//! An area's extracted OSM (extract.rs) into Postgres, in one transaction, as the TS import did: the snapshot is recorded
//! in osm_fetches (once per raw file, by its hash), every kind upserted by OSM id (each column passed whole, as an
//! array, and zipped by unnest), then rows the snapshot lacks deleted where they have a point inside the area's box:
//! Overpass returns everything with a node in the box, so a row like that which isn't in it is gone upstream.

use crate::extract::{AEROWAY_KINDS, Areas, Extracted, Lines, POI_KEYS, Polygons, WATER_KINDS};
use crate::osm::{NODE, Osm, Tags, WAY};
use crate::ways::ROAD_CLASSES;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tokio_postgres::Transaction;

type Error = Box<dyn std::error::Error + Send + Sync>;

/// Where a snapshot came from: its area ("s2:<token>"), box (west, south, east, north), and source.
pub struct Snapshot<'a> {
    pub area: &'a str,
    pub bbox: [f64; 4],
    pub source: &'a str,
    pub raw: &'a [u8],
}

/// Rows upserted and deleted, per table.
#[derive(Default, Debug)]
pub struct Counts {
    pub upserted: Vec<(&'static str, u64)>,
    pub deleted: Vec<(&'static str, u64)>,
}

/// Imports a snapshot's extracted data in one transaction.
pub async fn import(
    db: &mut tokio_postgres::Client,
    s: &Snapshot<'_>,
    osm: &Osm,
    x: &Extracted,
) -> Result<Counts, Error> {
    let tx = db.transaction().await?;
    let sha256: String = Sha256::digest(s.raw)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let [west, south, east, north] = s.bbox;
    let fetch: i64 = tx
        .query_one(
            "INSERT INTO osm_fetches (area, bbox, source, osm_base_timestamp, fetched_at, sha256)
             VALUES ($1, ST_MakeEnvelope($2, $3, $4, $5, 4326), $6, $7::text::timestamptz, now(), $8)
             ON CONFLICT (sha256) DO UPDATE SET imported_at = now()
             RETURNING id",
            &[&s.area, &west, &south, &east, &north, &s.source, &osm.timestamp, &sha256],
        )
        .await?
        .get(0);
    let mut counts = Counts::default();
    let rows = Rows { osm };
    roads(&tx, fetch, &rows, x, &mut counts).await?;
    buildings(&tx, fetch, &rows, x, &mut counts).await?;
    water(&tx, fetch, &rows, x, &mut counts).await?;
    aeroways(&tx, fetch, &rows, x, &mut counts).await?;
    pois(&tx, fetch, &rows, x, &mut counts).await?;
    tx.commit().await?;
    Ok(counts)
}

async fn roads(
    tx: &Transaction<'_>,
    fetch: i64,
    rows: &Rows<'_>,
    x: &Extracted,
    counts: &mut Counts,
) -> Result<(), Error> {
    let r = &x.roads;
    let ids: Vec<i64> = r.way.iter().map(|&w| rows.osm.way_id[w as usize]).collect();
    let node_ids: Vec<Value> = (0..ids.len())
        .map(|i| {
            Value::from(r.node_id[r.node_start[i] as usize..r.node_start[i + 1] as usize].to_vec())
        })
        .collect();
    let lines: Vec<String> = (0..ids.len())
        .map(|i| linestring(&r.lonlat[r.node_start[i] as usize..r.node_start[i + 1] as usize]))
        .collect();
    let n = tx
        .execute(
            "INSERT INTO road_ways (osm_way_id, class, name, oneway, lanes_fwd, lanes_back,
                                    speed_limit_mps, speed_limit_from_tag, length_m,
                                    node_ids, geom, tags, fetch_id)
             SELECT osm_way_id, class, name, oneway, lanes_fwd, lanes_back,
                    speed_limit_mps, speed_limit_from_tag, ST_Length(g::geography),
                    ARRAY(SELECT jsonb_array_elements_text(node_ids)::bigint), g, tags, $1
             FROM unnest($2::bigint[], $3::text[], $4::text[], $5::boolean[], $6::smallint[], $7::smallint[],
                         $8::real[], $9::boolean[], $10::jsonb[], $11::text[], $12::jsonb[])
               AS x(osm_way_id, class, name, oneway, lanes_fwd, lanes_back,
                    speed_limit_mps, speed_limit_from_tag, node_ids, wkt, tags),
               LATERAL ST_GeomFromText(wkt, 4326) AS g
             ON CONFLICT (osm_way_id) DO UPDATE SET
               class = excluded.class, name = excluded.name, oneway = excluded.oneway,
               lanes_fwd = excluded.lanes_fwd, lanes_back = excluded.lanes_back,
               speed_limit_mps = excluded.speed_limit_mps, speed_limit_from_tag = excluded.speed_limit_from_tag,
               length_m = excluded.length_m, node_ids = excluded.node_ids, geom = excluded.geom,
               tags = excluded.tags, fetch_id = excluded.fetch_id",
            &[
                &fetch,
                &ids,
                &r.class.iter().map(|&c| ROAD_CLASSES[c as usize]).collect::<Vec<_>>(),
                &r.way.iter().map(|&w| rows.text(&rows.osm.way_tags, w, "name").or(rows.text(&rows.osm.way_tags, w, "ref"))).collect::<Vec<_>>(),
                &r.oneway,
                &r.lanes_fwd.iter().map(|&l| l as i16).collect::<Vec<_>>(),
                &r.lanes_back.iter().map(|&l| l as i16).collect::<Vec<_>>(),
                &r.speed,
                &r.speed_from_tag,
                &node_ids,
                &lines,
                &r.way.iter().map(|&w| rows.tags(&rows.osm.way_tags, w)).collect::<Vec<_>>(),
            ],
        )
        .await?;
    counts.upserted.push(("road_ways", n));
    let n = tx
        .execute(
            "DELETE FROM road_ways r USING osm_fetches f
             WHERE f.id = $1 AND r.geom && f.bbox AND r.osm_way_id <> ALL($2::bigint[])
               AND EXISTS (SELECT 1 FROM ST_DumpPoints(r.geom) p WHERE ST_Intersects(p.geom, f.bbox))",
            &[&fetch, &ids],
        )
        .await?;
    counts.deleted.push(("road_ways", n));
    Ok(())
}

async fn buildings(
    tx: &Transaction<'_>,
    fetch: i64,
    rows: &Rows<'_>,
    x: &Extracted,
    counts: &mut Counts,
) -> Result<(), Error> {
    let b = &x.buildings;
    let (types, ids, tags) = rows.areas(&b.relation, &b.element);
    let names: Vec<Option<String>> = (0..ids.len())
        .map(|i| rows.text(rows.tags_of(b.relation[i]), b.element[i], "name"))
        .collect();
    let n = tx
        .execute(
            "INSERT INTO buildings (osm_type, osm_id, kind, is_part, name, height_m, min_height_m,
                                    height_source, levels, geom, tags, fetch_id)
             SELECT osm_type, osm_id, kind, is_part, name, height_m, min_height_m,
                    height_source, levels, ST_Multi(ST_GeomFromText(wkt, 4326)), tags, $1
             FROM unnest($2::text[], $3::bigint[], $4::text[], $5::boolean[], $6::text[], $7::real[], $8::real[],
                         $9::text[], $10::real[], $11::text[], $12::jsonb[])
               AS x(osm_type, osm_id, kind, is_part, name, height_m, min_height_m,
                    height_source, levels, wkt, tags)
             ON CONFLICT (osm_type, osm_id) DO UPDATE SET
               kind = excluded.kind, is_part = excluded.is_part, name = excluded.name,
               height_m = excluded.height_m, min_height_m = excluded.min_height_m,
               height_source = excluded.height_source, levels = excluded.levels,
               geom = excluded.geom, tags = excluded.tags, fetch_id = excluded.fetch_id",
            &[
                &fetch,
                &types,
                &ids,
                &b.kind.iter().map(|&k| rows.osm.strings.text[k as usize].as_str()).collect::<Vec<_>>(),
                &b.is_part,
                &names,
                &b.height,
                &b.min_height,
                &b.height_source.iter().map(|&s| ["height", "levels", "default"][s as usize]).collect::<Vec<_>>(),
                &b.levels.iter().map(|&l| (!l.is_nan()).then_some(l)).collect::<Vec<_>>(),
                &(0..ids.len()).map(|i| multipolygon(&b.shape, i)).collect::<Vec<_>>(),
                &tags,
            ],
        )
        .await?;
    counts.upserted.push(("buildings", n));
    let n = delete_missing_areas(tx, "buildings", fetch, &types, &ids).await?;
    counts.deleted.push(("buildings", n));
    Ok(())
}

async fn water(
    tx: &Transaction<'_>,
    fetch: i64,
    rows: &Rows<'_>,
    x: &Extracted,
    counts: &mut Counts,
) -> Result<(), Error> {
    let a = &x.water_areas;
    let (types, ids, tags) = rows.areas(&a.relation, &a.element);
    let n = tx
        .execute(
            "INSERT INTO water_areas (osm_type, osm_id, kind, name, geom, tags, fetch_id)
             SELECT osm_type, osm_id, kind, name, ST_Multi(ST_GeomFromText(wkt, 4326)), tags, $1
             FROM unnest($2::text[], $3::bigint[], $4::text[], $5::text[], $6::text[], $7::jsonb[])
               AS x(osm_type, osm_id, kind, name, wkt, tags)
             ON CONFLICT (osm_type, osm_id) DO UPDATE SET
               kind = excluded.kind, name = excluded.name, geom = excluded.geom, tags = excluded.tags,
               fetch_id = excluded.fetch_id",
            &[
                &fetch,
                &types,
                &ids,
                &a.kind.iter().map(|&k| WATER_KINDS[k as usize]).collect::<Vec<_>>(),
                &(0..ids.len()).map(|i| rows.text(rows.tags_of(a.relation[i]), a.element[i], "name")).collect::<Vec<_>>(),
                &(0..ids.len()).map(|i| multipolygon(&a.shape, i)).collect::<Vec<_>>(),
                &tags,
            ],
        )
        .await?;
    counts.upserted.push(("water_areas", n));
    let l = &x.waterways;
    let way_ids: Vec<i64> = l.way.iter().map(|&w| rows.osm.way_id[w as usize]).collect();
    let n = tx
        .execute(
            "INSERT INTO waterways (osm_way_id, kind, name, width_m, geom, tags, fetch_id)
             SELECT osm_way_id, kind, name, width_m, ST_GeomFromText(wkt, 4326), tags, $1
             FROM unnest($2::bigint[], $3::text[], $4::text[], $5::real[], $6::text[], $7::jsonb[])
               AS x(osm_way_id, kind, name, width_m, wkt, tags)
             ON CONFLICT (osm_way_id) DO UPDATE SET
               kind = excluded.kind, name = excluded.name, width_m = excluded.width_m, geom = excluded.geom,
               tags = excluded.tags, fetch_id = excluded.fetch_id",
            &[
                &fetch,
                &way_ids,
                &l.kind.iter().map(|&k| rows.osm.strings.text[k as usize].as_str()).collect::<Vec<_>>(),
                &l.way.iter().map(|&w| rows.text(&rows.osm.way_tags, w, "name")).collect::<Vec<_>>(),
                &l.width,
                &line_wkts(l),
                &l.way.iter().map(|&w| rows.tags(&rows.osm.way_tags, w)).collect::<Vec<_>>(),
            ],
        )
        .await?;
    counts.upserted.push(("waterways", n));
    let n = delete_missing_areas(tx, "water_areas", fetch, &types, &ids).await?;
    counts.deleted.push(("water_areas", n));
    let n = delete_missing_lines(tx, "waterways", fetch, &way_ids).await?;
    counts.deleted.push(("waterways", n));
    Ok(())
}

async fn aeroways(
    tx: &Transaction<'_>,
    fetch: i64,
    rows: &Rows<'_>,
    x: &Extracted,
    counts: &mut Counts,
) -> Result<(), Error> {
    let a: &Areas = &x.aeroway_areas;
    let (types, ids, tags) = rows.areas(&a.relation, &a.element);
    let n = tx
        .execute(
            "INSERT INTO aeroway_areas (osm_type, osm_id, kind, geom, tags, fetch_id)
             SELECT osm_type, osm_id, kind, ST_Multi(ST_GeomFromText(wkt, 4326)), tags, $1
             FROM unnest($2::text[], $3::bigint[], $4::text[], $5::text[], $6::jsonb[])
               AS x(osm_type, osm_id, kind, wkt, tags)
             ON CONFLICT (osm_type, osm_id) DO UPDATE SET
               kind = excluded.kind, geom = excluded.geom, tags = excluded.tags, fetch_id = excluded.fetch_id",
            &[
                &fetch,
                &types,
                &ids,
                &a.kind.iter().map(|&k| AEROWAY_KINDS[k as usize]).collect::<Vec<_>>(),
                &(0..ids.len()).map(|i| multipolygon(&a.shape, i)).collect::<Vec<_>>(),
                &tags,
            ],
        )
        .await?;
    counts.upserted.push(("aeroway_areas", n));
    let l: &Lines = &x.aeroway_lines;
    let way_ids: Vec<i64> = l.way.iter().map(|&w| rows.osm.way_id[w as usize]).collect();
    let n = tx
        .execute(
            "INSERT INTO aeroway_lines (osm_way_id, kind, ref, width_m, geom, tags, fetch_id)
             SELECT osm_way_id, kind, ref, width_m, ST_GeomFromText(wkt, 4326), tags, $1
             FROM unnest($2::bigint[], $3::text[], $4::text[], $5::real[], $6::text[], $7::jsonb[])
               AS x(osm_way_id, kind, ref, width_m, wkt, tags)
             ON CONFLICT (osm_way_id) DO UPDATE SET
               kind = excluded.kind, ref = excluded.ref, width_m = excluded.width_m, geom = excluded.geom,
               tags = excluded.tags, fetch_id = excluded.fetch_id",
            &[
                &fetch,
                &way_ids,
                &l.kind.iter().map(|&k| AEROWAY_KINDS[k as usize]).collect::<Vec<_>>(),
                &l.way.iter().map(|&w| rows.text(&rows.osm.way_tags, w, "ref")).collect::<Vec<_>>(),
                &l.width,
                &line_wkts(l),
                &l.way.iter().map(|&w| rows.tags(&rows.osm.way_tags, w)).collect::<Vec<_>>(),
            ],
        )
        .await?;
    counts.upserted.push(("aeroway_lines", n));
    let n = delete_missing_areas(tx, "aeroway_areas", fetch, &types, &ids).await?;
    counts.deleted.push(("aeroway_areas", n));
    let n = delete_missing_lines(tx, "aeroway_lines", fetch, &way_ids).await?;
    counts.deleted.push(("aeroway_lines", n));
    Ok(())
}

async fn pois(
    tx: &Transaction<'_>,
    fetch: i64,
    rows: &Rows<'_>,
    x: &Extracted,
    counts: &mut Counts,
) -> Result<(), Error> {
    let p = &x.pois;
    let o = rows.osm;
    let (mut types, mut ids, mut tags, mut names, mut brands) =
        (vec![], vec![], vec![], vec![], vec![]);
    for i in 0..p.key.len() {
        let e = p.element[i];
        let (kind, id, t) = match p.element_type[i] {
            NODE => ("node", o.node_id[e as usize], &o.node_tags),
            WAY => ("way", o.way_id[e as usize], &o.way_tags),
            _ => ("relation", o.relation_id[e as usize], &o.relation_tags),
        };
        types.push(kind);
        ids.push(id);
        tags.push(rows.tags(t, e));
        names.push(rows.text(t, e, "name"));
        brands.push(rows.text(t, e, "brand"));
    }
    let n = tx
        .execute(
            "INSERT INTO pois (osm_type, osm_id, category, kind, name, brand, geom, tags, fetch_id)
             SELECT osm_type, osm_id, category, kind, name, brand, ST_SetSRID(ST_MakePoint(lon, lat), 4326), tags, $1
             FROM unnest($2::text[], $3::bigint[], $4::text[], $5::text[], $6::text[], $7::text[],
                         $8::float8[], $9::float8[], $10::jsonb[])
               AS x(osm_type, osm_id, category, kind, name, brand, lon, lat, tags)
             ON CONFLICT (osm_type, osm_id) DO UPDATE SET
               category = excluded.category, kind = excluded.kind, name = excluded.name, brand = excluded.brand,
               geom = excluded.geom, tags = excluded.tags, fetch_id = excluded.fetch_id",
            &[
                &fetch,
                &types,
                &ids,
                &p.key.iter().map(|&k| POI_KEYS[k as usize]).collect::<Vec<_>>(),
                &p.value.iter().map(|&v| o.strings.text[v as usize].as_str()).collect::<Vec<_>>(),
                &names,
                &brands,
                &p.lonlat.iter().map(|q| q[0]).collect::<Vec<_>>(),
                &p.lonlat.iter().map(|q| q[1]).collect::<Vec<_>>(),
                &tags,
            ],
        )
        .await?;
    counts.upserted.push(("pois", n));
    // A point in the box that this snapshot lacks is gone (or no longer a point of interest).
    let n = tx
        .execute(
            "DELETE FROM pois p USING osm_fetches f
             WHERE f.id = $1 AND ST_Intersects(p.geom, f.bbox)
               AND (p.osm_type, p.osm_id) NOT IN (SELECT * FROM unnest($2::text[], $3::bigint[]))",
            &[&fetch, &types, &ids],
        )
        .await?;
    counts.deleted.push(("pois", n));
    Ok(())
}

async fn delete_missing_areas(
    tx: &Transaction<'_>,
    table: &str,
    fetch: i64,
    types: &[&str],
    ids: &[i64],
) -> Result<u64, Error> {
    let sql = format!(
        "DELETE FROM {table} b USING osm_fetches f
         WHERE f.id = $1 AND b.geom && f.bbox
           AND (b.osm_type, b.osm_id) NOT IN (SELECT * FROM unnest($2::text[], $3::bigint[]))
           AND EXISTS (SELECT 1 FROM ST_DumpPoints(b.geom) p WHERE ST_Intersects(p.geom, f.bbox))"
    );
    Ok(tx.execute(&sql, &[&fetch, &types, &ids]).await?)
}

async fn delete_missing_lines(
    tx: &Transaction<'_>,
    table: &str,
    fetch: i64,
    ids: &[i64],
) -> Result<u64, Error> {
    let sql = format!(
        "DELETE FROM {table} w USING osm_fetches f
         WHERE f.id = $1 AND w.geom && f.bbox AND w.osm_way_id <> ALL($2::bigint[])
           AND EXISTS (SELECT 1 FROM ST_DumpPoints(w.geom) p WHERE ST_Intersects(p.geom, f.bbox))"
    );
    Ok(tx.execute(&sql, &[&fetch, &ids]).await?)
}

/// Element lookups for the rows: tags as JSON, a tag's text.
struct Rows<'a> {
    osm: &'a Osm,
}

impl<'a> Rows<'a> {
    fn tags_of(&self, relation: bool) -> &'a Tags {
        if relation {
            &self.osm.relation_tags
        } else {
            &self.osm.way_tags
        }
    }

    /// An element's tags as a JSON object.
    fn tags(&self, tags: &Tags, e: u32) -> Value {
        let e = e as usize;
        let text = &self.osm.strings.text;
        let map: Map<String, Value> = tags.pairs
            [tags.start[e] as usize..tags.start[e + 1] as usize]
            .iter()
            .map(|&[k, v]| {
                (
                    text[k as usize].clone(),
                    Value::from(text[v as usize].as_str()),
                )
            })
            .collect();
        Value::Object(map)
    }

    fn text(&self, tags: &Tags, e: u32, key: &str) -> Option<String> {
        let k = self.osm.strings.find(key)?;
        tags.get(e as usize, k)
            .map(|v| self.osm.strings.text[v as usize].clone())
    }

    /// Areas' OSM types, ids and tags.
    fn areas(
        &self,
        relation: &[bool],
        element: &[u32],
    ) -> (Vec<&'static str>, Vec<i64>, Vec<Value>) {
        let o = self.osm;
        let types = relation
            .iter()
            .map(|&r| if r { "relation" } else { "way" })
            .collect();
        let ids = relation
            .iter()
            .zip(element)
            .map(|(&r, &e)| {
                if r {
                    o.relation_id[e as usize]
                } else {
                    o.way_id[e as usize]
                }
            })
            .collect();
        let tags = relation
            .iter()
            .zip(element)
            .map(|(&r, &e)| self.tags(self.tags_of(r), e))
            .collect();
        (types, ids, tags)
    }
}

// --- WKT --------------------------------------------------------------------------------------------------------------

fn linestring(points: &[[f64; 2]]) -> String {
    let coords: Vec<String> = points
        .iter()
        .map(|[lon, lat]| format!("{lon} {lat}"))
        .collect();
    format!("LINESTRING({})", coords.join(","))
}

fn line_wkts(l: &Lines) -> Vec<String> {
    (0..l.way.len())
        .map(|i| linestring(&l.lonlat[l.point_start[i] as usize..l.point_start[i + 1] as usize]))
        .collect()
}

/// Feature f's polygons as a MULTIPOLYGON.
fn multipolygon(p: &Polygons, f: usize) -> String {
    let polygons: Vec<String> = (p.poly_start[f] as usize..p.poly_start[f + 1] as usize)
        .map(|poly| {
            let rings: Vec<String> = (p.ring_start[poly] as usize..p.ring_start[poly + 1] as usize)
                .map(|r| {
                    let coords: Vec<String> = p.lonlat
                        [p.point_start[r] as usize..p.point_start[r + 1] as usize]
                        .iter()
                        .map(|[lon, lat]| format!("{lon} {lat}"))
                        .collect();
                    format!("({})", coords.join(","))
                })
                .collect();
            format!("({})", rings.join(","))
        })
        .collect();
    format!("MULTIPOLYGON({})", polygons.join(","))
}
