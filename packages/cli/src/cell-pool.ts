// Builds cells on a pool of worker threads (cell-worker.ts), one cell per
// worker at a time: building is CPU-bound (draping, street polygons), and one
// thread kept the server to a few cells a second. The main thread serves
// cached cells itself (only reading files), keeps one build per cell in flight,
// gives each build to the worker with the least to do, and does the OSM
// downloads the workers ask for (one queue, each area once).

import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { cellFromToken, cellToken, type CellFiles, type CellId } from "@game/world";
import { cachedCell, CellService } from "./cells.ts";

/** Each worker's elevation cache, in ~1 MB blocks. */
const ELEVATION_BLOCKS = 256;

export class CellPool {
  private workers: { worker: Worker; busy: number }[] = [];
  private pending = new Map<number, { resolve: (f: CellFiles) => void; reject: (e: Error) => void; slot: number }>();
  private builds = new Map<CellId, Promise<CellFiles>>();
  private nextId = 0;
  private fetcher: CellService;

  constructor(log: (msg: string) => void, size = Math.max(1, Math.min(16, availableParallelism() - 4))) {
    this.fetcher = new CellService(log, { elevationBlocks: 0 });
    for (let k = 0; k < size; k++) {
      const worker = new Worker(new URL("./cell-worker.ts", import.meta.url), { workerData: { elevationBlocks: ELEVATION_BLOCKS } });
      worker.on("message", (m: { log?: string; fetch?: number; token?: string; id?: number; files?: CellFiles; error?: string }) => {
        if (m.log !== undefined) { log(m.log); return; }
        if (m.fetch !== undefined) {
          this.fetcher.ensureFetched(cellFromToken(m.token!)).then(
            () => worker.postMessage({ fetched: m.fetch }),
            (err: unknown) => worker.postMessage({ fetched: m.fetch, error: err instanceof Error ? err.message : String(err) }),
          );
          return;
        }
        const p = this.pending.get(m.id!);
        if (!p) return;
        this.pending.delete(m.id!);
        this.workers[p.slot]!.busy--;
        if (m.error !== undefined) p.reject(new Error(m.error));
        else p.resolve(m.files!);
      });
      worker.on("error", (err) => log(`cell worker ${k}: ${err.message}`));
      this.workers.push({ worker, busy: 0 });
    }
    log(`cell pool: ${size} workers`);
  }

  /** The cell's files: from the disk cache, or built by a worker. */
  files(cell: CellId): Promise<CellFiles> {
    let p = this.builds.get(cell);
    if (!p) {
      p = cachedCell(cell).then((hit) => hit ?? this.build(cell)).finally(() => this.builds.delete(cell));
      this.builds.set(cell, p);
    }
    return p;
  }

  private build(cell: CellId): Promise<CellFiles> {
    let slot = 0;
    for (let k = 1; k < this.workers.length; k++) if (this.workers[k]!.busy < this.workers[slot]!.busy) slot = k;
    const id = this.nextId++;
    this.workers[slot]!.busy++;
    return new Promise<CellFiles>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, slot });
      this.workers[slot]!.worker.postMessage({ id, token: cellToken(cell) });
    });
  }
}
