import path from "node:path";

// Local socket + trust auth (see db/bootstrap.sql), so there are no secrets here.
// Override with env vars to point somewhere else.

/** Runtime role: DML only. */
export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://game@/game?host=/var/run/postgresql";

/** Owner role: runs DDL migrations. */
export const MIGRATIONS_DATABASE_URL =
  process.env.MIGRATIONS_DATABASE_URL ?? "postgres://game_migrations@/game?host=/var/run/postgresql";

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../../db/migrations");
