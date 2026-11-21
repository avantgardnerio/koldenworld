-- Water areas (lakes, reservoirs, ponds, river surfaces) and waterways mapped
-- as lines (rivers, streams, canals, ditches), keyed by OSM element like
-- buildings and road ways. kind: 'lake' is drawn flat at one level, 'river'
-- follows the ground. Cells clip both to their own square at export.
CREATE TABLE water_areas (
  osm_type  text     NOT NULL CHECK (osm_type IN ('way', 'relation')),
  osm_id    bigint   NOT NULL,
  kind      text     NOT NULL CHECK (kind IN ('lake', 'river')),
  name      text,
  geom      geometry(MultiPolygon, 4326) NOT NULL,
  tags      jsonb    NOT NULL,
  fetch_id  bigint   NOT NULL REFERENCES osm_fetches,
  PRIMARY KEY (osm_type, osm_id)
);
CREATE INDEX water_areas_geom_idx ON water_areas USING gist (geom);
CREATE INDEX water_areas_fetch_id_idx ON water_areas (fetch_id);

CREATE TABLE waterways (
  osm_way_id  bigint  PRIMARY KEY,
  kind        text    NOT NULL,  -- waterway=* value
  name        text,
  width_m     real    NOT NULL CHECK (width_m > 0),
  geom        geometry(LineString, 4326) NOT NULL,
  tags        jsonb   NOT NULL,
  fetch_id    bigint  NOT NULL REFERENCES osm_fetches
);
CREATE INDEX waterways_geom_idx ON waterways USING gist (geom);
CREATE INDEX waterways_fetch_id_idx ON waterways (fetch_id);
