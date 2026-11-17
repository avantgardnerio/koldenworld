-- One-time setup for the game database. Run as the postgres superuser:
--
--   sudo -u postgres psql -v ON_ERROR_STOP=1 -f db/bootstrap.sql
--
-- Prerequisite: sudo apt install postgresql-18-postgis-3
--
-- Roles (same pattern as koldenhome):
--   game_migrations  owns the database and schema, runs DDL migrations
--   game             runtime role, DML only
--
-- Both authenticate with `trust` on the local socket and loopback, limited to
-- the `game` database, via /etc/postgresql/18/main/pg_hba.conf lines placed
-- above the general `local all all` rule (mirrors koldenhome's lines):
--
--   local   game   game_migrations                   trust
--   host    game   game_migrations   127.0.0.1/32    trust
--   host    game   game_migrations   ::1/128         trust
--   local   game   game                              trust
--   host    game   game              127.0.0.1/32    trust
--   host    game   game              ::1/128         trust
--
-- then: sudo systemctl reload postgresql

CREATE ROLE game_migrations LOGIN;
CREATE ROLE game LOGIN;

CREATE DATABASE game OWNER game_migrations;
REVOKE CONNECT, TEMPORARY ON DATABASE game FROM PUBLIC;
GRANT CONNECT ON DATABASE game TO game_migrations, game;

\connect game

-- PostGIS is not a trusted extension, so it must be created by a superuser.
-- Migration 0001 repeats this with IF NOT EXISTS so a skipped bootstrap fails loudly.
CREATE EXTENSION postgis;

-- Everything game_migrations creates in public is usable by the runtime role.
ALTER DEFAULT PRIVILEGES FOR ROLE game_migrations IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO game;
ALTER DEFAULT PRIVILEGES FOR ROLE game_migrations IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO game;
