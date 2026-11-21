// Buildings ⇄ Apache Arrow IPC (buildings.arrow), one record batch, zero-copy
// reads. Rings are a nested list, so both CSR levels are Arrow list offsets:
//
//   osm_id         float64
//   osm_type       dictionary<uint8, utf8>    "way" | "relation"
//   kind           dictionary<uint16, utf8>   building / building:part tag value
//   is_part        uint8                      0 / 1
//   height         float32                    m, top of walls
//   min_height     float32                    m, bottom of walls
//   base           float32                    m, ground under the building in the frame (lowest point)
//   height_source  dictionary<uint8, utf8>    "height" | "levels" | "default"
//   rings          list<list<fixed_size_list<float32, 2>>>   outer first (CCW), holes CW; open rings

import { Field, FixedSizeList, Float32, List, makeData, Uint16, Uint8 } from "apache-arrow";
import {
  column, dictionaryStrings, f32, f64, listParts, readTable, toIPC, u8, utf8Dictionary, values,
  type FileMetadata,
} from "./arrow-util.ts";
import { HEIGHT_SOURCES, OSM_TYPES, type Buildings } from "./buildings.ts";

export function buildingsToArrow(b: Buildings, metadata: FileMetadata): Uint8Array {
  const pointType = new FixedSizeList(2, new Field("xy", new Float32(), false));
  const ringType = new List(new Field("point", pointType, false));
  const ringCount = b.ringStart[b.count]!;
  const rings = makeData({
    type: new List(new Field("ring", ringType, false)),
    length: b.count,
    nullCount: 0,
    valueOffsets: b.ringStart,
    child: makeData({
      type: ringType,
      length: ringCount,
      nullCount: 0,
      valueOffsets: b.pointStart,
      child: makeData({ type: pointType, length: b.points.length / 2, nullCount: 0, child: f32(b.points) }),
    }),
  });
  return toIPC({
    osm_id: f64(b.osmId),
    osm_type: utf8Dictionary(0, new Uint8(), b.osmType, OSM_TYPES),
    kind: utf8Dictionary(1, new Uint16(), b.kind, b.kinds),
    is_part: u8(b.isPart),
    height: f32(b.height),
    min_height: f32(b.minHeight),
    base: f32(b.base),
    height_source: utf8Dictionary(2, new Uint8(), b.heightSource, HEIGHT_SOURCES),
    rings,
  }, b.count, metadata);
}

export function buildingsFromArrow(bytes: Uint8Array): { buildings: Buildings; metadata: FileMetadata } {
  const { table, metadata } = readTable(bytes, "buildings");
  const count = table.numRows;
  const c = (name: string) => column(table, name, "buildings");

  const fixed = (name: string, expected: readonly string[]) => {
    const got = dictionaryStrings(c(name), `buildings.${name}`);
    if (got.join() !== expected.join()) throw new Error(`buildings.${name}: dictionary does not match`);
  };
  fixed("osm_type", OSM_TYPES);
  fixed("height_source", HEIGHT_SOURCES);

  const outer = listParts(c("rings"), "buildings.rings");
  const ringCount = outer.offsets[count]!;
  const inner = listParts(outer.child, "buildings.rings[]");
  const pointCount = inner.offsets[ringCount]!;
  const kindData = c("kind");

  return {
    buildings: {
      count,
      osmId: values(c("osm_id"), count, Float64Array, "buildings.osm_id"),
      osmType: values(c("osm_type"), count, Uint8Array, "buildings.osm_type"),
      kind: values(kindData, count, Uint16Array, "buildings.kind"),
      isPart: values(c("is_part"), count, Uint8Array, "buildings.is_part"),
      height: values(c("height"), count, Float32Array, "buildings.height"),
      minHeight: values(c("min_height"), count, Float32Array, "buildings.min_height"),
      base: values(c("base"), count, Float32Array, "buildings.base"),
      heightSource: values(c("height_source"), count, Uint8Array, "buildings.height_source"),
      ringStart: outer.offsets,
      pointStart: inner.offsets,
      points: values(inner.child.children[0]!, pointCount * 2, Float32Array, "buildings.points"),
      kinds: dictionaryStrings(kindData, "buildings.kind"),
    },
    metadata,
  };
}
