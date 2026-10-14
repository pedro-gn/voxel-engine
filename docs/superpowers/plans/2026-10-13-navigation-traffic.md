# Navigation Traffic (SP5 round 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the typical colony case (~100 units each on its own task) correct and cheap, and keep 1,000 units in real time, by fixing the water bug that strands half of a group, letting waiting units sleep, making background navigation work rest, and capping per-tick decision work.

**Architecture:** Water becomes part of the region layer's geometry: a pose whose head cell holds liquid is not a region pose, and the live policy uses the same rule (units wade through water up to one block). The region prebuild becomes a queue of changed tiles with a per-tick cap. A new `Sleepers` registry lets a unit queued behind another sleep until that unit's cells change, its tile changes or a deadline passes. A FIFO decision budget bounds the per-tick work of units that are not moving.

**Tech Stack:** TypeScript (Node v24 `--experimental-strip-types` for benches), vitest, npm workspaces (`@elovox/engine`, `@elovox/sandbox`).

**Spec:** `docs/superpowers/specs/2026-10-13-navigation-traffic-design.md`

## Planning findings and deviations from the spec

The spec's Task 0 asked to diagnose before fixing. Two probes ran while planning (2026-10-13, `main` 9163239, crowd world, 100 units, warm):

1. **The stuck half is water.** All 50 stuck units are the west pad's. Every refused step (385 of them) is a one-block step down onto a pose whose feet cell holds water deeper than 128/256 (`safe() = false`, `stand = true`). The region layer (ADR 0003) reads geometry only, so routes and group fields cross that water; the live policy refuses the step; the unit blocks `unsafe`, replans and gets the same route forever. Exact flat A\* under the live policy finds a dry way for every sampled unit. **User decisions (2026-10-13):** (A) the region layer becomes water-aware; (C) units wade through water up to one block deep, at normal speed.
2. **First action** at 100 units: the mass group field stays pending for 44 ticks; nav spends ~4,000 of the 8,192 operations per tick on it, because repairs take half the budget while any query waits (`afterPhysics`: `this.nav.pending ? left >> 1 : left`), even before anyone walks. Scatter: route searches found at p95 12 ticks, walking at p95 17.

Deviations (each also recorded in the final report):

- **D1 Deep = liquid in the head cell.** Spec §2 said "water-aware regions with hysteresis". Instead, a pose is *deep* when the voxel above its feet (y + 1) is liquid. Both the region layer (`NavigationSystem.regionStand`) and the live policy (`safe()` in `simulation.ts`) use it, so the region layer is never stricter than the live policy (no false `unreachable`) and never looser (no loop). Liquid presence only changes when the surface crosses a block boundary, which is the quantization the hysteresis was for. Water up to one block (feet cell full, head cell dry) is wadeable: decision C.
- **D2 Sleepers keep counting.** Spec §4 said counters are brought up to date on waking. Instead a sleeping unit's `stuck` and `wait` still rise by one per tick in the cheap second pass, and the unit wakes one tick before any threshold; behaviour at the thresholds is the same, with less code.
- **D3 Sleep only in a queue.** A unit sleeps only when `waitsFor` holds (it walks behind the blocking unit, or the blocker yields to it). Head-on conflicts stay awake: repairs and lanes resolve them.
- **D4 No bulk move of existing traffic code.** Spec §4 said traffic code moves to `workers/traffic.ts` "as far as the above needs". Only the new code gets its own module (`workers/sleepers.ts`); moving the existing 1,000 lines of cooperation code is not needed by any task and would only risk replay hashes.
- **D5 Decision budget counts units served**, a fixed cost of one per decision, not operations per kind. Repairs and searches already have their own operation budget (`searchCap`).
- **D6 Prebuild after the first pass is queue-only**: no rings around anchors and no whole-world rescans once every tile was built; a query rebuilds an evicted record on demand.

## Global Constraints

- Determinism: every decision is a function of hashed state; budgets count operations or units, never milliseconds. New state that decides future behaviour (sleepers, the decision queue, the prebuild queue) is mixed into `mixState`.
- A save does not store sleeping or the decision queue: after a load every unit is awake (ADR 0004, faithful not bit-identical).
- Quiet-machine rules for every benchmark: no games or heavy apps running, ≥ 8 GB free, worse of two runs. Ask the user before a benchmark run if you cannot check (`Get-Process` for games; free memory).
- Typical gates (100 units, crowd world, every phase): arrival within ideal walk + 60 s ≥ 99% (mass, scatter, churn), bottleneck 100%; zero false `unreachable`; first action p95 ≤ 5 ticks warm; workers' share p95 ≤ 2 ms, max ≤ 8 ms.
- Stress gates (1,000 units): whole tick p95 ≤ 15 ms in every phase; in a long phase every unit with a reachable destination arrives, the others get a correct `unreachable` verdict.
- Living gate: five interleaved A/B pairs against `d63ffe1`; median p50 delta ≤ +0.15 ms in idle, work, dam and collapse.
- Regressions: `npm run typecheck`, `npm test`, e2e (`E2E_PORT=5197 E2E_CHANNEL=msedge npm run e2e -- --workers=1`) green; the 5b corridor and gate tests pass; `--quality` stays within mean ≤ 1.10, p95 ≤ 1.25.
- Load-sensitive timeouts (`waterColumns` conservation, `densityBrush`) can fail in the parallel suite; re-run them alone before treating a failure as real.
- Commits: no `Co-Authored-By` trailer (project `.claude/settings.json` has no `attribution.commit`). Branch `feat/navigation-traffic`.
- Stop and report to the user (do not work around): if Task 0 shows the world alone leaves less than 6 ms of the 15 ms stress budget; if Task 6 cannot reach first action p95 ≤ 5 ticks; if any gate is missed at the end.

## Review Focus

1. A sleeper whose blocker is despawned, incapacitated or starts falling must wake: no unit sleeps for good behind a unit that left. (Task 5, test "despawning the leader wakes the queue".)
2. Water rising onto a sleeping unit's pose (or a block placed next to it) must wake it the same tick, so the stationary checks run. (Task 5, test "an edit in the sleeper's tile wakes it".)
3. Save and load with sleeping units: everyone is awake after the load and the queue drains. (Task 5, test "a save taken while units sleep loads with everyone awake and all arrive".)
4. Water that rises across a route after it was planned: the units stop at the edge and walk around, with no loop and no head under water. (Task 2, test "water that floods a basin across a route already planned is walked around".)
5. Water spreading over many columns (a dam breach) only queues the tiles it touched; the prebuild never exceeds its cap in a tick. (Task 3, test "the prebuild never spends more than prebuildCap in a tick, even after a wide flood".)

---

### Task 0: Benchmark tooling and the baseline

**Files:**
- Modify: `apps/sandbox/bench/crowd.node.ts` (flags, world-only mode, search-found breakdown, profile asserts)
- Create: `apps/sandbox/bench/livingAb.node.mjs`
- Create: `docs/superpowers/research/2026-10-13-traffic-baseline.json`
- Delete (if present, untracked): `apps/sandbox/bench/_probe-stuck.node.ts`, `apps/sandbox/bench/_probe-map.node.ts`, `apps/sandbox/bench/_probe-first.node.ts`

**Interfaces:**
- Produces: `crowd.node.ts --profile=typical|stress` (typical: 100 units, 6,600 ticks, typical gates in `--assert`; stress: 1,000 units, `--ticks` default 21,000, stress gates), `--world-only` (no units, tick cost per phase), result field `searchFoundTicks: { p50, p95 }` per move phase; `livingAb.node.mjs --a=<dir> --b=<dir> [--pairs=5] [--assert=0.15]`.

- [ ] **Step 1: Remove the planning probes**

```bash
rm -f apps/sandbox/bench/_probe-stuck.node.ts apps/sandbox/bench/_probe-map.node.ts apps/sandbox/bench/_probe-first.node.ts
```

- [ ] **Step 2: Add the profile and world-only flags to `crowd.node.ts`**

Replace the line `const UNITS = Number(flag('units') ?? 1000), TICKS = Number(flag('ticks') ?? 6600), ONLY = flag('phase'), COLD = flag('cold') !== undefined` with:

```ts
/** typical: 100 units and the typical gates; stress: 1,000 units, a long phase (4× the longest ideal walk) and the stress gates. */
const PROFILE = flag('profile') ?? 'legacy'
if (!['legacy', 'typical', 'stress'].includes(PROFILE)) throw new Error(`unknown profile ${PROFILE}`)
/** No units: the tick cost of the world alone (water, random ticks, each phase's terrain). */
const WORLD_ONLY = flag('world-only') !== undefined
const UNITS = WORLD_ONLY ? 0 : Number(flag('units') ?? (PROFILE === 'typical' ? 100 : 1000))
const TICKS = Number(flag('ticks') ?? (PROFILE === 'stress' ? 21000 : 6600)), ONLY = flag('phase'), COLD = flag('cold') !== undefined
```

In the phase loop, replace

```ts
  const orders = phase.orders(ids), warm = COLD ? null : warmUp(orders), atOrder = regions(); submit(orders)
```

with

```ts
  const orders = WORLD_ONLY ? [] : phase.orders(ids), warm = COLD ? null : warmUp(orders), atOrder = regions(); submit(orders)
```

(`respawn` with `UNITS = 0` spawns nothing; `spawnCrowd(0, …)` returns no commands — check `apps/sandbox/src/scenes/crowd.ts` `spawnCrowd`; if it throws on 0, guard the call with `if (UNITS)`.) Add `profile: PROFILE, worldOnly: WORLD_ONLY` to the final `console.log(JSON.stringify({ … }))` object.

- [ ] **Step 3: Record when each unit's search was found**

In `measure`, next to `const first = new Map<number, number>()`, add `const found = new Map<number, number>()`. In the per-tick loop, after the `for (let k = 0; k < poses.length; k += 9)` line, add:

```ts
    // When each ordered unit's route, group field or flat search was found: separates search time from refinement.
    for (const id of moved) {
      if (found.has(id)) continue
      const u = w.units.get(id) as unknown as { route?: { search: { status: string } } | null; search?: { status: string } | null } | undefined
      if ((u?.route?.search ?? u?.search)?.status === 'found') found.set(id, t)
    }
```

In the returned object, inside the `...(moved.length > 0 && {` block next to `firstActionTicks`, add:

```ts
      searchFoundTicks: { p50: finite(q(moved.map(id => found.get(id) ?? Infinity), .5)), p95: finite(q(moved.map(id => found.get(id) ?? Infinity), .95)) },
```

- [ ] **Step 4: Profile gates in `--assert`**

Replace the assert block's limits. Replace `const firstLimit = UNITS <= 100 ? 5 : 20, failures: string[] = []` and the `over(name, 'workers p95 ms', …)` line and the `firstActionTicks` line with:

```ts
  const failures: string[] = []
  // typical: spec §8 typical gates; stress: only the tick and nobody stuck; legacy: the 5b §7 gates.
  const lim = PROFILE === 'typical' ? { workersP95: 2, workersMax: 8, tickP95: Infinity, first: 5 }
    : PROFILE === 'stress' ? { workersP95: Infinity, workersMax: Infinity, tickP95: 15, first: Infinity }
    : { workersP95: 4, workersMax: 12, tickP95: 15, first: UNITS <= 100 ? 5 : 20 }
```

and inside the loop:

```ts
    over(name, 'workers p95 ms', m.workersMs.p95, lim.workersP95); over(name, 'workers max ms', m.workersMs.max, lim.workersMax); over(name, 'tick p95 ms', m.tickMs.p95, lim.tickP95)
    if (m.firstActionTicks && !COLD) over(name, 'first action p95 ticks', m.firstActionTicks.p95, lim.first)
```

For stress, arrival is "every unit with a reachable destination arrives within the phase": replace the arrival block with:

```ts
    if (m.arrived) {
      if (PROFILE === 'stress') {
        // Everyone not proven unreachable must have arrived by the end of the long phase.
        const a = m.arrived as { pct: number }, unreachable = (m.falseUnreachable?.suspects ?? 0) - (m.falseUnreachable?.count ?? 0)
        const need = 100 * (r as { units: number }).units - 100 * unreachable
        if (a.pct * (r as { units: number }).units < need) failures.push(`${name}: arrived ${a.pct}% with ${unreachable} proven unreachable`)
      } else {
        const need = name === 'bottleneck' ? 100 : 99, pct = m.arrived.withinIdealPlusGrace?.pct
        if (pct === undefined || pct < need) failures.push(`${name}: arrived within ideal + grace ${pct ?? 'not measured'}% < ${need}%`)
      }
    }
```

Update the header comment's flag list with `--profile=typical|stress` and `--world-only`.

- [ ] **Step 5: Typecheck the bench and run a smoke**

Run: `npm run typecheck` → Expected: exit 0.
Run: `node --experimental-strip-types apps/sandbox/bench/crowd.node.ts --profile=typical --phase=scatter --ticks=200 > %TEMP%/smoke.json` (bash: `> "$TEMP/smoke.json"`). Expected: JSON with `profile: "typical"`, `units: 100`, and `results.scatter.searchFoundTicks`.

- [ ] **Step 6: Write `livingAb.node.mjs`**

```js
// Interleaved A/B of the living benchmark between two checkouts of this repo (each with its own npm install).
// Run: node apps/sandbox/bench/livingAb.node.mjs --a=<candidate dir> --b=<baseline dir> [--pairs=5] [--assert=0.15]
// Pairs alternate AB, BA, AB, ... so drift does not favour one side. Per phase: each side's p50s, and the median over
// pairs of (a - b). --assert=ms exits 1 when a phase's median delta is above it.
import { execFileSync } from 'node:child_process'

const arg = (name, fallback) => { const a = process.argv.find(s => s.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : fallback }
const A = arg('a', '.'), B = arg('b'), PAIRS = Number(arg('pairs', '5')), LIMIT = arg('assert')
if (!B) throw new Error('--b=<baseline checkout> is required')
const run = dir => {
  const out = execFileSync(process.execPath, ['--experimental-strip-types', 'apps/sandbox/bench/living.node.ts'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 24 })
  return JSON.parse(out.slice(out.indexOf('{'))).results
}
const runs = { a: [], b: [] }
for (let i = 0; i < PAIRS; i++) for (const side of i % 2 ? ['b', 'a'] : ['a', 'b']) {
  console.error(`${new Date().toISOString().slice(11, 19)} pair ${i + 1} ${side}`)
  runs[side].push(run(side === 'a' ? A : B))
}
const median = xs => { const s = [...xs].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const phases = Object.keys(runs.a[0]), report = {}, failures = []
for (const p of phases) {
  const a = runs.a.map(r => r[p].p50), b = runs.b.map(r => r[p].p50), delta = +median(a.map((x, i) => x - b[i])).toFixed(3)
  report[p] = { a, b, medianA: median(a), medianB: median(b), medianDelta: delta }
  if (LIMIT !== undefined && delta > Number(LIMIT)) failures.push(`${p}: median delta ${delta} ms > ${LIMIT}`)
}
console.log(JSON.stringify({ node: process.version, a: A, b: B, pairs: PAIRS, report }, null, 2))
for (const f of failures) console.error(`FAIL ${f}`)
if (failures.length) process.exit(1)
```

- [ ] **Step 7: Baseline checkout for the A/B**

A detached worktree of `d63ffe1` with its own install, outside the repo (the session scratchpad, or `../voxel-pre5b`):

```bash
git worktree add --detach ../voxel-pre5b d63ffe1
(cd ../voxel-pre5b && npm ci --prefer-offline --no-audit --no-fund)
```

(The planning session left one at `<scratchpad>/pre5b`; reuse it if it still exists: `git worktree list`.)

- [ ] **Step 8: Measure the baseline (quiet machine)**

Check the machine is quiet first (no game in `Get-Process`, ≥ 8 GB free). Then, from the repo root on this branch (code still equal to `main` 9163239 apart from the bench):

```bash
OUT=docs/superpowers/research
for p in mass scatter bottleneck work churn; do for r in 1 2; do node --experimental-strip-types apps/sandbox/bench/crowd.node.ts --world-only --phase=$p --ticks=2000 > "$TEMP/world-$p-$r.json"; done; done
for p in mass scatter bottleneck work churn; do for r in 1 2; do node --experimental-strip-types apps/sandbox/bench/crowd.node.ts --profile=typical --phase=$p > "$TEMP/typical-$p-$r.json"; done; done
node apps/sandbox/bench/livingAb.node.mjs --a=. --b=../voxel-pre5b --pairs=5 > "$TEMP/living-ab.json"
```

The stress baseline at 1,000 units is already in `docs/superpowers/research/2026-10-12-crowd-round2-gate.json` (5b round 2; same code as `main`): do not re-run it here.

- [ ] **Step 9: Write the baseline file**

A small Node one-off (not committed) that reads the files above and writes `docs/superpowers/research/2026-10-13-traffic-baseline.json` with, per phase and run: `worldOnly.tickMs`, `typical.{tickMs, workersMs, firstActionTicks, searchFoundTicks, arrived.withinIdealPlusGrace.pct, falseUnreachable.count, work}`, and the living A/B `report`; plus `commit` (git rev-parse HEAD), `node` and the date. Keep the worse of the two runs in a `worse` block per phase (higher ms, lower arrival).

- [ ] **Step 10: Check the world budget (stop condition)**

Read the world-only `tickMs.p95` of each phase (worse of two). If any phase is above **9 ms** (less than 6 ms left for 1,000 units under 15 ms), stop and report to the user with the numbers before Task 1.

- [ ] **Step 11: Commit**

```bash
git add apps/sandbox/bench/crowd.node.ts apps/sandbox/bench/livingAb.node.mjs docs/superpowers/research/2026-10-13-traffic-baseline.json
git commit -m "bench(nav): typical/stress profiles, world-only mode, living A/B script and the round-3 baseline"
```

---

### Task 1: Units wade through water up to one block (decision C)

**Files:**
- Modify: `packages/engine/src/sim/simulation.ts:166-170` (`safe` in the workers port)
- Test: `packages/engine/test/workers.test.ts`

**Interfaces:**
- Produces: the live policy "a pose is unsafe when the voxel at y + 1 is liquid" (`safe()`), used by Task 2's region rule. No new exports.

- [ ] **Step 1: Write the failing tests**

Add to `describe('simulated workers', …)` in `packages/engine/test/workers.test.ts`, after the test `rejects water immersion on the cave floor but admits the dry roof`:

```ts
  it('wades through water that fills the feet cell but not the head cell', () => {
    // A one-deep trench across the floor (x = 10..12), full of water to the floor's top: the feet cell is water, the head cell dry.
    const sim = make(ctx => { for (let x = 10; x <= 12; x++) for (let z = 0; z < 32; z++) ctx.set(x, 3, z, 3 | (7 << 12)) })
    expect(sim.water.depthAt(11, 3, 5)).toBeGreaterThan(128)
    expect(sim.water.depthAt(11, 3, 5)).toBeLessThanOrEqual(256)
    spawn(sim, [5, 4, 5]); cmd(sim, { type: 'unitMove', ids: [1], pos: [20, 4, 5] })
    let wet = false
    for (let i = 0; i < 400 && sim.workers!.view(1)?.state !== 'idle'; i++) { sim.step(); const v = sim.workers!.view(1)!; if (v.y256 === 3 * 256) wet = true }
    expect(sim.workers!.view(1)).toMatchObject({ state: 'idle', x256: 20 * 256 + 128 })
    expect(wet).toBe(true) // it walked through the trench, not around it (there is no way around)
  })
  it('refuses a pose whose head cell is under water', () => {
    // Water two blocks deep in a pit (x = 10..12, y = 2..3): the pose on its floor has water in the head cell.
    const sim = make(ctx => { for (let x = 10; x <= 12; x++) for (let z = 0; z < 32; z++) { ctx.set(x, 2, z, 3 | (7 << 12)); ctx.set(x, 3, z, 3 | (7 << 12)) } })
    sim.submit(0, ++seq, { type: 'unitSpawn', pos: [11, 2, 5] }); expect(sim.step().acks[0]?.ok).toBe(false)
  })
```

Notes for the implementer: `make` builds stone at `y < 4`; `ctx.set` over a stone voxel replaces it, so the trench is the water itself. `3 | (7 << 12)` is the test registry's water (id 3) at full level, as in the existing cave test. If the generated water drains or levels out in the first ticks (it is enclosed by stone on every side but the top), assert the depth after one `sim.step()`.

- [ ] **Step 2: Run them to see the first fail**

Run: `cd packages/engine && npx vitest run test/workers.test.ts -t "wades through water"`
Expected: FAIL — the unit never reaches x = 20 (it blocks `unsafe` at the trench edge, depth > 128). The second test passes already (depth > 128 there too); it pins the rule that stays.

- [ ] **Step 3: Implement the head-cell rule**

In `packages/engine/src/sim/simulation.ts`, replace the body of `safe(x, y, z)` in the workers port:

```ts
        safe(x, y, z) {
          const id = y === 0 ? 0 : voxelId(sim.store.getVoxel(x, y - 1, z))
          const feet = voxelId(sim.store.getVoxel(x, y, z))
          // Units wade through water up to one block: the feet cell may hold water, the head cell may not hold any liquid.
          // The region layer reads the same head-cell rule (NavigationSystem.regionStand), so routes never cross what this refuses.
          const head = y + 1 >= sim.layout.size[1] ? 0 : voxelId(sim.store.getVoxel(x, y + 1, z))
          return !(sim.registry.liquid[feet] && (sim.registry.liquidGroup[feet] !== sim.water.water || sim.registry.source[feet])) && !sim.registry.liquid[head] && !sim.registry.falls[id] && !(sim.registry.collapses[id] && sim.collapse.checking) && !sim.collapse.overlaps(x, y, z) && !sim.collapse.overlaps(x, y + 1, z)
        },
```

- [ ] **Step 4: Run the worker tests**

Run: `cd packages/engine && npx vitest run test/workers.test.ts test/workersRoutes.test.ts test/underwater.test.ts`
Expected: PASS. If an existing test encoded the 128 limit (a unit refusing a half-deep feet cell), update its expectation to the new rule and name it in the commit message.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sim/simulation.ts packages/engine/test/workers.test.ts
git commit -m "feat(workers): units wade through water up to one block (head cell dry)"
```

---

### Task 2: Water-aware region layer (decision A) — the stuck-half fix

**Files:**
- Modify: `packages/engine/src/sim/navigation/navigation.ts:147-153` (`regionStand`), `:104-118` (`invalidate`, new `invalidateLiquid`)
- Modify: `packages/engine/src/sim/workers/workers.ts:233-238` (`afterWrite`)
- Test: `packages/engine/test/regions.test.ts`, `packages/engine/test/workersRoutes.test.ts`

**Interfaces:**
- Consumes: Task 1's head-cell rule (live policy).
- Produces: `NavigationSystem.regionStand(x, y, z)` also false when the voxel at y + 1 is liquid; `NavigationSystem.invalidateLiquid(x: number, y: number, z: number): void` (a liquid-presence change at voxel (x, y, z); marks the tiles flippy, bumps revisions, no `geometry` bump).

- [ ] **Step 1: Write the failing region test**

Add to `packages/engine/test/regions.test.ts` (extend `fixture` to take a liquid set; `BlockRegistry` gets a water block):

```ts
function wetFixture(side = 64) {
  const layout = new Layout([side, 32, side]), registry = new BlockRegistry([{ name: 'stone' }, { name: 'water', liquid: true }])
  const solid = new Set<number>(), water = new Set<number>()
  const nav = new NavigationSystem({ layout, registry, get: (x, y, z) => { const p = layout.voxelIndex(x, y, z); return y < 4 || solid.has(p) ? 1 : water.has(p) ? 2 : 0 } })
  return { nav, layout, solid, water }
}
it('a pose whose head cell holds liquid is not a region pose; a wadeable one is', () => {
  const { nav, layout, water } = wetFixture()
  // Feet-deep water at (20, 4, 20): wadeable. Head-deep at (21, 4, 20): water at y = 5 too.
  water.add(layout.voxelIndex(20, 4, 20)); water.add(layout.voxelIndex(21, 4, 20)); water.add(layout.voxelIndex(21, 5, 20))
  expect(nav.regionStand(20, 4, 20)).toBe(true)
  expect(nav.regionStand(21, 4, 20)).toBe(false)
  const r = build(nav, nav.tileOf(21, 4, 20))
  expect(r.poses).toContain(layout.voxelIndex(20, 4, 20))
  expect(r.poses).not.toContain(layout.voxelIndex(21, 4, 20))
})
it('a liquid-presence change rebuilds the tiles it touches and marks them flippy, without a geometry bump', () => {
  const { nav, layout, water } = wetFixture()
  const t = nav.tileOf(21, 4, 20), before = nav.revisions[t]!, geometry = nav.geometry
  water.add(layout.voxelIndex(21, 5, 20)); nav.invalidateLiquid(21, 5, 20)
  expect(nav.revisions[t]).toBeGreaterThan(before)
  expect(nav.flippy[t]).toBe(1)
  expect(nav.geometry).toBe(geometry)
  expect(build(nav, t).poses).not.toContain(layout.voxelIndex(21, 4, 20))
})
```

- [ ] **Step 2: Run to see them fail**

Run: `cd packages/engine && npx vitest run test/regions.test.ts -t "liquid"`
Expected: FAIL — `regionStand(21, 4, 20)` is true; `invalidateLiquid` is not a function.

- [ ] **Step 3: Implement the region rule and the invalidation**

In `navigation.ts`, replace `regionStand`:

```ts
  /**
   * A pose of the region layer: it stands, not on a block that falls, and not with liquid in the head cell. The live
   * policy always rejects both (units wade through water up to one block, never with the head under), so the region layer
   * drops them as geometry; flat searches still stand there (to search out of sand or deep water).
   */
  regionStand(x: number, y: number, z: number): boolean {
    const R = this.port.registry
    return this.stand(x, y, z) && (y === 0 || R.falls[voxelId(this.port.get(x, y - 1, z))] !== 1)
      && (y + 1 >= this.port.layout.size[1] || R.liquid[voxelId(this.port.get(x, y + 1, z))] !== 1)
  }
```

(If `BlockRegistry.liquid` is a `Uint8Array` like `falls`, the comparison with `1` matches the style above; check `packages/engine/src/blocks/registry.ts`.)

After `invalidate`, add:

```ts
  /**
   * Liquid appeared in or left voxel (x, y, z): the pose below it (y - 1) changed its head-cell rule, and the pose at y
   * its feet. Like a falls flip, it marks the tiles flippy (landmark tables then read those poses as standable, so they
   * stay a lower bound) and bumps their revisions; it is no change of solid geometry.
   */
  invalidateLiquid(x: number, y: number, z: number): void { this.invalidateBox(x, Math.max(0, y - 1), z, x, y, z, false, true) }
```

- [ ] **Step 4: Call it from the workers' write hook**

In `workers.ts` `afterWrite`, add as the first statement after `const R = …, a = …, b = …`:

```ts
    // Liquid entering or leaving a cell moves the head-cell rule of the pose below: the region layer reads it as geometry.
    if (R.liquid[a] !== R.liquid[b] && !R.solid[a] && !R.solid[b]) this.nav.invalidateLiquid(x, y, z)
```

(Solid ↔ liquid swaps are already covered by the solid branch.)

- [ ] **Step 5: Run the region tests**

Run: `cd packages/engine && npx vitest run test/regions.test.ts test/landmarks.test.ts test/routeSearch.test.ts test/groupField.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing group test (the repro)**

First let `makeWide` in `packages/engine/test/workersRoutes.test.ts` pass the column coordinates to `extra` (the generator context has none): change its parameter to `extra?: (ctx: GeneratorContext, cx: number, cz: number) => void` and its generator to `generateColumn(ctx, cx, cz) { …; extra?.(ctx, cx, cz) }`. Existing callers keep working. Then add to `describe('hierarchical routes', …)`:

```ts
  it('a group whose straight way crosses head-deep water walks around it and every unit arrives', () => {
    // A basin across x = 100..103, z = 2..27, two deep in the middle (x = 101..102) and one deep at its rims, full of
    // water to the floor's top: crossing it means a pose with water in the head cell. Dry, it would be crossable
    // (drop 1, drop 1, climb 1, climb 1). The way around is at z >= 28.
    const sim = makeWide(256, (ctx, cx, cz) => {
      for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
        const wx = cx * 32 + x, wz = cz * 32 + z
        if (wx < 100 || wx > 103 || wz < 2 || wz > 27) continue
        const water = 3 | (7 << 12)
        ctx.set(x, 3, z, water)
        if (wx === 101 || wx === 102) ctx.set(x, 2, z, water)
      }
    })
    for (let i = 0; i < 10; i++) spawn(sim, [60 + (i % 5) * 2, 4, 6 + Math.floor(i / 5) * 2])
    cmd(sim, { type: 'unitMove', ids: [...sim.workers!.units.keys()], pos: [160, 4, 10] })
    for (let i = 0; i < 4000 && [...sim.workers!.units.values()].some(u => u.state !== 'idle'); i++) {
      sim.step()
      for (const u of sim.workers!.units.values()) expect(sim.registry.liquid[sim.store.getVoxel(u.x >> 8, (u.y >> 8) + 1, u.z >> 8) & 0xfff], `unit ${u.id} head under water`).toBe(0)
    }
    expect([...sim.workers!.units.values()].map(u => u.state)).toEqual(Array(10).fill('idle'))
    for (const u of sim.workers!.units.values()) expect(Math.abs((u.x >> 8) - 160)).toBeLessThanOrEqual(6)
  })
  it('water that floods a basin across a route already planned is walked around', () => {
    const sim = makeWide(256)
    // The same basin as above, dug dry: x = 100 and 103 one deep, x = 101..102 two deep, z = 2..27.
    cmd(sim, { type: 'fillRegion', min: [100, 3, 2], max: [103, 3, 27], voxel: 0 }); cmd(sim, { type: 'fillRegion', min: [101, 2, 2], max: [102, 2, 27], voxel: 0 })
    for (let i = 0; i < 10; i++) spawn(sim, [60 + (i % 5) * 2, 4, 6 + Math.floor(i / 5) * 2])
    cmd(sim, { type: 'unitMove', ids: [...sim.workers!.units.keys()], pos: [160, 4, 10] })
    // The dry basin is on the way: let everyone set off, then flood it before anyone reaches it.
    until(sim, () => [...sim.workers!.units.values()].every(u => u.state === 'walking' || (u.x >> 8) > 70), 400)
    expect([...sim.workers!.units.values()].every(u => (u.x >> 8) < 95)).toBe(true)
    const water = 3 | (7 << 12)
    cmd(sim, { type: 'fillRegion', min: [100, 3, 2], max: [103, 3, 27], voxel: water }); cmd(sim, { type: 'fillRegion', min: [101, 2, 2], max: [102, 2, 27], voxel: water })
    for (let i = 0; i < 4000 && [...sim.workers!.units.values()].some(u => u.state !== 'idle'); i++) {
      sim.step()
      for (const u of sim.workers!.units.values()) expect(sim.registry.liquid[sim.store.getVoxel(u.x >> 8, (u.y >> 8) + 1, u.z >> 8) & 0xfff], `unit ${u.id} head under water`).toBe(0)
    }
    expect([...sim.workers!.units.values()].map(u => u.state)).toEqual(Array(10).fill('idle'))
    for (const u of sim.workers!.units.values()) expect(Math.abs((u.x >> 8) - 160)).toBeLessThanOrEqual(6)
  })
```

(`fillRegion` takes a packed voxel: `3 | (7 << 12)` is full water in this test registry, `0` air. The second test exercises the runtime path — liquid writes reach `afterWrite` → `invalidateLiquid` → routes recover around the changed tiles — where the first one exercises water present at generation.)

- [ ] **Step 7: Run the group test before and after**

Run: `git stash; cd packages/engine && npx vitest run test/workersRoutes.test.ts -t "head-deep water"; cd ../..; git stash pop` — Expected: FAIL without Steps 3–4 (units loop at the basin). Then without stashing: Expected: PASS.

(If the basin water drains into the world in the first ticks — it is enclosed by stone at y < 4 on every side — make the basin rims one block higher with `ctx.set(x, 4, z, 1)` around it and adjust the comment.)

- [ ] **Step 8: Check the crowd case**

Run: `node --experimental-strip-types apps/sandbox/bench/crowd.node.ts --profile=typical --phase=mass --ticks=6600 > "$TEMP/t2-mass.json"` and read `results.mass.arrived`. Expected: `pct` 100 (was 50), `falseUnreachable.count` 0. Then the same for `--phase=bottleneck` (was 50). Record both numbers in the commit message. This is a check, not a gate run (one run is enough here).

- [ ] **Step 9: Run the navigation suites and the quality bench**

Run: `cd packages/engine && npx vitest run test/navigation.test.ts test/routeFuzz.test.ts test/workersRoutes.test.ts test/workers.test.ts`
Expected: PASS.
Run: `node --experimental-strip-types apps/sandbox/bench/crowd.node.ts --quality` — Expected: `gate.pass` true and `group.gate.pass` true (the quality bench's exact search uses `regionStand`, so it applies the same water rule).

- [ ] **Step 10: Commit**

```bash
git add packages/engine/src/sim/navigation/navigation.ts packages/engine/src/sim/workers/workers.ts packages/engine/test/regions.test.ts packages/engine/test/workersRoutes.test.ts
git commit -m "fix(nav): region layer drops poses with liquid in the head cell (crowd mass/bottleneck no longer strand the west group)"
```

---

### Task 3: Prebuild by queue, with a per-tick cap

**Files:**
- Modify: `packages/engine/src/sim/navigation/navigation.ts` (queue fields, `invalidateBox`, `reset`, `prebuild`, `mixState`, new `prebuildChecks`)
- Modify: `packages/engine/src/sim/workers/types.ts` (`WorkerOptions.prebuildCap`)
- Modify: `packages/engine/src/sim/workers/workers.ts` (constructor validation, `afterPhysics` prebuild call)
- Test: `packages/engine/test/regions.test.ts`, `packages/engine/test/workersRoutes.test.ts`

**Interfaces:**
- Produces: `WorkerOptions.prebuildCap?: number` (default 1024); `NavigationSystem.prebuildChecks: number` (tiles the last `prebuild` call looked at; not simulation state); after the first complete pass the prebuild only visits tiles queued by `invalidateBox`.

- [ ] **Step 1: Write the failing tests**

In `packages/engine/test/regions.test.ts`:

```ts
it('after the first pass the prebuild visits only the tiles an edit touched', () => {
  const { nav, layout, solid } = fixture(256)
  while (!nav.prebuildStatus().done) nav.prebuild(1 << 20, [])
  expect(nav.prebuild(1 << 20, [])).toBe(0)
  solid.add(layout.voxelIndex(40, 4, 40)); nav.invalidate(40, 4, 40)
  nav.prebuild(1 << 20, [])
  // The edit's footprint (x 39..41, y 2..7, z 39..41) lies in one column of tiles and at most two levels.
  expect(nav.prebuildChecks).toBeLessThanOrEqual(2)
  expect(nav.prebuild(1 << 20, [])).toBe(0)
})
```

In `packages/engine/test/workersRoutes.test.ts`, inside `describe('background navigation work', …)`:

```ts
  it('the prebuild never spends more than prebuildCap in a tick, even after a wide flood', () => {
    const sim = makeWide(256, undefined, { prebuildCap: 256 }); spawn(sim, [5, 4, 5])
    for (let i = 0; i < 100; i++) expect(sim.step().workers!.stats.visited).toBeLessThanOrEqual(256)
    cmd(sim, { type: 'fillRegion', min: [40, 4, 40], max: [200, 4, 200], voxel: 3 | (7 << 12) })
    for (let i = 0; i < 200; i++) expect(sim.step().workers!.stats.visited).toBeLessThanOrEqual(256)
  })
```

(With one idle unit and no orders, `stats.visited` is the prebuild alone: no queries, refinement or repairs run.)

- [ ] **Step 2: Run to see them fail**

Run: `cd packages/engine && npx vitest run test/regions.test.ts -t "only the tiles" test/workersRoutes.test.ts -t "prebuildCap"`
Expected: FAIL — `prebuildChecks` is undefined; `prebuildCap` is rejected or ignored (visited reaches the leftover budget, 32,768 in `makeWide`).

- [ ] **Step 3: Implement the queue in `NavigationSystem`**

Add fields after `prebuildPasses = 0`:

```ts
  /** Tiles changed since the first complete prebuild pass, in the order they changed; `inQueue` marks them. */
  private readonly changed: number[] = []
  private readonly inQueue: Uint8Array
  /** Tiles the last prebuild call looked at (instrumentation; not simulation state). */
  prebuildChecks = 0
```

In the constructor, after `this.flippy = …`: `this.inQueue = new Uint8Array(this.revisions.length)`.

In `invalidateBox`, inside the innermost loop after `this.revisions[t]!++`:

```ts
          if (this.prebuildPasses > 0 && !this.inQueue[t]) { this.inQueue[t] = 1; this.changed.push(t) }
```

In `reset()`, add `this.changed.length = 0; this.inQueue.fill(0)`.

In `prebuild`, set `this.prebuildChecks = 0` at the top, and replace the `while (pre.idle !== this.revision && …) { … }` loop with:

```ts
    // After the first complete pass, only tiles that changed since are rebuilt, oldest change first.
    if (this.prebuildPasses > 0) {
      while (this.changed.length && used < cap && !this.full) {
        const tile = this.changed[0]!
        used++; this.prebuildChecks++
        if (!this.regions.get(tile)) {
          const { region, used: spent } = this.regionNow(tile, cap - used)
          used += spent
          if (!region) break
        }
        this.changed.shift(); this.inQueue[tile] = 0
      }
    } else while (pre.idle !== this.revision && used < cap && !this.full) {
      // (the existing ring/index pass body, unchanged, with this.prebuildChecks++ next to each used++ that checks a tile)
    }
```

Keep the existing loop body verbatim inside the `else`. (`changed.shift()` is O(n); the queue is bounded by the number of tiles and drained in order, so swap to a head index if profiling shows it.)

In `mixState`, after the `pre` fields: `mix(this.changed.length); for (const t of this.changed) mix(t)`.

Update the `prebuild` doc comment: after the first complete pass, only queued tiles; no rings, no rescans (D6).

- [ ] **Step 4: Cap the prebuild per tick in `WorkerSystem`**

In `types.ts` `WorkerOptions`, add:

```ts
  /** Most navigation operations the background region prebuild and landmark recompute may spend per tick (default 1024). */
  prebuildCap?: number
```

In `workers.ts`: add `private readonly prebuildCap: number` next to `searchCap`; in the constructor `this.prebuildCap = options.prebuildCap ?? 1024` and add `prebuildCap: this.prebuildCap` to the validated `Object.entries({ … })`. In `afterPhysics`, replace `this.nav.prebuild(rest - this.nav.visited, [...anchors], this.time)` with:

```ts
      this.nav.prebuild(Math.min(rest - this.nav.visited, this.prebuildCap), [...anchors], this.time)
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/engine && npx vitest run test/regions.test.ts test/workersRoutes.test.ts test/landmarks.test.ts test/navigation.test.ts`
Expected: PASS. The existing test `spare operations prebuild the world, nearest the units first, within the …` may need more ticks now that the prebuild has a cap: raise its tick bound, not the cap, and say so in the commit.

- [ ] **Step 6: Calibrate against the living A/B**

Run: `node apps/sandbox/bench/livingAb.node.mjs --a=. --b=../voxel-pre5b --pairs=5 > "$TEMP/t3-living.json"`. Record the median deltas. If idle is still above +0.15 ms, change the engine default (`options.prebuildCap ?? 1024`) to 512 and re-run, then 256. Keep the largest value that brings idle to ≤ +0.15 ms, provided the crowd warm-up (`crowd.node.ts --profile=typical --phase=scatter --ticks=200`, field `results.scatter.warmUp.ticks`) is at most 2× its Task 0 value; if no value meets both, keep 1024 and note it as an open item for Task 8 (idle may still pass once Tasks 5–7 land). Write the chosen value and the A/B results in the commit message.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/sim/navigation/navigation.ts packages/engine/src/sim/workers/types.ts packages/engine/src/sim/workers/workers.ts packages/engine/test/regions.test.ts packages/engine/test/workersRoutes.test.ts
git commit -m "perf(nav): prebuild rebuilds only changed tiles after the first pass, capped per tick (prebuildCap)"
```

---

### Task 4: The `Sleepers` registry

**Files:**
- Create: `packages/engine/src/sim/workers/sleepers.ts`
- Test: `packages/engine/test/sleepers.test.ts`

**Interfaces:**
- Produces:

```ts
export const SLEEP_TICKS = 16
export class Sleepers {
  get size(): number
  sleep(id: number, now: number, owner: number, tile: number, deadline: number): void
  asleep(id: number): boolean
  dozing(id: number, now: number): boolean
  wake(id: number): void
  wakeOwner(owner: number): void
  wakeTile(tile: number): void
  wakeAll(): void
  expire(now: number): void
  mixState(mix: (n: number) => void): void
}
```

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/sleepers.test.ts`:

```ts
import { expect, it } from 'vitest'
import { Sleepers } from '../src/sim/workers/sleepers.ts'

it('a sleeper dozes from the tick after it fell asleep until something wakes it', () => {
  const s = new Sleepers()
  s.sleep(7, 10, 3, 100, 26)
  expect(s.asleep(7)).toBe(true)
  expect(s.dozing(7, 10)).toBe(false) // the tick it fell asleep it still runs its second pass
  expect(s.dozing(7, 11)).toBe(true)
  s.wakeOwner(3)
  expect(s.asleep(7)).toBe(false); expect(s.size).toBe(0)
})
it('wakes by tile, by deadline, one by one and all at once', () => {
  const s = new Sleepers()
  s.sleep(1, 0, 9, 5, 16); s.sleep(2, 0, 9, 6, 16); s.sleep(3, 0, 8, 6, 4); s.sleep(4, 0, 8, 7, 16)
  s.wakeTile(6); expect([1, 2, 3, 4].map(id => s.asleep(id))).toEqual([true, false, false, true])
  s.sleep(3, 1, 8, 6, 4); s.expire(3); expect(s.asleep(3)).toBe(true); s.expire(4); expect(s.asleep(3)).toBe(false)
  s.wake(1); expect(s.asleep(1)).toBe(false)
  s.wakeAll(); expect(s.size).toBe(0)
})
it('sleeping again replaces the old owner and tile', () => {
  const s = new Sleepers()
  s.sleep(1, 0, 9, 5, 16); s.sleep(1, 2, 8, 6, 18)
  s.wakeOwner(9); s.wakeTile(5); expect(s.asleep(1)).toBe(true)
  s.wakeOwner(8); expect(s.asleep(1)).toBe(false)
})
it('mixes the same state the same way regardless of insertion order', () => {
  const a = new Sleepers(), b = new Sleepers(), ha: number[] = [], hb: number[] = []
  a.sleep(1, 0, 9, 5, 16); a.sleep(2, 0, 8, 6, 16)
  b.sleep(2, 0, 8, 6, 16); b.sleep(1, 0, 9, 5, 16)
  a.mixState(n => ha.push(n)); b.mixState(n => hb.push(n))
  expect(ha).toEqual(hb)
})
```

- [ ] **Step 2: Run to see them fail**

Run: `cd packages/engine && npx vitest run test/sleepers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/engine/src/sim/workers/sleepers.ts`:

```ts
/** Ticks a sleeping unit waits at most before it looks again by itself. */
export const SLEEP_TICKS = 16

interface Entry { since: number; owner: number; tile: number; deadline: number }

/**
 * Units waiting in a queue behind another unit, asleep until that unit's cells change (`wakeOwner`), the world changes in
 * their tile (`wakeTile`), a deadline passes (`expire`) or something else wakes them. A sleeper costs nothing in the
 * executor; it keeps its body held. Decides future behaviour, so it is hashed; a save does not keep it.
 */
export class Sleepers {
  private readonly entries = new Map<number, Entry>()
  private readonly byOwner = new Map<number, Set<number>>()
  private readonly byTile = new Map<number, Set<number>>()
  get size(): number { return this.entries.size }
  sleep(id: number, now: number, owner: number, tile: number, deadline: number): void {
    this.wake(id)
    this.entries.set(id, { since: now, owner, tile, deadline })
    add(this.byOwner, owner, id); add(this.byTile, tile, id)
  }
  asleep(id: number): boolean { return this.entries.has(id) }
  /** Asleep since an earlier tick: the executor skips it this tick. The tick it falls asleep it still runs its second pass. */
  dozing(id: number, now: number): boolean { const e = this.entries.get(id); return e !== undefined && e.since < now }
  wake(id: number): void {
    const e = this.entries.get(id)
    if (!e) return
    this.entries.delete(id); remove(this.byOwner, e.owner, id); remove(this.byTile, e.tile, id)
  }
  wakeOwner(owner: number): void { const ids = this.byOwner.get(owner); if (ids) for (const id of [...ids]) this.wake(id) }
  wakeTile(tile: number): void { const ids = this.byTile.get(tile); if (ids) for (const id of [...ids]) this.wake(id) }
  wakeAll(): void { this.entries.clear(); this.byOwner.clear(); this.byTile.clear() }
  /** Wakes every sleeper whose deadline is now or past. */
  expire(now: number): void { for (const [id, e] of this.entries) if (e.deadline <= now) this.wake(id) }
  mixState(mix: (n: number) => void): void {
    mix(this.entries.size)
    for (const [id, e] of [...this.entries].sort((a, b) => a[0] - b[0])) { mix(id); mix(e.since); mix(e.owner); mix(e.tile); mix(e.deadline) }
  }
}
function add(map: Map<number, Set<number>>, key: number, id: number): void { let s = map.get(key); if (!s) { s = new Set(); map.set(key, s) }; s.add(id) }
function remove(map: Map<number, Set<number>>, key: number, id: number): void { const s = map.get(key); if (!s) return; s.delete(id); if (!s.size) map.delete(key) }
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/engine && npx vitest run test/sleepers.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sim/workers/sleepers.ts packages/engine/test/sleepers.test.ts
git commit -m "feat(workers): Sleepers registry (wake by owner, tile, deadline)"
```

---

### Task 5: Units queued behind another unit sleep

**Files:**
- Modify: `packages/engine/src/sim/workers/types.ts` (`WorkerOptions.sleep`, `WorkerStats.sleeping`)
- Modify: `packages/engine/src/sim/workers/workers.ts` (fields, `reserve`, `afterWrite`, `invalidateAll`, `replaceChunk`, `restore`, `command`, `incapacitate`, `fall`, `afterPhysics` loops, `cooperate`, `publication`, `mixState`)
- Test: `packages/engine/test/workersSleep.test.ts` (new)

**Interfaces:**
- Consumes: Task 4 `Sleepers`, `SLEEP_TICKS`.
- Produces: `WorkerOptions.sleep?: boolean` (default true; false = every unit stays awake, for A/B and tests); `WorkerStats.sleeping: number`.

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/workersSleep.test.ts`. The scenario is the 5b two-wide corridor with ten units a side meeting head-on in one lane: the two heads negotiate (awake), and the units queued behind each head follow a unit that is on its way, so they sleep (D3).

```ts
import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import type { Command } from '../src/sim/commands.ts'
import type { WorkerOptions } from '../src/sim/workers/types.ts'
import type { GeneratorContext } from '../src/sim/generator.ts'

const blocks = [{ name: 'stone' }, { name: 'planks' }, { name: 'water', liquid: true }, { name: 'sand', falls: true }, { name: 'beam', collapses: true }]
function make(extra?: (ctx: GeneratorContext) => void, options: WorkerOptions = {}, side = 32) {
  const sim = new Simulation({ buffers: createWorldBuffers([side, 32, side]), blocks, seed: 1, randomTicksPerChunk: 0, workers: { materials: { stone: { digTicks: 4, buildTicks: 3 } }, ...options } })
  sim.generate({ generateColumn(ctx) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) ctx.set(x, y, z, 1); extra?.(ctx) } })
  return sim
}
let seq = 0
function cmd(sim: Simulation, command: Command) { sim.submit(0, ++seq, command); const r = sim.step(); expect(r.acks[0]?.ok, r.acks[0]?.error).toBe(true); return r }
function spawn(sim: Simulation, pos: number[]) { cmd(sim, { type: 'unitSpawn', pos }); return sim.workers!.units.size }
type Internals = { sleepers: { asleep(id: number): boolean; dozing(id: number, now: number): boolean; size: number }; time: number }
const inside = (sim: Simulation) => sim.workers as unknown as Internals
/** Walls along z = 4 and z = 7 (y 4..5) for x 2..29, capped at x = 2 and x = 29: a two-wide corridor on z = 5 and 6. */
const corridor = (ctx: GeneratorContext) => {
  for (let x = 2; x <= 29; x++) for (let y = 4; y < 6; y++) { ctx.set(x, y, 4, 1); ctx.set(x, y, 7, 1) }
  for (let y = 4; y < 6; y++) for (const z of [5, 6]) { ctx.set(2, y, z, 1); ctx.set(29, y, z, 1) }
}

/** Ten units a side in the corridor, all starting in the z = 5 lane, each ordered 16 blocks along it into the z = 6 lane. */
function jam(options: WorkerOptions = {}) {
  const sim = make(corridor, options)
  const orders = new Map<number, [number, number]>()
  for (let x = 3; x <= 12; x++) orders.set(spawn(sim, [x, 4, 5]), [x + 16, 6])
  for (let x = 19; x <= 28; x++) orders.set(spawn(sim, [x, 4, 5]), [x - 16, 6])
  for (const [id, [x, z]] of orders) sim.submit(0, ++seq, { type: 'unitMove', ids: [id], pos: [x, 4, z] })
  expect(sim.step().acks.every(a => a.ok)).toBe(true)
  return sim
}
const settled = (sim: Simulation) => [...sim.workers!.units.values()].every(u => u.goal === null)
/** Steps until some unit will doze next tick, and returns its id. */
function firstDozer(sim: Simulation, cap = 600): number {
  for (let i = 0; i < cap; i++) {
    sim.step()
    const w = inside(sim), id = [...sim.workers!.units.keys()].find(id => w.sleepers.dozing(id, w.time + 1))
    if (id !== undefined) return id
  }
  throw new Error('no unit fell asleep')
}

describe('sleeping units', { timeout: 60_000 }, () => {
  it('units queued behind the heads of a head-on jam sleep, and everyone arrives', () => {
    const sim = jam()
    let most = 0
    for (let i = 0; i < 3000 && !settled(sim); i++) most = Math.max(most, sim.step().workers!.stats.sleeping)
    expect(most).toBeGreaterThan(0)
    expect(settled(sim)).toBe(true)
    expect(sim.step().workers!.stats.sleeping).toBe(0)
  })
  it('with sleep off, the same jam still clears and nobody sleeps', () => {
    const sim = jam({ sleep: false })
    for (let i = 0; i < 3000 && !settled(sim); i++) expect(sim.step().workers!.stats.sleeping).toBe(0)
    expect(settled(sim)).toBe(true)
  })
  it('despawning the units a sleeper waits behind wakes it', () => {
    const sim = jam(), id = firstDozer(sim), w = inside(sim)
    // Whoever it sleeps behind is in its own group (it follows a unit going its way): despawn the rest of that group.
    const group = id <= 10 ? [...Array(10).keys()].map(i => i + 1) : [...Array(10).keys()].map(i => i + 11)
    cmd(sim, { type: 'unitDespawn', ids: group.filter(g => g !== id) })
    expect(w.sleepers.dozing(id, w.time + 1)).toBe(false)
  })
  it("an edit in the sleeper's tile wakes it the same tick", () => {
    const sim = jam(), id = firstDozer(sim), w = inside(sim)
    // A block high above the corridor, in the sleeper's 16³ tile (x 0..15 or 16..31, y 0..15, z 0..15).
    const u = sim.workers!.units.get(id)!, x = (u.x >> 8) < 16 ? 1 : 30
    sim.submit(0, ++seq, { type: 'setBlock', pos: [x, 12, 1], voxel: 1 }); sim.step()
    // Woken by the write; it may fall asleep again in the same tick, but then it did not doze in this one.
    expect(w.sleepers.dozing(id, w.time)).toBe(false)
  })
  it('a dozing unit still ages: its stuck count rises by one every tick it dozes', () => {
    const sim = jam(), w = inside(sim)
    let checked = 0
    for (let i = 0; i < 1500 && !settled(sim); i++) {
      const before = new Map([...sim.workers!.units.values()].map(u => [u.id, u.stuck]))
      sim.step()
      for (const u of sim.workers!.units.values()) if (w.sleepers.dozing(u.id, w.time) && u.goal !== null) { expect(u.stuck).toBe(before.get(u.id)! + 1); checked++ }
    }
    expect(checked).toBeGreaterThan(0)
  })
  it('replays with the same hashes', () => {
    const run = () => { const sim = jam(), h: string[] = []; for (let i = 0; i < 600; i++) { sim.step(); if (i % 50 === 0) h.push(String(sim.hash())) } return h }
    expect(run()).toEqual(run())
  })
  it('a save taken while units sleep loads with everyone awake and all arrive', () => {
    const a = jam(); firstDozer(a)
    expect(a.step().workers!.stats.sleeping).toBeGreaterThan(0)
    // The corridor world has no edits, so a fresh build of it plus the workers' snapshot is the load.
    const b = make(corridor)
    b.workers!.restore(a.workers!.snapshot())
    expect(inside(b).sleepers.size).toBe(0)
    for (let i = 0; i < 3000 && !settled(b); i++) b.step()
    expect(settled(b)).toBe(true)
  })
})
```

Notes for the implementer: `inside(sim).time` reads the workers' private tick counter (`WorkerSystem.time`); after `sim.step()` it is the tick whose second pass just ran, so `dozing(id, time + 1)` means "will doze next tick" and `dozing(id, time)` "dozed in this tick". If `jam()` produces no sleeper (the heads may resolve before a queue forms), order every unit 24 blocks instead of 16, clamped to x 3..28, and say so in the commit. `restore` throws on a system that already has units; `b` has none.

- [ ] **Step 2: Run to see them fail**

Run: `cd packages/engine && npx vitest run test/workersSleep.test.ts`
Expected: FAIL — `stats.sleeping` undefined; `sleep` option rejected or ignored.

- [ ] **Step 3: Options and stats**

`types.ts`: add to `WorkerOptions`:

```ts
  /** Units queued behind another unit sleep until it moves (default true). False keeps every unit awake (A/B, tests). */
  sleep?: boolean
```

and to `WorkerStats`: `sleeping: number`.

- [ ] **Step 4: Wire the registry into `WorkerSystem`**

Imports: `import { SLEEP_TICKS, Sleepers } from './sleepers.ts'`.
Fields (next to `table`): `private readonly sleepers = new Sleepers()` and `private readonly sleepEnabled: boolean`; constructor: `this.sleepEnabled = options.sleep !== false`.

Wake sources — add exactly these calls:

1. `reserve(u, cells)`: before `this.release(u)`, wake followers only when the cells change:
   ```ts
    if (cells.length !== u.cells.length || cells.some((p, i) => p !== u.cells[i])) this.sleepers.wakeOwner(u.id)
   ```
2. `afterWrite(x, y, z, …)`: first line: `this.sleepers.wakeTile(this.nav.tileOf(x, y, z))`.
3. `invalidateAll()` and `replaceChunk(…)`: first line: `this.sleepers.wakeAll()`.
4. `restore(…)`: nothing to wake (a fresh system); add `this.sleepers.wakeAll()` at the top for clarity.
5. `command(…)`: first line: `this.sleepers.wakeAll()` (commands are rare; any order, cancel, spawn or despawn may change what a sleeper waits for).
6. `incapacitate(u)` and `fall(u)`: first line: `this.sleepers.wakeOwner(u.id); this.sleepers.wake(u.id)`.
7. Physics: in `afterPhysics`, after `if (dynamic !== this.dynamicWasBusy) { … }`, add `if (dynamic || wasDynamic) this.sleepers.wakeAll()` — no unit sleeps through changing physics, as the stationary validation needs it.
8. Deadlines: after `this.time++; this.table.advance(this.time); this.expire()` … i.e. right after `this.expand()` on that line, add `this.sleepers.expire(this.time)`.

Falling asleep — in the first per-unit loop:

- After `if (u.state === 'incapacitated') continue`, add: `if (this.sleepers.dozing(u.id, this.time)) continue`.
- In the flat-motion blocked branch (`if (m.flat && (!this.table.free(u.id, this.time, cells) || !this.reserve(u, cells))) { … }`), as the last statement before `continue`, add:
  ```ts
          // Queued behind a unit on its way (or one yielding to it): sleep until that unit's cells change.
          if (this.sleepEnabled && u.motion && other && this.waitsFor(u, cells, this.time)) this.sleepers.sleep(u.id, this.time, other.id, this.nav.tileOfPose(this.position(u)), this.time + SLEEP_TICKS)
  ```
- In `beginMotion`, in the blocked branch (`if (!this.tableFree(…) || !this.reserve(u, cells)) { … return false }`), before `return false`:
  ```ts
      const other = this.blocker(u, cells, this.time + 1)
      if (this.sleepEnabled && other && u.reason === 'traffic' && this.waitsFor(u, cells, this.time + 1)) this.sleepers.sleep(u.id, this.time, other.id, this.nav.tileOfPose(this.position(u)), this.time + SLEEP_TICKS)
  ```

Second per-unit loop (`for (const u of this.units.values()) { … stuck … project/holdHere }`): replace the final `if (this.projecting(u)) this.project(u); else this.holdHere(u)` with:

```ts
      if (this.sleepers.dozing(u.id, this.time)) {
        // Asleep: no projection, its hold stays. `stuck` rose above as for any unit that did not get closer; a waiting step
        // counts its wait here, where the skipped first pass would have. Wake one tick before a threshold acts.
        if (u.motion) u.wait++
        const lease = u.task !== null && this.time + 1 - u.progressAt >= LEASE_TICKS
        if (u.wait + 1 === 12 || u.wait + 1 === 80 || u.stuck + 1 === STUCK_LIMIT || lease) this.sleepers.wake(u.id)
        continue
      }
      if (this.projecting(u)) this.project(u); else this.holdHere(u)
```

(The `stuck` update just above in the same loop already runs for every unit; a dozing unit's pose does not change, so it takes the `u.stuck++` branch exactly as an awake waiting unit would.)

`cooperate`: in the `conflicted` filter add `&& !this.sleepers.asleep(u.id)`; in the `pending` repairs list nothing changes (a sleeper has no repair: falling asleep happens only without one — add `&& !u.repair` to both sleep conditions above).

`publication`: add `sleeping: this.sleepers.size` to `stats`.

`mixState`: after `this.table.mixState(mix)`, add `this.sleepers.mixState(mix)`.

- [ ] **Step 5: Run the sleep tests and the traffic suites**

Run: `cd packages/engine && npx vitest run test/workersSleep.test.ts test/workers.test.ts test/workersRoutes.test.ts test/spaceTime.test.ts test/reservations.test.ts`
Expected: PASS, including the 5b corridor tests (20 v 20) and the group tests.

- [ ] **Step 6: Save and load**

The last test in Step 1 covers it ("a save taken while units sleep …"). Also run the persistence suites: `cd packages/engine && npx vitest run test/workersSnapshot.test.ts test/persistRoundTrip.test.ts test/simSnapshot.test.ts` — Expected: PASS (sleepers are not in the snapshot; `restore` starts with none).

- [ ] **Step 7: Measure the effect**

Run: `node --experimental-strip-types apps/sandbox/bench/crowd.node.ts --profile=typical --phase=bottleneck > "$TEMP/t5-bottleneck.json"` and the same for `mass`; and one stress phase: `node --experimental-strip-types apps/sandbox/bench/crowd.node.ts --profile=stress --phase=mass --ticks=6600 > "$TEMP/t5-stress-mass.json"`. Record workers p50/p95/max, tick p95 and arrival in the commit message (checks, not gate runs).

- [ ] **Step 8: Commit**

```bash
git add packages/engine/src/sim/workers/types.ts packages/engine/src/sim/workers/workers.ts packages/engine/test/workersSleep.test.ts
git commit -m "perf(workers): units queued behind another unit sleep until it moves, their tile changes or 16 ticks pass"
```

---

### Task 6: Pending searches of standing units come before repairs (first action)

**Files:**
- Modify: `packages/engine/src/sim/workers/workers.ts` (`afterPhysics`, the repair share)
- Test: `packages/engine/test/workersRoutes.test.ts`

**Interfaces:**
- Produces: while a query of a unit that has no path to walk is pending, repairs get at most 1/8 of what is left (`REPAIR_SHARE_WAITING_SHIFT = 3`); otherwise as today (half while any query waits, all when none).

- [ ] **Step 1: Write the failing test**

In `workersRoutes.test.ts`, `describe('hierarchical routes', …)`:

```ts
  it('a group of 40 packed units starts walking within 5 ticks of a far move order on a warm world', () => {
    const sim = makeWide(256, undefined, { searchCap: 8192 })
    for (let i = 0; i < 40; i++) spawn(sim, [4 + (i % 8) * 2, 4, 4 + Math.floor(i / 8) * 2])
    // Warm: let the prebuild build every tile first, as the bench does.
    for (let i = 0; i < 4000 && !sim.workers!.nav.prebuildStatus().done; i++) sim.step()
    cmd(sim, { type: 'unitMove', ids: [...sim.workers!.units.keys()], pos: [200, 4, 200] })
    const started = new Map<number, number>()
    for (let t = 1; t <= 60; t++) { sim.step(); for (const u of sim.workers!.units.values()) if (u.state === 'walking' && !started.has(u.id)) started.set(u.id, t) }
    const ticks = [...started.values()].sort((a, b) => a - b)
    expect(ticks.length).toBe(40)
    expect(ticks[Math.floor(ticks.length * 0.95)]).toBeLessThanOrEqual(5)
  })
```

- [ ] **Step 2: Run it**

Run: `cd packages/engine && npx vitest run test/workersRoutes.test.ts -t "within 5 ticks"`
Expected: FAIL or PASS. If it already passes on this open floor, the field is cheap here; keep it as a regression test and go on to Step 3 anyway (the crowd measurement in Step 5 is the real check).

- [ ] **Step 3: Give pending searches of standing units precedence**

In `afterPhysics`, replace:

```ts
    const repairWork = this.cooperate(this.nav.pending ? left >> 1 : left)
```

with:

```ts
    // While a unit with nothing to walk waits for its search, repairs get an eighth of what is left; while only other
    // queries wait, half; else all of it. A unit that cannot start is worse off than one whose plan needs a repair.
    let starving = false
    for (const u of this.units.values()) if (u.path[u.cursor] === undefined && !u.motion && (u.search?.status === 'pending' || u.route?.search.status === 'pending')) { starving = true; break }
    const repairWork = this.cooperate(starving ? left >> REPAIR_SHARE_WAITING_SHIFT : this.nav.pending ? left >> 1 : left)
```

and add `REPAIR_SHARE_WAITING_SHIFT = 3` to the constants line `const MAX_REPAIRS = 8, REPAIR_SPAN = 24, STUCK_STEP = 20` with a doc comment.

- [ ] **Step 4: Run the suites**

Run: `cd packages/engine && npx vitest run test/workersRoutes.test.ts test/workers.test.ts test/workersSleep.test.ts`
Expected: PASS.

- [ ] **Step 5: Measure the first action on the crowd world**

Run, for `mass` and `scatter`: `node --experimental-strip-types apps/sandbox/bench/crowd.node.ts --profile=typical --phase=<p> --ticks=600 > "$TEMP/t6-<p>.json"`; read `firstActionTicks.p95` and `searchFoundTicks.p95`.

Decision point: if `firstActionTicks.p95` ≤ 5 in both, go on. If not, **stop and report to the user** with: `searchFoundTicks` vs `firstActionTicks` (search vs refinement), the group field's operations (`groupField.spent` — read it in a one-off probe as in the planning probe `_probe-first`), and these options: (a) gate group orders at ≤ 1 s (20 ticks) and single routes at 5; (b) a higher `searchCap` for the typical case (an option, not a default); (c) a cheaper first segment (walk toward the field's first exit on a flat search while the field finishes). Do not pick one yourself.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/sim/workers/workers.ts packages/engine/test/workersRoutes.test.ts
git commit -m "perf(workers): searches of units with nothing to walk come before repairs"
```

---

### Task 7: A per-tick decision budget for units that are not moving

**Files:**
- Modify: `packages/engine/src/sim/workers/types.ts` (`WorkerOptions.decisionCap`, `WorkerStats.deferred`)
- Modify: `packages/engine/src/sim/workers/workers.ts` (fields, constructor, `afterPhysics` first loop, `restore`, `publication`, `mixState`)
- Test: `packages/engine/test/workersSleep.test.ts`

**Interfaces:**
- Produces: `WorkerOptions.decisionCap?: number` (default 256): at most this many non-moving, non-working, non-idle units take decisions per tick; the rest wait FIFO (oldest deferral first). `WorkerStats.deferred: number`.

- [ ] **Step 1: Write the failing tests**

Append to `workersSleep.test.ts`:

```ts
describe('decision budget', { timeout: 60_000 }, () => {
  it('serves at most decisionCap deciding units per tick and every unit within ceil(n / cap) ticks', () => {
    const sim = makeWide(128, undefined, { decisionCap: 4 })
    for (let i = 0; i < 20; i++) spawn(sim, [4 + (i % 5) * 2, 4, 4 + Math.floor(i / 5) * 2])
    sim.submit(0, ++seq, { type: 'unitMove', ids: [...sim.workers!.units.keys()].filter(id => id % 2), pos: [100, 4, 100] })
    sim.submit(0, ++seq, { type: 'unitMove', ids: [...sim.workers!.units.keys()].filter(id => id % 2 === 0), pos: [100, 4, 20] })
    const first = new Map<number, number>()
    for (let t = 0; t < 200; t++) {
      const r = sim.step()
      expect(r.workers!.stats.deferred).toBeLessThanOrEqual(20)
      for (const u of sim.workers!.units.values()) if (u.state === 'walking' && !first.has(u.id)) first.set(u.id, t)
    }
    expect(first.size).toBe(20)
  })
  it('with the default cap, 100 units never defer', () => {
    const sim = makeWide(128)
    for (let i = 0; i < 100; i++) spawn(sim, [4 + (i % 10) * 2, 4, 4 + Math.floor(i / 10) * 2])
    sim.submit(0, ++seq, { type: 'unitMove', ids: [...sim.workers!.units.keys()], pos: [100, 4, 100] })
    for (let t = 0; t < 100; t++) expect(sim.step().workers!.stats.deferred).toBe(0)
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `cd packages/engine && npx vitest run test/workersSleep.test.ts -t "decision"`
Expected: FAIL — `stats.deferred` undefined.

- [ ] **Step 3: Implement**

`types.ts`: `WorkerOptions.decisionCap?: number` with doc "Units that are not moving, working or idle that take decisions per tick (default 256); the rest wait, oldest first." `WorkerStats.deferred: number`.

`workers.ts`:
- Fields: `private readonly decisionCap: number` (constructor: `options.decisionCap ?? 256`, add to the validated entries) and `private deferred = new Map<number, number>()` (unit → tick it was first deferred).
- At the start of `afterPhysics`'s first loop (just before `for (const u of this.units.values()) {`):

```ts
    // FIFO decision budget: units deferred longest go first, then the others in id order while slots are left.
    const waiting = [...this.deferred].sort((a, b) => a[1] - b[1] || a[0] - b[0]), serve = new Set(waiting.slice(0, this.decisionCap).map(e => e[0]))
    let slots = this.decisionCap - serve.size
    const deferredNext = new Map<number, number>()
```

- In the loop, right after the motion block (`if (u.motion) { … if (u.motion) continue }`), before `if (u.state === 'blocked') {`:

```ts
      // Idle units with nothing to do and working units are cheap and exempt; anyone else takes a decision slot.
      if (u.state !== 'idle' && u.state !== 'working') {
        if (this.deferred.has(u.id) ? !serve.has(u.id) : slots-- <= 0) { deferredNext.set(u.id, this.deferred.get(u.id) ?? this.time); continue }
      }
```

- After the loop: `this.deferred = deferredNext`.
- `restore`: `this.deferred.clear()`. `command` `unitDespawn`: `this.deferred.delete(u.id)` per despawned unit.
- `publication` stats: `deferred: this.deferred.size`.
- `mixState`: `mix(this.deferred.size); for (const [id, t] of [...this.deferred].sort((a, b) => a[0] - b[0])) { mix(id); mix(t) }`.

Check that a deferred unit's counters behave: it is skipped after its motion block, so `wait` is not touched; `stuck` still rises in the second loop (it did not get closer), which ages its priority as it should.

- [ ] **Step 4: Run the suites**

Run: `cd packages/engine && npx vitest run test/workersSleep.test.ts test/workers.test.ts test/workersRoutes.test.ts test/determinism.test.ts`
Expected: PASS.

- [ ] **Step 5: Calibrate the cap with the stress profile**

Run (quiet machine): `node --experimental-strip-types apps/sandbox/bench/crowd.node.ts --profile=stress --phase=scatter --ticks=6600 > "$TEMP/t7-scatter.json"`, then `mass` and `churn` the same way. If any tick p95 is above 15 ms, lower the default `decisionCap` (128, then 64) and re-run that phase; never raise it above 256. Record the chosen value and the tick p95s in the commit message.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/sim/workers/types.ts packages/engine/src/sim/workers/workers.ts packages/engine/test/workersSleep.test.ts
git commit -m "perf(workers): FIFO decision budget per tick for units that are not moving (decisionCap)"
```

---

### Task 8: Gate runs, report, ADR amendment and the user's checkpoints

**Files:**
- Create: `docs/superpowers/research/2026-10-13-traffic-gates.json`
- Create: `docs/superpowers/reviews/2026-10-13-navigation-traffic.md`
- Modify: `docs/adr/0003-hierarchical-routes-and-reservations.md` (append a "Round 3" paragraph)
- Modify: `CONTEXT.md` (terms: *wade*, *sleeping unit*, *decision budget*, if not present)

- [ ] **Step 1: Full verification**

Run: `npm run typecheck` (exit 0), `npm test` (re-run load-sensitive timeouts alone if they fail), and e2e: `cd apps/sandbox && E2E_PORT=5197 E2E_CHANNEL=msedge npm run e2e -- --workers=1`. All green, or stop and fix.

- [ ] **Step 2: Gate runs (quiet machine; check before each batch)**

```bash
for p in mass scatter bottleneck work churn; do for r in 1 2; do node --experimental-strip-types apps/sandbox/bench/crowd.node.ts --profile=typical --phase=$p --assert --unreachable-cap=0 > "$TEMP/g-typ-$p-$r.json"; done; done
for p in mass scatter bottleneck work churn; do for r in 1 2; do node --experimental-strip-types apps/sandbox/bench/crowd.node.ts --profile=stress --phase=$p --assert > "$TEMP/g-str-$p-$r.json"; done; done
node apps/sandbox/bench/livingAb.node.mjs --a=. --b=../voxel-pre5b --pairs=5 --assert=0.15 > "$TEMP/g-living.json"
node --experimental-strip-types apps/sandbox/bench/crowd.node.ts --quality > "$TEMP/g-quality.json"
```

(The stress runs take about 5 minutes per phase; 10 runs ≈ 50 min. Tell the user before starting.) Write `docs/superpowers/research/2026-10-13-traffic-gates.json` the same way as the baseline file (Task 0 Step 9), with the worse of two per phase.

- [ ] **Step 3: Report**

`docs/superpowers/reviews/2026-10-13-navigation-traffic.md`, in the shape of `2026-10-09-navigation-at-scale.md`: outcome first (gates met or not, one paragraph); links (spec, plan, ADR, research files); what was delivered per task with commits; measurements (baseline vs final tables for typical, stress, living); the planning findings and deviations D1–D6 plus any found during execution; open items; the user checkpoint instructions (Step 5).

- [ ] **Step 4: ADR and glossary**

Append to ADR 0003 a "Round 3 (2026-10-13)" paragraph: the head-cell water rule shared by the region layer and the live policy (wading up to one block), liquid changes invalidating like falls flips, the queue-only prebuild with `prebuildCap`, sleeping units and their wake sources, the FIFO decision budget. Add `CONTEXT.md` terms for *wade*, *sleeping unit* and *decision budget* in the file's existing style (read it first).

- [ ] **Step 5: Commit, then the user's checkpoints**

```bash
git add docs/superpowers/research/2026-10-13-traffic-gates.json docs/superpowers/reviews/2026-10-13-navigation-traffic.md docs/adr/0003-hierarchical-routes-and-reservations.md CONTEXT.md
git commit -m "docs(nav): round 3 traffic report, gate results and ADR 0003 amendment"
```

Then ask the user to check, with the dev server (`cd apps/sandbox && npm run dev -- --port 5196 --strictPort`):
1. `?scene=crowd`: **Criar 1.000** is fixed at 1,000 — for the 100-unit look, the scene takes `?units=100` if it exists (check `apps/sandbox/src/scenes/crowd.ts` / `crowdScript.ts`; if not, add a `units` URL parameter as part of this step, defaulting to 1,000). Then **Todos → leste** (the west group now goes around the water or wades the shallow part), **Gargalo**, **Espalhar**: queues form and drain, nobody stands inside another, playback stays smooth.
2. `?scene=living`: units and water as before; no visible change.

Record the user's verdict in the report and commit it. Merging into `main` is the user's call (superpowers:finishing-a-development-branch).
