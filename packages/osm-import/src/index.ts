export type { OsmElement, OsmNode, OsmRelation, OsmWay, OverpassResponse, Tags } from "./osm.ts";
export {
  extractRoadWays, isRoad, onewayDirection, parseMaxspeed, roadAttributes, splitRoadWays,
  type ExtractStats, type RoadClass, type RoadSegment, type RoadWay,
} from "./roads.ts";
