-- PostGIS is created by the superuser in db/bootstrap.sql. This is a no-op there;
-- on a database where the bootstrap was skipped it fails loudly, since
-- game_migrations is not allowed to create the extension.
CREATE EXTENSION IF NOT EXISTS postgis;
