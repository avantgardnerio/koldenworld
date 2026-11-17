-- One row per downloaded raw OSM snapshot (data/osm/<area>.json).
CREATE TABLE osm_fetches (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  area                text        NOT NULL,         -- e.g. zip code '80205'
  bbox                geometry(Polygon, 4326) NOT NULL,
  source              text        NOT NULL,         -- e.g. the Overpass endpoint
  osm_base_timestamp  timestamptz,                  -- OSM data as of this time
  fetched_at          timestamptz NOT NULL,
  sha256              text        NOT NULL UNIQUE,  -- of the raw file; re-imports are idempotent
  imported_at         timestamptz NOT NULL DEFAULT now()
);

-- Drivable OSM ways, unsplit, keyed by OSM id so imports upsert and overlapping
-- fetches merge. Splitting at intersections happens at blob export.
-- One-way ways have node_ids and geom ordered in the direction of travel.
CREATE TABLE road_ways (
  osm_way_id            bigint   PRIMARY KEY,
  class                 text     NOT NULL,  -- OSM highway=* value
  name                  text,
  oneway                boolean  NOT NULL,
  lanes_fwd             smallint NOT NULL CHECK (lanes_fwd > 0),
  lanes_back            smallint NOT NULL CHECK (lanes_back >= 0),
  speed_limit_mps       real     NOT NULL,
  speed_limit_from_tag  boolean  NOT NULL,  -- false when a default by class was used
  length_m              real     NOT NULL,
  node_ids              bigint[] NOT NULL CHECK (cardinality(node_ids) >= 2),
  geom                  geometry(LineString, 4326) NOT NULL,
  tags                  jsonb    NOT NULL,  -- raw OSM tags
  fetch_id              bigint   NOT NULL REFERENCES osm_fetches,  -- fetch that last wrote this row
  CHECK (oneway = (lanes_back = 0)),
  CHECK (cardinality(node_ids) = ST_NPoints(geom))
);

CREATE INDEX road_ways_geom_idx ON road_ways USING gist (geom);
CREATE INDEX road_ways_node_ids_idx ON road_ways USING gin (node_ids);  -- ways sharing a node
CREATE INDEX road_ways_fetch_id_idx ON road_ways (fetch_id);
