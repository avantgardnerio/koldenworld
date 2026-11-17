// Usage: npm run cli -- <command> [options]

import { parseArgs } from "node:util";
import { migrate } from "@game/db";
import { fetchOsm } from "./fetch-osm.ts";
import { importRoads } from "./import-roads.ts";

const USAGE = `commands:
  fetch-osm --zip <zip> [--size <km>] [--force]   download raw OSM for a square around a zip code
  migrate                                          apply pending database migrations
  import-roads --zip <zip>                         convert downloaded OSM into the roads table`;

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
    case "import-roads": {
      const { values } = parseArgs({ args: rest, options: { zip: { type: "string" } } });
      if (!values.zip) throw new Error("--zip is required");
      await importRoads(values.zip, log);
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
