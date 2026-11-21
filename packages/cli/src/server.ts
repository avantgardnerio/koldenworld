// The cell server: GET /cells/<token>/<table>.arrow, generated on a miss
// (see cells.ts). The viewer's dev server proxies /cells here.

import { createServer } from "node:http";
import { CELL_LEVEL, CELL_TABLES, cellFromToken, cellLevel, type CellFiles } from "@game/world";
import { CellService } from "./cells.ts";

const ROUTE = /^\/cells\/([0-9a-f]{1,16})\/(nodes|edges|buildings)\.arrow$/;

export function serve(port: number, log: (msg: string) => void): Promise<void> {
  const cells = new CellService(log);
  const server = createServer((req, res) => {
    const m = ROUTE.exec(new URL(req.url ?? "/", "http://x").pathname);
    if (req.method !== "GET" || !m) {
      res.writeHead(404).end("not found\n");
      return;
    }
    const cell = cellFromToken(m[1]!);
    if (cellLevel(cell) !== CELL_LEVEL) {
      res.writeHead(400).end(`cells are served at level ${CELL_LEVEL}\n`);
      return;
    }
    const table = m[2] as (typeof CELL_TABLES)[number];
    cells.files(cell).then(
      (files: CellFiles) => {
        res.writeHead(200, {
          "Content-Type": "application/vnd.apache.arrow.file",
          "Content-Length": files[table].length,
          "Cache-Control": "no-cache",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(files[table]);
      },
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`cell ${m[1]}: ${msg}`);
        res.writeHead(502, { "Content-Type": "text/plain" }).end(`${msg}\n`);
      },
    );
  });
  return new Promise((resolve) => server.listen(port, () => {
    log(`cell server on http://localhost:${port}/cells/<token>/<table>.arrow`);
    resolve();
  }));
}
