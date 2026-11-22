// Viewer entry: stream the S2 cells around the camera and fly over them.
//
// URL: /?[graph=1][&radius=<m>][&planes=0]#lat,lon,alt,yaw,pitch
//   hash: the camera (without it, a default view of Denver); graph=1: the road
//   graph overlay (toggle with G); radius: fixed load radius instead of the
//   horizon; planes=0: no live air traffic. The URL describes the whole view.
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
  AIRCRAFT_PALETTE, aircraftMeshes, buildingMesh, CELL_LEVEL, placeVehicles, readGlb, VEHICLE_MODELS, VEHICLE_SCALE, CELL_TABLES, cellFromArrow, cellFrame, cellFromLatLon, cellsWithin, cellToken, flatTerrain,
  frameToFrame, horizonDistance, roadLineMesh, roadSurfaceMesh, terrainHeightAt, terrainMesh,
  type CellFiles, type CellId, type CellTerrain, type Frame as CellFrame,
} from "@game/world";
import { fromYawPitch, MIN_ALTITUDE, speed, viewProjection } from "./camera.ts";
import { AirTraffic, emptyAircraftInstances, emptyContrails } from "./air-traffic.ts";
import { createContrailLayer } from "./contrail-layer.ts";
import { createCarModels, createCarRenderer, type CarModels, type CarRenderer } from "./car-layer.ts";
import { createFlatLayer, type FlatLayer, type FlatMesh } from "./flat-layer.ts";
import { formatGlobeHash, localCamera, parseGlobeHash, stepGlobe, viewFrame, type GlobeCamera } from "./globe-camera.ts";
import { attachInput, isIdle } from "./input.ts";
import { createSolidLayer, type SolidLayer } from "./solid-layer.ts";
import { createTerrainLayer, type TerrainLayer } from "./terrain-layer.ts";
import { frustumPlanes, sphereVisible } from "./frustum.ts";
import { CellStreamer } from "./streaming.ts";
import { emptyInstances, TrafficView, type TrafficCell } from "./traffic-view.ts";
import {
  AEROWAY, BUILDING_COLORS_RGB, CLASS_COLORS_RGB, fogRange, MARKING_FADE, MARKINGS, SKY, SUN, SURFACE_COLORS, TERRAIN_STYLE, WATER,
} from "./style.ts";

export interface ViewerStatus {
  state: "loading" | "ready" | "error";
  error?: string;
  cells: { ready: number; loading: number; queued: number; failed: number; missing: number; drawn: number };
  radius: number;
  nodes: number;
  edges: number;
  surfaceTriangles: number;
  buildings: number;
  buildingTriangles: number;
  carModels: number;      // vehicle models loaded (0 until they are)
  cars: number;           // cars in the simulation
  carTriangles: number;   // drawn last frame
  simTime: number;        // s of traffic simulated
  aircraft: number;       // live aircraft known (drawn wherever they are)
  graphOverlay: boolean;
  frames: number;
  /** Render now and read the RGB at a CSS pixel (origin top left). */
  pixel?: (x: number, y: number) => [number, number, number];
}

declare global {
  interface Window { viewer: ViewerStatus }
}

/** Beyond this, the horizon needs coarser data (level of detail), which doesn't exist yet. */
const MAX_RADIUS = 25_000;
/** Cells stay loaded out to this multiple of the load radius, so the edge doesn't thrash. */
const KEEP_FACTOR = 1.3;
/** The load radius moves in steps of this (m), so climbing doesn't recompute the wanted cells every frame. */
const RADIUS_STEP = 500;
const MAX_DT = 0.1;  // s; a stalled tab must not teleport the camera
/** Downtown Denver, ~400 m above the ground (which is ~1,575 m above the ellipsoid there). */
const DEFAULT_CAMERA: GlobeCamera = { lat: 39.7444, lon: -104.9896, h: 1975, rot: fromYawPitch(0, -35 * Math.PI / 180) };
/** Terrain level of detail (index into TERRAIN_LOD_STEPS) by distance to the cell's center, m. */
const TERRAIN_LOD_DISTANCES = [4000, 8000, 16_000];
/** Roads drawn this far toward the camera from the ground they lie on (m, plus 0.1% of distance). */
const ROAD_BIAS = 0.3;
/** Water a little less than roads, so a road over a stream wins. */
const WATER_BIAS = 0.2;
/** Airport surfaces between water and roads: a service road across an apron wins. */
const AEROWAY_BIAS = 0.25;
/** Cells within this distance (m) get traffic (cars are ~2,100 triangles each); beyond 1.3× it they lose it. */
const CAR_DISTANCE = 1500;

const params = new URLSearchParams(location.search);
const fixedRadius = params.has("radius") ? Number(params.get("radius")) : undefined;
const showCars = params.get("cars") !== "0";
/** traffic=0: cars stand where they start (tests that look at exact pixels). */
const moving = showCars && params.get("traffic") !== "0";
const showPlanes = params.get("planes") !== "0";
const status: ViewerStatus = (window.viewer = {
  state: "loading", cells: { ready: 0, loading: 0, queued: 0, failed: 0, missing: 0, drawn: 0 }, radius: 0,
  nodes: 0, edges: 0, surfaceTriangles: 0, buildings: 0, buildingTriangles: 0, carModels: 0, cars: 0, carTriangles: 0, simTime: 0, aircraft: 0,
  graphOverlay: params.get("graph") === "1", frames: 0,
});

/** What can be seen from this height above the ground, out to MAX_RADIUS. */
const loadRadius = (h: number) =>
  fixedRadius ?? Math.min(MAX_RADIUS, Math.ceil(horizonDistance(h) / RADIUS_STEP) * RADIUS_STEP);

/** Platform adapter (architecture.md): in the browser, blobs come over HTTP and the HTTP cache. null: no such file. */
async function getBlob(path: string): Promise<Uint8Array | null> {
  const res = await fetch(path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  if (res.headers.get("content-type")?.startsWith("text/html")) return null;  // a dev server's index.html fallback
  return new Uint8Array(await res.arrayBuffer());
}

/** Farthest horizontal distance of interleaved points from the origin. */
function reach(points: ArrayLike<number>, stride: number): number {
  let r2 = 0;
  for (let i = 0; i < points.length; i += stride) r2 = Math.max(r2, points[i]! ** 2 + points[i + 1]! ** 2);
  return Math.sqrt(r2);
}

interface CellGpu {
  frame: CellFrame;
  missing: boolean;
  radius: number;  // bounding sphere around (0, 0, centerZ) in the frame, m: terrain, roads, building tops
  centerZ: number;
  model: Float32Array;  // this frame's cell → view transform, reused every frame
  terrain: CellTerrain;
  ground: TerrainLayer;
  lods: { start: number; count: number }[];
  roads?: FlatLayer;
  water?: FlatLayer;
  aeroways?: FlatLayer;
  lines?: FlatMesh;     // the graph overlay's mesh, uploaded on first use
  traffic?: TrafficCell;  // this cell's roads in the traffic sim
  graph?: FlatLayer;
  buildings?: SolidLayer;
  counts: { nodes: number; edges: number; surfaceTriangles: number; buildings: number; buildingTriangles: number };
}

/** The vehicle models and their shared palette texture, from the viewer's assets (Kenney Car Kit, CC0). */
async function loadCarModels(gl: WebGL2RenderingContext): Promise<CarModels> {
  const glb = (name: string) => fetch(new URL(`../assets/vehicles/${name}.glb`, import.meta.url)).then((r) => r.arrayBuffer());
  const [meshes, image] = await Promise.all([
    Promise.all(VEHICLE_MODELS.map(async (name) => readGlb(new Uint8Array(await glb(name)), VEHICLE_SCALE))),
    fetch(new URL("../assets/vehicles/colormap.png", import.meta.url)).then((r) => r.blob()).then((b) => createImageBitmap(b)),
  ]);
  return createCarModels(gl, meshes, image);
}

async function start(): Promise<void> {
  const canvas = document.querySelector("canvas")!;
  const hud = document.querySelector<HTMLElement>("#hud")!;
  const gl = canvas.getContext("webgl2", { antialias: true });
  if (!gl) throw new Error("WebGL2 is not available");

  const traffic = new TrafficView(1);
  const carInstances = emptyInstances();

  async function loadCell(cell: CellId): Promise<CellGpu> {
    const token = cellToken(cell);
    const blobs = await Promise.all(CELL_TABLES.map((t) => getBlob(`/cells/${token}/${t}.arrow`)));
    const frame = cellFrame(cell);
    const zero = { nodes: 0, edges: 0, surfaceTriangles: 0, buildings: 0, buildingTriangles: 0 };
    const missing = blobs.some((b) => b === null);
    const c = missing ? null : cellFromArrow(Object.fromEntries(CELL_TABLES.map((t, i) => [t, blobs[i]!])) as unknown as CellFiles);
    if (c && c.cell !== cell) throw new Error(`/cells/${token} holds cell ${cellToken(c.cell)}`);
    const terrain = c?.terrain ?? flatTerrain();
    const tm = terrainMesh(cell, frame, terrain);
    const ground = createTerrainLayer(gl!, tm, TERRAIN_STYLE);
    const groundReach = reach(tm.positions, 3);
    const model = new Float32Array(16);
    // Vertical extent: terrain (with its skirts) and building tops.
    let z0 = Infinity, z1 = -Infinity;
    for (let i = 2; i < tm.positions.length; i += 3) { z0 = Math.min(z0, tm.positions[i]!); z1 = Math.max(z1, tm.positions[i]!); }
    const sphere = (flat: number) => ({ centerZ: (z0 + z1) / 2, radius: Math.hypot(flat, (z1 - z0) / 2) });
    if (!c) return { frame, missing: true, ...sphere(groundReach), model, terrain, ground, lods: tm.lods, counts: zero };
    const surface = roadSurfaceMesh(c.graph);
    const lines = roadLineMesh(c.graph);
    const tris = buildingMesh(c.buildings);
    // Owned objects reach past the cell's edge; roads by up to half their width beyond their centerlines.
    const flat = Math.max(groundReach, reach(c.graph.points, 2) + 20, reach(c.buildings.points, 2));
    for (let i = 0; i < c.buildings.count; i++) z1 = Math.max(z1, c.buildings.base[i]! + c.buildings.height[i]!);
    return {
      frame,
      missing: false,
      ...sphere(flat),
      model,
      terrain,
      ground,
      lods: tm.lods,
      roads: createFlatLayer(gl!, surface, { mode: gl!.TRIANGLES, colors: SURFACE_COLORS, fade: MARKINGS, bias: ROAD_BIAS }),
      water: c.water.material.length === 0 ? undefined : createFlatLayer(gl!, {
        positions: c.water.positions, dims: 3, material: c.water.material,
        indices: Uint32Array.from({ length: c.water.material.length }, (_, i) => i),
      }, { mode: gl!.TRIANGLES, colors: WATER, bias: WATER_BIAS }),
      aeroways: c.aeroways.material.length === 0 ? undefined : createFlatLayer(gl!, {
        positions: c.aeroways.positions, dims: 3, material: c.aeroways.material,
        indices: Uint32Array.from({ length: c.aeroways.material.length }, (_, i) => i),
      }, { mode: gl!.TRIANGLES, colors: AEROWAY, bias: AEROWAY_BIAS }),
      lines: { positions: lines.positions, material: lines.pointClass, indices: lines.indices },
      traffic: c.graph.edges.count === 0 ? undefined
        : traffic.add(c.graph, placeVehicles(c.graph, Number(BigInt.asUintN(32, cell ^ (cell >> 32n)))), model),
      buildings: createSolidLayer(gl!, tris, BUILDING_COLORS_RGB),
      counts: {
        nodes: c.graph.nodes.count, edges: c.graph.edges.count, surfaceTriangles: surface.indices.length / 3,
        buildings: c.buildings.count, buildingTriangles: tris.indices.length / 3,
      },
    };
  }

  const streamer = new CellStreamer<CellGpu>({
    load: loadCell,
    concurrency: 8,
    dispose: (g) => {
      [g.ground, g.water, g.aeroways, g.roads, g.graph, g.buildings].forEach((l) => l?.dispose());
      if (g.traffic) traffic.remove(g.traffic);
    },
    onChange: () => {
      updateStatus();
      if (!running) render();
    },
  });

  const aspect = () => canvas.clientWidth / Math.max(1, canvas.clientHeight);
  let camera: GlobeCamera = parseGlobeHash(location.hash) ?? DEFAULT_CAMERA;
  history.replaceState(null, "", formatGlobeHash(camera));

  /** The ground's height under a point, from its loaded cell; the last known height while it loads. */
  let lastGround = 0;
  const groundAt = (lat: number, lon: number): number => {
    const cell = cellFromLatLon(lat, lon, CELL_LEVEL);
    const g = streamer.get(cell);
    if (g) lastGround = terrainHeightAt(cell, g.terrain, lat, lon);
    return lastGround;
  };

  // Live aircraft: drawn on the loaded terrain when taxiing; elsewhere on the ground under the camera.
  const air = new AirTraffic((lat, lon) => {
    const cell = cellFromLatLon(lat, lon, CELL_LEVEL), g = streamer.get(cell);
    return g ? terrainHeightAt(cell, g.terrain, lat, lon) : lastGround;
  });
  const planeInstances = emptyAircraftInstances();
  const planeRenderer = showPlanes
    ? createCarRenderer(gl, createCarModels(gl, aircraftMeshes(), new ImageData(new Uint8ClampedArray(AIRCRAFT_PALETTE), 16, 1)))
    : undefined;
  const contrails = emptyContrails();
  const contrailLayer = showPlanes ? createContrailLayer(gl) : undefined;
  air.onUpdate = () => wake();

  // --- which cells: refreshed when the camera enters another cell or the radius steps ---
  let refreshedCell: CellId | null = null;
  let refreshedRadius = 0;
  const refreshCells = () => {
    const radius = loadRadius(camera.h - groundAt(camera.lat, camera.lon));
    const here = cellFromLatLon(camera.lat, camera.lon, CELL_LEVEL);
    if (here === refreshedCell && radius === refreshedRadius) return;
    refreshedCell = here;
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
    Object.assign(status, totals, { cells: { ready, loading, queued, failed, missing, drawn: status.cells.drawn } });
    if (status.state === "loading" && streamer.settled) status.state = "ready";
  };

  // Vehicle models load alongside the first cells; traffic starts once they're in.
  let carRenderer: CarRenderer | undefined;
  loadCarModels(gl).then((m: CarModels) => {
    carRenderer = createCarRenderer(gl, m);
    status.carModels = VEHICLE_MODELS.length;
    if (moving) wake();
    else if (!running) render();
  }, (err: unknown) => console.error("vehicle models failed to load:", err));

  const visible: CellGpu[] = [];  // reused every frame
  /** Renders a frame; dt (s) advances the traffic. */
  const render = (dt = 0) => {
    const t0 = performance.now();
    // Terrain may have arrived under the camera since it last moved.
    const ground = groundAt(camera.lat, camera.lon);
    if (camera.h < ground + MIN_ALTITUDE) camera = { ...camera, h: ground + MIN_ALTITUDE };
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
    // Frustum culling: a cell's frame origin lands at the model matrix's translation.
    const vf = viewFrame(camera);
    const planes = frustumPlanes(f.view);
    visible.length = 0;
    streamer.forEachReady((g) => {
      frameToFrame(g.frame, vf, g.model);
      const m = g.model, cz = g.centerZ;
      const seen = sphereVisible(planes, m[12]! + m[8]! * cz, m[13]! + m[9]! * cz, m[14]! + m[10]! * cz, g.radius);
      if (seen) visible.push(g);
      if (g.traffic) g.traffic.visible = seen;
    });
    status.cells.drawn = visible.length;
    // Terrain first, at a level of detail by distance (skirts hide the cracks between levels), then
    // roads nudged toward the camera, then buildings; everything depth-tested.
    for (const g of visible) {
      const d = Math.hypot(g.model[12]!, g.model[13]!, g.model[14]! + g.centerZ - camera.h);
      let lod = 0;
      while (lod < TERRAIN_LOD_DISTANCES.length && d > TERRAIN_LOD_DISTANCES[lod]!) lod++;
      g.ground.draw(f, g.model, SUN, g.lods[lod]);
    }
    for (const g of visible) g.water?.draw(f, g.model);
    for (const g of visible) g.aeroways?.draw(f, g.model);
    for (const g of visible) g.roads?.draw(f, g.model);
    for (const g of visible) g.buildings?.draw(f, g.model, SUN);
    let carTriangles = 0;
    if (carRenderer && showCars) {
      // Horizontal distance to the cell's anchor (which sits at the ellipsoid, not at the ground or the camera).
      const near = (tc: TrafficCell) => Math.hypot(tc.model[12]!, tc.model[13]!);
      traffic.update(dt, near, CAR_DISTANCE, 1.3 * CAR_DISTANCE, moving);
      traffic.instances(carInstances);
      carTriangles = carRenderer.draw(f, SUN, ROAD_BIAS, carInstances);
    }
    if (planeRenderer) {
      const now = performance.now() / 1000;
      air.refresh(camera.lat, camera.lon, now);
      air.instances(vf, now, planeInstances);
      planeRenderer.draw(f, SUN, ROAD_BIAS, planeInstances);
    }
    const cars = traffic.cars.count;
    Object.assign(status, { cars, carTriangles, simTime: traffic.simTime, aircraft: air.count });
    if (contrailLayer) {
      // Last: blended over everything, without writing depth.
      air.contrails(vf, performance.now() / 1000, contrails);
      contrailLayer.draw(f, contrails, h);
    }
    if (status.graphOverlay) {
      for (const g of visible) {
        if (g.lines && !g.graph) g.graph = createFlatLayer(gl, g.lines, { mode: gl.LINES, colors: CLASS_COLORS_RGB, bias: 1 });
        g.graph?.draw(f, g.model);
      }
    }
    status.frames++;
    cpuMs = performance.now() - t0;
    const c = status.cells;
    const agl = camera.h - ground;
    hud.textContent = `${camera.lat.toFixed(5)}, ${camera.lon.toFixed(5)} · ${agl.toFixed(0)} m above ground ` +
      `(${ground.toFixed(0)} m) · ${speed({ pos: [0, 0, agl], rot: camera.rot }, false).toFixed(0)} m/s (Shift ×4) · cells ${c.drawn} drawn / ${c.ready - c.missing}` +
      `${c.loading + c.queued ? ` +${c.loading + c.queued} loading` : ""}${c.failed ? `, ${c.failed} failed` : ""} ` +
      `within ${(status.radius / 1000).toFixed(1)} km · ${cars} cars (${(carTriangles / 1e6).toFixed(1)}M tris) · ${air.count} aircraft · ${fps > 0 ? fps.toFixed(0) : "–"} fps, ${cpuMs.toFixed(1)} ms CPU`;
  };

  // --- frame loop: running while there is input, or while traffic or aircraft move ---
  let running = false;
  let steering = false;  // input this frame
  let last = 0;
  let fps = 0;    // smoothed while running; kept when idle
  let cpuMs = 0;  // last frame's CPU time: culling, matrices and draw submission (not GPU time)
  const frame = (now: number) => {
    const raw = (now - last) / 1000;
    const dt = Math.min(MAX_DT, raw);
    last = now;
    if (raw > 0) fps = fps === 0 ? 1 / raw : 0.9 * fps + 0.1 / raw;
    const input = keys.take();
    if (isIdle(input)) {
      // Input just stopped: the pose goes to the URL.
      if (steering) history.replaceState(null, "", formatGlobeHash(camera));
      steering = false;
      if (!(moving && carRenderer) && air.count === 0) {
        running = false;
        return;
      }
    } else {
      steering = true;
      camera = stepGlobe(camera, input, dt, groundAt);
    }
    render(dt);
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
