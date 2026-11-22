// A cell-building worker thread (see cell-pool.ts): its own CellService, building
// the cells the main thread hands it and sending back their files. OSM downloads
// it asks the main thread for, so each area is downloaded and imported once.

import { parentPort, workerData } from "node:worker_threads";
import { cellFromToken, cellToken, type CellId } from "@game/world";
import { CellService } from "./cells.ts";

const port = parentPort!;
const fetches = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
let nextFetch = 0;
const fetcher = (fetchCell: CellId) => new Promise<void>((resolve, reject) => {
  const fetch = nextFetch++;
  fetches.set(fetch, { resolve, reject });
  port.postMessage({ fetch, token: cellToken(fetchCell) });
});
const cells = new CellService((msg) => port.postMessage({ log: msg }), { elevationBlocks: workerData.elevationBlocks, fetcher });

port.on("message", (m: { id?: number; token?: string; fetched?: number; error?: string }) => {
  if (m.fetched !== undefined) {
    const f = fetches.get(m.fetched)!;
    fetches.delete(m.fetched);
    if (m.error !== undefined) f.reject(new Error(m.error));
    else f.resolve();
    return;
  }
  cells.files(cellFromToken(m.token!)).then(
    (files) => port.postMessage({ id: m.id, files }),
    (err: unknown) => port.postMessage({ id: m.id, error: err instanceof Error ? err.message : String(err) }),
  );
});
