# Docs

Design notes for an original open-world driving game on real streets from OpenStreetMap.

Status (2026-11-17): design phase, no code yet.

| Doc | What it covers |
|---|---|
| [architecture.md](architecture.md) | Goals, principles, packages, data flow, what runs where |
| [decisions.md](decisions.md) | Choices made, alternatives rejected, and why |
| [data-model.md](data-model.md) | Columnar tables, coordinates, IDs, linear referencing |
| [osm-pipeline.md](osm-pipeline.md) | OSM → PostGIS → TS import → blobs → IndexedDB |
| [spatial.md](spatial.md) | Partitions, R-trees, grids, BVHs, boundary handling |
| [operators.md](operators.md) | Reconcilers that turn tables into derived artifacts |
| [simulation.md](simulation.md) | `step()`, determinism, sim LOD bubble, vehicles |
| [rendering.md](rendering.md) | Culling, LOD, streaming, instancing |
| [testing.md](testing.md) | Headless CLI, text view, scenarios, replays, fixtures |
| [roadmap.md](roadmap.md) | Milestones, open questions, risks |

Workflow is the top priority: everything except the 3D viewer must run and be testable headless in Node.
