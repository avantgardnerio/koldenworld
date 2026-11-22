// Usage: npm run cli -- <command> [options]

import { parseArgs } from "node:util";
import { migrate } from "@game/db";
import { cellFromToken } from "@game/world";
import { CellService } from "./cells.ts";
import { fetchOsm } from "./fetch-osm.ts";
import { importArea } from "./import.ts";
import { importPbf } from "./import-pbf.ts";
import { serve } from "./server.ts";

const USAGE = `commands:
  fetch-osm --zip <zip> [--size <km>] [--force]   download raw OSM for a square around a zip code
  migrate                                          apply pending database migrations
  import --zip <zip>                               convert downloaded OSM into road_ways and buildings
  import-pbf --file <x.osm.pbf> [--poly <file>] [--within lat,lon,km] [--force]
                                                   import every download cell an extract fully covers
  cell --token <s2 token>                          generate one cell's files (downloading OSM if needed)
  serve [--port <port>] [--host <addr>]            cell server: /cells/<token>/<table>.arrow, generated on a miss`;

const log = (msg: string) => console.log(msg);

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "fetch-osm": {
      const { values } = parseArgs({
        args: rest,
        options: { zip: { type: "string" }, size: { type: "string", default: "2" }, force: { type: "boolean", default: false } },
      });
      if (!values.zip) throw new Error("--zip is required");
      await fetchOsm({ zip: values.zip, sizeKm: Number(values.size), force: values.force }, log);
      return;
    }
    case "migrate": {
      const applied = await migrate(undefined, log);
      if (applied.length === 0) log("database is up to date");
      return;
    }
    case "import": {
      const { values } = parseArgs({ args: rest, options: { zip: { type: "string" } } });
      if (!values.zip) throw new Error("--zip is required");
      await importArea(values.zip, log);
      return;
    }
    case "import-pbf": {
      const { values } = parseArgs({
        args: rest,
        options: { file: { type: "string" }, poly: { type: "string" }, within: { type: "string" }, force: { type: "boolean", default: false } },
      });
      if (!values.file) throw new Error("--file is required");
      const w = values.within?.split(",").map(Number);
      await importPbf({
        file: values.file, poly: values.poly, force: values.force,
        within: w ? { lat: w[0]!, lon: w[1]!, km: w[2]! } : undefined,
      }, log);
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
