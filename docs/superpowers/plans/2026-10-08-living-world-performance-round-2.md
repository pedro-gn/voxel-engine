# Living-World Performance, 4a Round 2: Implementation Plan (part 1: #5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring dam and collapse sim tick p95 to ≤ 10 ms by making the water publish cheaper (#5), with bit-identical
output. #2 (water apply in a worker) gets its own part of this plan, appended once #5 is measured.

**Architecture:** `WaterPublisher.records()` (`packages/engine/src/sim/water/publish.ts`) is rewritten with the same output:
- no per-column closures;
- flux sums in stamped typed arrays instead of `Map`s;
- links computed by walking the neighbour's chain in place, ranks counted on the way.

A golden characterization test, written first and passing on the old code, pins the output. A Node A/B in a quiet window
attributes the gain, and the living benchmark gates it.

**Tech Stack:** TypeScript, Vitest, Node 24 (`--experimental-strip-types`), Playwright (Edge channel), `@elovox/engine`.

**Spec:** `docs/superpowers/specs/2026-10-08-living-world-performance-round-2-design.md` (§3 for this part)

## Global Constraints

- **Targets**, per benchmark phase, worse of two runs, reference desktop, production build:
  - fps p5 ≥ 60;
  - sim tick p95 ≤ 10 ms;
  - main-thread water apply p95 ≤ 4 ms.
- **No behaviour change:**
  - the water state hashes, the units' deterministic replay and every unit and e2e suite stay green;
  - `?nobatch` keeps working.
- **One optimization per commit.** Before/after numbers come from an interleaved, alternating-order A/B in one quiet window
  (A B B A). Gates use the worse of two runs, also in a quiet window.
- **Quiet windows:**
  - Ask the expert with `WINDOW REQUEST: <what>, <est. minutes>`; at most 30 minutes.
  - Record free RAM at start and end with `(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory`. Abort if below
    8 GB.
  - Send DONE when finished.
- **Port 5184 for everything:** `E2E_PORT=5184`, and manual servers with `--port 5184 --strictPort`.
- **Playwright wipes `test-results/` at the start of a run.** Keep builds and scratch outside it.
- **Paths:** new data goes in `docs/superpowers/research/2026-10-08-living-r2-*.json`, committed right after its window.
  Repo artifacts in English.
- **Commits:** `type(scope): message`, no `Co-Authored-By` trailer, never pushed. In PowerShell use
  `git -C C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf …`: the shell's cwd is the main checkout.
- **Before any water-step refactor** (spec §3.1, follow-up 2), send the expert a note with the new profile.

### Planning deviation from the spec

- **`linkOf` is removed, not kept as a reference.** `links.ts` has no other caller; the publisher was its only one. The
  golden test (Task 1), recorded on the old code that used `linkOf`, is the reference instead. Dead code was a finding in
  4a's review.
- **The A/B numbers go in the results commit (Task 3).** The refactor commit (Task 2) is made before its window, so the
  work is not lost if the run ends. Task 3's commit message carries the A/B numbers for Task 2's SHA.

## Review Focus

1. **Tile order dependence through `U.shown`.** The hysteresis loop updates `U.shown` for one tile's columns before its
   records. A neighbour column in a later tile is read with its old flag, so tile order is part of the output. Expect the
   rewrite to keep the tile loop and the per-tile hysteresis pass exactly in place. Test: the golden world has layered
   water crossing tile borders (Task 1).
2. **Ranks past RANKS − 1** (5 stacked caves). Expect `hidden` and the `LINK_WALL` for a neighbour ranked past 3 to be
   unchanged. Test: the golden world's stack, with an assertion that `layersHidden` > 0 at some tick (Task 1).
3. **Lower-segment capacity growth mid-publish.** `UnderSegments.grow` replaces its arrays, and new refs go past the
   scratch's length. Expect the stamped sums to be resized from `n + U.col.length` at every publish. Test: the golden world
   opens new caves mid-run (shaft, pit), so segments are allocated after the first publish (Task 1).
4. **Ties between neighbour segments with the same floor.** `linkOf` keeps the first one met bottom-up (strict `>` / `<`).
   Expect the in-place walk to visit in the same order, lower chain bottom-up then the top. Test: the golden hash
   (Task 1).
5. **Records at the world's border.** A link to outside the world is 0 without a lookup. Expect the same. Test: the golden
   world's lake and stack touch no border, but the valley reaches x 30 and the pit x 60 near the 64-wide border; the hash
   covers both.

---

### Task 1: Golden characterization test of the water publish

**Files:**
- Create: `packages/engine/test/waterPublishGolden.test.ts`

**Interfaces:**
- Consumes: `Simulation`, `createWorldBuffers`, `WATER_BLOCKS`, `B`, `w`, `fillGenerator` (test/waterHelpers.ts).
  `sim.step().water` is the tick's `WaterTick | null`. `sim.water.stats().layersHidden`.
- Produces: `GOLDEN` hash constant. Task 2 must keep the test green.

- [ ] **Step 1: Write the test, with `GOLDEN = 0`**

```ts
import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import { RECORD } from '../src/sim/water/links.ts'
import { TILE } from '../src/sim/water/constants.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, WATER_BLOCKS, fillGenerator, w, type Fill } from './waterHelpers.ts'

/** The hash of every publish of the world below over TICKS ticks, recorded on the code before 4a round 2 #5. */
const GOLDEN = 0
const TICKS = 160
const SIZE: [number, number, number] = [64, 32, 32]

/**
 * x < 32: a lake (x 1–10, z 1–10, water y 10–15) over a dry cave (y 2–7), beside a valley (x 12–30, z 1–10, air y 2–20) with a
 * deck at y 14 over x 14–22; stone to y 20 elsewhere.
 * x ≥ 32: five 2-high caves stacked at y 2, 5, 8, 11, 14 under x 34–45, z 3–12, each holding one block of water (ranks 1–5:
 * 4 and 5 are hidden), and a sealed chamber full of water (x 50–55, z 20–25, y 2–5); stone to y 20 elsewhere.
 */
const world: Fill = (x, y, z) => {
  if (y === 0) return B.stone
  if (x < 32) {
    if (x >= 1 && x <= 10 && z >= 1 && z <= 10) {
      if (y >= 2 && y <= 7) return AIR
      if (y <= 9) return B.stone
      return y <= 15 ? w(7) : AIR
    }
    if (x >= 12 && x <= 30 && z >= 1 && z <= 10 && y >= 2 && y <= 20) return x >= 14 && x <= 22 && y === 14 ? B.stone : AIR
    return y <= 20 ? B.stone : AIR
  }
  if (x >= 34 && x <= 45 && z >= 3 && z <= 12 && y >= 2 && y <= 16) {
    const k = (y - 2) % 3
    return k === 0 ? w(7) : k === 1 ? AIR : B.stone
  }
  if (x >= 50 && x <= 55 && z >= 20 && z <= 25 && y >= 2 && y <= 5) return w(7)
  return y <= 20 ? B.stone : AIR
}

/** Edits by tick: the dam hole and the cave's roof hole, then a shaft beside the stack, then a pit that opens the chamber. */
const EDITS: Record<number, { min: [number, number, number]; max: [number, number, number] }[]> = {
  0: [{ min: [11, 10, 5], max: [11, 11, 6] }, { min: [5, 8, 5], max: [5, 9, 5] }],
  30: [{ min: [46, 2, 7], max: [46, 16, 7] }],
  60: [{ min: [56, 1, 20], max: [60, 5, 25] }],
}

describe('water publish golden (4a round 2 #5)', () => {
  it('publishes exactly what the code before #5 published, tick by tick', () => {
    const buffers = createWorldBuffers(SIZE)
    const sim = new Simulation({ buffers, blocks: WATER_BLOCKS, seed: 1, log: () => {}, randomTicksPerChunk: 0 })
    const gen = fillGenerator(world)
    sim.configure(gen, null)
    sim.generate(gen)
    const n = SIZE[0] * SIZE[2], tx = SIZE[0] / TILE
    const surface = new Int32Array(buffers.water.surface), flux = new Int16Array(buffers.water.flux)
    let h = 0x811c9dc5
    const mix = (v: number) => { h = Math.imul(h ^ (v | 0), 0x01000193) >>> 0 }
    let seq = 0, rank0 = 0, lower = 0, maxHidden = 0
    for (let tick = 0; tick < TICKS; tick++) {
      for (const e of EDITS[tick] ?? []) sim.submit(0, ++seq, { type: 'fillRegion', min: e.min, max: e.max, voxel: AIR })
      const t = sim.step().water
      const hidden = sim.water.stats().layersHidden
      mix(tick); mix(hidden); maxHidden = Math.max(maxHidden, hidden)
      if (!t) { mix(-2); continue }
      mix(t.seq); mix(t.parity); mix(t.tiles.length)
      const base = t.parity * n
      for (const tile of t.tiles) {
        mix(tile)
        const x0 = (tile % tx) * TILE, z0 = Math.floor(tile / tx) * TILE
        for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) {
          const c = base + x + z * SIZE[0]
          mix(surface[c]!); mix(flux[2 * c]!); mix(flux[2 * c + 1]!)
        }
      }
      if (!t.layers) { mix(-1); continue }
      mix(t.layers.length)
      for (const v of t.layers) mix(v)
      // Coverage: walk the records (per tile: tile, count, then count × RECORD ints) and count ranks.
      for (let i = 0; i < t.layers.length;) {
        const count = t.layers[i + 1]!
        for (let r = 0; r < count; r++) {
          const rank = t.layers[i + 2 + r * RECORD]! >> 8
          if (rank === 0) rank0++
          else lower++
        }
        i += 2 + count * RECORD
      }
    }
    // The world must exercise what the hash pins: top records, lower records and hidden segments.
    expect([rank0 > 0, lower > 0, maxHidden > 0]).toEqual([true, true, true])
    expect(h).toBe(GOLDEN)
  }, 60_000)
})
```

- [ ] **Step 2: Run it on the old code and record the hash**

Run: `npx vitest run --root packages/engine test/waterPublishGolden.test.ts`

Expected: FAIL only on `expect(h).toBe(GOLDEN)`, with the actual hash in the message.
- If the coverage line fails instead, change the world, not the assertion, until all three hold. The usual fix: let the
  shaft reach the stack's caves at their water rows.
- Then set `GOLDEN` to the actual hash.

- [ ] **Step 3: Run it again**

Run: `npx vitest run --root packages/engine test/waterPublishGolden.test.ts`. Expected: PASS.

- [ ] **Step 4: Prove it is not vacuous**

In `publish.ts` `records()`, temporarily swap two links: change `this.push(l2 | (l3 << 16))` to
`this.push(l3 | (l2 << 16))`. Run the test. Expected: FAIL on the hash. Revert, and check with
`git -C <worktree> diff --stat` that only the new test file is changed. Rerun: PASS.

- [ ] **Step 5: Commit**

```powershell
git -C C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf add packages/engine/test/waterPublishGolden.test.ts
git -C C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf commit -m "test(water): golden hash of every publish over a layered world, recorded before 4a-r2 #5"
```

### Task 2: `records()` without closures, maps or chain arrays

**Files:**
- Modify: `packages/engine/src/sim/water/publish.ts`: imports; the scratch fields `segs`, `chain`, `fx`, `fz` are replaced;
  `records()` is rewritten; `record()` and `link()` are added.
- Modify: `packages/engine/src/sim/water/links.ts`: remove `linkOf` and the now unused imports
  (`ceilOf`/`depthOf`/`floorOf`/`segmentsOf`, if nothing else in the file uses them).
- Test: `packages/engine/test/waterPublishGolden.test.ts` (unchanged), plus the existing water suites.

**Interfaces:**
- Consumes: `LINK_GROUND`, `LINK_WALL`, `SIDE_X`, `SIDE_Z` from `links.ts`; `RANKS`, `SUB`, `TILE` from `constants.ts`;
  `moved` from `columns.ts`.
- Produces: the same `WaterPublisher` API, with no visible change.

- [ ] **Step 1: Confirm the baseline is green**

Run: `npx vitest run --root packages/engine test/waterPublishGolden.test.ts test/waterPublish.test.ts test/waterLinks.test.ts test/surfaceLayers.test.ts test/waterLayersWorld.test.ts`
Expected: PASS.

- [ ] **Step 2: Replace the scratch fields**

In `WaterPublisher`, remove `segs`, `chain`, `fx` and `fz`, and add:

```ts
  /**
   * records' flux sums: water moved last step through each segment's +x / +z sides, summed over the tile's edges, by segment
   * ref. An entry counts only when its stamp is the current tile's `gen`, so nothing is cleared between tiles.
   */
  private sumX = new Float64Array(0)
  private sumZ = new Float64Array(0)
  private stampX = new Uint32Array(0)
  private stampZ = new Uint32Array(0)
  private gen = 0
```

- [ ] **Step 3: Rewrite `records()` and add `record()` and `link()`**

Replace the body of `records()` and add the two methods after it. The doc comment of `records()` stays.

```ts
  private records(tiles: readonly number[], cols: WaterColumns, U: UnderSegments, E: WaterEdges, height: number): Int32Array {
    this.recN = 0
    const n = cols.n, T = cols.tiles, sx = cols.sx, sz = cols.sz
    const refs = n + U.col.length
    if (this.sumX.length < refs) {
      this.sumX = new Float64Array(refs); this.sumZ = new Float64Array(refs)
      this.stampX = new Uint32Array(refs); this.stampZ = new Uint32Array(refs)
    }
    for (const t of tiles) {
      const x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE
      this.push(t)
      const at = this.recN
      this.push(0)
      // Records only come from a column with a lower segment or beside one: a tile with none in it or its ring has none.
      if (!this.anyLower(x0, z0, sx, sz, U)) {
        this.hidden -= this.hiddenOf.get(t) ?? 0
        this.hiddenOf.delete(t)
        continue
      }
      let count = 0, hidden = 0
      for (let z = z0; z < z0 + TILE; z++) for (let c = x0 + z * sx, e = c + TILE; c < e; c++) {
        for (let i = U.first[c]!; i >= 0; i = U.next[i]!) {
          const d = U.depth[i]!
          if (d >= SHOW_DEPTH) U.shown[i] = 1
          else if (d < HIDE_DEPTH) U.shown[i] = 0
        }
      }
      // Water moved last step through each segment's +x / +z sides, summed over its edges (the dense edge for a top).
      const gen = ++this.gen
      const L = E.tiles[t]
      if (L) for (let e = 0; e < L.count; e++) {
        const m = moved(L.flux[e]!), a = L.a[e]!
        if (L.axis[e] === 0) {
          if (this.stampX[a] === gen) this.sumX[a] = this.sumX[a]! + m
          else { this.stampX[a] = gen; this.sumX[a] = m }
        } else if (this.stampZ[a] === gen) this.sumZ[a] = this.sumZ[a]! + m
        else { this.stampZ[a] = gen; this.sumZ[a] = m }
      }
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) {
        const c = x + z * sx, local = (x - x0) + (z - z0) * TILE
        if ((U.first[c]! >= 0 || this.sideHasLower(x, z, sx, sz, U)) && this.record(c, 0, 0, cols.floor[c]!, height, c, x, z, local, cols, U, height)) count++
        // Lower segments bottom-up; the one at position j of k has rank k − j (the top is rank 0).
        let k = 0
        for (let i = U.first[c]!; i >= 0; i = U.next[i]!) k++
        let j = 0
        for (let i = U.first[c]!; i >= 0; i = U.next[i]!, j++) {
          const rank = k - j
          if (U.shown[i] !== 1) continue
          if (rank >= RANKS) { hidden++; continue }
          if (U.body[i]! >= 0 || U.depth[i]! >= U.cap(i)) continue // no free surface: its slot sinks away like a dried one
          const d = U.depth[i]!
          if (this.record(n + i, rank, U.floor[i]! * SUB + (d < SHOW_DEPTH ? SHOW_DEPTH : d), U.floor[i]!, U.ceil[i]!, c, x, z, local, cols, U, height)) count++
        }
      }
      this.rec[at] = count
      this.hidden += hidden - (this.hiddenOf.get(t) ?? 0)
      if (hidden > 0) this.hiddenOf.set(t, hidden)
      else this.hiddenOf.delete(t)
    }
    return this.rec.slice(0, this.recN)
  }

  /**
   * Pushes the record of segment ref r (rank, surface, floor, ceil) of column c at (x, z), tile-local `local`, and returns
   * true; a top whose four links are the default (0) has none (false). A side outside the world links 0.
   */
  private record(r: number, rank: number, surface: number, floor: number, ceil: number, c: number, x: number, z: number, local: number,
    cols: WaterColumns, U: UnderSegments, height: number): boolean {
    const n = cols.n, sx = cols.sx, sz = cols.sz
    const f = r < n ? cols.floor[r]! : U.floor[r - n]!, ce = r < n ? height : U.ceil[r - n]!
    const S = f * SUB + (r < n ? cols.depth[r]! : U.depth[r - n]!)
    const l0 = x + 1 < sx ? this.link(r, c, 0, cols, U, height, f, ce, S) : 0
    const l1 = x > 0 ? this.link(r, c, 1, cols, U, height, f, ce, S) : 0
    const l2 = z + 1 < sz ? this.link(r, c, 2, cols, U, height, f, ce, S) : 0
    const l3 = z > 0 ? this.link(r, c, 3, cols, U, height, f, ce, S) : 0
    if (rank === 0 && l0 === 0 && l1 === 0 && l2 === 0 && l3 === 0) return false
    const g = this.gen
    const fx = clamp16((r < n ? moved(cols.flux[2 * c]!) : 0) + (this.stampX[r] === g ? this.sumX[r]! : 0))
    const fz = clamp16((r < n ? moved(cols.flux[2 * c + 1]!) : 0) + (this.stampZ[r] === g ? this.sumZ[r]! : 0))
    this.push(local | (rank << 8))
    this.push(surface)
    this.push(floor | (ceil << 16))
    this.push((fx & 0xffff) | (fz << 16))
    this.push(l0 | (l1 << 16))
    this.push(l2 | (l3 << 16))
    return true
  }

  /**
   * The link of segment ref r (floor f, ceiling ce, surface S, 1/SUB block) of column c on side dir, the neighbour lying in
   * the world (plan decision 13 of 3d). Among the neighbour's segments overlapping r's run:
   * - the one with the highest floor below S, else the lowest;
   * - its rank when it is a top or drawn (U.shown);
   * - LINK_GROUND | its floor when it is a dry lower one;
   * - LINK_WALL when none overlaps, when the one met ranks past RANKS − 1, when its ceiling is at or under S, or when it is a
   *   lower segment full to its ceiling or in a body.
   * The neighbour's chain is walked once, bottom-up then its top, counting ranks on the way (ties: the first met wins).
   */
  private link(r: number, c: number, dir: number, cols: WaterColumns, U: UnderSegments, height: number, f: number, ce: number, S: number): number {
    const n = cols.n, nc = c + SIDE_X[dir]! + SIDE_Z[dir]! * cols.sx
    let best = -1, bestF = -1, bestP = -1, low = -1, lowF = Infinity, lowP = -1, k = 0
    for (let i = U.first[nc]!; i >= 0; i = U.next[i]!, k++) {
      const rf = U.floor[i]!, rc = U.ceil[i]!
      if (rf >= ce || rc <= f || rf >= rc) continue
      if (rf * SUB < S && rf > bestF) { best = n + i; bestF = rf; bestP = k }
      if (rf < lowF) { low = n + i; lowF = rf; lowP = k }
    }
    const tf = cols.floor[nc]!
    if (!(tf >= ce || height <= f || tf >= height)) {
      if (tf * SUB < S && tf > bestF) { best = nc; bestF = tf; bestP = k }
      if (tf < lowF) { low = nc; lowF = tf; lowP = k }
    }
    const m = best >= 0 ? best : low
    if (m < 0) return LINK_WALL
    const rank = m < n ? 0 : k - (best >= 0 ? bestP : lowP)
    if (rank >= RANKS) return LINK_WALL
    if (m < n) return height * SUB <= S ? LINK_WALL : 0
    const i = m - n
    if (U.ceil[i]! * SUB <= S || U.body[i]! >= 0 || U.depth[i]! >= U.cap(i)) return LINK_WALL
    return U.shown[i] === 1 ? rank : LINK_GROUND | U.floor[i]!
  }
```

Imports at the top of `publish.ts`:
- `import { LINK_GROUND, LINK_WALL, SIDE_X, SIDE_Z } from './links.ts'`, replacing `linkOf`;
- `RANKS`, `SUB` and `TILE` from `./constants.ts` (already imported).

The `link` logic matches `linkOf` line by line:
- ranks: a lower segment at position p of k, bottom-up, has `k − p` segments from the top, `rankOf`'s count;
- a top's `hidden` is false and its `shown` is irrelevant: `linkOf` returns its rank once the wall checks pass.

- [ ] **Step 4: Remove `linkOf` from `links.ts`**

Delete the function and its doc comment. Delete any import that is now unused (check with `npm run typecheck`).
`rankOf` stays only if something else imports it: use the Grep tool for `rankOf(` under `packages/`.

- [ ] **Step 5: Run the golden test and the water suites**

Run: `npx vitest run --root packages/engine test/waterPublishGolden.test.ts test/waterPublish.test.ts test/waterLinks.test.ts test/surfaceLayers.test.ts test/waterLayersWorld.test.ts test/waterWorld.test.ts test/waterFuzz.test.ts test/determinism.test.ts`
Expected: PASS.

If the golden hash differs, the rewrite changed the output:
- bisect by putting back one piece at a time (the sums, then `record`, then `link`);
- never update `GOLDEN`.

- [ ] **Step 6: Engine suite, sandbox suite, typecheck**

Run from the worktree root, each with its output redirected to a file that is then read:
- `npm run test -w @elovox/engine`
- `npm run test -w @elovox/sandbox`
- `npm run typecheck`

Expected: all pass; `workers.test.ts` (the units' replay) is included.

- [ ] **Step 7: Quick local check (not evidence)**

Run: `node --experimental-strip-types apps/sandbox/bench/living.node.ts`. The dam and collapse p95 should look lower than
the spec's 16.8 / 18.1. These numbers are not quoted anywhere.

- [ ] **Step 8: Commit**

```powershell
git -C C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf add packages/engine/src/sim/water/publish.ts packages/engine/src/sim/water/links.ts
git -C C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf commit -m "perf(water): publish's layer records without closures, maps or chain arrays" -m "Bit-identical: the golden publish hash (waterPublishGolden.test.ts) is unchanged. Node A/B and gate numbers: see the 4a-r2 #5 results commit."
```

### Task 3: Node A/B tool, then measure in a quiet window

**Files:**
- Create: `apps/sandbox/bench/nodeAb.node.mjs`
- Create (in the window): `docs/superpowers/research/2026-10-08-living-r2-node-ab-5.json` and
  `docs/superpowers/research/2026-10-08-living-r2-after-5.json`
- Modify: this plan (results section)

**Interfaces:**
- Consumes: `apps/sandbox/bench/living.node.ts` in two checkouts. It prints `generate … ms` and `settled after … ticks`,
  then a JSON `{ node, results: { idle|work|dam|collapse: { p50, p95, max } } }`.
- Produces: the A/B JSON `{ date, node, a, b, order, runs: { build: 'A' | 'B', results }[] }`.

- [ ] **Step 1: Write the A/B tool**

```js
// Interleaved A/B of the living Node bench (bench/living.node.ts) between two checkouts, in the order given (e.g. ABBA).
// Run: node apps/sandbox/bench/nodeAb.node.mjs <checkout A> <checkout B> ABBA <out.json>
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [a, b, order = 'ABBA', out = 'node-ab.json'] = process.argv.slice(2)
if (!a || !b) throw new Error('usage: nodeAb.node.mjs <checkout A> <checkout B> [order] [out.json]')
const runs = []
for (const build of order) {
  const dir = build === 'A' ? a : b
  const stdout = execFileSync(process.execPath, ['--experimental-strip-types', join(dir, 'apps/sandbox/bench/living.node.ts')], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 26 })
  const { results } = JSON.parse(stdout.slice(stdout.indexOf('{')))
  runs.push({ build, results })
  console.log(build, Object.entries(results).map(([p, r]) => `${p} ${r.p50}/${r.p95}`).join('  '))
}
writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), node: process.version, a, b, order, runs }, null, 2))
```

Smoke-run it outside a window with order `B` only: `node apps/sandbox/bench/nodeAb.node.mjs . . B <scratchpad>\ab-smoke.json`
from the worktree root. Expected: one line per run and a JSON file. The numbers are not evidence.

Commit:

```powershell
git -C C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf add apps/sandbox/bench/nodeAb.node.mjs
git -C C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf commit -m "test(sandbox): interleaved Node A/B of the living sim bench between two checkouts"
```

- [ ] **Step 2: Prepare A: the parent of Task 2's commit, in a detached worktree**

```powershell
git -C C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf worktree add --detach C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf-a <Task 2 SHA>~1
```

Then run `npm install` in `perf-a`. Also run `npm run build` in `apps/sandbox` of the perf worktree, at HEAD, for the
gate. Both happen outside the window.

- [ ] **Step 3: Request the window**

Send the expert: `WINDOW REQUEST: #5 Node A/B (ABBA, living sim bench) + living gate after #5 (2 runs), ~25 min`. Wait
for GO.

- [ ] **Step 4: In the window**

1. Record free RAM; abort if it is below 8 GB.
2. Run `node apps/sandbox/bench/nodeAb.node.mjs C:\…\worktrees\perf-a C:\…\worktrees\perf ABBA docs/superpowers/research/2026-10-08-living-r2-node-ab-5.json`
   from the perf worktree root.
3. Run the gate from `apps/sandbox`, output redirected to a log file outside `test-results/`:
   `BENCH_LIVING=1 LIVING_BENCH_OUT=../../docs/superpowers/research/2026-10-08-living-r2-after-5.json E2E_PREVIEW=1 E2E_PORT=5184 E2E_CHANNEL=msedge npx playwright test e2e/living-bench.spec.ts --headed --workers=1`.
   Expected: PASS with `invalid: []`.
4. Record free RAM, then send DONE.

- [ ] **Step 5: Decide (spec §5 rule 2)**

- **Revert Task 2** if B's dam and collapse tick p95 are not below A's in every adjacent pair of the A/B.
- **Otherwise #5 stands.**
- **If the gate's dam or collapse tick p95 is still > 10 ms:** profile the dam window of the Node bench at HEAD (the
  scratch inspector variant of `bench/living.node.ts`) and send the expert the note with the new top entries. The next
  #5 step (the rest of publish and flush, then the water step) is appended to this plan only after that.

- [ ] **Step 6: Results and commit**

Append a section "Results: #5" to this plan:
- the A/B table: per run, dam and collapse tick p50/p95;
- the gate table against the baseline: per phase, fps p5, CPU median, tick p95, apply p95.

Remove the `perf-a` worktree: `git -C <perf> worktree remove C:\…\worktrees\perf-a`.

```powershell
git -C C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf add docs/superpowers/research/2026-10-08-living-r2-node-ab-5.json docs/superpowers/research/2026-10-08-living-r2-after-5.json docs/superpowers/plans/2026-10-08-living-world-performance-round-2.md
git -C C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf commit -m "docs(4a-r2): #5 results" -m "<Task 2 SHA> perf(water) publish records: dam tick p95 A → B, collapse tick p95 A → B (Node A/B, ABBA); gate tick p95 dam/collapse baseline → after"
```

Send the expert the SHA, the before/after numbers, and whether tick p95 now meets 10 ms.

---

## Results: #5, step 1 (`7f9dfc0`: records without closures, maps or chain arrays)

Quiet window #3, 2026-10-08, 21:34–21:44.
- Free RAM: 12.7 GB at the start, 12.2 GB at the end.
- **Heavy apps running at both start and end: `cs2` (CS2) and `steam`.** Per the expert's rule, the browser gate below is
  PROVISIONAL. The alternating A/B is valid attribution.

**Node A/B** (`research/2026-10-08-living-r2-node-ab-5.json`; living sim bench, order A B B A).
- A = `6583a16`, the parent, in a detached worktree; B = `ac0f8e6`, which contains `7f9dfc0`.
- Tick in ms, p50 / p95.

| Run | Build | idle | work | dam | collapse |
|---|---|---|---|---|---|
| 1 | A | 7.35 / 9.70 | 7.97 / 12.56 | 14.77 / 20.19 | 15.27 / 24.02 |
| 2 | B | 5.89 / 8.79 | 6.25 / 10.32 | 10.47 / 14.03 | 12.24 / 18.29 |
| 3 | B | 5.26 / 6.57 | 6.19 / 9.93 | 10.48 / 14.12 | 12.46 / 17.30 |
| 4 | A | 6.68 / 9.23 | 8.01 / 13.93 | 14.81 / 20.02 | 16.96 / 24.48 |

- B wins every adjacent pair in every phase.
- Dam p95: 20.0–20.2 → 14.0–14.1 (−30%).
- Collapse p95: 24.0–24.5 → 17.3–18.3 (−27%).
- Outside a window, the dam-window profile shows `records()` going from 3.8 s to 1.1 s per 900 ticks.

**Browser gate** (`research/2026-10-08-living-r2-after-5.json`, worse of two runs, `invalid: []`). **PROVISIONAL**, with
CS2 running. CPU frame time doubled in every phase, and the water apply rose too, although #5 does not touch it. The
machine was loaded, so no absolute number from this gate counts against the targets.

| Phase | fps p5: baseline → after | CPU median | tick p95 | apply p95 |
|---|---|---|---|---|
| idle-default | 90.3 → 48.8 | 4.4 → 8.5 | 5.0 → 10.1 | 5.65 → 8.7 |
| idle-far | 89.8 → 43.3 | 5.8 → 10.2 | 5.4 → 9.0 | 6.0 → 8.2 |
| work-default | 89.9 → 49.9 | 5.2 → 9.2 | 7.2 → 11.4 | 6.4 → 8.3 |
| work-far | 60.1 → 45.1 | 6.3 → 10.2 | 7.7 → 11.3 | 6.9 → 8.6 |
| dam | 36.0 → 22.4 | 7.9 → 13.0 | 13.4 → 17.7 | 21.6 → 26.8 |
| collapse | 30.1 → 21.4 | 7.9 → 13.1 | 15.6 → 18.9 | 22.6 → 27.7 |

**Decision.**
- Step 1 stands: a measured gain in the A/B (spec §5 rule 2).
- The tick target still misses. In the Node A/B, B's dam and collapse p95 are 14–18 ms, against ≤ 10.
- Following §3.1, the expert gets the note with the new profile before the next #5 step: the rest of publish and flush,
  then the water step.
- The gate is to be re-run on a quiet machine.

---

# Part 2: #2, water apply in a dedicated worker

> Spec §4, approved, including the §4.1 back-to-back rule. Where each of the expert's conditions is covered:
> - Main-thread queries stay synchronous through the shared drawn-surface buffer (Task 4).
> - Lag is measured with `waterLagMs` and a clip (Tasks 7–8).
> - The worker's ColumnData is bit-identical to an in-thread view's (Task 4, differential).
> - `surfaceNear` answers the same as the in-thread view (Task 4, differential).
> - A crash gets one respawn plus `waterResync`; a second one is fatal (Tasks 6–7).
> - The worker is added on top of the mesh pool, and the mesh backlog is checked (Task 8).
> - A parity-buffer reuse is forced in Node with a queue deep enough to cause it (Task 5).

**Architecture**
- **`WaterHost`** (pure) wraps `SurfaceView`. It answers a `WaterRequest` (one tick's publish plus its relights) with a
  `WaterReply` that packs every dirty key's changed rows and curtains.
- **`render/water/water.worker.ts`** runs the host. With `EngineOptions.waterWorker: false` (`?nowaterworker`) the host
  runs in-thread and replies at once: that is the A of the A/B, in the same build.
- **`SurfaceMirror`** (main thread) holds the ColumnData that three uploads. It answers `surfaceNear`/`surfaceAt` from a
  shared Int32 buffer that the host writes.
- **`WaterLink`** (pure, main thread) keeps one request in flight and queues the rest in order. It freezes the drawn alpha
  while a publish is in flight and calls the engine's clock hooks in tick order.

**File map (part 2)**

| File | Responsibility |
|---|---|
| `packages/engine/src/render/water/surfaceView.ts` (modify) | `DrawnSurfaces`, `NO_SLOT`, `drawnSurfaces(n)`, `SurfaceView.surfaces` written after each apply |
| `packages/engine/src/render/water/waterHost.ts` (create) | `WaterRequest`, `WaterReply`, `packDirty(view)`, `WaterHost` |
| `packages/engine/src/render/water/surfaceMirror.ts` (create) | `SurfaceSource` interface, `SurfaceMirror` (copy, takeDirty, surfaceNear/At, reset) |
| `packages/engine/src/render/water/waterLink.ts` (create) | `WaterLink` scheduler and its hooks |
| `packages/engine/src/render/water/water.worker.ts` (create) | Worker shell around `WaterHost` |
| `packages/engine/src/render/water/waterSurface.ts`, `ripples.ts`, `render/visuals.ts` (modify) | Typed against `SurfaceSource` instead of `SurfaceView`; nothing else changes |
| `packages/engine/src/sim/water/waterSystem.ts`, `sim/simHost.ts`, `protocol.ts` (modify) | `waterResync` → `WaterSystem.republishAll()` |
| `packages/engine/src/engine.ts` (modify, water path only) | Host, worker and link wiring; freeze, lag, crash handling, stats; `EngineOptions.waterWorker` |
| `apps/sandbox/src/main.ts` (modify, one line) | `waterWorker: !params.has('nowaterworker')` |
| `packages/engine/test/layerHelpers.ts` (modify) | export `gateWorld()` |
| `packages/engine/test/surfaceMirror.test.ts`, `waterLink.test.ts`, `waterResync.test.ts` (create) | Tests for Tasks 4–6 |
| `apps/sandbox/e2e/water-worker.spec.ts`, `water-ab.spec.ts`, `living-anatomy.spec.ts`, `bench/anatomy.node.mjs` (create) | Task 7 e2e, Task 8 measurement |

**One known difference: when light is read.** The worker reads voxel light a few ms after the tick's message. If light
changes in the very next sim tick, the new value can therefore land one relight earlier. The next relight writes the same
value, so nothing visible changes. Node tests run single-threaded and cannot see this.

## Review Focus (part 2)

1. **The worker crashes mid-dam.**
   - Expected: one respawn, a full republish, and the water redrawn within a few ticks; the engine keeps running.
   - Test: the Task 7 e2e crashes the worker through a debug hook and checks the water comes back; a second crash is fatal.
2. **Physics paused while a request is in flight.**
   - Expected: the reply still lands; after that the queue empties and the alpha unfreezes. Ticks without a publish release
     the hold, as today.
   - Test: Task 5, ticks without a publish queued behind one in flight.
3. **A relight with no publish (a regeneration).**
   - Expected: it never releases the clock hold, and it is applied in order.
   - Test: Task 5.
4. **`dispose()` with a request in flight.**
   - Expected: the worker is terminated and no disposed mesh is touched afterwards.
   - Test: the Task 7 e2e disposes during the dam and checks for no console errors.
5. **A bunch of ticks longer than the parity window** (N + 2 overwrites N's buffer).
   - Expected: today's defer and re-read recovery, with no wrong data.
   - Test: Task 5 forces the reuse with a real publisher and host, and compares the result against a reference that read
     every publish at once.

---

### Task 4: `WaterHost`, `SurfaceMirror` and the drawn-surface buffer, bit-identical to an in-thread view

**Files:**
- Modify: `packages/engine/src/render/water/surfaceView.ts`
- Create: `packages/engine/src/render/water/waterHost.ts`, `packages/engine/src/render/water/surfaceMirror.ts`
- Modify: `packages/engine/test/layerHelpers.ts`: add `gateWorld()`, a copy of `surfaceLayers.test.ts`'s local one.
- Test: `packages/engine/test/surfaceMirror.test.ts`

**Interfaces:**
- Produces:
  - `DrawnSurfaces { value: Int32Array; floor: Int16Array }`, `NO_SLOT = -0x80000000`, and `drawnSurfaces(n): DrawnSurfaces`.
    The buffers are SharedArrayBuffer-backed. They start with rank 0 at −1 and ranks 1–3 at NO_SLOT.
  - `SurfaceView.surfaces: DrawnSurfaces | null`
  - `WaterRequest { type: 'apply'; id; tick; water: WaterTick | null; shown: number; relight: number[] }`. `relight` is a
    flat list of `[cc, y0, y1]` triples.
  - `WaterReply { type: 'result'; id; tick; applied: boolean; hostMs: number; keys: Int32Array; data: Float32Array }`
  - `packDirty(view): { keys; data }`
  - `class WaterHost { constructor(size, b, light, stepHz, surfaces); readonly view; handle(req): WaterReply }`
  - `interface SurfaceSource { ccCount; cx; column(cc, r?); takeDirty(); surfaceNear(x, z, y) }`
  - `class SurfaceMirror implements SurfaceSource { constructor(size, b); readonly surfaces; copy(reply); reset(); surfaceAt(x, z) }`

- [ ] **Step 1: Add `gateWorld()` to `test/layerHelpers.ts`**

```ts
/** A lake behind a gate with a hole under a deck: water runs through the hole into a lower channel, under the deck (lower slots). 64 × 32 × 32. */
export function gateWorld() {
  return layered((x, y, z) => {
    if (y < 2 || z === 0 || z >= 5 || x === 0 || x === 63) return STONE
    if (x === 31 && !(y >= 3 && y <= 4 && z === 2)) return STONE // the gate, a 1 × 2 hole at z 2
    if (x >= 26 && x <= 40 && y === 7) return STONE // the deck over the gate
    if (x < 31) return y <= 10 ? wv(7) : AIR // the lake
    return AIR
  }, [64, 32, 32])
}
```

- [ ] **Step 2: Write the failing differential test**

`packages/engine/test/surfaceMirror.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SurfaceView } from '../src/render/water/surfaceView.ts'
import { WaterHost } from '../src/render/water/waterHost.ts'
import { SurfaceMirror } from '../src/render/water/surfaceMirror.ts'
import { RANKS } from '../src/sim/water/constants.ts'
import { WaterPublisher } from '../src/sim/water/publish.ts'
import { gateWorld } from './layerHelpers.ts'

/** The first index where two arrays differ (Object.is), −1 when equal. */
const diff = (x: ArrayLike<number>, y: ArrayLike<number>): number => {
  if (x.length !== y.length) return -2
  for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return i
  return -1
}
const SIZE: [number, number, number] = [64, 32, 32]

describe('SurfaceMirror (4a-r2 #2)', () => {
  it('holds exactly what an in-thread view holds after every request, with alpha, relights and queued publishes (differential)', () => {
    const w = gateWorld()
    w.edges.ensure(w.cols, w.under, 32)
    let shift = 0
    const light = (x: number, y: number, z: number) => (x * 7 + y * 3 + z + shift) & 0xff
    const pub = new WaterPublisher(w.buffers.water)
    const ref = new SurfaceView(SIZE, w.buffers.water, light, 20)
    const mirror = new SurfaceMirror(SIZE, w.buffers.water)
    const host = new WaterHost(SIZE, w.buffers.water, light, 20, mirror.surfaces)
    const all = Array.from({ length: w.cols.tiles.count }, (_, t) => t)
    let id = 0, compared = 0
    for (let tick = 0; tick < 48; tick++) {
      // Every 5th tick two publishes come before a reply: WaterLink forwards the second after the first's copy, at alpha 0.
      for (let q = 0; q < (tick % 5 === 0 ? 2 : 1); q++) {
        const water = pub.publish(all, w.cols, { under: w.under, edges: w.edges, height: 32 })!
        const shown = q === 0 ? (tick % 3) / 3 : 0
        if (tick % 4 === 0) shift++
        const relight = tick % 4 === 0 ? [0, 0, 32, 1, 0, 16] : []
        ref.apply(water, shown)
        for (let i = 0; i < relight.length; i += 3) ref.relight(relight[i]!, relight[i + 1]!, relight[i + 2]!)
        mirror.copy(host.handle({ type: 'apply', id: ++id, tick, water, shown, relight }))
        for (let r = 0; r < RANKS; r++) for (let cc = 0; cc < ref.ccCount; cc++) {
          const a = ref.column(cc, r), m = mirror.column(cc, r)
          expect([tick, r, cc, !!a]).toEqual([tick, r, cc, !!m])
          if (!a || !m) continue
          const n = a.curtains.count * 4
          expect([tick, r, cc, diff(m.hPrev, a.hPrev), diff(m.hCur, a.hCur), diff(m.info, a.info), m.curtains.count - a.curtains.count,
            diff(m.curtains.prev.subarray(0, n), a.curtains.prev.subarray(0, n)), diff(m.curtains.cur.subarray(0, n), a.curtains.cur.subarray(0, n)),
            diff(m.curtains.reach.subarray(0, n), a.curtains.reach.subarray(0, n)), diff(m.curtains.thick.subarray(0, n), a.curtains.thick.subarray(0, n)),
            diff(m.curtains.flare.subarray(0, n), a.curtains.flare.subarray(0, n)), diff(m.curtains.info.subarray(0, n), a.curtains.info.subarray(0, n)),
          ]).toEqual([tick, r, cc, -1, -1, -1, 0, -1, -1, -1, -1, -1, -1])
          compared++
        }
        for (let z = 0; z < SIZE[2]; z++) for (let x = 0; x < SIZE[0]; x++) {
          expect([x, z, mirror.surfaceAt(x, z)]).toEqual([x, z, ref.surfaceAt(x, z)])
          for (const y of [2, 4, 7, 10]) expect([x, z, y, mirror.surfaceNear(x, z, y)]).toEqual([x, z, y, ref.surfaceNear(x, z, y)])
        }
        w.step()
      }
    }
    expect(compared).toBeGreaterThan(100)
    // The world must reach the layered path: some layer-1 column data exists.
    expect(Array.from({ length: ref.ccCount }, (_, cc) => ref.column(cc, 1)).some(Boolean)).toBe(true)
  }, 120_000)
})
```

Run: `npx vitest run --root packages/engine test/surfaceMirror.test.ts`. Expected: FAIL, because `waterHost.ts` and
`surfaceMirror.ts` do not exist yet.

- [ ] **Step 3: The drawn-surface buffer in `surfaceView.ts`**

At module level, after the imports:

```ts
/**
 * Drawn surfaces for main-thread queries (4a-r2 #2), written by the view that applies and read by SurfaceMirror.
 * `value[c × RANKS + r]`: rank 0 the published value of column c; rank r ≥ 1 the slot's published value, NO_SLOT when c has
 * no slot r. `floor[c × (RANKS − 1) + r − 1]`: the floor (blocks) of slot r ≥ 1. Plain stores into shared memory: a query
 * racing an apply may see some columns at the new step and some at the old, never a torn value.
 */
export interface DrawnSurfaces { value: Int32Array; floor: Int16Array }
/** No slot at this rank (never a published value: those are ≥ 0, or ~level ≥ −(128 × SUB + 1)). */
export const NO_SLOT = -0x80000000

/** DrawnSurfaces for n columns over SharedArrayBuffers, as before any apply: rank 0 −1 (SurfaceView.cur's start), no slots. */
export function drawnSurfaces(n: number): DrawnSurfaces {
  const value = new Int32Array(new SharedArrayBuffer(n * RANKS * 4)).fill(NO_SLOT)
  for (let c = 0; c < n; c++) value[c * RANKS] = -1
  return { value, floor: new Int16Array(new SharedArrayBuffer(n * (RANKS - 1) * 2)) }
}
```

In `SurfaceView`, after `forceSlots`:

```ts
  /** When set, every column of the tiles an apply reads is written here after the apply (see DrawnSurfaces). */
  surfaces: DrawnSurfaces | null = null
```

In `apply()`, right after the commit loop (the `for (const tile of tiles) { … this.tileSettled[tile] = moving ? 0 : 1 }` loop):

```ts
    if (this.surfaces) for (const tile of tiles) this.writeSurfaces(tile)
```

Then add, next to `defer`:

```ts
  /** Writes the drawn surfaces of tile's columns (see DrawnSurfaces): after the commit, so cur and the layers are this step's. */
  private writeSurfaces(tile: number): void {
    const { value, floor } = this.surfaces!
    const x0 = (tile % this.tx) * TILE, z0 = Math.floor(tile / this.tx) * TILE
    for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) {
      const c = x + z * this.sx
      value[c * RANKS] = this.cur[c]!
      for (let r = 1; r < RANKS; r++) {
        const has = this.layers.has(c, r)
        value[c * RANKS + r] = has ? this.layers.cur(c, r) : NO_SLOT
        floor[c * (RANKS - 1) + r - 1] = has ? this.layers.floor(c, r) : 0
      }
    }
  }
```

The layer store and `cur` change only in that commit loop, and only for the listed tiles, so the buffer stays equal to the
view.

- [ ] **Step 4: `waterHost.ts`**

```ts
import type { WaterTick } from '../../sim/water/publish.ts'
import type { WorldSize } from '../../world/layout.ts'
import type { WaterBuffers } from '../../world/waterBuffers.ts'
import { SurfaceView, type DrawnSurfaces } from './surfaceView.ts'

/** Main thread → water host: one tick's publish (null: none) and the light ranges [cc, y0, y1]* to re-read after it. */
export interface WaterRequest { type: 'apply'; id: number; tick: number; water: WaterTick | null; shown: number; relight: number[] }
/** Water host → main thread: whether the publish was applied, the host's cost (ms), and the data of every key that changed (packDirty). */
export interface WaterReply { type: 'result'; id: number; tick: number; applied: boolean; hostMs: number; keys: Int32Array; data: Float32Array }

/** Floats per row of a ColumnData array: 32 instances × 4. */
const ROW = 128
/** Ints per key in WaterReply.keys. */
export const KEY_INTS = 4

/**
 * Takes the view's dirty keys and packs what the renderer reads: per key [key, rowLo, rowHi, curtain count] (count −1: the
 * key has no data), then in `data`, key by key, rows rowLo..rowHi of hPrev, hCur and info (none when rowLo > rowHi), then
 * the first count × 4 floats of the six curtain arrays (prev, cur, reach, thick, flare, info). Resets each key's row range,
 * as WaterSurface.sync does when it uploads.
 */
export function packDirty(view: SurfaceView): { keys: Int32Array; data: Float32Array } {
  const dirty = view.takeDirty(), n = view.ccCount
  let floats = 0
  for (const key of dirty) {
    const cc = key % n, d = view.column(cc, (key - cc) / n)
    if (!d) continue
    if (d.rowLo <= d.rowHi) floats += (d.rowHi - d.rowLo + 1) * ROW * 3
    floats += d.curtains.count * 4 * 6
  }
  const keys = new Int32Array(dirty.length * KEY_INTS), data = new Float32Array(floats)
  let o = 0
  for (let k = 0; k < dirty.length; k++) {
    const key = dirty[k]!, cc = key % n, d = view.column(cc, (key - cc) / n)
    keys[k * KEY_INTS] = key
    if (!d) { keys[k * KEY_INTS + 1] = 32; keys[k * KEY_INTS + 2] = -1; keys[k * KEY_INTS + 3] = -1; continue }
    keys[k * KEY_INTS + 1] = d.rowLo; keys[k * KEY_INTS + 2] = d.rowHi
    if (d.rowLo <= d.rowHi) {
      const a = d.rowLo * ROW, b = (d.rowHi + 1) * ROW
      data.set(d.hPrev.subarray(a, b), o); o += b - a
      data.set(d.hCur.subarray(a, b), o); o += b - a
      data.set(d.info.subarray(a, b), o); o += b - a
      d.rowLo = 32; d.rowHi = -1
    }
    const cs = d.curtains, m = cs.count * 4
    keys[k * KEY_INTS + 3] = cs.count
    for (const arr of [cs.prev, cs.cur, cs.reach, cs.thick, cs.flare, cs.info]) { data.set(arr.subarray(0, m), o); o += m }
  }
  return { keys, data }
}

/** The water view's side of #2: applies requests in order and packs what changed. Runs in the water worker, or in-thread. */
export class WaterHost {
  readonly view: SurfaceView
  constructor(size: WorldSize, b: WaterBuffers, light: (x: number, y: number, z: number) => number, stepHz: number, surfaces: DrawnSurfaces) {
    this.view = new SurfaceView(size, b, light, stepHz)
    this.view.surfaces = surfaces
  }

  handle(req: WaterRequest): WaterReply {
    const t0 = performance.now()
    const applied = req.water ? this.view.apply(req.water, req.shown) : false
    for (let i = 0; i < req.relight.length; i += 3) this.view.relight(req.relight[i]!, req.relight[i + 1]!, req.relight[i + 2]!)
    const { keys, data } = packDirty(this.view)
    return { type: 'result', id: req.id, tick: req.tick, applied, hostMs: performance.now() - t0, keys, data }
  }
}
```

- [ ] **Step 5: `surfaceMirror.ts`**

```ts
import { RANKS } from '../../sim/water/constants.ts'
import type { WorldSize } from '../../world/layout.ts'
import { SUB, type WaterBuffers } from '../../world/waterBuffers.ts'
import { shows } from './surfaceMesh.ts'
import { ColumnData, NO_SLOT, drawnSurfaces, type DrawnSurfaces } from './surfaceView.ts'
import { KEY_INTS, type WaterReply } from './waterHost.ts'

/** What the renderer and the edit ripples read of the water: SurfaceView in-thread, SurfaceMirror beside a water host. */
export interface SurfaceSource {
  readonly ccCount: number
  readonly cx: number
  column(cc: number, r?: number): ColumnData | undefined
  takeDirty(): number[]
  surfaceNear(x: number, z: number, y: number): number | null
}

const ROW = 128
const PER_SUB = 1 / SUB
function byIndex(a: number, b: number): number { return a - b }

/**
 * The main thread's copy of the water view's draw data (4a-r2 #2): ColumnData filled from WaterReply copies, the dirty keys
 * for WaterSurface, and synchronous surface queries over the shared DrawnSurfaces the host writes.
 */
export class SurfaceMirror implements SurfaceSource {
  readonly sx: number
  readonly sz: number
  readonly cx: number
  readonly ccCount: number
  readonly surfaces: DrawnSurfaces
  private readonly floor: Int16Array
  private readonly data: (ColumnData | undefined)[][]
  private readonly dirtyFlag: Uint8Array
  private dirty: number[] = []
  private spare: number[] = []

  constructor(size: WorldSize, b: WaterBuffers) {
    this.sx = size[0]
    this.sz = size[2]
    this.cx = this.sx >> 5
    this.ccCount = this.cx * (this.sz >> 5)
    this.surfaces = drawnSurfaces(this.sx * this.sz)
    this.floor = new Int16Array(b.floor)
    this.data = Array.from({ length: RANKS }, () => new Array<ColumnData | undefined>(this.ccCount))
    this.dirtyFlag = new Uint8Array(this.ccCount * RANKS)
  }

  column(cc: number, r = 0): ColumnData | undefined { return this.data[r]![cc] }

  /** As SurfaceView.takeDirty: keys changed since the last call, in index order; the array is reused. */
  takeDirty(): number[] {
    const out = this.dirty
    if (out.length === 0) return out
    out.sort(byIndex)
    for (const k of out) this.dirtyFlag[k] = 0
    this.dirty = this.spare
    this.dirty.length = 0
    this.spare = out
    return out
  }

  /** Copies a reply's packed keys (packDirty) into the ColumnData the renderer uploads, marking their rows and keys. */
  copy(reply: WaterReply): void {
    const keys = reply.keys, src = reply.data
    let o = 0
    for (let k = 0; k < keys.length; k += KEY_INTS) {
      const key = keys[k]!, lo = keys[k + 1]!, hi = keys[k + 2]!, count = keys[k + 3]!
      if (count < 0) continue
      const cc = key % this.ccCount, r = (key - cc) / this.ccCount
      let d = this.data[r]![cc]
      if (!d) { d = new ColumnData(); this.data[r]![cc] = d }
      if (lo <= hi) {
        const a = lo * ROW, len = (hi - lo + 1) * ROW
        d.hPrev.set(src.subarray(o, o + len), a); o += len
        d.hCur.set(src.subarray(o, o + len), a); o += len
        d.info.set(src.subarray(o, o + len), a); o += len
        d.mark(lo); d.mark(hi)
      }
      const cs = d.curtains, m = count * 4
      cs.reserve(count)
      cs.count = count
      for (const arr of [cs.prev, cs.cur, cs.reach, cs.thick, cs.flare, cs.info]) { arr.set(src.subarray(o, o + m)); o += m }
      if (this.dirtyFlag[key] === 0) { this.dirtyFlag[key] = 1; this.dirty.push(key) }
    }
  }

  /** Forgets everything drawn (a lost worker): every quad hidden and every curtain gone until the next copies, surfaces back to their start. */
  reset(): void {
    for (let r = 0; r < RANKS; r++) for (let cc = 0; cc < this.ccCount; cc++) {
      const d = this.data[r]![cc]
      if (!d) continue
      d.info.fill(-1)
      d.curtains.count = 0
      d.mark(0); d.mark(31)
      const key = r * this.ccCount + cc
      if (this.dirtyFlag[key] === 0) { this.dirtyFlag[key] = 1; this.dirty.push(key) }
    }
    const v = this.surfaces.value
    v.fill(NO_SLOT)
    for (let c = 0; c < this.sx * this.sz; c++) v[c * RANKS] = -1
  }

  /** As SurfaceView.surfaceAt, from the drawn surfaces. */
  surfaceAt(x: number, z: number): number | null {
    if (x < 0 || z < 0 || x >= this.sx || z >= this.sz) return null
    const c = x + z * this.sx, v = this.surfaces.value[c * RANKS]!
    return shows(v, this.floor[c]!) ? v * PER_SUB : null
  }

  /** As SurfaceView.surfaceNear, from the drawn surfaces. */
  surfaceNear(x: number, z: number, y: number): number | null {
    if (x < 0 || z < 0 || x >= this.sx || z >= this.sz) return null
    const c = x + z * this.sx, value = this.surfaces.value, floor = this.surfaces.floor
    let best: number | null = null
    for (let r = 0; r < RANKS; r++) {
      const v = value[c * RANKS + r]!
      if (r > 0 && v === NO_SLOT) continue
      const f = r === 0 ? this.floor[c]! : floor[c * (RANKS - 1) + r - 1]!
      if (!shows(v, f)) continue
      const s = v * PER_SUB
      if (Math.abs(s - y) <= 2 && (best === null || Math.abs(s - y) < Math.abs(best - y))) best = s
    }
    return best
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run --root packages/engine test/surfaceMirror.test.ts test/surfaceView.test.ts test/surfaceLayers.test.ts test/waterSurface.test.ts test/ripples.test.ts`
Expected: PASS.

If the differential test fails, find the first `(tick, r, cc, index)`. The likely causes:
- a SurfaceView write that does not `mark()` its row;
- a key changed without `markDirty`.

Fix the packing or the mirror. If the cause is a missing `mark()` in SurfaceView, add the mark there: today that would
also be a latent upload bug.

- [ ] **Step 7: Commit**

```powershell
git -C C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf add packages/engine/src/render/water/surfaceView.ts packages/engine/src/render/water/waterHost.ts packages/engine/src/render/water/surfaceMirror.ts packages/engine/test/layerHelpers.ts packages/engine/test/surfaceMirror.test.ts
git -C C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf commit -m "feat(water): WaterHost packs the view's changed rows; SurfaceMirror copies them and answers surface queries (bit-identical)"
```

### Task 5: `WaterLink`: one request in flight, the rest in order

**Files:**
- Create: `packages/engine/src/render/water/waterLink.ts`
- Test: `packages/engine/test/waterLink.test.ts`

**Interfaces:**
- Consumes: `WaterRequest`, `WaterReply`, `WaterHost` and `SurfaceMirror` from Task 4.
- Produces:
  - `interface WaterLinkHooks { post(req); copy(reply, publish: boolean); applied(tick, arrived); settled(); shown(): number }`
  - `class WaterLink { constructor(hooks); submit(tick, water, relight, settles, arrived); receive(reply); reset(); readonly depth; maxDepth(); readonly frozen: number | null }`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { SurfaceView } from '../src/render/water/surfaceView.ts'
import { WaterHost, type WaterReply, type WaterRequest } from '../src/render/water/waterHost.ts'
import { WaterLink } from '../src/render/water/waterLink.ts'
import { SurfaceMirror } from '../src/render/water/surfaceMirror.ts'
import { WaterPublisher, type WaterTick } from '../src/sim/water/publish.ts'
import { gateWorld } from './layerHelpers.ts'

const tickOf = (seq: number): WaterTick => ({ seq, parity: seq & 1, tiles: [], layers: null })
const reply = (req: WaterRequest, applied: boolean): WaterReply => ({ type: 'result', id: req.id, tick: req.tick, applied, hostMs: 0, keys: new Int32Array(), data: new Float32Array() })

/** A link over a fake host: requests wait until `answer` replies to them; `log` records the hooks in order. */
function fake(onScreen = { v: 0.6 }) {
  const posted: WaterRequest[] = [], log: string[] = []
  const link = new WaterLink({
    post: (req) => { posted.push(req); log.push(`post ${req.tick} @${req.shown}`) },
    copy: (r, publish) => log.push(`copy ${r.tick}${publish ? '' : ' (no publish)'}`),
    applied: (tick, arrived) => { onScreen.v = 0; log.push(`applied ${tick} from ${arrived}`) },
    settled: () => log.push('settled'),
    shown: () => onScreen.v,
  })
  return { link, posted, log, answer: (i: number, applied = true) => link.receive(reply(posted[i]!, applied)) }
}

describe('WaterLink (4a-r2 #2, spec 4.1)', () => {
  it('two publishes before the first reply: one in flight, the second sent after the first copy, at alpha 0, in order', () => {
    const { link, posted, log, answer } = fake()
    link.submit(1, tickOf(1), [], true, 100)
    link.submit(2, tickOf(2), [], true, 120)
    expect(posted.map(p => p.tick)).toEqual([1])
    expect([link.depth, link.frozen]).toEqual([2, 0.6])
    answer(0)
    expect(posted.map(p => p.tick)).toEqual([1, 2])
    expect([link.depth, link.frozen]).toEqual([1, 0])
    answer(1)
    expect([link.depth, link.frozen, link.maxDepth()]).toEqual([0, null, 2])
    expect(log).toEqual(['post 1 @0.6', 'copy 1', 'applied 1 from 100', 'post 2 @0', 'copy 2', 'applied 2 from 120'])
  })

  it('ticks without a publish release the clock in order, behind the request in flight', () => {
    const { link, log, answer } = fake()
    link.submit(1, tickOf(1), [], true, 0)
    link.submit(2, null, [], true, 0)
    link.submit(3, null, [], true, 0)
    expect(log).toEqual(['post 1 @0.6'])
    answer(0)
    expect(log).toEqual(['post 1 @0.6', 'copy 1', 'applied 1 from 0', 'settled', 'settled'])
    link.submit(4, null, [], true, 0)
    expect(log.at(-1)).toBe('settled') // nothing in flight: at once
  })

  it('a relight goes to the host in order; with no publish it releases the clock only for a tick, not for a regeneration', () => {
    const { link, log, answer } = fake()
    link.submit(1, null, [0, 0, 32], true, 0)
    answer(0, false)
    link.submit(-1, null, [0, 0, 32], false, 0)
    answer(1, false)
    expect(log).toEqual(['post 1 @0.6', 'copy 1 (no publish)', 'settled', 'post -1 @0.6', 'copy -1 (no publish)'])
  })

  it('a deferred publish keeps the hold (no applied) and the queue moves on', () => {
    const { link, log, answer } = fake()
    link.submit(1, tickOf(1), [], true, 0)
    link.submit(2, tickOf(2), [], true, 0)
    answer(0, false)
    answer(1)
    expect(log).toEqual(['post 1 @0.6', 'copy 1', 'post 2 @0.6', 'copy 2', 'applied 2 from 0'])
  })

  it('after reset, a late reply is ignored and the next tick goes out at once', () => {
    const { link, posted, log } = fake()
    link.submit(1, tickOf(1), [], true, 0)
    link.reset()
    link.receive(reply(posted[0]!, true))
    expect(log).toEqual(['post 1 @0.6'])
    link.submit(2, tickOf(2), [], true, 0)
    expect(posted.map(p => p.tick)).toEqual([1, 2])
  })

  it('a queue deep enough that the sim reuses a parity buffer recovers like today: the stale publish defers, the next reads it (forced, real publisher)', () => {
    const w = gateWorld()
    w.edges.ensure(w.cols, w.under, 32)
    const SIZE: [number, number, number] = [64, 32, 32]
    const pub = new WaterPublisher(w.buffers.water)
    const ref = new SurfaceView(SIZE, w.buffers.water, () => 15, 20)
    const mirror = new SurfaceMirror(SIZE, w.buffers.water)
    const host = new WaterHost(SIZE, w.buffers.water, () => 15, 20, mirror.surfaces)
    const posted: WaterRequest[] = [], applied: number[] = [], replies: boolean[] = []
    const link = new WaterLink({ post: (r) => posted.push(r), copy: (r) => { replies.push(r.applied); mirror.copy(r) }, applied: (t) => applied.push(t), settled: () => {}, shown: () => 1 })
    const all = Array.from({ length: w.cols.tiles.count }, (_, t) => t)
    const step = (tick: number) => {
      const water = pub.publish(all, w.cols, { under: w.under, edges: w.edges, height: 32 })!
      ref.apply(water, 1) // the reference reads every publish at once, before its buffer is reused
      link.submit(tick, water, [], true, 0)
      w.step()
    }
    // Three publishes before any reply: the third writes the first's parity buffer.
    step(1); step(2); step(3)
    let delivered = 0
    const deliver = () => { while (delivered < posted.length) link.receive(host.handle(posted[delivered++]!)) }
    deliver()
    expect(replies.slice(0, 3)).toEqual([false, true, true]) // the reuse really happened
    expect(applied.slice(0, 2)).toEqual([2, 3])
    // Run on until the water settles, replying at once, then compare what is drawn.
    for (let tick = 4; tick < 400 && w.cols.tiles.awakeCount() > 0; tick++) { step(tick); deliver() }
    for (let tick = 400; tick < 404; tick++) { step(tick); deliver() }
    expect(w.cols.tiles.awakeCount()).toBe(0)
    for (let r = 0; r < 4; r++) for (let cc = 0; cc < ref.ccCount; cc++) {
      const a = ref.column(cc, r), m = mirror.column(cc, r)
      if (!a) continue
      expect([r, cc, [...m!.hCur].every((v, i) => Object.is(v, a.hCur[i])), [...m!.info].every((v, i) => Object.is(v, a.info[i]))]).toEqual([r, cc, true, true])
    }
  }, 120_000)
})
```

Run: `npx vitest run --root packages/engine test/waterLink.test.ts`. Expected: FAIL, because `waterLink.ts` does not exist
yet.

**As built**, the reuse test differs from the code above in one way. The gate world drains for thousands of ticks, so the
test does not wait for the water to settle. It runs 10 more prompt ticks while the water still runs, then compares
`hPrev`, `hCur`, `info` and the curtain count against the prompt reference. That is a stronger check than comparing after
the water settles.

- [ ] **Step 2: `waterLink.ts`**

```ts
import type { WaterTick } from '../../sim/water/publish.ts'
import type { WaterReply, WaterRequest } from './waterHost.ts'

export interface WaterLinkHooks {
  /** Sends a request to the host: the worker, or an in-thread host that answers through receive() at once. */
  post(req: WaterRequest): void
  /** Copies a reply into the main thread's mirror; `publish`: the request carried a publish (the apply cost is recorded). */
  copy(reply: WaterReply, publish: boolean): void
  /** A publish was applied: its step starts on screen (engine: waterTick, waterShown 0, clock hold tick + 1, lag from `arrived`). */
  applied(tick: number, arrived: number): void
  /** A tick without a publish came through, in order: every tile settled (engine: clock.hold(null)). */
  settled(): void
  /** The water alpha on screen now (engine: waterShown). */
  shown(): number
}

interface Entry { tick: number; water: WaterTick | null; relight: number[]; settles: boolean; arrived: number }

/** Depths kept for maxDepth: one per submit. */
const DEPTH_WINDOW = 200

/**
 * The main thread's side of the water host (spec §4.1): one request in flight, the rest queued in tick order and sent right
 * after the previous reply's copy, with the alpha on screen then (0 after an apply). No coalescing: publishes are deltas.
 * While a publish is in flight the drawn alpha is frozen at the one it was sent with (`frozen`).
 */
export class WaterLink {
  private readonly hooks: WaterLinkHooks
  private readonly queue: Entry[] = []
  private inFlight: (Entry & { id: number; shown: number }) | null = null
  private nextId = 0
  private readonly depths = new Uint16Array(DEPTH_WINDOW)
  private depthAt = 0

  constructor(hooks: WaterLinkHooks) { this.hooks = hooks }

  /** Requests in flight or queued. */
  get depth(): number { return this.queue.length + (this.inFlight ? 1 : 0) }

  /** The largest depth over the last DEPTH_WINDOW submits. */
  maxDepth(): number {
    let m = 0
    for (const d of this.depths) if (d > m) m = d
    return m
  }

  /** The alpha a publish in flight was sent with, to draw until its reply; null when no publish is in flight. */
  get frozen(): number | null { return this.inFlight !== null && this.inFlight.water !== null ? this.inFlight.shown : null }

  /**
   * A tick's publish (null: none) and the light ranges to re-read after it. `settles`: a tick, whose missing publish releases
   * the clock; false for a regeneration's relight. `arrived`: when its message came (performance.now()).
   */
  submit(tick: number, water: WaterTick | null, relight: number[], settles: boolean, arrived: number): void {
    this.queue.push({ tick, water, relight, settles, arrived })
    this.depths[this.depthAt] = Math.min(0xffff, this.depth)
    this.depthAt = (this.depthAt + 1) % DEPTH_WINDOW
    if (this.inFlight === null) this.drain()
  }

  /** The host's reply; one to a request from before reset() is ignored. */
  receive(reply: WaterReply): void {
    const e = this.inFlight
    if (e === null || reply.id !== e.id) return
    this.inFlight = null
    this.hooks.copy(reply, e.water !== null)
    if (reply.applied) this.hooks.applied(e.tick, e.arrived)
    else if (e.water === null && e.settles) this.hooks.settled()
    this.drain()
  }

  /** Forgets the request in flight and the queue (the worker was lost). */
  reset(): void {
    this.inFlight = null
    this.queue.length = 0
  }

  /** Sends the queue's head; entries with nothing for the host only release the clock, in order. */
  private drain(): void {
    while (this.inFlight === null && this.queue.length > 0) {
      const e = this.queue.shift()!
      if (e.water === null && e.relight.length === 0) { if (e.settles) this.hooks.settled(); continue }
      const id = ++this.nextId, shown = this.hooks.shown()
      this.inFlight = { ...e, id, shown }
      this.hooks.post({ type: 'apply', id, tick: e.tick, water: e.water, shown, relight: e.relight })
    }
  }
}
```

With an in-thread host, `post` calls `receive` immediately. The nested `drain` then sends the next entry before the outer
loop resumes, and the outer loop picks up the queue as the inner one left it. The order is kept.

- [ ] **Step 3: Run the tests**

Run: `npx vitest run --root packages/engine test/waterLink.test.ts test/surfaceMirror.test.ts`. Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git -C C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf add packages/engine/src/render/water/waterLink.ts packages/engine/test/waterLink.test.ts
git -C C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf commit -m "feat(water): WaterLink keeps one water request in flight and queues the rest in tick order (spec 4.1)"
```

### Task 6: `waterResync`: the next publish lists every tile

**Files:**
- Modify: `packages/engine/src/sim/water/waterSystem.ts`: add `republishAll()`.
- Modify: `packages/engine/src/protocol.ts`: append `| { type: 'waterResync' }` to `ToSim`, with a doc comment.
- Modify: `packages/engine/src/sim/simHost.ts`: add a `case 'waterResync'`.
- Test: `packages/engine/test/waterResync.test.ts`

**Interfaces:**
- Produces: `WaterSystem.republishAll(): void`; `ToSim` `{ type: 'waterResync' }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { AIR } from '../src/world/voxel.ts'
import { B, run, w, waterSim, type Fill } from './waterHelpers.ts'

/** A walled lake (x, z < 20) draining through a gap in its x = 19 wall onto open ground; 64 × 32 × 64 (16 tiles). */
const world: Fill = (x, y, z) => {
  if (y === 0) return B.stone
  if (x < 20 && z < 20) {
    if (y > 8) return AIR
    const wall = x === 0 || z === 0 || x === 19 || z === 19
    if (wall) return x === 19 && z === 10 && y >= 4 ? AIR : B.stone
    return w(7)
  }
  return y <= 2 ? B.stone : AIR
}

describe('waterResync (4a-r2 #2, spec 4.5)', () => {
  it('the next publish lists every tile, and the world hash stays what it would be without it', () => {
    const a = waterSim(world, { size: [64, 32, 64] }), b = waterSim(world, { size: [64, 32, 64] })
    run(a, 10); run(b, 10)
    b.water.republishAll()
    const ta = a.step().water, tb = b.step().water
    expect(tb!.tiles.length).toBe(16)
    expect(ta === null || ta.tiles.length < 16).toBe(true)
    expect(b.hash()).toBe(a.hash())
    for (let i = 0; i < 30; i++) { a.step(); b.step(); expect(b.hash()).toBe(a.hash()) }
  })
})
```

Run: `npx vitest run --root packages/engine test/waterResync.test.ts`. Expected: FAIL, because `republishAll` is not a
function.

- [ ] **Step 2: Implement**

In `WaterSystem`, after `flush()`:

```ts
  /**
   * The next flush publishes every tile, with its layer records, as the first publish after generation does: for a water
   * view that starts over (a respawned water worker, 4a-r2 #2). `dirty` is publish bookkeeping, not world state (tiles.ts).
   */
  republishAll(): void { this.cols.tiles.dirty.fill(1) }
```

In `protocol.ts`, append to `ToSim`:

```ts
  /** Main thread: the water view starts over (its worker was respawned); the next publish lists every tile. */
  | { type: 'waterResync' }
```

In `SimHost.handle`, after `case 'setPaused'`:

```ts
      case 'waterResync':
        this.sim?.water.republishAll()
        return
```

- [ ] **Step 3: Run the test, the engine suite and the typecheck**

Run each with its output redirected to a file:
- `npx vitest run --root packages/engine test/waterResync.test.ts`
- `npm run test -w @elovox/engine`
- `npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git -C C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf add packages/engine/src/sim/water/waterSystem.ts packages/engine/src/protocol.ts packages/engine/src/sim/simHost.ts packages/engine/test/waterResync.test.ts
git -C C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf commit -m "feat(sim): waterResync makes the next water publish list every tile"
```

### Task 7: The water worker in the engine

**Files:**
- Create: `packages/engine/src/render/water/water.worker.ts`
- Modify: `packages/engine/src/render/water/waterSurface.ts`, `ripples.ts`, `render/visuals.ts`. Type-only: `SurfaceView` becomes `SurfaceSource`.
- Modify: `packages/engine/src/engine.ts` (the water path, the options and the stats) and `apps/sandbox/src/main.ts` (one line).
- Test: the existing suites, plus `apps/sandbox/e2e/water-worker.spec.ts` (create).

**Interfaces:**
- Consumes: Tasks 4–6.
- Produces:
  - `EngineOptions.waterWorker?: boolean` (default true);
  - `EngineStats` fields `waterHostMs`, `waterHostP95`, `waterLagMs`, `waterLagP95`, `waterQueue`, `waterQueueMax`, `waterInWorker`;
  - a debug-only test hook `__elovoxWaterCrash` (Step 3).

- [ ] **Step 1: The worker shell**

```ts
import type { WorldBuffers } from '../../world/buffers.ts'
import { WorldReader } from '../../world/reader.ts'
import type { DrawnSurfaces } from './surfaceView.ts'
import { WaterHost, type WaterRequest } from './waterHost.ts'

/** Main thread → water worker. `opaque`: the registry's opaque table, for the light reader. */
export type ToWater =
  | { type: 'init'; buffers: WorldBuffers; opaque: Uint8Array; pages: SharedArrayBuffer[]; stepHz: number; surfaces: DrawnSurfaces }
  | { type: 'page'; index: number; page: SharedArrayBuffer }
  | WaterRequest

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<ToWater>) => void) | null
}
const scope = globalThis as unknown as WorkerScope
let reader: WorldReader | null = null
let host: WaterHost | null = null

scope.onmessage = (e) => {
  const m = e.data
  if (m.type === 'init') {
    const r = new WorldReader(m.buffers, m.opaque)
    m.pages.forEach((p, i) => r.addPage(i, p))
    reader = r
    host = new WaterHost(m.buffers.size, m.buffers.water, (x, y, z) => r.getLight(x, y, z), m.stepHz, m.surfaces)
    return
  }
  if (m.type === 'page') { reader?.addPage(m.index, m.page); return }
  // An exception here reaches the main thread as the worker's error event: the engine respawns once (spec 4.5).
  const reply = host!.handle(m)
  scope.postMessage(reply, [reply.keys.buffer, reply.data.buffer])
}
```

- [ ] **Step 2: Retype the consumers**

- `waterSurface.ts`: use `import type { ColumnData } from './surfaceView.ts'` and `import type { SurfaceSource } from './surfaceMirror.ts'`,
  and type `view` as `SurfaceSource` in the field and the constructor. Nothing else changes there; lod's visibility hunk
  lands beside it at merge.
- `ripples.ts`: `waterLineSurface(view: Pick<SurfaceSource, 'surfaceNear'>, …)`, and the same in `atWaterLine` and
  `editRipples`. Replace the import.
- `visuals.ts`: `water: SurfaceSource` in `VisualsOptions`, imported from `./water/surfaceMirror.ts`.

- [ ] **Step 3: Engine wiring (water path only)**

**`EngineOptions`.** Append:

```ts
  /**
   * Apply the water publishes in a dedicated worker (4a-r2 #2): the main thread only copies changed rows. False: the same
   * host runs in-thread, the A of the A/B. Default true.
   */
  waterWorker?: boolean
```

**`EngineStats`.** Change the doc comment on `waterApplyMs; waterApplyP95` to: "Main-thread cost (ms) of a water publish:
the copy of the host's reply, plus the host's own cost when it runs in-thread. The last one and the p95 of the last 200."
Then append:

```ts
  /** The water host's cost (ms) per request (apply + relights + packing), in the worker or in-thread: last and p95. */
  waterHostMs: number; waterHostP95: number
  /** From a tick message's arrival to the first frame that draws its water step (ms), queue wait included: last and p95. */
  waterLagMs: number; waterLagP95: number
  /** Water requests in flight or queued, now and the most over the last 200 ticks. */
  waterQueue: number; waterQueueMax: number
  /** Whether the water host runs in a worker (EngineOptions.waterWorker). */
  waterInWorker: boolean
```

**The mirror and the relight ranges.** Replace `const waterView = new SurfaceView(…)` and `relightWater` with:

```ts
  // The water's draw data: copied from a WaterHost, in a worker or in-thread (4a-r2 #2).
  const surfaceMirror = new SurfaceMirror(size, buffers.water)
  const inWorker = o.waterWorker ?? true
  /** Per chunk column, the layers [lo, hi) of the dirty chunks in it (relightRanges' scratch). */
  const relightRange = new Map<number, [number, number]>()
  /** The light ranges [cc, y0, y1]* where the sim changed voxel light (dirty chunks): still water is not republished. */
  const relightRanges = (chunks: readonly number[]): number[] => {
    if (chunks.length === 0) return []
    for (const ci of chunks) {
      const [cx, cy, cz] = layout.chunkCoords(ci)
      const cc = cx + cz * surfaceMirror.cx, r = relightRange.get(cc)
      if (r) { r[0] = Math.min(r[0], cy * 32); r[1] = Math.max(r[1], cy * 32 + 32) } else relightRange.set(cc, [cy * 32, cy * 32 + 32])
    }
    const out: number[] = []
    for (const [cc, [lo, hi]] of relightRange) out.push(cc, lo, hi)
    relightRange.clear()
    return out
  }
```

**The host, the link and the meters.** Keep `waterTick` and `waterShown`, and add the following after them. The line
`const waterApply = new CostMeter(200)` moves up here from the sim section.

```ts
  const waterApply = new CostMeter(200), waterHostCost = new CostMeter(200), waterLag = new CostMeter(200)
  /** The arrival time of the publish whose step the next frame draws first (waterLag), or null. */
  let lagFrom: number | null = null
  /** The in-thread host (waterWorker false); otherwise the worker and its crash count. */
  const localHost = inWorker ? null : new WaterHost(size, buffers.water, (x, y, z) => reader.getLight(x, y, z), 1000 / tickMs, surfaceMirror.surfaces)
  let waterWorker: Worker | null = null, waterCrashes = 0
  const waterLink: WaterLink = new WaterLink({
    post: (req) => {
      if (localHost) waterLink.receive(localHost.handle(req))
      else waterWorker?.postMessage(req)
    },
    copy: (reply, publish) => {
      const t0 = performance.now()
      surfaceMirror.copy(reply)
      waterHostCost.record(reply.hostMs)
      if (publish) waterApply.record(performance.now() - t0 + (localHost ? reply.hostMs : 0))
    },
    applied: (tick, arrived) => { waterTick = tick; waterShown = 0; clock.hold(surfaceMirror, tick + 1); lagFrom = arrived },
    settled: () => clock.hold(surfaceMirror, null), // every tile settled (prev = cur): nothing to time
    shown: () => waterShown,
  })
```

**Visuals.** Replace `water: waterView` with `water: surfaceMirror`.

**The worker.** After `for (let i = 0; i < poolSize; i++) spawn(i, 0)`, add:

```ts
  // ---- water worker (4a-r2 #2) ----
  const spawnWater = (): Worker => {
    const worker = new Worker(new URL('./render/water/water.worker.ts', import.meta.url), { type: 'module' })
    const lost = (reason: string) => {
      worker.terminate()
      if (halted || waterWorker !== worker) return
      // One respawn: the new view starts empty and the sim republishes every tile (spec 4.5). A second loss is fatal.
      if (++waterCrashes >= 2) { fail(`water worker crashed twice: ${reason}`); return }
      console.error(`[elovox] water worker lost (${reason}); restarting it`)
      waterLink.reset()
      surfaceMirror.reset()
      waterWorker = spawnWater()
      sim.postMessage({ type: 'waterResync' } satisfies ToSim)
    }
    worker.onmessage = (e: MessageEvent<WaterReply>) => { if (waterWorker === worker) waterLink.receive(e.data) }
    worker.onerror = (e) => { e.preventDefault(); lost(e.message || 'the worker failed to load or crashed') }
    worker.onmessageerror = () => lost('the worker sent a message that could not be deserialized')
    worker.postMessage({ type: 'init', buffers, opaque: registry.opaque, pages: [...pages], stepHz: 1000 / tickMs, surfaces: surfaceMirror.surfaces } satisfies ToWater)
    return worker
  }
  if (inWorker) waterWorker = spawnWater()
```

**`halt()`.** After `sim.terminate()`, add `waterWorker?.terminate()`.

**Sim `onmessage`.**
- `case 'page'`: after the mesh workers' loop, add
  `waterWorker?.postMessage({ type: 'page', index: m.index, page: m.page } satisfies ToWater)`.
- `case 'tick'`: replace the block `if (m.water) { … } else clock.hold(waterView, null)` and the `relightWater(m.dirtyChunks)`
  line that follows it with
  `waterLink.submit(m.tick, m.water, relightRanges(m.dirtyChunks), true, performance.now())`.
- `case 'regenerated'`: replace `relightWater(m.dirtyChunks)` with:

```ts
        { const ranges = relightRanges(m.dirtyChunks); if (ranges.length > 0) waterLink.submit(-1, null, ranges, false, performance.now()) }
```

**Frame loop.** Replace `waterShown = waterTick === null ? 1 : stepAlpha(clock.due, waterTick)` with:

```ts
    // A publish in the host is drawn at the alpha it was sent with until its copy (spec 4.1: freeze, not carry).
    waterShown = waterLink.frozen ?? (waterTick === null ? 1 : stepAlpha(clock.due, waterTick))
    if (lagFrom !== null) { waterLag.record(now - lagFrom); lagFrom = null }
```

**`stats()`.** After `waterApplyMs: waterApply.last, waterApplyP95: waterApply.p95(),` add:

```ts
        waterHostMs: waterHostCost.last, waterHostP95: waterHostCost.p95(), waterLagMs: waterLag.last, waterLagP95: waterLag.p95(),
        waterQueue: waterLink.depth, waterQueueMax: waterLink.maxDepth(), waterInWorker: inWorker,
```

**Imports.** Add:
- `SurfaceMirror` from `./render/water/surfaceMirror.ts`;
- `WaterHost` and `type WaterReply` from `./render/water/waterHost.ts`;
- `WaterLink` from `./render/water/waterLink.ts`;
- `type ToWater` from `./render/water/water.worker.ts`.

Drop the `SurfaceView` import if it is no longer used.

**Debug crash hook.** When the page URL has `?debug`, expose
`(globalThis as { __elovoxWaterCrash?: () => void }).__elovoxWaterCrash = () => waterWorker?.dispatchEvent(new ErrorEvent('error', { message: 'test crash' }))`.
This runs the same `lost` path as a real crash. If the engine or `main.ts` already has a debug-flag convention, follow it
instead of adding a new one.

**Sandbox.** In `apps/sandbox/src/main.ts`, add next to `batchChunks: !params.has('nobatch'),`:

```ts
    // ?nowaterworker: the water host runs on the main thread (the before of 4a-r2 #2's A/B).
    waterWorker: !params.has('nowaterworker'),
```

- [ ] **Step 4: e2e for the worker path**

`apps/sandbox/e2e/water-worker.spec.ts` (always runs, no timing):
1. Load `/?scene=flood&debug` and wait for ready. Break the dam as `flood.spec.ts` does. Check:
   - `stats().waterInWorker === true`
   - `waterQueue <= 3`, `waterLagP95 > 0`, `waterHostP95 > 0`
2. Call `__elovoxWaterCrash()` and wait 2 s. Check:
   - `waterColumns > 0`, and `waterApplyP95` keeps updating, so the respawned worker works;
   - exactly one `[elovox] water worker lost` console error, and no other errors.
3. Call `__elovoxWaterCrash()` again and wait for the `fatal` event: the second crash is fatal.
4. In a fresh page, load `/?scene=flood&nowaterworker` and break the dam. Check `waterInWorker === false` and that
   `waterColumns` grows (the water flows).
5. Call `engine.dispose()` while the dam runs, and check there are no console errors.

- [ ] **Step 5: Full verification**

Run each with its output redirected to a file, then read the file:
- `npm run test -w @elovox/engine`
- `npm run test -w @elovox/sandbox`
- `npm run typecheck`
- from `apps/sandbox`:
  `E2E_PORT=5184 E2E_CHANNEL=msedge npx playwright test e2e/water-worker.spec.ts e2e/water-render.spec.ts e2e/flood.spec.ts e2e/caves.spec.ts e2e/living.spec.ts e2e/smoke.spec.ts e2e/batching.spec.ts --workers=1`

Expected: all pass. `water-render.spec.ts`'s `waterApplyP95 > 0` still holds, because the copy has a cost.

- [ ] **Step 6: Commit**

```powershell
git -C C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf add packages/engine/src/render/water/water.worker.ts packages/engine/src/render/water/waterSurface.ts packages/engine/src/render/water/ripples.ts packages/engine/src/render/visuals.ts packages/engine/src/engine.ts apps/sandbox/src/main.ts apps/sandbox/e2e/water-worker.spec.ts
git -C C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf commit -m "perf(water): water publishes applied in a dedicated worker; the main thread copies changed rows (?nowaterworker: in-thread)"
```

### Task 8: Measure in a quiet window: A/B (lag, backlog, clip), anatomy, gate (also re-runs #5's gate)

**Files:**
- Create: `apps/sandbox/e2e/water-ab.spec.ts`; `apps/sandbox/e2e/living-anatomy.spec.ts`, promoted from
  `anatomy.scratch.spec.ts` (delete the scratch file); `apps/sandbox/bench/anatomy.node.mjs`, from the scratchpad's
  `anatomy.mjs`.
- Create (in the window): `docs/superpowers/research/2026-10-08-living-r2-water-ab.json`,
  `docs/superpowers/research/2026-10-08-living-r2-anatomy-after-2.json`, `docs/superpowers/research/2026-10-08-living-r2-after-2.json`.
- Modify: this plan (results).

- [ ] **Step 1: `water-ab.spec.ts`** (skipped unless `BENCH_WATER_AB=1`)

- **Builds compared.** A = `?scene=living&gpu&nowaterworker`, B = `?scene=living&gpu`.
- **Order.** ABBA, then BABA. Each page runs in a fresh browser context. Runs 1 and 2 also record video
  (`recordVideo: { dir: 'test-results/water-ab-video' }`).
- **Per page:** wait for ready, wait 10 s, `settle`. Then three windows:
  - `work-far`, 15 s: startWork 1 s in, far camera;
  - `dam`, 20 s: breach 1 s in, dam camera;
  - `collapse`, 15 s: collapse 1 s in, tower camera.
- **Per window it records:**
  - fps p5 from rAF intervals, and CPU frame median;
  - main apply p95: `waterApplyMs` sampled on each `tick` event;
  - host p95: `waterHostMs`, sampled the same way;
  - lag p50/p95: `waterLagMs` sampled per tick, in ms, in frames at 180 Hz (`/ (1000/180)`) and at 60 Hz (`/ (1000/60)`);
  - `waterQueueMax` at the end;
  - mesh backlog: mean and p95 of `meshQueue + meshInFlight` per frame.
- **Output:** `process.env.WATER_AB_OUT`, as `{ date, order, runs: { run, build, windows: {...} }[] }`.

- [ ] **Step 2: Promote the anatomy tool**

- Move the scratch spec to `e2e/living-anatomy.spec.ts` unchanged, except for its header comment: "Per-frame anatomy of the
  living scene (4a-r2): which frames are long and what the main thread did in them. `ANATOMY=1`; `ANATOMY_QUERY` appends to
  the URL; `ANATOMY_OUT` sets the file."
- Copy the summary script to `bench/anatomy.node.mjs`.

Commit them together with `water-ab.spec.ts`:

```powershell
git -C C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf add apps/sandbox/e2e/water-ab.spec.ts apps/sandbox/e2e/living-anatomy.spec.ts apps/sandbox/bench/anatomy.node.mjs
git -C C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\perf commit -m "test(sandbox): water worker A/B (lag, host cost, mesh backlog, clips) and the living frame anatomy"
```

- [ ] **Step 3: Request the window**

Run `npm run build` in `apps/sandbox` first. Then send:
`WINDOW REQUEST: #2 water A/B (ABBA+BABA, ~12 min) + anatomy after #2 (~3 min) + living gate (2 runs, ~6 min), ~25 min`.

In the window:
1. Record free RAM and `Get-Process cs2,HogwartsLegacy,steam`.
2. Run the A/B with `BENCH_WATER_AB=1 WATER_AB_OUT=../../docs/superpowers/research/2026-10-08-living-r2-water-ab.json`.
3. Run the anatomy with `ANATOMY=1 ANATOMY_OUT=../../docs/superpowers/research/2026-10-08-living-r2-anatomy-after-2.json`.
4. Run the gate with `LIVING_BENCH_OUT=../../docs/superpowers/research/2026-10-08-living-r2-after-2.json`. This also
   re-runs the gate for #5, since the earlier one was provisional.
5. Copy the two videos out of `test-results` before anything else runs.
6. Record free RAM and the heavy apps again, then send DONE.

- [ ] **Step 4: Decide**

- **Revert or keep Task 7.** Revert it if B's main apply p95 and fps p5 do not beat A's in every adjacent pair of dam and
  collapse.
- **Mesh backlog.** If B's mean backlog in dam or collapse is more than 20% above A's, set the pool to
  `min(6, hardwareConcurrency − 3)` when the water worker is on, then repeat the A/B and tell the expert.
- **Lag.** Send the expert the lag p50/p95, in frames at 180 Hz and 60 Hz, plus the two clips, for the checkpoint
  decision.

- [ ] **Step 5: Results and commit**

Append a "Results: #2" section to this plan with:
- the A/B table: per run and window, CPU median, fps p5, main apply p95, host p95, lag p50/p95, queue max, backlog;
- the anatomy summary: long frames with and without an apply;
- the gate against the baseline: per phase, fps p5, CPU median, tick p95, apply p95;
- the heavy apps running at start and end.

Commit the three JSONs and the plan, naming Task 7's SHA and its numbers.

---

# Part 3 (after #2): back to the tick

Per the expert's decision, in order:
1. **#5 step 2:** publish's dense loop and flush's mirror loop.
2. **#5 step 3:** the water step's hot loops, behind a second golden hash on column state.

Each step is planned here, as Tasks 9+, once #2's results are in.

**Rename during execution (Task 6):** the main-thread mirror is `SurfaceMirror` (`render/water/surfaceMirror.ts`,
`test/surfaceMirror.test.ts`), not `WaterMirror`. The sim already has a `WaterMirror` (`sim/water/mirror.ts`, the voxel
mirror), and its test file `test/waterMirror.test.ts` was overwritten by mistake in Task 4's commit `8abaf86`. That file is
restored from `90e5c97` in Task 6's commit.

**As built, Task 7.**
- **Crash hook.** It is a non-enumerable method keyed by `Symbol.for('elovox.waterCrash')` on the engine object, not a
  `?debug` global. It is not on the `Engine` type, so it is unreachable from the public API (the expert's @internal rule),
  and no sandbox flag is needed.
- **The e2e's queue check.** It waits for `waterQueue <= 1`, the queue draining, instead of asserting `<= 3`. Headless
  SwiftShader draws about one frame a second, and ticks bunch up behind each frame. That is exactly what `waterLagMs`
  reports.

## Results: #2 (`ca129f1`: water publishes applied in a dedicated worker)

Quiet window, 2026-10-09, 09:06–09:23. Edge headed, prod build at `eb138b6` (`0c51901` + the A/B video knob), 179 Hz
display.
- Free RAM: 14.67 GB at the start, 15.28 GB at the end, 15.1–15.2 GB between steps.
- Heavy apps at every step's start and end: `steam` only (107–116 MB). No game, so the gate counts.
- The A/B ran as two invocations, ABBA then BABA, merged as runs 1–8 (expert-approved, so each half fits one foreground
  call). Attribution comes from the pairs inside a half. Pair 4–5 spans the browser restart and is not used alone.
- Runs 1–2 recorded video, which loads the CPU. Both builds are slower in them, so they are reported but not used for
  the lag figures.

**Water A/B** (`research/2026-10-08-living-r2-water-ab.json`). A = `?nowaterworker`, the host in-thread; B = the host
in its worker.
- Columns: CPU median ms, fps p5, main apply p95 ms, host p95 ms, lag p50 / p95 ms, queue max, mean mesh backlog.
- In A, "lag" is the time from tick to shown, the in-thread host plus the wait for the next frame.

| Run | Build | Window | CPU med | fps p5 | apply p95 | host p95 | lag p50 / p95 | queue | backlog |
|---|---|---|---|---|---|---|---|---|---|
| 1 | A | work-far | 8.13 | 45.0 | 9.98 | 9.66 | 8.0 / 10.2 | 1 | 0.72 |
| 1 | A | dam | 8.68 | 30.0 | 25.35 | 24.97 | 19.2 / 25.5 | 1 | 1.79 |
| 1 | A | collapse | 9.75 | 22.6 | 30.41 | 29.94 | 24.0 / 30.6 | 1 | 3.55 |
| 2 | B | work-far | 9.67 | 59.9 | 0.52 | 10.78 | 11.4 / 16.9 | 1 | 0.74 |
| 2 | B | dam | 11.83 | 45.0 | 1.05 | 39.56 | 29.2 / 72.4 | 3 | 1.64 |
| 2 | B | collapse | 13.62 | 44.9 | 1.24 | 54.29 | 50.2 / 120.1 | 3 | 2.29 |
| 3 | B | work-far | 7.24 | 89.3 | 0.36 | 8.97 | 9.8 / 15.5 | 1 | 0.63 |
| 3 | B | dam | 7.58 | 89.6 | 0.58 | 23.77 | 22.9 / 30.6 | 1 | 1.18 |
| 3 | B | collapse | 8.62 | 60.0 | 0.85 | 30.86 | 28.8 / 42.7 | 2 | 1.64 |
| 4 | A | work-far | 6.35 | 60.0 | 8.57 | 8.34 | 6.5 / 8.8 | 1 | 0.61 |
| 4 | A | dam | 7.04 | 36.0 | 22.42 | 21.84 | 16.4 / 22.7 | 1 | 1.47 |
| 4 | A | collapse | 7.75 | 30.0 | 26.23 | 25.77 | 19.6 / 26.5 | 1 | 2.47 |
| 5 | B | work-far | 6.49 | 89.7 | 0.31 | 8.04 | 9.9 / 12.5 | 1 | 0.60 |
| 5 | B | dam | 7.31 | 89.3 | 0.56 | 22.17 | 21.9 / 29.0 | 1 | 1.18 |
| 5 | B | collapse | 7.96 | 60.9 | 0.70 | 28.13 | 27.3 / 38.1 | 2 | 1.56 |
| 6 | A | work-far | 6.12 | 60.0 | 9.12 | 8.92 | 6.3 / 9.2 | 1 | 0.59 |
| 6 | A | dam | 7.39 | 35.9 | 22.79 | 22.34 | 16.8 / 23.1 | 1 | 1.57 |
| 6 | A | collapse | 8.23 | 25.7 | 27.58 | 26.90 | 20.4 / 27.9 | 1 | 2.72 |
| 7 | B | work-far | 6.01 | 89.9 | 0.32 | 8.80 | 9.6 / 14.8 | 1 | 0.53 |
| 7 | B | dam | 6.83 | 89.4 | 0.56 | 25.61 | 22.8 / 34.3 | 2 | 1.12 |
| 7 | B | collapse | 7.33 | 89.4 | 0.77 | 29.17 | 28.2 / 35.8 | 2 | 1.44 |
| 8 | A | work-far | 6.24 | 60.0 | 8.79 | 8.50 | 6.2 / 9.1 | 1 | 0.61 |
| 8 | A | dam | 6.88 | 36.0 | 23.35 | 22.91 | 16.6 / 23.7 | 1 | 1.45 |
| 8 | A | collapse | 7.74 | 25.7 | 28.30 | 27.88 | 20.1 / 28.5 | 1 | 2.49 |

- **Main apply and fps.** B wins every adjacent pair in dam and collapse, on both apply p95 and fps p5. Apply p95 goes
  from 22–30 ms to 0.56–1.24 ms. fps p5 goes from 26–36 to 45–90, or 60–90 without video.
- **Host cost.** The host in the worker costs about what it costs in-thread, roughly +0–15% at p95: dam 22–26 against
  22–23, collapse 28–31 against 26–28. The 2× of the headless smoke, 88–100 against 41–50, was SwiftShader saturating
  the CPU.
- **Lag in B, runs 3–8:**
  - dam: p50 21.9–22.9 ms, p95 29.0–34.3 ms. At 180 Hz that is 5.2–6.2 frames at p95; at 60 Hz, 1.7–2.1 frames.
  - collapse: p50 27.3–28.8 ms, p95 35.8–42.7 ms. At 180 Hz that is 6.5–7.7 frames at p95; at 60 Hz, 2.2–2.6 frames.
  - Added over A in the same runs: p50 +5–6 ms in dam and +7–9 ms in collapse; p95 +6–11 ms in dam and +8–15 ms in
    collapse. That is under one 60 Hz frame.
  - Queue max is 1–2.
- **Lag under load.** In run 2 (video recording), B's queue reaches 3, and lag p95 reaches 72 ms in dam and 120 ms in
  collapse, 4.3 and 7.2 frames at 60 Hz. A does not queue, because its host is synchronous. When the CPU is short,
  queueing is how the worker path degrades. The headless smoke showed the extreme of it: queue 6–7, 235–280 ms.
- **Mesh backlog.** B's mean backlog is at or below A's in every window: dam 1.12–1.18 against 1.45–1.57, collapse
  1.44–1.64 against 2.47–2.72. The pool rule does not trigger.

**Frame pacing in today's session.** In both builds, frames alternate between one and two vsyncs, about half each,
even when idle at ~5 ms CPU. That holds the frame rate at ~120 fps and fps p5 at ~89.5, two 179 Hz vsyncs. At the
baseline, the idle phases ran 1-vsync frames ~89% of the time, ~170 fps. A and B have the same frame counts in today's
A/B, so the cause is the browser or OS pacing in this session, not #2. fps p5 ≥ 60 still means "no frame longer than
three vsyncs", so the target keeps its meaning. fps medians and means are not comparable with the baseline.

**Anatomy after #2** (`research/2026-10-08-living-r2-anatomy-after-2.json`; summary from `bench/anatomy.node.mjs`).
- Long frames are intervals over 16.7 ms. With #2 the main-thread apply is gone from them.

| Phase | Long frames, baseline → after | Of which with an apply | Main apply p50 / p95 per tick, ms |
|---|---|---|---|
| idle-far | 2 → 3 | 2 → 0 | 4.7 / 6.2 → 0.2 / 0.3 |
| dam | 298 (14.5%) → 17 (0.7%) | 297 → 8 | 12.7 / 17.4 → 0.4 / 0.6 |
| collapse | 305 (23.9%) → 19 (1.1%) | 300 → 10 | 15.6 / 21.1 → 0.5 / 0.7 |

- The few long frames left are ~17 ms of CPU, with apply medians of 0.0–0.4 ms. They are not apply frames.

**Gate** (`research/2026-10-08-living-r2-after-2.json`, worse of two runs, `invalid: []`). Valid, since no game was
running. This also re-runs #5's gate, which was provisional: the build contains `7f9dfc0`.

| Phase | fps p5: baseline → after | CPU median | tick p95 | apply p95 | Pass |
|---|---|---|---|---|---|
| idle-default | 90.3 → 89.5 | 4.4 → 5.1 | 5.0 → 5.4 | 5.65 → 0.32 | yes |
| idle-far | 89.8 → 89.4 | 5.8 → 6.1 | 5.4 → 5.3 | 6.0 → 0.33 | yes |
| work-default | 89.9 → 89.4 | 5.2 → 5.8 | 7.2 → 8.0 | 6.4 → 0.31 | yes |
| work-far | 60.1 → 89.5 | 6.3 → 6.5 | 7.7 → 8.1 | 6.9 → 0.32 | yes |
| dam | 36.0 → 60.2 | 7.9 → 8.0 | 13.4 → **12.3** | 21.6 → 0.69 | no (tick) |
| collapse | 30.1 → 88.6 | 7.9 → 7.8 | 15.6 → **13.9** | 22.6 → 0.79 | no (tick) |

- fps p5 ≥ 60 and apply p95 ≤ 4 now pass in every phase. Dam's fps p5 comes from run 2's 60.24; run 1 had 89.25.
- The only miss left is tick p95 in dam (12.3) and collapse (13.9), against ≤ 10. That is Part 3.
- #5 in the browser: the sim tick p95 drops 8–11% against the baseline, 13.4 → 12.3 and 15.6 → 13.9. That is less than
  the −27–30% of the Node A/B, because the browser tick includes more than the water publish.

**Decision (Step 4).**
- **Keep Task 7 (`ca129f1`).** B beats A on main apply p95 and fps p5 in every adjacent dam and collapse pair.
- **The mesh pool stays as it is.** B's backlog is not above A's.
- **Lag.** On a quiet machine, the added lag is under one 60 Hz frame at p95 (+6–15 ms). Under CPU load it grows with
  the queue, to 72–120 ms p95 with video recording. The numbers and clips (runs 1 A and 2 B, both with video) went to
  the expert for the checkpoint decision.

---

# Part 3, Task 9: #5 step 2, publish's dense loop and flush's mirror loop

Where things stand after #2:
- **Target:** tick p95 ≤ 10 ms.
- **Gate:** dam 12.3, collapse 13.9.
- **Node A/B after step 1:** dam 14.0, collapse 17.3–18.3.
- **Old profile shares** (spec §1, before step 1): publish's dense loop 8.7% self, flush's mirror loop 5.9% self, the
  water step 37.4%.
- **Arithmetic:** even if step 2 removed both loops entirely, it would cut ~15–18% of the tick, about 12.3 → ~10.3 in the
  dam. So step 2 alone probably does not reach the target, and step 3 (the water step) is where most of what remains
  lies. Step 1 below checks this before any code changes.

### Task 9

**Files:**
- Modify: `packages/engine/src/sim/water/publish.ts` (the dense loop in `publish`), `packages/engine/src/sim/water/waterSystem.ts`
  (`flush`), `packages/engine/test/waterPublishGolden.test.ts` (a second golden).
- Modify: `apps/sandbox/playwright.config.ts` (`E2E_PREVIEW_DIR`, for the browser A/B).
- Create (in the window): `docs/superpowers/research/2026-10-08-living-r2-node-ab-5b.json` and
  `docs/superpowers/research/2026-10-08-living-r2-browser-ab-5b.json`.

- [ ] **Step 1: Profile at HEAD, outside a window (not evidence)**

Run the scratch inspector variant of `bench/living.node.ts` (dam and collapse windows) at HEAD and summarize it with
`inclusive.mjs`. Record the self and inclusive shares of the following, in the dam and collapse windows:
- `WaterPublisher.publish`, its own dense loop;
- `records`;
- `WaterSystem.flush` self;
- `mirrorRun`;
- `quantize`;
- `columns.step` and its four hot loops.

**Go/no-go, sent to the expert:**
- **Go:** publish self plus the flush loop together are ≥ 10% of the dam tick. Steps 2–5 follow.
- **Below 10%:** step 2 cannot move tick p95 measurably. I propose to fold its two changes into step 3's work: still
  separate commits and separate A/B items, but one window.

- [ ] **Step 2: Characterization test first, passing on the current code**

In `waterPublishGolden.test.ts`, add a second `it` over the same world, edits and ticks: `mirrors exactly what the
code before step 2 mirrored`. It mixes `sim.hash()` after every tick. That hash covers the voxels, which the mirror
writes, and the water state (`WaterMirror.lo`/`q`, `U.mirrorLo`/`mirrorQ`). The final hash is recorded as `GOLDEN_STATE`
on the code before any change.
- **Not vacuous:** in a scratch edit, make `mirrorRun` write `part` instead of `part − 1` for the partial cell. The test
  must fail. Revert the edit.
- The existing publish golden (`GOLDEN`) pins the publish output and stays unchanged.
- Commit: `test(water): golden hash of the simulation state per tick, recorded before 4a-r2 #5 step 2`.

- [ ] **Step 3: publish's dense loop**

Changes, with the output bit-identical:
- Hoist `cols.depth`, `cols.floor`, `cols.flux`, `this.surface` and `this.flux` into locals.
- Walk each row with a running column index `c` and output index `o = base + c`, instead of recomputing `x + z * sx`
  and `2 * (base + c)`.
- Inline `moved` and `clamp16` as local arithmetic, with the same integer operations: `>> FLUX_FP` on the magnitude,
  and the ±32767/−32768 clamp.
- Read `shown[c]` once into a local.

Then run:
- both goldens;
- `waterPublish`, `surfaceLayers`, `waterLayersWorld`, `waterWorld`, the water fuzz, `determinism`;
- `workers.test.ts` (the units' replay).

Commit: `perf(water): publish's dense loop on locals, one index per row`.

- [ ] **Step 4: flush's mirror loop**

Changes:
- Hoist `mirror.q`, `mirror.lo`, `U.first`, `U.next`, `U.floor`, `U.ceil`, `U.depth`, `U.mirrorLo` and `U.mirrorQ` into
  locals.
- **Lower segments:** apply the same fast path the top already has before calling `mirrorRun`. Skip the call when
  `mirrorQ[i] ≥ 0`, `mirrorLo[i] === floor` and `mirrorQ[i] === (depth > 0 ? quantize(floor·SUB + depth) : floor·8)`.
  That is exactly `mirrorRun`'s own early return, so the writes are unchanged.
- Bind `this.get`/`this.set` once, outside the tile loop.

The same suites as in Step 3, plus both goldens. Commit: `perf(water): flush's mirror loop skips unchanged lower
segments without a call`.

- [ ] **Step 5: Measure in a quiet window: the Node A/B, then a browser A/B of the tick**

Before the window:
- Detach a worktree `perf-a` at Task 9's parent (the golden-test commit), run `npm install`, then `npm run build` in its
  `apps/sandbox`.
- Build B (HEAD) in the perf worktree.
- Add `E2E_PREVIEW_DIR` to `playwright.config.ts`: the preview command gets `--outDir <dir>` when it is set, so one port
  serves either build. Commit it with the tooling.

The window request (~25 min): `#5 step 2 Node A/B (ABBA, ~10 min) + browser tick A/B (ABBA, anatomy spec, ~8 min)`.
1. Record free RAM and the heavy apps, as in Task 8.
2. **Node A/B:** `nodeAb.node.mjs <perf-a> <perf> ABBA research/2026-10-08-living-r2-node-ab-5b.json`. Report dam and
   collapse tick p50/p95.
3. **Browser A/B:** four foreground calls of `living-anatomy.spec.ts`, in the order A B B A. A sets
   `E2E_PREVIEW_DIR=<perf-a>/apps/sandbox/dist`; B uses the default. Each run writes `ANATOMY_OUT=<scratch>/anat-<run>-<build>.json`,
   and the four are merged into `research/2026-10-08-living-r2-browser-ab-5b.json`.
   - The tick is the per-tick `tickMs` that the anatomy already records. Report tick p50/p95 per run for dam and
     collapse.
   - This replaces Task 3's comparison of a gate against a baseline from another day. It answers in the browser, and in
     the same session, why step 1's Node gain (−27–30%) looked like −8–11% in the browser.
4. Record free RAM and the heavy apps, then send DONE.

- [ ] **Step 6: Decide and record**

- **Keep or revert each commit** (Steps 3 and 4). Revert it unless B's dam and collapse tick p95 are below A's in every
  adjacent pair of the Node A/B.
- **If Steps 3 and 4 are in one A/B,** a gain can't be split between them. A further split is asked of the expert only
  when the result is ambiguous.
- **Gate:** the browser gate (living-bench, two runs) runs after step 3 (the water step), not after step 2, unless the
  browser A/B shows tick p95 ≤ 10 already.
- **Results:** append "Results: #5 step 2" to this plan, commit the JSONs, and send the expert the numbers together with
  the note for step 3 (the new profile's water-step shares).

**Step 3 of #5** (water-step hot loops behind a second golden hash on the column state) is not planned here. It comes
after its note to the expert, per §3.1. Step 2's `GOLDEN_STATE` is already the "second golden hash on the column
state" that §3.2 asks for. `sim.hash()` reaches `WaterSystem.mixState`, which covers:
- per column: floor, depth, last and both fluxes;
- every lower segment: floor, ceil, depth, last, excess and its mirror;
- every edge: a, b, lo, axis and flux;
- tile awake/quiet;
- the voxels.

Step 3 reuses it, and may add a longer world if step 3's profile points at code the golden world does not reach.

## Results: #5 steps 2 and 3 (Task 9 plus the expert's step-3 ruling, option A)

**Window.** Two back-to-back windows, 2026-10-09, 10:13–10:33.
- Free RAM stayed between 15.2 and 16.1 GB. Steam (~105 MB) was the only heavy app, and no game was running.
- W1: a smoke run of `bench/nodeChain.node.mjs` (order `01`, not evidence; the tool was committed in `4ecf40c`), then
  the Node chain.
- W2: the browser tick A/B, then the gate.

**Items and sizing** (Node profile at `b57f54c` and per-tick phase timers; not evidence):
- In the dam window, the water step is ~48% of the tick, flush ~33% (publish 23%), `chunkStore.commit` 6% and random
  ticks 5%.
- The p95 ticks have the same mix as the median ones, about 1.9× larger. More tiles are awake in them; there is no rare
  phase.
- The expert's ruling added 3a–3c (`limitAll` inline, the dry-uneven early exit, the collapse witness) to step 2's 2a
  and 2b. Each is its own commit and its own A/B item.

**Node chain A/B** (`research/2026-10-08-living-r2-node-ab-5b.json`):
- One scratch checkout steps through `21313ea` (base), `42a76b6` (2a), `8c8270e` (2b), `a5953da` (3a), `d0cfdfd`
  (3b) and `9fe45d7` (3c), in the order `012345` then `543210`. So every item has two adjacent pairs, one in each
  direction.
- Noise between repeats of one build: dam p95 0.2–0.9 ms (~5%). Collapse p95 up to 2–4 ms, from single spikes in a
  400-tick window. p50 is reported alongside it.

Per item, the two adjacent pairs:

| Item | dam p95 | collapse p95 | dam p50 | collapse p50 | Verdict |
|---|---|---|---|---|---|
| 2a publish dense loop | 11.06→10.88 ✓, 10.43→10.58 ✗ | 11.77→11.31 ✓, 11.75→10.91 ✓ | 7.88→7.62 ✓, 7.27→7.17 ✓ | 7.74→7.69 ✓, 7.67→7.39 ✓ | keep |
| 2b flush mirror loop | 10.88→11.00 ✗, 10.58→10.05 ✓ | 11.31→15.21 ✗, 10.91→11.08 ✗ | 7.62→7.93 ✗, 7.17→7.19 ✗ | 7.69→8.14 ✗, 7.39→7.77 ✗ | **reverted** (`87b3df4`) |
| 3a limitAll inline | 11.00→10.02 ✓, 10.05→10.81 ✗ | 15.21→10.82 ✓, 11.08→11.16 ✗ | 7.93→6.99 ✓, 7.19→7.23 ≈ | 8.14→7.82 ✓, 7.77→7.26 ✓ | keep (within noise, leaning better) |
| 3b dry-edge exit | 10.02→10.62 ✗, 10.81→10.44 ✓ | 10.82→10.54 ✓, 11.16→13.52 ✗ | 6.99→7.21 ✗, 7.23→7.27 ≈ | 7.82→7.18 ✓, 7.26→8.86 ✗ | **reverted** (`d7e4f05`, no measured gain) |
| 3c collapse witness | 10.62→9.12 ✓, 10.44→9.45 ✓ | 10.54→12.24 ✗, 13.52→9.99 ✓ | 7.21→6.13 ✓, 7.27→6.00 ✓ | 7.18→7.48 ✗, 8.86→7.02 ✓ | keep |

- **Base to all five** (means of the two runs): dam p95 10.75 → 9.29 (−14%), p50 7.58 → 6.06 (−20%); collapse p95
  11.76 → 11.11 (−6%), p50 7.71 → 7.25.
- **Reverts.** The expert ruled to apply spec rule 4 (no measured gain, revert) to 2b and 3b. Both goldens are unchanged
  after the reverts, as expected for pure refactors.

**Browser tick A/B** (`research/2026-10-08-living-r2-browser-ab-5b.json`). Base dist against HEAD dist (`9fe45d7`, all
five items) on one port via `E2E_PREVIEW_DIR`, ABBA, using the living-anatomy spec. Tick p50 / p95:

| Run | Build | dam | collapse |
|---|---|---|---|
| 1 | A | 7.71 / 12.09 | 9.78 / 17.05 |
| 2 | B | 5.90 / 9.89 | 7.39 / 10.89 |
| 3 | B | 7.12 / 9.51 | 9.21 / 13.79 |
| 4 | A | 6.09 / 8.13 | 7.32 / 10.05 |

- **Inconclusive, because of a method limit.** Run 1, the first page of the session, is an outlier, and pair 3–4 goes
  the other way. One 20 s window per page cannot resolve 5–15% effects.
- This is not a finding that Node gains shrink in the browser. That question stays open, and answering it would take
  more pages per build.

**Gate** (`research/2026-10-08-living-r2-after-5b.json`, HEAD `9fe45d7`, before the two reverts; worse of two runs,
`invalid: []`):

| Phase | fps p5: baseline / after #2 → now | tick p95 | apply p95 | Pass |
|---|---|---|---|---|
| idle-default | 90.3 / 89.5 → 89.9 | 5.0 / 5.4 → 5.5 | 5.65 / 0.32 → 0.35 | yes |
| idle-far | 89.8 / 89.4 → 89.8 | 5.4 / 5.3 → 5.2 | 6.0 / 0.33 → 0.33 | yes |
| work-default | 89.9 / 89.4 → 89.9 | 7.2 / 8.0 → 7.8 | 6.4 / 0.31 → 0.38 | yes |
| work-far | 60.1 / 89.5 → 89.7 | 7.7 / 8.1 → 7.9 | 6.9 / 0.32 → 0.37 | yes |
| dam | 36.0 / 60.2 → 60.1 | 13.4 / 12.3 → **11.8** (run 2: 11.4) | 21.6 / 0.69 → 0.76 | no (tick) |
| collapse | 30.1 / 88.6 → 60.0 | 15.6 / 13.9 → **13.9** (run 2: 12.7) | 22.6 / 0.79 → 0.88 | no (tick) |

- fps p5 ≥ 60 and apply p95 ≤ 4 still pass in every phase.
- Tick p95 still misses 10 in dam and collapse.
- 2b and 3b were reverted after the gate. Neither showed a gain, so the gate stands for the kept set.

**Decision.**
- Kept: 2a `42a76b6`, 3a `a5953da`, 3c `9fe45d7`.
- Reverted: 2b and 3b.
- The tick target is not met by pure refactors. The expert took the re-scope question to main and the user, with the
  options:
  - (i) a tile-major layout;
  - (ii) stepping fewer tiles, a visible change;
  - (iii) re-scope, since after #2 the tick runs only in the sim worker at 20 Hz.

  Neither (i) nor (ii) is started.
- **The user's answer, 2026-10-09: (iii).** The tick target is now p95 ≤ 15 ms, with 10 ms as a stretch goal. The gate
  above passes every phase under it.

## Results: #2 fix: the batched link and the worker's catch-up read

**Found by the final e2e (2026-10-09).** Headless Chromium draws on SwiftShader at ~1.5 fps, and three water e2e failed
there with the worker: water-render's flood, caves' canal and water-worker's respawn. In-thread passed. Two defects lay
behind it:
1. **One tick per round trip.** `WaterLink` sent one tick per round trip, so below ~20 main-thread turns per second the
   queue grew without bound: +18/s, 3845 after 3.5 min.
2. **Stale reads.** Every publish reached the worker one main-thread turn after the sim had reused its parity. All of
   them deferred, so the sleeping lake listed only in the first publish was never drawn. Worker logs: request 1 (seq 1)
   met stamps already at 7/8.

**Fixes** (expert rulings A, A):
- `29fafa0`: the queue goes to the host as one batch.
- `abfede1`, narrowed in `504cc10`: the worker's last publish of a batch catches up from the newest complete parity.
  The read is seqlock-validated, and a later tick never reads an older buffer than the last one read.
  - Earlier stale entries, and the in-thread host, defer as before.
  - The first version let every stale tick catch up, and the in-thread path spiralled at low fps: one full apply per
    stale tick.
- Spec §4.1 amended in `894055f` and `ba0e678`.
- Tests:
  - batch order and settles;
  - the union of rows against the in-thread view;
  - a lost worker with a batch in flight;
  - catch-up equal to the prompt view: tops at S, then every rank;
  - torn and not-newer reads defer;
  - the healthy path and the in-thread host never catch up.

  Mutations of each check fail them.
- The water-worker e2e's `waterQueue <= 1` wait is dropped. Under SwiftShader the ticks per round trip scale with
  1–10 s frames; `waterLink.test.ts` pins the bound instead.

**Sanity A/B** (`research/2026-10-08-living-r2-water-fix-ab.json`): headed Edge, prod builds, worker path in both, ABBA.
A = `41d0a16`, before the fixes; B = `ba0e678`. 2026-10-09, 17:17–17:22, 18.4–18.7 GB free, steam only.

| Run | Build | dam apply p95 | dam lag p50 / p95 | collapse apply p95 | collapse lag p50 / p95 | queue max | fps p5 |
|---|---|---|---|---|---|---|---|
| 1 | A | 0.57 | 18.4 / 26.4 | 0.70 | 23.5 / 31.7 | 1 | 89.9 |
| 2 | B | 0.56 | 19.1 / 27.6 | 0.67 | 23.6 / 33.8 | 1 | 89.8 |
| 3 | B | 0.55 | 18.7 / 27.6 | 0.70 | 23.0 / 30.6 | 2 | 89.9 |
| 4 | A | 0.55 | 19.0 / 26.6 | 0.65 | 23.6 / 30.6 | 1 | 89.9 |

- **Verdict: no regression beyond noise.**
  - Apply p95 is equal.
  - Lag p95 in dam is +1 ms (26.4–26.6 → 27.6), under one frame at 179 Hz; collapse overlaps (30.6–31.7 against
    30.6–33.8).
  - The queue stays at 1–2, and no page logged an error.
- On a healthy main thread the batch is the old single request, and the catch-up never runs.

**e2e at `504cc10`** (headless, port 5184): 20 passed, plus 1 existing skip:
- water-worker 3/3, water-render 2/2, caves 2/2;
- flood 3, plus its existing skip;
- living, smoke 7/7.

`collapse.spec.ts` fails both tests at main `90e5c97` too ("collapse checks 0"). It is pre-existing, an open item for
main.
