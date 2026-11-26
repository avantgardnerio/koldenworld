//! Points of interest, the input: named (or branded) shops, amenities, offices, ... as points, each with how much it
//! draws people with nowhere to live, as the TS loadPois (packages/db/src/export.ts) returns them: in the box, ordered
//! by OSM type (as text: node, relation, way) and id.

use crate::extract::{Extracted, POI_KEYS};
use crate::osm::{NODE, Osm, RELATION, WAY};
use std::collections::HashMap;

/// Points of interest as columns; strings (kinds, names, brands) once each in `strings`.
#[derive(Default, PartialEq)]
pub struct PoiInputs {
    pub osm_type: Vec<u8>,      // osm::NODE, WAY or RELATION
    pub osm_id: Vec<i64>,       //
    pub category: Vec<u8>,      // index into POI_KEYS
    pub kind: Vec<u32>,         // index into strings: "cafe", "bakery", ...
    pub name: Vec<Option<u32>>, // index into strings
    pub brand: Vec<Option<u32>>,
    pub lonlat: Vec<[f64; 2]>,
    pub charity: Vec<f32>, // charity_weight
    pub strings: Vec<String>,
}

/// Social facilities by what they do (social_facility=*): how much each draws people with nowhere to live.
const SOCIAL_FACILITY: [(&str, f32); 11] = [
    ("shelter", 4.0),
    ("soup_kitchen", 3.0),
    ("food_bank", 3.0),
    ("outreach", 2.0),
    ("healthcare", 1.0),
    ("community_centre", 1.0),
    // Homes for the old or the young, not drop-in services.
    ("group_home", 0.0),
    ("nursing_home", 0.0),
    ("assisted_living", 0.0),
    ("retirement_home", 0.0),
    ("childrens_centre", 0.0),
];

/// Names (or operators, or brands) of the services people with nowhere to live go to, lowercase, as the TS
/// CHARITY_NAMES (its "st\.?" spelled both ways).
const CHARITY_NAMES: [&str; 29] = [
    "rescue mission",
    "gospel mission",
    "salvation army",
    "catholic charities",
    "catholic community services",
    "volunteers of america",
    "united way",
    "coalition for the homeless",
    "st vincent de paul",
    "st. vincent de paul",
    "covenant house",
    "samaritan house",
    "st francis center",
    "st. francis center",
    "urban peak",
    "mile high ministries",
    "mary's place",
    "downtown emergency service",
    "plymouth housing",
    "operation sack lunch",
    "front steps",
    "mobile loaves",
    "community first! village",
    "lifeworks",
    "soup kitchen",
    "food bank",
    "homeless",
    "day shelter",
    "drop-in center",
];

/// Kinds a charity's name doesn't make a draw: its schools and day cares.
const NOT_SERVICES: [&str; 3] = ["childcare", "kindergarten", "school"];

impl PoiInputs {
    /// The points of interest of OSM loaded for a box (local::load_box) and extracted: those in the box (edges
    /// included), ordered by OSM type (as text, as Postgres did) and id.
    pub fn from_extracted(
        osm: &Osm,
        x: &Extracted,
        [west, south, east, north]: [f64; 4],
    ) -> PoiInputs {
        let x = &x.pois;
        // Postgres orders the types as text: node, relation, way.
        let rank = |t: u8| match t {
            NODE => 0,
            RELATION => 1,
            _ => 2,
        };
        let element = |i: usize| {
            let e = x.element[i] as usize;
            match x.element_type[i] {
                NODE => (osm.node_id[e], &osm.node_tags),
                WAY => (osm.way_id[e], &osm.way_tags),
                _ => (osm.relation_id[e], &osm.relation_tags),
            }
        };
        let mut order: Vec<usize> = (0..x.key.len())
            .filter(|&i| {
                let [lon, lat] = x.lonlat[i];
                (west..=east).contains(&lon) && (south..=north).contains(&lat)
            })
            .collect();
        order.sort_by_key(|&i| (rank(x.element_type[i]), element(i).0));
        let mut p = PoiInputs::default();
        let mut index = HashMap::new();
        for i in order {
            let (id, tags) = element(i);
            let e = x.element[i] as usize;
            let tag = |key: &str| {
                let k = osm.strings.find(key)?;
                tags.get(e, k)
                    .map(|v| osm.strings.text[v as usize].as_str())
            };
            let category = POI_KEYS[x.key[i] as usize];
            let kind = osm.strings.text[x.value[i] as usize].as_str();
            p.push(
                &mut index,
                (x.element_type[i], id),
                x.key[i],
                [Some(kind), tag("name"), tag("brand")],
                x.lonlat[i],
                charity_weight(category, kind, tag),
            );
        }
        p
    }

    fn push(
        &mut self,
        index: &mut HashMap<String, u32>,
        (osm_type, osm_id): (u8, i64),
        category: u8,
        [kind, name, brand]: [Option<&str>; 3],
        lonlat: [f64; 2],
        charity: f32,
    ) {
        let mut string = |s: Option<&str>| {
            s.map(|s| {
                *index.entry(s.to_string()).or_insert_with(|| {
                    self.strings.push(s.to_string());
                    (self.strings.len() - 1) as u32
                })
            })
        };
        let (kind, name, brand) = (string(kind).unwrap(), string(name), string(brand));
        self.osm_type.push(osm_type);
        self.osm_id.push(osm_id);
        self.category.push(category);
        self.kind.push(kind);
        self.name.push(name);
        self.brand.push(brand);
        self.lonlat.push(lonlat);
        self.charity.push(charity);
    }

    /// Point i's text by string index, for comparing two loads (whose strings are numbered differently).
    pub fn text(&self, s: Option<u32>) -> Option<&str> {
        s.map(|s| self.strings[s as usize].as_str())
    }
}

/// How much a place draws people with nowhere to live, from its OSM tags (0: not at all): a shelter 4, a soup kitchen
/// or food bank 3, outreach 2, a charity's office 1, a thrift store 0.5; anything run by (or named for) a known service
/// at least 2. As the TS charityWeight (packages/world/src/pois.ts).
pub fn charity_weight<'a>(
    category: &str,
    kind: &str,
    tag: impl Fn(&str) -> Option<&'a str>,
) -> f32 {
    let mut w = 0.0;
    if category == "amenity" && kind == "social_facility" {
        let for_whom = tag("social_facility:for").unwrap_or("");
        w = tag("social_facility")
            .and_then(|what| SOCIAL_FACILITY.iter().find(|(k, _)| *k == what))
            .map_or(1.0, |&(_, w)| w);
        if for_whom.contains("homeless") {
            w = f32::max(w, 3.0);
        } else if ["senior", "child", "juvenile", "youth"]
            .iter()
            .any(|s| for_whom.contains(s))
        {
            w = f32::min(w, 1.0);
        }
    } else if category == "amenity" && (kind == "food_bank" || kind == "soup_kitchen") {
        w = 3.0;
    } else if category == "office" && (kind == "charity" || kind == "ngo") {
        w = 1.0;
    } else if category == "shop" && kind == "charity" {
        w = 0.5;
    }
    let text = [tag("name"), tag("brand"), tag("operator")]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if CHARITY_NAMES.iter().any(|n| text.contains(n)) && !NOT_SERVICES.contains(&kind) {
        w = f32::max(w, 2.0);
    }
    if text.contains("ronald mcdonald house") {
        0.0
    } else {
        w
    }
}
