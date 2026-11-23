-- Points of interest: named (or branded) shops, amenities, offices, tourism,
-- crafts, leisure and healthcare, as points: a node where it is, a building or
-- area at its outline's center. For shopfronts and signs on the buildings
-- they're in. Keyed by OSM element; category is the key that made it one
-- (shop, amenity, ...), kind its value (cafe, bakery, ...).
CREATE TABLE pois (
  osm_type  text     NOT NULL CHECK (osm_type IN ('node', 'way', 'relation')),
  osm_id    bigint   NOT NULL,
  category  text     NOT NULL,
  kind      text     NOT NULL,
  name      text,
  brand     text,
  geom      geometry(Point, 4326) NOT NULL,
  tags      jsonb    NOT NULL,
  fetch_id  bigint   NOT NULL REFERENCES osm_fetches,
  PRIMARY KEY (osm_type, osm_id)
);
CREATE INDEX pois_geom_idx ON pois USING gist (geom);
CREATE INDEX pois_fetch_id_idx ON pois (fetch_id);
