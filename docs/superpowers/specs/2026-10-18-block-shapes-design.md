# Block shapes — design

Date: 2026-10-18. Status: agreed with the user in chat; awaiting their review of this document.

## Why

The colony game's art standard (colony repo, `docs/art/art-direction.md`, 2026-10-18) makes buildings out of blocks,
Hytale/Minecraft style: pitched roofs with eaves, ridges, marked corners and beams. Today the engine draws only whole
cubes, so a roof can only be a stepped staircase of full blocks and a beam is as thick as a wall. The user's call: the
engine gains block **shapes** — half block, stair (with the corner pieces a hip roof needs) and a thin post/beam.

## Goals

- A block type can have a **shape**: `slab`, `stair` or `post` (besides the default whole cube).
- Shaped blocks are drawn with the same tiles as their material's cube: a plank stair shows planks, aligned with the
  plank cubes beside it.
- Stairs make both **gable** and **hip** roofs: straight, outer-corner and inner-corner pieces, right side up and upside
  down.
- A unit builds a shaped block like any other block, one at a time, through the existing build path.
- Shapes keep their orientation in the voxel and survive saves; a blueprint turned by quarter turns turns its shapes'
  orientation with it.
- **Pilot in the colony game:** the simple house (`house`, both levels) gets a hip roof of stairs instead of its flat
  roof of `roof` cubes, to prove the shapes in the real game.

## Non-goals (this project)

- **Walking on shapes.** For now shapes are for roofs and structure only. Units do not stand on a half step, climb
  stairs to an upper floor or step onto a slab. **Recorded as the second part, for later** (user, 2026-10-18): half-step
  standing, stair climbing and slab floors through collision, navigation and unit movement together.
- Rebuilding the colony's buildings in the new style (its own project), new materials or textures (thatch, laid stone…),
  eaves that overhang outside a blueprint's footprint.
- Shapes for liquids, decorated blocks (grass) or `render: false` blocks.
- Fences, panes, doors, ladders, arbitrary models per block.

## Anti-goals

- A shaped block that looks like a different material from its cube (own texture, misaligned texture, different tint).
- Breaking old saves, or changing behaviour for any existing block or game that uses no shapes.
- Missing the mesher's hard gate (`bench/mesher.node.ts`: under 3 ms per chunk on plain Node), or slowing worlds with no
  shaped blocks.

## The shapes

Coordinates in a cell run 0..1. "Facing" is one of the four horizontal directions.

| Shape | Geometry | Orientation (in the voxel's state bits) |
| --- | --- | --- |
| `slab` | half block: bottom half (y 0..½) or top half (y ½..1) | half: bottom / top |
| `stair` | a half slab plus a quarter block on its high side, Minecraft-style | facing (the high side), half: upright / upside down |
| `post` | a square bar about 3/8 block wide through the cell centre | axis: y (post), x or z (beam) |

**Stair corners** are derived, not stored (Minecraft's rule): a stair's drawn form — straight, outer corner or inner
corner, and which side — comes from the stairs next to it with the same half. Roughly: if the stair on its high side
faces across it, it becomes an outer corner; if the stair on its low side faces across it, an inner corner. So a
blueprint only places stairs with a facing, and four rings of stairs facing inward make a hip roof with its corners. The
builder takes the exact rule from Minecraft's and documents it; the derivation only affects drawing.

Orientation lives in the voxel's 4 state bits (`world/voxel.ts`), which shaped blocks have free because they cannot be
liquid or decorated (the registry rejects a shaped block that is). Stair needs 3 bits, slab 1, post 2.

## How shapes behave (engine)

**As a whole cube for everything but drawing.** Until the second part, a shaped block counts as a full cell for
collision, picking, navigation, work poses, build attachment, water (a wall, as any non-air block), gravity and
collapse. In practice a shaped block uses the existing per-id flags (`solid`, `structural`, `falls`, `collapses`), so
none of those systems change.

**Neighbours draw their faces against it.** A shaped block is not opaque for face culling: the stone beside a slab
still draws the face the slab leaves open. A shaped block's own face that fills a whole cell side (a slab's bottom, a
stair's back) is culled against an opaque neighbour like a cube face.

**Light.** A roof of slabs and stairs must shade the inside of a house like a roof of cubes: slabs and stairs block sky
light and block light as their cube would; posts do not. Their own faces are lit from the cells their faces look into,
as cube faces are. How the registry separates "opaque for light" from "opaque for culling" is the builder's call.

**Drawing.**
- Same tiles as the cube of its material, with texture coordinates taken from world position as the chunk mesher does
  today, so a slab shows the lower half of the plank tile and lines up with the plank cube beside it.
- Shadows from the real geometry (shaped blocks cast and receive like chunk meshes do).
- The layer cut works: cells above the cut are hidden, and a shaped block below the cut draws whole.
- Ambient occlusion on shaped faces may be simpler than on cubes (none, or per-cell), as long as nothing looks broken
  next to cubes.
- The current vertex format cannot place sub-block corners (integer 6-bit positions, one spare bit), so shaped blocks
  need either a second geometry path built in the mesh worker with its own vertex format, or instanced box geometry.
  Builder's call; the gate and the "no shapes, no cost" rule above decide it.
- Falling blocks and structural fragments may keep drawing a shaped block as a cube while it falls (known limitation).

**API.**
- `defineBlock({ shape: 'slab' | 'stair' | 'post', … })`, default whole cube. Shaped blocks are ordinary block types,
  appended to a game's block list like any new block (save manifests require a prefix).
- Helpers to pack and read a shape's orientation into a voxel state, and to **turn a shaped voxel by quarter turns** (for
  blueprint rotation). Exact names are the builder's call; they are public engine API and get documented like the rest.
- Optionally, a helper that makes the shaped variants of a material (`plank` → `plank_slab`, `plank_stair`,
  `plank_post`) sharing its textures. Builder's call.

**Sandbox.** The engine sandbox (`apps/sandbox`) gets a scene that shows every shape and orientation, a gable roof, a
hip roof with outer and inner corners, posts and beams, next to cubes of the same material, so a change can be judged by
eye.

## Pilot in the colony game

After the engine part, in the colony repo (engine as submodule, as usual):

- New blocks `roof_stair` and `roof_slab` (and posts only if the roof needs them) using the current `roof` tile. The tile
  itself stays as is: retexturing is the building project's job.
- The `house` blueprint, both levels: the flat roof at h 3 becomes a **hip roof inside the 5 × 5 footprint**, with no
  overhang. Sketch (builder's call on the details): at h 3 the outer ring of upright stairs facing inward and, under the
  next ring, the inner 3 × 3 ring of upside-down stairs; at h 4 the 3 × 3 ring of upright stairs and the centre cap.
  - Every block must be face-attached when its turn comes (the engine refuses a build with no solid face neighbour;
    a ring that only sits diagonally over the one below is not buildable) — hence the upside-down stairs underneath.
  - Seen from inside under the layer cut, the attic reads as a sloped ceiling, not a flat filled one.
  - The roof's top is h 4, one above today's roof: see "Builder reach".
- Blueprint rotation turns each stair's facing with the footprint.
- Placement clearance (today footprint × 4 high) grows to the new roof height.
- Saves: bump `COLONY_VERSION`, the colony's practice for a changed blueprint (old saves are refused, as with every
  earlier sub-project). No migration of old flat-roof houses.
- Order: the colony is mid-way through sub-project 12 (accesses, branch `feat/accesses`, which also appends blocks,
  bumps the version and touches engine workers). The pilot lands **after** SP12 is merged, on top of it; the engine part
  of this project does not wait for it.

### Builder reach

Goblins reach 3 blocks above their feet when building (`BUILD_REACH`, `game/src/shared/balance.ts`); today's roof sits at
that limit, and the hip roof needs 4. **User's call (2026-10-18): the extra reach applies to roof pieces only**, so
nothing else in the game changes (walls, SP12's wall limit `BUILD_REACH + 1`, digging stay as they are).

- Engine: a build can carry its own reach that overrides the worker option for that one build (through the controlled
  unit's build intent; exact API the builder's call). Work-pose search and line of sight use that reach for that build.
- Colony: the house's roof blocks are built with reach 4 (`ROOF_REACH` beside `BUILD_REACH` in `balance.ts`); every
  other block keeps `BUILD_REACH`.

## Testing and acceptance

- Engine unit tests for: the registry rules (shape flags, rejected combinations), orientation packing and quarter-turn
  rotation, stair corner derivation (straight, outer, inner, both halves, all facings), face culling between shapes and
  cubes, light under a slab/stair roof, and that systems keep treating a shaped block as a full cell.
- The mesher gate still passes on its existing chunk (no shapes); a world with no shaped blocks meshes as fast as before.
- A new bench meshes a chunk with dense roofs (several hip roofs' worth of stairs and slabs): it reports its time and
  must stay under the same 3 ms. A chunk filled entirely with stairs is reported, not gated.
- Existing engine and colony suites stay green.
- Acceptance by the user's eye: the sandbox scene, then the pilot house built by goblins in the real game (day and night,
  management camera and layer cut).

## Left to the builder

The drawing technique, the vertex format of the shaped geometry, the light/culling flag split, the exact Minecraft
corner rule, helper names, the post width (about 3/8), and how the colony handles old saves within its versioning
practice.
