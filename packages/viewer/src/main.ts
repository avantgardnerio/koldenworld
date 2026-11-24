// Viewer entry: stream the S2 cells around the camera and fly over them.
//
// URL: /?[graph=1][&radius=<m>][&planes=0]#lat,lon,alt,yaw,pitch
//   hash: the camera (without it, a default view of Denver); graph=1: the road
//   graph overlay (toggle with G); radius: fixed load radius instead of the
//   horizon; planes=0: no live air traffic. The URL describes the whole view.
//
// Three tiers of ground from the Rust generator (/ground/<token>/…): far tiles
// (S2 level 7, ~70 km: terrain, land cover, lakes) out to the horizon (up to
// MAX_RADIUS), coarse tiles (level 10, ~9 km: streets, water, airports, coarse
// terrain) out to COARSE_DISTANCE, with their buildings as massing (blocks and
// towers), and fine cells (level 13, ~1.1 km: everything)
// within FINE_DISTANCE of the camera, with their roads, buildings and terrain
// from the cell server (/cells/<token>…; a cell with none, 404, is bare
// ground). Only what's in view loads: far tiles first, then coarse tiles, then
// fine cells, each nearest first. Each tier covers the coarser ground under it
// (stencil),
// and hide the massing in them (each massing shape knows its fine cell), so a
// coarse tile shows wherever its fine cells haven't loaded.
//
// Frames are rendered only while something changes: a held key or mouse
// movement starts the loop, and it stops (and writes the pose to the URL) once
// input goes idle. A cell arriving renders one frame.
//
// window.viewer exposes status and a pixel probe so headless tests can check
// what was drawn without decoding screenshots.

import {
  AIRCRAFT_PALETTE, aircraftMeshes, PEOPLE_PALETTE, personMesh, pistolMesh, placeVagrants, playerMesh, rifleCarryMesh, rifleMesh, slingMesh, vagrantMesh, womanMesh, buildingMesh, businessSigns, wallGrid, type WallGrid, cellLevel, cellOutline, ecefToLocal, enuUnprojection, geodeticToEcef, streetSigns, CELL_LEVEL, placeVehicles, readGlb, VEHICLE_MODELS, VEHICLE_SCALE, CELL_TABLES, cellFromArrow, cellFrame, cellFromLatLon, cellsWithin, cellToken, flatTerrain,
  frameToFrame, groundFromArrow, unpackCellFiles, horizonDistance, roadLineMesh, terrainHeightAt,
  type CellFiles, type CellId, type CellTerrain, type Frame as CellFrame, type Vec3,
} from "@game/world";
import { fromYawPitch, MIN_ALTITUDE, NEAR, viewProjection, yawPitch } from "./camera.ts";
import { Drive } from "./drive.ts";
import type { LoadedWorld } from "./local-world.ts";
import { OnFoot } from "./on-foot.ts";
import { AirTraffic, emptyAircraftInstances, emptyContrails } from "./air-traffic.ts";
import { createContrailLayer } from "./contrail-layer.ts";
import { createCarModels, createCarRenderer, type CarInstances, type CarModels, type CarRenderer } from "./car-layer.ts";
import { heldGun, ITEMS } from "@game/sim";
import { gunshot } from "./audio.ts";
import { createEffectsLayer, Effects } from "./effects-layer.ts";
import { Instruments, type HandData } from "./instruments.ts";
import { PeopleView } from "./people-view.ts";
import { VagrantView, type RoamCell } from "./vagrant-view.ts";
import { createPersonRenderer, PERSON_STRIDE, type PersonInstances } from "./person-layer.ts";
import { createFlatLayer, type FlatLayer, type FlatMesh } from "./flat-layer.ts";
import { formatGlobeHash, localCamera, parseGlobeHash, stepGlobe, viewFrame, type GlobeCamera } from "./globe-camera.ts";
import { attachInput, isIdle } from "./input.ts";
import { businessSignBoxes, createSignLayer, streetSignBoxes, type SignLayer } from "./sign-layer.ts";
import { createSolidLayer, type SolidLayer } from "./solid-layer.ts";
import { frustumPlanes, sphereVisible } from "./frustum.ts";
import { CellStreamer } from "./streaming.ts";
import { CAR_HALF, emptyInstances, TrafficView, type TrafficCell } from "./traffic-view.ts";
import {
  BUILDING_COLORS_RGB, BUILDING_WINDOWS, GROUND, PAINTS, CLASS_COLORS_RGB, fogRange, MASSING, SKY, SUN,
} from "./style.ts";

export interface ViewerStatus {
  state: "loading" | "ready" | "error";
  error?: string;
  cells: { ready: number; loading: number; queued: number; failed: number; missing: number; coarse: number; drawn: number };
  radius: number;
  nodes: number;
  edges: number;
  surfaceTriangles: number;
  buildings: number;
  buildingTriangles: number;
  carModels: number;      // vehicle models loaded (0 until they are)
  cars: number;           // cars in the simulation
  carTriangles: number;   // drawn last frame
  /** Triangles drawn last frame, by what: ground (every tier), fine cells' buildings, coarse massing, cars. */
  drawn: { ground: number; buildings: number; massing: number; cars: number };
  simTime: number;        // s of traffic simulated
  aircraft: number;       // live aircraft known (drawn wherever they are)
  people: number;         // pedestrians in the simulation
  graphOverlay: boolean;
  frames: number;
  /** Render now and read the RGB at a CSS pixel (origin top left). */
  pixel?: (x: number, y: number) => [number, number, number];
}

declare global {
  interface Window { viewer: ViewerStatus }
}

/** Nothing loads beyond this, m: the far tier out to well past the Front Range seen from Denver. */
const MAX_RADIUS = 150_000;
/** The coarse tier's S2 level (as cellgen's COARSE_LEVEL): ground and massing, drawn where fine cells aren't. */
const COARSE_LEVEL = 10;
/** Coarse tiles load within this distance (m) of the camera; the far tier beyond. */
const COARSE_DISTANCE = 25_000;
/** The far tier's S2 level (as cellgen's FAR_LEVEL): terrain, land cover and lakes, drawn where coarse tiles aren't. */
const FAR_LEVEL = 7;
/** How high, m above the ground under the camera, the horizon is worth loading for: Colorado's mountains. */
const MOUNTAINS = 3000;
/** Fine cells load within this straight-line distance (m) of the camera, so none load from high up. */
const FINE_DISTANCE = 3000;
/** Room for the terrain's relief around a cell's bounding sphere when deciding if it's in view, m. */
const RELIEF = 3000;
/** Cells stay loaded out to this multiple of the load radius, so the edge doesn't thrash. */
const KEEP_FACTOR = 1.3;
/** The load radius moves in steps of this (m), so climbing doesn't recompute the wanted cells every frame. */
const RADIUS_STEP = 500;
const MAX_DT = 0.1;  // s; a stalled tab must not teleport the camera
/** Downtown Denver, ~400 m above the ground (which is ~1,575 m above the ellipsoid there). */
const DEFAULT_CAMERA: GlobeCamera = { lat: 39.7444, lon: -104.9896, h: 1975, rot: fromYawPitch(0, -35 * Math.PI / 180) };
/** Cars and planes drawn this far toward the camera from the ground they're on (m, plus 0.1% of distance). */
const ROAD_BIAS = 0.3;
/** Coarse tiles' massing is drawn only within this distance (m): past it a 15 m building is about a pixel tall. */
const MASSING_DISTANCE = 12_000;
/** The car the player drives (V): a sedan, as the traffic draws one. */
const PLAYER_MODEL = VEHICLE_MODELS.indexOf("sedan");
/** Driving with the mouse: the wheel's full lock is this many px of movement away (1/px), the pedal's full travel this many. */
const MOUSE_WHEEL = 1 / 400, MOUSE_PEDAL = 1 / 300;
/** Cars farther than this (m) from the camera are drawn as simple stand-ins (~20 px long there). */
const CAR_LOD_DISTANCE = 250;
/** Cells within this distance (m) get traffic (cars are ~2,100 triangles each); beyond 1.3× it they lose it. */
const CAR_DISTANCE = 1500;
/** Cells within this distance (m) get people on their sidewalks; beyond 1.3× it they lose them. */
const PEOPLE_DISTANCE = 800;

const params = new URLSearchParams(location.search);
const fixedRadius = params.has("radius") ? Number(params.get("radius")) : undefined;
const showCars = params.get("cars") !== "0";
/** traffic=0: cars stand where they start (tests that look at exact pixels). */
const moving = showCars && params.get("traffic") !== "0";
const showPlanes = params.get("planes") !== "0";
/** people=0: no pedestrians; with traffic=0, they stand where they start. */
const showPeople = params.get("people") !== "0";
const walking = showPeople && params.get("traffic") !== "0";
const status: ViewerStatus = (window.viewer = {
  state: "loading", cells: { ready: 0, loading: 0, queued: 0, failed: 0, missing: 0, coarse: 0, drawn: 0 }, radius: 0,
  nodes: 0, edges: 0, surfaceTriangles: 0, buildings: 0, buildingTriangles: 0, carModels: 0, cars: 0, carTriangles: 0, drawn: { ground: 0, buildings: 0, massing: 0, cars: 0 }, simTime: 0, aircraft: 0, people: 0,
  graphOverlay: params.get("graph") === "1", frames: 0,
});

/** What can be seen from this height above the ground (mountains included), out to MAX_RADIUS. */
const loadRadius = (h: number) =>
  fixedRadius ?? Math.min(MAX_RADIUS, Math.ceil(horizonDistance(h, MOUNTAINS) / RADIUS_STEP) * RADIUS_STEP);

/** Platform adapter (architecture.md): in the browser, blobs come over HTTP and the HTTP cache. null: no such file. */
async function getBlob(path: string): Promise<Uint8Array | null> {
  const res = await fetch(path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  if (res.headers.get("content-type")?.startsWith("text/html")) return null;  // a dev server's index.html fallback
  return new Uint8Array(await res.arrayBuffer());
}

/** A bounding sphere around (0, 0, centerZ) for positions (x, y, z interleaved) reaching `flat` m sideways, and the heights of `more`. */
function bounds(positions: Float32Array, flat: number, more?: Float32Array): { centerZ: number; radius: number } {
  let z0 = Infinity, z1 = -Infinity;
  for (const ps of [positions, more ?? positions]) {
    for (let i = 2; i < ps.length; i += 3) { z0 = Math.min(z0, ps[i]!); z1 = Math.max(z1, ps[i]!); }
  }
  return { centerZ: (z0 + z1) / 2, radius: Math.hypot(flat, (z1 - z0) / 2) };
}

/**
 * A tile's 64 cells three levels down (a coarse tile's fine cells, a far tile's coarse tiles), by the index its ground
 * and massing ranges know them by: the three levels' Hilbert positions, the bits just below the tile's own.
 */
function children(tile: CellId): CellId[] {
  const lsb = (level: number) => 1n << BigInt(2 * (30 - level));
  const level = cellLevel(tile), prefix = tile ^ lsb(level), shift = BigInt(2 * (30 - (level + 3)) + 1);
  return Array.from({ length: 64 }, (_, i) => prefix | (BigInt(i) << shift) | lsb(level + 3));
}

/**
 * Into `runs`, the (first index, index count) pairs of the ranges (child, first triangle, triangles) whose child
 * `skip` doesn't leave out, neighbors in the index buffer as one run; returns how many.
 */
function runsWithout(ranges: [number, number, number][], skip: (child: number) => boolean, runs: Uint32Array): number {
  let n = 0;
  for (const [child, first, count] of ranges) {
    if (skip(child)) continue;
    if (n > 0 && runs[2 * n - 2]! + runs[2 * n - 1]! === 3 * first) runs[2 * n - 1]! += 3 * count;
    else [runs[2 * n], runs[2 * n + 1], n] = [3 * first, 3 * count, n + 1];
  }
  return n;
}

/** Farthest horizontal distance of interleaved points from the origin. */
function reach(points: ArrayLike<number>, stride: number): number {
  let r2 = 0;
  for (let i = 0; i < points.length; i += stride) r2 = Math.max(r2, points[i]! ** 2 + points[i + 1]! ** 2);
  return Math.sqrt(r2);
}

interface CellGpu {
  frame: CellFrame;
  coarse: boolean;  // a coarse or far tile: ground (and a coarse tile's massing)
  far?: boolean;    // a far tile: drawn where coarse tiles aren't
  massing?: SolidLayer;  // a coarse tile's buildings, merged; a shape hides where its fine cell is loaded
  children?: CellId[];   // a coarse or far tile's 64 cells three levels down, by the index its ranges know them by
  groundRanges?: [child: number, first: number, count: number][];  // a coarse or far tile's ground triangles per child
  massingRanges?: [child: number, first: number, count: number][];  // the massing's triangles per fine cell
  runs?: Uint32Array;    // this frame's ground or massing to draw: (first index, index count) pairs, reused
  missing: boolean;
  radius: number;  // bounding sphere around (0, 0, centerZ) in the frame, m: the ground, roads, building tops
  centerZ: number;
  model: Float32Array;  // this frame's cell → view transform, reused every frame
  terrain: CellTerrain;  // heights, for cars and the camera
  ground: SolidLayer;  // every point of the cell one kind of ground, draped on the terrain: from the Rust generator
  lines?: FlatMesh;     // the graph overlay's mesh, uploaded on first use
  traffic?: TrafficCell;  // this cell's roads in the traffic sim
  graph?: FlatLayer;
  buildings?: SolidLayer;
  signs?: SignLayer;
  walls?: WallGrid;      // a fine cell's building walls, for the driven car's collisions
  vagrants?: RoamCell;   // a fine cell with places that draw vagrants, in their sim
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
  const instruments = new Instruments(document.querySelector<HTMLCanvasElement>("#instruments")!);
  // The camera's motion, for the instruments: where it was last frame (ECEF), and its smoothed speed and climb.
  let lastEcef: Vec3 | undefined, lastH = 0, groundSpeed = 0, climb = 0;
  const gl = canvas.getContext("webgl2", { antialias: true, stencil: true });
  if (!gl) throw new Error("WebGL2 is not available");

  const traffic = new TrafficView(1);
  const carInstances = emptyInstances();
  const peopleView = new PeopleView(1);
  const vagrantView = new VagrantView(2);
  const nearCars = new Float64Array(5 * 256);  // the traffic cars near the player's car, for its collisions

  async function loadCell(cell: CellId): Promise<CellGpu> {
    const token = cellToken(cell);
    // The ground comes made from the Rust generator (/ground → `cellgen serve`): every point of the cell one kind,
    // draped on the terrain, as GPU buffers. Nothing here builds ground; a cell without it fails.
    const ground = Promise.all([getBlob(`/ground/${token}/ground.arrow`), getBlob(`/ground/${token}/ground_triangles.arrow`)])
      .then(([v, t]) => {
        if (!v || !t) throw new Error(`/ground/${token}: no ground`);
        return groundFromArrow(v, t);
      });
    const frame = cellFrame(cell);
    const zero = { nodes: 0, edges: 0, surfaceTriangles: 0, buildings: 0, buildingTriangles: 0 };
    if (cellLevel(cell) !== CELL_LEVEL) {
      // Coarse tiles have massing; far tiles are ground only.
      const coarseTile = cellLevel(cell) === COARSE_LEVEL;
      const [v, t] = coarseTile
        ? await Promise.all([getBlob(`/ground/${token}/buildings.arrow`), getBlob(`/ground/${token}/buildings_triangles.arrow`)])
        : [null, null];
      const mesh = await ground, massing = v && t ? groundFromArrow(v, t) : undefined;
      // The ground's reach, up to the tallest roof.
      const sphere = bounds(mesh.positions, reach(mesh.positions, 3), massing?.positions);
      return {
        frame, coarse: true, far: !coarseTile, missing: false, model: new Float32Array(16), terrain: flatTerrain(),
        ground: createSolidLayer(gl!, mesh, GROUND), ...sphere,
        massing: massing && createSolidLayer(gl!, massing, MASSING),
        groundRanges: mesh.ranges, massingRanges: massing?.ranges,
        runs: new Uint32Array(2 * Math.max(mesh.ranges.length, massing?.ranges.length ?? 0)),
        children: children(cell),
        counts: { ...zero, surfaceTriangles: mesh.indices.length / 3, buildingTriangles: massing ? massing.indices.length / 3 : 0 },
      };
    }
    // Every other table in one response from the cell server; a file per table when served as static files.
    const packed = await getBlob(`/cells/${token}.cell`);
    const files = packed && unpackCellFiles(packed);
    const blobs = files ? CELL_TABLES.map((t) => files[t]) : await Promise.all(CELL_TABLES.map((t) => getBlob(`/cells/${token}/${t}.arrow`)));
    const missing = blobs.some((b) => b === null);
    const c = missing ? null : cellFromArrow(Object.fromEntries(CELL_TABLES.map((t, i) => [t, blobs[i]!])) as unknown as CellFiles);
    if (c && c.cell !== cell) throw new Error(`/cells/${token} holds cell ${cellToken(c.cell)}`);
    const terrain = c?.terrain ?? flatTerrain();
    const mesh = await ground;
    const layer = createSolidLayer(gl!, mesh, GROUND);
    const model = new Float32Array(16);
    // Vertical extent: the ground and building tops.
    let z0 = Infinity, z1 = -Infinity;
    for (let i = 2; i < mesh.positions.length; i += 3) { z0 = Math.min(z0, mesh.positions[i]!); z1 = Math.max(z1, mesh.positions[i]!); }
    const sphere = (flat: number) => ({ centerZ: (z0 + z1) / 2, radius: Math.hypot(flat, (z1 - z0) / 2) });
    const groundReach = reach(mesh.positions, 3);
    const counts = { ...zero, surfaceTriangles: mesh.indices.length / 3 };
    if (!c) return { frame, coarse: false, missing: true, ...sphere(groundReach), model, terrain, ground: layer, counts };
    const lines = roadLineMesh(c.graph);
    // Businesses: shopfronts on their buildings' ground floors, and a sign each.
    const shops = businessSigns(c.buildings, c.pois);
    const tris = buildingMesh(c.buildings, shops.shopfront);
    // Owned objects reach past the cell's edge; roads by up to half their width beyond their centerlines.
    const flat = Math.max(groundReach, reach(c.graph.points, 2) + 20, reach(c.buildings.points, 2));
    for (let i = 0; i < c.buildings.count; i++) z1 = Math.max(z1, c.buildings.base[i]! + c.buildings.height[i]!);
    // Where the cell's cars, people and vagrants start.
    const seed = Number(BigInt.asUintN(32, cell ^ (cell >> 32n)));
    const walls = wallGrid(c.buildings), unproject = enuUnprojection(frame);
    const roam: RoamCell = {
      model, walls, visible: false, placements: placeVagrants(c.pois, c.buildings, seed ^ 0x85ebca6b),
      ground: (x, y) => {
        const [lon, lat] = unproject(x, y);
        return terrainHeightAt(cell, terrain, lat, lon);
      },
    };
    return {
      frame,
      coarse: false,
      missing: false,
      ...sphere(flat),
      model,
      terrain,
      ground: layer,
      lines: { positions: lines.positions, material: lines.pointClass, indices: lines.indices },
      traffic: c.graph.edges.count === 0 ? undefined
        : peopleView.add(traffic.add(c.graph, placeVehicles(c.graph, seed), model), seed ^ 0x9e3779b9),
      buildings: createSolidLayer(gl!, tris, BUILDING_COLORS_RGB, BUILDING_WINDOWS, PAINTS),
      // Street name signs at the intersections this cell owns, and its businesses' signs.
      signs: createSignLayer(gl!, [
        ...streetSignBoxes(streetSigns(c.graph, (x, y) => {
          const [lon, lat] = enuUnprojection(frame)(x, y);
          return cellFromLatLon(lat, lon, CELL_LEVEL) === cell;
        })),
        ...businessSignBoxes(shops.signs),
      ]),
      walls,
      vagrants: roam.placements.count > 0 ? vagrantView.add(roam) : undefined,
      counts: {
        ...counts, nodes: c.graph.nodes.count, edges: c.graph.edges.count,
        buildings: c.buildings.count, buildingTriangles: tris.indices.length / 3,
      },
    };
  }

  const streamer = new CellStreamer<CellGpu>({
    load: loadCell,
    concurrency: 16,  // the cell server builds on a pool of workers
    dispose: (g) => {
      [g.ground, g.graph, g.buildings, g.massing, g.signs].forEach((l) => l?.dispose());
      if (g.traffic) {
        peopleView.remove(g.traffic);
        traffic.remove(g.traffic);
      }
      if (g.vagrants) vagrantView.remove(g.vagrants);
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
  /** Roughly the ground's height under a point: from its fine cell, else the middle of its coarse tile's heights. */
  const roughGroundAt = (lat: number, lon: number): number => {
    const fine = streamer.get(cellFromLatLon(lat, lon, CELL_LEVEL));
    if (fine) return groundAt(lat, lon);
    return streamer.get(cellFromLatLon(lat, lon, COARSE_LEVEL))?.centerZ ?? lastGround;
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
  // People (P): rows of them walking the sidewalks.
  const personRenderer = createPersonRenderer(gl, personMesh(), new ImageData(new Uint8ClampedArray(PEOPLE_PALETTE), 16, 1));
  const personInstances: PersonInstances = { data: new Float32Array(PERSON_STRIDE * 64), count: 0 };
  const womanRenderer = createPersonRenderer(gl, womanMesh(), new ImageData(new Uint8ClampedArray(PEOPLE_PALETTE), 16, 1));
  const womanInstances: PersonInstances = { data: new Float32Array(PERSON_STRIDE * 64), count: 0 };
  // Vagrants: around the places that draw them, roaming anywhere.
  const vagrantRenderer = createPersonRenderer(gl, vagrantMesh(), new ImageData(new Uint8ClampedArray(PEOPLE_PALETTE), 16, 1));
  const vagrantInstances: PersonInstances = { data: new Float32Array(PERSON_STRIDE * 64), count: 0 };
  // The player on foot.
  const playerRenderer = createPersonRenderer(gl, playerMesh(), new ImageData(new Uint8ClampedArray(PEOPLE_PALETTE), 16, 1));
  const playerInstances: PersonInstances = { data: new Float32Array(PERSON_STRIDE), count: 0 };
  // What's in their hand (drawn with them), and what shots leave behind.
  const pistolRenderer = createPersonRenderer(gl, pistolMesh(), new ImageData(new Uint8ClampedArray(PEOPLE_PALETTE), 16, 1));
  const rifleRenderer = createPersonRenderer(gl, rifleMesh(), new ImageData(new Uint8ClampedArray(PEOPLE_PALETTE), 16, 1));
  const rifleCarryRenderer = createPersonRenderer(gl, rifleCarryMesh(), new ImageData(new Uint8ClampedArray(PEOPLE_PALETTE), 16, 1));
  const slingRenderer = createPersonRenderer(gl, slingMesh(), new ImageData(new Uint8ClampedArray(PEOPLE_PALETTE), 16, 1));
  const effects = new Effects(), effectsLayer = createEffectsLayer(gl);
  const contrails = emptyContrails();
  const contrailLayer = showPlanes ? createContrailLayer(gl) : undefined;
  air.onUpdate = () => wake();

  // --- which cells: every frame, from what's in view ---
  /** A cell's center and how far its corners reach from it, at the ellipsoid: for its bounding sphere. Cached. */
  const outlines = new Map<CellId, { lat: number; lon: number; reach: number }>();
  const outlineOf = (cell: CellId) => {
    let o = outlines.get(cell);
    if (!o) {
      if (outlines.size > 20_000) outlines.clear();
      const { center, corners } = cellOutline(cell);
      const c = geodeticToEcef({ ...center, h: 0 });
      const reach = Math.max(...corners.map((k) => {
        const p = geodeticToEcef({ ...k, h: 0 });
        return Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
      }));
      outlines.set(cell, o = { ...center, reach });
    }
    return o;
  };
  const refreshCells = (planes: Float64Array, vf: CellFrame) => {
    // Before the fine cell under the camera loads, its coarse tile says roughly how high the camera is.
    const ground = roughGroundAt(camera.lat, camera.lon), above = camera.h - ground;
    const radius = loadRadius(above);
    const fine = Math.min(FINE_DISTANCE, radius);
    status.radius = radius;
    // In view: the cell's bounding sphere, at the height of the ground under the camera, with room for relief.
    const inView = (cell: CellId) => {
      const o = outlineOf(cell);
      const [x, y, z] = ecefToLocal(vf, geodeticToEcef({ lat: o.lat, lon: o.lon, h: ground }));
      return sphereVisible(planes, x, y, z, o.reach + RELIEF);
    };
    const coarseRadius = Math.min(radius, COARSE_DISTANCE);
    const far = cellsWithin(camera.lat, camera.lon, radius * KEEP_FACTOR, FAR_LEVEL);
    const coarse = cellsWithin(camera.lat, camera.lon, coarseRadius * KEEP_FACTOR, COARSE_LEVEL);
    // Fine cells by straight-line distance: from high up, none.
    const near = above < fine * KEEP_FACTOR
      ? cellsWithin(camera.lat, camera.lon, Math.sqrt((fine * KEEP_FACTOR) ** 2 - above ** 2), CELL_LEVEL)
          .map((c) => ({ cell: c.cell, distance: Math.hypot(c.distance, above) }))
      : [];
    const wanted = [
      ...far.filter((c) => c.distance <= radius),
      ...coarse.filter((c) => c.distance <= coarseRadius),
      ...near.filter((c) => c.distance <= fine),
    ]
      .map((c) => c.cell)
      .filter(inView);
    streamer.update(wanted, new Set([...far, ...coarse, ...near].map((c) => c.cell)));
    updateStatus();
  };

  const updateStatus = () => {
    const totals = { nodes: 0, edges: 0, surfaceTriangles: 0, buildings: 0, buildingTriangles: 0 };
    let missing = 0, coarse = 0;
    for (const [, g] of streamer.ready()) {
      for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += g.counts[k];
      if (g.missing) missing++;
      if (g.coarse) coarse++;
    }
    const { ready, loading, queued, failed } = streamer.counts();
    Object.assign(status, totals, { cells: { ready, loading, queued, failed, missing, coarse, drawn: status.cells.drawn } });
    if (status.state === "loading" && streamer.settled) status.state = "ready";
  };

  // Vehicle models load alongside the first cells; traffic starts once they're in.
  let carRenderer: CarRenderer | undefined;
  loadCarModels(gl).then((m: CarModels) => {
    carRenderer = createCarRenderer(gl, m, CAR_LOD_DISTANCE);
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
    const dpr = devicePixelRatio;
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(SKY[0]!, SKY[1]!, SKY[2]!, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    const local = localCamera(camera);
    const f = {
      // The near plane moves out with height above the ground (0.5 m on the street, 15 m from 1.5 km up), so the depth
      // buffer still separates ridges 100 km away.
      view: viewProjection(local, aspect(), Math.max(NEAR, Math.min(50, (camera.h - roughGroundAt(camera.lat, camera.lon)) / 100))),
      eye: local.pos,
      sky: SKY,
      fog: fogRange(status.radius),
    };
    // Each cell's frame → the view frame, computed in f64, then cast (decision 20).
    // Frustum culling: a cell's frame origin lands at the model matrix's translation.
    const vf = viewFrame(camera);
    const planes = frustumPlanes(f.view);
    refreshCells(planes, vf);
    visible.length = 0;
    streamer.forEachReady((g) => {
      frameToFrame(g.frame, vf, g.model);
      const m = g.model, cz = g.centerZ;
      const seen = sphereVisible(planes, m[12]! + m[8]! * cz, m[13]! + m[9]! * cz, m[14]! + m[10]! * cz, g.radius);
      if (seen) visible.push(g);
      if (g.traffic) g.traffic.visible = seen;
      if (g.vagrants) g.vagrants.visible = seen;
    });
    status.cells.drawn = visible.length;
    // The ground first (airports are part of it), then buildings; everything depth-tested.
    // Finest first. A coarse or far tile leaves out its children that are loaded (its ground there is coarser, and
    // can poke up through theirs where its terrain is higher). Then the stencil, for the seams: fine ground marks it;
    // coarse ground draws only where it isn't marked, and marks too; far ground draws only where neither did.
    gl.enable(gl.STENCIL_TEST);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    const drawn = status.drawn;
    drawn.ground = drawn.buildings = drawn.massing = 0;
    for (const g of visible) if (!g.coarse) drawn.ground += g.ground.draw(f, g.model, SUN);
    const coarser = (g: CellGpu) => {
      const n = runsWithout(g.groundRanges!, (child) => !!streamer.get(g.children![child]!), g.runs!);
      return g.ground.draw(f, g.model, SUN, g.runs, n);
    };
    gl.stencilFunc(gl.NOTEQUAL, 1, 0xff);
    for (const g of visible) if (g.coarse && !g.far) drawn.ground += coarser(g);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    for (const g of visible) if (g.far) drawn.ground += coarser(g);
    gl.disable(gl.STENCIL_TEST);
    for (const g of visible) drawn.buildings += g.buildings?.draw(f, g.model, SUN) ?? 0;
    // Coarse tiles' massing, less the shapes in fine cells that have their own buildings.
    for (const g of visible) {
      const { massing, children, massingRanges, runs } = g;
      if (!massing || !children || !massingRanges || !runs) continue;
      // The tile's nearest point: its frame's origin, in the view frame, less its bounding sphere.
      const m = g.model;
      if (Math.hypot(m[12]! + m[8]! * g.centerZ, m[13]! + m[9]! * g.centerZ, m[14]! + m[10]! * g.centerZ) - g.radius > MASSING_DISTANCE) continue;
      // The fine cells without their own buildings loaded.
      const n = runsWithout(massingRanges, (child) => {
        const fine = streamer.get(children[child]!);
        return !!fine && !fine.missing;
      }, runs);
      drawn.massing += massing.draw(f, g.model, SUN, runs, n);
    }
    for (const g of visible) g.signs?.draw(f, g.model, SUN);
    let carTriangles = 0;
    if (carRenderer && (showCars || drive || foot)) {
      if (showCars) {
        // Horizontal distance to the cell's anchor (which sits at the ellipsoid, not at the ground or the camera).
        const near = (tc: TrafficCell) => Math.hypot(tc.model[12]!, tc.model[13]!);
        // The traffic notices the player, in their car or on foot: slows behind them, and is solid to them.
        const n = traffic.yieldTo((drive ?? foot)?.pose(vf).pos, nearCars);
        (drive ?? foot)?.setObstacles(nearCars, n, vf, CAR_HALF);
        traffic.update(dt, near, CAR_DISTANCE, 1.3 * CAR_DISTANCE, moving);
        traffic.instances(carInstances);
      } else {
        carInstances.count.fill(0);
      }
      if (drive) addCar(carInstances, PLAYER_MODEL, drive.pose(vf));
      const parked = foot?.carPose(vf);
      if (parked) addCar(carInstances, PLAYER_MODEL, parked);
      carTriangles = carRenderer.draw(f, SUN, ROAD_BIAS, carInstances);
    }
    if (foot) {
      foot.instance(vf, playerInstances);
      playerRenderer.draw(f, SUN, ROAD_BIAS, playerInstances);
      if (foot.holding === "pistol") pistolRenderer.draw(f, SUN, ROAD_BIAS, playerInstances);
      if (foot.holding === "rifle") {
        // Slung; shouldered aiming, patrol ready otherwise.
        slingRenderer.draw(f, SUN, ROAD_BIAS, playerInstances);
        (foot.aiming ? rifleRenderer : rifleCarryRenderer).draw(f, SUN, ROAD_BIAS, playerInstances);
      }
    }
    let personTriangles = 0;
    if (showPeople) {
      // Horizontal distance to the cell's anchor, as for traffic.
      const near = (c: { model: Float32Array }) => Math.hypot(c.model[12]!, c.model[13]!);
      peopleView.update(dt, near, PEOPLE_DISTANCE, 1.3 * PEOPLE_DISTANCE, walking);
      peopleView.instances(personInstances, womanInstances);
      personTriangles = personRenderer.draw(f, SUN, ROAD_BIAS, personInstances);
      personTriangles += womanRenderer.draw(f, SUN, ROAD_BIAS, womanInstances);
      vagrantView.update(dt, near, PEOPLE_DISTANCE, 1.3 * PEOPLE_DISTANCE, walking);
      vagrantView.instances(vagrantInstances);
      personTriangles += vagrantRenderer.draw(f, SUN, ROAD_BIAS, vagrantInstances);
    }
    if (planeRenderer) {
      const now = performance.now() / 1000;
      air.refresh(camera.lat, camera.lon, now);
      air.instances(vf, now, planeInstances);
      planeRenderer.draw(f, SUN, ROAD_BIAS, planeInstances);
    }
    const cars = traffic.cars.count;
    drawn.cars = carTriangles;
    const people = peopleView.people.count;
    Object.assign(status, { cars, carTriangles, simTime: traffic.simTime, aircraft: air.count, people });
    if (contrailLayer) {
      // Last: blended over everything, without writing depth.
      air.contrails(vf, performance.now() / 1000, contrails);
      contrailLayer.draw(f, contrails, h);
    }
    effectsLayer.draw(f, vf, effects, performance.now() / 1000, h);
    if (status.graphOverlay) {
      for (const g of visible) {
        if (g.lines && !g.graph) g.graph = createFlatLayer(gl, g.lines, { mode: gl.LINES, colors: CLASS_COLORS_RGB, bias: 1 });
        g.graph?.draw(f, g.model);
      }
    }
    status.frames++;
    cpuMs = performance.now() - t0;
    const c = status.cells;
    // Before the fine cell under the camera loads (or from high up, where none do), its coarse tile's height.
    const below = roughGroundAt(camera.lat, camera.lon);
    const agl = camera.h - below;
    // Speed over the ground and climb, from how far the camera moved this frame, smoothed over ~0.2 s.
    const ecef = geodeticToEcef(camera);
    if (lastEcef && dt > 0) {
      const k = Math.min(1, dt * 5), [dx, dy, dz] = [ecef[0] - lastEcef[0], ecef[1] - lastEcef[1], ecef[2] - lastEcef[2]];
      const vz = (camera.h - lastH) / dt;
      groundSpeed += (Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - (camera.h - lastH) ** 2)) / dt - groundSpeed) * k;
      climb += (vz - climb) * k;
    }
    [lastEcef, lastH] = [ecef, camera.h];
    const [yaw, pitch] = yawPitch(camera.rot);
    instruments.draw(
      foot ? undefined
        : { bearing: (-yaw * 180) / Math.PI, pitch, speed: groundSpeed, climb, altitude: camera.h, agl, ground: below, lat: camera.lat, lon: camera.lon },
      drive && { kmh: drive.kmh, bearing: 90 - (drive.car.heading * 180) / Math.PI, wheel, pedal },
      foot && (foot.nearCar ? "F: get in" : foot.car ? undefined : "V: fly"),
      foot && handData(foot),
    );
    const m = (t: number) => (t / 1e6).toFixed(2);
    hud.textContent = `cells ${c.drawn} drawn / ${c.ready - c.missing - c.coarse} + ${c.coarse} coarse` +
      `${c.loading + c.queued ? ` +${c.loading + c.queued} loading` : ""}${c.failed ? `, ${c.failed} failed` : ""} ` +
      `within ${(status.radius / 1000).toFixed(1)} km · ${cars} cars · ${people} people + ${vagrantView.vagrants.count} vagrants (${m(personTriangles)} M tris) · ${air.count} aircraft · ${fps > 0 ? fps.toFixed(0) : "–"} fps, ${cpuMs.toFixed(1)} ms CPU · ` +
      `M tris: ground ${m(status.drawn.ground)}, buildings ${m(status.drawn.buildings)}, massing ${m(status.drawn.massing)}, cars ${m(status.drawn.cars)}`;
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
    if (drive) {
      // Driving: the mouse (captured) is an analog wheel (left–right; it stays where it's left) and pedal (forward:
      // throttle, back: brake, then reverse); W/S and A/D add to them; Space is the handbrake. The camera chases.
      const clamp = (v: number) => Math.max(-1, Math.min(1, v));
      wheel = clamp(wheel + input.look[0] * MOUSE_WHEEL);
      pedal = clamp(pedal - input.look[1] * MOUSE_PEDAL);
      drive.step({ throttle: clamp(pedal + input.move[1]), steer: clamp(wheel + input.move[0]), handbrake: input.move[2] > 0 }, dt);
      camera = drive.camera();
      render(dt);
      requestAnimationFrame(frame);
      return;
    }
    if (foot) {
      // On foot: WASD relative to the camera, Shift to run, Space to jump; the mouse turns the camera behind them.
      foot.step(input, dt);
      camera = foot.camera();
      render(dt);
      requestAnimationFrame(frame);
      return;
    }
    if (isIdle(input)) {
      // Input just stopped: the pose goes to the URL.
      if (steering) history.replaceState(null, "", formatGlobeHash(camera));
      steering = false;
      if (!(moving && carRenderer) && air.count === 0 && !(walking && peopleView.people.count + vagrantView.vagrants.count > 0)) {
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

  // V: drive a car from the ground under the camera, facing its way; V again (driving or on foot): fly on from the
  // camera. F: out of the car, on foot beside it; back in, near it; flying, on foot on the ground under the camera.
  let drive: Drive | undefined;
  let foot: OnFoot | undefined;
  let wheel = 0, pedal = 0;  // the mouse's steering wheel and pedal, −1..1
  const loaded: LoadedWorld = { groundAt, walls: (cell) => streamer.get(cell)?.walls };
  addEventListener("keydown", (e) => {
    if (e.code !== "KeyV" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    wheel = pedal = 0;
    if (drive || foot) {
      drive = foot = undefined;
      history.replaceState(null, "", formatGlobeHash(camera));
    } else {
      drive = new Drive(camera.lat, camera.lon, yawPitch(camera.rot)[0] + Math.PI / 2, loaded);
      wake();
    }
  });
  addEventListener("keydown", (e) => {
    if (e.code !== "KeyF" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    wheel = pedal = 0;
    if (drive) {
      const car = drive.parked();
      foot = onFoot(new OnFoot(car.lat, car.lon, car.heading, loaded, car, CAR_HALF));
      drive = undefined;
    } else if (foot?.car && foot.nearCar) {
      drive = Drive.from(foot.car, loaded);
      foot = undefined;
    } else if (!foot) {
      foot = onFoot(new OnFoot(camera.lat, camera.lon, yawPitch(camera.rot)[0] + Math.PI / 2, loaded));
    }
    wake();
  });
  /** On foot: their shots flash, trace and go bang. */
  const onFoot = (o: OnFoot): OnFoot => {
    o.onShot = (muzzle, end, hit, gun) => {
      effects.shot(muzzle, end, hit, performance.now() / 1000);
      gunshot(gun === "rifle" ? "rifle" : "pistol");
    };
    return o;
  };
  // On foot: 1–9 take an inventory slot in hand; R reloads.
  addEventListener("keydown", (e) => {
    if (!foot || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^Digit[1-9]$/.test(e.code)) foot.select(Number(e.code.slice(5)) - 1);
    if (e.code === "KeyR") foot.reload();
  });

  addEventListener("keydown", (e) => {
    if (e.code !== "KeyG"|| e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
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

/** What the instruments show of what's in hand, on foot. */
function handData(foot: OnFoot): HandData {
  const inv = foot.inventory, gun = heldGun(inv);
  const rounds = gun && (inv.reloading > 0 ? "reloading" : `${inv.rounds[inv.selected]}/${gun.magazine}`);
  return { slots: inv.items.map((k) => ITEMS[k].name), selected: inv.selected, rounds, crosshair: !!gun, aiming: foot.aiming, sway: foot.sway };
}

/** Adds one car (position and forward direction, in the view frame) to a model's instances. */
function addCar(out: CarInstances, model: number, { pos, fwd }: { pos: Vec3; fwd: Vec3 }): void {
  let data = out.data[model]!;
  const o = 6 * out.count[model]!++;
  if (o + 6 > data.length) {
    const grown = new Float32Array(data.length * 2);
    grown.set(data);
    out.data[model] = data = grown;
  }
  data.set([pos[0], pos[1], pos[2], fwd[0], fwd[1], fwd[2]], o);
}
