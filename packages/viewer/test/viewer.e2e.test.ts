// End to end: synthetic OSM rows → buildCell (as the cell server runs it) and
// the Rust cell generator's ground (cellgen cell --ways, flat terrain) → Arrow
// files → Vite → headless Chromium → WebGL pixels. Hermetic: no network, no
// Postgres, no data/ directory; cells are static files. The cells around the
// fixture have no cell files (404), only their ground, so they are bare ground.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildCell, CELL_LEVEL, CELL_TABLES, cellCenter, cellFromLatLon, cellsWithin, cellToArrow, cellToken, drapeCell, enuFrame,
  groundSampler,
  enuUnprojection, laneGeometry, lanePoint, placeVehicles,
  type BuildingInput, type RoadWayInput,
} from "@game/world";
import { openViewer, type Session } from "../harness/browser.ts";
import { GROUND as PALETTE, SUN } from "../src/style.ts";

// The fixture sits at the center of one level-13 cell; positions are meters
// east (x) and north (y) of that point.
const cell = cellFromLatLon(0.01, 0.01, CELL_LEVEL);
const O = cellCenter(cell);
const toLonLat = enuUnprojection(enuFrame({ ...O, h: 0 }));
const M = 111.2;  // m per unit in road coordinates
const road = (osmWayId: number, nodeIds: number[], coords: [number, number][], extra: Partial<RoadWayInput>): RoadWayInput => ({
  osmWayId, nodeIds, points: coords.map(([x, y]) => toLonLat(x * M, y * M)),
  class: "residential", name: null, lanesFwd: 1, lanesBack: 1, speedLimitMps: 11, ...extra,
});

// A primary road along y = 0 crossed by a residential street along x = 0.
const ways = [
  road(1, [1, 2, 3], [[-1, 0], [0, 0], [1, 0]], { class: "primary" }),
  road(2, [4, 2, 5], [[0, 1], [0, 0], [0, -1]], { class: "residential" }),
];

// Two buildings north of the primary, east of the residential street: a 10 m
// house in front (y 30..50 m) and a 30 m office block behind it (y 60..80 m).
const box = (x0: number, y0: number, x1: number, y1: number): [number, number][] =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(([x, y]) => toLonLat(x!, y!));
const building = (osmId: number, kind: string, height: number, ring: [number, number][]): BuildingInput => ({
  osmType: "way", osmId, kind, isPart: false, height, minHeight: 0, heightSource: "height", polygons: [[ring]],
});
const buildings = [
  { ...building(1, "house", 10, box(30, 30, 50, 50)), roofShape: "flat" },  // flat: the depth test needs its 10 m roofline
  building(2, "office", 30, box(30, 60, 50, 80)),
];

/** The camera hash at (x, y) m from the fixture origin. */
const at = (x: number, y: number, h: number, yaw: number, pitch: number) => {
  const [lon, lat] = toLonLat(x, y);
  return `#${lat.toFixed(7)},${lon.toFixed(7)},${h.toFixed(2)},${yaw},${pitch}`;
};

// Looking straight down from the height where the 60° field of view gives
// 1 m per pixel on the ground; odd viewport so the camera's ground point is
// the center of pixel (200, 150).
const W = 401, H = 301;
const Z = H / 2 / Math.tan(Math.PI / 6);
const top = (x: number, mpp: number) => at(x, 0, Z * mpp, 0, -90);
// Ground colors as the solid layer draws flat ground (normal up, no shade): the palette × 0.9 × the sun's light.
const lit = (material: number) => {
  const light = 0.9 * (0.55 + 0.45 * Math.max(SUN[2], 0) + 0.08);
  return [0, 1, 2].map((k) => Math.round(255 * Math.min(1, PALETTE[3 * material + k]! * light)));
};
const ASPHALT = lit(0);
const YELLOW = lit(1);
const GROUND = lit(5);  // lots: what isn't road (the fixture's roads have no sidewalks)
const SKY = [169, 200, 230];
// Widths: primary 1+1 lanes × 3.4 m + 1 m shoulders = 8.8 m; residential 1+1 × 3 + 1 = 8 m.

const repo = path.resolve(import.meta.dirname, "../../..");
const cellgen = path.join(repo, "crates/cellgen");

/** The Rust ground for every cell the viewer loads near the fixture, from its ways, flat at `height`, into dataDir/ground. */
async function writeGround(dataDir: string, height = 0) {
  const waysFile = path.join(dataDir, "ways.json");
  await writeFile(waysFile, JSON.stringify(ways));
  // Fine cells around the fixture, and coarse (level 10) and far (level 7) tiles out past the load radius.
  const cells = [...cellsWithin(O.lat, O.lon, 2000), ...cellsWithin(O.lat, O.lon, 3000, 10), ...cellsWithin(O.lat, O.lon, 3000, 7)]
    .map((c) => cellToken(c.cell));
  execFileSync(path.join(cellgen, "target/release/cellgen"),
    ["cell", ...cells, "--ways", waysFile, "--height", String(height), "--out", path.join(dataDir, "ground")], { stdio: "ignore" });
}

let dir: string;
let viewer: Session;

beforeAll(async () => {
  execFileSync("cargo", ["build", "--release", "--quiet"], { cwd: cellgen, stdio: "inherit" });
  dir = await mkdtemp(path.join(tmpdir(), "viewer-e2e-"));
  await writeGround(dir);
  const files = cellToArrow(buildCell(cell, ways, buildings));
  const cellDir = path.join(dir, "ground", cellToken(cell));
  await mkdir(cellDir, { recursive: true });
  for (const t of CELL_TABLES) await writeFile(path.join(cellDir, `${t}.arrow`), files[t]);
  viewer = await openViewer({ dataDir: dir, query: "radius=1000&cars=0", hash: top(0, 1), width: W, height: H });
}, 300_000);

async function setHash(hash: string) {
  await viewer.page.evaluate((h) => { location.hash = h; }, hash);
  await viewer.page.waitForFunction((h) => location.hash === h, hash);
}

afterAll(async () => {
  await viewer?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("viewer", () => {
  it("loads the fixture cell, and the cells around it as bare ground", async () => {
    const s = await viewer.status();
    expect(s).toMatchObject({ state: "ready", nodes: 5, edges: 4, buildings: 2, buildingTriangles: 2 * (4 * 4 + 2), graphOverlay: false });  // walls: dark band and above
    expect(s.cells.ready).toBeGreaterThan(1);
    expect(s.cells.coarse).toBeGreaterThan(0);
    expect(s.cells).toMatchObject({ missing: s.cells.ready - s.cells.coarse - 1, failed: 0, loading: 0, queued: 0 });
    // Looking straight down from ~260 m: only cells under the view are drawn.
    expect(s.cells.drawn).toBeGreaterThan(0);
    expect(s.cells.drawn).toBeLessThan(s.cells.ready);
    expect(s.radius).toBe(1000);
    expect(s.surfaceTriangles).toBeGreaterThan(0);
    expect(s.frames).toBeGreaterThan(0);
  });

  it("draws asphalt roads of real width on green ground", async () => {
    expect(await viewer.pixel(200, 150)).toEqual(ASPHALT);  // the intersection
    expect(await viewer.pixel(250, 153)).toEqual(ASPHALT);  // primary, 50 m east, 3 m south of center
    expect(await viewer.pixel(250, 145)).toEqual(GROUND);   // 5 m north: past its 4.4 m half width
    expect(await viewer.pixel(203, 100)).toEqual(ASPHALT);  // residential, 3 m east of center
    expect(await viewer.pixel(205, 100)).toEqual(GROUND);   // 5 m east: past its 4 m half width
    expect(await viewer.pixel(100, 50)).toEqual(GROUND);
  });

  it("draws buildings over the ground", async () => {
    // Roofs are nearer the camera, so they look slightly bigger; sample well inside.
    expect(await viewer.pixel(241, 109)).not.toEqual(GROUND);  // house roof, (40, 40) m
    expect(await viewer.pixel(241, 109)).not.toEqual(ASPHALT);
    expect(await viewer.pixel(241, 75)).not.toEqual(GROUND);   // office roof, (40, 70) m
    expect(await viewer.pixel(241, 109)).not.toEqual(await viewer.pixel(241, 75));
  });

  it("hides the far building behind the near one (depth test)", async () => {
    // From 5 m up, 20 m south of the house, looking north at both.
    await setHash(at(40, -20, 5, 0, 0));
    const near = await viewer.pixel(200, 150);  // straight ahead: the house's south wall
    // tan 0.3 above the horizon: over the house's 10 m roofline, onto the office's wall.
    const far = await viewer.pixel(200, Math.round(150 - (0.3 / Math.tan(Math.PI / 6)) * 150.5));
    expect(near).not.toEqual(far);
    // Without depth testing the office (drawn after the house) would paint over it.
    expect(near).not.toEqual(SKY);
    expect(far).not.toEqual(SKY);
  });

  it("paints a double yellow center line on the primary road", async () => {
    await setHash(top(50, 0.05));  // 5 cm per pixel, over the primary 50 m east
    expect(await viewer.pixel(200, 147)).toEqual(YELLOW);   // 0.15 m north of center
    expect(await viewer.pixel(200, 153)).toEqual(YELLOW);   // 0.15 m south
    expect(await viewer.pixel(200, 150)).toEqual(ASPHALT);  // the gap between the lines
    expect(await viewer.pixel(200, 140)).toEqual(ASPHALT);
  });

  it("puts the camera in the URL", async () => {
    await setHash(top(100, 1));
    // The intersection is now 100 px left of center.
    expect(await viewer.pixel(100, 150)).toEqual(ASPHALT);
    expect(await viewer.pixel(105, 100)).toEqual(GROUND);
  });

  it("toggles the road graph overlay with G, in the URL", async () => {
    await setHash(top(0, 1));
    await viewer.page.keyboard.press("KeyG");
    expect((await viewer.status()).graphOverlay).toBe(true);
    expect(await viewer.page.evaluate(() => new URL(location.href).searchParams.get("graph"))).toBe("1");
    expect(await viewer.pixel(200, 100)).not.toEqual(ASPHALT);  // the residential centerline
    await viewer.page.keyboard.press("KeyG");
    expect((await viewer.status()).graphOverlay).toBe(false);
    expect(await viewer.pixel(200, 100)).toEqual(ASPHALT);
  });

  it("loads the vehicle models (hidden here: cars=0 keeps the road pixels exact)", async () => {
    await viewer.page.waitForFunction(() => window.viewer.carModels > 0, null, { timeout: 30_000 });
    expect((await viewer.status()).carModels).toBe(10);
  });

  it("draws ground in a neighboring cell that has no cell files", async () => {
    await setHash(top(800, 1));
    expect(await viewer.pixel(200, 150)).toEqual(GROUND);
    expect(await viewer.pixel(10, 150)).toEqual(GROUND);
  });

  it("flies with the keyboard and writes the pose back once idle", async () => {
    const start = at(0, 0, 100, 0, 0);  // level, facing north
    await setHash(start);
    const frames = (await viewer.status()).frames;
    await viewer.page.keyboard.down("KeyW");
    await viewer.page.waitForTimeout(300);
    await viewer.page.keyboard.up("KeyW");
    await viewer.page.waitForFunction((h) => location.hash !== h, start);
    const [lat, lon, h, yaw, pitch] = (await viewer.page.evaluate(() => location.hash)).slice(1).split(",").map(Number);
    const [lon0, lat0] = toLonLat(0, 0);
    expect((lat! - lat0) * 110_574).toBeGreaterThan(5);  // moved north, m
    expect(lon).toBeCloseTo(lon0, 6);
    expect([h, yaw, pitch]).toEqual([100, 0, 0]);
    expect((await viewer.status()).frames).toBeGreaterThan(frames + 3);
  });
});

/** The first car the viewer places in the fixture cell: its position and heading (x, y, fx, fy) in m from O. */
function firstCar(): [number, number, number, number] {
  const c = buildCell(cell, ways, buildings);  // the cell frame is ENU at O
  const v = placeVehicles(c.graph, Number(BigInt.asUintN(32, cell ^ (cell >> 32n))));
  expect(v.count).toBeGreaterThan(0);
  const pose = new Float32Array(6);
  lanePoint(laneGeometry(c.graph), v.edge[0]!, v.dir[0]!, v.lane[0]!, v.s[0]!, pose);
  return [pose[0]!, pose[1]!, pose[3]!, pose[4]!];
}

describe("vehicles", () => {
  let cars: Session;
  beforeAll(async () => {
    cars = await openViewer({ dataDir: dir, query: "radius=300&traffic=0", hash: top(0, 1), width: W, height: H });
    await cars.page.waitForFunction(() => window.viewer.carModels > 0, null, { timeout: 30_000 });
  }, 60_000);
  afterAll(async () => { await cars?.close(); });

  it("stands cars in their lanes, at real size, facing along the road", async () => {
    // The same placement the viewer computes for the fixture cell; the cell's frame is ENU at O.
    const c = buildCell(cell, ways, buildings);
    const [x, y, fx, fy] = firstCar();
    // Top-down over the first car at 0.1 m per pixel; screen up is north.
    const px = (dx: number, dy: number) => cars.pixel(Math.round(200 + dx * 10), Math.round(150 - dy * 10));
    const cam = at(x, y, Z * 0.1 + 0, 0, -90);
    await cars.page.evaluate((h) => { location.hash = h; }, cam);
    await cars.page.waitForFunction((h) => location.hash === h, cam);
    expect((await cars.status()).cars).toBeGreaterThan(0);
    const along = (d: number) => px(fx * d, fy * d), side = (d: number) => px(fy * d, -fx * d);
    expect(await along(0)).not.toEqual(ASPHALT);
    expect(await along(2)).not.toEqual(ASPHALT);    // still the car, 2 m ahead of its center
    expect(await along(3.2)).toEqual(ASPHALT);      // past its ~4.7 m length
    expect(await side(2.2)).not.toEqual(await along(2));  // past its ~2.8 m width: not car body
  });
});

describe("traffic", () => {
  // The fixture raised to 1,600 m, like Denver: distances to cells must not count the elevation.
  const GROUND_H = 1600;
  let moving: Session;
  let highDir: string;
  beforeAll(async () => {
    highDir = await mkdtemp(path.join(tmpdir(), "viewer-e2e-high-"));
    await writeGround(highDir, GROUND_H);
    const files = cellToArrow(drapeCell(buildCell(cell, ways, buildings), groundSampler(() => GROUND_H, CELL_LEVEL)));
    const cellDir = path.join(highDir, "ground", cellToken(cell));
    await mkdir(cellDir, { recursive: true });
    for (const t of CELL_TABLES) await writeFile(path.join(cellDir, `${t}.arrow`), files[t]);
    const [x, y] = firstCar();
    moving = await openViewer({ dataDir: highDir, query: "radius=300", hash: at(x, y, GROUND_H + Z * 0.1, 0, -90), width: W, height: H });
  }, 60_000);
  afterAll(async () => {
    await moving?.close();
    await rm(highDir, { recursive: true, force: true });
  });

  it("drives the cars off from rest along their lanes", async () => {
    const [, , fx, fy] = firstCar();
    await moving.page.waitForFunction(() => window.viewer.simTime > 2.5, null, { timeout: 30_000 });
    const s = await moving.status();
    expect(s.cars).toBeGreaterThan(0);
    // From rest at 2.5 m/s², 2.5 s moves a car ~7.8 m: where it stood is asphalt, and it is ahead.
    const px = (dx: number, dy: number) => moving.pixel(Math.round(200 + dx * 10), Math.round(150 - dy * 10));
    expect(await px(0, 0)).toEqual(ASPHALT);
    expect(await px(fx * 10, fy * 10)).not.toEqual(ASPHALT);
  });
});
