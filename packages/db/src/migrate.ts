// Forward-only plain SQL migrations.
//
// Files in db/migrations are applied in filename order, each in its own
// transaction, and recorded in schema_migrations with a checksum. Editing a
// migration after it has been applied is an error: write a new one instead.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { MIGRATIONS_DATABASE_URL, MIGRATIONS_DIR } from "./config.ts";

export interface Migration {
  version: string;   // filename without .sql, e.g. "0002_roads"
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(files.map(async (f) => {
    const sql = await readFile(path.join(dir, f), "utf8");
    return {
      version: f.slice(0, -".sql".length),
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    };
  }));
}

/** Applies pending migrations. Returns the versions applied. */
export async function migrate(
  url = MIGRATIONS_DATABASE_URL,
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations");
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    const migrations = await loadMigrations();
    for (const m of migrations) {
      const prior = applied.get(m.version);
      if (prior !== undefined && prior !== m.checksum) {
        throw new Error(`migration ${m.version} was edited after being applied; add a new migration instead`);
      }
    }
    for (const version of applied.keys()) {
      if (!migrations.some((m) => m.version === version)) {
        throw new Error(`migration ${version} is recorded in the database but missing from ${MIGRATIONS_DIR}`);
      }
    }

    const done: string[] = [];
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [m.version, m.checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${m.version} failed: ${(err as Error).message}`, { cause: err });
      }
      log(`applied ${m.version}`);
      done.push(m.version);
    }
    return done;
  } finally {
    await client.end();
  }
}
