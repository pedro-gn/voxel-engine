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
