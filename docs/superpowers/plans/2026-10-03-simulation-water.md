# Sub-project 3a: Simulation (water, falling blocks, spreading) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Water that flows with levels and conserves its volume. Lakes drain flat through a breach. Springs feed rivers through a water cycle with the sea. Sand and gravel fall smoothly. Grass, mud and decorations react to water over time.

**Architecture:**
- Two new engine systems run inside `Simulation.step()`:
  - a **fluid system**: a two-phase cellular automaton for moving water, plus **pools** for still water. A pool's exact volume moves its whole surface flat, and region jobs maintain the pools.
  - a **gravity system**: falling bodies that leave the grid while they fall.
- Both see every voxel write through hooks in `applySet`. Their state is part of `Simulation.hash()`.
- Rendering adds:
  - interpolated falling cubes;
  - a flow direction in the liquid vertex, which the water shader scrolls along.
- Content (grass, wetness, decoration growth) stays in sandbox rules on an extended `RuleContext`.

**Tech Stack:** TypeScript (strict), three.js 0.186.1 WebGPU/TSL, Vite, Vitest 4, Playwright, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-03-simulation-water-design.md`

## Global Constraints

- World state is integers only. Fluids and gravity use no `Math.random`, `Date` or `performance.now`, and no floats in stored state. Every iteration order is fixed: insertion-ordered queues, `Map`/`Set` insertion order, pools by id, chunks by index.
- Per-tick work caps are **counts**, never time:
  - `workCap` (rules, default 50 000);
  - `fluidCap` (default 20 000 cell updates per fluid step);
  - `jobCap` (default 50 000 visited cells per tick).
- The fluid step runs every `fluidEvery` ticks (default 2, so 10 Hz at 20 Hz).
- `outletRate` defaults to 8 units per outlet (or contact face) per fluid step.
- Cell state for liquids:
  - level 0–7 in bits 0–2, so the volume is `level + 1` units (1–8);
  - bit 3 stays free;
  - generated water keeps level 7.
- A source block (spring) counts as full (level 7) everywhere, whatever its state bits hold. Its state bits are a flow index into `SPRING_RATES = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 40, 48, 56, 64, 96, 128]`.
- Falling bodies:
  - `y256` in 1/256 block;
  - gravity `+24` per tick;
  - terminal speed `512` (2 blocks per tick).
- Water flows only into **air**. Every other non-liquid block, solid or not, is a wall for water (see Planning deviations).
- `SLEEP_STEPS = 4`, `DROP_REACH = 4`, `MAX_RESTARTS = 3`.
- Laptop budgets (spec §2): sim tick ≤ 10 ms p95 and ≥ 45 fps during the dam break; random ticks at 24 per chunk ≤ 2 ms per tick.
- Repo artifacts are in English. Commits have no `Co-Authored-By` trailer: the project's `.claude/settings.json` sets no `attribution.commit`.
- Engine tests live in `packages/engine/test/*.test.ts` (Vitest, Node environment). Run them from the package directory: `cd packages/engine && npx vitest run test/<file>`.
- The e2e needs `--workers=1`. Use `E2E_PORT=5174` if a stale dev server holds :5173.

## Review Focus

These inputs are implied by the spec but not exercised by any task's own tests unless pinned here. Each one has a test added to the task named.

1. **Writes into a frozen pool.** A `setBlock` or `fillRegion` lands on a pool's surface while its resurface or split job is pending. The pool must stay consistent after the job finishes: flat, invariants hold, volume exact. *Test added in Task 7.*
2. **World edges.** Water at x = 0, z = size − 1, y = 0 and y = top. Fluids must never read, write or register outlets outside the world, and water must not leak out of an edge. *Test added in Task 5.*
3. **Uniform water chunks.** A chunk that is entirely water (deep sea) has no slot. The rebuild must find its pool, and writing into it (digging, draining) must work. *Test added in Task 4.*
4. **Pause, regenerate, resume.** `replaceColumns` runs while physics is paused. On resume the old fluid state is discarded and rebuilt: no crash, no stale pool ids, volume consistent with the new world. *Test added in Task 9.*
5. **Springs at odd places.** A spring next to the cycle pool injects nothing, because there is no net change. A spring the player removes stops being processed. A spring walled in on every side injects nothing and the debit stays 0. *Test added in Task 8.*

---

## Planning deviations from the spec

Each was found while reading the code and is accepted here. The spec stays the source for everything else.

1. **Water flows only into air.** The spec says "non-solid cell". Torches and other non-solid, non-liquid blocks are walls for water, so the fluid system never destroys blocks. A falling body still destroys a torch it lands on (spec §6).
2. **The automaton is two-phase.** Each step, every active cell *proposes* transfers from the same snapshot, and the proposals are applied in queue order, capped by the receiver's room. This removes order bias and writes each changed cell once. Side order still rotates with the fluid-step counter, because a sender splits its water among sides one after another.
3. **Pools are column-owned, and two pools may touch.**
   - A deep cell belongs to the pool its water column reaches when walked up. A cell capped by a ceiling belongs to the pool recorded in a capped map.
   - Two pools whose cells are face-adjacent are a **contact**. Water moves from the higher to the lower by exact heights, `H = (surfaceY·8 + level)·area + balance`. When the heights meet on the same `surfaceY`, the two pools merge.
   - This replaces the spec's "a pool cell next to a lower pool acts as an outlet of the higher". The effect is the same, and it keeps every pool flat.
4. **Merges are instant.** A merge aliases the higher id to the lower one, so it needs no region job. A resurface job normalises the levels only when the two levels differ.
5. **Rebuild is synchronous.** After `replaceColumns` (the terrain panel or the editor), the next unpaused fluid step drops all fluid state and rescans the whole world in that tick. Generation does the same at the end of `finishGenerate`. The spec's "region job over pool-dirty chunks" is dropped: rescanning the sea after any coastal edit costs about the same, and a full rescan cannot go stale.
6. **Outlets need support (and a closed top) to join.**
   - A cell joins a pool only when it rests on a solid, on the world floor, or on a member cell.
   - Below the surface it also needs a member or a ceiling above it.
   - Water the pool pushes into any other outlet runs through the automaton. That covers a hole in the bed with air below, and a breach opening onto a lower floor: the water falls or spreads as a stream, fills the low area from the bottom, and meets the lake later through a contact.
   - Without this rule, a breach would fill the whole valley at once at the lake's height. A scan applies the same rule (`ownsColumn`), so stepped water becomes pools in contact rather than one pool forced flat at its highest step.
7. **Flow direction takes 5 bits, not 4.**
   - The encoding is moving, steep and 8 directions. It uses the 2 reserved bits of word A plus bits 9–11 of word B.
   - Liquid faces must use a texture layer below 512, and `meshTablesFrom` asserts it.
   - The liquid material decodes its layer with `b & 511`.
8. **Displaced water with no room is counted.**
   - Water displaced by a solid, outside a pool, goes up its column (at most 8 cells), then to the four sides at each step.
   - If it finds no room, the remainder is added to `fluids.lost` and logged. The conservation identity includes `lost`.
9. **Rivers drain at load.** Generated rivers are stepped water. Under conserved volume, connected water seeks one level, so at load each river drains toward the sea through contacts and outlets. What remains is a spring-fed stream along the carved bed, which is the "shape the sim gives" the user chose. The spec's "may differ slightly" understates this, and the spec is corrected in Task 14.
10. **Pausing also stops region jobs.** Jobs are physics. `setPaused(true)` stops gravity, fluids and jobs; rules, random ticks and light keep running.

---

## Design notes (shared by Tasks 3–9)

Read this before any fluid task. Names here are the code's names.

### Cells

- A **flow liquid** is a liquid that is not a source. `flowGroup(v)` returns its group (the base liquid's block id), or 0.
- `volumeOf(v)` is `(state & 7) + 1` for a liquid, 8 for a source, and 0 otherwise.
- `liquidVoxel(group, units)` builds the voxel, or air for 0 units.
- `FULL = 8`.

### Members and ownership

A cell is either a **member** of exactly one pool or not. Membership is stored three ways:

| Structure | What it holds |
|---|---|
| `members: ChunkBits` | One bit per member cell, allocated per chunk on demand |
| `index: SurfaceIndex` | Sparse 32 × 32 `Int32Array` tiles per (chunk column, y), mapping a surface cell to its pool id (0 = none) |
| `pools.capped: Map<voxelIndex, poolId>` | Member cells that are the top of their member column but sit below the pool's `surfaceY` (a ceiling or air above) |

`pools.ownerOf(x, y, z)` returns undefined for a non-member. For a member, it walks up member cells; at each one it checks the surface index (the entry must resolve to a pool whose `surfaceY` is that y), then the capped map, and stops at the first hit.

**Invariants of a live pool `p`:**
- every surface cell has level `p.level`, is a member, and has an index entry resolving to `p`;
- every deep member cell is full;
- `p.grid` is the sum of its members' volumes;
- its true volume is `p.grid + p.balance`.

### Water height

`H(p) = (p.surfaceY * 8 + p.level) * p.area + p.balance`. Pool a is higher than pool b when `H(a) * b.area > H(b) * a.area`. Every product stays below 2^53.

### Fluid step

The step runs every `fluidEvery` ticks, when not paused:

1. Rebuild if `needsRebuild`.
2. `flowCells()`: the automaton, with inlets handled first for cells next to a pool.
3. `runOutlets()`: each pool fills its outlets.
4. `runContacts()`: water moves between touching pools; equal pools merge.
5. `runSprings()`.
6. `queueResurfaces()`: start a resurface job for every pool whose `|balance| ≥ area`.
7. `queueSettles()`: start a settle scan for every cell that fell asleep.

Region jobs run after the fluid step (Simulation phase 5).

### A cell next to a pool (`inlet`)

Pools are visited in id order, skipping frozen pools and other liquids.

1. If the cell is at `surfaceY + 1` above a surface cell of `p` and `p` accepts its volume, the cell's volume goes to `balance` and the cell becomes air.
2. If the cell is at `y ≤ surfaceY` and **unsupported** (air or non-member water below), register it as an outlet of `p` and let the automaton move it.
3. If it is supported and at `y == surfaceY`:
   - `v > level+1`: credit the excess to `balance`, set the cell to `level+1`, and join.
   - `v == level+1`: join.
   - `v < level+1`: register it as an outlet; the pool fills it.
4. If it is supported and at `y < surfaceY`:
   - It joins only when it is full **and** the cell above is a member of `p` or a ceiling (anything but air and flowing liquid).
   - Otherwise it is registered as an outlet, and the automaton spreads it. The pool keeps feeding it, so water pushed out sideways onto a lower floor spreads as a stream and fills that area from the bottom.
   - The automaton never builds a wall at the lake's height. The newly filled area becomes its own lower pool, then meets the lake through a contact.

### Outlets

A pool fills each outlet once per fluid step, in insertion order. The outlet must be air or non-member water of the pool's liquid, must touch a member of the pool, and must have `y ≤ surfaceY`.

| Outlet | Fill target |
|---|---|
| Below the surface layer | Toward 8 |
| On the surface layer, directly above a member | Toward `level+1` |
| On the surface layer, otherwise | Toward `level+1`, only if `level ≥ have + 1` (the automaton's "difference ≥ 2" rule); else the outlet is dropped |

Each fill is at most `outletRate` and at most the pool's volume.

### Accepting water

`accepts(p, t)` is `!p.sealed || p.balance + t < p.area`. A sealed pool is one that could not add a layer because everything above its surface is solid.

### Resurface

A resurface job collects the pool's surface cells from its tiles. Its `finish` does the following, in order:

1. Normalise levels, in case a merge left mixed levels.
2. Move whole levels while `balance ≥ area` or `balance ≤ −area`.
3. **Layer up** (from level 7): new level-0 cells on the air above the surface.
4. **Layer down** (from level 0): remove the surface layer and start a **split** scan of what is left.

### Scans (`PoolScan`)

A scan is a BFS from seeds, sorted highest y first. A seed must be a claimable top cell; it fixes the component's `surfaceY` and level.

| Cell | Claimed when |
|---|---|
| At `surfaceY` | Same liquid, claimable, same level, and a top (no same-liquid water above) |
| Below `surfaceY` | Same liquid, claimable, full, and its water column ends at this surface (same level) or under a ceiling (`ownsColumn`). A column ending lower with air above is a separate, lower body. |
| Above `surfaceY` | Never visited |

While it runs, the scan records:
- air at `y ≤ surfaceY` as outlets;
- same-liquid cells it did not claim as **edges**, which become contacts or activations at finish.

Three kinds use it:

| Kind | When | Claimable |
|---|---|---|
| `rebuild` | Synchronous | Not a member |
| `settle` | Job | Not a member and not active |
| `split` | Job | A member owned by the old pool, or by no pool |

## File structure

### `packages/engine/src`

| File | Change | Responsibility |
|---|---|---|
| `blocks/registry.ts` | modify | `falls`, `source`; tables `falls`, `source`, `liquidGroup` |
| `sim/rules.ts` | modify | `RuleContext`: `isSolid`, `isLiquid`, `isOpaque`, `falls`, `skyLight`, `blockLight`, `level` |
| `sim/jobs.ts` | create | `JobReader`, `RegionJob`, `JobRunner`: budgeted, restartable region jobs |
| `sim/fluids/cell.ts` | create | `FULL`, `SPRING_RATES`, `volumeOf`, `flowGroup`, `liquidVoxel`, `isSource` |
| `sim/fluids/chunkBits.ts` | create | Sparse per-voxel bit set, allocated per chunk |
| `sim/fluids/surfaceIndex.ts` | create | Surface cell → pool id, in 32 × 32 tiles per (chunk column, y) |
| `sim/fluids/pools.ts` | create | `Pool`, `PoolTable`: create, alias/merge, ownership walk-up, capped map |
| `sim/fluids/contacts.ts` | create | `ContactTable`: face pairs between touching pools |
| `sim/fluids/activeQueue.ts` | create | `ActiveQueue`: deduplicated FIFO of moving cells with idle counters |
| `sim/fluids/scan.ts` | create | `PoolScan` region job (rebuild, settle, split) |
| `sim/fluids/resurface.ts` | create | `Resurface` region job |
| `sim/fluids/fluidSystem.ts` | create | `FluidSystem`: hooks, automaton, inlets, outlets, contacts, springs, rebuild, hash |
| `sim/gravity.ts` | create | `GravitySystem`: falling bodies |
| `sim/simulation.ts` | modify | Write hooks, chunk epochs, systems, pause, step order, hash, options |
| `sim/generator.ts` | modify | `configure` may return `{ seaLevel }` |
| `sim/simHost.ts` | modify | `setPaused`; tick carries `falling`/`landed` |
| `sim/runSimWorker.ts` | modify | Re-export `WriteSource`, `FluidOptions` types |
| `protocol.ts` | modify | `setPaused` message; tick fields |
| `engine.ts` | modify | `engine.physics`, the falling-cube renderer, `engine.fluids` stats |
| `render/meshQueue.ts` | modify | `appliedVersion(ci)` |
| `render/fallingTrack.ts` | create | Pure body tracking and interpolation, tested in Node |
| `render/falling.ts` | create | Instanced falling cubes (three.js) |
| `mesh/vertexFormat.ts` | modify | `packFlow` / `unpackFlow`, `FLOW` codes |
| `mesh/tables.ts` | modify | `liquidGroup`, `source`; the liquid layer < 512 assertion |
| `mesh/liquid.ts` | modify | Liquid groups, sources at full level, flow per face |
| `render/chunkVertex.ts` | modify | `liquid` mode: `layer = b & 511`, flow varying |
| `render/materials.ts` | modify | Builds the liquid slot in liquid mode |
| `render/water.ts` | modify | Ripples scroll along the flow; faster cascade streaks |
| `render/decorations/defs.ts` | modify | `stateDensity` |
| `render/decorations/extract.ts` | modify | Thins instances by `stateDensity` |
| `index.ts` | modify | Exports |

### Engine tests (`packages/engine/test`)

- New: `fluidHelpers.ts`, `jobs.test.ts`, `fluidPrimitives.test.ts`, `poolScan.test.ts`, `fluidCells.test.ts`, `pools.test.ts`, `resurface.test.ts`, `contacts.test.ts`, `fluidWorld.test.ts`, `gravity.test.ts`, `fallingTrack.test.ts`.
- Extended: `registry.test.ts`, `simulation.test.ts`, `simHost.test.ts`, `liquid.test.ts`, `vertexFormat.test.ts`, `decorations.test.ts`, `meshQueue.test.ts`, `determinism.test.ts`.

### `packages/terrain`

- `src/doc/types.ts`: `BlockNames.spring`.
- `src/ops/registry.ts`: `HeightOp.spring?`.
- `src/ops/river.ts`: `flow` param and spring.
- `src/pipeline/compile.ts`: `blocks.spring`.
- `src/pipeline/region.ts`: places springs.
- `src/generator.ts`: `configure` returns `{ seaLevel }`.
- Tests: `test/fixtures.ts`, `test/waterOps.test.ts`, `test/pipeline.test.ts`, `test/generator.test.ts`.

### `packages/terrain-editor`

- `src/ui/panels/toolbar.ts`: the "Simulate physics" checkbox.
- `src/ui/editor.ts`: pauses physics while attached; the toggle.

### `apps/sandbox`

- Modified: `src/blocks.ts`, `src/rules.ts`, `src/paint/materials.ts`, `src/paint/index.ts`, `src/main.ts`.
- New: `src/scenes/flood.ts`, `src/flood.worker.ts`.
- Tests: `test/rules.test.ts` (new), `test/flood.test.ts` (new), `test/painter.test.ts` (modified).
- E2E: `e2e/flood.spec.ts`, `e2e/flood-bench.spec.ts`.

---

### Task 1: Registry flags, rule-context reads, and cheaper writes

**Files:**
- Modify: `packages/engine/src/blocks/registry.ts`
- Modify: `packages/engine/src/sim/rules.ts`
- Modify: `packages/engine/src/sim/simulation.ts` (`applySet`, `makeContext`, constructor)
- Test: `packages/engine/test/registry.test.ts`, `packages/engine/test/simulation.test.ts`

**Interfaces:**
- Produces:
  - `BlockDef.falls?: boolean` and `BlockDef.source?: string`.
  - `BlockRegistry.falls: Uint8Array`, `.source: Uint8Array` (1 for a spring) and `.liquidGroup: Uint16Array`: the base liquid's id for a liquid or a spring, 0 otherwise.
  - New `RuleContext` methods:
    - `isSolid(v)`, `isLiquid(v)`, `isOpaque(v)`, `falls(v)`: `boolean`;
    - `skyLight(x, y, z)`, `blockLight(x, y, z)`: `number` (0–15);
    - `level(v)`: `number`. A liquid's level, 7 for a source, −1 for anything else.
  - `Simulation` skips `light.onVoxelChanged` when only the state changes (same id). It queues neighbour notifications only if some block defines `onNeighborChanged`.

- [ ] **Step 1: Write the failing registry tests**

Append to `packages/engine/test/registry.test.ts`, inside the `describe('BlockRegistry', …)` block:

```ts
  it('records falls, springs and liquid groups', () => {
    const r2 = new BlockRegistry([
      defineBlock({ name: 'water', liquid: true }),
      defineBlock({ name: 'spring', liquid: true, source: 'water', textures: 'water' }),
      defineBlock({ name: 'sand', falls: true }),
      defineBlock({ name: 'stone' }),
    ])
    const [water, spring, sand, stone] = [1, 2, 3, 4]
    expect(r2.falls[sand]).toBe(1)
    expect(r2.falls[stone]).toBe(0)
    expect(r2.source[spring]).toBe(1)
    expect(r2.source[water]).toBe(0)
    expect(r2.liquidGroup[water]).toBe(water)
    expect(r2.liquidGroup[spring]).toBe(water)
    expect(r2.liquidGroup[stone]).toBe(0)
    expect(r2.liquidGroup[0]).toBe(0)
  })
  it('rejects falls on a liquid and bad sources', () => {
    expect(() => new BlockRegistry([defineBlock({ name: 'w', liquid: true, falls: true })])).toThrow(/falls cannot be combined with liquid/)
    expect(() => new BlockRegistry([defineBlock({ name: 's', source: 'w' })])).toThrow(/source needs liquid: true/)
    expect(() => new BlockRegistry([defineBlock({ name: 's', liquid: true, source: 'nope' })])).toThrow(/names "nope", which is not a block/)
    expect(() => new BlockRegistry([defineBlock({ name: 'stone' }), defineBlock({ name: 's', liquid: true, source: 'stone' })]))
      .toThrow(/must be a liquid that is not itself a source/)
    expect(() => new BlockRegistry([
      defineBlock({ name: 'w', liquid: true }),
      defineBlock({ name: 'a', liquid: true, source: 'w' }),
      defineBlock({ name: 'b', liquid: true, source: 'a' }),
    ])).toThrow(/must be a liquid that is not itself a source/)
  })
```

- [ ] **Step 2: Write the failing simulation tests**

Append to `packages/engine/test/simulation.test.ts` (a new `describe` at the end of the file):

```ts
describe('rule context reads and write trimming', () => {
  it('reads registry flags, light and liquid levels', () => {
    const seen: Record<string, unknown> = {}
    const r = defineRules({
      commands: {
        probe(ctx) {
          seen.solid = [ctx.isSolid(ID.stone), ctx.isSolid(ID.water), ctx.isSolid(AIR)]
          seen.liquid = [ctx.isLiquid(ID.water), ctx.isLiquid(ID.stone)]
          seen.opaque = [ctx.isOpaque(ID.stone), ctx.isOpaque(ID.glass)]
          seen.falls = [ctx.falls(SAND), ctx.falls(ID.stone)]
          seen.level = [ctx.level(ctx.withState(ID.water, 3)), ctx.level(ID.stone)]
          seen.sky = ctx.skyLight(10, 60, 10)
          seen.block = ctx.blockLight(10, 60, 10)
        },
      },
    })
    const blocks = [...TEST_BLOCKS, defineBlock({ name: 'sand', falls: true })]
    const sim = new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks, rules: r, seed: 1 })
    sim.submit(1, 0, { type: 'probe' })
    sim.step()
    expect(seen).toEqual({
      solid: [true, false, false], liquid: [true, false], opaque: [true, false], falls: [true, false],
      level: [3, -1], sky: 15, block: 0,
    })
  })
  it('does not relight when only a block state changes', () => {
    const sim = makeSim()
    sim.submit(1, 0, { type: 'setBlock', pos: [5, 5, 5], voxel: ID.water })
    sim.step()
    const spy = vi.spyOn(sim.light, 'onVoxelChanged')
    sim.submit(1, 1, { type: 'setBlock', pos: [5, 5, 5], voxel: (3 << 12) | ID.water })
    sim.step()
    expect(spy).not.toHaveBeenCalled()
    expect(sim.store.getVoxel(5, 5, 5)).toBe((3 << 12) | ID.water)
  })
  it('queues no neighbour notifications when no block listens for them', () => {
    const quiet = defineRules({ blocks: { grass: { onRandomTick() {} } } })
    const sim = new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks: TEST_BLOCKS, rules: quiet, seed: 1 })
    sim.submit(1, 0, { type: 'fillRegion', min: [0, 0, 0], max: [9, 9, 9], voxel: ID.stone })
    sim.step()
    expect(sim.pendingWork).toBe(0)
  })
})
```

At the top of the file, change the vitest import to `import { describe, expect, it, vi } from 'vitest'`. `SAND` is already defined as 8: the test passes `SAND` as a voxel id against its own block list, where sand is also id 8.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/engine && npx vitest run test/registry.test.ts test/simulation.test.ts`

Expected: FAIL. The new registry tests fail with "Cannot read properties of undefined" on `r2.falls`. The probe test fails with "ctx.isSolid is not a function".

- [ ] **Step 4: Implement the registry flags**

In `packages/engine/src/blocks/registry.ts`, extend `BlockDef`:

```ts
export interface BlockDef {
  name: string
  textures?: string | { top: string; side: string; bottom: string }
  solid?: boolean
  opaque?: boolean
  layer?: RenderLayer
  emits?: number
  liquid?: boolean
  decoration?: string
  /** Falls when the cell below is air or a flowing liquid (sand, gravel). Cannot be combined with `liquid`. */
  falls?: boolean
  /** Makes this liquid block a spring of the named liquid: it counts as full and injects that liquid every fluid step. */
  source?: string
}
```

Add the fields and fill them. In the class body, after `readonly emits: Uint8Array`, add:

```ts
  readonly falls: Uint8Array
  /** 1 for a spring (a liquid with `source`). */
  readonly source: Uint8Array
  /** The base liquid's id for a liquid or a spring; 0 for every other block. */
  readonly liquidGroup: Uint16Array
```

In the constructor, allocate them next to the others:

```ts
    this.falls = new Uint8Array(this.count)
    this.source = new Uint8Array(this.count)
    this.liquidGroup = new Uint16Array(this.count)
```

Inside the `all.forEach` callback, after `const liquid = d.liquid ?? false`:

```ts
      const falls = d.falls ?? false
      if (falls && liquid) throw new Error(`block "${d.name}": falls cannot be combined with liquid`)
      if (d.source !== undefined && !liquid) throw new Error(`block "${d.name}": source needs liquid: true`)
      this.falls[id] = falls ? 1 : 0
```

After the `forEach`, resolve the groups. Every name is registered by then:

```ts
    all.forEach((d, id) => {
      if (!this.liquid[id]) return
      if (d.source === undefined) { this.liquidGroup[id] = id; return }
      const target = this.ids.get(d.source)
      if (target === undefined) throw new Error(`block "${d.name}": source names "${d.source}", which is not a block`)
      if (!this.liquid[target] || all[target]!.source !== undefined) {
        throw new Error(`block "${d.name}": source "${d.source}" must be a liquid that is not itself a source`)
      }
      this.source[id] = 1
      this.liquidGroup[id] = target
    })
```

- [ ] **Step 5: Extend the rule context**

In `packages/engine/src/sim/rules.ts`, add these to `RuleContext` after `withState`:

```ts
  /** Registry flags of a voxel's block. */
  isSolid(voxel: number): boolean
  isLiquid(voxel: number): boolean
  isOpaque(voxel: number): boolean
  falls(voxel: number): boolean
  /** Light at a voxel, 0–15 (15 outside the world). */
  skyLight(x: number, y: number, z: number): number
  blockLight(x: number, y: number, z: number): number
  /** A liquid's level 0–7 (a spring reads 7); −1 for any other voxel. */
  level(voxel: number): number
```

In `packages/engine/src/sim/simulation.ts`, change the voxel import to:

```ts
import { AIR, blockLight, skyLight, voxelId, voxelState, withState } from '../world/voxel.ts'
```

In `makeContext()`, after `withState: (v, s) => withState(v, s),`:

```ts
      isSolid: (v) => sim.registry.solid[voxelId(v)] === 1,
      isLiquid: (v) => sim.registry.liquid[voxelId(v)] === 1,
      isOpaque: (v) => sim.registry.opaque[voxelId(v)] === 1,
      falls: (v) => sim.registry.falls[voxelId(v)] === 1,
      skyLight: (x, y, z) => skyLight(sim.store.getLight(x, y, z)),
      blockLight: (x, y, z) => blockLight(sim.store.getLight(x, y, z)),
      level: (v) => {
        const id = voxelId(v)
        if (sim.registry.liquid[id] !== 1) return -1
        return sim.registry.source[id] === 1 ? 7 : voxelState(v) & 7
      },
```

- [ ] **Step 6: Trim `applySet`**

In `Simulation`, add a field after `private readonly hasRandom: boolean`:

```ts
  /** False when no block defines onNeighborChanged: writes then skip the notification queue entirely. */
  private readonly hasNeighborRules: boolean
```

In the constructor, after `this.hasRandom = …`:

```ts
    this.hasNeighborRules = this.byId.some((r) => r?.onNeighborChanged)
```

Replace `applySet` with:

```ts
  private applySet(x: number, y: number, z: number, v: number, notify: boolean): void {
    const old = this.store.getVoxel(x, y, z)
    if (!this.store.setVoxel(x, y, z, v)) return
    // Light depends only on a block's opacity and emission, which belong to its id: a state change cannot move it.
    if (voxelId(old) !== voxelId(v)) this.light.onVoxelChanged(x, y, z, old, v)
    if (!notify || !this.hasNeighborRules) return
    this.neighbors.push(this.layout.voxelIndex(x, y, z))
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
      if (this.layout.inBounds(nx, ny, nz)) this.neighbors.push(this.layout.voxelIndex(nx, ny, nz))
    }
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd packages/engine && npx vitest run`

Expected: PASS for every file, including `determinism.test.ts`. Its rules define `onNeighborChanged`, so notifications are unchanged there.

- [ ] **Step 8: Commit**

```bash
git add packages/engine/src/blocks/registry.ts packages/engine/src/sim/rules.ts packages/engine/src/sim/simulation.ts packages/engine/test/registry.test.ts packages/engine/test/simulation.test.ts
git commit -m "feat(engine): falls and source block flags, liquid groups, rule-context reads; skip relight on state-only writes"
```

---

### Task 2: Chunk epochs, region jobs, pause

**Files:**
- Create: `packages/engine/src/sim/jobs.ts`
- Modify: `packages/engine/src/sim/simulation.ts`, `packages/engine/src/sim/simHost.ts`, `packages/engine/src/protocol.ts`, `packages/engine/src/engine.ts`
- Test: `packages/engine/test/jobs.test.ts`, `packages/engine/test/simHost.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `class JobReader { get(x, y, z): number; stale(): boolean; reset(): void }`
  - `interface RegionJob { readonly kind: string; readonly done: boolean; step(r: JobReader, budget: number): number; finish(): void; reset(): void; mixState(mix: (v: number) => void): void }`
  - `class JobRunner`:
    - `constructor(layout: Layout, epochs: Uint32Array, read: (x, y, z) => number)`;
    - `start(job)`, `run(cap)`, `drain()`, `cancel(pred)`, `size`, `mixState(mix)`.
  - `MAX_RESTARTS = 3`.
  - `Simulation` additions:
    - `readonly epochs: Uint32Array`: per chunk, bumped on every voxel write;
    - `readonly jobs: JobRunner`;
    - `paused: boolean` (read-only getter) and `setPaused(p: boolean)`;
    - option `jobCap?: number` (default 50 000).
  - Protocol: `ToSim` gets `{ type: 'setPaused'; paused: boolean }`.
  - `Engine.physics: { readonly paused: boolean; setPaused(paused: boolean): void }`.

- [ ] **Step 1: Write the failing job-runner tests**

Create `packages/engine/test/jobs.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { JobRunner, MAX_RESTARTS, type JobReader, type RegionJob } from '../src/sim/jobs.ts'
import { Layout } from '../src/world/layout.ts'

/** Reads `cells` voxels at (i, 0, 0), one per budget unit, then reports the sum it saw. */
class CountJob implements RegionJob {
  readonly kind = 'count'
  done = false
  i = 0
  sum = 0
  finished: number[] = []
  resets = 0
  constructor(private readonly cells: number) {}
  step(r: JobReader, budget: number): number {
    let used = 0
    while (used < budget && this.i < this.cells) { this.sum += r.get(this.i, 0, 0); this.i++; used++ }
    if (this.i >= this.cells) this.done = true
    return used
  }
  finish(): void { this.finished.push(this.sum) }
  reset(): void { this.i = 0; this.sum = 0; this.resets++ }
  mixState(mix: (v: number) => void): void { mix(this.i) }
}

function setup() {
  const layout = new Layout([64, 32, 32])
  const epochs = new Uint32Array(layout.chunkCount)
  const world = new Map<number, number>()
  const read = (x: number, y: number, z: number) => world.get(layout.voxelIndex(x, y, z)) ?? 1
  return { layout, epochs, world, runner: new JobRunner(layout, epochs, read) }
}

describe('JobRunner', () => {
  it('splits a job across ticks under the budget and finishes it once', () => {
    const { runner } = setup()
    const job = new CountJob(10)
    runner.start(job)
    runner.run(4)
    expect([job.i, job.finished]).toEqual([4, []])
    runner.run(4)
    runner.run(4)
    expect(job.finished).toEqual([10])
    expect(runner.size).toBe(0)
  })
  it('runs jobs in start order and gives the rest of the budget to the next one', () => {
    const { runner } = setup()
    const a = new CountJob(3), b = new CountJob(5)
    runner.start(a); runner.start(b)
    runner.run(6)
    expect([a.finished, b.i]).toEqual([[3], 3])
  })
  it('restarts a job whose chunks were written, and runs it unbounded after MAX_RESTARTS', () => {
    const { runner, epochs } = setup()
    const job = new CountJob(40) // spans chunks 0 and 1 along x
    runner.start(job)
    for (let k = 0; k < MAX_RESTARTS; k++) {
      runner.run(5)
      epochs[0]!++
    }
    expect(job.resets).toBe(MAX_RESTARTS - 1)
    runner.run(5) // stale again → third restart → unbounded: finishes now
    expect(job.resets).toBe(MAX_RESTARTS)
    expect(job.finished).toEqual([40])
  })
  it('drains every job now, including jobs started by a finish', () => {
    const { runner } = setup()
    const later = new CountJob(2)
    const first = new CountJob(2)
    first.finish = () => { first.finished.push(first.sum); runner.start(later) }
    runner.start(first)
    runner.drain()
    expect([first.finished, later.finished, runner.size]).toEqual([[2], [2], 0])
  })
  it('cancels matching jobs', () => {
    const { runner } = setup()
    const a = new CountJob(3)
    runner.start(a)
    runner.cancel((j) => j.kind === 'count')
    runner.run(10)
    expect([a.finished, runner.size]).toEqual([[], 0])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/engine && npx vitest run test/jobs.test.ts`

Expected: FAIL with "Failed to resolve import ../src/sim/jobs.ts".

- [ ] **Step 3: Implement `sim/jobs.ts`**

Create `packages/engine/src/sim/jobs.ts`:

```ts
import type { Layout } from '../world/layout.ts'

/** Reads the world for one region job and remembers the epoch of every chunk it read. */
export class JobReader {
  private readonly seen = new Map<number, number>()
  constructor(
    private readonly layout: Layout,
    private readonly epochs: Uint32Array,
    private readonly read: (x: number, y: number, z: number) => number,
  ) {}

  get(x: number, y: number, z: number): number {
    if (x >= 0 && y >= 0 && z >= 0 && x < this.layout.size[0] && y < this.layout.size[1] && z < this.layout.size[2]) {
      const ci = this.layout.chunkOf(x, y, z)
      if (!this.seen.has(ci)) this.seen.set(ci, this.epochs[ci]!)
    }
    return this.read(x, y, z)
  }

  /** True when a chunk this job read has been written since. */
  stale(): boolean {
    for (const [ci, e] of this.seen) if (this.epochs[ci] !== e) return true
    return false
  }

  reset(): void { this.seen.clear() }
}

/**
 * Incremental work over a region of the world (pool scans, resurfacing; collapse checks in 3b).
 * A job reads the world only through its JobReader and writes only in finish().
 */
export interface RegionJob {
  readonly kind: string
  readonly done: boolean
  /** Visits up to `budget` cells (Infinity = no limit) and returns how many it used. Sets `done` when finished. */
  step(r: JobReader, budget: number): number
  /** Applies the result. Runs in the tick the job finishes, right after its last step. */
  finish(): void
  /** Drops all progress: the world changed under a part already read. */
  reset(): void
  mixState(mix: (v: number) => void): void
}

/** A job restarted this many times runs to completion without a budget, so a busy area cannot starve it. */
export const MAX_RESTARTS = 3

interface Entry { job: RegionJob; reader: JobReader; restarts: number }

function hashKind(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/** Runs region jobs in start order under a per-tick count of visited cells. Deterministic: no clocks. */
export class JobRunner {
  private queue: Entry[] = []
  constructor(
    private readonly layout: Layout,
    private readonly epochs: Uint32Array,
    private readonly read: (x: number, y: number, z: number) => number,
  ) {}

  get size(): number { return this.queue.length }

  start(job: RegionJob): void {
    this.queue.push({ job, reader: new JobReader(this.layout, this.epochs, this.read), restarts: 0 })
  }

  /** One tick of work: the head job gets the budget first; a finished job hands the rest to the next. */
  run(cap: number): void {
    let budget = cap
    while (this.queue.length > 0) {
      const e = this.queue[0]!
      if (e.reader.stale()) { e.job.reset(); e.reader.reset(); e.restarts++ }
      const unbounded = e.restarts >= MAX_RESTARTS
      if (!unbounded && budget <= 0) return
      budget -= e.job.step(e.reader, unbounded ? Infinity : budget)
      if (!e.job.done) {
        if (unbounded) throw new Error(`region job "${e.job.kind}" did not finish with an unbounded budget`)
        return
      }
      this.queue.shift()
      e.job.finish()
    }
  }

  /** Runs every queued job to completion now, including jobs that finishing jobs start. */
  drain(): void {
    while (this.queue.length > 0) {
      const e = this.queue.shift()!
      e.job.step(e.reader, Infinity)
      e.job.finish()
    }
  }

  /** Drops queued jobs that match, without finishing them. */
  cancel(pred: (job: RegionJob) => boolean): void {
    this.queue = this.queue.filter((e) => !pred(e.job))
  }

  mixState(mix: (v: number) => void): void {
    mix(this.queue.length)
    for (const e of this.queue) { mix(hashKind(e.job.kind)); mix(e.restarts); e.job.mixState(mix) }
  }
}
```

- [ ] **Step 4: Run the job tests**

Run: `cd packages/engine && npx vitest run test/jobs.test.ts`

Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing pause and job tests in the simulation and the host**

Append to `packages/engine/test/simulation.test.ts`:

```ts
describe('region jobs and pause', () => {
  it('bumps a chunk epoch on every voxel write', () => {
    const sim = makeSim()
    const ci = sim.layout.chunkOf(5, 5, 5)
    const e0 = sim.epochs[ci]!
    sim.submit(1, 0, { type: 'setBlock', pos: [5, 5, 5], voxel: ID.stone })
    sim.step()
    expect(sim.epochs[ci]).toBe(e0 + 1)
  })
  it('runs region jobs in the tick, and not while paused', () => {
    const sim = makeSim()
    let steps = 0
    sim.jobs.start({ kind: 't', done: false, step() { steps++; (this as { done: boolean }).done = true; return 1 }, finish() {}, reset() {}, mixState() {} })
    sim.setPaused(true)
    sim.step()
    expect([sim.paused, steps]).toEqual([true, 0])
    sim.setPaused(false)
    sim.step()
    expect(steps).toBe(1)
  })
})
```

Append to `packages/engine/test/simHost.test.ts`, inside `describe('SimHost', …)`:

```ts
  it('pauses and resumes physics on request', () => {
    const { host } = setup()
    host.handle({ type: 'setPaused', paused: true })
    expect(host.simulation!.paused).toBe(true)
    host.handle({ type: 'setPaused', paused: false })
    expect(host.simulation!.paused).toBe(false)
  })
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd packages/engine && npx vitest run test/simulation.test.ts test/simHost.test.ts`

Expected: FAIL with "Cannot read properties of undefined" on `sim.epochs`, and "sim.jobs is undefined".

- [ ] **Step 7: Wire epochs, jobs and pause into `Simulation`**

In `packages/engine/src/sim/simulation.ts`:

1. Import the runner: `import { JobRunner } from './jobs.ts'`.

2. In `SimulationOptions`, add:

```ts
  /** Region-job budget: visited cells per tick. Default 50 000. */
  jobCap?: number
```

3. Add fields after `readonly commandLog`:

```ts
  /** Per chunk: bumped on every voxel write. Region jobs compare it to notice a world that changed under them. */
  readonly epochs: Uint32Array
  readonly jobs: JobRunner
  private isPaused = false
  private readonly jobCap: number
```

4. In the constructor, after `this.layout = this.store.layout`:

```ts
    this.epochs = new Uint32Array(this.layout.chunkCount)
    this.jobs = new JobRunner(this.layout, this.epochs, (x, y, z) => this.store.getVoxel(x, y, z))
    this.jobCap = o.jobCap ?? 50_000
```

5. Add accessors after `get pendingWork()`:

```ts
  /** True while physics (gravity, fluids, region jobs) is stopped. Rules, random ticks and light still run. */
  get paused(): boolean { return this.isPaused }
  setPaused(paused: boolean): void { this.isPaused = paused }
```

6. In `step()`, between the work-cap loop (phase 2) and `// 3. random ticks`, insert:

```ts
      if (!this.isPaused) {
        // 5. region jobs (phases 3 and 4, gravity and fluids, are added by later tasks above this line)
        this.jobs.run(this.jobCap)
      }
```

7. In `applySet`, right after `if (!this.store.setVoxel(x, y, z, v)) return`:

```ts
    this.epochs[this.layout.chunkOf(x, y, z)]!++
```

8. In `replaceColumns`, inside `for (const w of writes) store.writeChunkDense(w.ci, w.data)`, also bump the epoch. Replace that line with:

```ts
    for (const w of writes) { store.writeChunkDense(w.ci, w.data); this.epochs[w.ci]!++ }
```

9. In `hash()`, after the chunk loop and before `return h >>> 0`:

```ts
    mix(this.isPaused ? 1 : 0)
    this.jobs.mixState(mix)
```

- [ ] **Step 8: Wire the protocol, the host and the engine**

In `packages/engine/src/protocol.ts`, add to `ToSim` after the `regenerate` member:

```ts
  /** Stops or resumes physics (gravity, fluids, region jobs). Rules, random ticks and light keep running. */
  | { type: 'setPaused'; paused: boolean }
```

In `packages/engine/src/sim/simHost.ts` `handle()`, add a case before `case 'genLost'`:

```ts
      case 'setPaused':
        this.sim?.setPaused(msg.paused === true)
        return
```

In `packages/engine/src/engine.ts`:

- Add to the `Engine` interface after `readonly terrain: {…}`:

```ts
  /** Physics (falling blocks, fluids, region jobs). Paused, the world only changes through commands, rules and regeneration. */
  readonly physics: {
    readonly paused: boolean
    setPaused(paused: boolean): void
  }
```

- In `createEngine`, before `return {`, add:

```ts
  let physicsPaused = false
  const physics = {
    get paused() { return physicsPaused },
    setPaused(paused: boolean) {
      if (typeof paused !== 'boolean') throw new TypeError(`physics.setPaused expects a boolean, got ${typeof paused}`)
      physicsPaused = paused
      if (!halted) sim.postMessage({ type: 'setPaused', paused } satisfies ToSim)
    },
  }
```

- Add `physics,` to the returned object after `terrain: {…},`.

- [ ] **Step 9: Run every engine test and the typecheck**

Run: `cd packages/engine && npx vitest run && npx tsc --noEmit -p .`

Expected: all PASS, and the typecheck exits 0.

- [ ] **Step 10: Commit**

```bash
git add packages/engine/src/sim/jobs.ts packages/engine/src/sim/simulation.ts packages/engine/src/sim/simHost.ts packages/engine/src/protocol.ts packages/engine/src/engine.ts packages/engine/test/jobs.test.ts packages/engine/test/simulation.test.ts packages/engine/test/simHost.test.ts
git commit -m "feat(engine): region-job runner with chunk epochs and restarts; physics pause"
```

---

### Task 3: Fluid primitives

**Files:**
- Create: `packages/engine/src/sim/fluids/cell.ts`, `chunkBits.ts`, `surfaceIndex.ts`, `pools.ts`, `contacts.ts`, `activeQueue.ts` (all under `packages/engine/src/sim/fluids/`)
- Test: `packages/engine/test/fluidPrimitives.test.ts`

**Interfaces:**
- Consumes: `BlockRegistry.liquid`, `.source`, `.liquidGroup` (Task 1).
- Produces:
  - `cell.ts`:
    - `FULL = 8` and `SPRING_RATES: readonly number[]`;
    - `flowGroup(reg, v): number`, `isSource(reg, v): boolean`, `volumeOf(reg, v): number`, `liquidVoxel(group, units): number`.
  - `class ChunkBits`: `has`, `add` and `delete`, each `(x, y, z)`; plus `clear()` and `count()`.
  - `class SurfaceIndex`:
    - `key(x, y, z)`, `origin(key): [x0, y, z0]`;
    - `get(x, y, z)`, `set(x, y, z, id): number` (returns the tile key), `delete(x, y, z)`;
    - `tile(key)`, `clear()`.
  - `interface Pool { id; liquid; surfaceY; level; area; grid; balance; cycle; sealed; frozen; tiles: Set<number>; capped: Set<number>; outlets: Set<number> }`.
  - `class PoolTable`:
    - `create(liquid, surfaceY, level)`, `resolve(id)`, `get(id)`, `all()`, `count`;
    - `remove(p)`, `merge(into, from)`, `ownerOf(x, y, z)`;
    - `capped: Map<number, number>`;
    - `clear()`, `mixState(mix)`.
  - `class ContactTable`: `add(pa, ca, pb, cb)`, `all(): Contact[]`, `delete(c)`, `clear()`, `size`, `mixState(mix)`.
    - `interface Contact { readonly a: number; readonly b: number; readonly faces: [number, number][] }`.
  - `class ActiveQueue`:
    - `add(pos)`, `has(pos)`, `take(n): number[]`, `requeue(pos)`, `drop(pos)`;
    - `rest(pos): number`, `size`, `clear()`, `mixState(mix)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/test/fluidPrimitives.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BlockRegistry, defineBlock } from '../src/blocks/registry.ts'
import { ActiveQueue } from '../src/sim/fluids/activeQueue.ts'
import { FULL, SPRING_RATES, flowGroup, isSource, liquidVoxel, volumeOf } from '../src/sim/fluids/cell.ts'
import { ChunkBits } from '../src/sim/fluids/chunkBits.ts'
import { ContactTable } from '../src/sim/fluids/contacts.ts'
import { PoolTable } from '../src/sim/fluids/pools.ts'
import { SurfaceIndex } from '../src/sim/fluids/surfaceIndex.ts'
import { Layout } from '../src/world/layout.ts'
import { AIR, packVoxel } from '../src/world/voxel.ts'

const reg = new BlockRegistry([
  defineBlock({ name: 'stone' }),
  defineBlock({ name: 'water', liquid: true }),
  defineBlock({ name: 'spring', liquid: true, source: 'water', textures: 'water' }),
])
const [STONE, WATER, SPRING] = [1, 2, 3]

describe('cell helpers', () => {
  it('reads volumes and groups', () => {
    expect(volumeOf(reg, packVoxel(WATER, 0))).toBe(1)
    expect(volumeOf(reg, packVoxel(WATER, 7))).toBe(FULL)
    expect(volumeOf(reg, packVoxel(SPRING, 2))).toBe(FULL) // a spring counts as full whatever its state
    expect(volumeOf(reg, STONE)).toBe(0)
    expect(flowGroup(reg, packVoxel(WATER, 3))).toBe(WATER)
    expect(flowGroup(reg, SPRING)).toBe(0)
    expect(flowGroup(reg, AIR)).toBe(0)
    expect(isSource(reg, SPRING)).toBe(true)
    expect(liquidVoxel(WATER, 3)).toBe(packVoxel(WATER, 2))
    expect(liquidVoxel(WATER, 0)).toBe(AIR)
    expect(() => liquidVoxel(WATER, 9)).toThrow(RangeError)
    expect(SPRING_RATES).toHaveLength(16)
  })
})

describe('ChunkBits and SurfaceIndex', () => {
  const L = new Layout([64, 64, 64])
  it('stores bits per chunk and ignores out-of-world coordinates', () => {
    const b = new ChunkBits(L)
    b.add(1, 2, 3); b.add(63, 63, 63); b.add(64, 0, 0); b.add(-1, 0, 0)
    expect([b.has(1, 2, 3), b.has(63, 63, 63), b.has(0, 2, 3), b.has(64, 0, 0), b.has(-1, 0, 0)]).toEqual([true, true, false, false, false])
    expect(b.count()).toBe(2)
    b.delete(1, 2, 3)
    expect(b.has(1, 2, 3)).toBe(false)
  })
  it('maps surface cells to pool ids in tiles', () => {
    const s = new SurfaceIndex(L)
    const k = s.set(40, 7, 9, 5)
    expect(s.get(40, 7, 9)).toBe(5)
    expect(s.get(40, 8, 9)).toBe(0)
    expect(s.origin(k)).toEqual([32, 7, 0])
    expect(s.key(33, 7, 31)).toBe(k)
    s.delete(40, 7, 9)
    expect(s.get(40, 7, 9)).toBe(0)
    expect(s.get(-1, 0, 0)).toBe(0)
  })
})

describe('PoolTable', () => {
  const L = new Layout([32, 32, 32])
  function table() {
    const index = new SurfaceIndex(L), members = new ChunkBits(L)
    return { index, members, pools: new PoolTable(L, index, members) }
  }
  it('finds the owner of a cell by walking up to its surface', () => {
    const { index, members, pools } = table()
    const p = pools.create(WATER, 5, 7)
    for (let y = 2; y <= 5; y++) members.add(4, y, 4)
    index.set(4, 5, 4, p.id)
    expect(pools.ownerOf(4, 2, 4)).toBe(p)
    expect(pools.ownerOf(4, 6, 4)).toBeUndefined()
    expect(pools.ownerOf(5, 2, 4)).toBeUndefined()
  })
  it('uses the capped map for a column top below the surface', () => {
    const { members, pools } = table()
    const p = pools.create(WATER, 9, 7)
    members.add(1, 3, 1); members.add(1, 4, 1)
    pools.capped.set(L.voxelIndex(1, 4, 1), p.id)
    expect(pools.ownerOf(1, 3, 1)).toBe(p)
  })
  it('merges by alias and resolves chains', () => {
    const { pools } = table()
    const a = pools.create(WATER, 5, 3), b = pools.create(WATER, 5, 3), c = pools.create(WATER, 5, 3)
    a.area = 2; b.area = 3; c.area = 4
    a.grid = 8; b.grid = 12; c.grid = 16
    b.balance = -1; c.cycle = true
    b.outlets.add(77)
    pools.merge(b, c)
    pools.merge(a, b)
    expect(pools.resolve(c.id)).toBe(a.id)
    expect(pools.get(c.id)).toBe(a)
    expect([a.area, a.grid, a.balance, a.cycle, a.outlets.has(77)]).toEqual([9, 36, -1, true, true])
    expect(pools.all()).toEqual([a])
    pools.remove(a)
    expect(pools.get(c.id)).toBeUndefined()
  })
})

describe('ContactTable', () => {
  it('stores each face once, keyed by the lower pool id', () => {
    const t = new ContactTable()
    t.add(5, 100, 2, 200)
    t.add(2, 200, 5, 100)
    t.add(2, 201, 5, 101)
    const [c] = t.all()
    expect(c).toMatchObject({ a: 2, b: 5, faces: [[200, 100], [201, 101]] })
    t.delete(c!)
    expect(t.size).toBe(0)
  })
})

describe('ActiveQueue', () => {
  it('takes cells in order, once each, and keeps idle counts', () => {
    const q = new ActiveQueue()
    q.add(1); q.add(2); q.add(1); q.add(3)
    expect(q.take(2)).toEqual([1, 2])
    q.requeue(1)
    q.drop(2)
    expect(q.take(10)).toEqual([3, 1])
    expect([q.has(1), q.has(2), q.size]).toEqual([true, false, 2])
    expect(q.rest(1)).toBe(1)
    expect(q.rest(1)).toBe(2)
    q.add(1) // waking resets the idle count
    expect(q.rest(1)).toBe(1)
  })
  it('does not hand out a dropped and re-added cell twice in one take', () => {
    const q = new ActiveQueue()
    q.add(7); q.drop(7); q.add(7)
    expect(q.take(10)).toEqual([7])
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/engine && npx vitest run test/fluidPrimitives.test.ts`

Expected: FAIL with "Failed to resolve import ../src/sim/fluids/activeQueue.ts".

- [ ] **Step 3: Implement `cell.ts`**

Create `packages/engine/src/sim/fluids/cell.ts`:

```ts
import type { BlockRegistry } from '../../blocks/registry.ts'
import { AIR, voxelId, voxelState } from '../../world/voxel.ts'

/** Units in a full liquid cell. A liquid cell holds level + 1 units; level 0–7 sits in state bits 0–2. */
export const FULL = 8

/** Units a spring injects per fluid step, indexed by the spring's state (its flow index). */
export const SPRING_RATES: readonly number[] = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 40, 48, 56, 64, 96, 128]

/** The group (base liquid id) of a flowing liquid voxel; 0 for air, solids and springs. */
export function flowGroup(reg: BlockRegistry, v: number): number {
  const id = voxelId(v)
  return reg.liquid[id] === 1 && reg.source[id] === 0 ? reg.liquidGroup[id]! : 0
}

export function isSource(reg: BlockRegistry, v: number): boolean {
  return reg.source[voxelId(v)] === 1
}

/** Units of liquid in a voxel: level + 1 for a liquid, FULL for a spring, 0 for anything else. */
export function volumeOf(reg: BlockRegistry, v: number): number {
  const id = voxelId(v)
  if (reg.liquid[id] !== 1) return 0
  return reg.source[id] === 1 ? FULL : (voxelState(v) & 7) + 1
}

/** The voxel holding `units` (1–8) of liquid `group`; air for 0. */
export function liquidVoxel(group: number, units: number): number {
  if (units <= 0) return AIR
  if (units > FULL || !Number.isInteger(units)) throw new RangeError(`a liquid cell holds 1–${FULL} units, got ${units}`)
  return ((units - 1) << 12) | group
}
```

- [ ] **Step 4: Implement `chunkBits.ts` and `surfaceIndex.ts`**

Create `packages/engine/src/sim/fluids/chunkBits.ts`:

```ts
import { Layout } from '../../world/layout.ts'

/** One bit per voxel, allocated 4 KB per chunk on the first set. Out-of-world coordinates read false and ignore writes. */
export class ChunkBits {
  private readonly chunks = new Map<number, Uint32Array>()
  private readonly sx: number
  private readonly sy: number
  private readonly sz: number
  constructor(private readonly layout: Layout) {
    ;[this.sx, this.sy, this.sz] = layout.size
  }

  private words(x: number, y: number, z: number, create: boolean): Uint32Array | undefined {
    if (x < 0 || y < 0 || z < 0 || x >= this.sx || y >= this.sy || z >= this.sz) return undefined
    const ci = this.layout.chunkOf(x, y, z)
    let w = this.chunks.get(ci)
    if (!w && create) { w = new Uint32Array(1024); this.chunks.set(ci, w) }
    return w
  }

  has(x: number, y: number, z: number): boolean {
    const w = this.words(x, y, z, false)
    if (!w) return false
    const i = Layout.localIndex(x & 31, y & 31, z & 31)
    return ((w[i >>> 5]! >>> (i & 31)) & 1) === 1
  }

  add(x: number, y: number, z: number): void {
    const w = this.words(x, y, z, true)
    if (!w) return
    const i = Layout.localIndex(x & 31, y & 31, z & 31)
    w[i >>> 5] = w[i >>> 5]! | (1 << (i & 31))
  }

  delete(x: number, y: number, z: number): void {
    const w = this.words(x, y, z, false)
    if (!w) return
    const i = Layout.localIndex(x & 31, y & 31, z & 31)
    w[i >>> 5] = w[i >>> 5]! & ~(1 << (i & 31))
  }

  clear(): void { this.chunks.clear() }

  /** Set bits; for tests and invariant checks. */
  count(): number {
    let n = 0
    for (const w of this.chunks.values()) for (let i = 0; i < w.length; i++) {
      let v = w[i]!
      while (v !== 0) { v &= v - 1; n++ }
    }
    return n
  }
}
```

Create `packages/engine/src/sim/fluids/surfaceIndex.ts`:

```ts
import type { Layout } from '../../world/layout.ts'

/** Pool ids of surface cells, in sparse 32 × 32 tiles per (chunk column, y). 0 = no pool. */
export class SurfaceIndex {
  private readonly tiles = new Map<number, Int32Array>()
  constructor(private readonly layout: Layout) {}

  key(x: number, y: number, z: number): number {
    return (y * this.layout.cz + (z >> 5)) * this.layout.cx + (x >> 5)
  }

  /** The world position of a tile's first cell: [x0, y, z0]. */
  origin(key: number): [number, number, number] {
    const { cx, cz } = this.layout
    const tx = key % cx
    const rest = (key - tx) / cx
    const tz = rest % cz
    return [tx * 32, (rest - tz) / cz, tz * 32]
  }

  private inside(x: number, y: number, z: number): boolean {
    const [sx, sy, sz] = this.layout.size
    return x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz
  }

  get(x: number, y: number, z: number): number {
    if (!this.inside(x, y, z)) return 0
    const t = this.tiles.get(this.key(x, y, z))
    return t ? t[(x & 31) | ((z & 31) << 5)]! : 0
  }

  /** Records a surface cell and returns its tile key. */
  set(x: number, y: number, z: number, id: number): number {
    const k = this.key(x, y, z)
    let t = this.tiles.get(k)
    if (!t) { t = new Int32Array(1024); this.tiles.set(k, t) }
    t[(x & 31) | ((z & 31) << 5)] = id
    return k
  }

  delete(x: number, y: number, z: number): void {
    if (!this.inside(x, y, z)) return
    const t = this.tiles.get(this.key(x, y, z))
    if (t) t[(x & 31) | ((z & 31) << 5)] = 0
  }

  tile(key: number): Int32Array | undefined { return this.tiles.get(key) }

  clear(): void { this.tiles.clear() }
}
```

- [ ] **Step 5: Implement `pools.ts`**

Create `packages/engine/src/sim/fluids/pools.ts`:

```ts
import type { Layout } from '../../world/layout.ts'
import type { ChunkBits } from './chunkBits.ts'
import type { SurfaceIndex } from './surfaceIndex.ts'

/** A settled body of liquid with a flat surface (design notes: Members and ownership). */
export interface Pool {
  readonly id: number
  /** The liquid group: the base liquid's block id. */
  readonly liquid: number
  surfaceY: number
  /** The level (0–7) of every surface cell. */
  level: number
  /** Surface cells. */
  area: number
  /** Units the pool's cells hold in the grid. */
  grid: number
  /** Units not shown in the grid yet. The true volume is grid + balance. */
  balance: number
  /** The sea that springs draw from. */
  cycle: boolean
  /** It could not add a layer: everything above its surface is solid. */
  sealed: boolean
  /** A region job is rewriting or rescanning it: it neither joins cells nor moves water. */
  frozen: boolean
  /** Surface-index tile keys holding its surface cells. */
  readonly tiles: Set<number>
  /** Voxel indices of its capped column tops. */
  readonly capped: Set<number>
  /** Voxel indices it fills each fluid step. */
  readonly outlets: Set<number>
}

export class PoolTable {
  /** Member column tops below their pool's surface: voxel index → pool id (raw; resolve it). */
  readonly capped = new Map<number, number>()
  private readonly live = new Map<number, Pool>()
  private readonly alias = new Map<number, number>()
  private nextId = 1

  constructor(private readonly layout: Layout, private readonly index: SurfaceIndex, private readonly members: ChunkBits) {}

  get count(): number { return this.live.size }

  create(liquid: number, surfaceY: number, level: number): Pool {
    const p: Pool = {
      id: this.nextId++, liquid, surfaceY, level, area: 0, grid: 0, balance: 0,
      cycle: false, sealed: false, frozen: false, tiles: new Set(), capped: new Set(), outlets: new Set(),
    }
    this.live.set(p.id, p)
    return p
  }

  /** Follows merges to the live pool's id; 0 when the pool no longer exists. */
  resolve(id: number): number {
    let cur = id
    while (!this.live.has(cur)) {
      const next = this.alias.get(cur)
      if (next === undefined) return 0
      cur = next
    }
    if (cur !== id) this.alias.set(id, cur)
    return cur
  }

  get(id: number): Pool | undefined {
    const r = this.resolve(id)
    return r === 0 ? undefined : this.live.get(r)
  }

  /** Live pools in id order (ids only grow, and a Map keeps insertion order). */
  all(): Pool[] { return [...this.live.values()] }

  /** Forgets a pool. Its index entries, capped entries and member bits are the caller's to clean. */
  remove(p: Pool): void { this.live.delete(p.id) }

  /** Folds `from` into `into` (same surfaceY). Levels may differ; the caller normalises them with a resurface job. */
  merge(into: Pool, from: Pool): void {
    if (into === from) return
    this.live.delete(from.id)
    this.alias.set(from.id, into.id)
    into.area += from.area
    into.grid += from.grid
    into.balance += from.balance
    into.cycle = into.cycle || from.cycle
    into.sealed = false
    for (const t of from.tiles) into.tiles.add(t)
    for (const c of from.capped) into.capped.add(c)
    for (const o of from.outlets) into.outlets.add(o)
  }

  /** The pool owning a member cell: walks up member cells to a surface entry or a capped top. */
  ownerOf(x: number, y: number, z: number): Pool | undefined {
    if (!this.members.has(x, y, z)) return undefined
    const H = this.layout.size[1]
    for (let yy = y; ; yy++) {
      const s = this.index.get(x, yy, z)
      if (s !== 0) {
        const p = this.get(s)
        if (p && p.surfaceY === yy) return p
      }
      const c = this.capped.get(this.layout.voxelIndex(x, yy, z))
      if (c !== undefined) {
        const p = this.get(c)
        if (p) return p
      }
      if (yy + 1 >= H || !this.members.has(x, yy + 1, z)) return undefined
    }
  }

  clear(): void {
    this.live.clear()
    this.alias.clear()
    this.capped.clear()
    this.nextId = 1
  }

  mixState(mix: (v: number) => void): void {
    mix(this.nextId)
    mix(this.alias.size)
    mix(this.capped.size)
    for (const p of this.live.values()) {
      mix(p.id); mix(p.liquid); mix(p.surfaceY); mix(p.level); mix(p.area); mix(p.grid); mix(p.balance)
      mix((p.cycle ? 1 : 0) | (p.sealed ? 2 : 0) | (p.frozen ? 4 : 0))
      mix(p.tiles.size); mix(p.capped.size); mix(p.outlets.size)
    }
  }
}
```

- [ ] **Step 6: Implement `contacts.ts` and `activeQueue.ts`**

Create `packages/engine/src/sim/fluids/contacts.ts`:

```ts
/** Two touching pools and the faces where they touch: [cell of a, cell of b] (voxel indices). Ids are raw; resolve them. */
export interface Contact {
  readonly a: number
  readonly b: number
  readonly faces: [number, number][]
}

interface Entry extends Contact { readonly keys: Set<string> }

export class ContactTable {
  private readonly byKey = new Map<string, Entry>()

  get size(): number { return this.byKey.size }

  add(pa: number, ca: number, pb: number, cb: number): void {
    if (pa === pb) return
    const [a, b, fa, fb] = pa < pb ? [pa, pb, ca, cb] : [pb, pa, cb, ca]
    const k = `${a}:${b}`
    let e = this.byKey.get(k)
    if (!e) { e = { a, b, faces: [], keys: new Set() }; this.byKey.set(k, e) }
    const fk = `${fa}:${fb}`
    if (e.keys.has(fk)) return
    e.keys.add(fk)
    e.faces.push([fa, fb])
  }

  /** Contacts in insertion order (a snapshot: deleting while iterating is safe). */
  all(): Contact[] { return [...this.byKey.values()] }

  delete(c: Contact): void { this.byKey.delete(`${c.a}:${c.b}`) }

  clear(): void { this.byKey.clear() }

  mixState(mix: (v: number) => void): void {
    mix(this.byKey.size)
    for (const e of this.byKey.values()) { mix(e.a); mix(e.b); mix(e.faces.length) }
  }
}
```

Create `packages/engine/src/sim/fluids/activeQueue.ts`:

```ts
interface State { idle: number; queued: boolean }

/** Moving liquid cells: a deduplicated FIFO of voxel indices with an idle-step count each. */
export class ActiveQueue {
  private order: number[] = []
  private head = 0
  private readonly state = new Map<number, State>()

  get size(): number { return this.state.size }
  has(pos: number): boolean { return this.state.has(pos) }

  /** Activates a cell, or wakes an active one (its idle count drops to 0). */
  add(pos: number): void {
    const s = this.state.get(pos)
    if (s) {
      s.idle = 0
      if (!s.queued) { s.queued = true; this.order.push(pos) }
      return
    }
    this.state.set(pos, { idle: 0, queued: true })
    this.order.push(pos)
  }

  /** Takes up to n cells from the front, in order. They stay active: requeue() or drop() each one. */
  take(n: number): number[] {
    const out: number[] = []
    while (out.length < n && this.head < this.order.length) {
      const pos = this.order[this.head++]!
      const s = this.state.get(pos)
      if (!s || !s.queued) continue // dropped, or a stale duplicate
      s.queued = false
      out.push(pos)
    }
    if (this.head > 4096 && this.head * 2 > this.order.length) {
      this.order = this.order.slice(this.head)
      this.head = 0
    }
    return out
  }

  /** Puts a taken cell back at the end of the line. */
  requeue(pos: number): void {
    const s = this.state.get(pos)
    if (s && !s.queued) { s.queued = true; this.order.push(pos) }
  }

  drop(pos: number): void { this.state.delete(pos) }

  /** One more step without change; returns the new idle count. */
  rest(pos: number): number {
    const s = this.state.get(pos)
    if (!s) return 0
    s.idle++
    return s.idle
  }

  clear(): void {
    this.order = []
    this.head = 0
    this.state.clear()
  }

  mixState(mix: (v: number) => void): void {
    mix(this.state.size)
    for (let i = this.head; i < this.order.length; i++) {
      const pos = this.order[i]!
      const s = this.state.get(pos)
      if (s && s.queued) { mix(pos); mix(s.idle) }
    }
  }
}
```

The ActiveQueue test expects `take(10)` to return `[3, 1]` after `requeue(1)` and `drop(2)`. `take(2)` returned 1 and 2 (now unqueued), 3 is still queued, then `requeue(1)` pushes 1 behind 3.

- [ ] **Step 7: Run the tests**

Run: `cd packages/engine && npx vitest run test/fluidPrimitives.test.ts`

Expected: PASS (all tests).

- [ ] **Step 8: Commit**

```bash
git add packages/engine/src/sim/fluids packages/engine/test/fluidPrimitives.test.ts
git commit -m "feat(engine): fluid primitives: cell helpers, chunk bits, surface index, pool table, contacts, active queue"
```

---

### Task 4: Pool scans, the fluid system and the world rebuild

**Files:**
- Create: `packages/engine/src/sim/fluids/scan.ts`, `packages/engine/src/sim/fluids/fluidSystem.ts`, `packages/engine/test/fluidHelpers.ts`
- Modify: `packages/engine/src/sim/simulation.ts`, `packages/engine/src/sim/generator.ts`, `packages/engine/src/sim/runSimWorker.ts`
- Test: `packages/engine/test/poolScan.test.ts`

**Interfaces:**
- Consumes: Task 3's primitives; `JobReader`, `RegionJob` and `JobRunner` (Task 2).
- Produces:
  - `scan.ts`:
    - `interface ScanComponent { liquid; surfaceY; level; surface: number[]; deep: number[]; capped: number[]; grid: number; outlets: number[]; edges: [number, number][] }`;
    - `type Claimable = (x, y, z, pos) => boolean`;
    - `class PoolScan implements RegionJob` (constructor `{ kind, registry, layout, seeds, claimable, onFinish }`, field `components`);
    - `sortSeeds(layout, seeds): number[]`;
    - `FLUID_JOBS: ReadonlySet<string>` = `'settle'`, `'split'`, `'resurface'`.
  - `fluidSystem.ts`:
    - `type WriteSource = 'external' | 'fluid' | 'gravity'`;
    - `interface FluidOptions { fluidEvery; fluidCap; outletRate }` and `DEFAULT_FLUID_OPTIONS`;
    - `interface FluidPort { layout; registry; store; jobs; epochs; get(x, y, z); write(x, y, z, v); log(m) }`.
  - `class FluidSystem` members:
    - Fields: `o`, `index`, `members`, `pools`, `contacts`, `active`, `springs: Set<number>`, `lost`, `needsRebuild`, `seaLevel`.
    - Getters: `activeCount`, `stepCount`, `cycle` (the cycle pool or undefined).
    - Queries: `poolAt(x, y, z)`, `totalVolume()`.
    - Lifecycle: `rebuild()`, `install(cs)`, `step(tick)`.
    - Write hooks: `beforeWrite(x, y, z, old, source)` and `afterWrite(x, y, z, old, v, source, owner)`.
    - `mixState(mix)`.
  - `Simulation`:
    - `readonly fluids: FluidSystem`;
    - option `fluids?: Partial<FluidOptions>`;
    - `configure` reads `{ seaLevel }` from the generator.
  - `GeneratorModule.configure?(doc, info): void | GeneratorConfig` with `interface GeneratorConfig { seaLevel?: number }`.
  - Test helpers (`test/fluidHelpers.ts`): `FLUID_BLOCKS`, `B`, `w(level)`, `spring(flow)`, `fluidSim(fill, opts)`, `run`, `settle`, `volume`.

- [ ] **Step 1: Write the test helpers**

Create `packages/engine/test/fluidHelpers.ts`:

```ts
import { defineBlock, type BlockDef } from '../src/blocks/registry.ts'
import type { FluidOptions } from '../src/sim/fluids/fluidSystem.ts'
import { defineGenerator } from '../src/sim/generator.ts'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { AIR, packVoxel } from '../src/world/voxel.ts'
import { TEST_BLOCKS } from './helpers.ts'

export const FLUID_BLOCKS: BlockDef[] = [
  ...TEST_BLOCKS,
  defineBlock({ name: 'sand', falls: true }),
  defineBlock({ name: 'spring', liquid: true, source: 'water', textures: 'water' }),
]
export const B = { air: 0, stone: 1, dirt: 2, grass: 3, glass: 4, water: 5, torch: 6, leaves: 7, sand: 8, spring: 9 } as const
/** A water voxel at a level (0–7). */
export const w = (level = 7): number => packVoxel(B.water, level)
export const spring = (flow = 5): number => packVoxel(B.spring, flow)

export type Fill = (x: number, y: number, z: number) => number
export interface FluidSimOptions {
  size?: [number, number, number]
  /** Handed to the sim through the generator's configure(); springs then draw from the pool at seaLevel − 1. */
  seaLevel?: number
  seed?: number
  fluids?: Partial<FluidOptions>
  jobCap?: number
}

/** A Simulation generated from `fill`. Fluids step every tick unless `fluids.fluidEvery` says otherwise. */
export function fluidSim(fill: Fill, o: FluidSimOptions = {}): Simulation {
  const size = o.size ?? [32, 32, 32]
  const sim = new Simulation({
    buffers: createWorldBuffers(size), blocks: FLUID_BLOCKS, seed: o.seed ?? 1, log: () => {},
    fluids: { fluidEvery: 1, ...o.fluids }, jobCap: o.jobCap,
  })
  const gen = defineGenerator({
    configure: () => (o.seaLevel === undefined ? undefined : { seaLevel: o.seaLevel }),
    generateColumn(ctx, cx, cz) {
      for (let y = 0; y < ctx.height; y++) for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
        const v = fill(cx * 32 + lx, y, cz * 32 + lz)
        if (v !== AIR) ctx.column[lx + (lz << 5) + (y << 10)] = v
      }
    },
  })
  sim.configure(gen, null)
  sim.generate(gen)
  return sim
}

export function run(sim: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) sim.step()
}

/** Steps until no cell is active and no region job is queued; returns the ticks it took. Throws after `max`. */
export function settle(sim: Simulation, max = 3000): number {
  for (let i = 0; i < max; i++) {
    if (sim.fluids.activeCount === 0 && sim.jobs.size === 0) return i
    sim.step()
  }
  throw new Error(`fluids still moving after ${max} ticks (${sim.fluids.activeCount} active, ${sim.jobs.size} jobs)`)
}

/** Exact liquid in the world: cells + pool balances + lost. */
export const volume = (sim: Simulation): number => sim.fluids.totalVolume()

/** A stone box: floor y < 1, walls at x/z = 0 and side − 1 up to `wallTop`, air inside. */
export function basin(side: number, wallTop: number): Fill {
  return (x, y, z) => {
    if (y === 0) return B.stone
    if ((x === 0 || z === 0 || x === side - 1 || z === side - 1) && y <= wallTop && x < side && z < side) return B.stone
    return AIR
  }
}
```

- [ ] **Step 2: Write the failing scan and rebuild tests**

Create `packages/engine/test/poolScan.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { AIR } from '../src/world/voxel.ts'
import { B, basin, fluidSim, w, spring, type Fill } from './fluidHelpers.ts'

/** A basin of side 12 with walls to y = 8, filled with full water for 1 ≤ y ≤ top. */
const lake = (top: number): Fill => {
  const b = basin(12, 8)
  return (x, y, z) => {
    const v = b(x, y, z)
    if (v !== AIR) return v
    return x > 0 && x < 11 && z > 0 && z < 11 && y >= 1 && y <= top ? w(7) : AIR
  }
}

describe('rebuild', () => {
  it('turns a still lake into one flat pool', () => {
    const sim = fluidSim(lake(4))
    const pools = sim.fluids.pools.all()
    expect(pools).toHaveLength(1)
    expect(pools[0]).toMatchObject({ surfaceY: 4, level: 7, area: 100, grid: 400 * 8, balance: 0 })
    expect(pools[0]!.outlets.size).toBe(0)
    expect(sim.fluids.poolAt(5, 1, 5)).toBe(pools[0])
    expect(sim.fluids.members.count()).toBe(400)
    expect(sim.fluids.activeCount).toBe(0)
  })
  it('keeps two separate lakes apart', () => {
    const one = lake(3)
    const sim = fluidSim((x, y, z) => (x === 6 && y >= 1 && y <= 8 ? B.stone : one(x, y, z)))
    expect(sim.fluids.pools.all().map((p) => p.area).sort()).toEqual([40, 50])
  })
  it('owns a cave below the bed through a capped top', () => {
    const b = lake(4)
    const sim = fluidSim((x, y, z) => {
      if (y === 0) return B.stone
      if (y <= 2 && x >= 3 && x <= 6 && z >= 3 && z <= 6) return y === 2 && !(x === 3 && z === 3) ? B.stone : w(7) // a cave at y = 1 under a lid with one hole
      if (y <= 2) return B.stone
      return b(x, y, z)
    })
    const [p] = sim.fluids.pools.all()
    expect(sim.fluids.pools.all()).toHaveLength(1)
    expect(sim.fluids.poolAt(5, 1, 5)).toBe(p)
    expect(p!.capped.size).toBeGreaterThan(0)
  })
  it('splits stepped water into pools in contact', () => {
    // west half: water to y = 4; east half: water to y = 3; one body below y = 3
    const b = basin(12, 8)
    const sim = fluidSim((x, y, z) => {
      const v = b(x, y, z)
      if (v !== AIR) return v
      if (x <= 0 || x >= 11 || z <= 0 || z >= 11 || y < 1) return AIR
      return y <= (x < 6 ? 4 : 3) ? w(7) : AIR
    })
    const ps = sim.fluids.pools.all()
    expect(ps.map((p) => p.surfaceY).sort()).toEqual([3, 4])
    expect(sim.fluids.contacts.size).toBe(1)
  })
  it('records outlets, wakes loose water and finds springs', () => {
    const b = lake(4)
    const sim = fluidSim((x, y, z) => {
      if (x === 5 && z === 5 && y === 0) return AIR // a hole in the floor under the lake
      if (x === 20 && z === 20 && y === 1) return w(2) // a puddle cell on its own floor tile
      if (x === 20 && z === 20 && y === 0) return B.stone
      if (x === 25 && z === 25 && y === 1) return spring(3)
      return b(x, y, z)
    })
    const [p] = sim.fluids.pools.all().filter((q) => q.area === 100)
    expect(p!.outlets.has(sim.layout.voxelIndex(5, 0, 5))).toBe(true)
    expect(sim.fluids.springs.has(sim.layout.voxelIndex(25, 1, 25))).toBe(true)
    expect(sim.fluids.pools.all()).toHaveLength(2) // the puddle is a pool of its own
  })
  it('handles a chunk that is entirely water', () => {
    const sim = fluidSim((_x, y) => (y <= 40 ? w(7) : AIR), { size: [32, 64, 32] })
    expect(sim.store.slotOf(0)).toBe(-1) // the bottom chunk is uniform: no slot
    const [p] = sim.fluids.pools.all()
    expect(p).toMatchObject({ surfaceY: 40, level: 7, area: 1024, grid: 41 * 1024 * 8 })
    expect(sim.fluids.poolAt(3, 3, 3)).toBe(p)
  })
  it('rescans after replaceColumns on the next step', () => {
    const sim = fluidSim(lake(4))
    const empty = new Uint16Array(32 * 32 * 32)
    sim.replaceColumns([{ cx: 0, cz: 0, data: empty }])
    expect(sim.fluids.needsRebuild).toBe(true)
    sim.step()
    expect([sim.fluids.needsRebuild, sim.fluids.pools.count]).toEqual([false, 0])
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd packages/engine && npx vitest run test/poolScan.test.ts`

Expected: FAIL with "Failed to resolve import ../src/sim/fluids/fluidSystem.ts" (from `fluidHelpers.ts`).

- [ ] **Step 4: Implement `scan.ts`**

Create `packages/engine/src/sim/fluids/scan.ts`:

```ts
import type { BlockRegistry } from '../../blocks/registry.ts'
import type { Layout } from '../../world/layout.ts'
import { AIR } from '../../world/voxel.ts'
import type { JobReader, RegionJob } from '../jobs.ts'
import { FULL, flowGroup, volumeOf } from './cell.ts'
import { ChunkBits } from './chunkBits.ts'

/** The fluid system's region-job kinds; a rebuild cancels them. */
export const FLUID_JOBS: ReadonlySet<string> = new Set(['settle', 'split', 'resurface'])

/** A connected body of still liquid found by a scan. Positions are voxel indices. */
export interface ScanComponent {
  liquid: number
  surfaceY: number
  level: number
  surface: number[]
  deep: number[]
  /** Deep cells whose cell above is not in the component: column tops below the surface. */
  capped: number[]
  /** Units held by all its cells. */
  grid: number
  /** Air cells at y ≤ surfaceY next to it (may repeat). */
  outlets: number[]
  /** [own cell, neighbour] for every same-liquid neighbour the scan did not claim. */
  edges: [number, number][]
}

export type Claimable = (x: number, y: number, z: number, pos: number) => boolean

export interface PoolScanOptions {
  kind: string
  registry: BlockRegistry
  layout: Layout
  /** Candidate tops in the order to try them (see sortSeeds). Claimed, unclaimable or non-top seeds are skipped. */
  seeds: readonly number[]
  claimable: Claimable
  onFinish(components: ScanComponent[]): void
}

const DX = [1, -1, 0, 0, 0, 0]
const DY = [0, 0, 1, -1, 0, 0]
const DZ = [0, 0, 0, 0, 1, -1]

/** Highest y first, then by index: a seed's component then claims everything below its surface. */
export function sortSeeds(layout: Layout, seeds: number[]): number[] {
  const layer = layout.size[0] * layout.size[2]
  return seeds.sort((a, b) => Math.floor(b / layer) - Math.floor(a / layer) || a - b)
}

/**
 * Floods bodies of still liquid from seed tops (design notes: Scans). A body's surface is its seed's
 * layer and level; below it, only full cells join. Writes nothing: onFinish installs the result.
 */
export class PoolScan implements RegionJob {
  readonly kind: string
  done = false
  readonly components: ScanComponent[] = []
  private readonly o: PoolScanOptions
  private readonly sx: number
  private readonly layer: number
  private marks: ChunkBits
  private cur: ChunkBits
  private seedAt = 0
  private comp: ScanComponent | null = null
  private queue: number[] = []
  private head = 0

  constructor(o: PoolScanOptions) {
    this.o = o
    this.kind = o.kind
    this.sx = o.layout.size[0]
    this.layer = o.layout.size[0] * o.layout.size[2]
    this.marks = new ChunkBits(o.layout)
    this.cur = new ChunkBits(o.layout)
  }

  step(r: JobReader, budget: number): number {
    let used = 0
    while (used < budget && !this.done) {
      if (this.comp === null) {
        if (this.seedAt >= this.o.seeds.length) { this.done = true; break }
        used++
        this.trySeed(r, this.o.seeds[this.seedAt++]!)
      } else if (this.head < this.queue.length) {
        used++
        this.visit(r, this.queue[this.head++]!)
      } else {
        this.close()
      }
    }
    return used
  }

  finish(): void { this.o.onFinish(this.components) }

  reset(): void {
    this.done = false
    this.components.length = 0
    this.marks = new ChunkBits(this.o.layout)
    this.cur = new ChunkBits(this.o.layout)
    this.seedAt = 0
    this.comp = null
    this.queue = []
    this.head = 0
  }

  mixState(mix: (v: number) => void): void {
    mix(this.seedAt); mix(this.components.length); mix(this.queue.length - this.head); mix(this.done ? 1 : 0)
  }

  private trySeed(r: JobReader, pos: number): void {
    const y = Math.floor(pos / this.layer), rest = pos - y * this.layer, z = Math.floor(rest / this.sx), x = rest - z * this.sx
    if (this.marks.has(x, y, z) || !this.o.claimable(x, y, z, pos)) return
    const reg = this.o.registry
    const v = r.get(x, y, z)
    const g = flowGroup(reg, v)
    if (g === 0 || flowGroup(reg, r.get(x, y + 1, z)) === g) return // not a top
    this.comp = { liquid: g, surfaceY: y, level: volumeOf(reg, v) - 1, surface: [], deep: [], capped: [], grid: 0, outlets: [], edges: [] }
    this.claim(x, y, z, pos)
  }

  private claim(x: number, y: number, z: number, pos: number): void {
    this.marks.add(x, y, z)
    this.cur.add(x, y, z)
    this.queue.push(pos)
  }

  private visit(r: JobReader, pos: number): void {
    const c = this.comp!, reg = this.o.registry, L = this.o.layout
    const y = Math.floor(pos / this.layer), rest = pos - y * this.layer, z = Math.floor(rest / this.sx), x = rest - z * this.sx
    c.grid += volumeOf(reg, r.get(x, y, z))
    if (y === c.surfaceY) c.surface.push(pos)
    else c.deep.push(pos)
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
      if (ny > c.surfaceY || nx < 0 || ny < 0 || nz < 0 || nx >= L.size[0] || ny >= L.size[1] || nz >= L.size[2]) continue
      if (this.cur.has(nx, ny, nz)) continue
      const npos = L.voxelIndex(nx, ny, nz)
      const nv = r.get(nx, ny, nz)
      if (nv === AIR) { c.outlets.push(npos); continue }
      if (flowGroup(reg, nv) !== c.liquid) continue
      if (this.marks.has(nx, ny, nz) || !this.o.claimable(nx, ny, nz, npos)) { c.edges.push([pos, npos]); continue }
      const units = volumeOf(reg, nv)
      const fits = ny === c.surfaceY
        ? units - 1 === c.level && flowGroup(reg, r.get(nx, ny + 1, nz)) !== c.liquid
        : units === FULL && this.ownsColumn(r, nx, ny, nz)
      if (fits) this.claim(nx, ny, nz, npos)
      else c.edges.push([pos, npos])
    }
  }

  /**
   * A deep cell belongs to this body only if its water column ends at this body's surface (same level)
   * or under a ceiling. A column that ends lower with air above is a separate body with its own,
   * lower surface: the two become pools in contact, so connected water at different heights is never
   * forced flat at the higher one.
   */
  private ownsColumn(r: JobReader, x: number, y: number, z: number): boolean {
    const c = this.comp!, reg = this.o.registry
    for (let yy = y + 1; yy <= c.surfaceY + 1; yy++) {
      if (this.cur.has(x, yy, z)) return true
      const v = r.get(x, yy, z)
      if (flowGroup(reg, v) === c.liquid) {
        if (yy > c.surfaceY) return false
        continue
      }
      const top = yy - 1
      if (top === c.surfaceY) return volumeOf(reg, r.get(x, top, z)) - 1 === c.level
      return v !== AIR // a ceiling keeps the cave in the body; air means a lower, open surface
    }
    return false
  }

  private close(): void {
    const c = this.comp!
    for (const pos of c.deep) {
      const y = Math.floor(pos / this.layer), rest = pos - y * this.layer, z = Math.floor(rest / this.sx), x = rest - z * this.sx
      if (!this.cur.has(x, y + 1, z)) c.capped.push(pos)
    }
    this.cur = new ChunkBits(this.o.layout)
    this.components.push(c)
    this.comp = null
    this.queue = []
    this.head = 0
  }
}
```

- [ ] **Step 5: Implement the fluid system skeleton**

Create `packages/engine/src/sim/fluids/fluidSystem.ts`. Later tasks add the step phases and more hook logic to this file. Keep the section comments, because those tasks insert code under them.

```ts
import type { BlockRegistry } from '../../blocks/registry.ts'
import { decodeUniform } from '../../world/buffers.ts'
import type { ChunkStore } from '../../world/chunkStore.ts'
import type { Layout } from '../../world/layout.ts'
import { AIR, voxelId, voxelState } from '../../world/voxel.ts'
import { JobReader, type JobRunner } from '../jobs.ts'
import { ActiveQueue } from './activeQueue.ts'
import { flowGroup, volumeOf } from './cell.ts'
import { ChunkBits } from './chunkBits.ts'
import { ContactTable } from './contacts.ts'
import { PoolTable, type Pool } from './pools.ts'
import { FLUID_JOBS, PoolScan, sortSeeds, type ScanComponent } from './scan.ts'
import { SurfaceIndex } from './surfaceIndex.ts'

/** Who wrote a voxel: a command or rule ('external'), the fluid system itself, or gravity. */
export type WriteSource = 'external' | 'fluid' | 'gravity'

export interface FluidOptions {
  /** Ticks between fluid steps. Default 2 (10 Hz at 20 Hz). */
  fluidEvery: number
  /** Active cells processed per fluid step; the rest wait their turn. Default 20 000. */
  fluidCap: number
  /** Units a pool pushes through one outlet or contact face per fluid step. Default 8. */
  outletRate: number
}
export const DEFAULT_FLUID_OPTIONS: FluidOptions = { fluidEvery: 2, fluidCap: 20_000, outletRate: 8 }

/** What the fluid system needs from the Simulation. */
export interface FluidPort {
  readonly layout: Layout
  readonly registry: BlockRegistry
  readonly store: ChunkStore
  readonly jobs: JobRunner
  readonly epochs: Uint32Array
  get(x: number, y: number, z: number): number
  /** Writes through the simulation as a 'fluid' write (light, rule notifications, write hooks). */
  write(x: number, y: number, z: number, v: number): void
  log(message: string): void
}

export const DX = [1, -1, 0, 0, 0, 0]
export const DY = [0, 0, 1, -1, 0, 0]
export const DZ = [0, 0, 0, 0, 1, -1]

/** Water in the world: moving cells, still pools, springs (spec §4; design notes in the 3a plan). */
export class FluidSystem {
  readonly o: FluidOptions
  readonly index: SurfaceIndex
  readonly members: ChunkBits
  readonly pools: PoolTable
  readonly contacts = new ContactTable()
  readonly active = new ActiveQueue()
  /** Spring positions in the order they appeared. */
  readonly springs = new Set<number>()
  /** Displaced water that found no room (planning deviation 8). Part of the conservation identity. */
  lost = 0
  /** Set by replaceColumns: the next fluid step rescans the world. */
  needsRebuild = false
  /** From the generator's configure(). The cycle pool's surface is seaLevel − 1; 0 means no sea. */
  seaLevel = 0
  protected steps = 0
  protected hadCycle = false
  protected cycleId = 0
  protected readonly settleQueue = new Set<number>()
  protected readonly port: FluidPort
  protected readonly reg: BlockRegistry
  protected readonly layout: Layout

  constructor(port: FluidPort, o: Partial<FluidOptions> = {}) {
    this.port = port
    this.reg = port.registry
    this.layout = port.layout
    this.o = { ...DEFAULT_FLUID_OPTIONS, ...o }
    for (const [k, v] of Object.entries(this.o)) {
      if (!Number.isInteger(v) || v < 1) throw new RangeError(`fluid option ${k} must be an integer ≥ 1, got ${v}`)
    }
    this.index = new SurfaceIndex(this.layout)
    this.members = new ChunkBits(this.layout)
    this.pools = new PoolTable(this.layout, this.index, this.members)
  }

  get activeCount(): number { return this.active.size }
  get stepCount(): number { return this.steps }
  /** The pool springs draw from, if the world has a sea. */
  get cycle(): Pool | undefined { return this.cycleId === 0 ? undefined : this.pools.get(this.cycleId) }

  poolAt(x: number, y: number, z: number): Pool | undefined { return this.pools.ownerOf(x, y, z) }

  // ---- write hooks ----

  /** Before a voxel changes: the pool owning the cell (its id), or 0. Fluid writes keep their own books. */
  beforeWrite(x: number, y: number, z: number, _old: number, source: WriteSource): number {
    if (source === 'fluid' || !this.members.has(x, y, z)) return 0
    return this.pools.ownerOf(x, y, z)?.id ?? 0
  }

  /** After a voxel changed. `owner` is what beforeWrite returned. */
  afterWrite(x: number, y: number, z: number, old: number, v: number, _source: WriteSource, _owner: number): void {
    const pos = this.layout.voxelIndex(x, y, z)
    if (this.reg.source[voxelId(old)] === 1) this.springs.delete(pos)
    if (this.reg.source[voxelId(v)] === 1) this.springs.add(pos)
    this.wakeAround(x, y, z)
  }

  /** Activates a moving liquid cell (not a pool member) at (x, y, z), if any. */
  wake(x: number, y: number, z: number): void {
    const [sx, sy, sz] = this.layout.size
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return
    if (flowGroup(this.reg, this.port.get(x, y, z)) === 0 || this.members.has(x, y, z)) return
    this.active.add(this.layout.voxelIndex(x, y, z))
  }

  wakeAround(x: number, y: number, z: number): void {
    this.wake(x, y, z)
    for (let d = 0; d < 6; d++) this.wake(x + DX[d]!, y + DY[d]!, z + DZ[d]!)
  }

  // ---- step ----

  step(tick: number): void {
    if (this.needsRebuild) this.rebuild()
    if (tick % this.o.fluidEvery !== 0) return
    this.steps++
    // Fluid-step phases (Tasks 5–8 add them here, in this order):
    // flowCells, runOutlets, runContacts, runSprings, queueResurfaces, queueSettles
  }

  // ---- rebuild ----

  /** Drops all fluid state and rescans the world: every still body becomes a pool, everything else moves. */
  rebuild(): void {
    this.needsRebuild = false
    this.pools.clear(); this.index.clear(); this.members.clear(); this.contacts.clear()
    this.active.clear(); this.springs.clear(); this.settleQueue.clear()
    this.port.jobs.cancel((j) => FLUID_JOBS.has(j.kind))
    const seeds: number[] = []
    this.forEachLiquid((x, y, z, pos, v) => {
      if (this.reg.source[voxelId(v)] === 1) { this.springs.add(pos); return }
      const g = flowGroup(this.reg, v)
      if (flowGroup(this.reg, this.port.get(x, y + 1, z)) !== g) seeds.push(pos)
    })
    const scan = new PoolScan({
      kind: 'rebuild', registry: this.reg, layout: this.layout, seeds: sortSeeds(this.layout, seeds),
      claimable: (x, y, z) => !this.members.has(x, y, z),
      onFinish: (cs) => { this.install(cs) },
    })
    scan.step(new JobReader(this.layout, this.port.epochs, (x, y, z) => this.port.get(x, y, z)), Infinity)
    scan.finish()
    this.forEachLiquid((x, y, z, pos, v) => {
      if (flowGroup(this.reg, v) !== 0 && !this.members.has(x, y, z)) this.active.add(pos)
    })
    this.pickCycle()
  }

  /** Creates a pool per component: index, member bits, capped tops, outlets; then links edges (contacts or wake-ups). */
  install(cs: readonly ScanComponent[]): Pool[] {
    const out: Pool[] = []
    for (const c of cs) {
      const p = this.pools.create(c.liquid, c.surfaceY, c.level)
      p.area = c.surface.length
      p.grid = c.grid
      for (const pos of c.surface) {
        const [x, y, z] = this.layout.voxelCoords(pos)
        this.members.add(x, y, z)
        p.tiles.add(this.index.set(x, y, z, p.id))
      }
      for (const pos of c.deep) {
        const [x, y, z] = this.layout.voxelCoords(pos)
        this.members.add(x, y, z)
      }
      for (const pos of c.capped) { this.pools.capped.set(pos, p.id); p.capped.add(pos) }
      for (const pos of c.outlets) p.outlets.add(pos)
      out.push(p)
    }
    cs.forEach((c, k) => { for (const [own, other] of c.edges) this.link(out[k]!, own, other) })
    return out
  }

  /** A same-liquid neighbour of pool p's cell `own`: a contact if another pool owns it, else it moves. */
  protected link(p: Pool, own: number, other: number): void {
    const [x, y, z] = this.layout.voxelCoords(other)
    if (this.members.has(x, y, z)) {
      const q = this.pools.ownerOf(x, y, z)
      if (q && q !== p) this.contacts.add(p.id, own, q.id, other)
      return
    }
    this.wake(x, y, z)
  }

  /** The cycle pool is the largest pool at the sea's surface (seaLevel − 1). */
  protected pickCycle(): void {
    this.cycleId = 0
    let best: Pool | undefined
    if (this.seaLevel > 0) {
      for (const p of this.pools.all()) if (p.surfaceY === this.seaLevel - 1 && (!best || p.area > best.area)) best = p
    }
    if (best) { best.cycle = true; this.cycleId = best.id }
    this.hadCycle = best !== undefined
  }

  /** Every liquid voxel (springs included), chunk by chunk in index order. Reads the store directly: fast enough for a whole-world pass. */
  protected forEachLiquid(fn: (x: number, y: number, z: number, pos: number, v: number) => void): void {
    const L = this.layout, store = this.port.store, liquid = this.reg.liquid
    for (let ci = 0; ci < L.chunkCount; ci++) {
      const e = store.table[ci]!
      const uniform = e < 0 ? decodeUniform(e) : -1
      if (uniform >= 0 && liquid[voxelId(uniform)] !== 1) continue
      const vox = uniform >= 0 ? null : store.views.voxels(e)
      const [cx, cy, cz] = L.chunkCoords(ci)
      for (let i = 0; i < 32768; i++) {
        const v = vox ? vox[i]! : uniform
        if (liquid[v & 0xfff] !== 1) continue
        const x = cx * 32 + (i & 31), z = cz * 32 + ((i >> 5) & 31), y = cy * 32 + (i >> 10)
        fn(x, y, z, L.voxelIndex(x, y, z), v)
      }
    }
  }

  /** Exact liquid units: every flowing cell, plus pool balances, plus lost. Springs are not counted. */
  totalVolume(): number {
    let n = this.lost
    for (const p of this.pools.all()) n += p.balance
    this.forEachLiquid((_x, _y, _z, _pos, v) => {
      if (this.reg.source[voxelId(v)] !== 1) n += (voxelState(v) & 7) + 1
    })
    return n
  }

  mixState(mix: (v: number) => void): void {
    mix(this.steps); mix(this.lost); mix(this.seaLevel); mix(this.cycleId)
    mix((this.hadCycle ? 1 : 0) | (this.needsRebuild ? 2 : 0))
    this.pools.mixState(mix)
    this.contacts.mixState(mix)
    this.active.mixState(mix)
    mix(this.springs.size)
    for (const s of this.springs) mix(s)
    mix(this.settleQueue.size)
  }
}

export { AIR, volumeOf }
```

The final `export { AIR, volumeOf }` line exists only so the imports used by later tasks resolve while this skeleton is unused. Remove it in Task 5 once `flowCells` uses them.

- [ ] **Step 6: Let generators report the sea level**

In `packages/engine/src/sim/generator.ts`, add after `GeneratorInfo`:

```ts
/** What a generator may return from configure(). */
export interface GeneratorConfig {
  /** Water fills y < seaLevel; the pool at seaLevel − 1 is the sea that springs draw from. */
  seaLevel?: number
}
```

Change `configure?` in `GeneratorModule` to:

```ts
  configure?(doc: unknown, info: GeneratorInfo): void | GeneratorConfig
```

In `packages/engine/src/sim/runSimWorker.ts`, extend the generator type export:

```ts
export type { GeneratorConfig, GeneratorContext, GeneratorInfo, GeneratorModule } from './generator.ts'
export type { FluidOptions, WriteSource } from './fluids/fluidSystem.ts'
```

- [ ] **Step 7: Wire the fluid system into `Simulation`**

In `packages/engine/src/sim/simulation.ts`:

1. Imports:

```ts
import { FluidSystem, type FluidOptions, type WriteSource } from './fluids/fluidSystem.ts'
```

2. `SimulationOptions`: add `fluids?: Partial<FluidOptions>`.

3. Field after `readonly jobs: JobRunner`: `readonly fluids: FluidSystem`.

4. In the constructor, after the `this.jobCap = …` line:

```ts
    const sim = this
    this.fluids = new FluidSystem({
      layout: this.layout, registry: this.registry, store: this.store, jobs: this.jobs, epochs: this.epochs,
      get: (x, y, z) => sim.store.getVoxel(x, y, z),
      write: (x, y, z, v) => sim.applySet(x, y, z, v, true, 'fluid'),
      log: (m) => sim.log(m),
    }, o.fluids)
```

`this.log` is assigned later in the constructor. The arrow reads it at call time, so the order is fine.

5. Replace `configure` with:

```ts
  /** Hands the generator its document (GeneratorModule.configure). Throws if the generator rejects it. */
  configure(gen: GeneratorModule, doc: unknown): void {
    const r = gen.configure?.(doc, { size: this.layout.size, seed: this.seed, id: (name) => this.registry.id(name) })
    const sea = r && typeof r === 'object' ? r.seaLevel : undefined
    this.fluids.seaLevel = Number.isInteger(sea) && (sea as number) > 0 ? (sea as number) : 0
  }
```

6. In `finishGenerate()`, after `this.store.commit()`:

```ts
    this.fluids.rebuild()
```

7. In `replaceColumns`, right after `if (writes.length === 0) return []`:

```ts
    this.fluids.needsRebuild = true
```

8. Change `applySet` to take the source and call the hooks:

```ts
  private applySet(x: number, y: number, z: number, v: number, notify: boolean, source: WriteSource = 'external'): void {
    const old = this.store.getVoxel(x, y, z)
    if (old === v || !this.layout.inBounds(x, y, z)) return
    const owner = this.fluids.beforeWrite(x, y, z, old, source)
    if (!this.store.setVoxel(x, y, z, v)) return
    this.epochs[this.layout.chunkOf(x, y, z)]!++
    // Light depends only on a block's opacity and emission, which belong to its id: a state change cannot move it.
    if (voxelId(old) !== voxelId(v)) this.light.onVoxelChanged(x, y, z, old, v)
    this.fluids.afterWrite(x, y, z, old, v, source, owner)
    if (!notify || !this.hasNeighborRules) return
    this.neighbors.push(this.layout.voxelIndex(x, y, z))
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
      if (this.layout.inBounds(nx, ny, nz)) this.neighbors.push(this.layout.voxelIndex(nx, ny, nz))
    }
  }
```

9. In `step()`, inside `if (!this.isPaused) {`, before `this.jobs.run(this.jobCap)`:

```ts
        // 4. fluids
        this.fluids.step(t)
```

10. In `hash()`, before `this.jobs.mixState(mix)`:

```ts
    this.fluids.mixState(mix)
```

- [ ] **Step 8: Run the scan tests and the whole engine suite**

Run: `cd packages/engine && npx vitest run && npx tsc --noEmit -p .`

Expected: `poolScan.test.ts` PASS (7 tests), every other file PASS, and the typecheck exits 0.

If "splits stepped water into pools in contact" counts 2 contacts: the west pool's deep cells at y = 3 touch the east pool's surface cells, and every face pair lands in one `Contact`. Check that `ContactTable.add` normalises the id order.

- [ ] **Step 9: Commit**

```bash
git add packages/engine/src/sim/fluids/scan.ts packages/engine/src/sim/fluids/fluidSystem.ts packages/engine/src/sim/simulation.ts packages/engine/src/sim/generator.ts packages/engine/src/sim/runSimWorker.ts packages/engine/test/fluidHelpers.ts packages/engine/test/poolScan.test.ts
git commit -m "feat(engine): pool scans and the fluid system rebuild; write hooks and sea level from the generator"
```

---

### Task 5: The cell automaton, external writes and displacement

**Files:**
- Modify: `packages/engine/src/sim/fluids/fluidSystem.ts`
- Test: `packages/engine/test/fluidCells.test.ts`

**Interfaces:**
- Consumes: the Task 4 skeleton (`afterWrite`, `wakeAround`, the `step` phase comment), plus `ActiveQueue`, `PoolTable` and `ChunkBits`.
- Produces, on `FluidSystem`:
  - constants `SLEEP_STEPS = 4` and `DROP_REACH = 4` (exported);
  - `protected flowCells()`, `propose`, `applyProposals`, `room`, `sideVolume`, `leadsToDrop`;
  - `protected external()`, `leave()`, `displace()`, `pour()`, `openNear()`;
  - `accepts(p, t): boolean`, `inside(x, y, z): boolean`.
  - The `step` phase list gains `this.flowCells()`.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/test/fluidCells.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { AIR } from '../src/world/voxel.ts'
import { B, basin, fluidSim, run, settle, volume, w } from './fluidHelpers.ts'

const level = (v: number) => (v >>> 12) & 7
const units = (v: number) => ((v & 0xfff) === B.water ? level(v) + 1 : 0)

/** Stone floor at y = 0 only. */
const floor = (x: number, y: number, z: number) => (y === 0 ? B.stone : AIR)

describe('cell automaton', () => {
  it('drops a cell straight down and keeps its volume', () => {
    const sim = fluidSim(floor)
    sim.submit(0, 0, { type: 'setBlock', pos: [10, 12, 10], voxel: w(7) })
    const before = 8
    for (let t = 0; t < 30; t++) { sim.step(); expect(volume(sim)).toBe(before) }
    expect(units(sim.store.getVoxel(10, 12, 10))).toBe(0)
    let below = 0
    for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) below += units(sim.store.getVoxel(x, 1, z))
    expect(below).toBe(8)
  })
  it('spreads on a flat floor until no neighbours differ by 2 or more, then sleeps', () => {
    const sim = fluidSim(floor)
    sim.submit(0, 0, { type: 'setBlock', pos: [16, 1, 16], voxel: w(7) })
    sim.step()
    settle(sim)
    expect(volume(sim)).toBe(8)
    for (let x = 1; x < 31; x++) for (let z = 1; z < 31; z++) {
      const u = units(sim.store.getVoxel(x, 1, z))
      for (const [dx, dz] of [[1, 0], [0, 1]] as const) expect(Math.abs(u - units(sim.store.getVoxel(x + dx, 1, z + dz)))).toBeLessThan(2)
    }
    expect(sim.fluids.activeCount).toBe(0)
  })
  it('prefers a side that leads to a drop within reach', () => {
    // a ledge at y ≤ 4 for x < 20; at x ≥ 20 the floor is y = 0
    const sim = fluidSim((x, y) => (y === 0 || (x < 20 && y <= 4) ? B.stone : AIR))
    sim.submit(0, 0, { type: 'setBlock', pos: [18, 5, 10], voxel: w(7) })
    sim.step() // the command lands; the fluid step runs the same tick
    expect(units(sim.store.getVoxel(19, 5, 10))).toBeGreaterThan(0)
    expect(units(sim.store.getVoxel(17, 5, 10))).toBe(0)
  })
  it('processes at most fluidCap cells per step, in order', () => {
    const sim = fluidSim(floor, { fluids: { fluidCap: 1 } })
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 10, 5], voxel: w(7) })
    sim.submit(0, 1, { type: 'setBlock', pos: [20, 10, 20], voxel: w(7) })
    sim.step()
    expect(units(sim.store.getVoxel(5, 9, 5))).toBe(8)
    expect(units(sim.store.getVoxel(20, 10, 20))).toBe(8) // still waiting its turn
  })
  it('stays inside the world at every edge', () => {
    const sim = fluidSim(() => AIR)
    sim.submit(0, 0, { type: 'setBlock', pos: [0, 0, 0], voxel: w(7) })
    sim.submit(0, 1, { type: 'setBlock', pos: [31, 31, 31], voxel: w(7) })
    sim.submit(0, 2, { type: 'setBlock', pos: [31, 0, 0], voxel: w(7) })
    sim.step()
    settle(sim)
    expect(volume(sim)).toBe(24)
    expect(sim.fluids.lost).toBe(0)
  })
})

describe('external writes', () => {
  it('displaces loose water up when a solid replaces it', () => {
    const sim = fluidSim(floor)
    sim.submit(0, 0, { type: 'setBlock', pos: [10, 1, 10], voxel: w(3) })
    sim.step()
    const v0 = volume(sim)
    sim.submit(0, 1, { type: 'fillRegion', min: [8, 1, 8], max: [12, 1, 12], voxel: B.stone })
    sim.step()
    expect(volume(sim)).toBe(v0)
  })
  it('credits a pool when a solid replaces one of its cells, and loses what a command deletes', () => {
    const b = basin(12, 8)
    const sim = fluidSim((x, y, z) => (b(x, y, z) !== AIR ? b(x, y, z) : x > 0 && x < 11 && z > 0 && z < 11 && y >= 1 && y <= 4 ? w(7) : AIR))
    const [p] = sim.fluids.pools.all()
    const v0 = volume(sim)
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 2, 5], voxel: B.stone })
    sim.step()
    expect(volume(sim)).toBe(v0)
    expect(p!.balance).toBe(8)
    expect(sim.fluids.members.has(5, 2, 5)).toBe(false)
    sim.submit(0, 1, { type: 'setBlock', pos: [6, 4, 6], voxel: AIR })
    sim.step()
    expect(volume(sim)).toBe(v0 - 8)
    expect(p!.area).toBe(99)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/engine && npx vitest run test/fluidCells.test.ts`

Expected: FAIL. Placed water never moves, so "drops a cell straight down" fails on `units(...)` at y = 12 still being 8.

- [ ] **Step 3: Add the automaton**

In `packages/engine/src/sim/fluids/fluidSystem.ts`:

1. Change the cell import to `import { FULL, flowGroup, liquidVoxel, volumeOf } from './cell.ts'`, and delete the temporary `export { AIR, volumeOf }` line at the bottom of the file.

2. Add the constants after `DZ`:

```ts
/** Fluid steps without change before a moving cell sleeps (and is offered to a settle scan). */
export const SLEEP_STEPS = 4
/** How far along a side a cell looks for a drop before it prefers that side. */
export const DROP_REACH = 4
/** +x, +z, −x, −z. */
const SIDES: readonly (readonly [number, number])[] = [[1, 0], [0, 1], [-1, 0], [0, -1]]
```

3. Add the proposal buffers as fields, after `protected readonly layout: Layout`:

```ts
  private readonly pFrom: number[] = []
  private readonly pTo: number[] = []
  private readonly pAmt: number[] = []
  private readonly pGroup: number[] = []
```

4. Replace the `step` method's phase comment with the first phase:

```ts
  step(tick: number): void {
    if (this.needsRebuild) this.rebuild()
    if (tick % this.o.fluidEvery !== 0) return
    this.steps++
    this.flowCells()
    // Fluid-step phases added by Tasks 6–8, in this order:
    // runOutlets, runContacts, runSprings, queueResurfaces, queueSettles
  }
```

5. Add these methods to the class, after `wakeAround`:

```ts
  inside(x: number, y: number, z: number): boolean {
    const [sx, sy, sz] = this.layout.size
    return x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz
  }

  /** A sealed pool takes water only while it stays below its next level. */
  accepts(p: Pool, t: number): boolean {
    return !p.sealed || p.balance + t < p.area
  }

  // ---- automaton ----

  /** One step for up to fluidCap active cells: every cell proposes from the same snapshot, then proposals apply in order. */
  protected flowCells(): void {
    const cells = this.active.take(this.o.fluidCap)
    this.pFrom.length = 0; this.pTo.length = 0; this.pAmt.length = 0; this.pGroup.length = 0
    const keep: number[] = []
    for (const pos of cells) {
      const [x, y, z] = this.layout.voxelCoords(pos)
      const v = this.port.get(x, y, z)
      const g = flowGroup(this.reg, v)
      if (g === 0 || this.members.has(x, y, z)) { this.active.drop(pos); continue }
      this.propose(pos, x, y, z, g, volumeOf(this.reg, v))
      keep.push(pos)
    }
    const touched = this.applyProposals()
    for (const pos of keep) {
      if (!this.active.has(pos)) continue
      if (touched.has(pos)) { this.active.requeue(pos); continue }
      if (this.active.rest(pos) >= SLEEP_STEPS) { this.active.drop(pos); this.settleQueue.add(pos) }
      else this.active.requeue(pos)
    }
  }

  /** Down first, then sideways by halving differences of 2 or more; sides that lead to a drop win. */
  protected propose(pos: number, x: number, y: number, z: number, g: number, units: number): void {
    let v = units
    if (y > 0) {
      const room = this.room(x, y - 1, z, g)
      if (room > 0) {
        const t = Math.min(v, room)
        this.offer(pos, this.layout.voxelIndex(x, y - 1, z), t, g)
        v -= t
      }
    }
    if (v < 2) return
    const start = (this.steps + pos) & 3
    const cand: number[] = [], vols: number[] = [], drops: boolean[] = []
    for (let i = 0; i < 4; i++) {
      const s = (start + i) & 3
      const [dx, dz] = SIDES[s]!
      const vn = this.sideVolume(x + dx, y, z + dz, g)
      if (vn < 0 || v - vn < 2) continue
      cand.push(s); vols.push(vn); drops.push(this.leadsToDrop(x, y, z, dx, dz))
    }
    const anyDrop = drops.includes(true)
    for (let k = 0; k < cand.length; k++) {
      if (anyDrop && !drops[k]) continue
      const t = (v - vols[k]!) >> 1
      if (t <= 0) continue
      const [dx, dz] = SIDES[cand[k]!]!
      this.offer(pos, this.layout.voxelIndex(x + dx, y, z + dz), t, g)
      v -= t
    }
  }

  private offer(from: number, to: number, amount: number, g: number): void {
    this.pFrom.push(from); this.pTo.push(to); this.pAmt.push(amount); this.pGroup.push(g)
  }

  /** Room for liquid g: air takes FULL, a moving cell of g what it lacks; members, solids and other liquids none. */
  protected room(x: number, y: number, z: number, g: number): number {
    if (!this.inside(x, y, z) || this.members.has(x, y, z)) return 0
    const v = this.port.get(x, y, z)
    if (v === AIR) return FULL
    return flowGroup(this.reg, v) === g ? FULL - volumeOf(this.reg, v) : 0
  }

  /** A side's current units (air = 0), or −1 when water cannot go there. */
  protected sideVolume(x: number, y: number, z: number, g: number): number {
    if (!this.inside(x, y, z) || this.members.has(x, y, z)) return -1
    const v = this.port.get(x, y, z)
    if (v === AIR) return 0
    return flowGroup(this.reg, v) === g ? volumeOf(this.reg, v) : -1
  }

  /** True if walking up to DROP_REACH cells of air along (dx, dz) reaches a cell with air below. */
  protected leadsToDrop(x: number, y: number, z: number, dx: number, dz: number): boolean {
    if (y === 0) return false
    for (let k = 1; k <= DROP_REACH; k++) {
      const nx = x + dx * k, nz = z + dz * k
      if (!this.inside(nx, y, nz) || this.port.get(nx, y, nz) !== AIR) return false
      if (this.port.get(nx, y - 1, nz) === AIR) return true
    }
    return false
  }

  /** Applies proposals in order, capped by what the sender still has and the receiver's room; writes each changed cell once. */
  protected applyProposals(): Set<number> {
    const delta = new Map<number, number>()
    const group = new Map<number, number>()
    const units = (pos: number): number => {
      const [x, y, z] = this.layout.voxelCoords(pos)
      return volumeOf(this.reg, this.port.get(x, y, z)) + (delta.get(pos) ?? 0)
    }
    for (let k = 0; k < this.pFrom.length; k++) {
      const f = this.pFrom[k]!, t = this.pTo[k]!, g = this.pGroup[k]!
      const [tx, ty, tz] = this.layout.voxelCoords(t)
      if (this.members.has(tx, ty, tz)) continue
      const tv = this.port.get(tx, ty, tz)
      if (tv !== AIR && flowGroup(this.reg, tv) !== g) continue
      const a = Math.min(this.pAmt[k]!, units(f), FULL - units(t))
      if (a <= 0) continue
      delta.set(f, (delta.get(f) ?? 0) - a)
      delta.set(t, (delta.get(t) ?? 0) + a)
      group.set(f, g)
      group.set(t, g)
    }
    const touched = new Set<number>()
    for (const [pos, d] of delta) {
      if (d === 0) continue
      const [x, y, z] = this.layout.voxelCoords(pos)
      this.port.write(x, y, z, liquidVoxel(group.get(pos)!, volumeOf(this.reg, this.port.get(x, y, z)) + d))
      touched.add(pos)
    }
    return touched
  }
```

- [ ] **Step 4: Account for external writes**

Replace `afterWrite` with:

```ts
  /** After a voxel changed. `owner` is what beforeWrite returned. */
  afterWrite(x: number, y: number, z: number, old: number, v: number, source: WriteSource, owner: number): void {
    const pos = this.layout.voxelIndex(x, y, z)
    if (this.reg.source[voxelId(old)] === 1) this.springs.delete(pos)
    if (this.reg.source[voxelId(v)] === 1) this.springs.add(pos)
    if (source !== 'fluid') this.external(x, y, z, pos, old, v, owner)
    if (v === AIR) this.openNear(x, y, z, pos)
    this.wakeAround(x, y, z)
  }
```

Add after it:

```ts
  /** A command, rule or landing body replaced a liquid cell: keep the pool's books, or push loose water aside. */
  protected external(x: number, y: number, z: number, pos: number, old: number, v: number, owner: number): void {
    if (owner === 0 && this.members.has(x, y, z)) {
      // An orphaned member bit (no pool owns it) must not outlive its water.
      this.members.delete(x, y, z)
      this.pools.capped.delete(pos)
    }
    const g = flowGroup(this.reg, old)
    if (g === 0) return
    const units = volumeOf(this.reg, old)
    const solid = this.reg.solid[voxelId(v)] === 1
    const p = owner !== 0 ? this.pools.get(owner) : undefined
    if (p) {
      this.leave(p, x, y, z, pos, units)
      // Displaced into the pool, unless that was its last surface cell: then the water goes up like loose water.
      if (solid) {
        if (p.area > 0) p.balance += units
        else this.displace(x, y + 1, z, g, units)
      }
      return
    }
    if (solid) this.displace(x, y + 1, z, g, units)
  }

  /** A member cell was overwritten: it leaves its pool, and the member below now tops its column. */
  protected leave(p: Pool, x: number, y: number, z: number, pos: number, units: number): void {
    this.members.delete(x, y, z)
    p.grid -= units
    if (y === p.surfaceY && this.pools.resolve(this.index.get(x, y, z)) === p.id) {
      this.index.delete(x, y, z)
      p.area--
    }
    if (this.pools.capped.delete(pos)) p.capped.delete(pos)
    if (y > 0 && this.members.has(x, y - 1, z)) {
      const below = this.layout.voxelIndex(x, y - 1, z)
      this.pools.capped.set(below, p.id)
      p.capped.add(below)
    }
  }

  /** A cell became air: each pool touching it at y ≤ its surface gains an outlet there. */
  protected openNear(x: number, y: number, z: number, pos: number): void {
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
      if (!this.members.has(nx, ny, nz)) continue
      const p = this.pools.ownerOf(nx, ny, nz)
      if (p && y <= p.surfaceY) p.outlets.add(pos)
    }
  }

  /** Puts `units` of liquid g pushed out by a solid into the first room up the column (and its sides); the rest is lost. */
  protected displace(x: number, y: number, z: number, g: number, units: number): void {
    let left = units
    const H = this.layout.size[1]
    for (let k = 0; k < FULL && left > 0 && y + k < H; k++) {
      const yy = y + k
      left = this.pour(x, yy, z, g, left)
      for (const [dx, dz] of SIDES) if (left > 0) left = this.pour(x + dx, yy, z + dz, g, left)
      if (left > 0 && this.inside(x, yy, z) && this.reg.solid[voxelId(this.port.get(x, yy, z))] === 1) break // the column is closed above
    }
    if (left > 0) {
      this.lost += left
      this.port.log(`fluids: ${left} displaced units found no room above (${x}, ${y - 1}, ${z})`)
    }
  }

  /** Adds up to `left` units of g at a cell (air, a moving cell of g, or a pool member of g); returns what is left. */
  protected pour(x: number, y: number, z: number, g: number, left: number): number {
    if (!this.inside(x, y, z)) return left
    if (this.members.has(x, y, z)) {
      const p = this.pools.ownerOf(x, y, z)
      if (p && p.liquid === g && this.accepts(p, left)) { p.balance += left; return 0 }
      return left
    }
    const v = this.port.get(x, y, z)
    if (v === AIR) {
      const t = Math.min(left, FULL)
      this.port.write(x, y, z, liquidVoxel(g, t))
      return left - t
    }
    if (flowGroup(this.reg, v) !== g) return left
    const have = volumeOf(this.reg, v)
    const t = Math.min(left, FULL - have)
    if (t > 0) this.port.write(x, y, z, liquidVoxel(g, have + t))
    return left - t
  }
```

- [ ] **Step 5: Run the cell tests and the engine suite**

Run: `cd packages/engine && npx vitest run && npx tsc --noEmit -p .`

Expected: `fluidCells.test.ts` PASS (7 tests), everything else PASS, typecheck 0.

If "prefers a side that leads to a drop" fails because the cell first flows down: the cell at (18, 5, 10) stands on the ledge (y = 4 is stone at x < 20), so down has no room. Check that `room()` returns 0 for stone.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/sim/fluids/fluidSystem.ts packages/engine/test/fluidCells.test.ts
git commit -m "feat(engine): two-phase water automaton with drop preference and sleep; pool bookkeeping and displacement for external writes"
```

---

### Task 6: Pools take and give water: inlets, joins, outlets, settling

**Files:**
- Modify: `packages/engine/src/sim/fluids/fluidSystem.ts`
- Test: `packages/engine/test/pools.test.ts`; add `poolProblems` to `packages/engine/test/fluidHelpers.ts`

**Interfaces:**
- Consumes: Task 5's `flowCells`, `accepts`, `inside` and `openNear`; Task 4's `install`, `PoolScan` and `sortSeeds`.
- Produces, on `FluidSystem`:
  - `protected inlet(pos, x, y, z, g, v): boolean`, `join(p, x, y, z, pos, units)`, `adjacentPools(x, y, z): Pool[]`;
  - `protected supported(x, y, z)`, `closedAbove(p, x, y, z)`, `touches(p, x, y, z)`;
  - `protected runOutlets()`, `queueSettles()`, `finishSettle(cs)`;
  - `checkInvariants(): string[]` (public; empty when every pool is consistent).
  - The step order becomes `flowCells, runOutlets, …, queueSettles`.

- [ ] **Step 1: Add the invariant helper to the tests**

Append to `packages/engine/test/fluidHelpers.ts`:

```ts
/** Every pool-invariant violation in the world (see FluidSystem.checkInvariants); [] when consistent. */
export const poolProblems = (sim: Simulation): string[] => sim.fluids.checkInvariants()

/** A basin of side 12 (walls to y = 8) holding full water for 1 ≤ y ≤ top. */
export function lake(top: number, side = 12, wallTop = 8): Fill {
  const b = basin(side, wallTop)
  return (x, y, z) => {
    const v = b(x, y, z)
    if (v !== AIR) return v
    return x > 0 && x < side - 1 && z > 0 && z < side - 1 && y >= 1 && y <= top ? w(7) : AIR
  }
}
```

- [ ] **Step 2: Write the failing pool tests**

Create `packages/engine/test/pools.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { AIR } from '../src/world/voxel.ts'
import { B, fluidSim, lake, poolProblems, run, settle, volume, w } from './fluidHelpers.ts'

const units = (v: number) => ((v & 0xfff) === B.water ? ((v >>> 12) & 7) + 1 : 0)

describe('pools and moving water', () => {
  it('absorbs water falling onto its surface', () => {
    const sim = fluidSim(lake(4))
    const [p] = sim.fluids.pools.all()
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 5, 5], voxel: w(3) })
    sim.step()
    expect(sim.store.getVoxel(5, 5, 5)).toBe(AIR)
    expect(p!.balance).toBe(4)
    expect(poolProblems(sim)).toEqual([])
  })
  it('refills a cell dug out of its surface and takes it back', () => {
    const sim = fluidSim(lake(4))
    const [p] = sim.fluids.pools.all()
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 4, 5], voxel: AIR })
    run(sim, 3)
    expect(units(sim.store.getVoxel(5, 4, 5))).toBe(8)
    expect(sim.fluids.poolAt(5, 4, 5)).toBe(p)
    expect(p!.area).toBe(100)
    expect(poolProblems(sim)).toEqual([])
  })
  it('floods a tunnel under a ceiling and takes its cells in', () => {
    // a tunnel at y = 1, z = 5, running east from the lake through the wall to x = 20, with stone above it
    const base = lake(4)
    const sim = fluidSim((x, y, z) => {
      if (y === 0) return B.stone
      if (x >= 11 && x <= 20 && z >= 4 && z <= 6 && y <= 3) return y === 1 && z === 5 && x < 20 && x > 11 ? AIR : B.stone
      return base(x, y, z)
    })
    const [p] = sim.fluids.pools.all()
    const v0 = volume(sim)
    sim.submit(0, 0, { type: 'setBlock', pos: [11, 1, 5], voxel: AIR }) // open the wall
    settle(sim)
    for (let x = 11; x < 20; x++) expect(sim.fluids.poolAt(x, 1, 5)).toBe(p)
    expect(volume(sim)).toBe(v0)
    expect(poolProblems(sim)).toEqual([])
  })
  it('pours out through a breach onto a lower floor as moving water', () => {
    // the east wall is open at the surface layer; outside, the floor is y = 0
    const base = lake(4)
    const sim = fluidSim((x, y, z) => (x === 11 && y === 4 && z === 5 ? AIR : base(x, y, z)), { size: [64, 32, 32] })
    const v0 = volume(sim)
    run(sim, 40)
    let outside = 0
    for (let x = 12; x < 64; x++) for (let z = 0; z < 32; z++) for (let y = 1; y < 8; y++) outside += units(sim.store.getVoxel(x, y, z))
    expect(outside).toBeGreaterThan(0)
    expect(volume(sim)).toBe(v0)
  })
  it('settles a resting puddle into a flat pool', () => {
    const sim = fluidSim((x, y, z) => (y === 0 ? B.stone : (x === 3 || x === 7 || z === 3 || z === 7) && y <= 3 ? B.stone : AIR))
    sim.submit(0, 0, { type: 'fillRegion', min: [4, 1, 4], max: [6, 2, 6], voxel: w(7) })
    sim.step()
    settle(sim)
    const ps = sim.fluids.pools.all()
    expect(ps).toHaveLength(1)
    expect(ps[0]).toMatchObject({ surfaceY: 2, level: 7, area: 9 })
    expect(poolProblems(sim)).toEqual([])
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd packages/engine && npx vitest run test/pools.test.ts`

Expected: FAIL with "sim.fluids.checkInvariants is not a function".

- [ ] **Step 4: Implement inlets and joins**

In `fluidSystem.ts`:

1. Add the `PoolScan`/`sortSeeds`/`ScanComponent` usage: they are already imported in Task 4.

2. In `flowCells`, after `if (g === 0 || this.members.has(x, y, z)) { … continue }`, add:

```ts
      if (this.inlet(pos, x, y, z, g, volumeOf(this.reg, v))) {
        // Joined or absorbed cells left the queue. A cell waiting at a pool's edge stays in line and can still
        // fall asleep, so a pool that cannot fill it never leaves it active forever.
        if (this.active.has(pos)) keep.push(pos)
        continue
      }
```

3. Add these methods after `flowCells`:

```ts
  /** Pools owning a face neighbour of (x, y, z), by id. */
  protected adjacentPools(x: number, y: number, z: number): Pool[] {
    const out: Pool[] = []
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
      if (!this.members.has(nx, ny, nz)) continue
      const p = this.pools.ownerOf(nx, ny, nz)
      if (p && !out.includes(p)) out.push(p)
    }
    return out.sort((a, b) => a.id - b.id)
  }

  /** Resting: the world floor, a pool member, or any block that is neither air nor flowing liquid. */
  protected supported(x: number, y: number, z: number): boolean {
    if (y === 0 || this.members.has(x, y - 1, z)) return true
    const b = this.port.get(x, y - 1, z)
    return b !== AIR && flowGroup(this.reg, b) === 0
  }

  /** A deep cell may join p only with p's water or a ceiling above it (never air or loose water). */
  protected closedAbove(p: Pool, x: number, y: number, z: number): boolean {
    if (this.members.has(x, y + 1, z)) return this.pools.ownerOf(x, y + 1, z) === p
    const a = this.port.get(x, y + 1, z)
    return a !== AIR && flowGroup(this.reg, a) === 0
  }

  protected touches(p: Pool, x: number, y: number, z: number): boolean {
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
      if (this.members.has(nx, ny, nz) && this.pools.ownerOf(nx, ny, nz) === p) return true
    }
    return false
  }

  /**
   * A moving cell next to a pool (design notes: A cell next to a pool). Returns true when the pool took
   * the cell's step; false lets the automaton move the cell.
   */
  protected inlet(pos: number, x: number, y: number, z: number, g: number, v: number): boolean {
    const adj = this.adjacentPools(x, y, z)
    if (adj.length === 0) return false
    for (const p of adj) {
      if (p.frozen || p.liquid !== g || y !== p.surfaceY + 1) continue
      if (!this.members.has(x, y - 1, z) || this.pools.ownerOf(x, y - 1, z) !== p || !this.accepts(p, v)) continue
      p.balance += v // falling onto the surface
      this.active.drop(pos)
      this.port.write(x, y, z, AIR)
      return true
    }
    for (const p of adj) {
      if (p.frozen || p.liquid !== g || y > p.surfaceY) continue
      if (!this.supported(x, y, z)) { p.outlets.add(pos); return false }
      if (y === p.surfaceY) {
        const want = p.level + 1
        if (v < want) { p.outlets.add(pos); return true }
        if (v > want) {
          if (!this.accepts(p, v - want)) continue
          p.balance += v - want
          this.port.write(x, y, z, liquidVoxel(g, want))
        }
        this.join(p, x, y, z, pos, want)
        return true
      }
      if (v === FULL && this.closedAbove(p, x, y, z)) { this.join(p, x, y, z, pos, FULL); return true }
      p.outlets.add(pos)
      return false
    }
    return false
  }

  /** A cell becomes a member of p: index or capped entry, then its open neighbours become outlets or contacts. */
  protected join(p: Pool, x: number, y: number, z: number, pos: number, units: number): void {
    this.members.add(x, y, z)
    this.active.drop(pos)
    p.outlets.delete(pos)
    p.grid += units
    if (y === p.surfaceY) {
      p.tiles.add(this.index.set(x, y, z, p.id))
      p.area++
    } else if (!this.members.has(x, y + 1, z)) {
      this.pools.capped.set(pos, p.id)
      p.capped.add(pos)
    }
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
      if (!this.inside(nx, ny, nz) || ny > p.surfaceY) continue
      const npos = this.layout.voxelIndex(nx, ny, nz)
      if (this.members.has(nx, ny, nz)) {
        const q = this.pools.ownerOf(nx, ny, nz)
        if (q && q !== p) this.contacts.add(p.id, pos, q.id, npos)
        continue
      }
      const nv = this.port.get(nx, ny, nz)
      if (nv === AIR) p.outlets.add(npos)
      else if (flowGroup(this.reg, nv) === p.liquid) this.active.add(npos)
    }
  }
```

- [ ] **Step 5: Implement outlets and settling**

Add after `join`:

```ts
  /** Each pool fills its outlets once (design notes: Outlets), debiting its balance. */
  protected runOutlets(): void {
    for (const p of this.pools.all()) {
      if (p.frozen) continue
      for (const o of [...p.outlets]) {
        const [x, y, z] = this.layout.voxelCoords(o)
        if (y > p.surfaceY || this.members.has(x, y, z) || !this.touches(p, x, y, z)) { p.outlets.delete(o); continue }
        const v = this.port.get(x, y, z)
        const g = flowGroup(this.reg, v)
        if (v !== AIR && g !== p.liquid) { p.outlets.delete(o); continue }
        const have = g === 0 ? 0 : volumeOf(this.reg, v)
        let target = FULL
        if (y === p.surfaceY) {
          target = p.level + 1
          const onMember = this.members.has(x, y - 1, z) && this.pools.ownerOf(x, y - 1, z) === p
          if (!onMember && p.level < have + 1) { p.outlets.delete(o); continue }
        }
        const t = Math.min(target - have, this.o.outletRate, p.grid + p.balance)
        if (t <= 0) continue
        p.balance -= t
        this.port.write(x, y, z, liquidVoxel(p.liquid, have + t))
      }
    }
  }

  /** Cells that fell asleep this step: one settle scan from their column tops. */
  protected queueSettles(): void {
    if (this.settleQueue.size === 0) return
    const tops: number[] = []
    const seen = new Set<number>()
    const H = this.layout.size[1]
    for (const pos of this.settleQueue) {
      const [x, y0, z] = this.layout.voxelCoords(pos)
      const g = flowGroup(this.reg, this.port.get(x, y0, z))
      if (g === 0 || this.members.has(x, y0, z)) continue
      let y = y0
      while (y + 1 < H && !this.members.has(x, y + 1, z) && flowGroup(this.reg, this.port.get(x, y + 1, z)) === g) y++
      const top = this.layout.voxelIndex(x, y, z)
      if (this.active.has(top) || seen.has(top)) continue
      seen.add(top)
      tops.push(top)
    }
    this.settleQueue.clear()
    if (tops.length === 0) return
    this.port.jobs.start(new PoolScan({
      kind: 'settle', registry: this.reg, layout: this.layout, seeds: sortSeeds(this.layout, tops),
      claimable: (x, y, z, pos) => !this.members.has(x, y, z) && !this.active.has(pos),
      onFinish: (cs) => this.finishSettle(cs),
    }))
  }

  /** Installs settled bodies. A body with a cell that joined a pool meanwhile (joins write nothing, so the job did not go stale) is retried later. */
  protected finishSettle(cs: readonly ScanComponent[]): void {
    const fresh: ScanComponent[] = []
    for (const c of cs) {
      const cells = [...c.surface, ...c.deep]
      const clash = cells.some((pos) => { const [x, y, z] = this.layout.voxelCoords(pos); return this.members.has(x, y, z) })
      if (clash) { for (const pos of cells) this.settleQueue.add(pos) }
      else fresh.push(c)
    }
    this.install(fresh)
  }

  /** Every pool-invariant violation (design notes: Members and ownership). Whole-world: tests and debug builds only. */
  checkInvariants(): string[] {
    const out: string[] = []
    const grid = new Map<number, number>()
    const area = new Map<number, number>()
    this.forEachLiquid((x, y, z, _pos, v) => {
      if (!this.members.has(x, y, z)) return
      const p = this.pools.ownerOf(x, y, z)
      if (!p) { out.push(`member (${x}, ${y}, ${z}) has no owner`); return }
      if (p.frozen) return // a pending job may legitimately leave a frozen pool's cells out of date
      if (flowGroup(this.reg, v) !== p.liquid) { out.push(`member (${x}, ${y}, ${z}) is not pool ${p.id}'s liquid`); return }
      const u = volumeOf(this.reg, v)
      grid.set(p.id, (grid.get(p.id) ?? 0) + u)
      if (y > p.surfaceY) out.push(`member (${x}, ${y}, ${z}) is above pool ${p.id}'s surface ${p.surfaceY}`)
      else if (y === p.surfaceY && this.pools.resolve(this.index.get(x, y, z)) === p.id) {
        area.set(p.id, (area.get(p.id) ?? 0) + 1)
        if (u !== p.level + 1) out.push(`surface (${x}, ${y}, ${z}) holds ${u}, pool ${p.id} is at level ${p.level}`)
      } else if (y < p.surfaceY && u !== FULL) out.push(`deep (${x}, ${y}, ${z}) of pool ${p.id} holds ${u}`)
    })
    for (const p of this.pools.all()) {
      if (p.frozen) continue
      if ((grid.get(p.id) ?? 0) !== p.grid) out.push(`pool ${p.id} grid ${p.grid}, cells hold ${grid.get(p.id) ?? 0}`)
      if ((area.get(p.id) ?? 0) !== p.area) out.push(`pool ${p.id} area ${p.area}, surface cells ${area.get(p.id) ?? 0}`)
      if (p.grid + p.balance < 0) out.push(`pool ${p.id} has negative volume ${p.grid + p.balance}`)
    }
    return out
  }
```

Frozen pools are skipped, both per cell and in the totals: a pending job may legitimately leave them out of date. A merge, for instance, holds two levels until its resurface job runs.

- [ ] **Step 6: Add the phases to `step`**

Replace the `step` body's phase list:

```ts
    this.steps++
    this.flowCells()
    this.runOutlets()
    // runContacts, runSprings, queueResurfaces (Tasks 7–8)
    this.queueSettles()
```

- [ ] **Step 7: Run the tests**

Run: `cd packages/engine && npx vitest run && npx tsc --noEmit -p .`

Expected: `pools.test.ts` PASS (5 tests), every other file PASS, typecheck 0.

The breach test only checks that water left the lake and that volume holds. The lake's balance drifts negative here, because resurfacing arrives in Task 7.

- [ ] **Step 8: Commit**

```bash
git add packages/engine/src/sim/fluids/fluidSystem.ts packages/engine/test/fluidHelpers.ts packages/engine/test/pools.test.ts
git commit -m "feat(engine): pools absorb, join and refill water; outlets pour as streams; resting water settles into pools"
```

---

### Task 7: Resurfacing: flat level changes, new layers, layer drops and splits

**Files:**
- Create: `packages/engine/src/sim/fluids/resurface.ts`
- Modify: `packages/engine/src/sim/fluids/fluidSystem.ts`
- Test: `packages/engine/test/resurface.test.ts`

**Interfaces:**
- Consumes:
  - from Task 6: `join`, `install`, `checkInvariants`, `runOutlets`;
  - from Task 5: `leave` and `SIDES`;
  - `PoolScan` and `sortSeeds`.
- Produces:
  - `class Resurface implements RegionJob`, constructor `{ poolId, pools, index, layout, apply(poolId, cells) }`.
  - On `FluidSystem`:
    - `protected queueResurfaces()`, `resurface(p)`, `applyResurface(id, cells)`;
    - `protected split(p, extra)`, `rescan(p)`, `finishSplit(id, cs)`;
    - private `setLevel`, `layerAbove`, `raiseLayer`, `dropLayer`, `surfaceOutlets`, `isSurfaceOf`.
  - `leave()` starts a rescan when a pool loses its last surface cell.
  - The step order becomes `flowCells, runOutlets, queueResurfaces, queueSettles`. `runContacts` and `runSprings` slot in before `queueResurfaces` in Task 8.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/test/resurface.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { AIR } from '../src/world/voxel.ts'
import { B, fluidSim, lake, poolProblems, run, settle, volume, w } from './fluidHelpers.ts'

describe('resurfacing', () => {
  it('moves the whole surface when the balance passes the area', () => {
    const sim = fluidSim(lake(4))
    const [p] = sim.fluids.pools.all()
    const v0 = volume(sim)
    p!.balance = -100 // one level's worth, taken by hand
    run(sim, 2)
    expect(p).toMatchObject({ surfaceY: 4, level: 6, balance: 0, area: 100 })
    expect(volume(sim)).toBe(v0 - 100)
    expect(poolProblems(sim)).toEqual([])
  })
  it('adds a layer when a full pool keeps rising', () => {
    const sim = fluidSim(lake(4))
    const [p] = sim.fluids.pools.all()
    p!.balance = 800
    run(sim, 2)
    expect(p).toMatchObject({ surfaceY: 5, level: 7, area: 100, balance: 0 })
    expect(poolProblems(sim)).toEqual([])
  })
  it('seals a pool under a ceiling instead of rising', () => {
    const base = lake(4)
    const sim = fluidSim((x, y, z) => (y === 5 && x < 12 && z < 12 ? B.stone : base(x, y, z)))
    const [p] = sim.fluids.pools.all()
    p!.balance = 100
    run(sim, 2)
    expect(p).toMatchObject({ surfaceY: 4, level: 7, sealed: true })
    expect(sim.fluids.accepts(p!, 1)).toBe(false)
  })
  it('drops layers and splits a lake over a ridge', () => {
    const base = lake(4)
    const sim = fluidSim((x, y, z) => (x === 6 && y >= 1 && y <= 2 && z > 0 && z < 11 ? B.stone : base(x, y, z)))
    const [p] = sim.fluids.pools.all()
    const v0 = volume(sim)
    p!.balance -= 1600 // two layers' worth
    settle(sim)
    const ps = sim.fluids.pools.all()
    expect(ps.map((q) => [q.surfaceY, q.level, q.area]).sort()).toEqual([[2, 7, 40], [2, 7, 50]])
    expect(volume(sim)).toBe(v0 - 1600)
    expect(poolProblems(sim)).toEqual([])
  })
  it('drains flat through a hole into a cavern below', () => {
    // stone to y = 9 except a cavern (1 ≤ y ≤ 8); a 10 × 10 lake on top (y 10..13) with a hole in its floor
    const sim = fluidSim((x, y, z) => {
      const inLake = x >= 13 && x <= 22 && z >= 13 && z <= 22
      if (y === 0) return B.stone
      if (y <= 8) return x >= 1 && x <= 30 && z >= 1 && z <= 30 ? AIR : B.stone
      if (y === 9) return x === 17 && z === 17 ? AIR : B.stone
      if (y <= 16 && (x === 12 || x === 23 || z === 12 || z === 23) && x >= 12 && x <= 23 && z >= 12 && z <= 23) return B.stone
      return inLake && y <= 13 ? w(7) : AIR
    })
    const v0 = volume(sim)
    for (let t = 0; t < 700; t++) {
      sim.step()
      expect(volume(sim)).toBe(v0)
      if (t % 25 === 0) expect(poolProblems(sim)).toEqual([])
    }
    let lakeWater = 0
    for (let y = 10; y <= 13; y++) for (let x = 13; x <= 22; x++) for (let z = 13; z <= 22; z++) if (sim.store.getVoxel(x, y, z) !== AIR) lakeWater++
    expect(lakeWater).toBe(0)
  }, 60_000)
  it('rescans a pool whose whole surface a command removed', () => {
    const sim = fluidSim(lake(4))
    const v0 = volume(sim)
    sim.submit(0, 0, { type: 'fillRegion', min: [1, 4, 1], max: [10, 4, 10], voxel: AIR })
    settle(sim)
    const ps = sim.fluids.pools.all()
    expect(ps).toHaveLength(1)
    expect(ps[0]).toMatchObject({ surfaceY: 3, level: 7, area: 100 })
    expect(volume(sim)).toBe(v0 - 800)
    expect(poolProblems(sim)).toEqual([])
  })
  it('stays consistent when a command lands on a frozen pool (review focus 1)', () => {
    // a lake spanning two chunk columns, so a resurface job with jobCap 1 takes two ticks
    const sim = fluidSim((x, y, z) => {
      if (y === 0) return B.stone
      if (y <= 8 && x <= 47 && z <= 11 && (x === 0 || x === 47 || z === 0 || z === 11)) return B.stone // 48 × 12 basin walls
      return x > 0 && x < 47 && z > 0 && z < 11 && y >= 1 && y <= 4 ? w(7) : AIR
    }, { size: [64, 32, 32], jobCap: 1 })
    const [p] = sim.fluids.pools.all()
    const v0 = volume(sim)
    p!.balance = -p!.area
    sim.step() // the job starts and reads the first tile
    expect(p!.frozen).toBe(true)
    sim.submit(0, 0, { type: 'setBlock', pos: [40, 4, 5], voxel: B.stone }) // lands mid-job
    settle(sim)
    expect(volume(sim)).toBe(v0 - 460)
    expect(poolProblems(sim)).toEqual([])
  })
})
```

The frozen-pool test's area is 46 × 10 = 460. The stone displaces 8 units into the balance, so total volume only moves by the hand-taken 460.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/engine && npx vitest run test/resurface.test.ts`

Expected: FAIL. The first test leaves `level` at 7, because nothing resurfaces yet.

- [ ] **Step 3: Implement the `Resurface` job**

Create `packages/engine/src/sim/fluids/resurface.ts`:

```ts
import type { Layout } from '../../world/layout.ts'
import type { JobReader, RegionJob } from '../jobs.ts'
import type { PoolTable } from './pools.ts'
import type { SurfaceIndex } from './surfaceIndex.ts'

export interface ResurfaceOptions {
  poolId: number
  pools: PoolTable
  index: SurfaceIndex
  layout: Layout
  /** Rewrites the pool from its collected surface cells (FluidSystem.applyResurface). */
  apply(poolId: number, cells: number[]): void
}

/**
 * Collects a pool's surface cells from its index tiles (1024 entries count as 1024 cells of budget);
 * finish() hands them over to be rewritten at once, so the whole surface changes in one tick. It reads
 * the index, not the world, so it never goes stale: the apply step validates every cell instead.
 */
export class Resurface implements RegionJob {
  readonly kind = 'resurface'
  done = false
  private tiles: number[] | null = null
  private at = 0
  private readonly cells: number[] = []

  constructor(private readonly o: ResurfaceOptions) {}

  step(_r: JobReader, budget: number): number {
    const p = this.o.pools.get(this.o.poolId)
    if (!p) { this.done = true; return 1 }
    if (this.tiles === null) this.tiles = [...p.tiles]
    let used = 0
    while (used < budget && this.at < this.tiles.length) {
      const key = this.tiles[this.at++]!
      used += 1024
      const t = this.o.index.tile(key)
      if (!t) continue
      const [x0, y, z0] = this.o.index.origin(key)
      for (let i = 0; i < 1024; i++) {
        if (t[i] !== 0 && this.o.pools.resolve(t[i]!) === p.id) this.cells.push(this.o.layout.voxelIndex(x0 + (i & 31), y, z0 + (i >> 5)))
      }
    }
    if (this.at >= this.tiles.length) this.done = true
    return Math.max(used, 1)
  }

  finish(): void { this.o.apply(this.o.poolId, this.cells) }

  reset(): void {
    this.done = false
    this.tiles = null
    this.at = 0
    this.cells.length = 0
  }

  mixState(mix: (v: number) => void): void { mix(this.o.poolId); mix(this.at); mix(this.cells.length) }
}
```

- [ ] **Step 4: Implement resurfacing and splitting in the fluid system**

In `fluidSystem.ts`, add `import { Resurface } from './resurface.ts'` and add `SPRING_RATES` to the cell import (Task 8 uses it). Then add these methods after `finishSettle`:

```ts
  // ---- resurfacing ----

  /** Every pool whose balance reached a whole level gets a resurface job (a sealed full pool cannot rise). */
  protected queueResurfaces(): void {
    for (const p of this.pools.all()) {
      if (p.frozen || p.area === 0) continue
      const up = p.balance >= p.area
      if (!up && p.balance > -p.area) continue
      if (up && p.level === 7 && p.sealed) continue
      this.resurface(p)
    }
  }

  protected resurface(p: Pool): void {
    p.frozen = true
    this.port.jobs.start(new Resurface({
      poolId: p.id, pools: this.pools, index: this.index, layout: this.layout,
      apply: (id, cells) => this.applyResurface(id, cells),
    }))
  }

  private get stride(): number { return this.layout.size[0] * this.layout.size[2] }

  private isSurfaceOf(p: Pool, pos: number): boolean {
    const [x, y, z] = this.layout.voxelCoords(pos)
    return y === p.surfaceY && this.members.has(x, y, z) && this.pools.resolve(this.index.get(x, y, z)) === p.id &&
      flowGroup(this.reg, this.port.get(x, y, z)) === p.liquid
  }

  /** Rewrites a pool's surface: normalise levels, then whole levels and layers while the balance allows. */
  applyResurface(id: number, cells: number[]): void {
    const p = this.pools.get(id)
    if (!p) return
    p.frozen = false
    let live = cells.filter((pos) => this.isSurfaceOf(p, pos))
    for (const pos of live) {
      const [x, y, z] = this.layout.voxelCoords(pos)
      const u = volumeOf(this.reg, this.port.get(x, y, z))
      if (u === p.level + 1) continue
      this.port.write(x, y, z, liquidVoxel(p.liquid, p.level + 1))
      p.grid += p.level + 1 - u
      p.balance -= p.level + 1 - u
    }
    p.area = live.length
    while (p.area > 0) {
      if (p.balance >= p.area) {
        if (p.level < 7) { this.setLevel(p, live, p.level + Math.min(7 - p.level, Math.floor(p.balance / p.area))); continue }
        const above = this.layerAbove(live)
        if (above.length === 0) { p.sealed = true; break }
        live = this.raiseLayer(p, live, above)
        continue
      }
      if (p.balance <= -p.area) {
        if (p.level > 0) { this.setLevel(p, live, p.level - Math.min(p.level, Math.floor(-p.balance / p.area))); continue }
        this.dropLayer(p, live)
        return
      }
      break
    }
    if (p.area === 0) this.rescan(p)
  }

  private setLevel(p: Pool, live: readonly number[], level: number): void {
    const d = level - p.level
    p.level = level
    for (const pos of live) {
      const [x, y, z] = this.layout.voxelCoords(pos)
      this.port.write(x, y, z, liquidVoxel(p.liquid, level + 1))
    }
    p.grid += d * live.length
    p.balance -= d * live.length
    if (d > 0) this.surfaceOutlets(p, live)
  }

  private layerAbove(live: readonly number[]): number[] {
    const H = this.layout.size[1]
    return live.map((pos) => pos + this.stride).filter((a) => {
      const [x, y, z] = this.layout.voxelCoords(a)
      return y < H && this.port.get(x, y, z) === AIR
    })
  }

  /** A full pool rises: level-0 cells on the air above its surface; old surface cells under a ceiling become capped tops. */
  private raiseLayer(p: Pool, old: readonly number[], above: number[]): number[] {
    const up = new Set(above)
    for (const pos of old) {
      const [x, y, z] = this.layout.voxelCoords(pos)
      this.index.delete(x, y, z)
      if (!up.has(pos + this.stride)) { this.pools.capped.set(pos, p.id); p.capped.add(pos) }
    }
    p.tiles.clear()
    p.surfaceY++
    p.level = 0
    p.area = above.length
    for (const pos of above) {
      const [x, y, z] = this.layout.voxelCoords(pos)
      this.members.add(x, y, z)
      p.tiles.add(this.index.set(x, y, z, p.id))
      this.port.write(x, y, z, liquidVoxel(p.liquid, 1))
    }
    p.grid += above.length
    p.balance -= above.length
    this.surfaceOutlets(p, above)
    return above
  }

  /** Air or moving water beside surface cells: outlets. Another pool's member: a contact. */
  private surfaceOutlets(p: Pool, cells: readonly number[]): void {
    for (const pos of cells) {
      const [x, y, z] = this.layout.voxelCoords(pos)
      for (const [dx, dz] of SIDES) {
        const nx = x + dx, nz = z + dz
        if (!this.inside(nx, y, nz)) continue
        const npos = this.layout.voxelIndex(nx, y, nz)
        if (this.members.has(nx, y, nz)) {
          const q = this.pools.ownerOf(nx, y, nz)
          if (q && q !== p) this.contacts.add(p.id, pos, q.id, npos)
          continue
        }
        const v = this.port.get(nx, y, nz)
        if (v === AIR || flowGroup(this.reg, v) === p.liquid) p.outlets.add(npos)
      }
    }
  }

  /** A level-0 surface empties: remove it (one unit per cell goes to the balance) and rescan what is left below. */
  private dropLayer(p: Pool, live: readonly number[]): void {
    const seeds: number[] = []
    for (const pos of live) {
      const [x, y, z] = this.layout.voxelCoords(pos)
      this.members.delete(x, y, z)
      this.index.delete(x, y, z)
      this.port.write(x, y, z, AIR)
      if (y > 0 && this.members.has(x, y - 1, z)) seeds.push(pos - this.stride)
    }
    p.grid -= live.length
    p.balance += live.length
    p.area = 0
    p.tiles.clear()
    this.split(p, seeds)
  }

  /** Rescans what is left of p from `extra` seeds and its capped tops. p stays frozen until finishSplit replaces it. */
  protected split(p: Pool, extra: readonly number[]): void {
    p.frozen = true
    this.port.jobs.start(new PoolScan({
      kind: 'split', registry: this.reg, layout: this.layout, seeds: sortSeeds(this.layout, [...extra, ...p.capped]),
      claimable: (x, y, z) => {
        if (!this.members.has(x, y, z)) return false
        const o = this.pools.ownerOf(x, y, z)
        return o === undefined || o === p
      },
      onFinish: (cs) => this.finishSplit(p.id, cs),
    }))
  }

  /** A pool that lost its whole surface (commands) is rescanned like a layer drop. */
  protected rescan(p: Pool): void { this.split(p, []) }

  /** Replaces the old pool with the scan's parts; its balance is shared by grid volume (the remainder to the largest). */
  protected finishSplit(id: number, cs: readonly ScanComponent[]): void {
    const p = this.pools.get(id)
    if (!p) return
    for (const c of p.capped) this.pools.capped.delete(c)
    this.pools.remove(p)
    const made = this.install(cs)
    if (made.length === 0) {
      if (p.balance !== 0) this.port.log(`fluids: pool ${p.id} emptied with ${p.balance} units unplaced`)
      this.lost += p.balance
      if (p.cycle) this.cycleId = 0
      return
    }
    const total = made.reduce((s, q) => s + q.grid, 0)
    const byGrid = [...made].sort((a, b) => b.grid - a.grid || a.id - b.id)
    let given = 0
    for (const q of byGrid) {
      const share = total === 0 ? 0 : Math.trunc((p.balance * q.grid) / total)
      q.balance += share
      given += share
    }
    byGrid[0]!.balance += p.balance - given
    if (p.cycle) {
      const big = [...made].sort((a, b) => b.area - a.area || a.id - b.id)[0]!
      big.cycle = true
      this.cycleId = big.id
    }
  }
```

In `leave()`, add at the end:

```ts
    if (p.area === 0 && !p.frozen) this.rescan(p)
```

In `step`, call `queueResurfaces` before `queueSettles`:

```ts
    this.steps++
    this.flowCells()
    this.runOutlets()
    // runContacts, runSprings (Task 8)
    this.queueResurfaces()
    this.queueSettles()
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/engine && npx vitest run && npx tsc --noEmit -p .`

Expected: `resurface.test.ts` PASS (7 tests), everything else PASS, typecheck 0.

If "drains flat through a hole" fails on the volume after a split: check the arithmetic of `finishSplit`. A pool emptied to its last layer must end with `balance === 0` there. Outlets never take more than `grid + balance`, so the drop leaves exactly 0.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/sim/fluids/resurface.ts packages/engine/src/sim/fluids/fluidSystem.ts packages/engine/test/resurface.test.ts
git commit -m "feat(engine): resurface jobs move whole pool surfaces; new layers, sealing, layer drops and splits"
```

---

### Task 8: Contacts, merges, springs and the water cycle

**Files:**
- Modify: `packages/engine/src/sim/fluids/fluidSystem.ts`
- Test: `packages/engine/test/contacts.test.ts`

**Interfaces:**
- Consumes: Task 7's `resurface`; `ContactTable`, `PoolTable.merge`, `SPRING_RATES`; and `cycle` and `cycleId`, which `pickCycle` set in Task 4.
- Produces, on `FluidSystem`:
  - `protected runContacts()`, `merge(a, b)`, `ownedBy(pos, p)`;
  - `protected runSprings()`.
  - The final step order is `flowCells, runOutlets, runContacts, runSprings, queueResurfaces, queueSettles`.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/test/contacts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SPRING_RATES } from '../src/sim/fluids/cell.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, basin, fluidSim, lake, poolProblems, run, settle, spring, volume, w } from './fluidHelpers.ts'

describe('pools in contact', () => {
  it('evens out stepped water and merges it into one flat pool', () => {
    const b = basin(12, 8)
    const sim = fluidSim((x, y, z) => {
      const v = b(x, y, z)
      if (v !== AIR) return v
      if (x <= 0 || x >= 11 || z <= 0 || z >= 11 || y < 1) return AIR
      return y <= (x < 6 ? 4 : 3) ? w(7) : AIR
    })
    const v0 = volume(sim)
    settle(sim)
    const ps = sim.fluids.pools.all()
    expect(ps).toHaveLength(1)
    expect(ps[0]).toMatchObject({ surfaceY: 4, level: 3, area: 100, balance: 0 })
    expect(volume(sim)).toBe(v0)
    expect(poolProblems(sim)).toEqual([])
  })
  it('raises water in a shaft to the lake level through a tunnel (communicating vessels)', () => {
    // lake x 1..10, water y 1..6, walls to y 9; tunnel at y = 1, z = 5 from x = 11 to 15 under a stone ceiling; shaft at x = 16 up to y = 12
    const base = lake(6, 12, 9)
    const sim = fluidSim((x, y, z) => {
      if (y === 0) return B.stone
      if (x >= 11 && x <= 17 && z >= 4 && z <= 6 && y <= 12) {
        if (z === 5 && y === 1 && x >= 12 && x <= 16) return AIR // the tunnel (x = 11 stays wall until dug)
        if (z === 5 && x === 16 && y >= 2) return AIR // the shaft
        return B.stone
      }
      return base(x, y, z)
    })
    const v0 = volume(sim)
    sim.submit(0, 0, { type: 'setBlock', pos: [11, 1, 5], voxel: AIR })
    settle(sim)
    const lakePool = sim.fluids.poolAt(5, 1, 5)!
    expect(sim.fluids.poolAt(16, lakePool.surfaceY, 5)).toBe(lakePool)
    expect(sim.store.getVoxel(16, lakePool.surfaceY + 1, 5)).toBe(AIR)
    expect(volume(sim)).toBe(v0)
    expect(poolProblems(sim)).toEqual([])
  })
})

describe('springs', () => {
  /** A sea (y 1..3, seaLevel 4) for x < 40, a stone hill (to y = 10) for x ≥ 40. */
  const coast = (x: number, y: number) => (y === 0 ? B.stone : x >= 40 ? (y <= 10 ? B.stone : AIR) : y <= 3 ? w(7) : AIR)

  it('draws from the sea, so total volume never changes', () => {
    const sim = fluidSim((x, y, z) => (x === 50 && y === 11 && z === 16 ? spring(5) : coast(x, y)), { size: [64, 32, 32], seaLevel: 4 })
    const sea = sim.fluids.cycle!
    expect(sea).toMatchObject({ surfaceY: 3, cycle: true })
    const v0 = volume(sim)
    for (let t = 0; t < 40; t++) { sim.step(); expect(volume(sim)).toBe(v0) }
    expect(sea.balance + (sea.level + 1 - 8) * sea.area).toBeLessThan(0) // the sea gave water
    let hill = 0
    for (let x = 40; x < 64; x++) for (let z = 0; z < 32; z++) for (let y = 11; y < 20; y++) if ((sim.store.getVoxel(x, y, z) & 0xfff) === B.water) hill++
    expect(hill).toBeGreaterThan(0)
  })
  it('is an infinite source when the world has no sea', () => {
    const sim = fluidSim((x, y, z) => (y === 0 ? B.stone : x === 16 && y === 1 && z === 16 ? spring(5) : AIR))
    sim.step()
    expect(volume(sim)).toBe(SPRING_RATES[5])
  })
  it('gives nothing next to the sea, stops when removed, and stays shut when walled in (review focus 5)', () => {
    const sim = fluidSim((x, y, z) => {
      if (x === 5 && y === 2 && z === 5) return spring(9)
      if (x === 50 && y === 11 && z === 16) return spring(9)
      if (x >= 49 && x <= 51 && y >= 10 && y <= 12 && z >= 15 && z <= 17) return B.stone // walls in the hill spring
      return coast(x, y)
    }, { size: [64, 32, 32], seaLevel: 4 })
    const v0 = volume(sim)
    run(sim, 10)
    expect(volume(sim)).toBe(v0)
    expect(sim.fluids.cycle!.balance).toBe(0)
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 2, 5], voxel: AIR })
    run(sim, 3)
    expect(sim.fluids.springs.has(sim.layout.voxelIndex(5, 2, 5))).toBe(false)
    expect(volume(sim)).toBe(v0)
  })
})
```

In the walled-in test the hill spring sits at (50, 11, 16), and the stone block 49..51 × 10..12 × 15..17 leaves only the spring cell inside. `fill` returns the spring first, so its cell keeps the spring.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/engine && npx vitest run test/contacts.test.ts`

Expected: FAIL. With no contact processing the two halves never merge, so the length check fails. With no spring processing the volume stays 0.

- [ ] **Step 3: Implement contacts and merges**

Add to `fluidSystem.ts` after `finishSplit`:

```ts
  // ---- contacts ----

  protected ownedBy(pos: number, p: Pool): boolean {
    const [x, y, z] = this.layout.voxelCoords(pos)
    return this.members.has(x, y, z) && this.pools.ownerOf(x, y, z) === p
  }

  /**
   * Touching pools trade water from the higher to the lower by exact heights,
   * H = (surfaceY·8 + level)·area + balance, at most outletRate per live face. Equal pools on one layer merge.
   */
  protected runContacts(): void {
    for (const c of this.contacts.all()) {
      const a = this.pools.get(c.a), b = this.pools.get(c.b)
      if (!a || !b || a === b) { this.contacts.delete(c); continue }
      if (a.frozen || b.frozen || a.area === 0 || b.area === 0) continue
      let faces = 0
      for (const [fa, fb] of c.faces) if (this.ownedBy(fa, a) && this.ownedBy(fb, b)) faces++
      if (faces === 0) { this.contacts.delete(c); continue }
      const ha = (a.surfaceY * 8 + a.level) * a.area + a.balance
      const hb = (b.surfaceY * 8 + b.level) * b.area + b.balance
      const d = ha * b.area - hb * a.area
      const [hi, lo] = d >= 0 ? [a, b] : [b, a]
      const tMax = Math.floor(Math.abs(d) / (a.area + b.area))
      if (tMax === 0) {
        if (a.surfaceY === b.surfaceY) this.merge(a, b)
        continue
      }
      let t = Math.min(tMax, this.o.outletRate * faces, hi.grid + hi.balance)
      if (lo.sealed) t = Math.min(t, lo.area - 1 - lo.balance)
      if (t <= 0) continue
      hi.balance -= t
      lo.balance += t
    }
  }

  /** Folds the higher id into the lower; a resurface job evens the levels if they differed. */
  protected merge(a: Pool, b: Pool): void {
    const [into, from] = a.id < b.id ? [a, b] : [b, a]
    const level = into.area >= from.area ? into.level : from.level
    const relevel = into.level !== from.level
    this.pools.merge(into, from)
    into.level = level
    if (into.cycle) this.cycleId = into.id
    if (relevel) this.resurface(into)
  }
```

- [ ] **Step 4: Implement springs**

Add after `merge`:

```ts
  // ---- springs ----

  /**
   * Each spring pushes its rate into the cells below and beside it (air, moving water, or another pool's
   * balance), at most FULL per cell. In a world with a sea, what it gives is debited from the sea, so total
   * volume never changes; once that sea is gone, springs give nothing.
   */
  protected runSprings(): void {
    const cycle = this.cycle
    for (const s of [...this.springs]) {
      const [x, y, z] = this.layout.voxelCoords(s)
      const v = this.port.get(x, y, z)
      if (this.reg.source[voxelId(v)] !== 1) { this.springs.delete(s); continue }
      const g = this.reg.liquidGroup[voxelId(v)]!
      let left = SPRING_RATES[voxelState(v)]!
      if (this.hadCycle) left = cycle ? Math.min(left, Math.max(0, cycle.grid + cycle.balance)) : 0
      let given = 0
      const start = (this.steps + s) & 3
      const order: [number, number, number][] = [[0, -1, 0]]
      for (let i = 0; i < 4; i++) { const [dx, dz] = SIDES[(start + i) & 3]!; order.push([dx, 0, dz]) }
      for (const [dx, dy, dz] of order) {
        if (left <= 0) break
        const nx = x + dx, ny = y + dy, nz = z + dz
        if (!this.inside(nx, ny, nz)) continue
        if (this.members.has(nx, ny, nz)) {
          const q = this.pools.ownerOf(nx, ny, nz)
          if (!q || q === cycle || q.liquid !== g) continue
          const t = Math.min(left, FULL)
          if (!this.accepts(q, t)) continue
          q.balance += t
          left -= t
          given += t
          continue
        }
        const nv = this.port.get(nx, ny, nz)
        if (nv === AIR) {
          const t = Math.min(left, FULL)
          this.port.write(nx, ny, nz, liquidVoxel(g, t))
          left -= t
          given += t
        } else if (flowGroup(this.reg, nv) === g) {
          const have = volumeOf(this.reg, nv)
          const t = Math.min(left, FULL - have)
          if (t > 0) {
            this.port.write(nx, ny, nz, liquidVoxel(g, have + t))
            left -= t
            given += t
          }
        }
      }
      if (cycle && given > 0) cycle.balance -= given
    }
  }
```

Make sure `voxelState` and `SPRING_RATES` are imported in `fluidSystem.ts`. `voxelState` comes from `../../world/voxel.ts`, which the Task 4 skeleton already imports. `SPRING_RATES` comes from `./cell.ts`.

- [ ] **Step 5: Final step order**

Replace the step body's phase list:

```ts
    this.steps++
    this.flowCells()
    this.runOutlets()
    this.runContacts()
    this.runSprings()
    this.queueResurfaces()
    this.queueSettles()
```

- [ ] **Step 6: Run the tests**

Run: `cd packages/engine && npx vitest run && npx tsc --noEmit -p .`

Expected: `contacts.test.ts` PASS (5 tests). The earlier fluid files still PASS, and so does `fluidCells.test.ts` "spreads on a flat floor": settling now merges the film into pools, and every neighbour difference stays below 2. Typecheck 0.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/sim/fluids/fluidSystem.ts packages/engine/test/contacts.test.ts
git commit -m "feat(engine): touching pools trade water by exact height and merge; springs draw from the sea"
```

---

### Task 9: Conservation fuzz, determinism, pause-and-regenerate, debug checks

**Files:**
- Modify: `packages/engine/src/sim/fluids/fluidSystem.ts` (`debug` option), `packages/engine/src/sim/simHost.ts`, `packages/engine/src/protocol.ts` (`SimInitOptions.debugFluids`), `packages/engine/test/fluidHelpers.ts` (`log` option)
- Test: `packages/engine/test/fluidWorld.test.ts`

**Interfaces:**
- Consumes: the complete fluid system (Tasks 4–8).
- Produces:
  - `FluidOptions.debug: boolean` (default false). After each fluid step it runs `checkInvariants()`; on any violation it logs `fluids: invariant check failed (…)` and sets `needsRebuild`.
  - `SimInitOptions.debugFluids?: boolean`, which `SimHost` passes as `fluids: { debug }`.
  - `FluidSimOptions.log?: (m: string) => void` in the test helpers.

- [ ] **Step 1: Extend the helper**

In `packages/engine/test/fluidHelpers.ts`, add `log?: (message: string) => void` to `FluidSimOptions`. In `fluidSim`, replace `log: () => {}` with `log: o.log ?? (() => {})`.

- [ ] **Step 2: Write the failing tests**

Create `packages/engine/test/fluidWorld.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Command, FillRegionCommand, SetBlockCommand } from '../src/sim/commands.ts'
import { volumeOf } from '../src/sim/fluids/cell.ts'
import { Pcg32 } from '../src/sim/rng.ts'
import type { Simulation } from '../src/sim/simulation.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, fluidSim, lake, poolProblems, volume, w, type Fill } from './fluidHelpers.ts'

/** Random ground 1–6 high, with water up to y = 5 above it. */
function terrain(seed: number): Fill {
  const rng = new Pcg32(seed)
  const h = Array.from({ length: 32 * 32 }, () => 1 + rng.nextInt(6))
  return (x, y, z) => {
    const top = h[x + z * 32]!
    if (y < top) return B.stone
    return y <= 5 ? w(7) : AIR
  }
}

function command(rng: Pcg32): Command | null {
  const k = rng.nextInt(5)
  const x = rng.nextInt(32), y = 1 + rng.nextInt(9), z = rng.nextInt(32)
  switch (k) {
    case 0: return { type: 'setBlock', pos: [x, y, z], voxel: AIR }
    case 1: return { type: 'setBlock', pos: [x, y, z], voxel: B.stone }
    case 2: return { type: 'setBlock', pos: [x, y, z], voxel: w(rng.nextInt(8)) }
    case 3: return { type: 'fillRegion', min: [x, y, z], max: [Math.min(31, x + 2), y, Math.min(31, z + 2)], voxel: AIR }
    default: return null
  }
}

/** Units a command creates (> 0) or deletes (< 0), read before it applies. A solid displaces water: 0. */
function commandDelta(sim: Simulation, cmd: Command): number {
  const cells: (readonly [number, number, number])[] = []
  let voxel: number
  if (cmd.type === 'setBlock') {
    const c = cmd as SetBlockCommand
    cells.push(c.pos)
    voxel = c.voxel
  } else {
    const c = cmd as FillRegionCommand
    for (let y = c.min[1]; y <= c.max[1]; y++) for (let z = c.min[2]; z <= c.max[2]; z++) for (let x = c.min[0]; x <= c.max[0]; x++) cells.push([x, y, z])
    voxel = c.voxel
  }
  let d = 0
  for (const [x, y, z] of cells) {
    const old = sim.store.getVoxel(x, y, z)
    if (old === voxel) continue
    const before = volumeOf(sim.registry, old)
    if (voxel === AIR) d -= before
    else if (volumeOf(sim.registry, voxel) > 0) d += volumeOf(sim.registry, voxel) - before
  }
  return d
}

function script(sim: Simulation, seed: number, ticks: number, check?: (t: number) => void): void {
  const rng = new Pcg32(seed * 7919)
  for (let t = 0; t < ticks; t++) {
    const cmd = t % 3 === 0 ? command(rng) : null
    if (cmd) sim.submit(1, t, cmd)
    sim.step()
    check?.(t)
  }
}

describe('fluid world', () => {
  it.each([1, 2, 3])('conserves volume through random digging, filling and pouring (seed %i)', (seed) => {
    const sim = fluidSim(terrain(seed), { seed })
    const rng = new Pcg32(seed * 7919)
    let expected = volume(sim)
    for (let t = 0; t < 300; t++) {
      const cmd = t % 3 === 0 ? command(rng) : null
      if (cmd) { expected += commandDelta(sim, cmd); sim.submit(1, t, cmd) }
      sim.step()
      expect(volume(sim)).toBe(expected)
      if (t % 50 === 49) expect(poolProblems(sim)).toEqual([])
    }
  }, 120_000)

  it('is deterministic and replays from the command log', () => {
    const a = fluidSim(terrain(5), { seed: 5 }), b = fluidSim(terrain(5), { seed: 5 })
    script(a, 5, 200)
    script(b, 5, 200)
    expect(a.hash()).toBe(b.hash())
    const c = fluidSim(terrain(5), { seed: 5 })
    let i = 0
    for (let t = 0; t < 200; t++) {
      while (i < a.commandLog.length && a.commandLog[i]!.tick === t) { const e = a.commandLog[i++]!; c.submit(e.clientId, e.seq, e.cmd) }
      c.step()
    }
    expect(c.hash()).toBe(a.hash())
  }, 60_000)

  it('rebuilds cleanly after a regeneration while paused (review focus 4)', () => {
    const sim = fluidSim(terrain(9), { seed: 9 })
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 9, 5], voxel: w(7) })
    sim.step()
    sim.setPaused(true)
    const data = new Uint16Array(32 * 32 * 32)
    for (let y = 0; y < 32; y++) for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
      data[lx + (lz << 5) + (y << 10)] = y === 0 ? B.stone : y <= 3 ? w(7) : AIR
    }
    sim.replaceColumns([{ cx: 0, cz: 0, data }])
    sim.step(); sim.step()
    expect(sim.fluids.needsRebuild).toBe(true) // paused: the rebuild waits
    sim.setPaused(false)
    sim.step()
    expect(sim.fluids.needsRebuild).toBe(false)
    const ps = sim.fluids.pools.all()
    expect(ps).toHaveLength(1)
    expect(ps[0]).toMatchObject({ id: 1, surfaceY: 3, area: 1024 })
    expect(volume(sim)).toBe(3 * 1024 * 8)
    expect(poolProblems(sim)).toEqual([])
  })

  it('debug checks catch a corrupted pool and rebuild it', () => {
    const logs: string[] = []
    const sim = fluidSim(lake(4), { fluids: { debug: true }, log: (m) => logs.push(m) })
    sim.fluids.pools.all()[0]!.grid += 8
    sim.step()
    expect(logs.some((m) => /invariant check failed/.test(m))).toBe(true)
    sim.step()
    expect(poolProblems(sim)).toEqual([])
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd packages/engine && npx vitest run test/fluidWorld.test.ts`

Expected: the fuzz and determinism tests may already pass. If a fuzz seed fails, its message names the first tick where the volume drifted; fix that in the fluid system before going on. The debug test FAILS ("FluidOptions … debug" type error or no log line).

- [ ] **Step 4: Add the debug option**

In `fluidSystem.ts`:

1. Extend `FluidOptions`:

```ts
  /** After every fluid step, check every pool invariant (whole world: slow). A violation is logged and the world rescanned. */
  debug: boolean
```

2. Set `DEFAULT_FLUID_OPTIONS` to `{ fluidEvery: 2, fluidCap: 20_000, outletRate: 8, debug: false }`.

3. In the constructor, validate only the numeric options:

```ts
    for (const k of ['fluidEvery', 'fluidCap', 'outletRate'] as const) {
      const v = this.o[k]
      if (!Number.isInteger(v) || v < 1) throw new RangeError(`fluid option ${k} must be an integer ≥ 1, got ${v}`)
    }
```

4. At the end of `step` (after `queueSettles()`):

```ts
    if (this.o.debug) {
      const bad = this.checkInvariants()
      if (bad.length > 0) {
        this.port.log(`fluids: invariant check failed (${bad.length}): ${bad.slice(0, 3).join('; ')}; rescanning`)
        this.needsRebuild = true
      }
    }
```

In `packages/engine/src/protocol.ts` `SimInitOptions`, add:

```ts
  /** Check every pool invariant after each fluid step (slow; for debugging). */
  debugFluids?: boolean
```

In `simHost.ts`, inside `case 'init'`, add to the `new Simulation({...})` options:

```ts
            fluids: { debug: msg.options.debugFluids === true },
```

- [ ] **Step 5: Run the engine suite**

Run: `cd packages/engine && npx vitest run && npx tsc --noEmit -p .`

Expected: `fluidWorld.test.ts` PASS (6 tests), every other file PASS, typecheck 0.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/sim/fluids/fluidSystem.ts packages/engine/src/sim/simHost.ts packages/engine/src/protocol.ts packages/engine/test/fluidHelpers.ts packages/engine/test/fluidWorld.test.ts
git commit -m "test(engine): fluid conservation fuzz, determinism and paused-regeneration tests; debug invariant checks"
```

---

### Task 10: Falling blocks

**Files:**
- Create: `packages/engine/src/sim/gravity.ts`
- Modify: `packages/engine/src/sim/simulation.ts`, `packages/engine/src/protocol.ts`, `packages/engine/src/sim/runSimWorker.ts`
- Test: `packages/engine/test/gravity.test.ts`, `packages/engine/test/determinism.test.ts`

**Interfaces:**
- Consumes: `BlockRegistry.falls` (Task 1); the `applySet` hooks, the `WriteSource` `'gravity'` and the pause (Tasks 2 and 4).
- Produces:
  - Constants `GRAVITY_256 = 24` and `MAX_FALL_256 = 512`.
  - `interface FallingBodyState { id: number; voxel: number; x: number; z: number; y256: number; vy256: number }`.
  - `interface Landing { id: number; x: number; y: number; z: number; chunk: number; version: number }`.
  - `class GravitySystem { afterWrite(x, y, z, v); step(); snapshot(): FallingBodyState[]; landed: Landing[]; count; mixState(mix) }`.
  - `Simulation.gravity` and `TickResult.falling` / `.landed`. The landing `version` is the chunk's version after the tick's commit.
  - `FromSim` tick gets `falling` and `landed`.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/test/gravity.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MAX_FALL_256 } from '../src/sim/gravity.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, fluidSim, lake, poolProblems, run, volume, w } from './fluidHelpers.ts'

const floor = (_x: number, y: number) => (y === 0 ? B.stone : AIR)

describe('gravity', () => {
  it('lifts an unsupported block out of the grid and lands it, accelerating to a cap', () => {
    const sim = fluidSim(floor)
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
    const sim = fluidSim(floor)
    sim.submit(0, 0, { type: 'fillRegion', min: [3, 10, 3], max: [3, 12, 3], voxel: B.sand })
    const r = sim.step()
    expect(r.falling.map((b) => b.id)).toEqual([1, 2, 3])
    run(sim, 40)
    expect([1, 2, 3, 4].map((y) => sim.store.getVoxel(3, y, 3))).toEqual([B.sand, B.sand, B.sand, AIR])
  })
  it('passes a torch on the way and destroys one in its landing cell', () => {
    const sim = fluidSim((x, y, z) => (y === 0 ? B.stone : x === 7 && z === 7 && (y === 1 || y === 5) ? B.torch : AIR))
    sim.submit(0, 0, { type: 'setBlock', pos: [7, 9, 7], voxel: B.sand })
    run(sim, 40)
    expect(sim.store.getVoxel(7, 5, 7)).toBe(B.torch)
    expect(sim.store.getVoxel(7, 1, 7)).toBe(B.sand)
  })
  it('sinks through a pool and displaces its volume into the balance', () => {
    const sim = fluidSim(lake(4))
    const [p] = sim.fluids.pools.all()
    const v0 = volume(sim)
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 8, 5], voxel: B.sand })
    run(sim, 30)
    expect(sim.store.getVoxel(5, 1, 5)).toBe(B.sand)
    expect(volume(sim)).toBe(v0)
    expect(p!.balance).toBe(8)
    expect(poolProblems(sim)).toEqual([])
  })
  it('pushes loose water up when it lands in it', () => {
    const sim = fluidSim((x, y, z) => (y === 0 ? B.stone : (x === 4 || x === 6 || z === 4 || z === 6) && y <= 3 ? B.stone : AIR))
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 1, 5], voxel: w(5) })
    sim.step()
    const v0 = volume(sim)
    sim.submit(0, 1, { type: 'setBlock', pos: [5, 9, 5], voxel: B.sand })
    run(sim, 30)
    expect(sim.store.getVoxel(5, 1, 5)).toBe(B.sand)
    expect(volume(sim)).toBe(v0)
  })
  it('logs a throwing physics phase, drops the job, and finishes the tick', () => {
    const logs: string[] = []
    const sim = fluidSim(floor, { log: (m) => logs.push(m) })
    sim.jobs.start({ kind: 'boom', done: false, step() { throw new Error('boom') }, finish() {}, reset() {}, mixState() {} })
    expect(() => sim.step()).not.toThrow()
    expect(logs.some((m) => /region jobs error tick=0: boom/.test(m))).toBe(true)
    expect(sim.jobs.size).toBe(0)
    expect(sim.fluids.needsRebuild).toBe(true)
  })
  it('holds still while physics is paused', () => {
    const sim = fluidSim(floor)
    sim.setPaused(true)
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 20, 5], voxel: B.sand })
    run(sim, 5)
    expect(sim.store.getVoxel(5, 20, 5)).toBe(B.sand)
    sim.setPaused(false)
    expect(sim.step().falling).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/engine && npx vitest run test/gravity.test.ts`

Expected: FAIL with "Failed to resolve import ../src/sim/gravity.ts".

- [ ] **Step 3: Implement `sim/gravity.ts`**

```ts
import type { BlockRegistry } from '../blocks/registry.ts'
import type { Layout } from '../world/layout.ts'
import { AIR, voxelId } from '../world/voxel.ts'

/** Added to a body's downward speed every tick, in 1/256 block per tick (≈ 1 g at 20 Hz). */
export const GRAVITY_256 = 24
/** Terminal speed: 2 blocks per tick. */
export const MAX_FALL_256 = 512

/** A block out of the grid while it falls. y256 is the height of its bottom face in 1/256 block. */
export interface FallingBodyState { id: number; voxel: number; x: number; z: number; y256: number; vy256: number }
/** A body that returned to the grid this tick. `version` is its chunk's version after the tick committed. */
export interface Landing { id: number; x: number; y: number; z: number; chunk: number; version: number }

export interface GravityPort {
  readonly layout: Layout
  readonly registry: BlockRegistry
  get(x: number, y: number, z: number): number
  /** Writes through the simulation as a 'gravity' write. */
  write(x: number, y: number, z: number, v: number): void
}

/** Falling blocks (spec §6): integer bodies, processed in id order, a write when they start and when they land. */
export class GravitySystem {
  /** Landings of the last step; Simulation sets their versions after commit. */
  landed: Landing[] = []
  private bodies: FallingBodyState[] = []
  private readonly pending: number[] = []
  private readonly pendingSet = new Set<number>()
  private nextId = 1

  constructor(private readonly port: GravityPort) {}

  get count(): number { return this.bodies.length }

  /** A write may have placed a falls block or taken a support away: check the cell and the one above. */
  afterWrite(x: number, y: number, z: number, v: number): void {
    const falls = this.port.registry.falls
    if (falls[voxelId(v)] === 1) this.queue(x, y, z)
    if (y + 1 < this.port.layout.size[1] && falls[voxelId(this.port.get(x, y + 1, z))] === 1) this.queue(x, y + 1, z)
  }

  step(): void {
    const L = this.port.layout, reg = this.port.registry
    this.landed = []
    // 1. Starts. Removing a block queues the one above, which this loop reaches in the same tick.
    for (let i = 0; i < this.pending.length; i++) {
      const pos = this.pending[i]!
      this.pendingSet.delete(pos)
      const [x, y, z] = L.voxelCoords(pos)
      const v = this.port.get(x, y, z)
      if (reg.falls[voxelId(v)] !== 1 || !this.open(x, y - 1, z)) continue
      this.bodies.push({ id: this.nextId++, voxel: v, x, z, y256: y * 256, vy256: 0 })
      this.port.write(x, y, z, AIR)
    }
    this.pending.length = 0
    // 2. Advance in id order. A later body never passes an earlier one still falling in its column.
    const keep: FallingBodyState[] = []
    const floorOf = new Map<number, number>()
    for (const b of this.bodies) {
      b.vy256 = Math.min(b.vy256 + GRAVITY_256, MAX_FALL_256)
      const col = b.x + b.z * L.size[0]
      let target = b.y256 - b.vy256
      const limit = floorOf.get(col)
      if (limit !== undefined && limit <= b.y256) target = Math.max(target, limit)
      let land = -1
      for (let k = Math.ceil(b.y256 / 256) - 1; k >= Math.floor(target / 256); k--) {
        if (k < 0) { land = 0; break }
        if (reg.solid[voxelId(this.port.get(b.x, k, b.z))] === 1) { land = k + 1; break }
      }
      if (land < 0 && target < 0) land = 0
      if (land >= 0) {
        this.port.write(b.x, land, b.z, b.voxel)
        this.landed.push({ id: b.id, x: b.x, y: land, z: b.z, chunk: L.chunkOf(b.x, land, b.z), version: 0 })
        continue
      }
      b.y256 = target
      floorOf.set(col, b.y256 + 256)
      keep.push(b)
    }
    this.bodies = keep
  }

  /** Copies of the bodies still falling, for the tick message. */
  snapshot(): FallingBodyState[] { return this.bodies.map((b) => ({ ...b })) }

  mixState(mix: (v: number) => void): void {
    mix(this.nextId)
    mix(this.bodies.length)
    for (const b of this.bodies) { mix(b.id); mix(b.voxel); mix(b.x); mix(b.z); mix(b.y256); mix(b.vy256) }
    mix(this.pending.length)
  }

  private queue(x: number, y: number, z: number): void {
    const pos = this.port.layout.voxelIndex(x, y, z)
    if (this.pendingSet.has(pos)) return
    this.pendingSet.add(pos)
    this.pending.push(pos)
  }

  /** A block falls into air or a flowing liquid; never through the world floor or a spring. */
  private open(x: number, y: number, z: number): boolean {
    if (y < 0) return false
    const v = this.port.get(x, y, z), id = voxelId(v), reg = this.port.registry
    return v === AIR || (reg.liquid[id] === 1 && reg.source[id] === 0)
  }
}
```

The first test expects `y256 = 20·256 − 24` after the first tick. A body starts and advances in the same gravity step, so its first speed is 24.

- [ ] **Step 4: Wire gravity into `Simulation`**

In `simulation.ts`:

1. Import: `import { GravitySystem, type FallingBodyState, type Landing } from './gravity.ts'`.

2. Extend `TickResult`:

```ts
export interface TickResult {
  tick: number; dirtyChunks: number[]; events: SimEvent[]; acks: Ack[]
  /** Bodies still falling after this tick. */
  falling: FallingBodyState[]
  /** Bodies that landed this tick, with their chunk's version after commit. */
  landed: Landing[]
}
```

3. Field `readonly gravity: GravitySystem`. In the constructor, after the fluid system:

```ts
    this.gravity = new GravitySystem({
      layout: this.layout, registry: this.registry,
      get: (x, y, z) => sim.store.getVoxel(x, y, z),
      write: (x, y, z, v) => sim.applySet(x, y, z, v, true, 'gravity'),
    })
```

4. In `applySet`, after `this.fluids.afterWrite(…)`:

```ts
    this.gravity.afterWrite(x, y, z, v)
```

5. In `step()`:
   - Right after `const t = this.tick`, add `this.gravity.landed = []`.
   - Replace the `if (!this.isPaused)` block, so gravity comes first and every physics phase is guarded:

```ts
      if (!this.isPaused) {
        this.physics('gravity', () => this.gravity.step()) // 3
        this.physics('fluids', () => this.fluids.step(t)) // 4
        this.physics('region jobs', () => this.jobs.run(this.jobCap)) // 5
      }
```

   - Add the guard method (spec §9: a physics exception is a bug, not content). The log is the same as for a rule error, the tick finishes, the fluid state heals through a rescan, and `WorldFullError` stays fatal:

```ts
  private physics(name: string, fn: () => void): void {
    try {
      fn()
    } catch (e) {
      if (e instanceof WorldFullError) throw e
      this.log(`${name} error tick=${this.tick}: ${e instanceof Error ? e.message : String(e)}`)
      if (name !== 'gravity') this.fluids.needsRebuild = true
    }
  }
```

   - In `packages/engine/src/sim/jobs.ts`, make `JobRunner.run` drop a job that throws, so it cannot fail every tick. Wrap the loop body's step/finish:

```ts
      let finished = false
      try {
        budget -= e.job.step(e.reader, unbounded ? Infinity : budget)
        if (e.job.done) { this.queue.shift(); finished = true; e.job.finish() }
      } catch (err) {
        if (!finished) this.queue.shift()
        throw err
      }
      if (!finished) {
        if (unbounded) throw new Error(`region job "${e.job.kind}" did not finish with an unbounded budget`)
        return
      }
```

     This replaces the lines from `budget -= e.job.step(…)` through `e.job.finish()`. Behaviour is unchanged for well-behaved jobs, so `jobs.test.ts` still passes.

   - After the `try/finally` (versions are even again), before building the result:

```ts
    const landed = this.gravity.landed
    for (const l of landed) l.version = this.store.versions[l.chunk]!
```

   - Return `{ tick: t, dirtyChunks, events, acks, falling: this.gravity.snapshot(), landed }`.

6. In `hash()`, before `this.fluids.mixState(mix)`, add `this.gravity.mixState(mix)`.

In `protocol.ts`, import the types (`import type { FallingBodyState, Landing } from './sim/gravity.ts'`) and extend the tick message:

```ts
  | { type: 'tick'; tick: number; dirtyChunks: number[]; events: SimEvent[]; acks: Ack[]; falling: FallingBodyState[]; landed: Landing[]; slotsUsed: number; tickMs: number }
```

In `runSimWorker.ts`, add `export type { FallingBodyState, Landing } from './gravity.ts'`.

- [ ] **Step 5: Extend the determinism test with water, gravel and a spring**

In `packages/engine/test/determinism.test.ts`:

1. Replace the `BLOCKS` line:

```ts
const BLOCKS = [
  ...TEST_BLOCKS, defineBlock({ name: 'sand' }), defineBlock({ name: 'gravel', falls: true }),
  defineBlock({ name: 'spring', liquid: true, source: 'water', textures: 'water' }),
]
const GRAVEL = 9, SPRING = 10
```

2. Extend `script`:

```ts
  if (t % 15 === 5) sim.submit(4, t, { type: 'setBlock', pos: [(t * 11) % 64, 58, (t * 5) % 64], voxel: (7 << 12) | 5 }) // full water
  if (t % 20 === 7) sim.submit(5, t, { type: 'fillRegion', min: [(t * 17) % 60, 50, 30], max: [(t * 17) % 60, 52, 30], voxel: GRAVEL })
  if (t === 30) sim.submit(6, t, { type: 'setBlock', pos: [32, 62, 32], voxel: (5 << 12) | SPRING })
```

3. In the first test, after `expect(ha).toBe(hb)`:

```ts
    expect(a.fluids.totalVolume()).toBeGreaterThan(0) // water and the spring really ran
```

- [ ] **Step 6: Run the engine suite**

Run: `cd packages/engine && npx vitest run && npx tsc --noEmit -p .`

Expected: `gravity.test.ts` PASS (7 tests), `determinism.test.ts` PASS, everything else PASS (including `jobs.test.ts`), typecheck 0.

`engine.ts` also consumes the tick message. It compiles unchanged, because extra fields are ignored until Task 11.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/sim/gravity.ts packages/engine/src/sim/simulation.ts packages/engine/src/sim/jobs.ts packages/engine/src/protocol.ts packages/engine/src/sim/runSimWorker.ts packages/engine/test/gravity.test.ts packages/engine/test/determinism.test.ts
git commit -m "feat(engine): falling blocks leave the grid, accelerate and land; physics phases are guarded"
```

---

### Task 11: Drawing falling blocks, and physics stats on the main thread

**Files:**
- Create: `packages/engine/src/render/fallingTrack.ts`, `packages/engine/src/render/falling.ts`
- Modify: `packages/engine/src/render/meshQueue.ts`, `packages/engine/src/render/visuals.ts`, `packages/engine/src/engine.ts`, `packages/engine/src/sim/simulation.ts` (`TickResult.physics`), `packages/engine/src/protocol.ts`
- Test: `packages/engine/test/fallingTrack.test.ts`, `packages/engine/test/meshQueue.test.ts`

**Interfaces:**
- Consumes: `FallingBodyState` and `Landing` (Task 10); `MeshQueue.accept`; `VoxelNodeMaterial` and `voxelLit`.
- Produces:
  - `MeshQueue.appliedVersion(ci): number` (−1 when none).
  - `class FallingTrack { update(falling, landed, now); frame(now, tickMs, applied): FallingCube[]; size }` with `interface FallingCube { voxel; x; y; z }`.
  - `class FallingCubes { readonly mesh; set(cubes, light); dispose() }`.
  - `VisualsOptions.faceLayers: Uint16Array` and `Visuals.drawFalling(cubes, light)`.
  - `TickResult.physics: { active: number; pools: number; jobs: number }`.
  - New `EngineStats` fields: `fallingBodies`, `fluidActive`, `fluidPools`, `regionJobs`.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/test/fallingTrack.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { FallingTrack } from '../src/render/fallingTrack.ts'

const body = (id: number, y256: number, vy256 = 24) => ({ id, voxel: 8, x: 3, z: 4, y256, vy256 })

describe('FallingTrack', () => {
  it('starts a new body at its old cell and interpolates over one tick', () => {
    const t = new FallingTrack()
    t.update([body(1, 2560 - 24)], [], 1000)
    expect(t.frame(1000, 50, () => -1)).toEqual([{ voxel: 8, x: 3, y: 10, z: 4 }])
    expect(t.frame(1025, 50, () => -1)[0]!.y).toBeCloseTo((2560 - 12) / 256, 6)
    t.update([body(1, 2560 - 72, 48)], [], 1050)
    expect(t.frame(1050, 50, () => -1)[0]!.y).toBeCloseTo((2560 - 24) / 256, 6)
  })
  it('keeps a landed body until the mesh of its chunk at the landing version is applied', () => {
    const t = new FallingTrack()
    t.update([body(1, 300)], [], 0)
    t.update([], [{ id: 1, x: 3, y: 1, z: 4, chunk: 7, version: 12 }], 50)
    let applied = 10
    expect(t.frame(100, 50, () => applied)).toEqual([{ voxel: 8, x: 3, y: 1, z: 4 }])
    t.update([], [], 100) // later ticks hold it still
    expect(t.frame(120, 50, () => applied)[0]!.y).toBe(1)
    applied = 12
    expect(t.frame(140, 50, () => applied)).toEqual([])
    expect(t.size).toBe(0)
  })
  it('forgets a body that disappears without landing', () => {
    const t = new FallingTrack()
    t.update([body(1, 300)], [], 0)
    t.update([], [], 50)
    expect(t.size).toBe(0)
  })
})
```

Append to `packages/engine/test/meshQueue.test.ts`, inside its `describe`:

```ts
  it('reports the last applied version of a chunk', () => {
    const q = new MeshQueue()
    expect(q.appliedVersion(3)).toBe(-1)
    q.accept(3, 4)
    expect(q.appliedVersion(3)).toBe(4)
    q.accept(3, 2) // older: rejected, unchanged
    expect(q.appliedVersion(3)).toBe(4)
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/engine && npx vitest run test/fallingTrack.test.ts test/meshQueue.test.ts`

Expected: FAIL with "Failed to resolve import ../src/render/fallingTrack.ts" and "q.appliedVersion is not a function".

- [ ] **Step 3: Implement `appliedVersion` and `FallingTrack`**

In `packages/engine/src/render/meshQueue.ts`, add to `MeshQueue`:

```ts
  /** The version of the mesh last applied for a chunk; −1 before any. */
  appliedVersion(ci: number): number { return this.applied.get(ci) ?? -1 }
```

Create `packages/engine/src/render/fallingTrack.ts`:

```ts
import type { FallingBodyState, Landing } from '../sim/gravity.ts'

export interface FallingCube { voxel: number; x: number; y: number; z: number }

interface Tracked { voxel: number; x: number; z: number; prevY: number; curY: number; landing: { chunk: number; version: number } | null }

/**
 * Follows falling bodies between sim ticks for drawing (no three.js, so Node tests reach it). A body is drawn
 * between its last two heights; a landed body stays until its chunk's mesh at the landing version is applied,
 * so a block never blinks out between the cube and the chunk mesh.
 */
export class FallingTrack {
  private readonly bodies = new Map<number, Tracked>()
  private tickAt = 0

  get size(): number { return this.bodies.size }

  /** A tick message arrived at `now` (ms). */
  update(falling: readonly FallingBodyState[], landed: readonly Landing[], now: number): void {
    const seen = new Set<number>()
    for (const s of falling) {
      seen.add(s.id)
      const b = this.bodies.get(s.id)
      if (b) { b.prevY = b.curY; b.curY = s.y256 }
      else this.bodies.set(s.id, { voxel: s.voxel, x: s.x, z: s.z, prevY: s.y256 + s.vy256, curY: s.y256, landing: null })
    }
    for (const l of landed) {
      const b = this.bodies.get(l.id)
      if (!b) continue // started and landed within one tick: the chunk mesh covers it
      seen.add(l.id)
      b.prevY = b.curY
      b.curY = l.y * 256
      b.landing = { chunk: l.chunk, version: l.version }
    }
    for (const [id, b] of this.bodies) {
      if (seen.has(id)) continue
      if (b.landing) b.prevY = b.curY
      else this.bodies.delete(id)
    }
    this.tickAt = now
  }

  /** Cubes to draw at `now`, y in blocks. `applied(chunk)` is the chunk's applied mesh version. */
  frame(now: number, tickMs: number, applied: (chunk: number) => number): FallingCube[] {
    const a = Math.min(1, Math.max(0, (now - this.tickAt) / tickMs))
    const out: FallingCube[] = []
    for (const [id, b] of this.bodies) {
      if (b.landing && applied(b.landing.chunk) >= b.landing.version) { this.bodies.delete(id); continue }
      out.push({ voxel: b.voxel, x: b.x, y: (b.prevY + (b.curY - b.prevY) * a) / 256, z: b.z })
    }
    return out
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/engine && npx vitest run test/fallingTrack.test.ts test/meshQueue.test.ts`

Expected: PASS.

- [ ] **Step 5: Implement the instanced cubes**

Create `packages/engine/src/render/falling.ts`:

```ts
import * as THREE from 'three/webgpu'
import { attribute, float, normalLocal, positionLocal, select, texture, vec4 } from 'three/tsl'
import type { FallingCube } from './fallingTrack.ts'
import { VoxelNodeMaterial, voxelLit, type LightUniforms } from './voxelLighting.ts'

/** Falling blocks as instanced unit cubes: per instance a min corner and (top, side, bottom layer, packed light). */
export class FallingCubes {
  readonly mesh: THREE.Mesh
  private readonly geometry = new THREE.InstancedBufferGeometry()
  private readonly material: VoxelNodeMaterial
  private pos!: THREE.InstancedBufferAttribute
  private info!: THREE.InstancedBufferAttribute
  private capacity = 0

  constructor(tex: THREE.DataArrayTexture, lights: LightUniforms, private readonly faceLayers: Uint16Array) {
    const box = new THREE.BoxGeometry(1, 1, 1)
    box.translate(0.5, 0.5, 0.5)
    this.geometry.index = box.index
    this.geometry.setAttribute('position', box.getAttribute('position'))
    this.geometry.setAttribute('normal', box.getAttribute('normal'))
    this.geometry.setAttribute('uv', box.getAttribute('uv'))
    this.grow(64)
    const fpos = attribute('fallPos', 'vec3')
    const info = attribute('fallInfo', 'vec4')
    const n = normalLocal
    const layer = select(n.y.greaterThan(0.5), info.x, select(n.y.lessThan(-0.5), info.z, info.y))
    const sky = info.w.div(16).floor().div(15)
    const blk = info.w.mod(16).div(15)
    const m = new VoxelNodeMaterial(sky)
    m.positionNode = positionLocal.add(fpos)
    const albedo = texture(tex, attribute('uv', 'vec2')).depth(layer.add(0.5).toInt())
    voxelLit(m, { normal: n, sky, blk, ao: float(1), albedo: albedo.rgb }, lights)
    m.colorNode = vec4(albedo.rgb, 1)
    this.material = m
    this.mesh = new THREE.Mesh(this.geometry, m)
    this.mesh.name = 'elovox-falling'
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
    this.mesh.frustumCulled = false // instances are spread over the world; the box geometry's bounds say nothing
    this.mesh.raycast = () => {}
    this.mesh.visible = false
  }

  /** Draws exactly these cubes this frame. `light(x, y, z)` is the packed voxel light (sky | block << 4). */
  set(cubes: readonly FallingCube[], light: (x: number, y: number, z: number) => number): void {
    if (cubes.length > this.capacity) this.grow(cubes.length)
    cubes.forEach((c, i) => {
      const id = c.voxel & 0xfff
      const l = light(c.x, Math.floor(c.y + 0.5), c.z)
      this.pos.setXYZ(i, c.x, c.y, c.z)
      this.info.setXYZW(i, this.faceLayers[id * 6 + 2]!, this.faceLayers[id * 6]!, this.faceLayers[id * 6 + 3]!, (l & 15) * 16 + (l >> 4))
    })
    this.pos.needsUpdate = true
    this.info.needsUpdate = true
    this.geometry.instanceCount = cubes.length
    this.mesh.visible = cubes.length > 0
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }

  private grow(n: number): void {
    let cap = Math.max(64, this.capacity)
    while (cap < n) cap *= 2
    this.capacity = cap
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3)
    this.info = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4)
    this.pos.setUsage(THREE.DynamicDrawUsage)
    this.info.setUsage(THREE.DynamicDrawUsage)
    this.geometry.setAttribute('fallPos', this.pos)
    this.geometry.setAttribute('fallInfo', this.info)
  }
}
```

- [ ] **Step 6: Own the cubes in `Visuals`**

In `packages/engine/src/render/visuals.ts`:

1. Import: `import { FallingCubes } from './falling.ts'` and `import type { FallingCube } from './fallingTrack.ts'`.
2. Add to `VisualsOptions`:

```ts
  /** Per block id × 6 faces (+X −X +Y −Y +Z −Z): texture-array layer (BlockRegistry.faceLayers). */
  faceLayers: Uint16Array
```

3. Add a field `private readonly falling: FallingCubes`. In the constructor, after the decoration meshes are added:

```ts
    this.falling = new FallingCubes(o.texture, this.lights, o.faceLayers)
    o.scene.add(this.falling.mesh)
```

4. Add a method:

```ts
  /** Falling blocks to draw this frame. */
  drawFalling(cubes: readonly FallingCube[], light: (x: number, y: number, z: number) => number): void {
    this.falling.set(cubes, light)
  }
```

5. In `dispose()`, add `this.o.scene.remove(this.falling.mesh); this.falling.dispose()`.

- [ ] **Step 7: Report physics counts with each tick**

In `simulation.ts`, extend `TickResult` with:

```ts
  /** Moving fluid cells, live pools and queued region jobs after this tick. */
  physics: { active: number; pools: number; jobs: number }
```

Return it from `step()`: `physics: { active: this.fluids.activeCount, pools: this.fluids.pools.count, jobs: this.jobs.size }`.

In `protocol.ts`, add `physics: { active: number; pools: number; jobs: number }` to the `tick` message type.

- [ ] **Step 8: Wire the engine**

In `packages/engine/src/engine.ts`:

1. Import `FallingTrack`: `import { FallingTrack } from './render/fallingTrack.ts'`.
2. Compute the face layers once and pass them to both users:

```ts
  const faceLayers = registry.faceLayers(tex.layerOf)
  const tables = meshTablesFrom(registry, faceLayers, decorations.tables)
```

   Add `faceLayers,` to the `new Visuals({...})` options.
3. After `const queue = new MeshQueue()`, add `const falling = new FallingTrack()`. Next to `let lastTick = 0…`, add `let physicsStats = { active: 0, pools: 0, jobs: 0 }` and `const tickMs = 1000 / (o.sim?.tickHz ?? 20)`.
4. In the `case 'tick':` handler, after `markTick(…)`:

```ts
        falling.update(m.falling, m.landed, performance.now())
        physicsStats = m.physics
```

5. In the frame loop, before `visuals.frame(dt)`:

```ts
    visuals.drawFalling(falling.frame(performance.now(), tickMs, (ci) => queue.appliedVersion(ci)), (x, y, z) => reader.getLight(x, y, z))
```

6. Add to `EngineStats`:

```ts
  /** Falling blocks being drawn (in the air or waiting for their chunk mesh). */
  fallingBodies: number
  /** Moving fluid cells, live pools and queued region jobs, as of the last tick. */
  fluidActive: number; fluidPools: number; regionJobs: number
```

and to `stats()`:

```ts
        fallingBodies: falling.size, fluidActive: physicsStats.active, fluidPools: physicsStats.pools, regionJobs: physicsStats.jobs,
```

- [ ] **Step 9: Typecheck and run everything**

Run: `cd packages/engine && npx vitest run && npx tsc --noEmit -p .` and `cd ../.. && npm run typecheck`

Expected: all PASS, and every workspace typechecks. If the sandbox or terrain-editor typecheck complains about `EngineStats` literals in their tests, add the four new fields to those literals.

- [ ] **Step 10: Commit**

```bash
git add packages/engine/src/render packages/engine/src/engine.ts packages/engine/src/sim/simulation.ts packages/engine/src/protocol.ts packages/engine/test/fallingTrack.test.ts packages/engine/test/meshQueue.test.ts
git commit -m "feat(engine): falling blocks drawn as interpolated instanced cubes that hand over to the chunk mesh; physics stats per tick"
```

---

### Task 12: Liquid groups, springs and flow direction in the mesh and the water shader

**Files:**
- Modify: `packages/engine/src/mesh/vertexFormat.ts`, `packages/engine/src/mesh/tables.ts`, `packages/engine/src/mesh/liquid.ts`, `packages/engine/src/render/chunkVertex.ts`, `packages/engine/src/render/materials.ts`, `packages/engine/src/render/water.ts`
- Test: `packages/engine/test/vertexFormat.test.ts`, `packages/engine/test/liquid.test.ts`

**Interfaces:**
- Consumes: `BlockRegistry.liquidGroup` and `.source` (Task 1).
- Produces:
  - `FLOW = { STILL: 0, STEEP: 8, MOVING: 16 }`, `flowCode(dir, steep)`, `packFlow(a, b, code): [number, number]`, `unpackFlow(a, b): number`.
  - `MeshTables.liquidGroup: Uint16Array` and `MeshTables.source: Uint8Array`.
  - `meshTablesFrom` throws a `RangeError` for a liquid face layer ≥ 512.
  - `chunkVertex(scales?, liquid = false)` returns `flow: vec3` (x and z direction times moving, then speed).

- [ ] **Step 1: Write the failing tests**

Append to `packages/engine/test/vertexFormat.test.ts`:

```ts
describe('flow bits', () => {
  it('round-trips every flow code through a liquid vertex without touching its other fields', () => {
    for (let code = 0; code < 32; code++) {
      const a0 = packA(31, 32, 7, 2, 1, 3, 17), b0 = packB(511, 9, 4, 1, 1)
      const [a, b] = packFlow(a0, b0, code)
      expect(unpackFlow(a, b)).toBe(code)
      expect(unpackA(a)).toEqual(unpackA(a0))
      expect(unpackB(b).layer & 511).toBe(511)
      expect(unpackB(b).sky).toBe(9)
    }
  })
  it('builds moving codes', () => {
    expect(flowCode(3, false)).toBe(FLOW.MOVING | 3)
    expect(flowCode(10, true)).toBe(FLOW.MOVING | FLOW.STEEP | 2)
  })
})
```

Change its import to `import { FLOW, flowCode, packA, packB, packFlow, unpackA, unpackB, unpackFlow } from '../src/mesh/vertexFormat.ts'`.

Append to `packages/engine/test/liquid.test.ts`:

```ts
describe('liquid groups, springs and flow', () => {
  const reg = new BlockRegistry([...TEST_BLOCKS, defineBlock({ name: 'spring', liquid: true, source: 'water', textures: 'water' })])
  const SPRING_ID = 8
  const t2 = meshTablesFrom(reg, reg.faceLayers(new Map(reg.textureNames().map((n, i) => [n, i + 1]))))
  const liquidOf = (s: ChunkSnapshot) => { const t = new QuadBuilder(), l = new QuadBuilder(); meshTranslucent(s, t2, t, l); return l.build() }
  const faces = (m: ReturnType<typeof liquidOf>, normal: number) => {
    const out: { a: number; b: number }[] = []
    if (m) for (let i = 0; i < m.vertices.length; i += 8) if (unpackA(m.vertices[i]!).normal === normal) out.push({ a: m.vertices[i]!, b: m.vertices[i + 1]! })
    return out
  }

  it('draws no face between water and its spring', () => {
    const s = emptySnap()
    put(s, 5, 5, 5, water(0))
    put(s, 6, 5, 5, packVoxel(SPRING_ID, 3))
    const m = liquidOf(s)
    expect(faces(m, FACE.PX).length + faces(m, FACE.NX).length).toBe(2) // only the outer −x of the water and +x of the spring
  })
  it('draws a spring at full level whatever its state', () => {
    const s = emptySnap()
    put(s, 6, 5, 5, packVoxel(SPRING_ID, 3))
    const tops = faces(liquidOf(s), FACE.PY)
    expect(tops).toHaveLength(1)
    expect(unpackA(tops[0]!.a).drop).toBe(Math.round((1 - liquidHeight(7)) * 16))
  })
  it('points the top-face flow downhill and leaves flat water still', () => {
    const s = emptySnap()
    for (let x = 4; x <= 6; x++) put(s, x, 5, 5, water(x === 4 ? 7 : x === 5 ? 3 : 0))
    const tops = faces(liquidOf(s), FACE.PY)
    const mid = tops.find((f) => unpackA(f.a).x === 5)! // the first vertex of the x = 5 cell's top quad
    const code = unpackFlow(mid.a, mid.b)
    expect(code & FLOW.MOVING).toBeTruthy()
    expect(code & 7).toBe(0) // toward +x
    const flat = emptySnap()
    for (let x = 4; x <= 6; x++) put(flat, x, 5, 5, water(5))
    for (const f of faces(liquidOf(flat), FACE.PY)) expect(unpackFlow(f.a, f.b)).toBe(FLOW.STILL)
  })
  it('marks the sides of falling water steep and leaves the top cell still', () => {
    const s = emptySnap()
    put(s, 5, 5, 5, water(7))
    put(s, 5, 6, 5, water(7))
    const side = faces(liquidOf(s), FACE.PX) // first vertex of each quad sits at the cell's own y
    const lower = side.filter((f) => unpackA(f.a).y === 5)
    const upper = side.filter((f) => unpackA(f.a).y === 6)
    expect([lower.length, upper.length]).toEqual([1, 1])
    expect(unpackFlow(lower[0]!.a, lower[0]!.b) & FLOW.STEEP).toBeTruthy()
    expect(unpackFlow(upper[0]!.a, upper[0]!.b)).toBe(FLOW.STILL)
  })
  it('refuses a liquid texture layer at or above 512', () => {
    const fl = reg.faceLayers(new Map(reg.textureNames().map((n) => [n, n === 'water' ? 600 : 1])))
    expect(() => meshTablesFrom(reg, fl)).toThrow(/below layer 512/)
  })
})
```

Add to the imports of `liquid.test.ts`:

```ts
import { BlockRegistry, defineBlock } from '../src/blocks/registry.ts'
import { meshTablesFrom } from '../src/mesh/tables.ts'
import { FLOW, unpackFlow } from '../src/mesh/vertexFormat.ts'
import { TEST_BLOCKS } from './helpers.ts'
```

`unpackA` and `FACE` are already imported there. Reuse the existing imports instead of duplicating them.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/engine && npx vitest run test/vertexFormat.test.ts test/liquid.test.ts`

Expected: FAIL with "packFlow is not exported" / "FLOW is not exported".

- [ ] **Step 3: Implement the flow bits and tables**

Append to `packages/engine/src/mesh/vertexFormat.ts`:

```ts
/** Liquid flow codes (5 bits): MOVING, STEEP, and a direction in bits 0–2 (0 = +x, then 45° steps toward +z). */
export const FLOW = { STILL: 0, STEEP: 8, MOVING: 16 } as const

export function flowCode(dir: number, steep: boolean): number {
  return FLOW.MOVING | (steep ? FLOW.STEEP : 0) | (dir & 7)
}

/** Packs a flow code into a liquid vertex: bits 30–31 of word A (reserved) and bits 9–11 of word B (liquid layers stay below 512). */
export function packFlow(a: number, b: number, code: number): [number, number] {
  return [(a | ((code & 3) << 30)) >>> 0, (b | (((code >> 2) & 7) << 9)) >>> 0]
}

export function unpackFlow(a: number, b: number): number {
  return ((a >>> 30) & 3) | (((b >>> 9) & 7) << 2)
}
```

Replace `packages/engine/src/mesh/tables.ts`:

```ts
import type { BlockRegistry } from '../blocks/registry.ts'
import { emptyDecorationTables, type DecorationTables } from '../render/decorations/defs.ts'

/** Plain typed arrays, so they can be posted to mesh workers. */
export interface MeshTables {
  opaque: Uint8Array
  layer: Uint8Array
  liquid: Uint8Array
  /** Base liquid id of a liquid or spring; 0 otherwise. Liquids of one group share corners and hide faces between them. */
  liquidGroup: Uint16Array
  /** 1 for a spring: drawn at full level whatever its state. */
  source: Uint8Array
  faceLayers: Uint16Array
  deco: DecorationTables
}

/** Liquid faces carry flow bits in word B bits 9–11, so their texture layer must fit in 9 bits. */
export const MAX_LIQUID_LAYER = 511

export function meshTablesFrom(registry: BlockRegistry, faceLayers: Uint16Array, deco: DecorationTables = emptyDecorationTables(registry.count)): MeshTables {
  for (let id = 0; id < registry.count; id++) {
    if (registry.liquid[id] !== 1) continue
    for (let f = 0; f < 6; f++) {
      const layer = faceLayers[id * 6 + f]!
      if (layer > MAX_LIQUID_LAYER) throw new RangeError(`liquid block "${registry.name(id)}" uses texture layer ${layer}; liquid textures must sit below layer 512`)
    }
  }
  return {
    opaque: registry.opaque, layer: registry.layer, liquid: registry.liquid,
    liquidGroup: registry.liquidGroup, source: registry.source, faceLayers, deco,
  }
}
```

- [ ] **Step 4: Mesh liquid groups, springs and flow**

Replace `packages/engine/src/mesh/liquid.ts`:

```ts
import { LAYER } from '../blocks/registry.ts'
import { padIndex, type ChunkSnapshot } from '../world/reader.ts'
import { voxelId, voxelState } from '../world/voxel.ts'
import { AXES, REVERSE, STRIDE } from './greedy.ts'
import type { QuadBuilder } from './quadBuilder.ts'
import type { MeshTables } from './tables.ts'
import { FACE, FLOW, flowCode, packA, packB, packFlow } from './vertexFormat.ts'

export function liquidHeight(level: number): number { return (level + 1) / 9 }

/** Below this corner-height slope (blocks per block) a surface reads as still. */
const FLOW_EPS = 0.05
/** Above it, as steep. */
const FLOW_STEEP = 0.5

const UP = STRIDE[1]
const qa = new Uint32Array(4)
const qb = new Uint32Array(4)
const corners = [0, 0, 0, 0] // top-corner heights in order (−x,−z) (+x,−z) (+x,+z) (−x,+z)
const SX = [-1, 1, 1, -1]
const SZ = [-1, -1, 1, 1]

function level(s: ChunkSnapshot, t: MeshTables, pi: number): number {
  const v = s.voxels[pi]!
  return t.source[voxelId(v)] === 1 ? 7 : voxelState(v) & 7
}

function cellHeight(s: ChunkSnapshot, t: MeshTables, pi: number, group: number): number {
  if (t.liquidGroup[voxelId(s.voxels[pi + UP]!)] === group) return 1
  return liquidHeight(level(s, t, pi))
}

function cornerHeights(s: ChunkSnapshot, t: MeshTables, pi: number, group: number): void {
  for (let c = 0; c < 4; c++) {
    const cells = [pi, pi + SX[c]!, pi + SZ[c]! * STRIDE[2], pi + SX[c]! + SZ[c]! * STRIDE[2]]
    let sum = 0, n = 0, full = false
    for (const ci of cells) {
      if (t.liquidGroup[voxelId(s.voxels[ci]!)] !== group) continue
      const hgt = cellHeight(s, t, ci, group)
      if (hgt === 1) { full = true; break }
      sum += hgt
      n++
    }
    corners[c] = full ? 1 : sum / n
  }
}

/** Downhill direction of the current top face from its corner heights, as a flow code. */
function topFlow(): number {
  const fx = (corners[0]! + corners[3]!) - (corners[1]! + corners[2]!) // −gradient along x
  const fz = (corners[0]! + corners[1]!) - (corners[2]! + corners[3]!) // −gradient along z
  const m = Math.hypot(fx, fz)
  if (m < FLOW_EPS) return FLOW.STILL
  const dir = ((Math.round(Math.atan2(fz, fx) / (Math.PI / 4)) % 8) + 8) % 8
  return flowCode(dir, m > FLOW_STEEP)
}

function cornerIndex(sx: number, sz: number): number {
  return sz < 0 ? (sx < 0 ? 0 : 1) : (sx > 0 ? 2 : 3)
}

export function meshTranslucent(s: ChunkSnapshot, t: MeshTables, translucent: QuadBuilder, liquidOut: QuadBuilder): void {
  const p = [0, 0, 0]
  for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
    const pi = padIndex(x + 1, y + 1, z + 1)
    const id = voxelId(s.voxels[pi]!)
    const layer = t.layer[id]
    if (layer !== LAYER.TRANSLUCENT && layer !== LAYER.LIQUID) continue
    const out = layer === LAYER.LIQUID ? liquidOut : translucent
    const liquid = t.liquid[id] === 1
    const group = liquid ? t.liquidGroup[id]! : 0
    if (liquid) cornerHeights(s, t, pi, group)
    const falling = liquid && t.liquidGroup[voxelId(s.voxels[pi + UP]!)] === group
    for (let f = 0; f < 6; f++) {
      const [d, u, v] = AXES[f]!
      const ni = pi + ((f & 1) === 0 ? 1 : -1) * STRIDE[d as 0 | 1 | 2]
      const nid = voxelId(s.voxels[ni]!)
      if (t.opaque[nid] || (liquid ? t.liquidGroup[nid] === group : nid === id)) continue
      const l = s.light[ni]!
      const b = packB(t.faceLayers[id * 6 + f]!, l & 15, l >> 4, 1, 1)
      const plane = (f & 1) === 0 ? 1 : 0
      const flow = !liquid ? FLOW.STILL : f === FACE.PY ? topFlow() : f !== FACE.NY && falling ? flowCode(0, true) : FLOW.STILL
      for (let c = 0; c < 4; c++) {
        const cu = c === 1 || c === 2 ? 1 : 0
        const cv = c >= 2 ? 1 : 0
        p[d] = plane; p[u] = cu; p[v] = cv
        const vx = x + p[0]!, vz = z + p[2]!
        let vy = y + p[1]!
        let drop = 0
        if (liquid && p[1] === 1) {
          const hgt = corners[cornerIndex(p[0] ? 1 : -1, p[2] ? 1 : -1)]!
          drop = Math.round((1 - hgt) * 16)
          vy = y + 1
        }
        qa[c] = packA(vx, vy, vz, f, 0, c, drop)
        qb[c] = b
        if (flow !== FLOW.STILL) [qa[c], qb[c]] = packFlow(qa[c]!, qb[c]!, flow)
      }
      out.push(qa, qb, false, REVERSE[f]!)
    }
  }
}
```

Check: in the "downhill" test the cells hold levels 7, 3 and 0 from x = 4 to 6. The middle cell's corners are higher on −x, so `fx > 0`, `atan2(0, +) = 0` and dir = 0 (+x).

- [ ] **Step 5: Decode the flow in the shaders**

In `packages/engine/src/render/chunkVertex.ts`, change the signature to `export function chunkVertex(scales?: ScaleTable, liquid = false)` and replace the `layer` and `uvRaw` lines:

```ts
  // Liquid faces keep flow bits in word B bits 9–11 (and word A bits 30–31), so their layer is 9 bits wide.
  const layerBits = b.bitAnd(uint(liquid ? 511 : 4095))
  const layer = layerBits.toFloat()
```

and in `uvRaw`, use `scales.element(layerBits.toInt())` instead of `scales.element(b.bitAnd(uint(4095)).toInt())`.

Before `return`, decode the flow:

```ts
  const code = liquid
    ? a.shiftRight(uint(30)).bitAnd(uint(3)).bitOr(b.shiftRight(uint(9)).bitAnd(uint(7)).shiftLeft(uint(2)))
    : uint(0)
  const moving = code.shiftRight(uint(4)).bitAnd(uint(1)).toFloat()
  const steep = code.shiftRight(uint(3)).bitAnd(uint(1)).toFloat()
  const angle = code.bitAnd(uint(7)).toFloat().mul(Math.PI / 4)
  // x, z: unit direction (0 when still); z component of the vec3: speed (1 gentle, 2.5 steep, 0 still)
  const flow = vec3(angle.cos().mul(moving), angle.sin().mul(moving), moving.mul(steep.mul(1.5).add(1)))
```

Add `flow: varying(flow),` to the returned object.

In `packages/engine/src/render/materials.ts`, change `build` to take the flag and use it for the liquid slot:

```ts
  function build(mode: 'opaque' | 'cutout' | 'translucent', liquid = false): VoxelNodeMaterial {
    const v = chunkVertex(scales as Parameters<typeof chunkVertex>[0], liquid)
```

and `return { opaque: build('opaque'), cutout: build('cutout'), translucent: build('translucent'), liquid: build('translucent', true) }`.

In `packages/engine/src/render/water.ts`:

1. Add `const FLOW_SPEED = 1.2` (blocks per second at speed 1) next to `RIPPLE`.
2. Change `const v = chunkVertex()` to `const v = chunkVertex(undefined, true)`.
3. Sample the ripples in a frame that moves with the flow. Replace the `h0, hx, hz` line:

```ts
    const drift = vec2(v.flow.x, v.flow.y).mul(time.mul(v.flow.z).mul(FLOW_SPEED))
    const q = wp.xz.sub(drift)
    const h0 = h(q), hx = h(q.add(vec2(EPS, 0))), hz = h(q.add(vec2(0, EPS)))
```

4. Make the side streaks of falling water run faster. Replace the `streak` line:

```ts
    const fall = float(1).add(v.flow.z.mul(2))
    const streak = select(isTop, float(0), mx_noise_float(vec3(wp.x.add(wp.z).mul(0.9), wp.y.mul(0.6).add(speed.mul(3).mul(fall)), 0)).mul(0.12))
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `cd packages/engine && npx vitest run && npx tsc --noEmit -p .`

Expected: all PASS (`vertexFormat`, `liquid`, `greedy`, `meshJob`, …), typecheck 0.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/mesh packages/engine/src/render/chunkVertex.ts packages/engine/src/render/materials.ts packages/engine/src/render/water.ts packages/engine/test/vertexFormat.test.ts packages/engine/test/liquid.test.ts
git commit -m "feat(engine): springs share water's surface; liquid vertices carry a flow direction the water shader scrolls along"
```

---

### Task 13: Decoration density by block state

**Files:**
- Modify: `packages/engine/src/render/decorations/defs.ts`, `packages/engine/src/render/decorations/extract.ts`
- Test: `packages/engine/test/decorations.test.ts`

**Interfaces:**
- Produces:
  - `DecorationDef.stateDensity?: readonly [number, number, number, number]`.
  - `ResolvedDecoration.stateDensity: readonly number[]`.
  - `DecorationTables.stateDensity: Float32Array` (4 per decoration).
  - `extractDecorations` keeps a decorated block's instances with probability `stateDensity[state & 3]`, deterministic per block.

- [ ] **Step 1: Write the failing tests**

Append to `packages/engine/test/decorations.test.ts`:

```ts
describe('stateDensity', () => {
  const YOUNG = defineDecoration({ name: 'meadow', grass: {}, stateDensity: [1, 2 / 3, 1 / 3, 0] })
  const plane = (state: number) => {
    const s = emptySnap()
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) put(s, x, 4, z, (state << 12) | ID.grass)
    return s
  }
  const count = (state: number) => instances(run(plane(state), decoratedMeshTables([YOUNG])).grass).length
  it('keeps every tuft at state 0, none at state 3, and about a third at state 2', () => {
    expect(count(0)).toBe(1024)
    expect(count(3)).toBe(0)
    const third = count(2)
    expect(third).toBeGreaterThan(1024 * 0.25)
    expect(third).toBeLessThan(1024 * 0.42)
  })
  it('is deterministic per block and nested: a block shown at 1/3 is also shown at 2/3', () => {
    const at = (state: number) => new Set(instances(run(plane(state), decoratedMeshTables([YOUNG])).grass).map((i) => i.lx + i.lz * 32))
    const a = at(2), b = at(1)
    for (const k of a) expect(b.has(k)).toBe(true)
  })
  it('validates stateDensity', () => {
    const b = new BlockRegistry([defineBlock({ name: 'stone' })])
    expect(() => new DecorationRegistry([{ name: 'x', stateDensity: [1, 2, 0, 0] as unknown as [number, number, number, number] }], b)).toThrow(/stateDensity/)
    expect(() => new DecorationRegistry([{ name: 'x', stateDensity: [1, 1] as unknown as [number, number, number, number] }], b)).toThrow(/stateDensity/)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/engine && npx vitest run test/decorations.test.ts`

Expected: FAIL. `count(3)` is 1024, because density is ignored.

- [ ] **Step 3: Implement**

In `packages/engine/src/render/decorations/defs.ts`:

1. Extend the def and the resolved form:

```ts
export interface DecorationDef {
  name: string
  grass?: GrassDef
  flowers?: FlowerDef
  /** Instance density by the decorated block's state & 3 (e.g. grass youth: [1, ⅔, ⅓, 0]). Default all 1. */
  stateDensity?: readonly [number, number, number, number]
}
export interface ResolvedDecoration { name: string; grass: ResolvedGrass | null; flowers: ResolvedFlowers | null; stateDensity: readonly number[] }
```

2. Add `stateDensity: Float32Array` to `DecorationTables`. In `emptyDecorationTables`, add `stateDensity: new Float32Array(0)`.

3. In `resolve`, before `return`:

```ts
  const sd = d.stateDensity ?? [1, 1, 1, 1]
  if (!Array.isArray(sd) || sd.length !== 4 || !sd.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) {
    throw new RangeError(`${p} stateDensity must be 4 numbers in [0, 1]`)
  }
```

   and return `{ name: d.name, grass, flowers, stateDensity: sd }`.

4. In `DecorationRegistry`'s `tables`, add `stateDensity: Float32Array.from(this.defs.flatMap((d) => d.stateDensity))`.

In `packages/engine/src/render/decorations/extract.ts`:

1. Add `const DENSITY_SEED = 0x51d3e` next to the other seeds, and import `voxelState`: `import { AIR, voxelId, voxelState } from '../../world/voxel.ts'`.
2. In `extractDecorations`, after `if (voxelId(s.voxels[pi + UP]!) !== AIR) continue`, compute the world position early and thin by density:

```ts
    const wx = ox + x, wy = oy + y, wz = oz + z
    const dens = d.stateDensity[(k - 1) * 4 + (voxelState(s.voxels[pi]!) & 3)]!
    if (dens < 1 && hash32(DENSITY_SEED, wx, wy, wz) / 4294967296 >= dens) continue
```

   Then remove the later `const wx = ox + x, wy = oy + y, wz = oz + z` line, because the values are now defined above.

The nesting test holds because the same per-block hash is compared against a larger threshold.

- [ ] **Step 4: Run the tests**

Run: `cd packages/engine && npx vitest run && npx tsc --noEmit -p .`

Expected: PASS, typecheck 0.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/render/decorations packages/engine/test/decorations.test.ts
git commit -m "feat(engine): decoration density by block state (stateDensity)"
```

---

### Task 14: Terrain: springs at river heads, and the sea level for the sim

**Files:**
- Modify: `packages/terrain/src/doc/types.ts`, `packages/terrain/src/ops/registry.ts`, `packages/terrain/src/ops/river.ts`, `packages/terrain/src/pipeline/compile.ts`, `packages/terrain/src/pipeline/region.ts`, `packages/terrain/src/generator.ts`
- Modify: `docs/superpowers/specs/2026-10-03-simulation-water-design.md` (§4 Terrain, planning deviation 9)
- Test: `packages/terrain/test/fixtures.ts`, `packages/terrain/test/waterOps.test.ts`, `packages/terrain/test/pipeline.test.ts`, `packages/terrain/test/generator.test.ts`

**Interfaces:**
- Consumes: `GeneratorConfig` (Task 4); the engine's `packVoxel`.
- Produces:
  - `BlockNames.spring` (default `'spring'`).
  - `HeightOp.spring?: { readonly x: number; readonly z: number; readonly flow: number }`.
  - The river op takes `params.flow` (integer 0–15, default 8).
  - `TerrainBlocks.spring: number` (−1 when no op places one).
  - `generateRegion` places `packVoxel(spring, flow)` in the lowest water cell of the head column.
  - `createTerrainGenerator().configure` returns `{ seaLevel }`.

- [ ] **Step 1: Write the failing tests**

In `packages/terrain/test/fixtures.ts`, add `spring: 14` to `IDS`.

Append to `packages/terrain/test/waterOps.test.ts`, inside `describe('river', …)`:

```ts
  it('puts a spring at the head of the path unless flow is 0', () => {
    const op = river.compile({ ...def, type: 'river', enabled: true, params: { ...def.params, flow: 5 } }, ctx)
    expect(op.spring).toEqual({ x: 0, z: 0, flow: 5 })
    expect(river.compile({ ...def, type: 'river', enabled: true }, ctx).spring).toEqual({ x: 0, z: 0, flow: 8 })
    expect(river.compile({ ...def, type: 'river', enabled: true, params: { ...def.params, flow: 0 } }, ctx).spring).toBeUndefined()
  })
  it('validates flow', () => {
    const c = new Check()
    river.validate(c, 'ops[0]', { ...def, type: 'river', enabled: true, params: { ...def.params, flow: 16 } }, { biomes: [], height: 128 })
    expect(c.errors.join('\n')).toMatch(/flow/)
  })
```

Append to `packages/terrain/test/pipeline.test.ts` (a new `describe` at the end):

```ts
describe('generateRegion: springs', () => {
  it('places a river spring in the lowest water cell of its head column', () => {
    const doc = {
      ...minimalDoc(),
      ops: [{ id: 'r', type: 'river', shape: { kind: 'path', width: 6, points: [{ x: 10, z: 32 }, { x: 54, z: 32 }] }, params: { start: 18, end: 14, flow: 3 } }],
    }
    const get = region(compileDoc(doc), 0, 0, 64, 64)
    const col = column(get, 10, 32)
    const springs = col.map((v, y) => [v, y] as const).filter(([v]) => (v & 0xfff) === IDS.spring)
    expect(springs).toHaveLength(1)
    const [v, y] = springs[0]!
    expect(v).toBe(IDS.spring! | (3 << 12))
    expect(col[y - 1]! & 0xfff).not.toBe(IDS.water) // nothing liquid below it: it sits on the bed
    expect(col[y + 1]).toBe(WATER)
  })
  it('needs no spring block when no river flows', () => {
    const t = compileDoc({ ...minimalDoc(), ops: [{ id: 'r', type: 'river', shape: { kind: 'path', width: 6, points: [{ x: 10, z: 32 }, { x: 54, z: 32 }] }, params: { start: 18, end: 14, flow: 0 } }] })
    expect(t.blocks.spring).toBe(-1)
  })
})
```

Append to `packages/terrain/test/generator.test.ts`, inside `describe('terrainGenerator', …)`:

```ts
  it('hands the sea level to the simulation', () => {
    const s = sim()
    s.configure(terrainGenerator, minimalDoc())
    expect(s.fluids.seaLevel).toBe(10)
  })
```

The doc in that file has no river with flow, so its `BLOCKS` list needs no spring.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/terrain && npx vitest run`

Expected: FAIL. `op.spring` is undefined, `t.blocks.spring` is undefined, and `seaLevel` is 0.

- [ ] **Step 3: Implement**

`packages/terrain/src/doc/types.ts`:

```ts
/** Block names the pipeline places by itself. */
export interface BlockNames { fill: string; water: string; log: string; leaves: string; pineLeaves: string; rock: string; spring: string }
export const DEFAULT_BLOCKS: BlockNames = { fill: 'stone', water: 'water', log: 'log', leaves: 'leaves', pineLeaves: 'pine_leaves', rock: 'rock', spring: 'spring' }
```

`packages/terrain/src/ops/registry.ts`, in `HeightOp`:

```ts
  /** A spring this op places: in the lowest water cell of column (x, z), with this flow index (0–15). */
  readonly spring?: { readonly x: number; readonly z: number; readonly flow: number }
```

`packages/terrain/src/ops/river.ts`:

1. Add the param:

```ts
  flow: { type: 'number', default: 8, min: 0, max: 15, int: true, range: [0, 15] },
```

2. Extend the doc comment with: "A spring with flow index `flow` (0 = none) sits in the bed under the first point; the sim's water then runs from it."

3. In `compile`, read it, take the head and return the spring:

```ts
    const { start, end, depth, bank, bankSlope: slope, flow } = paramsOf(def, PARAMS)
    const head = def.shape.kind === 'path' ? def.shape.points[0] : undefined
    const spring = flow > 0 && head ? { x: Math.floor(head.x), z: Math.floor(head.z), flow } : undefined
```

   Add `spring,` to the returned object.

`packages/terrain/src/pipeline/compile.ts`:

1. Extend `TerrainBlocks` with `spring: number`, documented as "the spring voxel id, or −1 when no op places one".
2. In `compileTerrain`, the `blocks` object becomes:

```ts
    blocks: {
      fill: id(doc.blocks.fill), water: packVoxel(id(doc.blocks.water), WATER_STATE),
      log: id(doc.blocks.log), leaves: id(doc.blocks.leaves), pineLeaves: id(doc.blocks.pineLeaves), rock: id(doc.blocks.rock),
      // Resolved only when needed: a document without flowing rivers works with registries that lack a spring block.
      spring: heightOps.some((op) => op.spring !== undefined) ? id(doc.blocks.spring) : -1,
    },
```

`packages/terrain/src/pipeline/region.ts`:

1. Import: `import { packVoxel } from '@elovox/engine/src/world/voxel.ts'`.
2. Between the column loop and `if (o.features !== false) …`, add:

```ts
  if (t.blocks.spring >= 0) {
    const waterId = t.blocks.water & 0xfff
    for (const op of t.heightOps) {
      const s = op.spring
      if (!s || s.x < x0 || s.x >= x0 + w || s.z < z0 || s.z >= z0 + d) continue
      const lx = s.x - x0, lz = s.z - z0
      for (let y = 0; y < H; y++) {
        const i = lx + lz * w + y * layer
        if ((out[i]! & 0xfff) === waterId) { out[i] = packVoxel(t.blocks.spring, s.flow); break }
      }
    }
  }
```

`packages/terrain/src/generator.ts`, at the end of `configure`, after `limits = …`:

```ts
      return { seaLevel: r.doc.seaLevel }
```

- [ ] **Step 4: Correct the spec**

In `docs/superpowers/specs/2026-10-03-simulation-water-design.md` §4 "Terrain", replace the sentence "The river's water is still generated as today. When the sim starts, its stepped surface becomes neighbouring pools that drain into each other, the spring refills them, and the river reaches a steady state. The steady state may differ slightly from the drawn one." with:

> The river's water is still generated as today. When the sim starts, each step of its surface becomes a pool in contact with the next. Connected water seeks one level, so the river drains toward the sea. The steady state is a spring-fed stream along the carved bed, plus whatever the bed holds in its hollows. The carved channel keeps the editor's shape; the water in it is the shape the sim gives.

- [ ] **Step 5: Run every suite that compiles terrain**

Run: `npm test --workspaces --if-present`

Expected: terrain PASS. The engine, terrain-editor and sandbox suites still pass. `apps/sandbox/test/terrainDocs.test.ts` compiles the showcase and e2e documents, which have rivers (default flow 8), against the sandbox `BLOCKS`. That registry has no `spring` until Task 15, so this test fails until then. If it fails, add `defineBlock({ name: 'spring', textures: 'water', liquid: true, source: 'water', solid: false })` to `apps/sandbox/src/blocks.ts` now; Task 15 keeps it.

- [ ] **Step 6: Commit**

```bash
git add packages/terrain docs/superpowers/specs/2026-10-03-simulation-water-design.md apps/sandbox/src/blocks.ts
git commit -m "feat(terrain): rivers place a spring at their head; the generator reports the sea level"
```

---

### Task 15: Sandbox content: falling sand, springs, wet blocks, growing grass, water in the hotbar

**Files:**
- Modify: `apps/sandbox/src/blocks.ts`, `apps/sandbox/src/rules.ts`, `apps/sandbox/src/paint/materials.ts`, `apps/sandbox/src/paint/index.ts`, `apps/sandbox/src/main.ts`, `apps/sandbox/src/hud.ts`
- Test: `apps/sandbox/test/rules.test.ts` (new), `apps/sandbox/test/painter.test.ts`

**Interfaces:**
- Consumes:
  - the `RuleContext` reads (Task 1);
  - `BlockDef.falls` and `source`;
  - `DecorationDef.stateDensity` (Task 13);
  - the `EngineStats` physics fields (Task 11).
- Produces:
  - Sandbox blocks `spring`, `mud` and `wet_sand`; sand and gravel now fall.
  - Rules on `grass` (dies covered, grows its youth, spreads), `dirt` ↔ `mud` and `sand` ↔ `wet_sand`.
  - `nearWater(ctx, x, y, z)` exported from `rules.ts`.
  - Painted tiles `mud` and `wet_sand`.
  - `randomTicksPerChunk: 24`, `?debugFluids`, water in the hotbar, and a physics line in the HUD.

- [ ] **Step 1: Write the failing rule tests**

Create `apps/sandbox/test/rules.test.ts`:

```ts
import type { RuleContext } from '@elovox/engine/sim-worker'
import { describe, expect, it } from 'vitest'
import { BLOCKS } from '../src/blocks.ts'
import rules, { nearWater } from '../src/rules.ts'

const id = (name: string) => BLOCKS.findIndex((b) => b.name === name) + 1
const def = (v: number) => BLOCKS[(v & 0xfff) - 1]

/** A RuleContext over a Map, with fixed random numbers and sky light 15 unless a cell is listed as dark. */
function world(cells: Record<string, number>, o: { random?: number[]; dark?: string[] } = {}) {
  const m = new Map(Object.entries(cells))
  const rnd = [...(o.random ?? [])]
  const ctx = {
    tick: 0,
    get: (x: number, y: number, z: number) => m.get(`${x},${y},${z}`) ?? 0,
    set: (x: number, y: number, z: number, v: number) => { m.set(`${x},${y},${z}`, v) },
    schedule() {}, emit() {},
    random: () => rnd.shift() ?? 0,
    id,
    isAir: (v: number) => (v & 0xfff) === 0,
    state: (v: number) => (v >>> 12) & 15,
    withState: (v: number, s: number) => (v & 0xfff) | (s << 12),
    isSolid: (v: number) => (v & 0xfff) !== 0 && def(v)!.solid !== false && !def(v)!.liquid,
    isLiquid: (v: number) => (v & 0xfff) !== 0 && def(v)!.liquid === true,
    isOpaque: (v: number) => (v & 0xfff) !== 0 && (def(v)!.layer ?? (def(v)!.liquid ? 'liquid' : 'opaque')) === 'opaque',
    falls: (v: number) => (v & 0xfff) !== 0 && def(v)!.falls === true,
    skyLight: (x: number, y: number, z: number) => ((o.dark ?? []).includes(`${x},${y},${z}`) ? 0 : 15),
    blockLight: () => 0,
    level: (v: number) => ((v & 0xfff) === id('water') ? (v >>> 12) & 7 : -1),
  } satisfies RuleContext
  return { ctx, at: (x: number, y: number, z: number) => ctx.get(x, y, z) }
}
const tick = (block: string, ctx: RuleContext, x: number, y: number, z: number) =>
  rules.blocks![block]!.onRandomTick!(ctx, x, y, z, ctx.get(x, y, z))

describe('sandbox rules', () => {
  it('turns grass under an opaque block or water into dirt', () => {
    const { ctx, at } = world({ '0,0,0': id('grass'), '0,1,0': id('stone') })
    tick('grass', ctx, 0, 0, 0)
    expect(at(0, 0, 0)).toBe(id('dirt'))
    const w = world({ '0,0,0': id('grass'), '0,1,0': id('water') | (7 << 12) })
    tick('grass', w.ctx, 0, 0, 0)
    expect(w.at(0, 0, 0)).toBe(id('dirt'))
  })
  it('grows young grass back one step per tick', () => {
    const { ctx, at } = world({ '0,0,0': id('grass') | (3 << 12) })
    tick('grass', ctx, 0, 0, 0)
    expect(at(0, 0, 0)).toBe(id('grass') | (2 << 12))
  })
  it('spreads to lit dirt as young grass, and not into the dark', () => {
    // random: side 0 (+x), dy 1 → 0 (rounds to level)
    const { ctx, at } = world({ '0,0,0': id('grass'), '1,0,0': id('dirt') }, { random: [0, 0.5] })
    tick('grass', ctx, 0, 0, 0)
    expect(at(1, 0, 0)).toBe(id('grass') | (3 << 12))
    const dark = world({ '0,0,0': id('grass'), '1,0,0': id('dirt') }, { random: [0, 0.5], dark: ['1,1,0'] })
    tick('grass', dark.ctx, 0, 0, 0)
    expect(dark.at(1, 0, 0)).toBe(id('dirt'))
  })
  it('wets dirt and sand within two blocks of water, and dries them away from it', () => {
    const water = id('water') | (7 << 12)
    const w = world({ '0,0,0': id('dirt'), '2,0,0': water, '5,0,0': id('sand'), '5,0,2': water })
    expect(nearWater(w.ctx, 0, 0, 0)).toBe(true)
    tick('dirt', w.ctx, 0, 0, 0)
    tick('sand', w.ctx, 5, 0, 0)
    expect([w.at(0, 0, 0), w.at(5, 0, 0)]).toEqual([id('mud'), id('wet_sand')])
    const dry = world({ '0,0,0': id('mud'), '9,0,0': id('wet_sand') })
    tick('mud', dry.ctx, 0, 0, 0)
    tick('wet_sand', dry.ctx, 9, 0, 0)
    expect([dry.at(0, 0, 0), dry.at(9, 0, 0)]).toEqual([id('dirt'), id('sand')])
  })
  it('lets sand and gravel fall but not wet sand; springs feed water', () => {
    expect(BLOCKS.find((b) => b.name === 'sand')!.falls).toBe(true)
    expect(BLOCKS.find((b) => b.name === 'gravel')!.falls).toBe(true)
    expect(BLOCKS.find((b) => b.name === 'wet_sand')!.falls).toBeFalsy()
    expect(BLOCKS.find((b) => b.name === 'spring')).toMatchObject({ liquid: true, source: 'water' })
  })
})
```

In `apps/sandbox/test/painter.test.ts`, add `'mud', 'wet_sand'` to `NAMES` and to the "keeps solid tiles opaque" list.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/sandbox && npx vitest run test/rules.test.ts test/painter.test.ts`

Expected: FAIL. `nearWater` is not exported, `rules.blocks.dirt` is undefined, and the painted tile names differ.

- [ ] **Step 3: Blocks and decorations**

Replace `apps/sandbox/src/blocks.ts`:

```ts
import { defineBlock, defineDecoration } from '@elovox/engine'

export const BLOCKS = [
  defineBlock({ name: 'stone', textures: 'stone' }),
  defineBlock({ name: 'dirt', textures: 'dirt' }),
  defineBlock({ name: 'grass', textures: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' }, decoration: 'meadow' }),
  defineBlock({ name: 'sand', textures: 'sand', falls: true }),
  defineBlock({ name: 'log', textures: { top: 'log_top', side: 'log_side', bottom: 'log_top' } }),
  defineBlock({ name: 'planks', textures: 'planks' }),
  defineBlock({ name: 'leaves', textures: 'leaves', layer: 'cutout' }),
  defineBlock({ name: 'glass', textures: 'glass', layer: 'translucent' }),
  defineBlock({ name: 'water', textures: 'water', liquid: true, solid: false }),
  defineBlock({ name: 'torch', textures: 'torch', layer: 'cutout', emits: 14, solid: false }),
  defineBlock({ name: 'rock', textures: 'rock' }),
  // terrain toolkit (sub-project 2b)
  defineBlock({ name: 'snow', textures: 'snow' }),
  defineBlock({ name: 'gravel', textures: 'gravel', falls: true }),
  defineBlock({ name: 'sandstone', textures: 'sandstone' }),
  defineBlock({ name: 'sandstone_red', textures: 'sandstone_red' }),
  defineBlock({ name: 'pine_leaves', textures: 'pine_leaves', layer: 'cutout' }),
  // simulation (sub-project 3a)
  defineBlock({ name: 'spring', textures: 'water', liquid: true, source: 'water', solid: false }),
  defineBlock({ name: 'mud', textures: 'mud' }),
  defineBlock({ name: 'wet_sand', textures: 'wet_sand' }),
]

export const DECORATIONS = [
  defineDecoration({
    name: 'meadow',
    grass: { blades: 20, height: [0.25, 0.55], base: '#4f8a2e', tip: '#a9d65a', overhang: 0.32 },
    flowers: { chance: 0.06, patchScale: 12, colors: ['#e94b4b', '#f5d142', '#ffffff', '#f08ac0', '#6f8cf0'] },
    // Grass youth (state bits 0–1): new grass is bare and fills in as it matures.
    stateDensity: [1, 2 / 3, 1 / 3, 0],
  }),
]
```

If Task 14 already added the spring line, keep a single definition.

- [ ] **Step 4: Rules**

Replace `apps/sandbox/src/rules.ts`:

```ts
import { defineRules, type RuleContext } from '@elovox/engine/sim-worker'

/** Grass youth lives in state bits 0–1: 0 is mature; grass that just spread starts at YOUNG. */
const YOUNG = 3
/** Light a grass cell needs above it to spread there. */
const MIN_SKY = 9
const SIDES: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]]
/** Every offset within Manhattan distance 2. */
const NEAR: readonly (readonly [number, number, number])[] = (() => {
  const out: [number, number, number][] = []
  for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    const d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz)
    if (d >= 1 && d <= 2) out.push([dx, dy, dz])
  }
  return out
})()

/** True if water (or a spring) is within Manhattan distance 2. */
export function nearWater(ctx: RuleContext, x: number, y: number, z: number): boolean {
  for (const [dx, dy, dz] of NEAR) if (ctx.isLiquid(ctx.get(x + dx, y + dy, z + dz))) return true
  return false
}

/** One block turns into another when water is near (or gone). */
function wetting(wet: string, dry: string) {
  return {
    [dry]: { onRandomTick(ctx: RuleContext, x: number, y: number, z: number) { if (nearWater(ctx, x, y, z)) ctx.set(x, y, z, ctx.id(wet)) } },
    [wet]: { onRandomTick(ctx: RuleContext, x: number, y: number, z: number) { if (!nearWater(ctx, x, y, z)) ctx.set(x, y, z, ctx.id(dry)) } },
  }
}

export default defineRules({
  blocks: {
    grass: {
      // Dies under an opaque block or water; otherwise matures one step and tries to spread to lit dirt nearby.
      onRandomTick(ctx, x, y, z, v) {
        const above = ctx.get(x, y + 1, z)
        if (ctx.isOpaque(above) || ctx.isLiquid(above)) { ctx.set(x, y, z, ctx.id('dirt')); return }
        const youth = ctx.state(v) & 3
        if (youth > 0) ctx.set(x, y, z, ctx.withState(v, youth - 1))
        const [dx, dz] = SIDES[Math.floor(ctx.random() * 4)]!
        const nx = x + dx, nz = z + dz, ny = y + Math.floor(ctx.random() * 3) - 1
        if (ny < 0 || ctx.get(nx, ny, nz) !== ctx.id('dirt')) return
        const top = ctx.get(nx, ny + 1, nz)
        if (ctx.isOpaque(top) || ctx.isLiquid(top) || ctx.skyLight(nx, ny + 1, nz) < MIN_SKY) return
        ctx.set(nx, ny, nz, ctx.withState(ctx.id('grass'), YOUNG))
      },
    },
    ...wetting('mud', 'dirt'),
    ...wetting('wet_sand', 'sand'),
  },
})
```

The demo `sand` rule is gone, because gravity replaces it.

In the "spreads" test, the random numbers are `0` (side +x) and `0.5`. `floor(0.5 · 3) − 1 = 0`, so the target sits at the same y.

- [ ] **Step 5: Painted tiles**

Append to `apps/sandbox/src/paint/materials.ts`, before `export const TILES`:

```ts
/** Dirt, darker and wetter, with glossy puddle spots. */
export function mud(r: Rand): Layer {
  const l = dirt(r)
  for (let i = 0; i < l.height.length; i++) {
    l.color[i * 3]! *= 0.62; l.color[i * 3 + 1]! *= 0.56; l.color[i * 3 + 2]! *= 0.52
    l.height[i]! *= 0.7
  }
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (tileFbm(61, x, y, 8, 3) > 0.62) paint(l, wrap(x, y), hex('#3a2a20'), 0.2)
  }
  return l
}

/** Sand, darker and a touch more saturated. */
export function wetSand(r: Rand): Layer {
  const l = sand(r)
  for (let i = 0; i < l.height.length; i++) {
    l.color[i * 3]! *= 0.74; l.color[i * 3 + 1]! *= 0.68; l.color[i * 3 + 2]! *= 0.58
  }
  return l
}
```

Append these entries to the **end** of `TILES`. That keeps every existing tile's seed, because seeds come from the index:

```ts
  ['mud', mud, {}],
  ['wet_sand', wetSand, {}],
```

In `apps/sandbox/src/paint/index.ts`, add `'mud', 'wet_sand'` to both `SEAMLESS_X` and `SEAMLESS_Y`. Both tiles are built from seamless tiles, and their extra passes use wrapped noise.

- [ ] **Step 6: Engine options, hotbar and HUD**

In `apps/sandbox/src/main.ts`:

1. Import `packVoxel`: `import { AIR, createEngine, packVoxel } from '@elovox/engine'`.
2. Change the hotbar so water replaces rock:

```ts
const HOTBAR = ['stone', 'dirt', 'grass', 'sand', 'planks', 'log', 'leaves', 'water', 'torch', 'glass']
```

3. Add to the `createEngine` options:

```ts
  sim: { randomTicksPerChunk: 24, debugFluids: params.has('debugFluids') },
```

4. Place liquids full. In the right-click branch, replace `engine.submit({ type: 'setBlock', pos: p, voxel: engine.blocks.id(HOTBAR[selected]!) })` with:

```ts
    const id = engine.blocks.id(HOTBAR[selected]!)
    engine.submit({ type: 'setBlock', pos: p, voxel: engine.blocks.liquid[id] ? packVoxel(id, 7) : id })
```

In `apps/sandbox/src/hud.ts`, add a line after the decorations line:

```ts
      `physics  fluid cells ${s.fluidActive}   pools ${s.fluidPools}   jobs ${s.regionJobs}   falling ${s.fallingBodies}`,
```

- [ ] **Step 7: Run the sandbox tests and every suite**

Run: `npm test --workspaces --if-present && npm run typecheck`

Expected: all PASS, including `rules.test.ts` (5 tests), `painter.test.ts` (with the two new seamless tiles) and `terrainDocs.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add apps/sandbox/src apps/sandbox/test
git commit -m "feat(sandbox): falling sand and gravel, springs, mud and wet sand, growing grass; water in the hotbar; physics HUD line"
```

---

### Task 16: The editor pauses physics, with a toggle

**Files:**
- Modify: `packages/terrain-editor/src/ui/panels/toolbar.ts`, `packages/terrain-editor/src/ui/editor.ts`

**Interfaces:**
- Consumes: `engine.physics` (Task 2).
- Produces:
  - `ToolbarState.physics: boolean` and `ToolbarActions.physics(on: boolean)`, plus a checkbox `#editor-physics` labelled "simulate physics".
  - The editor pauses physics when created and restores the previous state on `dispose()`.

- [ ] **Step 1: Toolbar**

In `packages/terrain-editor/src/ui/panels/toolbar.ts`:

1. Extend the types:

```ts
export interface ToolbarState { fileName: string; dirty: boolean; canUndo: boolean; canRedo: boolean; status: PreviewStatus; showAll: boolean; showLayers: boolean; physics: boolean }
export interface ToolbarActions { open(): void; save(): void; saveAs(): void; undo(): void; redo(): void; showAll(on: boolean): void; showLayers(on: boolean): void; physics(on: boolean): void }
```

2. After the `layers` checkbox, add:

```ts
  const physics = h('input', { type: 'checkbox', id: 'editor-physics' })
  physics.addEventListener('change', () => actions.physics(physics.checked))
```

3. Append `h('label', { title: 'Run falling blocks and water while editing (regeneration rescans the water)' }, physics, ' simulate physics')` after the "show layers" label.

4. In `render`, add `physics.checked = s.physics`.

- [ ] **Step 2: Editor**

In `packages/terrain-editor/src/ui/editor.ts`:

1. Right after `const session = new EditorSession(…)`:

```ts
  // Editing regenerates terrain under the water; physics waits (spec §4 Editor) unless the toggle runs it.
  const physicsWasPaused = engine.physics.paused
  engine.physics.setPaused(true)
  let physics = false
```

2. Add the action to `createToolbar(left, {…})`:

```ts
    physics: (on) => { physics = on; engine.physics.setPaused(!on); renderToolbar() },
```

3. Pass it in `renderToolbar`: add `physics` to the object given to `toolbar.render(...)`.

4. In `dispose()`, at the end: `engine.physics.setPaused(physicsWasPaused)`.

- [ ] **Step 3: Typecheck and run the editor suite**

Run: `cd packages/terrain-editor && npx vitest run && npx tsc --noEmit -p .`

Expected: PASS, typecheck 0. The toolbar and editor are DOM code, covered by the e2e in Task 17.

- [ ] **Step 4: Commit**

```bash
git add packages/terrain-editor/src/ui
git commit -m "feat(terrain-editor): pause physics while editing, with a 'simulate physics' toggle"
```

---

### Task 17: The flood scene, its e2e and its bench

**Files:**
- Create: `apps/sandbox/src/scenes/flood.ts`, `apps/sandbox/src/flood.worker.ts`, `apps/sandbox/test/flood.test.ts`, `apps/sandbox/e2e/flood.spec.ts`, `apps/sandbox/e2e/flood-bench.spec.ts`
- Modify: `apps/sandbox/src/main.ts`

**Interfaces:**
- Consumes: everything above. Engine APIs: `engine.submit`, `engine.world.get`, the `engine.stats()` physics fields, and `GeneratorConfig.seaLevel`.
- Produces:
  - `FLOOD_SIZE = [256, 64, 256]`, `SEA_LEVEL = 12`, `GROUND = 25`.
  - Layout constants: `LAKE`, `DAM_X = 125`, `BREACH`, `VALLEY`, `SEA`, `RIVER`, `SPRING`, `PILLARS`.
  - Functions: `groundAt(x, z)`, `floodColumn(x, z)`, `floodGenerator`, `breachCommands()`, `dropCommands()`.
  - URL `?scene=flood`, and `window.__elovox.flood = { breach(), drop() }` (null in other scenes).

- [ ] **Step 1: Write the failing scene tests**

Create `apps/sandbox/test/flood.test.ts`:

```ts
import { Simulation } from '@elovox/engine/src/sim/simulation.ts'
import { createWorldBuffers } from '@elovox/engine/src/world/buffers.ts'
import { describe, expect, it } from 'vitest'
import { BLOCKS } from '../src/blocks.ts'
import rules from '../src/rules.ts'
import { BREACH, DAM_X, FLOOD_SIZE, LAKE, PILLARS, SEA_LEVEL, SPRING, VALLEY, breachCommands, dropCommands, floodColumn, floodGenerator } from '../src/scenes/flood.ts'

describe('flood scene layout', () => {
  it('holds a lake behind a one-block dam above a dry valley', () => {
    const lake = floodColumn(60, 60)
    expect(lake.slice(LAKE.floor, LAKE.top + 1).every((b) => b === 'water')).toBe(true)
    expect(lake[LAKE.floor - 1]).toBe('dirt')
    expect(lake[LAKE.top + 1]).toBeNull()
    expect(floodColumn(DAM_X, 75)[LAKE.top]).not.toBeNull()
    const valley = floodColumn(DAM_X + 1, 75)
    expect(valley[VALLEY.ground - 1]).toBe('grass')
    expect(valley[VALLEY.ground]).toBeNull()
  })
  it('has a spring on the river bed, a sea below the sea level and sand on planks in the air', () => {
    const head = floodColumn(SPRING.x, SPRING.z)
    const y = head.indexOf('spring')
    expect(y).toBeGreaterThan(0)
    expect(head[y - 1]).not.toBeNull()
    expect(floodColumn(50, 230)[SEA_LEVEL - 1]).toBe('water')
    expect(floodColumn(50, 230)[SEA_LEVEL]).toBeNull()
    const p = PILLARS[0]
    const col = floodColumn(p.x, p.z)
    expect(col[p.base]).toBe('planks')
    expect(col[p.base - 1]).toBeNull()
    expect(col.slice(p.base + 1, p.base + 1 + p.height).every((b) => b === 'sand')).toBe(true)
  })
  it('breaches the dam down to the lake floor and drops the pillars by removing their planks', () => {
    expect(breachCommands()).toEqual([{ type: 'fillRegion', min: [DAM_X, LAKE.floor, BREACH.z0], max: [DAM_X, LAKE.top, BREACH.z1], voxel: 0 }])
    expect(dropCommands()).toEqual(PILLARS.map((q) => ({ type: 'setBlock', pos: [q.x, q.base, q.z], voxel: 0 })))
  })
})

describe('flood scene simulation', () => {
  it('makes the lake and the sea pools, and a breach pours the lake into the valley', () => {
    const sim = new Simulation({ buffers: createWorldBuffers([...FLOOD_SIZE]), blocks: BLOCKS, rules, seed: 1, log: () => {}, fluids: { fluidEvery: 1 } })
    sim.configure(floodGenerator, {})
    sim.generate(floodGenerator)
    const lake = sim.fluids.poolAt(60, LAKE.floor, 60)!
    expect(lake).toMatchObject({ surfaceY: LAKE.top, area: 100 * 100 })
    expect(sim.fluids.cycle).toMatchObject({ surfaceY: SEA_LEVEL - 1 })
    breachCommands().forEach((c, i) => sim.submit(0, i, c))
    for (let t = 0; t < 80; t++) sim.step()
    const water = sim.registry.id('water')
    let valley = 0
    for (let x = VALLEY.x0; x < VALLEY.x0 + 24; x++) for (let z = BREACH.z0 - 12; z <= BREACH.z1 + 12; z++) {
      for (let y = VALLEY.ground; y < VALLEY.ground + 3; y++) if ((sim.store.getVoxel(x, y, z) & 0xfff) === water) valley++
    }
    expect(valley).toBeGreaterThan(0)
    expect((lake.level - 7) * lake.area + lake.balance).toBeLessThan(0) // the lake gave water
  }, 180_000)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/sandbox && npx vitest run test/flood.test.ts`

Expected: FAIL with "Failed to resolve import ../src/scenes/flood.ts".

- [ ] **Step 3: Implement the scene**

Create `apps/sandbox/src/scenes/flood.ts`:

```ts
import type { Command } from '@elovox/engine'
import { defineGenerator } from '@elovox/engine/sim-worker'
import { AIR, packVoxel } from '@elovox/engine/src/world/voxel.ts'

/** A test bed for 3a: a dammed lake above a dry valley, a spring-fed river into a small sea, sand on planks in the air. */
export const FLOOD_SIZE = [256, 64, 256] as const
/** Water fills y < SEA_LEVEL in the sea and the river mouth; the sea's pool (surface y = 11) is the cycle pool. */
export const SEA_LEVEL = 12
/** Default solid layers: a column with ground g is solid for y < g. */
export const GROUND = 25
/** 100 × 100 lake: bed solid below `floor`, water from `floor` to `top`. */
export const LAKE = { x0: 25, x1: 124, z0: 25, z1: 124, floor: 21, top: 24 } as const
/** The one-block dam on the lake's east side; the valley floor is far below it. */
export const DAM_X = 125
export const BREACH = { z0: 70, z1: 79 } as const
export const VALLEY = { x0: 126, x1: 250, z0: 10, z1: 245, ground: 9 } as const
export const SEA = { x1: 120, z0: 200, ground: 5 } as const
/** A channel that steps down one block every 4 from `head` toward the sea. */
export const RIVER = { x0: 8, x1: 12, z0: 136, z1: 199, head: 23 } as const
export const SPRING = { x: 10, z: 136, flow: 8 } as const
export const PILLARS = [{ x: 60, z: 160, base: 40, height: 8 }, { x: 70, z: 70, base: 40, height: 4 }] as const

export type FloodBlock = 'stone' | 'dirt' | 'grass' | 'sand' | 'water' | 'spring' | 'planks'

const inLake = (x: number, z: number) => x >= LAKE.x0 && x <= LAKE.x1 && z >= LAKE.z0 && z <= LAKE.z1
const inValley = (x: number, z: number) => x >= VALLEY.x0 && x <= VALLEY.x1 && z >= VALLEY.z0 && z <= VALLEY.z1
const inRiver = (x: number, z: number) => x >= RIVER.x0 && x <= RIVER.x1 && z >= RIVER.z0 && z <= RIVER.z1
const inSea = (x: number, z: number) => x <= SEA.x1 && z >= SEA.z0

/** Solid layers under (x, z). */
export function groundAt(x: number, z: number): number {
  if (inLake(x, z)) return LAKE.floor
  if (inValley(x, z)) return VALLEY.ground
  if (inRiver(x, z)) return RIVER.head - Math.floor((z - RIVER.z0) / 4)
  if (inSea(x, z)) return SEA.ground
  return GROUND
}

/** The scene's blocks for one column, bottom to top (index = y). Pure. */
export function floodColumn(x: number, z: number): (FloodBlock | null)[] {
  const col = new Array<FloodBlock | null>(FLOOD_SIZE[1]).fill(null)
  const g = groundAt(x, z)
  const top: FloodBlock = inLake(x, z) ? 'dirt' : inSea(x, z) || inRiver(x, z) ? 'sand' : 'grass'
  for (let y = 0; y < g; y++) col[y] = y === g - 1 ? top : y >= g - 4 ? 'dirt' : 'stone'
  if (inLake(x, z)) for (let y = g; y <= LAKE.top; y++) col[y] = 'water'
  else if (x <= SEA.x1 && g < SEA_LEVEL) for (let y = g; y < SEA_LEVEL; y++) col[y] = 'water'
  if (x === SPRING.x && z === SPRING.z) col[g] = 'spring'
  for (const p of PILLARS) {
    if (x !== p.x || z !== p.z) continue
    col[p.base] = 'planks'
    for (let y = p.base + 1; y <= p.base + p.height; y++) col[y] = 'sand'
  }
  return col
}

export const floodGenerator = defineGenerator({
  configure: () => ({ seaLevel: SEA_LEVEL }),
  generateColumn(ctx, cx, cz) {
    const ids: Record<FloodBlock, number> = {
      stone: ctx.id('stone'), dirt: ctx.id('dirt'), grass: ctx.id('grass'), sand: ctx.id('sand'),
      water: packVoxel(ctx.id('water'), 7), spring: packVoxel(ctx.id('spring'), SPRING.flow), planks: ctx.id('planks'),
    }
    for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
      const col = floodColumn(cx * 32 + lx, cz * 32 + lz)
      for (let y = 0; y < col.length; y++) {
        const b = col[y]
        if (b) ctx.set(lx, y, lz, ids[b])
      }
    }
  },
})

/** Opens the dam over BREACH, down to the lake floor. */
export function breachCommands(): Command[] {
  return [{ type: 'fillRegion', min: [DAM_X, LAKE.floor, BREACH.z0], max: [DAM_X, LAKE.top, BREACH.z1], voxel: AIR }]
}

/** Removes the planks under each sand pillar, so the pillars fall (one into the lake). */
export function dropCommands(): Command[] {
  return PILLARS.map((p) => ({ type: 'setBlock', pos: [p.x, p.base, p.z], voxel: AIR }))
}
```

Create `apps/sandbox/src/flood.worker.ts`:

```ts
import { runSimWorker } from '@elovox/engine/sim-worker'
import rules from './rules.ts'
import { floodGenerator } from './scenes/flood.ts'

runSimWorker({ rules, generator: floodGenerator })
```

- [ ] **Step 4: Wire the scene into `main.ts`**

In `apps/sandbox/src/main.ts`:

1. Import: `import { FLOOD_SIZE, breachCommands, dropCommands } from './scenes/flood.ts'`.
2. Scene name: `const sceneName = sceneParam === 'diorama' || sceneParam === 'terrain' || sceneParam === 'flood' ? sceneParam : 'world'`.
3. Size: put the flood case first in the `size` expression: `sceneName === 'flood' ? [...FLOOD_SIZE] : sceneName === 'diorama' ? … `.
4. `simWorker`: add a branch before the terrain one:

```ts
    : sceneName === 'flood'
      ? () => new Worker(new URL('./flood.worker.ts', import.meta.url), { type: 'module' })
```

5. `terrain`: `terrain: sceneName === 'flood' ? { scene: 'flood' } : terrainDoc,`. Any document makes the sim call the generator's `configure`, which reports the sea level.
6. Camera, after the terrain-scene camera block:

```ts
if (sceneName === 'flood') {
  for (const s of [engine.controls.goal, engine.controls.current]) {
    s.target[0] = 128; s.target[1] = 20; s.target[2] = 128
    s.distance = 320
    s.pitch = 0.8
  }
}
```

7. The window hook:

```ts
const flood = sceneName === 'flood'
  ? { breach: () => breachCommands().forEach((c) => engine.submit(c)), drop: () => dropCommands().forEach((c) => engine.submit(c)) }
  : null
Object.assign(window, { __elovox: { engine, bean, editor, flood, ready: true } })
```

   This replaces the existing `Object.assign` line.

- [ ] **Step 5: Run the scene tests**

Run: `cd apps/sandbox && npx vitest run test/flood.test.ts && npx tsc --noEmit -p .`

Expected: PASS (4 tests), typecheck 0.

- [ ] **Step 6: Write the e2e**

Create `apps/sandbox/e2e/flood.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test'
import type { Engine } from '@elovox/engine'

type W = Window & { __elovox?: { engine: Engine; flood: { breach(): void; drop(): void } | null; ready: boolean } }

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

/**
 * Distinct (top y : level) pairs over the lake's interior, every 3rd column (the pillar column skipped).
 * The sim worker may be mid-tick while the main thread reads, so a mixed read is retried before it counts.
 */
async function lakeSurfaces(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const e = (window as W).__elovox!.engine
    const water = e.blocks.id('water')
    let last: string[] = []
    for (let attempt = 0; attempt < 20; attempt++) {
      const seen = new Set<string>()
      for (let x = 25; x <= 124; x += 3) for (let z = 25; z <= 124; z += 3) {
        if (Math.abs(x - 70) <= 1 && Math.abs(z - 70) <= 1) continue
        for (let y = 30; y >= 20; y--) {
          const v = e.world.get(x, y, z)
          if ((v & 0xfff) === water) { seen.add(`${y}:${(v >>> 12) & 7}`); break }
        }
      }
      last = [...seen]
      if (last.length <= 1) return last
      await new Promise((r) => setTimeout(r, 30))
    }
    return last
  })
}

test('a breached lake drains flat into the valley, and sand pillars fall', async ({ page }) => {
  test.setTimeout(420_000)
  const errors = watchErrors(page)
  await page.goto('/?scene=flood')
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 120_000 })
  expect(await lakeSurfaces(page)).toEqual(['24:7'])

  await page.evaluate(() => (window as W).__elovox!.flood!.breach())
  // the lake's surface goes down: one whole level takes ~10 000 units through the breach
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine
    const water = e.blocks.id('water')
    for (let y = 30; y >= 20; y--) {
      const v = e.world.get(60, y, 60)
      if ((v & 0xfff) === water) return y * 8 + ((v >>> 12) & 7) < 24 * 8 + 7
    }
    return true
  }, null, { timeout: 300_000, polling: 1000 })
  const surfaces = await lakeSurfaces(page)
  expect(surfaces).toHaveLength(1) // flat
  expect(surfaces[0]).not.toBe('24:7') // and lower

  const valley = await page.evaluate(() => {
    const e = (window as W).__elovox!.engine
    const water = e.blocks.id('water')
    let n = 0
    for (let x = 126; x < 160; x++) for (let z = 50; z < 100; z++) for (let y = 9; y < 14; y++) if ((e.world.get(x, y, z) & 0xfff) === water) n++
    return n
  })
  expect(valley).toBeGreaterThan(0)

  await page.evaluate(() => (window as W).__elovox!.flood!.drop())
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine
    return e.world.get(60, 25, 160) === e.blocks.id('sand') && e.world.get(60, 40, 160) === 0
  }, null, { timeout: 60_000, polling: 250 })
  expect(errors).toEqual([])
})
```

- [ ] **Step 7: Write the bench**

Create `apps/sandbox/e2e/flood-bench.spec.ts`:

```ts
import { expect, test } from '@playwright/test'
import type { Engine } from '@elovox/engine'

type W = Window & { __elovox?: { engine: Engine; flood: { breach(): void; drop(): void } | null; ready: boolean } }

test.skip(!process.env.BENCH, 'set BENCH=1 to run the dam-break benchmark')

test('dam break: sim tick p95, fps, time to settle', async ({ page }) => {
  test.setTimeout(1_200_000)
  await page.goto('/?scene=flood')
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 180_000 })
  const r = await page.evaluate(async () => {
    const e = (window as W).__elovox!.engine
    const ticks: number[] = [], fps: number[] = []
    let peak = 0, quiet = 0
    const t0 = performance.now()
    e.on('tick', (t) => ticks.push(t.tickMs))
    ;(window as W).__elovox!.flood!.breach()
    while (performance.now() - t0 < 900_000) {
      await new Promise((res) => setTimeout(res, 500))
      const s = e.stats()
      fps.push(s.fps)
      peak = Math.max(peak, s.fluidActive)
      quiet = s.fluidActive === 0 && s.regionJobs === 0 ? quiet + 1 : 0
      if (quiet >= 3) break
    }
    const sorted = [...ticks].sort((a, b) => a - b)
    const fs = [...fps].sort((a, b) => a - b)
    return {
      settled: quiet >= 3, settleS: (performance.now() - t0) / 1000, ticks: ticks.length,
      tickP95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, tickMax: sorted[sorted.length - 1] ?? 0,
      fpsMin: fs[0] ?? 0, fpsMedian: fs[Math.floor(fs.length / 2)] ?? 0, peakActive: peak,
    }
  })
  console.log(`[flood-bench] ${JSON.stringify(r)}`)
  expect(r.settled).toBe(true)
})
```

Headless Chromium renders with software GL here, so its fps is meaningless. The user runs the bench on the laptop for the real numbers (Task 18).

- [ ] **Step 8: Run the e2e**

Start a fresh dev server first. An old Vite on :5173 has served stale code before.

Run: `cd apps/sandbox && E2E_PORT=5174 npx playwright test --workers=1`

Expected: every e2e test PASSES (smoke, brush bench skipped, flood). The bench is skipped without `BENCH=1`.

- [ ] **Step 9: Commit**

```bash
git add apps/sandbox/src/scenes/flood.ts apps/sandbox/src/flood.worker.ts apps/sandbox/src/main.ts apps/sandbox/test/flood.test.ts apps/sandbox/e2e/flood.spec.ts apps/sandbox/e2e/flood-bench.spec.ts
git commit -m "feat(sandbox): ?scene=flood with a breachable lake, a spring-fed river and sand pillars; e2e and dam-break bench"
```

---

### Task 18: Checkpoints with the user

This task is interactive. The controller drives it with the user, who runs the app on the laptop and decides the tuning. Record every result and change in the "Checkpoint results" section at the end of this plan.

**Setup:** `cd apps/sandbox && npx vite --port 5174`, then open `http://localhost:5174/?scene=flood`. The HUD's `physics` line shows the moving cells, pools, jobs and falling bodies.

- [ ] **Checkpoint 1: Dam break.**
  - Run `__elovox.flood.breach()` in the console.
  - The user judges the flow speed, the lake going down (flat, in steps of 1/8 block), the cascade at the breach and the valley filling.
  - Tuning knobs:
    - `outletRate` and `fluidEvery`: engine options. Expose `sim.fluids` through `SimInitOptions` if they need changing.
    - `FLOW_SPEED` in `water.ts`.
    - The `streak` speed for falling sides.
- [ ] **Checkpoint 2: River and spring.**
  - Watch the channel at x ≈ 10, z 136–200 until it reaches a steady state.
  - The user judges the stream, the flow direction on its surface, and the mouth into the sea.
  - Also open `?scene=terrain` (the showcase): its rivers drain at load (planning deviation 9). The user decides whether that is acceptable or whether rivers need more flow (the river op's `flow`).
- [ ] **Checkpoint 3: Falling sand.**
  - Run `__elovox.flood.drop()`.
  - One pillar falls onto grass, one into the lake. Check the motion is smooth, the hand-over to the chunk mesh has no blink, and the lake absorbs the displaced water.
  - Also place sand with the hotbar over a hole.
- [ ] **Checkpoint 4: Drain cycle.**
  - After the lake drains, watch the lake bed and the shores for a few minutes: mud near the water and drying away from it, wet sand, grass spreading back bare and growing tufts.
  - Tuning knobs: `randomTicksPerChunk`, `MIN_SKY`, the `stateDensity` values, and the `mud` / `wet_sand` colours.
- [ ] **Checkpoint 5: Laptop measurements against spec §2.**
  - **Dam break:** `BENCH=1 E2E_PORT=5174 npx playwright test e2e/flood-bench.spec.ts --workers=1 --headed`, or the HUD while breaching by hand. Targets: tick p95 ≤ 10 ms, fps ≥ 45 during the dam break, settled afterwards (`fluid cells 0`, `jobs 0`).
  - **Random ticks:** `?scene=terrain`, idle, tick ms with nothing else going on. Target ≤ 2 ms.
  - If the dam break misses its budget, measure first:
    - mesh queue length during the break;
    - share of the tick spent in the fluid step.
  - Then apply the spec's planned fix: a liquid-only mesh job. Record the decision.
- [ ] **Also check** `?scene=diorama` and `?scene=world` for regressions: lakes stay put, no sand falls on its own, no console errors.
- [ ] **Record and commit.** Fill in "Checkpoint results" below, then commit: `git commit -am "docs(plan): simulation 3a checkpoint results"`.

---

## Checkpoint results

*(Filled in during Task 18.)*
