// Viewer entry: load an area's Arrow files, build meshes, fly around them.
//
// URL: /?area=80205[&graph=1]#x,y,z,yaw,pitch
//   hash: the camera pose (without it, an overview); graph=1: the road graph
//   overlay (toggle with G). The URL describes the whole view.
//
// Frames are rendered only while something changes: a held key or mouse
// movement starts the loop, and it stops (and writes the pose to the URL) once
// input goes idle.
//
// window.viewer exposes status and a pixel probe so headless tests can check
// what was drawn without decoding screenshots.

import { buildingMesh, buildingsFromArrow, roadGraphFromArrow, roadLineMesh, roadSurfaceMesh } from "@game/world";
import { FAR, formatHash, overview, parseHash, speed, stepCamera, viewProjection, type Camera } from "./camera.ts";
import { createFlatLayer, groundMesh } from "./flat-layer.ts";
import { attachInput, isIdle } from "./input.ts";
import { createSolidLayer } from "./solid-layer.ts";
import {
  BUILDING_COLORS_RGB, CLASS_COLORS_RGB, fogRange, GROUND, MARKING_FADE, SKY, SUN, SURFACE_COLORS,
} from "./style.ts";

export interface ViewerStatus {
  state: "loading" | "ready" | "error";
  error?: string;
  area: string;
  nodes?: number;
  edges?: number;
  surfaceTriangles?: number;
  buildings?: number;
  buildingTriangles?: number;
  graphOverlay: boolean;
  frames: number;
  /** Render now and read the RGB at a CSS pixel (origin top left). */
  pixel?: (x: number, y: number) => [number, number, number];
}

declare global {
  interface Window { viewer: ViewerStatus }
}

/** Platform adapter (architecture.md): in the browser, blobs come over HTTP and the HTTP cache. */
async function getBlob(path: string): Promise<Uint8Array> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

const params = new URLSearchParams(location.search);
const area = params.get("area") ?? "80205";
const status: ViewerStatus = (window.viewer = { state: "loading", area, graphOverlay: params.get("graph") === "1", frames: 0 });
const MAX_DT = 0.1;  // s; a stalled tab must not teleport the camera

async function start(): Promise<void> {
  const canvas = document.querySelector("canvas")!;
  const hud = document.querySelector<HTMLElement>("#hud")!;
  const gl = canvas.getContext("webgl2", { antialias: true });
  if (!gl) throw new Error("WebGL2 is not available");

  const [nodes, edges, buildingFile] = await Promise.all([
    getBlob(`/${area}/nodes.arrow`), getBlob(`/${area}/edges.arrow`), getBlob(`/${area}/buildings.arrow`),
  ]);
  const { graph } = roadGraphFromArrow({ nodes, edges });
  const { buildings } = buildingsFromArrow(buildingFile);
  const buildingTris = buildingMesh(buildings);
  const lines = roadLineMesh(graph);
  const surface = roadSurfaceMesh(graph);
  const b = lines.bounds;
  const layers = {
    ground: createFlatLayer(gl, groundMesh((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, FAR),
      { mode: gl.TRIANGLES, colors: GROUND, fadeToBase: false }),
    roads: createFlatLayer(gl, surface, { mode: gl.TRIANGLES, colors: SURFACE_COLORS, fadeToBase: true }),
    buildings: createSolidLayer(gl, buildingTris, BUILDING_COLORS_RGB),
    graph: createFlatLayer(gl, { positions: lines.positions, material: lines.pointClass, indices: lines.indices },
      { mode: gl.LINES, colors: CLASS_COLORS_RGB, fadeToBase: false }),
  };

  const aspect = () => canvas.clientWidth / Math.max(1, canvas.clientHeight);
  let camera: Camera = parseHash(location.hash) ?? overview(lines.bounds, aspect());
  history.replaceState(null, "", formatHash(camera));

  const render = () => {
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
    const f = {
      view: viewProjection(camera, aspect()),
      eye: camera.pos,
      sky: SKY,
      fog: fogRange(camera.pos[2]),
      fade: MARKING_FADE,
    };
    // Ground layers in painter's order (writing depth), then depth-tested buildings.
    layers.ground.draw(f);
    layers.roads.draw(f);
    layers.buildings.draw(f, SUN);
    if (status.graphOverlay) layers.graph.draw(f);
    status.frames++;
    hud.textContent = `alt ${camera.pos[2].toFixed(0)} m · ${speed(camera, false).toFixed(0)} m/s (Shift ×4)`;
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
      history.replaceState(null, "", formatHash(camera));
      return;
    }
    camera = stepCamera(camera, input, dt);
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
    const c = parseHash(location.hash);
    if (c) { camera = c; render(); }
  });
  new ResizeObserver(() => render()).observe(canvas);

  render();
  if (gl.getError() !== gl.NO_ERROR) throw new Error("WebGL error during the first frame");

  Object.assign(status, {
    state: "ready",
    nodes: graph.nodes.count,
    edges: graph.edges.count,
    surfaceTriangles: surface.indices.length / 3,
    buildings: buildings.count,
    buildingTriangles: buildingTris.indices.length / 3,
    pixel(x: number, y: number) {
      render();  // read before the browser clears the drawing buffer
      const dpr = devicePixelRatio;
      const out = new Uint8Array(4);
      gl.readPixels(Math.floor(x * dpr), canvas.height - 1 - Math.floor(y * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
      return [out[0]!, out[1]!, out[2]!];
    },
  } satisfies Partial<ViewerStatus>);
}

start().catch((err: unknown) => {
  status.state = "error";
  status.error = err instanceof Error ? err.message : String(err);
  console.error(err);
});
