export type { OsmElement, OsmNode, OsmRelation, OsmWay, OverpassResponse, Tags } from "./osm.ts";
export {
  extractRoadWays, isRoad, onewayDirection, parseMaxspeed, roadAttributes,
  type ExtractStats, type RoadWay,
} from "./roads.ts";
