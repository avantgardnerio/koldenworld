// Usage: npm run cli -- <command> [options]

import { parseArgs } from "node:util";
import { migrate } from "@game/db";
import { cellFromToken } from "@game/world";
import { CellService } from "./cells.ts";
import { serve } from "./server.ts";

const USAGE = `commands:
  migrate                                          apply pending database migrations
  cell --token <s2 token>                          generate one cell's files (OSM imported by cellgen if needed)
  serve [--port <port>] [--host <addr>]            cell server: /cells/<token>/<table>.arrow, generated on a miss`;

const log = (msg: string) => console.log(msg);

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "migrate": {
      const applied = await migrate(undefined, log);
      if (applied.length === 0) log("database is up to date");
      return;
    }
    case "cell": {
      const { values } = parseArgs({ args: rest, options: { token: { type: "string" } } });
      if (!values.token) throw new Error("--token is required");
      await new CellService(log).files(cellFromToken(values.token));
      return;
    }
    case "serve": {
      const { values } = parseArgs({ args: rest, options: { port: { type: "string", default: "5174" }, host: { type: "string", default: "127.0.0.1" } } });
      await serve(Number(values.port), values.host, log);
      return;
    }
    default:
      console.log(USAGE);
      if (cmd !== undefined && cmd !== "help") process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
