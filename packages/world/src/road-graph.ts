// The road graph: nodes at way endpoints and intersections, edges between them.
//
// An OSM way often runs through several intersections. Two ways meet where they
// share a node id (not where their lines cross: a bridge crosses a street
// without sharing a node). Each way is cut at every node it shares with another
// way, and each piece becomes an edge.
//
// Edges run from `from` to `to` along their points. One-way edges are always
// stored in the direction of travel (lanesBack = 0).

import type { Projection } from "./projection.ts";

/** Bump when buildRoadGraph's output changes for the same input. */
export const ROAD_GRAPH_VERSION = 4;

export const ROAD_CLASSES = [
  "motorway", "motorway_link",
  "trunk", "trunk_link",
  "primary", "primary_link",
  "secondary", "secondary_link",
  "tertiary", "tertiary_link",
  "unclassified", "residential", "living_street", "service", "road",
] as const;

export type RoadClass = (typeof ROAD_CLASSES)[number];

/** Edge structure: index 0 follows the ground; bridges and tunnels run straight between their ends. */
export const ROAD_STRUCTURES = ["ground", "bridge", "tunnel"] as const;

/** What the graph needs from a stored road way (a Postgres row). */
export interface RoadWayInput {
  osmWayId: number;
  nodeIds: number[];                     // direction of travel for one-way roads
  points: [lon: number, lat: number][];  // one per node id
  class: RoadClass;
  name: string | null;
  lanesFwd: number;
  lanesBack: number;
  speedLimitMps: number;
  structure?: "bridge" | "tunnel" | null;  // default: on the ground
  sidewalks?: number;                      // bits: 1 left, 2 right of nodeIds' direction (decision 33); default none
}

export interface RoadNodes {
  count: number;
  x: Float32Array;           // m east, in the projection's frame
  y: Float32Array;           // m north
  z: Float32Array;           // m up: the road's height in the frame (0 until draped on terrain)
  drop: Float32Array;        // m from the node's disc down to the lowest ground at its rim (fill skirt), 0 until draped
  osmId: Float64Array;
  edgeStart: Int32Array;     // count + 1 offsets into edgeList (CSR; Int32 like Arrow list offsets)
  edgeList: Uint32Array;     // incident edge ids; a self-loop is listed twice
}

export interface RoadEdges {
  count: number;
  from: Uint32Array;         // node id
  to: Uint32Array;           // node id
  class: Uint8Array;         // index into ROAD_CLASSES
  lanesFwd: Uint8Array;      // lanes from → to
  lanesBack: Uint8Array;     // lanes to → from; 0 = one-way
  speedLimit: Float32Array;  // m/s
  length: Float32Array;      // m, along the points
  name: Uint32Array;         // index into names; 0 = unnamed
  structure: Uint8Array;     // index into ROAD_STRUCTURES
  sidewalks: Uint8Array;     // bits: 1 left, 2 right, looking from → to
  osmWayId: Float64Array;
  pointStart: Int32Array;    // count + 1 offsets, in points, into RoadGraph.points (CSR)
}

export interface RoadGraph {
  nodes: RoadNodes;
  edges: RoadEdges;
  points: Float32Array;      // x, y interleaved; each edge's points include both end nodes
  pointZ: Float32Array;      // z per point (0 until draped on terrain)
  pointDrop: Float32Array;   // m from the road's edge down to the ground below its lower side (fill skirt) per point
  names: string[];           // names[0] = ""
}

/**
 * Builds the graph from ways. Node and edge ids follow input order, so sort
 * the input (e.g. by osm_way_id) for reproducible output.
 *
 * `keep` selects edges by their midpoint (lon, lat), for partitions that own
 * part of the input: ways are still cut wherever any input way shares a node,
 * so every partition cuts a way the same way. Nodes exist only for kept edges.
 */
export function buildRoadGraph(
  ways: RoadWayInput[], project: Projection, keep: (lon: number, lat: number) => boolean = () => true,
): RoadGraph {
  const uses = new Map<number, number>();
  for (const w of ways) {
    for (const id of w.nodeIds) uses.set(id, (uses.get(id) ?? 0) + 1);
  }

  const nodeIndex = new Map<number, number>();
  const nodeX: number[] = [];
  const nodeY: number[] = [];
  const nodeOsm: number[] = [];
  const graphNode = (osmId: number, [lon, lat]: [number, number]): number => {
    let i = nodeIndex.get(osmId);
    if (i === undefined) {
      i = nodeOsm.length;
      nodeIndex.set(osmId, i);
      const [x, y] = project(lon, lat);
      nodeX.push(x);
      nodeY.push(y);
      nodeOsm.push(osmId);
    }
    return i;
  };

  const names = [""];
  const nameIndex = new Map([["", 0]]);
  const nameId = (name: string | null): number => {
    if (!name) return 0;
    let i = nameIndex.get(name);
    if (i === undefined) {
      i = names.length;
      names.push(name);
      nameIndex.set(name, i);
    }
    return i;
  };

  const e = {
    from: [] as number[], to: [] as number[], class: [] as number[],
    lanesFwd: [] as number[], lanesBack: [] as number[], speedLimit: [] as number[],
    length: [] as number[], name: [] as number[], structure: [] as number[], sidewalks: [] as number[], osmWayId: [] as number[],
    pointStart: [0],
  };
  const points: number[] = [];

  for (const w of ways) {
    const cls = ROAD_CLASSES.indexOf(w.class);
    if (cls < 0) throw new Error(`way ${w.osmWayId}: unknown road class ${w.class}`);
    const name = nameId(w.name);
    let start = 0;
    for (let i = 1; i < w.nodeIds.length; i++) {
      if (i < w.nodeIds.length - 1 && (uses.get(w.nodeIds[i]!) ?? 0) < 2) continue;
      const [mLon, mLat] = midpoint(w.points, start, i);
      if (!keep(mLon, mLat)) {
        start = i;
        continue;
      }

      e.from.push(graphNode(w.nodeIds[start]!, w.points[start]!));
      e.to.push(graphNode(w.nodeIds[i]!, w.points[i]!));
      let length = 0;
      let px = 0, py = 0;
      for (let k = start; k <= i; k++) {
        const [x, y] = project(...w.points[k]!);
        if (k > start) length += Math.hypot(x - px, y - py);
        points.push(x, y);
        px = x;
        py = y;
      }
      e.class.push(cls);
      e.lanesFwd.push(w.lanesFwd);
      e.lanesBack.push(w.lanesBack);
      e.speedLimit.push(w.speedLimitMps);
      e.length.push(length);
      e.name.push(name);
      e.structure.push(ROAD_STRUCTURES.indexOf(w.structure ?? "ground"));
      e.sidewalks.push(w.sidewalks ?? 0);
      e.osmWayId.push(w.osmWayId);
      e.pointStart.push(points.length / 2);
      start = i;
    }
  }

  // Incidence lists, CSR: count per node, prefix sum, fill.
  const nodeCount = nodeOsm.length;
  const edgeCount = e.from.length;
  const edgeStart = new Int32Array(nodeCount + 1);
  for (let i = 0; i < edgeCount; i++) {
    edgeStart[e.from[i]! + 1]!++;
    edgeStart[e.to[i]! + 1]!++;
  }
  for (let n = 0; n < nodeCount; n++) edgeStart[n + 1]! += edgeStart[n]!;
  const edgeList = new Uint32Array(edgeStart[nodeCount]!);
  const fill = edgeStart.slice(0, nodeCount);
  for (let i = 0; i < edgeCount; i++) {
    edgeList[fill[e.from[i]!]!++] = i;
    edgeList[fill[e.to[i]!]!++] = i;
  }

  return {
    nodes: {
      count: nodeCount,
      x: Float32Array.from(nodeX),
      y: Float32Array.from(nodeY),
      z: new Float32Array(nodeCount),
      drop: new Float32Array(nodeCount),
      osmId: Float64Array.from(nodeOsm),
      edgeStart,
      edgeList,
    },
    edges: {
      count: edgeCount,
      from: Uint32Array.from(e.from),
      to: Uint32Array.from(e.to),
      class: Uint8Array.from(e.class),
      lanesFwd: Uint8Array.from(e.lanesFwd),
      lanesBack: Uint8Array.from(e.lanesBack),
      speedLimit: Float32Array.from(e.speedLimit),
      length: Float32Array.from(e.length),
      name: Uint32Array.from(e.name),
      structure: Uint8Array.from(e.structure),
      sidewalks: Uint8Array.from(e.sidewalks),
      osmWayId: Float64Array.from(e.osmWayId),
      pointStart: Int32Array.from(e.pointStart),
    },
    points: Float32Array.from(points),
    pointZ: new Float32Array(points.length / 2),
    pointDrop: new Float32Array(points.length / 2),
    names,
  };
}

/** The point halfway along points[start..end] by vertex count: a middle vertex, or the middle segment's midpoint. */
function midpoint(points: [number, number][], start: number, end: number): [number, number] {
  const a = points[Math.floor((start + end) / 2)]!, b = points[Math.ceil((start + end) / 2)]!;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

// --- analysis -------------------------------------------------------------

/** Sizes of connected components (ignoring direction), largest first. */
export function componentSizes(g: RoadGraph): number[] {
  const parent = Uint32Array.from({ length: g.nodes.count }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let i = 0; i < g.edges.count; i++) {
    const a = find(g.edges.from[i]!);
    const b = find(g.edges.to[i]!);
    if (a !== b) parent[a] = b;
  }
  const sizes = new Map<number, number>();
  for (let i = 0; i < g.nodes.count; i++) {
    const r = find(i);
    sizes.set(r, (sizes.get(r) ?? 0) + 1);
  }
  return [...sizes.values()].sort((a, b) => b - a);
}
