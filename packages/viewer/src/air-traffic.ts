// Live air traffic in the viewer (decision 31): ADS-B reports from the cell
// server's /aircraft, refreshed every REFRESH_S, extrapolated in between.
//
// - A plane flies on in a straight line (in ECEF) at its reported ground
//   speed, track and climb rate, from where it was when its position was
//   received. Planes on the ground stay on the ground (the loaded terrain).
// - A new report never moves a plane: the difference between where it was
//   drawn and where the report puts it (position and velocity) becomes a
//   correction that fades out over about TAU_S, so it eases onto the new
//   track without a jump.
// - A plane that stops reporting holds still after STALE_S and is forgotten
//   after FORGET_S.
//
// Not flight dynamics: no banking, and turns are a series of straight legs
// blended together.

import {
  aircraftMeshes, ecefToGeodetic, enuFrame, geodeticToEcef, parseAircraft,
  type AircraftReport, type Frame, type Vec3,
} from "@game/world";
import type { CarInstances } from "./car-layer.ts";

export const REFRESH_S = 10;
const TAU_S = 2;
const STALE_S = 30;
const FORGET_S = 60;
/** Fetch radius (nautical miles), and how far the camera may move before the circle is refetched early (m). */
const RADIUS_NM = 60;
const REFETCH_M = 20_000;
/** A correction this large is a glitch or a long gap, not drift: the plane is just put there. */
const SNAP_M = 3000;

/** Ground height (m above the ellipsoid) at a point. */
export type Ground = (lat: number, lon: number) => number;

interface Plane {
  model: number;
  ground: boolean;
  t0: number;     // s (the clock passed in): when the report's position was received
  p0: Vec3;       // ECEF there and then
  v0: Vec3;       // ECEF velocity, m/s
  up: Vec3;       // local up at p0
  hint: Vec3;     // forward when not moving: the reported track, or the last way it moved
  e: Vec3;        // correction at tc (position, m), fading
  ev: Vec3;       // correction at tc (velocity, m/s), fading
  tc: number;
  seen: number;   // s, last report
}

const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

export const emptyAircraftInstances = (): CarInstances => ({
  data: aircraftMeshes().map(() => new Float32Array(6 * 16)),
  count: aircraftMeshes().map(() => 0),
});

export class AirTraffic {
  private planes = new Map<string, Plane>();
  private ground: Ground;
  private fetchedAt = -Infinity;
  private fetchedFrom: Vec3 | undefined;
  private pending = false;
  /** Called after reports arrive (the viewer wakes its frame loop). */
  onUpdate: () => void = () => {};

  constructor(ground: Ground) {
    this.ground = ground;
  }

  get count(): number {
    return this.planes.size;
  }

  /** Fetches new reports when they are due (every REFRESH_S, or sooner after a long move). */
  refresh(lat: number, lon: number, now: number): void {
    if (this.pending) return;
    const here = geodeticToEcef({ lat, lon, h: 0 });
    const moved = this.fetchedFrom ? len(sub(here, this.fetchedFrom)) > REFETCH_M : true;
    if (now - this.fetchedAt < REFRESH_S && !moved) return;
    this.pending = true;
    this.fetchedAt = now;
    this.fetchedFrom = here;
    fetch(`/aircraft?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&nm=${RADIUS_NM}`)
      .then(async (res) => {
        // Without a cell server (the hermetic e2e setup) the dev server answers with its index page.
        if (!res.ok || !res.headers.get("content-type")?.includes("json")) return;
        this.update(parseAircraft(await res.json()), performance.now() / 1000);
        this.onUpdate();
      })
      .catch((err: unknown) => console.warn("aircraft:", err))
      .finally(() => { this.pending = false; });
  }

  /** Takes in reports received at `now` (s). */
  update(reports: AircraftReport[], now: number): void {
    for (const r of reports) {
      const f = enuFrame({ lat: r.lat, lon: r.lon, h: 0 });
      const p0 = geodeticToEcef({ lat: r.lat, lon: r.lon, h: r.h ?? this.ground(r.lat, r.lon) });
      const dir: Vec3 | undefined = r.track === undefined ? undefined : add(add([0, 0, 0], f.east, Math.sin(r.track)), f.north, Math.cos(r.track));
      const v0 = add(dir ? add([0, 0, 0], dir, r.speed) : [0, 0, 0], f.up, r.climb);
      const old = this.planes.get(r.id);
      const next: Plane = {
        model: r.model, ground: r.ground, t0: now - r.age, p0, v0, up: f.up, hint: dir ?? old?.hint ?? f.north,
        e: [0, 0, 0], ev: [0, 0, 0], tc: now, seen: now,
      };
      if (old) {
        const e = sub(this.position(old, now), this.predicted(next, now));
        if (len(e) < SNAP_M) {
          next.e = e;
          next.ev = sub(this.velocity(old, now), v0);
        }
      }
      this.planes.set(r.id, next);
    }
    for (const [id, p] of this.planes) if (now - p.seen > FORGET_S) this.planes.delete(id);
  }

  /** Where the report alone puts a plane at t: extrapolated, held after STALE_S, on the ground if it's taxiing. */
  private predicted(p: Plane, t: number): Vec3 {
    const at = add(p.p0, p.v0, Math.min(Math.max(0, t - p.t0), STALE_S));
    if (!p.ground) return at;
    const g = ecefToGeodetic(at);
    return geodeticToEcef({ lat: g.lat, lon: g.lon, h: this.ground(g.lat, g.lon) });
  }

  private fade(p: Plane, t: number): number {
    return Math.exp(-Math.max(0, t - p.tc) / TAU_S);
  }

  /** Where a plane is drawn at t (ECEF). */
  position(p: Plane, t: number): Vec3 {
    return add(this.predicted(p, t), p.e, this.fade(p, t));
  }

  private velocity(p: Plane, t: number): Vec3 {
    const v = t - p.t0 > STALE_S ? ([0, 0, 0] as Vec3) : p.v0;
    return add(v, p.ev, this.fade(p, t));
  }

  /** Writes every plane's pose at t into per-model instance arrays, in the view frame. */
  instances(vf: Frame, t: number, out: CarInstances): void {
    out.count.fill(0);
    for (const p of this.planes.values()) {
      const at = sub(this.position(p, t), vf.origin);
      let v = this.velocity(p, t);
      if (p.ground) v = add(v, p.up, -dot(v, p.up));  // taxiing: level, whatever the terrain does
      if (len(v) > 0.5) p.hint = v;
      const fwd = p.hint, fl = len(fwd) || 1;
      let data = out.data[p.model]!;
      const o = 6 * out.count[p.model]!++;
      if (o + 6 > data.length) {
        const grown = new Float32Array(data.length * 2);
        grown.set(data);
        out.data[p.model] = data = grown;
      }
      data[o] = dot(at, vf.east);
      data[o + 1] = dot(at, vf.north);
      data[o + 2] = dot(at, vf.up);
      data[o + 3] = dot(fwd, vf.east) / fl;
      data[o + 4] = dot(fwd, vf.north) / fl;
      data[o + 5] = dot(fwd, vf.up) / fl;
    }
  }

  /** Test hook: every plane's drawn position and forward at t, by id (ECEF). */
  poses(t: number): Map<string, { at: Vec3; fwd: Vec3 }> {
    const out = new Map<string, { at: Vec3; fwd: Vec3 }>();
    for (const [id, p] of this.planes) {
      const v = this.velocity(p, t);
      out.set(id, { at: this.position(p, t), fwd: len(v) > 0.5 ? v : p.hint });
    }
    return out;
  }
}
