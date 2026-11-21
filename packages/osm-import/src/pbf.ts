// OSM PBF (the .osm.pbf format of Geofabrik extracts and planet files):
// a sequence of length-prefixed, usually zlib-compressed protobuf blocks.
// This is a small hand-written protobuf reader for the parts we use, so
// elements come out as the same OsmNode / OsmWay / OsmRelation objects the
// Overpass JSON gives, and every extractor works on either source.
//
// Format: https://wiki.openstreetmap.org/wiki/PBF_Format (fileformat.proto,
// osmformat.proto). Decompression is injected (zlib is a platform API), so
// this module stays platform-free.

import type { OsmRelation, OsmWay, Tags } from "./osm.ts";

// --- protobuf wire format -------------------------------------------------------

class Reader {
  pos: number;
  readonly end: number;
  readonly buf: Uint8Array;

  constructor(buf: Uint8Array, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  get done() { return this.pos >= this.end; }

  /** Unsigned varint as a number: exact below 2^53, which covers ids, sizes and offsets. */
  varint(): number {
    const b = this.buf;
    let x = 0, mul = 1, byte: number;
    do {
      byte = b[this.pos++]!;
      x += (byte & 0x7f) * mul;
      mul *= 128;
    } while (byte & 0x80);
    return x;
  }

  /** Signed (zigzag) varint. */
  svarint(): number {
    const v = this.varint();
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }

  /** int32/int64 fields, which encode negative values as 10-byte two's complement varints. */
  int(): number {
    const start = this.pos;
    const v = this.varint();
    if (this.pos - start < 10) return v;
    let x = 0n;
    for (let i = this.pos - 1; i >= start; i--) x = (x << 7n) | BigInt(this.buf[i]! & 0x7f);
    return Number(BigInt.asIntN(64, x));
  }

  /** A length-delimited field's [start, end). */
  bytes(): [number, number] {
    const len = this.varint();
    const start = this.pos;
    this.pos += len;
    return [start, this.pos];
  }

  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported protobuf wire type ${wire}`);
  }

  /** Each value of a packed (or single unpacked) repeated varint field. */
  packed(wire: number, read: (r: Reader) => number, out: number[]): void {
    if (wire !== 2) {
      out.push(read(this));
      return;
    }
    const [s, e] = this.bytes();
    const r = new Reader(this.buf, s, e);
    while (!r.done) out.push(read(r));
  }
}

const utf8 = new TextDecoder();
const vint = (r: Reader) => r.varint();
const sint = (r: Reader) => r.svarint();

// --- file blocks -----------------------------------------------------------------

export interface PbfBlock {
  type: string;        // "OSMHeader" or "OSMData"
  blob: Uint8Array;    // the Blob message, still compressed
}

/** The file's blocks, without decompressing them. */
export function* pbfBlocks(file: Uint8Array): Generator<PbfBlock> {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let pos = 0;
  while (pos < file.length) {
    const headerLen = view.getUint32(pos);
    const h = new Reader(file, pos + 4, pos + 4 + headerLen);
    let type = "", size = 0;
    while (!h.done) {
      const key = h.varint();
      if (key >> 3 === 1) {
        const [s, e] = h.bytes();
        type = utf8.decode(file.subarray(s, e));
      } else if (key >> 3 === 3) size = h.varint();
      else h.skip(key & 7);
    }
    const start = pos + 4 + headerLen;
    yield { type, blob: file.subarray(start, start + size) };
    pos = start + size;
  }
}

export type Inflate = (zlibData: Uint8Array, rawSize: number) => Uint8Array;

/** A block's payload, decompressed. */
export function blobData(blob: Uint8Array, inflate: Inflate): Uint8Array {
  const r = new Reader(blob);
  let rawSize = 0;
  let raw: Uint8Array | undefined, zlib: Uint8Array | undefined;
  while (!r.done) {
    const key = r.varint(), field = key >> 3;
    if (field === 1 || field === 3) {
      const [s, e] = r.bytes();
      if (field === 1) raw = blob.subarray(s, e);
      else zlib = blob.subarray(s, e);
    } else if (field === 2) rawSize = r.varint();
    else if (field >= 4 && field <= 7) throw new Error(`unsupported PBF compression (Blob field ${field})`);
    else r.skip(key & 7);
  }
  if (raw) return raw;
  if (zlib) return inflate(zlib, rawSize);
  throw new Error("empty PBF blob");
}

export interface PbfHeader {
  requiredFeatures: string[];
  optionalFeatures: string[];
  writingProgram?: string;
  replicationTimestamp?: string;  // ISO, the OSM data's base time
}

export function readHeader(data: Uint8Array): PbfHeader {
  const r = new Reader(data);
  const h: PbfHeader = { requiredFeatures: [], optionalFeatures: [] };
  const str = () => { const [s, e] = r.bytes(); return utf8.decode(data.subarray(s, e)); };
  while (!r.done) {
    const key = r.varint(), field = key >> 3;
    if (field === 4) h.requiredFeatures.push(str());
    else if (field === 5) h.optionalFeatures.push(str());
    else if (field === 16) h.writingProgram = str();
    else if (field === 32) h.replicationTimestamp = new Date(r.int() * 1000).toISOString();
    else r.skip(key & 7);
  }
  return h;
}

// --- data blocks -------------------------------------------------------------------

export interface PbfVisitor {
  /** Called for every node; tags only when `nodeTags` is set (building them is most of the cost). */
  node?(id: number, lat: number, lon: number, tags: Tags | undefined): void;
  nodeTags?: boolean;
  way?(w: OsmWay): void;
  relation?(r: OsmRelation): void;
}

const MEMBER_TYPES = ["node", "way", "relation"] as const;

/** Decodes one PrimitiveBlock, calling the visitor per element. Groups the visitor doesn't want are skipped undecoded. */
export function readPrimitiveBlock(data: Uint8Array, v: PbfVisitor): void {
  const r = new Reader(data);
  const strings: string[] = [];
  const groups: [number, number][] = [];
  let granularity = 100, latOffset = 0, lonOffset = 0;
  while (!r.done) {
    const key = r.varint(), field = key >> 3;
    if (field === 1) {
      const [s, e] = r.bytes();
      const t = new Reader(data, s, e);
      while (!t.done) {
        const k = t.varint();
        if (k >> 3 === 1) {
          const [a, b] = t.bytes();
          strings.push(utf8.decode(data.subarray(a, b)));
        } else t.skip(k & 7);
      }
    } else if (field === 2) groups.push(r.bytes());
    else if (field === 17) granularity = r.int();
    else if (field === 19) latOffset = r.int();
    else if (field === 20) lonOffset = r.int();
    else r.skip(key & 7);
  }
  const lat = (raw: number) => 1e-9 * (latOffset + granularity * raw);
  const lon = (raw: number) => 1e-9 * (lonOffset + granularity * raw);
  const tagsOf = (keys: number[], vals: number[]): Tags | undefined => {
    if (keys.length === 0) return undefined;
    const t: Tags = {};
    for (let i = 0; i < keys.length; i++) t[strings[keys[i]!]!] = strings[vals[i]!]!;
    return t;
  };

  for (const [gs, ge] of groups) {
    const g = new Reader(data, gs, ge);
    while (!g.done) {
      const key = g.varint(), field = key >> 3;
      if (field === 2 && v.node) readDense(data, g.bytes(), v, strings, lat, lon);
      else if (field === 1 && v.node) {
        const [s, e] = g.bytes();
        const n = new Reader(data, s, e);
        let id = 0, la = 0, lo = 0;
        const keys: number[] = [], vals: number[] = [];
        while (!n.done) {
          const k = n.varint(), f = k >> 3;
          if (f === 1) id = n.svarint();
          else if (f === 2) n.packed(k & 7, vint, keys);
          else if (f === 3) n.packed(k & 7, vint, vals);
          else if (f === 8) la = n.svarint();
          else if (f === 9) lo = n.svarint();
          else n.skip(k & 7);
        }
        v.node(id, lat(la), lon(lo), v.nodeTags ? tagsOf(keys, vals) : undefined);
      } else if (field === 3 && v.way) {
        const [s, e] = g.bytes();
        const w = new Reader(data, s, e);
        let id = 0;
        const keys: number[] = [], vals: number[] = [], refs: number[] = [];
        while (!w.done) {
          const k = w.varint(), f = k >> 3;
          if (f === 1) id = w.int();
          else if (f === 2) w.packed(k & 7, vint, keys);
          else if (f === 3) w.packed(k & 7, vint, vals);
          else if (f === 8) w.packed(k & 7, sint, refs);
          else w.skip(k & 7);
        }
        for (let i = 1; i < refs.length; i++) refs[i]! += refs[i - 1]!;  // delta coded
        const tags = tagsOf(keys, vals);
        v.way(tags ? { type: "way", id, nodes: refs, tags } : { type: "way", id, nodes: refs });
      } else if (field === 4 && v.relation) {
        const [s, e] = g.bytes();
        const m = new Reader(data, s, e);
        let id = 0;
        const keys: number[] = [], vals: number[] = [], roles: number[] = [], ids: number[] = [], types: number[] = [];
        while (!m.done) {
          const k = m.varint(), f = k >> 3;
          if (f === 1) id = m.int();
          else if (f === 2) m.packed(k & 7, vint, keys);
          else if (f === 3) m.packed(k & 7, vint, vals);
          else if (f === 8) m.packed(k & 7, vint, roles);
          else if (f === 9) m.packed(k & 7, sint, ids);
          else if (f === 10) m.packed(k & 7, vint, types);
          else m.skip(k & 7);
        }
        let ref = 0;
        const members = ids.map((d, i) => ({ type: MEMBER_TYPES[types[i]!]!, ref: (ref += d), role: strings[roles[i]!]! }));
        const tags = tagsOf(keys, vals);
        v.relation(tags ? { type: "relation", id, members, tags } : { type: "relation", id, members });
      } else g.skip(key & 7);
    }
  }
}

function readDense(
  data: Uint8Array, [s, e]: [number, number], v: PbfVisitor, strings: string[],
  lat: (raw: number) => number, lon: (raw: number) => number,
): void {
  const d = new Reader(data, s, e);
  const ids: number[] = [], lats: number[] = [], lons: number[] = [], kv: number[] = [];
  while (!d.done) {
    const k = d.varint(), f = k >> 3;
    if (f === 1) d.packed(k & 7, sint, ids);
    else if (f === 8) d.packed(k & 7, sint, lats);
    else if (f === 9) d.packed(k & 7, sint, lons);
    else if (f === 10 && v.nodeTags) d.packed(k & 7, vint, kv);
    else d.skip(k & 7);
  }
  // keys_vals: per node, key, value, key, value, ..., 0.
  let id = 0, la = 0, lo = 0, t = 0;
  for (let i = 0; i < ids.length; i++) {
    id += ids[i]!;
    la += lats[i]!;
    lo += lons[i]!;
    let tags: Tags | undefined;
    if (v.nodeTags && kv.length > 0) {
      while (kv[t] !== 0) {
        (tags ??= {})[strings[kv[t]!]!] = strings[kv[t + 1]!]!;
        t += 2;
      }
      t++;
    }
    v.node!(id, lat(la), lon(lo), tags);
  }
}
