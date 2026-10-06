# Sub-project 3d: Multi-layer water Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Water in several layers per column: tunnels, caves, holes under a solid top, water under bridges and on roofs. Full tunnels carry pressure (communicating vessels). All of 3c's look and behaviour is kept on single-layer ground.

**Architecture:**
- **3c's column is the top segment.** `WaterColumns` (floor, depth, the dense flux of the edge between two top segments) is unchanged. A world with no lower segment steps exactly as in 3c, proved by a differential test against a frozen copy of 3c's step.
- **Lower segments** (`sim/water/under.ts`) live in a pool: every run of air or water cells between walls below a column's top segment.
- **Under edges** (`sim/water/edges.ts`) join every pair of overlapping segments of neighbouring columns other than two top segments. They are stored per tile.
- `WaterColumns.step` runs them alongside the dense edges: acceleration, outflow and inflow limits, transfer, the quiet test.
- **Pressurized bodies** (`sim/water/bodies.ts`) are connected full lower segments. A body's level H comes from an integer bisection (net inflow zero). Water entering one opening leaves through the others in the same step.
- **Edits** (`sim/water/resegment.ts`) re-derive a column's runs from its cells and carry the volumes over. 3c's displaced-water spread is kept for the top segment.
- **Rendering:**
  - Draw layer r of a column is its r-th segment from the top (0–3).
  - Layer 0 is published as in 3c, in shared memory.
  - Layers 1–3, and the links that say which neighbour slot a slot's water meets, travel as records in the tick message (`sim/water/links.ts`).
  - The main thread keeps them in a `LayerStore`.
  - `SurfaceView` refreshes tiles with layers through a per-slot path that resolves each neighbour through the links. Tiles without layers keep 3c's fast path, and a differential test proves the two paths agree.
- Static water and its voxel mesher path are gone: every water voxel is simulated.

**Tech Stack:** TypeScript (strict, `erasableSyntaxOnly`), three.js 0.186.1 WebGPU/TSL, Vite, Vitest 4, Playwright, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-05-water-layers-design.md`. Context: 3c spec `docs/superpowers/specs/2026-10-04-water-heightfield-design.md`, 3c plan `docs/superpowers/plans/2026-10-04-water-heightfield.md` (its design notes explain the step, tiles, the sea, the mirror, publishing and rendering this plan extends).

## Global Constraints

- Work happens on branch `feat/water-layers` (already created from `main` at `2c4817d`; the spec is commit `b98e19c`).
- World state is integers only. The water code uses no `Math.random`, `Date` or `performance.now`, and no floats in stored state.
- Iteration orders are fixed and never depend on pool slot numbers:
  - tiles in index order from the round-robin cursor;
  - columns row-major inside a tile;
  - a column's segments bottom-up (its under chain, then the top);
  - a tile's under edges in the order `buildTileEdges` emits them;
  - bodies in the position order of their first member.
- Units are 3c's:
  - `SUB = 256`;
  - surface `S = floor × SUB + depth`;
  - flux carries `FLUX_FP = 4` extra bits.
- Every 3c constant keeps its value (`GAIN` 3, `THROTTLED_GAIN` 2, `FRICTION_SHIFT` 4, `MAX_HEAD` 2 × SUB, `MIN_FLOW` 4, `TILE` 16, `SLEEP_STEPS` 10, `FLUX_EPS` 3, `DEPTH_EPS` 8, `HEAD_EPS` 6, `SLOPE_SHIFT` 4). New constants:

  | Constant | Value | Meaning |
  |---|---|---|
  | `LEAVE` | `SUB / 8` | a body member leaves when its deficit exceeds this |
  | `RANKS` | 4 | draw layers per column (segments counted from the top) |
  | `BISECT_ROUNDS` | 32 | guard on the bisection loop (the range halves each round) |
- A **wall** is any block that is neither air nor the simulated water (3c planning decision 1).
- `erasableSyntaxOnly`: no constructor parameter properties, no enums, no namespaces.
- Budgets (spec §7):
  - sim tick ≤ 10 ms p95 and ≥ 45 fps during the dam break on the laptop;
  - `bench:dam` within **1.2×** of 3c's time;
  - still water and sealed bodies cost nothing per tick.
- Repo artifacts are in English.
- Commits use conventional English messages and **no** `Co-Authored-By` trailer: `.claude/settings.json` sets no `attribution.commit`.
- Commands:

  | What | Command |
  |---|---|
  | Engine tests | `cd packages/engine && npx vitest run test/<file>` |
  | Every test | `npm test` at the repo root |
  | Types | `npm run typecheck` at the repo root |
  | E2E | `cd apps/sandbox && E2E_PORT=5174 npx playwright test <spec> --workers=1` (stop anything on 5174 first) |
  | Dam bench | `cd apps/sandbox && npm run bench:dam` (`npm run bench:dam settle` for the full settle) |

## Review Focus

The spec implies these inputs, but no task's own tests would exercise them unless pinned here. Each one has a test in the task named.

1. **Blocks placed in sequence by one `fillRegion` into deep water** (a slab mid-lake, built bottom-up by the command).
   - The first layer splits the top segment and traps water below it; the next layers raise the new floor.
   - Volume stays exact, and the trapped water becomes a full lower segment (a body), not lost and not pushed up.
   - *Test in Task 7.*
2. **A body whose boundary edges sit in sleeping tiles**, woken from the other side of a hill (dig the tunnel's far end while the lake sleeps).
   - The body steps as soon as one boundary tile is awake.
   - The water it moves wakes the tile at the other end.
   - *Test in Task 6.*
3. **Under edges across tile and chunk borders**, with one tile stepping and the other asleep.
   - Water crossing into the sleeping tile reaches it (wake or trickle), exactly as 3c's dense border edges do.
   - *Test in Task 5.*
4. **A wet segment ranked below 3** (four stacked caves).
   - It is simulated and mirrored but not drawn, and counted in `waterLayersHidden`.
   - It never throws, and never draws garbage in layer 3.
   - *Test in Task 9.*
5. **A slot that dries out or appears between two publishes** (a lake draining from under a bridge, a cave pool appearing).
   - It sinks to its floor and then disappears, or rises from its floor.
   - It never pops, and never leaves a stale quad when its tile loses its last layer record.
   - *Test in Task 10.*

---

## Planning decisions (resolving the spec)

Each one was found while reading the code or the spec, and is accepted here. The spec stays the source for everything else.

1. **The top segment is 3c's column.**
   - `WaterColumns.floor/depth` and the dense flux (`flux[2c]`, `flux[2c + 1]`) are the top segment and the edge between two top segments.
   - Lower segments are a separate pool. A segment is named by one number, its **ref**: a column `c` (0 ≤ c < n) for a top segment, `n + i` for lower segment `i`.
   - This keeps every tuned 3c path (falls, plunge, the sea pin, the slope test, publishing layer 0) unchanged.
2. **Bodies hold lower segments only.** A top segment reaches the world's top and is never full (its capacity is never reached in practice), so it never joins a body.
3. **Draw layer = segment rank from the top**, at most 4 (`RANKS`).
   - The spec says "layer 0 is the highest *wet* segment". Ranking all segments instead keeps a slot stable from step to step: a puddle forming on a bridge deck would otherwise move the river below it from layer 0 to layer 1, mid-interpolation.
   - Layer 0 is the top segment, wet or dry.
4. **Layers 1–3 and the links travel in the tick message** (`WaterTick.layers`, an `Int32Array` of records), not in shared memory.
   - Each published tile carries the complete records of its slots, so a late tick never shows torn data.
   - Layer 0 stays in 3c's shared double buffer.
   - Shared memory sized for 4 dense layers would cost ~64 MB at 1024².
5. **Lower edges never throw.**
   - Only an edge between two top segments carries a fall code (3c).
   - Water crossing an under edge moves straight into its receiver, and its curtain is drawn straight (reach 0).
   - The spec's "the arc stays under the receiving segment's ceiling" is met by never arcing under a ceiling.
   - A roof hole is a top segment (open to the sky), so the lake pouring into it is a 3c fall: its clear columns stop at the roof, so it lands in the hole.
6. **The quiet test for lower segments is local.** A tile with under edges is also live when one of them moved `FLUX_EPS` or more, when connected water across one of them differs by more than `HEAD_EPS`, or when a lower segment's depth changed by more than `DEPTH_EPS`. There is no slope test underground. Accepted: a gently sloped underground channel may fall asleep with a slight tilt.
7. **The sea pins top segments only**, as in 3c. A lower segment joined to the sea (under a bridge at the coast) stays at sea level through flow.
8. **Edits go through `resegment`** for every write that changes a cell's kind (or a water level).
   - **Top segment, wall placed at or below its surface cell:**
     - the cell's water is *displaced*: it is added to the top's depth and spread by 3c's `spreadDisplaced`;
     - the pending entry's `f0` is the wall's cell `y`, so the spread takes exactly the cell's water;
     - a wall on the top's floor is 3c's floor rise, unchanged;
     - a wall above the floor splits off the water below it as a new lower segment.
   - **Lower segment:** the displaced water goes to the part above the wall, or, when there is none, to the part below, over its capacity (excess).
   - **A one-cell pocket filled by the wall:** its water goes to the top segment and is spread.
9. **Excess.**
   - Water beyond a lower segment's capacity (an edit pushed it in) is kept as `excess` on the segment.
   - A body collects it and pushes it out through its boundary: the bisection target is a net inflow of `−excess`.
   - A body that takes in more than its slack in a step also stores the surplus as excess. Volume stays exact, and the surplus leaves at the next step.
10. **Springs feed the segment whose floor is the spring block's top**, top or lower. A lower one takes at most its room (`cap − depth`); the rest stays in `sea`.
11. **The rebuild reads whole columns.** Every run of non-wall cells is a segment. Its depth is all the water in the run, dropped onto its floor; it is canonical when that water already lies full from the floor up, as in 3c.
12. **Mesh workers never draw the simulated water** once the sim owns it (`floor !== NO_FLOOR`). Static water and its remesh plumbing (`WaterPort.remesh`, `waterChunks`, the rebuild's `moved` callback) are removed.
13. **Links.**
    - A slot's link on a side names the neighbour segment its water meets: among the neighbour column's segments that overlap the slot's run, the one with the highest floor below the slot's surface, else the lowest one, else a wall.
    - The link is encoded as the neighbour's rank (0–3) when that segment is drawn or is a top. Otherwise it is `LINK_GROUND | floor` (dry ground). A rank above 3, or no overlap, gives `LINK_WALL`.
    - A rank-0 slot whose links are all "the neighbour's top" (the 3c case) has no record.
14. **Fast and layered refresh paths.**
    - A tile whose `LayerStore` entry was ever allocated (its own or one of its 8 neighbours) is refreshed per slot, resolving neighbours through the links (`slotPatch.ts`).
    - Every other tile keeps 3c's refresh exactly.
    - On a world without layers the two paths give identical instance data (differential test with `forceLayered`).
15. **Curtains in layered tiles.**
    - A rank-0 curtain whose span (its column, the `ARC_COLUMNS` ahead and the rows beside) has default links is laid by 3c's `lay`.
    - Any other curtain is straight: foot at its resolved neighbour's level, reach 0, no body, closed flare, a splash when it lands on drawn water.
16. **Some 3c world tests change meaning** (a wall dropped mid-water no longer pushes the trapped water up; there is no static water). Task 7 lists each one and its new expectation from the spec. They are rewritten, never deleted.

---

## Design notes (shared by Tasks 1–12)

### Segments

- `UnderSegments` (pool) arrays, per index `i`:
  - `floor`, `ceil` (Int16);
  - `depth`, `last`, `excess` (Int32);
  - `col`: its column, −1 when free;
  - `next`: the next lower segment up the column, −1 when the top segment is next;
  - `body`: its body, −1 when free;
  - `shown`: publish hysteresis;
  - `mirrorLo`, `mirrorQ`.
- `first[c]` is column c's lowest lower segment.
- `cap(i) = (ceil − floor) × SUB`.
- Free indices are reused last-freed-first, so two worlds fed the same edits allocate the same indices.
- The top segment of column c is `[cols.floor[c], height)` with `cols.depth[c]`.
- **Ranks:** with k lower segments in a column, the top has rank 0 and the j-th lower segment from the bottom (j = 0 … k − 1) has rank `k − j`.
- **Total water:** `Σ top depth + Σ (lower depth + excess) + Σ body excess + sea` is constant under physics.

### Edges

- `WaterEdges.tiles[t]` is a `TileEdges` or null. For every column c of tile t (row-major), it holds, in this order:
  - first, for axis 0 (+x, when x + 1 < sx): every pair (segment a of c, segment b of c + 1) whose runs overlap;
  - then the same for axis 1 (+z, neighbour c + sx);
  - pairs ordered by a bottom-up, then b bottom-up;
  - except the pair of the two top segments, which is the dense edge.
- Each edge stores `a`, `b` (refs), `lo` (the opening's floor, `max(floor a, floor b)`), `axis` and `flux`.
- An edge is **owned** by the tile of its a column, as 3c's dense +x/+z edges are.
- A tile's list is rebuilt when a segment of one of its columns, or of the column just −x or −z of it, changes (`markColumn`). Fluxes of edges whose two refs survive are carried over.

### The step with lower segments (`WaterColumns.step`)

1. **Bodies.** `bodies.ensure()` rebuilds dirty bodies, and `edges.ensure()` rebuilds dirty tile lists.
2. **Collect.** As in 3c, then `collectUnder()`: every under edge of each stepped tile, plus, on a side whose neighbour tile does not step, that tile's edges whose b column lies in this tile. `uK` records which stepped tile each edge was collected for, and `uStart[k]` where tile k's edges start.
3. **Accelerate:**
   - dense edges as in 3c;
   - under edges with `accelerateUnder`: 3c's `accelerate` without a fall code, with the opening's floor in place of the receiver's floor. An edge with a body member at either end is skipped;
   - an under edge stored in a non-stepping tile that moved water marks its owner tile dirty, as 3c does for dense border edges.
4. **Bodies:** `bodies.step(stepping, gain)` sets every boundary edge of each active body.
5. **Outflow limit:**
   - under-edge outflows of free senders are summed into `topOut` / `underOut`;
   - 3c's `limit` adds `topOut[c]` to a column's outflow and remembers the scale `(d, out)` of every scaled sender;
   - a top sender outside the stepped tiles and their ring, and every lower sender, is scaled on its under outflows alone;
   - then every under edge from a scaled sender is scaled the same way (`scaled`).
6. **Inflow limit:** each free lower receiver's inflow over under edges is scaled down to its room `cap − depth`.
7. **Transfer:**
   - dense edges as in 3c (falls and plunge included);
   - under edges move `moved(f)` from sender to receiver;
   - water crossing into a tile that does not step reaches it (`reach`), as in 3c.
8. **Rebalance:** each stepped body (`bodies.rebalance()`) redistributes its volume, lowest ceiling first, with deficits at the top; it marks members past `LEAVE` and free lower segments that became full as seeds for the next `ensure`.
9. **Pin and settle:**
   - the sea is pinned on top segments;
   - `settle` adds decision 6's tests;
   - `zeroTile` also zeroes under edges, keeping a border edge whose other tile is awake.

With no `under` attached (`attach` never called) steps 1, 2, 4, 6 and 8 and the under parts of 3, 5, 7 and 9 do nothing, so the step is 3c's.

### Bodies

- **Candidates.** A lower segment is a candidate when `depth + excess ≥ cap`, or when it is a member with `cap − depth ≤ LEAVE`.
- **Rebuild.**
  - Seeds come from edits, fills and leaves.
  - A body containing a seed or a freed member is dropped. Its excess goes back to its first surviving member's `excess`, or to the seed.
  - A breadth-first search from the seeds and the dropped bodies' members walks candidates through overlap with the 4 neighbour columns' lower segments. Top segments are never members.
  - Reaching a member of a kept body drops that body too, and its members join the search.
  - Members are sorted by position. `fill` holds the members by ceiling ascending, then position.
  - `excess` is gathered from the members' `under.excess`, which is then zeroed.
  - Boundary edges are the under edges, in the member columns' tiles and the tiles just −x and −z of them, with exactly one end in the body.
  - Bodies are sorted by first member position, and `under.body` is reassigned.
- **Step (active body: a boundary edge's tile is stepping):**
  - `V = Σ member depth + excess`.
  - `Hb = maxCeil × SUB − max(0, capSum − V)`.
  - `hi = max(Hb, max free surface on the boundary) + MAX_HEAD + 1`.
  - Target `T = excess > 0 ? −excess : 0`.
  - `N(H) = Σ moved(f(H))` oriented into the body. f(H) is the boundary edge accelerated with H as the body side's surface; the body sends only when H is above the opening's floor; a free side sends only with depth ≥ `MIN_FLOW` and surface above the opening's floor. N does not increase with H.
  - `H` = Hb if `N(Hb) ≤ T`, hi if `N(hi) > T`, else the smallest integer in (Hb, hi] with `N(H) ≤ T` (bisection).
  - The fluxes at H are stored, and `level = H`.
  - If the body's total outflow exceeds V, its outflows are scaled to V.
- **Rebalance (after transfer):**
  - `V' = Σ member depth + excess`.
  - Fill members in `fill` order up to their capacity. The rest is `excess`.
  - A member whose deficit exceeds `LEAVE` is a seed.
  - Members whose depth changed mark their tile dirty.

### Edits (`resegment`, `WaterSystem.onWrite`)

- `resegment(old, height, kindAfter, y, oldKind, newKind, newUnits)` returns the runs after the write, bottom-up (the last is the top, `[f, height)` or empty `[height, height)`), with their depths, the old identity each continues, and `topDisplaced`.
  - Water a command removes: the cell's share, as in 3c.
  - A wall placed at y in segment s:
    - `below = min(d, (y − s.floor) × SUB)` stays below;
    - `cell = min(SUB, d − below)` is displaced (decision 8);
    - `above = d − below − cell` goes to the run starting at y + 1.
  - Water placed: `units × UNIT` goes to the run holding y.
  - Every other old segment's water goes to the run holding its floor cell.
  - **Identities.** For each lower run, bottom-up, the first unused old lower segment:
    - with the same floor;
    - else one lying wholly inside the run;
    - else one with the same ceiling.

    The top run keeps the top.
- `onWrite` applies the runs:
  - the top's floor and depth;
  - kept lower segments updated, new ones allocated, vanished ones freed (a freed member drops its body);
  - a depth over capacity becomes `excess`;
  - the column chain;
  - mirror: the top's `lo` is set to its new floor and its cells touched up to y, and every lower run is forced to rewrite its range;
  - tiles dirty and woken (wet around: any segment of the column or its 4 neighbours holds water);
  - `edges.markColumn`;
  - `bodies.seed` for every lower run that is full or kept a body;
  - the pending spread when `topDisplaced > 0`;
  - `floorMoved` when the top floor moved.

### The mirror

`mirrorRun(lo, q, i, x, z, floor, ceil, depth, …)` is 3c's flush bounded to `[min(lo, floor), ceil)`. `WaterMirror.flush` calls it with the top's arrays and `ceil = height`; lower segments use the pool's `mirrorLo` / `mirrorQ`.

### Publishing (sim) and the records

- Layer 0 is 3c's shared buffers, unchanged.
- `WaterTick.layers` is an `Int32Array` of tile blocks, `[tile, count, count × RECORD ints]`, one block per tile in `tiles` (count may be 0).
- A record (`RECORD = 6` ints):

  | Int | Content |
  |---|---|
  | 0 | `local | rank << 8`, where local = `(x & 15) + (z & 15) × 16` |
  | 1 | encoded surface: wet `S`, dry `~S`, with the hysteresis of 3c's `shown`; 0 for rank 0 |
  | 2 | `floor | ceil << 16` |
  | 3 | `(fluxX & 0xffff) | fluxZ << 16`: water moved last step through the slot's +x and +z sides, summed over its edges (clamped to Int16) |
  | 4 | `link(+x) | link(−x) << 16` |
  | 5 | `link(+z) | link(−z) << 16` |
- Records:
  - rank 0 when any in-world link differs from 0;
  - ranks 1–3 when the segment is shown.
- Wet lower segments of rank > 3 in published tiles are counted per tile, and their sum is `waterLayersHidden`.

### The main thread (`LayerStore`, `SurfaceView`)

- **`LayerStore`.**
  - `stage(layers)` keeps the latest block per tile. `commit(t, first)` applies it when `SurfaceView.apply` reads tile t.
  - A slot named again: `prev ← cur`. A new slot: `prev = ~(floor × SUB)`, so it rises; `prev = cur` on a tile's first read.
  - A slot of rank ≥ 1 no longer named: `prev ← cur, cur ← ~(floor × SUB)` (it sinks). At the commit after that it is removed.
  - A rank-0 slot no longer named goes back to default links.
- **`SurfaceView`.**
  - `data[r][cc]` is the `ColumnData` of layer r of chunk column cc.
  - Dirty and touched keys are `r × ccCount + cc`.
  - `refreshTile` takes the layered path when `layers.layeredAround(tile)` or `forceLayered`:
    - every column of the tile and its ring, every rank;
    - `patch()` gives the 3 × 3 effective values;
    - the corners are `vertexShares` over the four 2 × 2 sub-blocks, own quadrants 3, 2, 0, 1;
    - info and curtain masks as in 3c;
    - slots that vanished get `info = −1`.
- **Curtains:** decision 15.

---

## File structure

### `packages/engine/src`

| File | Change | Responsibility |
|---|---|---|
| `sim/water/constants.ts` | modify | `LEAVE`, `RANKS`, `BISECT_ROUNDS` |
| `sim/water/under.ts` | create | `UnderSegments`: the lower-segment pool, chains, ranks, totals, hash |
| `sim/water/resegment.ts` | create | `runsOf`, `resegment`: a column's runs after one write, with volumes and identities |
| `sim/water/edits.ts` | delete | replaced by `resegment.ts` |
| `sim/water/edges.ts` | create | `TileEdges`, `WaterEdges`, `segmentsOf`, `buildTileEdges` |
| `sim/water/columns.ts` | modify | `attach`; the step over under edges; quiet test; totals; hash |
| `sim/water/bodies.ts` | create | `WaterBodies`: rebuild, the H bisection, rebalance, excess |
| `sim/water/rebuild.ts` | modify | whole-column runs, lower segments, no `OVERHANG`, no `moved` |
| `sim/water/mirror.ts` | modify | `mirrorRun`, bounded by a ceiling |
| `sim/water/cycle.ts` | modify | springs feed lower segments |
| `sim/water/links.ts` | create | `rankOf`, `linkOf`, record encoding (`RECORD`, `LINK_*`) |
| `sim/water/publish.ts` | modify | `layers` records, hidden count |
| `sim/water/waterSystem.ts` | modify | wiring: `onWrite` via `resegment`, springs, flush of lower segments, checks, stats, rebuilds; remesh plumbing removed |
| `sim/simulation.ts`, `protocol.ts` | modify | `waterBodies`, `waterLayersHidden` in tick physics; `WaterPort.remesh` removed |
| `mesh/liquid.ts` | modify | never mesh simulated water |
| `render/water/layerStore.ts` | create | `LayerStore`: staged and committed slots of ranks 0–3 |
| `render/water/slotPatch.ts` | create | `SlotSource`, `resolve`, `patch`: a slot's 3 × 3 through the links |
| `render/water/surfaceView.ts` | modify | per-layer `ColumnData`, the layered refresh path, straight curtains, `surfaceNear` |
| `render/water/waterSurface.ts` | modify | one mesh pair per (layer, chunk column) |
| `render/water/ripples.ts` | modify | `surfaceNear` |
| `engine.ts` | modify | stats `waterBodies`, `waterLayersHidden` |

### Engine tests (`packages/engine/test`)

| File | Change |
|---|---|
| `legacy/columns3c.ts` | create: a frozen copy of 3c's `columns.ts` (the differential oracle) |
| `layerHelpers.ts` | create: a voxel-built harness of columns, lower segments, edges, bodies and mirror |
| `underSegments.test.ts`, `resegment.test.ts`, `waterEdges.test.ts`, `waterUnderStep.test.ts`, `waterBodies.test.ts`, `waterLayersWorld.test.ts`, `waterLinks.test.ts`, `layerStore.test.ts`, `surfaceLayers.test.ts` | create |
| `waterEdits.test.ts` | delete (its cases move to `resegment.test.ts`) |
| `waterRebuild.test.ts`, `waterMirror.test.ts`, `waterWorld.test.ts`, `waterCycle.test.ts`, `waterPublish.test.ts`, `liquid.test.ts`, `determinism.test.ts`, `waterFuzz.test.ts`, `surfaceView.test.ts`, `ripples.test.ts` | modify |

### Sandbox (`apps/sandbox`)

| File | Change |
|---|---|
| `src/scenes/caves.ts`, `src/caves.worker.ts`, `test/caves.test.ts`, `e2e/caves.spec.ts` | create: the `?scene=caves` test bed and its hooks |
| `src/main.ts`, `src/hud.ts` | modify: the scene, `__elovox.caves`, the HUD's bodies and hidden layers |
| `bench/damBreak.node.ts` | unchanged; its numbers are compared with 3c's (Task 13) |

---

## Tasks

### Task 0: Baseline

**Files:**
- Modify: `docs/superpowers/plans/2026-10-05-water-layers.md` (the "Checkpoint results" section at the end)

- [ ] **Step 1: Confirm the branch and a green tree**

Run: `git branch --show-current && npm test && npm run typecheck`
Expected:
- the branch is `feat/water-layers`;
- engine 582 passed + 2 expected fail, terrain 174, editor 200, sandbox 74;
- typecheck exits 0.

- [ ] **Step 2: Record 3c's dam bench**

Run: `cd apps/sandbox && npm run bench:dam > ../../bench-3c.txt 2>&1; tail -20 ../../bench-3c.txt`
Expected: tick p50 / p95 / max and the water step's p50 / p95.

Copy those lines into "Checkpoint results" under **3c baseline (Task 0)**, then delete `bench-3c.txt`.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-10-05-water-layers.md
git commit -m "docs(plan): record 3c's dam bench as the 3d baseline"
```

---

### Task 1: The lower-segment pool

**Files:**
- Modify: `packages/engine/src/sim/water/constants.ts`
- Create: `packages/engine/src/sim/water/under.ts`
- Test: `packages/engine/test/underSegments.test.ts`

**Interfaces:**
- Produces:
  - `LEAVE`, `RANKS`, `BISECT_ROUNDS` (constants.ts);
  - `class UnderSegments` with:
    - `n`, `first`, the arrays of the design notes, `count`;
    - `cap(i)`, `surface(i)`;
    - `alloc(c, floor, ceil, depth): number`, `release(i): void`;
    - `chain(c, out: number[]): number[]` (bottom-up), `setChain(c, list: readonly number[]): void`, `freeColumn(c, freed?: number[]): void`;
    - `rankOf(i): number`, `total(): number`, `mixState(mix)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/underSegments.test.ts
import { describe, expect, it } from 'vitest'
import { SUB } from '../src/sim/water/constants.ts'
import { UnderSegments } from '../src/sim/water/under.ts'

describe('UnderSegments', () => {
  it('chains a column bottom-up and ranks its segments from the top (the top segment is rank 0)', () => {
    const u = new UnderSegments(4)
    const a = u.alloc(2, 1, 4, SUB), b = u.alloc(2, 6, 9, 0), c = u.alloc(2, 11, 12, 3)
    u.setChain(2, [a, b, c])
    expect(u.chain(2, [])).toEqual([a, b, c])
    expect([u.rankOf(a), u.rankOf(b), u.rankOf(c)]).toEqual([3, 2, 1])
    expect(u.first[1]).toBe(-1)
    expect(u.cap(a)).toBe(3 * SUB)
    expect(u.surface(a)).toBe(SUB + SUB)
  })

  it('reuses freed indices last-freed-first, so the same edits allocate the same indices', () => {
    const u = new UnderSegments(4)
    const a = u.alloc(0, 0, 2, 0), b = u.alloc(0, 3, 5, 0)
    u.setChain(0, [a, b])
    const freed: number[] = []
    u.freeColumn(0, freed)
    expect(freed).toEqual([a, b])
    expect(u.first[0]).toBe(-1)
    expect(u.count).toBe(0)
    expect(u.alloc(1, 0, 1, 0)).toBe(b)
    expect(u.alloc(1, 2, 3, 0)).toBe(a)
  })

  it('grows past its first capacity and keeps every field', () => {
    const u = new UnderSegments(1)
    const ids: number[] = []
    for (let k = 0; k < 200; k++) ids.push(u.alloc(0, 2 * k, 2 * k + 1, k))
    u.setChain(0, ids)
    expect(u.count).toBe(200)
    expect(u.depth[ids[150]!]).toBe(150)
    expect(u.rankOf(ids[0]!)).toBe(200)
  })

  it('totals depth and excess, and its hash changes with any segment', () => {
    const u = new UnderSegments(2)
    const a = u.alloc(1, 0, 2, 100)
    u.setChain(1, [a])
    u.excess[a] = 7
    expect(u.total()).toBe(107)
    const hash = () => { let h = 0; u.mixState((v) => { h = (Math.imul(h, 31) + v) | 0 }); return h }
    const h0 = hash()
    u.depth[a] = 101
    expect(hash()).not.toBe(h0)
  })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd packages/engine && npx vitest run test/underSegments.test.ts`
Expected: FAIL, `Cannot find module '../src/sim/water/under.ts'`.

- [ ] **Step 3: Add the constants**

Append to `packages/engine/src/sim/water/constants.ts`:

```ts
/** A body member leaves its body when its deficit (cap − depth) exceeds this (1/8 block): hysteresis against flicker (3d). */
export const LEAVE = SUB / 8
/** Draw layers per column: segments counted from the top (rank 0 is the top segment). */
export const RANKS = 4
/** Guard on a body's level bisection (bodies.ts): the range halves every round. */
export const BISECT_ROUNDS = 32
```

- [ ] **Step 4: Write the pool**

```ts
// packages/engine/src/sim/water/under.ts
import { SUB } from './constants.ts'

/**
 * The lower segments of every column (3d spec §3; plan design notes: Segments): each run of air or water cells between two
 * walls below a column's top segment. The top segment is 3c's column (WaterColumns). A lower segment's ref is n + its index,
 * a top segment's ref is its column, so one number names any segment. Indices come from a free list, last freed first:
 * two worlds fed the same edits allocate the same indices. Nothing iterates by index: loops walk columns, then each
 * column's chain bottom-up.
 */
export class UnderSegments {
  readonly n: number
  /** Per column: its lowest lower segment, −1 when it has none. */
  readonly first: Int32Array
  floor = new Int16Array(0)
  ceil = new Int16Array(0)
  depth = new Int32Array(0)
  /** Depth after the segment's last step (the quiet test). */
  last = new Int32Array(0)
  /** Water beyond its capacity that an edit pushed in, until a body pushes it out (plan decision 9). */
  excess = new Int32Array(0)
  /** The segment's column, −1 for a free index. */
  col = new Int32Array(0)
  /** The next lower segment up the column; −1: the top segment is next. */
  next = new Int32Array(0)
  /** Its body (bodies.ts), −1 when free. */
  body = new Int32Array(0)
  /** 1 while it is drawn (publish hysteresis, as WaterPublisher's shown). */
  shown = new Uint8Array(0)
  /** The mirror's state for the segment (mirror.ts mirrorRun). */
  mirrorLo = new Int16Array(0)
  mirrorQ = new Int32Array(0)
  /** Lower segments in use. */
  count = 0
  private readonly freed: number[] = []
  private used = 0

  constructor(n: number) {
    this.n = n
    this.first = new Int32Array(n).fill(-1)
    this.grow(64)
  }

  cap(i: number): number { return (this.ceil[i]! - this.floor[i]!) * SUB }
  surface(i: number): number { return this.floor[i]! * SUB + this.depth[i]! }

  /** A new segment of column c, not yet in its chain (setChain). Its mirror is rewritten at the next flush. */
  alloc(c: number, floor: number, ceil: number, depth: number): number {
    let i = this.freed.pop()
    if (i === undefined) {
      if (this.used === this.col.length) this.grow(this.col.length * 2)
      i = this.used++
    }
    this.col[i] = c
    this.floor[i] = floor
    this.ceil[i] = ceil
    this.depth[i] = depth
    this.last[i] = depth
    this.excess[i] = 0
    this.next[i] = -1
    this.body[i] = -1
    this.shown[i] = 0
    this.mirrorLo[i] = floor
    this.mirrorQ[i] = ~(ceil * 8)
    this.count++
    return i
  }

  /** Frees index i (out of its column's chain already, or the chain is reset right after). */
  release(i: number): void {
    this.col[i] = -1
    this.next[i] = -1
    this.body[i] = -1
    this.freed.push(i)
    this.count--
  }

  /** Column c's lower segments bottom-up, into `out` (cleared first). */
  chain(c: number, out: number[]): number[] {
    out.length = 0
    for (let i = this.first[c]!; i >= 0; i = this.next[i]!) out.push(i)
    return out
  }

  /** Makes `list` (bottom-up) column c's chain. */
  setChain(c: number, list: readonly number[]): void {
    this.first[c] = list.length > 0 ? list[0]! : -1
    for (let k = 0; k < list.length; k++) this.next[list[k]!] = k + 1 < list.length ? list[k + 1]! : -1
  }

  /** Frees every lower segment of column c, bottom-up (their indices into `freed` when given). */
  freeColumn(c: number, freed?: number[]): void {
    let i = this.first[c]!
    while (i >= 0) {
      const nx = this.next[i]!
      freed?.push(i)
      this.release(i)
      i = nx
    }
    this.first[c] = -1
  }

  /** Rank from the top: 1 for the highest lower segment of its column, the top segment being 0. */
  rankOf(i: number): number {
    let r = 1
    for (let j = this.next[i]!; j >= 0; j = this.next[j]!) r++
    return r
  }

  /** Σ depth + excess over the segments in use. */
  total(): number {
    let s = 0
    for (let c = 0; c < this.n; c++) for (let i = this.first[c]!; i >= 0; i = this.next[i]!) s += this.depth[i]! + this.excess[i]!
    return s
  }

  /** Mixes every column's chain bottom-up (never by index): floor, ceil, depth, last, excess and the mirror's state. */
  mixState(mix: (v: number) => void): void {
    mix(this.count)
    for (let c = 0; c < this.n; c++) {
      for (let i = this.first[c]!; i >= 0; i = this.next[i]!) {
        mix(c); mix(this.floor[i]!); mix(this.ceil[i]!); mix(this.depth[i]!); mix(this.last[i]!); mix(this.excess[i]!)
        mix(this.mirrorLo[i]!); mix(this.mirrorQ[i]!)
      }
    }
  }

  private grow(cap: number): void {
    const g16 = (a: Int16Array) => { const b = new Int16Array(cap); b.set(a); return b }
    const g32 = (a: Int32Array, fill = 0) => { const b = new Int32Array(cap).fill(fill); b.set(a); return b }
    const g8 = (a: Uint8Array) => { const b = new Uint8Array(cap); b.set(a); return b }
    this.floor = g16(this.floor)
    this.ceil = g16(this.ceil)
    this.depth = g32(this.depth)
    this.last = g32(this.last)
    this.excess = g32(this.excess)
    this.col = g32(this.col, -1)
    this.next = g32(this.next, -1)
    this.body = g32(this.body, -1)
    this.shown = g8(this.shown)
    this.mirrorLo = g16(this.mirrorLo)
    this.mirrorQ = g32(this.mirrorQ)
  }
}
```

The arrays are replaced when the pool grows. Hot loops read `u.depth` (and the others) afresh each step, never across an `alloc`.

- [ ] **Step 5: Run the test to see it pass**

Run: `cd packages/engine && npx vitest run test/underSegments.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/sim/water/constants.ts packages/engine/src/sim/water/under.ts packages/engine/test/underSegments.test.ts
git commit -m "feat(sim): a pool for the lower segments of every column"
```

---

### Task 2: `resegment`: a column's runs after one write

**Files:**
- Create: `packages/engine/src/sim/water/resegment.ts`
- Test: `packages/engine/test/resegment.test.ts`

`edits.ts` and `waterEdits.test.ts` are deleted in Task 7, once `onWrite` no longer imports them.

**Interfaces:**
- Consumes: `KIND`, `SUB`, `UNIT` (constants.ts).
- Produces:
  - `interface Seg { floor: number; ceil: number; depth: number; id: number }`;
  - `interface Run { floor: number; ceil: number; depth: number; id: number }`;
  - `interface Resegmented { runs: Run[]; topDisplaced: number }`;
  - `runsOf(height, kindAfter): Run[]`;
  - `resegment(old: readonly Seg[], height: number, kindAfter: (y: number) => number, y: number, oldKind: number, newKind: number, newUnits: number): Resegmented`.
- Conventions:
  - `old` and `runs` are bottom-up, the last being the top segment (`ceil = height`);
  - `id` −1 is a new run;
  - a run's depth may exceed `(ceil − floor) × SUB` (excess, plan decision 9).

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/resegment.test.ts
import { describe, expect, it } from 'vitest'
import { KIND, SUB, UNIT } from '../src/sim/water/constants.ts'
import { resegment, runsOf, type Seg } from '../src/sim/water/resegment.ts'

const { AIR: A, WATER: W, WALL: L } = KIND
const H = 32
const TOP = -2

/** Cell kinds after the write: walls at the given heights, everything else air. */
const walls = (...ys: number[]) => (y: number) => (ys.includes(y) ? L : A)
/** Walls below `g` plus the given ones. */
const ground = (g: number, ...ys: number[]) => (y: number) => (y < g || ys.includes(y) ? L : A)
const top = (floor: number, depth: number): Seg => ({ floor, ceil: H, depth, id: TOP })
const seg = (id: number, floor: number, ceil: number, depth: number): Seg => ({ floor, ceil, depth, id })
const sum = (xs: { depth: number }[]) => xs.reduce((s, x) => s + x.depth, 0)

describe('runsOf', () => {
  it('lists the runs of non-wall cells bottom-up, the last reaching the height (empty under a wall at the top)', () => {
    expect(runsOf(H, walls(0, 5, 6, 9))).toEqual([
      { floor: 1, ceil: 5, depth: 0, id: -1 }, { floor: 7, ceil: 9, depth: 0, id: -1 }, { floor: 10, ceil: H, depth: 0, id: -1 },
    ])
    expect(runsOf(4, () => L)).toEqual([{ floor: 4, ceil: 4, depth: 0, id: -1 }])
  })
})

describe('resegment', () => {
  it('a wall on the top segment floor is 3c floor rise: depth unchanged, the cell water displaced (spread later)', () => {
    const r = resegment([top(2, 3 * SUB)], H, ground(3), 2, W, L, 0)
    expect(r.runs).toEqual([{ floor: 3, ceil: H, depth: 3 * SUB, id: TOP }])
    expect(r.topDisplaced).toBe(SUB)
  })

  it('a wall mid-water in the top splits it: water below stays as a new lower segment, the cell water is displaced', () => {
    const r = resegment([top(2, 4 * SUB)], H, ground(2, 4), 4, W, L, 0)
    expect(r.runs).toEqual([
      { floor: 2, ceil: 4, depth: 2 * SUB, id: -1 },
      { floor: 5, ceil: H, depth: SUB + SUB, id: TOP }, // one block above the wall + the displaced cell
    ])
    expect(r.topDisplaced).toBe(SUB)
  })

  it('a wall in the surface cell displaces only that cell water', () => {
    const r = resegment([top(2, 2 * SUB + 100)], H, ground(2, 4), 4, W, L, 0)
    expect(r.runs).toEqual([{ floor: 2, ceil: 4, depth: 2 * SUB, id: -1 }, { floor: 5, ceil: H, depth: 100, id: TOP }])
    expect(r.topDisplaced).toBe(100)
  })

  it('a wall above the surface (a bridge) splits the top: the lake becomes a lower segment, the top is dry', () => {
    const r = resegment([top(2, 3 * SUB)], H, ground(2, 8), 8, A, L, 0)
    expect(r.runs).toEqual([{ floor: 2, ceil: 8, depth: 3 * SUB, id: -1 }, { floor: 9, ceil: H, depth: 0, id: TOP }])
    expect(r.topDisplaced).toBe(0)
  })

  it('a wall in a lower segment: below stays, the cell goes up with the water above', () => {
    const r = resegment([seg(7, 2, 8, 5 * SUB), top(9, 0)], H, ground(2, 4, 8), 4, W, L, 0)
    expect(r.runs).toEqual([
      { floor: 2, ceil: 4, depth: 2 * SUB, id: 7 }, { floor: 5, ceil: 8, depth: 3 * SUB, id: -1 }, { floor: 9, ceil: H, depth: 0, id: TOP },
    ])
  })

  it('a wall in the top cell of a full lower segment pushes the cell water into the part below, over its capacity', () => {
    const r = resegment([seg(3, 2, 6, 4 * SUB), top(7, 0)], H, ground(2, 5, 6), 5, W, L, 0)
    expect(r.runs[0]).toEqual({ floor: 2, ceil: 5, depth: 4 * SUB, id: 3 }) // cap 3 blocks: 1 block of excess
    expect(sum(r.runs)).toBe(4 * SUB)
  })

  it('a wall filling a one-cell pocket sends its water to the top (spread)', () => {
    const r = resegment([seg(1, 3, 4, SUB), top(5, 0)], H, ground(5), 3, W, L, 0)
    expect(r.runs).toEqual([{ floor: 5, ceil: H, depth: SUB, id: TOP }])
    expect(r.topDisplaced).toBe(SUB)
  })

  it('digging the wall between a lower segment and the top merges them: the upper water falls onto the lower', () => {
    const r = resegment([seg(4, 2, 5, 2 * SUB), top(6, SUB)], H, ground(2), 5, L, A, 0)
    expect(r.runs).toEqual([{ floor: 2, ceil: H, depth: 3 * SUB, id: TOP }])
  })

  it('digging the wall between two lower segments merges them under the lower one identity', () => {
    const r = resegment([seg(4, 2, 5, 3 * SUB), seg(9, 6, 8, SUB), top(10, 0)], H, ground(2, 8, 9), 5, L, A, 0)
    expect(r.runs).toEqual([{ floor: 2, ceil: 8, depth: 4 * SUB, id: 4 }, { floor: 10, ceil: H, depth: 0, id: TOP }])
  })

  it('digging a roof cell grows the segment under it; digging a floor cell lowers it and keeps it', () => {
    const roof = resegment([seg(4, 2, 5, 3 * SUB), top(7, 0)], H, ground(2, 6), 5, L, A, 0)
    expect(roof.runs[0]).toEqual({ floor: 2, ceil: 6, depth: 3 * SUB, id: 4 })
    const floor = resegment([seg(4, 3, 6, SUB), top(7, 0)], H, ground(2, 6), 2, L, A, 0)
    expect(floor.runs[0]).toEqual({ floor: 2, ceil: 6, depth: SUB, id: 4 })
  })

  it('digging a cell inside a thick wall opens a new empty pocket', () => {
    const r = resegment([top(10, 0)], H, (y) => (y < 10 && y !== 5 ? L : A), 5, L, A, 0)
    expect(r.runs).toEqual([{ floor: 5, ceil: 6, depth: 0, id: -1 }, { floor: 10, ceil: H, depth: 0, id: TOP }])
  })

  it('water placed or removed by a command changes the segment holding the cell by exactly its share', () => {
    const placed = resegment([seg(4, 2, 8, SUB), top(9, 0)], H, ground(2, 8), 6, A, W, 3)
    expect(placed.runs[0]!.depth).toBe(SUB + 3 * UNIT)
    const removed = resegment([seg(4, 2, 8, 2 * SUB + 50), top(9, 0)], H, ground(2, 8), 4, W, A, 0)
    expect(removed.runs[0]!.depth).toBe(2 * SUB) // the surface cell held 50
    const relevel = resegment([top(2, 2 * SUB)], H, ground(2), 3, W, W, 4)
    expect(relevel.runs[0]!.depth).toBe(SUB + 4 * UNIT)
  })

  it('keeps volume exact through any single wall or air write, plus the units placed', () => {
    let seed = 3
    const rand = (k: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % k }
    for (let trial = 0; trial < 500; trial++) {
      const kinds: number[] = []
      for (let y = 0; y < H; y++) kinds.push(y < 2 || rand(4) === 0 ? L : A)
      const before = runsOf(H, (y) => kinds[y]!)
      const old: Seg[] = before.map((r, k) => ({ ...r, id: k === before.length - 1 ? TOP : k, depth: rand(Math.max(1, (r.ceil - r.floor) * SUB)) }))
      const y = 2 + rand(H - 3), ok = kinds[y]!
      // the cell held air or a wall (never a water voxel here): nothing is removed, only placed
      const nk = ok === L ? (rand(2) === 0 ? A : W) : rand(3) === 0 ? W : L
      const units = nk === W ? 1 + rand(8) : 0
      const after = kinds.slice()
      after[y] = nk === W ? A : nk
      const r = resegment(old, H, (yy) => after[yy]!, y, ok, nk, units)
      expect(sum(r.runs)).toBe(sum(old) + units * UNIT)
      for (let k = 0; k < r.runs.length - 1; k++) expect(r.runs[k]!.ceil).toBeLessThanOrEqual(r.runs[k + 1]!.floor)
    }
  })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd packages/engine && npx vitest run test/resegment.test.ts`
Expected: FAIL, `Cannot find module '../src/sim/water/resegment.ts'`.

- [ ] **Step 3: Write `resegment.ts`**

```ts
// packages/engine/src/sim/water/resegment.ts
import { KIND, SUB, UNIT } from './constants.ts'

/** A segment of a column before a write: cells [floor, ceil), its water (1/SUB block) and its identity. */
export interface Seg { floor: number; ceil: number; depth: number; id: number }
/** A run of non-wall cells after the write: the old segment it continues (`id`, −1 when new) and its water, which may exceed its capacity. */
export interface Run { floor: number; ceil: number; depth: number; id: number }
export interface Resegmented {
  /** Bottom-up; the last is the top segment (ceil = height). */
  runs: Run[]
  /** Water a wall placed in the top segment displaced, already in the top run's depth: WaterSystem spreads it (plan decision 8). */
  topDisplaced: number
}

/** The runs of non-wall cells of a column, bottom-up; the last is the top run, reaching `height` (empty when the top cell is a wall). */
export function runsOf(height: number, kindAfter: (y: number) => number): Run[] {
  const runs: Run[] = []
  let f = -1
  for (let y = 0; y < height; y++) {
    if (kindAfter(y) === KIND.WALL) {
      if (f >= 0) { runs.push({ floor: f, ceil: y, depth: 0, id: -1 }); f = -1 }
    } else if (f < 0) f = y
  }
  runs.push(f >= 0 ? { floor: f, ceil: height, depth: 0, id: -1 } : { floor: height, ceil: height, depth: 0, id: -1 })
  return runs
}

/** The run holding cell y; the top run for a cell no run holds (at or above the world's top). */
function runAt(runs: Run[], y: number): Run {
  for (const r of runs) if (y >= r.floor && y < r.ceil) return r
  return runs[runs.length - 1]!
}

/**
 * One voxel write at cell y of a column (3d spec §5 Edits; plan design notes: Edits). `old`: the column's segments before
 * the write, bottom-up, the top last; `kindAfter(y)`: every cell's KIND after it. Volume is exact: the runs hold the old
 * water, minus what a command removed, plus what it placed.
 * - Water a command removes (overwritten by anything but a wall): the cell's share of its segment, as in 3c.
 * - A wall placed in a segment's cell y: the water below y stays below, the cell's own water is displaced, the water above
 *   goes to the run above. Displaced water in the top goes into the top run's depth and is reported (`topDisplaced`); in a
 *   lower segment it goes to the run above, else to the run below (over its capacity); a filled one-cell pocket sends it up.
 * - Water placed: its units go to the run holding y.
 * Each lower run continues the first unused old lower segment with its floor, else one lying inside it, else one with its
 * ceiling; the top run continues the top.
 */
export function resegment(old: readonly Seg[], height: number, kindAfter: (y: number) => number,
  y: number, oldKind: number, newKind: number, newUnits: number): Resegmented {
  const runs = runsOf(height, kindAfter)
  const topRun = runs[runs.length - 1]!
  let topDisplaced = 0
  for (let k = 0; k < old.length; k++) {
    const s = old[k]!, isTop = k === old.length - 1
    const holds = y >= s.floor && y < s.ceil
    let d = s.depth
    if (holds && oldKind === KIND.WATER && newKind !== KIND.WALL) {
      d = Math.max(0, d - Math.min(SUB, Math.max(0, s.floor * SUB + d - y * SUB)))
    }
    if (holds && newKind === KIND.WALL && oldKind !== KIND.WALL) {
      const below = Math.min(d, (y - s.floor) * SUB)
      const cell = Math.min(SUB, d - below)
      const above = d - below - cell
      if (below > 0) runAt(runs, y - 1).depth += below
      if (above > 0) runAt(runs, y + 1).depth += above
      if (cell > 0) {
        if (isTop || (y === s.floor && y + 1 === s.ceil)) { topRun.depth += cell; topDisplaced += cell }
        else if (y + 1 < s.ceil) runAt(runs, y + 1).depth += cell
        else runAt(runs, y - 1).depth += cell
      }
      continue
    }
    if (d > 0) runAt(runs, s.floor).depth += d
  }
  if (newKind === KIND.WATER) runAt(runs, y).depth += newUnits * UNIT
  const used = new Set<number>()
  const lower = old.slice(0, -1)
  for (let i = 0; i < runs.length - 1; i++) {
    const r = runs[i]!
    const s = lower.find((o) => !used.has(o.id) && o.floor === r.floor)
      ?? lower.find((o) => !used.has(o.id) && o.floor >= r.floor && o.ceil <= r.ceil)
      ?? lower.find((o) => !used.has(o.id) && o.ceil === r.ceil)
    if (s) { r.id = s.id; used.add(s.id) }
  }
  topRun.id = old[old.length - 1]!.id
  return { runs, topDisplaced }
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `cd packages/engine && npx vitest run test/resegment.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sim/water/resegment.ts packages/engine/test/resegment.test.ts
git commit -m "feat(sim): resegment re-derives a column's runs after a write and carries their water over"
```

---

### Task 3: Under edges

**Files:**
- Create: `packages/engine/src/sim/water/edges.ts`
- Test: `packages/engine/test/waterEdges.test.ts`

**Interfaces:**
- Consumes:
  - `UnderSegments` (Task 1);
  - `WaterColumns` (`n`, `sx`, `sz`, `floor`, `depth`, `tiles`), type-only import.
- Produces:
  - `class TileEdges { count; a: Int32Array; b: Int32Array; lo: Int16Array; axis: Uint8Array; flux: Int32Array; seen: Int32Array; push(a, b, lo, axis, flux) }`;
  - `segmentsOf(c, under, out): number[]`;
  - `floorOf(ref, cols, under)`, `ceilOf(ref, cols, under, height)`, `depthOf(ref, cols, under)`, `columnOf(ref, cols, under)`;
  - `class WaterEdges { tiles: (TileEdges | null)[]; rebuilt: number[]; markColumn(x, z, cols); markAll(); ensure(cols, under, height); mixState(mix) }`.
- `seen` is a per-edge stamp that `WaterColumns.collectUnder` (Task 5) sets to the step number when it collects the edge.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/waterEdges.test.ts
import { describe, expect, it } from 'vitest'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { WaterEdges, segmentsOf } from '../src/sim/water/edges.ts'
import { UnderSegments } from '../src/sim/water/under.ts'

const H = 32

/** A 32 × 32 world, every top floor at 1; column (5, 5) also holds a lower segment [2, 5) under a roof, its top at 6. */
function setup() {
  const cols = new WaterColumns(32, 32, new Int16Array(32 * 32))
  cols.floor.fill(1)
  const u = new UnderSegments(cols.n)
  const c = 5 + 5 * 32
  cols.floor[c] = 6
  const i = u.alloc(c, 2, 5, SUB)
  u.setChain(c, [i])
  const e = new WaterEdges(cols.tiles.count)
  e.markAll()
  e.ensure(cols, u, H)
  return { cols, u, e, c, ref: cols.n + i }
}

describe('WaterEdges', () => {
  it('lists every overlapping pair but the two tops, row-major, +x before +z, bottom-up', () => {
    const { cols, e, c, ref } = setup()
    const E = e.tiles[0]!
    const got = Array.from({ length: E.count }, (_, k) => [E.a[k], E.b[k], E.lo[k], E.axis[k]])
    expect(got).toEqual([
      [c - 32, ref, 2, 1], // (5, 4) +z into the lower segment
      [c - 1, ref, 2, 0], // (4, 5) +x
      [ref, c + 1, 2, 0], // (5, 5) lower segment +x
      [ref, c + 32, 2, 1], // (5, 5) lower segment +z
    ])
    expect(e.tiles[1]).toBeNull() // no lower segment in or beside tile 1
    expect(segmentsOf(c, setupUnder(cols), [])).toEqual([c])
  })

  it('keeps the flux of an edge whose two segments survive a rebuild, drops edges that vanished', () => {
    const { cols, u, e, c } = setup()
    const E = e.tiles[0]!
    E.flux[2] = 777
    e.markColumn(5, 5, cols)
    e.ensure(cols, u, H)
    expect(e.tiles[0]!.flux[2]).toBe(777)
    expect(e.rebuilt).toEqual([0])
    u.freeColumn(c)
    e.markColumn(5, 5, cols)
    e.ensure(cols, u, H)
    expect(e.tiles[0]).toBeNull()
  })

  it('marks the tiles owning a column edges: its own and its −x and −z neighbours', () => {
    const { cols, u, e } = setup()
    e.markColumn(16, 16, cols)
    e.ensure(cols, u, H)
    expect(e.rebuilt).toEqual([1, 2, 3]) // tiles (1,0), (0,1), (1,1) of a 2 × 2 tiling
  })

  it('makes no edge for an empty top (a column solid to the top) and none across no overlap', () => {
    const cols = new WaterColumns(16, 16, new Int16Array(256))
    cols.floor.fill(H) // every column solid to the top
    const u = new UnderSegments(cols.n)
    const i = u.alloc(0, 2, 4, 0), j = u.alloc(1, 5, 7, 0) // side by side, no overlap
    u.setChain(0, [i]); u.setChain(1, [j])
    const e = new WaterEdges(cols.tiles.count)
    e.markAll()
    e.ensure(cols, u, H)
    expect(e.tiles[0]).toBeNull()
  })
})

function setupUnder(cols: WaterColumns): UnderSegments { return new UnderSegments(cols.n) }
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd packages/engine && npx vitest run test/waterEdges.test.ts`
Expected: FAIL, `Cannot find module '../src/sim/water/edges.ts'`.

- [ ] **Step 3: Write `edges.ts`**

```ts
// packages/engine/src/sim/water/edges.ts
import type { WaterColumns } from './columns.ts'
import { TILE } from './constants.ts'
import type { UnderSegments } from './under.ts'

/**
 * The under edges one tile owns (plan design notes: Edges). Edge e joins segment ref a, in a column of the tile, to ref b in
 * its +x (axis 0) or +z (axis 1) neighbour column; the two top segments' edge is the dense one (WaterColumns.flux).
 */
export class TileEdges {
  count = 0
  a = new Int32Array(8)
  b = new Int32Array(8)
  /** The opening's floor: max(floor a, floor b), in blocks. */
  lo = new Int16Array(8)
  axis = new Uint8Array(8)
  /** Stored flux (FLUX_FP extra bits; positive from a to b), as WaterColumns.flux. */
  flux = new Int32Array(8)
  /** The step that last collected the edge (WaterColumns.collectUnder). */
  seen = new Int32Array(8)

  push(a: number, b: number, lo: number, axis: number, flux: number): void {
    if (this.count === this.a.length) {
      const m = this.a.length * 2
      const g32 = (x: Int32Array) => { const y = new Int32Array(m); y.set(x); return y }
      this.a = g32(this.a); this.b = g32(this.b); this.flux = g32(this.flux); this.seen = g32(this.seen)
      const lo = new Int16Array(m); lo.set(this.lo); this.lo = lo
      const ax = new Uint8Array(m); ax.set(this.axis); this.axis = ax
    }
    const e = this.count++
    this.a[e] = a; this.b[e] = b; this.lo[e] = lo; this.axis[e] = axis; this.flux[e] = flux; this.seen[e] = 0
  }
}

/** Column c's segments bottom-up as refs (its lower chain, then its top: ref c), into `out` (cleared first). */
export function segmentsOf(c: number, under: UnderSegments, out: number[]): number[] {
  out.length = 0
  for (let i = under.first[c]!; i >= 0; i = under.next[i]!) out.push(under.n + i)
  out.push(c)
  return out
}

export function floorOf(ref: number, cols: WaterColumns, under: UnderSegments): number {
  return ref < cols.n ? cols.floor[ref]! : under.floor[ref - cols.n]!
}
/** The world's height for a top segment. */
export function ceilOf(ref: number, cols: WaterColumns, under: UnderSegments, height: number): number {
  return ref < cols.n ? height : under.ceil[ref - cols.n]!
}
export function depthOf(ref: number, cols: WaterColumns, under: UnderSegments): number {
  return ref < cols.n ? cols.depth[ref]! : under.depth[ref - cols.n]!
}
export function columnOf(ref: number, cols: WaterColumns, under: UnderSegments): number {
  return ref < cols.n ? ref : under.col[ref - cols.n]!
}

/** Every tile's under edges, rebuilt per tile when a segment of one of its columns (or of the column −x / −z of it) changes. */
export class WaterEdges {
  readonly tiles: (TileEdges | null)[]
  /** Tiles the last ensure() rebuilt, ascending: bodies with boundary edges there are rebuilt (bodies.ts). */
  readonly rebuilt: number[] = []
  private readonly flag: Uint8Array
  private pending: number[] = []
  private readonly sa: number[] = []
  private readonly sb: number[] = []
  private readonly keep = new Map<number, number>()

  constructor(tileCount: number) {
    this.tiles = new Array<TileEdges | null>(tileCount).fill(null)
    this.flag = new Uint8Array(tileCount)
  }

  /** A segment of column (x, z) changed: its tile and the tiles of its −x and −z neighbours rebuild at the next ensure(). */
  markColumn(x: number, z: number, cols: WaterColumns): void {
    const T = cols.tiles
    this.mark(T.of(x, z))
    if (x > 0) this.mark(T.of(x - 1, z))
    if (z > 0) this.mark(T.of(x, z - 1))
  }

  markAll(): void { for (let t = 0; t < this.tiles.length; t++) this.mark(t) }

  /** Rebuilds the marked tiles, ascending; lists them in `rebuilt`. */
  ensure(cols: WaterColumns, under: UnderSegments, height: number): void {
    this.rebuilt.length = 0
    if (this.pending.length === 0) return
    const p = this.pending.sort((a, b) => a - b)
    this.pending = []
    for (const t of p) { this.flag[t] = 0; this.rebuild(t, cols, under, height); this.rebuilt.push(t) }
  }

  mixState(mix: (v: number) => void): void {
    for (let t = 0; t < this.tiles.length; t++) {
      const E = this.tiles[t]
      if (!E) continue
      mix(t); mix(E.count)
      for (let e = 0; e < E.count; e++) { mix(E.a[e]!); mix(E.b[e]!); mix(E.lo[e]!); mix(E.axis[e]!); mix(E.flux[e]!) }
    }
  }

  private mark(t: number): void {
    if (this.flag[t] === 1) return
    this.flag[t] = 1
    this.pending.push(t)
  }

  private rebuild(t: number, cols: WaterColumns, under: UnderSegments, height: number): void {
    const old = this.tiles[t], keep = this.keep, sx = cols.sx, sz = cols.sz, tx = cols.tiles.tx
    keep.clear()
    if (old) for (let e = 0; e < old.count; e++) keep.set(old.a[e]! * 4294967296 + old.b[e]!, old.flux[e]!)
    const x0 = (t % tx) * TILE, z0 = Math.floor(t / tx) * TILE
    let E: TileEdges | null = null
    for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) {
      const c = x + z * sx
      for (let axis = 0; axis < 2; axis++) {
        if (axis === 0 ? x + 1 >= sx : z + 1 >= sz) continue
        const nb = axis === 0 ? c + 1 : c + sx
        if (under.first[c]! < 0 && under.first[nb]! < 0) continue // two tops only: the dense edge
        const sa = segmentsOf(c, under, this.sa), sb = segmentsOf(nb, under, this.sb)
        for (const ra of sa) {
          const fa = floorOf(ra, cols, under), ca = ceilOf(ra, cols, under, height)
          for (const rb of sb) {
            if (ra === c && rb === nb) continue
            const fb = floorOf(rb, cols, under), cb = ceilOf(rb, cols, under, height)
            const lo = fa > fb ? fa : fb, hi = ca < cb ? ca : cb
            if (lo >= hi) continue
            E ??= new TileEdges()
            E.push(ra, rb, lo, axis, keep.get(ra * 4294967296 + rb) ?? 0)
          }
        }
      }
    }
    this.tiles[t] = E
  }
}
```

The test's `setupUnder` helper only checks that `segmentsOf` lists a lone top for a column with no lower segment.

- [ ] **Step 4: Run the test to see it pass**

Run: `cd packages/engine && npx vitest run test/waterEdges.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sim/water/edges.ts packages/engine/test/waterEdges.test.ts
git commit -m "feat(sim): under edges join the overlapping segments of neighbouring columns, per tile"
```

---

### Task 4: Segments from the voxels, and the mirror of a bounded run

**Files:**
- Modify: `packages/engine/src/sim/water/rebuild.ts` (add `rebuildSegments`; `rebuildColumns` stays until Task 7)
- Modify: `packages/engine/src/sim/water/mirror.ts` (`mirrorRun`; `WaterMirror.flush` delegates to it)
- Test: `packages/engine/test/waterRebuild.test.ts`, `packages/engine/test/waterMirror.test.ts` (new cases)

**Interfaces:**
- Consumes: `UnderSegments` (Task 1).
- Produces:
  - `rebuildSegments(store, kind, cols, under, mirror, x0, z0, x1, z1): void`;
  - `mirrorRun(lo: Int16Array, q: Int32Array, i, x, z, floor, ceil, depth, water, kind, get, set): boolean`.

`rebuildSegments` does the following for every column in the range:
- its top run goes into `cols.floor/depth`, with the mirror state of 3c and the fluxes zeroed;
- every lower run is allocated in `under`, after freeing the column's old chain;
- each lower run gets its own mirror state: canonical or forced, as in 3c.

The caller marks the region's edges (`edges.markColumn`, or `markAll`) and rebuilds bodies.

- [ ] **Step 1: Write the failing tests**

Add to `packages/engine/test/waterRebuild.test.ts`, after the existing `describe`:

```ts
import { rebuildSegments } from '../src/sim/water/rebuild.ts'
import { UnderSegments } from '../src/sim/water/under.ts'

function segWorld(fill: (x: number, y: number, z: number) => number, size: [number, number, number] = [32, 64, 32]) {
  const buffers = createWorldBuffers(size)
  const store = new ChunkStore({ buffers, opaque: reg.opaque })
  const L = store.layout, data = new Uint16Array(32768)
  for (let ci = 0; ci < L.chunkCount; ci++) {
    const [cx, cy, cz] = L.chunkCoords(ci)
    for (let i = 0; i < 32768; i++) data[i] = fill(cx * 32 + (i & 31), cy * 32 + (i >> 10), cz * 32 + ((i >> 5) & 31))
    store.writeChunkDense(ci, data)
  }
  store.commit()
  const cols = new WaterColumns(size[0], size[2], new Int16Array(buffers.water.floor))
  const under = new UnderSegments(cols.n)
  const mirror = new WaterMirror(cols.n)
  rebuildSegments(store, kind, cols, under, mirror, 0, 0, size[0], size[2])
  /** Column (x, z) bottom-up: its lower segments, then its top ([floor, height)). */
  const segs = (x: number, z: number) => {
    const c = x + z * size[0]
    const out = under.chain(c, []).map((i) => ({ floor: under.floor[i]!, ceil: under.ceil[i]!, depth: under.depth[i]! }))
    out.push({ floor: cols.floor[c]!, ceil: size[1], depth: cols.depth[c]! })
    return out
  }
  return { cols, under, mirror, segs }
}

describe('rebuildSegments', () => {
  it('makes every run of non-wall cells a segment: a bridge and a roof over a lake split it, nothing is static', () => {
    const { segs } = segWorld((x, y) => {
      if (y < 3) return ID.stone
      if (y <= 5) return water(7)
      if (x === 4 && y >= 8 && y <= 10) return ID.stone // a bridge over the lake
      if (x === 6 && y >= 6 && y <= 14) return ID.stone // a roof right on the water
      return AIR
    })
    expect(segs(4, 4)).toEqual([{ floor: 3, ceil: 8, depth: 3 * SUB }, { floor: 11, ceil: 64, depth: 0 }])
    expect(segs(6, 4)).toEqual([{ floor: 3, ceil: 6, depth: 3 * SUB }, { floor: 15, ceil: 64, depth: 0 }])
    expect(segs(9, 4)).toEqual([{ floor: 3, ceil: 64, depth: 3 * SUB }])
  })

  it('drops water hovering over air in a run onto the run floor, and forces its mirror up to its top', () => {
    const { segs, under } = segWorld((x, y, z) => {
      if (y < 2 || y === 9) return ID.stone // a cave [2, 9) under a roof
      if (x === 3 && z === 3 && y === 6) return water(7) // hovering in the cave
      return AIR
    })
    expect(segs(3, 3)[0]).toEqual({ floor: 2, ceil: 9, depth: SUB })
    const i = under.first[3 + 3 * 32]!
    expect(under.mirrorQ[i]).toBe(~(7 * 8))
  })

  it('reads a column solid to the top as an empty top at the height; every other column holds its cave', () => {
    const { cols, under, segs } = segWorld((x, y) => (x === 0 ? ID.stone : y < 2 || y === 5 ? ID.stone : AIR))
    expect(segs(0, 0)).toEqual([{ floor: 64, ceil: 64, depth: 0 }])
    expect(segs(1, 0)).toEqual([{ floor: 2, ceil: 5, depth: 0 }, { floor: 6, ceil: 64, depth: 0 }])
    expect(cols.depth[1]).toBe(0)
    expect(under.count).toBe(31 * 32) // one cave per column but the solid row
  })
})
```

Add to `packages/engine/test/waterMirror.test.ts`:

```ts
import { mirrorRun } from '../src/sim/water/mirror.ts'

describe('mirrorRun', () => {
  it('writes a lower segment cells only inside [floor, ceil): never the cells of the segment above', () => {
    const w = column()
    w.cells.set(5, ID.stone) // the roof of [2, 5)
    w.cells.set(6, water(7)) // the segment above holds water
    const lo = new Int16Array([2]), q = new Int32Array([~(5 * 8)])
    mirrorRun(lo, q, 0, 0, 0, 2, 5, 3 * SUB, ID.water, kind, w.get, w.set)
    expect([2, 3, 4, 5, 6].map((y) => w.get(0, y, 0))).toEqual([water(7), water(7), water(7), ID.stone, water(7)])
    expect(q[0]).toBe(5 * 8)
  })

  it('clears a drained lower segment cells and leaves its partial top at the right level', () => {
    const w = column()
    for (const y of [2, 3, 4]) w.cells.set(y, water(7))
    const lo = new Int16Array([2]), q = new Int32Array([5 * 8])
    mirrorRun(lo, q, 0, 0, 0, 2, 5, SUB + SUB / 2, ID.water, kind, w.get, w.set)
    expect([2, 3, 4].map((y) => w.get(0, y, 0))).toEqual([water(7), water(3), AIR])
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/engine && npx vitest run test/waterRebuild.test.ts test/waterMirror.test.ts`
Expected: FAIL, `rebuildSegments` and `mirrorRun` are not exported.

- [ ] **Step 3: Write `mirrorRun` and make `flush` delegate**

Replace the body of `WaterMirror.flush` in `packages/engine/src/sim/water/mirror.ts` with a call to a new exported function holding the same code, bounded by a ceiling:

```ts
/**
 * Makes one segment's cells match its water (spec §4 The voxel mirror; 3d: bounded by `ceil`): full cells under the
 * quantized surface, a partial cell at it, air above where water was, and air in cells a risen floor left under it (from
 * min(lo, floor)). Walls and springs are never written; nothing at or above `ceil` is touched. `lo`/`q` hold the segment's
 * mirror state at index i (WaterMirror's arrays for a top segment, UnderSegments.mirrorLo / mirrorQ for a lower one).
 */
export function mirrorRun(lo: Int16Array, q: Int32Array, i: number, x: number, z: number, floor: number, ceil: number, depth: number,
  water: number, kind: Uint8Array, get: (x: number, y: number, z: number) => number, set: (x: number, y: number, z: number, v: number) => void): boolean {
  const nq = depth > 0 ? quantize(floor * SUB + depth) : floor * 8
  const oq = q[i]!, force = oq < 0, extent = force ? ~oq : oq
  const ol = lo[i]!
  if (!force && nq === oq && floor === ol) return false
  const from = Math.min(ol, floor)
  const to = Math.min(ceil, Math.max((extent + 7) >> 3, (nq + 7) >> 3))
  const full = nq >> 3, part = nq & 7
  let wrote = false
  for (let y = from; y < to; y++) {
    const v = get(x, y, z), k = kind[v & 0xfff]!
    if (k === KIND.WALL) continue
    let want = AIR
    if (y >= floor) {
      if (y < full) want = water | (7 << 12)
      else if (y === full && part > 0) want = water | ((part - 1) << 12)
    }
    if (want === AIR ? k === KIND.WATER : v !== want) {
      set(x, y, z, want)
      wrote = true
    }
  }
  lo[i] = floor
  q[i] = nq
  return wrote
}
```

`WaterMirror.flush(c, x, z, floor, depth, water, kind, height, get, set)` becomes `return mirrorRun(this.lo, this.q, c, x, z, floor, height, depth, water, kind, get, set)`. Its behaviour is unchanged: `to` was already capped at `height`.

- [ ] **Step 4: Write `rebuildSegments`**

Add to `packages/engine/src/sim/water/rebuild.ts`. Import `UnderSegments` from `./under.ts` as a type; `quantize` is already imported.

```ts
/**
 * Rebuilds columns [x0, x1) × [z0, z1) as segments (3d spec §5 Rebuild; plan decision 11). Each column is read bottom-up
 * and every run of non-wall cells becomes a segment: its water is all the water in the run, resting on its floor. The top
 * run (it reaches the world's height; empty at the height when the top cell is a wall) is the column (floor, depth, the
 * mirror state, fluxes zeroed as in rebuildColumns); the others replace the column's lower chain. A run's mirror is
 * canonical when its water lies full from the floor up with at most a partial top, else forced up to its highest water
 * cell. Uniform air and wall chunks are skipped whole. The caller rebuilds the edges and bodies of the region.
 */
export function rebuildSegments(store: ChunkStore, kind: Uint8Array, cols: WaterColumns, under: UnderSegments, mirror: WaterMirror,
  x0: number, z0: number, x1: number, z1: number): void {
  const L = store.layout, H = L.size[1], sx = cols.sx
  const chunks = new Array<Uint16Array | number>(L.cy)
  const runs = new Int32Array((H + 1) * 4) // per run: floor, ceil, depth, mirror q
  const list: number[] = []
  for (let cz = z0 >> 5; cz <= (z1 - 1) >> 5; cz++) for (let cx = x0 >> 5; cx <= (x1 - 1) >> 5; cx++) {
    for (let cy = 0; cy < L.cy; cy++) {
      const e = store.table[L.chunkIndex(cx, cy, cz)]!
      chunks[cy] = e < 0 ? decodeUniform(e) : store.views.voxels(e)
    }
    const xa = Math.max(x0, cx * 32), xb = Math.min(x1, cx * 32 + 32)
    const za = Math.max(z0, cz * 32), zb = Math.min(z1, cz * 32 + 32)
    for (let z = za; z < zb; z++) for (let x = xa; x < xb; x++) {
      const local = (x & 31) + ((z & 31) << 5), c = x + z * sx
      let k = 0, f = -1, depth = 0, wTop = -1, canonical = true, gap = false, lastUnits = 8
      const open = (y: number) => { f = y; depth = 0; wTop = -1; canonical = true; gap = false; lastUnits = 8 }
      const close = (ceil: number) => {
        const o = k * 4
        runs[o] = f; runs[o + 1] = ceil; runs[o + 2] = depth
        runs[o + 3] = depth === 0 ? f * 8 : canonical ? quantize(f * SUB + depth) : ~((wTop + 1) * 8)
        k++
        f = -1
      }
      let y = 0
      while (y < H) {
        const ch = chunks[y >> 5]!
        if (typeof ch === 'number') {
          const kk = kind[ch & 0xfff]!
          if (kk === KIND.WALL) { if (f >= 0) close(y); y = (y | 31) + 1; continue }
          if (kk === KIND.AIR) { if (f < 0) open(y); gap = true; y = (y | 31) + 1; continue }
        }
        const v = typeof ch === 'number' ? ch : ch[local + ((y & 31) << 10)]!
        const kk = kind[v & 0xfff]!
        if (kk === KIND.WALL) { if (f >= 0) close(y); y++; continue }
        if (f < 0) open(y)
        if (kk === KIND.WATER) {
          const units = ((v >>> 12) & 7) + 1
          if (gap || lastUnits !== 8) canonical = false
          depth += units * UNIT
          wTop = y
          lastUnits = units
        } else gap = true
        y++
      }
      if (f >= 0) close(H)
      else { runs[k * 4] = H; runs[k * 4 + 1] = H; runs[k * 4 + 2] = 0; runs[k * 4 + 3] = H * 8; k++ }
      const t = (k - 1) * 4
      cols.floor[c] = runs[t]!
      cols.depth[c] = runs[t + 2]!
      cols.flux[2 * c] = 0
      cols.flux[2 * c + 1] = 0
      if (x > 0) cols.flux[2 * (c - 1)] = 0
      if (z > 0) cols.flux[2 * (c - sx) + 1] = 0
      mirror.lo[c] = runs[t]!
      mirror.q[c] = runs[t + 3]!
      under.freeColumn(c)
      list.length = 0
      for (let r = 0; r < k - 1; r++) {
        const o = r * 4, i = under.alloc(c, runs[o]!, runs[o + 1]!, runs[o + 2]!)
        under.mirrorLo[i] = runs[o]!
        under.mirrorQ[i] = runs[o + 3]!
        list.push(i)
      }
      under.setChain(c, list)
    }
  }
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd packages/engine && npx vitest run test/waterRebuild.test.ts test/waterMirror.test.ts`
Expected: PASS. The existing cases are unchanged: `rebuildColumns` and `flush` keep their behaviour.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/sim/water/rebuild.ts packages/engine/src/sim/water/mirror.ts packages/engine/test/waterRebuild.test.ts packages/engine/test/waterMirror.test.ts
git commit -m "feat(sim): segments from the voxels, and the mirror of a segment bounded by its ceiling"
```

---

### Task 5: The step over under edges

**Files:**
- Create: `packages/engine/test/legacy/columns3c.ts` (a frozen copy of 3c's `columns.ts`)
- Create: `packages/engine/test/layerHelpers.ts`
- Modify: `packages/engine/src/sim/water/columns.ts`
- Test: `packages/engine/test/waterUnderStep.test.ts`

**Interfaces:**
- Consumes:
  - `UnderSegments` (Task 1);
  - `WaterEdges`, `TileEdges`, `columnOf` (Task 3);
  - `rebuildSegments` (Task 4).
- Produces on `WaterColumns`:
  - `under: UnderSegments | null`, `edges: WaterEdges | null`, `height: number`;
  - `attach(under: UnderSegments, edges: WaterEdges, height: number): void`;
  - `stepNo: number` (read-only for others);
  - `bodyLevel: ((ref: number) => number) | null` (set by bodies in Task 6; the level a body member shows to the quiet test);
  - a hook interface `StepHooks` that Task 6 fills: `{ ensure(): void; step(stepping: Uint8Array, gain: number): void; rebalance(): void; filled(i: number): void; excessTotal(): number; mixState(mix): void }`, set with `hooks(h: StepHooks | null)`;
  - `total()` includes lower segments, their excess and `hooks.excessTotal()`;
  - `wetAwake()` counts wet lower segments in awake tiles.
- `layerHelpers.ts` exports:
  - `LREG`, `KINDS`, `wv(level)`, `type LFill`;
  - `layered(fill, size?, opts?)`, returning `{ store, cols, under, edges, mirror, step, settle, segs, total, wakeWet }`.

- [ ] **Step 1: Freeze 3c's step as the oracle**

Run: `cd packages/engine && mkdir -p test/legacy && git show HEAD:packages/engine/src/sim/water/columns.ts > test/legacy/columns3c.ts`

Then in `test/legacy/columns3c.ts`, rewrite the three relative imports to point at the sources:
- `'./constants.ts'` → `'../../src/sim/water/constants.ts'`;
- `'./fall.ts'` → `'../../src/sim/water/fall.ts'`;
- `'./tiles.ts'` → `'../../src/sim/water/tiles.ts'`.

Rename the class `WaterColumns` to `LegacyColumns`, and add this first line:

```ts
// Frozen copy of 3c's sim/water/columns.ts (commit 2c4817d): the oracle for the 3d differential test. Never edit.
```

- [ ] **Step 2: Write the harness**

```ts
// packages/engine/test/layerHelpers.ts
import { BlockRegistry, defineBlock } from '../src/blocks/registry.ts'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { WaterEdges } from '../src/sim/water/edges.ts'
import { WaterMirror } from '../src/sim/water/mirror.ts'
import { rebuildSegments, waterKinds } from '../src/sim/water/rebuild.ts'
import { UnderSegments } from '../src/sim/water/under.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ChunkStore } from '../src/world/chunkStore.ts'
import { AIR, packVoxel } from '../src/world/voxel.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

export const LREG = new BlockRegistry([...TEST_BLOCKS, defineBlock({ name: 'spring', liquid: true, source: 'water', textures: 'water' })])
export const KINDS = waterKinds(LREG, ID.water)
export const wv = (level = 7): number => packVoxel(ID.water, level)
export const STONE = ID.stone
export { AIR }
export type LFill = (x: number, y: number, z: number) => number

/**
 * Columns, lower segments and their edges built from voxels, without a WaterSystem (Tasks 5–6). Every tile holding water
 * starts awake. `step()` steps once with no sea; `segs(x, z)` lists a column bottom-up (lower segments, then its top).
 */
export function layered(fill: LFill, size: [number, number, number] = [32, 32, 32]) {
  const buffers = createWorldBuffers(size)
  const store = new ChunkStore({ buffers, opaque: LREG.opaque })
  const L = store.layout, data = new Uint16Array(32768)
  for (let ci = 0; ci < L.chunkCount; ci++) {
    const [cx, cy, cz] = L.chunkCoords(ci)
    for (let i = 0; i < 32768; i++) data[i] = fill(cx * 32 + (i & 31), cy * 32 + (i >> 10), cz * 32 + ((i >> 5) & 31))
    store.writeChunkDense(ci, data)
  }
  store.commit()
  const [sx, H, sz] = size
  const cols = new WaterColumns(sx, sz, new Int16Array(buffers.water.floor))
  const under = new UnderSegments(cols.n)
  const mirror = new WaterMirror(cols.n)
  rebuildSegments(store, KINDS, cols, under, mirror, 0, 0, sx, sz)
  const edges = new WaterEdges(cols.tiles.count)
  edges.markAll()
  cols.attach(under, edges, H)
  const wakeWet = () => {
    for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
      const c = x + z * sx
      let wet = cols.depth[c]! > 0
      for (let i = under.first[c]!; i >= 0 && !wet; i = under.next[i]!) wet = under.depth[i]! > 0
      if (wet) cols.tiles.wake(cols.tiles.of(x, z))
    }
  }
  wakeWet()
  const step = (cap = 1 << 20) => { cols.step(cap, null, 0) }
  const settle = (max = 30_000, cap = 1 << 20, each?: () => void) => {
    for (let i = 1; i <= max; i++) { cols.step(cap, null, 0); each?.(); if (cols.tiles.awakeCount() === 0) return i }
    throw new Error(`still awake after ${max} steps: ${cols.tiles.awakeCount()} tiles`)
  }
  const segs = (x: number, z: number) => {
    const c = x + z * sx
    const out = under.chain(c, []).map((i) => ({ floor: under.floor[i]!, ceil: under.ceil[i]!, depth: under.depth[i]! }))
    out.push({ floor: cols.floor[c]!, ceil: H, depth: cols.depth[c]! })
    return out
  }
  return { store, cols, under, edges, mirror, step, settle, segs, total: () => cols.total(), wakeWet }
}
```

- [ ] **Step 3: Write the failing tests**

```ts
// packages/engine/test/waterUnderStep.test.ts
import { describe, expect, it } from 'vitest'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { HEAD_EPS, SUB, TILE } from '../src/sim/water/constants.ts'
import { WaterEdges } from '../src/sim/water/edges.ts'
import { UnderSegments } from '../src/sim/water/under.ts'
import { LegacyColumns } from './legacy/columns3c.ts'
import { AIR, STONE, layered, wv } from './layerHelpers.ts'

describe('the step with no lower segment is 3c step', () => {
  it('matches the frozen 3c step exactly, depth and flux, every step, free and throttled', () => {
    for (const [seed, cap] of [[1, 1 << 20], [2, 1 << 20], [3, 2], [4, 1]] as const) {
      let s = seed
      const rand = (k: number) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % k }
      const sx = 48, sz = 32
      const floor = new Int16Array(sx * sz), depth = new Int32Array(sx * sz)
      for (let c = 0; c < sx * sz; c++) { floor[c] = 2 + rand(6); depth[c] = rand(3) === 0 ? 0 : rand(4 * SUB) }
      const a = new WaterColumns(sx, sz, floor.slice()), b = new LegacyColumns(sx, sz, floor.slice())
      a.attach(new UnderSegments(a.n), new WaterEdges(a.tiles.count), 32)
      a.depth.set(depth); b.depth.set(depth)
      for (let t = 0; t < a.tiles.count; t++) { a.tiles.wake(t); b.tiles.wake(t) }
      for (let k = 0; k < 300; k++) {
        a.step(cap, null, 0); b.step(cap, null, 0)
        expect(a.depth).toEqual(b.depth)
        expect(a.flux).toEqual(b.flux)
        expect([...a.tiles.awake]).toEqual([...b.tiles.awake])
      }
    }
  })
})

describe('water through under edges', () => {
  /** A lake (x 1–10, floor 2, water to y 5) beside a cave (x 11–20, cells y 2–3) under a roof; stone walls all round. */
  const lakeAndCave = (x: number, y: number, z: number) => {
    if (y < 2 || x === 0 || z === 0 || z >= 6 || x >= 21) return STONE
    if (x <= 10) return y <= 5 ? wv(7) : AIR
    return y <= 3 ? AIR : STONE
  }

  it('a lake pours into a cave beside it: the cave fills to its roof, never past it, and volume is exact', () => {
    const w = layered(lakeAndCave)
    const total = w.total()
    w.settle(30_000, 1 << 20, () => {
      for (let i = 0; i < w.under.count; i++) if (w.under.col[i]! >= 0) expect(w.under.depth[i]!).toBeLessThanOrEqual(w.under.cap(i))
    })
    // the cave ends full to its roof, within the heads a sleeping tile allows
    for (let x = 11; x <= 20; x++) expect(w.segs(x, 3)[0]!.depth).toBeGreaterThanOrEqual(2 * SUB - 2 * HEAD_EPS)
    expect(w.total()).toBe(total)
  })

  it('water flows under a bridge from one pool into the other and levels', () => {
    const w = layered((x, y, z) => {
      if (y < 2 || x === 0 || x === 31 || z === 0 || z >= 4) return STONE
      if (x === 15 && y === 7) return STONE // the bridge deck, above the water
      return x < 15 && y <= 5 ? wv(7) : AIR
    })
    const total = w.total()
    w.settle()
    expect(w.segs(15, 2)).toEqual([{ floor: 2, ceil: 7, depth: expect.any(Number) }, { floor: 8, ceil: 32, depth: 0 }])
    const left = w.cols.surface(5 + 2 * 32), right = w.cols.surface(25 + 2 * 32)
    expect(Math.abs(left - right)).toBeLessThanOrEqual(2 * HEAD_EPS)
    expect(w.total()).toBe(total)
  })

  it('water crossing an under edge into a tile that does not step reaches it (Review Focus 3)', () => {
    // The lake fills tile 0; the cave starts at x 16, in tile 1, which starts asleep.
    const w = layered((x, y, z) => {
      if (y < 2 || x === 0 || z === 0 || z >= 6 || x >= 30) return STONE
      if (x <= 15) return y <= 5 ? wv(7) : AIR
      return y <= 3 ? AIR : STONE
    })
    const t1 = w.cols.tiles.of(16, 3)
    expect(w.cols.tiles.awake[t1]).toBe(0)
    const total = w.total()
    let woke = false
    for (let k = 0; k < 20 && !woke; k++) { w.step(); woke = w.cols.tiles.awake[t1] === 1 }
    expect(woke).toBe(true)
    expect(w.segs(16, 3)[0]!.depth).toBeGreaterThan(0)
    expect(w.total()).toBe(total)
  })

  it('a still cave pool falls asleep and stays put', () => {
    const w = layered((x, y, z) => {
      if (y < 2 || y >= 6 || x === 0 || z === 0 || x >= TILE || z >= TILE) return STONE
      return y <= 3 ? wv(7) : AIR
    })
    const total = w.total()
    w.settle(200)
    expect(w.segs(5, 5)[0]).toMatchObject({ floor: 2, ceil: 6, depth: 2 * SUB })
    expect(w.total()).toBe(total)
  })
})
```

- [ ] **Step 4: Run them to see them fail**

Run: `cd packages/engine && npx vitest run test/waterUnderStep.test.ts`
Expected: FAIL, `a.attach is not a function` (and `w.cols.attach` in the harness).

- [ ] **Step 5: Add the under step to `WaterColumns`**

Make these changes in `packages/engine/src/sim/water/columns.ts`.

(a) Imports and module helpers. Add, after the existing imports:

```ts
import type { TileEdges, WaterEdges } from './edges.ts'
import type { UnderSegments } from './under.ts'

/** What bodies (Task 6) plug into the step; null until then. */
export interface StepHooks {
  /** Rebuild dirty bodies (after the edges). */
  ensure(): void
  /** Set every boundary edge of each body with an edge collected this step. */
  step(stepping: Uint8Array, gain: number): void
  /** After the transfer: redistribute each stepped body's water; list members to leave. */
  rebalance(): void
  /** A free lower segment reached its capacity this step. */
  filled(i: number): void
  /** Water held as bodies' excess. */
  excessTotal(): number
  mixState(mix: (v: number) => void): void
}

/**
 * Step 2 for under edge e of E: 3c's accelerate without a fall code (plan decision 5); the opening's floor `lo` stands where
 * 3c reads the receiver's floor. Refs below n are top segments.
 */
function accelerateUnder(E: TileEdges, e: number, n: number, floor: Int16Array, depth: Int32Array, uf: Int16Array, ud: Int32Array, gain: number): void {
  const a = E.a[e]!, b = E.b[e]!
  const da = a < n ? depth[a]! : ud[a - n]!, db = b < n ? depth[b]! : ud[b - n]!
  const sa = (a < n ? floor[a]! : uf[a - n]!) * SUB + da, sb = (b < n ? floor[b]! : uf[b - n]!) * SUB + db
  const lo = E.lo[e]! * SUB
  let h = sa - sb
  if (h > MAX_HEAD) h = MAX_HEAD
  else if (h < -MAX_HEAD) h = -MAX_HEAD
  let f = damp(E.flux[e]!) + h * gain
  if (f > 0) { if (da < MIN_FLOW || sa <= lo) f = 0 } else if (f < 0) { if (db < MIN_FLOW || sb <= lo) f = 0 }
  E.flux[e] = f
}
```

(b) `limit` takes the column's under outflow and returns the outflow it scaled to (0 when it scaled nothing). The change is the `extra` parameter, its first use, and the return value:

```ts
/** Step 3 for column c: scales its outflows (east, south, west, north edges; −1 where none; `extra`: its outflow over under edges) to move at most its depth. Returns the total outflow when it scaled, else 0. */
function limit(depth: Int32Array, flux: Int32Array, c: number, east: number, south: number, west: number, north: number, extra: number): number {
  let out = extra
  if (east >= 0 && flux[east]! > 0) out += flux[east]! >> FLUX_FP
  if (south >= 0 && flux[south]! > 0) out += flux[south]! >> FLUX_FP
  if (west >= 0 && flux[west]! < 0) out += -flux[west]! >> FLUX_FP
  if (north >= 0 && flux[north]! < 0) out += -flux[north]! >> FLUX_FP
  const d = depth[c]!
  if (out <= d) return 0
  if (east >= 0 && flux[east]! > 0) flux[east] = scaled(flux[east]!, d, out)
  if (south >= 0 && flux[south]! > 0) flux[south] = scaled(flux[south]!, d, out)
  if (west >= 0 && flux[west]! < 0) flux[west] = -scaled(-flux[west]!, d, out)
  if (north >= 0 && flux[north]! < 0) flux[north] = -scaled(-flux[north]!, d, out)
  return out
}
```

(c) New fields on `WaterColumns`, after `private cursor = 0`:

```ts
  /** Lower segments, their edges and the world's height (attach); null: a single-layer world, stepped exactly as 3c. */
  under: UnderSegments | null = null
  edges: WaterEdges | null = null
  height = 0
  /** Bodies' level for a member ref (set by WaterBodies, Task 6): the surface the quiet test reads for it. */
  bodyLevel: ((ref: number) => number) | null = null
  /** Increments every step: stamps the per-step marks below and TileEdges.seen. */
  stepNo = 0
  private hook: StepHooks | null = null
  /** The under edges this step moves: their tile list (uT) and index there (uE); stepped tile k's run from uStart[k]. */
  private readonly uT = new IntList()
  private readonly uE = new IntList()
  private uStart = new Int32Array(65)
  /** Per top column (n) / lower segment (pool size): outflow over under edges this step, the step that set it, and a sender's scale (depth, outflow) when it was scaled. */
  private topOut = new Int32Array(0)
  private topMark = new Int32Array(0)
  private topLimited = new Int32Array(0)
  private topScaleD = new Int32Array(0)
  private topScaleOut = new Int32Array(0)
  private topScaleMark = new Int32Array(0)
  private underOut = new Int32Array(0)
  private underMark = new Int32Array(0)
  private underScaleD = new Int32Array(0)
  private underScaleOut = new Int32Array(0)
  private underScaleMark = new Int32Array(0)
  private underIn = new Int32Array(0)
  private underInMark = new Int32Array(0)
  private readonly sendersTop = new IntList()
  private readonly sendersUnder = new IntList()
  private readonly receivers = new IntList()
```

(d) `attach` and `hooks`:

```ts
  /** Steps lower segments too (3d). Without it the step is 3c's. */
  attach(under: UnderSegments, edges: WaterEdges, height: number): void {
    this.under = under
    this.edges = edges
    this.height = height
    this.topOut = new Int32Array(this.n)
    this.topMark = new Int32Array(this.n)
    this.topLimited = new Int32Array(this.n)
    this.topScaleD = new Int32Array(this.n)
    this.topScaleOut = new Int32Array(this.n)
    this.topScaleMark = new Int32Array(this.n)
  }

  hooks(h: StepHooks | null): void { this.hook = h }
```

(e) `step`: wrap the 3c phases with the under phases. Replace the body of `step` with:

```ts
  step(cap: number, sea: Uint8Array | null, seaSurface: number): number {
    const U = this.under
    this.stepNo++
    if (U) {
      this.edges!.ensure(this, U, this.height)
      this.hook?.ensure()
      this.sizeUnder(U)
    }
    this.collect(cap)
    if (U) this.collectUnder(U)
    // The cap left awake tiles out: their borders advance out of phase, which only a lower gain keeps stable.
    const throttled = this.list.length >= cap && this.tiles.awakeCount() > this.list.length
    const gain = throttled ? THROTTLED_GAIN : GAIN
    this.accelerateAll(gain)
    if (U) {
      this.accelerateUnderAll(U, gain)
      this.hook?.step(this.stepping, gain)
      this.sumUnderOut(U)
    }
    this.limitAll()
    if (U) { this.limitUnder(U); this.scaleUnder(U); this.inflowUnder(U) }
    this.transferAll()
    if (U) { this.transferUnder(U); this.hook?.rebalance() }
    const credit = sea ? this.pinAll(sea, seaSurface) : 0
    this.settle()
    for (let k = 0; k < this.list.length; k++) this.stepping[this.list.data[k]!] = 0
    return credit
  }
```

(f) `limitAll`: pass the under outflow, record scales, and mark the columns it covered. Replace it with:

```ts
  /** Every column of the stepped tiles, then every ring column: each one's outflows together move at most its depth. */
  private limitAll(): void {
    const depth = this.depth, flux = this.flux, sx = this.sx, sz = this.sz, tx = this.tiles.tx
    for (let k = 0; k < this.list.length; k++) {
      const t = this.list.data[k]!
      const x0 = (t % tx) * TILE, z0 = Math.floor(t / tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0, c = x0 + z * sx; x < x0 + TILE; x++, c++) {
        this.limitTop(c, limit(depth, flux, c, x + 1 < sx ? c * 2 : -1, z + 1 < sz ? c * 2 + 1 : -1, x > 0 ? (c - 1) * 2 : -1, z > 0 ? (c - sx) * 2 + 1 : -1, this.extraOut(c)))
      }
    }
    for (let k = 0; k < this.ring.length; k++) {
      const c = this.ring.data[k]!, x = c % sx, z = (c - x) / sx
      this.limitTop(c, limit(depth, flux, c, x + 1 < sx ? c * 2 : -1, z + 1 < sz ? c * 2 + 1 : -1, x > 0 ? (c - 1) * 2 : -1, z > 0 ? (c - sx) * 2 + 1 : -1, this.extraOut(c)))
    }
  }

  /** Column c's outflow over under edges this step (0 in a single-layer world). */
  private extraOut(c: number): number { return this.under !== null && this.topMark[c] === this.stepNo ? this.topOut[c]! : 0 }

  /** After limit for column c: remember it was limited, and its scale when it scaled (its under edges are scaled alike). */
  private limitTop(c: number, out: number): void {
    if (this.under === null) return
    this.topLimited[c] = this.stepNo
    if (out > 0) { this.topScaleD[c] = this.depth[c]!; this.topScaleOut[c] = out; this.topScaleMark[c] = this.stepNo }
  }
```

(g) The under phases. Add these private methods:

```ts
  /** Grows the per-lower-segment scratch to the pool's size. */
  private sizeUnder(U: UnderSegments): void {
    const m = U.col.length
    if (this.underOut.length >= m) return
    this.underOut = new Int32Array(m); this.underMark = new Int32Array(m)
    this.underScaleD = new Int32Array(m); this.underScaleOut = new Int32Array(m); this.underScaleMark = new Int32Array(m)
    this.underIn = new Int32Array(m); this.underInMark = new Int32Array(m)
  }

  /** The column holding segment ref. */
  private colOf(ref: number, U: UnderSegments): number { return ref < this.n ? ref : U.col[ref - this.n]! }

  /**
   * Every under edge of each stepped tile, plus, on a side whose neighbour tile does not step, that tile's edges reaching
   * into this one (as 3c's border edges). Stamps each collected edge (TileEdges.seen).
   */
  private collectUnder(U: UnderSegments): void {
    const E = this.edges!, sx = this.sx, tx = this.tiles.tx, no = this.stepNo
    this.uT.clear(); this.uE.clear()
    if (this.uStart.length < this.list.length + 1) this.uStart = new Int32Array(this.list.length * 2 + 1)
    const take = (t: number, e: number) => { this.uT.push(t); this.uE.push(e); E.tiles[t]!.seen[e] = no }
    for (let k = 0; k < this.list.length; k++) {
      const t = this.list.data[k]!, o = this.open[k]!
      this.uStart[k] = this.uT.length
      const own = E.tiles[t]
      if (own) for (let e = 0; e < own.count; e++) take(t, e)
      const x0 = (t % tx) * TILE, z0 = Math.floor(t / tx) * TILE
      const w = (o & WEST) !== 0 ? E.tiles[t - 1] : null
      if (w) for (let e = 0; e < w.count; e++) if (w.axis[e] === 0 && this.colOf(w.a[e]!, U) % sx === x0 - 1) take(t - 1, e)
      const nt = (o & NORTH) !== 0 ? E.tiles[t - tx] : null
      if (nt) for (let e = 0; e < nt.count; e++) if (nt.axis[e] === 1 && Math.floor(this.colOf(nt.a[e]!, U) / sx) === z0 - 1) take(t - tx, e)
    }
    this.uStart[this.list.length] = this.uT.length
  }

  /**
   * Accelerates every collected under edge but a body's: a boundary edge is set by its body, an edge inside one carries
   * nothing. An edge stored in a tile that does not step that moved water marks it dirty.
   */
  private accelerateUnderAll(U: UnderSegments, gain: number): void {
    const E = this.edges!, n = this.n, dirty = this.tiles.dirty, stepping = this.stepping
    for (let k = 0; k < this.uT.length; k++) {
      const t = this.uT.data[k]!, e = this.uE.data[k]!, T = E.tiles[t]!, a = T.a[e]!, b = T.b[e]!
      const ma = a >= n && U.body[a - n]! >= 0, mb = b >= n && U.body[b - n]! >= 0
      if (ma || mb) { if (ma && mb) T.flux[e] = 0; continue } // inside a body nothing flows; a boundary edge is the body's
      if (stepping[t] === 0 && moved(T.flux[e]!) !== 0) dirty[t] = 1
      accelerateUnder(T, e, n, this.floor, this.depth, U.floor, U.depth, gain)
    }
  }

  /** Sums each free sender's outflow over the collected under edges (a body caps its own outflow). */
  private sumUnderOut(U: UnderSegments): void {
    const E = this.edges!, n = this.n, no = this.stepNo
    this.sendersTop.clear(); this.sendersUnder.clear()
    for (let k = 0; k < this.uT.length; k++) {
      const T = E.tiles[this.uT.data[k]!]!, e = this.uE.data[k]!, f = T.flux[e]!
      if (f === 0) continue
      const s = f > 0 ? T.a[e]! : T.b[e]!, m = (f > 0 ? f : -f) >> FLUX_FP
      if (s < n) {
        if (this.topMark[s] !== no) { this.topMark[s] = no; this.topOut[s] = 0; this.sendersTop.push(s) }
        this.topOut[s] = this.topOut[s]! + m
      } else {
        const i = s - n
        if (U.body[i]! >= 0) continue
        if (this.underMark[i] !== no) { this.underMark[i] = no; this.underOut[i] = 0; this.sendersUnder.push(i) }
        this.underOut[i] = this.underOut[i]! + m
      }
    }
  }

  /** Senders limitAll did not cover (lower segments, top columns outside the stepped tiles and their ring): scaled on their under outflow alone. */
  private limitUnder(U: UnderSegments): void {
    const no = this.stepNo
    for (let k = 0; k < this.sendersTop.length; k++) {
      const c = this.sendersTop.data[k]!
      if (this.topLimited[c] === no) continue
      const out = this.topOut[c]!, d = this.depth[c]!
      if (out > d) { this.topScaleD[c] = d; this.topScaleOut[c] = out; this.topScaleMark[c] = no }
    }
    for (let k = 0; k < this.sendersUnder.length; k++) {
      const i = this.sendersUnder.data[k]!, out = this.underOut[i]!, d = U.depth[i]!
      if (out > d) { this.underScaleD[i] = d; this.underScaleOut[i] = out; this.underScaleMark[i] = no }
    }
  }

  /** Scales every collected under edge whose sender was scaled, as limit scaled that sender's dense edges. */
  private scaleUnder(U: UnderSegments): void {
    const E = this.edges!, n = this.n, no = this.stepNo
    for (let k = 0; k < this.uT.length; k++) {
      const T = E.tiles[this.uT.data[k]!]!, e = this.uE.data[k]!, f = T.flux[e]!
      if (f === 0) continue
      const s = f > 0 ? T.a[e]! : T.b[e]!, af = f > 0 ? f : -f
      let g = af
      if (s < n) { if (this.topScaleMark[s] === no) g = scaled(af, this.topScaleD[s]!, this.topScaleOut[s]!) }
      else if (this.underScaleMark[s - n] === no) g = scaled(af, this.underScaleD[s - n]!, this.underScaleOut[s - n]!)
      if (g !== af) T.flux[e] = f > 0 ? g : -g
    }
  }

  /** A free lower segment never takes more than its room (cap − depth): its inflows are scaled down together. */
  private inflowUnder(U: UnderSegments): void {
    const E = this.edges!, n = this.n, no = this.stepNo
    this.receivers.clear()
    for (let k = 0; k < this.uT.length; k++) {
      const T = E.tiles[this.uT.data[k]!]!, e = this.uE.data[k]!, f = T.flux[e]!
      if (f === 0) continue
      const r = f > 0 ? T.b[e]! : T.a[e]!
      if (r < n || U.body[r - n]! >= 0) continue
      const i = r - n
      if (this.underInMark[i] !== no) { this.underInMark[i] = no; this.underIn[i] = 0; this.receivers.push(i) }
      this.underIn[i] = this.underIn[i]! + ((f > 0 ? f : -f) >> FLUX_FP)
    }
    let any = false
    for (let k = 0; k < this.receivers.length; k++) {
      const i = this.receivers.data[k]!
      if (this.underIn[i]! > Math.max(0, U.cap(i) - U.depth[i]!)) any = true
      else this.underInMark[i] = 0 // not over: no scaling
    }
    if (!any) return
    for (let k = 0; k < this.uT.length; k++) {
      const T = E.tiles[this.uT.data[k]!]!, e = this.uE.data[k]!, f = T.flux[e]!
      if (f === 0) continue
      const r = f > 0 ? T.b[e]! : T.a[e]!
      if (r < n || this.underInMark[r - n] !== no) continue
      const i = r - n, af = f > 0 ? f : -f, g = scaled(af, Math.max(0, U.cap(i) - U.depth[i]!), this.underIn[i]!)
      T.flux[e] = f > 0 ? g : -g
    }
  }

  /**
   * Moves the water of every collected under edge. Water reaching a tile that does not step reaches it (wakes it, or is a
   * trickle), and a tile that does not step that loses water is mirrored and published (dirty), as in 3c.
   */
  private transferUnder(U: UnderSegments): void {
    const E = this.edges!, n = this.n, T = this.tiles, sx = this.sx, tx = T.tx, stepping = this.stepping
    const tileOf = (c: number) => { const x = c % sx; return Math.floor(x / TILE) + Math.floor((c - x) / sx / TILE) * tx }
    for (let k = 0, kk = 0; k < this.uT.length; k++) {
      while (kk + 1 < this.list.length && this.uStart[kk + 1]! <= k) kk++
      const L = E.tiles[this.uT.data[k]!]!, e = this.uE.data[k]!, m = moved(L.flux[e]!)
      if (m === 0) continue
      const a = L.a[e]!, b = L.b[e]!
      if (a < n) this.depth[a] = this.depth[a]! - m; else U.depth[a - n] = U.depth[a - n]! - m
      if (b < n) this.depth[b] = this.depth[b]! + m; else U.depth[b - n] = U.depth[b - n]! + m
      const am = m < 0 ? -m : m
      if (am > this.most[kk]!) this.most[kk] = am
      const recv = m > 0 ? b : a, send = m > 0 ? a : b
      const tr = tileOf(this.colOf(recv, U)), ts = tileOf(this.colOf(send, U))
      if (stepping[tr] === 0) this.reach(tr, am)
      if (stepping[ts] === 0) T.dirty[ts] = 1
      if (recv >= n && U.body[recv - n]! < 0 && U.depth[recv - n]! >= U.cap(recv - n)) this.hook?.filled(recv - n)
    }
  }
```

`most[k]` for a stepped tile is first written by `transferAll`, so `transferUnder` must run after it, as `step` orders them.

(h) The quiet test. In `settle`, right after the loop over the tile's columns (before `if (!live) live = !this.flat(t)`), add:

```ts
      if (this.under !== null) {
        const U = this.under
        for (let z = z0; z < z0 + TILE; z++) for (let c = x0 + z * sx, e = c + TILE; c < e; c++) {
          for (let i = U.first[c]!; i >= 0; i = U.next[i]!) {
            const d = U.depth[i]!, dd = d - U.last[i]!
            if (dd === 0) continue
            changed = true
            U.last[i] = d
            if (dd > DEPTH_EPS || -dd > DEPTH_EPS) live = true
          }
        }
        if (!live) live = this.underLive(k)
      }
```

Then add `underLive`:

```ts
  /**
   * Plan decision 6: stepped tile k is live when one of its collected under edges moved FLUX_EPS or more, or when connected
   * water across one of them (the higher side can send: at least MIN_FLOW deep, and one side shows) differs by more than
   * HEAD_EPS. A body member shows its body's level and counts as deep.
   */
  private underLive(k: number): boolean {
    const E = this.edges!, U = this.under!, n = this.n
    for (let j = this.uStart[k]!; j < this.uStart[k + 1]!; j++) {
      const L = E.tiles[this.uT.data[j]!]!, e = this.uE.data[j]!, f = L.flux[e]!
      if (f >= LOUD || -f >= LOUD) return true
      const a = L.a[e]!, b = L.b[e]!
      const ma = a >= n && U.body[a - n]! >= 0, mb = b >= n && U.body[b - n]! >= 0
      const da = ma ? SUB : a < n ? this.depth[a]! : U.depth[a - n]!
      const db = mb ? SUB : b < n ? this.depth[b]! : U.depth[b - n]!
      const sa = ma && this.bodyLevel ? this.bodyLevel(a) : (a < n ? this.floor[a]! : U.floor[a - n]!) * SUB + (a < n ? this.depth[a]! : U.depth[a - n]!)
      const sb = mb && this.bodyLevel ? this.bodyLevel(b) : (b < n ? this.floor[b]! : U.floor[b - n]!) * SUB + (b < n ? this.depth[b]! : U.depth[b - n]!)
      const up = sa > sb ? da : sb > sa ? db : da > db ? da : db
      if (up >= MIN_FLOW && (da >= SHOWN || db >= SHOWN) && (sa - sb > HEAD_EPS || sb - sa > HEAD_EPS)) return true
    }
    return false
  }
```

(i) `zeroTile` also zeroes under edges. Append to `zeroTile`, before `T.dirty[t] = 1`:

```ts
    if (this.edges !== null) {
      const E = this.edges, U = this.under!, own = E.tiles[t]
      if (own) for (let e = 0; e < own.count; e++) {
        const bc = this.colOf(own.b[e]!, U), bx = bc % sx, tb = Math.floor(bx / TILE) + Math.floor((bc - bx) / sx / TILE) * T.tx
        if (tb !== t && awake[tb] === 1) continue // a border edge whose other tile is awake: that tile moves it from now on
        own.flux[e] = 0
      }
      for (const nb of [x0 > 0 ? t - 1 : -1, z0 > 0 ? t - T.tx : -1]) {
        if (nb < 0 || awake[nb] === 1) continue
        const L = E.tiles[nb]
        if (!L) continue
        for (let e = 0; e < L.count; e++) {
          const bc = this.colOf(L.b[e]!, U), bx = bc % sx, tb = Math.floor(bx / TILE) + Math.floor((bc - bx) / sx / TILE) * T.tx
          if (tb !== t) continue
          if (moved(L.flux[e]!) !== 0) T.dirty[nb] = 1
          L.flux[e] = 0
        }
      }
    }
```

(j) Totals, wet count and hash. In `total()` add, before `return s`:

```ts
    if (this.under !== null) s += this.under.total()
    if (this.hook !== null) s += this.hook.excessTotal()
```

In `wetAwake()`, inside the column loop, after counting the top:

```ts
      if (this.under !== null) for (let z = z0; z < z0 + TILE; z++) for (let c = x0 + z * sx, e = c + TILE; c < e; c++) {
        for (let i = this.under.first[c]!; i >= 0; i = this.under.next[i]!) if (this.under.depth[i]! > 0) n++
      }
```

Place it as a separate loop after the existing one, inside the `if (T.awake[t] !== 1) continue` guard.

In `mixState`, append `this.under?.mixState(mix); this.edges?.mixState(mix); this.hook?.mixState(mix)` before `this.tiles.mixState(mix)`.

- [ ] **Step 6: Run the tests to see them pass**

Run: `cd packages/engine && npx vitest run test/waterUnderStep.test.ts test/waterColumns.test.ts`
Expected: PASS. The differential test, the four under-edge tests, and every 3c column test.

If the differential test fails, the change to `limit` or the step order broke 3c's arithmetic. Fix the code, never the oracle.

- [ ] **Step 7: Run every engine test and the types**

Run: `cd packages/engine && npx vitest run && cd ../.. && npm run typecheck`
Expected: all green. `WaterSystem` does not attach yet, so the world tests are untouched.

- [ ] **Step 8: Commit**

```bash
git add packages/engine/src/sim/water/columns.ts packages/engine/test/legacy/columns3c.ts packages/engine/test/layerHelpers.ts packages/engine/test/waterUnderStep.test.ts
git commit -m "feat(sim): the water step moves lower segments through under edges; 3c's step is unchanged without them"
```

---

### Task 6: Pressurized bodies

**Files:**
- Create: `packages/engine/src/sim/water/bodies.ts`
- Modify: `packages/engine/test/layerHelpers.ts` (attach bodies)
- Test: `packages/engine/test/waterBodies.test.ts`

**Interfaces:**
- Consumes:
  - `StepHooks`, `WaterColumns.hooks`, `stepNo`, `bodyLevel`, `damp`, `moved` (Task 5);
  - `TileEdges.seen`, `WaterEdges.rebuilt`, `segmentsOf`, `floorOf`, `ceilOf` (Task 3).
- Produces:
  - `class Body { members; fill; bTile; bEdge; bSide; tiles; capSum; maxCeil; excess; level }`;
  - `class WaterBodies implements StepHooks`:
    - `constructor(cols, under, edges)`;
    - `list: Body[]`;
    - `seed(i)`, `seedFull()`;
    - `dropBody(id): void`;
    - `dropAll(): void`;
    - `activeCount(stepping?)`;
    - the `StepHooks` methods.
  - It installs itself with `cols.hooks(this)` and `cols.bodyLevel = (ref) => …`.

- [ ] **Step 1: Attach bodies in the harness**

In `packages/engine/test/layerHelpers.ts`:
- import `WaterBodies` from `'../src/sim/water/bodies.ts'`;
- after `cols.attach(under, edges, H)`, add `const bodies = new WaterBodies(cols, under, edges); bodies.seedFull()`;
- return `bodies` too.

- [ ] **Step 2: Write the failing tests**

```ts
// packages/engine/test/waterBodies.test.ts
import { describe, expect, it } from 'vitest'
import { HEAD_EPS, SUB } from '../src/sim/water/constants.ts'
import { AIR, STONE, layered, wv } from './layerHelpers.ts'

/**
 * A lake (x 1–20, z 1–10, floor 10, water to y 19: surface 20) beside a hill (x 21–40, solid to y 24) pierced by a tunnel
 * (cells y 12–13, z 5–6) that ends in a shaft (x 41–42, z 5–6, open to the sky). Stone everywhere else up to y 24.
 * `tunnel`: the tunnel cells start full of water; `shaftTop`: water in the shaft up to that y (inclusive), −1 for none.
 */
function uTube(tunnel: boolean, shaftTop = -1) {
  return (x: number, y: number, z: number) => {
    if (y < 10) return STONE
    const lake = x >= 1 && x <= 20 && z >= 1 && z <= 10
    if (lake) return y <= 19 ? wv(7) : AIR
    const tube = z >= 5 && z <= 6 && y >= 12 && y <= 13 && x >= 21 && x <= 40
    if (tube) return tunnel ? wv(7) : AIR
    const shaft = z >= 5 && z <= 6 && x >= 41 && x <= 42 && y >= 12
    if (shaft) return y <= shaftTop ? wv(7) : AIR
    return y <= 24 ? STONE : AIR
  }
}

describe('pressurized bodies', () => {
  it('communicating vessels: the shaft rises to the lake level through a full tunnel, sways and settles (U-tube)', () => {
    const w = layered(uTube(false), [64, 32, 32])
    const total = w.total()
    let peak = 0
    w.settle(60_000, 1 << 20, () => { peak = Math.max(peak, w.cols.surface(41 + 5 * 64)) })
    const lake = w.cols.surface(10 + 5 * 64), shaft = w.cols.surface(41 + 5 * 64)
    expect(shaft).toBeGreaterThan(14 * SUB) // above the tunnel's roof: pressure lifted it
    expect(Math.abs(shaft - lake)).toBeLessThanOrEqual(2 * HEAD_EPS)
    expect(w.bodies.list.length).toBeGreaterThanOrEqual(1)
    expect(w.total()).toBe(total)
  })

  it('a hole under a solid top drains the lake to the hole floor (the 3c checkpoint case)', () => {
    // dam at x = 21 solid to y 24 but a hole at y 10–11, z 5–6; a valley floor at y 2 beyond it, walled at its far end
    const w = layered((x, y, z) => {
      if (y < 2) return STONE
      if (x >= 1 && x <= 20 && z >= 1 && z <= 10) return y < 10 ? STONE : y <= 19 ? wv(7) : AIR
      if (x === 21) return (z === 5 || z === 6) && (y === 10 || y === 11) ? AIR : y <= 24 ? STONE : AIR
      if (x >= 22 && x <= 62 && z >= 1 && z <= 10) return AIR
      return y <= 24 ? STONE : AIR
    }, [64, 32, 32])
    const total = w.total()
    w.settle(120_000)
    let lake = 0
    for (let z = 1; z <= 10; z++) for (let x = 1; x <= 20; x++) lake += w.cols.depth[x + z * 64]!
    expect(lake).toBeLessThan(200 * 2 * SUB) // from 10 blocks deep to the hole's floor (films and a level at the hole's top row aside)
    expect(w.total()).toBe(total)
  })

  it('a sealed full chamber is a body that never moves and costs no step', () => {
    const w = layered((x, y, z) => (y >= 4 && y <= 6 && x >= 3 && x <= 8 && z >= 3 && z <= 8 ? wv(7) : STONE))
    const total = w.total()
    w.settle(50) // the first step groups the body; nothing moves after
    expect(w.bodies.list.length).toBe(1)
    expect(w.bodies.list[0]!.bTile.length).toBe(0)
    expect(w.total()).toBe(total)
    expect(w.segs(5, 5)[0]).toEqual({ floor: 4, ceil: 7, depth: 3 * SUB })
  })

  it('a body draining from below frees its members from the top, each at most once (no flicker)', () => {
    // a full 6 × 6 × 4 tank (cells y 10–13) under a roof, with a one-column drain at its floor into a deep open pit
    const w = layered((x, y, z) => {
      if (y < 2) return STONE
      const tank = x >= 3 && x <= 8 && z >= 3 && z <= 8 && y >= 10 && y <= 13
      if (tank) return wv(7)
      if (x === 9 && z === 5 && y === 10) return AIR // the drain's opening, at the tank's floor
      if (x >= 10 && x <= 20 && z >= 3 && z <= 8 && y >= 2) return AIR // the pit, open to the sky
      return y <= 16 ? STONE : AIR
    })
    const total = w.total()
    const transitions = new Map<number, number>(), was = new Map<number, boolean>()
    w.settle(60_000, 1 << 20, () => {
      for (let i = 0; i < w.under.col.length; i++) {
        if (w.under.col[i]! < 0) continue
        const inBody = w.under.body[i]! >= 0
        if (was.has(i) && was.get(i) !== inBody) transitions.set(i, (transitions.get(i) ?? 0) + 1)
        was.set(i, inBody)
      }
    })
    for (const n of transitions.values()) expect(n).toBeLessThanOrEqual(2)
    expect(w.total()).toBe(total)
  })

  it('excess pushed into a body leaves through its boundary within a few steps, volume exact', () => {
    const w = layered(uTube(true, 19), [64, 32, 32])
    w.settle(60_000)
    const total = w.total()
    const i = w.under.first[30 + 5 * 64]!
    expect(w.under.body[i]).toBeGreaterThanOrEqual(0)
    w.under.excess[i] = SUB
    w.bodies.seed(i)
    w.wakeWet()
    const shaft0 = w.cols.surface(41 + 5 * 64)
    for (let k = 0; k < 40; k++) w.step()
    expect(w.bodies.list.every((b) => b.excess === 0)).toBe(true)
    expect(w.total()).toBe(total + SUB)
    expect(w.cols.surface(41 + 5 * 64)).toBeGreaterThanOrEqual(shaft0)
  })

  it('a body woken on one side wakes the far side: raising the lake lifts the sleeping shaft (Review Focus 2)', () => {
    const w = layered(uTube(true, 19), [64, 32, 32])
    w.settle(60_000)
    expect(w.cols.tiles.awakeCount()).toBe(0)
    const shaftTile = w.cols.tiles.of(41, 5)
    const s0 = w.cols.surface(41 + 5 * 64)
    for (let z = 1; z <= 10; z++) for (let x = 1; x <= 20; x++) w.cols.depth[x + z * 64] = w.cols.depth[x + z * 64]! + SUB / 2
    w.cols.tiles.wake(w.cols.tiles.of(10, 5))
    let woke = false
    for (let k = 0; k < 200; k++) { w.step(); if (w.cols.tiles.awake[shaftTile] === 1) woke = true }
    expect(woke).toBe(true)
    expect(w.cols.surface(41 + 5 * 64)).toBeGreaterThan(s0)
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd packages/engine && npx vitest run test/waterBodies.test.ts`
Expected: FAIL, `Cannot find module '../src/sim/water/bodies.ts'`.

- [ ] **Step 4: Write `bodies.ts`**

```ts
// packages/engine/src/sim/water/bodies.ts
import { damp, moved, type StepHooks, type WaterColumns } from './columns.ts'
import { BISECT_ROUNDS, FLUX_FP, LEAVE, MAX_HEAD, MIN_FLOW, SUB } from './constants.ts'
import type { TileEdges, WaterEdges } from './edges.ts'
import type { UnderSegments } from './under.ts'

/** Connected full lower segments that carry pressure (3d spec §4; plan design notes: Bodies). */
export class Body {
  /** Lower segment indices, in position order (column, then bottom-up). */
  members: number[] = []
  /** Members by ceiling ascending, then position: filled first, so deficits sit at the top. */
  fill: number[] = []
  /** Boundary edges: tile, index in its TileEdges, and +1 when the member is the edge's b (positive flux flows in), −1 when it is a. */
  bTile: number[] = []
  bEdge: number[] = []
  bSide: number[] = []
  /** Tiles of its boundary edges, ascending, once each. */
  tiles: number[] = []
  capSum = 0
  maxCeil = 0
  /** Members whose ceiling is maxCeil: the top layer, which holds the deficit. */
  topCount = 0
  excess = 0
  /** Its level at its last step (1/SUB block). */
  level = 0
  /** The step it last stepped (rebalance runs for those only). */
  stepped = -1
}

/** Rounds a stored flux's share: scaled() of columns.ts, for a body's outflows. */
function scaleFlux(f: number, d: number, out: number): number { return Math.floor(((f >> FLUX_FP) * d) / out) << FLUX_FP }

export class WaterBodies implements StepHooks {
  list: Body[] = []
  private readonly cols: WaterColumns
  private readonly under: UnderSegments
  private readonly edges: WaterEdges
  private seeds: number[] = []
  /** Per lower segment: the search's generation that visited it, and whether it was a member of a body dropped since the last ensure(). */
  private visited = new Int32Array(0)
  private wasMember = new Int32Array(0)
  private gen = 0
  private searching = false

  constructor(cols: WaterColumns, under: UnderSegments, edges: WaterEdges) {
    this.cols = cols
    this.under = under
    this.edges = edges
    cols.hooks(this)
    cols.bodyLevel = (ref) => this.list[under.body[ref - cols.n]!]!.level
  }

  seed(i: number): void { this.seeds.push(i) }

  /** Seeds every full lower segment (after a rebuild from the voxels). */
  seedFull(): void {
    const U = this.under
    for (let c = 0; c < U.n; c++) for (let i = U.first[c]!; i >= 0; i = U.next[i]!) if (U.depth[i]! + U.excess[i]! >= U.cap(i)) this.seeds.push(i)
  }

  filled(i: number): void { this.seeds.push(i) }

  /** Drops body `id`: its members go back to free (seeded, so they regroup at ensure()), its excess to its first member. */
  dropBody(id: number): void {
    const b = this.list[id]
    if (!b) return
    const U = this.under
    this.sizeScratch()
    // Tagged with the generation of the search that regroups them: the current one while searching, else the next.
    const tag = this.searching ? this.gen : this.gen + 1
    for (const m of b.members) { U.body[m] = -1; this.wasMember[m] = tag; this.seeds.push(m) }
    if (b.excess > 0) { U.excess[b.members[0]!] = U.excess[b.members[0]!]! + b.excess; b.excess = 0 }
    b.members = []
  }

  /** Drops every body (a rebuild from the voxels follows; their excess is discarded with the old segments). */
  dropAll(): void {
    for (const b of this.list) for (const m of b.members) this.under.body[m] = -1
    this.list = []
    this.seeds = []
  }

  excessTotal(): number {
    let s = 0
    for (const b of this.list) s += b.excess
    return s
  }

  /** Bodies with a boundary edge in a tile that `stepping` marks (all bodies with a boundary when omitted). */
  activeCount(stepping?: Uint8Array): number {
    let n = 0
    for (const b of this.list) if (b.tiles.length > 0 && (!stepping || b.tiles.some((t) => stepping[t] === 1))) n++
    return n
  }

  /** Regroups bodies: those touched by rebuilt edge lists or by seeds, then a search from the seeds over candidates. */
  ensure(): void {
    const U = this.under, E = this.edges
    this.sizeScratch()
    if (E.rebuilt.length > 0) for (let id = 0; id < this.list.length; id++) {
      const b = this.list[id]!
      if (b.members.length > 0 && b.tiles.some((t) => E.rebuilt.includes(t))) this.dropBody(id)
    }
    for (const s of this.seeds.slice()) if (U.col[s]! >= 0 && U.body[s]! >= 0) this.dropBody(U.body[s]!)
    if (this.seeds.length === 0) { this.compact(); return }
    const gen = ++this.gen, seeds = this.seeds
    this.seeds = []
    this.searching = true
    const fresh: Body[] = []
    for (const s of seeds) {
      if (U.col[s]! < 0 || this.visited[s] === gen || !this.candidate(s, gen)) continue
      const members: number[] = [s]
      this.visited[s] = gen
      for (let q = 0; q < members.length; q++) this.neighbours(members[q]!, gen, members)
      const b = new Body()
      b.members = members
      fresh.push(b)
    }
    this.searching = false
    // Members of kept bodies the search merged were seeded again: drop those already grouped this round.
    this.seeds = this.seeds.filter((m) => U.col[m]! >= 0 && this.visited[m] !== gen)
    this.compact()
    for (const b of fresh) this.list.push(b)
    this.list.sort((p, q) => this.position(p.members[0]!) - this.position(q.members[0]!))
    for (let id = 0; id < this.list.length; id++) for (const m of this.list[id]!.members) U.body[m] = id
    for (const b of fresh) this.finish(b)
  }

  /** Sets every collected boundary edge of each body that has one (plan design notes: Bodies, Step). */
  step(stepping: Uint8Array, gain: number): void {
    const U = this.under, cols = this.cols, no = cols.stepNo, T = cols.tiles
    for (const b of this.list) {
      let active = false
      for (let k = 0; k < b.bTile.length && !active; k++) active = this.edges.tiles[b.bTile[k]!]!.seen[b.bEdge[k]!] === no
      if (!active) continue
      b.stepped = no
      for (const t of b.tiles) if (T.awake[t] === 0) T.wake(t) // pressure reaches every opening: the far side steps next
      let V = b.excess, hiS = -Infinity
      for (const m of b.members) V += U.depth[m]!
      for (let k = 0; k < b.bTile.length; k++) {
        const L = this.edges.tiles[b.bTile[k]!]!, e = b.bEdge[k]!
        if (L.seen[e] !== no) continue
        const s = this.freeSurface(L, e, b.bSide[k]!)
        if (s > hiS) hiS = s
      }
      // Its own water's level: the top layer's surface (rebalance spreads the deficit evenly over that layer).
      const Hb = b.maxCeil * SUB - Math.ceil(Math.max(0, b.capSum - V) / b.topCount)
      const hi = Math.max(Hb, hiS) + MAX_HEAD + 1
      const target = b.excess > 0 ? -b.excess : 0
      let H = Hb
      if (this.inflow(b, Hb, gain, false) > target) {
        if (this.inflow(b, hi, gain, false) > target) H = hi
        else {
          let lo = Hb, up = hi
          for (let r = 0; r < BISECT_ROUNDS && up - lo > 1; r++) {
            const mid = lo + Math.floor((up - lo) / 2)
            if (this.inflow(b, mid, gain, false) <= target) up = mid
            else lo = mid
          }
          H = up
        }
      }
      this.inflow(b, H, gain, true)
      b.level = H
      // A body never sends more than it holds.
      let out = 0
      for (let k = 0; k < b.bTile.length; k++) {
        const L = this.edges.tiles[b.bTile[k]!]!, e = b.bEdge[k]!
        if (L.seen[e] !== no) continue
        const into = b.bSide[k]! > 0 ? moved(L.flux[e]!) : -moved(L.flux[e]!)
        if (into < 0) out -= into
      }
      if (out > V) for (let k = 0; k < b.bTile.length; k++) {
        const L = this.edges.tiles[b.bTile[k]!]!, e = b.bEdge[k]!, f = L.flux[e]!
        if (L.seen[e] !== no) continue
        const sends = b.bSide[k]! > 0 ? f < 0 : f > 0
        if (sends) L.flux[e] = f > 0 ? scaleFlux(f, V, out) : -scaleFlux(-f, V, out)
      }
    }
  }

  /**
   * After the transfer: each stepped body fills its members layer by layer, lowest ceiling first. The layer the water runs
   * out in shares its deficit evenly (an even surface: its members leave together, never one at a time to be refilled by
   * the rest); layers above it are emptied. What is left over is excess. A member past LEAVE is seeded to leave.
   */
  rebalance(): void {
    const U = this.under, no = this.cols.stepNo, T = this.cols.tiles, sx = this.cols.sx
    const set = (m: number, d: number) => {
      if (U.depth[m] === d) return
      U.depth[m] = d
      const c = U.col[m]!
      T.dirty[T.of(c % sx, Math.floor(c / sx))] = 1
    }
    for (const b of this.list) {
      if (b.stepped !== no) continue
      let rest = b.excess
      for (const m of b.members) rest += U.depth[m]!
      for (let k = 0; k < b.fill.length;) {
        const ce = U.ceil[b.fill[k]!]!, j0 = k
        let gcap = 0
        while (k < b.fill.length && U.ceil[b.fill[k]!] === ce) gcap += U.cap(b.fill[k++]!)
        if (rest >= gcap) { for (let j = j0; j < k; j++) set(b.fill[j]!, U.cap(b.fill[j]!)); rest -= gcap; continue }
        // The deficit gcap − rest spread evenly; a member too shallow for its share is emptied and the others take the rest.
        let def = gcap - rest, cnt = k - j0
        const order = b.fill.slice(j0, k).sort((p, q) => U.cap(p) - U.cap(q) || this.position(p) - this.position(q))
        for (const m of order) {
          const dm = Math.min(U.cap(m), Math.ceil(def / cnt))
          set(m, U.cap(m) - dm)
          def -= dm
          cnt--
        }
        rest = 0
      }
      b.excess = rest
      for (const m of b.members) if (U.cap(m) - U.depth[m]! > LEAVE) this.seeds.push(m)
      if (b.excess > 0) for (const t of b.tiles) if (T.awake[t] === 0) T.wake(t)
    }
  }

  mixState(mix: (v: number) => void): void {
    mix(this.list.length)
    for (const b of this.list) {
      mix(b.members.length); mix(b.excess); mix(b.level)
      for (const m of b.members) mix(this.position(m))
    }
  }

  /**
   * Net water (1/SUB block, moved as transfer will move it) the body takes in through its collected boundary edges at level
   * H; `store` writes those fluxes. A boundary edge is accelerated as 3c's with H as the member side's surface: the body
   * sends only while H is above the opening's floor; a free side sends only at least MIN_FLOW deep and above it.
   */
  private inflow(b: Body, H: number, gain: number, store: boolean): number {
    const cols = this.cols, U = this.under, n = cols.n, no = cols.stepNo
    let net = 0
    for (let k = 0; k < b.bTile.length; k++) {
      const L = this.edges.tiles[b.bTile[k]!]!, e = b.bEdge[k]!
      if (L.seen[e] !== no) continue
      const side = b.bSide[k]!, free = side > 0 ? L.a[e]! : L.b[e]!, lo = L.lo[e]! * SUB
      const df = free < n ? cols.depth[free]! : U.depth[free - n]!
      const sf = (free < n ? cols.floor[free]! : U.floor[free - n]!) * SUB + df
      let h = side > 0 ? sf - H : H - sf
      if (h > MAX_HEAD) h = MAX_HEAD
      else if (h < -MAX_HEAD) h = -MAX_HEAD
      let f = damp(L.flux[e]!) + h * gain
      if (f !== 0) {
        const freeSends = (f > 0) === (side > 0)
        if (freeSends ? df < MIN_FLOW || sf <= lo : H <= lo) f = 0
      }
      if (store) L.flux[e] = f
      net += side > 0 ? moved(f) : -moved(f)
    }
    return net
  }

  /** The surface of the free side of a boundary edge. */
  private freeSurface(L: TileEdges, e: number, side: number): number {
    const cols = this.cols, U = this.under, n = cols.n, free = side > 0 ? L.a[e]! : L.b[e]!
    return free < n ? cols.surface(free) : U.surface(free - n)
  }

  /** A lower segment that joins a body: full (excess counts), or one dropped from a body this round still within LEAVE. */
  private candidate(i: number, gen: number): boolean {
    const U = this.under
    if (U.depth[i]! + U.excess[i]! >= U.cap(i)) return true
    return this.wasMember[i] === gen && U.cap(i) - U.depth[i]! <= LEAVE
  }

  /** Adds the candidate lower segments overlapping i in its 4 neighbour columns; a member of a kept body drops it (merge). */
  private neighbours(i: number, gen: number, out: number[]): void {
    const U = this.under, cols = this.cols, sx = cols.sx, sz = cols.sz, c = U.col[i]!, x = c % sx, z = (c - x) / sx
    const f = U.floor[i]!, ce = U.ceil[i]!
    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0), nz = z + (d === 2 ? 1 : d === 3 ? -1 : 0)
      if (nx < 0 || nz < 0 || nx >= sx || nz >= sz) continue
      const nc = nx + nz * sx
      for (let j = U.first[nc]!; j >= 0; j = U.next[j]!) {
        if (U.floor[j]! >= ce || U.ceil[j]! <= f || this.visited[j] === gen) continue
        if (U.body[j]! >= 0) this.dropBody(U.body[j]!)
        if (!this.candidate(j, gen)) continue
        this.visited[j] = gen
        out.push(j)
      }
    }
  }

  /** Fill order, capacity, excess and boundary edges of a new body. */
  private finish(b: Body): void {
    const U = this.under, cols = this.cols, n = cols.n, sx = cols.sx, T = cols.tiles, E = this.edges
    b.members.sort((p, q) => this.position(p) - this.position(q))
    b.fill = b.members.slice().sort((p, q) => U.ceil[p]! - U.ceil[q]! || this.position(p) - this.position(q))
    b.capSum = 0; b.maxCeil = 0; b.excess = 0; b.topCount = 0
    for (const m of b.members) {
      b.capSum += U.cap(m)
      if (U.ceil[m]! > b.maxCeil) b.maxCeil = U.ceil[m]!
      b.excess += U.excess[m]!
      U.excess[m] = 0
    }
    for (const m of b.members) if (U.ceil[m] === b.maxCeil) b.topCount++
    const id = U.body[b.members[0]!]!
    const tiles = new Set<number>()
    for (const m of b.members) {
      const c = U.col[m]!, x = c % sx, z = (c - x) / sx
      tiles.add(T.of(x, z))
      if (x > 0) tiles.add(T.of(x - 1, z))
      if (z > 0) tiles.add(T.of(x, z - 1))
    }
    const sorted = [...tiles].sort((p, q) => p - q)
    const inBody = (ref: number) => ref >= n && U.body[ref - n] === id
    for (const t of sorted) {
      const L = E.tiles[t]
      if (!L) continue
      for (let e = 0; e < L.count; e++) {
        const ia = inBody(L.a[e]!), ib = inBody(L.b[e]!)
        if (ia && ib) { L.flux[e] = 0; continue } // inside the body: nothing flows
        if (ia === ib) continue
        b.bTile.push(t); b.bEdge.push(e); b.bSide.push(ib ? 1 : -1)
      }
    }
    b.tiles = [...new Set(b.bTile)].sort((p, q) => p - q)
    b.level = b.maxCeil * SUB
    if (b.excess > 0) for (const t of b.tiles) if (T.awake[t] === 0) T.wake(t)
  }

  /** A lower segment's position: column, then floor (never its pool index). */
  private position(i: number): number { return this.under.col[i]! * 65536 + this.under.floor[i]! }

  /** Removes emptied bodies and renumbers members. */
  private compact(): void {
    const U = this.under
    this.list = this.list.filter((b) => b.members.length > 0)
    for (let id = 0; id < this.list.length; id++) for (const m of this.list[id]!.members) U.body[m] = id
  }

  private sizeScratch(): void {
    const m = this.under.col.length
    if (this.visited.length >= m) return
    const v = new Int32Array(m); v.set(this.visited); this.visited = v
    const w = new Int32Array(m); w.set(this.wasMember); this.wasMember = w
  }
}
```

Notes for the implementer:
- `dropBody` tags the members it frees with the generation of the search that regroups them. A member within `LEAVE` of full stays a candidate there, so a body merging with another never loses a slightly drained member.
- `ensure` drops the bodies of seeds that are members, so a seed always restarts its body's grouping from scratch.
- An edge between two members carries nothing (`finish` and `accelerateUnderAll` zero it), so a resting body never keeps its tile awake with stale flux.

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd packages/engine && npx vitest run test/waterBodies.test.ts test/waterUnderStep.test.ts`
Expected: PASS.

If the U-tube test sways without settling, check that a body's level stays the smallest H with N(H) ≤ T. A larger H overshoots and rings. Report the measured settle steps in the commit message body.

- [ ] **Step 6: Run every engine test and the types**

Run: `cd packages/engine && npx vitest run && cd ../.. && npm run typecheck`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/sim/water/bodies.ts packages/engine/test/layerHelpers.ts packages/engine/test/waterBodies.test.ts
git commit -m "feat(sim): full lower segments form bodies that carry pressure: communicating vessels"
```

---

### Task 7: The water system runs on segments

**Files:**
- Modify: `packages/engine/src/sim/water/waterSystem.ts`
- Modify: `packages/engine/src/sim/water/cycle.ts` (springs feed lower segments)
- Modify: `packages/engine/src/sim/water/rebuild.ts` (delete `rebuildColumns` and `OVERHANG`'s use)
- Modify: `packages/engine/src/sim/water/constants.ts` (delete `OVERHANG`)
- Delete: `packages/engine/src/sim/water/edits.ts`, `packages/engine/test/waterEdits.test.ts`
- Test:
  - create `packages/engine/test/waterLayersWorld.test.ts`;
  - modify `packages/engine/test/waterWorld.test.ts`, `waterRebuild.test.ts`, `waterCycle.test.ts`.

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces on `WaterSystem`:
  - `under`, `edges`, `bodies`;
  - `segments(x, z): { floor: number; ceil: number; depth: number; body: number }[]` (bottom-up, the top last with `ceil` = height and body −1);
  - `stats(): { tiles; columns; bodies }`;
  - `rebuildChunkColumns` still returns `number[]`, always `[]` now (Task 8 removes the remesh plumbing).
- Produces on `WaterCycle`: `runSprings(cols, under, layout, get, source, filled)`.

- [ ] **Step 1: Write the failing world tests**

```ts
// packages/engine/test/waterLayersWorld.test.ts
import { describe, expect, it } from 'vitest'
import { HEAD_EPS, SUB } from '../src/sim/water/constants.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, lake, run, settle, spring, w, waterSim, type Fill } from './waterHelpers.ts'

/** Stone below y 10; a lake (x 1–10, z 1–10) of water y 10–15 (surface 16) in a basin walled to y 20; a hill to y 20 elsewhere. */
const hillLake: Fill = (x, y, z) => {
  if (y < 10) return B.stone
  if (x >= 1 && x <= 10 && z >= 1 && z <= 10) return y <= 15 ? w(7) : AIR
  return y <= 20 ? B.stone : AIR
}

describe('water in layers', () => {
  it('a bridge built over a lake splits its columns: the lake runs on under it, the top is the deck', () => {
    const sim = waterSim(lake(4, 12, 12), { water: { debug: true } })
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 6, 5], voxel: B.stone })
    sim.step()
    expect(sim.water.segments(5, 5)).toEqual([
      { floor: 1, ceil: 6, depth: 4 * SUB, body: -1 }, { floor: 7, ceil: 32, depth: 0, body: -1 },
    ])
    expect(sim.water.check()).toEqual([])
  })

  it('a hole dug through a dam under a solid top drains the lake (the 3c checkpoint case)', () => {
    // the dam is the stone row x = 11; the valley (x 12–30, air from y 2) lies beyond it: open the dam's hole at y 10–11, z 5–6
    const sim = waterSim((x, y, z) => (x >= 12 && x <= 30 && z >= 1 && z <= 10 && y >= 2 && y <= 20 ? AIR : hillLake(x, y, z)), { water: { debug: true } })
    const total = sim.water.total()
    sim.submit(0, 0, { type: 'fillRegion', min: [11, 10, 5], max: [11, 11, 6], voxel: AIR })
    settle(sim, 60_000)
    let lakeDepth = 0
    for (let z = 1; z <= 10; z++) for (let x = 1; x <= 10; x++) lakeDepth += sim.water.column(x, z).depth
    expect(lakeDepth).toBeLessThan(100 * SUB) // was 600 blocks; drains to the hole's floor (y 10, the lake's own floor)
    expect(sim.water.total()).toBe(total)
    expect(sim.water.check()).toEqual([])
  })

  it('digging a tunnel from the lake to a shaft fills it and the shaft rises to the lake level (U-tube)', () => {
    // shaft at x 22–23, z 5–6, open from y 11 up; the tunnel (y 11–12, z 5–6) is dug from x 11 to x 21
    const sim = waterSim((x, y, z) => (x >= 22 && x <= 23 && z >= 5 && z <= 6 && y >= 11 ? AIR : hillLake(x, y, z)), { water: { debug: true } })
    const total = sim.water.total()
    sim.submit(0, 0, { type: 'fillRegion', min: [11, 11, 5], max: [21, 12, 6], voxel: AIR })
    settle(sim, 60_000)
    const lakeS = sim.water.column(5, 5).surface, shaftS = sim.water.column(22, 5).surface
    expect(shaftS).toBeGreaterThan(13 * SUB) // above the tunnel's roof
    expect(Math.abs(shaftS - lakeS)).toBeLessThanOrEqual(2 * HEAD_EPS)
    expect(sim.water.stats().bodies).toBeGreaterThanOrEqual(0)
    expect(sim.water.total()).toBe(total)
  })

  it('a hole through the roof of a dry cave under a shallow lake pours the lake into the cave', () => {
    // a cave (y 2–7) under x 1–10, z 1–10, roof y 8–9, the lake's floor at y 10
    const sim = waterSim((x, y, z) => (x >= 1 && x <= 10 && z >= 1 && z <= 10 && y >= 2 && y <= 7 ? AIR : hillLake(x, y, z)), { water: { debug: true } })
    const total = sim.water.total()
    expect(sim.water.segments(5, 5)[0]).toEqual({ floor: 2, ceil: 8, depth: 0, body: -1 })
    sim.submit(0, 0, { type: 'fillRegion', min: [5, 8, 5], max: [5, 9, 5], voxel: AIR })
    settle(sim, 60_000)
    let cave = 0
    for (let z = 1; z <= 10; z++) for (let x = 1; x <= 10; x++) cave += sim.water.segments(x, z)[0]!.depth
    expect(cave).toBeGreaterThan(400 * SUB) // the cave (600 blocks) took most of the lake (600 blocks)
    expect(sim.water.total()).toBe(total)
  })

  it('a slab built bottom-up by one fillRegion mid-lake traps the water under it as a full lower segment (Review Focus 1)', () => {
    const sim = waterSim(lake(6, 22, 8), { water: { debug: true } })
    sim.setPaused(true)
    const total = sim.water.total()
    sim.submit(0, 0, { type: 'fillRegion', min: [8, 3, 8], max: [13, 4, 13], voxel: B.stone })
    sim.step()
    expect(sim.water.total()).toBe(total)
    expect(sim.water.check()).toEqual([])
    const s = sim.water.segments(10, 10)
    expect(s[0]).toMatchObject({ floor: 1, ceil: 3, depth: 2 * SUB })
    expect(s[s.length - 1]!.floor).toBe(5)
    sim.setPaused(false)
    run(sim, 3)
    expect(sim.water.segments(10, 10)[0]!.body).toBeGreaterThanOrEqual(0) // full: grouped into a body
  })

  it('sand landing in a cave pool raises it by its volume, never past the roof', () => {
    // a cave pool (y 2–3 water, roof at y 6) with a shaft above (5, 5) open to the sky
    const sim = waterSim((x, y, z) => {
      if (y < 2) return B.stone
      const cave = x >= 1 && x <= 10 && z >= 1 && z <= 10 && y <= 5
      if (cave) return y <= 3 ? w(7) : AIR
      if (x === 5 && z === 5 && y >= 6) return AIR
      return y <= 12 ? B.stone : AIR
    }, { water: { debug: true } })
    const total = sim.water.total()
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 20, 5], voxel: B.sand })
    settle(sim, 20_000)
    expect(sim.store.getVoxel(5, 2, 5)).toBe(B.sand)
    expect(sim.water.total()).toBe(total)
    expect(sim.water.check()).toEqual([])
  })

  it('a spring under a cave feeds the cave segment resting on it, at most its room', () => {
    const sim = waterSim((x, y, z) => {
      if (x === 5 && z === 5 && y === 1) return spring(15) // 2048 sub per step: fills the 200-block cave in ~25 steps
      if (y < 2) return B.stone
      return x >= 1 && x <= 10 && z >= 1 && z <= 10 && y <= 3 ? AIR : B.stone
    })
    run(sim, 2000)
    for (let z = 1; z <= 10; z++) for (let x = 1; x <= 10; x++) {
      const seg = sim.water.segments(x, z)[0]!
      expect(seg.depth).toBeLessThanOrEqual(2 * SUB)
    }
    expect(sim.water.segments(5, 5)[0]!.depth).toBeGreaterThan(0)
    expect(sim.water.total()).toBe(sim.water.expected)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/engine && npx vitest run test/waterLayersWorld.test.ts`
Expected: FAIL, `sim.water.segments is not a function`.

- [ ] **Step 3: Springs feed any segment**

In `packages/engine/src/sim/water/cycle.ts`, give `runSprings` the lower segments and a callback for a segment it fills. Replace the method with:

```ts
  /**
   * Each spring adds its rate to the segment resting on it (its floor is the spring's top: the top segment or a lower one,
   * plan decision 10), at most what the sea holds when the world has a sea level, and at most a lower segment's room; the
   * sea pays for it. `filled(i)` hears of a lower segment it filled. A position that no longer holds a spring is forgotten.
   */
  runSprings(cols: WaterColumns, under: UnderSegments, layout: Layout, get: (x: number, y: number, z: number) => number, source: Uint8Array,
    filled: (i: number) => void): void {
    for (const s of this.springs) {
      const [x, y, z] = layout.voxelCoords(s)
      const v = get(x, y, z)
      if (source[v & 0xfff] !== 1) { this.springs.delete(s); continue }
      const c = x + z * cols.sx
      let low = -1
      if (cols.floor[c] !== y + 1) {
        for (let i = under.first[c]!; i >= 0; i = under.next[i]!) if (under.floor[i] === y + 1) { low = i; break }
        if (low < 0) continue
      }
      let rate = SPRING_RATES[(v >>> 12) & 15]! * SPRING_SCALE
      if (this.seaLevel > 0) rate = Math.min(rate, Math.max(0, this.sea))
      if (low >= 0) rate = Math.min(rate, Math.max(0, under.cap(low) - under.depth[low]!))
      if (rate <= 0) continue
      if (low < 0) cols.depth[c] = cols.depth[c]! + rate
      else {
        under.depth[low] = under.depth[low]! + rate
        if (under.depth[low]! >= under.cap(low)) filled(low)
      }
      this.sea -= rate
      cols.tiles.wake(cols.tiles.of(x, z))
    }
  }
```

Add `import type { UnderSegments } from './under.ts'`. In `waterCycle.test.ts`, pass `new UnderSegments(cols.n)` and `() => {}` at every `runSprings` call. Their expectations are unchanged: those springs feed top segments.

- [ ] **Step 4: Wire the segments into `WaterSystem`**

In `packages/engine/src/sim/water/waterSystem.ts`:

(a) Imports:
- remove `applyEdit, type ColumnCells, type EditColumn` and `rebuildColumns`;
- add:

```ts
import { WaterBodies } from './bodies.ts'
import { WaterEdges } from './edges.ts'
import { mirrorRun } from './mirror.ts'
import { rebuildSegments, waterKinds } from './rebuild.ts'
import { resegment, type Seg } from './resegment.ts'
import { UnderSegments } from './under.ts'
```

(b) Fields:
- add `readonly under: UnderSegments`, `readonly edges: WaterEdges`, `readonly bodies: WaterBodies` and `private readonly segScratch: Seg[] = []`;
- replace `private readonly edit: EditColumn …` and `private readonly cells: ColumnCells` with:

```ts
  /** KIND of cell y of the column being edited (ex, ez), as the store holds it after the write. */
  private readonly kindAt: (y: number) => number
```

- change `pending`'s value type to `{ f0: number; s0: number; vol: number }`;
- remove `private built = false`.

(c) Constructor: after `this.cols.floor.fill(0)`:

```ts
    this.under = new UnderSegments(sx * sz)
    this.edges = new WaterEdges(this.cols.tiles.count)
    this.cols.attach(this.under, this.edges, this.height)
    this.bodies = new WaterBodies(this.cols, this.under, this.edges)
```

Replace the `this.cells = { … }` block with:

```ts
    this.kindAt = (y) => sys.kind[voxelId(port.get(sys.ex, y, sys.ez))]!
```

(d) `onWrite`: replace everything after the "wall for wall" early return with:

```ts
    const cols = this.cols, U = this.under, c = x + z * cols.sx, T = cols.tiles
    // A body holding a segment of this column regroups after the edit; its excess goes back to its members first.
    for (let i = U.first[c]!; i >= 0; i = U.next[i]!) if (U.body[i]! >= 0) this.bodies.dropBody(U.body[i]!)
    const old = this.segScratch
    old.length = 0
    for (let i = U.first[c]!; i >= 0; i = U.next[i]!) old.push({ floor: U.floor[i]!, ceil: U.ceil[i]!, depth: U.depth[i]! + U.excess[i]!, id: i })
    const f0 = cols.floor[c]!, d0 = cols.depth[c]!
    old.push({ floor: f0, ceil: this.height, depth: d0, id: -2 })
    this.ex = x
    this.ez = z
    const r = resegment(old, this.height, this.kindAt, y, ok, nk, nk === KIND.WATER ? (voxelState(v) & 7) + 1 : 0)
    const runs = r.runs, top = runs[runs.length - 1]!
    if (runs.length === old.length && runs.every((q, k) => q.floor === old[k]!.floor && q.ceil === old[k]!.ceil && q.depth === old[k]!.depth)) {
      // No segment changed, but a cell did (a stray water voxel, a removed block in the water): re-mirror the segment holding it.
      if (y >= f0) this.mirror.touch(c, y)
      for (let i = U.first[c]!; i >= 0; i = U.next[i]!) if (y >= U.floor[i]! && y < U.ceil[i]!) U.mirrorQ[i] = ~(U.ceil[i]! * 8)
      T.dirty[T.of(x, z)] = 1
      return
    }
    let before = 0, after = 0
    for (const s of old) before += s.depth
    for (const q of runs) after += q.depth
    this.expected += after - before
    cols.floor[c] = top.floor
    cols.depth[c] = top.depth
    // The top's mirror rewrites from its floor: cells below a split belong to the lower run now (never cleared as 3c's push-up did).
    this.mirror.lo[c] = top.floor
    this.mirror.touch(c, Math.max(y, top.floor))
    const kept = new Set<number>(), chain: number[] = []
    for (let k = 0; k < runs.length - 1; k++) {
      const q = runs[k]!
      let i = q.id
      if (i >= 0) { U.floor[i] = q.floor; U.ceil[i] = q.ceil; kept.add(i) } else i = U.alloc(c, q.floor, q.ceil, 0)
      const cap = (q.ceil - q.floor) * SUB
      U.depth[i] = Math.min(q.depth, cap)
      U.excess[i] = Math.max(0, q.depth - cap)
      U.mirrorLo[i] = q.floor
      U.mirrorQ[i] = ~(q.ceil * 8)
      chain.push(i)
      if (q.depth >= cap) this.bodies.seed(i)
    }
    for (const s of old) if (s.id >= 0 && !kept.has(s.id)) U.release(s.id)
    U.setChain(c, chain)
    T.dirty[T.of(x, z)] = 1
    if (this.wetAround(x, z)) T.wakeAround(x, z)
    this.edges.markColumn(x, z, cols)
    if (top.floor !== f0) this.floorMoved(x, z, c, f0, top.floor)
    for (const i of chain) this.springAt(x, U.floor[i]! - 1, z)
    // Water a wall displaced in the top segment spreads before the next step (3c's spreadDisplaced; plan decision 8).
    if (r.topDisplaced > 0) {
      const e = this.pending.get(c)
      if (e) e.vol += r.topDisplaced
      else this.pending.set(c, { f0: y, s0: f0 * SUB + d0, vol: r.topDisplaced })
    }
```

(e) `spreadDisplaced`: the volume a source spreads is now what its walls displaced, not its floor's rise. Replace the line computing `vol`:

```ts
      const vol = Math.min(depth[c]!, e.vol)
```

Update its doc comment: "Each source column displaced `vol` (what resegment reported for the walls placed in its top segment since the last spread), at most its depth."

(f) `step`:
- call `cy.runSprings(this.cols, this.under, this.layout, this.get, this.port.registry.source, (i) => this.bodies.seed(i))`;
- in the debug check branch, nothing changes;
- the edges and bodies ensure themselves inside `cols.step`.

(g) `flush`: in the per-column loop, after `mirror.flush(…)`, add:

```ts
        for (let i = U.first[c]!; i >= 0; i = U.next[i]!) mirrorRun(U.mirrorLo, U.mirrorQ, i, x, z, U.floor[i]!, U.ceil[i]!, U.depth[i]!, this.water, this.kind, this.get, this.set)
```

Declare `const U = this.under` next to the other locals.

(h) `check`: add, before the identity check:

```ts
    const U = this.under
    for (let c = 0; c < this.cols.n && out.length < 3; c++) for (let i = U.first[c]!; i >= 0; i = U.next[i]!) {
      if (U.depth[i]! < 0 || U.depth[i]! > U.cap(i)) out.push(`lower segment ${i} (column ${c}) has depth ${U.depth[i]} of ${U.cap(i)}`)
      if (U.excess[i]! < 0) out.push(`lower segment ${i} has excess ${U.excess[i]}`)
    }
    for (const b of this.bodies.list) if (b.excess < 0) out.push(`a body has excess ${b.excess}`)
```

(i) `rebuild`:

```ts
  /** Drops all water state and rebuilds every segment from the voxels (generation, recovery). There is no static water left to remesh. */
  rebuild(): void {
    this.needsRebuild = false
    this.pending.clear()
    if (this.water === 0) return
    const [sx, , sz] = this.layout.size, cols = this.cols, cy = this.cycle
    cols.tiles.clear()
    cy.springs.clear()
    this.bodies.dropAll()
    rebuildSegments(this.port.store, this.kind, cols, this.under, this.mirror, 0, 0, sx, sz)
    this.edges.markAll()
    this.bodies.seedFull()
    this.findSprings(0, 0, sx, sz)
    cy.findSea(cols)
    cy.sea = cy.seaDepth(cols)
    this.wakeUnsettled(0, 0, sx, sz)
    cols.tiles.dirty.fill(1)
    this.expected = this.total()
  }
```

(j) `rebuildChunkColumns`: replace the `remesh` set, the `moved` callback and the `rebuildColumns` call with:

```ts
    this.bodies.dropAll()
    for (const [cx, cz] of ccs) {
      rebuildSegments(this.port.store, this.kind, cols, this.under, this.mirror, cx * 32, cz * 32, cx * 32 + 32, cz * 32 + 32)
      this.findSprings(cx * 32, cz * 32, cx * 32 + 32, cz * 32 + 32)
      for (let z = cz * 32; z < cz * 32 + 32; z++) for (let x = cx * 32; x < cx * 32 + 32; x++) this.edges.markColumn(x, z, cols)
    }
    this.bodies.seedFull()
```

It returns `[]`. Keep the doc comment's first sentence; replace the remesh sentence with "No chunk needs a remesh: water is never meshed (3d)".

(k) `dropAll` keeps excess. Replace `WaterBodies.dropAll` (Task 6) with:

```ts
  /** Drops every body, handing each one's excess back to its first member; a full rebuild then frees those segments anyway. */
  dropAll(): void {
    for (let id = 0; id < this.list.length; id++) this.dropBody(id)
    this.list = []
    this.seeds = []
  }
```

(l) Helpers:

```ts
  /** Column (x, z) bottom-up: its lower segments, then its top (ceil = the world's height, body −1). For tests and tools. */
  segments(x: number, z: number): { floor: number; ceil: number; depth: number; body: number }[] {
    const U = this.under, c = x + z * this.cols.sx, out: { floor: number; ceil: number; depth: number; body: number }[] = []
    for (let i = U.first[c]!; i >= 0; i = U.next[i]!) out.push({ floor: U.floor[i]!, ceil: U.ceil[i]!, depth: U.depth[i]!, body: U.body[i]! })
    out.push({ floor: this.cols.floor[c]!, ceil: this.height, depth: this.cols.depth[c]!, body: -1 })
    return out
  }

  /** Awake tiles, the wet segments in them, and the bodies with a boundary in an awake tile. */
  stats(): { tiles: number; columns: number; bodies: number } {
    const T = this.cols.tiles
    return { tiles: T.awakeCount(), columns: this.cols.wetAwake(), bodies: this.bodies.activeCount(T.awake) }
  }
```

`wetAround` also looks at lower segments:

```ts
  /** Whether a segment of column (x, z) or of one of its four neighbours holds water: only then can an edit there move any. */
  private wetAround(x: number, z: number): boolean {
    const { sx, sz } = this.cols
    const wet = (c: number) => {
      if (this.cols.depth[c]! > 0) return true
      for (let i = this.under.first[c]!; i >= 0; i = this.under.next[i]!) if (this.under.depth[i]! > 0) return true
      return false
    }
    const c = x + z * sx
    return wet(c) || (x > 0 && wet(c - 1)) || (x + 1 < sx && wet(c + 1)) || (z > 0 && wet(c - sx)) || (z + 1 < sz && wet(c + sx))
  }
```

The other helpers:
- `findSprings` checks every segment's floor: after the top's `springAt`, loop the column's chain and call `this.springAt(x, U.floor[i]! - 1, z)`;
- `wakeUnsettled` also wakes the tile of any column with a lower segment holding at least `MIN_FLOW`;
- `floorMoved` drops its static-water remesh line;
- `waterChunks` is deleted.

- [ ] **Step 5: Delete the 3c-only code**

- In `rebuild.ts`, delete `rebuildColumns` and the `OVERHANG` import.
- Delete `OVERHANG` from `constants.ts`.
- Delete `edits.ts` and `test/waterEdits.test.ts`. Their cases are `resegment.test.ts` now.

In `test/waterRebuild.test.ts`:
- `world()` calls `rebuildSegments` with a fresh `UnderSegments`;
- delete "looks through a thin floating run (a bridge) but not through a thick roof" (Task 4's bridge test covers it);
- delete "reports the floors that moved…" (there is no `moved` callback);
- the others keep their expectations: they read top segments.

- [ ] **Step 6: Rewrite the 3c world tests whose meaning changed (plan decision 16)**

In `packages/engine/test/waterWorld.test.ts`, change exactly these tests, keeping every other assertion:

| Test (3c title) | New title | New expectations |
|---|---|---|
| "a wall dropped into the water pushes the water trapped under it up" | "a wall dropped mid-water keeps the water under it and displaces only its own cell" | `column(5, 5).floor` 3; `segments(5, 5)[0]` is `{ floor: 1, ceil: 2, depth: SUB, body: -1 }`; `getVoxel(5, 1, 5) & 0xfff` is `B.water`; `surfaceSum(…) − s0` is `SUB`; `total()` is `LAKE` |
| "digging out a floor drops it to the next wall, and static water on the way joins the column" | "digging down into a water pocket merges it into the column" | before the dig, `segments(5, 5)[0]` is `{ floor: 3, ceil: 4, depth: SUB, body: expect.any(Number) }` and `expected` is `SUB`; after it, the same `{ floor: 3, depth: SUB }` as before |
| "a block above the surface is a bridge: the floor stays, …" | "a block above the surface splits the column: the lake runs on under it, rising water never overwrites it, …" | `column(5, 5).floor` is 7 after the first step, and `segments(5, 5)[0]` is `{ floor: 1, ceil: 6, depth: 4 * SUB, body: -1 }`; the rest unchanged |
| "a floor dug out over static water remeshes the chunk that water is in, even with no write there" | "digging the roof over a cave pool merges it into the column; water is never meshed" | `segments(5, 5)[0]` is `{ floor: 25, ceil: 33, depth: 7 * SUB, … }` and `expected` is `7 * SUB` before; after the dig, `column(5, 5)` is `{ floor: 25, depth: 7 * SUB }`; drop the `markDirty` spy and the `dirtyChunks` assertion |
| "a regenerated region remeshes the chunks whose static water became the heightfield's" | "a regenerated region rebuilds its segments; nothing is static" | `expected` is `7 * SUB` before; after `replaceColumns`, `column(5, 5)` is `{ floor: 25, depth: 7 * SUB }` and `expected` is `7 * SUB`; drop the `out` assertion |
| "a healing rebuild remeshes the chunks whose static water became the heightfield's" | "a healing rebuild reads the cave pool as segments" | after the heal, `column(5, 5)` is `{ floor: 25, depth: 7 * SUB }`; drop the `dirtyChunks` assertion |
| "filling the gap under a floating block merges them into the floor: water never crosses the dam" | unchanged | the first assertion becomes `expect(sim.water.segments(9, 5)).toEqual([{ floor: 2, ceil: 3, depth: 0, body: -1 }, { floor: 5, ceil: 32, depth: 0, body: -1 }])` |
| "while paused, edits change the columns exactly …" | unchanged | the comment reads "the wall displaced 1 block of water: 16 columns around take 1/16 block each, the wall's own column too"; `getVoxel(5, 1, 5) & 0xfff` is `B.water` (the trapped cell stays); the rest unchanged |
| "a block floating in the water pushes only the trapped water, and that spreads too" | "a block floating in the water keeps the water under it and spreads only its own cell" | add `expect(sim.water.segments(10, 10)[0]).toMatchObject({ floor: 1, ceil: 3, depth: 2 * SUB })` |
| "a block filling the top water cell leaves no pillar either: the whole column is spread" | "a block filling the top water cell traps the water under it and spreads only its cell" | add `expect(sim.water.segments(10, 10)[0]).toMatchObject({ floor: 1, ceil: 4, depth: 3 * SUB })` |
| `apps/sandbox/test/flood.test.ts` › "rebuilds the lake, the sea and the spring…": `column(70, 70)` has floor `LAKE.floor` | unchanged | `expect(sim.water.segments(70, 70)[0]).toMatchObject({ floor: LAKE.floor, ceil: PILLARS[1].base, depth: (LAKE.top + 1 - LAKE.floor) * SUB })`, with the comment "the pillar's planks over the lake split its column: the lake runs on under them" |

Run `npx vitest run test/waterWorld.test.ts` after each change.

If a test outside this table fails, read it. A failure that encodes 3c's push-up, `OVERHANG` or static-water semantics goes into this table, with the new expectation derived from the spec's §5 table. Any other failure is a 3d bug: fix the code.

- [ ] **Step 7: Run every test and the types**

Run: `npm test && npm run typecheck` at the repo root. This includes the sandbox's `flood.test.ts`.
Expected: green.

If `determinism.test.ts`'s pinned hashes changed only because `mixState` now mixes the lower segments, update the pins in this commit and say so in its message.

- [ ] **Step 8: Commit**

```bash
git add -A packages/engine/src/sim/water packages/engine/test
git commit -m "feat(sim): the water system runs on segments: edits resegment, lower segments step, mirror and rebuild, bodies"
```

---

### Task 8: Water is never meshed; the static-water plumbing goes

**Files:**
- Modify: `packages/engine/src/mesh/liquid.ts`
- Modify: `packages/engine/src/sim/water/waterSystem.ts` (`WaterPort.remesh`, `rebuildChunkColumns`'s return)
- Modify: `packages/engine/src/sim/simulation.ts`
- Test: `packages/engine/test/liquid.test.ts`

**Interfaces:**
- `WaterPort` loses `remesh`.
- `WaterSystem.rebuildChunkColumns(ccs): void`.
- The mesher skips every simulated-water voxel of a column whose floor is not `NO_FLOOR`.

- [ ] **Step 1: Rewrite the static-water mesher test**

In `packages/engine/test/liquid.test.ts`, replace the `describe('static and simulated water', …)` test "leaves water at or above its column's floor to the heightfield and meshes the static water below it" with:

```ts
  it('never meshes the simulated water of a column the sim owns, at any height; still meshes it where no sim owns it (NO_FLOOR)', () => {
    expect(tables.waterGroup).toBe(ID.water)
    const s = emptySnap()
    put(s, 4, 3, 4, water(7)) // below the floor: a lower segment's water, simulated since 3d
    put(s, 4, 6, 4, water(7)) // at the floor: the top segment's
    put(s, 9, 6, 9, water(7)) // a column with no floor (NO_FLOOR): no sim owns it
    s.floor[(4 + 1) + (4 + 1) * PAD] = 5
    expect(mesh(s).n).toBe(6) // only the lone cell of the column nobody simulates
  })
```

Keep "still meshes a spring above its column's floor".

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/engine && npx vitest run test/liquid.test.ts`
Expected: FAIL, 12 faces instead of 6.

- [ ] **Step 3: Change the mesher's test**

In `packages/engine/src/mesh/liquid.ts`, where the comment reads "Water at or above its column's floor is the heightfield's (render/water): …", change the condition from `y >= s.floor[x + 1 + (z + 1) * PAD]!` to `s.floor[x + 1 + (z + 1) * PAD]! !== NO_FLOOR`. Update the comment to "Every water voxel of a column the sim owns (floor ≠ NO_FLOOR) is a segment's, drawn by render/water (3d: no static water)". Import `NO_FLOOR` from `../world/waterBuffers.ts` if it is not imported yet.

- [ ] **Step 4: Remove the remesh plumbing**

- Delete `remesh` from `WaterPort` and from the port object `Simulation` builds.
- `rebuildChunkColumns` returns `void`.
- Where `Simulation.replaceColumns` merged its result into the dirty chunks (`for (const ci of this.water.rebuildChunkColumns(regenerated)) out.add(ci)`), call it alone.

- [ ] **Step 5: Run every engine test and the types**

Run: `cd packages/engine && npx vitest run && cd ../.. && npm run typecheck`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add -A packages/engine/src packages/engine/test
git commit -m "refactor(engine): water is never meshed: the static-water mesher path and remesh plumbing go"
```

---

### Task 9: Links and layer records in the tick

**Files:**
- Create: `packages/engine/src/sim/water/links.ts`
- Modify: `packages/engine/src/sim/water/publish.ts`, `packages/engine/src/sim/water/waterSystem.ts`, `packages/engine/src/sim/simulation.ts`, `packages/engine/src/protocol.ts`
- Modify: `packages/engine/test/layerHelpers.ts` (return `buffers`)
- Test: `packages/engine/test/waterLinks.test.ts`

**Interfaces:**
- Produces in `links.ts`:
  - `LINK_GROUND = 0x8000`, `LINK_WALL = 0x7fff`, `RECORD = 6`;
  - `rankOf(ref, n, under)`;
  - `linkOf(ref, c, dir, cols, under, height, shown, scratch)`.
- `WaterTick` becomes `{ seq: number; parity: number; tiles: readonly number[]; layers: Int32Array | null }`.
- `WaterPublisher`:
  - `publish(changed, cols, layered?: { under: UnderSegments; edges: WaterEdges; height: number })` fills `layers` when `layered` is given;
  - `hidden` is the wet lower segments ranked past `RANKS − 1` in the tiles it last published, summed over all tiles.
- `WaterSystem.stats()` gains `layersHidden`.
- The `'tick'` message's `physics` gains `waterBodies` and `waterLayersHidden`.

- [ ] **Step 1: Return the buffers from the harness**

In `packages/engine/test/layerHelpers.ts`, add `buffers` to the object `layered()` returns.

- [ ] **Step 2: Write the failing test**

```ts
// packages/engine/test/waterLinks.test.ts
import { describe, expect, it } from 'vitest'
import { RANKS, SUB } from '../src/sim/water/constants.ts'
import { LINK_GROUND, LINK_WALL, RECORD } from '../src/sim/water/links.ts'
import { WaterPublisher } from '../src/sim/water/publish.ts'
import { AIR, STONE, layered, wv } from './layerHelpers.ts'

/** A channel (z 1–3, floor 2, walls round) holding water y 2–5 everywhere, with a bridge deck at x = 15, y = 7. */
const bridged = (x: number, y: number, z: number) => {
  if (y < 2 || x === 0 || x === 31 || z === 0 || z >= 4) return STONE
  if (x === 15 && y === 7) return STONE
  return y <= 5 ? wv(7) : AIR
}

/** The records of a tick's layers, by tile: [local, rank, surface, floor, ceil, fluxX, fluxZ, links ×4]. */
function records(layers: Int32Array): Map<number, number[][]> {
  const out = new Map<number, number[][]>()
  for (let o = 0; o < layers.length;) {
    const t = layers[o]!, n = layers[o + 1]!, list: number[][] = []
    for (let k = 0; k < n; k++) {
      const r = layers.subarray(o + 2 + k * RECORD, o + 2 + (k + 1) * RECORD)
      list.push([r[0]! & 0xff, r[0]! >> 8, r[1]!, r[2]! & 0xffff, r[2]! >>> 16, (r[3]! << 16) >> 16, r[3]! >> 16,
        r[4]! & 0xffff, r[4]! >>> 16, r[5]! & 0xffff, r[5]! >>> 16])
    }
    out.set(t, list)
    o += 2 + n * RECORD
  }
  return out
}

function publish(w: ReturnType<typeof layered>) {
  const pub = new WaterPublisher(w.buffers.water)
  const all = Array.from({ length: w.cols.tiles.count }, (_, t) => t)
  const tick = pub.publish(all, w.cols, { under: w.under, edges: w.edges, height: 32 })!
  return { pub, tick, recs: records(tick.layers!) }
}

describe('layer records', () => {
  it('a world with no lower segment publishes an empty block per tile', () => {
    const w = layered((x, y, z) => (y < 2 ? STONE : y <= 4 && x < 10 && z < 10 ? wv(7) : AIR))
    const { recs } = publish(w)
    expect([...recs.keys()]).toEqual([0, 1, 2, 3])
    for (const list of recs.values()) expect(list).toEqual([])
  })

  it('the water under a bridge is a rank-1 slot; the lake beside it links to it on that side', () => {
    const w = layered(bridged)
    w.edges.ensure(w.cols, w.under, 32)
    const { recs } = publish(w)
    const t0 = recs.get(0)!
    const under = t0.find((r) => r[0] === 15 + 2 * 16 && r[1] === 1)!
    expect(under.slice(2, 5)).toEqual([2 * SUB + 4 * SUB, 2, 7]) // wet, its surface; floor 2, ceil 7
    expect(under.slice(7)).toEqual([0, 0, 1, 1]) // ±x: the lake's tops; ±z: the slots under the same deck
    const edge = t0.find((r) => r[0] === 15 + 1 * 16 && r[1] === 1)!
    expect(edge[10]).toBe(LINK_WALL) // −z of the row at z = 1: the stone wall
    const beside = t0.find((r) => r[0] === 14 + 2 * 16 && r[1] === 0)!
    expect(beside.slice(7, 9)).toEqual([1, 0]) // +x: the slot under the deck; −x: the next lake column's top
  })

  it('a dry lower segment met by wet water links as ground at its floor', () => {
    // a dry cave (y 2–3) under a roof beside a lake: the lake's side links to the cave's floor
    const w = layered((x, y, z) => {
      if (y < 2 || z === 0 || z >= 4 || x >= 20) return STONE
      if (x <= 9) return y <= 5 ? wv(7) : AIR
      return y <= 3 ? AIR : STONE
    })
    w.under.depth.fill(0) // keep the cave dry for this publish
    const { recs } = publish(w)
    const edge = recs.get(0)!.find((r) => r[0] === 9 + 2 * 16 && r[1] === 0)!
    expect(edge[7]).toBe(LINK_GROUND | 2)
  })

  it('a wet segment ranked past the draw layers is counted as hidden, never published (Review Focus 4)', () => {
    // five stacked water pockets in column (5, 5): ranks 1–5 under its top
    const w = layered((x, y, z) => (x === 5 && z === 5 && y > 1 && y < 22 && y % 4 !== 1 ? wv(7) : x === 5 && z === 5 && y >= 22 ? AIR : STONE))
    const { pub, recs } = publish(w)
    const ranks = recs.get(0)!.filter((r) => r[0] === 5 + 5 * 16).map((r) => r[1])
    expect(ranks.every((r) => r! < RANKS)).toBe(true)
    expect(pub.hidden).toBe(2)
  })
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd packages/engine && npx vitest run test/waterLinks.test.ts`
Expected: FAIL, `Cannot find module '../src/sim/water/links.ts'`.

- [ ] **Step 4: Write `links.ts`**

```ts
// packages/engine/src/sim/water/links.ts
import type { WaterColumns } from './columns.ts'
import { RANKS, SUB } from './constants.ts'
import { ceilOf, depthOf, floorOf, segmentsOf } from './edges.ts'
import type { UnderSegments } from './under.ts'

/** A link to dry ground: LINK_GROUND | its height (blocks). */
export const LINK_GROUND = 0x8000
/** No segment of the neighbour overlaps, or the one met is ranked past the draw layers: a wall. */
export const LINK_WALL = 0x7fff
/** Ints per record of WaterTick.layers (plan design notes: Publishing). */
export const RECORD = 6
/** Sides in link order: +x, −x, +z, −z (render/water/surfaceMesh.ts DIR_X / DIR_Z). */
export const SIDE_X: readonly number[] = [1, -1, 0, 0]
export const SIDE_Z: readonly number[] = [0, 0, 1, -1]

/** Draw rank of segment ref: 0 for the top; for a lower one, the lower segments above it plus one. */
export function rankOf(ref: number, n: number, under: UnderSegments): number { return ref < n ? 0 : under.rankOf(ref - n) }

/**
 * The link of segment `ref` of column c on side dir, the neighbour column lying in the world (plan decision 13): among the
 * neighbour's segments overlapping ref's run, the one with the highest floor below ref's surface, else the lowest; its rank
 * when it is a top or drawn (`shown`), LINK_GROUND | its floor when it is a dry lower one, LINK_WALL when none overlaps or
 * the one met ranks past RANKS − 1.
 */
export function linkOf(ref: number, c: number, dir: number, cols: WaterColumns, under: UnderSegments, height: number,
  shown: (ref: number) => boolean, scratch: number[]): number {
  const nc = c + SIDE_X[dir]! + SIDE_Z[dir]! * cols.sx
  const f = floorOf(ref, cols, under), ce = ceilOf(ref, cols, under, height), S = f * SUB + depthOf(ref, cols, under)
  segmentsOf(nc, under, scratch)
  let best = -1, bestF = -1, low = -1, lowF = Infinity
  for (const r of scratch) {
    const rf = floorOf(r, cols, under), rc = ceilOf(r, cols, under, height)
    if (rf >= ce || rc <= f || rf >= rc) continue
    if (rf * SUB < S && rf > bestF) { best = r; bestF = rf }
    if (rf < lowF) { low = r; lowF = rf }
  }
  const m = best >= 0 ? best : low
  if (m < 0) return LINK_WALL
  const rank = rankOf(m, cols.n, under)
  if (rank >= RANKS) return LINK_WALL
  if (m < cols.n || shown(m)) return rank
  return LINK_GROUND | floorOf(m, cols, under)
}
```

- [ ] **Step 5: Publish the records**

In `packages/engine/src/sim/water/publish.ts`:

(a) Change `WaterTick` to:

```ts
/** One publish: its sequence number, the parity buffer it wrote, its tiles, and their layer records (3d; null without lower segments). */
export interface WaterTick { seq: number; parity: number; tiles: readonly number[]; layers: Int32Array | null }
```

(b) `WaterPublisher` gains:
- the fields `hidden = 0` and `private readonly hiddenOf = new Map<number, number>()`;
- the scratch fields `private rec = new Int32Array(1024)`, `private recN = 0`, `private readonly segs: number[] = []`, `private readonly chain: number[] = []`;
- maps `private readonly fx = new Map<number, number>()`, `private readonly fz = new Map<number, number>()`;
- a third parameter `layered?: { under: UnderSegments; edges: WaterEdges; height: number }` on `publish`;
- `layers: layered ? this.records(tiles, cols, layered.under, layered.edges, layered.height) : null` on the tick it returns.

(c) Add the method:

```ts
  /**
   * The layer records of `tiles` (plan design notes: Publishing): per tile, a rank-0 record for each top whose links differ
   * from "the neighbour's top", and a record for each shown lower segment of rank 1 to RANKS − 1. Lower segments' shown
   * flags follow the top's hysteresis. Wet lower segments ranked past RANKS − 1 are counted in `hidden`.
   */
  private records(tiles: readonly number[], cols: WaterColumns, U: UnderSegments, E: WaterEdges, height: number): Int32Array {
    this.recN = 0
    const n = cols.n, T = cols.tiles, sx = cols.sx, sz = cols.sz
    const shown = (r: number) => (r < n ? this.shown[r] === 1 : U.shown[r - n] === 1)
    for (const t of tiles) {
      const x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE
      this.push(t)
      const at = this.recN
      this.push(0)
      let count = 0, hidden = 0
      for (let z = z0; z < z0 + TILE; z++) for (let c = x0 + z * sx, e = c + TILE; c < e; c++) {
        for (let i = U.first[c]!; i >= 0; i = U.next[i]!) {
          const d = U.depth[i]!
          if (d >= SHOW_DEPTH) U.shown[i] = 1
          else if (d < HIDE_DEPTH) U.shown[i] = 0
        }
      }
      // Water moved last step through each segment's +x / +z sides, summed over its edges (the dense edge for a top).
      this.fx.clear(); this.fz.clear()
      const L = E.tiles[t]
      if (L) for (let e = 0; e < L.count; e++) {
        const m = moved(L.flux[e]!), a = L.a[e]!, map = L.axis[e] === 0 ? this.fx : this.fz
        map.set(a, (map.get(a) ?? 0) + m)
      }
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) {
        const c = x + z * sx, local = (x - x0) + (z - z0) * TILE
        const fx = (r: number) => clamp16((r < n ? moved(cols.flux[2 * c]!) : 0) + (this.fx.get(r) ?? 0))
        const fz = (r: number) => clamp16((r < n ? moved(cols.flux[2 * c + 1]!) : 0) + (this.fz.get(r) ?? 0))
        const link = (r: number, dir: number) => {
          const nx = x + (dir === 0 ? 1 : dir === 1 ? -1 : 0), nz = z + (dir === 2 ? 1 : dir === 3 ? -1 : 0)
          return nx < 0 || nz < 0 || nx >= sx || nz >= sz ? 0 : linkOf(r, c, dir, cols, U, height, shown, this.segs)
        }
        const record = (r: number, rank: number, surface: number, floor: number, ceil: number) => {
          const l0 = link(r, 0), l1 = link(r, 1), l2 = link(r, 2), l3 = link(r, 3)
          if (rank === 0 && l0 === 0 && l1 === 0 && l2 === 0 && l3 === 0) return
          this.push(local | (rank << 8))
          this.push(surface)
          this.push(floor | (ceil << 16))
          this.push((fx(r) & 0xffff) | (fz(r) << 16))
          this.push(l0 | (l1 << 16))
          this.push(l2 | (l3 << 16))
          count++
        }
        if (U.first[c]! >= 0 || this.sideHasLower(x, z, sx, sz, U)) record(c, 0, 0, cols.floor[c]!, height)
        const chain = U.chain(c, this.chain), k = chain.length
        for (let j = 0; j < k; j++) {
          const i = chain[j]!, rank = k - j
          if (U.shown[i] !== 1) continue
          if (rank >= RANKS) { hidden++; continue }
          const d = U.depth[i]!
          record(n + i, rank, U.floor[i]! * SUB + (d < SHOW_DEPTH ? SHOW_DEPTH : d), U.floor[i]!, U.ceil[i]!)
        }
      }
      this.rec[at] = count
      this.hidden += hidden - (this.hiddenOf.get(t) ?? 0)
      if (hidden > 0) this.hiddenOf.set(t, hidden)
      else this.hiddenOf.delete(t)
    }
    return this.rec.slice(0, this.recN)
  }

  /** Whether a neighbour column of (x, z) has a lower segment: only then can a top's links differ from the default. */
  private sideHasLower(x: number, z: number, sx: number, sz: number, U: UnderSegments): boolean {
    const c = x + z * sx
    return (x > 0 && U.first[c - 1]! >= 0) || (x + 1 < sx && U.first[c + 1]! >= 0) || (z > 0 && U.first[c - sx]! >= 0) || (z + 1 < sz && U.first[c + sx]! >= 0)
  }

  private push(v: number): void {
    if (this.recN === this.rec.length) { const r = new Int32Array(this.rec.length * 2); r.set(this.rec); this.rec = r }
    this.rec[this.recN++] = v
  }
```

`records` runs after the dense write, so the tops' `shown` flags are current. A shown lower segment always holds at least `HIDE_DEPTH`, so its record's surface is a wet `S` (≥ 0).

Imports to add: `TILE`, `RANKS` (constants), `linkOf` (links), and the types `UnderSegments`, `WaterEdges`.

(d) In `WaterSystem.flush`, publish with `{ under: this.under, edges: this.edges, height: this.height }`. In `WaterSystem.stats()`, add `layersHidden: this.publisher.hidden`.

(e) In `simulation.ts`, the tick's physics becomes `{ waterTiles: ws.tiles, waterColumns: ws.columns, waterBodies: ws.bodies, waterLayersHidden: ws.layersHidden, jobs, busy: … }`. Update the type in `protocol.ts` (`physics: { waterTiles: number; waterColumns: number; waterBodies: number; waterLayersHidden: number; jobs: number; busy: boolean }`) and the `TickResult` type in `simulation.ts`.

- [ ] **Step 6: Run the tests to see them pass**

Run: `cd packages/engine && npx vitest run test/waterLinks.test.ts test/waterPublish.test.ts test/surfaceView.test.ts`
Expected: PASS. `waterPublish` and `surfaceView` publish without `layered`, so their ticks carry `layers: null`. Fix any test that builds a `WaterTick` literal by adding `layers: null`.

- [ ] **Step 7: Run every engine test and the types**

Run: `cd packages/engine && npx vitest run && cd ../.. && npm run typecheck`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add -A packages/engine/src packages/engine/test
git commit -m "feat(sim): water ticks carry layer records: lower segments of rank 1-3 and the links between slots"
```

---

### Task 10: The main thread's slots and the 3 × 3 through links

**Files:**
- Create: `packages/engine/src/render/water/layerStore.ts`
- Create: `packages/engine/src/render/water/slotPatch.ts`
- Test: `packages/engine/test/layerStore.test.ts`

**Interfaces:**
- Consumes: `RECORD`, `LINK_GROUND`, `LINK_WALL` (Task 9); `RANKS`, `TILE`; `effective`, `level`, `OUTSIDE`, `DIR_X`, `DIR_Z` (surfaceMesh.ts).
- Produces:
  - `class LayerStore`:
    - `constructor(sx, sz)`, `stage(layers)`, `commit(t, first): boolean`;
    - `layered(t)`, `layeredAround(t)`, `has(c, r)`;
    - `prev(c, r)`, `cur(c, r)`, `floor(c, r)`, `ceil(c, r)`, `fluxX(c, r)`, `fluxZ(c, r)`, `link(c, r, dir)`.
  - `interface SlotSource { sx; sz; value(c, r, cur); floor(c, r); ceil(c, r); link(c, r, dir) }`;
  - `const hit: { c: number; r: number; e: number }`;
  - `resolve(src, x, z, r, dir, cur): void`;
  - `patch(src, x, z, r, cur, e: Int32Array): void`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/layerStore.test.ts
import { describe, expect, it } from 'vitest'
import { LayerStore } from '../src/render/water/layerStore.ts'
import { patch, resolve, hit, type SlotSource } from '../src/render/water/slotPatch.ts'
import { OUTSIDE, effective } from '../src/render/water/surfaceMesh.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { LINK_GROUND, LINK_WALL, RECORD } from '../src/sim/water/links.ts'

/** A layers block for one tile: records [local, rank, surface, floor, ceil, links ×4]. */
function block(t: number, recs: number[][]): Int32Array {
  const out = [t, recs.length]
  for (const [local, rank, surface, floor, ceil, l0, l1, l2, l3] of recs) {
    out.push(local! | (rank! << 8), surface!, floor! | (ceil! << 16), 0, l0! | (l1! << 16), l2! | (l3! << 16))
  }
  return Int32Array.from(out)
}

describe('LayerStore', () => {
  it('a new slot rises from its floor; named again it moves on from where it was', () => {
    const L = new LayerStore(32, 32)
    L.stage(block(0, [[3, 1, 5 * SUB, 2, 7, 0, 0, 0, 0]]))
    expect(L.commit(0, false)).toBe(true)
    expect([L.prev(3, 1), L.cur(3, 1), L.floor(3, 1), L.ceil(3, 1)]).toEqual([~(2 * SUB), 5 * SUB, 2, 7])
    L.stage(block(0, [[3, 1, 5 * SUB + 9, 2, 7, 0, 0, 0, 0]]))
    L.commit(0, false)
    expect([L.prev(3, 1), L.cur(3, 1)]).toEqual([5 * SUB, 5 * SUB + 9])
    expect(L.layered(0)).toBe(true)
    expect(L.layeredAround(3)).toBe(true) // tile (1, 1) of a 2 × 2 tiling touches tile 0
  })

  it('a slot no longer named sinks to its floor, then goes (Review Focus 5)', () => {
    const L = new LayerStore(32, 32)
    L.stage(block(0, [[3, 1, 5 * SUB, 2, 7, 0, 0, 0, 0]])); L.commit(0, true)
    L.stage(block(0, [])); L.commit(0, false)
    expect([L.has(3, 1), L.prev(3, 1), L.cur(3, 1)]).toEqual([true, 5 * SUB, ~(2 * SUB)])
    L.stage(block(0, [])); L.commit(0, false)
    expect([L.has(3, 1), L.prev(3, 1), L.cur(3, 1)]).toEqual([true, ~(2 * SUB), ~(2 * SUB)])
    L.stage(block(0, [])); L.commit(0, false)
    expect(L.has(3, 1)).toBe(false)
  })

  it('keeps the latest staged block per tile, and links default to the neighbour top without a record', () => {
    const L = new LayerStore(32, 32)
    L.stage(block(0, [[3, 0, 0, 1, 32, 1, 0, LINK_WALL, 0]]))
    L.stage(block(0, [[3, 0, 0, 1, 32, 2, 0, LINK_WALL, 0]]))
    L.commit(0, false)
    expect([L.link(3, 0, 0), L.link(3, 0, 2), L.link(4, 0, 0)]).toEqual([2, LINK_WALL, 0])
    expect(L.commit(0, false)).toBe(false) // nothing staged
  })
})

describe('patch', () => {
  /** Rank 0 everywhere at surface 4 blocks over floor 1; a rank-1 slot at (5, 5) under a deck. */
  const src: SlotSource = {
    sx: 16, sz: 16,
    value: (c, r) => (r === 0 ? (c === 5 + 5 * 16 ? ~(8 * SUB) : 4 * SUB) : 4 * SUB),
    floor: (c, r) => (r === 0 && c === 5 + 5 * 16 ? 8 : 1),
    ceil: (c, r) => (r === 0 ? 32 : 6),
    link: (c, r, dir) => {
      if (r === 1) return 0 // the slot under the deck meets the tops around
      const x = c % 16, z = Math.floor(c / 16)
      // tops beside (5, 5) meet its rank-1 slot on the side facing it
      if ((x === 4 && z === 5 && dir === 0) || (x === 6 && z === 5 && dir === 1) || (x === 5 && z === 4 && dir === 2) || (x === 5 && z === 6 && dir === 3)) return 1
      return 0
    },
  }

  it('resolves sides through links: the slot under the deck sees the lake, the lake sees it', () => {
    resolve(src, 5, 5, 1, 0, true)
    expect([hit.c, hit.r, hit.e]).toEqual([6 + 5 * 16, 0, 4 * SUB])
    resolve(src, 4, 5, 0, 0, true)
    expect([hit.c, hit.r, hit.e]).toEqual([5 + 5 * 16, 1, 4 * SUB])
    resolve(src, 0, 0, 0, 1, true)
    expect(hit.e).toBe(OUTSIDE)
  })

  it('the 3 × 3 of the slot under the deck is the lake all round: no seam', () => {
    const e = new Int32Array(9)
    patch(src, 5, 5, 1, true, e)
    expect([...e]).toEqual(new Array(9).fill(4 * SUB))
  })

  it('ground and walls: a dry link reads as ground at its height, a wall above the slot', () => {
    const s2: SlotSource = { ...src, link: (c, r, dir) => (dir === 0 ? LINK_GROUND | 3 : dir === 1 ? LINK_WALL : 0) }
    const e = new Int32Array(9)
    patch(s2, 5, 5, 1, true, e)
    expect(e[5]).toBe(~(3 * SUB))
    expect(e[3]).toBe(~(6 * SUB))
    expect(e[4]).toBe(effective(4 * SUB, 1))
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/engine && npx vitest run test/layerStore.test.ts`
Expected: FAIL, missing modules.

- [ ] **Step 3: Write `layerStore.ts`**

```ts
// packages/engine/src/render/water/layerStore.ts
import { RANKS, TILE } from '../../sim/water/constants.ts'
import { RECORD } from '../../sim/water/links.ts'
import { SUB } from '../../world/waterBuffers.ts'

const SLOTS = TILE * TILE * RANKS

/** One tile's slots, index local column × RANKS + rank. Rank 0 holds links only: its water is the dense view's. */
class TileSlots {
  readonly present = new Uint8Array(SLOTS)
  readonly named = new Uint8Array(SLOTS)
  readonly prev = new Int32Array(SLOTS)
  readonly cur = new Int32Array(SLOTS)
  readonly floor = new Int16Array(SLOTS)
  readonly ceil = new Int16Array(SLOTS)
  readonly fluxX = new Int16Array(SLOTS)
  readonly fluxZ = new Int16Array(SLOTS)
  readonly links = new Uint16Array(SLOTS * 4)
}

/**
 * The main thread's slots of ranks 0–3 (plan design notes: The main thread): staged from each tick's layer records and
 * committed when SurfaceView reads their tile, so a slot moves from step to step like the dense columns. A slot no longer
 * published sinks to its floor over one step, then goes.
 */
export class LayerStore {
  readonly sx: number
  readonly sz: number
  readonly tx: number
  readonly tz: number
  private readonly tiles: (TileSlots | null)[]
  private readonly staged = new Map<number, Int32Array>()

  constructor(sx: number, sz: number) {
    this.sx = sx
    this.sz = sz
    this.tx = sx / TILE
    this.tz = sz / TILE
    this.tiles = new Array<TileSlots | null>(this.tx * this.tz).fill(null)
  }

  /** Keeps each tile's latest records from a tick's layers (tile blocks: tile, count, count × RECORD ints). */
  stage(layers: Int32Array): void {
    for (let o = 0; o < layers.length;) {
      const t = layers[o]!, count = layers[o + 1]!
      this.staged.set(t, layers.slice(o + 2, o + 2 + count * RECORD))
      o += 2 + count * RECORD
    }
  }

  /** Applies tile t's staged records, if any. `first`: the tile is read for the first time (its slots start where they are). Returns whether a slot changed. */
  commit(t: number, first: boolean): boolean {
    const recs = this.staged.get(t)
    if (recs === undefined) return false
    this.staged.delete(t)
    let s = this.tiles[t]
    if (!s) {
      if (recs.length === 0) return false
      s = new TileSlots()
      this.tiles[t] = s
    }
    s.named.fill(0)
    let changed = false
    for (let o = 0; o < recs.length; o += RECORD) {
      const head = recs[o]!, r = head >> 8, k = (head & 0xff) * RANKS + r, lk = k * 4
      const l0 = recs[o + 4]! & 0xffff, l1 = recs[o + 4]! >>> 16, l2 = recs[o + 5]! & 0xffff, l3 = recs[o + 5]! >>> 16
      const L = s.links
      if (s.present[k] === 0 || L[lk] !== l0 || L[lk + 1] !== l1 || L[lk + 2] !== l2 || L[lk + 3] !== l3) changed = true
      L[lk] = l0; L[lk + 1] = l1; L[lk + 2] = l2; L[lk + 3] = l3
      if (r > 0) {
        const v = recs[o + 1]!, fl = recs[o + 2]! & 0xffff, ce = recs[o + 2]! >>> 16
        const fx = (recs[o + 3]! << 16) >> 16, fz = recs[o + 3]! >> 16
        const pv = first ? v : s.present[k] === 1 ? s.cur[k]! : ~(fl * SUB)
        if (s.present[k] === 0 || s.cur[k] !== v || s.prev[k] !== pv || s.fluxX[k] !== fx || s.fluxZ[k] !== fz || s.floor[k] !== fl || s.ceil[k] !== ce) changed = true
        s.prev[k] = pv; s.cur[k] = v; s.floor[k] = fl; s.ceil[k] = ce; s.fluxX[k] = fx; s.fluxZ[k] = fz
      }
      s.present[k] = 1
      s.named[k] = 1
    }
    for (let k = 0; k < SLOTS; k++) {
      if (s.present[k] === 0 || s.named[k] === 1) continue
      changed = true
      if (k % RANKS === 0) { s.present[k] = 0; continue } // a top back to default links
      const dry = ~(s.floor[k]! * SUB)
      if (s.cur[k] === dry && s.prev[k] === dry) { s.present[k] = 0; continue }
      s.prev[k] = s.cur[k]!
      s.cur[k] = dry
      s.fluxX[k] = 0
      s.fluxZ[k] = 0
    }
    return changed
  }

  /** Whether tile t ever held a slot (it then stays on the layered refresh path). */
  layered(t: number): boolean { return this.tiles[t] !== null }

  /** Whether tile t or one of its 8 neighbours ever held a slot. */
  layeredAround(t: number): boolean {
    const x = t % this.tx, z = (t - x) / this.tx
    for (let j = Math.max(0, z - 1); j <= Math.min(this.tz - 1, z + 1); j++) {
      for (let i = Math.max(0, x - 1); i <= Math.min(this.tx - 1, x + 1); i++) if (this.tiles[i + j * this.tx] !== null) return true
    }
    return false
  }

  has(c: number, r: number): boolean { const s = this.slots(c); return s !== null && s.present[this.k(c, r)] === 1 }
  prev(c: number, r: number): number { return this.slots(c)!.prev[this.k(c, r)]! }
  cur(c: number, r: number): number { return this.slots(c)!.cur[this.k(c, r)]! }
  floor(c: number, r: number): number { return this.slots(c)!.floor[this.k(c, r)]! }
  ceil(c: number, r: number): number { return this.slots(c)!.ceil[this.k(c, r)]! }
  fluxX(c: number, r: number): number { return this.slots(c)!.fluxX[this.k(c, r)]! }
  fluxZ(c: number, r: number): number { return this.slots(c)!.fluxZ[this.k(c, r)]! }

  /** Link of slot (c, r) on side dir: 0 (the neighbour's top) when the slot has no record. */
  link(c: number, r: number, dir: number): number {
    const s = this.slots(c), k = this.k(c, r)
    return s !== null && s.present[k] === 1 ? s.links[k * 4 + dir]! : 0
  }

  private slots(c: number): TileSlots | null {
    const x = c % this.sx, z = (c - x) / this.sx
    return this.tiles[(x >> 4) + (z >> 4) * this.tx]!
  }

  private k(c: number, r: number): number {
    const x = c % this.sx, z = (c - x) / this.sx
    return ((x & 15) + (z & 15) * 16) * RANKS + r
  }
}
```

`TILE` is 16; the `>> 4` and `& 15` above rely on it.

- [ ] **Step 4: Write `slotPatch.ts`**

```ts
// packages/engine/src/render/water/slotPatch.ts
import { RANKS } from '../../sim/water/constants.ts'
import { LINK_WALL } from '../../sim/water/links.ts'
import { SUB } from '../../world/waterBuffers.ts'
import { DIR_X, DIR_Z, OUTSIDE, effective, level } from './surfaceMesh.ts'

/** What patch reads: every slot's published water (rank 0: the dense view's) and the links between slots. */
export interface SlotSource {
  readonly sx: number
  readonly sz: number
  /** Encoded surface of slot (c, r) at the previous step (cur false) or the current one. */
  value(c: number, r: number, cur: boolean): number
  floor(c: number, r: number): number
  ceil(c: number, r: number): number
  link(c: number, r: number, dir: number): number
}

/** The last resolve(): the neighbour slot (column, rank; both −1 for ground, a wall or outside) and its effective value. */
export const hit = { c: -1, r: -1, e: 0 }

/** The neighbour of slot (x, z, r) through side dir (0 +x, 1 −x, 2 +z, 3 −z), through its link, into `hit`. */
export function resolve(src: SlotSource, x: number, z: number, r: number, dir: number, cur: boolean): void {
  const nx = x + DIR_X[dir]!, nz = z + DIR_Z[dir]!
  if (nx < 0 || nz < 0 || nx >= src.sx || nz >= src.sz) { hit.c = -1; hit.r = -1; hit.e = OUTSIDE; return }
  const c = x + z * src.sx, l = src.link(c, r, dir)
  if (l < RANKS) {
    const nc = nx + nz * src.sx
    hit.c = nc; hit.r = l; hit.e = effective(src.value(nc, l, cur), src.floor(nc, l))
    return
  }
  hit.c = -1; hit.r = -1
  hit.e = l === LINK_WALL ? ~(src.ceil(c, r) * SUB) : ~((l & 0x7fff) * SUB)
}

/** A diagonal: from side slot a through side dir da, else from side slot b through db, else the higher ground of the two sides. */
function diagonal(src: SlotSource, ac: number, ar: number, da: number, bc: number, br: number, db: number, ea: number, eb: number, cur: boolean): number {
  if (ac >= 0) { resolve(src, ac % src.sx, Math.floor(ac / src.sx), ar, da, cur); return hit.e }
  if (bc >= 0) { resolve(src, bc % src.sx, Math.floor(bc / src.sx), br, db, cur); return hit.e }
  if (ea === OUTSIDE || eb === OUTSIDE) return OUTSIDE
  return ~Math.max(level(ea), level(eb))
}

/**
 * The effective values (surfaceMesh.effective, or OUTSIDE) of the 3 × 3 around slot (x, z, r), index (dz + 1) × 3 + dx + 1,
 * each neighbour through the links (plan design notes: The main thread). With every link the default this is the 3 × 3 of
 * the dense columns, exactly as 3c's refresh reads it.
 */
export function patch(src: SlotSource, x: number, z: number, r: number, cur: boolean, e: Int32Array): void {
  const c = x + z * src.sx
  e[4] = effective(src.value(c, r, cur), src.floor(c, r))
  resolve(src, x, z, r, 0, cur); e[5] = hit.e; const ec = hit.c, er = hit.r
  resolve(src, x, z, r, 1, cur); e[3] = hit.e; const wc = hit.c, wr = hit.r
  resolve(src, x, z, r, 2, cur); e[7] = hit.e; const sc = hit.c, sr = hit.r
  resolve(src, x, z, r, 3, cur); e[1] = hit.e; const nc = hit.c, nr = hit.r
  e[8] = diagonal(src, ec, er, 2, sc, sr, 0, e[5]!, e[7]!, cur)
  e[2] = diagonal(src, ec, er, 3, nc, nr, 0, e[5]!, e[1]!, cur)
  e[6] = diagonal(src, wc, wr, 2, sc, sr, 1, e[3]!, e[7]!, cur)
  e[0] = diagonal(src, wc, wr, 3, nc, nr, 1, e[3]!, e[1]!, cur)
}
```

- [ ] **Step 5: Run the test to see it pass**

Run: `cd packages/engine && npx vitest run test/layerStore.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/render/water/layerStore.ts packages/engine/src/render/water/slotPatch.ts packages/engine/test/layerStore.test.ts
git commit -m "feat(render): the main thread's water slots of ranks 0-3, and a slot's 3 x 3 through its links"
```

---

### Task 11: `SurfaceView` draws every layer

**Files:**
- Modify: `packages/engine/src/render/water/surfaceView.ts`
- Modify: `packages/engine/src/render/water/waterSurface.ts`
- Test: `packages/engine/test/surfaceLayers.test.ts`; `packages/engine/test/surfaceView.test.ts` (calls of `column(cc)` keep working: `r` defaults to 0)

**Interfaces:**
- Consumes: `LayerStore`, `patch`, `resolve`, `hit`, `SlotSource` (Task 10); `WaterTick.layers` (Task 9).
- Produces on `SurfaceView`:
  - `readonly layers: LayerStore`;
  - `forceLayered: boolean` (tests);
  - `column(cc, r = 0)`;
  - `takeDirty()` returns keys `r × ccCount + cc`;
  - `readonly ccCount`.
- `WaterSurface` keeps one mesh pair per key, named `water-${r}-${cc}`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/engine/test/surfaceLayers.test.ts
import { describe, expect, it } from 'vitest'
import { SurfaceView } from '../src/render/water/surfaceView.ts'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { WaterPublisher } from '../src/sim/water/publish.ts'
import { createWaterBuffers } from '../src/world/waterBuffers.ts'
import { AIR, STONE, layered, wv } from './layerHelpers.ts'

function corners(view: SurfaceView, x: number, z: number, r: number, f: 'hCur' | 'hPrev' | 'info' = 'hCur'): number[] {
  const d = view.column((x >> 5) + (z >> 5) * view.cx, r)!
  const o = ((x & 31) + (z & 31) * 32) * 4
  return [...d[f].subarray(o, o + 4)]
}

describe('the layered refresh path', () => {
  it('draws exactly what the fast path draws on a world with no layers (differential, random changes)', () => {
    const S = 64, b = createWaterBuffers([S, 32, S])
    const cols = new WaterColumns(S, S, new Int16Array(b.floor))
    let seed = 11
    const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
    for (let c = 0; c < S * S; c++) { cols.floor[c] = 2 + Math.floor(rand() * 3); cols.depth[c] = rand() < 0.6 ? Math.floor(rand() * 3 * SUB) : 0 }
    const pub = new WaterPublisher(b)
    const fast = new SurfaceView([S, 32, S], b, () => 15), slow = new SurfaceView([S, 32, S], b, () => 15)
    slow.forceLayered = true
    const T = S / 16
    for (let tick = 0; tick < 30; tick++) {
      const changed = new Set<number>()
      for (let m = 0; m < 3; m++) {
        const t = Math.floor(rand() * T * T), x0 = (t % T) * 16, z0 = Math.floor(t / T) * 16
        changed.add(t)
        for (let z = z0; z < z0 + 16; z++) for (let x = x0; x < x0 + 16; x++) {
          const c = x + z * S
          cols.depth[c] = Math.max(0, cols.depth[c]! + Math.floor((rand() - 0.5) * 200))
          cols.flux[2 * c] = Math.floor((rand() - 0.5) * 800); cols.flux[2 * c + 1] = Math.floor((rand() - 0.5) * 800)
        }
      }
      const tick0 = pub.publish([...changed].sort((a, b2) => a - b2), cols)!
      fast.apply(tick0); slow.apply(tick0)
      for (let cc = 0; cc < fast.cx * fast.cz; cc++) {
        const a = fast.column(cc), s = slow.column(cc)
        expect(!!a).toBe(!!s)
        if (!a || !s) continue
        expect(s.hCur).toEqual(a.hCur)
        expect(s.hPrev).toEqual(a.hPrev)
        expect(s.info).toEqual(a.info)
        expect(s.curtainMask).toEqual(a.curtainMask)
        expect(s.curtains.cur.subarray(0, s.curtains.count * 4)).toEqual(a.curtains.cur.subarray(0, a.curtains.count * 4))
      }
    }
  })

  /** The bridged channel of Task 9's tests, published with its layers into a view. */
  function bridgedView() {
    const w = layered((x, y, z) => {
      if (y < 2 || x === 0 || x === 31 || z === 0 || z >= 4) return STONE
      if (x === 15 && y === 7) return STONE
      return y <= 5 ? wv(7) : AIR
    })
    w.edges.ensure(w.cols, w.under, 32)
    const pub = new WaterPublisher(w.buffers.water), view = new SurfaceView([32, 32, 32], w.buffers.water, () => 15)
    const all = Array.from({ length: w.cols.tiles.count }, (_, t) => t)
    const publish = () => view.apply(pub.publish(all, w.cols, { under: w.under, edges: w.edges, height: 32 })!)
    return { w, view, publish }
  }

  it('the water under a bridge is drawn in layer 1 and meets the lake in layer 0 with no seam', () => {
    const { view, publish } = bridgedView()
    publish()
    const under = corners(view, 15, 2, 1), west = corners(view, 14, 2, 0), east = corners(view, 16, 2, 0)
    expect(under[0]).toBeCloseTo(west[1]!, 6) // (−x,−z) of the slot = (+x,−z) of the lake column west of it
    expect(under[3]).toBeCloseTo(west[2]!, 6)
    expect(under[1]).toBeCloseTo(east[0]!, 6)
    expect(under[2]).toBeCloseTo(east[3]!, 6)
    expect(under[0]).toBeCloseTo(6, 6) // the lake's surface: 2 + 4 blocks
    expect(corners(view, 15, 2, 0, 'info')[3]).toBeLessThan(0) // the deck's top segment is dry: nothing drawn in layer 0
  })

  it('a slot drained between publishes sinks, then leaves no quad behind (Review Focus 5)', () => {
    const { w, view, publish } = bridgedView()
    publish()
    expect(corners(view, 15, 2, 1, 'info')[3]).toBeGreaterThanOrEqual(0)
    for (let z = 1; z <= 3; z++) w.under.depth[w.under.first[15 + z * 32]!] = 0
    publish()
    publish()
    publish()
    expect(corners(view, 15, 2, 1, 'info')[3]).toBeLessThan(0)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/engine && npx vitest run test/surfaceLayers.test.ts`
Expected: FAIL, `slow.forceLayered` has no effect yet, and `column(cc, 1)` returns undefined.

- [ ] **Step 3: Give `SurfaceView` its layers**

In `packages/engine/src/render/water/surfaceView.ts`:

(a) Imports: `LayerStore` (`./layerStore.ts`); `patch`, `resolve`, `hit`, `type SlotSource` (`./slotPatch.ts`); `RANKS` (constants).

(b) Fields:
- `readonly layers: LayerStore`, `forceLayered = false`, `readonly ccCount: number`;
- `private readonly slotChanged: Uint16Array` (per tile, the epoch of the apply that changed its slots; cleared with the other epoch arrays in `nextEpoch`);
- `data` becomes `private readonly data: (ColumnData | undefined)[][]`, one array per rank;
- `private readonly pC = new Int32Array(9)`, `private readonly pP = new Int32Array(9)`, `private readonly vtmp = new Float32Array(4)`;
- `private readonly src: SlotSource`;
- `movingMark` becomes `new Uint16Array(this.n * RANKS)`; `moving` / `nextMoving` hold slot keys `c × RANKS + r`.

(c) Constructor:

```ts
    this.ccCount = this.cx * this.cz
    this.data = Array.from({ length: RANKS }, () => new Array<ColumnData | undefined>(this.ccCount))
    this.layers = new LayerStore(this.sx, this.sz)
    const view = this
    this.src = {
      sx: this.sx, sz: this.sz,
      value: (c, r, cur) => (r === 0 ? (cur ? view.cur[c]! : view.prev[c]!) : cur ? view.layers.cur(c, r) : view.layers.prev(c, r)),
      floor: (c, r) => (r === 0 ? view.floor[c]! : view.layers.floor(c, r)),
      ceil: (c, r) => (r === 0 ? 0x7fff : view.layers.ceil(c, r)),
      link: (c, r, dir) => view.layers.link(c, r, dir),
    }
```

`ceil(c, 0)` is 0x7fff, so a wall beside a top reads as ground far above it: never drawn, never joined, as a wall in 3c.

(d) `column(cc: number, r = 0): ColumnData | undefined { return this.data[r]![cc] }`.

(e) Keys. `markDirty(key)` and `touch(key)` take keys:
- every existing call passes `cc`, which is the key for rank 0;
- `touchSpan(x, z, r = 0)` touches `r × ccCount + cc`;
- in `apply`, the touched loop decodes `const cc = key % this.ccCount, r = (key - cc) / this.ccCount, d = this.data[r]![cc]` and calls `this.buildCurtains(cc, d, this.shown, r)`;
- `settleRest` decodes slot keys (`c = k / RANKS | 0, r = k % RANKS`) and reads `this.data[r]`;
- `track(c, r = 0)` pushes `c × RANKS + r`.

(f) `apply`:
- stage before the stamp check: `if (t.layers) this.layers.stage(t.layers)`;
- in the per-tile loop, after the column loop: `if (this.layers.commit(tile, first)) { any = true; this.slotChanged[tile] = e }`. Move `const e = this.nextEpoch()` above that loop if it is not already.

(g) `refreshTile` starts with:

```ts
    if (this.forceLayered || this.layers.layeredAround(tile)) { this.refreshLayered(tile, e); return }
```

(h) The layered path:

```ts
  /** The tile and its ring as refreshTile, every column at every rank, neighbours through links (plan decision 14). */
  private refreshLayered(tile: number, e: number): void {
    const tw = this.tx, th = this.seen.length / tw, tx = tile % tw, tz = (tile - tx) / tw
    const x0 = tx * TILE, z0 = tz * TILE
    const xa = tx > 0 && this.tileChanged[tile - 1] !== e ? x0 - 1 : x0
    const xb = tx + 1 < tw && this.tileChanged[tile + 1] !== e ? x0 + TILE + 1 : x0 + TILE
    const za = tz > 0 && this.tileChanged[tile - tw] !== e ? z0 - 1 : z0
    const zb = tz + 1 < th && this.tileChanged[tile + tw] !== e ? z0 + TILE + 1 : z0 + TILE
    for (let z = za; z < zb; z++) for (let x = xa; x < xb; x++) {
      const c = x + z * this.sx
      if (this.refreshed[c] === e || !this.nearLayered(x, z, e)) continue
      this.refreshed[c] = e
      for (let r = 0; r < RANKS; r++) {
        if (r === 0 || this.layers.has(c, r)) this.refreshSlot(x, z, r)
        else this.clearSlot(x, z, r)
      }
    }
  }

  /**
   * near(), or anywhere in a tile whose slots changed this apply (a slot's change does not mark its column). With no slot
   * change this is near() exactly, so on a world without layers the layered path refreshes the same columns as the fast one.
   */
  private nearLayered(x: number, z: number, e: number): boolean {
    return this.near(x, z, e) || this.slotChanged[(x >> 4) + (z >> 4) * this.tx] === e
  }

  /** A slot that is gone: its quad is hidden. */
  private clearSlot(x: number, z: number, r: number): void {
    const cc = (x >> 5) + (z >> 5) * this.cx, d = this.data[r]![cc]
    if (!d) return
    const i = (x & 31) + (z & 31) * 32
    if (d.info[i * 4 + 3]! < 0) return
    d.info[i * 4 + 3] = -1
    d.curtainMask[i] = 0
    d.mark(z & 31)
    this.markDirty(r * this.ccCount + cc)
    this.touch(r * this.ccCount + cc)
  }

  /**
   * refreshColumn for slot (x, z, r) on its 3 × 3 through the links (patch): its corners are its shares of its four vertices
   * (vertexShares over each 2 × 2 block, own quadrants 3, 2, 0, 1), and its flow, white water, light and curtain bits as
   * refreshColumn computes them. With default links every number equals refreshColumn's (the differential test).
   */
  private refreshSlot(x: number, z: number, r: number): void {
    const sx = this.sx, c = x + z * sx, cc = (x >> 5) + (z >> 5) * this.cx, src = this.src, key = r * this.ccCount + cc
    const pv = src.value(c, r, false), fl = src.floor(c, r), pC = this.pC, pP = this.pP
    patch(src, x, z, r, true, pC)
    patch(src, x, z, r, false, pP)
    const ec = pC[4]!, was = shows(pv, fl), drawn = was || ec >= 0
    const lx = x & 31, lz = z & 31, i = lx + lz * 32, o = i * 4
    if (lx < ARC_SPAN || lx >= 32 - ARC_SPAN || lz < ARC_SPAN || lz >= 32 - ARC_SPAN) this.touchSpan(x, z, r)
    let d = this.data[r]![cc]
    if (!d) {
      if (!drawn) return
      d = new ColumnData()
      this.data[r]![cc] = d
    }
    d.mark(lz)
    this.markDirty(key)
    this.touch(key)
    if (!drawn) { d.info[o + 3] = -1; d.curtainMask[i] = 0; return }
    const hp = d.hPrev, hc = d.hCur, a = this.shown, onScreen = a >= 0 && d.info[o + 3]! >= 0
    const s0 = hp[o]! + (hc[o]! - hp[o]!) * a, s1 = hp[o + 1]! + (hc[o + 1]! - hp[o + 1]!) * a
    const s2 = hp[o + 2]! + (hc[o + 2]! - hp[o + 2]!) * a, s3 = hp[o + 3]! + (hc[o + 3]! - hp[o + 3]!) * a
    let smoothP = true, smoothC = true
    for (let k = 0; k < 4; k++) {
      smoothP = patchCorner(pP, k, hp, o, this.vtmp) && smoothP
      smoothC = patchCorner(pC, k, hc, o, this.vtmp) && smoothC
    }
    if (onScreen) { hp[o] = s0; hp[o + 1] = s1; hp[o + 2] = s2; hp[o + 3] = s3 }
    const prevBits = smoothP ? 0 : edgeBits(pP, 4, 3)
    const s = level(src.value(c, r, true)), depth = Math.max(0, s - fl * SUB)
    const east = r === 0 ? this.fluxX[c]! : this.layers.fluxX(c, r), south = r === 0 ? this.fluxZ[c]! : this.layers.fluxZ(c, r)
    resolve(src, x, z, r, 1, true)
    const west = hit.c < 0 ? 0 : hit.r === 0 ? this.fluxX[hit.c]! : this.layers.fluxX(hit.c, hit.r)
    resolve(src, x, z, r, 3, true)
    const north = hit.c < 0 ? 0 : hit.r === 0 ? this.fluxZ[hit.c]! : this.layers.fluxZ(hit.c, hit.r)
    const k = this.stepHz / (2 * Math.max(depth, SUB / 8))
    const fr = froude(quantizeFlow((west + east) * k, (north + south) * k, d.info, o), depth * PER_SUB)
    let white = surfaceWhite(fr)
    let curBits = 0
    if (!smoothC) {
      curBits = edgeBits(pC, 4, 3)
      if (frontIn(pC, 5, ec, east) || frontIn(pC, 3, ec, -west) || frontIn(pC, 7, ec, south) || frontIn(pC, 1, ec, -north)) white = Math.max(white, boreWhite(fr))
    }
    const l = this.light(x, Math.ceil(s * PER_SUB), z)
    d.info[o + 2] = depth * PER_SUB
    d.info[o + 3] = (l & 15) * 16 + (l >> 4) + 256 * white
    d.curtainMask[i] = prevBits | (curBits << 4)
    if (a >= 0) this.track(c, r)
  }
```

`refreshColumn` (the fast path) uses the smooth bits of its four vertices exactly like `smoothP` and `smoothC` here. So do the "aligned" copy of hCur into hPrev and its `prevBits` taken from the last mask: on an unchanged previous step they give the same numbers as recomputing from `prev`, which is what the differential test checks.

(i) Module helpers:

```ts
/** Vertex k (0–3: (−x,−z) (+x,−z) (+x,+z) (−x,+z)) of a 3 × 3 patch: its 2 × 2 block (e0, e1, e2, e3 for vertexShares) and the centre's quadrant. */
const BLOCKS: readonly (readonly number[])[] = [[0, 1, 3, 4, 3], [1, 2, 4, 5, 2], [4, 5, 7, 8, 0], [3, 4, 6, 7, 1]]

/** Corner k of the patch's centre into out[o + k]; whether that vertex is smooth. */
function patchCorner(e: Int32Array, k: number, out: Float32Array, o: number, tmp: Float32Array): boolean {
  const b = BLOCKS[k]!
  const smooth = vertexShares(e[b[0]!]!, e[b[1]!]!, e[b[2]!]!, e[b[3]!]!, tmp, 0)
  out[o + k] = tmp[b[4]!]!
  return smooth
}

/** SurfaceView.front on a patch: a column at ec sending `out` toward cell j runs onto dry ground there, within JOIN below it. */
function frontIn(e: Int32Array, j: number, ec: number, out: number): boolean {
  const ej = e[j]!
  if (out <= 0 || ej >= 0 || ej === OUTSIDE) return false
  const drop = ec - ~ej
  return drop > 0 && drop <= JOIN
}
```

`refreshColumn`'s `front` stays as it is.

(j) `relight(cc, y0, y1)`: loop the ranks. For `r > 0`, a slot's light cell is `Math.ceil(level(this.layers.cur(c, r)) * PER_SUB)`, and only present slots are relit. Rebuild a layer's curtains with `this.buildCurtains(cc, d, 0, r)` and mark the key dirty.

(k) `buildCurtains(cc, d, carry, r = 0)`. Task 11 only threads `r` through; Task 12 adds straight curtains. For now `lay` is called as before for every rank.

- [ ] **Step 4: `WaterSurface` keys**

In `packages/engine/src/render/water/waterSurface.ts`, `update()` decodes keys:

```ts
  update(): void {
    const n = this.view.ccCount
    for (const key of this.view.takeDirty()) {
      const cc = key % n, r = (key - cc) / n, d = this.view.column(cc, r)
      if (d) this.sync(key, cc, r, d)
    }
  }
```

`sync(key, cc, r, d)` and `create(key, cc, r, d)` key `slots` by `key`, and name the meshes `water-${r}-${cc}` and `water-${r}-${cc}-curtains`.

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd packages/engine && npx vitest run test/surfaceLayers.test.ts test/surfaceView.test.ts test/ripples.test.ts`
Expected: PASS.

If the differential test fails, compare `refreshSlot` with `refreshColumn` line by line. The usual suspects are the corner order (quadrants 3, 2, 0, 1) and the smooth bits.

- [ ] **Step 6: Run every engine test and the types**

Run: `cd packages/engine && npx vitest run && cd ../.. && npm run typecheck`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add -A packages/engine/src/render/water packages/engine/test
git commit -m "feat(render): every draw layer gets its own quads; tiles with layers refresh per slot through links"
```

---

### Task 12: Straight curtains, ripples on any layer, stats and the browser

**Files:**
- Modify: `packages/engine/src/render/water/surfaceView.ts` (`buildCurtains`, `layStraight`, `spanDefault`, `surfaceNear`)
- Modify: `packages/engine/src/render/water/ripples.ts` (`surfaceNear`)
- Modify: `packages/engine/src/engine.ts` (`EngineStats.waterBodies`, `waterLayersHidden`)
- Modify: `apps/sandbox/src/hud.ts` (the physics line)
- Test: `packages/engine/test/surfaceLayers.test.ts` (new cases), `packages/engine/test/ripples.test.ts`, `apps/sandbox/e2e/water-render.spec.ts` (still passes)

**Interfaces:**
- `SurfaceView.surfaceNear(x, z, y): number | null`: the drawn surface (blocks) among the column's slots nearest to height y, within 2 blocks.
- `EngineStats` gains `waterBodies: number` and `waterLayersHidden: number`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/engine/test/surfaceLayers.test.ts`:

```ts
describe('curtains and ripples in layers', () => {
  it('water falling inside a cave hangs a straight curtain: no reach, no flare, foot at the water below', () => {
    // a cave (y 2–6) under a roof at y 7; a ledge (x 8–15 floor 4) above a lower pool (x 16–30 floor 2), both in the cave
    const w = layered((x, y, z) => {
      if (y < 2 || y >= 7 || x === 0 || x === 31 || z === 0 || z >= 4) return STONE
      if (x <= 15 && y < 4) return STONE
      if (x <= 15) return y === 4 ? wv(7) : AIR
      return y === 2 ? wv(4) : AIR
    })
    w.edges.ensure(w.cols, w.under, 32)
    for (let k = 0; k < 4; k++) w.step() // the ledge starts pouring
    const pub = new WaterPublisher(w.buffers.water), view = new SurfaceView([32, 32, 32], w.buffers.water, () => 15)
    const all = Array.from({ length: w.cols.tiles.count }, (_, t) => t)
    view.apply(pub.publish(all, w.cols, { under: w.under, edges: w.edges, height: 32 })!)
    const d = view.column(0, 1)!, cs = d.curtains
    expect(cs.count).toBeGreaterThan(0)
    for (let k = 0; k < cs.count; k++) {
      expect(cs.reach[k * 4 + 2]).toBe(0)
      expect(cs.reach[k * 4 + 3]).toBe(0)
      expect(cs.thick[k * 4 + 2]).toBe(0)
      expect(cs.cur[k * 4 + 2]!).toBeLessThan(cs.cur[k * 4]!) // the foot is below the top
    }
  })

  it('surfaceNear finds the slot at the edit height: the lake under a bridge, not the dry deck above', () => {
    const { view, publish } = bridgedView()
    publish()
    expect(view.surfaceNear(15, 2, 5)).toBeCloseTo(6, 6)
    expect(view.surfaceNear(15, 2, 20)).toBeNull()
  })
})
```

Move `bridgedView` out of the first `describe` to module level, so both blocks use it.

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/engine && npx vitest run test/surfaceLayers.test.ts`
Expected: FAIL. `surfaceNear` is not a function, and the cave curtain has a reach > 0 (laid by `lay`).

- [ ] **Step 3: Straight curtains and `surfaceNear`**

In `surfaceView.ts`:

(a) In `buildCurtains(cc, d, carry, r)`, choose the layer of each curtain. Where `lay` is called twice (previous and current step), use:

```ts
        const straight = r > 0 || !this.spanDefault(x, z, dir)
        const v2 = straight ? exitSpeed(Math.max(0, this.slotEdgeFlux(c, r, x, z, dir)), this.stepHz) : v
        if (straight) this.layStraight(cs, o, false, was, x, z, r, dir, v2)
        else this.lay(cs, o, false, was, x, z, dir, v)
        const water = straight ? this.layStraight(cs, o, true, now, x, z, r, dir, v2) : this.lay(cs, o, true, now, x, z, dir, v)
```

and compute `flux` for `packFlux` from `this.slotEdgeFlux(c, r, x, z, dir)` when `straight`.

(b) Add:

```ts
  /** Whether a curtain from (x, z) through `dir` sees only default links: its column, the ARC_COLUMNS ahead and the rows beside them. */
  private spanDefault(x: number, z: number, dir: number): boolean {
    const dx = DIR_X[dir]!, dz = DIR_Z[dir]!, sx = this.sx, sz = this.sz
    for (let i = 0; i <= ARC_COLUMNS; i++) for (let s = -1; s <= 1; s++) {
      const ax = x + dx * i + (dz !== 0 ? s : 0), az = z + dz * i + (dx !== 0 ? s : 0)
      if (ax < 0 || az < 0 || ax >= sx || az >= sz) continue
      if (this.layers.has(ax + az * sx, 0)) return false
    }
    return true
  }

  /** Water leaving slot (c, r) at (x, z) through `dir` (1/SUB block per step): its own +x / +z flux, or minus its resolved neighbour's. */
  private slotEdgeFlux(c: number, r: number, x: number, z: number, dir: number): number {
    if (r === 0 && (dir === 0 || dir === 2)) return dir === 0 ? this.fluxX[c]! : this.fluxZ[c]!
    if (dir === 0) return this.layers.fluxX(c, r)
    if (dir === 2) return this.layers.fluxZ(c, r)
    resolve(this.src, x, z, r, dir, true)
    if (hit.c < 0) return 0
    const f = dir === 1 ? (hit.r === 0 ? this.fluxX[hit.c]! : this.layers.fluxX(hit.c, hit.r)) : hit.r === 0 ? this.fluxZ[hit.c]! : this.layers.fluxZ(hit.c, hit.r)
    return -f
  }

  /**
   * A straight curtain (plan decision 15) for one step: both ends drop to the level of the slot's resolved neighbour through
   * `dir`, with no reach, body or lip and a closed flare; a splash where that neighbour is drawn water. Returns which ends
   * land on drawn water, as lay does.
   */
  private layStraight(cs: Curtains, o: number, cur: boolean, on: boolean, x: number, z: number, r: number, dir: number, v: number): number {
    const out = cur ? cs.cur : cs.prev, rr = cur ? o + 2 : o
    resolve(this.src, x, z, r, dir, cur)
    const foot = hit.e === OUTSIDE ? null : level(hit.e) * PER_SUB, wet = on && hit.c >= 0 && hit.e >= 0
    for (let end = 0; end < 2; end++) {
      out[o + 2 + end] = on && foot !== null ? Math.min(out[o + end]!, foot) : out[o + end]!
      cs.reach[rr + end] = 0
      cs.thick[rr + end] = 0
      cs.flare[rr + end] = flareCode(1, 0)
      this.endSplash[end] = wet ? splashCode(splashHalf(v), 0) : 0
      this.endLip[end] = 0
    }
    return wet ? 3 : 0
  }

  /** The drawn surface (blocks) of column (x, z) nearest to height y among its slots, within 2 blocks; null when none. */
  surfaceNear(x: number, z: number, y: number): number | null {
    if (x < 0 || z < 0 || x >= this.sx || z >= this.sz) return null
    const c = x + z * this.sx
    let best: number | null = null
    for (let r = 0; r < RANKS; r++) {
      if (r > 0 && !this.layers.has(c, r)) continue
      const v = r === 0 ? this.cur[c]! : this.layers.cur(c, r), f = r === 0 ? this.floor[c]! : this.layers.floor(c, r)
      if (!shows(v, f)) continue
      const s = v * PER_SUB
      if (Math.abs(s - y) <= 2 && (best === null || Math.abs(s - y) < Math.abs(best - y))) best = s
    }
    return best
  }
```

Import `splashCode`, `splashHalf`, `flareCode`, `DIR_X`, `DIR_Z` and `exitSpeed` if they are not imported yet.

- [ ] **Step 4: Ripples read the layer at the edit's height**

In `packages/engine/src/render/water/ripples.ts`, replace each `view.surfaceAt(px, pz)` in `waterLineSurface` and `editRipples` with `view.surfaceNear(px, pz, y)`, where `y` is the edited cell's height those functions already take. In `ripples.test.ts`, any test stub of `SurfaceView` gains `surfaceNear(x, z) { return this.surfaceAt(x, z) }`.

- [ ] **Step 5: Stats and HUD**

In `packages/engine/src/engine.ts`:
- `EngineStats` gains `waterBodies: number` and `waterLayersHidden: number`, documented "bodies with a boundary in an awake tile" and "wet segments ranked past the 4 draw layers (not drawn)";
- `physicsStats` starts with both at 0;
- the stats getter copies them from the tick's physics.

In `apps/sandbox/src/hud.ts`, append ` · bodies ${s.waterBodies}` to the physics line, and ` · hidden ${s.waterLayersHidden}` when it is not 0.

- [ ] **Step 6: Run the unit tests, the types and the water e2e**

Run: `cd packages/engine && npx vitest run && cd ../.. && npm run typecheck && npm test`
Expected: green.

Run: `cd apps/sandbox && E2E_PORT=5174 npx playwright test e2e/water-render.spec.ts e2e/flood.spec.ts --workers=1`
Expected: pass (water-render 1, flood 2 + gated skips). Stop anything on 5174 first.

- [ ] **Step 7: Commit**

```bash
git add -A packages/engine/src packages/engine/test apps/sandbox/src
git commit -m "feat(render): straight curtains in caves and under roofs, ripples on the layer at the edit, bodies and hidden layers on the HUD"
```

---

### Task 13: Conservation fuzz with caves, determinism, and the bench

**Files:**
- Modify: `packages/engine/test/waterFuzz.test.ts`
- Modify: `docs/superpowers/plans/2026-10-05-water-layers.md` ("Checkpoint results")

**Interfaces:** none new.

- [ ] **Step 1: Write the fuzz on layered terrain**

Add to `packages/engine/test/waterFuzz.test.ts`:

```ts
/** Random ground 3–9 high with caves (random air pockets inside it), stone slabs floating over it, and water to y 6. */
function caved(seed: number): Fill {
  const rng = new Pcg32(seed)
  const h = Array.from({ length: 32 * 32 }, () => 3 + rng.nextInt(7))
  const cave = Array.from({ length: 32 * 32 * 12 }, () => rng.nextInt(5) === 0)
  const slab = Array.from({ length: 32 * 32 }, () => (rng.nextInt(6) === 0 ? 8 + rng.nextInt(4) : -1))
  return (x, y, z) => {
    const c = x + z * 32, top = h[c]!
    if (y === 0) return B.stone
    if (y < top) return y < 12 && cave[c * 12 + y] ? (y <= 6 ? w(7) : AIR) : B.stone
    if (y === slab[c]) return B.stone
    return y <= 6 ? w(7) : AIR
  }
}

describe('water conservation in layers', () => {
  it('keeps the total exact and the debug check quiet under random edits on caved terrain, and a replay matches', () => {
    for (const seed of [4, 5, 6]) {
      const logs: string[] = []
      const sim = waterSim(caved(seed), { seed, water: { debug: true }, log: (m) => logs.push(m) })
      const rng = new Pcg32(seed * 131)
      let seq = 0
      for (let t = 0; t < 400; t++) {
        for (let k = 0; k < 3; k++) {
          const c = command(rng)
          if (c) sim.submit(0, seq++, c)
        }
        sim.step()
        expect(sim.water.total()).toBe(sim.water.expected)
      }
      expect(sim.water.check()).toEqual([])
      expect(logs).toEqual([])
      const replay = waterSim(caved(seed), { seed, water: { debug: true } })
      let i = 0
      for (let t = 0; t < 400; t++) {
        while (i < sim.commandLog.length && sim.commandLog[i]!.tick === t) { const c = sim.commandLog[i++]!; replay.submit(c.clientId, c.seq, c.cmd) }
        replay.step()
      }
      expect(replay.hash()).toBe(sim.hash())
    }
  }, 180_000)
})
```

- [ ] **Step 2: Run it**

Run: `cd packages/engine && npx vitest run test/waterFuzz.test.ts`
Expected: PASS.

A failure is a 3d bug. Shrink it: find the first tick where `total()` differs from `expected`, log that tick's commands, then fix the code. Never loosen the assertions.

- [ ] **Step 3: Run the dam bench and compare with 3c**

Run: `cd apps/sandbox && npm run bench:dam > ../../bench-3d.txt 2>&1; tail -20 ../../bench-3d.txt`
Expected: tick p95 within 1.2× of Task 0's 3c baseline (spec §7).

If it is over:
- measure first: wrap `edges.ensure`, `bodies.ensure`, `collectUnder` and the under phases in `performance.now()` in a local build;
- the flood scene has two lower segments' worth of columns (the pillars), so the cost is almost certainly the per-step overhead of the new phases on empty lists;
- make each phase return at once when its list is empty (`uT.length === 0`, no bodies, no pending edge tiles), re-run, and record the numbers.

- [ ] **Step 4: Record the numbers**

In "Checkpoint results", add **3d bench (Task 13)** with the same lines as Task 0's, the ratio, and any optimisation made. Delete `bench-3d.txt`.

- [ ] **Step 5: Run everything and commit**

Run: `npm test && npm run typecheck` at the repo root.
Expected: green.

```bash
git add packages/engine/test/waterFuzz.test.ts docs/superpowers/plans/2026-10-05-water-layers.md packages/engine/src
git commit -m "test(sim): conservation fuzz on caved terrain with a replay; dam bench within 3c's budget"
```

---

### Task 14: The `caves` scene

**Files:**
- Create: `apps/sandbox/src/scenes/caves.ts`, `apps/sandbox/src/caves.worker.ts`
- Modify: `apps/sandbox/src/main.ts`
- Test: `apps/sandbox/test/caves.test.ts`, `apps/sandbox/e2e/caves.spec.ts`

**Interfaces:**
- Produces in `caves.ts`:
  - `CAVES_SIZE`, `LAKE`, `TUNNEL`, `SHAFT`, `POND`, `CAVE`, `DAM`, `VALLEY`, `CANAL`, `BRIDGES`;
  - `cavesColumn(x, z): (CaveBlock | null)[]`;
  - `cavesGenerator`;
  - `digTunnelCommands()`, `pierceRoofCommands()`, `openDamCommands()`, `openCanalCommands()`.
- `window.__elovox.caves = { digTunnel(), pierceRoof(), openDam(), openCanal() }` on `?scene=caves`.

- [ ] **Step 1: Write the failing scene test**

```ts
// apps/sandbox/test/caves.test.ts
import { Simulation } from '@elovox/engine/src/sim/simulation.ts'
import { createWorldBuffers } from '@elovox/engine/src/world/buffers.ts'
import { SUB } from '@elovox/engine/src/world/waterBuffers.ts'
import { describe, expect, it } from 'vitest'
import { BLOCKS } from '../src/blocks.ts'
import rules from '../src/rules.ts'
import {
  BRIDGES, CANAL, CAVE, CAVES_SIZE, DAM, LAKE, POND, SHAFT, TUNNEL, VALLEY,
  cavesColumn, cavesGenerator, digTunnelCommands, openDamCommands, pierceRoofCommands,
} from '../src/scenes/caves.ts'

function sim(): Simulation {
  const s = new Simulation({ buffers: createWorldBuffers([...CAVES_SIZE]), blocks: BLOCKS, rules, seed: 1, randomTicksPerChunk: 0, log: () => {} })
  s.configure(cavesGenerator, {})
  s.generate(cavesGenerator)
  return s
}

describe('caves scene layout', () => {
  it('has a lake, a dry tunnel closed by a plug, an open shaft, a cave under a shallow pond, a dam over a valley and a bridged canal', () => {
    const lake = cavesColumn(20, 20)
    expect(lake.slice(LAKE.floor, LAKE.top + 1).every((b) => b === 'water')).toBe(true)
    expect(cavesColumn(TUNNEL.x0 + 5, TUNNEL.z0)[TUNNEL.y0]).toBeNull() // dug, dry
    expect(cavesColumn(TUNNEL.plug, TUNNEL.z0)[TUNNEL.y0]).not.toBeNull() // the plug
    expect(cavesColumn(SHAFT.x0, SHAFT.z0).slice(TUNNEL.y0).every((b) => b === null)).toBe(true)
    const pond = cavesColumn(80, 15)
    expect(pond[POND.floor]).toBe('water')
    expect(pond[CAVE.roof]).not.toBeNull()
    expect(pond.slice(CAVE.y0, CAVE.y1 + 1).every((b) => b === null)).toBe(true)
    expect(cavesColumn(30, DAM.z)[LAKE.floor]).not.toBeNull()
    expect(cavesColumn(30, VALLEY.z0)[VALLEY.floor]).toBeNull()
    expect(cavesColumn(CANAL.x0, BRIDGES[1]!.z)[BRIDGES[1]!.deck]).not.toBeNull()
  })
})

describe('caves scene simulation', () => {
  it('reads its lower segments: the cave under the pond, the canal under the low bridge full and grouped', () => {
    const s = sim()
    expect(s.water.segments(80, 15)[0]).toMatchObject({ floor: CAVE.y0, ceil: CAVE.roof, depth: 0 })
    for (let t = 0; t < 3; t++) s.step()
    const under = s.water.segments(CANAL.x0, BRIDGES[1]!.z)[0]!
    expect(under).toMatchObject({ floor: CANAL.floor, ceil: BRIDGES[1]!.deck })
    expect(under.depth).toBe((BRIDGES[1]!.deck - CANAL.floor) * SUB)
    expect(under.body).toBeGreaterThanOrEqual(0)
  }, 120_000)

  it('the hooks: the dam hole drains the lake, the pierced roof fills the cave, the tunnel lifts the shaft', () => {
    const s = sim()
    const total = s.water.total()
    ;[...openDamCommands(), ...pierceRoofCommands(), ...digTunnelCommands()].forEach((c, i) => s.submit(0, i, c))
    for (let t = 0; t < 1500; t++) s.step()
    expect(s.water.total()).toBe(total)
    let cave = 0
    for (let z = CAVE.z0; z <= CAVE.z1; z++) for (let x = CAVE.x0; x <= CAVE.x1; x++) cave += s.water.segments(x, z)[0]!.depth
    expect(cave).toBeGreaterThan(100 * SUB)
    let valley = 0
    for (let z = VALLEY.z0; z <= VALLEY.z0 + 20; z++) for (let x = 20; x <= 40; x++) valley += s.water.column(x, z).depth
    expect(valley).toBeGreaterThan(0)
    expect(s.water.column(SHAFT.x0, SHAFT.z0).surface).toBeGreaterThan((TUNNEL.y1 + 1) * SUB)
  }, 300_000)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/sandbox && npx vitest run test/caves.test.ts`
Expected: FAIL, `Cannot find module '../src/scenes/caves.ts'`.

- [ ] **Step 3: Write the scene**

```ts
// apps/sandbox/src/scenes/caves.ts
import type { Command } from '@elovox/engine'
import { defineGenerator } from '@elovox/engine/sim-worker'
import { AIR, packVoxel } from '@elovox/engine/src/world/voxel.ts'

/** A test bed for 3d (multi-layer water): every layered case in one 128 × 64 × 128 world, closed until a hook opens it. */
export const CAVES_SIZE = [128, 64, 128] as const
/** Default solid layers: a column is solid for y < GROUND. */
export const GROUND = 32
/** A lake (bed solid below `floor`, water floor..top). */
export const LAKE = { x0: 8, x1: 47, z0: 8, z1: 47, floor: 20, top: 27 } as const
/** A dry tunnel east of the lake (cells y0–y1, z0–z1) from x0 to x1, closed at the lake by a plug at x = plug (dug by digTunnel). */
export const TUNNEL = { plug: 48, x0: 49, x1: 79, z0: 27, z1: 28, y0: 22, y1: 23 } as const
/** A shaft at the tunnel's far end, open from the tunnel's floor to the sky. */
export const SHAFT = { x0: 80, x1: 81, z0: 27, z1: 28 } as const
/** A shallow pond (one block of water on a bed at `floor`). */
export const POND = { x0: 64, x1: 95, z0: 8, z1: 23, floor: 30 } as const
/** A dry cave under the pond (cells y0–y1), its roof from `roof` to the pond's bed. */
export const CAVE = { x0: 68, x1: 91, z0: 10, z1: 21, y0: 18, y1: 27, roof: 28 } as const
/** The lake's south bank, one block thick, with the valley right behind it (openDam opens a hole at the lake's floor). */
export const DAM = { z: 48, hole: { x0: 26, x1: 29 } } as const
export const VALLEY = { x0: 0, x1: 90, z0: 49, z1: 120, floor: 10 } as const
/** A canal (bed solid below `floor`, water floor..top) along z, with a high bridge (deck above the water) and a low one (deck in it). */
export const CANAL = { x0: 100, x1: 103, floor: 26, top: 29 } as const
export const BRIDGES = [{ z: 40, deck: 31 }, { z: 60, deck: 29 }] as const
/** Where openCanal cuts the canal's west bank into the valley. */
export const CUT = { x0: 91, x1: 99, z0: 100, z1: 103 } as const

export type CaveBlock = 'stone' | 'dirt' | 'grass' | 'water'

const inLake = (x: number, z: number) => x >= LAKE.x0 && x <= LAKE.x1 && z >= LAKE.z0 && z <= LAKE.z1
const inPond = (x: number, z: number) => x >= POND.x0 && x <= POND.x1 && z >= POND.z0 && z <= POND.z1
const inCave = (x: number, z: number) => x >= CAVE.x0 && x <= CAVE.x1 && z >= CAVE.z0 && z <= CAVE.z1
const inValley = (x: number, z: number) => x >= VALLEY.x0 && x <= VALLEY.x1 && z >= VALLEY.z0 && z <= VALLEY.z1
const inCanal = (x: number) => x >= CANAL.x0 && x <= CANAL.x1
const inTunnelZ = (z: number) => z >= TUNNEL.z0 && z <= TUNNEL.z1
const inShaft = (x: number, z: number) => x >= SHAFT.x0 && x <= SHAFT.x1 && z >= SHAFT.z0 && z <= SHAFT.z1

/** Solid layers under (x, z) before carving. */
function groundAt(x: number, z: number): number {
  if (inLake(x, z)) return LAKE.floor
  if (inPond(x, z)) return POND.floor
  if (inValley(x, z)) return VALLEY.floor
  if (inCanal(x)) return CANAL.floor
  return GROUND
}

/** The scene's blocks for one column, bottom to top (index = y). Pure. */
export function cavesColumn(x: number, z: number): (CaveBlock | null)[] {
  const col = new Array<CaveBlock | null>(CAVES_SIZE[1]).fill(null)
  const g = groundAt(x, z)
  for (let y = 0; y < g; y++) col[y] = y === g - 1 ? (inLake(x, z) || inPond(x, z) || inCanal(x) ? 'dirt' : 'grass') : y >= g - 4 ? 'dirt' : 'stone'
  if (inLake(x, z)) for (let y = LAKE.floor; y <= LAKE.top; y++) col[y] = 'water'
  if (inPond(x, z)) col[POND.floor] = 'water'
  if (inCanal(x)) for (let y = CANAL.floor; y <= CANAL.top; y++) col[y] = 'water'
  if (inCave(x, z)) for (let y = CAVE.y0; y <= CAVE.y1; y++) col[y] = null
  if (inTunnelZ(z) && x >= TUNNEL.x0 && x <= TUNNEL.x1) for (let y = TUNNEL.y0; y <= TUNNEL.y1; y++) col[y] = null
  if (inShaft(x, z)) for (let y = TUNNEL.y0; y < col.length; y++) col[y] = null
  for (const b of BRIDGES) if (z === b.z && x >= CANAL.x0 - 1 && x <= CANAL.x1 + 1) col[b.deck] = 'stone'
  return col
}

export const cavesGenerator = defineGenerator({
  generateColumn(ctx, cx, cz) {
    const ids: Record<CaveBlock, number> = { stone: ctx.id('stone'), dirt: ctx.id('dirt'), grass: ctx.id('grass'), water: packVoxel(ctx.id('water'), 7) }
    for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
      const col = cavesColumn(cx * 32 + lx, cz * 32 + lz)
      for (let y = 0; y < col.length; y++) {
        const b = col[y]
        if (b) ctx.set(lx, y, lz, ids[b])
      }
    }
  },
})

/** Digs the tunnel's plug: the lake runs into the tunnel and lifts the shaft. */
export function digTunnelCommands(): Command[] {
  return [{ type: 'fillRegion', min: [TUNNEL.plug, TUNNEL.y0, TUNNEL.z0], max: [TUNNEL.plug, TUNNEL.y1, TUNNEL.z1], voxel: AIR }]
}
/** Pierces the cave's roof under the pond's middle. */
export function pierceRoofCommands(): Command[] {
  return [{ type: 'fillRegion', min: [80, CAVE.roof, 15], max: [80, POND.floor - 1, 15], voxel: AIR }]
}
/** Opens a hole through the dam at the lake's floor, two blocks high, the dam solid above it. */
export function openDamCommands(): Command[] {
  return [{ type: 'fillRegion', min: [DAM.hole.x0, LAKE.floor, DAM.z], max: [DAM.hole.x1, LAKE.floor + 1, DAM.z], voxel: AIR }]
}
/** Cuts the canal's west bank into the valley: the canal runs under both bridges toward the cut. */
export function openCanalCommands(): Command[] {
  return [{ type: 'fillRegion', min: [CUT.x0, CANAL.floor, CUT.z0], max: [CUT.x1, GROUND - 1, CUT.z1], voxel: AIR }]
}
```

```ts
// apps/sandbox/src/caves.worker.ts
import { runSimWorker } from '@elovox/engine/sim-worker'
import rules from './rules.ts'
import { cavesGenerator } from './scenes/caves.ts'

runSimWorker({ rules, generator: cavesGenerator })
```

- [ ] **Step 4: Wire it into `main.ts`**

In `apps/sandbox/src/main.ts`:
- **Scene name:** accept `'caves'` in `sceneName`.
- **Size and worker:** size `[...CAVES_SIZE]`; the worker `new Worker(new URL('./caves.worker.ts', import.meta.url), { type: 'module' })`; `terrain: { scene: 'caves' }`, as flood does.
- **Camera:** target (64, 26, 64), distance 200, pitch 0.8, beside flood's block.
- **Hooks:**

  ```ts
  const caves = sceneName === 'caves'
    ? {
        digTunnel: () => digTunnelCommands().forEach((c) => engine.submit(c)),
        pierceRoof: () => pierceRoofCommands().forEach((c) => engine.submit(c)),
        openDam: () => openDamCommands().forEach((c) => engine.submit(c)),
        openCanal: () => openCanalCommands().forEach((c) => engine.submit(c)),
      }
    : null
  ```

- **Window:** add `caves` to the `__elovox` object.

- [ ] **Step 5: Write the e2e**

```ts
// apps/sandbox/e2e/caves.spec.ts
import { expect, test, type Page } from '@playwright/test'
import type { Engine } from '@elovox/engine'

type Caves = { digTunnel(): void; pierceRoof(): void; openDam(): void; openCanal(): void }
type W = Window & { __elovox?: { engine: Engine; caves: Caves | null; ready: boolean } }

async function open(page: Page): Promise<string[]> {
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/?scene=caves')
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 120_000 })
  return errors
}

/** Whether voxel (x, y, z) holds water. */
function wet(page: Page, x: number, y: number, z: number): Promise<boolean> {
  return page.evaluate(([x, y, z]) => {
    const e = (window as W).__elovox!.engine
    return (e.world.get(x!, y!, z!) & 0xfff) === e.blocks.id('water')
  }, [x, y, z])
}

test('the pierced roof pours the pond into the cave; the dam hole drains into the valley; the tunnel lifts the shaft', async ({ page }) => {
  test.setTimeout(300_000)
  const errors = await open(page)
  expect(await wet(page, 80, 18, 15)).toBe(false)
  await page.evaluate(() => { const c = (window as W).__elovox!.caves!; c.pierceRoof(); c.openDam(); c.digTunnel() })
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine, water = e.blocks.id('water')
    return (e.world.get(80, 18, 15) & 0xfff) === water
  }, null, { timeout: 180_000, polling: 1000 })
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine, water = e.blocks.id('water')
    for (let x = 20; x <= 40; x++) if ((e.world.get(x, 10, 50) & 0xfff) === water) return true
    return false
  }, null, { timeout: 180_000, polling: 1000 })
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine
    return (e.world.get(80, 25, 27) & 0xfff) === e.blocks.id('water') // above the tunnel's roof: pressure lifted it
  }, null, { timeout: 180_000, polling: 1000 })
  expect(errors).toEqual([])
})
```

- [ ] **Step 6: Run the unit test and the e2e**

Run: `cd apps/sandbox && npx vitest run test/caves.test.ts`
Expected: PASS.

Run: `cd apps/sandbox && E2E_PORT=5174 npx playwright test e2e/caves.spec.ts --workers=1`
Expected: PASS. Stop anything on 5174 first.

- [ ] **Step 7: Commit**

```bash
git add apps/sandbox/src/scenes/caves.ts apps/sandbox/src/caves.worker.ts apps/sandbox/src/main.ts apps/sandbox/test/caves.test.ts apps/sandbox/e2e/caves.spec.ts
git commit -m "feat(sandbox): the caves scene: a U-tunnel and shaft, a cave under a pond, a dam hole, a bridged canal"
```

---

### Task 15: Checkpoints with the user

This task is interactive. The controller drives it with the user, who runs the app on the laptop and decides the tuning. Record every result and every change in "Checkpoint results" below.

**Setup:** run `cd apps/sandbox && npx vite --port 5174`, then open `http://localhost:5174/?scene=caves`. The HUD's physics line shows awake water tiles, wet segments, bodies, and hidden layers when there are any.

**Tuning knobs:**

| What | Where |
|---|---|
| When a draining body lets its top go | `LEAVE` in `sim/water/constants.ts` |
| Every 3c knob | 3c plan, Task 13 table |
| Straight curtains | `layStraight` in `render/water/surfaceView.ts` |

- [ ] **Checkpoint 1: The dam hole.** Run `__elovox.caves.openDam()`. The lake drains through the two-block hole under the solid dam into the valley. A straight curtain falls from the hole. Everything settles.
- [ ] **Checkpoint 2: The U-tunnel.** Run `__elovox.caves.digTunnel()` on a fresh page. The tunnel fills, and the shaft's water rises to the lake's level, sways a little and settles. The lake goes down by what the tunnel and the shaft took.
- [ ] **Checkpoint 3: The pierced roof.** Run `__elovox.caves.pierceRoof()` on a fresh page. The pond pours through the hole as a curtain, and the cave fills (seen through the hole). The pond empties.
- [ ] **Checkpoint 4: The bridged canal.** Judge the water under both bridges: no seam where the layers meet. Then run `__elovox.caves.openCanal()`: the canal flows under both bridges toward the cut. The low deck stays dry on top.
- [ ] **Checkpoint 5: Flood regression.** Open `?scene=flood`. Dam break, channel, river and sand, as accepted at 3c's checkpoints: the same look and speed. The pillar over the lake now stands on a layer-1 slot: no seam.
- [ ] **Checkpoint 6: Laptop measurements.**
  - Targets:
    - dam break and stress (`BENCH=1 E2E_PORT=5174 npx playwright test e2e/flood-bench.spec.ts --workers=1 --headed`, or the HUD) at tick p95 ≤ 10 ms and ≥ 45 fps;
    - `?scene=terrain` idle with 0 water tiles.
  - The pending 3c measurements: the HUD's `waterApply` during the dam break. Over budget: spread `SurfaceView.apply` over frames (record the decision).
- [ ] **Also check** `?scene=diorama` and `?scene=world` for regressions, and that there are no console errors.
- [ ] **Record and commit.** Fill in "Checkpoint results", then:

```bash
git add docs/superpowers/plans/2026-10-05-water-layers.md
git commit -m "docs(plan): multi-layer water 3d checkpoint results"
```

---

## Spec coverage

| Spec | Tasks |
|---|---|
| §1 Decisions: cases, pressure, air, dry caves | 5–7 (cases), 6 (pressure), 7 (no static water), 14 (scene) |
| §2 Success criteria | 6, 7, 13, 14, 15 |
| §3 Segments, edges, storage | 1, 3, 4 |
| §3 The free step (opening floor, inflow limit, falls) | 5; decision 5 |
| §4 Bodies, H, slack, hysteresis, sealed, sleep, edits in a body | 6, 7; decisions 2, 9 |
| §4 Determinism | 1 (pool order), 3 (edge order), 6 (body order), 7, 13 |
| §5 Mirror | 4, 7 |
| §5 Edits table | 2, 7; decision 8 |
| §5 Rebuild | 4, 7; decision 11 |
| §5 Sea and springs | 7; decisions 7, 10 |
| §6 Draw layers, corners by connection, publishing | 9, 10, 11; decisions 3, 4, 13, 14 |
| §6 What is drawn (curtains, light, ripples) | 11, 12; decision 15 |
| §6 Removed (static mesher path) | 8 |
| §7 Performance | 5 (no-layer step = 3c), 13 (bench), 15 (laptop) |
| §8 API, stats, errors | 7 (check), 9 (records, hidden), 12 (EngineStats, HUD) |
| §9 Tests | 1–14; checkpoints 15 |

## Checkpoint results

*(Filled in during Tasks 0, 13 and 15.)*

### 3c baseline (Task 0)

`npm run bench:dam` on `5defe84` (desktop, Node):

```
dam break, 3000 ticks in 9.8 s; Σ depth + sea off on 0 ticks
  sim tick        p50 3.42  p95 4.62  max 10.07 ms
  water step      p50 2.05  p95 2.82  max 6.04 ms
  mirror+publish  p50 0.96  p95 1.51  max 6.23 ms
```
