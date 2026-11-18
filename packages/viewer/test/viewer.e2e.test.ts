// End to end: a synthetic graph → Arrow files → Vite → headless Chromium →
// WebGL pixels. Hermetic: no network, no Postgres, no data/ directory.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRoadGraph, roadGraphToArrow, type RoadWayInput } from "@game/world";
import { openViewer, type Session } from "../harness/browser.ts";

const D = 0.001; // degrees; ≈ 111 m
const road = (osmWayId: number, nodeIds: number[], coords: [number, number][], extra: Partial<RoadWayInput>): RoadWayInput => ({
  osmWayId, nodeIds, points: coords.map(([x, y]) => [x * D, y * D]),
  class: "residential", name: null, lanesFwd: 1, lanesBack: 1, speedLimitMps: 11, ...extra,
});

// A primary road along y = 0 crossed by a residential street along x = 0.
const graph = buildRoadGraph([
  road(1, [1, 2, 3], [[-1, 0], [0, 0], [1, 0]], { class: "primary" }),
  road(2, [4, 2, 5], [[0, 1], [0, 0], [0, -1]], { class: "residential" }),
], { lat: 0, lon: 0 });

// Looking straight down from the height where the 60° field of view gives
// 1 m per pixel on the ground; odd viewport so world (0, 0) is the center of
// pixel (200, 150). Hash: #x,y,z,yaw,pitch.
const W = 401, H = 301;
const Z = (H / 2 / Math.tan(Math.PI / 6)).toFixed(1);
const top = (x: number, mpp: number) => `#${x},0,${(+Z * mpp).toFixed(2)},0,-90`;
const ASPHALT = [46, 48, 52];
const GROUND = [91, 127, 58];
const YELLOW = [226, 182, 42];
// Widths: primary 1+1 lanes × 3.4 m + 1 m shoulders = 8.8 m; residential 1+1 × 3 + 1 = 8 m.

let dir: string;
let viewer: Session;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "viewer-e2e-"));
  const files = roadGraphToArrow(graph, { area: "fixture" });
  await mkdir(path.join(dir, "fixture"));
  await writeFile(path.join(dir, "fixture/nodes.arrow"), files.nodes);
  await writeFile(path.join(dir, "fixture/edges.arrow"), files.edges);
  viewer = await openViewer({ dataDir: dir, area: "fixture", hash: top(0, 1), width: W, height: H });
}, 60_000);

async function setHash(hash: string) {
  await viewer.page.evaluate((h) => { location.hash = h; }, hash);
  await viewer.page.waitForFunction((h) => location.hash === h, hash);
}

afterAll(async () => {
  await viewer?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("viewer", () => {
  it("loads the graph from Arrow files", async () => {
    const s = await viewer.status();
    expect(s).toMatchObject({ state: "ready", nodes: 5, edges: 4, graphOverlay: false });
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

  it("flies with the keyboard and writes the pose back once idle", async () => {
    const start = "#0,0,100.0,0.0,0.0";  // level, facing north
    await setHash(start);
    const frames = (await viewer.status()).frames;
    await viewer.page.keyboard.down("KeyW");
    await viewer.page.waitForTimeout(300);
    await viewer.page.keyboard.up("KeyW");
    await viewer.page.waitForFunction((h) => location.hash !== h, start);
    const [x, y, z, yaw, pitch] = (await viewer.page.evaluate(() => location.hash)).slice(1).split(",").map(Number);
    expect(y).toBeGreaterThan(5);  // moved north
    expect([x, z, yaw, pitch]).toEqual([0, 100, 0, 0]);
    expect((await viewer.status()).frames).toBeGreaterThan(frames + 3);
  });
});
