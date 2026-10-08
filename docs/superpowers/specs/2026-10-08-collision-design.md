# Elovox — Sub-project 4c: AABB collision — Design

Status: the API section (§3) was approved by the expert (sub-project 4 decider) on 2026-10-08. The other sections
await review. Builds on the voxel core (`2026-10-01-voxel-core-design.md`: the registry's `solid` flag, "used by
sub-project 4") and on the water mirror (`2026-10-04-water-heightfield-design.md` §4, `2026-10-05-water-layers-design.md` §5).

## 1. Context

Sub-project 4 adds first person: 4c (this spec) gives the engine a reusable AABB-vs-voxel collision service, and 4d
(fpcontrol) builds the first-person character controller on top of it, in parallel. Today no general collision
exists. Units move on grid paths in the sim worker (Q8 fixed point, `walkSweep`, discrete falls). Those stay as they
are: this API does not replace them and does not touch `sim/`.

| Topic | Decision |
|---|---|
| Shape | **Pure, time-agnostic geometry functions** in the style of `raycast.ts`: displacements in, allowed displacements out. No dt, velocity, gravity or input. Motion policy (gravity, jump, swim, ground snap) belongs to the controller (4d) |
| Module | `packages/engine/src/interact/collision.ts`. Nothing is called "physics": `engine.physics` already means sim physics |
| Binding | `engine.collision`: the same functions bound to the ghost-aware `world.get` (a predicted edit collides at once, as it is drawn) and to `registry.solid` / `liquid` / `source` |
| Solids | `registry.solid` only. Liquids are not solid. Falling blocks, collapse fragments and units are off-grid and do not collide |
| Water | Read from the **voxel water mirror** (liquid id + level in the state bits), not from `SurfaceView` |
| Numbers | float64, world blocks, y up. Pure functions with no `Math.hypot`, so results are reproducible from the same inputs |

## 2. Scope

### In scope

1. `@elovox/engine`:
   - `interact/collision.ts`: the swept move, the move with step-up, the overlap test, the ground query, the liquid
     queries and unstick (§3, §4);
   - its exports appended to `index.ts`;
   - one `engine.ts` hunk: `collision` on the `Engine` interface and on the public object (§5).
2. Unit tests in Node against a fake world, and through the binding over `GhostEdits` (§7).

### Out of scope

Rigid bodies, slopes, capsules and non-cube block shapes; collision with falling blocks, fragments, units or other
entities; gravity, velocity, jumping, swimming and ground snap (controller policy, 4d); sim-side unit movement;
streaming or unloading of chunks (the world stays fully resident).

### Success criteria

- No call ever moves a box into a solid voxel it did not already overlap, at any displacement length (no tunnelling).
- Step-up climbs exactly up to `stepHeight`, never under a ceiling that leaves no room.
- The engine unit suite and `npm run typecheck` pass; no existing test changes.
- fpcontrol builds against the committed API with no change after approval.

## 3. API (approved)

```ts
/** An axis-aligned box in world blocks. Voxel (x, y, z) occupies [x, x+1) × [y, y+1) × [z, z+1). */
export interface Box {
  readonly minX: number; readonly minY: number; readonly minZ: number
  readonly maxX: number; readonly maxY: number; readonly maxZ: number
}
/** The box of a body whose feet centre is (x, y, z): [x−hw, x+hw] × [y, y+height] × [z−hw, z+hw]. */
export function bodyBox(x: number, y: number, z: number, halfWidth: number, height: number): Box

/** What collision reads. `solid`, `liquid` and `source` are the registry's per-id tables. */
export interface CollisionWorld {
  readonly size: WorldSize
  get(x: number, y: number, z: number): number
  readonly solid: Uint8Array
  readonly liquid: Uint8Array
  readonly source: Uint8Array
}

/** Faces closer than this are touching, not overlapping (absorbs float residue at contact). */
export const CONTACT_EPS = 1e-7
/** A box is grounded when solid lies within this distance below it. */
export const GROUND_EPS = 1e-3

export interface SweepResult {
  /** The allowed displacement. */
  dx: number; dy: number; dz: number
  /** That axis moved less than requested. */
  blockedX: boolean; blockedY: boolean; blockedZ: boolean
}
export interface MoveOptions { /** Highest ledge climbed without a jump; default 0 (no step-up). */ stepHeight?: number }
export interface MoveResult extends SweepResult {
  /** After the move, solid lies within GROUND_EPS below the box. */
  grounded: boolean
  /** A positive dy was stopped by solid above. */
  ceiling: boolean
  /** Rise added by step-up, already included in dy; 0 when no step was taken. For camera smoothing. */
  stepped: number
}
export interface LiquidInfo {
  /** Liquid height inside [minY, maxY] over the box height, 0..1: the max over the columns the footprint overlaps. */
  submerged: number
  /** eyeY was given and the point (box centre x, eyeY, box centre z) is under a liquid surface. */
  eyeUnder: boolean
  /** Top of the highest liquid run touching the box in the column that gave `submerged`; null when dry. */
  surfaceY: number | null
}

export function sweepBox(world: CollisionWorld, box: Box, delta: Vec3Like, out?: SweepResult): SweepResult
export function moveBox(world: CollisionWorld, box: Box, delta: Vec3Like, options?: MoveOptions, out?: MoveResult): MoveResult
export function boxOverlapsSolid(world: CollisionWorld, box: Box): boolean
/** How far the box drops before resting on solid, if within maxDown (default GROUND_EPS); null otherwise. Support y = box.minY − result. */
export function groundDistance(world: CollisionWorld, box: Box, maxDown?: number): number | null
export function liquidInBox(world: CollisionWorld, box: Box, eyeY?: number): LiquidInfo
/** Whether the point (x, y, z) is under a liquid surface: inside a liquid voxel, below that voxel's fill. */
export function liquidAt(world: CollisionWorld, x: number, y: number, z: number): boolean
/** The smallest upward lift (≤ maxUp) after which the box overlaps no solid: 0 when it already overlaps none; null when no lift up to maxUp frees it. */
export function unstick(world: CollisionWorld, box: Box, maxUp: number): number | null

/** The functions bound to one world; what `engine.collision` is. */
export interface Collision {
  sweep(box: Box, delta: Vec3Like, out?: SweepResult): SweepResult
  move(box: Box, delta: Vec3Like, options?: MoveOptions, out?: MoveResult): MoveResult
  overlaps(box: Box): boolean
  groundDistance(box: Box, maxDown?: number): number | null
  liquid(box: Box, eyeY?: number): LiquidInfo
  liquidAt(x: number, y: number, z: number): boolean
  unstick(box: Box, maxUp: number): number | null
}
export function bindCollision(world: CollisionWorld): Collision
```

`Vec3Like` is `raycast.ts`'s (`{x, y, z}` or a 3-tuple). `out` parameters let a per-frame caller avoid allocation;
when omitted a new object is returned.

## 4. Semantics

### Cells and contact

A box interval [lo, hi] on one axis overlaps the cells `floor(lo + CONTACT_EPS) … ceil(hi − CONTACT_EPS) − 1`.
Touching faces, and float residue within `CONTACT_EPS`, are not overlap. When a sweep is blocked it puts the leading
face exactly on the voxel plane (`allowed = plane − face`, never past it and never below 0 in the move's direction).

### World bounds

A cell is solid when `x < 0`, `x ≥ size[0]`, `z < 0`, `z ≥ size[2]` or `y < 0`; air when `y ≥ size[1]`; otherwise
`solid[voxelId(get(x, y, z))]`. Liquids are read the same way, with no liquid outside the world.

### The sweep

`sweepBox` moves one axis at a time: **Y first**, then the horizontal axis with the larger |delta| (X on a tie),
then the other. Y first resolves landing and head bumps before horizontal motion; the larger horizontal axis first
keeps diagonal motion against corners symmetric.

For one axis with displacement d > 0 and leading face f (= max on that axis), the sweep visits the slabs of cells
`c = ceil(f − CONTACT_EPS), c + 1, …` while `c < f + d − CONTACT_EPS`. At each slab it checks every cell of the box's
cross-section on the other two axes; the first slab holding a solid cell stops the axis at `max(0, c − f)`. d < 0 is
symmetric (face = min, slabs downward from `floor(f + CONTACT_EPS) − 1`, stop at `min(0, c + 1 − f)`). Every slab the
face crosses is checked, so a displacement of any length cannot tunnel.

The scan is bounded by the world: horizontal scans and downward scans reach solid at the world's sides or floor.
An upward scan stops early, with the full displacement allowed, once its slab is at or above `size[1]` with a
cross-section inside the world (everything above is air).

Non-finite delta components count as 0. A box with a non-finite bound moves by 0 on every axis.

### Overlap and escape

Only cells the leading face newly enters are checked. A box that already overlaps solid (a block edited into it, a
falling block landing in it, a regeneration, a transient read, §8) can always move out of the cells it overlaps, but
never into new solid. `moveBox` applies no automatic push; `unstick` is the explicit recovery.

### Step-up

`moveBox` is `sweepBox` plus step-up:

1. The Y phase sweeps the requested dy. `blockedY` and `ceiling` (dy > 0 and blocked) come from this phase.
2. The horizontal phase sweeps dx, dz in the sweep's order: this is the **plain path**.
3. If `stepHeight > 0`, a horizontal axis was blocked and the box is grounded after the Y phase
   (`groundDistance ≤ GROUND_EPS`), the **step path** starts from the box after the Y phase: sweep up by
   `stepHeight` (a ceiling shortens this lift to h), sweep dx and dz in the same order, then sweep down by h.
4. The step path is taken only if its horizontal progress (dx² + dz²) strictly exceeds the plain path's. Then
   `stepped` is its net rise (≥ 0) and is included in dy; `blockedX`/`blockedZ` are the step path's.
5. `grounded` is computed on the final box.

A ledge higher than `stepHeight`, or one whose top leaves less headroom than the box's height under a ceiling,
gives no progress on the step path and is refused. Walking down stairs and ground snap are controller policy (a
downward `moveBox`).

### Ground

`groundDistance` is a downward sweep of `maxDown` (non-finite or negative → `GROUND_EPS`): the distance moved if it
was blocked, else null.

### Liquid

The fill of a voxel is 0 for a non-liquid, 1 for a spring (`source`), otherwise `((state & 7) + 1) / 8`: the mirror
writes full cells as level 7 and the surface cell as level `part − 1`, with the water at the bottom of the cell.
Every water segment of a column is mirrored, so layered water (under a bridge, in a cave) is seen.

- `liquidAt(x, y, z)`: the cell at `floor` of the point holds liquid and `y < cellY + fill`.
- `liquidInBox`: for each column of the footprint (clipped to the world), the summed overlap of
  `[cellY, cellY + fill)` with `[minY, maxY]` over the cells the box spans; `submerged` is the max over columns
  divided by the box height (0 for a zero-height box). `surfaceY`, in the column that gave the max (first in x,
  then z order), is the top of the highest liquid run touching the box: from its highest liquid cell inside the
  box, climb while the cell is full and the next one is liquid; the top is that cell's y + fill.
  `eyeUnder = eyeY !== undefined && liquidAt(centreX, eyeY, centreZ)`.

### Unstick

`unstick(box, maxUp)` returns 0 when the box overlaps nothing. Otherwise it tries lifts that put `minY` on each
integer above it (`n − minY` for n = floor(minY) + 1, …) while the lift ≤ maxUp, and returns the first lift whose box
overlaps no solid, or null. Clearing a cell needs `minY` at that cell's top, so the smallest free lift is one of these
candidates. A non-finite or negative `maxUp` returns null for an overlapping box.

## 5. Engine binding

One additive `engine.ts` hunk:

```ts
// Engine interface
readonly collision: Collision
// createEngine, beside `world`
const collision = bindCollision({ size, get: world.get, solid: registry.solid, liquid: registry.liquid, source: registry.source })
// public object
collision,
```

`index.ts` appends `bindCollision`, `bodyBox`, the pure functions, the constants and the types on their own lines.

## 6. Performance

The sweep visits (slabs crossed) × (cross-section cells). A body of 0.6 × 1.8 moving 0.5 block per frame reads about
a dozen voxels per axis; one 1024-block horizontal displacement reads at most ~1024 × 6. No allocation when `out` is
passed. No benchmark is planned: the cost is a few hundred `world.get` calls per frame for one player.

## 7. Testing (TDD, Node)

A fake world (a small `Map` or typed grid, with `TEST_BLOCKS`' registry tables) drives the pure functions:

- **Sweep:** free motion; stop on each face (±x, ±y, ±z) exactly at the plane; sliding along a wall when moving
  diagonally; outer and inner corners; a gap exactly the box's width passes, a narrower one does not.
- **Tunnelling:** a 1-voxel wall stops displacements of 0.9, 10 and 10⁴ blocks; a 1-block floor stops a fall of 10⁴;
  high speed across chunk borders (x = 31/32).
- **World bounds:** the sides and the floor stop the box; the top lets it rise above `size[1]` and comes back; a
  huge upward displacement terminates.
- **Contact residue:** a box resting on a face within float residue does not count as overlapping and can slide.
- **Non-finite input** gives zero motion.
- **Step-up:** climbs a 0.5 and a 1.0 ledge with stepHeight 1; refuses 1.0 with stepHeight 0.6; refused under a
  ceiling with too little headroom; not taken in the air; not taken when it gains no horizontal progress; `stepped`
  equals the rise; diagonal against a tall wall with a free axis does not bob.
- **Ceiling:** a jump into a ceiling sets `ceiling` and `blockedY`.
- **Ground:** resting, hovering within and beyond `maxDown`, over a world-floor edge.
- **Overlap and escape:** a block edited into the box: the box can move out but not further into solid;
  `boxOverlapsSolid` for the "refuse placing into the player" check; `unstick` returns the smallest lift, 0 when
  free, null beyond maxUp or under a ceiling.
- **Liquid:** full and partial cells, springs, a box straddling a shore (max over columns), water under a bridge
  deck (two runs), `surfaceY` in deep water above the box, `eyeUnder` just above and below a partial surface,
  outside the world.
- **Binding:** `bindCollision` over `ghostAwareGet(GhostEdits, base)`: a ghost block collides before its ack; a
  ghost air block lets the box through.

## 8. Limitations

- `WorldReader.get` returns air for a chunk whose memory page has not reached the main thread yet (a short window
  while the sim allocates a page). Collision cannot tell it from real air; a body may sink into such a chunk for a
  frame and then overlap solid. The escape rule and `unstick` are the recovery. Accepted by the expert.
- A box that starts outside the world's x/z bounds is stuck (every slab ahead is outside, hence solid). Callers keep
  bodies inside the world.
- Off-grid moving geometry (falling blocks, fragments, units) does not collide.
