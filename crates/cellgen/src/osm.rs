//! Raw OSM data (as the Overpass API returns it with [out:json]) as columns: nodes, ways and relations each a set of
//! columns, their tags as (key, value) pairs of indices into one string table, ways' node lists and relations' member
//! lists CSR. Parsed straight into the columns by a streaming visitor: no struct per element.

use serde::de::{self, DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use std::collections::HashMap;
use std::fmt;

/// What a relation member is.
pub const NODE: u8 = 0;
pub const WAY: u8 = 1;
pub const RELATION: u8 = 2;

/// OSM elements as columns.
#[derive(Default)]
pub struct Osm {
    pub node_id: Vec<i64>,
    pub node_lonlat: Vec<[f64; 2]>,
    pub node_tags: Tags,
    pub way_id: Vec<i64>,
    pub way_node_start: Vec<u32>, // ways + 1 offsets into way_nodes (CSR)
    pub way_nodes: Vec<i64>,      // node ids
    pub way_tags: Tags,
    pub relation_id: Vec<i64>,
    pub member_start: Vec<u32>, // relations + 1 offsets into the member columns (CSR)
    pub member_type: Vec<u8>,   // NODE, WAY, RELATION
    pub member_ref: Vec<i64>,
    pub member_role: Vec<u32>, // index into strings
    pub relation_tags: Tags,
    pub strings: Strings,
    pub timestamp: Option<String>, // osm3s.timestamp_osm_base: the data's age
}

/// One kind of element's tags: element e's are pairs start[e]..start[e + 1] (CSR), each (key, value) into strings.
#[derive(Default)]
pub struct Tags {
    pub start: Vec<u32>,
    pub pairs: Vec<[u32; 2]>,
}

/// Every key, value and role, once each.
#[derive(Default)]
pub struct Strings {
    pub text: Vec<String>,
    index: HashMap<String, u32>,
}

impl Strings {
    pub fn intern(&mut self, s: &str) -> u32 {
        if let Some(&i) = self.index.get(s) {
            return i;
        }
        self.text.push(s.to_string());
        self.index.insert(s.to_string(), self.text.len() as u32 - 1);
        self.text.len() as u32 - 1
    }

    /// A string's index, if it's there.
    pub fn find(&self, s: &str) -> Option<u32> {
        self.index.get(s).copied()
    }
}

impl Tags {
    /// Element e's value for a key (by index), if it has one.
    pub fn get(&self, e: usize, key: u32) -> Option<u32> {
        self.pairs[self.start[e] as usize..self.start[e + 1] as usize]
            .iter()
            .find(|p| p[0] == key)
            .map(|p| p[1])
    }

    pub fn count(&self, e: usize) -> usize {
        (self.start[e + 1] - self.start[e]) as usize
    }
}

/// Parses an Overpass [out:json] response.
pub fn parse(json: &[u8]) -> Result<Osm, serde_json::Error> {
    let mut osm = Osm {
        way_node_start: vec![0],
        member_start: vec![0],
        ..Default::default()
    };
    osm.node_tags.start.push(0);
    osm.way_tags.start.push(0);
    osm.relation_tags.start.push(0);
    let mut de = serde_json::Deserializer::from_slice(json);
    Response(&mut osm).deserialize(&mut de)?;
    de.end()?;
    Ok(osm)
}

impl Osm {
    pub fn nodes(&self) -> usize {
        self.node_id.len()
    }

    pub fn ways(&self) -> usize {
        self.way_id.len()
    }

    pub fn relations(&self) -> usize {
        self.relation_id.len()
    }
}

// --- the streaming parser: each level a seed pushing into the columns ------------------------------------------------

/// The response: { "osm3s": { "timestamp_osm_base": … }, "elements": [ … ], … }.
struct Response<'a>(&'a mut Osm);

impl<'de> DeserializeSeed<'de> for Response<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for Response<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an Overpass JSON response")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        while let Some(key) = map.next_key::<&str>()? {
            match key {
                "elements" => map.next_value_seed(Elements(self.0))?,
                "osm3s" => {
                    let meta: HashMap<String, serde_json::Value> = map.next_value()?;
                    self.0.timestamp = meta
                        .get("timestamp_osm_base")
                        .and_then(|t| t.as_str())
                        .map(String::from);
                }
                "remark" => {
                    let remark: String = map.next_value()?;
                    return Err(de::Error::custom(format!(
                        "Overpass remark (a timeout or error): {remark}"
                    )));
                }
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(())
    }
}

struct Elements<'a>(&'a mut Osm);

impl<'de> DeserializeSeed<'de> for Elements<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for Elements<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an array of OSM elements")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        let mut scratch = Scratch::default();
        while seq
            .next_element_seed(Element(self.0, &mut scratch))?
            .is_some()
        {}
        Ok(())
    }
}

/// An element's parts as they're read (keys can come in any order), reused for every element.
#[derive(Default)]
struct Scratch {
    tags: Vec<[u32; 2]>,
    nodes: Vec<i64>,
    members: Vec<(u8, i64, u32)>,
}

struct Element<'a, 'b>(&'a mut Osm, &'b mut Scratch);

impl<'de> DeserializeSeed<'de> for Element<'_, '_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for Element<'_, '_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an OSM element")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let (osm, s) = (self.0, self.1);
        s.tags.clear();
        s.nodes.clear();
        s.members.clear();
        let (mut kind, mut id, mut lat, mut lon) = (None::<u8>, 0i64, f64::NAN, f64::NAN);
        while let Some(key) = map.next_key::<&str>()? {
            match key {
                "type" => {
                    kind = Some(match map.next_value::<&str>()? {
                        "node" => NODE,
                        "way" => WAY,
                        "relation" => RELATION,
                        other => {
                            return Err(de::Error::custom(format!("unknown element type {other}")));
                        }
                    })
                }
                "id" => id = map.next_value()?,
                "lat" => lat = map.next_value()?,
                "lon" => lon = map.next_value()?,
                "tags" => map.next_value_seed(TagMap(&mut osm.strings, &mut s.tags))?,
                "nodes" => map.next_value_seed(NodeList(&mut s.nodes))?,
                "members" => map.next_value_seed(MemberList(&mut osm.strings, &mut s.members))?,
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        let tags = match kind.ok_or_else(|| de::Error::missing_field("type"))? {
            NODE => {
                osm.node_id.push(id);
                osm.node_lonlat.push([lon, lat]);
                &mut osm.node_tags
            }
            WAY => {
                osm.way_id.push(id);
                osm.way_nodes.extend_from_slice(&s.nodes);
                osm.way_node_start.push(osm.way_nodes.len() as u32);
                &mut osm.way_tags
            }
            _ => {
                osm.relation_id.push(id);
                for &(t, r, role) in &s.members {
                    osm.member_type.push(t);
                    osm.member_ref.push(r);
                    osm.member_role.push(role);
                }
                osm.member_start.push(osm.member_type.len() as u32);
                &mut osm.relation_tags
            }
        };
        tags.pairs.extend_from_slice(&s.tags);
        tags.start.push(tags.pairs.len() as u32);
        Ok(())
    }
}

struct TagMap<'a, 'b>(&'a mut Strings, &'b mut Vec<[u32; 2]>);

impl<'de> DeserializeSeed<'de> for TagMap<'_, '_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for TagMap<'_, '_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a map of tags")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        // Owned strings: a tag may contain escapes, which a borrowed &str can't hold.
        while let Some((k, v)) = map.next_entry::<String, String>()? {
            let pair = [self.0.intern(&k), self.0.intern(&v)];
            self.1.push(pair);
        }
        Ok(())
    }
}

struct NodeList<'a>(&'a mut Vec<i64>);

impl<'de> DeserializeSeed<'de> for NodeList<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for NodeList<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a list of node ids")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while let Some(n) = seq.next_element::<i64>()? {
            self.0.push(n);
        }
        Ok(())
    }
}

struct MemberList<'a, 'b>(&'a mut Strings, &'b mut Vec<(u8, i64, u32)>);

impl<'de> DeserializeSeed<'de> for MemberList<'_, '_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for MemberList<'_, '_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a list of relation members")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        #[derive(serde::Deserialize)]
        struct Member {
            #[serde(rename = "type")]
            kind: String,
            #[serde(rename = "ref")]
            reference: i64,
            role: String,
        }
        while let Some(m) = seq.next_element::<Member>()? {
            let kind = match m.kind.as_str() {
                "node" => NODE,
                "way" => WAY,
                _ => RELATION,
            };
            let role = self.0.intern(&m.role);
            self.1.push((kind, m.reference, role));
        }
        Ok(())
    }
}
