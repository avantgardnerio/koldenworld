import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { blobData, pbfBlocks, readHeader, readPrimitiveBlock, type OsmRelation, type OsmWay, type Tags } from "../src/index.ts";

// --- a minimal protobuf encoder, enough to write a PBF -----------------------------

const varint = (v: number): number[] => {
  const out: number[] = [];
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
};
const zigzag = (v: number) => (v < 0 ? -2 * v - 1 : 2 * v);
const key = (field: number, wire: number) => varint(field * 8 + wire);
const bytesField = (field: number, data: number[] | Uint8Array) => [...key(field, 2), ...varint(data.length), ...data];
const intField = (field: number, v: number) => [...key(field, 0), ...varint(v)];
const packed = (field: number, vs: number[]) => bytesField(field, vs.flatMap(varint));
const deltas = (vs: number[]) => vs.map((v, i) => zigzag(v - (i > 0 ? vs[i - 1]! : 0)));
const utf8 = (s: string) => [...new TextEncoder().encode(s)];

function fileBlock(type: string, payload: number[], compress: boolean): number[] {
  const blob = compress
    ? [...intField(2, payload.length), ...bytesField(3, deflateSync(Uint8Array.from(payload)))]
    : bytesField(1, payload);
  const header = [...bytesField(1, utf8(type)), ...intField(3, blob.length)];
  const len = header.length;
  return [len >>> 24, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...header, ...blob];
}

// Strings: 0 is "" by convention.
const S = ["", "highway", "residential", "name", "Ünïcode St", "building", "yes", "type", "multipolygon", "outer"];
const s = (x: string) => S.indexOf(x);

// Denver-ish coordinates (negative longitude), ids above 2^32.
const BIG = 2 ** 33;
const nodes = [
  { id: BIG + 1, lat: 39.7482163, lon: -104.9597869, tags: { highway: "residential" } as Tags },
  { id: BIG + 5, lat: 39.7483, lon: -104.96 },
  { id: BIG + 9, lat: 39.75, lon: -104.95 },
];

function testFile(compress: boolean): Uint8Array {
  const gran = 100;  // nanodegrees
  const raw = (deg: number) => Math.round(deg * 1e9 / gran);
  const kv = nodes.flatMap((n) => [...Object.entries(n.tags ?? {}).flatMap(([k, v]) => [s(k), s(v)]), 0]);
  const dense = [
    ...packed(1, deltas(nodes.map((n) => n.id))),
    ...packed(8, deltas(nodes.map((n) => raw(n.lat)))),
    ...packed(9, deltas(nodes.map((n) => raw(n.lon)))),
    ...packed(10, kv),
  ];
  const way = [
    ...intField(1, BIG + 100),
    ...packed(2, [s("highway"), s("name")]), ...packed(3, [s("residential"), s("Ünïcode St")]),
    ...packed(8, deltas([BIG + 9, BIG + 1, BIG + 5])),
  ];
  const rel = [
    ...intField(1, 7),
    ...packed(2, [s("type"), s("building")]), ...packed(3, [s("multipolygon"), s("yes")]),
    ...packed(8, [s("outer"), s("")]),
    ...packed(9, deltas([BIG + 100, BIG + 1])),
    ...packed(10, [1, 0]),
  ];
  const block = [
    ...bytesField(1, S.flatMap((x) => bytesField(1, utf8(x)))),
    ...bytesField(2, bytesField(2, dense)),
    ...bytesField(2, bytesField(3, way)),
    ...bytesField(2, bytesField(4, rel)),
    ...intField(17, gran),
  ];
  const header = [...bytesField(4, utf8("DenseNodes")), ...bytesField(5, utf8("Sort.Type_then_ID")), ...intField(32, 1_763_673_681)];
  return Uint8Array.from([...fileBlock("OSMHeader", header, compress), ...fileBlock("OSMData", block, compress)]);
}

const inflate = (z: Uint8Array) => inflateSync(z);

function decode(file: Uint8Array, nodeTags = true) {
  const out = { nodes: [] as { id: number; lat: number; lon: number; tags?: Tags }[], ways: [] as OsmWay[], relations: [] as OsmRelation[] };
  const blocks = [...pbfBlocks(file)];
  const header = readHeader(blobData(blocks[0]!.blob, inflate));
  for (const b of blocks.slice(1)) {
    readPrimitiveBlock(blobData(b.blob, inflate), {
      nodeTags,
      node: (id, lat, lon, tags) => out.nodes.push(tags ? { id, lat, lon, tags } : { id, lat, lon }),
      way: (w) => out.ways.push(w),
      relation: (r) => out.relations.push(r),
    });
  }
  return { header, ...out };
}

describe("PBF", () => {
  for (const compress of [true, false]) {
    it(`decodes header, dense nodes, ways and relations (${compress ? "zlib" : "raw"} blobs)`, () => {
      const d = decode(testFile(compress));
      expect(d.header).toMatchObject({
        requiredFeatures: ["DenseNodes"], optionalFeatures: ["Sort.Type_then_ID"], replicationTimestamp: "2025-11-20T21:21:21.000Z",
      });
      expect(d.nodes.map((n) => n.id)).toEqual(nodes.map((n) => n.id));
      d.nodes.forEach((n, i) => {
        expect(n.lat).toBeCloseTo(nodes[i]!.lat, 9);
        expect(n.lon).toBeCloseTo(nodes[i]!.lon, 9);
      });
      expect(d.nodes[0]!.tags).toEqual({ highway: "residential" });
      expect(d.nodes[1]!.tags).toBeUndefined();
      expect(d.ways).toEqual([{
        type: "way", id: BIG + 100, nodes: [BIG + 9, BIG + 1, BIG + 5], tags: { highway: "residential", name: "Ünïcode St" },
      }]);
      expect(d.relations).toEqual([{
        type: "relation", id: 7, tags: { type: "multipolygon", building: "yes" },
        members: [{ type: "way", ref: BIG + 100, role: "outer" }, { type: "node", ref: BIG + 1, role: "" }],
      }]);
    });
  }

  it("skips node tags unless asked", () => {
    expect(decode(testFile(true), false).nodes.every((n) => n.tags === undefined)).toBe(true);
  });
});
