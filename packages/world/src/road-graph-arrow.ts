// RoadGraph ⇄ Apache Arrow IPC files: one file per table (nodes, edges), one
// record batch per file, so every column is a single contiguous buffer.
//
// Both directions are zero-copy for numeric data: writing wraps the graph's
// typed arrays, and reading returns typed-array views onto the file bytes.
// Inspect the files with any Arrow tool, e.g.
//   python3 -c "import pyarrow.ipc as i; print(i.open_file('data/export/80205/edges.arrow').read_all())"
// (DuckDB needs its community nanoarrow extension: LOAD nanoarrow; FROM read_arrow('...'))
//
//   nodes.arrow                          edges.arrow
//   x         float32                    from        uint32
//   y         float32                    to          uint32
//   osm_id    float64                    class       dictionary<uint8, utf8>
//   edges     list<uint32>               lanes_fwd   uint8
//                                        lanes_back  uint8
//                                        speed_limit float32   m/s
//                                        length      float32   m
//                                        name        dictionary<uint32, utf8>; "" = unnamed
//                                        osm_way_id  float64
//                                        points      list<fixed_size_list<float32, 2>>  x, y in m

import { Field, FixedSizeList, Float32, List, makeData, Uint32, Uint8 } from "apache-arrow";
import {
  column, dictionaryStrings, f32, f64, listParts, readTable, toIPC, u32, u8, utf8Dictionary, values,
  type FileMetadata,
} from "./arrow-util.ts";
import { ROAD_CLASSES, type RoadEdges, type RoadGraph, type RoadNodes } from "./road-graph.ts";

export interface RoadGraphFiles {
  nodes: Uint8Array;
  edges: Uint8Array;
}

/** Free-form provenance stored in each file's schema metadata (values are JSON-encoded). */
export type GraphMetadata = FileMetadata;

// --- write ----------------------------------------------------------------

export function roadGraphToArrow(g: RoadGraph, metadata: GraphMetadata): RoadGraphFiles {
  const { nodes, edges } = g;

  const incident = makeData({
    type: new List(new Field("edge", new Uint32(), false)),
    length: nodes.count,
    nullCount: 0,
    valueOffsets: nodes.edgeStart,
    child: u32(nodes.edgeList),
  });

  const pointType = new FixedSizeList(2, new Field("xy", new Float32(), false));
  const points = makeData({
    type: new List(new Field("point", pointType, false)),
    length: edges.count,
    nullCount: 0,
    valueOffsets: edges.pointStart,
    child: makeData({ type: pointType, length: g.points.length / 2, nullCount: 0, child: f32(g.points) }),
  });

  return {
    nodes: toIPC({
      x: f32(nodes.x),
      y: f32(nodes.y),
      osm_id: f64(nodes.osmId),
      edges: incident,
    }, nodes.count, metadata),
    edges: toIPC({
      from: u32(edges.from),
      to: u32(edges.to),
      class: utf8Dictionary(0, new Uint8(), edges.class, ROAD_CLASSES),
      lanes_fwd: u8(edges.lanesFwd),
      lanes_back: u8(edges.lanesBack),
      speed_limit: f32(edges.speedLimit),
      length: f32(edges.length),
      name: utf8Dictionary(1, new Uint32(), edges.name, g.names),
      osm_way_id: f64(edges.osmWayId),
      points,
    }, edges.count, metadata),
  };
}

export function roadGraphFromArrow(files: RoadGraphFiles): { graph: RoadGraph; metadata: GraphMetadata } {
  const n = readTable(files.nodes, "nodes");
  const e = readTable(files.edges, "edges");
  const nodeCount = n.table.numRows;
  const edgeCount = e.table.numRows;
  const nc = (name: string) => column(n.table, name, "nodes");
  const ec = (name: string) => column(e.table, name, "edges");

  const incident = listParts(nc("edges"), "nodes.edges");
  const nodes: RoadNodes = {
    count: nodeCount,
    x: values(nc("x"), nodeCount, Float32Array, "nodes.x"),
    y: values(nc("y"), nodeCount, Float32Array, "nodes.y"),
    osmId: values(nc("osm_id"), nodeCount, Float64Array, "nodes.osm_id"),
    edgeStart: incident.offsets,
    edgeList: values(incident.child, incident.offsets[nodeCount]!, Uint32Array, "nodes.edges"),
  };

  const classData = ec("class");
  const classes = dictionaryStrings(classData, "edges.class");
  if (classes.join() !== ROAD_CLASSES.join()) throw new Error("edges.class: dictionary does not match ROAD_CLASSES");
  const nameData = ec("name");
  const pts = listParts(ec("points"), "edges.points");
  const pointCount = pts.offsets[edgeCount]!;

  const edges: RoadEdges = {
    count: edgeCount,
    from: values(ec("from"), edgeCount, Uint32Array, "edges.from"),
    to: values(ec("to"), edgeCount, Uint32Array, "edges.to"),
    class: values(classData, edgeCount, Uint8Array, "edges.class"),
    lanesFwd: values(ec("lanes_fwd"), edgeCount, Uint8Array, "edges.lanes_fwd"),
    lanesBack: values(ec("lanes_back"), edgeCount, Uint8Array, "edges.lanes_back"),
    speedLimit: values(ec("speed_limit"), edgeCount, Float32Array, "edges.speed_limit"),
    length: values(ec("length"), edgeCount, Float32Array, "edges.length"),
    name: values(nameData, edgeCount, Uint32Array, "edges.name"),
    osmWayId: values(ec("osm_way_id"), edgeCount, Float64Array, "edges.osm_way_id"),
    pointStart: pts.offsets,
  };

  return {
    graph: {
      nodes,
      edges,
      points: values(pts.child.children[0]!, pointCount * 2, Float32Array, "edges.points"),
      names: dictionaryStrings(nameData, "edges.name"),
    },
    metadata: { ...n.metadata, ...e.metadata },
  };
}
