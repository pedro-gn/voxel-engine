# Navigation at scale (5b): final report

Date: TBD. Branch `feat/navigation-scale`, from `main` d63ffe1. Round 2 from 70b7063.

- [Spec](../specs/2026-10-09-navigation-at-scale-design.md) (§7 corrected 2026-10-09, amended 2026-10-12)
- [Plan](../plans/2026-10-09-navigation-at-scale.md)
- [ADR 0003](../../adr/0003-hierarchical-routes-and-reservations.md)
- Data, all in `../research/`:
  - baseline (pre-5b, quiet, 2026-10-12): `2026-10-09-crowd-baseline.json`
  - round-2 gate runs: TBD
  - path quality: TBD
  - living A/B vs `main`: TBD

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
- Landmarks (user decision, option b) 8a4f358, 9058c58: an ALT bound from eight edge tiles over the region graph,
  computed by the prebuild once every tile is built, and retired by any solid edit until recomputed.
- Portal lanes 7e6e1a7: exits keep their run of crossings; a unit crosses at the first one it reaches.
- c53b4f2: a traffic detour (a flat search around nearby bodies) that ran out of poses was reported unreachable, which
  gave false `no-access` verdicts. It now ends limited, and the unit waits on traffic.

**Traffic** (T1–T3).
- T1 bfa67f6: keep-right lanes in passages exactly two wide; queues wait behind leaders going the same way; aimless
  units give way. The 20 v 20 and 30 v 30 corridor tests pass. 5cc726a: pending repairs share the budget fairly (by
  rotation) and lapse after 4 ticks.
- Integration: 7ac9314 repairs take half the budget only while navigation queries wait; d2cc6f6 refuge plans leave the
  route at once (a cheaper way to a space-time state replaces the queued one).
- T2 (500 against 500 through the gates) and T3 (workers' share): see Measurements. walkSweep is cheaper with identical
  results (833844e, 6a86cb4).

**Bench** (B1): phases of 6,600 ticks (ideal walks reach ~5,200 ticks on the sand detour, plus the 60 s grace); every
phase warms the region store before its orders (ticks until the engine's prebuild reports done); `--cold` measures the
cold first action separately; the result JSON labels the warm-up and reports region bytes against the cap.

## Measurements

Conditions: TBD (quiet window, free RAM, CPU, Node version). Worse of two runs, one phase per process, 1,000 units.

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
| Workers p95 / max | ≤ 4 / ≤ 12 ms | TBD | | | | |
| Tick p95 | ≤ 15 ms | | | | | |
| First action p95 (warm) | ≤ 20 ticks (1 s) | | | | — | |
| Arrival within ideal + 60 s | ≥ 99% (bottleneck 100%) | | | | — | |
| False unreachable | 0, all verdicts checked | | | | — | |
| Region bytes / cap | ≤ 64 MiB | | | | | |

### First action: warm vs cold

TBD: warm-up ticks, ms and built/ground per phase; cold first action from a separate `--cold` run of each phase; whether
the 120 setup ticks warm anything (at 3671bc5 they did not: regions at order 0).

### Path quality

TBD (`--quality`, 500 pairs: agreement, cost ratio mean / p95 over routed pairs).

### Living benchmark, `main` vs branch

TBD (interleaved ABBA, `nodeAb.node.mjs`).

## Verification

TBD: typecheck, `npm test` per workspace, full e2e (Edge, one worker).

## Deviations

TBD (from the plan and the spec, with the ledger's rulings).

## Open items

TBD.

## User checkpoint: `?scene=crowd`

TBD.
