# Headless workflow and testing

Everything except `viewer` runs in Node with the same code as the browser. Claude and the test suite work entirely through the CLI and tests; no browser is needed.

## CLI (sketch)

```sh
cli import --zip 80202 --size 2km     # fetch, import and cache an area
cli run scenarios/straight-line.json  # run a scenario, print pass/fail and diffs
cli replay recordings/crash.jsonl     # replay a recorded input log
cli view --at 1200,-340 --radius 150  # print the text view
cli repl                              # JSON-lines on stdin/stdout
```

## JSON-lines protocol

One JSON object per line in each direction. The process holds the world in memory.

```jsonl
{"cmd":"load","map":"sha256:ab12..."}
{"cmd":"input","inputs":[{"kind":"throttle","value":1}]}
{"cmd":"step","ticks":60}
{"cmd":"query","what":"player"}
{"cmd":"view","radius":100}
{"cmd":"snapshot"}
```

## Text view

A top-down character grid centered on the player. This is the main way Claude "sees" the game.

```
  . . . # # # . . . . . = = = = = = = = = = = = =
  . . . # # # . . . . . | . . . . . . . . . . . .
  = = = = = = = = = = = + = = = = > = = = = = = =
  . . . . . . . . . . . | . . . . . . . . . . . .
  . # # . . @ . . . . . | . . # # # # . . . . . .
```

Legend (draft): `=`/`|` roads, `+` intersections, `#` buildings, `~` water, `"` parks, `@` player, `>` `<` `^` `v` other cars by heading.

## Test types

| Type | What it checks |
|---|---|
| Scenario | initial state + input script + assertions, e.g. "after 300 ticks of throttle, the player is on edge 412 heading north" |
| Replay | a recorded input log reproduces the same final state hash. Any bug found while playing becomes a replay test. |
| Determinism | every scenario run twice gives identical state hashes |
| Operator golden | an operator on a fixture partition produces the expected output hash |
| Allocation | a long run keeps heap usage flat |
| Import | a fixture OSM extract imports to the expected tables |

## Scenario format (draft)

```json
{
  "map": "fixtures/downtown-grid",
  "seed": 1,
  "setup": { "player": { "edge": 412, "t": 0, "inVehicle": true } },
  "script": [
    { "at": 0, "inputs": [{ "kind": "throttle", "value": 1 }] },
    { "at": 300, "inputs": [{ "kind": "throttle", "value": 0 }] }
  ],
  "expect": [
    { "at": 300, "player.edge": 412, "player.speed": { "gt": 10 } }
  ]
}
```

## Fixtures

Small committed map blobs so tests never touch the network or Postgres:

- a downtown grid
- a highway interchange
- a sparse suburb (few or no buildings)

Fixtures are regenerated only on purpose, when the import code or schema changes.
