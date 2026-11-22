// The cell server: GET /cells/<token>/<table>.arrow, or every table at once as
// GET /cells/<token>.cell (packCellFiles), generated on a miss (see cells.ts,
// built on a pool of worker threads: cell-pool.ts), and GET /aircraft?lat=&lon=&nm=
// for live air traffic (see aircraft.ts). The viewer's dev server proxies both here.

import { createServer } from "node:http";
import { CELL_LEVEL, CELL_TABLES, cellFromToken, cellLevel, packCellFiles, type CellFiles } from "@game/world";
import { AircraftService } from "./aircraft.ts";
import { CellPool } from "./cell-pool.ts";

const ROUTE = new RegExp(`^/cells/([0-9a-f]{1,16})(?:/(${CELL_TABLES.join("|")})\\.arrow|\\.cell)$`);

export function serve(port: number, host: string, log: (msg: string) => void): Promise<void> {
  const cells = new CellPool(log);
  const aircraft = new AircraftService(log);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/aircraft") {
      const [lat, lon, nm] = ["lat", "lon", "nm"].map((k) => Number(url.searchParams.get(k)));
      if (![lat, lon, nm].every(Number.isFinite)) {
        res.writeHead(400).end("lat, lon and nm are required\n");
        return;
      }
      aircraft.around(lat!, lon!, nm!).then(
        (body) => res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(body),
        (err: unknown) => res.writeHead(502, { "Content-Type": "text/plain" }).end(`${err instanceof Error ? err.message : String(err)}\n`),
      );
      return;
    }
    const m = ROUTE.exec(url.pathname);
    if (req.method !== "GET" || !m) {
      res.writeHead(404).end("not found\n");
      return;
    }
    const cell = cellFromToken(m[1]!);
    if (cellLevel(cell) !== CELL_LEVEL) {
      res.writeHead(400).end(`cells are served at level ${CELL_LEVEL}\n`);
      return;
    }
    const table = m[2] as (typeof CELL_TABLES)[number] | undefined;
    cells.files(cell).then(
      (files: CellFiles) => {
        const body = table ? files[table] : packCellFiles(files);
        res.writeHead(200, {
          "Content-Type": table ? "application/vnd.apache.arrow.file" : "application/octet-stream",
          "Content-Length": body.length,
          // Not even the browser's disk cache: it turned every cell into 3 cache files in $HOME,
          // and this server answers from its own cache in under a millisecond. Content-hashed,
          // immutable URLs are the plan once cells are served from somewhere remote.
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(body);
      },
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`cell ${m[1]}: ${msg}`);
        res.writeHead(502, { "Content-Type": "text/plain" }).end(`${msg}\n`);
      },
    );
  });
  return new Promise((resolve) => server.listen(port, host, () => {
    log(`cell server on http://${host}:${port}/cells/<token>/<table>.arrow`);
    resolve();
  }));
}
