# Elovox — Sub-project 3d: Multi-layer water — Design

Status: approved in brainstorming on 2026-10-05 (sections 1–5 approved in chat). Builds on 3c
(`docs/superpowers/specs/2026-10-04-water-heightfield-design.md`).

## 1. Context

3c replaced 3a's automaton with a heightfield: one water layer per column (x, z), flow with
inertia, a smooth interpolated surface. At 3c's first checkpoint (2026-10-04) the user found that
a hole in the middle of a dam, with a solid block above it, does not drain: the column's only
layer sits on top of the dam, and the water under a wall is static. The user moved that case,
and every other "water under something" case, into this sub-project.

| Topic | Decision |
|---|---|
| Cases | All four: **player digging** (a tunnel or hole below a lake's level floods and the lake goes down; the dam hole drains), **generated caves** (flood when connected), **water under bridges and roofs**, **water on a roof** (a pool over a cave, an aqueduct) |
| Pressure | **Communicating vessels**: a tunnel full to its ceiling carries pressure, so water rises up a shaft on the far side to the lake's level |
| Trapped air | **Not simulated**: a chamber fills to its ceiling whenever pressure pushes water in, even with no way out for its air (as in Minecraft or Timberborn) |
| Generated caves | **Dry**: the generator is unchanged; a cave floods only when digging connects it to water. All voxel water, from the generator or the editor, becomes simulated: static water is gone |
| Approach | **Layered heightfield + pressurized bodies as junctions** (§3, §4). Rejected: a compressible overfill (a stiff spring needs a lower gain or oscillates) and 3D cells (cost scales with volume, loses 3c's surface) |

### What 3d keeps from 3c

The pipe step on free surfaces (inertia, friction, `MAX_HEAD`, films, falls and their landing),
sleeping tiles, the sea account and springs, the voxel mirror, displacement on edits, publishing
through shared memory, the surface renderer (interpolation, curtains with arcs, bodies, flares and
splashes, white water, ripples), stats, the `flood` scene, its e2e and bench, and every tuned
constant.

### What 3d removes

Static water (voxel water below a column's floor) and its voxel liquid mesher path; the
`OVERHANG` rule of the rebuild; the rule that a wall placed above the surface is ignored; the
one-layer assumption of `WaterColumns`, the publisher and `SurfaceView`.

## 2. Scope and success criteria

### In scope

1. `@elovox/engine`:
   - segments and edges in place of one layer per column (§3);
   - pressurized bodies (§4);
   - coupling with the voxel world for segments: mirror, edits, rebuild, sea, springs (§5);
   - layered rendering (§6);
   - stats and debug checks (§8).
2. `apps/sandbox`: a `?scene=caves` scene with `__elovox.caves` hooks, its e2e, and the `flood`
   scene, e2e and bench unchanged in behaviour.

### Out of scope

Simulated air (air pockets); aquifers or water placed in caves by the generator; a cutaway view of
the underground; pressure that takes time to cross a tunnel; evaporation, rain, other liquids;
persisting water state (SP6).

### Success criteria

- **Dam hole**: a hole through a dam with solid blocks above it drains the lake down to the
  hole's floor.
- **U-tube**: digging a tunnel under a hill from a lake to a shaft on the far side fills the
  tunnel, and the shaft rises to the lake's level, oscillates a little and settles.
- **Roof hole**: a hole through the roof of a dry cave under a shallow lake pours the lake into the
  cave as a curtain; the cave fills and the lake goes down by the cave's volume.
- **Bridge**: a river flows under a low bridge with no seam in its surface; a bridge deck below
  the water's level is pushed around by pressure, not drowned.
- **No regression**: the `flood` scene looks and moves as in 3c, and its e2e passes.
- **Exact volume**: `Σ depth + sea` is constant under physics (test, fuzz on terrain with caves).
- **Determinism**: two sims and a command-log replay give the same hash over 500 ticks.
- **Laptop budget** (unchanged): sim tick ≤ 10 ms p95 and ≥ 45 fps during the dam break; still
  water and sealed bodies cost nothing per tick.

## 3. Segments and edges

### Segments

Every column (x, z) is an ordered list of **segments**. A segment is a vertical run of air or
water cells between two walls (a wall is any block that is neither air nor the simulated liquid,
as in 3c):

| Field | Meaning |
|---|---|
| `floor` | y of the top face of the wall below (0 on the world floor) |
| `ceil` | y of the bottom face of the wall above (the world's height when open to the sky) |
| `depth` | water depth in 1/SUB block, `0 ≤ depth ≤ cap` |
| `cap` | capacity, `(ceil − floor) × SUB` |

The segment's surface is `S = floor × SUB + depth`. A column under a bridge has two segments (the
river's, from the bed up to the deck, and the deck's, from its top to the sky); a column over a
cave has the cave's and the surface's.

There is **no vertical flow inside a column**: its segments are separated by walls. A shaft or a
hole through a roof is a column whose single segment runs from the cave's floor to the sky, so it
fills and drains like a 3c column.

### Edges

Two segments of neighbouring columns are joined by an **edge** when their runs overlap; the
overlap is the edge's **opening** `[lo, hi)`. A tall segment beside a column with a cave and a
bridge can have several edges on one side. Each edge stores its flux (with inertia, as in 3c) and
its fall code.

### Storage

- Segments live in a **pool** of typed arrays (`floor`, `ceil`, `depth`, column, next segment up),
  with one index per column to its lowest segment.
- Edges live in a pool of their own, rebuilt per pair of columns when an edit changes either
  column's segments.
- Freed slots are reused through free lists. Slot numbers never decide iteration order (§4
  Determinism).
- The common case (one segment, four edges per column) stays compact; multi-layer columns cost
  only where they exist.

### The free step

For free segments (not in a body, §4) the step is 3c's, per edge, with two additions:

1. An edge conducts only while the sender's surface is above the opening's `lo` (generalizing
   3c's "no flux toward a floor at the sender's surface").
2. An **inflow limit**: if a free segment's incoming water this step would exceed `cap − depth`,
   every inflow into it is scaled down (integer multiply, floor divide), as the outflow limit
   scales outflows. A free segment never passes its ceiling.

Falls (`fallColumn`, the brink rule, the plunge) keep 3c's rules, with the landing searched along
the receiver's row **below the receiving segments' ceilings**: ground or a ceiling lower than the
falling water stops the throw.

Volume is exact by construction: every edge moves the same water out of one segment and into
another.

## 4. Pressurized bodies

### Bodies

- A free segment whose depth reaches its capacity is **full**. Full segments joined by edges form a
  **body**.
- A body is identified by the first of its segments in position order (see Determinism below).
- A body has no internal flow. Its **boundary edges** are the edges between one of its segments
  and a free segment.

### The body's level H

- Each boundary edge is accelerated as a 3c edge, with the body side's surface replaced by the
  body's level `H` (friction, `MAX_HEAD`, films, and the cut-off when the free side's surface is
  under the opening and the flow points into the body).
- `H` is the level at which the body's net inflow is zero. Net inflow does not increase as `H`
  rises, so `H` is found by **integer bisection** over at most ~20 rounds of the boundary edges.
  It is exact and deterministic.
- Water entering through one opening leaves through the others in the same step. Pressure crosses
  a tunnel of any length instantly.
- Result: the lake pushes, the tunnel carries, the shaft rises to the lake's level. A U-tube sways
  and settles through friction.

### Slack and hysteresis

- A body keeps its **slack**, `Σ cap − Σ depth ≥ 0`.
- **Net outflow** (a body draining through a low opening): the volume leaving is taken from the
  body's segment with the **highest ceiling** (ties by position). Water leaves from the top, and
  air enters there.
- **Net inflow** is allowed up to the slack. Beyond it, every boundary inflow is scaled down
  together; volume stays exact.
- A segment **leaves** the body only when its deficit (`cap − depth`) exceeds `LEAVE` (a constant,
  first guess 1/8 block, tuned in the plan). Until then it stays in the body with a "bubble" under
  its ceiling, so a segment does not flip in and out each step.
- When a segment leaves, the body is rebuilt by a search over its segments (it may have split).
  When a segment fills, it joins the bodies around it and merges them.

### Sealed bodies and sleep

- A body with no boundary edge (a full, closed chamber) does nothing and costs nothing.
- A body steps when any tile holding one of its boundary edges is awake. A step that moves water
  through a boundary edge wakes that edge's tile, which is how pressure wakes the shaft on the far
  side of a hill.
- A body with no boundary flow costs nothing.

### Edits inside a body

- A wall placed in a body displaces its volume: it leaves through the boundary through `H`, like
  3c's `displace` but through the body's pressure.
- Opening a hole or removing a block adds capacity (slack), and the body draws water from its
  boundary.

### Determinism

Bodies, boundary edges and segments are iterated by position (tile, then column row-major, then
segment bottom-up), never by pool slot. `Simulation.hash()` mixes the segments (by position), the
edge fluxes, the bodies' slack, the sea account and the awake-tile set.

## 5. Coupling with the voxel world

### Mirror

As in 3c, per segment: cells in `[floor, surface)` are water, the surface cell gets a partial
level, cells above it inside the segment that held mirrored water become air. A full segment, or
one in a body, is level 7 throughout; a bubble shows as a partial cell at its top. Mirror writes
still trigger no remesh, light update or wake-up.

### Edits

A write to a column rebuilds that column's segments and its edges to its four neighbours. Volume
is kept exact:

| Edit | Effect |
|---|---|
| A wall placed in cell y of a segment, at or below its surface | The segment splits into `[floor, y)` and `[y + 1, ceil)`. The lower part keeps `min(depth, its cap)`; the water above `y + 1` goes to the upper part; the water that was in cell y is displaced and spread as 3c's `displace` (in a body, through `H`, §4). |
| A wall placed above a segment's surface | The segment splits; no water moves. |
| A wall removed between two segments | They merge into one with the sum of their depths: the upper water drops at once, as digging does in 3c. If the merged segment is full it joins a body. |
| A roof removed above water | The capacity grows; a body gains slack and its boundary changes. |
| Water placed or removed by a command | Its volume is added to or removed from the segment holding the cell. |

### Rebuild from the voxels

After generation, and when physics resumes after the editor:

- every run of air or water cells in a column becomes a segment;
- its depth is the water contiguous above its floor (water floating over air inside a segment
  drops onto it, 3c's rule);
- full segments form bodies.

No static water remains.

### Sea and springs

- **Sea segments** are segments whose surface is at `seaLevel` and that connect, through such
  segments, to the world's edge. A sea under a bridge or a roof counts when it is connected. The
  `sea` account is unchanged.
- A **spring** feeds the segment resting on it (whose floor is the spring block's top). If that
  segment is in a body, its water enters the body up to the slack; what does not fit stays in
  `sea`.

### Editor pause

Unchanged.

## 6. Rendering

### Draw layers

3c draws one grid of 32 × 32 instanced quads per chunk column, with per-corner heights. 3d keeps
that machinery and stacks it in **draw layers**:

- layer 0 is the **highest wet segment** of each column (3c's case);
- layers 1 and up are the other wet free segments below it (a river under a bridge, a lake in a
  cave), from the top down.

An extra layer is allocated only for chunk columns that hold water there, so where there are no
extra layers the cost is 3c's. At most **4 layers per column** are published. A wet segment beyond
that is not drawn and is counted in a stat.

### Corners by connection, not by layer index

A corner's height is the mean of the segment's surface and the surfaces of the segments in the
three other columns around the corner that are **joined to it by an edge** with a surface within
`JOIN`. Diagonal columns count through either orthogonal path. So a river runs under a bridge with
no seam: under the deck it is layer 1, beside it layer 0, and their corners still meet.

### Publishing

Per column and per draw layer, the sim publishes:

- the segment's surface, flux and ceiling;
- per side, the draw layer of the neighbour segment it joins (or none).

The layout is in shared memory, double-buffered by step parity as in 3c.

### What is drawn

- Full segments and bodies have **no free surface and are not drawn**; walls hide them. Wherever
  a body's water meets air there is a free segment, which is drawn.
- **Curtains** come from fall edges, segment to segment, with 3c's arc and landing. The arc is
  limited to stay under the receiving segment's ceiling, so a fall in a low cave throws shorter.
  Water poured through a roof hole into a cave is a vertical curtain down the shaft.
- **Light**: each quad already samples the light in its surface cell, so cave water is dark and
  water under a bridge is shaded with no new mechanism.
- **Ripples**: an edit's ripples go to the segment at the edit's height.

### Removed

The voxel liquid mesher path for static water; the one-layer assumption in `SurfaceView`.

## 7. Performance

- Budget as in 3c: sim tick ≤ 10 ms p95 and ≥ 45 fps on the laptop during the dam break; still
  water costs nothing.
- **Common case** (one segment per column): the step walks edges instead of column borders. Target:
  within **1.2×** of 3c's time on the Node dam-break bench (`bench:dam`), measured before and after.
- **Bodies**: the bisection walks only boundary edges, ~20 times per step. A 200-block tunnel with
  two mouths has a handful of boundary edges.
- **Edits** rebuild only the edited column's and its neighbours' segments and edges. A body search
  runs only when a segment leaves it.
- The tile cap and `THROTTLED_GAIN` keep their 3c rules.

## 8. API, stats and errors

- `EngineStats` gains `waterBodies` (bodies with a boundary in an awake tile) and
  `waterLayersHidden` (wet segments beyond the 4 draw layers). The sandbox HUD shows both.
- Options are unchanged.
- `debugFluids` additionally checks, after every step:
  - `0 ≤ depth ≤ cap` for every free segment;
  - `slack ≥ 0` for every body;
  - that segments and edges match the voxels.
  On failure it logs and rebuilds from the voxels, as in 3c.

## 9. Testing

### Engine unit tests

- Segments and edges from voxels: a bridge, a cave, a shaft, a roof pool.
- Splitting and merging segments on edits, with volume exact.
- U-tube: levels and settles. A shaft rises to the lake's level.
- The dam hole under a solid top drains (3c's checkpoint case).
- A body draining from below frees segments from its top, with hysteresis, no flicker.
- A sealed body stays still and costs no step.
- A spring under a body.
- A river under a bridge, a lake over a cave, a roof hole pouring into a cave.
- Conservation fuzz with random edits on terrain with caves and bridges.
- Determinism: two sims and a replay, 500 ticks.
- Surface mesh: corners join layer 1 of one column to layer 0 of the next; curtains under a
  ceiling; the 4-layer limit.

### Sandbox, e2e and bench

- `?scene=caves`: a lake beside a hill pierced by a U-tunnel and a shaft; a low bridge over a
  river; a dry cave under a shallow lake; a dam with a hole.
- `__elovox.caves` hooks: dig the tunnel, pierce the cave's roof, open the dam's hole.
- A `caves` e2e: each hook's outcome and no console errors.
- The `flood` e2e passes unchanged; `bench:dam` compares against 3c's numbers.

### Visual checkpoints with the user

1. The dam hole drains.
2. Dig the U-tunnel: the shaft rises.
3. Pierce the roof of the cave under the lake.
4. The river under the bridge, with no seam.
5. `flood` regression: 3c's look and speed.
6. Laptop measurements, including those pending from 3c (checkpoint 5 and the main-thread apply
   cost).
