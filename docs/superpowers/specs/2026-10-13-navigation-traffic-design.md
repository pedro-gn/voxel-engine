# Elovox — Sub-project 5, round 3: Navigation traffic — Design

Status: approved in brainstorming on 2026-10-13 (sections 1–6 approved in chat). Follows the navigation-at-scale work
([spec](2026-10-09-navigation-at-scale-design.md), [report](../reviews/2026-10-09-navigation-at-scale.md),
[ADR 0003](../../adr/0003-hierarchical-routes-and-reservations.md)), which delivered the region hierarchy, space-time
reservations, the task frontier and view sync, and missed every scale gate at 1,000 units.

## 1. Context

The engine is for colony games: **each unit does its own task**. Large group orders are rare. A typical game has
**up to ~100 units**; **1,000 is a stress case**. Round 3 is re-scoped from the report's "group movement layer" to
what this use needs: a correct and cheap typical case, and a stress case that keeps real time.

Baseline measured on 2026-10-13 (`main` 9163239, quiet machine, Node v24.5.0, `crowd.node.ts --units=100`, worse of
two runs, 6,600 ticks per phase after the warm-up):

| Phase | tick p50 / p95 / max ms | workers p95 / max ms | first action p95 (ticks) | arrived |
|---|---|---|---|---|
| mass | 9.5 / 14.7 / 43.5 | 5.9 / 25.4 | 44 | 50% |
| scatter | 7.7 / 12.0 / 34.5 | 4.6 / 21.5 | 17 | 100% |
| bottleneck | 8.7 / 11.8 / 31.3 | 4.8 / 21.0 | 64 | 50% |
| work | 7.5 / 10.5 / 35.9 | 3.7 / 19.2 | — | 541 / 1,472 tasks |
| churn | 7.0 / 9.9 / 30.3 | 3.7 / 18.5 | 55 | 99% |

- **Half of a group order never arrives.** Mass and bottleneck stop at exactly 50% in both runs, and still 50% after
  20,000 ticks (about 4× the longest ideal walk), with `unsafe`, `search-limited` and `traffic` blocks repeating. With
  100 units this is not congestion: it is a bug. Units with their own destinations (scatter, churn) arrive.
- **Workers spike to 18–25 ms** even at 100 units.
- **The crowd world alone costs about 5–7 ms per tick** (water, random ticks), which leaves 8–10 ms of the 15 ms
  budget for 1,000 units.
- **Living A/B** (`main` vs `d63ffe1`, before 5b, AB BA AB, median p50 ms): idle 4.0 vs 3.6, work 5.5 vs 4.2, dam
  8.7 vs 7.0, collapse 8.6 vs 7.9. Noisy (±0.5 ms between runs of one side) but in the report's direction: `main` is
  slower in every phase.

From the 5b report: waiting units drive the CPU (each retries its step, re-projects its reservations and asks for a
repair every tick, ~15 ms of the workers' share at 1,000 units); the region prebuild spends every tick's leftover
budget while units exist; the first action is limited by refinement and the route queue, not by group fields.

## 2. Scope

### In scope

1. **Diagnosis first** (Task 0): the world-only tick cost, the stuck half of group orders, where the first-action
   ticks go. Recorded in `docs/superpowers/research/`.
2. **Fix the stuck half** of group orders, test first.
3. **Sleeping waiters**: a waiting unit costs nothing until something it waits on changes.
4. **Background work that rests**: a queue-driven region prebuild and sliced landmark recomputes, both capped per tick.
5. **A per-tick decision budget** for units, round-robin, so 1,000 units slow down instead of overrunning the tick.
6. **First action ≤ 5 ticks at 100 units.**
7. Traffic code moves out of `workers/workers.ts` (136 KB) into `workers/traffic.ts`, as far as the above needs.

### Out of scope

- Group flow fields and lanes across the width of a way (the report's round-3 option 1).
- Multiplayer and anything game-specific.
- Keeping landmark tables current under edits (5b open item I2), unless it turns out to cause a missed gate.
- Continuous local avoidance or replacing the reservation table.

## 3. Task 0: measure and diagnose

1. **World-only cost**: the crowd world's tick with no units, per phase's terrain (the bottleneck wall, the churn
   edits), p50/p95/max. What remains up to 15 ms is the stress budget for units. If that leaves too little room for
   1,000 units, stop and bring options to the user before going on.
2. **The stuck half**: reproduce it small (a group order of 2–10 units, on the crowd world or a synthetic one) as a
   failing test; follow one stuck unit through its states and block reasons to the loop it is in. The fix lands with
   that test. If the cause is in 5b's design (the group field, the region layer) rather than a local error, stop and
   bring options to the user.
3. **First action**: per unit, ticks spent waiting in the query queue, searching, and refining before the first step.
4. Record the baseline (crowd 100, crowd 1,000, world-only, living A/B) as JSON under `docs/superpowers/research/`.

## 4. Sleeping waiters

Today every waiting unit, every tick: retries its step, re-projects its cells (`holdHere` recomputes the swept cells
and their owners), and enters the repair contest in `cooperate`.

**When a unit sleeps.** When its step is refused for a known reason:
- *behind a leader*: the cells are held or reserved by a unit walking the same way (`follows`);
- *failed repair*: the repair search failed or found nothing (today it waits `repairAfter`);
- *blocked*: in `blocked` state until its `retry`.

**What wakes it**, whichever comes first:
- the unit holding the cells (or its leader) moves;
- one of the cells it wants is released in the table or in `occupied`;
- the world changes in its tile (a write, or a revision bump that touches it);
- a deadline, about 16 ticks, so no wake can be lost for good;
- its order is cancelled, changed or reprioritised.

**While asleep it costs nothing.** It is skipped in the per-unit loop (no step retry), in `holdHere`/projection, and
in the `cooperate` candidate list. It keeps holding its body in the table, so no one plans through it.

**Escalation keeps its thresholds.** Counters that rise once per tick today (`wait`, `stuck`, the claim lease via
`progressAt`, `exposed`) are brought up to date from the elapsed ticks on waking, so the detour at `wait ≥ 12` and
`≥ 80`, `STUCK_LIMIT`, `STUCK_STEP` aging of priority and `LEASE_TICKS` fire at the same tick counts as today. The
wake deadline is never later than the next threshold a sleeping unit would cross.

**Queues ripple.** The leader moves and wakes the second, which moves next tick and wakes the third: one tick of lag
per unit, like a real queue.

**Determinism.** Wake sets are keyed by unit id and cell index; units woken in a tick are processed in id order in
the next per-unit pass. Sleeping is derived state: the replay hash covers the decisions it changes (positions, plans,
counters), and a save does not store it: every unit is awake after a load (persistence is faithful, not
bit-identical; ADR 0004).

**Code.** Sleep, wake, repairs, lanes and the conflict contest move to `workers/traffic.ts` behind a small interface
used by `WorkerSystem` (sleep, wake events in, the units due this tick out). No unrelated refactoring.

## 5. Background work that rests

- **Region prebuild by queue.** Today, with units present, any change makes the prebuild rescan every tile at one
  operation each and spend the whole leftover budget. It becomes a queue: tiles changed since they were built, plus
  the ring around units the first time it is needed. An empty queue costs nothing. The prebuild gets a per-tick cap
  (order of 1,024 operations) instead of the leftover; the value is calibrated against the living A/B.
- **Landmark recompute** runs in capped slices per tick; the 200-tick quiet rule stays.

## 6. Per-tick decision budget

- **Exempt**: units in motion always advance (cheap; cutting motion would stutter playback), and so do falls and
  work progress.
- **Budgeted**: decision work: waking and retrying a step, repairs, refining the next segment, lane changes,
  re-projection after a conflict.
- **Counted in operations**, not milliseconds, to stay deterministic; each kind of work has a fixed cost.
- **Round-robin**: the starting unit rotates every tick; units not served wait for the next tick.
- **Calibrated** so 1,000 units fit 15 ms on the crowd world (with the Task 0 world cost); at 100 units the cap
  should never bind.

## 7. First action at 100 units

Driven by Task 0's breakdown. Expected measures:
- the first segment of a unit standing still is served before prebuild and repairs in the budget order;
- a new unit refines only enough to start walking, and the rest while it walks;
- if not enough: new route queries are served first come, first served, with a minimum slice each.

## 8. Success criteria

Quiet-machine rules of sub-project 4 apply (no games or heavy apps, ≥ 8 GB free, worse of two runs).

### Typical: 100 units, crowd world, all five phases

| Criterion | Target | Baseline |
|---|---|---|
| Arrival, mass / scatter / churn | ≥ 99% within ideal walk + 60 s | 50% / 100% / 99% |
| Arrival, bottleneck | 100% | 50% |
| False `unreachable` | 0, all verdicts checked | 0 |
| First action p95, warm world | ≤ 5 ticks (250 ms) | 17–64 |
| Workers' share of the tick | p95 ≤ 2 ms, max ≤ 8 ms | p95 3.7–5.9, max 18–25 |
| Work phase | no unit looping; tasks done recorded, not gated | 541 / 1,472 |

### Stress: 1,000 units

| Criterion | Target |
|---|---|
| Whole tick | p95 ≤ 15 ms in every phase |
| No unit stuck for good | in a long phase (4× the longest ideal walk), every unit with a reachable destination arrives; the others get a correct `unreachable` verdict |
| First action, arrival times | recorded, not gated |

### Living scene vs `d63ffe1` (before 5b)

Five interleaved A/B pairs; the median p50 delta is ≤ +0.15 ms in each phase (idle, work, dam, collapse).

### Regressions

All unit and e2e suites green; replay hashes stable; the 5b corridor (20 v 20) and gate tests still pass; path
quality (`--quality`) still within mean ≤ 1.10×, p95 ≤ 1.25×.

Plus: nothing visible changes without a checkpoint with the user.

## 9. Testing

- **Unit tests**: the small reproduction of the stuck half; each wake cause (leader moves, cell released, world edit,
  deadline, order change); escalation thresholds fire at the same ticks as before (a sleeping and an always-awake run
  agree); the decision budget holds per tick and serves everyone over a rotation; determinism (two runs hash the
  same; save and load with sleeping units).
- **Benchmarks**: `crowd.node.ts` gets `--profile=typical` (100 units) and `--profile=stress` (1,000 units, long
  phase) with their own `--assert`; a world-only mode; the living A/B script is committed as
  `apps/sandbox/bench/livingAb.node.mjs` (two checkouts, interleaved pairs, median deltas).
- **User checkpoints**: `?scene=crowd` with 100 and with 1,000 units (queues, no overlaps, smooth playback), and
  the living scene.

## 10. Process and deliverables

- Branch `feat/navigation-traffic`; one implementer and one reviewer (the user's preference).
- Spec (this file), plan in `docs/superpowers/plans/`, report in `docs/superpowers/reviews/`, measurements in
  `docs/superpowers/research/`, an amendment to ADR 0003 (sleeping waiters, prebuild queue, decision budget), and
  `CONTEXT.md` terms if new ones appear.
- Merge into `main` is the user's call.
