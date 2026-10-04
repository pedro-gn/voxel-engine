# Elovox — Sub-project 3c: Heightfield water — Design

Status: approved in brainstorming on 2026-10-04 (sections 1–4 approved in chat). Builds on 3a
(`docs/superpowers/specs/2026-10-03-simulation-water-design.md`).

## 1. Context

3a shipped water as a cellular automaton for moving water plus **pools** for still water, drawn
from the voxels by the liquid mesher. At the 3a dam-break checkpoint (2026-10-04) the user found
the result better after the "voxel suave" fixes, but still not fluid: water still blinks as cells
appear and change level, thin films show a per-cell mosaic, and the flood reads as a shallow
sheet rather than a body of water. The user asked for water that behaves like a fluid and chose:

| Topic | Decision |
|---|---|
| Reference | **Timberborn / From Dust**: water is a continuous height per column, with flow and inertia, drawn as a smooth surface over blocky terrain |
| Layers | **One water layer per column** (x, z). Water in caves or under overhangs is out of scope |
| Dynamics | **Flow with inertia**: a flood front advances, overshoots a little and settles; river current is visible; lakes sway slightly and settle. Small waves, no splashes |
| Approach | **Replace** the 3a automaton and pools with a heightfield ("virtual pipes") simulation. Not a hybrid |
| Sequencing | 3a is closed as is (checkpoints 4–5, merge). 3c is its own sub-project with its own plan |

The first game is a diorama/colony sim where units dig and build and water flows into what they
dig. That is the case this design optimises: dig a channel next to a lake and the water runs in.

### What 3c keeps from 3a

Falling bodies (gravity), region jobs, spreading rules (grass, mud, wet sand, decoration growth),
`engine.physics.setPaused`, springs as blocks (`BlockDef.source`, `liquidGroup`), the water
material's look (depth colour, sun glint, fresnel, shore foam), the `?scene=flood` scene, its
e2e and bench.

### What 3c removes

The cell automaton, pools, pool scans, resurface jobs, contacts, the surface index, the active
cell queue (`sim/fluids/*` except what a new module reuses), the liquid mesher path for simulated
water, `liquidBlend` (WV4) and the 5 flow bits in the liquid vertex. `SimInitOptions.fluidEvery`
and `fluidCap` are replaced (§7).

## 2. Scope and success criteria

### In scope

1. `@elovox/engine`:
   - a **water system** (heightfield simulation, sea account, springs, sleeping tiles);
   - coupling with the voxel world (floor tracking, edits, the voxel mirror, rebuild);
   - a **water surface renderer** (smooth per-chunk-column surface, interpolation between
     steps, waterfall curtains, flow and white-water foam);
   - stats and options for the new system.
2. `apps/sandbox`: the flood scene keeps working; a `dig` hook on `__elovox.flood` for the
   channel checkpoint; e2e and bench updated.

### Out of scope

Water in caves and multiple water layers per column; evaporation and rain; splashes and
particles; other liquids; light attenuation in water; persisting water state to disk (SP6).

### Success criteria

- **Dam break** (`?scene=flood`, `__elovox.flood.breach()`):
  - the front crosses the valley as a low wave that overshoots a little and settles;
  - the lake goes down flat and smooth;
  - the breach is one continuous curtain of water;
  - everything settles and every tile falls asleep;
  - total volume is exact: `Σ depth + sea` is constant (test).
- **Dig a channel** beside the lake: water runs in, fills the channel and the lake goes down
  (test + checkpoint).
- **River**: the spring feeds a stream with visible current down to the sea; water that reaches
  the sea returns to the `sea` account.
- **Sand into the lake**: the surface rises by the displaced volume.
- **Visual**: no blinking, no mosaic, no steps in a water surface; at 60+ fps water moves
  smoothly between sim steps.
- **Laptop budget** (unchanged from 3a): sim tick ≤ 10 ms p95 and ≥ 45 fps during the dam
  break; still water costs nothing per tick.
- **Determinism**: two sims and a command-log replay produce the same hash over 500 ticks of
  water, sand and springs.

## 3. The water model

### Column state

For every column (x, z) of the world:

| Field | Type | Meaning |
|---|---|---|
| `floor` | int | y of the top face of the block the water rests on (see Floor) |
| `depth` | int ≥ 0 | water depth in **sub-units of 1/256 block** (`SUB = 256`) |
| `fx`, `fz` | int | flux through the column's +x and +z edges, sub-units per step, signed (positive = toward +x / +z) |

The column's **surface** is `S = floor * SUB + depth`. A column is **wet** when `depth > 0`.
The −x edge of a column is the +x edge of its −x neighbour, so each edge is stored once.
Total water is `Σ depth + sea` (the sea account, below) and is exact.

### Floor

- A **wall** for water is any block that is neither air nor liquid (3a planning deviation 1:
  water flows only into air).
- A **wet** column's floor is the top of the highest wall block below its surface.
- A **dry** column's floor is the top of its highest wall block.
- So a bridge or roof above a lake does not change the lake, but a dry column under a bridge
  presents the bridge top as its floor (one-layer limit, accepted).

### Step

The water step runs **every tick (20 Hz)** over the awake tiles, in a fixed order (tiles by
index, columns row-major inside a tile). For each edge between columns a and b:

1. **Blocked edges.** If neither side can hold water at the other's surface (b's floor is at or
   above a's surface and a's floor at or above b's surface), the flux is 0.
2. **Acceleration with friction.** `f ← f − (f >> FRICTION_SHIFT) + ((clamp(Sa − Sb, ±MAX_HEAD) * GAIN) >> GAIN_SHIFT)`.
   `MAX_HEAD` caps the head difference (a few blocks), so a cliff does not accelerate water
   without bound; the excess just pours.
3. **Outflow limit.** For each column, if the sum of its positive outflows exceeds its depth,
   every outflow of that column is scaled by `depth / sum` (integer multiply then floor divide).
   A column can never go negative.
4. **Transfer.** Each edge moves exactly its (scaled) flux from one side to the other. Volume is
   conserved by construction.
5. **Thin films.** A column whose depth is below `MIN_FLOW` sends nothing (its outgoing fluxes are
   zeroed). Films stay as damp puddles instead of creeping forever.

All constants are integers chosen in the plan and tuned at the checkpoints. A starting point:
`FRICTION_SHIFT = 4` (1/16 per step), `MAX_HEAD = 2 * SUB`, `MIN_FLOW = 4`.

### Sleeping tiles

- The world is divided into **tiles of 16 × 16 columns**. Only awake tiles step.
- A tile falls asleep after `SLEEP_STEPS` consecutive steps in which every |flux| is below
  `FLUX_EPS` and no depth changed by more than `DEPTH_EPS`. Its fluxes are then set to 0.
  - *Clarified in 3c's implementation (2026-10-04, Task 8b).* The quiet test also requires the tile's water to lie flat,
    read the same on all four borders:
    - every edge's head is at most `HEAD_EPS` (6 sub-units), and so is every run of connected water along a row or column
      of the tile and one column past it;
    - the tile's mean slope is at most 1/16 sub-unit per column, with 1 sub-unit of slack.
  - Without this, gentle slopes fall asleep before friction lets their flux build. A border edge keeps its flux while the
    tile across it is awake. A sleeping tile that takes a trickle of water wakes if it no longer lies flat.
- A tile wakes when a neighbouring tile sends water across their border, when an edit touches
  one of its columns or their neighbours, or when a spring in it runs.
- A still lake costs nothing.

### Sea and springs (the water cycle)

- At load, **sea columns** are the generated water columns whose surface is at `seaLevel` and
  that connect (4-neighbour, through such columns) to the world edge.
- A sea column's surface is pinned to `seaLevel * SUB` after every step. Water above that is
  credited to the **`sea`** account; a deficit is debited from it.
- A **spring** (a `source` block, as in 3a) adds its rate to its column each step, debited from
  `sea`. With `sea` empty, springs stop.
- The identity `Σ depth + sea = constant` holds under physics and is tested.

### Determinism

Every field is an integer; iteration order is fixed; `Simulation.hash()` mixes the column arrays,
the sea account and the awake-tile set. The command-log replay reproduces the hash.

## 4. Coupling with the voxel world

### The voxel mirror

The voxel grid keeps water blocks as a **mirror** of the heightfield, so everything that reads
voxels keeps working: wetting rules (mud, wet sand), raycast, falling bodies, the editor.

- After each step, every column whose **quantized** water changed rewrites its voxels: cells
  entirely below the surface are full water (level 7); the surface cell gets level
  `round(frac * 8) − 1` (air below 1/16 block); cells above it that held mirrored water become air.
- Mirror writes are flagged: they **do not trigger remeshing, light updates or water wake-ups**.
  Water is no longer drawn from voxels (§5) and is already transparent to light.

### Edits (commands, rules, gravity landings, the editor)

A write to a column re-evaluates its floor and wakes its tile and the neighbours. Volume is kept
exact by these rules:

| Edit | Effect |
|---|---|
| A wall placed in the water, resting on the floor | the floor rises; depth is unchanged, so the surface rises by the displaced volume |
| A wall placed in the water, not on the floor | the water that would be trapped below it is added to the column's depth (pushed up) |
| A wall placed above the surface | ignored (bridge or roof) |
| The floor removed (digging) | the floor drops to the next wall below; the water falls into the deeper column |
| A wall removed beside water | the neighbour's floor drops, so the edge starts flowing |
| Water placed by a command (hotbar, `fillRegion`) | its volume is added to the column |
| Water removed by a command | its volume is removed from the column |

Explicit commands may create or delete water; that is not a physics leak (3a assumption). Sand
landing in water is an ordinary wall placement.

### Generation and the editor

- After generation, and when physics resumes after the editor, columns are **rebuilt from the
  voxels**: the floor as above, the depth from the water contiguous above the floor (full cells
  and the surface cell's level).
- Sea, generated lakes and rivers enter this way. Rivers keep the spring at their head and drain
  toward the sea (3a planning deviation 9 still applies).
- Water below a column's floor (a flooded cave under a lake, or under a roof) stays as **static**
  voxel water: not simulated, drawn by the voxel liquid mesher.

## 5. Rendering

### Water surface mesh

- One surface mesh per **chunk column** (32 × 32 world columns), owned by the main thread.
- A grid of vertices at column corners. A corner's height is the average surface of the wet
  columns around it. A dry column has no quad. Lakes are planes, rivers continuous ramps, and
  the edge of a film thins to the ground.
- The surface cuts through the blocky terrain at shores, as in Timberborn; the depth test hides
  the intersection.

### Data path and interpolation

- The sim publishes, in **shared memory** (as the voxel pages already are), each column's
  surface and flux, double-buffered by step parity so the main thread never reads a half-written
  step. The tick message lists the tiles that changed and the buffer to read.
- The main thread copies the changed tiles into two per-vertex height attributes, **previous**
  and **current**, plus a flow attribute, using partial buffer updates.
- The vertex shader interpolates previous → current over the step (50 ms) on a shared clock.
  Water moves smoothly at 60+ fps, one step behind the sim. Nothing appears or vanishes at once:
  a column that gets wet starts at height 0 and rises.

### Waterfalls

Where a wet column's surface is more than ~1 block above a neighbour's surface (or above a dry,
lower neighbour's floor), the mesh adds a **vertical curtain** from the upper surface down to the
lower one, with falling streaks. The curtain's opacity and streak speed follow that edge's flux.

### Current and foam

- Each column's flux gives the direction and speed of the ripple flow map: the river shows its
  real current.
- Shore foam stays thickness-based (3a). **White water** is added where the flow is fast and at
  the foot of curtains.
- The existing water material (depth colour, sun glint, fresnel) is reused.

### Static water

Static voxel water (below a column's floor) keeps the 3a voxel liquid mesher path.

## 6. Performance

- Budget as in 3a: sim tick ≤ 10 ms p95 and ≥ 45 fps during the dam break on the laptop.
- Estimate: ~40 000 awake columns at the peak of the dam break, one integer update per column
  and edge, about 2–4 ms in JS.
- A cap on **awake tiles per step** (a count, in tile order) is a safety net. Tiles are always
  stepped whole, so a cap never splits a column of water across steps.
- The mirror writes only changed columns and never remeshes. The renderer updates only changed
  tiles.

## 7. API and stats

- `SimInitOptions`: `fluidEvery` and `fluidCap` are removed; `waterTileCap` (awake tiles per step)
  is added. `debugFluids` stays as a debug check of the conservation identity.
- `EngineStats`: `fluidActive` / `fluidPools` are replaced by `waterTiles` (awake tiles) and
  `waterColumns` (wet columns in awake tiles). `physicsBusy` is true while any tile is awake, a
  region job runs or a body falls.
- The sandbox HUD's physics line shows the new fields.

## 8. Errors and validation

- Option validation as in 3a (RangeError for non-integer or out-of-range values).
- `debugFluids`: after every step, check `Σ depth + sea` against the running total and that no
  depth is negative; on failure, log and rebuild from the voxels.

## 9. Testing

### Engine unit tests

- Conservation over long runs, with and without edits (fuzz with random edits and springs).
- A lake settles flat; every tile falls asleep; an edit wakes exactly the right tiles.
- Inertia: water released into an empty channel overshoots the final level and settles.
- Waterfall: a ledge pours into a lower basin; volume exact.
- Springs and sea: the identity holds; a spring stops when `sea` is empty.
- Edits: displacement by a wall on the floor; trapped water pushed up; digging lowers the floor;
  water placed and removed by commands.
- Rebuild from voxels (generated sea, lake, river) and the voxel mirror's quantization.
- Determinism: two sims and a replay, 500 ticks.
- Surface mesh: corner averaging, dry columns, curtains, chunk-column borders (Node test of the
  mesh builder).

### Sandbox, e2e and bench

- The flood e2e: breach, the valley fills, everything settles, no console errors.
- A `dig` e2e/hook: a channel cut beside the lake fills.
- `BENCH=1`: dam break and stress, tick p95 and fps.

### Visual checkpoints with the user

1. Dam break.
2. Digging a channel.
3. River and sea.
4. Sand into the lake.
5. Laptop measurements.
