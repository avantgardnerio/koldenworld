// Cell streaming: keep the cells around the camera loaded, nearest first.
//
// Each update gets the wanted cells (within the load radius, nearest first)
// and the ones to keep (a larger radius, so cells at the edge don't thrash).
// Cells outside the keep set are disposed, even mid-load. A few loads run at
// once; a failed cell is retried after a while. Pure TS, no DOM.

import type { CellId } from "@game/world";

export type SlotState = "loading" | "ready" | "failed";

interface Slot<T> {
  state: SlotState;
  data?: T;
  failedAt?: number;
}

export interface StreamerOptions<T> {
  load(cell: CellId): Promise<T>;
  dispose(data: T): void;
  onChange(): void;
  concurrency?: number;
  retryMs?: number;
  now?: () => number;
}

export class CellStreamer<T> {
  private slots = new Map<CellId, Slot<T>>();
  private queue: CellId[] = [];
  private inflight = 0;
  private o: Required<StreamerOptions<T>>;

  constructor(o: StreamerOptions<T>) {
    this.o = { concurrency: 4, retryMs: 30_000, now: () => performance.now(), ...o };
  }

  update(wanted: readonly CellId[], keep: ReadonlySet<CellId>): void {
    for (const [cell, slot] of this.slots) {
      const stale = slot.state === "failed" && this.o.now() - slot.failedAt! > this.o.retryMs;
      if (keep.has(cell) && !stale) continue;
      if (slot.data !== undefined) this.o.dispose(slot.data);
      this.slots.delete(cell);  // a load still in flight finds its slot gone and disposes
    }
    this.queue = wanted.filter((c) => !this.slots.has(c));
    this.pump();
  }

  /** Loaded cells and their data. */
  *ready(): Generator<[CellId, T]> {
    for (const [cell, slot] of this.slots) if (slot.state === "ready") yield [cell, slot.data!];
  }

  counts(): Record<SlotState | "queued", number> {
    const n = { loading: 0, ready: 0, failed: 0, queued: this.queue.length };
    for (const s of this.slots.values()) n[s.state]++;
    return n;
  }

  /** Nothing loading or queued. */
  get settled(): boolean {
    return this.inflight === 0 && this.queue.length === 0;
  }

  private pump(): void {
    while (this.inflight < this.o.concurrency && this.queue.length > 0) {
      const cell = this.queue.shift()!;
      const slot: Slot<T> = { state: "loading" };
      this.slots.set(cell, slot);
      this.inflight++;
      this.o.load(cell).then(
        (data) => {
          if (this.slots.get(cell) === slot) Object.assign(slot, { state: "ready", data });
          else this.o.dispose(data);
        },
        (err: unknown) => {
          console.warn(`cell load failed:`, err);
          Object.assign(slot, { state: "failed", failedAt: this.o.now() });
        },
      ).finally(() => {
        this.inflight--;
        this.pump();
        this.o.onChange();
      });
    }
  }
}
