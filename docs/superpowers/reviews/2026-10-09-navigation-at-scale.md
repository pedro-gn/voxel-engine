# Navigation at scale (5b): final report

Date: 2026-10-12. Branch `feat/navigation-scale`, from `main` d63ffe1. Round 2 from 70b7063; measured at 9e3c7b4.

**Outcome: the §7 gates are not met.** Route quality passes, and no false `unreachable` remains. At 1,000 units every
phase misses the CPU, first-action and arrival targets by a wide margin, and the living benchmark is slower than
`main`. The cause is group congestion: the units of a move order merge into single-file lines and jam, and the waiting
units cost most of the CPU. Round 2 stopped by the user's decision (option B: measure and report) before a movement
layer for groups was attempted. See [Round-3 options](#round-3-options).

- [Spec](../specs/2026-10-09-navigation-at-scale-design.md) (§7 corrected 2026-10-09, amended 2026-10-12)
- [Plan](../plans/2026-10-09-navigation-at-scale.md)
- [ADR 0003](../../adr/0003-hierarchical-routes-and-reservations.md)
- Data, all in `../research/`:
  - baseline (pre-5b, quiet, 2026-10-12): `2026-10-09-crowd-baseline.json`
  - round-2 gate runs, worse of two, cold mass, path quality (with the group sample): `2026-10-12-crowd-round2-gate.json`
  - living A/B vs `main`: `2026-10-12-crowd-round2-living-ab.json`

## What was delivered

### Round 1 (2026-10-09)

**Hierarchy** (H1–H7, `packages/engine/src/sim/navigation/`).
- Regions of 16³ tiles with exits; runs of exits merged across height changes when both ends connect both ways.
- `RouteSearch` (weighted abstract A*, `ROUTE_WEIGHT` 1.25) and `GroupField` (one reverse search per move order, shared
  by its units); units walk segmented routes refined two segments ahead, with a confined flat fallback.
- Region builds are sliced and charged against the search budget (`BUILD_WEIGHT` 4 build steps per operation),
  shared between concurrent queries; poses on `falls` blocks are not standable in the region layer.
- Region store with a byte cap; empty tiles share one frozen record; per-column slot index (ground record ~8 KB).
- Agreement fuzz (1,000 pairs, 1,000 group starts: reachability agrees on all) and `--quality`.

**Cooperation** (C1–C5). Reservation table, projection and holds in the executor, space-time repair with pockets,
priorities, preemption with refuges, make-way, keep-right cost in repairs.

**Frontier** (F1–F4). Effective priority and aging, fair shares with parking, work-pose claims with leases, locality
with a global-priority pull.

**View** (V1–V3). Units drawn ~75 ms behind the newest tick at constant speed; edit holds 250 ms (was 1 s) and only the
editor and units within 1.5 blocks; nav-perf (policy once per pose, no allocations in the edge loop; ~0.6× ns per op,
confirmed quiet: long search 265 → 158 ns/op, short 147 → 96).

**Bench and scene** (Task 0, X1). `crowd.node.ts` (1,000 units, 1024² crowd world, five phases, exact-A* ideal walks,
false-unreachable re-check, `--assert`), `?scene=crowd`.

### Why round 1 did not pass at scale

Quiet measurements on 2026-10-12 (integration 3671bc5, mass, 1,000 units, 6,600 ticks): 394 started, 0 arrived,
workers p95 9.9 ms. Root causes:
1. Every long route and group field went stale: random ticks flip sand to wet sand (`falls`) ~0.8× per tick world-wide,
   and any change to an explored region staled the whole search. Fixed in c42a472: a found route is stale only if a
   region it crosses changed; a group field only if its goal or start regions changed.
2. Cold cost: the west+north → east group field builds ~3,400 regions (~11.5 M operations, ~1,400 ticks at 8,192 per
   tick) before anyone walks, because the sand belt forces a long detour.
3. Warm, 100 units: the group field still costs 1.2 M operations; target changes replanned to per-unit route searches
   that end search-limited.

### Round 2 (2026-10-12)

User-approved amendment (70b7063): background region prebuild with spare budget, store cap up to 64 MiB, first action
gated on a warm world (cold recorded).

**Routing** (R1–R4, then the single-agent finish).
- R1 f49d375: refinement appends only while the path still ends where the route left off, so a repair or sidestep
  that replaced the path no longer causes `target-changed` jumps.
- R2 b903361, 82ee460: local recovery on the route's own costs (`nextHop` prices the way on from any pose; a changed
  tile is rebuilt on the refinement budget); a full replan only for a loop or more than 16 recoveries. `RouteSearch`
  node cap 65,536. 913c501: a reseat (traffic or an edit moved the unit) restarts that history.
- R3 9b6fac0: one group field per start cluster; starts covered by the first closed exit they reach; a field capped
  by its node limit still serves the starts it settled. 7db5026: group fields weight their heuristic by 2 (routes keep
  1.25), after a group quality sample met the gate.
- R4 fe8b796: background region prebuild with the operations a tick leaves unused (rings around units, then every tile
  by index); store cap 64 MiB; the prebuild stops at 90%. c3d73a8: `prebuildStatus()` for warm-ups; half-built regions
  are kept and finished by the next reader or the prebuild.
- Landmarks (user decision, option b) 8a4f358, 9058c58, ba03c71, 68f8f39: an ALT bound from eight edge tiles over the
  region graph, computed by the prebuild once every tile is built. The tables read sand as standable in and next to
  tiles where the falls rule has ever changed (`nav.flippy`), so wet/dry flips keep them a lower bound; dry sand that
  never changes stays a barrier, which keeps the sand-belt gain. A solid edit, or the first flip in a new tile, retires
  them until they are computed again. A landmark search that ends limited is not used (M4).
- Portal lanes 7e6e1a7: exits keep their run of crossings; a unit crosses at the first one it reaches.
- c53b4f2: a traffic detour (a flat search around nearby bodies) that ran out of poses was reported unreachable, which
  gave false `no-access` verdicts. It now ends limited, and the unit waits on traffic. 3bb75d8: no detour search from
  partway up a climb (another false `no-access`). ee4d236: a weighted group field's far stop compares unweighted
  costs. M3 (in ba03c71): a full store drops half-built regions.

**Traffic** (T1–T3).
- T1 bfa67f6: keep-right lanes in passages exactly two wide; queues wait behind leaders going the same way; aimless
  units give way. The 20 v 20 and 30 v 30 corridor tests pass. 5cc726a: pending repairs share the budget fairly (by
  rotation) and lapse after 4 ticks.
- Integration: 7ac9314 repairs take half the budget only while navigation queries wait; d2cc6f6 refuge plans leave the
  route at once (a cheaper way to a space-time state replaces the queued one); 92b3bf1 no repair once the conflict
  cleared (a crash at 1,000 units).
- Reviewer's C1, 443f6a0: a unit that is not on its way (blocked, or waiting on a search) no longer shields followers,
  who had waited behind it forever. 04bc54d: a unit blocked on traffic keeps its settled route instead of planning one
  of its own (~370 units had queued behind one another's route searches).
- T2 (500 against 500 through the gates) and T3 (workers' share): not met, see Measurements. Identical-result speed-ups:
  walkSweep (833844e, 6a86cb4) and traffic's space-time and projection caches (b631340, 991ff28, merged in 3d19d7a).

**Bench** (B1): phases of 6,600 ticks (ideal walks reach ~5,200 ticks on the sand detour, plus the 60 s grace); every
phase warms the region store before its orders (ticks until the engine's prebuild reports done); `--cold` measures the
cold first action separately; the result JSON labels the warm-up and reports region bytes against the cap.

## Measurements

Conditions: 2026-10-12 19:46–20:27, commit 9e3c7b4, Node v24.5.0, quiet machine (17–19 GB free, CPU 7–31% before
each run, no game running, checked before every run). Worse of two runs, one phase per process, 1,000 units,
searchCap 8,192, 6,600 timed ticks per phase after a warm-up that ticks until the prebuild reports done (regions
and landmark tables).

### Baseline (pre-5b)

`main` + the crowd bench (e5eff43), searchCap 8192, 4,400 ticks, worse of two:

| Phase | tick p95 / max ms | workers p95 / max ms | started | arrived |
|---|---|---|---|---|
| mass | 7.32 / 36.82 | 2.91 / 29.62 | 0 / 1,000 | 0% |
| scatter | 7.30 / 35.34 | 2.94 / 22.61 | 0 / 1,000 | 0% |
| bottleneck | 7.21 / 24.35 | 2.85 / 18.55 | 0 / 1,000 | 0% |
| work | 9.87 / 23.19 | 5.28 / 14.77 | — | 177 / 1,472 tasks |
| churn | 7.28 / 36.18 | 2.95 / 25.60 | 0 / 1,000 | 0% |

In every move phase no unit ever started: each long flat search ends search-limited (456–464 units blocked
`search-limited`), so the phase length did not matter.

### X3 gate vs spec §7 (round 2, worse of two)

| Criterion | Target | mass | scatter | bottleneck | work | churn |
|---|---|---|---|---|---|---|
| Workers p95 / max | ≤ 4 / ≤ 12 ms | 18.6 / 38.6 ✗ | 20.0 / 67.2 ✗ | 18.6 / 38.8 ✗ | 10.3 / 35.7 ✗ | 18.2 / 56.2 ✗ |
| Tick p95 | ≤ 15 ms | 25.6 ✗ | 26.5 ✗ | 25.8 ✗ | 16.8 ✗ | 25.2 ✗ |
| First action p95 (p50), warm | ≤ 20 ticks (1 s) | 106 (93) ✗ | 704 (402) ✗ | 97 (83) ✗ | — | 805 (489) ✗ |
| Arrival within ideal + 60 s | ≥ 99% (bottleneck 100%) | 6.5% ✗ | 35.2% ✗ | 0.8% ✗ | — | 10.0% ✗ |
| Arrived at all in the phase | — | 9.4% | 69.6% | 1.4% | — | 33.1% |
| Work tasks done | — | — | — | — | 808 / 1,472 | — |
| False unreachable | 0, all verdicts checked | 0 ✓ | 0 ✓ | 0 ✓ | — | 0 ✓ |
| Region bytes / cap | ≤ 64 MiB | 45.9 MB ✓ | 45.8 MB ✓ | 45.8 MB ✓ | 46.0 MB ✓ | 46.0 MB ✓ |
| Landmark tables current, % of ticks | — | 16 | 16 | 16 | 1.9 | 0.2 |

Navigation bytes in all (store, tables, queries, edge cache) peaked at 58–62 MB. Every phase failed `--assert`.

What the numbers show:
- **Congestion is the root cause.** The units of one move order share a group field, and its grid-optimal paths
  merge into single-file lines in open terrain; region portals (runs of at most 8 crossings, split at tile borders)
  narrow them further. In the mass phase 400–590 units at a time wait on traffic behind one another (18,554 traffic
  blocks in the phase). A synthetic test shows the same thing at small scale: 200 units through a 3-wide gap that
  straddles a tile border, 155 through after 3,000 ticks.
- **Waiting units drive the CPU.** Each one retries its step, re-projects its reservations and asks for repairs every
  tick; profiles put ~15 ms of the workers' share in that per-unit traffic work (projection, space-time repairs, step
  checks), not in the searches. A smaller searchCap cannot bring the share to 4 ms on its own.
- **First action** is limited by refinement and the route queue, not the group fields: on a warm world with current
  landmark tables the west field costs ~13 k operations and the north one ~7 k, yet the mass p95 is 106 ticks.
  Scatter and churn give every unit its own route search, and 1,000 of them queue behind the 8,192-operation budget.
- **Landmarks are current only 16% of a move phase**: each tile whose sand first gets wet or dries during the phase
  (11 per phase) retires the tables until they are computed again, which the leftover budget of a busy tick does
  slowly; in work and churn every dig or wall retires them (I2, open).

### First action: warm vs cold

Warm-up: 7,648–7,660 ticks (47–53 s untimed) until every one of the 32,768 tiles was built and the landmark tables
were current; the tables are retired a few times during warm-up as sand near water first flips. Region store 45.8 MB.

Cold mass (`--cold`, one run): first action p50 1,046 / p95 1,058 ticks; 7,302 regions were already built at order
time (the 120 setup ticks and the spawn ticks prebuild with spare budget). Arrival within ideal + 60 s was 13.2%,
higher than warm (6.5%): units that start later spread out and jam less.

### Path quality

`--quality`, 500 seeded surface pairs on the warm crowd world, with the prebuild's landmark tables, against exact flat
A* under the same static rule (no pose on a falling block): reachability agrees on 500 / 500 (70 unreachable); routed
pairs (428) cost mean 1.04×, p95 1.09×, max 1.16× ✓. Group fields (weight 2), 25 fields of 20 clustered starts: 500 / 500
agree; 380 routed starts cost mean 1.056×, p95 1.23×, max 1.24× ✓.

### Living benchmark, `main` vs branch

Interleaved AB, BA, AB (`nodeAb.node.mjs`), p50 ms per phase:

| Phase | `main` d63ffe1 | branch 9e3c7b4 | median delta |
|---|---|---|---|
| idle | 2.96, 2.94, 2.85 | 3.97, 3.32, 3.56 | +0.62 ✗ |
| work | 3.22, 3.33, 3.67 | 4.81, 4.86, 5.55 | +1.53 ✗ |
| dam | 6.01, 5.64, 5.65 | 7.82, 7.55, 7.55 | +1.90 ✗ |
| collapse | 6.50, 7.17, 6.10 | 8.39, 8.92, 8.05 | +1.89 ✗ |

The gate "living benchmark no worse" fails. Attribution (two branch runs with the background prebuild switched off,
not committed): idle 2.94 / 2.96, work 4.13 / 5.29, dam 5.89 / 7.00, collapse 6.41 / 6.69. The prebuild and the landmark
recomputes after flips spend every tick's leftover budget and explain the idle gap and much of dam and collapse; the
rest (work) is the per-unit traffic work added in round 1.

## Verification

- `npm run typecheck`: clean.
- `npm test` at 5043938 (code as measured, plus data): engine 1,083 passed + 2 expected fail; sandbox 174; terrain 200;
  terrain-editor 124.
- E2E: **not run in round 2** (user's decision); the last e2e runs were round 1's.
- Determinism: speed-ups were checked hash-identical (walkSweep equivalence test; traffic's merge on three scenarios,
  hashes every 100 ticks).

## Deviations

- Landmark tables (user decision b): the lead's note asked for a fully relaxed graph (sand standable everywhere). That
  erased the sand-belt gain (west → east route back from 6.7 k to 135 k operations, scatter first action p50 74 → 361
  ticks), so sand is relaxed only in and next to tiles where the falls rule has changed, with the first change in a
  new tile retiring the tables. Sound, and the gain is kept while the tables are current.
- Group fields weight their heuristic by 2 (ruling's condition met by the sample above). A probe saw more units moving
  at 1.25 at tick 1,000 but similar arrivals by tick 5,000 (80 vs 90), and a slower first action (p95 87 vs 71).
- Traffic's proposed repair cap (min(2,048, half the remaining budget)) was not adopted: no gate runs to justify tuning.
- The quality bench's exact search now applies the static sand rule, as the live policy and the region layer do; before,
  it walked on sand and reported 108 false disagreements.

## Open items

- §7 targets: all CPU, first-action, arrival and bottleneck gates, and the living benchmark (see above).
- I2 (reviewer): any solid edit anywhere retires every landmark table and restarts all eight whole-world searches; in
  work and churn the tables are almost never current. Needs local repair or recompute.
- Flip retirements: new tiles whose sand first flips retire the tables mid-phase (16% current). Marking tiles with sand
  near water as relaxed up front, or recomputing only the affected landmarks, would keep them current.
- The background prebuild never rests while random ticks keep changing tiles: it rescans every tile at one operation
  each and recomputes landmarks, using the whole leftover budget (living regression).
- searchCap stays 8,192: the per-unit traffic work, not the search budget, dominates the share.
- Scatter and churn: one route search per unit queues 1,000 searches behind one budget.

## Round-3 options

1. **Group movement layer** (largest effect, multi-day): units of one order follow a shared flow field with lanes
   spread across the width of the way (and across a portal's crossings), with local avoidance between neighbours in
   place of per-cell projections for units in a group; reservations stay for crossings, corridors and gates.
2. **Cheaper waiting**: a unit waiting behind a known leader sleeps until that leader moves or its table cells change,
   instead of retrying, re-projecting and repairing every tick; bound repairs and preemption per region.
3. **Background work that rests**: prebuild and landmark recompute capped per tick (or only when idle) and queue-driven
   (changed tiles only); local landmark repair for edits (I2) and relaxed sand near water marked up front.
4. **Re-scope the gate**: gate CPU and arrival at a smaller crowd (for example 200–300 units) and record 1,000, if the
   user prefers to ship the hierarchy and cooperation as they are.

## User checkpoint: `?scene=crowd`

Start the dev server from the integration worktree and open the crowd scene:

```
cd .claude/worktrees/nav-integration/apps/sandbox
npm run dev -- --port 5196 --strictPort
```

Then open `http://localhost:5196/?scene=crowd`. The camera looks down on the 1024² crowd world with its five pads. The
bar at the bottom drives the scale benchmark's events:

1. **Criar 1.000**: clears the pads and spawns 1,000 units, half on the west pad and half on the north pad. Runs once.
   Regions and landmark tables are built in the background with spare budget; the bench waits ~7,650 ticks (about
   6½ minutes) for a fully warm world. Orders given earlier still work; the first units only start more slowly.
2. **Todos → leste**: one move order, everyone to the east pad (the long west → east trip goes around the sand belt).
3. **Espalhar**: scattered destinations 200–800 blocks away; each press draws new ones.
4. **Gargalo**: builds the full-height wall at x = 832 with a one-wide and a two-wide gate, then sends half the units
   east and half west through it. Runs once.
5. **Obras**: the 20 work orders (digs and builds) on the pads.

What to look at: how soon units start after an order; whether units ever stand inside one another or pass through
walls (they should not); whether playback stays smooth (units are drawn ~75 ms behind the newest tick, at constant
speed). Known at this commit (see Measurements): with all 1,000 units moving, the units of a pad merge into long
single-file lines and jam where paths cross. Many units wait for long stretches, most do not arrive within the
benchmark's time, and the simulation runs slower than real time while the jam lasts.
