# Sub-project 3c: Heightfield water Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Water as a continuous height per column (x, z) that flows with inertia ("virtual pipes"), drawn as a smooth surface that moves between sim steps, with waterfall curtains and current. It replaces 3a's cell automaton and pools.

**Architecture:**
- **Sim worker** (`packages/engine/src/sim/water/`): a pure, Node-testable core:
  - `columns.ts`: the column store and the step;
  - `tiles.ts`: 16 × 16 sleeping tiles;
  - `cycle.ts`: the sea and springs;
  - `edits.ts`: how one voxel write changes a column;
  - `mirror.ts`: water voxels as a mirror of the heightfield;
  - `rebuild.ts`: columns from the voxels;
  - `publish.ts`: the shared double buffer.
- `WaterSystem` (`waterSystem.ts`) wires them into `Simulation`: every write goes through `onWrite`, the step runs every tick, and the mirror and the publish run every tick, paused or not.
- **Shared memory** (`world/waterBuffers.ts`, part of `WorldBuffers`):
  - the floor of every column, which the mesh workers read to tell static water from simulated water;
  - every column's surface and flux, double-buffered by publish parity, which the main thread reads.
- **Main thread** (`packages/engine/src/render/water/`):
  - `SurfaceView` (pure) reads the published tiles and keeps the previous and current step. It computes per-column corner heights, flow, light and white water, and the waterfall curtains.
  - `WaterSurface` (three.js) draws one instanced quad per column and one instanced quad per curtain, per chunk column, with partial buffer updates. The vertex shader interpolates between the two steps.
  - `render/water.ts` shares one water shading between static voxel water, the surface and the curtains.
- Static water (below its column's floor) stays in the voxel liquid mesher.

**Tech Stack:** TypeScript (strict, `erasableSyntaxOnly`), three.js 0.186.1 WebGPU/TSL, Vite, Vitest 4, Playwright, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-04-water-heightfield-design.md` (3a context: `docs/superpowers/specs/2026-10-03-simulation-water-design.md`, `docs/superpowers/plans/2026-10-03-simulation-water.md`).

## Global Constraints

- Work happens on branch `feat/water-heightfield`, created from `main` after 3a (`feat/sim-water`) is merged (Task 0).
- World state is integers only. The water code uses no `Math.random`, `Date` or `performance.now`, and no floats in stored state.
- Iteration orders are fixed:
  - tiles in index order, starting at the round-robin cursor;
  - columns row-major inside a tile;
  - springs in insertion order;
  - chunk columns in index order.
- Units:
  - `SUB = 256` (one block = 256 sub-units);
  - a column's surface is `S = floor × SUB + depth`;
  - flux is stored with `FLUX_FP = 4` extra bits, so a stored flux of 16 moves 1/SUB block per step.
- Starting constants, tuned in Task 13:

  | Constant | Value |
  |---|---|
  | `FRICTION_SHIFT` | 4 |
  | `GAIN` | 2 (k = 1/8) |
  | `MAX_HEAD` | 2 × SUB |
  | `MIN_FLOW` | 4 |
  | `TILE` | 16 |
  | `SLEEP_STEPS` | 10 |
  | `FLUX_EPS` | 2 |
  | `DEPTH_EPS` | 2 |
  | `OVERHANG` | 6 |
  | `SPRING_SCALE` | 16 |
  | `waterTileCap` | 1024 (default) |
- The water step runs every tick (20 Hz).
- A **wall** is any block that is neither air nor the simulated water. Springs and other liquids are walls (planning decision 1).
- The mirror quantizes the surface in eighths: `quantize(S) = (S + 16) >> 5`. Cells under it are full; the surface cell gets level `units − 1`; below 1/16 block the cell is air.
- `erasableSyntaxOnly`: no TS constructor parameter properties, no enums, no namespaces. Assign fields in the constructor body.
- Budgets (spec §2): sim tick ≤ 10 ms p95 and ≥ 45 fps during the dam break on the laptop. Still water costs nothing per tick.
- Repo artifacts are in English.
- Commits use conventional English messages and **no** `Co-Authored-By` trailer: the project's `.claude/settings.json` sets no `attribution.commit`.
- Commands:

  | What | Command |
  |---|---|
  | Engine tests | `cd packages/engine && npx vitest run test/<file>` |
  | Every test | `npm test` at the repo root |
  | Types | `npm run typecheck` at the repo root |
  | E2E | `cd apps/sandbox && E2E_PORT=5174 npx playwright test <spec> --workers=1` |
  | Benches | set `BENCH=1` |

  The e2e needs a fresh server: stop anything listening on 5174 first.

## Review Focus

The spec implies these inputs, but no task's own tests would exercise them unless pinned here. Each one has a test in the task named.

1. **Hotbar water in mid-air or on a lake.**
   - The placed voxel joins its column: the surface rises by exactly its volume, and the voxel is gone after the next tick.
   - It must never stay as a floating water cell.
   - *Test in Task 6.*
2. **Edits and regeneration while physics is paused** (the terrain editor).
   - Commands keep columns exact, and the mirror still updates.
   - `replaceColumns` rebuilds its region at once.
   - Resuming needs no rebuild and loses no water.
   - *Test in Task 7.*
3. **A bridge or a block above water, and water rising past a floating block.**
   - The floor does not move, and the mirror never overwrites the block.
   - Removing the block lets water into the gap.
   - *Tests in Task 4 (mirror) and Task 6 (world).*
4. **World edges.**
   - Water at x = 0, x = sx − 1, z = 0 and z = sz − 1 never flows out.
   - No edge outside the world is read or written.
   - *Test in Task 2.*
5. **The main thread falling behind the sim.**
   - A tick message read after its buffer was reused must not apply stale or torn data.
   - Its tiles are read at the next message, from a buffer that is complete.
   - *Test in Task 9.*

---

## Planning decisions (resolving the spec)

Each one was found while reading the code or the spec, and is accepted here. The spec stays the source for everything else.

1. **Springs and other liquids are walls.**
   - The spec says a wall is "neither air nor liquid". A spring is a liquid block, but the mirror must never overwrite it, and gravity already lands on springs.
   - So a spring is the floor block its water rests on.
   - Only one liquid is simulated: `waterGroupOf(registry)`, the first liquid without `source`. Other liquids are static voxels and walls for water.
2. **Floors change only through edits and rebuilds.** A column that dries out through flow keeps its floor, so a lake under a bridge can drain and fill again. The spec's "a dry column's floor is its highest wall" holds at rebuild (decision 4).
3. **Walls on dry columns.**
   - A wall placed on a dry column's floor raises the floor.
   - A wall placed higher (a floating block) is ignored, like a bridge over water.
   - Everything else follows the spec's edit table (design notes, Edits).
4. **Rebuild reads each column from the top.**
   - If the first non-air block is water, the run of water down from it is the column's water, and the block under the run is its floor.
   - A wall run is skipped when it is at most `OVERHANG` (6) blocks thick and floats over air or water: a bridge, a canopy, the flood scene's sand pillar on planks. The scan then continues below it.
   - Otherwise the column is dry, with its floor on that wall.
   - Water under a roof thicker than 6 blocks (a cave) is static.
   - Accepted limit: a flooded cave under 6 or fewer blocks of ground becomes the column's water.
5. **Blocked edges apply per direction.** Water never moves into a column whose floor is at or above the sender's surface. This is a superset of the spec's rule, where both sides are blocked. Without it, inertia could push water up a wall.
6. **Flux is fixed point, and rounding is symmetric.**
   - Flux keeps 4 extra bits, so the acceleration needs no shift that would round small heads to 0.
   - Friction rounds away from zero, so a lone flux always dies out.
   - Transfers truncate toward zero, so neither direction is favoured.
   - The spec's formula is `f ← f − (f >> 4) + ((clamp(Sa − Sb, ±MAX_HEAD) × GAIN) >> GAIN_SHIFT)` with f in sub-units. Here f is carried 4 bits finer: `GAIN_SHIFT` equals `FLUX_FP` and is applied when water moves, not when the flux accelerates.
7. **The sea account's start value.**
   - A full rebuild sets `sea` to the water the sea columns hold, the counterpart of 3a's cycle pool volume. A region rebuild adds or removes the depth of columns that join or leave the sea.
   - With no sea level (`seaLevel` 0), springs are unbounded. `sea` then goes negative, and the identity `Σ depth + sea = constant` still holds.
   - With a sea level and an empty sea, springs stop (spec).
8. **Spring rate.**
   - 3a's `SPRING_RATES` were units (1/8 block) per 10 Hz fluid step.
   - At 20 Hz, in sub-units, that is `rate × 32 / 2`, so `SPRING_SCALE = 16`. A spring delivers the same volume per second as in 3a.
9. **A spring runs only as its column's floor block** (`floor === y + 1`). A buried spring, or one with a block on top of it, gives nothing.
10. **Regeneration rebuilds its region at once, even while paused.** The spec rebuilds "when physics resumes after the editor". Instead:
    - `replaceColumns` calls `water.rebuildRegion` for the chunk columns it rewrote;
    - edits while paused keep columns exact, and the mirror flushes every tick;
    - so resuming needs no rebuild. A whole-world rebuild on resume would cost about 1 s on a 1024² world.
11. **Mirror writes are quiet.**
    - `ChunkStore.setVoxelQuiet` writes under the chunk seqlock but leaves the chunk out of `commit()`'s remesh list.
    - The water block must be transparent and emit no light: `WaterSystem` throws otherwise, because mirror writes do not relight.
    - Decorations under freshly mirrored water update at the chunk's next remesh (accepted).
12. **Static versus simulated water in mesh workers.**
    - The mesh workers read the shared floor array.
    - A water voxel at `y ≥ floor` is drawn by the heightfield; below the floor, by the voxel liquid mesher.
    - The floor reaches the mesher through `ChunkSnapshot.floor` (34 × 34, relative to the chunk's base y).
13. **Surface rendering details.**
    - A column is drawn when it holds at least `SHOW_MIN` (16, 1/16 block). Thinner films would z-fight the ground; the mirror shows them as air anyway.
    - Corners average neighbours within `JOIN` (1 block); larger drops get curtains.
    - Ripple flow is quantized to 8 directions × still / gentle / steep, like 3a, so neighbouring quads mostly share a flow and their ripples do not tear.
14. **`physicsBusy`** also counts falling bodies (spec §7: "a body falls").
15. **Waking.**
    - An edit wakes tiles only when it changed the column's floor or depth and the column or a neighbour holds water. Rules that swap walls (grass, mud) never wake water.
    - After a rebuild, only tiles with a column that can flow somewhere wake, so a flat generated lake starts asleep.
16. **The dam-break e2e** cannot read 3a's exact flatness from voxels: the mirror quantizes to eighths, and a draining lake slopes toward the breach. It checks that the lake goes down, the valley fills, everything settles, and the lake ends flat to one level. The user judges the look in Task 13.

---

## Design notes (shared by Tasks 2–10)

Read this before any water task. The names here are the code's names.

### Columns

| Field (`WaterColumns`) | Type | Meaning |
|---|---|---|
| `floor[c]` | Int16, **shared** (`WaterBuffers.floor`) | y of the top face the water rests on |
| `depth[c]` | Int32 | water in 1/SUB block |
| `flux[2c]`, `flux[2c + 1]` | Int32 | flux through c's +x and +z edges, in 1/(16 SUB) block per step; positive toward +x / +z |
| `last[c]` | Int32 | depth after c's last step (the quiet test) |

- The column index is `c = x + z × sx`.
- The −x edge of c is the +x edge of c − 1, so each edge is stored once.
- Edges past the world border do not exist: the world edge is a wall.

### The step

The step runs over the **stepped tiles**: awake tiles, at most `tileCap` of them, round robin from a cursor, in visit order. Each phase runs over all stepped tiles before the next phase starts.

1. **Collect.**
   - Each stepped tile contributes its columns' +x and +z edges.
   - When the tile's −x (or −z) neighbour tile does not step, the tile also takes the neighbour's border edge into it, and the neighbour's border columns join a **ring**.
   - When its +x (or +z) neighbour does not step, that neighbour's border columns join the ring too.
   - Every edge touching a stepped tile is processed exactly once.
2. **Accelerate** each edge (a → b):
   - apply friction: `f = damp(f)`, which loses 1/16 rounded away from zero;
   - add the head: `f += clamp(Sa − Sb, ±MAX_HEAD) × GAIN`;
   - zero a flux from a sender shallower than `MIN_FLOW`, and a flux toward a column whose floor is at or above the sender's surface.
3. **Limit.** For each column of a stepped tile and each ring column, sum its outflows (`f >> 4` over its sending edges). If the sum exceeds its depth, scale every outflow to `floor(amount × depth / sum)` whole sub-units. No column can go negative.
4. **Transfer.**
   - Each edge moves `moved(f)` (truncated toward zero) from a to b.
   - Water crossing into a tile that does not step marks that tile dirty, and wakes it if at least `FLUX_EPS` crossed.
5. **Pin the sea.** Every sea column among those touched is set back to `seaLevel × SUB`. The difference is credited to `sea`; a deficit is debited from it.
6. **Settle** (rule revised in Task 8b). A stepped tile is quiet when no column changed by more than `DEPTH_EPS` since its last step and its water lies flat. The flatness test reads every edge touching the tile, its four borders included, so a world and its mirror image sleep alike:
   - no edge moved `FLUX_EPS` or more;
   - no run of connected water along a row or a column of the tile, extended one column past each border, spans more than `HEAD_EPS` (6). So no connected edge's head exceeds it either.
   - An edge connects its columns when the higher one is at least `MIN_FLOW` deep, or, level, when either is.
   - An edge between two films never connects. A film is under `SHOWN` = 1/16 block, which neither the mirror nor the renderer draws, and near `MIN_FLOW` the integers can hold a film sloped forever. Visible water beside a film still connects to it, so it cannot freeze standing above it.
   - the tile's mean slope along x and along z is at most 1/2^`SLOPE_SHIFT` (1/16) sub per column, plus 1/SUB of slack in all. Each run of 8 columns or more gives its fall from the mean of the 4 surfaces at each end, so leftover 1/SUB bumps cancel while a slope adds up. Shorter runs are not measured: an odd volume in a small pit swaps 1/SUB forever.
   - Why: a still lake never comes to rest in integers (leftover bumps move on forever), and from zero flux heads of 1–2 sub move nothing for longer than `SLEEP_STEPS`. Water moved alone therefore lets a gentle slope freeze. A per-edge head bound cannot both let a lake sleep and catch a slope.
   - After `SLEEP_STEPS` quiet steps the tile sleeps and its fluxes are zeroed, except a border edge whose other tile is still awake after the step: that tile goes on moving it.
   - A tile that does not step and took a trickle this step (under `FLUX_EPS`) is woken if it no longer lies flat.
   - A stepped tile is marked dirty when a depth changed or an edge moved water this step or the last one. The tile storing a border edge is marked dirty whenever that edge moved water this step or the last one.

Springs run before the step, so a spring's tile is stepped in the same tick. The sea pin runs inside the step.

**Stability bound.**
- Write `k = GAIN / 2^FLUX_FP` (here 1/8): the stored flux per step per sub-unit of head.
- Without friction and the limiter, the step is symplectic Euler on the discrete wave equation `h'' = −k · L h`, where L is the 4-neighbour Laplacian.
- A mode with Laplacian eigenvalue λ is stable while `k · λ ≤ 4`. The checkerboard mode has the largest eigenvalue, λ = 8, so the step needs `k ≤ 1/2`.
- `k = 1/8` leaves a 4× margin. Friction and the outflow limiter only remove energy, so they can never push the step past it.
- Long waves travel at `√k ≈ 0.35` columns per step, about 7 blocks/s at 20 Hz.
- Friction `1/16` per step damps a wavelength-28 slosh at about ζ ≈ 0.4: it overshoots by about 25% and settles in about 2 s. That is the "overshoots a little and settles" of spec §2. Longer sloshes are close to critically damped.

### Tiles

- `WaterTiles` stores flags per tile `t = tx + tz × (sx / 16)`:
  - `awake` (steps);
  - `quiet` (count of consecutive quiet steps);
  - `dirty` (a column changed: mirror and publish it).
- `wake(t)` sets awake, resets quiet and marks dirty.
- `wakeAround(x, z)` wakes the tile of (x, z) and the tiles of its four neighbour columns: 1 to 3 tiles.

### Sea and springs (`WaterCycle`)

- **Sea mask.** A sea column is wet with `S === seaLevel × SUB` and 4-connected to the world edge through such columns. It is found by an iterative flood fill at rebuild, and is never set by edits. An edit that raises a column's floor to `seaLevel` or above clears its mask bit.
- **Springs** are a `Set` of voxel positions. A spring is added when a spring block is written, found under a rebuilt column's water, or uncovered as a new floor.
- Each step, a spring whose column's floor is `y + 1` adds `SPRING_RATES[state] × SPRING_SCALE` to its column, at most `sea` when the world has a sea level. The amount is debited from `sea`, and the spring's tile wakes.

### Edits (`applyEdit`, called from `WaterSystem.onWrite` after the store write)

The rules run in this order, with `f0` and `S0` the floor and surface before the write.

| Write at y | Effect |
|---|---|
| water → air or water, `y ≥ f0` | `depth −= clamp(S0 − y × SUB, 0, SUB)`: the cell's share of the column |
| any → wall, `y ≥ f0` and (`y × SUB < S0` or `y === f0`) | `floor = y + 1`; depth unchanged. A wall on the floor or in the water pushes the water up. A dry column's floor rises. |
| any → wall, otherwise | ignored: a bridge, a roof, or a block below the floor |
| wall → not wall, `y === f0 − 1` | The floor falls to the next wall below. Static water on the way joins the column (`depth += units × 32`). |
| wall → not wall, otherwise | no column change. The mirror refills the cell if it lies in the water. |
| any → water, `y ≥ floor` (after the rules above) | `depth += units × 32`. The voxel is cleared or rewritten by the next flush. |
| any → water, `y < floor` | static water, ignored |

- A wall written over water displaces it: the water is not removed.
- `expected` (the running `Σ depth + sea` for the debug check) follows the depth changes.
- A floor that falls over static water remeshes the chunks holding that water. It is drawn by the heightfield from now on.

### The mirror (`WaterMirror`)

- Per column it keeps `lo` (the floor it last wrote from) and `q` (the quantized surface it wrote, in eighths).
- `q < 0` encodes "rewrite up to `~q` eighths": a forced rewrite. Edits call `touch(c, y)`, which forces a rewrite covering cell y.
- `flush` rewrites cells from `min(lo, floor)` up to `max(old top, new top)`:
  - below the floor: air where mirrored water was;
  - under the quantized surface: full water;
  - at it: a partial cell;
  - above it: air where water was.
- Walls (springs included) are never written.
- It runs for every column of every dirty tile, once per tick (`WaterSystem.flush`), paused or not. It writes through `setVoxelQuiet`.

### Publishing (`WaterPublisher`, `SurfaceView`)

- Each publish n (with `seq = n` and `parity = n & 1`) writes into parity `n & 1`:
  - the tiles that changed since the last publish;
  - the tiles of publish n − 1.
- By induction, each parity buffer is complete as of its last publish.
- A publish happens when either set is non-empty. `stamp[p]` is −1 while parity p is being written, then n.
- The tick message carries `{ seq, parity, tiles }`. The main thread then does the following:
  1. Check `stamp[parity] === seq` before and after copying the tiles into scratch, with a fence between the copy and the second check.
  2. On a mismatch (it fell two publishes behind), keep the tiles pending and read them, with the next message's tiles, from the next message's buffer.
  3. On success, `prev ← cur` and `cur ← published` for each listed tile. A tile seen for the first time takes `prev = cur`, so the world does not rise from y = 0 at load.
  4. Reset the interpolation clock.
- Encoding: `surface = depth > 0 ? S : ~S`, so a dry column carries its ground. `flux` is `moved(f)` clamped to Int16, in 1/SUB block per step.

### Rendering

- **Instances.** One instanced quad per column of a chunk column (instance `lx + lz × 32`), with these attributes:
  - `hPrev`, `hCur`: four corner heights in blocks, corners (−x,−z) (+x,−z) (+x,+z) (−x,+z);
  - `info`: flow x, flow z, depth in blocks, and `packed = sky × 16 + block + 256 × white`. `packed = −1` hides the quad.
- **Corners.**
  - A drawn column's corner averages its surface with the drawn neighbours around that corner within `JOIN`.
  - It also averages in the ground of undrawn neighbours that lie below it within `JOIN`, so a film's edge thins to the ground.
  - Walls and larger drops are left out. Lakes come out as planes and rivers as ramps.
  - An undrawn column's corners sit at its ground minus `SINK`. A column getting wet rises from there; a drying one sinks into the ground.
- **Curtains.** Where a drawn column stands more than `JOIN` above a neighbour's level (surface or ground), a vertical quad hangs:
  - from the column's two corners on that edge;
  - down to the neighbour's two corners there (or its ground);
  - with the edge's flux as its strength.
  - A curtain that exists in only one of the two steps rolls up to its top in the other.
- **Interpolation.** The vertex shader mixes `hPrev → hCur` with `waterAlpha = min(1, (now − t0) / tickMs)`, where t0 is the arrival of the last applied publish.
- **Shading.** The surface, the curtains and static voxel water share one water shading: depth colour, ripples along the flow, shore foam, white water, sun glint, fresnel.

---

## File structure

### `packages/engine/src`

| File | Change | Responsibility |
|---|---|---|
| `world/waterBuffers.ts` | create | `SUB`, `NO_FLOOR`, `WaterBuffers`, `createWaterBuffers` |
| `world/buffers.ts` | modify | `WorldBuffers.water` |
| `world/chunkStore.ts` | modify | `setVoxelQuiet`; `commit()` leaves quiet-only chunks out |
| `world/reader.ts` | modify | `ChunkSnapshot.floor`; snapshots copy column floors |
| `blocks/registry.ts` | modify | `waterGroupOf` |
| `mesh/tables.ts` | modify | `MeshTables.waterGroup`; (Task 11) drop the liquid-layer limit |
| `mesh/liquid.ts` | modify | Skip simulated water; (Task 11) drop flow bits, own `isTopRow` |
| `mesh/vertexFormat.ts` | modify | (Task 11) drop `FLOW`, `flowCode`, `packFlow`, `unpackFlow` |
| `sim/water/constants.ts` | create | Every water constant, `KIND`, `SPRING_RATES` |
| `sim/water/tiles.ts` | create | `WaterTiles` |
| `sim/water/columns.ts` | create | `WaterColumns`, `damp`, `moved`: the step |
| `sim/water/cycle.ts` | create | `WaterCycle`: sea mask, sea account, springs |
| `sim/water/edits.ts` | create | `applyEdit` |
| `sim/water/mirror.ts` | create | `WaterMirror`, `quantize` |
| `sim/water/rebuild.ts` | create | `waterKinds`, `rebuildColumns` |
| `sim/water/publish.ts` | create | `WaterTick`, `WaterPublisher` |
| `sim/water/waterSystem.ts` | create | `WaterSystem`, `WaterOptions`, `WaterPort` |
| `sim/fluids/*` | **delete** | 3a automaton, pools, scans, contacts, surface index |
| `sim/simulation.ts` | modify | Water system instead of fluids; `applySet`; step order; stats; hash |
| `sim/simHost.ts` | modify | `waterTileCap`, `debugFluids` |
| `sim/runSimWorker.ts` | modify | Export `WaterOptions` instead of `FluidOptions`/`WriteSource` |
| `protocol.ts` | modify | `SimInitOptions`; tick `physics` and `water` |
| `engine.ts` | modify | `SurfaceView`, interpolation clock, stats |
| `render/water/surfaceMesh.ts` | create | Pure builders: `cornerHeights`, `curtainAt`, `quantizeFlow`, constants |
| `render/water/surfaceView.ts` | create | `SurfaceView`, `ColumnData`, `Curtains` |
| `render/water/waterVertex.ts` | create | TSL vertex sources: `surfaceVertex`, `curtainVertex`, `voxelWaterVertex`, `waterAlpha` |
| `render/water/waterSurface.ts` | create | `WaterSurface`: instanced meshes per chunk column |
| `render/water.ts` | modify | Shared shading; `voxel`, `surface`, `curtain`, `plainSurface`, `plainCurtain` materials |
| `render/visuals.ts` | modify | Owns `WaterSurface`; `setWaterAlpha`; (Task 11) no `liquidNow` |
| `render/chunkMeshes.ts`, `render/chunkVertex.ts` | modify | (Task 11) no liquid blend, no flow bits |
| `render/liquidBlend.ts` | **delete** | (Task 11) |

### Engine tests (`packages/engine/test`)

- New:
  - `waterBuffers.test.ts`, `waterColumns.test.ts`, `waterCycle.test.ts`, `waterMirror.test.ts`, `waterRebuild.test.ts`, `waterEdits.test.ts`;
  - `waterHelpers.ts`, `waterWorld.test.ts`, `waterFuzz.test.ts`, `waterPublish.test.ts`;
  - `surfaceView.test.ts`, `waterSurface.test.ts`.
- Rewritten: `gravity.test.ts`, `chunkMeshes.test.ts`.
- Changed: `chunkStore.test.ts`, `reader.test.ts`, `registry.test.ts`, `liquid.test.ts`, `simulation.test.ts`, `simHost.test.ts`, `determinism.test.ts`, `vertexFormat.test.ts`.
- Deleted:
  - `fluidHelpers.ts`, `fluidCells.test.ts`, `fluidPrimitives.test.ts`, `fluidWorld.test.ts`;
  - `poolScan.test.ts`, `pools.test.ts`, `resurface.test.ts`, `contacts.test.ts`;
  - `liquidBlend.test.ts`.
- Kept as they are: `jobs.test.ts` (region jobs stay for 3b) and everything else.

### Other packages

- `packages/terrain/test/generator.test.ts`: `s.fluids.seaLevel` becomes `s.water.seaLevel`.
- `apps/sandbox`:
  - `src/hud.ts`: the physics line;
  - `src/main.ts`: sim options and the `dig` hook;
  - `src/scenes/flood.ts`: `CHANNEL`, `digCommands`;
  - `test/flood.test.ts`, `test/waterSoak.test.ts`;
  - `e2e/flood.spec.ts`, `e2e/flood-bench.spec.ts`, and a new `e2e/water-render.spec.ts`.

---

### Task 0: Branch

- [ ] **Step 1: Check that 3a is merged, then branch**

Run:
```bash
git checkout main
git branch --merged main
```
Expected: the list contains `feat/sim-water`. If it does not, stop and ask the controller: 3c starts only after 3a is merged.

```bash
git checkout -b feat/water-heightfield
git log --oneline -1
```
Expected: `On branch feat/water-heightfield`, with HEAD at main's tip.

- [ ] **Step 2: Baseline**

Run: `npm test` and `npm run typecheck` at the repo root.
Expected: both pass. Record any failure in the controller's notes before changing anything.

---

### Task 1: Shared water buffers, quiet writes, and static-only liquid meshing

**Files:**
- Create: `packages/engine/src/world/waterBuffers.ts`
- Modify:
  - `packages/engine/src/world/buffers.ts` (`WorldBuffers`, `createWorldBuffers`)
  - `packages/engine/src/world/chunkStore.ts` (`setVoxelQuiet`, `writable`, `writeChunkDense`, `commit`)
  - `packages/engine/src/world/reader.ts` (`ChunkSnapshot`, `createSnapshot`, `WorldReader` constructor and `copy`)
  - `packages/engine/src/blocks/registry.ts` (append `waterGroupOf`)
  - `packages/engine/src/mesh/tables.ts` (`MeshTables.waterGroup`)
  - `packages/engine/src/mesh/liquid.ts` (`meshTranslucent`)
- Test:
  - Create `packages/engine/test/waterBuffers.test.ts`.
  - Modify `packages/engine/test/chunkStore.test.ts`, `reader.test.ts`, `registry.test.ts`, `liquid.test.ts`.

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `SUB = 256`, `NO_FLOOR = 0x7fff`, `interface WaterBuffers { floor; surface; flux; stamp }` (SharedArrayBuffers), and `createWaterBuffers(size: WorldSize): WaterBuffers`, from `world/waterBuffers.ts`.
  - `WorldBuffers.water: WaterBuffers`, created by `createWorldBuffers`.
  - `ChunkStore.setVoxelQuiet(x, y, z, v): boolean`.
  - `ChunkSnapshot.floor: Int16Array` (PAD × PAD, index `px + pz × PAD`): each column's floor minus the chunk's base y, or `NO_FLOOR`.
  - `waterGroupOf(reg: BlockRegistry): number`.
  - `MeshTables.waterGroup: number`.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/test/waterBuffers.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { NO_FLOOR } from '../src/world/waterBuffers.ts'

describe('water buffers', () => {
  it('are sized per column and start empty: no floor, dry surfaces, nothing published', () => {
    const b = createWorldBuffers([64, 32, 96]).water
    const floor = new Int16Array(b.floor)
    expect(floor.length).toBe(64 * 96)
    expect(floor.every((f) => f === NO_FLOOR)).toBe(true)
    const surface = new Int32Array(b.surface)
    expect(surface.length).toBe(2 * 64 * 96)
    expect(surface.every((s) => s === -1)).toBe(true)
    expect(new Int16Array(b.flux).length).toBe(4 * 64 * 96)
    expect([...new Int32Array(b.stamp)]).toEqual([-1, -1])
  })
})
```

Add to `packages/engine/test/chunkStore.test.ts`, inside `describe('ChunkStore', …)`:

```ts
  it('writes quietly: the version moves but commit() asks for no remesh', () => {
    const { store } = makeStore([64, 64, 64])
    expect(store.setVoxelQuiet(1, 1, 1, ID.water)).toBe(true)
    expect(store.versions[0]! & 1).toBe(1)
    expect(store.getVoxel(1, 1, 1)).toBe(ID.water)
    expect(store.commit()).toEqual([])
    expect(store.versions[0]).toBe(2)
    expect(store.setVoxelQuiet(1, 1, 1, ID.water)).toBe(false)
  })

  it('remeshes a chunk that a normal write also opened, whichever came first', () => {
    const { store } = makeStore([64, 64, 64])
    store.setVoxelQuiet(1, 1, 1, ID.water)
    store.setVoxel(2, 1, 1, ID.stone)
    expect(store.commit()).toEqual([0])
    store.setVoxel(3, 1, 1, ID.stone)
    store.setVoxelQuiet(4, 1, 1, ID.water)
    expect(store.commit()).toEqual([0])
    store.setVoxelQuiet(5, 1, 1, ID.water)
    expect(store.commit()).toEqual([]) // the quiet mark does not leak into the next commit
  })

  it('gives a uniform chunk a slot for a quiet write and collapses it once it is uniform again', () => {
    const { store } = makeStore([64, 64, 64])
    store.writeChunkDense(0, new Uint16Array(32768).fill(ID.water))
    store.commit()
    expect(store.slotOf(0)).toBe(-1)
    store.setVoxelQuiet(1, 31, 1, AIR)
    store.commit()
    expect(store.slotOf(0)).toBeGreaterThanOrEqual(0)
    store.setVoxelQuiet(1, 31, 1, ID.water)
    store.commit()
    expect(store.slotOf(0)).toBe(-1)
  })
```

Add to `packages/engine/test/reader.test.ts`. Extend the imports: `PAD` from `../src/world/reader.ts` and `NO_FLOOR` from `../src/world/waterBuffers.ts`. Then add inside `describe('WorldReader', …)`:

```ts
  it('copies each column\'s water floor relative to the chunk base, NO_FLOOR outside the world', () => {
    const buffers = createWorldBuffers([64, 64, 64])
    const floors = new Int16Array(buffers.water.floor)
    floors[3 + 4 * 64] = 40
    floors[31 + 0 * 64] = 5
    const reader = new WorldReader(buffers, reg.opaque)
    const snap = createSnapshot()
    expect(reader.snapshot(reader.layout.chunkIndex(0, 1, 0), snap)).not.toBeNull()
    expect(snap.floor[(3 + 1) + (4 + 1) * PAD]).toBe(40 - 32)
    expect(snap.floor[(31 + 1) + (0 + 1) * PAD]).toBe(5 - 32)
    expect(snap.floor[0]).toBe(NO_FLOOR) // x = −1, z = −1: outside the world
    expect(snap.floor[(10 + 1) + (10 + 1) * PAD]).toBe(NO_FLOOR) // never set
  })
```

Add to `packages/engine/test/registry.test.ts`. Extend the import from `../src/blocks/registry.ts` with `waterGroupOf`, then add a top-level `it`:

```ts
it('names the simulated water: the first liquid that is not a spring', () => {
  const reg = new BlockRegistry([
    defineBlock({ name: 'spring', liquid: true, source: 'water' }),
    defineBlock({ name: 'water', liquid: true }),
    defineBlock({ name: 'lava', liquid: true }),
  ])
  expect(waterGroupOf(reg)).toBe(2)
  expect(waterGroupOf(new BlockRegistry([defineBlock({ name: 'stone' })]))).toBe(0)
})
```

Add to `packages/engine/test/liquid.test.ts`. Extend the import from `../src/world/reader.ts` with `PAD`, then add a new `describe` at the end of the file:

```ts
describe('static and simulated water', () => {
  it('leaves water at or above its column\'s floor to the heightfield and meshes the static water below it', () => {
    expect(tables.waterGroup).toBe(ID.water)
    const s = emptySnap()
    put(s, 4, 3, 4, water(7)) // below the floor: static
    put(s, 4, 6, 4, water(7)) // at the floor: simulated, not meshed here
    put(s, 9, 6, 9, water(7)) // a column with no floor (NO_FLOOR): static
    s.floor[(4 + 1) + (4 + 1) * PAD] = 5
    expect(mesh(s).n).toBe(12) // two lone static cells, 6 faces each
  })
  it('still meshes a spring above its column\'s floor', () => {
    const reg = new BlockRegistry([...TEST_BLOCKS, defineBlock({ name: 'spring', liquid: true, source: 'water', textures: 'water' })])
    const t2 = meshTablesFrom(reg, reg.faceLayers(new Map(reg.textureNames().map((n, i) => [n, i + 1]))))
    const s = emptySnap()
    put(s, 6, 5, 5, packVoxel(8, 3))
    s.floor[(6 + 1) + (5 + 1) * PAD] = 0
    const t = new QuadBuilder(), l = new QuadBuilder()
    meshTranslucent(s, t2, t, l)
    expect(l.quadCount).toBe(6)
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/engine && npx vitest run test/waterBuffers.test.ts test/chunkStore.test.ts test/reader.test.ts test/registry.test.ts test/liquid.test.ts`
Expected: FAIL. Errors include "Cannot find module '../src/world/waterBuffers.ts'", "store.setVoxelQuiet is not a function", "waterGroupOf is not a function" and "Cannot read properties of undefined (reading '…')" for `snap.floor`.

- [ ] **Step 3: Create `packages/engine/src/world/waterBuffers.ts`**

```ts
import type { WorldSize } from './layout.ts'

/** Water heights are fixed point: one block is SUB sub-units. */
export const SUB = 256
/** A column floor meaning "nothing simulated here": every liquid voxel in the column is static. */
export const NO_FLOOR = 0x7fff

/**
 * Heightfield water state, written only by the sim worker and read by the main thread and the mesh workers
 * (plan design notes: Publishing). Columns are indexed x + z × sizeX.
 * - `floor`: Int16 per column, the y of the top face the column's water rests on. Mesh workers draw water voxels below it.
 * - `surface`: Int32 × 2 parities × columns. A wet column stores its surface S (1/SUB block); a dry one stores ~S, its ground.
 * - `flux`: Int16 × 2 parities × columns × 2, the water moved through each column's +x and +z edges last step (1/SUB block).
 * - `stamp`: Int32 × 2, per parity the sequence number of the publish last completed there; −1 while one is being written.
 */
export interface WaterBuffers {
  floor: SharedArrayBuffer
  surface: SharedArrayBuffer
  flux: SharedArrayBuffer
  stamp: SharedArrayBuffer
}

export function createWaterBuffers(size: WorldSize): WaterBuffers {
  const n = size[0] * size[2]
  const floor = new SharedArrayBuffer(n * 2)
  new Int16Array(floor).fill(NO_FLOOR)
  const surface = new SharedArrayBuffer(n * 2 * 4)
  new Int32Array(surface).fill(-1)
  const stamp = new SharedArrayBuffer(2 * 4)
  new Int32Array(stamp).fill(-1)
  return { floor, surface, flux: new SharedArrayBuffer(n * 2 * 2 * 2), stamp }
}
```

- [ ] **Step 4: Add the buffers to `WorldBuffers`**

In `packages/engine/src/world/buffers.ts`, add `import { createWaterBuffers, type WaterBuffers } from './waterBuffers.ts'` to the imports. Then replace the interface and `createWorldBuffers`:

```ts
export interface WorldBuffers {
  size: WorldSize
  chunkTable: SharedArrayBuffer
  versions: SharedArrayBuffer
  /** Heightfield water shared with the main thread and the mesh workers (waterBuffers.ts). */
  water: WaterBuffers
}
```

```ts
export function createWorldBuffers(size: WorldSize): WorldBuffers {
  const layout = new Layout(size)
  const chunkTable = new SharedArrayBuffer(layout.chunkCount * 4)
  new Int32Array(chunkTable).fill(encodeUniform(0))
  return { size: layout.size, chunkTable, versions: new SharedArrayBuffer(layout.chunkCount * 4), water: createWaterBuffers(layout.size) }
}
```

- [ ] **Step 5: Add quiet writes to `ChunkStore`**

In `packages/engine/src/world/chunkStore.ts`:

1. Add a field after `private readonly dirty = new Set<number>()`:
   ```ts
     /** Chunks opened only by quiet writes since the last commit: their versions move, but commit() asks for no remesh. */
     private readonly quiet = new Set<number>()
   ```
2. Add a method after `setVoxel`:
   ```ts
     /**
      * Writes a voxel under the chunk's seqlock without asking for a remesh: commit() bumps the version but leaves the chunk
      * out of its result unless a normal write also opened it. For the water mirror, whose cells the heightfield draws.
      * Marks no neighbour: a mirror write changes no face, light or AO.
      */
     setVoxelQuiet(x: number, y: number, z: number, v: number): boolean {
       if (!this.layout.inBounds(x, y, z)) return false
       if (this.getVoxel(x, y, z) === v) return false
       const slot = this.writable(this.layout.chunkOf(x, y, z), true)
       this.views.voxels(slot)[Layout.localIndex(x & 31, y & 31, z & 31)] = v
       return true
     }
   ```
3. In `writeChunkDense`, in the uniform branch, put `this.quiet.delete(ci)` immediately before `this.openChunk(ci)`.
4. Replace `commit()`:
   ```ts
     commit(): number[] {
       const out = new Set(this.dirty)
       for (const ci of this.open) {
         this.tryCollapse(ci)
         Atomics.add(this.versions, ci, 1) // back to even: stable
         if (!this.quiet.has(ci)) out.add(ci)
       }
       this.open.clear()
       this.dirty.clear()
       this.quiet.clear()
       return [...out].sort((a, b) => a - b)
     }
   ```
5. Replace `writable`:
   ```ts
     private writable(ci: number, quiet = false): number {
       if (!quiet) this.quiet.delete(ci)
       else if (!this.open.has(ci)) this.quiet.add(ci)
       this.openChunk(ci)
       const e = this.table[ci]!
       if (e >= 0) return e
       const v = decodeUniform(e)
       const slot = this.allocSlot()
       this.views.voxels(slot).fill(v)
       this.views.light(slot).fill(impliedLight(v, this.opaque))
       Atomics.store(this.table, ci, slot)
       return slot
     }
   ```

- [ ] **Step 6: Copy column floors into snapshots**

In `packages/engine/src/world/reader.ts`:

1. Add `import { NO_FLOOR } from './waterBuffers.ts'`.
2. Replace the `ChunkSnapshot` interface and `createSnapshot`:
   ```ts
   /**
    * `outside`: OUTSIDE bits for the x and z borders; the y borders are not tracked.
    * `floor`: per padded column (px + pz × PAD), the water floor minus the chunk's base y, or NO_FLOOR. Water voxels at or above it belong to the heightfield.
    */
   export interface ChunkSnapshot { voxels: Uint16Array; light: Uint8Array; outside: number; floor: Int16Array }
   export function createSnapshot(): ChunkSnapshot {
     return { voxels: new Uint16Array(PAD_VOLUME), light: new Uint8Array(PAD_VOLUME), outside: 0, floor: new Int16Array(PAD * PAD).fill(NO_FLOOR) }
   }
   ```
3. In `WorldReader`, add a field `private readonly floors: Int16Array`, and in the constructor `this.floors = new Int16Array(buffers.water.floor)`.
4. At the top of `copy()`, after the `out.outside = …` statement, add:
   ```ts
       // Floors are not under the seqlock: a floor that moves marks the chunks it reclassifies dirty, so a stale read is redone.
       for (let pz = 0; pz < PAD; pz++) for (let px = 0; px < PAD; px++) {
         const x = bx + px - 1, z = bz + pz - 1
         const f = x < 0 || z < 0 || x >= SX || z >= SZ ? NO_FLOOR : this.floors[x + z * SX]!
         out.floor[px + pz * PAD] = f === NO_FLOOR ? NO_FLOOR : f - by
       }
   ```

- [ ] **Step 7: `waterGroupOf`, the mesh tables, and the liquid mesher**

Append to `packages/engine/src/blocks/registry.ts`:

```ts
/** The liquid the water simulation moves: the first liquid block that is not a spring; 0 when the registry has none. */
export function waterGroupOf(reg: BlockRegistry): number {
  for (let id = 1; id < reg.count; id++) if (reg.liquid[id] === 1 && reg.source[id] === 0) return id
  return 0
}
```

In `packages/engine/src/mesh/tables.ts`:
- import `waterGroupOf` along with `BlockRegistry` (change the type-only import to `import { waterGroupOf, type BlockRegistry } from '../blocks/registry.ts'`);
- add to `MeshTables`:
  ```ts
    /** The simulated water's block id (waterGroupOf): its voxels at or above a column's floor are drawn by the heightfield. 0: none. */
    waterGroup: number
  ```
- add `waterGroup: waterGroupOf(registry),` to the object `meshTablesFrom` returns.

In `packages/engine/src/mesh/liquid.ts`, inside `meshTranslucent`, right after `const group = liquid ? t.liquidGroup[id]! : 0`, add:

```ts
    // Water at or above its column's floor is the heightfield's (render/water): only static water is meshed here.
    if (liquid && id === t.waterGroup && y >= s.floor[x + 1 + (z + 1) * PAD]!) continue
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `cd packages/engine && npx vitest run test/waterBuffers.test.ts test/chunkStore.test.ts test/reader.test.ts test/registry.test.ts test/liquid.test.ts test/meshJob.test.ts`
Expected: PASS.

Run: `npm run typecheck` (repo root).
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/engine/src/world/waterBuffers.ts packages/engine/src/world/buffers.ts packages/engine/src/world/chunkStore.ts packages/engine/src/world/reader.ts packages/engine/src/blocks/registry.ts packages/engine/src/mesh/tables.ts packages/engine/src/mesh/liquid.ts packages/engine/test/waterBuffers.test.ts packages/engine/test/chunkStore.test.ts packages/engine/test/reader.test.ts packages/engine/test/registry.test.ts packages/engine/test/liquid.test.ts
git commit -m "feat(world): shared water buffers, quiet voxel writes, and static-only liquid meshing"
```

---

### Task 2: The column store, the step, and sleeping tiles

**Files:**
- Create:
  - `packages/engine/src/sim/water/constants.ts`
  - `packages/engine/src/sim/water/tiles.ts`
  - `packages/engine/src/sim/water/columns.ts`
- Test: `packages/engine/test/waterColumns.test.ts`

**Interfaces:**
- Consumes: `SUB` from `world/waterBuffers.ts`.
- Produces:
  - From `constants.ts`: `SUB` (re-export), `FLUX_FP`, `FRICTION_SHIFT`, `GAIN`, `MAX_HEAD`, `MIN_FLOW`, `TILE`, `SLEEP_STEPS`, `FLUX_EPS`, `DEPTH_EPS`, `OVERHANG`, `SPRING_SCALE`, `SPRING_RATES`, `UNIT` (= SUB / 8), `KIND = { AIR: 0, WATER: 1, WALL: 2 }`.
  - `class WaterTiles`:
    - fields `tx`, `tz`, `count`, `awake`, `quiet`, `dirty`;
    - methods `of(x, z)`, `wake(t)`, `wakeAround(x, z)`, `awakeCount()`, `clear()`, `mixState(mix)`.
  - `class WaterColumns`:
    - constructor `(sx, sz, floor: Int16Array)`;
    - fields `sx`, `sz`, `n`, `floor`, `depth`, `flux`, `tiles`;
    - methods `surface(c)`, `total()`, `wetAwake()`, `step(cap, sea: Uint8Array | null, seaSurface): number` (returns the sea credit), `mixState(mix)`.
  - `damp(f)`, `moved(f)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/test/waterColumns.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Pcg32 } from '../src/sim/rng.ts'
import { WaterColumns, damp, moved } from '../src/sim/water/columns.ts'
import { MIN_FLOW, SUB } from '../src/sim/water/constants.ts'

const CAP = 1 << 20

/** sx × sz columns; floors in blocks, depths in 1/SUB block. Tiles holding water start awake. */
function grid(sx: number, sz: number, floor: (x: number, z: number) => number, depth: (x: number, z: number) => number = () => 0): WaterColumns {
  const g = new WaterColumns(sx, sz, new Int16Array(sx * sz))
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    const c = x + z * sx
    g.floor[c] = floor(x, z)
    g.depth[c] = depth(x, z)
    if (g.depth[c]! > 0) g.tiles.wake(g.tiles.of(x, z))
  }
  return g
}

/** Steps until no tile is awake; returns the steps taken. */
function settle(g: WaterColumns, cap = CAP, max = 50_000, each?: () => void): number {
  for (let i = 1; i <= max; i++) {
    g.step(cap, null, 0)
    each?.()
    if (g.tiles.awakeCount() === 0) return i
  }
  throw new Error(`still awake after ${max} steps: ${g.tiles.awakeCount()} tiles`)
}

/** A walled box: floor `bed` inside, floor `wall` on the rim. */
const box = (sx: number, sz: number, bed: number, wall = 100) =>
  (x: number, z: number) => (x === 0 || z === 0 || x === sx - 1 || z === sz - 1 ? wall : bed)

/** Max − min surface over the columns that hold water. */
function spread(g: WaterColumns): number {
  let lo = Infinity, hi = -Infinity
  for (let c = 0; c < g.n; c++) if (g.depth[c]! > 0) { lo = Math.min(lo, g.surface(c)); hi = Math.max(hi, g.surface(c)) }
  return hi - lo
}

function minDepth(g: WaterColumns): number {
  let m = Infinity
  for (let c = 0; c < g.n; c++) m = Math.min(m, g.depth[c]!)
  return m
}

describe('flux arithmetic', () => {
  it('rounds friction away from zero and transfers toward zero, the same in both directions', () => {
    expect([damp(1), damp(-1), damp(32), damp(-32), damp(0)]).toEqual([0, 0, 30, -30, 0])
    expect([moved(31), moved(-31), moved(15), moved(-15), moved(16)]).toEqual([1, -1, 0, 0, 1])
  })
})

describe('WaterColumns', () => {
  it('conserves water exactly and never goes negative over random floors and depths', () => {
    const rng = new Pcg32(7)
    const floors = Array.from({ length: 64 * 64 }, () => rng.nextInt(6))
    const depths = Array.from({ length: 64 * 64 }, () => rng.nextInt(3 * SUB))
    const g = grid(64, 64, (x, z) => floors[x + z * 64]!, (x, z) => depths[x + z * 64]!)
    const v0 = g.total()
    for (let i = 0; i < 3000; i++) {
      g.step(CAP, null, 0)
      expect(g.total()).toBe(v0)
      expect(minDepth(g)).toBeGreaterThanOrEqual(0)
    }
  })

  it('settles a lake flat, puts every tile to sleep and zeroes every flux', () => {
    const g = grid(32, 32, box(32, 32, 10), (x, z) => (x > 0 && z > 0 && x < 31 && z < 31 ? 2 * SUB + (x >= 8 && x < 12 && z >= 8 && z < 12 ? 8 * SUB : 0) : 0))
    const v0 = g.total()
    settle(g)
    expect(g.total()).toBe(v0)
    expect(spread(g)).toBeLessThanOrEqual(16)
    expect(g.flux.every((f) => f === 0)).toBe(true)
    expect(g.wetAwake()).toBe(0)
  })

  it('carries inertia: released into an empty channel, water overshoots its final level at the far wall, then settles', () => {
    // One tile, walled; water in x 1..7 at 2 blocks, the rest dry: the mean is 1 block.
    const g = grid(16, 16, box(16, 16, 0), (x, z) => (x >= 1 && x <= 7 && z >= 1 && z <= 14 ? 2 * SUB : 0))
    const far = 14 + 7 * 16
    let peak = 0
    for (let i = 0; i < 400; i++) { g.step(CAP, null, 0); peak = Math.max(peak, g.depth[far]!) }
    expect(peak).toBeGreaterThan(1.1 * SUB)
    settle(g)
    expect(spread(g)).toBeLessThanOrEqual(16)
    expect(Math.abs(g.depth[far]! - SUB)).toBeLessThanOrEqual(16)
  })

  it('pours off a ledge into a lower basin, exact to the unit', () => {
    const g = grid(32, 16, (x, z) => (x === 0 || z === 0 || x === 31 || z === 15 ? 100 : x <= 14 ? 20 : 5),
      (x, z) => (x >= 1 && x <= 14 && z >= 1 && z <= 14 ? 2 * SUB : 0))
    const v0 = g.total()
    settle(g, CAP, 50_000, () => expect(g.total()).toBe(v0))
    let basin = 0
    for (let z = 1; z <= 14; z++) for (let x = 15; x <= 30; x++) basin += g.depth[x + z * 32]!
    expect(basin).toBeGreaterThanOrEqual(0.95 * v0)
  })

  it('never moves water into a column whose floor is at or above the sender\'s surface', () => {
    const g = grid(16, 16, (x) => (x < 8 ? 0 : 3), (x) => (x < 8 ? 3 * SUB : 0))
    for (let i = 0; i < 500; i++) g.step(CAP, null, 0)
    for (let z = 0; z < 16; z++) for (let x = 8; x < 16; x++) expect(g.depth[x + z * 16]).toBe(0)
  })

  it('leaves a film thinner than MIN_FLOW where it is and lets its tile sleep', () => {
    const g = grid(16, 16, () => 0, (x, z) => (x === 5 && z === 5 ? MIN_FLOW - 1 : 0))
    settle(g)
    expect(g.depth[5 + 5 * 16]).toBe(MIN_FLOW - 1)
  })

  it('wakes exactly the tile of an edited column and the tiles of its neighbours', () => {
    const g = grid(32, 32, () => 0)
    const awake = () => [0, 1, 2, 3].filter((t) => g.tiles.awake[t] === 1)
    g.tiles.wakeAround(5, 5)
    expect(awake()).toEqual([0])
    g.tiles.clear()
    g.tiles.wakeAround(15, 5)
    expect(awake()).toEqual([0, 1])
    g.tiles.clear()
    g.tiles.wakeAround(15, 15)
    expect(awake()).toEqual([0, 1, 2])
  })

  it('keeps water inside the world at every edge: nothing crosses the border', () => {
    const corner = (x: number, z: number) => (x < 4 && z < 4) || (x >= 28 && z >= 28)
    const g = grid(32, 32, () => 0, (x, z) => (corner(x, z) ? 4 * SUB : 0))
    const v0 = g.total()
    for (let i = 0; i < 2000; i++) {
      g.step(CAP, null, 0)
      expect(g.total()).toBe(v0)
    }
    for (let z = 0; z < 32; z++) expect(g.flux[2 * (31 + z * 32)]).toBe(0) // +x edges of the last column
    for (let x = 0; x < 32; x++) expect(g.flux[2 * (x + 31 * 32) + 1]).toBe(0) // +z edges of the last row
  })

  it('steps at most `cap` tiles per step, round robin, and still settles exactly', () => {
    const rng = new Pcg32(3)
    const depths = Array.from({ length: 32 * 32 }, () => rng.nextInt(2 * SUB))
    const g = grid(32, 32, box(32, 32, 0), (x, z) => (x > 0 && z > 0 && x < 31 && z < 31 ? depths[x + z * 32]! : 0))
    const v0 = g.total()
    settle(g, 1, 200_000, () => expect(g.total()).toBe(v0))
    expect(spread(g)).toBeLessThanOrEqual(16)
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/engine && npx vitest run test/waterColumns.test.ts`
Expected: FAIL with "Cannot find module '../src/sim/water/columns.ts'".

- [ ] **Step 3: Create `packages/engine/src/sim/water/constants.ts`**

```ts
import { SUB } from '../../world/waterBuffers.ts'

export { SUB }
/** Flux carries FLUX_FP extra bits: a stored flux of 16 moves 1/SUB block per step. */
export const FLUX_FP = 4
/** Friction: every step a flux loses 1/2^FRICTION_SHIFT of itself, at least one stored unit (rounded away from zero). */
export const FRICTION_SHIFT = 4
/**
 * Stored flux gained per step per 1/SUB block of head: k = GAIN / 2^FLUX_FP = 1/8. The step is symplectic Euler on the
 * discrete wave equation; its stiffest (checkerboard) mode is stable while 8k ≤ 4, so k = 1/8 keeps a 4× margin.
 */
export const GAIN = 2
/** The head an edge feels is clamped to 2 blocks: a cliff does not accelerate water without bound, the excess just pours. */
export const MAX_HEAD = 2 * SUB
/** A column shallower than this (1/64 block) sends nothing: films stay as damp puddles. */
export const MIN_FLOW = 4
/** Columns per tile side. */
export const TILE = 16
/** Quiet steps before a tile falls asleep (half a second at 20 Hz). */
export const SLEEP_STEPS = 10
/** A tile is quiet while every edge it moved carried less than this (1/SUB block per step)… */
export const FLUX_EPS = 2
/** …and no column of it changed by more than this since its last step. */
export const DEPTH_EPS = 2
/** At rebuild, a wall run at most this thick that floats over air or water (a bridge, a canopy) hides no water below it. */
export const OVERHANG = 6
/** One liquid unit (1/8 block, a voxel level step) in 1/SUB block. */
export const UNIT = SUB / 8
/** A spring's flow per step, per its state (flow index): 3a's units per 10 Hz fluid step, × SPRING_SCALE. */
export const SPRING_RATES: readonly number[] = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 40, 48, 56, 64, 96, 128]
/** 3a units (32 sub) per 10 Hz step → sub per 20 Hz step: × 32 / 2. */
export const SPRING_SCALE = 16
/** What a voxel is to water. */
export const KIND = { AIR: 0, WATER: 1, WALL: 2 } as const
```

- [ ] **Step 4: Create `packages/engine/src/sim/water/tiles.ts`**

```ts
import { TILE } from './constants.ts'

/** The world's columns in TILE × TILE tiles (spec §3 Sleeping tiles). Only awake tiles step. */
export class WaterTiles {
  readonly sx: number
  readonly sz: number
  readonly tx: number
  readonly tz: number
  readonly count: number
  /** 1 while the tile steps. */
  readonly awake: Uint8Array
  /** Consecutive quiet steps. */
  readonly quiet: Uint8Array
  /** 1 when a column of the tile changed since the last flush: mirror it and publish it. */
  readonly dirty: Uint8Array

  constructor(sx: number, sz: number) {
    if (sx % TILE !== 0 || sz % TILE !== 0) throw new RangeError(`water tiles need world sizes that are multiples of ${TILE}, got ${sx} × ${sz}`)
    this.sx = sx
    this.sz = sz
    this.tx = sx / TILE
    this.tz = sz / TILE
    this.count = this.tx * this.tz
    this.awake = new Uint8Array(this.count)
    this.quiet = new Uint8Array(this.count)
    this.dirty = new Uint8Array(this.count)
  }

  of(x: number, z: number): number { return Math.floor(x / TILE) + Math.floor(z / TILE) * this.tx }

  wake(t: number): void {
    this.awake[t] = 1
    this.quiet[t] = 0
    this.dirty[t] = 1
  }

  /** An edit at column (x, z): wakes its tile and the tiles of its four neighbour columns (1 to 3 tiles). */
  wakeAround(x: number, z: number): void {
    this.wake(this.of(x, z))
    if (x > 0) this.wake(this.of(x - 1, z))
    if (x + 1 < this.sx) this.wake(this.of(x + 1, z))
    if (z > 0) this.wake(this.of(x, z - 1))
    if (z + 1 < this.sz) this.wake(this.of(x, z + 1))
  }

  awakeCount(): number {
    let n = 0
    for (let t = 0; t < this.count; t++) n += this.awake[t]!
    return n
  }

  clear(): void {
    this.awake.fill(0)
    this.quiet.fill(0)
    this.dirty.fill(0)
  }

  /** `dirty` is publish bookkeeping, cleared every tick: not world state. */
  mixState(mix: (v: number) => void): void {
    for (let t = 0; t < this.count; t++) mix(this.awake[t]! | (this.quiet[t]! << 1))
  }
}
```

- [ ] **Step 5: Create `packages/engine/src/sim/water/columns.ts`**

```ts
import { DEPTH_EPS, FLUX_EPS, FLUX_FP, FRICTION_SHIFT, GAIN, MAX_HEAD, MIN_FLOW, SLEEP_STEPS, SUB, TILE } from './constants.ts'
import { WaterTiles } from './tiles.ts'

const FRICTION_MASK = (1 << FRICTION_SHIFT) - 1

/** A stored flux after one step of friction: loses 1/2^FRICTION_SHIFT, rounded away from zero, so a lone flux always dies out. */
export function damp(f: number): number {
  if (f > 0) return f - ((f + FRICTION_MASK) >> FRICTION_SHIFT)
  if (f < 0) return f + ((FRICTION_MASK - f) >> FRICTION_SHIFT)
  return 0
}

/** Water (1/SUB block) an edge with stored flux f moves this step: truncated toward zero, the same both ways. */
export function moved(f: number): number {
  return f >= 0 ? f >> FLUX_FP : -((-f) >> FLUX_FP)
}

/** An outflow f > 0 (stored units) scaled so a column sending `out` in all moves only its depth `d`: whole 1/SUB, rounded down. */
function scaled(f: number, d: number, out: number): number {
  return Math.floor(((f >> FLUX_FP) * d) / out) << FLUX_FP
}

/** A growable Int32 list, reused every step. */
class IntList {
  data = new Int32Array(1024)
  length = 0
  push(v: number): void {
    if (this.length === this.data.length) {
      const d = new Int32Array(this.data.length * 2)
      d.set(this.data)
      this.data = d
    }
    this.data[this.length++] = v
  }
  clear(): void { this.length = 0 }
}

/**
 * The heightfield (spec §3; plan design notes: Columns, The step). Pure: no voxels. Every field is an integer and every
 * loop has a fixed order, so two stores fed the same edits stay identical.
 */
export class WaterColumns {
  readonly sx: number
  readonly sz: number
  readonly n: number
  /** Per column (x + z × sx): y of the top face the water rests on. A view of the shared floor buffer. */
  readonly floor: Int16Array
  /** Per column: water in 1/SUB block. */
  readonly depth: Int32Array
  /** Per column c: flux through its +x edge at 2c and its +z edge at 2c + 1 (1/(16 SUB) block per step; positive toward +x / +z). */
  readonly flux: Int32Array
  readonly tiles: WaterTiles
  /** Per column: depth after its last step (the quiet test). */
  private readonly last: Int32Array
  private readonly stepping: Uint8Array
  private readonly list = new IntList()
  private readonly edges = new IntList()
  private readonly edgeEnd = new IntList()
  private readonly ring = new IntList()
  private most = new Int32Array(64)
  private cursor = 0

  constructor(sx: number, sz: number, floor: Int16Array) {
    if (floor.length !== sx * sz) throw new RangeError(`floor has ${floor.length} columns, expected ${sx * sz}`)
    this.sx = sx
    this.sz = sz
    this.n = sx * sz
    this.floor = floor
    this.depth = new Int32Array(this.n)
    this.flux = new Int32Array(this.n * 2)
    this.last = new Int32Array(this.n)
    this.tiles = new WaterTiles(sx, sz)
    this.stepping = new Uint8Array(this.tiles.count)
  }

  surface(c: number): number { return this.floor[c]! * SUB + this.depth[c]! }

  /** Σ depth. */
  total(): number {
    let s = 0
    for (let c = 0; c < this.n; c++) s += this.depth[c]!
    return s
  }

  /** Wet columns in awake tiles (EngineStats.waterColumns). */
  wetAwake(): number {
    const T = this.tiles
    let n = 0
    for (let t = 0; t < T.count; t++) {
      if (T.awake[t] !== 1) continue
      const x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) if (this.depth[x + z * this.sx]! > 0) n++
    }
    return n
  }

  /**
   * One step over at most `cap` awake tiles (round robin): accelerate every edge touching them, limit each column's
   * outflow to its depth, move the water, pin the sea columns (`sea` mask, at `seaSurface`), and put quiet tiles to sleep.
   * Returns what the sea columns gave the sea account (negative: what they took from it).
   */
  step(cap: number, sea: Uint8Array | null, seaSurface: number): number {
    this.collect(cap)
    this.accelerate()
    this.limit()
    this.transfer()
    const credit = sea ? this.pin(sea, seaSurface) : 0
    this.settle()
    for (let k = 0; k < this.list.length; k++) this.stepping[this.list.data[k]!] = 0
    return credit
  }

  mixState(mix: (v: number) => void): void {
    mix(this.cursor)
    for (let c = 0; c < this.n; c++) {
      mix(this.floor[c]!); mix(this.depth[c]!); mix(this.last[c]!)
      mix(this.flux[2 * c]!); mix(this.flux[2 * c + 1]!)
    }
    this.tiles.mixState(mix)
  }

  /** The stepped tiles, their edges (each touching edge once) and the ring of outside columns those edges reach. */
  private collect(cap: number): void {
    const T = this.tiles
    this.list.clear(); this.edges.clear(); this.edgeEnd.clear(); this.ring.clear()
    let t = this.cursor
    for (let k = 0; k < T.count && this.list.length < cap; k++) {
      if (T.awake[t] === 1) { this.list.push(t); this.stepping[t] = 1 }
      t = t + 1 === T.count ? 0 : t + 1
    }
    this.cursor = t
    if (this.most.length < this.list.length) this.most = new Int32Array(this.list.length * 2)
    for (let k = 0; k < this.list.length; k++) {
      this.tileEdges(this.list.data[k]!)
      this.edgeEnd.push(this.edges.length)
    }
  }

  private tileEdges(t: number): void {
    const T = this.tiles, sx = this.sx, sz = this.sz
    const x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE, x1 = x0 + TILE, z1 = z0 + TILE
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      const c = x + z * sx
      if (x + 1 < sx) this.edges.push(c * 2)
      if (z + 1 < sz) this.edges.push(c * 2 + 1)
    }
    // Edges owned by a neighbour tile that does not step are this tile's to move; their outside columns are limited as a ring.
    if (x0 > 0 && this.stepping[t - 1] === 0) for (let z = z0; z < z1; z++) { const c = x0 - 1 + z * sx; this.edges.push(c * 2); this.ring.push(c) }
    if (z0 > 0 && this.stepping[t - T.tx] === 0) for (let x = x0; x < x1; x++) { const c = x + (z0 - 1) * sx; this.edges.push(c * 2 + 1); this.ring.push(c) }
    if (x1 < sx && this.stepping[t + 1] === 0) for (let z = z0; z < z1; z++) this.ring.push(x1 + z * sx)
    if (z1 < sz && this.stepping[t + T.tx] === 0) for (let x = x0; x < x1; x++) this.ring.push(x + z1 * sx)
  }

  private accelerate(): void {
    const floor = this.floor, depth = this.depth, flux = this.flux, sx = this.sx, E = this.edges.data
    for (let k = 0; k < this.edges.length; k++) {
      const e = E[k]!, a = e >> 1, b = a + ((e & 1) === 0 ? 1 : sx)
      const fa = floor[a]! * SUB, fb = floor[b]! * SUB, da = depth[a]!, db = depth[b]!
      const sa = fa + da, sb = fb + db
      let h = sa - sb
      if (h > MAX_HEAD) h = MAX_HEAD
      else if (h < -MAX_HEAD) h = -MAX_HEAD
      let f = damp(flux[e]!) + h * GAIN
      // Thin films send nothing, and water never moves into a column whose floor is at or above the sender's surface.
      if (f > 0) { if (da < MIN_FLOW || sa <= fb) f = 0 }
      else if (f < 0) { if (db < MIN_FLOW || sb <= fa) f = 0 }
      flux[e] = f
    }
  }

  private limit(): void {
    const T = this.tiles, sx = this.sx
    for (let k = 0; k < this.list.length; k++) {
      const t = this.list.data[k]!, x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) this.limitColumn(x + z * sx, x, z)
    }
    for (let k = 0; k < this.ring.length; k++) {
      const c = this.ring.data[k]!, x = c % sx
      this.limitColumn(c, x, (c - x) / sx)
    }
  }

  /** Scales every outflow of column c so that together they move at most its depth. */
  private limitColumn(c: number, x: number, z: number): void {
    const flux = this.flux, sx = this.sx
    const east = x + 1 < sx ? c * 2 : -1, south = z + 1 < this.sz ? c * 2 + 1 : -1
    const west = x > 0 ? (c - 1) * 2 : -1, north = z > 0 ? (c - sx) * 2 + 1 : -1
    let out = 0
    if (east >= 0 && flux[east]! > 0) out += flux[east]! >> FLUX_FP
    if (south >= 0 && flux[south]! > 0) out += flux[south]! >> FLUX_FP
    if (west >= 0 && flux[west]! < 0) out += -flux[west]! >> FLUX_FP
    if (north >= 0 && flux[north]! < 0) out += -flux[north]! >> FLUX_FP
    const d = this.depth[c]!
    if (out <= d) return
    if (east >= 0 && flux[east]! > 0) flux[east] = scaled(flux[east]!, d, out)
    if (south >= 0 && flux[south]! > 0) flux[south] = scaled(flux[south]!, d, out)
    if (west >= 0 && flux[west]! < 0) flux[west] = -scaled(-flux[west]!, d, out)
    if (north >= 0 && flux[north]! < 0) flux[north] = -scaled(-flux[north]!, d, out)
  }

  private transfer(): void {
    const depth = this.depth, flux = this.flux, sx = this.sx, E = this.edges.data
    let e = 0
    for (let k = 0; k < this.list.length; k++) {
      const end = this.edgeEnd.data[k]!
      let most = 0
      for (; e < end; e++) {
        const edge = E[e]!, a = edge >> 1, b = a + ((edge & 1) === 0 ? 1 : sx)
        const m = moved(flux[edge]!)
        if (m === 0) continue
        depth[a] = depth[a]! - m
        depth[b] = depth[b]! + m
        const am = m < 0 ? -m : m
        if (am > most) most = am
        this.reach(a, am)
        this.reach(b, am)
      }
      this.most[k] = most
    }
  }

  /** Water moved in or out of column c: if its tile does not step, mirror and publish it, and a real stream wakes it. */
  private reach(c: number, amount: number): void {
    const T = this.tiles, x = c % this.sx
    const t = T.of(x, (c - x) / this.sx)
    if (this.stepping[t] === 1) return
    T.dirty[t] = 1
    if (amount >= FLUX_EPS) T.wake(t)
  }

  private pin(sea: Uint8Array, target: number): number {
    const T = this.tiles, sx = this.sx
    let credit = 0
    for (let k = 0; k < this.list.length; k++) {
      const t = this.list.data[k]!, x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) credit += this.pinColumn(x + z * sx, sea, target)
    }
    for (let k = 0; k < this.ring.length; k++) credit += this.pinColumn(this.ring.data[k]!, sea, target)
    return credit
  }

  /** Sets a sea column back to the sea's surface; returns the water it gave (negative: took). */
  private pinColumn(c: number, sea: Uint8Array, target: number): number {
    if (sea[c] !== 1) return 0
    const d = this.floor[c]! * SUB + this.depth[c]! - target
    if (d === 0 || this.depth[c]! - d < 0) return 0
    this.depth[c] = this.depth[c]! - d
    return d
  }

  private settle(): void {
    const T = this.tiles, sx = this.sx
    let start = 0
    for (let k = 0; k < this.list.length; k++) {
      const t = this.list.data[k]!, end = this.edgeEnd.data[k]!
      const x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE
      let change = 0
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) {
        const c = x + z * sx, d = this.depth[c]! - this.last[c]!
        this.last[c] = this.depth[c]!
        if (d > change) change = d
        else if (-d > change) change = -d
      }
      T.dirty[t] = 1
      if (this.most[k]! < FLUX_EPS && change <= DEPTH_EPS) {
        T.quiet[t] = T.quiet[t]! + 1
        if (T.quiet[t]! >= SLEEP_STEPS) {
          T.awake[t] = 0
          T.quiet[t] = 0
          for (let e = start; e < end; e++) this.flux[this.edges.data[e]!] = 0
        }
      } else {
        T.quiet[t] = 0
      }
      start = end
    }
  }
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `cd packages/engine && npx vitest run test/waterColumns.test.ts`
Expected: PASS.

If the overshoot test fails (`peak` ≤ 1.1 × SUB), do **not** loosen it. Print `peak` and report it to the controller: it measures the inertia the spec asks for.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/sim/water/constants.ts packages/engine/src/sim/water/tiles.ts packages/engine/src/sim/water/columns.ts packages/engine/test/waterColumns.test.ts
git commit -m "feat(sim): heightfield water columns: virtual-pipe step, outflow limit and sleeping tiles"
```

---

### Task 3: The water cycle: sea columns, the sea account, springs

**Files:**
- Create: `packages/engine/src/sim/water/cycle.ts`
- Test: `packages/engine/test/waterCycle.test.ts`

**Interfaces:**
- Consumes: `WaterColumns` (Task 2); `SPRING_RATES`, `SPRING_SCALE`, `SUB` (Task 2); `Layout` (`world/layout.ts`).
- Produces: `class WaterCycle`:
  - fields `seaLevel`, `sea`, `mask: Uint8Array`, `springs: Set<number>`;
  - methods:
    - `findSea(cols)`;
    - `seaDepth(cols): number`;
    - `runSprings(cols, layout, get: (x, y, z) => number, source: Uint8Array): void`;
    - `mixState(mix)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/test/waterCycle.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { SPRING_RATES, SPRING_SCALE, SUB } from '../src/sim/water/constants.ts'
import { WaterCycle } from '../src/sim/water/cycle.ts'
import { Layout } from '../src/world/layout.ts'
import { AIR, packVoxel } from '../src/world/voxel.ts'

const CAP = 1 << 20
const SPRING_ID = 9
const source = new Uint8Array(16)
source[SPRING_ID] = 1

function grid(sx: number, sz: number, floor: (x: number, z: number) => number, depth: (x: number, z: number) => number): WaterColumns {
  const g = new WaterColumns(sx, sz, new Int16Array(sx * sz))
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    g.floor[x + z * sx] = floor(x, z)
    g.depth[x + z * sx] = depth(x, z)
  }
  return g
}

describe('sea columns', () => {
  it('marks wet columns at sea level that reach the world edge, and nothing else', () => {
    // Sea for z ≥ 20; an inland lake at the same surface; a puddle at the corner above sea level.
    const g = grid(32, 32,
      (x, z) => (z >= 20 ? 2 : x >= 5 && x <= 8 && z >= 5 && z <= 8 ? 3 : 10),
      (x, z) => (z >= 20 ? 3 * SUB : x >= 5 && x <= 8 && z >= 5 && z <= 8 ? 2 * SUB : x === 0 && z === 0 ? 7 : 0))
    const cy = new WaterCycle(g.n)
    cy.seaLevel = 5
    cy.findSea(g)
    expect(cy.mask[10 + 25 * 32]).toBe(1)
    expect(cy.mask[6 + 6 * 32]).toBe(0) // same surface, but landlocked
    expect(cy.mask[0]).toBe(0)
    expect(cy.seaDepth(g)).toBe(12 * 32 * 3 * SUB)
  })

  it('pins the sea at its level and keeps Σ depth + sea constant while land water pours in', () => {
    const g = grid(32, 32, (_x, z) => (z >= 24 ? 0 : 6), (x, z) => (z >= 24 ? 5 * SUB : x >= 2 && x <= 10 && z >= 2 && z <= 10 ? 2 * SUB : 0))
    for (let t = 0; t < g.tiles.count; t++) g.tiles.wake(t)
    const cy = new WaterCycle(g.n)
    cy.seaLevel = 5
    cy.findSea(g)
    cy.sea = cy.seaDepth(g)
    const sea0 = cy.sea, v0 = g.total() + cy.sea
    for (let i = 0; i < 1500; i++) {
      cy.sea += g.step(CAP, cy.mask, 5 * SUB)
      expect(g.total() + cy.sea).toBe(v0)
    }
    for (let x = 0; x < 32; x++) expect(g.surface(x + 28 * 32)).toBe(5 * SUB)
    expect(cy.sea).toBeGreaterThan(sea0) // land water reached the sea
  })
})

describe('springs', () => {
  const layout = new Layout([32, 32, 32])
  const at = (y: number, v: number) => (x: number, yy: number, z: number) => (x === 5 && yy === y && z === 5 ? v : AIR)

  it('adds its rate to its column from the sea, wakes its tile, and stops when the sea is empty', () => {
    const g = grid(32, 32, () => 4, () => 0)
    const cy = new WaterCycle(g.n)
    cy.seaLevel = 5
    cy.sea = 40
    cy.springs.add(layout.voxelIndex(5, 3, 5))
    const get = at(3, packVoxel(SPRING_ID, 0)) // rate 1 × 16 per step
    const rate = SPRING_RATES[0]! * SPRING_SCALE
    cy.runSprings(g, layout, get, source)
    expect([g.depth[5 + 5 * 32], cy.sea]).toEqual([rate, 40 - rate])
    expect(g.tiles.awake[0]).toBe(1)
    cy.runSprings(g, layout, get, source)
    cy.runSprings(g, layout, get, source)
    cy.runSprings(g, layout, get, source)
    expect([g.depth[5 + 5 * 32], cy.sea]).toEqual([40, 0])
  })

  it('is unbounded without a sea level: the account goes negative and the identity holds', () => {
    const g = grid(32, 32, () => 4, () => 0)
    const cy = new WaterCycle(g.n)
    cy.springs.add(layout.voxelIndex(5, 3, 5))
    for (let i = 0; i < 3; i++) cy.runSprings(g, layout, at(3, packVoxel(SPRING_ID, 4)), source)
    expect(g.depth[5 + 5 * 32]).toBe(3 * SPRING_RATES[4]! * SPRING_SCALE)
    expect(g.total() + cy.sea).toBe(0)
  })

  it('gives nothing when buried (its column\'s floor is not on it), and forgets a spring that is gone', () => {
    const g = grid(32, 32, () => 9, () => 0) // floor 9: something sits on the spring at y = 3
    const cy = new WaterCycle(g.n)
    cy.springs.add(layout.voxelIndex(5, 3, 5))
    cy.runSprings(g, layout, at(3, packVoxel(SPRING_ID, 4)), source)
    expect(g.total()).toBe(0)
    expect(cy.springs.size).toBe(1)
    cy.runSprings(g, layout, () => AIR, source)
    expect(cy.springs.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/engine && npx vitest run test/waterCycle.test.ts`
Expected: FAIL with "Cannot find module '../src/sim/water/cycle.ts'".

- [ ] **Step 3: Create `packages/engine/src/sim/water/cycle.ts`**

```ts
import type { Layout } from '../../world/layout.ts'
import type { WaterColumns } from './columns.ts'
import { SPRING_RATES, SPRING_SCALE, SUB } from './constants.ts'

/** The water cycle (spec §3 Sea and springs; plan decisions 7–9). */
export class WaterCycle {
  /** From the generator's configure(): sea columns sit at seaLevel × SUB. 0: no sea, and springs are unbounded. */
  seaLevel = 0
  /** The sea account (1/SUB block): credited by water that reaches the sea, debited by springs. Negative only without a sea level. */
  sea = 0
  /** 1 for a sea column. */
  readonly mask: Uint8Array
  /** Spring positions (Layout.voxelIndex) in the order they were found. */
  readonly springs = new Set<number>()
  private stack = new Int32Array(0)

  constructor(n: number) { this.mask = new Uint8Array(n) }

  /** Marks the sea: wet columns whose surface is at sea level, 4-connected to the world edge through such columns. */
  findSea(cols: WaterColumns): void {
    const mask = this.mask, sx = cols.sx, sz = cols.sz
    mask.fill(0)
    if (this.seaLevel <= 0) return
    if (this.stack.length < cols.n) this.stack = new Int32Array(cols.n)
    const stack = this.stack, target = this.seaLevel * SUB
    let top = 0
    const push = (c: number): void => {
      if (mask[c] === 1 || cols.depth[c]! <= 0 || cols.surface(c) !== target) return
      mask[c] = 1
      stack[top++] = c
    }
    for (let x = 0; x < sx; x++) { push(x); push(x + (sz - 1) * sx) }
    for (let z = 0; z < sz; z++) { push(z * sx); push(sx - 1 + z * sx) }
    while (top > 0) {
      const c = stack[--top]!, x = c % sx, z = (c - x) / sx
      if (x > 0) push(c - 1)
      if (x + 1 < sx) push(c + 1)
      if (z > 0) push(c - sx)
      if (z + 1 < sz) push(c + sx)
    }
  }

  /** Water the sea columns hold. */
  seaDepth(cols: WaterColumns): number {
    let s = 0
    for (let c = 0; c < cols.n; c++) if (this.mask[c] === 1) s += cols.depth[c]!
    return s
  }

  /**
   * Each spring that is its column's floor block adds its rate to the column, at most what the sea holds when the world has
   * a sea level, and the sea pays for it. A position that no longer holds a spring is forgotten.
   */
  runSprings(cols: WaterColumns, layout: Layout, get: (x: number, y: number, z: number) => number, source: Uint8Array): void {
    for (const s of this.springs) {
      const [x, y, z] = layout.voxelCoords(s)
      const v = get(x, y, z)
      if (source[v & 0xfff] !== 1) { this.springs.delete(s); continue }
      const c = x + z * cols.sx
      if (cols.floor[c] !== y + 1) continue
      let rate = SPRING_RATES[(v >>> 12) & 15]! * SPRING_SCALE
      if (this.seaLevel > 0) rate = Math.min(rate, Math.max(0, this.sea))
      if (rate <= 0) continue
      cols.depth[c] = cols.depth[c]! + rate
      this.sea -= rate
      cols.tiles.wake(cols.tiles.of(x, z))
    }
  }

  mixState(mix: (v: number) => void): void {
    mix(this.seaLevel); mix(this.sea)
    mix(this.springs.size)
    for (const s of this.springs) mix(s)
    for (let c = 0; c < this.mask.length; c++) mix(this.mask[c]!)
  }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd packages/engine && npx vitest run test/waterCycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sim/water/cycle.ts packages/engine/test/waterCycle.test.ts
git commit -m "feat(sim): water cycle: sea columns pinned at sea level, the sea account and springs"
```

---

### Task 4: The voxel mirror and the rebuild from voxels

**Files:**
- Create: `packages/engine/src/sim/water/mirror.ts`, `packages/engine/src/sim/water/rebuild.ts`
- Test: `packages/engine/test/waterMirror.test.ts`, `packages/engine/test/waterRebuild.test.ts`

**Interfaces:**
- Consumes: `WaterColumns` and the constants (Task 2); `ChunkStore` (Task 1); `decodeUniform` (`world/buffers.ts`); `BlockRegistry`.
- Produces:
  - `quantize(s: number): number` (eighths of a block).
  - `class WaterMirror`:
    - constructor `(n)`;
    - fields `lo: Int16Array`, `q: Int32Array`;
    - methods `touch(c, y)`, `flush(c, x, z, floor, depth, water, kind, height, get, set): boolean`, `mixState(mix)`.
  - `waterKinds(reg: BlockRegistry, water: number): Uint8Array` (4096 entries: `KIND` per block id).
  - `type FloorMoved = (x, z, from, to) => void`.
  - `rebuildColumns(store, kind, cols, mirror, x0, z0, x1, z1, moved?: FloorMoved): void`.

- [ ] **Step 1: Write the failing mirror tests**

Create `packages/engine/test/waterMirror.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BlockRegistry, defineBlock } from '../src/blocks/registry.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { WaterMirror, quantize } from '../src/sim/water/mirror.ts'
import { waterKinds } from '../src/sim/water/rebuild.ts'
import { AIR, packVoxel } from '../src/world/voxel.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

const reg = new BlockRegistry([...TEST_BLOCKS, defineBlock({ name: 'spring', liquid: true, source: 'water', textures: 'water' })])
const kind = waterKinds(reg, ID.water)
const SPRING = 8
const water = (level: number) => packVoxel(ID.water, level)

/** One column at (0, 0): y → voxel. */
function column() {
  const cells = new Map<number, number>()
  return {
    cells,
    get: (_x: number, y: number, _z: number) => cells.get(y) ?? AIR,
    set: (_x: number, y: number, _z: number, v: number) => { if (v === AIR) cells.delete(y); else cells.set(y, v) },
  }
}

/** A mirror whose single column was rebuilt dry at `floor`. */
function mirrorAt(floor: number): WaterMirror {
  const m = new WaterMirror(1)
  m.lo[0] = floor
  m.q[0] = floor * 8
  return m
}

describe('quantize', () => {
  it('rounds the surface to eighths; less than 1/16 block over a cell top is no water', () => {
    expect(quantize(4 * SUB + 15)).toBe(32)
    expect(quantize(4 * SUB + 16)).toBe(33)
    expect(quantize(4 * SUB + 239)).toBe(39)
    expect(quantize(4 * SUB + 240)).toBe(40)
  })
})

describe('WaterMirror', () => {
  it('writes full cells under the quantized surface and a partial cell at it', () => {
    const m = mirrorAt(2), w = column()
    expect(m.flush(0, 0, 0, 2, 2 * SUB + 100, ID.water, kind, 32, w.get, w.set)).toBe(true)
    expect([...w.cells].sort((a, b) => a[0] - b[0])).toEqual([[2, water(7)], [3, water(7)], [4, water(2)]])
    expect(m.flush(0, 0, 0, 2, 2 * SUB + 100, ID.water, kind, 32, w.get, w.set)).toBe(false) // nothing changed
  })

  it('clears what is above a lower surface, and everything once the column is dry', () => {
    const m = mirrorAt(2), w = column()
    m.flush(0, 0, 0, 2, 3 * SUB, ID.water, kind, 32, w.get, w.set)
    m.flush(0, 0, 0, 2, SUB, ID.water, kind, 32, w.get, w.set)
    expect([...w.cells.keys()]).toEqual([2])
    m.flush(0, 0, 0, 2, 0, ID.water, kind, 32, w.get, w.set)
    expect(w.cells.size).toBe(0)
  })

  it('empties the cells a risen floor left under it, and leaves static water further down alone', () => {
    const m = mirrorAt(2), w = column()
    w.cells.set(1, water(7)) // static, under the floor
    m.flush(0, 0, 0, 2, 3 * SUB, ID.water, kind, 32, w.get, w.set)
    w.cells.set(4, ID.stone) // a wall dropped in the water: the floor is now 5, the water pushed up
    m.flush(0, 0, 0, 5, 3 * SUB, ID.water, kind, 32, w.get, w.set)
    expect([...w.cells].sort((a, b) => a[0] - b[0])).toEqual([[1, water(7)], [4, ID.stone], [5, water(7)], [6, water(7)], [7, water(7)]])
  })

  it('never writes a wall or a spring inside the water (a floating block, a spring)', () => {
    const m = mirrorAt(2), w = column()
    w.cells.set(3, ID.stone)
    w.cells.set(5, packVoxel(SPRING, 2))
    m.flush(0, 0, 0, 2, 5 * SUB, ID.water, kind, 32, w.get, w.set)
    expect([2, 3, 4, 5, 6].map((y) => w.get(0, y, 0))).toEqual([water(7), ID.stone, water(7), packVoxel(SPRING, 2), water(7)])
  })

  it('rewrites a touched column up to the touched cell: a stray water voxel above the surface goes', () => {
    const m = mirrorAt(2), w = column()
    m.flush(0, 0, 0, 2, SUB, ID.water, kind, 32, w.get, w.set)
    w.cells.set(10, water(7)) // a command placed it; its volume already joined the column
    expect(m.flush(0, 0, 0, 2, SUB, ID.water, kind, 32, w.get, w.set)).toBe(false)
    m.touch(0, 10)
    expect(m.flush(0, 0, 0, 2, SUB, ID.water, kind, 32, w.get, w.set)).toBe(true)
    expect([...w.cells.keys()]).toEqual([2])
  })
})
```

- [ ] **Step 2: Write the failing rebuild tests**

Create `packages/engine/test/waterRebuild.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BlockRegistry, defineBlock } from '../src/blocks/registry.ts'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { SUB, UNIT } from '../src/sim/water/constants.ts'
import { WaterMirror, quantize } from '../src/sim/water/mirror.ts'
import { rebuildColumns, waterKinds } from '../src/sim/water/rebuild.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ChunkStore } from '../src/world/chunkStore.ts'
import { AIR, packVoxel } from '../src/world/voxel.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

const reg = new BlockRegistry([...TEST_BLOCKS, defineBlock({ name: 'spring', liquid: true, source: 'water', textures: 'water' })])
const kind = waterKinds(reg, ID.water)
const water = (level: number) => packVoxel(ID.water, level)

function world(fill: (x: number, y: number, z: number) => number, size: [number, number, number] = [32, 64, 32]) {
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
  const mirror = new WaterMirror(cols.n)
  rebuildColumns(store, kind, cols, mirror, 0, 0, size[0], size[2])
  const at = (x: number, z: number) => ({ floor: cols.floor[x + z * size[0]]!, depth: cols.depth[x + z * size[0]]! })
  return { store, cols, mirror, at, buffers }
}

describe('rebuildColumns', () => {
  it('reads a lake (partial top cell included), a dry column and an empty one', () => {
    const { at, mirror, buffers } = world((x, y, z) => {
      if (x === 31 && z === 31) return AIR
      if (y < 3) return ID.stone
      if (x < 8 && y <= 5) return y === 5 ? water(3) : water(7)
      return AIR
    })
    expect(at(2, 2)).toEqual({ floor: 3, depth: 2 * SUB + 4 * UNIT })
    expect(mirror.q[2 + 2 * 32]).toBe(quantize(3 * SUB + 2 * SUB + 4 * UNIT)) // canonical: nothing to rewrite
    expect(at(20, 2)).toEqual({ floor: 3, depth: 0 })
    expect(at(31, 31)).toEqual({ floor: 0, depth: 0 })
    expect(new Int16Array(buffers.water.floor)[2 + 2 * 32]).toBe(3) // the shared floor the mesh workers read
  })

  it('looks through a thin floating run (a bridge) but not through a thick roof: water under a roof is static', () => {
    const { at } = world((x, y) => {
      if (y < 3) return ID.stone
      if (y <= 5) return water(7)
      if (x === 4 && y >= 8 && y <= 10) return ID.stone // a 3-thick bridge over air
      if (x === 6 && y >= 6 && y <= 14) return ID.stone // a 9-thick roof right on the water
      return AIR
    })
    expect(at(4, 4)).toEqual({ floor: 3, depth: 3 * SUB })
    expect(at(6, 4)).toEqual({ floor: 15, depth: 0 })
  })

  it('reads a chunk that is all water (a uniform chunk)', () => {
    const { at, mirror } = world((_x, y) => (y < 32 ? water(7) : AIR))
    expect(at(9, 9)).toEqual({ floor: 0, depth: 32 * SUB })
    expect(mirror.q[9 + 9 * 32]).toBe(32 * 8)
  })

  it('forces a rewrite of a run that is not the canonical mirror, up to its top', () => {
    const { at, mirror } = world((_x, y) => (y < 3 ? ID.stone : y === 3 ? water(3) : y === 4 ? water(7) : AIR))
    expect(at(1, 1)).toEqual({ floor: 3, depth: 12 * UNIT })
    expect(mirror.q[1 + 32]).toBe(~(5 * 8))
  })

  it('rests water on a spring: the spring is its column\'s floor block', () => {
    const { at } = world((x, y, z) => (y < 3 ? ID.stone : x === 5 && z === 5 && y === 3 ? packVoxel(8, 4) : y <= 5 ? water(7) : AIR))
    expect(at(5, 5)).toEqual({ floor: 4, depth: 2 * SUB })
  })

  it('reports the floors that moved and zeroes the rebuilt columns\' fluxes', () => {
    const { store, cols, mirror } = world((_x, y) => (y < 3 ? ID.stone : AIR))
    cols.flux.fill(160)
    store.setVoxel(7, 3, 7, ID.stone)
    store.commit()
    const moved: number[][] = []
    rebuildColumns(store, kind, cols, mirror, 0, 0, 32, 32, (x, z, from, to) => moved.push([x, z, from, to]))
    expect(moved).toEqual([[7, 7, 3, 4]])
    expect(cols.flux.every((f) => f === 0)).toBe(true)
  })
})
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd packages/engine && npx vitest run test/waterMirror.test.ts test/waterRebuild.test.ts`
Expected: FAIL with "Cannot find module '../src/sim/water/mirror.ts'".

- [ ] **Step 4: Create `packages/engine/src/sim/water/mirror.ts`**

```ts
import { AIR } from '../../world/voxel.ts'
import { KIND, SUB } from './constants.ts'

/** A surface (1/SUB block) in eighths of a block, rounded: the cell holding it gets level round(frac × 8) − 1, air below 1/16 block. */
export function quantize(s: number): number { return (s + SUB / 16) >> 5 }

/**
 * Water voxels as a mirror of the heightfield (spec §4 The voxel mirror). Per column it remembers what the voxels hold, so a
 * flush writes only columns whose quantized water changed, and only the cells that differ.
 */
export class WaterMirror {
  /** Per column: the floor its cells were last written from. */
  readonly lo: Int16Array
  /** Per column: the quantized surface (eighths) its cells hold; ~e (negative) when they must be rewritten up to e eighths. */
  readonly q: Int32Array

  constructor(n: number) {
    this.lo = new Int16Array(n)
    this.q = new Int32Array(n)
  }

  /** An edit touched cell y of column c: rewrite the column at the next flush, up to that cell at least. */
  touch(c: number, y: number): void {
    const q = this.q[c]!, extent = q < 0 ? ~q : q
    this.q[c] = ~Math.max(extent, (y + 1) * 8)
  }

  /**
   * Makes column c's cells match its water: full cells under the quantized surface, a partial cell at it, air above where
   * water was, and air in cells a risen floor left under it. Walls and springs are never written; static water under the
   * old floor is never touched. `set` is a quiet write. Returns whether it wrote anything.
   */
  flush(c: number, x: number, z: number, floor: number, depth: number, water: number, kind: Uint8Array, height: number,
    get: (x: number, y: number, z: number) => number, set: (x: number, y: number, z: number, v: number) => void): boolean {
    const nq = depth > 0 ? quantize(floor * SUB + depth) : floor * 8
    const oq = this.q[c]!, force = oq < 0, extent = force ? ~oq : oq
    const ol = this.lo[c]!
    if (!force && nq === oq && floor === ol) return false
    const from = Math.min(ol, floor)
    const to = Math.min(height, Math.max((extent + 7) >> 3, (nq + 7) >> 3))
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
    this.lo[c] = floor
    this.q[c] = nq
    return wrote
  }

  mixState(mix: (v: number) => void): void {
    for (let c = 0; c < this.q.length; c++) { mix(this.lo[c]!); mix(this.q[c]!) }
  }
}
```

- [ ] **Step 5: Create `packages/engine/src/sim/water/rebuild.ts`**

```ts
import type { BlockRegistry } from '../../blocks/registry.ts'
import { decodeUniform } from '../../world/buffers.ts'
import type { ChunkStore } from '../../world/chunkStore.ts'
import type { WaterColumns } from './columns.ts'
import { KIND, OVERHANG, SUB, UNIT } from './constants.ts'
import { quantize, type WaterMirror } from './mirror.ts'

/** Per block id: KIND.AIR for air, KIND.WATER for the simulated liquid `water`, KIND.WALL for everything else (springs and other liquids too). */
export function waterKinds(reg: BlockRegistry, water: number): Uint8Array {
  const k = new Uint8Array(4096).fill(KIND.WALL)
  k[0] = KIND.AIR
  if (water > 0 && water < reg.count) k[water] = KIND.WATER
  return k
}

/** Called for every rebuilt column whose floor moved. */
export type FloorMoved = (x: number, z: number, from: number, to: number) => void

function cell(chunks: readonly (Uint16Array | number)[], local: number, y: number): number {
  const ch = chunks[y >> 5]!
  return typeof ch === 'number' ? ch : ch[local + ((y & 31) << 10)]!
}

/**
 * Rebuilds columns [x0, x1) × [z0, z1) from the voxels (spec §4; plan decision 4). Each column is read from the top. The
 * first block that is not air decides:
 * - water: the run of water down from it is the column's water, and the block under the run its floor;
 * - a wall run at most OVERHANG thick over air or water (a bridge, a canopy): skipped, the scan goes on below it;
 * - any other wall: the column is dry, its floor on that wall.
 * An all-air column is dry on the world floor (0). Water under a wall that decided is static. The rebuilt columns' fluxes,
 * and the fluxes into them, are zeroed. The mirror records what the voxels hold: a canonical run (full cells under at most
 * one partial top) needs no rewrite, anything else is forced up to the run's top. Reads chunk slots directly.
 */
export function rebuildColumns(store: ChunkStore, kind: Uint8Array, cols: WaterColumns, mirror: WaterMirror,
  x0: number, z0: number, x1: number, z1: number, moved?: FloorMoved): void {
  const L = store.layout, H = L.size[1], sx = cols.sx
  const chunks = new Array<Uint16Array | number>(L.cy)
  for (let cz = z0 >> 5; cz <= (z1 - 1) >> 5; cz++) for (let cx = x0 >> 5; cx <= (x1 - 1) >> 5; cx++) {
    for (let cy = 0; cy < L.cy; cy++) {
      const e = store.table[L.chunkIndex(cx, cy, cz)]!
      chunks[cy] = e < 0 ? decodeUniform(e) : store.views.voxels(e)
    }
    const xa = Math.max(x0, cx * 32), xb = Math.min(x1, cx * 32 + 32)
    const za = Math.max(z0, cz * 32), zb = Math.min(z1, cz * 32 + 32)
    for (let z = za; z < zb; z++) for (let x = xa; x < xb; x++) {
      const local = (x & 31) + ((z & 31) << 5), c = x + z * sx
      let y = H - 1, top = -1, floor = 0
      while (y >= 0) {
        const ch = chunks[y >> 5]!
        const v = typeof ch === 'number' ? ch : ch[local + ((y & 31) << 10)]!
        const k = kind[v & 0xfff]!
        if (k === KIND.AIR) { y = typeof ch === 'number' ? (y & ~31) - 1 : y - 1; continue }
        if (k === KIND.WATER) { top = y; break }
        let r = y - 1
        while (r >= 0 && y - r <= OVERHANG && kind[cell(chunks, local, r) & 0xfff] === KIND.WALL) r--
        if (r >= 0 && y - r <= OVERHANG) { y = r; continue } // a thin floating run: look below it
        floor = y + 1
        break
      }
      let depth = 0, canonical = true
      if (top >= 0) {
        for (y = top; y >= 0; y--) {
          const v = cell(chunks, local, y)
          if (kind[v & 0xfff] !== KIND.WATER) break
          const units = ((v >>> 12) & 7) + 1
          if (units !== 8 && y !== top) canonical = false
          depth += units * UNIT
        }
        floor = y + 1
      }
      const old = cols.floor[c]!
      cols.floor[c] = floor
      cols.depth[c] = depth
      cols.flux[2 * c] = 0
      cols.flux[2 * c + 1] = 0
      if (x > 0) cols.flux[2 * (c - 1)] = 0
      if (z > 0) cols.flux[2 * (c - sx) + 1] = 0
      mirror.lo[c] = floor
      mirror.q[c] = depth === 0 ? floor * 8 : canonical ? quantize(floor * SUB + depth) : ~((top + 1) * 8)
      if (old !== floor) moved?.(x, z, old, floor)
    }
  }
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `cd packages/engine && npx vitest run test/waterMirror.test.ts test/waterRebuild.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/sim/water/mirror.ts packages/engine/src/sim/water/rebuild.ts packages/engine/test/waterMirror.test.ts packages/engine/test/waterRebuild.test.ts
git commit -m "feat(sim): water voxels mirror the heightfield; columns rebuild from the voxels"
```

---

### Task 5: Edits: how one voxel write changes a column

**Files:**
- Create: `packages/engine/src/sim/water/edits.ts`
- Test: `packages/engine/test/waterEdits.test.ts`

**Interfaces:**
- Consumes: `KIND`, `SUB`, `UNIT` (Task 2).
- Produces:
  - `interface EditColumn { floor: number; depth: number }`.
  - `interface ColumnCells { kind(y: number): number; units(y: number): number }`.
  - `applyEdit(col, y, oldKind, oldUnits, newKind, newUnits, cells): void`. `oldUnits` is unused but kept for symmetry: a column's own depth decides how much a removed cell held.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/test/waterEdits.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { KIND, SUB, UNIT } from '../src/sim/water/constants.ts'
import { applyEdit, type ColumnCells, type EditColumn } from '../src/sim/water/edits.ts'

const { AIR: A, WATER: W, WALL: L } = KIND

/** The column's cells after the write: kinds by y (missing: air) and water units by y. */
function cells(kinds: number[], units: number[] = []): ColumnCells {
  return { kind: (y) => kinds[y] ?? A, units: (y) => units[y] ?? 0 }
}

function edit(col: EditColumn, y: number, from: [number, number], to: [number, number], c: ColumnCells = cells([])): EditColumn {
  applyEdit(col, y, from[0], from[1], to[0], to[1], c)
  return col
}

describe('applyEdit', () => {
  it('a wall on the floor in the water raises the floor and keeps the depth: the surface rises by its volume', () => {
    expect(edit({ floor: 2, depth: 3 * SUB }, 2, [W, 8], [L, 0])).toEqual({ floor: 3, depth: 3 * SUB })
  })
  it('a wall in the water above the floor pushes the water under it up', () => {
    expect(edit({ floor: 2, depth: 3 * SUB }, 3, [W, 8], [L, 0])).toEqual({ floor: 4, depth: 3 * SUB })
  })
  it('a wall in the surface cell counts as in the water', () => {
    expect(edit({ floor: 2, depth: 3 * SUB + 100 }, 5, [W, 3], [L, 0])).toEqual({ floor: 6, depth: 3 * SUB + 100 })
  })
  it('ignores a wall above the surface (a bridge), including one resting exactly on it', () => {
    expect(edit({ floor: 2, depth: 3 * SUB }, 6, [A, 0], [L, 0])).toEqual({ floor: 2, depth: 3 * SUB })
    expect(edit({ floor: 2, depth: 3 * SUB }, 5, [A, 0], [L, 0])).toEqual({ floor: 2, depth: 3 * SUB })
  })
  it('raises a dry column\'s floor for a wall on it, and ignores a floating one', () => {
    expect(edit({ floor: 4, depth: 0 }, 4, [A, 0], [L, 0])).toEqual({ floor: 5, depth: 0 })
    expect(edit({ floor: 4, depth: 0 }, 7, [A, 0], [L, 0])).toEqual({ floor: 4, depth: 0 })
  })
  it('ignores a wall below the floor', () => {
    expect(edit({ floor: 4, depth: SUB }, 1, [A, 0], [L, 0])).toEqual({ floor: 4, depth: SUB })
  })
  it('drops the floor to the next wall when the floor block is dug out; static water on the way joins the column', () => {
    // y: 0 stone, 1 stone, 2 static water, 3 air, 4 the dug block (now air)
    expect(edit({ floor: 5, depth: 0 }, 4, [L, 0], [A, 0], cells([L, L, W, A, A], [0, 0, 8]))).toEqual({ floor: 2, depth: SUB })
  })
  it('drops the floor to the world bottom when nothing is below', () => {
    expect(edit({ floor: 3, depth: 2 * SUB }, 2, [L, 0], [A, 0], cells([]))).toEqual({ floor: 0, depth: 2 * SUB })
  })
  it('changes nothing for a wall removed elsewhere (below the floor, or above the water)', () => {
    expect(edit({ floor: 5, depth: SUB }, 2, [L, 0], [A, 0])).toEqual({ floor: 5, depth: SUB })
    expect(edit({ floor: 5, depth: SUB }, 9, [L, 0], [A, 0])).toEqual({ floor: 5, depth: SUB })
  })
  it('adds water placed at or above the floor, even high above the surface, and ignores water placed below it', () => {
    expect(edit({ floor: 2, depth: SUB }, 9, [A, 0], [W, 8])).toEqual({ floor: 2, depth: 2 * SUB })
    expect(edit({ floor: 2, depth: SUB }, 2, [A, 0], [W, 3])).toEqual({ floor: 2, depth: SUB + 3 * UNIT })
    expect(edit({ floor: 4, depth: SUB }, 1, [A, 0], [W, 8])).toEqual({ floor: 4, depth: SUB })
  })
  it('removes a water cell\'s share of the column: a partial top, a full cell, nothing above the surface', () => {
    expect(edit({ floor: 2, depth: 2 * SUB + 100 }, 4, [W, 4], [A, 0])).toEqual({ floor: 2, depth: 2 * SUB })
    expect(edit({ floor: 2, depth: 2 * SUB + 100 }, 2, [W, 8], [A, 0])).toEqual({ floor: 2, depth: SUB + 100 })
    expect(edit({ floor: 2, depth: 2 * SUB }, 7, [W, 8], [A, 0])).toEqual({ floor: 2, depth: 2 * SUB })
  })
  it('replaces a water cell by another level: out with its share, in with the new units', () => {
    expect(edit({ floor: 2, depth: 2 * SUB }, 3, [W, 8], [W, 2])).toEqual({ floor: 2, depth: SUB + 2 * UNIT })
  })
  it('lets a dug floor take the water placed in the dug cell', () => {
    expect(edit({ floor: 4, depth: 0 }, 3, [L, 0], [W, 8], cells([L, L, L, W]))).toEqual({ floor: 3, depth: SUB })
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/engine && npx vitest run test/waterEdits.test.ts`
Expected: FAIL with "Cannot find module '../src/sim/water/edits.ts'".

- [ ] **Step 3: Create `packages/engine/src/sim/water/edits.ts`**

```ts
import { KIND, SUB, UNIT } from './constants.ts'

/** A column's floor and depth, changed in place by applyEdit. */
export interface EditColumn { floor: number; depth: number }

/** The column's voxels after the write: a cell's KIND, and its water units (1–8; 0 when it is not water). */
export interface ColumnCells { kind(y: number): number; units(y: number): number }

/**
 * One voxel write at height y of a column (spec §4 Edits; plan decision 3, design notes: Edits). `oldKind` describes the voxel
 * before, `newKind`/`newUnits` after. Volume is exact:
 * - a wall in the water keeps the water and pushes it up;
 * - water a command removes or places changes the depth by exactly the cell's share of the column or the new units;
 * - static water a dug-out floor uncovers joins the column.
 * `_oldUnits` is not needed: the column's own depth says how much a removed cell held.
 */
export function applyEdit(col: EditColumn, y: number, oldKind: number, _oldUnits: number, newKind: number, newUnits: number, cells: ColumnCells): void {
  const f0 = col.floor
  const s0 = f0 * SUB + col.depth
  // Water overwritten by anything but a wall leaves the column; a wall over water displaces it instead.
  if (oldKind === KIND.WATER && newKind !== KIND.WALL && y >= f0) {
    col.depth = Math.max(0, col.depth - Math.min(SUB, Math.max(0, s0 - y * SUB)))
  }
  if (newKind === KIND.WALL && oldKind !== KIND.WALL) {
    // On the floor or in the water: the floor rises and the depth stays, so the surface rises by the displaced volume.
    if (y >= f0 && (y * SUB < s0 || y === f0)) col.floor = y + 1
  } else if (oldKind === KIND.WALL && newKind !== KIND.WALL && y === f0 - 1) {
    // The floor block dug out: the floor falls to the next wall below, and static water on the way joins the column.
    let f = y
    while (f > 0) {
      const k = cells.kind(f - 1)
      if (k === KIND.WALL) break
      if (k === KIND.WATER) col.depth += cells.units(f - 1) * UNIT
      f--
    }
    col.floor = f
  }
  if (newKind === KIND.WATER && y >= col.floor) col.depth += newUnits * UNIT
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd packages/engine && npx vitest run test/waterEdits.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sim/water/edits.ts packages/engine/test/waterEdits.test.ts
git commit -m "feat(sim): water edit rules: displacement, digging, placed and removed water"
```

---

### Task 6: The water system replaces fluids in the Simulation

This task swaps 3a's `FluidSystem` for the `WaterSystem`, deletes `sim/fluids/` and its tests, and moves every caller to the new API (stats, options, sandbox tests), so the repository stays green.

**Files:**
- Create:
  - `packages/engine/src/sim/water/waterSystem.ts`
  - `packages/engine/test/waterHelpers.ts`
  - `packages/engine/test/waterWorld.test.ts`
- Modify:
  - `packages/engine/src/sim/simulation.ts`
  - `packages/engine/src/sim/simHost.ts` (the `init` case)
  - `packages/engine/src/sim/runSimWorker.ts`
  - `packages/engine/src/protocol.ts` (`SimInitOptions`, the tick `physics` type)
  - `packages/engine/src/engine.ts` (`EngineStats`, `physicsStats`, `stats()`)
  - `apps/sandbox/src/hud.ts`
  - `apps/sandbox/src/main.ts` (sim options)
  - `apps/sandbox/e2e/flood-bench.spec.ts`
- Rewrite:
  - `packages/engine/test/gravity.test.ts`
  - `apps/sandbox/test/flood.test.ts`
  - `apps/sandbox/test/waterSoak.test.ts`
- Change:
  - `packages/engine/test/simulation.test.ts`
  - `packages/engine/test/simHost.test.ts`
  - `packages/engine/test/determinism.test.ts`
  - `packages/terrain/test/generator.test.ts`
- Delete:
  - `packages/engine/src/sim/fluids/` (all of it);
  - `packages/engine/test/fluidHelpers.ts`, `fluidCells.test.ts`, `fluidPrimitives.test.ts`, `fluidWorld.test.ts`;
  - `packages/engine/test/poolScan.test.ts`, `pools.test.ts`, `resurface.test.ts`, `contacts.test.ts`.

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces:
  - `interface WaterOptions { tileCap: number; debug: boolean }` and `DEFAULT_WATER_OPTIONS`.
  - `interface WaterPort { layout; registry; store; buffers: WaterBuffers; get; setQuiet; remesh; log }`.
  - `class WaterSystem`:
    - fields `o`, `water`, `kind`, `cols`, `cycle`, `mirror`, `needsRebuild`, `expected`;
    - getters `enabled`, `seaLevel` (with setter), `sea`, `stepCount`;
    - methods:
      - `total()`, `stats(): { tiles; columns }`, `column(x, z): { floor; depth; surface }`;
      - `onWrite(x, y, z, old, v)`, `step()`, `flush(): number[]`;
      - `rebuild()`, `rebuildRegion(x0, z0, x1, z1): number[]`;
      - `check(): string[]`, `mixState(mix)`.
  - `Simulation.water: WaterSystem` (`Simulation.fluids` is gone) and `SimulationOptions.water?: Partial<WaterOptions>` (`fluids` is gone).
  - `TickResult.physics: { waterTiles: number; waterColumns: number; jobs: number; busy: boolean }`.
  - `SimInitOptions.waterTileCap?: number`. `fluidEvery` and `fluidCap` are gone; `debugFluids` stays.
  - `EngineStats.waterTiles`, `EngineStats.waterColumns` (`fluidActive` and `fluidPools` are gone).
  - Test helpers (`waterHelpers.ts`):
    - `WATER_BLOCKS`, `B`, `w(level)`, `spring(flow)`, `type Fill`;
    - `fillGenerator(fill, seaLevel?)`, `waterSim(fill, o)`, `run`, `settle`;
    - `basin`, `lake`, `surfaceSum`, `depthSum`.

- [ ] **Step 1: Write the test helpers**

Create `packages/engine/test/waterHelpers.ts`:

```ts
import { defineBlock, type BlockDef } from '../src/blocks/registry.ts'
import { defineGenerator, type GeneratorModule } from '../src/sim/generator.ts'
import type { RulesModule } from '../src/sim/rules.ts'
import { Simulation } from '../src/sim/simulation.ts'
import type { WaterOptions } from '../src/sim/water/waterSystem.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { AIR, packVoxel } from '../src/world/voxel.ts'
import { TEST_BLOCKS } from './helpers.ts'

export const WATER_BLOCKS: BlockDef[] = [
  ...TEST_BLOCKS,
  defineBlock({ name: 'sand', falls: true }),
  defineBlock({ name: 'spring', liquid: true, source: 'water', textures: 'water' }),
]
export const B = { air: 0, stone: 1, dirt: 2, grass: 3, glass: 4, water: 5, torch: 6, leaves: 7, sand: 8, spring: 9 } as const
/** A water voxel at a level (0–7). */
export const w = (level = 7): number => packVoxel(B.water, level)
export const spring = (flow = 5): number => packVoxel(B.spring, flow)

export type Fill = (x: number, y: number, z: number) => number
export interface WaterSimOptions {
  size?: [number, number, number]
  /** Handed to the sim through the generator's configure(). */
  seaLevel?: number
  seed?: number
  water?: Partial<WaterOptions>
  rules?: RulesModule
  log?: (message: string) => void
}

/** A generator that writes `fill` for every voxel, and reports `seaLevel` from configure() when given. */
export function fillGenerator(fill: Fill, seaLevel?: number): GeneratorModule {
  return defineGenerator({
    configure: () => (seaLevel === undefined ? undefined : { seaLevel }),
    generateColumn(ctx, cx, cz) {
      for (let y = 0; y < ctx.height; y++) for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
        const v = fill(cx * 32 + lx, y, cz * 32 + lz)
        if (v !== AIR) ctx.column[lx + (lz << 5) + (y << 10)] = v
      }
    },
  })
}

/** A Simulation generated from `fill` (32³ unless `size` says otherwise), without random ticks. */
export function waterSim(fill: Fill, o: WaterSimOptions = {}): Simulation {
  const sim = new Simulation({
    buffers: createWorldBuffers(o.size ?? [32, 32, 32]), blocks: WATER_BLOCKS, rules: o.rules, seed: o.seed ?? 1,
    log: o.log ?? (() => {}), water: o.water, randomTicksPerChunk: 0,
  })
  const gen = fillGenerator(fill, o.seaLevel)
  sim.configure(gen, null)
  sim.generate(gen)
  return sim
}

export function run(sim: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) sim.step()
}

/** Steps (at least once) until no physics work is left: no tile awake, no region job, nothing falling. Returns the ticks. */
export function settle(sim: Simulation, max = 20_000): number {
  for (let i = 1; i <= max; i++) if (!sim.step().physics.busy) return i
  throw new Error(`water still moving after ${max} ticks (${sim.water.stats().tiles} tiles awake)`)
}

/** A stone box: floor y = 0, walls at x/z = 0 and side − 1 up to `wallTop`, air inside and around. */
export function basin(side: number, wallTop: number): Fill {
  return (x, y, z) => {
    if (y === 0) return B.stone
    if ((x === 0 || z === 0 || x === side - 1 || z === side - 1) && y <= wallTop && x < side && z < side) return B.stone
    return AIR
  }
}

/** A basin of side `side` (walls to `wallTop`) holding full water for 1 ≤ y ≤ top. */
export function lake(top: number, side = 12, wallTop = 8): Fill {
  const b = basin(side, wallTop)
  return (x, y, z) => {
    const v = b(x, y, z)
    if (v !== AIR) return v
    return x > 0 && x < side - 1 && z > 0 && z < side - 1 && y >= 1 && y <= top ? w(7) : AIR
  }
}

/** Σ surface (1/SUB block) over columns [x0, x1] × [z0, z1]. */
export function surfaceSum(sim: Simulation, x0: number, z0: number, x1: number, z1: number): number {
  let s = 0
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) s += sim.water.column(x, z).surface
  return s
}

/** Σ depth (1/SUB block) over columns [x0, x1] × [z0, z1]. */
export function depthSum(sim: Simulation, x0: number, z0: number, x1: number, z1: number): number {
  let s = 0
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) s += sim.water.column(x, z).depth
  return s
}
```

- [ ] **Step 2: Write the failing world tests**

Create `packages/engine/test/waterWorld.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SUB } from '../src/sim/water/constants.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, depthSum, lake, run, settle, spring, surfaceSum, w, waterSim, type Fill } from './waterHelpers.ts'

/** lake(4): 10 × 10 columns, 4 blocks deep on a floor at y = 1. */
const LAKE = 100 * 4 * SUB

describe('water in the world', () => {
  it('rebuilds columns from the voxels at generation; a flat lake starts asleep', () => {
    const sim = waterSim(lake(4))
    expect(sim.water.column(5, 5)).toEqual({ floor: 1, depth: 4 * SUB, surface: 5 * SUB })
    expect(sim.water.column(0, 5)).toEqual({ floor: 9, depth: 0, surface: 9 * SUB })
    expect(sim.water.column(20, 20)).toEqual({ floor: 1, depth: 0, surface: SUB })
    expect(sim.water.total()).toBe(LAKE)
    expect(sim.water.expected).toBe(LAKE)
    expect(sim.step().physics).toMatchObject({ waterTiles: 0, waterColumns: 0, busy: false })
  })

  it('a wall landing on the lake floor raises the surface by its volume: sand sinks through the water', () => {
    const sim = waterSim(lake(4))
    const s0 = surfaceSum(sim, 1, 1, 10, 10)
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 8, 5], voxel: B.sand })
    settle(sim)
    expect(sim.store.getVoxel(5, 1, 5)).toBe(B.sand)
    expect(sim.water.column(5, 5).floor).toBe(2)
    expect(surfaceSum(sim, 1, 1, 10, 10) - s0).toBe(SUB)
    expect(sim.water.total()).toBe(LAKE)
  })

  it('a wall dropped into the water pushes the water trapped under it up', () => {
    const sim = waterSim(lake(4))
    const s0 = surfaceSum(sim, 1, 1, 10, 10)
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 2, 5], voxel: B.stone })
    sim.step()
    expect(sim.water.column(5, 5).floor).toBe(3)
    expect(sim.store.getVoxel(5, 1, 5)).toBe(AIR) // the pocket under the wall emptied
    expect(surfaceSum(sim, 1, 1, 10, 10) - s0).toBe(2 * SUB)
    expect(sim.water.total()).toBe(LAKE)
  })

  it('digging out a floor drops it to the next wall, and static water on the way joins the column', () => {
    const sim = waterSim((x, y, z) => (y < 12 ? (x === 5 && z === 5 && y === 3 ? w(7) : B.stone) : AIR))
    expect(sim.water.column(5, 5)).toMatchObject({ floor: 12, depth: 0 }) // the cave cell is static
    sim.submit(0, 0, { type: 'fillRegion', min: [5, 4, 5], max: [5, 11, 5], voxel: AIR })
    sim.step()
    expect(sim.water.column(5, 5)).toMatchObject({ floor: 3, depth: SUB })
    expect(sim.water.total()).toBe(SUB)
    expect(sim.water.expected).toBe(SUB)
  })

  it('water placed in the air over a lake joins its column: the voxel goes and the surface rises', () => {
    const sim = waterSim(lake(4))
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 7, 5], voxel: w(7) })
    sim.step()
    expect(sim.store.getVoxel(5, 7, 5)).toBe(AIR)
    expect(sim.water.total()).toBe(LAKE + SUB)
    expect(sim.water.expected).toBe(LAKE + SUB)
    settle(sim)
    expect(Math.abs(sim.water.column(5, 5).surface - (5 * SUB + SUB / 100))).toBeLessThanOrEqual(16)
  })

  it('water removed by a command leaves its column', () => {
    const sim = waterSim(lake(4))
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 4, 5], voxel: AIR })
    sim.step()
    expect(sim.water.total()).toBe(LAKE - SUB)
    expect(sim.water.expected).toBe(LAKE - SUB)
  })

  it('a block above the surface is a bridge: the floor stays, rising water never overwrites it, and removing it lets water in', () => {
    const sim = waterSim(lake(4, 12, 12))
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 6, 5], voxel: B.stone })
    sim.step()
    expect(sim.water.column(5, 5).floor).toBe(1)
    sim.submit(0, 1, { type: 'fillRegion', min: [1, 9, 1], max: [10, 11, 10], voxel: w(7) }) // 3 more blocks over the lake
    settle(sim)
    expect(sim.store.getVoxel(5, 6, 5)).toBe(B.stone)
    expect(sim.store.getVoxel(5, 5, 5) & 0xfff).toBe(B.water)
    expect(sim.store.getVoxel(5, 7, 5) & 0xfff).toBe(B.water)
    sim.submit(0, 2, { type: 'setBlock', pos: [5, 6, 5], voxel: AIR })
    sim.step()
    expect(sim.store.getVoxel(5, 6, 5) & 0xfff).toBe(B.water)
    expect(sim.water.total()).toBe(sim.water.expected)
  })

  it('an edit on dry land far from water wakes no tile', () => {
    const sim = waterSim(lake(4))
    sim.submit(0, 0, { type: 'setBlock', pos: [25, 1, 25], voxel: B.stone })
    const r = sim.step()
    expect(sim.water.column(25, 25).floor).toBe(2)
    expect(r.physics.waterTiles).toBe(0)
  })

  it('a spring on its column\'s floor runs from the sea, and Σ depth + sea holds', () => {
    // Sea (level 3) for z ≥ 24; land at floor 5 elsewhere, with a spring on it.
    const coast: Fill = (x, y, z) => {
      if (y === 0) return B.stone
      if (z >= 24) return y <= 2 ? w(7) : AIR
      if (y <= 4) return B.stone
      return x === 5 && z === 5 && y === 5 ? spring(5) : AIR
    }
    const sim = waterSim(coast, { seaLevel: 3 })
    expect(sim.water.cycle.springs.size).toBe(1)
    expect(sim.water.sea).toBe(8 * 32 * 2 * SUB)
    const t0 = sim.water.total()
    run(sim, 200)
    expect(sim.water.total()).toBe(t0)
    expect(sim.water.sea).toBeLessThan(8 * 32 * 2 * SUB)
    expect(depthSum(sim, 0, 0, 31, 23)).toBeGreaterThan(0)
  })

  it('a spring gives nothing when the world has a sea level but no sea', () => {
    const sim = waterSim((x, y, z) => (y <= 4 ? B.stone : x === 5 && z === 5 && y === 5 ? spring(5) : AIR), { seaLevel: 3 })
    run(sim, 50)
    expect(sim.water.total()).toBe(0)
    expect(sim.water.sea).toBe(0)
  })

  it('a channel dug beside a lake fills while the lake goes down by exactly what it holds', () => {
    // A 10 × 10 lake 4 deep in a pit (floor 1, ground at 7 around it); the channel runs east from it.
    const pit: Fill = (x, y, z) => {
      if (y === 0) return B.stone
      if (x >= 1 && x <= 10 && z >= 1 && z <= 10) return y <= 4 ? w(7) : AIR
      return y <= 6 ? B.stone : AIR
    }
    const sim = waterSim(pit)
    const lake0 = depthSum(sim, 1, 1, 10, 10)
    sim.submit(0, 0, { type: 'fillRegion', min: [11, 1, 5], max: [20, 6, 6], voxel: AIR })
    settle(sim)
    const channel = depthSum(sim, 11, 5, 20, 6)
    expect(channel).toBeGreaterThan(20 * 3 * SUB)
    expect(lake0 - depthSum(sim, 1, 1, 10, 10)).toBe(channel)
  })
})
```

- [ ] **Step 3: Run the new tests to see them fail**

Run: `cd packages/engine && npx vitest run test/waterWorld.test.ts`
Expected: FAIL with "Cannot find module '../src/sim/water/waterSystem.ts'".

- [ ] **Step 4: Create `packages/engine/src/sim/water/waterSystem.ts`**

```ts
import { waterGroupOf, type BlockRegistry } from '../../blocks/registry.ts'
import type { ChunkStore } from '../../world/chunkStore.ts'
import type { Layout } from '../../world/layout.ts'
import { voxelId, voxelState } from '../../world/voxel.ts'
import type { WaterBuffers } from '../../world/waterBuffers.ts'
import { WaterColumns } from './columns.ts'
import { KIND, MIN_FLOW, SUB, TILE } from './constants.ts'
import { WaterCycle } from './cycle.ts'
import { applyEdit, type ColumnCells, type EditColumn } from './edits.ts'
import { WaterMirror } from './mirror.ts'
import { rebuildColumns, waterKinds } from './rebuild.ts'

export interface WaterOptions {
  /** Awake tiles stepped per tick, in tile order, round robin; the rest wait (spec §6 safety net). Integer ≥ 1. Default 1024. */
  tileCap: number
  /** After every step, check Σ depth + sea against the running total and that no depth is negative; on failure log and rebuild. */
  debug: boolean
}
export const DEFAULT_WATER_OPTIONS: WaterOptions = Object.freeze({ tileCap: 1024, debug: false })

/** What the water system needs from the Simulation. */
export interface WaterPort {
  readonly layout: Layout
  readonly registry: BlockRegistry
  readonly store: ChunkStore
  readonly buffers: WaterBuffers
  get(x: number, y: number, z: number): number
  /** A mirror write: under the chunk seqlock, with no remesh, no relight and no write hooks. */
  setQuiet(x: number, y: number, z: number, v: number): void
  /** Chunk ci must be remeshed at the next commit: static water in it became the heightfield's. */
  remesh(ci: number): void
  log(message: string): void
}

/** Heightfield water in the world (spec §3–4): edits, the step, the mirror and rebuilds. Design notes: the 3c plan. */
export class WaterSystem {
  readonly o: WaterOptions
  /** The simulated liquid's block id (waterGroupOf); 0 when the registry has none, and then the system does nothing. */
  readonly water: number
  /** KIND per block id. */
  readonly kind: Uint8Array
  readonly cols: WaterColumns
  readonly cycle: WaterCycle
  readonly mirror: WaterMirror
  /** Set by a failed debug check or a physics error: the next step rebuilds every column from the voxels. */
  needsRebuild = false
  /** Σ depth + sea as physics must keep it; only edits and rebuilds move it. The debug check compares against it. */
  expected = 0
  private steps = 0
  private readonly port: WaterPort
  private readonly layout: Layout
  private readonly height: number
  private readonly edit: EditColumn = { floor: 0, depth: 0 }
  private ex = 0
  private ez = 0
  private readonly cells: ColumnCells
  private readonly get: (x: number, y: number, z: number) => number
  private readonly set: (x: number, y: number, z: number, v: number) => void

  constructor(port: WaterPort, o: Partial<WaterOptions> = {}) {
    this.port = port
    this.layout = port.layout
    this.height = port.layout.size[1]
    this.o = { ...DEFAULT_WATER_OPTIONS, ...o }
    const cap = this.o.tileCap
    if (!Number.isInteger(cap) || cap < 1) throw new RangeError(`water option tileCap must be an integer ≥ 1, got ${cap}`)
    const reg = port.registry
    this.water = waterGroupOf(reg)
    if (this.water !== 0 && (reg.opaque[this.water] === 1 || reg.emits[this.water]! > 0)) {
      throw new Error(`block "${reg.name(this.water)}" is the simulated water: it must be transparent and emit no light (mirror writes do not relight)`)
    }
    this.kind = waterKinds(reg, this.water)
    const [sx, , sz] = port.layout.size
    this.cols = new WaterColumns(sx, sz, new Int16Array(port.buffers.floor))
    this.cols.floor.fill(0) // an empty world: every column dry on the world floor
    this.cycle = new WaterCycle(sx * sz)
    this.mirror = new WaterMirror(sx * sz)
    this.get = (x, y, z) => port.get(x, y, z)
    this.set = (x, y, z, v) => port.setQuiet(x, y, z, v)
    const sys = this
    this.cells = {
      kind: (y) => sys.kind[voxelId(port.get(sys.ex, y, sys.ez))]!,
      units: (y) => {
        const v = port.get(sys.ex, y, sys.ez)
        return sys.kind[voxelId(v)] === KIND.WATER ? (voxelState(v) & 7) + 1 : 0
      },
    }
  }

  get enabled(): boolean { return this.water !== 0 }
  get seaLevel(): number { return this.cycle.seaLevel }
  set seaLevel(v: number) { this.cycle.seaLevel = v }
  get sea(): number { return this.cycle.sea }
  get stepCount(): number { return this.steps }

  /** Σ depth + sea. */
  total(): number { return this.cols.total() + this.cycle.sea }

  /** Awake tiles and the wet columns in them. */
  stats(): { tiles: number; columns: number } {
    return { tiles: this.cols.tiles.awakeCount(), columns: this.cols.wetAwake() }
  }

  /** Column (x, z): floor, depth and surface. For tests and tools. */
  column(x: number, z: number): { floor: number; depth: number; surface: number } {
    const c = x + z * this.cols.sx
    return { floor: this.cols.floor[c]!, depth: this.cols.depth[c]!, surface: this.cols.surface(c) }
  }

  /** Every voxel write except the mirror's comes here, after the store took it (Simulation.applySet), paused or not. */
  onWrite(x: number, y: number, z: number, old: number, v: number): void {
    if (this.water === 0) return
    const reg = this.port.registry
    if (reg.source[voxelId(old)] === 1) this.cycle.springs.delete(this.layout.voxelIndex(x, y, z))
    if (reg.source[voxelId(v)] === 1) this.cycle.springs.add(this.layout.voxelIndex(x, y, z))
    const ok = this.kind[voxelId(old)]!, nk = this.kind[voxelId(v)]!
    if (ok === nk && nk !== KIND.WATER) return // wall for wall: nothing for water
    const cols = this.cols, c = x + z * cols.sx
    const f0 = cols.floor[c]!, d0 = cols.depth[c]!
    const col = this.edit
    col.floor = f0
    col.depth = d0
    this.ex = x
    this.ez = z
    applyEdit(col, y, ok, ok === KIND.WATER ? (voxelState(old) & 7) + 1 : 0, nk, nk === KIND.WATER ? (voxelState(v) & 7) + 1 : 0, this.cells)
    const T = cols.tiles
    if (col.floor === f0 && col.depth === d0) {
      // No column change, but a cell in or above the water did change (a removed block in the water, a stray voxel): re-mirror.
      if (y >= f0) { this.mirror.touch(c, y); T.dirty[T.of(x, z)] = 1 }
      return
    }
    cols.floor[c] = col.floor
    cols.depth[c] = col.depth
    this.expected += col.depth - d0
    this.mirror.touch(c, y)
    T.dirty[T.of(x, z)] = 1
    if (this.wetAround(x, z)) T.wakeAround(x, z)
    if (col.floor !== f0) this.floorMoved(x, z, c, f0, col.floor)
  }

  /** One physics step (spec §3): springs, flow over the awake tiles, the sea. Not called while paused. */
  step(): void {
    if (this.water === 0) return
    if (this.needsRebuild) this.rebuild()
    this.steps++
    const cy = this.cycle
    cy.runSprings(this.cols, this.layout, this.get, this.port.registry.source)
    cy.sea += this.cols.step(this.o.tileCap, cy.seaLevel > 0 ? cy.mask : null, cy.seaLevel * SUB)
    if (this.o.debug) {
      const bad = this.check()
      if (bad.length > 0) {
        this.port.log(`water: check failed (${bad.length}): ${bad.slice(0, 3).join('; ')}; rebuilding from the voxels`)
        this.needsRebuild = true
      }
    }
  }

  /** Rewrites the mirror of every dirty tile (every tick, paused or not); returns those tiles in index order and clears them. */
  flush(): number[] {
    const out: number[] = []
    if (this.water === 0) return out
    const cols = this.cols, T = cols.tiles, sx = cols.sx
    for (let t = 0; t < T.count; t++) {
      if (T.dirty[t] !== 1) continue
      T.dirty[t] = 0
      out.push(t)
      const x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) {
        const c = x + z * sx
        this.mirror.flush(c, x, z, cols.floor[c]!, cols.depth[c]!, this.water, this.kind, this.height, this.get, this.set)
      }
    }
    return out
  }

  /** The conservation identity and non-negative depths (spec §8). Whole world: for debug builds and tests. */
  check(): string[] {
    const out: string[] = []
    const d = this.cols.depth
    for (let c = 0; c < this.cols.n && out.length < 3; c++) if (d[c]! < 0) out.push(`column ${c} has depth ${d[c]}`)
    const t = this.total()
    if (t !== this.expected) out.push(`Σ depth + sea is ${t}, expected ${this.expected}`)
    return out
  }

  /** Drops all water state and rebuilds every column from the voxels (generation, recovery). */
  rebuild(): void {
    this.needsRebuild = false
    if (this.water === 0) return
    const [sx, , sz] = this.layout.size, cols = this.cols, cy = this.cycle
    cols.tiles.clear()
    cy.springs.clear()
    rebuildColumns(this.port.store, this.kind, cols, this.mirror, 0, 0, sx, sz)
    this.findSprings(0, 0, sx, sz)
    cy.findSea(cols)
    cy.sea = cy.seaDepth(cols)
    this.wakeUnsettled(0, 0, sx, sz)
    cols.tiles.dirty.fill(1)
    this.expected = this.total()
  }

  /**
   * Rebuilds columns [x0, x1) × [z0, z1) after a regeneration, paused or not (plan decision 10). Returns the chunks whose
   * static water became the heightfield's or the other way round (they need a remesh even if their voxels did not change).
   */
  rebuildRegion(x0: number, z0: number, x1: number, z1: number): number[] {
    if (this.water === 0) return []
    const cols = this.cols, cy = this.cycle, T = cols.tiles
    const remesh = new Set<number>()
    for (const s of [...cy.springs]) {
      const [x, , z] = this.layout.voxelCoords(s)
      if (x >= x0 && x < x1 && z >= z0 && z < z1) cy.springs.delete(s)
    }
    rebuildColumns(this.port.store, this.kind, cols, this.mirror, x0, z0, x1, z1, (x, z, from, to) => {
      this.waterChunks(x, z, Math.min(from, to), Math.max(from, to), (ci) => remesh.add(ci))
    })
    this.findSprings(x0, z0, x1, z1)
    const was = cy.mask.slice()
    cy.findSea(cols)
    for (let c = 0; c < cols.n; c++) {
      if (was[c] === cy.mask[c]) continue
      cy.sea += cy.mask[c] === 1 ? cols.depth[c]! : -cols.depth[c]!
    }
    for (let tz = Math.floor(z0 / TILE); tz <= Math.floor((z1 - 1) / TILE); tz++) {
      for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x1 - 1) / TILE); tx++) T.dirty[tx + tz * T.tx] = 1
    }
    this.wakeUnsettled(Math.max(0, x0 - 1), Math.max(0, z0 - 1), Math.min(cols.sx, x1 + 1), Math.min(cols.sz, z1 + 1))
    this.expected = this.total()
    return [...remesh].sort((a, b) => a - b)
  }

  mixState(mix: (v: number) => void): void {
    mix(this.steps)
    mix(this.needsRebuild ? 1 : 0)
    this.cols.mixState(mix)
    this.cycle.mixState(mix)
    this.mirror.mixState(mix)
  }

  /** Whether column (x, z) or one of its four neighbours holds water: only then can an edit there move any. */
  private wetAround(x: number, z: number): boolean {
    const { depth, sx, sz } = this.cols, c = x + z * sx
    return depth[c]! > 0 || (x > 0 && depth[c - 1]! > 0) || (x + 1 < sx && depth[c + 1]! > 0) ||
      (z > 0 && depth[c - sx]! > 0) || (z + 1 < sz && depth[c + sx]! > 0)
  }

  private floorMoved(x: number, z: number, c: number, from: number, to: number): void {
    if (to >= this.cycle.seaLevel) this.cycle.mask[c] = 0
    this.springAt(x, to - 1, z)
    // Static water the floor uncovered was the voxel mesher's: remesh its chunks now that the heightfield draws it.
    if (to < from) this.waterChunks(x, z, to, from, (ci) => this.port.remesh(ci))
  }

  /** Calls `out` once per chunk of column (x, z) that holds water in [y0, y1). */
  private waterChunks(x: number, z: number, y0: number, y1: number, out: (ci: number) => void): void {
    let last = -1
    for (let y = Math.max(0, y0); y < Math.min(this.height, y1); y++) {
      if (this.kind[voxelId(this.port.get(x, y, z))] !== KIND.WATER) continue
      const cy = y >> 5
      if (cy !== last) { out(this.layout.chunkIndex(x >> 5, cy, z >> 5)); last = cy }
    }
  }

  /** Remembers a spring at (x, y, z) if there is one (a column's floor block). */
  private springAt(x: number, y: number, z: number): void {
    if (y < 0) return
    if (this.port.registry.source[voxelId(this.port.get(x, y, z))] === 1) this.cycle.springs.add(this.layout.voxelIndex(x, y, z))
  }

  private findSprings(x0: number, z0: number, x1: number, z1: number): void {
    const { floor, sx } = this.cols
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) this.springAt(x, floor[x + z * sx]! - 1, z)
  }

  /** Wakes the tile of every wet, non-sea column in the range that stands above a neighbour it can flow to. */
  private wakeUnsettled(x0: number, z0: number, x1: number, z1: number): void {
    const { floor, depth, sx, sz, tiles } = this.cols, mask = this.cycle.mask
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      const c = x + z * sx, d = depth[c]!
      if (d < MIN_FLOW || mask[c] === 1) continue
      const s = floor[c]! * SUB + d
      if ((x > 0 && s > this.cols.surface(c - 1)) || (x + 1 < sx && s > this.cols.surface(c + 1)) ||
        (z > 0 && s > this.cols.surface(c - sx)) || (z + 1 < sz && s > this.cols.surface(c + sx))) tiles.wake(tiles.of(x, z))
    }
  }
}
```

- [ ] **Step 5: Wire the water system into `Simulation`**

In `packages/engine/src/sim/simulation.ts`:

1. Replace the import `import { FluidSystem, type FluidOptions, type WriteSource } from './fluids/fluidSystem.ts'` with `import { WaterSystem, type WaterOptions } from './water/waterSystem.ts'`.
2. In `SimulationOptions`, replace `fluids?: Partial<FluidOptions>` with:
   ```ts
     /** Heightfield water options (tile cap, debug check). */
     water?: Partial<WaterOptions>
   ```
3. Replace the `physics` field of `TickResult` and its comment:
   ```ts
     /** Awake water tiles, the wet columns in them and queued region jobs after this tick; busy: a tile is awake, a job is queued or a body falls. */
     physics: { waterTiles: number; waterColumns: number; jobs: number; busy: boolean }
   ```
4. Replace the field `readonly fluids: FluidSystem` with `readonly water: WaterSystem`.
5. In the constructor, replace the `this.fluids = new FluidSystem({…}, o.fluids)` statement with:
   ```ts
       this.water = new WaterSystem({
         layout: this.layout, registry: this.registry, store: this.store, buffers: o.buffers.water,
         get: (x, y, z) => sim.store.getVoxel(x, y, z),
         setQuiet: (x, y, z, v) => { if (sim.store.setVoxelQuiet(x, y, z, v)) sim.epochs[sim.layout.chunkOf(x, y, z)]!++ },
         remesh: (ci) => sim.store.markDirty(ci),
         log: (m) => sim.log(m),
       }, o.water)
   ```
   In the `GravitySystem` port, change the write to `write: (x, y, z, v) => sim.applySet(x, y, z, v, true),`.
6. In `configure`, replace `this.fluids.seaLevel = …` with `this.water.seaLevel = Number.isInteger(sea) && (sea as number) > 0 ? (sea as number) : 0`.
7. In `finishGenerate`, replace `this.fluids.rebuild()` with `this.water.rebuild()`.
8. In `replaceColumns`:
   - delete the line `let wet = false …`;
   - delete the line `if (!wet) wet = this.fluids.regenTouches(ci, old, data)`;
   - delete the line `if (wet) this.fluids.needsRebuild = true`;
   - immediately before the final `return [...out].sort((a, b) => a - b)`, add:
     ```ts
         // The water of the regenerated columns, rebuilt now even while paused; chunks whose static water changed hands remesh.
         for (const ci of this.water.rebuildRegion(x0, z0, x1, z1)) out.add(ci)
     ```
9. In `step()`, replace the physics block and add the mirror flush after `this.light.propagate()`:
   ```ts
         if (!this.isPaused) {
           this.physics('gravity', () => this.gravity.step()) // 3
           this.physics('water', () => this.water.step()) // 4
           this.physics('region jobs', () => this.jobs.run(this.jobCap)) // 5
         }
   ```
   ```ts
         // 4. light
         this.light.propagate()
         // 5. the water mirror follows the heightfield every tick, paused or not, so edits made while paused show
         this.physics('water mirror', () => { this.water.flush() })
   ```
   Replace the stats lines after the `finally` block:
   ```ts
       const ws = this.water.stats(), jobs = this.jobs.size
       const physics = { waterTiles: ws.tiles, waterColumns: ws.columns, jobs, busy: ws.tiles > 0 || jobs > 0 || this.gravity.count > 0 }
   ```
10. In `hash()`, replace `this.fluids.mixState(mix)` with `this.water.mixState(mix)`.
11. In `physics()`, change the heal line and its doc comment:
    ```ts
      /** Spec §9: a physics exception is a bug, not content. Log it, finish the tick, heal the water through a rebuild. */
    ```
    ```ts
          if (name !== 'gravity') this.water.needsRebuild = true
    ```
12. Replace `applySet`:
    ```ts
      private applySet(x: number, y: number, z: number, v: number, notify: boolean): void {
        const old = this.store.getVoxel(x, y, z)
        if (old === v || !this.layout.inBounds(x, y, z)) return
        if (!this.store.setVoxel(x, y, z, v)) return
        this.epochs[this.layout.chunkOf(x, y, z)]!++
        // Light depends only on a block's opacity and emission, which belong to its id: a state change cannot move it.
        if (voxelId(old) !== voxelId(v)) this.light.onVoxelChanged(x, y, z, old, v)
        this.water.onWrite(x, y, z, old, v)
        this.gravity.afterWrite(x, y, z, v)
        if (!notify || !this.hasNeighborRules) return
        this.neighbors.push(this.layout.voxelIndex(x, y, z))
        for (let d = 0; d < 6; d++) {
          const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
          if (this.layout.inBounds(nx, ny, nz)) this.neighbors.push(this.layout.voxelIndex(nx, ny, nz))
        }
      }
    ```
13. Update the comment on `paused`: "True while physics (gravity, water, region jobs) is stopped. Rules, random ticks, light and the water mirror still run."

- [ ] **Step 6: Options, protocol, worker exports, engine stats**

In `packages/engine/src/protocol.ts`, replace the three fluid options in `SimInitOptions` (`debugFluids`, `fluidEvery`, `fluidCap`) with:

```ts
  /** After every water step, check Σ depth + sea against the running total and that no depth is negative (slow; for debugging). On failure: log and rebuild from the voxels. */
  debugFluids?: boolean
  /** Awake water tiles (16 × 16 columns) stepped per tick, in tile order, round robin (integer ≥ 1). Default 1024. */
  waterTileCap?: number
```

In the `FromSim` `'tick'` member, replace `physics: { active: number; pools: number; jobs: number; busy: boolean }` with `physics: { waterTiles: number; waterColumns: number; jobs: number; busy: boolean }`.

In `packages/engine/src/sim/simHost.ts`, `init` case, replace the `fluids: {…}` property with:

```ts
            // only defined keys: an undefined one would override WaterSystem's default
            water: {
              debug: msg.options.debugFluids === true,
              ...(msg.options.waterTileCap !== undefined && { tileCap: msg.options.waterTileCap }),
            },
```

In `packages/engine/src/sim/runSimWorker.ts`, replace `export type { FluidOptions, WriteSource } from './fluids/fluidSystem.ts'` with `export type { WaterOptions } from './water/waterSystem.ts'`.

In `packages/engine/src/engine.ts`:
- in `EngineStats`, replace the `fluidActive`/`fluidPools`/`regionJobs` line and its comment, and the `physicsBusy` comment:
  ```ts
    /** Awake water tiles (16 × 16 columns), wet columns in them, and queued region jobs, as of the last tick. */
    waterTiles: number; waterColumns: number; regionJobs: number
    /** True while a water tile was awake, a region job queued or a block falling after the last tick. */
    physicsBusy: boolean
  ```
- replace `let physicsStats = { active: 0, pools: 0, jobs: 0, busy: false }` with `let physicsStats = { waterTiles: 0, waterColumns: 0, jobs: 0, busy: false }`;
- in `stats()`, replace `fluidActive: physicsStats.active, fluidPools: physicsStats.pools,` with `waterTiles: physicsStats.waterTiles, waterColumns: physicsStats.waterColumns,`.

- [ ] **Step 7: Sandbox callers**

In `apps/sandbox/src/hud.ts`, replace the physics line:

```ts
      `physics  water tiles ${s.waterTiles}   columns ${s.waterColumns}   jobs ${s.regionJobs}   falling ${s.fallingBodies}   ${s.physicsBusy ? 'busy' : 'settled'}`,
```

In `apps/sandbox/src/main.ts`, replace the non-`still` sim options (and drop the trailing fluid comment):

```ts
    : { randomTicksPerChunk: randomTickRate(size[0], size[2]), debugFluids: params.has('debugFluids') },
```

In `apps/sandbox/e2e/flood-bench.spec.ts`:
- replace the doc comment's "(otherwise its water keeps ~85 cells moving forever)" with "(otherwise its river tiles never sleep)";
- replace `peak = Math.max(peak, s.fluidActive)` with `peak = Math.max(peak, s.waterColumns)`;
- replace `peakActive: peak` with `peakColumns: peak`.

- [ ] **Step 8: Delete 3a's fluids and their tests**

```bash
git rm -r packages/engine/src/sim/fluids
git rm packages/engine/test/fluidHelpers.ts packages/engine/test/fluidCells.test.ts packages/engine/test/fluidPrimitives.test.ts packages/engine/test/fluidWorld.test.ts packages/engine/test/poolScan.test.ts packages/engine/test/pools.test.ts packages/engine/test/resurface.test.ts packages/engine/test/contacts.test.ts
```

- [ ] **Step 9: Move the remaining tests to the new API**

Rewrite `packages/engine/test/gravity.test.ts` in full:

```ts
import { describe, expect, it } from 'vitest'
import { BlockRegistry } from '../src/blocks/registry.ts'
import { GravitySystem, MAX_FALL_256 } from '../src/sim/gravity.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { Layout } from '../src/world/layout.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, WATER_BLOCKS, lake, run, spring, w, waterSim } from './waterHelpers.ts'

const floor = (_x: number, y: number) => (y === 0 ? B.stone : AIR)

describe('gravity', () => {
  it('lifts an unsupported block out of the grid and lands it, accelerating to a cap', () => {
    const sim = waterSim(floor)
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 20, 5], voxel: B.sand })
    const r0 = sim.step()
    expect(sim.store.getVoxel(5, 20, 5)).toBe(AIR)
    expect(r0.falling).toEqual([{ id: 1, voxel: B.sand, x: 5, z: 5, y256: 20 * 256 - 24, vy256: 24 }])
    let landedAt = -1
    for (let t = 1; t < 60 && landedAt < 0; t++) {
      const r = sim.step()
      for (const b of r.falling) expect(b.vy256).toBeLessThanOrEqual(MAX_FALL_256)
      if (r.landed.length > 0) {
        landedAt = t
        expect(r.landed[0]).toMatchObject({ id: 1, x: 5, y: 1, z: 5, chunk: 0 })
        expect(r.landed[0]!.version % 2).toBe(0)
        expect(r.landed[0]!.version).toBe(sim.store.versions[0])
      }
    }
    expect(landedAt).toBeGreaterThan(0)
    expect(sim.store.getVoxel(5, 1, 5)).toBe(B.sand)
    expect(sim.gravity.count).toBe(0)
  })
  it('drops a whole column together and stacks it', () => {
    const sim = waterSim(floor)
    sim.submit(0, 0, { type: 'fillRegion', min: [3, 10, 3], max: [3, 12, 3], voxel: B.sand })
    const r = sim.step()
    expect(r.falling.map((b) => b.id)).toEqual([1, 2, 3])
    run(sim, 40)
    expect([1, 2, 3, 4].map((y) => sim.store.getVoxel(3, y, 3))).toEqual([B.sand, B.sand, B.sand, AIR])
  })
  it('passes a torch on the way and destroys one in its landing cell', () => {
    const sim = waterSim((x, y, z) => (y === 0 ? B.stone : x === 7 && z === 7 && (y === 1 || y === 5) ? B.torch : AIR))
    sim.submit(0, 0, { type: 'setBlock', pos: [7, 9, 7], voxel: B.sand })
    run(sim, 40)
    expect(sim.store.getVoxel(7, 5, 7)).toBe(B.torch)
    expect(sim.store.getVoxel(7, 1, 7)).toBe(B.sand)
  })
  it('lands on a spring without overwriting it', () => {
    const sim = waterSim((x, y, z) => (y === 0 ? B.stone : x === 7 && z === 7 && y === 1 ? spring() : AIR))
    sim.submit(0, 0, { type: 'setBlock', pos: [7, 9, 7], voxel: B.sand })
    run(sim, 40)
    expect(sim.store.getVoxel(7, 1, 7)).toBe(spring())
    expect(sim.store.getVoxel(7, 2, 7)).toBe(B.sand)
    expect(sim.gravity.count).toBe(0)
  })
  it('sinks through a lake to its floor; the lake keeps its water and its floor there rises', () => {
    const sim = waterSim(lake(4))
    const v0 = sim.water.total()
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 8, 5], voxel: B.sand })
    run(sim, 30)
    expect(sim.store.getVoxel(5, 1, 5)).toBe(B.sand)
    expect(sim.water.column(5, 5).floor).toBe(2)
    expect(sim.water.total()).toBe(v0)
  })
  it('pushes the water of a one-column well up when it lands in it', () => {
    const sim = waterSim((x, y, z) => (y === 0 ? B.stone : (x === 4 || x === 6 || z === 4 || z === 6) && y <= 3 ? B.stone : AIR))
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 1, 5], voxel: w(5) })
    sim.step()
    const v0 = sim.water.total()
    expect(v0).toBe((6 * SUB) / 8)
    sim.submit(0, 1, { type: 'setBlock', pos: [5, 9, 5], voxel: B.sand })
    run(sim, 30)
    expect(sim.store.getVoxel(5, 1, 5)).toBe(B.sand)
    expect(sim.water.column(5, 5)).toMatchObject({ floor: 2, depth: v0 })
    expect(sim.water.total()).toBe(v0)
  })
  it('logs a throwing physics phase, drops the job, and finishes the tick', () => {
    const logs: string[] = []
    const sim = waterSim(floor, { log: (m) => logs.push(m) })
    sim.jobs.start({ kind: 'boom', done: false, step() { throw new Error('boom') }, finish() {}, reset() {}, mixState() {} })
    expect(() => sim.step()).not.toThrow()
    expect(logs.some((m) => /region jobs error tick=0: boom/.test(m))).toBe(true)
    expect(sim.jobs.size).toBe(0)
    expect(sim.water.needsRebuild).toBe(true)
  })
  it('keeps its bodies consistent when a landing write throws: no body lands twice', () => {
    const layout = new Layout([32, 32, 32])
    const world = new Map<number, number>()
    const writes: string[] = []
    let landings = 0
    const g = new GravitySystem({
      layout, registry: new BlockRegistry(WATER_BLOCKS),
      get: (x, y, z) => (y === 0 ? B.stone : world.get(layout.voxelIndex(x, y, z)) ?? AIR),
      write(x, y, z, v) {
        if (v !== AIR && ++landings === 2) throw new Error('write failed')
        world.set(layout.voxelIndex(x, y, z), v)
        if (v !== AIR) writes.push(`${x},${y},${z}`)
      },
    })
    for (const x of [3, 6]) { world.set(layout.voxelIndex(x, 5, 3), B.sand); g.afterWrite(x, 5, 3, B.sand) }
    let threw = 0
    for (let t = 0; t < 40; t++) { try { g.step() } catch { threw++ } }
    expect(threw).toBe(1) // both land in the same step; the second landing's write throws
    expect(writes).toEqual(['3,1,3']) // the first body landed once and was not landed again
    expect(g.count).toBe(0) // the body whose landing threw is dropped, not retried on top of a half-written cell
  })
  it('holds still while physics is paused', () => {
    const sim = waterSim(floor)
    sim.setPaused(true)
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 20, 5], voxel: B.sand })
    run(sim, 5)
    expect(sim.store.getVoxel(5, 20, 5)).toBe(B.sand)
    sim.setPaused(false)
    expect(sim.step().falling).toHaveLength(1)
  })
})
```

In `packages/engine/test/simulation.test.ts`, replace the two water tests `'does not relight when only a block state changes'` and `'reports physics busy while fluid moves or a job is queued, and idle once settled'` with:

```ts
  it('does not relight when only a block state changes', () => {
    const sim = makeSim()
    sim.submit(1, 0, { type: 'setBlock', pos: [5, 5, 5], voxel: ID.stone })
    sim.step()
    const spy = vi.spyOn(sim.light, 'onVoxelChanged')
    sim.submit(1, 1, { type: 'setBlock', pos: [5, 5, 5], voxel: (3 << 12) | ID.stone })
    sim.step()
    expect(spy).not.toHaveBeenCalled()
    expect(sim.store.getVoxel(5, 5, 5)).toBe((3 << 12) | ID.stone)
  })
  it('reports physics busy while water moves or a job is queued, and idle once settled', () => {
    const sim = makeSim()
    expect(sim.step().physics).toMatchObject({ waterTiles: 0, waterColumns: 0, jobs: 0, busy: false })
    sim.submit(1, 0, { type: 'setBlock', pos: [5, 20, 5], voxel: (7 << 12) | ID.water })
    expect(sim.step().physics.busy).toBe(true)
    let busy = true
    for (let i = 0; i < 2000 && busy; i++) busy = sim.step().physics.busy
    expect(busy).toBe(false)
    let left = 2
    sim.jobs.start({ kind: 't', done: false, step() { if (--left === 0) (this as { done: boolean }).done = true; return 1 }, finish() {}, reset() {}, mixState() {} })
    expect(sim.step().physics).toMatchObject({ jobs: 1, busy: true })
    expect(sim.step().physics).toMatchObject({ jobs: 0, busy: false })
  })
```

In `packages/engine/test/simHost.test.ts`, replace the tests `'passes fluidEvery from the init options…'` and `'validates fluidCap from the init options…'` with:

```ts
  it('passes debugFluids and waterTileCap to the water system', () => {
    const { host } = setup({ debugFluids: true, waterTileCap: 7 })
    expect(host.simulation!.water.o).toMatchObject({ debug: true, tileCap: 7 })
  })
  it('validates waterTileCap from the init options through the water system', () => {
    const { out } = setup({ waterTileCap: 0 })
    expect(out.some((m) => m.type === 'fatal' && /tileCap/.test(m.message))).toBe(true)
  })
```

In `packages/engine/test/determinism.test.ts`:
- replace the spring line of `script` (`if (t === 30) sim.submit(6, t, …)`) with:
  ```ts
    if (t === 30) {
      let y = 63
      while (y > 0 && sim.store.getVoxel(32, y - 1, 32) === AIR) y--
      sim.submit(6, t, { type: 'setBlock', pos: [32, y, 32], voxel: (5 << 12) | SPRING }) // on the ground: its column's floor block
    }
  ```
- replace `expect(a.fluids.totalVolume()).toBeGreaterThan(0) // water and the spring really ran` with:
  ```ts
      expect(a.water.sea).toBeLessThan(0) // no sea level: the spring ran unbounded
      expect(a.water.total()).toBe(a.water.expected)
  ```

In `packages/terrain/test/generator.test.ts`, replace `expect(s.fluids.seaLevel).toBe(10)` with `expect(s.water.seaLevel).toBe(10)`.

Rewrite `apps/sandbox/test/flood.test.ts`. Keep the `describe('flood scene layout', …)` block as it is. Add `import { SUB } from '@elovox/engine/src/world/waterBuffers.ts'` to the imports, and replace the `describe('flood scene simulation', …)` block with:

```ts
describe('flood scene simulation', () => {
  it('rebuilds the lake, the sea and the spring from the voxels, and a breach pours the lake into the valley', () => {
    const sim = new Simulation({ buffers: createWorldBuffers([...FLOOD_SIZE]), blocks: BLOCKS, rules, seed: 1, log: () => {} })
    sim.configure(floodGenerator, {})
    sim.generate(floodGenerator)
    expect(sim.water.column(60, 60)).toMatchObject({ floor: LAKE.floor, depth: (LAKE.top + 1 - LAKE.floor) * SUB })
    expect(sim.water.column(70, 70)).toMatchObject({ floor: LAKE.floor }) // the sand pillar on planks floats over the lake
    expect(sim.water.cycle.mask[50 + 230 * FLOOD_SIZE[0]]).toBe(1)
    expect(sim.water.cycle.springs.size).toBe(1)
    const lake0 = sim.water.column(LAKE.x1, 75).depth
    breachCommands().forEach((c, i) => sim.submit(0, i, c))
    for (let t = 0; t < 80; t++) sim.step()
    let valley = 0
    for (let x = VALLEY.x0; x < VALLEY.x0 + 24; x++) for (let z = BREACH.z0 - 12; z <= BREACH.z1 + 12; z++) valley += sim.water.column(x, z).depth
    expect(valley).toBeGreaterThan(0)
    expect(sim.water.column(LAKE.x1, 75).depth).toBeLessThan(lake0)
  }, 180_000)
  it('with the spring stopped, a breached lake drains into the valley and the scene settles without losing water', () => {
    const logs: string[] = []
    const sim = new Simulation({
      buffers: createWorldBuffers([...FLOOD_SIZE]), blocks: BLOCKS, rules, seed: 1, randomTicksPerChunk: 0,
      log: (m) => logs.push(m), water: { debug: true },
    })
    sim.configure(floodGenerator, {})
    sim.generate(floodGenerator)
    const v0 = sim.water.total()
    const lake0 = sim.water.column(60, 60).surface
    ;[...stopSpringCommands(sim.registry.id('stone')), ...breachCommands()].forEach((c, i) => sim.submit(0, i, c))
    // settled: no physics work for 3 ticks in a row, counted only once the lake has dropped
    let quiet = 0
    for (let t = 0; t < 30_000 && quiet < 3; t++) {
      const r = sim.step()
      quiet = sim.water.column(60, 60).surface < lake0 && !r.physics.busy ? quiet + 1 : 0
    }
    expect(quiet).toBe(3)
    expect(sim.water.column(60, 60).surface).toBeLessThan(lake0 - SUB)
    expect(sim.water.cycle.springs.size).toBe(0)
    expect(logs).toEqual([])
    expect(sim.water.total()).toBe(v0)
    expect(sim.water.check()).toEqual([])
  }, 300_000)
})
```

Rewrite `apps/sandbox/test/waterSoak.test.ts`:

```ts
import { Simulation } from '@elovox/engine/src/sim/simulation.ts'
import { createWorldBuffers } from '@elovox/engine/src/world/buffers.ts'
import { terrainGenerator } from '@elovox/terrain'
import { describe, expect, it } from 'vitest'
import { BLOCKS } from '../src/blocks.ts'
import rules from '../src/rules.ts'
import e2eDoc from '../src/terrain/e2e.terrain.json'

describe('natural water soak', () => {
  it('the e2e document\'s river and lakes run 3000 ticks with Σ depth + sea exact and the debug check quiet', () => {
    const logs: string[] = []
    const sim = new Simulation({
      buffers: createWorldBuffers([e2eDoc.size[0]!, 128, e2eDoc.size[1]!]), blocks: BLOCKS, rules, seed: 1234,
      randomTicksPerChunk: 0, log: (m) => logs.push(m), water: { debug: true },
    })
    sim.configure(terrainGenerator, e2eDoc)
    sim.generate(terrainGenerator)
    expect(sim.water.cycle.springs.size).toBe(1) // the river-head spring, under its water
    const v0 = sim.water.total()
    for (let t = 0; t < 3000; t++) sim.step()
    expect(logs).toEqual([])
    expect(sim.water.total()).toBe(v0)
    expect(sim.water.check()).toEqual([])
  }, 60_000)
})
```

- [ ] **Step 10: Check that nothing still uses the old API**

Use the Grep tool with pattern `sim/fluids|fluidHelpers|\.fluids\b|fluidActive|fluidPools|fluidEvery|fluidCap|FluidOptions|WriteSource` over `packages/` and `apps/`, excluding `node_modules`.
Expected: no matches. Fix any that remain the same way as above.

- [ ] **Step 11: Run every test and the typecheck**

Run: `cd packages/engine && npx vitest run test/waterWorld.test.ts test/gravity.test.ts test/simulation.test.ts test/simHost.test.ts test/determinism.test.ts test/replaceColumns.test.ts test/regenerate.test.ts`
Expected: PASS.

Run: `npm test` and `npm run typecheck` (repo root).
Expected: PASS, no type errors. `apps/sandbox/test/flood.test.ts` takes up to a few minutes.

If the flood settle test does not settle within 30 000 ticks, record the tick count and the awake tiles at the end, and report to the controller. Do not raise the limit silently.

- [ ] **Step 12: Commit**

The deletions are already staged by `git rm` (Step 8). Stage the rest by name: other agents may have unrelated changes in the working tree, so leave those unstaged.

```bash
git add packages/engine/src/sim/water/waterSystem.ts packages/engine/src/sim/simulation.ts packages/engine/src/sim/simHost.ts packages/engine/src/sim/runSimWorker.ts packages/engine/src/protocol.ts packages/engine/src/engine.ts packages/engine/test/waterHelpers.ts packages/engine/test/waterWorld.test.ts packages/engine/test/gravity.test.ts packages/engine/test/simulation.test.ts packages/engine/test/simHost.test.ts packages/engine/test/determinism.test.ts apps/sandbox/src/hud.ts apps/sandbox/src/main.ts apps/sandbox/e2e/flood-bench.spec.ts apps/sandbox/test/flood.test.ts apps/sandbox/test/waterSoak.test.ts packages/terrain/test/generator.test.ts
git status --short
git commit -m "feat(sim): heightfield water replaces the cell automaton and pools"
```

Before committing, check that `git status --short` shows only this task's files as staged (`M`, `A` or `D` in the first column).

---

### Task 7: Conservation fuzz, the debug check, pause and regenerate, the hash

**Files:**
- Test: `packages/engine/test/waterFuzz.test.ts` (create)

**Interfaces:**
- Consumes:
  - `waterSim`, `fillGenerator`, `lake`, `settle`, `B`, `w`, `spring` (Task 6 helpers);
  - `Simulation.replaceColumns`, `generateColumnData`, `setPaused`, `hash`, `commandLog`;
  - `WaterSystem.expected`, `check()`, `needsRebuild`.
- Produces: tests only. If any test here fails, the fix belongs in `waterSystem.ts` or `simulation.ts`: fix the code, never the test's expectations.

- [ ] **Step 1: Write the tests**

Create `packages/engine/test/waterFuzz.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Command } from '../src/sim/commands.ts'
import { Pcg32 } from '../src/sim/rng.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, fillGenerator, lake, settle, spring, w, waterSim, type Fill } from './waterHelpers.ts'

/** Random ground 1–6 high with water up to y = 4 above it; the low ground reaching the edges is sea (sea level 5). */
function terrain(seed: number): Fill {
  const rng = new Pcg32(seed)
  const h = Array.from({ length: 32 * 32 }, () => 1 + rng.nextInt(6))
  return (x, y, z) => {
    const top = h[x + z * 32]!
    if (y < top) return B.stone
    return y <= 4 ? w(7) : AIR
  }
}

function command(rng: Pcg32): Command | null {
  const k = rng.nextInt(7)
  const x = rng.nextInt(32), y = 1 + rng.nextInt(10), z = rng.nextInt(32)
  switch (k) {
    case 0: return { type: 'setBlock', pos: [x, y, z], voxel: AIR }
    case 1: return { type: 'setBlock', pos: [x, y, z], voxel: B.stone }
    case 2: return { type: 'setBlock', pos: [x, y, z], voxel: w(rng.nextInt(8)) }
    case 3: return { type: 'setBlock', pos: [x, y, z], voxel: B.sand }
    case 4: return { type: 'setBlock', pos: [x, y, z], voxel: spring(rng.nextInt(16)) }
    case 5: return { type: 'fillRegion', min: [x, y, z], max: [Math.min(31, x + 2), y, Math.min(31, z + 2)], voxel: AIR }
    default: return null
  }
}

describe('water conservation', () => {
  it('keeps Σ depth + sea on the running total under random edits, sand and springs, with the debug check quiet', () => {
    for (const seed of [1, 2, 3]) {
      const logs: string[] = []
      const sim = waterSim(terrain(seed), { seed, seaLevel: 5, water: { debug: true }, log: (m) => logs.push(m) })
      const rng = new Pcg32(seed * 977)
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
      // The same commands replayed from the log reproduce the same world, water included.
      const replay = waterSim(terrain(seed), { seed, seaLevel: 5, water: { debug: true } })
      let i = 0
      for (let t = 0; t < 400; t++) {
        while (i < sim.commandLog.length && sim.commandLog[i]!.tick === t) { const c = sim.commandLog[i++]!; replay.submit(c.clientId, c.seq, c.cmd) }
        replay.step()
      }
      expect(replay.hash()).toBe(sim.hash())
    }
  }, 120_000)
})

describe('the debug check', () => {
  it('logs a failed check and heals by rebuilding from the voxels', () => {
    const logs: string[] = []
    const sim = waterSim(lake(4), { water: { debug: true }, log: (m) => logs.push(m) })
    sim.water.cols.depth[5 + 5 * 32] += 100 // water from nowhere
    sim.step()
    expect(logs.some((m) => /water: check failed/.test(m))).toBe(true)
    expect(sim.water.needsRebuild).toBe(true)
    sim.step()
    expect(sim.water.needsRebuild).toBe(false)
    expect(sim.water.check()).toEqual([])
    expect(sim.water.column(5, 5).depth).toBe(4 * SUB)
  })
})

describe('pause and regenerate', () => {
  it('keeps columns exact through edits and a regeneration while paused, and resumes without a rebuild', () => {
    const logs: string[] = []
    const sim = waterSim(lake(4), { water: { debug: true }, log: (m) => logs.push(m) })
    sim.setPaused(true)
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 7, 5], voxel: w(7) })
    sim.step()
    expect(sim.store.getVoxel(5, 7, 5)).toBe(AIR) // the mirror runs while paused
    expect(sim.water.column(5, 5).depth).toBe(5 * SUB) // nothing flowed: physics is paused
    expect(sim.store.getVoxel(5, 5, 5)).toBe(w(7))
    // Regenerate the chunk column with a shallower lake, still paused.
    const data = new Uint16Array(32 * 32 * 32)
    sim.generateColumnData(fillGenerator(lake(2)), 0, 0, data)
    sim.replaceColumns([{ cx: 0, cz: 0, data }])
    expect(sim.water.column(5, 5)).toMatchObject({ floor: 1, depth: 2 * SUB })
    expect(sim.water.total()).toBe(100 * 2 * SUB)
    expect(sim.water.expected).toBe(sim.water.total())
    sim.setPaused(false)
    settle(sim)
    expect(sim.water.total()).toBe(100 * 2 * SUB)
    expect(sim.water.needsRebuild).toBe(false)
    expect(logs).toEqual([])
  })
})

describe('the world hash', () => {
  it('mixes the water state in, velocities included', () => {
    const a = waterSim(lake(4)), b = waterSim(lake(4))
    expect(a.hash()).toBe(b.hash())
    a.water.cols.flux[2 * (5 + 5 * 32)] = 16
    expect(a.hash()).not.toBe(b.hash())
  })
})
```

- [ ] **Step 2: Run them**

Run: `cd packages/engine && npx vitest run test/waterFuzz.test.ts`
Expected: PASS.

If a test fails, it is a real bug in Tasks 2–6. Debug it with the superpowers:systematic-debugging skill. The usual suspects:
- an edit path that changes `depth` without updating `expected`;
- a mirror write that goes through `applySet` instead of `setQuiet`;
- a region rebuild that leaves stale fluxes.

- [ ] **Step 3: Commit**

```bash
git add packages/engine/test/waterFuzz.test.ts
git commit -m "test(sim): water conservation fuzz, debug check, pause and regenerate, hash"
```

---

### Task 8: Publishing the heightfield to shared memory

**Files:**
- Create: `packages/engine/src/sim/water/publish.ts`
- Modify:
  - `packages/engine/src/sim/water/waterSystem.ts` (`published`, the publisher, `flush`)
  - `packages/engine/src/sim/simulation.ts` (`TickResult.water`)
  - `packages/engine/src/protocol.ts` (the tick's `water`)
- Test: `packages/engine/test/waterPublish.test.ts`

**Interfaces:**
- Consumes: `WaterColumns`, `moved` (Task 2); `WaterBuffers` (Task 1); `WaterSystem.flush()` (Task 6).
- Produces:
  - `interface WaterTick { seq: number; parity: number; tiles: number[] }`.
  - `mergeTiles(a, b): number[]`.
  - `class WaterPublisher`: constructor `(b: WaterBuffers)`, method `publish(changed, cols): WaterTick | null`.
  - `WaterSystem.published: WaterTick | null`, set by every `flush()`.
  - `TickResult.water: WaterTick | null`, and the same field on the `FromSim` `'tick'` message.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/test/waterPublish.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { WaterPublisher, mergeTiles } from '../src/sim/water/publish.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { createWaterBuffers } from '../src/world/waterBuffers.ts'
import { WATER_BLOCKS, fillGenerator, lake, w } from './waterHelpers.ts'

describe('WaterPublisher', () => {
  it('writes the changed tiles plus the previous publish\'s into alternating parities, stamped', () => {
    const b = createWaterBuffers([32, 32, 32])
    const cols = new WaterColumns(32, 32, new Int16Array(b.floor))
    cols.floor.fill(2)
    cols.depth[0] = 300
    cols.flux[0] = 16 * 5
    cols.flux[1] = -16 * 3
    const p = new WaterPublisher(b)
    const surface = new Int32Array(b.surface), flux = new Int16Array(b.flux), stamp = new Int32Array(b.stamp)
    expect(p.publish([0], cols)).toEqual({ seq: 1, parity: 1, tiles: [0] })
    expect(surface[1024 + 0]).toBe(2 * SUB + 300)
    expect(surface[1024 + 1]).toBe(~(2 * SUB)) // dry: its ground
    expect([flux[2 * 1024], flux[2 * 1024 + 1]]).toEqual([5, -3])
    expect([...stamp]).toEqual([-1, 1])
    expect(p.publish([1], cols)).toEqual({ seq: 2, parity: 0, tiles: [0, 1] })
    expect(p.publish([], cols)).toEqual({ seq: 3, parity: 1, tiles: [1] })
    expect(p.publish([], cols)).toBeNull()
  })

  it('clamps the published flux to 16 bits', () => {
    const b = createWaterBuffers([32, 32, 32])
    const cols = new WaterColumns(32, 32, new Int16Array(b.floor))
    cols.flux[0] = 16 * 40_000
    new WaterPublisher(b).publish([0], cols)
    expect(new Int16Array(b.flux)[2 * 1024]).toBe(32767)
  })

  it('merges sorted tile lists without duplicates', () => {
    expect(mergeTiles([1, 4, 9], [0, 4, 10])).toEqual([0, 1, 4, 9, 10])
    expect(mergeTiles([], [])).toEqual([])
  })

  it('publishes from the Simulation: every tile after generation, twice, then an edit\'s tiles, and nothing once quiet', () => {
    const buffers = createWorldBuffers([32, 32, 32])
    const sim = new Simulation({ buffers, blocks: WATER_BLOCKS, seed: 1, log: () => {} })
    sim.generate(fillGenerator(lake(4)))
    const t1 = sim.step().water!
    expect(t1.tiles).toEqual([0, 1, 2, 3])
    const surface = new Int32Array(buffers.water.surface)
    expect(surface[t1.parity * 1024 + 5 + 5 * 32]).toBe(5 * SUB)
    expect(surface[t1.parity * 1024 + 20 + 20 * 32]).toBe(~SUB)
    expect(sim.step().water!.tiles).toEqual([0, 1, 2, 3]) // once more, so the other parity is complete too
    expect(sim.step().water).toBeNull()
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 7, 5], voxel: w(7) })
    expect(sim.step().water!.tiles).toContain(0)
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/engine && npx vitest run test/waterPublish.test.ts`
Expected: FAIL with "Cannot find module '../src/sim/water/publish.ts'".

- [ ] **Step 3: Create `packages/engine/src/sim/water/publish.ts`**

```ts
import type { WaterBuffers } from '../../world/waterBuffers.ts'
import { moved, type WaterColumns } from './columns.ts'
import { SUB, TILE } from './constants.ts'

/** One publish (plan design notes: Publishing): its sequence number, the parity buffer it wrote, and the tiles in it. */
export interface WaterTick { seq: number; parity: number; tiles: number[] }

function clamp16(v: number): number { return v > 32767 ? 32767 : v < -32768 ? -32768 : v }

/** The sorted union of two sorted tile lists. */
export function mergeTiles(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = []
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    const v = j >= b.length || (i < a.length && a[i]! < b[j]!) ? a[i++]! : b[j++]!
    if (out.length === 0 || out[out.length - 1] !== v) out.push(v)
  }
  return out
}

/**
 * Writes the heightfield into the shared double buffer. Publish n writes into parity n & 1 the tiles that changed since the
 * last publish plus that publish's tiles, so each parity buffer is complete as of its last publish. The stamp brackets the
 * write (−1 while writing), so a reader can tell a buffer that was reused under it.
 */
export class WaterPublisher {
  private readonly surface: Int32Array
  private readonly flux: Int16Array
  private readonly stamp: Int32Array
  private seq = 0
  private last: number[] = []

  constructor(b: WaterBuffers) {
    this.surface = new Int32Array(b.surface)
    this.flux = new Int16Array(b.flux)
    this.stamp = new Int32Array(b.stamp)
  }

  /** Publishes `changed` (sorted tile indices) plus the previous publish's tiles; null when both are empty. */
  publish(changed: readonly number[], cols: WaterColumns): WaterTick | null {
    const tiles = mergeTiles(changed, this.last)
    this.last = [...changed]
    if (tiles.length === 0) return null
    const seq = ++this.seq, p = seq & 1, base = p * cols.n, T = cols.tiles, sx = cols.sx
    Atomics.store(this.stamp, p, -1)
    for (const t of tiles) {
      const x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) {
        const c = x + z * sx, d = cols.depth[c]!, s = cols.floor[c]! * SUB + d
        this.surface[base + c] = d > 0 ? s : ~s
        this.flux[2 * (base + c)] = clamp16(moved(cols.flux[2 * c]!))
        this.flux[2 * (base + c) + 1] = clamp16(moved(cols.flux[2 * c + 1]!))
      }
    }
    Atomics.store(this.stamp, p, seq)
    return { seq, parity: p, tiles }
  }
}
```

- [ ] **Step 4: Publish from the water system and carry it in the tick**

In `packages/engine/src/sim/water/waterSystem.ts`:
1. Add `import { WaterPublisher, type WaterTick } from './publish.ts'`.
2. Add the fields:
   ```ts
     /** The last flush's publish, or null when nothing changed: the tick message carries it to the main thread. */
     published: WaterTick | null = null
     private readonly publisher: WaterPublisher
   ```
3. In the constructor, after `this.mirror = …`, add `this.publisher = new WaterPublisher(port.buffers)`.
4. In `flush()`, add `this.published = null` as its first statement. Replace its final `return out` with:
   ```ts
       this.published = this.publisher.publish(out, cols)
       return out
   ```

In `packages/engine/src/sim/simulation.ts`:
1. Add `import type { WaterTick } from './water/publish.ts'`.
2. Add to `TickResult`:
   ```ts
     /** The heightfield tiles published this tick (null: none changed); the main thread reads them from shared memory. */
     water: WaterTick | null
   ```
3. Change the `return` at the end of `step()` to `return { tick: t, dirtyChunks, events, acks, falling: this.gravity.snapshot(), landed, physics, water: this.water.published }`.

In `packages/engine/src/protocol.ts`:
1. Add `import type { WaterTick } from './sim/water/publish.ts'`.
2. In the `FromSim` `'tick'` member, add `water: WaterTick | null;` after `physics: {…};`.

- [ ] **Step 5: Run the tests**

Run: `cd packages/engine && npx vitest run test/waterPublish.test.ts test/simHost.test.ts test/waterWorld.test.ts`
Expected: PASS.

Run: `npm run typecheck`.
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/sim/water/publish.ts packages/engine/src/sim/water/waterSystem.ts packages/engine/src/sim/simulation.ts packages/engine/src/protocol.ts packages/engine/test/waterPublish.test.ts
git commit -m "feat(sim): publish the heightfield to a stamped shared double buffer every tick"
```

---

### Task 9: The main thread's view: corners, flow, light and curtains

**Files:**
- Create: `packages/engine/src/render/water/surfaceMesh.ts`, `packages/engine/src/render/water/surfaceView.ts`
- Test: `packages/engine/test/surfaceView.test.ts`

**Interfaces:**
- Consumes: `WaterTick`, `mergeTiles` (Task 8); `WaterBuffers`, `SUB` (Task 1); `TILE` (Task 2).
- Produces:
  - From `surfaceMesh.ts`:
    - constants `JOIN`, `SHOW_MIN`, `SINK`, `FLOW_STILL`, `FLOW_STEEP`, `CORNER_X`, `CORNER_Z`, `DIR_X`, `DIR_Z`, `CURTAIN_TOP`, `CURTAIN_BOTTOM`;
    - functions `level(v)`, `shows(v, floor)`, `cornerHeights(s, floor, sx, sz, x, z, out, o): boolean`, `curtainAt(s, floor, c, j): boolean`, `quantizeFlow(vx, vz, out, o): number`.
  - From `surfaceView.ts`:
    - `class Curtains { count; prev; cur; info; generation; reserve(n) }`;
    - `class ColumnData { hPrev; hCur; info; rowLo; rowHi; curtains; mark(lz) }`;
    - `class SurfaceView`, constructor `(size: WorldSize, b: WaterBuffers, light: (x, y, z) => number, stepHz = 20)`:
      - fields `sx`, `sz`, `n`, `cx`, `cz`, `prev`, `cur`, `fluxX`, `fluxZ`;
      - methods `apply(t: WaterTick): boolean`, `column(cc): ColumnData | undefined`, `takeDirty(): number[]`.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/test/surfaceView.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SINK, quantizeFlow } from '../src/render/water/surfaceMesh.ts'
import { SurfaceView } from '../src/render/water/surfaceView.ts'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { WaterPublisher } from '../src/sim/water/publish.ts'
import { createWaterBuffers } from '../src/world/waterBuffers.ts'

/** Packed voxel light for every column: sky 15, block 0. */
const SKY15 = 15
const LIT = 15 * 16 // info.w for that light and no white water

/** A heightfield, its publisher and a view. `publish(tiles?)` publishes (every tile by default) and applies the tick. */
function scene(sx: number, sz: number, floor: (x: number, z: number) => number, depth: (x: number, z: number) => number) {
  const b = createWaterBuffers([sx, 32, sz])
  const cols = new WaterColumns(sx, sz, new Int16Array(b.floor))
  const set = (f: (x: number, z: number) => number, d: (x: number, z: number) => number) => {
    for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) { cols.floor[x + z * sx] = f(x, z); cols.depth[x + z * sx] = d(x, z) }
  }
  set(floor, depth)
  const pub = new WaterPublisher(b)
  const view = new SurfaceView([sx, 32, sz], b, () => SKY15)
  const all = Array.from({ length: cols.tiles.count }, (_, t) => t)
  const publish = (tiles: number[] = all) => view.apply(pub.publish(tiles, cols)!)
  return { cols, pub, view, publish, set }
}

function at(view: SurfaceView, x: number, z: number, field: 'hCur' | 'hPrev' | 'info'): number[] {
  const d = view.column((x >> 5) + (z >> 5) * view.cx)!
  const o = ((x & 31) + (z & 31) * 32) * 4
  return [...d[field].subarray(o, o + 4)]
}

describe('SurfaceView', () => {
  it('draws a lake as a plane at its surface, leaving out the ground far below its edge', () => {
    const { view, publish } = scene(32, 32, () => 2, (x, z) => (x >= 4 && x <= 27 && z >= 4 && z <= 27 ? 3 * SUB : 0))
    expect(publish()).toBe(true)
    expect(at(view, 10, 10, 'hCur')).toEqual([5, 5, 5, 5])
    expect(at(view, 4, 10, 'hCur')).toEqual([5, 5, 5, 5])
    expect(at(view, 10, 10, 'info')).toEqual([0, 0, 3, LIT])
  })

  it('allocates nothing for a chunk column without water, and hides dry columns', () => {
    const { view, publish } = scene(64, 32, () => 2, (x, z) => (x < 20 && z < 20 ? SUB : 0))
    publish()
    expect(view.column(1)).toBeUndefined()
    expect(at(view, 25, 25, 'info')[3]).toBe(-1)
  })

  it('thins a film\'s edge toward lower dry ground within a block', () => {
    const { view, publish } = scene(32, 32, () => 2, (x) => (x <= 10 ? SUB / 4 : 0))
    publish()
    expect(at(view, 10, 5, 'hCur')).toEqual([2.25, 2.125, 2.125, 2.25])
  })

  it('leaves higher ground (a wall) out of the corners', () => {
    const { view, publish } = scene(32, 32, (x) => (x <= 10 ? 2 : 10), (x) => (x <= 10 ? 2 * SUB : 0))
    publish()
    expect(at(view, 10, 5, 'hCur')).toEqual([4, 4, 4, 4])
  })

  it('hangs a curtain from a ledge down to the water below, with the edge\'s flux, and white water at its foot', () => {
    const s = scene(32, 32, (x) => (x <= 10 ? 6 : 2), () => SUB)
    for (let z = 0; z < 32; z++) s.cols.flux[2 * (10 + z * 32)] = 16 * 20 // 20 sub per step over the ledge
    s.publish()
    const cs = s.view.column(0)!.curtains
    expect(cs.count).toBe(32)
    const k = [...Array(cs.count).keys()].find((i) => cs.info[i * 4] === 10 && cs.info[i * 4 + 1] === 5)!
    expect([...cs.cur.subarray(k * 4, k * 4 + 4)]).toEqual([7, 7, 3, 3])
    expect([...cs.prev.subarray(k * 4, k * 4 + 4)]).toEqual([7, 7, 3, 3])
    expect([...cs.info.subarray(k * 4, k * 4 + 4)]).toEqual([10, 5, 0 + 4 * LIT, 20])
    expect(at(s.view, 11, 5, 'info')[3]).toBe(LIT + 256) // white water 1 = 20 >> 4
  })

  it('matches corners across a chunk-column border', () => {
    const { view, publish } = scene(64, 32, () => 2, (x) => (x >= 20 && x <= 45 ? 2 * SUB : 0))
    publish()
    expect(at(view, 31, 10, 'hCur')[1]).toBe(at(view, 32, 10, 'hCur')[0])
    expect(at(view, 31, 10, 'hCur')[1]).toBe(4)
  })

  it('raises a column that just got wet from its ground, and sinks one that dried while still drawing it', () => {
    const s = scene(32, 32, () => 2, () => 0)
    s.publish()
    s.set(() => 2, (x, z) => (x === 10 && z === 10 ? 2 * SUB : 0))
    s.publish([0])
    const ground = Math.fround(2 - SINK)
    expect(at(s.view, 10, 10, 'hPrev')).toEqual([ground, ground, ground, ground])
    expect(at(s.view, 10, 10, 'hCur')).toEqual([4, 4, 4, 4])
    s.set(() => 2, () => 0)
    s.publish([0])
    expect(at(s.view, 10, 10, 'hPrev')).toEqual([4, 4, 4, 4])
    expect(at(s.view, 10, 10, 'hCur')).toEqual([ground, ground, ground, ground])
    expect(at(s.view, 10, 10, 'info')[3]).toBeGreaterThanOrEqual(0)
  })

  it('keeps the tiles of a tick whose buffer was reused, and reads them from the next tick\'s complete buffer', () => {
    const s = scene(32, 32, () => 2, () => SUB)
    const t1 = s.pub.publish([0], s.cols)!
    s.cols.depth[20 + 5 * 32] = 3 * SUB // tile 1 changes
    s.pub.publish([1], s.cols)
    s.cols.depth[5 + 20 * 32] = 4 * SUB // tile 2 changes; publish 3 reuses publish 1's buffer
    const t3 = s.pub.publish([2], s.cols)!
    expect(s.view.apply(t1)).toBe(false)
    expect(s.view.apply(t3)).toBe(true) // tiles 0, 1 and 2, from publish 3's buffer
    expect(at(s.view, 5, 5, 'hCur')).toEqual([3, 3, 3, 3])
    expect(at(s.view, 20, 5, 'hCur')).toEqual([5, 5, 5, 5])
    expect(at(s.view, 5, 20, 'hCur')).toEqual([6, 6, 6, 6])
  })

  it('hands each changed chunk column to the renderer once', () => {
    const { view, publish } = scene(64, 32, () => 2, (x) => (x < 40 ? SUB : 0))
    publish()
    expect(view.takeDirty()).toEqual([0, 1])
    expect(view.takeDirty()).toEqual([])
  })
})

describe('quantizeFlow', () => {
  it('quantizes the ripple flow to 8 directions and still / gentle / steep', () => {
    const out = new Float32Array(2)
    expect(quantizeFlow(0.1, 0, out, 0)).toBeCloseTo(0.1)
    expect([...out]).toEqual([0, 0])
    quantizeFlow(2, 0, out, 0)
    expect([...out]).toEqual([2.5, 0])
    quantizeFlow(0.5, 0.5, out, 0)
    expect(out[0]).toBeCloseTo(Math.SQRT1_2)
    expect(out[1]).toBeCloseTo(Math.SQRT1_2)
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/engine && npx vitest run test/surfaceView.test.ts`
Expected: FAIL with "Cannot find module '../src/render/water/surfaceMesh.ts'".

- [ ] **Step 3: Create `packages/engine/src/render/water/surfaceMesh.ts`**

```ts
import { SUB } from '../../world/waterBuffers.ts'

/** Neighbours whose surfaces lie within this of each other share corners; a larger drop gets a curtain (spec §5: ~1 block). */
export const JOIN = SUB
/** Columns shallower than this (1/16 block, the mirror's threshold) are not drawn: thinner films would z-fight the ground. */
export const SHOW_MIN = 16
/** A column that is not drawn has its corners this far (blocks) under its ground, so a drying column sinks out of sight. */
export const SINK = 0.02
/** Below this speed (blocks per second) the ripples stand still… */
export const FLOW_STILL = 0.15
/** …below this they drift gently (1), above it steeply (2.5): 3a's two flow speeds. */
export const FLOW_STEEP = 1.5
/** Corner offsets, in the order (−x,−z) (+x,−z) (+x,+z) (−x,+z). */
export const CORNER_X: readonly number[] = [-1, 1, 1, -1]
export const CORNER_Z: readonly number[] = [-1, -1, 1, 1]
/** Curtain directions 0 +x, 1 −x, 2 +z, 3 −z: the neighbour's offset. */
export const DIR_X: readonly number[] = [1, -1, 0, 0]
export const DIR_Z: readonly number[] = [0, 0, 1, -1]
/** Per direction, the upper column's corners at the edge's ends A and B… */
export const CURTAIN_TOP: readonly (readonly [number, number])[] = [[1, 2], [3, 0], [2, 3], [0, 1]]
/** …and the lower neighbour's corners at the same ends. */
export const CURTAIN_BOTTOM: readonly (readonly [number, number])[] = [[0, 3], [2, 1], [1, 0], [3, 2]]

/** The level (1/SUB block) a published value stands for: a wet column's surface, a dry one's ground. */
export function level(v: number): number { return v >= 0 ? v : ~v }

/** Whether a column (published value v, floor `floor`) is drawn: wet and at least SHOW_MIN deep. */
export function shows(v: number, floor: number): boolean { return v >= 0 && v - floor * SUB >= SHOW_MIN }

/**
 * Corner heights (blocks) of column (x, z) of the published surfaces `s`, into out[o..o+3] (plan design notes: Rendering).
 * A drawn column's corner averages its surface with:
 * - the neighbours around that corner that are drawn within JOIN of it;
 * - the ground of neighbours that are not drawn but lie below it within JOIN (a film's edge thins to the ground).
 * Higher ground (walls) and drops beyond JOIN are left out. A column that is not drawn gets its ground minus SINK.
 * Returns whether the column is drawn.
 */
export function cornerHeights(s: Int32Array, floor: Int16Array, sx: number, sz: number, x: number, z: number, out: Float32Array, o: number): boolean {
  const c = x + z * sx, v = s[c]!
  if (!shows(v, floor[c]!)) {
    const g = level(v) / SUB - SINK
    out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = g
    return false
  }
  for (let k = 0; k < 4; k++) {
    const nx = x + CORNER_X[k]!, nz = z + CORNER_Z[k]!
    let sum = v, n = 1
    for (let m = 0; m < 3; m++) {
      const jx = m === 1 ? x : nx, jz = m === 0 ? z : nz
      if (jx < 0 || jz < 0 || jx >= sx || jz >= sz) continue
      const j = jx + jz * sx, w = s[j]!
      if (shows(w, floor[j]!)) {
        if (Math.abs(w - v) <= JOIN) { sum += w; n++ }
      } else {
        const g = level(w)
        if (g < v && v - g <= JOIN) { sum += g; n++ }
      }
    }
    out[o + k] = sum / n / SUB
  }
  return true
}

/** Whether edge c → j (j beside c) needs a curtain in `s`: c is drawn and stands more than JOIN above j's level. */
export function curtainAt(s: Int32Array, floor: Int16Array, c: number, j: number): boolean {
  return shows(s[c]!, floor[c]!) && s[c]! - level(s[j]!) > JOIN
}

/** Ripple flow for a column velocity (blocks per second) into out[o], out[o + 1]: 8 directions × still / 1 / 2.5. Returns the speed. */
export function quantizeFlow(vx: number, vz: number, out: Float32Array, o: number): number {
  const speed = Math.hypot(vx, vz)
  if (speed < FLOW_STILL) { out[o] = 0; out[o + 1] = 0; return speed }
  const dir = ((Math.round(Math.atan2(vz, vx) / (Math.PI / 4)) % 8) + 8) % 8
  const k = speed < FLOW_STEEP ? 1 : 2.5
  out[o] = Math.cos((dir * Math.PI) / 4) * k
  out[o + 1] = Math.sin((dir * Math.PI) / 4) * k
  return speed
}
```

Note: `Math.cos(0) * 2.5` is exactly 2.5 and `Math.sin(0)` is 0, so the `[2.5, 0]` expectation is exact.

- [ ] **Step 4: Create `packages/engine/src/render/water/surfaceView.ts`**

```ts
import { TILE } from '../../sim/water/constants.ts'
import { mergeTiles, type WaterTick } from '../../sim/water/publish.ts'
import type { WorldSize } from '../../world/layout.ts'
import { SUB, type WaterBuffers } from '../../world/waterBuffers.ts'
import {
  CURTAIN_BOTTOM, CURTAIN_TOP, DIR_X, DIR_Z, FLOW_STEEP, cornerHeights, curtainAt, level, quantizeFlow, shows,
} from './surfaceMesh.ts'

/**
 * The curtains of one chunk column, per curtain (4 floats each):
 * - `prev`, `cur`: (top A, top B, bottom A, bottom B) heights in blocks;
 * - `info`: (lx, lz, dir + 4 × light, flux).
 */
export class Curtains {
  count = 0
  prev = new Float32Array(64)
  cur = new Float32Array(64)
  info = new Float32Array(64)
  /** Bumped whenever the arrays are replaced: the renderer then rebuilds its attributes. */
  generation = 0

  reserve(n: number): void {
    if (n * 4 <= this.prev.length) return
    let cap = this.prev.length
    while (cap < n * 4) cap *= 2
    const grow = (a: Float32Array): Float32Array => { const b = new Float32Array(cap); b.set(a); return b }
    this.prev = grow(this.prev)
    this.cur = grow(this.cur)
    this.info = grow(this.info)
    this.generation++
  }
}

/** Instance data of one chunk column: 32 × 32 quads, instance lx + lz × 32, 4 floats each. */
export class ColumnData {
  /** Corner heights (blocks; corners (−x,−z) (+x,−z) (+x,+z) (−x,+z)) of the previous and the current step. */
  readonly hPrev = new Float32Array(4096)
  readonly hCur = new Float32Array(4096)
  /** Flow x, flow z, depth (blocks), packed light (sky × 16 + block + 256 × white water); a negative packed value hides the quad. */
  readonly info = new Float32Array(4096).fill(-1)
  /** Rows (lz) changed since the renderer last took this column; rowLo > rowHi when none. */
  rowLo = 32
  rowHi = -1
  readonly curtains = new Curtains()

  mark(lz: number): void {
    if (lz < this.rowLo) this.rowLo = lz
    if (lz > this.rowHi) this.rowHi = lz
  }
}

/**
 * The main thread's copy of the heightfield (spec §5 Data path): reads published tiles, keeps the previous and current step,
 * and turns them into per-column instance data and curtains. Pure: no three.js, Node-testable.
 */
export class SurfaceView {
  readonly sx: number
  readonly sz: number
  readonly n: number
  /** Chunk columns along x and z. */
  readonly cx: number
  readonly cz: number
  /** Encoded surfaces (WaterBuffers.surface) of the previous and the current step. */
  readonly prev: Int32Array
  readonly cur: Int32Array
  /** Water moved last step through each column's +x and +z edges (1/SUB block per step). */
  readonly fluxX: Int16Array
  readonly fluxZ: Int16Array
  private readonly surface: Int32Array
  private readonly flux: Int16Array
  private readonly stamp: Int32Array
  private readonly floor: Int16Array
  private readonly fenceWord = new Int32Array(new SharedArrayBuffer(4))
  private readonly tx: number
  private readonly seen: Uint8Array
  private pending: number[] = []
  private readonly data: (ColumnData | undefined)[]
  private readonly dirty = new Set<number>()
  private readonly light: (x: number, y: number, z: number) => number
  private readonly stepHz: number
  private scratchS = new Int32Array(0)
  private scratchF = new Int16Array(0)
  private readonly k = new Float32Array(16)

  /** `light(x, y, z)`: packed voxel light (sky | block << 4). `stepHz`: water steps per second (the tick rate). */
  constructor(size: WorldSize, b: WaterBuffers, light: (x: number, y: number, z: number) => number, stepHz = 20) {
    this.sx = size[0]
    this.sz = size[2]
    this.n = this.sx * this.sz
    this.cx = this.sx >> 5
    this.cz = this.sz >> 5
    this.prev = new Int32Array(this.n).fill(-1)
    this.cur = new Int32Array(this.n).fill(-1)
    this.fluxX = new Int16Array(this.n)
    this.fluxZ = new Int16Array(this.n)
    this.surface = new Int32Array(b.surface)
    this.flux = new Int16Array(b.flux)
    this.stamp = new Int32Array(b.stamp)
    this.floor = new Int16Array(b.floor)
    this.tx = this.sx / TILE
    this.seen = new Uint8Array(this.tx * (this.sz / TILE))
    this.data = new Array<ColumnData | undefined>(this.cx * this.cz)
    this.light = light
    this.stepHz = stepHz
  }

  column(cc: number): ColumnData | undefined { return this.data[cc] }

  /** Chunk columns whose data changed since the last call, in index order. */
  takeDirty(): number[] {
    const out = [...this.dirty].sort((a, b) => a - b)
    this.dirty.clear()
    return out
  }

  /**
   * Reads a tick's tiles (and any still pending) from shared memory. If the publish's buffer was reused before we got to it,
   * nothing is applied: the tiles wait for the next tick, whose buffer holds them complete. Returns whether it applied.
   */
  apply(t: WaterTick): boolean {
    const tiles = mergeTiles(t.tiles, this.pending)
    const p = t.parity
    if (Atomics.load(this.stamp, p) !== t.seq) { this.pending = tiles; return false }
    const per = TILE * TILE
    if (this.scratchS.length < tiles.length * per) {
      this.scratchS = new Int32Array(tiles.length * per * 2)
      this.scratchF = new Int16Array(tiles.length * per * 4)
    }
    const base = p * this.n
    let k = 0
    for (const tile of tiles) {
      const x0 = (tile % this.tx) * TILE, z0 = Math.floor(tile / this.tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) {
        const c = x + z * this.sx
        this.scratchS[k] = this.surface[base + c]!
        this.scratchF[2 * k] = this.flux[2 * (base + c)]!
        this.scratchF[2 * k + 1] = this.flux[2 * (base + c) + 1]!
        k++
      }
    }
    Atomics.add(this.fenceWord, 0, 0) // orders the copies before the validating load (see WorldReader.fence)
    if (Atomics.load(this.stamp, p) !== t.seq) { this.pending = tiles; return false }
    this.pending = []
    k = 0
    for (const tile of tiles) {
      const first = this.seen[tile] === 0
      this.seen[tile] = 1
      const x0 = (tile % this.tx) * TILE, z0 = Math.floor(tile / this.tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) {
        const c = x + z * this.sx, v = this.scratchS[k]!
        this.prev[c] = first ? v : this.cur[c]!
        this.cur[c] = v
        this.fluxX[c] = this.scratchF[2 * k]!
        this.fluxZ[c] = this.scratchF[2 * k + 1]!
        k++
      }
    }
    for (const tile of tiles) this.refreshTile(tile)
    for (const cc of this.dirty) {
      const d = this.data[cc]
      if (d) this.buildCurtains(cc, d)
    }
    return true
  }

  /** Recomputes the tile's columns and the one-column ring around it (their corners see the tile). */
  private refreshTile(tile: number): void {
    const x0 = (tile % this.tx) * TILE, z0 = Math.floor(tile / this.tx) * TILE
    const xa = Math.max(0, x0 - 1), xb = Math.min(this.sx, x0 + TILE + 1)
    const za = Math.max(0, z0 - 1), zb = Math.min(this.sz, z0 + TILE + 1)
    for (let z = za; z < zb; z++) for (let x = xa; x < xb; x++) this.refreshColumn(x, z)
  }

  private refreshColumn(x: number, z: number): void {
    const sx = this.sx, c = x + z * sx, cc = (x >> 5) + (z >> 5) * this.cx
    const fl = this.floor[c]!, pv = this.prev[c]!, cv = this.cur[c]!
    const drawn = shows(pv, fl) || shows(cv, fl)
    let d = this.data[cc]
    if (!d) {
      if (!drawn) return
      d = new ColumnData()
      this.data[cc] = d
    }
    const lz = z & 31, o = ((x & 31) + lz * 32) * 4
    d.mark(lz)
    this.dirty.add(cc)
    if (!drawn) { d.info[o + 3] = -1; return }
    cornerHeights(this.prev, this.floor, sx, this.sz, x, z, d.hPrev, o)
    cornerHeights(this.cur, this.floor, sx, this.sz, x, z, d.hCur, o)
    const s = level(cv), depth = Math.max(0, s - fl * SUB)
    const west = x > 0 ? this.fluxX[c - 1]! : 0, east = this.fluxX[c]!
    const north = z > 0 ? this.fluxZ[c - sx]! : 0, south = this.fluxZ[c]!
    // Velocity (blocks per second) = flux through a 1-block edge / depth, × steps per second.
    const h = Math.max(depth, SUB / 8)
    const speed = quantizeFlow((((west + east) / 2) / h) * this.stepHz, (((north + south) / 2) / h) * this.stepHz, d.info, o)
    let white = Math.max(0, Math.min(15, Math.round((speed - FLOW_STEEP) * 4)))
    if (x > 0) white = Math.max(white, this.foot(c - 1, c, west))
    if (x + 1 < sx) white = Math.max(white, this.foot(c + 1, c, -east))
    if (z > 0) white = Math.max(white, this.foot(c - sx, c, north))
    if (z + 1 < this.sz) white = Math.max(white, this.foot(c + sx, c, -south))
    const l = this.light(x, Math.ceil(s / SUB), z)
    d.info[o + 2] = depth / SUB
    d.info[o + 3] = (l & 15) * 16 + (l >> 4) + 256 * white
  }

  /** White water (0–15) at the foot of a curtain from column j into c carrying `into` (1/SUB block per step toward c). */
  private foot(j: number, c: number, into: number): number {
    if (into <= 0 || !curtainAt(this.cur, this.floor, j, c)) return 0
    return Math.min(15, into >> 4)
  }

  private buildCurtains(cc: number, d: ColumnData): void {
    const cs = d.curtains, sx = this.sx, sz = this.sz, k = this.k
    const x0 = (cc % this.cx) * 32, z0 = Math.floor(cc / this.cx) * 32
    let n = 0
    for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
      const packed = d.info[(lx + lz * 32) * 4 + 3]!
      if (packed < 0) continue // not drawn in either step: nothing hangs from it
      const x = x0 + lx, z = z0 + lz, c = x + z * sx
      for (let dir = 0; dir < 4; dir++) {
        const jx = x + DIR_X[dir]!, jz = z + DIR_Z[dir]!
        if (jx < 0 || jz < 0 || jx >= sx || jz >= sz) continue
        const j = jx + jz * sx
        const was = curtainAt(this.prev, this.floor, c, j), now = curtainAt(this.cur, this.floor, c, j)
        if (!was && !now) continue
        cornerHeights(this.prev, this.floor, sx, sz, x, z, k, 0)
        cornerHeights(this.cur, this.floor, sx, sz, x, z, k, 4)
        const jp = cornerHeights(this.prev, this.floor, sx, sz, jx, jz, k, 8)
        const jc = cornerHeights(this.cur, this.floor, sx, sz, jx, jz, k, 12)
        const [ta, tb] = CURTAIN_TOP[dir]!, [ba, bb] = CURTAIN_BOTTOM[dir]!
        const gp = level(this.prev[j]!) / SUB, gc = level(this.cur[j]!) / SUB
        cs.reserve(n + 1)
        const o = n * 4
        edge(cs.prev, o, was, k[ta]!, k[tb]!, jp ? k[8 + ba]! : gp, jp ? k[8 + bb]! : gp)
        edge(cs.cur, o, now, k[4 + ta]!, k[4 + tb]!, jc ? k[12 + ba]! : gc, jc ? k[12 + bb]! : gc)
        cs.info[o] = lx
        cs.info[o + 1] = lz
        cs.info[o + 2] = dir + 4 * (packed % 256)
        cs.info[o + 3] = Math.max(0, this.edgeFlux(c, dir))
        n++
      }
    }
    cs.count = n
  }

  /** Water leaving column c through its side `dir` (1/SUB block per step; negative: coming in). */
  private edgeFlux(c: number, dir: number): number {
    switch (dir) {
      case 0: return this.fluxX[c]!
      case 1: return -this.fluxX[c - 1]!
      case 2: return this.fluxZ[c]!
      default: return -this.fluxZ[c - this.sx]!
    }
  }
}

/** A curtain's (top A, top B, bottom A, bottom B); one absent in this step is rolled up to its top. */
function edge(out: Float32Array, o: number, on: boolean, ta: number, tb: number, ba: number, bb: number): void {
  out[o] = ta
  out[o + 1] = tb
  out[o + 2] = on ? ba : ta
  out[o + 3] = on ? bb : tb
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd packages/engine && npx vitest run test/surfaceView.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/render/water/surfaceMesh.ts packages/engine/src/render/water/surfaceView.ts packages/engine/test/surfaceView.test.ts
git commit -m "feat(render): main-thread water view: interpolation pairs, corners, flow, white water and curtains"
```

---

### Task 10: Drawing the heightfield

**Files:**
- Create:
  - `packages/engine/src/render/water/waterVertex.ts`
  - `packages/engine/src/render/water/waterSurface.ts`
  - `packages/engine/test/waterSurface.test.ts`
  - `apps/sandbox/e2e/water-render.spec.ts`
- Modify:
  - `packages/engine/src/render/water.ts` (rewritten in full)
  - `packages/engine/src/render/visuals.ts`
  - `packages/engine/src/engine.ts`

**Interfaces:**
- Consumes: `SurfaceView`, `ColumnData`, `Curtains` (Task 9); `chunkVertex` (`render/chunkVertex.ts`); `VoxelNodeMaterial`, `voxelLit`, `LightUniforms`, `createLightUniforms` (`render/voxelLighting.ts`).
- Produces:
  - `waterAlpha` (a TSL uniform).
  - `interface WaterVertex`, `surfaceVertex()`, `curtainVertex()`, `voxelWaterVertex()`.
  - `WaterMaterial`: `.voxel`, `.surface`, `.curtain`, `.plainSurface`, `.plainCurtain` (`.material` is gone).
  - `class WaterSurface`:
    - constructor `(height, view, surface, curtain)`;
    - `group` (named `'elovox-water'`; meshes `water-<cc>` and `water-<cc>-curtains`);
    - `meshCount`, `setMaterials(surface, curtain)`, `update()`, `dispose()`.
  - `VisualsOptions.water: SurfaceView` and `Visuals.setWaterAlpha(a)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/test/waterSurface.test.ts`:

```ts
import * as THREE from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { WaterMaterial } from '../src/render/water.ts'
import { SurfaceView } from '../src/render/water/surfaceView.ts'
import { WaterSurface } from '../src/render/water/waterSurface.ts'
import { createLightUniforms } from '../src/render/voxelLighting.ts'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { WaterPublisher } from '../src/sim/water/publish.ts'
import { createWaterBuffers } from '../src/world/waterBuffers.ts'

function published(sx: number, sz: number, floor: (x: number) => number, depth: (x: number) => number): SurfaceView {
  const b = createWaterBuffers([sx, 32, sz])
  const cols = new WaterColumns(sx, sz, new Int16Array(b.floor))
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) { cols.floor[x + z * sx] = floor(x); cols.depth[x + z * sx] = depth(x) }
  const view = new SurfaceView([sx, 32, sz], b, () => 15)
  view.apply(new WaterPublisher(b).publish(Array.from({ length: cols.tiles.count }, (_, t) => t), cols)!)
  return view
}
const mat = () => new THREE.MeshBasicMaterial()

describe('WaterSurface', () => {
  it('builds one instanced surface per chunk column with water, wired to the view\'s arrays with a row range', () => {
    const view = published(64, 32, () => 2, (x) => (x < 20 ? SUB : 0))
    const ws = new WaterSurface(32, view, mat(), mat())
    ws.update()
    expect(ws.meshCount).toBe(1)
    const mesh = ws.group.getObjectByName('water-0') as THREE.Mesh
    const geo = mesh.geometry as THREE.InstancedBufferGeometry
    expect(geo.instanceCount).toBe(1024)
    expect(geo.getAttribute('hCur').array).toBe(view.column(0)!.hCur)
    expect(geo.getAttribute('info').array).toBe(view.column(0)!.info)
    expect(mesh.position.toArray()).toEqual([0, 0, 0])
    expect(mesh.renderOrder).toBe(1)
    expect((geo.getAttribute('hCur') as THREE.BufferAttribute).updateRanges).toEqual([{ start: 0, count: 32 * 32 * 4 }])
  })

  it('sizes the curtain instances to the view\'s curtain list', () => {
    const view = published(32, 32, (x) => (x <= 10 ? 6 : 2), () => SUB)
    const ws = new WaterSurface(32, view, mat(), mat())
    ws.update()
    const curtains = ws.group.getObjectByName('water-0-curtains') as THREE.Mesh
    expect((curtains.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(32)
    expect(curtains.visible).toBe(true)
  })

  it('swaps the materials of every mesh', () => {
    const view = published(32, 32, () => 2, () => SUB)
    const ws = new WaterSurface(32, view, mat(), mat())
    ws.update()
    const a = mat(), b = mat()
    ws.setMaterials(a, b)
    expect((ws.group.getObjectByName('water-0') as THREE.Mesh).material).toBe(a)
    expect((ws.group.getObjectByName('water-0-curtains') as THREE.Mesh).material).toBe(b)
  })
})

describe('WaterMaterial', () => {
  it('builds the voxel, surface and curtain materials, stylised and plain', () => {
    const m = new WaterMaterial(createLightUniforms(), true)
    expect(m.curtain.side).toBe(THREE.DoubleSide)
    expect(m.plainCurtain.side).toBe(THREE.DoubleSide)
    expect(m.surface.transparent).toBe(true)
    expect(m.voxel.depthWrite).toBe(false)
    m.dispose()
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/engine && npx vitest run test/waterSurface.test.ts`
Expected: FAIL with "Cannot find module '../src/render/water/waterSurface.ts'".

- [ ] **Step 3: Create `packages/engine/src/render/water/waterVertex.ts`**

```ts
import { attribute, bool, float, instanceIndex, mix, normalize, select, smoothstep, uniform, varying, vec2, vec3 } from 'three/tsl'
import { chunkVertex } from '../chunkVertex.ts'

/** Loose TSL node type (see voxelLighting.ts). */
type N = any

/** How far the heightfield has moved from the previous water step to the current one (0–1); the engine sets it every frame. */
export const waterAlpha = uniform(1)

/** What the water shading reads, whatever draws the water: static voxel cells, the heightfield surface or a curtain. */
export interface WaterVertex {
  /** The local position (the material's positionNode). */
  position: N
  /** World-space normal. */
  normal: N
  /** True for a surface (ripples); false for a side or a curtain (falling streaks). */
  isTop: N
  sky: N
  blk: N
  /** Ripple flow: direction x, z and speed (0 still, 1 gentle, 2.5 steep). */
  flow: N
  /** 0–1: how much shore foam the water may get (thin films get little). */
  surface: N
  /** 0–1: white water. */
  white: N
  /** Streak speed factor on sides and curtains. */
  fall: N
  /** Opacity factor. */
  alpha: N
}

/** Component k (0–3) of a vec4. */
function pick4(v: N, k: N): N {
  return select(k.lessThan(0.5), v.x, select(k.lessThan(1.5), v.y, select(k.lessThan(2.5), v.z, v.w)))
}

/**
 * Light packed as sky × 16 + block (+ 256 × white), decoded in the vertex stage. Decoding in the fragment stage would floor
 * an interpolated value and flip the nibbles (see falling.ts).
 */
function unpack(packed: N): { sky: N; blk: N; white: N } {
  const p = packed.max(0)
  const white = p.div(256).floor()
  const rest = p.sub(white.mul(256))
  return { sky: varying(rest.div(16).floor().div(15)), blk: varying(rest.mod(16).div(15)), white: varying(white.div(15)) }
}

/** Static voxel water: the chunk liquid layer's packed vertex. */
export function voxelWaterVertex(): WaterVertex {
  const v = chunkVertex(undefined, true)
  return {
    position: v.position, normal: v.normal, isTop: v.normal.y.greaterThan(0.5), sky: v.sky, blk: v.blk,
    flow: v.flow, surface: v.surface, white: float(0), fall: float(1).add(v.flow.z.mul(2)), alpha: float(1),
  }
}

/**
 * The heightfield surface: one instanced quad per column of a chunk column (WaterSurface), instance lx + lz × 32. The base
 * quad's `corner` attribute (0–3: (−x,−z) (+x,−z) (+x,+z) (−x,+z)) picks the corner of `hPrev`/`hCur`, mixed by waterAlpha.
 * A negative info.w collapses the quad to a line (nothing drawn).
 */
export function surfaceVertex(): WaterVertex {
  const corner = attribute('corner', 'float')
  const hp = attribute('hPrev', 'vec4'), hc = attribute('hCur', 'vec4'), info = attribute('info', 'vec4')
  const h = mix(hp, hc, waterAlpha)
  const i = instanceIndex.toFloat()
  const lz = i.div(32).floor(), lx = i.sub(lz.mul(32))
  const shown = select(info.w.lessThan(0), float(0), float(1))
  const ox = select(corner.greaterThan(0.5).and(corner.lessThan(2.5)), float(1), float(0)).mul(shown)
  const oz = select(corner.greaterThan(1.5), float(1), float(0)).mul(shown)
  // The quad's plane from its four corners: rise along x and along z.
  const dx = h.y.add(h.z).sub(h.x).sub(h.w).mul(0.5)
  const dz = h.z.add(h.w).sub(h.x).sub(h.y).mul(0.5)
  const { sky, blk, white } = unpack(info.w)
  const speed = vec2(info.x, info.y).length()
  const dir = vec2(info.x, info.y).div(speed.max(0.001))
  return {
    position: vec3(lx.add(ox), pick4(h, corner), lz.add(oz)),
    normal: varying(normalize(vec3(dx.negate(), float(1), dz.negate()))),
    isTop: bool(true),
    sky, blk, white,
    flow: varying(vec3(dir.x, dir.y, speed)),
    surface: varying(smoothstep(0.05, 0.35, info.z)),
    fall: float(1),
    alpha: float(1),
  }
}

/**
 * A waterfall curtain (WaterSurface): one instanced quad per curtain.
 * - The base quad's `corner` (0 top A, 1 top B, 2 bottom B, 3 bottom A) picks a height from cPrev/cCur (top A, top B, bottom A, bottom B).
 * - cInfo is (lx, lz, dir + 4 × light, flux).
 * - The edge's ends A and B sit on the upper column's side `dir` (0 +x, 1 −x, 2 +z, 3 −z).
 */
export function curtainVertex(): WaterVertex {
  const corner = attribute('corner', 'float')
  const cp = attribute('cPrev', 'vec4'), cc = attribute('cCur', 'vec4'), info = attribute('cInfo', 'vec4')
  const h = mix(cp, cc, waterAlpha)
  const dir = info.z.mod(4)
  const light = info.z.div(4).floor()
  const isB = corner.greaterThan(0.5).and(corner.lessThan(2.5))
  const top = corner.lessThan(1.5)
  const d0 = dir.lessThan(0.5), d1 = dir.lessThan(1.5), d2 = dir.lessThan(2.5)
  const one = float(1), zero = float(0)
  const ax = select(d0, one, select(d1, zero, select(d2, one, zero)))
  const az = select(d0, zero, select(d1, one, select(d2, one, zero)))
  const bx = select(d0, one, select(d1, zero, select(d2, zero, one)))
  const bz = select(d0, one, select(d1, zero, select(d2, one, zero)))
  const y = select(top, select(isB, h.y, h.x), select(isB, h.w, h.z))
  const normal = select(d0, vec3(1, 0, 0), select(d1, vec3(-1, 0, 0), select(d2, vec3(0, 0, 1), vec3(0, 0, -1))))
  const { sky, blk } = unpack(light)
  const flux = info.w
  return {
    position: vec3(info.x.add(select(isB, bx, ax)), y, info.y.add(select(isB, bz, az))),
    normal: varying(normal),
    isTop: bool(false),
    sky, blk,
    flow: vec3(0, 0, 0),
    surface: float(1),
    white: varying(smoothstep(8, 64, flux).mul(0.6)),
    fall: varying(float(1).add(flux.div(32).min(3))),
    alpha: varying(mix(float(0.45), float(1), smoothstep(0, 24, flux))),
  }
}
```

- [ ] **Step 4: Rewrite `packages/engine/src/render/water.ts`**

The new file shares one shading between the three vertex sources. The graph is 3a's, plus white water, an opacity factor, and ripples that tilt with the surface:

```ts
import * as THREE from 'three/webgpu'
import {
  abs, cameraFar, cameraNear, cameraPosition, dot, float, fract, max, mix, mx_noise_float, normalize, perspectiveDepthToViewZ,
  positionView, positionWorld, select, smoothstep, step, time, uniform, vec2, vec3, vec4, viewportDepthTexture,
} from 'three/tsl'
import { sunDirection, sunVisibility, type Atmosphere } from './atmosphere.ts'
import { setLinear } from './lighting.ts'
import type { WaterParams } from './settings.ts'
import { VoxelNodeMaterial, voxelLit, type LightUniforms } from './voxelLighting.ts'
import { curtainVertex, surfaceVertex, voxelWaterVertex, type WaterVertex } from './water/waterVertex.ts'

type N = ReturnType<typeof float>
type V2 = THREE.Node<'vec2'>
const EPS = 0.08
const RIPPLE = 0.15
/** Blocks per second the ripples travel along the flow at speed 1. */
const FLOW_SPEED = 1.2
/** How far (blocks) a flow ripple sample drifts before it fades out and restarts: the drift never exceeds it. */
const FLOW_PERIOD = 1.5

function createUniforms() {
  return {
    shallow: uniform(new THREE.Color()),
    deep: uniform(new THREE.Color()),
    depthScale: uniform(3),
    foamWidth: uniform(0.5),
    waveScale: uniform(0.35),
    waveSpeed: uniform(0.6),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
    sunColor: uniform(new THREE.Color()),
    /** sunVisibility(elevation) × min(intensity, 1): no glint once the sun has set. */
    sunVis: uniform(1),
    horizon: uniform(new THREE.Color()),
  }
}
type WaterUniforms = ReturnType<typeof createUniforms>

/** Ripples, depth colour, shore foam, white water, sun glint and sky fresnel, for any water vertex source. */
function shade(m: VoxelNodeMaterial, v: WaterVertex, u: WaterUniforms, lights: LightUniforms, depthEffects: boolean): void {
  m.positionNode = v.position
  m.transparent = true
  m.depthWrite = false
  const wp = positionWorld
  const speed = time.mul(u.waveSpeed)
  const h = (p: V2) => mx_noise_float(vec3(p.mul(u.waveScale).add(vec2(speed, speed.mul(0.6))), time.mul(0.25)))
    .add(mx_noise_float(vec3(p.mul(u.waveScale.mul(2.3)).sub(vec2(speed.mul(0.7), 0)), time.mul(0.4))).mul(0.5))
  // Flow map with two phases: two ripple samples drift along the flow, half a period apart, by at most FLOW_PERIOD
  // blocks, and each fades out (triangle weight) as it wraps back. Still water (flow 0) has no drift.
  const phase = fract(time.mul(v.flow.z).mul(FLOW_SPEED / FLOW_PERIOD))
  const dir = vec2(v.flow.x, v.flow.y).mul(FLOW_PERIOD)
  const slope = (q: V2) => {
    const h0 = h(q)
    return vec2(h0.sub(h(q.add(vec2(EPS, 0)))), h0.sub(h(q.add(vec2(0, EPS)))))
  }
  const g = mix(slope(wp.xz.sub(dir.mul(phase))), slope(wp.xz.sub(dir.mul(fract(phase.add(0.5))))), abs(phase.mul(2).sub(1)))
  const ripple = normalize(vec3(g.x.mul(RIPPLE / EPS), 1, g.y.mul(RIPPLE / EPS)))
  // Ripples ride on the surface's own tilt (a river ramp); on flat water v.normal is straight up and this is the ripple.
  const n = select(v.isTop, normalize(ripple.add(v.normal).sub(vec3(0, 1, 0))), v.normal)

  const thickness = depthEffects
    ? positionView.z.sub(perspectiveDepthToViewZ(viewportDepthTexture(), cameraNear, cameraFar)).max(0)
    : float(2)
  const depthT = float(1).sub(thickness.div(u.depthScale).negate().exp())
  const drift = time.mul(0.35)
  const foamNoise = mx_noise_float(vec3(wp.xz.mul(1.6).add(vec2(drift, drift.mul(0.5))), time.mul(0.3)))
    .add(mx_noise_float(vec3(wp.xz.mul(3.1).sub(vec2(drift.mul(0.6), drift.mul(1.2))), time.mul(0.45))))
    .mul(0.25).add(0.5)
  const fw = max(u.foamWidth, 1e-3)
  const band = float(1).sub(smoothstep(0, max(u.foamWidth.mul(foamNoise.mul(0.8).add(0.6)), 1e-3), thickness))
  const lap = smoothstep(0.75, 1.0, fract(thickness.div(fw.mul(1.6)).add(time.mul(0.35)).add(foamNoise.mul(0.3))))
    .mul(float(1).sub(smoothstep(0, fw.mul(3), thickness)))
  const foam = depthEffects ? max(band, lap.mul(0.7)).mul(step(1e-4, u.foamWidth)).mul(smoothstep(0.2, 0.6, v.surface)) : float(0)
  // White water breaks up with the same noise as the foam, so fast water churns rather than turning flat white.
  const white = max(foam, v.white.mul(foamNoise.mul(0.6).add(0.55)).min(1))
  const streak = select(v.isTop, float(0), mx_noise_float(vec3(wp.x.add(wp.z).mul(0.9), wp.y.mul(0.6).add(speed.mul(3).mul(v.fall)), 0)).mul(0.12))
  const albedo = mix(mix(u.shallow, u.deep, depthT).add(streak), vec3(1), white)
  m.colorNode = vec4(albedo, mix(mix(float(0.66), float(0.94), depthT), float(1), white).mul(v.alpha))
  voxelLit(m, { normal: n, sky: v.sky, blk: v.blk, ao: float(1), albedo }, lights)

  const view = cameraPosition.sub(wp).normalize()
  const half = normalize(view.add(u.sunDir))
  const spec = dot(n, half).max(0).pow(160).mul(2.5).mul(smoothstep(0.35, 0.95, v.sky)).mul(u.sunVis)
  const fresnel = float(1).sub(dot(n, view).max(0)).pow(4).mul(0.35)
  m.emissiveNode = (m.emissiveNode as N).add(u.sunColor.mul(spec)).add(u.horizon.mul(fresnel))
}

/** Translucent flat-coloured water for when the water effect is off. */
function plain(v: WaterVertex, u: WaterUniforms, lights: LightUniforms): VoxelNodeMaterial {
  const m = new VoxelNodeMaterial(v.sky)
  m.positionNode = v.position
  m.transparent = true
  m.depthWrite = false
  voxelLit(m, { normal: v.normal, sky: v.sky, blk: v.blk, ao: float(1), albedo: u.shallow }, lights)
  m.colorNode = vec4(u.shallow, float(0.8).mul(v.alpha))
  return m
}

/** The water materials: static voxel water (the chunk liquid layer), the heightfield surface and its curtains, plus plain fallbacks. */
export class WaterMaterial {
  readonly voxel: VoxelNodeMaterial
  readonly surface: VoxelNodeMaterial
  readonly curtain: VoxelNodeMaterial
  readonly plainSurface: VoxelNodeMaterial
  readonly plainCurtain: VoxelNodeMaterial
  private readonly u = createUniforms()

  constructor(lights: LightUniforms, depthEffects: boolean) {
    const make = (v: WaterVertex): VoxelNodeMaterial => {
      const m = new VoxelNodeMaterial(v.sky)
      shade(m, v, this.u, lights, depthEffects)
      return m
    }
    this.voxel = make(voxelWaterVertex())
    this.surface = make(surfaceVertex())
    this.curtain = make(curtainVertex())
    this.curtain.side = THREE.DoubleSide
    this.plainSurface = plain(surfaceVertex(), this.u, lights)
    this.plainCurtain = plain(curtainVertex(), this.u, lights)
    this.plainCurtain.side = THREE.DoubleSide
  }

  setParams(p: WaterParams): void {
    setLinear(this.u.shallow.value, p.shallow)
    setLinear(this.u.deep.value, p.deep)
    this.u.depthScale.value = p.depthScale
    this.u.foamWidth.value = p.foamWidth
    this.u.waveScale.value = p.waveScale
    this.u.waveSpeed.value = p.waveSpeed
  }

  applyAtmosphere(a: Atmosphere): void {
    const [x, y, z] = sunDirection(a.sun.azimuth, a.sun.elevation)
    this.u.sunDir.value.set(x, y, z)
    setLinear(this.u.sunColor.value, a.sun.color)
    this.u.sunVis.value = sunVisibility(a.sun.elevation) * Math.min(a.sun.intensity, 1)
    setLinear(this.u.horizon.value, a.sky.horizon)
  }

  dispose(): void {
    for (const m of [this.voxel, this.surface, this.curtain, this.plainSurface, this.plainCurtain]) m.dispose()
  }
}
```

- [ ] **Step 5: Create `packages/engine/src/render/water/waterSurface.ts`**

```ts
import * as THREE from 'three/webgpu'
import type { ColumnData, SurfaceView } from './surfaceView.ts'

/** Base quad corners, in the order (−x,−z) (+x,−z) (+x,+z) (−x,+z) (surface) or top A, top B, bottom B, bottom A (curtain). */
const CORNERS = [0, 1, 2, 3]
/** Facing +y, counter-clockwise seen from above. */
const SURFACE_INDEX = [0, 2, 1, 0, 3, 2]
const CURTAIN_INDEX = [0, 1, 2, 0, 2, 3]
/** Update ranges merge until the next upload; past this many, the whole attribute is uploaded instead. */
const MAX_RANGES = 8

interface Slot {
  surface: THREE.Mesh
  geo: THREE.InstancedBufferGeometry
  attrs: THREE.InstancedBufferAttribute[]
  curtains: THREE.Mesh
  cgeo: THREE.InstancedBufferGeometry
  generation: number
}

function baseQuad(index: number[], height: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry()
  g.setAttribute('corner', new THREE.BufferAttribute(Float32Array.from(CORNERS), 1))
  // three's node materials expect a `position` attribute; the shaders build positions from the instance data instead.
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3))
  g.setIndex(index)
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(16, height / 2, 16), Math.hypot(16, height / 2, 16) + 1)
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(33, height, 33))
  return g
}

function dynamic(array: Float32Array): THREE.InstancedBufferAttribute {
  const a = new THREE.InstancedBufferAttribute(array, 4)
  a.setUsage(THREE.DynamicDrawUsage)
  return a
}

function uploadRows(a: THREE.BufferAttribute, start: number, count: number): void {
  if (a.updateRanges.length >= MAX_RANGES) a.clearUpdateRanges() // no range: three uploads the whole attribute
  else a.addUpdateRange(start, count)
  a.needsUpdate = true
}

/**
 * Draws the heightfield (spec §5): per chunk column, 32 × 32 instanced quads whose corners interpolate between the
 * previous and the current water step, and its waterfall curtains. Instance data lives in the SurfaceView; this class
 * only wires it to three.js and uploads the rows that changed.
 */
export class WaterSurface {
  readonly group = new THREE.Group()
  private readonly view: SurfaceView
  private readonly height: number
  private readonly slots = new Map<number, Slot>()
  private surfaceMaterial: THREE.Material
  private curtainMaterial: THREE.Material

  constructor(height: number, view: SurfaceView, surface: THREE.Material, curtain: THREE.Material) {
    this.height = height
    this.view = view
    this.surfaceMaterial = surface
    this.curtainMaterial = curtain
    this.group.name = 'elovox-water'
  }

  get meshCount(): number { return this.slots.size }

  setMaterials(surface: THREE.Material, curtain: THREE.Material): void {
    this.surfaceMaterial = surface
    this.curtainMaterial = curtain
    for (const s of this.slots.values()) {
      s.surface.material = surface
      s.curtains.material = curtain
    }
  }

  /** Uploads every chunk column the view changed since the last call. */
  update(): void {
    for (const cc of this.view.takeDirty()) {
      const d = this.view.column(cc)
      if (d) this.sync(cc, d)
    }
  }

  dispose(): void {
    for (const s of this.slots.values()) { s.geo.dispose(); s.cgeo.dispose() }
    this.slots.clear()
    this.group.clear()
  }

  private sync(cc: number, d: ColumnData): void {
    const s = this.slots.get(cc) ?? this.create(cc, d)
    if (d.rowLo <= d.rowHi) {
      const start = d.rowLo * 32 * 4, count = (d.rowHi - d.rowLo + 1) * 32 * 4
      for (const a of s.attrs) uploadRows(a, start, count)
      d.rowLo = 32
      d.rowHi = -1
    }
    const cs = d.curtains
    if (cs.generation !== s.generation) {
      s.cgeo.setAttribute('cPrev', dynamic(cs.prev))
      s.cgeo.setAttribute('cCur', dynamic(cs.cur))
      s.cgeo.setAttribute('cInfo', dynamic(cs.info))
      s.generation = cs.generation
    } else {
      for (const name of ['cPrev', 'cCur', 'cInfo']) s.cgeo.getAttribute(name).needsUpdate = true
    }
    s.cgeo.instanceCount = cs.count
    s.curtains.visible = cs.count > 0
  }

  private create(cc: number, d: ColumnData): Slot {
    const ox = (cc % this.view.cx) * 32, oz = Math.floor(cc / this.view.cx) * 32
    const geo = baseQuad(SURFACE_INDEX, this.height)
    const attrs = [dynamic(d.hPrev), dynamic(d.hCur), dynamic(d.info)]
    geo.setAttribute('hPrev', attrs[0]!)
    geo.setAttribute('hCur', attrs[1]!)
    geo.setAttribute('info', attrs[2]!)
    geo.instanceCount = 1024
    const surface = this.mesh(geo, this.surfaceMaterial, ox, oz, `water-${cc}`)
    const cgeo = baseQuad(CURTAIN_INDEX, this.height)
    cgeo.setAttribute('cPrev', dynamic(d.curtains.prev))
    cgeo.setAttribute('cCur', dynamic(d.curtains.cur))
    cgeo.setAttribute('cInfo', dynamic(d.curtains.info))
    cgeo.instanceCount = 0
    const curtains = this.mesh(cgeo, this.curtainMaterial, ox, oz, `water-${cc}-curtains`)
    curtains.visible = false
    const slot: Slot = { surface, geo, attrs, curtains, cgeo, generation: d.curtains.generation }
    this.slots.set(cc, slot)
    return slot
  }

  private mesh(geo: THREE.InstancedBufferGeometry, material: THREE.Material, ox: number, oz: number, name: string): THREE.Mesh {
    const m = new THREE.Mesh(geo, material)
    m.position.set(ox, 0, oz)
    m.matrixAutoUpdate = false
    m.updateMatrix()
    m.renderOrder = 1 // after opaque terrain and glass, like the liquid layer
    m.castShadow = false
    m.receiveShadow = true
    m.raycast = () => {}
    m.name = name
    this.group.add(m)
    return m
  }
}
```

- [ ] **Step 6: Wire it into `Visuals` and the engine**

In `packages/engine/src/render/visuals.ts`:
1. Add the imports:
   ```ts
   import type { SurfaceView } from './water/surfaceView.ts'
   import { WaterSurface } from './water/waterSurface.ts'
   import { waterAlpha } from './water/waterVertex.ts'
   ```
2. Add to `VisualsOptions`:
   ```ts
     /** The main thread's view of the heightfield water (engine.ts feeds it from the tick messages). */
     water: SurfaceView
   ```
3. Add a field `private readonly waterSurface: WaterSurface`.
4. In the constructor, replace the three lines from `this.water = new WaterMaterial(…)` through `this.syncWater()` with:
   ```ts
       this.water = new WaterMaterial(this.lights, resolveEffects(this.requested, SUPPORT[o.backend]).waterDepth)
       this.water.setParams(this.waterParams)
       this.waterSurface = new WaterSurface(o.layout.size[1], o.water, this.water.surface, this.water.curtain)
       o.scene.add(this.waterSurface.group)
       this.syncWater()
   ```
5. Add a method after `drawFalling`:
   ```ts
     /** How far the water surface is between the previous and the current water step (0–1). */
     setWaterAlpha(a: number): void { waterAlpha.value = a }
   ```
6. In `frame(dt)`, add `this.waterSurface.update()` right before the `if (this.effects.post)` line.
7. In `dispose()`, add before `this.water.dispose()`:
   ```ts
       this.o.scene.remove(this.waterSurface.group)
       this.waterSurface.dispose()
   ```
8. Replace `syncWater()`:
   ```ts
     private syncWater(): void {
       const on = this.effects.water
       this.chunks.setLayerMaterial('liquid', on ? this.water.voxel : this.chunks.baseMaterial('liquid'))
       this.waterSurface.setMaterials(on ? this.water.surface : this.water.plainSurface, on ? this.water.curtain : this.water.plainCurtain)
     }
   ```

In `packages/engine/src/engine.ts`:
1. Add `import { SurfaceView } from './render/water/surfaceView.ts'`.
2. After `const falling = new FallingTrack()`, add:
   ```ts
     const waterView = new SurfaceView(size, buffers.water, (x, y, z) => reader.getLight(x, y, z), o.sim?.tickHz ?? 20)
     /** When the last water publish was applied: the surface interpolates from it over one tick. */
     let waterT0 = 0
   ```
3. In the `new Visuals({…})` options, add `water: waterView,`.
4. In the `'tick'` case, after `falling.update(…)`, add:
   ```ts
           if (m.water && waterView.apply(m.water)) waterT0 = performance.now()
   ```
5. In the animation loop, right before `visuals.frame(dt)`, add:
   ```ts
       visuals.setWaterAlpha(Math.min(1, (performance.now() - waterT0) / tickMs))
   ```

- [ ] **Step 7: An e2e that the shaders compile and draw**

Create `apps/sandbox/e2e/water-render.spec.ts`:

```ts
import { expect, test } from '@playwright/test'
import type { Engine } from '@elovox/engine'

type W = Window & { __elovox?: { engine: Engine; ready: boolean } }

test('the flood scene draws its lake and sea as heightfield water, with no console errors', async ({ page }) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/?scene=flood')
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 120_000 })
  await page.waitForFunction(() => {
    const water = (window as W).__elovox!.engine.scene.getObjectByName('elovox-water')
    return !!water && water.children.length > 0
  }, null, { timeout: 30_000 })
  await page.waitForTimeout(3000) // a few frames with the water shaders compiled and drawing
  expect(errors).toEqual([])
})
```

- [ ] **Step 8: Run the tests**

Run: `cd packages/engine && npx vitest run test/waterSurface.test.ts test/surfaceView.test.ts`
Expected: PASS.

The `WaterMaterial` test only builds node graphs: no GPU is needed. If it fails in Node on a missing browser global inside three, report the exact error to the controller rather than deleting the test.

Run: `npm run typecheck` and `npm test` (repo root).
Expected: PASS.

Run (stop anything holding port 5174 first): `cd apps/sandbox && E2E_PORT=5174 npx playwright test e2e/water-render.spec.ts e2e/smoke.spec.ts --workers=1`
Expected: PASS. A shader that fails to compile shows up as a console error here.

- [ ] **Step 9: Look at it**

Start `cd apps/sandbox && npx vite --port 5174` and open `http://localhost:5174/?scene=flood`. Check, and note in the task report:
- the lake and the sea show a smooth surface;
- the static water under the pillar on planks is drawn by the heightfield, not as a hole;
- the river shows its current;
- `__elovox.flood.breach()` produces a curtain at the breach.

Stop the server afterwards. The user's judgement comes in Task 13.

- [ ] **Step 10: Commit**

```bash
git add packages/engine/src/render/water/waterVertex.ts packages/engine/src/render/water/waterSurface.ts packages/engine/src/render/water.ts packages/engine/src/render/visuals.ts packages/engine/src/engine.ts packages/engine/test/waterSurface.test.ts apps/sandbox/e2e/water-render.spec.ts
git commit -m "feat(render): draw heightfield water: interpolated surfaces, waterfall curtains, current and white water"
```

---

### Task 11: Remove the 3a water-visual fixes that the heightfield supersedes

These 3a "WV" fixes made voxel water glide between remeshes and carry flow in the liquid vertex: the liquid blend (WV4), the 5 flow bits, and the chunk-seam blend fixes. Simulated water no longer comes from voxels, so they go. The following stay:
- the spring block, `liquidGroup` and `BlockDef.source`;
- `LIQUID_DEEP` (deep static water keeps its shore foam);
- the static liquid mesher itself.

**Files:**
- Delete: `packages/engine/src/render/liquidBlend.ts`, `packages/engine/test/liquidBlend.test.ts`
- Modify:
  - `packages/engine/src/render/chunkMeshes.ts`
  - `packages/engine/src/render/chunkVertex.ts`
  - `packages/engine/src/render/visuals.ts`
  - `packages/engine/src/render/water/waterVertex.ts` (`voxelWaterVertex`)
  - `packages/engine/src/mesh/vertexFormat.ts`
  - `packages/engine/src/mesh/liquid.ts`
  - `packages/engine/src/mesh/tables.ts`
- Rewrite: `packages/engine/test/chunkMeshes.test.ts`
- Change: `packages/engine/test/vertexFormat.test.ts`, `packages/engine/test/liquid.test.ts`

**Interfaces:**
- Consumes: Task 10's `voxelWaterVertex`.
- Produces:
  - `isTopRow(a: number): boolean`, which moves from `render/liquidBlend.ts` to `mesh/liquid.ts`.
  - `chunkVertex()` no longer returns `flow`.
  - `ChunkMeshes` no longer has `now()`.
  - Removed: `MAX_LIQUID_LAYER`, `FLOW`, `flowCode`, `packFlow`, `unpackFlow`, `liquidNow`, `BLEND_SECONDS`, `NEW_DROP`, `blendFrom`, `blendedDrop`.

- [ ] **Step 1: Rewrite the tests first**

Replace `packages/engine/test/chunkMeshes.test.ts` with:

```ts
import * as THREE from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import type { ChunkMeshData } from '../src/mesh/mesher.ts'
import type { LayerMesh } from '../src/mesh/quadBuilder.ts'
import { FACE, packA } from '../src/mesh/vertexFormat.ts'
import { ChunkMeshes } from '../src/render/chunkMeshes.ts'
import type { ChunkMaterials } from '../src/render/materials.ts'
import { Layout } from '../src/world/layout.ts'

function setup(): ChunkMeshes {
  const m = () => new THREE.MeshBasicMaterial()
  const mats = { opaque: m(), cutout: m(), translucent: m(), liquid: m() } as unknown as ChunkMaterials
  return new ChunkMeshes(new Layout([64, 64, 64]), mats)
}

/** One +Y quad at cell (1, 1, 1). */
function quad(): LayerMesh {
  const vertices = new Uint32Array(8)
  for (let c = 0; c < 4; c++) vertices[c * 2] = packA(1 + (c === 1 || c === 2 ? 1 : 0), 2, 1 + (c >= 2 ? 1 : 0), FACE.PY, 0, c, 0)
  return { vertices, indices: Uint32Array.of(0, 1, 2, 0, 2, 3) }
}

function data(liquid: LayerMesh | null, opaque: LayerMesh | null = null): ChunkMeshData {
  return { opaque, cutout: null, translucent: null, liquid, grass: null, flowers: null }
}

describe('ChunkMeshes', () => {
  it('adds a mesh per layer at the chunk\'s centre; liquid meshes draw after glass and carry no blend attributes', () => {
    const cm = setup()
    cm.apply(1, data(quad(), quad()))
    expect(cm.meshCount).toBe(2)
    const liquid = cm.group.getObjectByName('chunk-1-liquid') as THREE.Mesh
    expect(liquid.position.toArray()).toEqual([32 + 16, 16, 16])
    expect(liquid.renderOrder).toBe(1)
    expect(liquid.geometry.getAttribute('prevDrop')).toBeUndefined()
  })
  it('removes a layer that comes back empty, and every layer of a removed chunk', () => {
    const cm = setup()
    cm.apply(0, data(quad(), quad()))
    cm.apply(0, data(null, quad()))
    expect(cm.group.getObjectByName('chunk-0-liquid')).toBeUndefined()
    expect(cm.meshCount).toBe(1)
    cm.remove(0)
    expect(cm.meshCount).toBe(0)
  })
})
```

In `packages/engine/test/vertexFormat.test.ts`:
- delete the whole `describe('flow bits', …)` block;
- change the import to `import { packA, packB, unpackA, unpackB } from '../src/mesh/vertexFormat.ts'`.

In `packages/engine/test/liquid.test.ts`:
- change the imports:
  - `import { isTopRow, liquidHeight, meshTranslucent } from '../src/mesh/liquid.ts'`;
  - `import { FACE, LIQUID_DEEP, unpackA } from '../src/mesh/vertexFormat.ts'`;
  - delete the `../src/render/liquidBlend.ts` import.
- delete the three tests `'points the top-face flow downhill and leaves flat water still'`, `'marks the sides of falling water steep and leaves the top cell still'` and `'refuses a liquid texture layer at or above 512'`;
- rename `describe('liquid groups, springs and flow', …)` to `describe('liquid groups and springs', …)`.

Delete the blend test:

```bash
git rm packages/engine/test/liquidBlend.test.ts
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/engine && npx vitest run test/chunkMeshes.test.ts test/liquid.test.ts test/vertexFormat.test.ts`
Expected: FAIL. `liquid.test.ts` fails with "isTopRow is not exported" or a similar import error, and `chunkMeshes.test.ts` with `prevDrop` defined.

- [ ] **Step 3: Remove the blend and the flow bits**

```bash
git rm packages/engine/src/render/liquidBlend.ts
```

In `packages/engine/src/render/chunkMeshes.ts`:
- delete the `import { blendFrom, type LiquidBlendState } from './liquidBlend.ts'` line;
- delete the `liquidBlend` and `origin` fields and the `now()` method;
- in `apply`, delete the line `if (name === 'liquid') this.liquidBlend.delete(ci) // …` and the whole `if (name === 'liquid') { const b = blendFrom(…); … }` block;
- in `remove`, delete `this.liquidBlend.delete(ci)`.

Replace `packages/engine/src/render/chunkVertex.ts` in full:

```ts
import { attribute, bool, float, modelWorldMatrix, select, uint, varying, vec2, vec3, vec4 } from 'three/tsl'
import { AO_CURVE } from '../mesh/ao.ts'
import { LIQUID_DEEP } from '../mesh/vertexFormat.ts'
import { FLIP_U } from './faceUv.ts'

/** Loose TSL node type for the optional per-layer scale table (a `uniformArray` of floats). */
type ScaleTable = { element(i: unknown): ReturnType<typeof float> }

/**
 * TSL nodes decoded from the packed 8-byte chunk vertex (sub-project 1 format; spec §5 of the core spec).
 * `scales`, when given, holds one entry per texture-array layer: how many blocks one repeat of that texture spans.
 */
export function chunkVertex(scales?: ScaleTable, liquid = false) {
  const packed = attribute('packed', 'uvec2')
  const a = packed.x, b = packed.y
  const px = a.bitAnd(uint(63)).toFloat()
  const py = a.shiftRight(uint(6)).bitAnd(uint(63)).toFloat()
  const pz = a.shiftRight(uint(12)).bitAnd(uint(63)).toFloat()
  const nIdx = a.shiftRight(uint(18)).bitAnd(uint(7))
  const ao = a.shiftRight(uint(21)).bitAnd(uint(3))
  const drop = a.shiftRight(uint(25)).bitAnd(uint(31)).toFloat()
  const layerBits = b.bitAnd(uint(4095))
  const layer = layerBits.toFloat()
  const sky = b.shiftRight(uint(12)).bitAnd(uint(15)).toFloat().div(15)
  const blk = b.shiftRight(uint(16)).bitAnd(uint(15)).toFloat().div(15)

  const local = vec3(px, py.sub(drop.div(16)), pz)
  const normal = select(nIdx.equal(uint(0)), vec3(1, 0, 0),
    select(nIdx.equal(uint(1)), vec3(-1, 0, 0),
      select(nIdx.equal(uint(2)), vec3(0, 1, 0),
        select(nIdx.equal(uint(3)), vec3(0, -1, 0),
          select(nIdx.equal(uint(4)), vec3(0, 0, 1), vec3(0, 0, -1))))))
  const axis = nIdx.shiftRight(uint(1))
  // Project the WORLD position, not the chunk-local one: chunk origins are multiples of 32, so this is identical at
  // scale 1, and a non-integer texture scale stays continuous across chunk borders.
  const world = modelWorldMatrix.mul(vec4(local.sub(16), 1)).xyz
  const proj = select(axis.equal(uint(0)), vec2(world.z, world.y), select(axis.equal(uint(1)), vec2(world.x, world.z), vec2(world.x, world.y)))
  const uvRaw = scales ? proj.div(scales.element(layerBits.toInt())) : proj
  const flip = FLIP_U.reduce<ReturnType<typeof nIdx.equal>>((acc, on, f) => (on ? acc.or(nIdx.equal(uint(f))) : acc), bool(false) as unknown as ReturnType<typeof nIdx.equal>)
  const uv = vec2(select(flip, uvRaw.x.negate(), uvRaw.x), uvRaw.y)
  const aoF = select(ao.equal(uint(0)), float(AO_CURVE[0]!),
    select(ao.equal(uint(1)), float(AO_CURVE[1]!), select(ao.equal(uint(2)), float(AO_CURVE[2]!), float(AO_CURVE[3]!))))

  return {
    position: local.sub(16),
    normal: varying(normal),
    uv: varying(uv),
    layer: varying(layer),
    sky: varying(sky),
    blk: varying(blk),
    // Liquid vertices carry flags in their ao bits (LIQUID_DEEP), not occlusion: their AO is always 1.
    ao: liquid ? float(1) : varying(aoF),
    /**
     * The vertex's surface height within its cell (1 = full); 1 for deep water (a LIQUID_DEEP vertex: the same liquid
     * lies below, so a thin top layer still reads as deep) and for non-liquid layers.
     */
    surface: liquid ? varying(select(ao.equal(uint(LIQUID_DEEP)), float(1), float(1).sub(drop.div(16)))) : float(1),
  }
}

export type ChunkVertex = ReturnType<typeof chunkVertex>
```

In `packages/engine/src/render/water/waterVertex.ts`, replace `voxelWaterVertex`. Static voxel water now has no flow:

```ts
/** Static voxel water: the chunk liquid layer's packed vertex. It never flows: what moves is the heightfield. */
export function voxelWaterVertex(): WaterVertex {
  const v = chunkVertex(undefined, true)
  return {
    position: v.position, normal: v.normal, isTop: v.normal.y.greaterThan(0.5), sky: v.sky, blk: v.blk,
    flow: vec3(0, 0, 0), surface: v.surface, white: float(0), fall: float(1), alpha: float(1),
  }
}
```

In `packages/engine/src/render/visuals.ts`, delete `import { liquidNow } from './chunkVertex.ts'` and the line `liquidNow.value = this.chunks.now()` in `frame`.

In `packages/engine/src/mesh/vertexFormat.ts`, delete everything from the comment `/** Liquid flow codes (5 bits)…` to the end of the file: `FLOW`, `flowCode`, `packFlow` and `unpackFlow`.

In `packages/engine/src/mesh/tables.ts`:
- delete `MAX_LIQUID_LAYER` and its comment;
- delete the `for` loop in `meshTablesFrom` that checks liquid texture layers, so the function just returns the object.

In `packages/engine/src/mesh/liquid.ts`:
1. Change the vertex-format import to `import { LIQUID_DEEP, packA, packB } from './vertexFormat.ts'`.
2. Delete `FLOW_EPS`, `FLOW_STEEP` and `topFlow()`.
3. In `meshTranslucent`:
   - delete the `falling` const;
   - delete the `const flow = …` line;
   - delete the line `if (flow !== FLOW.STILL) [qa[c], qb[c]] = packFlow(qa[c]!, qb[c]!, flow)`.
4. Add, after `cornerIndex`:
   ```ts
   /** Per face × corner: 1 when the corner sits on the cell's top plane (the liquid mesher's vertex layout). */
   const TOP_ROW = new Uint8Array(24)
   for (let f = 0; f < 6; f++) {
     const [d, u, v] = AXES[f]!
     for (let c = 0; c < 4; c++) {
       TOP_ROW[f * 4 + c] = d === 1 ? ((f & 1) === 0 ? 1 : 0) : u === 1 ? (c === 1 || c === 2 ? 1 : 0) : v === 1 ? (c >= 2 ? 1 : 0) : 0
     }
   }

   /** Whether a liquid vertex (word A) is on its cell's top row: the only row whose height depends on the water level. */
   export function isTopRow(a: number): boolean {
     return TOP_ROW[((a >>> 18) & 7) * 4 + ((a >>> 23) & 3)] === 1
   }
   ```

- [ ] **Step 4: Check that nothing still uses what was removed**

Use the Grep tool with pattern `liquidBlend|packFlow|unpackFlow|flowCode|FLOW\.|liquidNow|MAX_LIQUID_LAYER|BLEND_SECONDS|NEW_DROP|blendFrom` over `packages/` and `apps/`.
Expected: no matches.

- [ ] **Step 5: Run the tests**

Run: `cd packages/engine && npx vitest run test/chunkMeshes.test.ts test/liquid.test.ts test/vertexFormat.test.ts test/waterSurface.test.ts test/meshJob.test.ts`
Expected: PASS.

Run: `npm run typecheck` and `npm test`.
Expected: PASS.

Run (port 5174 free): `cd apps/sandbox && E2E_PORT=5174 npx playwright test e2e/water-render.spec.ts --workers=1`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/render/chunkMeshes.ts packages/engine/src/render/chunkVertex.ts packages/engine/src/render/visuals.ts packages/engine/src/render/water/waterVertex.ts packages/engine/src/mesh/vertexFormat.ts packages/engine/src/mesh/liquid.ts packages/engine/src/mesh/tables.ts packages/engine/test/chunkMeshes.test.ts packages/engine/test/vertexFormat.test.ts packages/engine/test/liquid.test.ts
git commit -m "refactor(render): drop the voxel liquid blend and flow bits the heightfield supersedes"
```

The `git rm` deletions from Steps 1 and 3 are already staged.

---

### Task 12: The flood scene: the dig hook, its tests, the e2e and the bench

**Files:**
- Modify:
  - `apps/sandbox/src/scenes/flood.ts` (`CHANNEL`, `digCommands`)
  - `apps/sandbox/src/main.ts` (the `dig` hook)
  - `apps/sandbox/test/flood.test.ts`
  - `apps/sandbox/e2e/flood-bench.spec.ts` (the `Flood` type)
- Rewrite: `apps/sandbox/e2e/flood.spec.ts`

**Interfaces:**
- Consumes: the flood scene's constants; `engine.stats()` (`physicsBusy`, `fallingBodies`, `waterColumns`).
- Produces:
  - `CHANNEL = { x0: 4, x1: 24, z0: 40, z1: 43 }`;
  - `digCommands(): Command[]`;
  - `__elovox.flood.dig()`.

- [ ] **Step 1: Write the failing scene tests**

In `apps/sandbox/test/flood.test.ts`:
- add `CHANNEL` and `digCommands` to the import from `../src/scenes/flood.ts`;
- add, inside `describe('flood scene layout', …)`:
  ```ts
    it('digs a channel west of the lake through the ground, down to the lake floor', () => {
      expect(digCommands()).toEqual([{ type: 'fillRegion', min: [CHANNEL.x0, LAKE.floor, CHANNEL.z0], max: [CHANNEL.x1, 24, CHANNEL.z1], voxel: 0 }])
      expect(CHANNEL.x1).toBe(LAKE.x0 - 1) // it opens straight into the lake
      for (const x of [CHANNEL.x0, CHANNEL.x1]) expect(floodColumn(x, CHANNEL.z0)[LAKE.floor]).not.toBeNull() // ground there now
    })
  ```
- add, inside `describe('flood scene simulation', …)`:
  ```ts
    it('a channel dug beside the lake fills while the lake goes down by exactly what the channel holds', () => {
      const sim = new Simulation({ buffers: createWorldBuffers([...FLOOD_SIZE]), blocks: BLOCKS, rules, seed: 1, randomTicksPerChunk: 0, log: () => {} })
      sim.configure(floodGenerator, {})
      sim.generate(floodGenerator)
      const sum = (x0: number, z0: number, x1: number, z1: number) => {
        let s = 0
        for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) s += sim.water.column(x, z).depth
        return s
      }
      const lake0 = sum(LAKE.x0, LAKE.z0, LAKE.x1, LAKE.z1)
      digCommands().forEach((c, i) => sim.submit(0, i, c))
      for (let t = 0; t < 1500; t++) sim.step()
      const channel = sum(CHANNEL.x0, CHANNEL.z0, CHANNEL.x1, CHANNEL.z1)
      const area = (CHANNEL.x1 - CHANNEL.x0 + 1) * (CHANNEL.z1 - CHANNEL.z0 + 1)
      expect(channel).toBeGreaterThan(area * 3 * SUB)
      expect(lake0 - sum(LAKE.x0, LAKE.z0, LAKE.x1, LAKE.z1)).toBe(channel)
    }, 180_000)
  ```

Run: `cd apps/sandbox && npx vitest run test/flood.test.ts`
Expected: FAIL with "digCommands is not a function" (or a missing export).

- [ ] **Step 2: Add the channel to the scene**

In `apps/sandbox/src/scenes/flood.ts`, add after `PILLARS`:

```ts
/** The dig checkpoint's channel: west of the lake, opening straight into it (x 4..24, z 40..43). */
export const CHANNEL = { x0: 4, x1: LAKE.x0 - 1, z0: 40, z1: 43 } as const
```

and after `dropCommands`:

```ts
/** Cuts CHANNEL through the ground down to the lake's floor: the lake runs into it. */
export function digCommands(): Command[] {
  return [{ type: 'fillRegion', min: [CHANNEL.x0, LAKE.floor, CHANNEL.z0], max: [CHANNEL.x1, GROUND - 1, CHANNEL.z1], voxel: AIR }]
}
```

In `apps/sandbox/src/main.ts`:
- add `digCommands` to the import from `./scenes/flood.ts`;
- add to the `flood` object: `dig: () => digCommands().forEach((c) => engine.submit(c)),`.

In `apps/sandbox/e2e/flood-bench.spec.ts`, change the `Flood` type to `{ breach(): void; drop(): void; stopSpring(): void; stress(): void; dig(): void }`.

Run: `cd apps/sandbox && npx vitest run test/flood.test.ts`
Expected: PASS.

- [ ] **Step 3: Rewrite the flood e2e**

Replace `apps/sandbox/e2e/flood.spec.ts` with:

```ts
import { expect, test, type Page } from '@playwright/test'
import type { Engine } from '@elovox/engine'

type Flood = { breach(): void; drop(): void; stopSpring(): void; dig(): void }
type W = Window & { __elovox?: { engine: Engine; flood: Flood | null; ready: boolean }; __quiet?: number }

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

async function open(page: Page): Promise<void> {
  await page.goto('/?scene=flood')
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 120_000 })
}

/** Lowest and highest mirrored water top (y × 8 + level) over the lake's interior, every 3rd column; null when there is none. */
async function lakeRange(page: Page): Promise<[number, number] | null> {
  return page.evaluate(() => {
    const e = (window as W).__elovox!.engine
    const water = e.blocks.id('water')
    let lo = Infinity, hi = -Infinity
    for (let x = 25; x <= 124; x += 3) for (let z = 25; z <= 124; z += 3) {
      for (let y = 30; y >= 20; y--) {
        const v = e.world.get(x, y, z)
        if ((v & 0xfff) === water) {
          const h = y * 8 + ((v >>> 12) & 7)
          lo = Math.min(lo, h)
          hi = Math.max(hi, h)
          break
        }
      }
    }
    return lo === Infinity ? null : [lo, hi] as [number, number]
  })
}

test('a breached lake drains into the valley and the whole scene settles', async ({ page }) => {
  test.setTimeout(600_000)
  const errors = watchErrors(page)
  await open(page)
  expect(await lakeRange(page)).toEqual([24 * 8 + 7, 24 * 8 + 7])
  await page.evaluate(() => { const f = (window as W).__elovox!.flood!; f.stopSpring(); f.breach() })
  // the lake goes down: its top cell at (60, 24, 60) is no longer full
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine
    const v = e.world.get(60, 24, 60)
    return (v & 0xfff) !== e.blocks.id('water') || ((v >>> 12) & 7) < 7
  }, null, { timeout: 300_000, polling: 1000 })
  const valley = await page.evaluate(() => {
    const e = (window as W).__elovox!.engine
    const water = e.blocks.id('water')
    let n = 0
    for (let x = 126; x < 160; x++) for (let z = 50; z < 100; z++) for (let y = 9; y < 14; y++) if ((e.world.get(x, y, z) & 0xfff) === water) n++
    return n
  })
  expect(valley).toBeGreaterThan(0)
  // settled: no physics work and nothing falling for 3 samples in a row
  await page.evaluate(() => { (window as W).__quiet = 0 })
  await page.waitForFunction(() => {
    const w = window as W
    const s = w.__elovox!.engine.stats()
    w.__quiet = !s.physicsBusy && s.fallingBodies === 0 ? (w.__quiet ?? 0) + 1 : 0
    return w.__quiet >= 3
  }, null, { timeout: 480_000, polling: 1000 })
  const range = await lakeRange(page)
  if (range) expect(range[1] - range[0]).toBeLessThanOrEqual(1) // what is left on the lake bed lies flat
  expect(errors).toEqual([])
})

test('a channel dug beside the lake fills', async ({ page }) => {
  test.setTimeout(240_000)
  const errors = watchErrors(page)
  await open(page)
  await page.evaluate(() => (window as W).__elovox!.flood!.dig())
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine
    return (e.world.get(6, 22, 41) & 0xfff) === e.blocks.id('water')
  }, null, { timeout: 120_000, polling: 500 })
  expect(errors).toEqual([])
})

test('sand pillars fall, one into the lake', async ({ page }) => {
  test.setTimeout(240_000)
  const errors = watchErrors(page)
  await open(page)
  await page.evaluate(() => (window as W).__elovox!.flood!.drop())
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine
    return e.world.get(60, 25, 160) === e.blocks.id('sand') && e.world.get(60, 40, 160) === 0
  }, null, { timeout: 60_000, polling: 250 })
  expect(errors).toEqual([])
})
```

- [ ] **Step 4: Run the e2e**

Run (port 5174 free): `cd apps/sandbox && E2E_PORT=5174 npx playwright test e2e/flood.spec.ts e2e/water-render.spec.ts e2e/smoke.spec.ts --workers=1`
Expected: PASS. The dam-break test takes a few minutes.

If the dam break does not settle within the timeout:
1. Read `engine.stats()` in a headed run (`--headed`).
2. Report the awake tiles and wet columns to the controller. A tile that never sleeps points at `SLEEP_STEPS`, `FLUX_EPS` or `DEPTH_EPS`, which are tuned in Task 13.

Do not raise timeouts silently.

- [ ] **Step 5: Run the bench once**

Run: `cd apps/sandbox && BENCH=1 E2E_PORT=5174 npx playwright test e2e/flood-bench.spec.ts --workers=1`
Expected: both tests settle. Copy the two `[flood-bench …]` JSON lines into the task report: they are the desktop baseline for Task 13.

- [ ] **Step 6: Commit**

```bash
git add apps/sandbox/src/scenes/flood.ts apps/sandbox/src/main.ts apps/sandbox/test/flood.test.ts apps/sandbox/e2e/flood.spec.ts apps/sandbox/e2e/flood-bench.spec.ts
git commit -m "test(sandbox): flood scene dig hook; dam-break, channel and pillar e2e on heightfield water"
```

---

### Task 13: Checkpoints with the user

This task is interactive. The controller drives it with the user, who runs the app on the laptop and decides the tuning. Record every result and every change in the "Checkpoint results" section at the end of this plan.

**Setup:** run `cd apps/sandbox && npx vite --port 5174`, then open `http://localhost:5174/?scene=flood`. The HUD's `physics` line shows awake water tiles, wet columns in them, jobs and falling bodies.

**Tuning knobs:**

| What | Where |
|---|---|
| Flow speed and inertia | `GAIN` (k = GAIN / 16), `FRICTION_SHIFT` in `packages/engine/src/sim/water/constants.ts` |
| How hard a cliff pours | `MAX_HEAD` |
| Films | `MIN_FLOW`; `SHOW_MIN` in `render/water/surfaceMesh.ts` |
| Sleeping | `SLEEP_STEPS`, `FLUX_EPS`, `DEPTH_EPS` |
| Curtains | `JOIN` in `surfaceMesh.ts`; the curtain `alpha`/`white`/`fall` curves in `render/water/waterVertex.ts` `curtainVertex` |
| Current and white water | `FLOW_STILL`, `FLOW_STEEP` in `surfaceMesh.ts`; `FLOW_SPEED` in `render/water.ts`; the white-water threshold in `SurfaceView.refreshColumn` |
| Water per tick (safety net) | the `waterTileCap` sim option |

- [ ] **Checkpoint 1: Dam break.**
  - Run `__elovox.flood.stopSpring(); __elovox.flood.breach()` in the console.
  - The user judges:
    - the front crossing the valley as a low wave that overshoots a little and settles;
    - the lake going down flat and smooth, with no blinking, no mosaic and no steps;
    - the breach as one continuous curtain;
    - everything settling: the HUD reads `settled`, with water tiles at 0.
- [ ] **Checkpoint 2: Digging a channel.**
  - Run `__elovox.flood.dig()` on a fresh page.
  - The water runs into the channel and fills it, and the lake goes down by the channel's volume.
  - Also dig with the mouse (LMB) along the lake's shore.
- [ ] **Checkpoint 3: River and sea.**
  - Watch the river at x ≈ 10, z 136–200.
  - The user judges the stream's visible current (ripples moving downstream), the steps of the bed as small curtains or ramps, and the mouth into the sea.
  - Open `?scene=terrain` (the showcase), and judge its rivers and sea, and the water under trees and bridges (planning decision 4).
- [ ] **Checkpoint 4: Sand into the lake.**
  - Run `__elovox.flood.drop()`.
  - The pillar over the lake sinks to the bed, and the surface around it rises by its volume, smoothly. Also place sand with the hotbar over the lake.
  - Place water with the hotbar in mid-air over the lake: it must join the lake, never float.
- [ ] **Checkpoint 5: Laptop measurements against spec §2.**
  - Dam break and stress: `BENCH=1 E2E_PORT=5174 npx playwright test e2e/flood-bench.spec.ts --workers=1 --headed`, or the HUD while breaching by hand.
  - Targets: tick p95 ≤ 10 ms, and fps ≥ 45 during the dam break; settled afterwards.
  - Still water costs nothing: on `?scene=terrain` while idle, the HUD shows 0 water tiles once the rivers' tiles are the only ones awake. Check that the tick time then matches 3a's idle tick.
  - If the budget is missed, measure first:
    - the water step's share of the tick (`console.time` around `this.water.step()` in a local build);
    - the main thread's `SurfaceView.apply` time per tick.
  - Then try `waterTileCap`, or move `refreshTile` work into `frame` within a budget. Record the decision.
- [ ] **Also check** `?scene=diorama` and `?scene=world` for regressions: lakes stay put, no sand falls on its own, and there are no console errors.
- [ ] **Record and commit.** Fill in "Checkpoint results" below, then commit: `git add docs/superpowers/plans/2026-10-04-water-heightfield.md && git commit -m "docs(plan): heightfield water 3c checkpoint results"`.

---

## Spec coverage

| Spec | Tasks |
|---|---|
| §3 Column state, Floor, Step | 2 (step), 4 (rebuild), 5 (edits); decisions 2–6 |
| §3 Sleeping tiles | 2; waking on edits in 6 |
| §3 Sea and springs | 3, 6 |
| §3 Determinism | 2, 3, 4 (`mixState`), 6 (hash), 7 (replay) |
| §4 Voxel mirror | 1 (quiet writes), 4, 6 (flush every tick) |
| §4 Edits | 5, 6 |
| §4 Generation and the editor | 4, 6 (`rebuild`, `rebuildRegion`), 7; decision 10 |
| §4 Static water | 1 (floor in snapshots), 6 (remesh on reclassification) |
| §5 Surface mesh, data path, interpolation | 8, 9, 10 |
| §5 Waterfalls, current and foam | 9, 10 |
| §5 Static water | 1, 11 |
| §6 Performance | 2 (`tileCap`), 9 (row updates), 12 (bench), 13 |
| §7 API and stats | 6 (options, stats, HUD) |
| §8 Errors and validation | 6 (`tileCap` RangeError, debug check), 7 |
| §9 Tests | 2–12 |
| §9 Checkpoints | 13 |

---

## Checkpoint results

*(Filled in during Task 13.)*
