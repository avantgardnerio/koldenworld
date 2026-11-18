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
const PRIMARY = [232, 200, 74];
const RESIDENTIAL = [168, 172, 180];
const BACKGROUND = [18, 20, 26];

let dir: string;
let viewer: Session;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "viewer-e2e-"));
  const files = roadGraphToArrow(graph, { area: "fixture" });
  await mkdir(path.join(dir, "fixture"));
  await writeFile(path.join(dir, "fixture/nodes.arrow"), files.nodes);
  await writeFile(path.join(dir, "fixture/edges.arrow"), files.edges);
  viewer = await openViewer({ dataDir: dir, area: "fixture", hash: `#0,0,${Z},0,-90`, width: W, height: H });
}, 60_000);

afterAll(async () => {
  await viewer?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("viewer", () => {
  it("loads the graph from Arrow files", async () => {
    const s = await viewer.status();
    expect(s).toMatchObject({ state: "ready", nodes: 5, edges: 4, segments: 4 });
    expect(s.frames).toBeGreaterThan(0);
  });

  it("draws roads in their class colors, major roads on top", async () => {
    expect(await viewer.pixel(200, 150)).toEqual(PRIMARY);      // the intersection
    expect(await viewer.pixel(250, 150)).toEqual(PRIMARY);      // 50 m east
    expect(await viewer.pixel(200, 100)).toEqual(RESIDENTIAL);  // 50 m north
    expect(await viewer.pixel(200, 200)).toEqual(RESIDENTIAL);  // 50 m south
    expect(await viewer.pixel(100, 50)).toEqual(BACKGROUND);
  });

  it("puts the camera in the URL", async () => {
    const hash = `#100,0,${Z},0,-90`;
    await viewer.page.evaluate((h) => { location.hash = h; }, hash);
    await viewer.page.waitForFunction((h) => location.hash === h, hash);
    // The intersection is now 100 px left of center.
    expect(await viewer.pixel(100, 150)).toEqual(PRIMARY);
    expect(await viewer.pixel(100, 100)).toEqual(RESIDENTIAL);
  });

  it("flies with the keyboard and writes the pose back once idle", async () => {
    const start = "#0,0,100.0,0.0,0.0";  // level, facing north
    await viewer.page.evaluate((h) => { location.hash = h; }, start);
    await viewer.page.waitForFunction((h) => location.hash === h, start);
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
