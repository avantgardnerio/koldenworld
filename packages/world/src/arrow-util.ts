// Shared Arrow IPC plumbing for map tables: one record batch per file, no
// nulls, no slicing, so every column is one contiguous buffer and reads are
// typed-array views onto the file bytes.

import {
  Dictionary, Field, makeData, RecordBatch, Schema, Struct, Table, tableFromIPC, tableToIPC,
  Float32, Float64, Uint16, Uint32, Uint8, Utf8, vectorFromArray,
  type Data, type DataType,
} from "apache-arrow";

/** Free-form provenance stored in each file's schema metadata (values are JSON-encoded). */
export type FileMetadata = Record<string, unknown>;

// --- write ----------------------------------------------------------------

export const f32 = (data: Float32Array) => makeData({ type: new Float32(), length: data.length, nullCount: 0, data });
export const f64 = (data: Float64Array) => makeData({ type: new Float64(), length: data.length, nullCount: 0, data });
export const u8 = (data: Uint8Array) => makeData({ type: new Uint8(), length: data.length, nullCount: 0, data });
export const u32 = (data: Uint32Array) => makeData({ type: new Uint32(), length: data.length, nullCount: 0, data });

// Dictionary ids must be explicit: Arrow JS otherwise takes them from a global
// counter, and the same table would serialize to different bytes on each call.
export function utf8Dictionary<I extends Uint8 | Uint16 | Uint32>(id: number, indexType: I, indices: I["TArray"], values: readonly string[]) {
  return makeData({
    type: new Dictionary(new Utf8(), indexType, id),
    length: indices.length,
    nullCount: 0,
    data: indices,
    dictionary: vectorFromArray([...values], new Utf8()),
  });
}

export function toIPC(columns: Record<string, Data>, length: number, metadata: FileMetadata): Uint8Array {
  const fields = Object.entries(columns).map(([name, d]) => new Field(name, d.type, false));
  const meta = new Map(Object.entries(metadata).map(([k, v]) => [k, JSON.stringify(v)]));
  const schema = new Schema(fields, meta);
  const struct = makeData({ type: new Struct(fields), length, nullCount: 0, children: Object.values(columns) });
  return tableToIPC(new Table([new RecordBatch(schema, struct)]), "file");
}

// --- read -----------------------------------------------------------------

export function readTable(bytes: Uint8Array, which: string): { table: Table; metadata: FileMetadata } {
  const table = tableFromIPC(bytes);
  if (table.batches.length !== 1) throw new Error(`${which}: expected 1 record batch, got ${table.batches.length}`);
  const metadata: FileMetadata = {};
  for (const [k, v] of table.schema.metadata) metadata[k] = JSON.parse(v);
  return { table, metadata };
}

export function column(table: Table, name: string, which: string): Data {
  const col = table.getChild(name);
  if (!col) throw new Error(`${which}: missing column ${name}`);
  const d = col.data[0]!;
  if (d.offset !== 0 || d.nullCount !== 0) throw new Error(`${which}.${name}: sliced or nullable data is not supported`);
  return d;
}

export function values<T extends { subarray(a: number, b: number): T }>(
  d: Data, length: number, ctor: abstract new (...args: never[]) => T, where: string,
): T {
  const v: unknown = d.values;
  if (!(v instanceof ctor)) throw new Error(`${where}: unexpected buffer type`);
  return (v as T).subarray(0, length);
}

export function listParts(d: Data, where: string): { offsets: Int32Array; child: Data } {
  const offsets: unknown = d.valueOffsets;
  if (!(offsets instanceof Int32Array)) throw new Error(`${where}: expected int32 list offsets`);
  return { offsets: offsets.subarray(0, d.length + 1), child: d.children[0]! };
}

export function dictionaryStrings(d: Data<DataType>, where: string): string[] {
  const dict = d.dictionary;
  if (!dict) throw new Error(`${where}: expected a dictionary`);
  return [...dict.toArray()] as string[];
}
