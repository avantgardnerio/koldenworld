// Viewer entry: load an area's Arrow files, build the line mesh, draw on demand.
//
// URL: /?area=80205#x,y,mpp   (the hash is the camera; without it the view fits the area)
//
// window.viewer exposes status and a pixel probe so headless tests can check
// what was drawn without decoding screenshots.

import { roadGraphFromArrow, roadLineMesh } from "@game/world";
import { fitBounds, formatHash, pan, parseHash, viewMatrix, zoomAt, type Camera } from "./camera.ts";
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

async function start(): Promise<void> {
  const canvas = document.querySelector("canvas")!;
  const gl = canvas.getContext("webgl2", { antialias: false });
  if (!gl) throw new Error("WebGL2 is not available");

  const [nodes, edges] = await Promise.all([getBlob(`/${area}/nodes.arrow`), getBlob(`/${area}/edges.arrow`)]);
  const { graph } = roadGraphFromArrow({ nodes, edges });
  const mesh = roadLineMesh(graph);
  const roads = createRoadLayer(gl, mesh, classColors());

  const size = () => ({ w: canvas.clientWidth, h: canvas.clientHeight });
  let camera: Camera = parseHash(location.hash) ?? fitBounds(mesh.bounds, size().w, size().h);
  history.replaceState(null, "", formatHash(camera));

  const render = () => {
    const { w, h } = size();
    const dpr = devicePixelRatio;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    roads.draw(viewMatrix(camera, w, h));
    status.frames++;
  };

  let queued = false;
  const invalidate = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(); });
  };
  const setCamera = (c: Camera) => {
    camera = c;
    history.replaceState(null, "", formatHash(c));
    invalidate();
  };

  // --- input: drag to pan, wheel to zoom about the cursor ---
  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointerup", () => { drag = null; });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    setCamera(pan(camera, e.clientX - drag.x, e.clientY - drag.y));
    drag = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const { w, h } = size();
    setCamera(zoomAt(camera, w, h, e.offsetX, e.offsetY, Math.exp(e.deltaY * 0.002)));
  }, { passive: false });
  addEventListener("hashchange", () => {
    const c = parseHash(location.hash);
    if (c) { camera = c; invalidate(); }
  });
  new ResizeObserver(invalidate).observe(canvas);

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
