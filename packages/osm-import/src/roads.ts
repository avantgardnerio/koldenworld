// Raw OSM ways → drivable road ways with resolved attributes.
//
// Ways are what Postgres stores, whole and keyed by OSM id. Cutting them into
// graph edges at intersections happens at export (@game/world buildRoadGraph):
// where a way gets cut depends on which other ways meet it.

import { ROAD_CLASSES, type RoadClass } from "@game/world";
import type { OsmElement, OsmNode, OsmWay, Tags } from "./osm.ts";

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

const ROAD_CLASS_SET = new Set<string>(ROAD_CLASSES);

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

export interface ExtractStats {
  roadWays: number;
  skippedWays: number;         // missing node coordinates or degenerate
}

export function isRoad(tags: Tags | undefined): boolean {
  return tags !== undefined
    && tags.highway !== undefined
    && ROAD_CLASS_SET.has(tags.highway)
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

/** Sidewalk bits (decision 33): which sides of a stored road way have one, looking along its stored node order. */
export const SIDEWALK_LEFT = 1, SIDEWALK_RIGHT = 2;

/** Town streets: where untagged roads get sidewalks on both sides (at most 40 mph). */
const SIDEWALK_CLASSES = new Set(["primary", "secondary", "tertiary", "unclassified", "residential", "living_street"]);
const SIDEWALK_MAX_SPEED = 40 * 0.44704;

/**
 * Which sides of a road have a sidewalk, from sidewalk=*, sidewalk:left/right/both=*
 * (a separately mapped sidewalk counts: it's drawn at the curb), or, untagged,
 * by class and speed limit. Left and right are relative to the stored node
 * order, which runs against the way for oneway=-1.
 */
export function roadSidewalks(tags: Tags, speedLimitMps: number): number {
  const yes = (v: string | undefined) => v === undefined ? undefined : !["no", "none"].includes(v);
  let left: boolean | undefined, right: boolean | undefined;
  const both = tags["sidewalk:both"] ?? tags.sidewalk;
  if (both !== undefined) {
    if (both === "left") [left, right] = [true, false];
    else if (both === "right") [left, right] = [false, true];
    else left = right = yes(both);
  }
  left = yes(tags["sidewalk:left"]) ?? left;
  right = yes(tags["sidewalk:right"]) ?? right;
  if (left === undefined && right === undefined) {
    const town = SIDEWALK_CLASSES.has(tags.highway ?? "") && speedLimitMps <= SIDEWALK_MAX_SPEED + 0.01
      && (tags.tunnel === undefined || tags.tunnel === "no" || tags.tunnel === "building_passage");
    left = right = town;
  }
  if (onewayDirection(tags) === -1) [left, right] = [right, left];
  return (left ? SIDEWALK_LEFT : 0) | (right ? SIDEWALK_RIGHT : 0);
}

/** Bridges and tunnels run straight between their ends instead of following the ground (decision 29). */
export function roadStructure(tags: Tags): "bridge" | "tunnel" | null {
  if (tags.bridge !== undefined && tags.bridge !== "no") return "bridge";
  // A building passage is a short gap under a building at ground level, not a tunnel through ground.
  if (tags.tunnel !== undefined && tags.tunnel !== "no" && tags.tunnel !== "building_passage") return "tunnel";
  return null;
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
