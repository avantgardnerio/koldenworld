// Screenshot an exported area headlessly:
//   npm run shot -- --area 80205 [--view=x,y,z,yaw,pitch] [--graph] [--size 1600x1200] [--out data/shots/80205.png]
// (Use --view=..., with "=": a value starting with "-" would otherwise parse as a flag.)

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { openViewer } from "../harness/browser.ts";

const { values: a } = parseArgs({
  options: {
    area: { type: "string", default: "80205" },
    view: { type: "string" },
    graph: { type: "boolean", default: false },
    size: { type: "string", default: "1600x1200" },
    out: { type: "string" },
  },
});
const [width, height] = a.size.split("x").map(Number) as [number, number];
const out = path.resolve(a.out ?? `data/shots/${a.area}${a.view ? `@${a.view}` : ""}${a.graph ? "+graph" : ""}.png`);

const viewer = await openViewer({ area: a.area, graph: a.graph, hash: a.view ? `#${a.view}` : undefined, width, height });
try {
  await mkdir(path.dirname(out), { recursive: true });
  await viewer.page.screenshot({ path: out });
  const { state, nodes, edges, surfaceTriangles, frames } = await viewer.status();
  const camera = await viewer.page.evaluate(() => location.hash);
  console.log(JSON.stringify({ state, nodes, edges, surfaceTriangles, frames, camera, out }));
} finally {
  await viewer.close();
}
