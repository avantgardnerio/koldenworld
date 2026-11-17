// Raw OSM ways → drivable road ways with resolved attributes, and road ways →
// segments split at intersections.
//
// Ways are what Postgres stores (keyed by OSM id). Segments are derived at
// export time: where a way gets split depends on which other ways meet it, so
// splitting needs a partition together with its neighbors.

import type { OsmElement, OsmNode, OsmWay, Tags } from "./osm.ts";

export type RoadClass =
  | "motorway" | "motorway_link"
  | "trunk" | "trunk_link"
  | "primary" | "primary_link"
  | "secondary" | "secondary_link"
  | "tertiary" | "tertiary_link"
  | "unclassified" | "residential" | "living_street" | "service" | "road";

const MPH = 0.44704; // m/s
const KMH = 1 / 3.6; // m/s

// US defaults, used when maxspeed is missing or unparseable.
const DEFAULT_SPEED_MPH: Record<RoadClass, number> = {
  motorway: 65, motorway_link: 35,
  trunk: 55, trunk_link: 35,
  primary: 35, primary_link: 30,
  secondary: 30, secondary_link: 25,
  tertiary: 30, tertiary_link: 25,
  unclassified: 25, residential: 25, living_street: 15, service: 10, road: 25,
};

const ROAD_CLASSES = new Set<string>(Object.keys(DEFAULT_SPEED_MPH));

interface RoadAttributes {
  class: RoadClass;
  name: string | null;
  oneway: boolean;
  lanesFwd: number;
  lanesBack: number;           // 0 when oneway
  speedLimitMps: number;
  speedLimitFromTag: boolean;  // false when DEFAULT_SPEED_MPH was used
  tags: Tags;
}

/** A drivable OSM way. For one-way roads, nodes and points run in the direction of travel. */
export interface RoadWay extends RoadAttributes {
  osmWayId: number;
  nodeIds: number[];
  points: [lon: number, lat: number][];
}

/** A piece of a road way between two graph nodes (way endpoints or intersections). */
export interface RoadSegment extends RoadAttributes {
  osmWayId: number;
  fromNode: number;            // OSM node id
  toNode: number;              // OSM node id
  points: [lon: number, lat: number][];
}

export interface ExtractStats {
  roadWays: number;
  skippedWays: number;         // missing node coordinates or degenerate
}

export function isRoad(tags: Tags | undefined): boolean {
  return tags !== undefined
    && tags.highway !== undefined
    && ROAD_CLASSES.has(tags.highway)
    && tags.area !== "yes";
}

export function extractRoadWays(elements: OsmElement[]): { ways: RoadWay[]; stats: ExtractStats } {
  const nodes = new Map<number, OsmNode>();
  const osmWays: OsmWay[] = [];
  for (const e of elements) {
    if (e.type === "node") nodes.set(e.id, e);
    else if (e.type === "way" && isRoad(e.tags)) osmWays.push(e);
  }

  const ways: RoadWay[] = [];
  let skippedWays = 0;
  for (const w of osmWays) {
    const ids = dedupeConsecutive(w.nodes);
    if (ids.length < 2 || !ids.every((id) => nodes.has(id))) {
      skippedWays++;
      continue;
    }
    const { reversed, ...attrs } = roadAttributes(w.tags!);
    if (reversed) ids.reverse();
    ways.push({
      ...attrs,
      osmWayId: w.id,
      nodeIds: ids,
      points: ids.map((id) => {
        const n = nodes.get(id)!;
        return [n.lon, n.lat];
      }),
    });
  }
  return { ways, stats: { roadWays: osmWays.length, skippedWays } };
}

/** Splits ways wherever they share a node with another way (or themselves). */
export function splitRoadWays(ways: RoadWay[]): RoadSegment[] {
  const uses = new Map<number, number>();
  for (const w of ways) {
    for (const id of w.nodeIds) uses.set(id, (uses.get(id) ?? 0) + 1);
  }

  const segments: RoadSegment[] = [];
  for (const { nodeIds, points, osmWayId, ...attrs } of ways) {
    let start = 0;
    for (let i = 1; i < nodeIds.length; i++) {
      if (i === nodeIds.length - 1 || (uses.get(nodeIds[i]!) ?? 0) > 1) {
        segments.push({
          ...attrs,
          osmWayId,
          fromNode: nodeIds[start]!,
          toNode: nodeIds[i]!,
          points: points.slice(start, i + 1),
        });
        start = i;
      }
    }
  }
  return segments;
}

export function roadAttributes(tags: Tags): RoadAttributes & { reversed: boolean } {
  const cls = tags.highway as RoadClass;
  const dir = onewayDirection(tags);
  const oneway = dir !== 0;
  const reversed = dir === -1;   // oneway=-1: travel runs against the way's node order

  // lanes:forward / lanes:backward are relative to the way's node order; flip them if we reverse it.
  let fwd = parseCount(tags[reversed ? "lanes:backward" : "lanes:forward"]);
  let back = parseCount(tags[reversed ? "lanes:forward" : "lanes:backward"]);
  const total = parseCount(tags.lanes);
  if (oneway) {
    fwd ??= total ?? (cls === "motorway" || cls === "trunk" ? 2 : 1);
    back = 0;
  } else {
    if (fwd === undefined && back === undefined && total !== undefined) {
      fwd = Math.ceil(total / 2);
      back = Math.floor(total / 2);
    }
    // A two-way road always has at least one lane each way, even if they share pavement.
    fwd = Math.max(1, fwd ?? 1);
    back = Math.max(1, back ?? 1);
  }

  const tagged = parseMaxspeed(tags.maxspeed);
  return {
    class: cls,
    name: tags.name ?? tags.ref ?? null,
    oneway,
    reversed,
    lanesFwd: fwd,
    lanesBack: back,
    speedLimitMps: tagged ?? DEFAULT_SPEED_MPH[cls] * MPH,
    speedLimitFromTag: tagged !== undefined,
    tags,
  };
}

/** 1 = one-way along node order, -1 = one-way against it, 0 = two-way. */
export function onewayDirection(tags: Tags): 1 | -1 | 0 {
  switch (tags.oneway) {
    case "yes": case "true": case "1": return 1;
    case "-1": case "reverse": return -1;
    case "no": case "false": case "0": case "reversible": case "alternating": return 0;
  }
  // Implied one-way when untagged.
  if (tags.highway === "motorway" || tags.highway === "motorway_link") return 1;
  if (tags.junction === "roundabout" || tags.junction === "circular") return 1;
  return 0;
}

/** OSM maxspeed → m/s. Bare numbers are km/h per OSM convention. */
export function parseMaxspeed(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?\s*$/i.exec(value.split(";")[0]!);
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2]?.toLowerCase() === "mph" ? n * MPH : n * KMH;
}

function parseCount(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  const n = Number(value);
  return n > 0 ? n : undefined;
}

function dedupeConsecutive(ids: number[]): number[] {
  return ids.filter((id, i) => i === 0 || id !== ids[i - 1]);
}
