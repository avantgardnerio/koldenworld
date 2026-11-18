// Viewer entry: load an area's Arrow files, build the line mesh, fly around it.
//
// URL: /?area=80205#x,y,z,yaw,pitch   (the hash is the camera pose; without it, an overview)
//
// Frames are rendered only while something changes: a held key or mouse
// movement starts the loop, and it stops (and writes the pose to the URL) once
// input goes idle.
//
// window.viewer exposes status and a pixel probe so headless tests can check
// what was drawn without decoding screenshots.

import { roadGraphFromArrow, roadLineMesh } from "@game/world";
import { formatHash, overview, parseHash, speed, stepCamera, viewProjection, type Camera } from "./camera.ts";
import { attachInput, isIdle } from "./input.ts";
import { createRoadLayer } from "./road-layer.ts";
import { BACKGROUND, classColors } from "./style.ts";

export interface ViewerStatus {
  state: "loading" | "ready" | "error";
  error?: string;
  area: string;
  nodes?: number;
  edges?: number;
  segments?: number;
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

const area = new URLSearchParams(location.search).get("area") ?? "80205";
const status: ViewerStatus = (window.viewer = { state: "loading", area, frames: 0 });
const MAX_DT = 0.1;  // s; a stalled tab must not teleport the camera

async function start(): Promise<void> {
  const canvas = document.querySelector("canvas")!;
  const hud = document.querySelector<HTMLElement>("#hud")!;
  const gl = canvas.getContext("webgl2", { antialias: false });
  if (!gl) throw new Error("WebGL2 is not available");

  const [nodes, edges] = await Promise.all([getBlob(`/${area}/nodes.arrow`), getBlob(`/${area}/edges.arrow`)]);
  const { graph } = roadGraphFromArrow({ nodes, edges });
  const mesh = roadLineMesh(graph);
  const roads = createRoadLayer(gl, mesh, classColors());

  const aspect = () => canvas.clientWidth / Math.max(1, canvas.clientHeight);
  let camera: Camera = parseHash(location.hash) ?? overview(mesh.bounds, aspect());
  history.replaceState(null, "", formatHash(camera));

  const render = () => {
    const dpr = devicePixelRatio;
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    roads.draw(viewProjection(camera, aspect()));
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
    segments: mesh.indices.length / 2,
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
