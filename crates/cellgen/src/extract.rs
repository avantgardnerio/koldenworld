//! Raw OSM (osm.rs) → what the game stores: drivable road ways, buildings, water areas and waterways, airport areas and
//! center lines, and points of interest. A port of the TS extractors (packages/osm-import), rule for rule, plus points
//! of interest. Every kind as columns; each feature keeps its source element, for its tags.
//!
//! Areas (buildings, water, airports) come from closed ways and from multipolygon relations, whose outer and inner
//! member ways are joined into rings by their ends; an inner ring belongs to the outer ring holding its first point.

use crate::osm::{NODE, Osm, Tags, WAY};
use crate::ways::ROAD_CLASSES;
use std::collections::HashMap;

const MPH: f64 = 0.44704; // m/s
const KMH: f64 = 1.0 / 3.6; // m/s

/// US defaults (mph), when maxspeed is missing or unparseable, by class (ROAD_CLASSES order).
const DEFAULT_SPEED_MPH: [f64; ROAD_CLASSES.len()] = [
    65.0, 35.0, 55.0, 35.0, 35.0, 30.0, 30.0, 25.0, 30.0, 25.0, 25.0, 25.0, 15.0, 10.0, 25.0,
];
/// Sidewalk bits (as ways.rs): which sides of a stored way have one, looking along its stored node order.
pub const SIDEWALK_LEFT: u8 = 1;
pub const SIDEWALK_RIGHT: u8 = 2;
/// Town streets: where untagged roads get sidewalks on both sides (at most 40 mph).
const SIDEWALK_CLASSES: [&str; 6] = [
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
    "living_street",
];
const SIDEWALK_MAX_SPEED: f64 = 40.0 * MPH;

/// m per storey; m heights when neither height nor levels is tagged, by kind (else FALLBACK_HEIGHT).
const LEVEL_HEIGHT: f64 = 3.0;
const DEFAULT_HEIGHT: [(&str, f64); 36] = [
    ("house", 6.0),
    ("detached", 6.0),
    ("semidetached_house", 6.0),
    ("bungalow", 4.0),
    ("terrace", 7.0),
    ("duplex", 7.0),
    ("residential", 8.0),
    ("apartments", 12.0),
    ("dormitory", 12.0),
    ("garage", 3.0),
    ("garages", 3.0),
    ("shed", 2.5),
    ("carport", 3.0),
    ("roof", 4.0),
    ("hut", 3.0),
    ("commercial", 8.0),
    ("retail", 5.0),
    ("office", 12.0),
    ("hotel", 15.0),
    ("supermarket", 6.0),
    ("kiosk", 3.0),
    ("industrial", 8.0),
    ("warehouse", 9.0),
    ("manufacture", 9.0),
    ("church", 12.0),
    ("cathedral", 20.0),
    ("chapel", 8.0),
    ("school", 8.0),
    ("university", 12.0),
    ("college", 10.0),
    ("kindergarten", 4.0),
    ("public", 8.0),
    ("civic", 8.0),
    ("government", 10.0),
    ("hospital", 15.0),
    ("fire_station", 7.0),
];
const FALLBACK_HEIGHT: f64 = 6.0;
/// Parking structures are a building kind too (the TS has it last).
const PARKING_HEIGHT: f64 = 10.0;

/// Water: what a natural=water's water=* draws as a river surface; waterway widths (m) when untagged.
const RIVER_WATER: [&str; 8] = [
    "river",
    "stream",
    "canal",
    "rapids",
    "ditch",
    "drain",
    "stream_pool",
    "oxbow",
];
const WATERWAY_WIDTH: [(&str, f64); 5] = [
    ("river", 12.0),
    ("canal", 6.0),
    ("stream", 2.5),
    ("ditch", 1.5),
    ("drain", 1.5),
];

/// Airports: center line kinds (aeroway=* → runway or taxiway), and widths (m) when untagged.
const AEROWAY_LINES: [(&str, u8, f64); 4] = [
    ("runway", 0, 45.0),
    ("stopway", 0, 45.0),
    ("taxiway", 1, 23.0),
    ("taxilane", 1, 15.0),
];
/// What makes a point of interest: one of these keys, and a name or brand.
pub const POI_KEYS: [&str; 7] = [
    "shop",
    "amenity",
    "office",
    "tourism",
    "craft",
    "leisure",
    "healthcare",
];

/// Everything extracted, each kind as columns.
#[derive(Default)]
pub struct Extracted {
    pub roads: Roads,
    pub buildings: Buildings,
    pub water_areas: Areas,
    pub waterways: Lines,
    pub aeroway_areas: Areas,
    pub aeroway_lines: Lines,
    pub pois: Pois,
    pub skipped: usize, // missing nodes, rings that never close, unclosed areas
}

/// Drivable road ways. For one-way roads, nodes run in the direction of travel.
#[derive(Default)]
pub struct Roads {
    pub way: Vec<u32>,  // index into the OSM ways
    pub class: Vec<u8>, // index into ROAD_CLASSES
    pub oneway: Vec<bool>,
    pub lanes_fwd: Vec<u8>,
    pub lanes_back: Vec<u8>, // 0 when one-way
    pub speed: Vec<f32>,     // m/s
    pub speed_from_tag: Vec<bool>,
    pub sidewalks: Vec<u8>,   // SIDEWALK_LEFT | SIDEWALK_RIGHT
    pub structure: Vec<u8>,   // 0 on the ground, 1 bridge, 2 tunnel
    pub node_start: Vec<u32>, // roads + 1 offsets into node_id and lonlat
    pub node_id: Vec<i64>,
    pub lonlat: Vec<[f64; 2]>,
}

/// Polygons with holes, per feature: feature f's polygons poly_start[f]..poly_start[f + 1], polygon p's rings
/// ring_start[p]..ring_start[p + 1] (outer first, closed: first point repeated), ring r's points
/// point_start[r]..point_start[r + 1].
#[derive(Default)]
pub struct Polygons {
    pub poly_start: Vec<u32>,
    pub ring_start: Vec<u32>,
    pub point_start: Vec<u32>,
    pub lonlat: Vec<[f64; 2]>,
}

impl Polygons {
    /// Feature f's rings, each with whether it's an outer ring (a polygon's first).
    pub fn rings(&self, f: usize) -> impl Iterator<Item = (bool, &[[f64; 2]])> + Clone {
        (self.poly_start[f] as usize..self.poly_start[f + 1] as usize).flat_map(move |p| {
            (self.ring_start[p] as usize..self.ring_start[p + 1] as usize).map(move |r| {
                let points = self.point_start[r] as usize..self.point_start[r + 1] as usize;
                (r == self.ring_start[p] as usize, &self.lonlat[points])
            })
        })
    }
}

/// Features by OSM type as text, then id (as Postgres's `ORDER BY osm_type, osm_id` did): relations, then ways.
pub fn by_type_and_id(osm: &Osm, relation: &[bool], element: &[u32]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..element.len()).collect();
    order.sort_by_key(|&f| {
        let e = element[f] as usize;
        (
            !relation[f],
            if relation[f] {
                osm.relation_id[e]
            } else {
                osm.way_id[e]
            },
        )
    });
    order
}

/// Areas (water, airports): their source (a way or a relation), kind, and polygons.
#[derive(Default)]
pub struct Areas {
    pub relation: Vec<bool>, // the source: a relation (else a way)
    pub element: Vec<u32>,   // index into the OSM ways or relations
    pub kind: Vec<u8>,       // into WATER_KINDS or AEROWAY_KINDS
    pub shape: Polygons,
}

/// Buildings: areas with a kind (the building / building:part value) and heights.
#[derive(Default)]
pub struct Buildings {
    pub relation: Vec<bool>,
    pub element: Vec<u32>,
    pub kind: Vec<u32>, // index into the OSM strings
    pub is_part: Vec<bool>,
    pub height: Vec<f32>,       // m, top of the walls
    pub min_height: Vec<f32>,   // m, bottom of the walls
    pub height_source: Vec<u8>, // 0 "height", 1 "levels", 2 "default" (as the TS HEIGHT_SOURCES)
    pub levels: Vec<f32>,       // building:levels; NaN where not tagged
    pub shape: Polygons,
}

/// Lines with a width (waterways, airport center lines).
#[derive(Default)]
pub struct Lines {
    pub way: Vec<u32>,
    pub kind: Vec<u32>, // waterways: index into the OSM strings (waterway=*); airports: into AEROWAY_KINDS
    pub width: Vec<f32>, // m
    pub point_start: Vec<u32>,
    pub lonlat: Vec<[f64; 2]>,
}

/// Points of interest: named shops, amenities, offices, ... as points (an area's at its outline's center).
#[derive(Default)]
pub struct Pois {
    pub element_type: Vec<u8>, // osm::NODE, WAY or RELATION
    pub element: Vec<u32>,     // index into the OSM nodes, ways or relations
    pub key: Vec<u8>,          // index into POI_KEYS
    pub value: Vec<u32>,       // the key's value (into the OSM strings): "cafe", "bakery", ...
    pub lonlat: Vec<[f64; 2]>,
}

/// Extracts every kind from parsed OSM.
pub fn extract(osm: &Osm) -> Extracted {
    let ex = Extractor::new(osm);
    let mut out = Extracted::default();
    out.roads.node_start.push(0);
    for p in [
        &mut out.buildings.shape,
        &mut out.water_areas.shape,
        &mut out.aeroway_areas.shape,
    ] {
        p.poly_start.push(0);
        p.ring_start.push(0);
        p.point_start.push(0);
    }
    out.waterways.point_start.push(0);
    out.aeroway_lines.point_start.push(0);

    for w in 0..osm.ways() {
        ex.road(w, &mut out);
        ex.way_areas(w, &mut out);
        ex.way_lines(w, &mut out);
    }
    for r in 0..osm.relations() {
        ex.relation_areas(r, &mut out);
    }
    ex.pois(&mut out);
    out
}

/// The parsed OSM with its lookups: element ids to indices, tags by name.
struct Extractor<'a> {
    osm: &'a Osm,
    node: HashMap<i64, u32>,
    way: HashMap<i64, u32>,
}

impl<'a> Extractor<'a> {
    fn new(osm: &'a Osm) -> Extractor<'a> {
        Extractor {
            osm,
            node: osm
                .node_id
                .iter()
                .enumerate()
                .map(|(i, &id)| (id, i as u32))
                .collect(),
            way: osm
                .way_id
                .iter()
                .enumerate()
                .map(|(i, &id)| (id, i as u32))
                .collect(),
        }
    }

    /// An element's value for a key, if tagged.
    fn tag(&self, tags: &Tags, e: usize, key: &str) -> Option<&'a str> {
        let k = self.osm.strings.find(key)?;
        tags.get(e, k)
            .map(|v| self.osm.strings.text[v as usize].as_str())
    }

    fn way_nodes(&self, w: usize) -> &'a [i64] {
        &self.osm.way_nodes
            [self.osm.way_node_start[w] as usize..self.osm.way_node_start[w + 1] as usize]
    }

    /// Node ids' coordinates pushed onto `out`; false (with nothing pushed) if any is missing.
    fn coords(&self, ids: &[i64], out: &mut Vec<[f64; 2]>) -> bool {
        if !ids.iter().all(|id| self.node.contains_key(id)) {
            return false;
        }
        out.extend(
            ids.iter()
                .map(|id| self.osm.node_lonlat[self.node[id] as usize]),
        );
        true
    }

    /// A building (or a building part, the bool) and its kind: the tag's value, into the OSM strings.
    fn building_kind(&self, tags: &Tags, e: usize) -> Option<(u32, bool)> {
        let strings = &self.osm.strings;
        let value = |key: &str| {
            strings
                .find(key)
                .and_then(|k| tags.get(e, k))
                .filter(|&v| strings.text[v as usize] != "no")
        };
        value("building")
            .map(|v| (v, false))
            .or_else(|| value("building:part").map(|v| (v, true)))
    }

    // --- roads ------------------------------------------------------------------------------------------------------

    fn road(&self, w: usize, out: &mut Extracted) {
        let t = &self.osm.way_tags;
        let Some(class) = self
            .tag(t, w, "highway")
            .and_then(|h| ROAD_CLASSES.iter().position(|c| *c == h))
        else {
            return;
        };
        if self.tag(t, w, "area") == Some("yes") {
            return;
        }
        let mut ids: Vec<i64> = Vec::new();
        for &id in self.way_nodes(w) {
            if ids.last() != Some(&id) {
                ids.push(id);
            }
        }
        if ids.len() < 2 || !ids.iter().all(|id| self.node.contains_key(id)) {
            out.skipped += 1;
            return;
        }
        let tag = |k: &str| self.tag(t, w, k);
        let dir = oneway_direction(tag("oneway"), ROAD_CLASSES[class], tag("junction"));
        let reversed = dir == -1;
        if reversed {
            ids.reverse();
        }
        // lanes:forward / lanes:backward run with the way's node order: swapped when it's reversed.
        let mut fwd = parse_count(tag(if reversed {
            "lanes:backward"
        } else {
            "lanes:forward"
        }));
        let mut back = parse_count(tag(if reversed {
            "lanes:forward"
        } else {
            "lanes:backward"
        }));
        let total = parse_count(tag("lanes"));
        if dir != 0 {
            fwd = Some(fwd.or(total).unwrap_or(
                if matches!(ROAD_CLASSES[class], "motorway" | "trunk") {
                    2
                } else {
                    1
                },
            ));
            back = Some(0);
        } else {
            if fwd.is_none()
                && back.is_none()
                && let Some(n) = total
            {
                fwd = Some(n.div_ceil(2));
                back = Some(n / 2);
            }
            // A two-way road always has at least one lane each way, even if they share pavement.
            fwd = Some(fwd.unwrap_or(1).max(1));
            back = Some(back.unwrap_or(1).max(1));
        }
        let tagged = parse_maxspeed(tag("maxspeed"));
        let speed = tagged.unwrap_or(DEFAULT_SPEED_MPH[class] * MPH);

        let r = &mut out.roads;
        r.way.push(w as u32);
        r.class.push(class as u8);
        r.oneway.push(dir != 0);
        r.lanes_fwd.push(fwd.unwrap_or(1).min(255) as u8);
        r.lanes_back.push(back.unwrap_or(0).min(255) as u8);
        r.speed.push(speed as f32);
        r.speed_from_tag.push(tagged.is_some());
        r.sidewalks
            .push(sidewalks(&tag, ROAD_CLASSES[class], speed, dir));
        r.structure.push(structure(tag("bridge"), tag("tunnel")));
        self.coords(&ids, &mut r.lonlat);
        r.node_id.extend_from_slice(&ids);
        r.node_start.push(r.node_id.len() as u32);
    }

    // --- areas and lines from ways -------------------------------------------------------------------------------------

    fn way_areas(&self, w: usize, out: &mut Extracted) {
        let t = &self.osm.way_tags;
        let tag = |k: &str| self.tag(t, w, k);
        let nodes = self.way_nodes(w);
        let closed = nodes.len() >= 4 && nodes.first() == nodes.last();
        if let Some((kind, is_part)) = self.building_kind(t, w) {
            if closed && self.ring_feature(&[nodes], &[], &mut out.buildings.shape) {
                self.building(false, w, kind, is_part, &tag, &mut out.buildings);
            } else {
                out.skipped += 1;
            }
        }
        if let Some(kind) = water_area_kind(&tag) {
            if !closed || !self.ring_feature(&[nodes], &[], &mut out.water_areas.shape) {
                out.skipped += 1;
            } else {
                push_area(&mut out.water_areas, false, w, kind);
            }
        }
        let aeroway_kind = if closed {
            aeroway_area_kind(&tag)
        } else {
            None
        };
        if let Some(kind) = aeroway_kind {
            if !self.ring_feature(&[nodes], &[], &mut out.aeroway_areas.shape) {
                out.skipped += 1;
            } else {
                push_area(&mut out.aeroway_areas, false, w, kind);
            }
        } else if tag("aeroway") == Some("apron") {
            out.skipped += 1; // an apron that isn't closed
        }
    }

    fn way_lines(&self, w: usize, out: &mut Extracted) {
        let t = &self.osm.way_tags;
        let tag = |k: &str| self.tag(t, w, k);
        let nodes = self.way_nodes(w);
        let closed = nodes.len() >= 4 && nodes.first() == nodes.last();
        // A waterway, unless the way is a water area (those take precedence in the TS).
        if water_area_kind(&tag).is_none()
            && let Some((kind, default)) =
                tag("waterway").and_then(|k| WATERWAY_WIDTH.iter().find(|(n, _)| *n == k))
            && matches!(tag("tunnel"), None | Some("no"))
            && tag("intermittent") != Some("yes")
        {
            let width = parse_width(tag("width"), 2000.0).unwrap_or(*default);
            let kind = self.osm.strings.find(kind).unwrap_or(0);
            self.line(w, kind, width, nodes, &mut out.waterways, &mut out.skipped);
        }
        let is_area = closed && aeroway_area_kind(&tag).is_some();
        if !is_area
            && tag("area") != Some("yes")
            && let Some(&(_, kind, default)) =
                tag("aeroway").and_then(|a| AEROWAY_LINES.iter().find(|(n, _, _)| *n == a))
        {
            let width = parse_width(tag("width"), 500.0).unwrap_or(default);
            self.line(
                w,
                kind as u32,
                width,
                nodes,
                &mut out.aeroway_lines,
                &mut out.skipped,
            );
        }
    }

    fn line(
        &self,
        w: usize,
        kind: u32,
        width: f64,
        nodes: &[i64],
        lines: &mut Lines,
        skipped: &mut usize,
    ) {
        if nodes.len() < 2 || !self.coords(nodes, &mut lines.lonlat) {
            *skipped += 1;
            return;
        }
        lines.way.push(w as u32);
        lines.kind.push(kind);
        lines.width.push(width as f32);
        lines.point_start.push(lines.lonlat.len() as u32);
    }

    fn building(
        &self,
        relation: bool,
        e: usize,
        kind: u32,
        is_part: bool,
        tag: &impl Fn(&str) -> Option<&'a str>,
        b: &mut Buildings,
    ) {
        let kind_text = &self.osm.strings.text[kind as usize];
        let levels = parse_levels(tag("building:levels"));
        let tagged = parse_height(tag("height").or(tag("building:height")));
        let (mut height, source) = match (tagged, levels) {
            (Some(h), _) => (h, 0),
            (None, Some(l)) if l > 0.0 => (l * LEVEL_HEIGHT, 1),
            _ => (default_height(kind_text), 2),
        };
        let min_level = parse_levels(tag("building:min_level"));
        let mut min_height =
            parse_height(tag("min_height")).unwrap_or(min_level.map_or(0.0, |l| l * LEVEL_HEIGHT));
        // An untagged height above a lifted bottom: stack the estimate on top of it.
        if source != 0 && min_height > 0.0 {
            height += min_height;
        }
        if min_height >= height {
            min_height = 0.0;
        }
        b.relation.push(relation);
        b.element.push(e as u32);
        b.kind.push(kind);
        b.is_part.push(is_part);
        b.height.push(height as f32);
        b.min_height.push(min_height as f32);
        b.height_source.push(source);
        b.levels.push(levels.map_or(f32::NAN, |l| l as f32));
    }

    // --- multipolygon relations ---------------------------------------------------------------------------------------

    fn relation_areas(&self, r: usize, out: &mut Extracted) {
        let t = &self.osm.relation_tags;
        let tag = |k: &str| self.tag(t, r, k);
        if tag("type") != Some("multipolygon") {
            return;
        }
        let members = |role: &str| -> Vec<&'a [i64]> {
            let o = self.osm;
            (o.member_start[r] as usize..o.member_start[r + 1] as usize)
                .filter(|&m| {
                    o.member_type[m] == WAY && o.strings.text[o.member_role[m] as usize] == role
                })
                .filter_map(|m| {
                    self.way
                        .get(&o.member_ref[m])
                        .map(|&w| self.way_nodes(w as usize))
                })
                .collect()
        };
        let building = self.building_kind(t, r);
        let water = water_area_kind(&tag);
        // A multipolygon is an area: a runway or taxiway relation counts.
        let aeroway = match tag("aeroway") {
            Some("apron") => Some(2),
            Some(a) => AEROWAY_LINES
                .iter()
                .find(|(n, _, _)| *n == a)
                .map(|&(_, k, _)| k),
            None => None,
        };
        if building.is_none() && water.is_none() && aeroway.is_none() {
            return;
        }
        let (outers, inners) = (members("outer"), members("inner"));
        if let Some((kind, is_part)) = building {
            if self.ring_feature(&outers, &inners, &mut out.buildings.shape) {
                self.building(true, r, kind, is_part, &tag, &mut out.buildings);
            } else {
                out.skipped += 1;
            }
        }
        if let Some(kind) = water {
            if self.ring_feature(&outers, &inners, &mut out.water_areas.shape) {
                push_area(&mut out.water_areas, true, r, kind);
            } else {
                out.skipped += 1;
            }
        }
        if let Some(kind) = aeroway {
            if self.ring_feature(&outers, &inners, &mut out.aeroway_areas.shape) {
                push_area(&mut out.aeroway_areas, true, r, kind);
            } else {
                out.skipped += 1;
            }
        }
    }

    /// A feature's polygons from outer and inner member ways (joined into rings), pushed onto `p`: false (nothing
    /// pushed) if there's no closed outer ring, or a ring has a missing node.
    fn ring_feature(&self, outers: &[&[i64]], inners: &[&[i64]], p: &mut Polygons) -> bool {
        let outer_rings = assemble_rings(outers);
        let inner_rings = assemble_rings(inners);
        if outer_rings.is_empty() {
            return false;
        }
        let lonlat = |ring: &[i64]| -> Option<Vec<[f64; 2]>> {
            let mut pts = Vec::with_capacity(ring.len());
            self.coords(ring, &mut pts).then_some(pts)
        };
        let Some(outer_pts) = outer_rings
            .iter()
            .map(|r| lonlat(r))
            .collect::<Option<Vec<_>>>()
        else {
            return false;
        };
        let Some(inner_pts) = inner_rings
            .iter()
            .map(|r| lonlat(r))
            .collect::<Option<Vec<_>>>()
        else {
            return false;
        };
        // Each inner ring with the outer holding its first point (none: dropped, as the TS does).
        let mut holes: Vec<Vec<usize>> = vec![Vec::new(); outer_pts.len()];
        for (i, inner) in inner_pts.iter().enumerate() {
            let [x, y] = inner[0];
            if let Some(o) = outer_pts.iter().position(|o| point_in_ring(x, y, o)) {
                holes[o].push(i);
            }
        }
        for (o, outer) in outer_pts.iter().enumerate() {
            for ring in std::iter::once(outer).chain(holes[o].iter().map(|&i| &inner_pts[i])) {
                p.lonlat.extend_from_slice(ring);
                p.point_start.push(p.lonlat.len() as u32);
            }
            p.ring_start.push(p.point_start.len() as u32 - 1);
        }
        p.poly_start.push(p.ring_start.len() as u32 - 1);
        true
    }

    // --- points of interest ----------------------------------------------------------------------------------------

    /// Named (or branded) shops, amenities, ...: nodes where they are, closed ways and multipolygons at their outer
    /// ring's center.
    fn pois(&self, out: &mut Extracted) {
        let o = self.osm;
        let mut push = |kind: u8, e: usize, tags: &Tags, at: Option<[f64; 2]>| {
            if self.tag(tags, e, "name").is_none() && self.tag(tags, e, "brand").is_none() {
                return;
            }
            let Some((key, value)) = POI_KEYS.iter().enumerate().find_map(|(k, key)| {
                o.strings
                    .find(key)
                    .and_then(|ki| tags.get(e, ki))
                    .map(|v| (k, v))
            }) else {
                return;
            };
            let Some(at) = at else { return };
            let p = &mut out.pois;
            p.element_type.push(kind);
            p.element.push(e as u32);
            p.key.push(key as u8);
            p.value.push(value);
            p.lonlat.push(at);
        };
        for n in 0..o.nodes() {
            if o.node_tags.count(n) > 0 {
                push(NODE, n, &o.node_tags, Some(o.node_lonlat[n]));
            }
        }
        for w in 0..o.ways() {
            if o.way_tags.count(w) > 0 {
                let nodes = self.way_nodes(w);
                let closed = nodes.len() >= 4 && nodes.first() == nodes.last();
                push(
                    WAY,
                    w,
                    &o.way_tags,
                    if closed { self.center(&[nodes]) } else { None },
                );
            }
        }
        for r in 0..o.relations() {
            if o.relation_tags.count(r) > 0
                && self.tag(&o.relation_tags, r, "type") == Some("multipolygon")
            {
                let outers: Vec<&[i64]> = (o.member_start[r] as usize
                    ..o.member_start[r + 1] as usize)
                    .filter(|&m| {
                        o.member_type[m] == WAY
                            && o.strings.text[o.member_role[m] as usize] == "outer"
                    })
                    .filter_map(|m| {
                        self.way
                            .get(&o.member_ref[m])
                            .map(|&w| self.way_nodes(w as usize))
                    })
                    .collect();
                push(
                    crate::osm::RELATION,
                    r,
                    &o.relation_tags,
                    self.center(&outers),
                );
            }
        }
    }

    /// The area centroid of the first ring the ways join into, if its nodes are all here.
    fn center(&self, ways: &[&[i64]]) -> Option<[f64; 2]> {
        let rings = assemble_rings(ways);
        let mut pts = Vec::new();
        if !self.coords(rings.first()?, &mut pts) {
            return None;
        }
        let [x0, y0] = pts[0];
        let (mut a, mut cx, mut cy) = (0.0, 0.0, 0.0);
        for w in pts.windows(2) {
            let (ax, ay, bx, by) = (w[0][0] - x0, w[0][1] - y0, w[1][0] - x0, w[1][1] - y0);
            let c = ax * by - bx * ay;
            a += c;
            cx += (ax + bx) * c;
            cy += (ay + by) * c;
        }
        Some(if a == 0.0 {
            [x0, y0]
        } else {
            [x0 + cx / (3.0 * a), y0 + cy / (3.0 * a)]
        })
    }
}

fn push_area(a: &mut Areas, relation: bool, e: usize, kind: u8) {
    a.relation.push(relation);
    a.element.push(e as u32);
    a.kind.push(kind);
}

// --- tag rules ---------------------------------------------------------------------------------------------------------

/// 1: one-way along the node order, −1: against it, 0: two-way.
fn oneway_direction(oneway: Option<&str>, highway: &str, junction: Option<&str>) -> i8 {
    match oneway {
        Some("yes" | "true" | "1") => return 1,
        Some("-1" | "reverse") => return -1,
        Some("no" | "false" | "0" | "reversible" | "alternating") => return 0,
        _ => {}
    }
    // Implied one-way when untagged.
    if matches!(highway, "motorway" | "motorway_link")
        || matches!(junction, Some("roundabout" | "circular"))
    {
        1
    } else {
        0
    }
}

/// Which sides of a road have a sidewalk, from sidewalk=*, sidewalk:left/right/both=* (a separately mapped sidewalk
/// counts), or untagged by class and speed; left and right of the stored node order (reversed for oneway=−1).
fn sidewalks<'a>(tag: &impl Fn(&str) -> Option<&'a str>, class: &str, speed: f64, dir: i8) -> u8 {
    let yes = |v: Option<&str>| v.map(|v| !matches!(v, "no" | "none"));
    let (mut left, mut right) = (None, None);
    if let Some(both) = tag("sidewalk:both").or(tag("sidewalk")) {
        match both {
            "left" => (left, right) = (Some(true), Some(false)),
            "right" => (left, right) = (Some(false), Some(true)),
            other => (left, right) = (yes(Some(other)), yes(Some(other))),
        }
    }
    left = yes(tag("sidewalk:left")).or(left);
    right = yes(tag("sidewalk:right")).or(right);
    if left.is_none() && right.is_none() {
        let town = SIDEWALK_CLASSES.contains(&class)
            && speed <= SIDEWALK_MAX_SPEED + 0.01
            && matches!(tag("tunnel"), None | Some("no" | "building_passage"));
        (left, right) = (Some(town), Some(town));
    }
    let (left, right) = if dir == -1 {
        (right, left)
    } else {
        (left, right)
    };
    (if left == Some(true) { SIDEWALK_LEFT } else { 0 })
        | (if right == Some(true) {
            SIDEWALK_RIGHT
        } else {
            0
        })
}

/// 1 bridge, 2 tunnel (not a building passage: a gap under a building at ground level), else 0.
pub fn structure(bridge: Option<&str>, tunnel: Option<&str>) -> u8 {
    if bridge.is_some_and(|b| b != "no") {
        1
    } else if tunnel.is_some_and(|t| t != "no" && t != "building_passage") {
        2
    } else {
        0
    }
}

fn water_area_kind<'a>(tag: &impl Fn(&str) -> Option<&'a str>) -> Option<u8> {
    if tag("waterway") == Some("riverbank") {
        return Some(1);
    }
    if tag("natural") == Some("water") {
        return Some(if RIVER_WATER.contains(&tag("water").unwrap_or("")) {
            1
        } else {
            0
        });
    }
    matches!(tag("landuse"), Some("reservoir" | "basin")).then_some(0)
}

/// A closed way's airport area kind: aprons, and runways or taxiways mapped as areas (area=yes).
fn aeroway_area_kind<'a>(tag: &impl Fn(&str) -> Option<&'a str>) -> Option<u8> {
    match tag("aeroway")? {
        "apron" => Some(2),
        a if tag("area") == Some("yes") => AEROWAY_LINES
            .iter()
            .find(|(n, _, _)| *n == a)
            .map(|&(_, k, _)| k),
        _ => None,
    }
}

fn default_height(kind: &str) -> f64 {
    if kind == "parking" {
        return PARKING_HEIGHT;
    }
    DEFAULT_HEIGHT
        .iter()
        .find(|(k, _)| *k == kind)
        .map_or(FALLBACK_HEIGHT, |&(_, h)| h)
}

// --- parsing tag values ------------------------------------------------------------------------------------------------

/// OSM maxspeed → m/s; bare numbers are km/h (OSM's convention).
fn parse_maxspeed(v: Option<&str>) -> Option<f64> {
    let v = v?.split(';').next()?.trim();
    let digits = v
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(v.len());
    let n: f64 = v[..digits].parse().ok()?;
    match v[digits..].trim().to_ascii_lowercase().as_str() {
        "mph" => Some(n * MPH),
        "" | "km/h" | "kmh" | "kph" => Some(n * KMH),
        _ => None,
    }
}

/// A positive whole count ("2"), or None.
fn parse_count(v: Option<&str>) -> Option<u32> {
    let v = v?.trim();
    if v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    v.parse().ok().filter(|&n| n > 0)
}

/// "12", "12 m", "12.5m", "40'", "40 ft", "12'6\"" → m; None if unparseable or not positive.
fn parse_height(v: Option<&str>) -> Option<f64> {
    let s = v?.trim().replace(',', ".");
    let number_end = s
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(s.len());
    let n: f64 = s[..number_end].parse().ok()?;
    let rest = s[number_end..].trim();
    let m = match rest.to_ascii_lowercase().as_str() {
        "" | "m" | "meter" | "meters" | "metre" | "metres" => n,
        "ft" | "feet" | "'" => n * 0.3048,
        r if r.starts_with('\'') => {
            // 12'6": feet and inches.
            let inches = r[1..].trim().trim_end_matches('"').trim();
            n * 0.3048 + inches.parse::<f64>().ok()? * 0.0254
        }
        _ => return None,
    };
    (m.is_finite() && m > 0.0).then_some(m)
}

fn parse_levels(v: Option<&str>) -> Option<f64> {
    let n: f64 = v?.trim().replace(',', ".").parse().ok()?;
    (n.is_finite() && n >= 0.0).then_some(n)
}

/// "12" or "12 m" → m, if positive and under `max`.
fn parse_width(v: Option<&str>, max: f64) -> Option<f64> {
    let v = v?.trim();
    let n: f64 = v.strip_suffix('m').unwrap_or(v).trim().parse().ok()?;
    (n.is_finite() && n > 0.0 && n < max).then_some(n)
}

// --- geometry ----------------------------------------------------------------------------------------------------------

/// Joins ways (node id lists) into closed rings by matching ends; ways that never close are dropped.
fn assemble_rings(ways: &[&[i64]]) -> Vec<Vec<i64>> {
    let mut pending: Vec<Vec<i64>> = ways
        .iter()
        .filter(|w| w.len() >= 2)
        .map(|w| w.to_vec())
        .collect();
    let mut rings = Vec::new();
    while let Some(mut ring) = pending.pop() {
        let mut grown = true;
        while ring.first() != ring.last() && grown {
            grown = false;
            let end = *ring.last().unwrap();
            if let Some(i) = pending
                .iter()
                .position(|w| w[0] == end || *w.last().unwrap() == end)
            {
                let w = pending.remove(i);
                if w[0] == end {
                    ring.extend_from_slice(&w[1..]);
                } else {
                    ring.extend(w[..w.len() - 1].iter().rev());
                }
                grown = true;
            }
        }
        if ring.len() >= 4 && ring.first() == ring.last() {
            rings.push(ring);
        }
    }
    rings
}

fn point_in_ring(x: f64, y: f64, ring: &[[f64; 2]]) -> bool {
    let mut inside = false;
    let mut j = ring.len() - 1;
    for i in 0..ring.len() {
        let ([xi, yi], [xj, yj]) = (ring[i], ring[j]);
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}
