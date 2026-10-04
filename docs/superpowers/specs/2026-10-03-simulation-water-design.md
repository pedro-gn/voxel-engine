# Elovox — Sub-project 3a: Simulation (water, falling blocks, spreading) — Design

Date: 2026-10-03
Status: Draft, awaiting user review
Builds on: `2026-10-01-voxel-core-design.md` (SP1: sim worker, rule API, liquid mesher),
`2026-10-02-terrain-toolkit-design.md` (2b: sea level, lake and river ops) and
`2026-10-03-terrain-editor-design.md` (2c: `replaceColumns`, the editor session)

## 1. Context

SP1 planned sub-project 3 as "Simulation: water, falling blocks, spreading, then structural
collapse (region jobs)". On 2026-10-03 it was split:

- **3a (this spec)**: flowing water with levels and conserved volume, falling blocks,
  spreading/growth content rules, the region-job API, and the rule-API extensions they need.
- **3b**: structural collapse on top of 3a's region jobs and falling bodies.

The first game is a diorama/colony sim: units dig and build, and water flows into what they
dig. Today water is static. Terrain generation fills every non-solid voxel below
`seaLevel` with water, and the lake and river ops set a per-column water level. All of that
water has state 7. The SP1 liquid mesher already draws levels (`state & 7`, height
`(level+1)/9`, corner heights averaged over the four cells that share a corner). Nothing
moves the water, and no shader effect shows a flow direction.

### What exists that 3a builds on

- `Simulation.step()` runs at 20 Hz in this order: commands, neighbour notifications and
  scheduled updates under a count budget (`workCap`, default 50 000), random ticks, light,
  commit.
- Rule hooks: `onNeighborChanged`, `onScheduledTick`, `onRandomTick`. The context
  (`RuleContext`) offers `get`, `set`, `schedule`, `random`, `emit`, `id`, `isAir`,
  `state` and `withState`. It cannot read registry flags or light.
- A voxel is a u16: bits 0–11 are the id and bits 12–15 the state (4 bits).
- `Simulation.hash()` covers voxels and light. The determinism test replays the command log.
- The sandbox's `sand` and `grass` rules exist only to exercise the pipeline.

### Decisions made in brainstorming

| Topic | Decision |
|---|---|
| Split | 3a = water + falling + spreading + region jobs; 3b = structural collapse |
| Water model | **Conserved volume.** Digging a channel from a lake fills the channel and lowers the lake |
| Hardest case | A dam break: a ~100 × 100 lake drains into a dry valley, visibly and **flat** |
| Approach | **Cells + pools**: moving water is a cellular automaton; still water belongs to a pool with an exact volume that rises and falls flat |
| Rivers and sea | Rivers get a **spring** at their head; the sea is an ordinary finite pool. Springs draw from the sea (water cycle), so total volume stays exact |
| Editor | Fluids and gravity are paused while editing terrain; pools are rebuilt on resume |
| Falling blocks | Smooth, interpolated fall. The block **leaves the grid** while it falls (a sim-side falling body) and returns when it lands |
| Spreading | Grass grows and dies, wet variants near water (mud, wet sand), decorations grow back in stages |

### Assumptions

- One liquid (water). The fluid system is generic over `liquid` blocks, but liquid-liquid
  interactions (lava) are out of scope.
- Total water volume is exact under physics. Explicit player commands (`setBlock`,
  `fillRegion`) may create or delete water; that is not a physics leak.
- Saving pools, cells and falling bodies to disk belongs to SP6. 3a only makes that state
  part of the sim state, so it is hashed and replayed.

## 2. Scope and success criteria

### In scope

1. `@elovox/engine`:
   - a **fluid system**: active cells, pools, springs and the water cycle;
   - a **gravity system**: falling bodies;
   - a **region-job API**;
   - `RuleContext` extensions;
   - `BlockDef` additions: `falls` and `source`;
   - `DecorationDef.stateDensity`;
   - `engine.physics.setPaused`;
   - render: falling bodies interpolated between ticks, flow direction in the liquid
     vertex and the water shader.
2. `@elovox/terrain`: the river op's `flow` parameter, which places a spring at its head,
   and the sea level handed to the sim.
3. `@elovox/terrain-editor`: physics is paused while an editor is attached.
4. `apps/sandbox`:
   - content rules: grass, wetness and decoration growth;
   - new blocks: `spring`, `mud` and `wet_sand`, with painted textures;
   - water in the hotbar;
   - `randomTicksPerChunk: 24`;
   - the `?scene=flood` scene, its e2e and its bench.

### Out of scope

- Structural collapse (3b).
- Other liquids and liquid interactions.
- Light attenuation in water.
- Rain and evaporation.
- Foam, splashes and particles.
- Raycast hits on falling bodies.
- Persisting fluid state to disk (SP6).

### Success criteria

- **Dam break** in `?scene=flood`: breaching the dam of a ~100 × 100 × 4 lake into a dry
  valley meets all of these:
  - the lake surface is flat after every fluid step (one level shared by every surface
    cell);
  - the valley fills;
  - total volume is exactly conserved (test);
  - everything settles into pools and the active-cell count drops to **zero**.
- **Laptop performance during the dam break**: sim tick ≤ 10 ms p95 and ≥ 45 fps. Once
  settled, water costs nothing per tick.
- **Falling**:
  - a sand pillar falls smoothly and lands in the right cells;
  - sand falling into water displaces its volume;
  - a landed block never flickers between the falling cube and the chunk mesh.
- **Spreading**: after a drain, mud → dirt → grass → tufts is visible within minutes.
- **Random ticks** at 24 per chunk cost ≤ 2 ms per tick on the flood and terrain scenes.
- **Determinism**: two sims and a command-log replay produce the same hash over 500
  ticks of water, sand and springs. The hash includes pools, active cells, falling bodies
  and job cursors.

## 3. Engine architecture

Fluids and gravity are **engine systems**, not sandbox rules. They need their own state
(pools, bodies), region jobs and render support. Blocks opt in through `BlockDef`.
Spreading stays a content rule on the rule API, because it is game-specific.

### Tick order

`Simulation.step()` becomes:

1. Commands.
2. Neighbour notifications and scheduled updates (rules), under `workCap`.
3. **Gravity**: start new falls, advance bodies, land them.
4. **Fluids**: every `fluidEvery` ticks (default 2, so 10 Hz). This runs active cells,
   pool outlets and inlets, and springs, under `fluidCap` (default 20 000 cell updates).
   Leftovers carry to the next fluid step in order.
5. **Region jobs**, under `jobCap` (default 50 000 visited cells per tick).
6. Random ticks.
7. Light.
8. Commit.

Every iteration order is fixed: insertion-ordered queues, deterministic side rotation and
chunk-index order. World and fluid state stay integers. `Simulation.hash()` also mixes the
pool table, the active-cell queue, the falling bodies and the job cursors.

### Block definitions

- `liquid: true` is unchanged.
- `source: '<liquid name>'` makes a block a spring of that liquid. A spring is itself a
  liquid block, so the registry validates that the named block is a liquid. The registry
  gains `liquidGroup[id]`: the base liquid's id for both the liquid and its springs. The
  mesher uses `liquidGroup` in place of the raw id when it compares neighbours, so water
  and springs share corner heights and cull faces between each other.
- `falls: true` marks blocks that fall when unsupported. It cannot be combined with
  `liquid`, and the registry rejects that combination.

### Pause

`engine.physics.setPaused(paused)` posts to the sim. While paused:

- the gravity and fluid steps are skipped;
- activations still queue (deduplicated), so nothing is lost;
- rules, random ticks and light still run.

`replaceColumns` and `terrain.patch` mark the regenerated chunks as **pool-dirty**. When
physics resumes, a region job rebuilds the pools that touch pool-dirty chunks before
fluids run again.

## 4. Water

### Cell state

A liquid's state bits 0–2 hold the level. The cell's volume is `level + 1` units (1–8).
Bit 3 stays free. Cascades and flow direction are derived by the mesher from neighbours,
not stored. Generated water keeps level 7, so a full cell is 8 units.

### Active cells (the automaton)

The fluid system keeps an **active queue**: liquid cell indices, deduplicated, in
insertion order. A cell is activated when:

- a rule or command writes a liquid there;
- a neighbour changes (from the existing neighbour notification);
- a pool emits water into it.

For each active cell in a fluid step, with `v` its volume:

1. **Down.** If the cell below is air or a non-pool liquid cell with room, move
   `min(v, room)` down.
2. **Sideways.** The cell visits its 4 sides in an order that rotates with the fluid-step
   counter. A side is a candidate if it is air or a non-pool liquid with volume `vn`, and
   `v − vn ≥ 2`.
   - **Drop preference:** if any candidate side leads to a drop (a non-solid cell below a
     reachable cell) within 4 cells, a breadth-first search over at most 4 steps on this
     cell's layer, only those sides are used.
   - Each used side receives `⌊(v − vn) / 2⌋`, recomputing `v` after each transfer.
3. A cell whose volume reaches 0 becomes air.
4. **Sleep.** A cell that did not change for 4 fluid steps leaves the queue. Any write
   next to it activates it again.

A difference of 1 does not flow, so a film of volume-1 cells stops and stays a puddle.

### Pools (still water)

A pool is a settled body. It records:

| Field | Meaning |
|---|---|
| `id` | Stable within a run, allocated in order |
| `surfaceY` | The y of its surface layer |
| `level` | The level of every surface cell (0–7) |
| `area` | The number of surface cells |
| `balance` | Integer units not yet shown in the grid, kept in `(−area, +area)` once jobs catch up |
| `cycle` | `true` for the sea pool that springs draw from (see Springs) |

Invariants:

- every surface cell has `level`;
- every pool cell below `surfaceY` is full (level 7);
- the pool's true volume is its grid volume plus `balance`.

The surface is therefore **flat by construction**.

**Surface index.** Pool membership is stored for surface cells only. Each chunk column
holds sparse 32 × 32 `Int32` tiles keyed by `surfaceY`, which map a cell to a pool id. A
deeper cell finds its pool by walking up its water column to the surface, at most the
world height. The sea at 1024² costs about 4 MB of tiles.

**Outlets.** An outlet is a non-solid, non-pool cell (air or an active liquid cell)
adjacent to a pool cell, either sideways or below, with `y ≤ surfaceY`. Each fluid step,
every outlet receives water from the pool, which debits `balance`:

| Outlet position | Water it receives |
|---|---|
| Below the surface layer | Fills toward 8 units, at most `outletRate` (default 8) |
| On the surface layer | Follows the automaton's rule against the pool's level: `v − vn ≥ 2`, half the difference |

An outlet cell **joins** the pool in two cases:

- it is below `surfaceY` and full;
- it is on the surface layer and its level equals the pool's.

Joining extends the pool. On the surface layer it also adds 1 to `area`. Joining is what
gives communicating vessels: a tunnel dug into a lake bed fills, joins, exposes the next
outlet, and rises to the lake's level.

**Inlets.** Active water adjacent to a pool from above, or from the side on the surface
layer at a level ≥ the pool's, gives its volume to `balance`. The cell then becomes air
if it sits above the surface, or joins if it sits on the surface layer.

**Level changes.** When `balance ≥ area` or `balance ≤ −area`, a **resurface job** moves
the whole surface one level and applies `∓area` to `balance`:

- **Down from level 0:** the surface layer empties. The layer below, all full, becomes
  the surface at level 7. A connectivity job then recomputes the pool, which may split.
  Each part keeps a share of `balance` proportional to its area, with the remainder going
  to the part holding the lowest cell index.
- **Up from level 7:** the air cells above the surface become a new layer at level 0.
  Cells above the surface that are solid are skipped, which changes `area`. Shoreline
  air beside the new layer becomes outlets, so the pool spreads into a wider basin
  through the automaton.

**Pools that touch.**

- A pool cell next to another pool's cell at a lower water height acts as an outlet of
  the higher pool, on the same rules.
- When two touching pools have the same `surfaceY` and `level`, a merge job joins them:
  the balances add, the areas add, and the lower id survives.

**Settling.** A cell that falls asleep is queued for a **settle job**. The job floods
across connected sleeping liquid cells on the same layer whose surface (air or a
non-liquid above) is at one level, and turns them into a pool or adds them to the pool
they touch. Puddles become pools of their own.

**Writes into pools.**

- A `setBlock`, `fillRegion` or `ctx.set` that changes a pool cell adjusts that pool:
  - removing a surface cell lowers `area` and drops its volume from the world;
  - removing a deeper cell turns its neighbours into outlets, because the pool now sees
    air at `y ≤ surfaceY`;
  - placing a solid in a pool cell **displaces** its volume into `balance`.
- Placing water next to a pool makes an active cell, which then follows the inlet rules.

**Mesh cost.** Water changing at 10 Hz remeshes whole chunks. 3a measures that first. If
the dam break misses its budget, the planned fix is a **liquid-only mesh job**: when
only liquid cells changed in a chunk, mesh only its liquid layer and keep the other
layers' buffers. Changing only a liquid's level does not change opacity or emission, so
`applySet` skips `light.onVoxelChanged` when only the state of a liquid changed.

### Springs and the water cycle

- `spring` is a sandbox block with `source: 'water'` and the water textures. It is always
  full: the mesher and the fluid system read a source block's level as 7, whatever its
  state bits hold.
- Its 4 state bits are a **flow index**. `SPRING_RATES[0..15]` maps it to units per fluid
  step (1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 40, 48, 56, 64, 96, 128).
- Each fluid step, a spring pushes its rate into the neighbours that have room, in this
  order: below, then the rotated sides. It never runs out, and with no room it injects
  nothing.
- **Water cycle.** Whatever a spring injects is debited from the **cycle pool**'s
  `balance`, so total volume stays exact. The river runs to the sea and returns its
  water. The sea drops only by the water in transit, which is invisible on a sea of
  ~300 000 surface cells.
  - The cycle pool is the pool with the largest area among those whose surface sits at
    `seaLevel − 1`. When it splits, the largest part keeps `cycle`.
  - A spring never drives the cycle pool's true volume below zero. When the sea has no
    volume left, springs inject nothing.
  - A world with no sea (`seaLevel` 0, or no pool at `seaLevel − 1` after generation)
    has no cycle pool, and its springs are infinite sources. This is the one documented
    exception to conservation.
- The sim learns `seaLevel` from the generator: `GeneratorModule.configure` may return
  `{ seaLevel }`, and the terrain generator returns the document's.

### Terrain

- **River op.** It gains `flow` (a flow index, 0–15, default 8). With `flow > 0`, the op
  places a spring at the start of its path, at the bed's lowest cell under the axis. It
  replaces that water voxel; the bank is untouched.
- The river's water is still generated as today. When the sim starts, each step of its
  surface becomes a pool in contact with the next. Connected water seeks one level, so the
  river drains toward the sea. The steady state is a spring-fed stream along the carved
  bed, plus whatever the bed holds in its hollows. The carved channel keeps the editor's
  shape; the water in it is the shape the sim gives.
- **Initial pools.** `finishGenerate` runs the settle pass over all water synchronously,
  outside the per-tick budget. Lakes and the sea become pools, and their outlets are found
  at once. A leaky lake (a basin open on one side) starts draining on the first fluid
  step. That is intended, and it shows terrain bugs.

### Editor

While a terrain editor is attached (`?scene=terrain&edit`), the sandbox calls
`engine.physics.setPaused(true)`. The terrain panel gets a "Simulate physics" toggle,
which resumes physics and rebuilds the dirty pools. Pausing keeps the 2c drag budget:
otherwise each regeneration at the coast would invalidate the sea pool.

## 5. Region jobs

```ts
interface RegionJob {
  readonly kind: string
  /** Visits up to `budget` cells; returns the cells used. Done when `done` is true. */
  step(budget: number): number
  readonly done: boolean
  /** Applies the result atomically, in the tick it finishes. */
  finish(): void
}
sim.jobs.start(job: RegionJob): void
```

- Jobs run in start order. Each tick, they share `jobCap` (default 50 000 visited cells);
  the first unfinished job gets the budget first.
- A job reads the world while it runs and writes only in `finish()`.
- **Stale jobs.** A write that lands in a region a job has already visited marks the job
  stale. A stale job restarts from its seed. It is never applied on stale data.
- Jobs and their cursors are part of the sim state and the hash.
- **3a jobs:**
  - `settle`: flood sleeping cells into pools;
  - `merge`: join two pools;
  - `resurface`: rewrite every surface cell one level up or down, cursor-based. On the sea
    this can span several ticks; the level change becomes visible when it finishes;
  - `connectivity`: recompute a pool after a layer change;
  - `rebuild`: rebuild pools over pool-dirty chunks.
- 3b reuses the API for support checks.

## 6. Falling blocks

### Sim

- A `falls` block with air or a liquid below it starts falling. The check runs:
  - in the gravity step, for every `falls` cell notified this tick;
  - in a cascade within the same tick, so a whole column starts together.
- **Start.** The sim removes the voxel from the grid with one write (to air) and creates a
  **falling body**: `{ id, voxel, x, z, y256, vy256 }`. `y256` is the height in 1/256
  block; `vy256` is the velocity in 1/256 block per tick.
- **Each tick:**
  - `vy256 += 24`, with a cap at 512 (2 blocks per tick);
  - the body sweeps the cells between its old and new height and stops in the first
    cell above a support. A support is a solid block, a resting `falls` block, or the
    world floor.
- **Landing.** The body returns to the grid with one write.
  - A non-solid, non-liquid block in the landing cell (a torch) is destroyed.
  - **Water in the landing cell is displaced.** Its volume goes to its pool's `balance`
    if it is a pool cell. Otherwise it goes to the cell above as active water, and to the
    nearest cell with room upward if that one is full.
- Bodies pass through liquids. Two bodies in one column land on each other in order.
- Bodies are processed in id order and are included in the hash. A tick's result carries
  `falling: { id, block, x, z, y256, vy256 }[]` plus the ids of the bodies that landed
  this tick, with the chunk version each landing produced.

### Render

- Bodies are drawn as instanced cubes with the block's face textures, cast shadows, and
  sample light at the cell they are in.
- The position is **interpolated** between the last two ticks with the frame's fraction of
  the tick, so the fall looks continuous.
- **No flicker.** A landed body keeps being drawn until the mesh of its chunk at version
  ≥ the landing version is applied. This is the same mechanism as ghost edits. At the
  start of a fall, the stale chunk mesh and the body overlap at the same spot until the
  remesh arrives, which is not visible.
- A fall costs 2 remeshes in total, and 3b's landslides reuse the bodies.

## 7. Spreading and the rule API

### `RuleContext` additions

```ts
isSolid(v: number): boolean
isLiquid(v: number): boolean
isOpaque(v: number): boolean
falls(v: number): boolean
skyLight(x: number, y: number, z: number): number   // 0–15
blockLight(x: number, y: number, z: number): number // 0–15
level(v: number): number                            // a liquid's level, else −1
```

`ctx.set` of a liquid goes through the fluid system: it activates the cell and keeps any
pool consistent, like commands do.

### Content rules (sandbox, `onRandomTick`)

- **Grass.**
  - It becomes dirt when the block above is opaque or liquid.
  - It spreads to dirt at ±1 x/z and dy −1..1 when the target has a non-opaque,
    non-liquid block above and sky light ≥ 9. New grass gets the youngest stage.
- **Growth stage.** Grass state bits 0–1 hold its youth: 0 is mature (the default, so
  generated grass is unchanged) and 3 is new. Each random tick lowers it by 1.
- **Wetness.**
  - Dirt becomes `mud`, and sand becomes `wet_sand`, when a liquid is within Manhattan
    distance 2.
  - Without one, they dry back.
  - `wet_sand` does not fall. When it dries into sand, the write notifies gravity, and
    unsupported sand falls.
  - Mud and wet sand get painted textures from `paint/materials.ts`: darker, more
    saturated versions of dirt and sand.
- **Rate.** The sandbox sets `randomTicksPerChunk: 24`, so a block is visited about every
  70 s on average. Budget: ≤ 2 ms per tick. Worlds larger than 256² scale the rate down by
  area, never below 3 (`randomTickRate`): every sample is a cache miss in a big world, and
  the 1024² showcase at 24 costs ~10 ms per tick (3 there: ~2 ms p95, a visit every ~9 min).
- The demo `sand` rule is removed: gravity replaces it.

### Decorations

`DecorationDef.stateDensity?: [number, number, number, number]`, indexed by `state & 3` of
the decorated block (the grass), multiplies the grass-tuft and flower density in
`extractDecorations`. The default is `[1, 1, 1, 1]`. The sandbox's meadow uses
`[1, ⅔, ⅓, 0]`, so new grass is bare and fills in over a few random ticks. Decorations
already disappear when the grass is submerged, because extraction needs air above.

## 8. Water visuals

- **Flow direction.** The mesher computes, for each liquid top face, a downhill direction
  from its corner heights and from its lowest neighbouring liquid or drop. It quantizes
  the direction to 8 directions plus "still", together with a 2-step speed (gentle or
  steep).
  - The result is packed into the liquid vertex using the 2 reserved bits of word A and
    the high bits of word B's texture-layer field. Liquid faces use few layers, and the
    mesher asserts that their layer fits.
  - The water shader scrolls its ripple noise along the direction, faster on steep
    flow. Still water is unchanged.
- **Cascades.** A liquid with liquid above already draws at full height. Side faces of
  falling water (water above and a non-solid side neighbour) scroll downward faster than
  other side faces.

## 9. Errors and validation

- The registry rejects:
  - `source` naming a non-liquid;
  - `falls` together with `liquid`;
  - `stateDensity` that is not 4 numbers in [0, 1].
- **Pool invariants** are checked in tests and, in dev builds, after each fluid step on
  the pools touched that step. A violation is logged with the pool id, and a `rebuild`
  job is started for its chunks, so the world heals instead of drifting.
- A fluid or gravity exception is a bug, not content. It is logged with the tick and
  position. The step's remaining work carries to the next tick and `commit()` still runs,
  as the existing `finally` guarantees. `WorldFullError` stays fatal.
- `setPaused` with a non-boolean throws on the main thread.

## 10. Testing

### Engine unit tests

- **Cells:** falling, sideways split, the drop preference, volume-1 puddles stopping,
  sleep and wake.
- **Pools:**
  - the surface is flat after every step;
  - balance moves the whole surface;
  - a layer change splits a pool;
  - equal pools merge;
  - communicating vessels: a tunnel dug into a lake bed rises to the lake's level;
  - writes into pools keep the invariants.
- **Conservation (property test with fuzz).** Random scenarios: dig, fill, breach, sand
  into water, springs with a sea. At every tick, total volume (cells + pool balances)
  equals the previous total plus the volume explicit commands added or removed.
- **Springs:** the debit comes from the cycle pool; a spring with no sea is infinite; a
  spring with an empty sea injects nothing.
- **Region jobs:** the budget is respected, the result is atomic, the job resumes next
  tick, and a stale job restarts.
- **Gravity:** a column falls together, the velocity cap holds, landing works on solids
  and on resting `falls` blocks, a torch is destroyed, and water is displaced.
- **Pause:** activations queue while paused and run on resume; dirty pools are rebuilt.
- **Determinism:** the existing test is extended to 500 ticks with water, sand and a
  spring. Two sims and a replay match, and the hash covers the new state.
- **Mesher:** flow-direction encoding round-trips; `liquidGroup` makes springs and water
  share corners; `stateDensity` thins decorations.

### Terrain and sandbox tests

- The river op places a spring when `flow > 0` and none when `flow` is 0.
- The content rules:
  - submerged grass dies;
  - grass spreads only with light;
  - the stage advances;
  - mud and wet sand appear and dry;
  - dried `wet_sand` falls.

### Scene `?scene=flood`

- A 256² world containing:
  - a ~100 × 100 × 4 lake held by a 1-block dam beside a dry valley;
  - a river with a spring that runs into a small sea;
  - a floating sand pillar.
- `window.__elovox.flood.breach()` removes the dam.

### E2E and bench (`BENCH=1`)

The 2c/2d pattern: Playwright drives `window.__elovox`, with `--workers=1`. The e2e:

- breaches the dam;
- waits for settling;
- asserts the lake is flat and lower, the valley holds water, and the active count is 0;
- asserts the sand pillar is on the ground.

The bench records sim tick p95, fps and time to settle. Headless GL is software, so the
performance numbers are measured by the user on the laptop.

### Visual checkpoints with the user

1. The dam break: flow speed, the lake going down, cascades.
2. The river with its spring in steady state; flow direction in the shader.
3. Sand falling, including into water.
4. The drain cycle: mud → grass → tufts.
5. Laptop measurements against §2.
