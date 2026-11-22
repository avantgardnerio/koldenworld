// Columnar tables for dynamic entities (decision 28): one typed array per
// column, rows packed densely in 0..count-1.
//
// Batch updates loop over the columns directly (`for (let i = 0; i < n; i++)
// s[i] += v[i] * dt`): contiguous, monomorphic, no holes to skip, the shape
// that ports to WASM SIMD unchanged. Removing a row moves the last row into
// its place, so rows have no stable identity; anything that must survive a
// removal keeps its own id column.
//
// Row-based logic (branching per entity) uses a cursor: a reusable view whose
// properties read and write the columns at its current row. Move it by setting
// `i`; it never allocates.

type Column =
  | Float32ArrayConstructor | Float64ArrayConstructor
  | Int8ArrayConstructor | Uint8ArrayConstructor | Int16ArrayConstructor | Uint16ArrayConstructor
  | Int32ArrayConstructor | Uint32ArrayConstructor;

export type Schema = Record<string, Column>;
export type Columns<S extends Schema> = { [K in keyof S]: InstanceType<S[K]> };
export type Cursor<S extends Schema> = { i: number } & { -readonly [K in keyof S]: number };

const cursorClasses = new WeakMap<Schema, new (t: Table<Schema>) => Cursor<Schema>>();

export class Table<S extends Schema> {
  count = 0;
  capacity: number;
  readonly schema: S;
  c: Columns<S>;

  constructor(schema: S, capacity = 1024) {
    this.schema = schema;
    this.capacity = capacity;
    this.c = Object.fromEntries(Object.entries(schema).map(([k, T]) => [k, new T(capacity)])) as Columns<S>;
  }

  /** Appends a zeroed row and returns its index. Grows by doubling. */
  add(): number {
    if (this.count === this.capacity) {
      this.capacity *= 2;
      for (const [k, T] of Object.entries(this.schema)) {
        const next = new T(this.capacity);
        next.set(this.c[k] as never);
        (this.c as Record<string, unknown>)[k] = next;
      }
    }
    const i = this.count++;
    for (const k in this.c) this.c[k][i] = 0;
    return i;
  }

  /** Removes row i by moving the last row into it. Iterate downward when removing during a scan. */
  remove(i: number): void {
    const last = --this.count;
    if (i !== last) for (const k in this.c) this.c[k][i] = this.c[k][last]!;
  }

  clear(): void {
    this.count = 0;
  }

  /** A view onto row i (default 0); set `.i` to move it. */
  cursor(i = 0): Cursor<S> {
    let C = cursorClasses.get(this.schema);
    if (!C) {
      class RowCursor {
        i = 0;
        readonly table: Table<Schema>;
        constructor(t: Table<Schema>) {
          this.table = t;
        }
      }
      for (const k of Object.keys(this.schema)) {
        Object.defineProperty(RowCursor.prototype, k, {
          get(this: RowCursor) { return this.table.c[k]![this.i]; },
          set(this: RowCursor, v: number) { this.table.c[k]![this.i] = v; },
        });
      }
      C = RowCursor as unknown as new (t: Table<Schema>) => Cursor<Schema>;
      cursorClasses.set(this.schema, C);
    }
    const cur = new C(this as unknown as Table<Schema>) as unknown as Cursor<S>;
    cur.i = i;
    return cur;
  }
}
