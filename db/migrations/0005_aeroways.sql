-- Airport surfaces (decision 32): aprons and runways or taxiways mapped as
-- areas, and runways and taxiways mapped as center lines with a width, keyed
-- by OSM element like water. Cells clip both to their own square at export.
CREATE TABLE aeroway_areas (
  osm_type  text     NOT NULL CHECK (osm_type IN ('way', 'relation')),
  osm_id    bigint   NOT NULL,
  kind      text     NOT NULL CHECK (kind IN ('runway', 'taxiway', 'apron')),
  geom      geometry(MultiPolygon, 4326) NOT NULL,
  tags      jsonb    NOT NULL,
  fetch_id  bigint   NOT NULL REFERENCES osm_fetches,
  PRIMARY KEY (osm_type, osm_id)
);
CREATE INDEX aeroway_areas_geom_idx ON aeroway_areas USING gist (geom);
CREATE INDEX aeroway_areas_fetch_id_idx ON aeroway_areas (fetch_id);

CREATE TABLE aeroway_lines (
  osm_way_id  bigint  PRIMARY KEY,
  kind        text    NOT NULL CHECK (kind IN ('runway', 'taxiway')),
  ref         text,
  width_m     real    NOT NULL CHECK (width_m > 0),
  geom        geometry(LineString, 4326) NOT NULL,
  tags        jsonb   NOT NULL,
  fetch_id    bigint  NOT NULL REFERENCES osm_fetches
);
CREATE INDEX aeroway_lines_geom_idx ON aeroway_lines USING gist (geom);
CREATE INDEX aeroway_lines_fetch_id_idx ON aeroway_lines (fetch_id);
