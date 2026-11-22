// A street graph, as columns: nodes where streets meet or end, streets between
// them as polylines in meters (CSR into point columns), each with its half
// width and layer. Built from OSM ways (the one place objects come in: the
// ways' JSON) or straight from a road graph's typed arrays.

import { F64, I32 } from "./arrays.ts";

/** An OSM way as the database has it: node ids and their [lon, lat], class, total lanes. */
export interface WayInput {
  id: string;
  nodes: string[];
  coords: [lon: number, lat: number][];
  cls: string;
  lanes: number;
  structure?: string;     // "bridge", "tunnel", or on the ground
  layer?: number | null;  // OSM's layer=*, when tagged
  name?: string | null;
}

export interface Graph {
  nodeCount: number;
  nx: Float64Array; ny: Float64Array; nz: Float64Array;   // per node
  streetCount: number;
  a: Int32Array; b: Int32Array;                           // per street: its end nodes
  hw: Float64Array;                                       // per street: half width, m
  layer: Int8Array;                                       // per street: 0 on the ground, above for bridges, below for tunnels
  pointStart: Int32Array;                                 // streetCount + 1: its points, a to b, both ends included
  px: Float64Array; py: Float64Array; pz: Float64Array;
}

/** [lane width, shoulder] by OSM class, m (as the game's road profiles). */
const PROFILE: Record<string, [number, number]> = {
  motorway: [3.7, 2.5], motorway_link: [3.7, 1.5], trunk: [3.6, 1.5], trunk_link: [3.6, 1.0],
  primary: [3.4, 1.0], primary_link: [3.4, 0.5], secondary: [3.4, 1.0], secondary_link: [3.4, 0.5],
  tertiary: [3.3, 1.0], tertiary_link: [3.3, 0.5], unclassified: [3.0, 1.0], residential: [3.0, 1.0],
  living_street: [3.0, 0.5], service: [2.8, 0.2], road: [3.0, 0.5],
};

export function halfWidth(cls: string, lanes: number): number {
  const [lane, shoulder] = PROFILE[cls] ?? [3.0, 0.5];
  return (lanes * lane) / 2 + shoulder;
}

/** A way's level: OSM's layer when tagged on a bridge or tunnel, else 1 for a bridge, −1 for a tunnel, 0 on the ground. */
export function layerOf(w: WayInput): number {
  if (w.structure === "bridge") return w.layer && w.layer > 0 ? w.layer : 1;
  if (w.structure === "tunnel") return w.layer && w.layer < 0 ? w.layer : -1;
  return 0;
}

/** Ways cut at every node another way shares, in meters around (lat0, lon0), y north; heights 0. */
export function buildGraph(ways: WayInput[], lat0: number, lon0: number): Graph {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  const uses = new Map<string, number>();
  for (const w of ways) for (const id of w.nodes) uses.set(id, (uses.get(id) ?? 0) + 1);
  const index = new Map<string, number>(), NX = new F64(), NY = new F64();
  const node = (id: string, lon: number, lat: number) => {
    let n = index.get(id);
    if (n === undefined) {
      n = NX.length;
      index.set(id, n);
      NX.push((lon - lon0) * kx);
      NY.push((lat - lat0) * ky);
    }
    return n;
  };
  const A = new I32(), B = new I32(), HW = new F64(), LAYER = new I32(), start = new I32(), PX = new F64(), PY = new F64();
  start.push(0);
  for (const w of ways) {
    let first = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      if (i < w.nodes.length - 1 && uses.get(w.nodes[i]!)! < 2) continue;
      const before = PX.length;
      for (let k = first; k <= i; k++) {
        const x = (w.coords[k]![0] - lon0) * kx, y = (w.coords[k]![1] - lat0) * ky;
        if (PX.length > before && x === PX.data[PX.length - 1] && y === PY.data[PY.length - 1]) continue;
        PX.push(x);
        PY.push(y);
      }
      if (PX.length - before >= 2) {
        A.push(node(w.nodes[first]!, ...w.coords[first]!));
        B.push(node(w.nodes[i]!, ...w.coords[i]!));
        HW.push(halfWidth(w.cls, w.lanes));
        LAYER.push(layerOf(w));
        start.push(PX.length);
      } else {
        PX.length = before;
        PY.length = before;
      }
      first = i;
    }
  }
  return {
    nodeCount: NX.length, nx: NX.view().slice(), ny: NY.view().slice(), nz: new Float64Array(NX.length),
    streetCount: A.length, a: A.view().slice(), b: B.view().slice(), hw: HW.view().slice(), layer: Int8Array.from(LAYER.view()),
    pointStart: start.view().slice(), px: PX.view().slice(), py: PY.view().slice(), pz: new Float64Array(PX.length),
  };
}
