// Instruments: overlays drawn on a 2D canvas over the view, like a car's
// dashboard or an aircraft's head-up display.
//
// - Flying: a heading tape across the top (compass, degrees clockwise from
//   north), a pitch ladder (10° rungs, true to the view's field of view) with
//   the boresight in the middle, a speed tape on the left (ground speed, m/s)
//   and an altitude tape on the right (m above the ellipsoid), with the
//   height above the ground (RA), the ground's height, the climb rate, and the
//   position under it. The tapes' scale follows the value (a speed of 8 m/s
//   and of 8,000 m/s both read).
// - Driving: a speedometer (km/h; R in reverse) with the heading above it,
//   and the wheel (left–right) and pedal (throttle up, brake down) beside it.
// - On foot: the inventory along the bottom (what's in hand outlined, a gun's
//   rounds beside it), a crosshair with a gun in hand (green aiming; swaying
//   with their steps, where shots go), and a hint now and then (what F does).
//
// Drawn as light lines with a dark outline, so they read over sky and ground.

import { FOV_Y } from "./camera.ts";

export interface FlightData {
  bearing: number;  // degrees clockwise from north
  pitch: number;    // radians, up positive
  speed: number;    // m/s over the ground
  climb: number;    // m/s, up positive
  altitude: number; // m above the ellipsoid
  agl: number;      // m above the ground
  ground: number;   // the ground's height, m above the ellipsoid
  lat: number;
  lon: number;
}

export interface HandData {
  slots: string[];    // the inventory's items, by name
  selected: number;   // the one in hand
  rounds?: string;    // a gun in hand: what's in it ("12/12", "reloading")
  crosshair: boolean; // a gun in hand
  aiming: boolean;
  sway: [number, number];  // the crosshair off the middle, radians right and up
}

export interface DriveData {
  kmh: number;      // negative in reverse
  bearing: number;  // degrees clockwise from north
  wheel: number;    // −1 (left) .. 1
  pedal: number;    // −1 (brake) .. 1 (throttle)
}

const INK = "#f4fbff", OUTLINE = "rgb(10 20 30 / 0.75)", ACCENT = "#7fe0a0", BRAKE = "#ff7a6a";
const FONT = "system-ui, sans-serif";
/** The speedometer's dial: 0 to this many km/h, over a 270° sweep. */
const DIAL_MAX = 200;
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export class Instruments {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
  }

  /**
   * Clears, sized to the window; then draws one set of instruments (or none), what's in hand on foot, and a hint at
   * the bottom if there is one.
   */
  draw(flight?: FlightData, drive?: DriveData, hint?: string, hand?: HandData): void {
    const { canvas, ctx } = this, dpr = devicePixelRatio;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (drive) this.dashboard(w, h, drive);
    else if (flight) this.hud(w, h, flight);
    if (hand) this.hand(w, h, hand);
    if (hint) this.text(hint, w / 2, h - 70, 15, "center");
  }

  // --- on foot -----------------------------------------------------------------------

  /** The inventory along the bottom (the slot in hand outlined, with its rounds); a crosshair with a gun in hand. */
  private hand(w: number, h: number, d: HandData): void {
    const bw = 104, bh = 26, y = h - 26, x0 = w / 2 - (d.slots.length * (bw + 6)) / 2 + bw / 2;
    d.slots.forEach((name, i) => {
      const x = x0 + i * (bw + 6), on = i === d.selected;
      this.box(x, y, bw, bh, on ? ACCENT : "rgb(255 255 255 / 0.35)");
      this.text(`${i + 1}  ${name}${on && d.rounds ? `  ${d.rounds}` : ""}`, x, y + 5, 13, "center", on ? INK : "rgb(244 251 255 / 0.6)");
    });
    if (!d.crosshair) return;
    // Off the middle by its sway, as the view projects it.
    const f = h / 2 / Math.tan(FOV_Y / 2), color = d.aiming ? ACCENT : INK;
    const [cx, cy] = [w / 2 + f * Math.tan(d.sway[0]), h / 2 - f * Math.tan(d.sway[1])];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      this.stroke([[cx + dx * 5, cy + dy * 5], [cx + dx * 13, cy + dy * 13]], 2, color);
    }
  }

  // --- flying ------------------------------------------------------------------------

  private hud(w: number, h: number, d: FlightData): void {
    const cx = w / 2, cy = h / 2;
    this.ladder(cx, cy, h, d.pitch);
    this.headingTape(cx, 40, Math.min(480, w * 0.5), d.bearing);
    const tapeH = Math.min(320, h * 0.45);
    const sx = Math.max(70, cx - Math.min(360, w * 0.32)), ax = Math.min(w - 70, cx + Math.min(360, w * 0.32));
    this.tape(sx, cy, tapeH, d.speed, "left", "GS m/s");
    this.tape(ax, cy, tapeH, d.altitude, "right", "ALT m");
    // Under the altitude tape: radio altitude, the ground, the climb rate; under that, where.
    const y = cy + tapeH / 2 + 22;
    this.text(`RA ${fmt(d.agl)}`, ax, y, 13, "center");
    this.text(`GND ${fmt(d.ground)}`, ax, y + 18, 12, "center");
    this.text(`VS ${d.climb >= 0 ? "▲" : "▼"} ${Math.abs(d.climb).toFixed(Math.abs(d.climb) < 10 ? 1 : 0)}`, ax, y + 36, 12, "center");
    const lat = `${Math.abs(d.lat).toFixed(5)}°${d.lat >= 0 ? "N" : "S"}`, lon = `${Math.abs(d.lon).toFixed(5)}°${d.lon >= 0 ? "E" : "W"}`;
    this.text(`${lat}  ${lon}`, cx, h - 44, 12, "center");
  }

  /** The horizon and a rung every 10° of pitch, placed as the view projects them; the boresight at the center. */
  private ladder(cx: number, cy: number, h: number, pitch: number): void {
    const f = h / 2 / Math.tan(FOV_Y / 2);  // px per unit of tan(angle) off the view's axis
    const ctx = this.ctx;
    for (let deg = -90; deg <= 90; deg += 10) {
      const off = deg * (Math.PI / 180) - pitch;
      if (Math.abs(off) > FOV_Y / 2) continue;
      const y = cy - f * Math.tan(off);
      const half = deg === 0 ? 150 : 60, gap = deg === 0 ? 40 : 24;
      ctx.setLineDash(deg < 0 ? [6, 5] : []);
      for (const s of [-1, 1]) {
        // A rung: from the gap out, with a tick toward the horizon at its outer end.
        const tick = deg === 0 ? 0 : deg > 0 ? 7 : -7;
        this.stroke([[cx + s * gap, y], [cx + s * half, y], [cx + s * half, y + tick]], deg === 0 ? 2 : 1.5);
      }
      ctx.setLineDash([]);
      if (deg !== 0) for (const s of [-1, 1]) this.text(String(Math.abs(deg)), cx + s * (half + 16), y + 4, 11, "center");
    }
    // The boresight: where the view points.
    this.stroke([[cx - 22, cy], [cx - 9, cy], [cx - 4, cy + 6], [cx, cy], [cx + 4, cy + 6], [cx + 9, cy], [cx + 22, cy]], 2, ACCENT);
  }

  /** Degrees on a strip `width` wide centered on the bearing, 4 px per degree, with the bearing boxed under a caret. */
  private headingTape(cx: number, y: number, width: number, bearing: number): void {
    const ppd = 4, half = width / 2 / ppd;
    this.stroke([[cx - width / 2, y], [cx + width / 2, y]], 1);
    for (let deg = Math.ceil((bearing - half) / 5) * 5; deg <= bearing + half; deg += 5) {
      const x = cx + (deg - bearing) * ppd, b = ((deg % 360) + 360) % 360;
      const major = b % 10 === 0;
      this.stroke([[x, y], [x, y - (major ? 9 : 5)]], 1.5);
      if (b % 45 === 0) this.text(COMPASS[b / 45]!, x, y - 14, 13, "center", b === 0 ? ACCENT : INK);
      else if (b % 30 === 0) this.text(String(b / 10).padStart(2, "0"), x, y - 14, 11, "center");
    }
    const shown = Math.round(((bearing % 360) + 360) % 360) % 360;
    this.stroke([[cx - 6, y + 9], [cx, y + 2], [cx + 6, y + 9]], 2, ACCENT);
    this.box(cx, y + 24, 46, 20);
    this.text(`${String(shown).padStart(3, "0")}°`, cx, y + 29, 14, "center");
  }

  /** A vertical tape `height` tall at x, ticks at a nice step for the value's size, the value boxed at the middle. */
  private tape(x: number, cy: number, height: number, value: number, side: "left" | "right", label: string): void {
    const step = niceStep(Math.max(10, Math.abs(value)) / 4), ppu = height / (8 * step);
    const dir = side === "left" ? -1 : 1;  // ticks point toward the center of the screen, labels away from it
    this.stroke([[x, cy - height / 2], [x, cy + height / 2]], 1);
    for (let v = Math.ceil((value - 4 * step) / step) * step; v <= value + 4 * step; v += step) {
      const y = cy - (v - value) * ppu;
      this.stroke([[x, y], [x - dir * 10, y]], 1.5);
      const half = y - (step / 2) * ppu;
      if (half > cy - height / 2) this.stroke([[x, half], [x - dir * 5, half]], 1);
      if (Math.abs(y - cy) > 14) this.text(fmt(v), x + dir * 8, y + 4, 11, side === "left" ? "right" : "left");
    }
    this.box(x + dir * 30, cy, 64, 24);
    this.text(fmt(value), x + dir * 30, cy + 5, 15, "center");
    this.text(label, x, cy - height / 2 - 10, 11, "center");
  }

  // --- driving -----------------------------------------------------------------------

  private dashboard(w: number, h: number, d: DriveData): void {
    const r = Math.min(90, h * 0.14), cx = w / 2, cy = h - r - 46;
    // The dial: from 225° (0 km/h, lower left) clockwise through the top to −45° (DIAL_MAX, lower right).
    const angle = (kmh: number) => ((225 - (270 * Math.min(kmh, DIAL_MAX)) / DIAL_MAX) * Math.PI) / 180;
    const at = (a: number, rr: number): [number, number] => [cx + rr * Math.cos(a), cy - rr * Math.sin(a)];
    const ctx = this.ctx;
    ctx.fillStyle = "rgb(10 20 30 / 0.45)";
    ctx.beginPath();
    ctx.arc(cx, cy, r + 8, 0, 2 * Math.PI);
    ctx.fill();
    for (let v = 0; v <= DIAL_MAX; v += 10) {
      const major = v % 20 === 0, a = angle(v);
      this.stroke([at(a, r), at(a, r - (major ? 12 : 6))], major ? 2 : 1);
      if (v % 40 === 0) this.text(String(v), ...at(a, r - 26), 11, "center", INK, 4);
    }
    const speed = Math.abs(d.kmh);
    this.stroke([at(angle(speed), -10), at(angle(speed), r - 6)], 3, ACCENT);
    this.text(speed.toFixed(0), cx, cy + r * 0.42, 26, "center");
    this.text(d.kmh < -0.5 ? "R  km/h" : "km/h", cx, cy + r * 0.42 + 16, 11, "center");
    // The heading above the dial.
    const b = ((Math.round(d.bearing) % 360) + 360) % 360;
    this.text(`${COMPASS[Math.round(b / 45) % 8]} ${String(b).padStart(3, "0")}°`, cx, cy - r - 18, 14, "center");
    // The wheel under the dial: where it's turned, full lock at the ends.
    const ww = r * 1.6, wy = h - 22;
    this.stroke([[cx - ww / 2, wy], [cx + ww / 2, wy]], 2);
    this.stroke([[cx, wy - 4], [cx, wy + 4]], 1);
    this.stroke([[cx + (d.wheel * ww) / 2, wy - 8], [cx + (d.wheel * ww) / 2, wy + 8]], 3, ACCENT);
    // The pedal right of the dial: throttle up from the middle, brake down.
    const px = cx + r + 30, ph = r * 1.4;
    this.stroke([[px, cy - ph / 2], [px, cy + ph / 2]], 1);
    if (d.pedal !== 0) this.stroke([[px, cy], [px, cy - (d.pedal * ph) / 2]], 6, d.pedal > 0 ? ACCENT : BRAKE);
    this.text("F: get out · V: fly", cx + r + 30, h - 18, 11, "center");
  }

  // --- drawing -----------------------------------------------------------------------

  /** A polyline: a dark outline, then the line. */
  private stroke(points: [number, number][], width: number, color = INK): void {
    const ctx = this.ctx;
    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = width + 2.5;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  private text(s: string, x: number, y: number, size: number, align: CanvasTextAlign, color = INK, dy = 0): void {
    const ctx = this.ctx;
    ctx.font = `600 ${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.lineWidth = 3;
    ctx.strokeStyle = OUTLINE;
    ctx.strokeText(s, x, y + dy);
    ctx.fillStyle = color;
    ctx.fillText(s, x, y + dy);
  }

  /** A value's box, centered at (x, y). */
  private box(x: number, y: number, w: number, h: number, edge = INK): void {
    const ctx = this.ctx;
    ctx.fillStyle = "rgb(10 20 30 / 0.55)";
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = edge;
    ctx.strokeRect(x - w / 2, y - h / 2, w, h);
  }
}

/** 1, 2 or 5 times a power of ten, at least x. */
export function niceStep(x: number): number {
  const p = 10 ** Math.floor(Math.log10(x)), m = x / p;
  return p * (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10);
}

/** A reading: whole meters, thousands grouped by a thin space. */
const fmt = (v: number) => Math.round(v).toLocaleString("en-US").replace(/,/g, " ");
