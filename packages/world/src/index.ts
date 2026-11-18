export { localProjection, type LatLon } from "./projection.ts";
export {
  buildRoadGraph, componentSizes, ROAD_CLASSES, ROAD_GRAPH_VERSION,
  type RoadClass, type RoadEdges, type RoadGraph, type RoadNodes, type RoadWayInput,
} from "./road-graph.ts";
export { roadGraphFromArrow, roadGraphToArrow, type GraphMetadata, type RoadGraphFiles } from "./road-graph-arrow.ts";
export { roadLineMesh, type Bounds, type RoadLineMesh } from "./road-lines.ts";
export {
  edgeHalfWidth, MARKING, nodeRadii, ROAD_PROFILES, roadSurfaceMesh, SurfaceMaterial, type SurfaceMesh,
} from "./road-surface.ts";
export {
  BUILDING_GROUPS, BUILDINGS_VERSION, buildBuildings, buildingGroup, HEIGHT_SOURCES, OSM_TYPES, signedArea2,
  type BuildingGroup, type BuildingInput, type Buildings, type HeightSource, type OsmType,
} from "./buildings.ts";
export { buildingsFromArrow, buildingsToArrow } from "./buildings-arrow.ts";
export { BUILDING_MATERIALS, buildingMesh, idShade, type BuildingMesh } from "./building-mesh.ts";
export type { FileMetadata } from "./arrow-util.ts";
