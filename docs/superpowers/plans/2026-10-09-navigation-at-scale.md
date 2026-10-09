# Navigation at Scale (5b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1,000 worker units on a 1024 × 128 × 1024 world move, work and cross bottlenecks inside the tick budget,
through a portal hierarchy, space-time reservations, a fair task frontier and smooth pose playback.

**Architecture:** Navigation gains a geometry-only region layer: each 16³ tile is built once into poses, exits and a
reverse distance field per exit. Routes are found over exits and refined by descending those fields under the live
policy. Units reserve (cell, tick) pairs over a 32-tick window and repair conflicts with a small space-time search.
The frontier shares its slots by aged priority. The view plays poses back on sim time and holds only the units an
edit affects.

**Tech Stack:** TypeScript (strip-types), vitest 4, Node 24 benches, Playwright e2e (Edge), three.js r186 in the
sandbox view.

**Spec:** `docs/superpowers/specs/2026-10-09-navigation-at-scale-design.md` (read it first; this plan argues from it).

## Global Constraints

- Everything in `packages/engine/src/sim` runs in the sim worker and is deterministic. No wall clock, no
  `Math.random`, no iteration over unordered state that is not insertion-ordered or sorted.
- All new state that decides future behaviour is mixed into `Simulation.hash()` with length prefixes. Sets are sorted
  before mixing. Derived caches (region records) are not hashed, but must be a pure function of terrain and command
  history.
- Work is budgeted in operations (`searchCap`), never in milliseconds. `visited` per tick ≤ the cap passed to
  `NavigationSystem.step`.
- `limited` never becomes `unreachable`. A cut by budget, node limit, memory cap or confinement is `limited`.
- The abstract layer reads geometry only (`stand`, `neighbor`). Water, hazards, build reservations and units are
  checked live during refinement and execution, as today.
- Defaults with workers disabled, and every existing test (unit, e2e, replay hashes), stay green. Where a test pins
  old behaviour the spec changes (id-biased yield, 12 provisional work poses, the 1 s barrier), the task updates it and
  says why in the commit.
- Repo artifacts in English. Commits: conventional style (`feat(nav): …`), **no `Co-Authored-By` trailer** (user rule;
  project settings set no attribution). Never commit `.env` or secrets. Never push or merge to `main`.
- Tests: `npm test -w @elovox/engine -- <file>`; sandbox `npm test -w @elovox/sandbox -- <file>`; typecheck
  `npm run typecheck`. E2E: `E2E_PORT=<free port> E2E_CHANNEL=msedge npm run e2e -- --workers=1 <spec>`.
- Benches only in a quiet window granted by the expert: no games, ≥ 8 GB free, worse of two runs, interleaved A/B.

## Review Focus

1. **Edits during a route** — a wall placed across a refined segment, or a tunnel dug that opens a shortcut, while
   units walk: units must stop safely, replan, and never walk through the new solid. *Pinned in Task H6 (wall across a
   segment) and Task C5 (churn scenario).*
2. **Units starting inside a build designation, or on unsafe ground** — these use the flat escape search; the
   hierarchy must not take them. *Pinned in Task H6 ("escape stays flat").*
3. **A destination that is reachable only by a one-way drop** — the abstract graph is directed; a route back up must
   be `unreachable`, never `found`. *Pinned in Task H3 (one-way drop test) and the H7 fuzz.*
4. **Pause and resume mid-repair** — reservations are tick-indexed; after a pause the window must restart from the
   current tick without stale entries blocking everyone. *Pinned in Task C2 ("pause keeps no stale window").*
5. **Despawn or incapacitation of a reservation owner** — its timed and held cells must free at once, or a corridor
   stays blocked forever. *Pinned in Task C1 (`releaseOwner`) and Task C4 (despawn mid-corridor).*

## Planning deviations from the spec (for the expert and the user)

1. **Intra-region links are reverse distance fields per exit** (spec §3 says forward Dijkstra per entering portal).
   One reverse field per exit gives the cost from *every* pose of the region to that exit, so starts, entries and
   refinement all read the same table. Refinement becomes a descent on the field (a few operations per step) with a
   confined A* fallback. Same exactness, shared by all units in a region.
2. **Group moves share one abstract field** (not in the spec). A `unitMove` with several ids computes one reverse
   abstract search from the destination's regions, and every unit descends it. Without it, 1,000 independent
   abstract searches cost ~1.5 M operations, about 30 ticks at the raised cap, which misses the 1 s first-action
   target.
3. **`searchCap` default rises from 4,096 to 32,768.** Operations are ~70–100 ns each, so 32k ≈ 3 ms, inside the 4 ms
   workers' share. Task 0 measures the real cost per operation and the expert sets the final value.

## File structure

| File | Responsibility |
|---|---|
| `packages/engine/src/sim/navigation/heap.ts` (new) | Lazy binary min-heap over integer ids with two keys, typed arrays |
| `packages/engine/src/sim/navigation/navigation.ts` | Existing flat A*; gains `edgeCost`, `tileOfPose`, `SearchOptions.region`, `NavQuery`, `route()`, `group()`, region store ownership |
| `packages/engine/src/sim/navigation/regions.ts` (new) | `RegionBuild` (sliceable: poses, forward and reverse edges, exits, exit fields) and `RegionStore` (cache with byte cap) |
| `packages/engine/src/sim/navigation/routeSearch.ts` (new) | `RouteSearch`: abstract A* over exits, goal fields, proof of unreachable, stale check, hash |
| `packages/engine/src/sim/navigation/groupField.ts` (new) | `GroupField`: reverse abstract Dijkstra from a destination for many units |
| `packages/engine/src/sim/navigation/refine.ts` (new) | Field descent under live policy, with confined A* fallback |
| `packages/engine/src/sim/workers/reservations.ts` (new) | `ReservationTable`: (cell, tick) → owner over a rolling window, plus untimed holds |
| `packages/engine/src/sim/workers/spaceTime.ts` (new) | `SpaceTimeSearch`: wait, step or back-off repair in a ±8 box |
| `packages/engine/src/sim/workers/frontier.ts` (new) | Pure functions: effective priority, fair shares, park choice |
| `packages/engine/src/sim/workers/workers.ts` | Integration of all of the above |
| `packages/engine/src/sim/workers/types.ts` | `WorkerTick.tick`, barrier records, new stats, `WorkOrderView.effectivePriority` |
| `packages/engine/src/engine.ts` | `preFrame` event, `meshFailed(ci)` |
| `apps/sandbox/src/poseTimeline.ts` (new) | Sim-time pose playback (pure, testable) |
| `apps/sandbox/src/workersView.ts` | Uses the timeline, `preFrame` and precise barriers |
| `apps/sandbox/src/scenes/crowd.ts` (new), `apps/sandbox/src/terrain/crowd.terrain.json` (new) | Crowd scene: 1024² terrain with pads, command lists |
| `apps/sandbox/bench/crowd.node.ts` (new) | Scale benchmark, path-quality bench |
| `docs/adr/0003-hierarchical-routes-and-reservations.md` (new), `docs/adr/0002-…` | Decision record; correction |

## Workstreams and merge order

Four agents, one worktree each, all branching from `feat/navigation-scale` after Task 0:

| Stream | Tasks | Worktree branch |
|---|---|---|
| hierarchy | H1–H7 | `feat/nav-hierarchy` |
| cooperation | C1–C5 | `feat/nav-cooperation` |
| frontier | F1–F4 | `feat/nav-frontier` |
| view | V1–V3 | `feat/nav-view` |

`workers.ts` is shared. To keep conflicts small, each stream puts its logic in its own new module and touches
`workers.ts` only at the named call sites. **Merge into `feat/navigation-scale` in the order view → frontier →
hierarchy → cooperation.** Cooperation rebases last and adapts its projection to segmented paths. X1–X3 run on the
integration branch after all four merge.

---

### Task 0: Baseline scale benchmark and crowd terrain

**Files:**
- Create: `apps/sandbox/src/terrain/crowd.terrain.json`
- Create: `apps/sandbox/src/scenes/crowd.ts`
- Create: `apps/sandbox/bench/crowd.node.ts`
- Test: `apps/sandbox/test/crowd.test.ts`

**Interfaces:**
- Produces: `CROWD_SIZE = [1024, 128, 1024] as const`; `PADS: Record<'west' | 'east' | 'north' | 'south' | 'centre', { min: Vec3; max: Vec3; y: number }>`
  (flattened plateaus, `y` = standing height); `spawnCrowd(count: number, pads: (keyof typeof PADS)[]): Command[]`
  (`unitSpawn` on a 2-block grid across the pads, tools `['pick']`, deterministic order);
  `massMove(ids: number[], to: keyof typeof PADS): Command` (one `unitMove`);
  `scatterMoves(ids: number[], seed: number): Command[]` (one `unitMove` per 25 ids to pads 200–800 blocks away);
  `bottleneckCommands(stone: number): Command[]` (walls with a 1-wide and a 2-wide gap between `west` and `east`);
  `workOrders(stone: number, planks: number): Command[]` (20 orders, two of them > 256 cells);
  `CROWD_WORKER_OPTIONS: WorkerOptions`.

- [ ] **Step 1: Write the terrain document.** Copy `showcase.terrain.json` into `crowd.terrain.json` and append five
  `flatten` ops (same op shape as the plateaus in `living.terrain.json`). Each pad is 64 × 64. Centres:
  west (160, 512), east (864, 512), north (512, 160), south (512, 864), centre (512, 512). Heights are 48, 52, 56, 50
  and 44. Export the boxes and heights from `crowd.ts` as `PADS`, matching the document.

- [ ] **Step 2: Write the failing test** `apps/sandbox/test/crowd.test.ts`:

```ts
import { expect, it } from 'vitest'
import { PADS, spawnCrowd, scatterMoves, workOrders, bottleneckCommands } from '../src/scenes/crowd.ts'
import doc from '../src/terrain/crowd.terrain.json'

it('pads in the document match the exported boxes and heights', () => {
  const flats = (doc.ops as { type: string }[]).filter(o => o.type === 'flatten')
  expect(flats).toHaveLength(5)
  for (const pad of Object.values(PADS)) expect(pad.max[0] - pad.min[0]).toBe(63)
})
it('spawns 1,000 distinct positions on the pads, deterministically', () => {
  const a = spawnCrowd(1000, ['west', 'north']), b = spawnCrowd(1000, ['west', 'north'])
  expect(a).toEqual(b)
  const keys = new Set(a.map(c => (c as { pos: number[] }).pos.join(',')))
  expect(keys.size).toBe(1000)
})
it('scatter moves go 200–800 blocks away, 25 ids per order', () => {
  const moves = scatterMoves([...Array(1000).keys()].map(i => i + 1), 7)
  expect(moves).toHaveLength(40)
  for (const m of moves) expect((m as { ids: number[] }).ids).toHaveLength(25)
})
it('work orders include two larger than the frontier', () => {
  const orders = workOrders(1, 2)
  expect(orders).toHaveLength(20)
  const cells = orders.map(o => { const { min, max } = o as { min: number[]; max: number[] }; return (max[0]! - min[0]! + 1) * (max[1]! - min[1]! + 1) * (max[2]! - min[2]! + 1) })
  expect(cells.filter(n => n > 256)).toHaveLength(2)
  expect(bottleneckCommands(1).length).toBeGreaterThan(0)
})
```

- [ ] **Step 3: Run it.** `npm test -w @elovox/sandbox -- crowd`. Expected: FAIL (module not found).

- [ ] **Step 4: Implement `crowd.ts`.** Use plain integer loops; for `scatterMoves`, use the engine's `rng.ts`
  (`import { Rng } from '@elovox/engine/src/sim/rng.ts'`; read its API first) seeded with `seed`. Pick, per group of
  25 ids, the pad whose centre is 200–800 blocks from the group's spawn pad, cycling through valid pads.
  `CROWD_WORKER_OPTIONS = { ...WORKER_OPTIONS, maxUnits: 1000, maxOrders: 128 }` (import `WORKER_OPTIONS` from
  `./workers.ts`).

- [ ] **Step 5: Run the test.** Expected: PASS.

- [ ] **Step 6: Write the bench** `apps/sandbox/bench/crowd.node.ts`. Follow `bench/living.node.ts`: same imports,
  `terrainGenerator` and `configure` + `generate`, a `submit`/`check` helper, the `q()` percentile. It runs these
  phases in order and prints one JSON object:

  1. `setup`: generate, spawn 1,000 on west + north, 120 idle ticks.
  2. `mass`: one `massMove` of all ids to `east`, 1,200 ticks.
  3. `scatter`: `scatterMoves`, 1,200 ticks.
  4. `bottleneck`: `bottleneckCommands`, then 500 ids west → east and 500 east → west, 1,200 ticks.
  5. `work`: `workOrders`, 1,200 ticks.
  6. `churn`: during `scatter` again, every 20 ticks a `fillRegion` 1 × 3 × 3 wall on an active unit's next path node
     (pick the lowest id walking).

  Per phase it records:
  - whole tick ms p50/p95/p99/max;
  - workers' share (time `sim.workers.afterPhysics` + `beforePhysics` by wrapping them with `performance.now()` in the
    bench only);
  - first-action latency (ticks from the order to the unit's first `walking` state) p50/p95;
  - arrived %, and ticks until all arrived;
  - `traffic` blocks;
  - `visited` max;
  - `navBytes` max.

  CLI flags: `--units=N` (default 1000), `--phase=name` (run setup + one phase), `--quality` (Task H7 adds it).
  Header comment: `// Run: node --experimental-strip-types apps/sandbox/bench/crowd.node.ts [--units=1000]`.

- [ ] **Step 7: Measure the operation cost.** Add a `--opcost` mode: a single long flat search on the generated world
  with `nav.step(4096)` repeated, printing ns per visited operation. Run it once now (not a gated bench). Record the
  number in the commit message; the expert uses it to set `searchCap` (deviation 3).

- [ ] **Step 8: Baseline run (quiet window from the expert).** Run `crowd.node.ts` twice and keep the worse values.
  Save the result as `docs/superpowers/research/2026-10-09-crowd-baseline.json`. Some phases are expected to fail
  (units not arriving); the bench records, it does not assert.

- [ ] **Step 9: Commit**

```bash
git add apps/sandbox/src/terrain/crowd.terrain.json apps/sandbox/src/scenes/crowd.ts apps/sandbox/bench/crowd.node.ts apps/sandbox/test/crowd.test.ts docs/superpowers/research/2026-10-09-crowd-baseline.json
git commit -m "test(5b): crowd terrain, scale benchmark and baseline"
```

---

## Stream H — hierarchy

### Task H1: Heap, edge cost and confined searches

**Files:**
- Create: `packages/engine/src/sim/navigation/heap.ts`
- Modify: `packages/engine/src/sim/navigation/navigation.ts` (export `edgeCost`, add `tileOfPose`, `SearchOptions.region`)
- Test: `packages/engine/test/heap.test.ts`, `packages/engine/test/navigation.test.ts`

**Interfaces:**
- Produces:
  - `class IdHeap { push(id: number, f: number, h: number): void; pop(): number; peekF(): number; get size(): number; clear(): void; mixState(mix): void }`.
    Order is by (f, h, id) ascending; ids are non-negative integers < 2^53.
  - `edgeCost(layout: Layout, from: number, to: number): number` = `4 + (ty > sy ? 2 : sy - ty)`.
  - `NavigationSystem.tileOfPose(p: number): number`.
  - `SearchOptions.region?: number`: expansions only into poses with `tileOfPose(p) === region`.

- [ ] **Step 1: Failing tests.** `heap.test.ts`:

```ts
import { expect, it } from 'vitest'
import { IdHeap } from '../src/sim/navigation/heap.ts'

it('pops by f, then h, then id, and grows past its initial size', () => {
  const h = new IdHeap()
  for (let i = 0; i < 1000; i++) h.push(999 - i, (i * 7919) % 101, i % 3)
  let last = [-1, -1, -1]
  while (h.size) {
    const f = h.peekF(), id = h.pop()
    expect(f).toBeGreaterThanOrEqual(last[0]!)
    last = [f, 0, id]
  }
})
it('mixes its contents in heap order', () => {
  const a = new IdHeap(), b = new IdHeap(); a.push(1, 5, 0); b.push(1, 6, 0)
  const sig = (h: IdHeap) => { const v: number[] = []; h.mixState(n => v.push(n)); return v }
  expect(sig(a)).not.toEqual(sig(b))
})
```

  In `navigation.test.ts`, add:

```ts
it('a region-confined search never leaves its tile and ends limited, not unreachable, when the goal needs a detour outside', () => {
  const { nav, layout, blocked } = fixture()
  // A wall inside tile 0 with its only gap outside the tile.
  for (let z = 0; z <= 16; z++) for (let y = 4; y < 8; y++) blocked.add(layout.voxelIndex(8, y, z))
  const start = layout.voxelIndex(4, 4, 4), goal = layout.voxelIndex(12, 4, 4), region = nav.tileOfPose(start)
  const s = nav.request(start, [goal], undefined, { region })
  while (s.status === 'pending') nav.step(128)
  expect(s.status).toBe('limited')
  const free = nav.request(start, [goal])
  while (free.status === 'pending') nav.step(128)
  expect(free.status).toBe('found')
})
```

- [ ] **Step 2: Run** `npm test -w @elovox/engine -- heap navigation`. Expected: FAIL.

- [ ] **Step 3: Implement `heap.ts`.**

```ts
/** Lazy binary min-heap of integer ids ordered by (f, h, id); duplicates allowed, callers skip stale pops. */
export class IdHeap {
  private ids = new Float64Array(64)
  private fs = new Float64Array(64)
  private hs = new Float64Array(64)
  private n = 0
  get size(): number { return this.n }
  clear(): void { this.n = 0 }
  peekF(): number { return this.n ? this.fs[0]! : Infinity }
  private less(a: number, b: number): boolean {
    const fa = this.fs[a]!, fb = this.fs[b]!
    if (fa !== fb) return fa < fb
    const ha = this.hs[a]!, hb = this.hs[b]!
    return ha !== hb ? ha < hb : this.ids[a]! < this.ids[b]!
  }
  private swap(a: number, b: number): void {
    for (const k of ['ids', 'fs', 'hs'] as const) { const t = this[k][a]!; this[k][a] = this[k][b]!; this[k][b] = t }
  }
  push(id: number, f: number, h: number): void {
    if (this.n === this.ids.length) for (const k of ['ids', 'fs', 'hs'] as const) { const a = new Float64Array(this.n * 2); a.set(this[k]); this[k] = a }
    let i = this.n++
    this.ids[i] = id; this.fs[i] = f; this.hs[i] = h
    while (i) { const p = (i - 1) >> 1; if (!this.less(i, p)) break; this.swap(i, p); i = p }
  }
  pop(): number {
    const id = this.ids[0]!
    if (--this.n) {
      this.ids[0] = this.ids[this.n]!; this.fs[0] = this.fs[this.n]!; this.hs[0] = this.hs[this.n]!
      let i = 0
      for (;;) {
        const l = i * 2 + 1, r = l + 1
        let m = i
        if (l < this.n && this.less(l, m)) m = l
        if (r < this.n && this.less(r, m)) m = r
        if (m === i) break
        this.swap(i, m); i = m
      }
    }
    return id
  }
  mixState(mix: (n: number) => void): void { mix(this.n); for (let i = 0; i < this.n; i++) { mix(this.ids[i]!); mix(this.fs[i]!); mix(this.hs[i]!) } }
}
```

- [ ] **Step 4: Navigation changes.**
  - Add `export const edgeCost = (L: Layout, from: number, to: number): number => { const sy = L.voxelCoords(from)[1], ty = L.voxelCoords(to)[1]; return 4 + (ty > sy ? 2 : sy - ty) }`.
    Replace the inline cost at `PathSearch.step` (`this.gs[this.expanding]! + 4 + (ty > sy ? 2 : sy - ty)`) with
    `this.gs[this.expanding]! + edgeCost(L, p, to)`.
  - Add `tileOfPose(p: number): number { const [x, y, z] = this.port.layout.voxelCoords(p); return this.tileOf(x, y, z) }`.
  - `SearchOptions.region?: number`. Store it in `PathSearch` (`private readonly region?: number`).
  - In the expansion branch, skip `to` when `this.region !== undefined && this.nav.tileOfPose(to) !== this.region`,
    and set a flag `this.cut = true`.
  - When the heap empties: `status = this.cut && !this.path.length ? 'limited' : …`. Concretely, in the
    `validate` final line use `this.path.length ? 'found' : this.cut ? 'limited' : 'unreachable'`.
  - Mix `region ?? -1` and `cut` in `mixState`.

- [ ] **Step 5: Run the tests.** Expected: PASS, including the existing `navigation.test.ts` cases (costs unchanged).

- [ ] **Step 6: Commit** `feat(nav): typed id heap, shared edge cost and region-confined searches`.

### Task H2: Region builds and the region store

**Files:**
- Create: `packages/engine/src/sim/navigation/regions.ts`
- Test: `packages/engine/test/regions.test.ts`

**Interfaces:**
- Consumes: `NavigationSystem.stand/neighbor/tileOf/tileOfPose/revisions`, `edgeCost`, `IdHeap`.
- Produces:

```ts
export const UNREACHED = 0xffff
export interface Exit { from: number; to: number; cost: number; target: number }
export interface Region {
  index: number; epoch: number
  /** local cell (x + z*16 + y*256) → pose slot, -1 when not a pose */
  slots: Int16Array
  poses: Int32Array        // slot → world voxel index
  /** forward edges: 4 per slot, slot of the target inside the region or -1 (edges leaving the region are exits) */
  next: Int16Array
  exits: Exit[]
  /** fields[e * poses.length + slot] = cost from slot to exits[e].from inside the region, UNREACHED if none */
  fields: Uint16Array
  bytes: number
}
export class RegionBuild {
  constructor(nav: NavigationSystem, index: number)
  readonly index: number
  done: boolean
  step(cap: number): number      // operations used
  result(): Region               // after done
  mixState(mix: (n: number) => void): void
}
export class RegionStore {
  constructor(nav: NavigationSystem, maxBytes?: number)  // default 32 MiB
  get(index: number): Region | undefined   // only if epoch === nav.revisions[index]
  put(region: Region): void                // FIFO eviction by insertion past maxBytes
  get bytes(): number; get size(): number
  clear(): void
}
/** Exit keys used by route and group searches: 1 + region * 4096 + exit index. */
export const exitKey = (region: number, e: number): number => 1 + region * 4096 + e
export const splitKey = (key: number): [region: number, e: number] => [Math.floor((key - 1) / 4096), (key - 1) % 4096]
/** Cost from a pose (world index) inside the region to every exit; UNREACHED where not connected. */
export function exitCosts(region: Region, pose: number, layout: Layout): number[]
/** Reverse Dijkstra inside the region from a set of poses; returns cost per slot (UNREACHED elsewhere). */
export function reverseField(region: Region, targets: readonly number[], layout: Layout): Uint16Array
```

- [ ] **Step 1: Failing tests** `regions.test.ts` (reuse the `fixture` pattern from `navigation.test.ts`, copied
  locally):

```ts
import { expect, it } from 'vitest'
import { NavigationSystem } from '../src/sim/navigation/navigation.ts'
import { RegionBuild, RegionStore, UNREACHED, exitCosts } from '../src/sim/navigation/regions.ts'
import { BlockRegistry } from '../src/blocks/registry.ts'
import { Layout } from '../src/world/layout.ts'

function fixture(side = 64, solid = new Set<number>()) {
  const layout = new Layout([side, 32, side]), registry = new BlockRegistry([{ name: 'stone' }])
  const nav = new NavigationSystem({ layout, registry, get: (x, y, z) => y < 4 || solid.has(layout.voxelIndex(x, y, z)) ? 1 : 0 })
  return { nav, layout, solid }
}
function build(nav: NavigationSystem, index: number, cap = 64) {
  const b = new RegionBuild(nav, index)
  while (!b.done) expect(b.step(cap)).toBeLessThanOrEqual(cap)
  return b.result()
}

it('an open floor region has 256 poses and exits on its four sides in runs of at most 8', () => {
  const { nav, layout } = fixture()
  const r = build(nav, nav.tileOf(16, 4, 16))
  expect(r.poses.length).toBe(256)
  // 4 sides × 16 crossings / 8 per run = 8 exits
  expect(r.exits).toHaveLength(8)
  for (const e of r.exits) expect(nav.tileOfPose(e.to)).not.toBe(r.index)
  // The corner pose reaches every exit; the field agrees with flat distances.
  const costs = exitCosts(r, layout.voxelIndex(16, 4, 16), layout)
  expect(costs.every(c => c !== UNREACHED)).toBe(true)
})
it('a drop is a one-way exit: the lower region has no exit back up the cliff', () => {
  const { nav, layout, solid } = fixture()
  // Upper shelf x < 16 at y=4..5 (top at 6), lower floor x >= 16 at y=4.
  for (let x = 0; x < 16; x++) for (let z = 0; z < 32; z++) for (let y = 4; y < 6; y++) solid.add(layout.voxelIndex(x, y, z))
  nav.invalidateBox(0, 0, 0, 31, 8, 31)
  const upper = build(nav, nav.tileOf(8, 6, 8)), lower = build(nav, nav.tileOf(20, 4, 8))
  expect(upper.exits.some(e => nav.tileOfPose(e.to) === lower.index)).toBe(true)
  expect(lower.exits.some(e => nav.tileOfPose(e.to) === upper.index)).toBe(false)
})
it('the store returns a region only while its tile revision is unchanged and evicts past its byte cap', () => {
  const { nav } = fixture(128)
  const store = new RegionStore(nav, 64 * 1024)
  const a = build(nav, nav.tileOf(0, 4, 0)); store.put(a)
  expect(store.get(a.index)).toBe(a)
  nav.invalidate(3, 4, 3)
  expect(store.get(a.index)).toBeUndefined()
  for (let i = 0; i < 16; i++) store.put(build(nav, nav.tileOf(i * 16 % 128, 4, Math.floor(i / 8) * 16)))
  expect(store.bytes).toBeLessThanOrEqual(64 * 1024)
})
it('builds are sliceable and give the same region at any slice size', () => {
  const { nav } = fixture()
  const a = build(nav, nav.tileOf(16, 4, 16), 7), b = build(nav, nav.tileOf(16, 4, 16), 5000)
  expect([...a.fields]).toEqual([...b.fields]); expect(a.exits).toEqual(b.exits)
})
```

- [ ] **Step 2: Run** `npm test -w @elovox/engine -- regions`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `regions.ts`.** `RegionBuild` is a state machine with phases
  `'poses' | 'edges' | 'exits' | 'fields' | 'done'`. Each counted unit of work is one operation.
  - **poses**: iterate local cells `c = 0..4095` in order (`x = c & 15, z = (c >> 4) & 15, y = c >> 8`, world =
    origin + local). If `nav.stand(...)`, assign the next slot. 1 op per cell.
  - **edges**: for each slot and `d = 0..3`, `to = nav.neighbor(pose, d)` (1 op). If `to < 0`, set `next = -1`. If
    `tileOfPose(to) === index`, set `next = slots[local(to)]`. Otherwise push a crossing
    `{ slot, d, to, cost: edgeCost(L, pose, to), target: tileOfPose(to) }`. Also count in-region reverse degree.
  - **exits**: sort the crossings by `(d, target, sy, ty, alongD, across)`:
    - `sy`, `ty`: source and target y;
    - `alongD`: x for d 0/1, z for d 2/3;
    - `across`: the other horizontal coordinate.

    Split into runs where `across` is not consecutive, any key changes, or a run reaches 8. The middle element
    (`Math.floor(len / 2)`) of each run becomes an `Exit`. 1 op per crossing.
    - Over 4,095 exits (exit keys reserve 4,096 per region), set `Region.overflow = true`. A route or group search
      that needs an overflowing region ends `limited` (add `overflow: boolean` to `Region`).
  - **fields**: build reverse adjacency (CSR arrays `revStart`/`rev` from `next`). Then, for each exit `e`, run a
    Dijkstra over the reverse edges from `slots[local(exits[e].from)]`, using `IdHeap` and the cost of the forward
    edge `edgeCost(L, poses[src], poses[dst])`. Write the costs into `fields[e * P + slot]`. 1 op per pop and 1 per
    relaxed edge. Cap the costs at `UNREACHED - 1` (a region path never costs that much: 4096 × 6 < 65535).
  - `result()` sets `bytes = slots.byteLength + poses.byteLength + next.byteLength + fields.byteLength + exits.length * 32`.
  - `mixState`: phase, cursors, slot count, crossings length, current field index and heap.
  - `exitCosts(region, pose, L)`: `slot = region.slots[local(pose)]`, then `fields[e * P + slot]` for each `e`.
  - `reverseField(region, targets, L)`: the same reverse Dijkstra, from several target slots (targets outside the
    region are ignored). Synchronous; the caller charges `region.poses.length * 5` operations for it.
  - `RegionStore`: a `Map<index, Region>` in insertion order. `get` checks `region.epoch === nav.revisions[index]`.
    `put` deletes then re-inserts the key and evicts from the front while `bytes > maxBytes`.

- [ ] **Step 4: Run the tests.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(nav): sliceable region builds with exits and reverse exit fields`.

### Task H3: Route search over exits

**Files:**
- Create: `packages/engine/src/sim/navigation/routeSearch.ts`
- Test: `packages/engine/test/routeSearch.test.ts`

**Interfaces:**
- Consumes: `RegionBuild`, `RegionStore`, `exitCosts`, `reverseField`, `IdHeap`, `PathStatus`.
- Produces:

```ts
export interface RouteOptions { exclude?: ReadonlySet<number> /* exit.from poses not to use */; maxNodes?: number /* default 8192 */ }
export class RouteSearch {
  constructor(nav: NavigationSystem, store: RegionStore, start: number, goals: readonly number[], options?: RouteOptions)
  status: PathStatus; cost: number; spent: number; readonly estimate: number
  /** After 'found': the exits to take, in order (the `from` poses), then the goal pose that the last segment reaches. */
  exits: number[]; goal: number
  /** Per-query goal fields, keyed by region index: cost from a region slot to the nearest goal. */
  readonly goalFields: Map<number, Uint16Array>
  readonly seen: Map<number, number>
  step(cap: number): number; cancel(): void; result(): PathResult; get bytes(): number
  mixState(mix: (n: number) => void): void
}
```

  Node keys: `0` = start; `1 + region * 4096 + e` = exit `e` of region `region` (taken: the unit stands on
  `exit.to`); the goal node is key `-1` (handled by a flag, not in the heap ids).

- [ ] **Step 1: Failing tests** `routeSearch.test.ts` (with the `fixture` and `build` helpers from
  `regions.test.ts`, copied):

```ts
function route(nav: NavigationSystem, store: RegionStore, start: number, goals: number[], cap = 512, options = {}) {
  const s = new RouteSearch(nav, store, start, goals, options)
  for (let i = 0; i < 100000 && s.status === 'pending'; i++) expect(s.step(cap)).toBeLessThanOrEqual(cap)
  return s
}
it('crosses an open 128² floor with a cost within 1.25× of the flat optimum', () => {
  const { nav, layout } = fixture(128), store = new RegionStore(nav)
  const s = route(nav, store, layout.voxelIndex(2, 4, 2), [layout.voxelIndex(125, 4, 125)])
  expect(s.status).toBe('found')
  expect(s.cost).toBeGreaterThanOrEqual(246 * 4); expect(s.cost).toBeLessThanOrEqual(246 * 4 * 1.25)
  expect(s.exits.length).toBeGreaterThan(10)
})
it('proves unreachable for an enclosed goal after building only the regions it touched', () => {
  const { nav, layout, solid } = fixture(128)
  for (let x = 98; x <= 102; x++) for (let z = 98; z <= 102; z++) if (x === 98 || x === 102 || z === 98 || z === 102) for (let y = 4; y < 8; y++) solid.add(layout.voxelIndex(x, y, z))
  const store = new RegionStore(nav)
  const s = route(nav, store, layout.voxelIndex(5, 4, 5), [layout.voxelIndex(100, 4, 100)])
  expect(s.status).toBe('unreachable')
})
it('a goal reachable only by dropping is unreachable in the other direction', () => {
  const { nav, layout, solid } = fixture(64)
  for (let x = 0; x < 32; x++) for (let z = 0; z < 64; z++) for (let y = 4; y < 6; y++) solid.add(layout.voxelIndex(x, y, z))
  const store = new RegionStore(nav)
  expect(route(nav, store, layout.voxelIndex(4, 6, 4), [layout.voxelIndex(60, 4, 60)]).status).toBe('found')
  expect(route(nav, store, layout.voxelIndex(60, 4, 60), [layout.voxelIndex(4, 6, 4)]).status).toBe('unreachable')
})
it('ends limited, never unreachable, when its node cap cuts the search', () => {
  const { nav, layout } = fixture(256), store = new RegionStore(nav)
  const s = route(nav, store, layout.voxelIndex(2, 4, 2), [layout.voxelIndex(250, 4, 250)], 512, { maxNodes: 4 })
  expect(s.status).toBe('limited')
})
it('ends stale when a region it read changes before it finishes', () => {
  const { nav, layout } = fixture(128), store = new RegionStore(nav)
  const s = new RouteSearch(nav, store, layout.voxelIndex(2, 4, 2), [layout.voxelIndex(125, 4, 125)])
  s.step(20000); nav.invalidate(3, 4, 3)
  while (s.status === 'pending') s.step(4096)
  expect(s.status).toBe('stale')
})
it('excluded exits are not used', () => {
  const { nav, layout } = fixture(64), store = new RegionStore(nav)
  const a = route(nav, store, layout.voxelIndex(2, 4, 8), [layout.voxelIndex(60, 4, 8)])
  const b = route(nav, store, layout.voxelIndex(2, 4, 8), [layout.voxelIndex(60, 4, 8)], 512, { exclude: new Set([a.exits[0]!]) })
  expect(b.status).toBe('found'); expect(b.exits).not.toContain(a.exits[0])
})
it('two searches with different state mix differently', () => {
  const { nav, layout } = fixture(64), store = new RegionStore(nav)
  const a = new RouteSearch(nav, store, layout.voxelIndex(2, 4, 8), [layout.voxelIndex(60, 4, 8)])
  const b = new RouteSearch(nav, store, layout.voxelIndex(2, 4, 9), [layout.voxelIndex(60, 4, 8)])
  const sig = (s: RouteSearch) => { const v: number[] = []; s.mixState(n => v.push(n)); return v }
  expect(sig(a)).not.toEqual(sig(b))
})
```

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement `routeSearch.ts`.** It is a state machine. At most one `RegionBuild` job is pending at a
  time; when it completes, the region goes into the store.
  - **Region access** `need(index)`:
    1. Return `store.get(index)` if present, recording `seen.set(index, nav.revisions[index])`.
    2. Otherwise start `this.job = new RegionBuild(nav, index)` and return `undefined`; the caller retries the same
       expansion after the job finishes.
  - **Goal fields**: on first need of a goal region `R` (the region of any goal), compute
    `reverseField(region, goals in R)` and charge `region.poses.length * 5` ops. Keep it in `goalFields`.
  - **Start**: `need(R0)`.
    - Push each exit `e` with `exitCosts(R0, start)[e] !== UNREACHED`, as key `1 + R0 * 4096 + e` with
      `g = cost + exit.cost`.
    - If `R0` holds a goal and `goalFields[R0][slot(start)] !== UNREACHED`, record a goal candidate
      `g = goalField`.
  - **Expand exit key k** (stand on `exit.to` in region `R1 = exit.target`): `need(R1)`. Take the slot of `exit.to`.
    - For each exit `e2` of `R1` not excluded, with `fields[e2 * P + slot] !== UNREACHED`, relax `1 + R1 * 4096 + e2`
      with `g + field + exit2.cost`.
    - If `R1` is a goal region with a reachable goal field at that slot, relax the goal with `g + goalField`.
  - **Goal**: keep `bestGoal = { g, parent }`. Stop with `found` when `bestGoal.g <= heap.peekF()`; this keeps the
    result optimal over the abstract graph.
  - **Heuristic**: `h(p)` = the flat heuristic from `PathSearch.h` (min over goals of
    `(|dx| + |dz|) * 4 + max(0, gy - y) * 2`), evaluated at `exit.to`. It is consistent here too.
  - **Scratch**: `g`, parent and closed live in `Map<number, number>`s. 1 op per pop, 1 per relaxation, plus job ops.
    Past `maxNodes` distinct keys, the status is `limited`.
  - **Reconstruct**: follow parents from the goal to `0`. Then `exits = [exit.from …]` in order and `goal` = the goal
    pose with the minimum `goalField` (the descent target).
  - **Validate**: like `PathSearch`, re-check every `seen` revision; a mismatch gives `stale`.
  - **Unreachable**: the heap is empty and there is no goal candidate.
  - **mixState**: status, phase, the job (`job?.mixState`), heap, the `g`/parent maps sorted by key, `seen`, sorted
    `exclude`, `goals`, `bestGoal`.

- [ ] **Step 4: Run the tests.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(nav): route search over region exits with goal fields and proofs of unreachability`.

### Task H4: Group fields for many units, one destination

**Files:**
- Create: `packages/engine/src/sim/navigation/groupField.ts`
- Test: `packages/engine/test/groupField.test.ts`

**Interfaces:**
- Produces:

```ts
export class GroupField {
  constructor(nav: NavigationSystem, store: RegionStore, goals: readonly number[], starts: readonly number[], maxNodes?: number /* 32768 */)
  status: PathStatus          // 'found' once every start region is settled; 'limited' if cut
  spent: number; readonly estimate: number
  /** Cost to the goals from exit `key` (1 + region*4096 + e), or Infinity when unknown or unreachable. */
  distance(key: number): number
  /** The best exit key to take from `pose` (or -1 when the pose's region is a goal region and the goal field is best), and its total cost. */
  next(pose: number): { exit: number; cost: number } | null
  readonly goalFields: Map<number, Uint16Array>
  step(cap: number): number; cancel(): void; mixState(mix): void; get bytes(): number
  readonly seen: Map<number, number>
}
```

- [ ] **Step 1: Failing tests:**

```ts
it('agrees with independent route searches for every start of a group', () => {
  const { nav, layout } = fixture(128), store = new RegionStore(nav)
  const goals = [layout.voxelIndex(120, 4, 120), layout.voxelIndex(118, 4, 120)]
  const starts = [layout.voxelIndex(4, 4, 4), layout.voxelIndex(60, 4, 4), layout.voxelIndex(4, 4, 70)]
  const g = new GroupField(nav, store, goals, starts)
  while (g.status === 'pending') g.step(4096)
  expect(g.status).toBe('found')
  for (const s of starts) {
    const r = route(nav, store, s, goals)
    expect(g.next(s)!.cost).toBe(r.cost)
  }
})
it('reports unreachable starts with a null next', () => {
  const { nav, layout, solid } = fixture(64)
  for (let x = 30; x <= 34; x++) for (let z = 0; z < 64; z++) for (let y = 4; y < 8; y++) solid.add(layout.voxelIndex(x, y, z))
  const store = new RegionStore(nav), g = new GroupField(nav, store, [layout.voxelIndex(60, 4, 8)], [layout.voxelIndex(4, 4, 8)])
  while (g.status === 'pending') g.step(4096)
  expect(g.next(layout.voxelIndex(4, 4, 8))).toBeNull()
})
```

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement.** A reverse Dijkstra over exits:
  - **Seeds**: for each goal region `R` (goal field as in H3) and each neighbour region `A` that has an exit `p` into
    `R` (`p.target === R`), seed `D(p) = p.cost + goalField_R[slot(p.to)]`. Neighbours are the regions within ±1
    tile in x, z and y (at most 26, but only face neighbours ± y can hold exits into `R`; build `A` with `need`).
  - **Relaxation**: pop exit `e` of region `A` (`e.from` in `A`). For every region `B` adjacent to `A` (same
    neighbour set) with an exit `p` such that `p.target === A`:
    `D(p) = min(D(p), p.cost + fields_A[e][slot(p.to)] + D(e))`.
  - **Done**: when every start region `S` has all of its exits settled, or the heap's minimum exceeds the best known
    total for every start (`min_e exitCosts(S, start)[e] + D(e)`), status `found`. Heap empty: `found` (unresolved
    starts return `null`). Over `maxNodes`: `limited`.
  - `next(pose)`:
    - In a goal region with a reachable goal field: compare `goalField[slot]` against
      `min_e exitCosts + D(e)` and return the smaller (exit `-1` means descend the goal field).
    - Elsewhere: `argmin_e exitCosts[e] + D(e)`, ties broken by lower `e`.
    - If the pose's region is not in the store, `next` returns `null` and the caller replans.
  - Record `seen` like H3. `step` charges the same operation kinds as H3.

- [ ] **Step 4: Run.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(nav): group fields share one reverse abstract search across a move order`.

### Task H5: Scheduling routes and groups in NavigationSystem

**Files:**
- Modify: `packages/engine/src/sim/navigation/navigation.ts`
- Modify: `packages/engine/src/sim/workers/types.ts` (`WorkerStats.regionBytes`, `regions`)
- Test: `packages/engine/test/navigation.test.ts`

**Interfaces:**
- Produces:
  - `interface NavQuery { status: PathStatus; spent: number; readonly estimate: number; readonly seen: Map<number, number>; step(cap: number): number; cancel(): void; mixState(mix): void; readonly bytes: number }`.
    `PathSearch`, `RouteSearch` and `GroupField` all satisfy it.
  - `NavigationSystem.regions: RegionStore` (created in the constructor, cleared by `reset`).
  - `NavigationSystem.route(start, goals, options?): RouteSearch` and `NavigationSystem.group(goals, starts): GroupField`,
    both queued like `request`.
  - `NavigationSystem.bytes` includes `regions.bytes`.
  - `explored()` and `invalidatePolicy(box)` work for every `NavQuery` (they read `seen`; for routes and groups, `seen`
    is keyed by region index, which equals the tile index, so the existing box test applies unchanged).

- [ ] **Step 1: Failing test:**

```ts
it('schedules route searches with flat ones inside one budget and keeps short searches fast', () => {
  const { nav, layout } = fixture(256)
  const long = nav.route(layout.voxelIndex(2, 4, 2), [layout.voxelIndex(250, 4, 250)])
  const short = nav.request(layout.voxelIndex(5, 4, 20), [layout.voxelIndex(8, 4, 20)])
  for (let tick = 0; tick < 3 && short.status === 'pending'; tick++) { nav.step(4096); expect(nav.visited).toBeLessThanOrEqual(4096) }
  expect(short.status).toBe('found')
  while (long.status === 'pending') { nav.step(4096); expect(nav.visited).toBeLessThanOrEqual(4096) }
  expect(long.status).toBe('found')
  expect(nav.bytes).toBeGreaterThan(nav.regions.bytes)
})
it('reset drops region records and cancels routes', () => {
  const { nav, layout } = fixture(128)
  const r = nav.route(layout.voxelIndex(2, 4, 2), [layout.voxelIndex(120, 4, 120)]); nav.step(8192)
  nav.reset()
  expect(r.status).toBe('cancelled'); expect(nav.regions.size).toBe(0)
})
```

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement.** Change `requests: PathSearch[]` to `NavQuery[]`; nothing else in `step()` changes. A
  route's `estimate` is the heuristic from the start, so long routes go to the FIFO window as today. Raise the window
  from 4 to 8 queries (constant `WINDOW = 8`) so group fields and routes do not all queue behind one long flat search.
  `mixState` already mixes each request through its own `mixState`; mix a kind tag (0 flat, 1 route, 2 group) before
  each.

- [ ] **Step 4: Run** the full engine suite: `npm test -w @elovox/engine`. Expected: PASS (the hash test in
  `workers.test.ts` still replays equal).

- [ ] **Step 5: Commit** `feat(nav): route and group queries share the navigation budget`.

### Task H6: Units walk segmented routes

**Files:**
- Create: `packages/engine/src/sim/navigation/refine.ts`
- Modify: `packages/engine/src/sim/workers/workers.ts`
- Test: `packages/engine/test/refine.test.ts`, `packages/engine/test/workers.test.ts`

**Interfaces:**
- Consumes: `Region`, `exitCosts`, `RouteSearch`, `GroupField`, `edgeCost`.
- Produces:
  - `descend(region: Region, field: Uint16Array | number /* exit index */, from: number, allowed: (p: number) => boolean, layout: Layout, maxSteps = 256): { path: number[]; ops: number; ok: boolean }`.
    It follows `next` edges whose `field[target] + edgeCost === field[current]`, in direction order, skipping
    disallowed targets. `ok` is false when no allowed optimal step exists before reaching cost 0.
  - In `workers.ts`: `Unit.route: { search: RouteSearch | GroupField; exits: number[]; next: number } | null` and
    `Unit.segment: PathSearch | null` (the confined fallback search).
  - Constant `HIER_MIN = 48 * 4` (estimate above which a unit uses a route).

- [ ] **Step 1: Failing tests** `refine.test.ts`:

```ts
it('descends an exit field along an optimal path and stops at a disallowed step', () => {
  const { nav, layout } = fixture()
  const r = build(nav, nav.tileOf(16, 4, 16)), e = 0, from = layout.voxelIndex(20, 4, 20)
  const all = descend(r, e, from, () => true, layout)
  expect(all.ok).toBe(true); expect(all.path.at(-1)).toBe(r.exits[e]!.from)
  const blocked = new Set(all.path.slice(1, 2))
  const cut = descend(r, e, from, p => !blocked.has(p), layout)
  // Another optimal neighbour exists on an open floor, so descent still succeeds around one blocked pose.
  expect(cut.ok).toBe(true); expect(cut.path).not.toContain([...blocked][0])
})
```

  `workers.test.ts` (in a 256² world, so routes engage; add a `makeWide(side)` helper next to `make`, with the same
  options and a generator for `side × 32 × side`):

```ts
it('walks a 200-block move through route segments and arrives', () => {
  const sim = makeWide(256); spawn(sim, [5, 4, 5])
  cmd(sim, { type: 'unitMove', ids: [1], pos: [220, 4, 200] })
  until(sim, () => sim.workers!.view(1)?.state === 'walking', 40)   // first action within 2 s
  until(sim, () => sim.workers!.view(1)?.state === 'idle', 4000)
  expect(sim.workers!.view(1)).toMatchObject({ x256: 220 * 256 + 128, z256: 200 * 256 + 128 })
})
it('a wall built across the next segment makes the unit stop safely, replan and still arrive', () => {
  const sim = makeWide(256); spawn(sim, [5, 4, 5])
  cmd(sim, { type: 'unitMove', ids: [1], pos: [220, 4, 5] })
  until(sim, () => (sim.workers!.view(1)?.x256 ?? 0) > 60 * 256, 2000)
  cmd(sim, { type: 'fillRegion', min: [100, 4, 0], max: [100, 7, 30], voxel: 1 })
  until(sim, () => sim.workers!.view(1)?.state === 'idle', 6000)
  expect(sim.workers!.view(1)?.x256).toBe(220 * 256 + 128)
})
it('escape from a build designation stays on the flat search', () => {
  // Spawn inside a build box, then order a long move: the first query must be a PathSearch with an allowed override.
  const sim = makeWide(256); spawn(sim, [10, 4, 10])
  cmd(sim, { type: 'workBuild', min: [8, 4, 8], max: [12, 4, 12], voxel: 2 })
  cmd(sim, { type: 'unitMove', ids: [1], pos: [200, 4, 200] })
  expect(sim.workers!.units.get(1)!.route).toBeNull()
})
it('a group move resolves every unit from one group field', () => {
  const sim = makeWide(256)
  for (let i = 0; i < 20; i++) spawn(sim, [4 + (i % 5) * 2, 4, 4 + Math.floor(i / 5) * 2])
  cmd(sim, { type: 'unitMove', ids: [...sim.workers!.units.keys()], pos: [200, 4, 200] })
  const fields = new Set([...sim.workers!.units.values()].map(u => u.route?.search))
  expect(fields.size).toBe(1)
  until(sim, () => [...sim.workers!.units.values()].every(u => u.state === 'walking' || u.state === 'idle'), 60)
})
```

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement `refine.ts`** (`descend` as specified; 1 op per step plus 1 per inspected edge).

- [ ] **Step 4: Integrate in `workers.ts`.**
  - **New `plan(u, goals)`**, replacing `request(u, goals)` at `assign()` (`u.search = this.request(u, goals)`), the
    task retry (`if (this.time >= u.retry) u.search = this.request(u, this.workGoals(u, u.task))`) and the goal retry
    (`u.search = this.request(u, [u.goal])`):
    - It computes `escape` as `request` does.
    - It uses `nav.route(position, goals)` only when `escape` is empty, the unit has no `allowDig`/`buildBlock`, and
      the flat heuristic estimate > `HIER_MIN`. Otherwise it falls through to `request`.
    - Traffic detours (`yield`), the exposure escape (`accept`) and engineering stay on `request`.
  - **Group moves**: in `command()` for `unitMove` with more than one unit, after destinations are chosen, call
    `this.nav.group(destinations, units.map(position))` and set every unit's
    `route = { search: field, exits: [], next: 0 }`, `u.search = null`.
  - **Adopting a route** (new branch before `if (u.search)` in `afterPhysics`): while `route.search.status` is
    pending, the unit stays `planning`.
    - On `found`, refine the first segment.
    - `unreachable` → `block(u, 'no-access')`.
    - `limited` → `block(u, 'search-limited')`.
    - `stale` → stale backoff (as for flat searches).
  - **Refining a segment** (`refineNext(u)`):
    - Take the unit's current pose region `R` (from `nav.regions.get`; if missing, replan).
    - Get the target: for a `RouteSearch`, `exits[next]`; for a `GroupField`, `field.next(lastPose)`. A goal-field
      target (`-1` or past the last exit) descends `goalFields[R]`.
    - `descend` with `allowed = p => this.poseOk(u, coords(p)) && !this.occupied.has(p)`.
    - On `ok`, append the path (without its first pose) plus the crossing pose `exit.to` to `u.path`, and advance
      `next`.
    - When not `ok`, start `u.segment = nav.request(lastPose, [exit.from], undefined, { region: R })`. If that ends
      not found, replan the route from the current pose with `exclude` = previous exclusions plus `exit.from`.
  - **Keep 2 segments ahead**: after each motion step, if the unwalked part of `u.path` holds fewer than 2 crossing
    poses and the route has more exits, call `refineNext`.
  - **Arriving**: when the last segment reaches the goal, `route = null`. Work poses: the final pose becomes the claim
    as today (`u.workPoses = [p]`).
  - **Resets**: `resetRoute` also cancels `route.search` (when no other unit uses the same group field, i.e. a
    reference count on the field) and `u.segment`, and clears `route`.
  - **Hash**: `mixState` mixes `route` (`exits`, `next`, and a group field id through a `Map<GroupField, number>`
    assigned in creation order) and `segment?.mixState`. The group field's own state is mixed once by
    `nav.mixState`.

- [ ] **Step 5: Run** `npm test -w @elovox/engine -- refine workers navigation`. Expected: PASS. Then run the whole
  engine suite.

- [ ] **Step 6: Commit** `feat(workers): units walk hierarchical routes refined two segments ahead`.

### Task H7: Agreement fuzz and path-quality bench

**Files:**
- Test: `packages/engine/test/routeFuzz.test.ts`
- Modify: `apps/sandbox/bench/crowd.node.ts` (`--quality`)

- [ ] **Step 1: Write the fuzz test.** 40 seeded worlds 96 × 32 × 96 with random hills (heights 4–9), 3 random walls
  and one cave tunnel. Use `Rng` from `sim/rng.ts` for determinism. For 25 random start/goal pairs per world, both
  standing poses:
  - a flat `PathSearch` with `maxSearchNodes` = 1 << 20 (constructor argument);
  - a `RouteSearch`.

  Assert that the statuses agree (found/unreachable), and that `route.cost <= 1.25 * flat.cost` for each pair.
  Accumulate the mean ratio and assert ≤ 1.10.

- [ ] **Step 2: Run.** Expected: PASS. If it fails, the failing seed and pair print in the assertion message; fix the
  implementation in H2–H4, never the bounds.

- [ ] **Step 3: Bench `--quality`.** On the crowd world, 500 seeded pairs between random standing poses on the
  surface, run flat (node limit 1 << 22) against route, and print the mean and p95 ratio, agreement count, and ops per
  query. Save as `docs/superpowers/research/2026-10-09-route-quality.json` (quiet window).

- [ ] **Step 4: Commit** `test(nav): routes agree with exact A* on fuzzed terrain; quality bench`.

---

## Stream C — cooperation

### Task C1: The reservation table

**Files:**
- Create: `packages/engine/src/sim/workers/reservations.ts`
- Test: `packages/engine/test/reservations.test.ts`

**Interfaces:**
- Produces:

```ts
export class ReservationTable {
  constructor(window?: number)   // default 32
  readonly window: number
  now: number
  /** Owner of `cell` at absolute tick `t`: a hold wins over timed entries; 0 when free. */
  owner(cell: number, t: number): number
  free(owner: number, t: number, cells: readonly number[]): boolean
  /** Timed: only for now <= t < now + 2 * window; earlier or later ticks are ignored. */
  reserve(owner: number, t: number, cells: readonly number[]): void
  /** Drops the owner's timed entries at ticks >= t. */
  releaseFrom(owner: number, t: number): void
  hold(owner: number, cells: readonly number[]): void
  releaseHold(owner: number): void
  releaseOwner(owner: number): void
  /** Last tick the owner has timed entries for, or now - 1. */
  horizon(owner: number): number
  advance(now: number): void      // drops ticks < now
  get size(): number
  mixState(mix: (n: number) => void): void
}
```

- [ ] **Step 1: Failing tests:**

```ts
import { expect, it } from 'vitest'
import { ReservationTable } from '../src/sim/workers/reservations.ts'

it('timed entries are owned per tick and expire as time advances', () => {
  const t = new ReservationTable(4)
  t.reserve(1, 0, [10, 11]); t.reserve(1, 1, [11, 12])
  expect(t.owner(10, 0)).toBe(1); expect(t.owner(10, 1)).toBe(0); expect(t.horizon(1)).toBe(1)
  t.advance(1)
  expect(t.owner(10, 0)).toBe(0); expect(t.owner(12, 1)).toBe(1)
})
it('holds win over timed entries and never expire', () => {
  const t = new ReservationTable(4)
  t.hold(2, [5]); t.reserve(1, 3, [5])
  expect(t.owner(5, 3)).toBe(2)
  t.advance(100); expect(t.owner(5, 100)).toBe(2)
  t.releaseHold(2); expect(t.owner(5, 100)).toBe(0)
})
it('releaseFrom and releaseOwner free exactly the owner’s cells', () => {
  const t = new ReservationTable(8)
  for (let k = 0; k < 6; k++) { t.reserve(1, k, [k]); t.reserve(2, k, [100 + k]) }
  t.releaseFrom(1, 3)
  expect(t.owner(2, 2)).toBe(1); expect(t.owner(3, 3)).toBe(0); expect(t.owner(103, 3)).toBe(2)
  t.hold(1, [50]); t.releaseOwner(1)
  expect(t.owner(50, 0)).toBe(0); expect(t.owner(0, 0)).toBe(0); expect(t.horizon(1)).toBe(-1)
})
it('free() ignores the asking owner’s own entries', () => {
  const t = new ReservationTable(4); t.reserve(1, 0, [7])
  expect(t.free(1, 0, [7])).toBe(true); expect(t.free(2, 0, [7])).toBe(false)
})
it('mixes the same state the same way regardless of insertion order of owners', () => {
  const a = new ReservationTable(4), b = new ReservationTable(4)
  a.reserve(1, 0, [1]); a.reserve(2, 0, [2]); b.reserve(2, 0, [2]); b.reserve(1, 0, [1])
  const sig = (t: ReservationTable) => { const v: number[] = []; t.mixState(n => v.push(n)); return v }
  expect(sig(a)).toEqual(sig(b))
})
```

- [ ] **Step 2: Run** `npm test -w @elovox/engine -- reservations`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **Timed entries**: `2 * window` slots, `slot = t % (2 * window)`. Each slot holds `{ tick: number; cells: Map<number, number> }`.
    A slot whose `tick !== t` reads as empty.
  - **Per-owner index**: `spans: Map<owner, { t: number; cells: number[] }[]>`, sorted by `t`.
  - **Holds**: `holds: Map<number, number>` (cell → owner) and `held: Map<owner, number[]>`.
  - **`advance(now)`** drops every span with `t < now` and clears the slots whose tick is below `now`.
  - **`mixState`**:
    1. `now` and `window`.
    2. The holds, sorted by cell.
    3. For each `t` from `now` to `now + 2 * window - 1`, the entries of that tick sorted by cell (cell, owner pairs),
       each list length-prefixed.

- [ ] **Step 4: Run.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(workers): space-time reservation table with holds`.

### Task C2: Projection and holds in the executor

**Files:**
- Modify: `packages/engine/src/sim/workers/workers.ts`
- Test: `packages/engine/test/workers.test.ts`

**Interfaces:**
- Consumes: `ReservationTable`.
- Produces:
  - `WorkerSystem.table: ReservationTable` (public read-only, for tests).
  - `Unit.projection: { cursor: number; pose: [number, number, number]; t: number } | null` (the frontier of what the
    unit has reserved).
  - `Unit.conflict: { t: number; owner: number } | null`.
  - `private project(u): void`, `private holdHere(u): void`.

- [ ] **Step 1: Failing tests:**

```ts
it('a walking unit reserves its next 32 ticks along its path and holds its body when it stops', () => {
  const sim = make(); spawn(sim); cmd(sim, { type: 'unitMove', ids: [1], pos: [25, 4, 5] })
  until(sim, () => sim.workers!.view(1)?.state === 'walking')
  const w = sim.workers!, t = w.table, now = t.now
  expect(t.horizon(1)).toBeGreaterThanOrEqual(now + 31)
  until(sim, () => w.view(1)?.state === 'idle')
  const cell = sim.store.layout.voxelIndex(25, 4, 5)
  expect(t.owner(cell, t.now + 1000)).toBe(1)
})
it('no two units ever own or occupy the same cell in the same tick', () => {
  const sim = make(); spawn(sim, [3, 4, 5]); spawn(sim, [28, 4, 5])
  cmd(sim, { type: 'unitMove', ids: [1], pos: [28, 4, 6] }); cmd(sim, { type: 'unitMove', ids: [2], pos: [3, 4, 6] })
  for (let i = 0; i < 600; i++) {
    sim.step()
    const seen = new Map<number, number>()
    for (const u of sim.workers!.units.values()) for (const p of u.cells) { expect(seen.get(p), `cell ${p} tick ${i}`).toBeUndefined(); seen.set(p, u.id) }
  }
})
it('pause keeps no stale window: after resuming, reservations start at the current tick', () => {
  const sim = make(); spawn(sim); cmd(sim, { type: 'unitMove', ids: [1], pos: [25, 4, 5] })
  until(sim, () => sim.workers!.view(1)?.state === 'walking')
  sim.setPaused(true); for (let i = 0; i < 100; i++) sim.step(); sim.setPaused(false); sim.step()
  const t = sim.workers!.table
  expect(t.horizon(1)).toBeGreaterThanOrEqual(t.now)
  expect(t.horizon(1)).toBeLessThan(t.now + 2 * t.window)
})
```

  (Read `Simulation` for the actual pause API name; adjust `setPaused` to it.)

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **Construction and time**: `table = new ReservationTable(32)` in the constructor. At the start of `afterPhysics`,
    `table.advance(this.time)`. `time` only advances while physics runs, so a pause freezes the window.
  - **`project(u)`**, called after each unit's step in `afterPhysics`:
    - With a `motion`, the remaining ticks of the motion reserve exactly the cells the executor will check: for flat
      motions, `walkSweep(pose(t - 1), pose(t)) ∩ area`; for vertical ones, the whole `m.cells`.
    - Then the remaining `u.path` nodes from `motion.cursor` (or `u.cursor`), one node at a time: flat steps take
      `ceil(256 / WALK_SPEED) = 4` ticks with `walkSweep` per tick; vertical steps take their tick count with
      whole-action cells.
    - It stops at `time + window`, or at the first tick whose cells are not `free(u.id, …)`. That sets
      `u.conflict = { t, owner }` and stops projecting.
    - It is incremental: it resumes from `u.projection`.
  - **Invalidation**: when the path changes (`resetRoute`, adoption of a new search result, a string-pulled
    `beginPathMotion`), `table.releaseFrom(u.id, time + 1)` and `u.projection = null` before re-projecting.
  - **Executor check**: `beginMotion` and the per-tick motion update also require
    `table.free(u.id, this.time + 1, cells)`. Failing it is treated exactly like a failed `reserve` (wait, traffic).
  - **`holdHere(u)`**: when a unit is not moving (idle, working, waiting, blocked), `table.hold(u.id, u.cells)`. When
    it starts moving, `table.releaseHold(u.id)`.
  - **Removal**: `unitDespawn` and `incapacitate` call `table.releaseOwner(u.id)`.
  - **Hash**: `table.mixState`, plus `projection` and `conflict` per unit.

- [ ] **Step 4: Run** the whole engine suite. Expected: PASS. If an existing traffic test now behaves differently
  only because units no longer collide, keep the stronger behaviour and update the assertion, noting it in the commit.

- [ ] **Step 5: Commit** `feat(workers): units project 32 ticks of reservations and hold their body when still`.

### Task C3: Space-time repair

**Files:**
- Create: `packages/engine/src/sim/workers/spaceTime.ts`
- Test: `packages/engine/test/spaceTime.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SpaceTimePort {
  neighbor(p: number, d: number): number          // NavigationSystem.neighbor
  allowed(p: number): boolean                     // live pose policy for this unit
  cellsOf(p: number): number[]                    // body cells standing on pose p
  stepCells(a: number, b: number): number[]       // union of body cells for a step a→b
  ticksOf(a: number, b: number): number           // 4 flat; 4 + 2 climb; 4 + d drop
  coords(p: number): [number, number, number]
}
export interface SpaceTimePlan { steps: { pose: number; until: number }[]; rejoin: number /* index into targets, -1 for a pocket */ }
export class SpaceTimeSearch {
  constructor(port: SpaceTimePort, table: ReservationTable, owner: number, start: number, startTick: number, targets: readonly number[], radius?: number /* 8 */, maxOps?: number /* 4096 */)
  status: 'pending' | 'found' | 'failed'; plan: SpaceTimePlan | null
  step(cap: number): number
  mixState(mix: (n: number) => void): void
}
```

  `steps[i]` means: be on `pose` and stay there through tick `until`, then take the next step. The plan reaches a
  target pose (`rejoin = i`) or survives to `startTick + window` on a pose it may hold (a pocket).

- [ ] **Step 1: Failing tests** (pure, on a flat grid port; `.` floor, `P` pocket floor, `#` wall; one cell per body):

```ts
import { expect, it } from 'vitest'
import { ReservationTable } from '../src/sim/workers/reservations.ts'
import { SpaceTimeSearch, type SpaceTimePort, type SpaceTimePlan } from '../src/sim/workers/spaceTime.ts'

function corridor(lines: string[]) {
  const W = lines[0]!.length, D = lines.length, idx = (x: number, z: number) => x + z * W
  const open = (x: number, z: number) => x >= 0 && z >= 0 && x < W && z < D && lines[z]![x] !== '#'
  const port: SpaceTimePort = {
    neighbor: (p, d) => { const x = p % W + [1, -1, 0, 0][d]!, z = Math.floor(p / W) + [0, 0, 1, -1][d]!; return open(x, z) ? idx(x, z) : -1 },
    allowed: () => true, cellsOf: p => [p], stepCells: (a, b) => [a, b], ticksOf: () => 4, coords: p => [p % W, 0, Math.floor(p / W)],
  }
  return { port, idx }
}
/** Cells the plan occupies per tick: standing until `until`, then both poses during each 4-tick step. */
function occupancy(plan: SpaceTimePlan, start: number) {
  const at = new Map<number, Set<number>>(), put = (t: number, c: number) => { let s = at.get(t); if (!s) { s = new Set(); at.set(t, s) }; s.add(c) }
  let t = start
  plan.steps.forEach((s, i) => {
    for (; t <= s.until; t++) put(t, s.pose)
    const n = plan.steps[i + 1]; if (n) for (let k = 1; k <= 4; k++) { put(t - 1 + k, s.pose); put(t - 1 + k, n.pose) }
    if (n) t += 3
  })
  return at
}
function run(s: SpaceTimeSearch) { while (s.status === 'pending') expect(s.step(64)).toBeLessThanOrEqual(64); return s }

it('waits for a crossing unit instead of walking into it', () => {
  const { port, idx } = corridor(['........']), table = new ReservationTable(32)
  for (let t = 1; t <= 12; t++) table.reserve(2, t, [idx(3, 0)])
  const targets = [1, 2, 3, 4, 5, 6, 7].map(x => idx(x, 0))
  const s = run(new SpaceTimeSearch(port, table, 1, idx(0, 0), 0, targets))
  expect(s.status).toBe('found'); expect(s.plan!.rejoin).toBe(6)
  for (const [t, cells] of occupancy(s.plan!, 0)) if (t <= 12) expect(cells.has(idx(3, 0)), `tick ${t}`).toBe(false)
})
it('backs off into a side pocket when a unit with the right of way sweeps the corridor', () => {
  const { port, idx } = corridor(['........', '...P....'.replace(/[^P]/g, '#')]), table = new ReservationTable(32)
  for (let k = 0; k <= 7; k++) for (let t = 4 * k; t <= 4 * k + 4; t++) table.reserve(2, t, [idx(7 - k, 0)])
  const s = run(new SpaceTimeSearch(port, table, 1, idx(0, 0), 0, [1, 2, 3, 4, 5, 6, 7].map(x => idx(x, 0))))
  expect(s.status).toBe('found')
  expect(s.plan!.steps.some(st => st.pose === idx(3, 1))).toBe(true)
})
it('fails, never loops, when every cell is taken', () => {
  const { port, idx } = corridor(['....']), table = new ReservationTable(32)
  for (let t = 1; t <= 32; t++) table.reserve(2, t, [0, 1, 2, 3].map(x => idx(x, 0)))
  const s = run(new SpaceTimeSearch(port, table, 1, idx(0, 0), 0, [idx(3, 0)]))
  expect(s.status).toBe('failed')
})
it('is deterministic: same inputs, same plan and the same mixState', () => {
  const make = () => { const { port, idx } = corridor(['........']), table = new ReservationTable(32); table.reserve(2, 5, [idx(2, 0)]); return run(new SpaceTimeSearch(port, table, 1, idx(0, 0), 0, [idx(7, 0)])) }
  const a = make(), b = make(), sig = (s: SpaceTimeSearch) => { const v: number[] = []; s.mixState(n => v.push(n)); return v }
  expect(a.plan).toEqual(b.plan); expect(sig(a)).toEqual(sig(b))
})
```

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement** an A* over states `(pose, t)` with `t ≤ startTick + table.window`.
  - **Key**: `pose * 64 + (t - startTick)`.
  - **Actions**:
    - wait: `t + 1`, requires `free(owner, t + 1, cellsOf(pose))`;
    - step: for `d = 0..3`, `q = neighbor(pose, d)` that is `allowed`, inside the radius box around `start` (|dx|,
      |dz| ≤ radius, |dy| ≤ 4), with `k = ticksOf`, requiring `free(owner, t + i, stepCells(pose, q))` for
      i = 1..k.
  - **Cost**: `g` = ticks elapsed.
  - **Heuristic**: `h = min_i(4 * manhattan(pose, targets[i]) + 4 * (targets.length - 1 - i))`.
  - **Goal on pop**: the pose equals `targets[i]` (rejoin `i`), or `t = startTick + window` (pocket).
  - **Budget**: 1 op per pop and 1 per action tried. Past `maxOps`, the search fails.
  - **Reconstruct**: compress consecutive waits into `until`.

- [ ] **Step 4: Run.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(workers): bounded space-time repair search`.

### Task C4: Priorities, repairs, preemption and make-way

**Files:**
- Modify: `packages/engine/src/sim/workers/workers.ts`
- Test: `packages/engine/test/workers.test.ts`

**Interfaces:**
- Consumes: `SpaceTimeSearch`, `ReservationTable`, `Unit.conflict`, and `effectivePriority` from `frontier.ts`
  (Task F1). If F1 has not merged yet, use `o.priority` and switch to `effectivePriority` at the integration rebase.
- Produces:
  - `Unit.stuck` (ticks without progress; progress = position change or work progress).
  - `Unit.repair: SpaceTimeSearch | null`.
  - `private priority(u): number` = (task order effective priority, or 128 for moves) + `min(64, floor(stuck / 20))`.
  - `private rotation(u): number` = `((u.id * 2654435761) ^ (this.time >> 6)) >>> 0`, the tie-breaker.
  - Constant `MAX_REPAIRS = 8` per tick.

- [ ] **Step 1: Failing tests**, as `Simulation` scenarios in `workers.test.ts`:

```ts
/** Walls along z=4 and z=6 (y 4..5) for x 2..29 and caps at x=2 and x=29: a one-wide corridor on z=5. Optional pocket cells open z=6. */
function corridorWorld(pockets: [number, number][] = []) {
  return make(ctx => {
    for (let x = 2; x <= 29; x++) for (let y = 4; y < 6; y++) { ctx.set(x, y, 4, 1); if (!pockets.some(([px, pz]) => px === x && pz === 6)) ctx.set(x, y, 6, 1) }
    for (let y = 4; y < 6; y++) { ctx.set(2, y, 5, 1); ctx.set(29, y, 5, 1); for (const [px] of pockets) ctx.set(px, y, 7, 1) }
  })
}
function noOverlap(sim: Simulation, tick: number) {
  const seen = new Map<number, number>()
  for (const u of sim.workers!.units.values()) for (const p of u.cells) { expect(seen.get(p), `cell ${p} tick ${tick}`).toBeUndefined(); seen.set(p, u.id) }
}
it('two units meet head-on in a one-wide corridor with a pocket and both arrive', () => {
  const sim = corridorWorld([[15, 6]]); spawn(sim, [3, 4, 5]); spawn(sim, [28, 4, 5])
  cmd(sim, { type: 'unitMove', ids: [1], pos: [28, 4, 5] }); cmd(sim, { type: 'unitMove', ids: [2], pos: [3, 4, 5] })
  for (let i = 0; i < 1500 && [...sim.workers!.units.values()].some(u => u.goal !== null); i++) { sim.step(); noOverlap(sim, i) }
  expect(sim.workers!.view(1)).toMatchObject({ state: 'idle', x256: 28 * 256 + 128 })
  expect(sim.workers!.view(2)).toMatchObject({ state: 'idle', x256: 3 * 256 + 128 })
})
it('despawning a unit mid-corridor frees its reservations at once', () => {
  const sim = corridorWorld(); spawn(sim, [3, 4, 5]); cmd(sim, { type: 'unitMove', ids: [1], pos: [28, 4, 5] })
  until(sim, () => (sim.workers!.view(1)?.x256 ?? 0) > 10 * 256)
  cmd(sim, { type: 'unitDespawn', ids: [1] })
  const t = sim.workers!.table
  expect(t.horizon(1)).toBe(t.now - 1)
  for (let x = 3; x <= 28; x++) expect(t.owner(sim.store.layout.voxelIndex(x, 4, 5), t.now + 1)).toBe(0)
})
```

  Write these the same way, with `corridorWorld`, `noOverlap` and `until`:
  - **Two-wide corridor**: walls at z=4 and z=7, so z=5 and z=6 are open. 10 units spawn at x=3..12 on z=5 and z=6
    going east, and 10 at x=19..28 going west. Every unit ends at its goal within 2,000 ticks, and `noOverlap` holds
    every tick.
  - **X crossing**: four units at (16,4,3), (16,4,28), (3,4,16), (28,4,16), each ordered to the opposite side through
    one-wide corridors that cross at (16,4,16). All four arrive within 1,500 ticks.
  - **Idle unit in the corridor**: unit 2 is spawned at (15,4,5) with no order, and there is a pocket at (14,6). Unit 1
    walks from x=3 to x=28. Unit 1 arrives; unit 2 ends idle anywhere but (15,4,5) or back on it, and was never
    overlapped.
  - **Working unit in a passage**: there is a dig order at (15,4,4) in the corridor wall for unit 2, standing at
    (15,4,5), and a pocket at (10,6). Unit 1 walks through. Unit 2's progress keeps increasing every tick until its dig
    completes (it is never displaced); unit 1 arrives after it.
  - **No pocket**: the head-on scenario without the pocket. After 1,500 ticks, at least one unit is `blocked` with
    `reason: 'traffic'`, or one passed. Neither unit changes `state` more than 40 times (no endless alternation).
  - **Replay**: the head-on scenario run twice from the same commands gives the same `sim.hash()` every 50 ticks.

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement**, inside `afterPhysics`, after the per-unit loop and before `assign()`.
  1. Collect the units with `conflict`, sort them by `(priority desc, rotation asc, id asc)`, and take up to
     `MAX_REPAIRS`.
  2. For each unit `u` with conflict owner `o`:
     - **Preempt**: if `o` is moving (no hold), `priority(u) > priority(o)` and `u.stuck >= 20`, then
       `table.releaseFrom(o.id, conflict.t)`, set `o.projection` to stop at `conflict.t - 1`, set
       `o.conflict = { t: conflict.t, owner: u.id }` (so `o` repairs next tick), and re-project `u`.
     - **Make way**: if `o` holds and is idle with no task and no goal, give `o` a make-way search:
       `request(o, [], undefined, p => !uProjected.has(p) && safePose(p))` within radius 4 (an `accept` search, as
       the exposure escape). `u` waits.
     - **Repair**: otherwise `u.repair = new SpaceTimeSearch(port, table, u.id, pose(u), time, u.path.slice(u.cursor, u.cursor + 24))`.
  3. Step each active repair with the shared budget: `nav.step` gets `searchCap - engineeringWork - repairWork`.
  4. On `found`:
     - replace `u.path` with the plan's poses followed by `path.slice(cursor + rejoin + 1)`. A pocket keeps the pocket
       as the last pose and then replans the rest;
     - store the `until` ticks in `u.schedule`;
     - the executor does not start the step from `steps[i]` before `until`;
     - re-project.
  5. On `failed`, fall back to today's `yield(u)` path (wait 12 / 80, sidestep, then `block(u, 'traffic')`).
  6. **Yield priority**: replace the id comparison in `yield()` (`owner > u.id`) and in the motion conflict branch
     (`owner > u.id && other && …`) with `priority(other) > priority(u)`, then `rotation`, then id.
  7. **Hash**: mix `stuck`, `schedule` and `repair?.mixState`.

- [ ] **Step 4: Run** the whole engine suite. Expected: PASS.

- [ ] **Step 5: Commit** `feat(workers): aged priorities, space-time repairs, preemption and make-way`.

### Task C5: Traffic and churn at scale

**Files:**
- Modify: `apps/sandbox/bench/crowd.node.ts` (no new code if Task 0 covered the phases; add asserts behind `--assert`)
- Test: `packages/engine/test/workers.test.ts`

- [ ] **Step 1: Failing test, the churn scenario:** 20 units walking across a 128² world; every 10 ticks a
  1 × 3 × 3 wall appears on the next path node of the lowest walking id. After 1,500 ticks:
  - every unit is idle at its goal, or blocked with `no-access` because a wall sealed its goal;
  - no body cell is ever inside a solid voxel (check every tick);
  - the overlap invariant holds.

- [ ] **Step 2: Run, fix, pass.**

- [ ] **Step 3: Add `--assert`** to the bench. It exits non-zero when any spec §7 criterion fails for a phase, using
  the workers' share and the first-action numbers.

- [ ] **Step 4: Commit** `test(workers): churn scenario; crowd bench asserts the success criteria`.

---

## Stream F — frontier

### Task F1: Effective priority and aging

**Files:**
- Create: `packages/engine/src/sim/workers/frontier.ts`
- Modify: `packages/engine/src/sim/workers/workers.ts`, `types.ts`
- Test: `packages/engine/test/frontier.test.ts`

**Interfaces:**
- Produces:
  - `AGE_TICKS = 100` (5 s); `AGE_CAP = 64`;
  - `effectivePriority(priority: number, idleSince: number, now: number): number` = `priority + min(AGE_CAP, floor((now - idleSince) / AGE_TICKS))`;
  - `Order.idleSince` (the tick of the order's last progress, reset on any task done);
  - `WorkOrderView.effectivePriority`.

- [ ] **Step 1: Failing tests:**

```ts
it('ages by one per 5 s without progress, capped at +64', () => {
  expect(effectivePriority(64, 0, 99)).toBe(64)
  expect(effectivePriority(64, 0, 100)).toBe(65)
  expect(effectivePriority(64, 0, 100 * 1000)).toBe(128)
})
```

  `workers.test.ts`: an old low-priority dig order whose crew is busy elsewhere for 600 ticks overtakes a new
  priority-70 order in `assign` order. Assert on `publication().orders[i].effectivePriority` and on which order's
  task the next idle unit takes.

- [ ] **Step 2: Run, implement, pass.** Use `effectivePriority` in the `expand()` sort, in the `assign()` candidate
  sort (`b.order.priority - a.order.priority`), and in `park()` (Task F2). Mix `idleSince`. Set `idleSince = time` on
  order creation and in `removeTask(t, true)`.

- [ ] **Step 3: Commit** `feat(workers): orders age while they wait`.

### Task F2: Fair shares and parking

**Files:**
- Modify: `packages/engine/src/sim/workers/frontier.ts`, `workers.ts`
- Test: `packages/engine/test/frontier.test.ts`, `workers.test.ts`

**Interfaces:**
- Produces:
  - `shares(orders: { id: number; weight: number; open: number }[], slots: number, min = 8): Map<number, number>`.
    Slots go in proportion to weight, at least `min` (or `open` if smaller), never more than `open` (cells the order
    can still expose). Leftovers are redistributed by weight; ties go to the lower id. The sum is ≤ `slots`.
  - `parkChoice(tasks: { i: number; priority: number; added: number; claimed: boolean; parkable: boolean }[]): number`.
    It returns the index of the unclaimed parkable task with the lowest priority, then the oldest `added`, then the
    lowest `i`, or -1.
  - `Order.noCrewSince` (tick since no eligible unit was available; -1 when one is).

- [ ] **Step 1: Failing tests:**

```ts
it('splits 256 slots by weight with a floor of 8 and never beyond what an order can expose', () => {
  const s = shares([{ id: 1, weight: 128, open: 1000 }, { id: 2, weight: 128, open: 5 }, { id: 3, weight: 64, open: 1000 }], 256)
  expect(s.get(2)).toBe(5)
  expect(s.get(1)! + s.get(3)!).toBe(251)
  expect(s.get(1)! > s.get(3)!).toBe(true)
  expect(s.get(3)!).toBeGreaterThanOrEqual(8)
})
```

  `workers.test.ts`:
  - a 400-cell dig order and a later 4-cell order: both progress within 400 ticks (today the second starves);
  - a high-priority order submitted while the frontier is full gets tasks on the next tick;
  - the park choice evicts a low-priority task before a high-priority one.

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `expand()` computes `shares` once per tick from the active orders: `weight = effectivePriority`,
    `open = remaining exposable cells`, the latter capped by the build ring rules exactly as the loop already gates
    them. It exposes each order up to its share.
  - A task is `parkable` when its order's count in the frontier exceeds its share, or `noCrewSince >= 0` and
    `time - noCrewSince >= 100`, or `reason !== undefined`.
  - `park()` uses `parkChoice`.
  - Update `noCrewSince` in `expand()` from `hasWorker`.
  - Mix the shares inputs (`noCrewSince`).

- [ ] **Step 4: Run** the whole engine suite. The living scene's quarry test in `apps/sandbox/test/living.test.ts`
  must still pass: `npm test -w @elovox/sandbox -- living`.

- [ ] **Step 5: Commit** `feat(workers): fair frontier shares and priority-aware parking`.

### Task F3: Work-pose claims and claim leases

**Files:**
- Modify: `packages/engine/src/sim/workers/workers.ts`
- Test: `packages/engine/test/workers.test.ts`

**Interfaces:**
- Produces: `Unit.progressAt` (the tick of the last move or work progress); `LEASE_TICKS = 200`.

- [ ] **Step 1: Failing tests:**
  - Two adjacent dig tasks with two idle units next to them: both units work at the same time, and neither unit ever
    reports `traffic` (today the first unit's 12 provisional poses block the second).
  - A unit whose task is claimed but who cannot move: put it in a pit it cannot leave, with its goal pose
    unreachable after a fill. Within 200 ticks the task's claim is 0 and its failure is recorded.

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement.**
  - In `assign()`, stop writing every goal to `workPositions` (`for (const p of goals) this.workPositions.set(p, u.id)`).
    Keep `u.workPoses = goals` as the search goal set only.
  - At adoption (`if (u.task) { this.releaseWorkPoses(u); … }`), claim only `s.path.at(-1)` as today. If another unit
    holds that pose by then, re-request with the remaining free goals.
  - `workGoals` keeps filtering out poses claimed in `workPositions` or occupied, and adds poses held in the
    reservation table when Stream C is present.
  - **Lease**: every tick, a unit with a task whose `time - progressAt >= LEASE_TICKS` (and that is not falling)
    calls `block(u, 'traffic')`. That releases the claim and records the failure through the existing path.
  - Mix `progressAt`.

- [ ] **Step 4: Run** the whole engine suite. Expected: PASS.

- [ ] **Step 5: Commit** `feat(workers): claim only the final work pose; leases release stuck claims`.

### Task F4: Assignment at scale

**Files:**
- Modify: `packages/engine/src/sim/workers/workers.ts`
- Test: `packages/engine/test/workers.test.ts`, `apps/sandbox/bench/crowd.node.ts` (`work` phase)

**Interfaces:**
- Produces:
  - `private taskIndex: Map<number /* chunk column */, Task[]>`, maintained on task add and remove.
  - `assignmentCap` default becomes `max(16, ceil(idle / 8))` per tick, read from a new
    `WorkerOptions.assignmentShare` (default 8).

- [ ] **Step 1: Failing test:** 200 idle units and 200 one-cell dig tasks spread over a 256² world. All 200 units are
  working within 60 ticks, and `visited` never exceeds the cap.

- [ ] **Step 2: Run.** Expected: FAIL (16 per tick needs 13 ticks of assignment alone, but the 256-sort per unit
  dominates).

- [ ] **Step 3: Implement.**
  - The candidate list comes from the unit's chunk column and its 8 neighbours. Widen ring by ring until 16
    candidates or ring 4, then fall back to all tasks.
  - The candidate order is unchanged (effective priority, distance, order id, position).
  - The attempt limit stays 8.

- [ ] **Step 4: Run** the suite and the `work` phase of the bench (no gate yet).

- [ ] **Step 5: Commit** `perf(workers): spatial task index and assignment proportional to idle units`.

---

## Stream V — view

### Task V1: Tick numbers, precise barriers, mesh failure and `preFrame`

**Files:**
- Modify: `packages/engine/src/sim/workers/types.ts`, `workers.ts`, `packages/engine/src/engine.ts`
- Test: `packages/engine/test/workers.test.ts`

**Interfaces:**
- Produces:
  - `WorkerTick.tick: number` (the sim tick of the publication, set in `Simulation` where `publication()` is called;
    pass the tick into `publication(versions, tick)`).
  - `WorkerTick.barriers: { unit: number; pos: Vec3; chunks: { chunk: number; version: number }[] }[]`. `chunks` =
    every chunk containing a voxel of the 3 × 3 × 3 box around `pos`, deduplicated and sorted.
  - `Engine.meshFailed(ci: number): boolean` (reads the existing `failed` set at `engine.ts` near line 398).
  - `EngineEvents.preFrame: { dt: number; now: number }`, emitted at the top of the animation loop, before the camera
    update.

- [ ] **Step 1: Failing test:** a dig at a chunk corner (31, 4, 31) in a 64³ world publishes one barrier whose
  `chunks` lists the 8 chunks around that corner (2 × 1 × 2 here, since y 3..5 stays in chunk row 0), with
  `unit === 1`. `tick` equals the `Simulation` tick.

- [ ] **Step 2: Run, implement, pass.**
  - In `beforePhysics`, replace `this.barriers.add(chunkOf(...))` with a list of `{ unit, pos }`.
  - `publication` expands each entry to chunks and reads `versions`.
  - In `engine.ts`, emit `preFrame` before `if (cameraMode === 'orbit') …`.
  - Export `meshFailed` on the engine object.
  - Update `apps/sandbox/src/workersView.ts` minimally to compile: map the new barrier shape to its chunks.

- [ ] **Step 3: Typecheck** (`npm run typecheck`) and the engine suite.

- [ ] **Step 4: Commit** `feat(engine): worker ticks carry tick numbers and per-edit barriers; preFrame event`.

### Task V2: Sim-time pose playback

**Files:**
- Create: `apps/sandbox/src/poseTimeline.ts`
- Test: `apps/sandbox/test/poseTimeline.test.ts`

**Interfaces:**
- Produces:

```ts
export const TICK_MS = 50, DELAY_MS = 75, HISTORY = 4
export class PoseTimeline {
  /** Records a publication: its tick, poses (stride 9) and wall-clock receipt time. */
  push(tick: number, poses: Int32Array, receivedAt: number): void
  /** Positions in blocks at wall-clock `now`, interpolated between the two ticks around now - offset - DELAY_MS; ids not present in the newest tick are dropped. */
  sample(now: number, out: Map<number, { x: number; y: number; z: number; facing: number }>): void
  /** The smoothed offset between wall clock and sim time (ms). */
  readonly offset: number
}
```

  The offset is the lower envelope of `receivedAt - tick * TICK_MS`: it follows decreases at once and increases by at
  most 1 ms per push, so late messages do not stretch time. Past the newest tick, positions hold the newest value (no
  extrapolation).

- [ ] **Step 1: Failing tests:**

```ts
it('moves at constant speed when messages arrive with jitter', () => {
  const t = new PoseTimeline(), out = new Map()
  const pose = (tick: number) => Int32Array.from([1, tick * 64, 1024, 128, 0, 2, 0, 0, 0])
  const arrivals = [0, 61, 95, 160, 199, 262, 300]   // ±12 ms jitter around 50 ms
  arrivals.forEach((at, tick) => t.push(tick, pose(tick), at))
  const xs: number[] = []
  for (let now = 200; now <= 300; now += 10) { t.sample(now, out); xs.push(out.get(1).x) }
  const steps = xs.slice(1).map((x, i) => x - xs[i]!)
  for (const s of steps) expect(s).toBeCloseTo(steps[0]!, 1)
})
it('does not skip a tick when two arrive between frames', () => {
  const t = new PoseTimeline(), out = new Map()
  t.push(0, Int32Array.from([1, 0, 0, 0, 0, 2, 0, 0, 0]), 0)
  t.push(1, Int32Array.from([1, 256, 0, 0, 0, 2, 0, 0, 0]), 100)
  t.push(2, Int32Array.from([1, 256, 0, 256, 0, 2, 0, 0, 0]), 100)
  t.sample(100 + DELAY_MS + 25 - 50, out)   // midway between ticks 1 and 2 on sim time
  expect(out.get(1).x).toBeCloseTo(1, 1)
})
it('holds the newest pose when the sim is late instead of extrapolating', () => {
  const t = new PoseTimeline(), out = new Map()
  t.push(0, Int32Array.from([1, 0, 0, 0, 0, 2, 0, 0, 0]), 0); t.push(1, Int32Array.from([1, 256, 0, 0, 0, 2, 0, 0, 0]), 50)
  t.sample(5000, out); expect(out.get(1).x).toBe(1)
})
```

- [ ] **Step 2: Run, implement, pass.** Keep at most `HISTORY` publications. Interpolate x/y/z linearly; take facing
  from the later sample.

- [ ] **Step 3: Commit** `feat(sandbox): sim-time pose playback`.

### Task V3: The view uses the timeline, `preFrame` and precise barriers

**Files:**
- Modify: `apps/sandbox/src/workersView.ts`
- Test: `apps/sandbox/test/workersView.test.ts`

- [ ] **Step 1: Failing tests** (extend the existing stub engine: add `meshFailed`, and emit `preFrame` instead of
  `frame`):
  - a barrier holds only its `unit` and units whose drawn position is within 1 block of `pos`; a unit 3 blocks away
    keeps moving;
  - a barrier whose chunk `meshFailed` releases on the next frame;
  - the hold cap is 250 ms;
  - unit positions are set in `preFrame` (assert they changed before a `frame` event fires).

- [ ] **Step 2: Run, implement, pass.**
  - Replace `previous`/`alpha` with a `PoseTimeline`: on `workers`, push `(tick.tick, tick.poses, performance.now())`;
    on `preFrame`, sample.
  - Barriers are stored per edit (`{ unit, pos, chunks, since }`). One is released when every chunk has
    `meshVersion(ci) >= version` or `meshFailed(ci)`, or after `BARRIER_TIMEOUT_MS = 250`.
  - `held(u, position)` = `u.id === b.unit` or position within 1.5 blocks of `b.pos` (centre distance).
  - Keep the frame-dependent animation work (mixer update, heading turn) where it is, now in `preFrame`.

- [ ] **Step 3: Sandbox suite and typecheck.**

- [ ] **Step 4: Commit** `feat(sandbox): units play back on sim time and wait only for the edits they touch`.

---

## Integration tasks (after the four streams merge)

### Task X1: The crowd scene

**Files:**
- Create: `apps/sandbox/src/crowd.worker.ts` (copy `terrain.worker.ts`'s pattern; check `living` wiring in `main.ts`)
- Modify: `apps/sandbox/src/main.ts` (scene `crowd`: size `CROWD_SIZE`, doc `crowd.terrain.json`, gen worker,
  `workers: CROWD_WORKER_OPTIONS`, the workers view without demo buttons, plus the HUD buttons below)
- Create: `apps/sandbox/e2e/crowd.spec.ts`

- [ ] **Step 1: Wire the scene.** Buttons: *Spawn 1,000*, *All → east*, *Scatter*, *Bottleneck*, *Work orders*.
  Expose `window.__elovox.crowd` with the same functions, as `living` does. Use `?units=N` to override the count
  (the e2e uses 50).

- [ ] **Step 2: E2E** `crowd.spec.ts`. Load `?scene=crowd&units=50`, wait for ready, spawn, all → east. Within 30 s
  at least 45 units are `walking` or `idle` at the east pad, with no console errors. Run:
  `E2E_PORT=5196 E2E_CHANNEL=msedge npm run e2e -- --workers=1 crowd.spec.ts`. Expected: PASS.

- [ ] **Step 3: Commit** `feat(sandbox): crowd scene for 1,000 units on the 1024² world`.

### Task X2: Decision records and glossary

**Files:**
- Create: `docs/adr/0003-hierarchical-routes-and-reservations.md`
- Modify: `docs/adr/0002-sparse-worker-navigation.md`, `CONTEXT.md`

- [ ] **Step 1: ADR 0003** (same short style as 0002). It records:
  - the region layer: geometry only, exits, reverse fields, exact, so unreachable is a proof;
  - group fields;
  - the reservation table, the window of 32 and repairs;
  - aged priority;
  - the cache determinism rule (derived, unhashed, a pure function of the history).

- [ ] **Step 2: ADR 0002.** Replace the sentence about "exact straight region-boundary shortcuts" with what existed:
  flat A* plus execution-time string-pulling. Point to ADR 0003.

- [ ] **Step 3: `CONTEXT.md`**: add **Portal** (an exit run between two regions; one-way when it drops; _Avoid_:
  door, waypoint) and **Reservation window** (the 32 ticks of (cell, tick) a walking unit reserves ahead; a still unit
  holds its cells with no end; _Avoid_: lock, path claim). Rename the navigation test title "reconstructs every local
  step of long portal shortcuts" to "reconstructs every local step of a long flat route".

- [ ] **Step 4: Commit** `docs(5b): ADR 0003, ADR 0002 correction, glossary`.

### Task X3: Gate, report and user checkpoint

- [ ] **Step 1:** Full verification on the integration branch:
  - `npm run typecheck`;
  - `npm test`;
  - the full e2e: `E2E_PORT=5196 E2E_CHANNEL=msedge npm run e2e -- --workers=1`.

  All green.
- [ ] **Step 2:** Run `crowd.node.ts --assert` twice in a quiet window, and keep the worse values. Save
  `docs/superpowers/research/2026-10-09-crowd-final.json`. Every spec §7 target must pass. If one misses, the expert
  decides between a tuning task and escalating to the user.
- [ ] **Step 3:** Run the living bench (`apps/sandbox/bench/living.node.ts`) against `main` in an interleaved A/B,
  and the headed living gate if the expert asks. It must be no worse.
- [ ] **Step 4:** Write `docs/superpowers/reviews/2026-10-09-navigation-at-scale.md`. Cover:
  - what was delivered;
  - the result tables against the baseline;
  - the planning deviations and how they held;
  - what is still open.
- [ ] **Step 5:** User checkpoint (through main): `?scene=crowd`. The user judges playback smoothness, the crowd
  moving, and the bottleneck crossing.
- [ ] **Step 6: Commit** `docs(5b): final report and benchmark results`.
