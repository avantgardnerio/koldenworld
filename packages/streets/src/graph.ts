// A street graph from OSM ways: nodes where ways meet or end, streets
// (edges) between them as polylines in meters, each with its half width.

/** A point in meters; z (height) when the streets have heights, carried through everything made from them. */
export interface Point { x: number; y: number; z?: number }

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

export interface Street {
  a: number;     // node index at its start
  b: number;     // node index at its end
  pts: Point[];  // a to b, both ends included
  hw: number;    // half width, m
  way: string;
  layer: number; // 0 on the ground; above it for bridges, below for tunnels
}

export interface Graph {
  nodes: (Point & { id: string })[];
  streets: Street[];
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

/** Ways cut at every node another way shares, in meters around (lat0, lon0), y north. */
export function buildGraph(ways: WayInput[], lat0: number, lon0: number): Graph {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  const at = ([lon, lat]: [number, number]): Point => ({ x: (lon - lon0) * kx, y: (lat - lat0) * ky });
  const uses = new Map<string, number>();
  for (const w of ways) for (const id of w.nodes) uses.set(id, (uses.get(id) ?? 0) + 1);
  const nodes: Graph["nodes"] = [], index = new Map<string, number>(), streets: Street[] = [];
  const node = (id: string, c: [number, number]) => {
    if (!index.has(id)) index.set(id, nodes.push({ id, ...at(c) }) - 1);
    return index.get(id)!;
  };
  for (const w of ways) {
    let start = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      if (i < w.nodes.length - 1 && uses.get(w.nodes[i]!)! < 2) continue;
      const pts: Point[] = [];
      for (let k = start; k <= i; k++) {
        const p = at(w.coords[k]!), last = pts.at(-1);
        if (!last || p.x !== last.x || p.y !== last.y) pts.push(p);
      }
      if (pts.length >= 2) {
        streets.push({
          a: node(w.nodes[start]!, w.coords[start]!), b: node(w.nodes[i]!, w.coords[i]!), pts,
          hw: halfWidth(w.cls, w.lanes), way: w.id, layer: layerOf(w),
        });
      }
      start = i;
    }
  }
  return { nodes, streets };
}
