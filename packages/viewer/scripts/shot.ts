// Screenshot the world headlessly, with cells from the cell server (run `npm run server`):
//   npm run shot -- [--view=lat,lon,alt,yaw,pitch] [--graph] [--radius <m>] [--size 1600x1200] [--out data/shots/x.png]
// (Use --view=..., with "=": a value starting with "-" would otherwise parse as a flag.)
// Waits until every cell in range has loaded, which may mean downloading OSM first.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { openViewer } from "../harness/browser.ts";

const { values: a } = parseArgs({
  options: {
    view: { type: "string" },
    radius: { type: "string" },
    graph: { type: "boolean", default: false },
    size: { type: "string", default: "1600x1200" },
    out: { type: "string" },
  },
});
const [width, height] = a.size.split("x").map(Number) as [number, number];
const out = path.resolve(a.out ?? `data/shots/${a.view ? `@${a.view}` : "default"}${a.graph ? "+graph" : ""}.png`);
const query = [a.graph ? "graph=1" : "", a.radius ? `radius=${a.radius}` : ""].filter(Boolean).join("&");

const viewer = await openViewer({ query, hash: a.view ? `#${a.view}` : undefined, width, height, timeoutMs: 30 * 60_000 });
try {
  await mkdir(path.dirname(out), { recursive: true });
  await viewer.page.screenshot({ path: out });
  const { state, cells, radius, nodes, edges, surfaceTriangles, buildings, buildingTriangles, frames } = await viewer.status();
  const camera = await viewer.page.evaluate(() => location.hash);
  console.log(JSON.stringify({ state, cells, radius, nodes, edges, surfaceTriangles, buildings, buildingTriangles, frames, camera, out }));
} finally {
  await viewer.close();
}
