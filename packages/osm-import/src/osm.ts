// Raw OSM data as returned by the Overpass API with [out:json].
// OSM ids exceed 2^32 but stay well below 2^53, so plain numbers are safe.

export type Tags = Record<string, string>;

export interface OsmNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags?: Tags;
}

export interface OsmWay {
  type: "way";
  id: number;
  nodes: number[];
  tags?: Tags;
}

export interface OsmRelation {
  type: "relation";
  id: number;
  members: { type: "node" | "way" | "relation"; ref: number; role: string }[];
  tags?: Tags;
}

export type OsmElement = OsmNode | OsmWay | OsmRelation;

export interface OverpassResponse {
  version: number;
  generator: string;
  osm3s: { timestamp_osm_base: string; copyright: string };
  elements: OsmElement[];
}
