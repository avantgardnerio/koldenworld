// Viewer entry: stream the S2 cells around the camera and fly over them.
//
// URL: /?[graph=1][&radius=<m>]#lat,lon,alt,yaw,pitch
//   hash: the camera (without it, a default view of Denver); graph=1: the road
//   graph overlay (toggle with G); radius: fixed load radius instead of the
//   horizon. The URL describes the whole view.
//
// Cells come from /cells/<token>/<table>.arrow (the cell server, through the
// dev server's proxy). Every cell within the horizon is loaded, nearest first,
// up to MAX_RADIUS; a cell with no files (404) is drawn as bare ground.
//
// Frames are rendered only while something changes: a held key or mouse
// movement starts the loop, and it stops (and writes the pose to the URL) once
// input goes idle. A cell arriving renders one frame.
//
// window.viewer exposes status and a pixel probe so headless tests can check
// what was drawn without decoding screenshots.

import {
  buildingMesh, CELL_TABLES, cellFromArrow, cellFrame, cellGroundMesh, cellsWithin, cellToken, frameToFrame,
  geodeticToEcef, horizonDistance, roadLineMesh, roadSurfaceMesh, type CellFiles, type CellId, type Frame as CellFrame,
} from "@game/world";
import { fromYawPitch, speed, viewProjection } from "./camera.ts";
import { createFlatLayer, type FlatLayer } from "./flat-layer.ts";
import { formatGlobeHash, localCamera, parseGlobeHash, stepGlobe, viewFrame, type GlobeCamera } from "./globe-camera.ts";
import { attachInput, isIdle } from "./input.ts";
import { createSolidLayer, type SolidLayer } from "./solid-layer.ts";
import { CellStreamer } from "./streaming.ts";
import {
  BUILDING_COLORS_RGB, CLASS_COLORS_RGB, fogRange, GROUND, MARKING_FADE, SKY, SUN, SURFACE_COLORS,
} from "./style.ts";

export interface ViewerStatus {
  state: "loading" | "ready" | "error";
  error?: string;
  cells: { ready: number; loading: number; queued: number; failed: number; missing: number };
  radius: number;
  nodes: number;
  edges: number;
  surfaceTriangles: number;
  buildings: number;
  buildingTriangles: number;
  graphOverlay: boolean;
  frames: number;
  /** Render now and read the RGB at a CSS pixel (origin top left). */
  pixel?: (x: number, y: number) => [number, number, number];
}

declare global {
  interface Window { viewer: ViewerStatus }
}

/** Beyond this, the horizon needs coarser data (level of detail), which doesn't exist yet. */
const MAX_RADIUS = 5000;
/** Cells stay loaded out to this multiple of the load radius, so the edge doesn't thrash. */
const KEEP_FACTOR = 1.3;
/** Recompute the wanted cells once the camera has moved this far (m). */
const REFRESH_M = 50;
const MAX_DT = 0.1;  // s; a stalled tab must not teleport the camera
const DEFAULT_CAMERA: GlobeCamera = { lat: 39.7444, lon: -104.9896, h: 400, rot: fromYawPitch(0, -35 * Math.PI / 180) };

const params = new URLSearchParams(location.search);
const fixedRadius = params.has("radius") ? Number(params.get("radius")) : undefined;
const status: ViewerStatus = (window.viewer = {
  state: "loading", cells: { ready: 0, loading: 0, queued: 0, failed: 0, missing: 0 }, radius: 0,
  nodes: 0, edges: 0, surfaceTriangles: 0, buildings: 0, buildingTriangles: 0,
  graphOverlay: params.get("graph") === "1", frames: 0,
});

/** What can be seen from this height, out to MAX_RADIUS. */
const loadRadius = (h: number) => fixedRadius ?? Math.min(MAX_RADIUS, horizonDistance(h));

/** Platform adapter (architecture.md): in the browser, blobs come over HTTP and the HTTP cache. null: no such file. */
async function getBlob(path: string): Promise<Uint8Array | null> {
  const res = await fetch(path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  if (res.headers.get("content-type")?.startsWith("text/html")) return null;  // a dev server's index.html fallback
  return new Uint8Array(await res.arrayBuffer());
}

interface CellGpu {
  frame: CellFrame;
  missing: boolean;
  ground: FlatLayer;
  roads?: FlatLayer;
  graph?: FlatLayer;
  buildings?: SolidLayer;
  counts: { nodes: number; edges: number; surfaceTriangles: number; buildings: number; buildingTriangles: number };
}

async function start(): Promise<void> {
  const canvas = document.querySelector("canvas")!;
  const hud = document.querySelector<HTMLElement>("#hud")!;
  const gl = canvas.getContext("webgl2", { antialias: true });
  if (!gl) throw new Error("WebGL2 is not available");

  async function loadCell(cell: CellId): Promise<CellGpu> {
    const token = cellToken(cell);
    const blobs = await Promise.all(CELL_TABLES.map((t) => getBlob(`/cells/${token}/${t}.arrow`)));
    const frame = cellFrame(cell);
    const ground = createFlatLayer(gl!, { ...cellGroundMesh(cell, frame), dims: 3 }, { mode: gl!.TRIANGLES, colors: GROUND, fadeToBase: false });
    const zero = { nodes: 0, edges: 0, surfaceTriangles: 0, buildings: 0, buildingTriangles: 0 };
    if (blobs.some((b) => b === null)) return { frame, missing: true, ground, counts: zero };
    const files = Object.fromEntries(CELL_TABLES.map((t, i) => [t, blobs[i]!])) as unknown as CellFiles;
    const c = cellFromArrow(files);
    if (c.cell !== cell) throw new Error(`/cells/${token} holds cell ${cellToken(c.cell)}`);
    const surface = roadSurfaceMesh(c.graph);
    const lines = roadLineMesh(c.graph);
    const tris = buildingMesh(c.buildings);
    return {
      frame,
      missing: false,
      ground,
      roads: createFlatLayer(gl!, surface, { mode: gl!.TRIANGLES, colors: SURFACE_COLORS, fadeToBase: true }),
      graph: createFlatLayer(gl!, { positions: lines.positions, material: lines.pointClass, indices: lines.indices },
        { mode: gl!.LINES, colors: CLASS_COLORS_RGB, fadeToBase: false }),
      buildings: createSolidLayer(gl!, tris, BUILDING_COLORS_RGB),
      counts: {
        nodes: c.graph.nodes.count, edges: c.graph.edges.count, surfaceTriangles: surface.indices.length / 3,
        buildings: c.buildings.count, buildingTriangles: tris.indices.length / 3,
      },
    };
  }

  const streamer = new CellStreamer<CellGpu>({
    load: loadCell,
    dispose: (g) => [g.ground, g.roads, g.graph, g.buildings].forEach((l) => l?.dispose()),
    onChange: () => {
      updateStatus();
      if (!running) render();
    },
  });

  const aspect = () => canvas.clientWidth / Math.max(1, canvas.clientHeight);
  let camera: GlobeCamera = parseGlobeHash(location.hash) ?? DEFAULT_CAMERA;
  history.replaceState(null, "", formatGlobeHash(camera));

  // --- which cells: refreshed when the camera has moved enough ---
  let refreshedAt: [number, number, number] | null = null;
  let refreshedRadius = 0;
  const refreshCells = () => {
    const radius = loadRadius(camera.h);
    const p = geodeticToEcef({ lat: camera.lat, lon: camera.lon, h: 0 });
    if (refreshedAt && radius === refreshedRadius
        && Math.hypot(p[0] - refreshedAt[0], p[1] - refreshedAt[1], p[2] - refreshedAt[2]) < REFRESH_M) return;
    refreshedAt = p;
    refreshedRadius = radius;
    status.radius = radius;
    const around = cellsWithin(camera.lat, camera.lon, radius * KEEP_FACTOR);
    streamer.update(around.filter((c) => c.distance <= radius).map((c) => c.cell), new Set(around.map((c) => c.cell)));
    updateStatus();
  };

  const updateStatus = () => {
    const totals = { nodes: 0, edges: 0, surfaceTriangles: 0, buildings: 0, buildingTriangles: 0 };
    let missing = 0;
    for (const [, g] of streamer.ready()) {
      for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += g.counts[k];
      if (g.missing) missing++;
    }
    const { ready, loading, queued, failed } = streamer.counts();
    Object.assign(status, totals, { cells: { ready, loading, queued, failed, missing } });
    if (status.state === "loading" && streamer.settled) status.state = "ready";
  };

  const render = () => {
    refreshCells();
    const dpr = devicePixelRatio;
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(SKY[0]!, SKY[1]!, SKY[2]!, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const local = localCamera(camera);
    const f = {
      view: viewProjection(local, aspect()),
      eye: local.pos,
      sky: SKY,
      fog: fogRange(status.radius),
      fade: MARKING_FADE,
    };
    // Each cell's frame → the view frame, computed in f64, then cast (decision 20).
    const vf = viewFrame(camera);
    const cells = [...streamer.ready()].map(([, g]) => ({ g, model: Float32Array.from(frameToFrame(g.frame, vf)) }));
    // Ground layers in painter's order across all cells (writing depth), then depth-tested buildings.
    for (const { g, model } of cells) g.ground.draw(f, model);
    for (const { g, model } of cells) g.roads?.draw(f, model);
    for (const { g, model } of cells) g.buildings?.draw(f, model, SUN);
    if (status.graphOverlay) for (const { g, model } of cells) g.graph?.draw(f, model);
    status.frames++;
    const c = status.cells;
    hud.textContent = `${camera.lat.toFixed(5)}, ${camera.lon.toFixed(5)} · alt ${camera.h.toFixed(0)} m · ` +
      `${speed(local, false).toFixed(0)} m/s (Shift ×4) · cells ${c.ready - c.missing}` +
      `${c.loading + c.queued ? ` +${c.loading + c.queued} loading` : ""}${c.failed ? `, ${c.failed} failed` : ""} ` +
      `within ${(status.radius / 1000).toFixed(1)} km`;
  };

  // --- frame loop, running only while there is input ---
  let running = false;
  let last = 0;
  const frame = (now: number) => {
    const dt = Math.min(MAX_DT, (now - last) / 1000);
    last = now;
    const input = keys.take();
    if (isIdle(input)) {
      running = false;
      history.replaceState(null, "", formatGlobeHash(camera));
      return;
    }
    camera = stepGlobe(camera, input, dt);
    render();
    requestAnimationFrame(frame);
  };
  const wake = () => {
    if (running) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  };
  const keys = attachInput(canvas, wake);

  addEventListener("keydown", (e) => {
    if (e.code !== "KeyG" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    status.graphOverlay = !status.graphOverlay;
    const url = new URL(location.href);
    if (status.graphOverlay) url.searchParams.set("graph", "1");
    else url.searchParams.delete("graph");
    history.replaceState(null, "", url);
    render();
  });

  addEventListener("hashchange", () => {
    const c = parseGlobeHash(location.hash);
    if (c) { camera = c; render(); }
  });
  new ResizeObserver(() => render()).observe(canvas);

  render();
  if (gl.getError() !== gl.NO_ERROR) throw new Error("WebGL error during the first frame");

  status.pixel = (x: number, y: number) => {
    render();  // read before the browser clears the drawing buffer
    const dpr = devicePixelRatio;
    const out = new Uint8Array(4);
    gl.readPixels(Math.floor(x * dpr), canvas.height - 1 - Math.floor(y * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return [out[0]!, out[1]!, out[2]!];
  };
}

start().catch((err: unknown) => {
  status.state = "error";
  status.error = err instanceof Error ? err.message : String(err);
  console.error(err);
});
