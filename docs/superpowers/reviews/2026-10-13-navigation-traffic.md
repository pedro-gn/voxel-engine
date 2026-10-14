# Navigation traffic (SP5 round 3): final report

Date: 2026-10-13. Branch `feat/navigation-traffic`, from `main` 9163239 (spec 8c9d139, plan 62fa985).

**Outcome: the correctness targets are met at 100 units, the performance targets are not.** The bug that stranded half of
a group order is fixed: mass goes from 50% to 100% arrival, scatter and churn arrive 100%, and no false `unreachable`
verdict remains. The workers' share of the tick (p95 3.3–5.3 ms, max 17–44 ms against 2 and 8), the first action of
group orders (p95 44–71 ticks against 5) and the head-on bottleneck (45% arrival against 100%) did not reach their
targets, and the living scene is still slower than before 5b (round 3 itself adds +0.76 ms in the collapse phase, little
elsewhere). The 1,000-unit stress runs were skipped at the user's request. The user asked to close the round here; the
performance targets are open items.

- [Spec](../specs/2026-10-13-navigation-traffic-design.md), [plan](../plans/2026-10-13-navigation-traffic.md),
  [ADR 0003](../../adr/0003-hierarchical-routes-and-reservations.md) (round 3 paragraph)
- Data: `../research/2026-10-13-traffic-gates.json` (baseline, world-only, typical, quality; stress and living below)

## What was delivered

| Commit | Change |
|---|---|
| f9817cb | Crowd bench: `--profile=typical|stress`, `--world-only`, search-found ticks; `livingAb.node.mjs` (interleaved A/B) |
| ff286c4 | Units wade: the live policy refuses a pose only when its head cell holds liquid (was: water deeper than half a block) |
| 3b29455 | The region layer drops poses with liquid in the head cell: routes no longer cross water units refuse (the stuck-half bug) |
| d865b37 | Prebuild by queue: after the first complete pass only changed tiles are rebuilt, at most `prebuildCap` a tick |
| 8ac64d8, 2761830 | Sleeping units: a unit queued behind a unit on its way skips its decisions until that unit's cells change, its tile changes, a command arrives or 16 ticks pass |
| bad5d5e | While a unit with nothing to walk waits for its route or group field, repairs get an eighth of the leftover budget |
| b003b6d | FIFO decision budget (`decisionCap`, 256) for units that are not moving, working or idle |
| 6a22f73 | Final-review fixes (see Review) |
| 2a7af88 | `prebuildCap` applies only once the world is warm (capped from the start, the crowd warm-up never finished) |
| c52f805, 8f616c3, 07daed8 | Water robustness: wade-out escape for units with water over their heads, re-escape, wading hysteresis (carry on up to 1.5 blocks once in water), wade to the region layer before a long walk |
| 0d0005f | Wading costs about three steps in planning (`WADE_COST` 8), walked at the same speed (user decision) |
| ff22985 | Liquid changes reach the region layer per tile 200 ticks after the first, in one bump (`WATER_SETTLE`) |

## Measurements

Conditions: Node v24.5.0, 100 units on the 1024² crowd world, 6,600 timed ticks per phase after the prebuild warm-up,
worse of two runs, quiet machine checked before each batch.

World alone (no units): tick p95 5.9–6.9 ms in every phase (the Task 0 stop rule was 9 ms).

### Typical: 100 units

| Phase | Arrival in grace (all) | baseline | First action p95 (search found) | baseline | Workers p95 / max ms | baseline | Tick p95 ms |
|---|---|---|---|---|---|---|---|
| mass | **100% (100%)** | 50% | 44 (42) | 44 | 4.9–5.3 / 22–44 | 4.5 / 24 | 12.8–13.8 |
| scatter | **100%** | 100% | **13** (10) | 17 | 3.3–3.7 / 20–21 | 4.0 / 24 | 10.2–11.4 |
| bottleneck | 41% (45%) | 50% | 71 (69) | 64 | 4.4–4.8 / 18–19 | 6.1 / 20 | 12.4–13.9 |
| churn | **100%** | 99% | 47 (46) | 55 | 4.3–5.3 / 17–26 | 4.0 / 22 | 12.1–15.0 |
| work | 552 / 1,472 tasks | 541 | — | — | 3.9–4.3 / 29 | 4.0 / 25 | 11.6–12.9 |

False `unreachable`: 0 in every phase, every verdict re-checked. Route quality (`--quality`, 500 pairs): agree 500/500,
mean 1.04, p95 1.09; group fields 500/500, mean 1.056, p95 1.23 (gate 1.10 / 1.25: pass).

Gates (spec §8): arrival met in mass, scatter and churn, missed in bottleneck; first action missed everywhere; workers'
share missed everywhere.

### Stress: 1,000 units

Not run: the user asked to skip the 1,000-unit runs to save time. The stress gate (tick p95 ≤ 15 ms, nobody stuck)
is unmeasured for this branch; round 2's numbers at 1,000 units are in `../research/2026-10-12-crowd-round2-gate.json`.

### Living scene vs `d63ffe1`

Five interleaved pairs (`livingAb.node.mjs`), median of the per-pair p50 differences, ms. Against `d63ffe1` (before 5b,
the spec's gate, ≤ +0.15) and against `main` (9163239, round 2, to show what round 3 itself adds):

| Phase | branch − `d63ffe1` | branch − `main` |
|---|---|---|
| idle | +0.38 ✗ | −0.04 |
| work | +1.57 ✗ | +0.10 |
| dam | +2.17 ✗ | +0.17 |
| collapse | +2.04 ✗ | +0.76 |

The living gate fails. Most of the gap to `d63ffe1` is round 2's (5b report: +0.30 / +1.15 / +1.34 / +1.10 against the
same baseline); round 3 adds little except in the collapse phase (+0.76). The two A/Bs ran back to back on a quiet machine
but drifted (the second run's absolute times are higher), so differences under ~0.3 ms are within noise.

## What was found on the way

1. **The stuck half was water** (planning probe). The region layer was water-blind (ADR 0003): routes crossed water deeper
   than the live policy allowed, units blocked `unsafe`, replanned and got the same route. Fixed by making the head-cell
   rule part of both (D1).
2. **The prebuild cap starved the warm-up**: at 1,024 operations a tick the crowd warm-up timed out after 20,000 ticks
   with 13,843 of 32,768 tiles; first action rose to 269 ticks. The cap now applies once the world is warm.
3. **Wading at exactly one block strands units**: lakes on the crowd world sit about one block deep and their level moves
   by a few 1/256; units that waded in had their heads under water a moment later, and every search from there ended
   `unreachable` (31 false verdicts). Fixed by the wade-out escape, the 1.5-block hysteresis (user approved), the wade to
   the region layer, and the water cost (user decision: routes keep to dry land unless going round is much longer).
4. **Water flips about 150 times a tick** at river edges (2.49 M liquid writes in ~16,000 ticks). Bumping a tile revision
   on each one restarted every build and search over it: churn arrival fell from 99% to 58% with route searches pending
   at 1–2 M operations. Liquid changes now settle for 200 ticks per tile (review finding I6, confirmed by measurement).

## Deviations from the plan

- D1–D6 as listed in the plan (head-cell rule, counters keep rising, sleep only in a queue, no bulk move of the existing
  traffic code, decision budget in units, queue-only prebuild after the first pass).
- The changed-tile queue fills from the start, not only after the first pass.
- Sleep wakes on the owner's cells changing plus a deadline; the spec's "a wanted cell is released" wake is not separate.
- Decisions the plan did not foresee, all from measurements: the warm-only prebuild cap, wading hysteresis, wade-out,
  wade to the region layer, `WADE_COST`, `WATER_SETTLE` (see What was found).
- Benchmarks ran later than their tasks (the machine was busy for most of the execution); the stress and living
  calibrations of `prebuildCap` and `decisionCap` used the defaults' measurements below.

## Review

Whole-branch review (opus) after Task 7: no critical issue, eight important. Fixed with a failing test first: water-only
chunk regeneration did not invalidate regions; springs and non-water liquids were looser in the region layer than live;
dozing units skipped their safety checks and changing physics woke every sleeper; cooperation changed sleepers' plans
without waking them; decision slots went to no-op turns and stalled walkers; the world-only bench never warmed. The
eighth (liquid flips bumping revisions) was measured later and fixed (finding 4). Forcing a table hold on sleepers, or
keeping units others yield to awake, broke the 20- and 30-a-side corridor tests; cooperation now skips only units dozing
since an earlier tick, and a dozer whose cells lapse wakes.

Deferred minors: `beginMotion` sleepers stop counting `wait` while dozing; `prebuildPasses` decides behaviour but is not
hashed; `changed.shift()` is O(n); the decision-budget test does not assert FIFO order; owner-wake paths (incapacitated,
falling) have no direct test; the 20-unit group test allows 6 + 16 blocks for final poses; a served deferred unit skipped
earlier still uses a slot.

## Open items (for a performance round)

- **Workers' share**: p95 3.3–5.3 ms and spikes to 17–44 ms at 100 units. Sleeping, the decision budget and the resting
  prebuild did not move it; the spikes need a profile before any design.
- **First action of group orders**: 42–69 ticks are the group field itself (search found ≈ first action). The field over
  the crowd world's detours costs hundreds of thousands of operations at 8,192 a tick.
- **Head-on bottleneck**: 45% arrival; the two groups jam in the one- and two-wide gates (round 2's known limit, now that
  the west group reaches the gates instead of the water).
- **Living scene**: still slower than before 5b in every phase (see above); the collapse phase got +0.76 ms slower in
  this round and needs attribution (sleep wakes on writes, liquid footprints, wet-cost reads in flat searches).
- **Stress at 1,000 units**: not measured in this round.
- **Water**: the region layer lags water by up to 200 ticks; within that window a false `unreachable` is possible if water
  drains (none seen in the gate runs).

## Verification

At ff22985 plus docs: `npm run typecheck` clean; `npm test` engine 1,172 passed + 2 expected fail, terrain 174, terrain-editor
200, sandbox 135; e2e (`E2E_PORT=5197 E2E_CHANNEL=msedge`, one worker) 46 passed, 16 skipped, 0 failed.

## User checkpoint

Visual test on 2026-10-13 (`?scene=crowd&units=100`, `?scene=crowd`, `?scene=living`): the user tested and asked to
close the round.
