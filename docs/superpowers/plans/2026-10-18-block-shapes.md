# Block Shapes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Blocks can be slabs, stairs (with derived outer/inner corners) and posts/beams, drawn with their material's tiles; the colony's simple house gets a hip roof built from them.

**Architecture:** A shape is a per-block-type property (`BlockDef.shape`); its orientation lives in the voxel's 4 state bits. Everything but drawing and light keeps treating a shaped block as a full cell through the existing `solid`/`structural` flags. Shaped blocks get their own render layer code so the greedy mesher skips them, and a small per-cell pass emits their boxes into the **opaque** quad stream; sub-block corners ride in vertex word B's 12 bits that `w`/`h` occupy today (the shader never reads them), so batches, shadows and the layer cut work unchanged. Light uses a new `blocksLight` table (opaque cubes + slabs + stairs).

**Tech Stack:** TypeScript, three.js r186 TSL (WebGPU/WebGL2), Vitest 4, Playwright (sandbox e2e). Engine repo `C:\Users\pedro\Desktop\Projetos\voxel-engine-shapes` (branch `feat/block-shapes`, from origin main 571d935); colony repo for Part B.

**Spec:** `docs/superpowers/specs/2026-10-18-block-shapes-design.md`

## Global Constraints

- Shapes: `slab`, `stair`, `post` only. No walking on shapes (recorded as the second part, later).
- A shaped block is a full cell for collision, picking, navigation, work poses, build attachment, water, gravity, collapse.
- A shaped block is **not** opaque for face culling; slabs and stairs block light, posts do not.
- Same tiles as the material's cube, texture coordinates from world position (as `chunkVertex.ts` does).
- Shaped blocks cannot be `liquid`, `decoration`, `render: false`, `falls`, or have `layer` other than `'opaque'` (registry throws).
- Post width 3/8 block: boxes at 5/16..11/16.
- Mesher hard gate: `npm run bench:node -w @elovox/engine` under 3 ms/chunk, on its existing chunk and on the new roofs chunk.
- No behaviour change for a registry with no shaped blocks; old saves load (shaped blocks are appended block types).
- Engine commits: no `Co-Authored-By` trailer (the repo's `.claude/settings.json` sets no attribution). Same in the colony repo.
- Code style: match the surrounding code (dense one-line JSDoc on exports, `.ts` import suffixes, no default exports).

## Review Focus

1. **Stairs across a chunk border** — a stair whose corner-deciding neighbour is in the next chunk must show the same form from both chunks' meshes (the padded apron holds it). Test in Task 3.
2. **A cube face looking into a stair/slab cell** — that cell's stored light is 0 (it blocks light), so the visible part of the cube face must not turn black. Test in Task 3.
3. **Upside-down stairs and top slabs** — every form mirrored in y, corners derived only between stairs of the same half. Tests in Tasks 1 and 3.
4. **Blueprint rotation** — a stair placed by a rotated house faces the rotated way; a beam's x/z axis swaps on odd turns. Tests in Tasks 1 and 8.
5. **Layer cut through a roof** — shaped cells above the cut vanish, below draw whole, no cut-flagged face on a shape. Test in Task 3.

---

## File map

Engine (`packages/engine/`):
- Create `src/blocks/shapes.ts` — shape codes, state packing, quarter turns, stair form derivation, boxes per shape. Pure.
- Modify `src/blocks/registry.ts` — `BlockDef.shape`, tables `shape` and `blocksLight`, `LAYER.SHAPE`, validation.
- Modify `src/mesh/vertexFormat.ts`, `src/render/chunkVertex.ts` — word B fine offsets.
- Create `src/mesh/shapes.ts` — the shaped-cell pass. Modify `src/mesh/greedy.ts` (light sample into shaped cells), `src/mesh/mesher.ts`, `src/mesh/tables.ts`, `src/mesh/meshJob.ts`.
- Modify `src/sim/simulation.ts` (light tables), `src/render/fragmentGeometry.ts` (shape layer drawn as cube).
- Modify `src/sim/workers/types.ts`, `src/sim/workers/workers.ts`, `src/sim/systems.ts`, `src/sim/simulation.ts` — per-build reach.
- Modify `src/index.ts`, `src/sim/runSimWorker.ts` — exports. `CONTEXT.md` — glossary.
- Tests: `test/shapes.test.ts` (new), `test/registry.test.ts`, `test/vertexFormat.test.ts`, `test/shapeMesh.test.ts` (new), `test/light.test.ts`, `test/controlledUnits.test.ts`; `test/helpers.ts` gains shaped test blocks.
- Bench: `bench/surface.ts` (roofs chunk), `bench/mesher.node.ts`.

Sandbox (`apps/sandbox/`): `src/blocks.ts`, `src/scene.ts`, `src/scenes/shapes.ts` (new), `src/shapes.worker.ts` (new), `src/main.ts`, `e2e/shapes.spec.ts` (new), textures if a tile is missing.

Colony (Part B): `game/src/shared/blueprints.ts`, `game/src/shared/balance.ts`, `game/src/shared/version.ts`, `game/src/client/blocks.ts`, `game/src/sim/colony/colony.ts`, `game/src/sim/colony/siteWork.ts`, tests under `game/test/`.

---

# Part A — Engine

### Task 1: Shape model (pure)

**Files:**
- Create: `packages/engine/src/blocks/shapes.ts`
- Test: `packages/engine/test/shapes.test.ts`

**Interfaces:**
- Produces (all exported from `src/blocks/shapes.ts`):
  - `type BlockShape = 'slab' | 'stair' | 'post'`
  - `const SHAPE = { CUBE: 0, SLAB: 1, STAIR: 2, POST: 3 } as const` and `SHAPE_CODE: Record<BlockShape, number>`
  - `type Facing = 0 | 1 | 2 | 3` — +x, +z, −x, −z; one quarter turn adds 1 (matches the colony's blueprint `frame`: rotation 1 maps local +x to world +z).
  - `type PostAxis = 'y' | 'x' | 'z'`
  - `slabState(top: boolean): number` (bit 0), `stairState(facing: Facing, upsideDown = false): number` (bits 0–1 facing, bit 2 upside down), `postState(axis: PostAxis): number` (0 y, 1 x, 2 z)
  - `turnShapeState(shape: BlockShape, state: number, quarterTurns: number): number` — stair: facing + turns mod 4, half kept; post: x↔z on odd turns, y kept; slab: unchanged. Negative turns allowed.
  - `type StairForm = { kind: 'straight' } | { kind: 'outer' | 'inner'; side: Facing }`
  - `stairForm(state: number, neighbour: (dx: number, dz: number) => number): StairForm` — `neighbour` returns the stair state of the cell at that horizontal offset, or −1 when it holds no stair.
  - `type Box = readonly [x0: number, y0: number, z0: number, x1: number, y1: number, z1: number]` in sixteenths (0..16)
  - `shapeBoxes(code: number, state: number, form: StairForm): readonly Box[]` — non-overlapping boxes; `form` ignored unless `code === SHAPE.STAIR`.

Stair rule (stair at c, facing F = its high side, same-half neighbours only): let B = c + F and L = c − F. If B is a stair with facing G ⟂ F → `outer` with `side: G`. Else if L is a stair with facing G ⟂ F → `inner` with `side: G`. Else `straight`. Geometry (upright; upside down mirrors y: the slab part is y 8..16, the stepped part y 0..8):
- straight: slab y 0..8 + the F half at y 8..16
- outer (side G): slab + the quadrant on both the F side and the G side at y 8..16
- inner (side G): slab + the F half + the quadrant on the −F side and the G side at y 8..16

- [ ] **Step 1: Write the failing tests** in `test/shapes.test.ts`:

```ts
const vol = (bs: readonly Box[]) => bs.reduce((s, [a, b, c, d, e, f]) => s + (d - a) * (e - b) * (f - c), 0)
it('packs and turns states', () => {
  expect(turnShapeState('stair', stairState(0), 1)).toBe(stairState(1))
  expect(turnShapeState('stair', stairState(3, true), 1)).toBe(stairState(0, true))
  expect(turnShapeState('stair', stairState(1), -1)).toBe(stairState(0))
  expect(turnShapeState('post', postState('x'), 1)).toBe(postState('z'))
  expect(turnShapeState('post', postState('y'), 3)).toBe(postState('y'))
  expect(turnShapeState('slab', slabState(true), 2)).toBe(slabState(true))
})
it('gives each shape its volume', () => {
  expect(vol(shapeBoxes(SHAPE.SLAB, slabState(false), STRAIGHT))).toBe(2048)
  expect(vol(shapeBoxes(SHAPE.STAIR, stairState(0), STRAIGHT))).toBe(3072)
  expect(vol(shapeBoxes(SHAPE.STAIR, stairState(0), { kind: 'outer', side: 1 }))).toBe(2560)
  expect(vol(shapeBoxes(SHAPE.STAIR, stairState(0), { kind: 'inner', side: 1 }))).toBe(3584)
  expect(vol(shapeBoxes(SHAPE.POST, postState('y'), STRAIGHT))).toBe(576)
})
it('places the parts', () => {
  expect(shapeBoxes(SHAPE.SLAB, slabState(true), STRAIGHT)).toEqual([[0, 8, 0, 16, 16, 16]])
  expect(shapeBoxes(SHAPE.STAIR, stairState(0), STRAIGHT)).toContainEqual([8, 8, 0, 16, 16, 16])        // +x high half
  expect(shapeBoxes(SHAPE.STAIR, stairState(0, true), STRAIGHT)).toContainEqual([8, 0, 0, 16, 8, 16])  // mirrored
  expect(shapeBoxes(SHAPE.STAIR, stairState(0), { kind: 'outer', side: 1 })).toContainEqual([8, 8, 8, 16, 16, 16])
  expect(shapeBoxes(SHAPE.POST, postState('x'), STRAIGHT)).toEqual([[0, 5, 5, 16, 11, 11]])
})
it('derives corners like a hip roof', () => {
  // corner (0,0) of a ring facing inward: itself +z, the cell on its high side (+z) faces +x
  const ring = (dx: number, dz: number) => (dx === 0 && dz === 1 ? stairState(0) : dx === 1 && dz === 0 ? stairState(1) : -1)
  expect(stairForm(stairState(1), ring)).toEqual({ kind: 'outer', side: 0 })
  expect(stairForm(stairState(1), (dx, dz) => (dx === 0 && dz === -1 ? stairState(0) : -1))).toEqual({ kind: 'inner', side: 0 })
  expect(stairForm(stairState(1), (dx, dz) => (dx === 0 && dz === 1 ? stairState(0, true) : -1))).toEqual(STRAIGHT) // other half
  expect(stairForm(stairState(1), (dx, dz) => (dx === 0 && dz === 1 ? stairState(1) : -1))).toEqual(STRAIGHT)       // parallel
})
```
(`STRAIGHT = { kind: 'straight' } as const` at the top of the test.) Add one `it.each` over the 4 facings × 2 halves × 3 forms asserting the boxes stay inside 0..16 and do not overlap.

- [ ] **Step 2: Run** `npx vitest run test/shapes.test.ts` in `packages/engine` — expect FAIL (module not found).
- [ ] **Step 3: Implement `src/blocks/shapes.ts`.** Build the upright boxes for facing +x, then rotate them about the cell centre for other facings and mirror y for upside down, so one table serves all orientations.
- [ ] **Step 4: Run** the test again — PASS.
- [ ] **Step 5: Commit** `feat(blocks): block shapes — slab, stair with derived corners, post; state packing and quarter turns`.

### Task 2: Registry knows shapes

**Files:**
- Modify: `packages/engine/src/blocks/registry.ts`
- Modify: `packages/engine/test/helpers.ts` (append to `TEST_BLOCKS`: `stone_slab` shape slab tex `stone`, `stone_stair` shape stair tex `stone`, `stone_post` shape post tex `stone`; `ID` gains `stone_slab: 8, stone_stair: 9, stone_post: 10`)
- Test: `packages/engine/test/registry.test.ts`

**Interfaces:**
- Consumes: `BlockShape`, `SHAPE_CODE` (Task 1).
- Produces: `BlockDef.shape?: BlockShape`; `LAYER.SHAPE = 5`; `BlockRegistry.shape: Uint8Array` (SHAPE codes, 0 for cubes); `BlockRegistry.blocksLight: Uint8Array` (1 when opaque, or slab, or stair).

- [ ] **Step 1: Failing tests** in `registry.test.ts`:

```ts
it('records shapes', () => {
  const r = testRegistry()
  expect([r.shape[ID.stone], r.shape[ID.stone_slab], r.shape[ID.stone_stair], r.shape[ID.stone_post]]).toEqual([0, 1, 2, 3])
  expect(r.layer[ID.stone_stair]).toBe(LAYER.SHAPE)
  expect([r.opaque[ID.stone_slab], r.solid[ID.stone_slab], r.structural[ID.stone_slab]]).toEqual([0, 1, 2])
  expect([r.blocksLight[ID.stone], r.blocksLight[ID.stone_slab], r.blocksLight[ID.stone_stair], r.blocksLight[ID.stone_post], r.blocksLight[ID.glass]]).toEqual([1, 1, 1, 0, 0])
  expect(r.faceLayers(new Map([['stone', 7]]))[ID.stone_stair * 6 + 2]).toBe(7)
})
it.each([
  [{ liquid: true }, 'liquid'], [{ decoration: 'meadow' }, 'decoration'], [{ render: false }, 'render'],
  [{ falls: true }, 'falls'], [{ layer: 'cutout' as const }, 'layer'],
])('rejects a shape combined with %o', (extra, word) => {
  expect(() => new BlockRegistry([{ name: 'x', shape: 'slab', ...extra }])).toThrow(new RegExp(`block "x": shape .*${word}`))
})
```

- [ ] **Step 2: Run** `npx vitest run test/registry.test.ts` — FAIL.
- [ ] **Step 3: Implement.** In the constructor: a shaped block gets `layer = LAYER.SHAPE`, `opaque = 0` (ignoring `opaque`/default), solid as usual; `shape[id] = SHAPE_CODE[d.shape]`; `blocksLight[id] = opaque || shape is slab/stair`. Error text: `` block "${name}": shape "${shape}" cannot be combined with ${word} ``.
- [ ] **Step 4: Run** the whole engine suite `npx vitest run` — PASS (the appended test blocks must not shift existing ids).
- [ ] **Step 5: Commit** `feat(blocks): registry shape and blocksLight tables`.

### Task 3: Drawing shapes

**Files:**
- Modify: `src/mesh/vertexFormat.ts`, `src/render/chunkVertex.ts`, `src/mesh/tables.ts`, `src/mesh/greedy.ts`, `src/mesh/mesher.ts`, `src/mesh/meshJob.ts`, `src/render/fragmentGeometry.ts`
- Create: `src/mesh/shapes.ts`
- Test: `test/vertexFormat.test.ts`, `test/shapeMesh.test.ts` (new), existing `greedy`/`meshJob`/`layerCut` tests stay green

**Interfaces:**
- Consumes: Task 1 (`shapeBoxes`, `stairForm`, `SHAPE`), Task 2 tables.
- Produces:
  - `packB(layer: number, sky: number, block: number, fx = 0, fy = 0, fz = 0): number` — word B becomes layer(12) sky(4) block(4) fx(4) fy(4) fz(4); `unpackB` returns `{ layer, sky, block, fx, fy, fz }`. The vertex position is `(x + fx/16, y + fy/16 − drop/16, z + fz/16)`.
  - `MeshTables.shape: Uint8Array`, `MeshTables.blocksLight: Uint8Array`, `MeshTables.hasShapes: boolean` (from `meshTablesFrom`).
  - `meshShapes(s: ChunkSnapshot, t: MeshTables, out: QuadBuilder): void` in `src/mesh/shapes.ts`.
  - `faceLight(s: ChunkSnapshot, t: MeshTables, pi: number): number` in `src/mesh/shapes.ts` — the packed light a face looking into padded cell `pi` uses: `s.light[pi]` unless that cell is a light-blocking shape, then the brightest of its in-bounds neighbours (sky from above passes 15 unchanged, everything else −1).

Rules for `meshShapes` (skip entirely when `!t.hasShapes`): for every cell of the 32³ chunk whose `t.layer[id] === LAYER.SHAPE`, take its boxes (`stairForm` reads the 4 horizontal neighbours from the padded snapshot, apron included); emit each box face as one quad into the opaque builder with texture `t.faceLayers[id * 6 + f]`, AO 0, light `faceLight` of the cell the face looks into (the neighbour cell for faces on the cell boundary, also for interior faces — the cell in the face's normal direction), never `CUT_BIT`. Skip a face that lies on the cell boundary when the neighbour across is opaque. Hidden faces between a shape's own boxes or between two shapes may be drawn; no coplanar faces facing the same way may overlap (no z-fighting). Greedy's light read for a visible face (`s.light[ni]`) becomes `faceLight(s, t, ni)`; nothing else in `greedy.ts` changes (LAYER.SHAPE already falls through its layer check). `applyOverrides` in `meshJob.ts` uses `blocksLight` where it uses `opaque` for light. `fragmentGeometry.ts` treats `LAYER.SHAPE` as `LAYER.OPAQUE` (falling shapes draw as cubes — spec's known limitation). Shader: read fx/fy/fz from `b` bits 20/24/28 and add `/16` to `local`.

- [ ] **Step 1: Failing tests.** `vertexFormat.test.ts`: `expect(unpackB(packB(4095, 15, 15, 15, 8, 1))).toEqual({ layer: 4095, sky: 15, block: 15, fx: 15, fy: 8, fz: 1 })` (replaces the w/h case). `shapeMesh.test.ts`, with `emptySnap`, `put`, `meshTables`, `countByNormal` from `meshHelpers.ts` and a local `positions(mesh)` that decodes `(x + fx/16, y + fy/16, z + fz/16)` per vertex:
  - `a bottom slab on stone draws 5 faces, its top at y + 0.5` — slab at (5,5,5) on stone at (5,4,5): 0 quads facing −y from the slab, 1 facing +y with every vertex y = 5.5.
  - `stone beside a slab still draws its face` — stone at (6,5,5): it has a −x quad.
  - `a straight stair has no stray faces` — `assertOutwardWinding(opaque)`, quads facing +y total area 1 (two half-cell tops).
  - `a hip roof corner draws an outer corner` — the ring of Task 1's corner case in the mesh: the corner cell's +y quads at y 6 cover exactly the quadrant x 8..16, z 8..16 (relative).
  - `a corner across a chunk border` — the corner stair at local x 31 with its deciding neighbour at the apron x 32: same quads as when both are inside.
  - `a cube face into a stair cell keeps the stair's neighbours' light` — stair at (5,5,5) with `s.light` 0 in its cell and 15 above; stone at (6,5,5) facing −x: its quad's sky is 14 or 15, not 0.
  - `no shapes, no change` — a cube-only snapshot meshes to identical buffers with `meshTables()` and with tables from `new BlockRegistry(TEST_BLOCKS.slice(0, 7))` (same ids, no shaped blocks, `hasShapes` false).
  - `the layer cut hides shapes above it and flags none` — `MeshJobRunner`-free: `applyCut(snap, 0, 5, t.opaque)` then mesh: no vertex above y 6 from the stair at y 6, no shape quad with `CUT_BIT`.
- [ ] **Step 2: Run** `npx vitest run test/vertexFormat.test.ts test/shapeMesh.test.ts` — FAIL.
- [ ] **Step 3: Implement** as specified above. Greedy's `emitQuad` calls `packB(tex, sky, blk)` (the quad's w/h no longer go in the vertex; nothing on the GPU read them).
- [ ] **Step 4: Run** the full engine suite and `npm run typecheck` at the repo root — PASS.
- [ ] **Step 5: Commit** `feat(mesh): draw shaped blocks in the opaque stream with sub-block corners`.

### Task 4: Light under shapes

**Files:**
- Modify: `src/sim/simulation.ts` (the `LightEngine` and store construction at lines ~120 and ~148 get `blocksLight` instead of `opaque` for light; audit every other `registry.opaque` use in `src/sim` and keep culling-only uses on `opaque`)
- Test: `test/light.test.ts`

**Interfaces:**
- Consumes: `BlockRegistry.blocksLight` (Task 2).
- Produces: no new API; `LightTables.opaque` is now fed `blocksLight`.

- [ ] **Step 1: Failing tests** in `light.test.ts` (follow the file's existing world setup):
  - `a slab roof shades the room below` — a 3×3 roof of `stone_slab` over air walled in by stone: the cell under the middle of the roof has sky light < 15 after `initialize()` and after building the roof incrementally (`onVoxelChanged` + `propagate()`), both giving the same value.
  - `a post lets sky light through` — a `stone_post` column: the air cell below it keeps sky 15.
- [ ] **Step 2: Run** `npx vitest run test/light.test.ts` — FAIL.
- [ ] **Step 3: Implement** the table swap.
- [ ] **Step 4: Run** the full engine suite — PASS.
- [ ] **Step 5: Commit** `feat(light): slabs and stairs block light, posts do not`.

### Task 5: Per-build reach

**Files:**
- Modify: `src/sim/workers/types.ts` (`Intent` build variant gets `reach?: number`), `src/sim/workers/workers.ts` (`work`, `startIntent`, `Order`, `canWork`, `workGoals`, `tilesAround`), `src/sim/systems.ts` (`SystemUnits.build`), `src/sim/simulation.ts:644`
- Test: `test/controlledUnits.test.ts`

**Interfaces:**
- Produces: `SystemUnits.build(id: number, pos: Vec3, voxel: number, options?: { reach?: number }): void` — `reach` (integer 1..16, else throws `RangeError('build reach must be an integer 1..16')`) replaces the worker option `buildReach` for this one build only; `Order.reach?: number`; `workers.work(id, kind, pos, voxel = 0, reach?: number)`. Every reach read in `canWork`, `workGoals` and `tilesAround` uses `t.order.reach ?? this.buildReach`.

- [ ] **Step 1: Failing tests** in `controlledUnits.test.ts` (reuse its world/unit setup): with `buildReach: 3`, a unit on flat ground can build at feet + 4 in a 1-wide boxed column only with `{ reach: 4 }` (`built` event), fails `no-access` without it; a later plain `build` from the same unit is again limited to 3; `{ reach: 0 }` and `{ reach: 17 }` throw.
- [ ] **Step 2: Run** `npx vitest run test/controlledUnits.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full engine suite, plus `node bench/workers.node.ts` in `packages/engine` (no regression versus `main`'s run on the same machine) — PASS.
- [ ] **Step 5: Commit** `feat(workers): a controlled build can carry its own reach`.

### Task 6: Public API, bench, sandbox scene, glossary

**Files:**
- Modify: `src/index.ts`, `src/sim/runSimWorker.ts` — export `type BlockShape`, `type Facing`, `type PostAxis`, `slabState`, `stairState`, `postState`, `turnShapeState` (both entries: the colony's sim imports from `@elovox/engine/sim-worker`, its client from `@elovox/engine`)
- Modify: `bench/surface.ts` (export `roofsSnap()`: a chunk with a ground surface and four 7 × 7 hip roofs of stairs with outer corners, inner upside-down rings and a cube peak, plus a slab ridge row and posts), `bench/mesher.node.ts` (gate both snaps at 3 ms, printing each)
- Create: `apps/sandbox/src/scenes/shapes.ts` (generator: flat ground; rows showing every shape × facing × half next to a cube of the same material; a gable roof; a hip roof with outer corners; an L-shaped hip roof with an inner corner; posts and x/z beams framing a wall), `apps/sandbox/src/shapes.worker.ts`
- Modify: `apps/sandbox/src/blocks.ts` (append `planks_slab`, `planks_stair`, `planks_post`, `stone_slab`, `stone_stair` with the cubes' textures), `apps/sandbox/src/scene.ts` (`'shapes'` in `SCENES`), `apps/sandbox/src/main.ts` (worker and size wiring like `diorama`)
- Create: `apps/sandbox/e2e/shapes.spec.ts` — loads `?scene=shapes`, waits for the first meshes, asserts no console errors, saves a screenshot to `test-results/shapes.png`
- Modify: `CONTEXT.md` — add **Block shape**: "A block type's form other than the whole cube — slab, stair or post — drawn with its material's tiles and oriented by its voxel state; every system but drawing and light treats it as a full cell. _Avoid_: model block, partial block."

- [ ] **Step 1:** Add the exports and a type-level check in `test/shapes.test.ts` importing them from `../src/index.ts` and `../src/sim/runSimWorker.ts`. Run — FAIL, then implement, run — PASS.
- [ ] **Step 2:** Add `roofsSnap()` and the second gate; run `npm run bench:node -w @elovox/engine` — both under 3 ms (record both numbers in the commit message body).
- [ ] **Step 3:** Build the sandbox scene; run `npm run e2e -w @elovox/sandbox -- shapes.spec.ts` — PASS; open the screenshot and check by eye: tiles aligned with the cubes, corners correct, no black faces, shadows under roofs.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck` at the repo root — PASS.
- [ ] **Step 5: Commit** `feat: shapes in the public API, roofs bench, sandbox shapes scene`.

**Engine checkpoint:** stop here and report to the user with the sandbox screenshot. The colony part starts after their OK and after SP12 (accesses) is merged into colony main.

---

# Part B — Colony pilot (colony repo)

Start from colony `main` **after SP12 (accesses) is merged**, on a new branch `feat/hip-roof`; point the `engine` submodule at `feat/block-shapes` while developing (merged into engine main at acceptance, as earlier sub-projects did).

### Task 7: Shaped blocks and oriented blueprint blocks

**Files:**
- Modify: `game/src/shared/blueprints.ts` — `BlockName` gains `'roof_stair'`; `LocalBlock` and `BlueprintBlock` gain `state: number`; `LocalPlacer` gains a trailing `state = 0`; the placed blocks' states are turned with `turnShapeState(SHAPE_OF[block], state, rotation)` when the block has a shape; export `SHAPE_OF: Partial<Record<BlockName, BlockShape>> = { roof_stair: 'stair' }`
- Modify: `game/src/client/blocks.ts` — append `defineBlock({ name: 'roof_stair', textures: 'roof', shape: SHAPE_OF.roof_stair })` at the end of `BLOCKS`
- Modify: `game/src/sim/colony/colony.ts`, `game/src/sim/colony/siteWork.ts` — every `packVoxel(ctx.id(b.block), 0)` for a blueprint block becomes `packVoxel(ctx.id(b.block), b.state)` (today: colony.ts lines ~1165, ~1179, ~1629, ~1673 and the swaps in siteWork.ts ~537/~546 — grep `packVoxel(ctx.id(` to find them all after SP12)
- Test: `game/test/blueprints.test.ts` (or the file that tests `placedOf`/`frame` today)

**Interfaces:**
- Consumes: `turnShapeState`, `stairState`, `type BlockShape` from the engine (Task 6).
- Produces: `BlueprintBlock.state`, `SHAPE_OF`.

- [ ] **Step 1: Failing test:** a test-only blueprint (registered in the test) holding one `roof_stair` with `stairState(0)` placed at rotations 0..3 yields states `stairState(0..3)`; a cube block keeps state 0.
- [ ] **Step 2: Run** the colony unit suite filter for the file — FAIL.
- [ ] **Step 3: Implement.** Wherever a level is compared with the one below (`registerBlueprint`'s `changed` filter, `game/src/shared/levels.ts` keep/swap diff), a cell is unchanged only when both its block and its state match.
- [ ] **Step 4: Run** the full colony unit suite and typecheck — PASS (no house uses the stair yet).
- [ ] **Step 5: Commit** `feat(construction): blueprint blocks carry an oriented state; roof_stair block`.

### Task 8: The house's hip roof

**Files:**
- Modify: `game/src/shared/blueprints.ts` (`house` layout, both levels), `game/src/shared/balance.ts` (`ROOF_REACH = 4` beside `BUILD_REACH`), `game/src/shared/version.ts` (bump `COLONY_VERSION` by 1), placement clearance in `checkPlacement` (from "footprint × 4 high" to the blueprint's highest block + 1 over all levels), `game/src/sim/colony/colony.ts` (build roof blocks with `{ reach: ROOF_REACH }`; `isRoofBlock(b: BlueprintBlock): boolean` in `blueprints.ts` is true for a shaped block or a `roof` cube — the sawmill's and plank house's `roof` cubes at h 3 get reach 4 too, harmlessly)
- Test: the colony's blueprint tests and the construction harness test that builds a house to completion

The roof (local lx, lz in the 5 × 5; facings in Task 1's convention, before rotation):
- h 3, the outer ring (`ring(5, 5)` order): upright `roof_stair`, facing inward — row lz 0 → +z (1), row lz 4 → −z (3), column lx 0 → +x (0), column lx 4 → −x (2); the four corners take their row's facing.
- h 3, the inner ring (`HOUSE_INNER` without its last cell [2, 2]): upside-down `roof_stair` facing outward (row lz 1 → −z, row lz 3 → +z, column lx 1 → −x, column lx 3 → +x; corners take their row's facing).
- h 4, the same 8 cells: upright `roof_stair` facing inward (row lz 1 → +z, row lz 3 → −z, column lx 1 → +x, column lx 3 → −x; corners take their row's facing).
- h 4, centre [2, 2]: a `roof` cube (the peak).
- Material `wood` at both levels (level 2 keeps the roof, so it costs nothing new); `HOUSE_WOOD` unchanged (the 33 roof + wall blocks share it).
- Build order: walls as today, then h 3 outer ring, h 3 inner ring, h 4 ring, peak. Every block is face-attached when its turn comes.

- [ ] **Step 1: Failing tests:** the house at level 1 holds 16 + 8 + 8 `roof_stair` and one `roof` at h 4; every roof block has a face neighbour earlier in the build order or below it in the walls; `isRoofBlock` is true for exactly those 33 of the house's blocks; the construction harness builds a house to `done` with `BUILD_REACH` 3 and `ROOF_REACH` 4 (and the level-2 upgrade keeps the roof untouched).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full colony unit + e2e suites and typecheck — PASS.
- [ ] **Step 5: Commit** `feat(construction): the house gets a hip roof of stairs (roof reach 4)`.

**Acceptance:** the user's eye in the real game (dev server from the worktree): goblins build a house, day and night, management camera and layer cut through the attic. Then the opus review of both repos, then merge engine `feat/block-shapes` into engine main, move the submodule, merge colony.
