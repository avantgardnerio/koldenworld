-- Buildings and building parts, keyed by OSM element: ways and relations have
-- separate id spaces, so the key is (osm_type, osm_id). Geometry is always a
-- MultiPolygon (closed ways become one polygon; multipolygon relations may have
-- several outers). Whether a building's parts replace its outline is decided at
-- blob export, from the parts present in the selection.
CREATE TABLE buildings (
  osm_type       text     NOT NULL CHECK (osm_type IN ('way', 'relation')),
  osm_id         bigint   NOT NULL,
  kind           text     NOT NULL,  -- building=* or building:part=* value
  is_part        boolean  NOT NULL,  -- building:part=*
  name           text,
  height_m       real     NOT NULL CHECK (height_m > 0),          -- top of the walls
  min_height_m   real     NOT NULL CHECK (min_height_m >= 0),     -- bottom of the walls
  height_source  text     NOT NULL CHECK (height_source IN ('height', 'levels', 'default')),
  levels         real,                                            -- building:levels, as tagged
  geom           geometry(MultiPolygon, 4326) NOT NULL,
  tags           jsonb    NOT NULL,  -- raw OSM tags
  fetch_id       bigint   NOT NULL REFERENCES osm_fetches,  -- fetch that last wrote this row
  PRIMARY KEY (osm_type, osm_id),
  CHECK (min_height_m < height_m)
);

CREATE INDEX buildings_geom_idx ON buildings USING gist (geom);
CREATE INDEX buildings_fetch_id_idx ON buildings (fetch_id);
