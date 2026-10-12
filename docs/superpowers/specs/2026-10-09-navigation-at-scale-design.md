# Elovox — Sub-project 5b: Navigation at scale — Design

Status: approved in brainstorming on 2026-10-09 (sections 1–4 approved in chat). Builds on the navigation & workers
work of 2026-10-07 ([spec](2026-10-07-navigation-and-workers-design.md),
[validation](../reviews/2026-10-07-workers-validation.md), [fixes](../reviews/2026-10-07-workers-fixes.md),
[ADR 0002](../../adr/0002-sparse-worker-navigation.md)), which delivered units, flat resumable A*, next-tick
reservations and the work frontier, and listed four leftovers: a global HPA*, WHCA*, the task frontier, and the
units' visual sync.

## 1. Context

What the code does today (mapped on 2026-10-09):

- **Search is flat A\*** over a lazy edge cache in 16³ tiles (`sim/navigation/navigation.ts`). There is no
  abstraction: ADR 0002's "exact straight region-boundary shortcuts" and the test title "long portal shortcuts" do
  not match the code. The only shortcut is at execution: a walking unit string-pulls up to 32 path nodes
  (`WALK_LOOKAHEAD`). Long routes hit `maxNodes = 16384` (`limited`), and a truly unreachable goal costs a full
  16,384-node search.
- **Reservations cover one tick.** `occupied` holds each unit's body plus the next tick's swept cells; there is no
  time axis. Traffic is broken by waiting, id-biased yielding (the higher id wins), sidesteps and finally a `traffic`
  block.
- **The work frontier is first come, first served.** 256 slots, filled by orders in priority order; only tasks that
  already failed can be parked, so one order with ≥ 256 unattempted cells (the living scene's 360-cell quarry) starves
  the others. The park choice ignores priority, and priority never ages. Assignment claims all up to 12 candidate work
  poses while a search runs, so neighbouring tasks fail with `traffic`. Only build orders have a stall timeout.
- **The view interpolates from receipt time.** `workersView.ts` lerps the previous tick's pose to the newest one over
  the 50 ms after the message arrives: the picture is about one tick behind, message jitter becomes speed jitter,
  intermediate ticks are skipped when two arrive between frames, and the camera is placed before the units. A mesh
  barrier holds units within ±2 voxels of an edited chunk until its mesh shows, but neighbour chunks are not covered
  and a failed mesh holds them for 1 s.

Measured on 2026-10-07 (256² flat floor, Node): 1,000 units, mass move, only 610 started moving in 240 ticks (12 s).

| Topic | Decision |
|---|---|
| Goal | **1,000 units on a 1024 × 128 × 1024 world**, moving, working and crossing bottlenecks, inside the tick budget |
| Scope | All four leftovers in one sub-project: hierarchy, cooperative reservations, task frontier, visual sync |
| Hierarchy | **Portal graph over the existing 16³ tiles, built on demand** and refined segment by segment. Rejected: flat A* with landmark heuristics (every edit recomputes world-wide distance fields; unreachable stays expensive); flow fields (only for shared goals) |
| Cooperation | **Space-time reservation table with a 32-tick window and on-demand repair** only where projections collide. Rejected: full WHCA* for every unit (over budget at 1,000 units, needs fixed per-node steps); continuous local avoidance (no corridor guarantee, hard to keep deterministic) |
| Authority | Unchanged: the sim worker is the single writer; everything new is deterministic, budgeted in operations and hashed when it decides future behaviour |

## 2. Scope

### In scope

1. Hierarchical routes (§3).
2. Cooperative space-time reservations (§4).
3. Task frontier fairness, aging, work-pose claims, claim leases and assignment at scale (§5).
4. Smooth pose playback and precise mesh barriers in the view (§6).
5. A scale benchmark, a path-quality bench, traffic scenarios and a `?scene=crowd` sandbox scene (§7).
6. Correcting ADR 0002 and recording the new design in ADR 0003; glossary terms in `CONTEXT.md`.

### Out of scope

- Automatic scaffolding, new locomotion profiles (swimming, jumping, larger bodies), engineering beyond today's
  planar planner.
- Rendering 1,000 animated models: the view keeps up to 24 skinned units and instanced proxies beyond that.
- Off-thread navigation: everything stays in the sim worker.
- Hauling, stockpiles and any economy beyond today's unit inventory.

## 3. Hierarchical routes

### Abstract graph

- **Region** = the existing 16³ navigation tile.
- **Portal**: a maximal run of crossings between two neighbouring regions with the same source height, target height
  and transition class (flat, climb, drop 1, drop 2), split every 8 positions. Each run becomes one abstract node.
  Two crossings in one run are joined by flat edges on both sides, so one representative per run keeps connectivity.
- Portals are **directed**: a drop is one-way, and a climb needs headroom at its source. Regions stacked in y have
  portals for climbs and drops that cross their horizontal faces.
- **Intra-region links**: for a portal entering a region, a Dijkstra confined to that region gives the cost to every
  exit portal. Links are computed the first time a route reaches the portal, cached, and charged to the operation
  budget like any expansion.
- **Invalidation**: the regions that `invalidateBox` already bumps (the edit plus its halo) drop their abstract record
  and the portals on their faces. Nothing else is rebuilt.
- **Geometry only**: the abstract graph never reads water, hazards, build reservations or units. Those stay live
  checks in refinement and execution, as today.
- **Cache**: abstract records live in their own store, not in the FIFO edge cache of 512 tiles. It has a memory cap
  (32 MiB proposed, tuned by the benchmark) and a deterministic eviction order.

### Queries

- **Short routes** (estimate ≤ 48 blocks) and routes inside one region stay on the current flat A*, which is exact.
- **Long routes**: the start, and every goal, connect to the portals of their own region by a confined search. An
  abstract A* over portals finds the portal sequence, with the existing consistent heuristic. Multi-goal queries
  (work poses) insert every goal.
- **Refinement**: the unit receives its route in segments. Each segment, from one portal to the next, is refined by a
  flat A* confined to one region, under the live policy (`allowed`, `blocked`). The unit keeps **2 refined segments
  ahead**, so its first action does not wait for an 800-block route to be refined.
- **Refinement failure**: when a segment fails because of policy or hazard, the unit replans without that portal (a
  per-query exclusion set). When it fails because the region changed, it replans from its current pose.
- **Searches that stay flat**: escaping a build designation (per-search `allowed` override), `accept`-only searches
  (nearest safe pose), traffic detours with a `blocked` set, and the engineering planner.

### Guarantees

- **Unreachable is a proof**: every region an abstract search touches is built exactly, so an exhausted abstract
  search proves there is no route in the geometry, and policy can only remove routes. A cut by budget, node limit or
  the memory cap stays `limited`, never `unreachable`.
- **Stale detection**: abstract searches record the revision of every region they read, like `seen` today, and end
  `stale` on a mismatch.
- **Determinism**: abstract records are a function of the terrain and the command history, so a replay rebuilds the
  same cache and the same operation counts. Abstract searches in flight are mixed into `Simulation.hash()` like flat
  searches. The cache itself is not hashed.
- **Quality**: hierarchical routes can be longer than optimal. Target: mean ≤ 1.10× and p95 ≤ 1.25× of the exact
  cost over 500 sampled pairs (§7). Execution-time string-pulling still smooths the walked line.

## 4. Cooperative reservations

### The table

- A **reservation table** keyed by (cell, tick) and holding an owner, over a **rolling window of 32 ticks** (1.6 s).
- A **walking unit** projects its motion along its refined route with the same motion model the executor uses
  (speed, flat string-pulling, vertical actions reserved whole) and reserves the cells its body sweeps in each future
  tick. Each tick it appends one tick at the far end: about 1,000 × 8 cells per tick at full load.
- A **stationary unit** (working, idle, waiting) reserves its pose with no end. The window's end never frees a body.
- Swaps are impossible: two units crossing each other sweep the same cells in overlapping ticks.
- `occupied` (body plus next-tick sweep) stays the source of truth for collision. The table plans; occupancy checks.

### Conflicts and repair

- When a projection meets another owner's reservation, the unit with the **lower priority** repairs: a space-time
  search (wait, sidestep, back off) inside a ±8 box, over the navigation edges with their real step durations, whose
  goal is to rejoin its own route further on.
- Repairs share the operation budget, with at most 8 per tick (a tunable, set by the traffic scenarios). Open terrain produces no conflicts, so most units
  never pay.
- **Priority** = the order's priority plus an aging term for ticks spent without progress. Ties rotate with the tick
  instead of always favouring the higher id.
- **Corridors**: in a one-wide corridor the lower-priority unit backs off to a free pocket inside the window. An idle
  unit standing on a projected route is asked to step aside.
- **Escalation**: a failed repair waits and retries. Today's tie-breakers (yield at wait 12 and 80, sidestep,
  retarget) remain as the last resort, then a `traffic` block, never endless alternation.

### Determinism

- The table and the priorities are simulation state: mixed into the hash in a canonical order, bounded per tick.

## 5. Task frontier

- **Fair shares**: the 256 frontier slots are split among active orders in proportion to their effective priority,
  with at least 8 slots per order. A new high-priority order enters on the next tick.
- **Parking**: a task may leave the frontier when its order is over its share (even if never attempted), when no
  eligible crew member has been available for 100 ticks (5 s), or when it is blocked. The task parked first is the one with
  the lowest effective priority, then the oldest. Parked tasks keep their failure history, as today.
- **Aging**: effective priority = order priority + 1 per 5 s while the order has pending work and makes no progress,
  capped at +64, reset on progress. It drives expansion, parking and assignment.
- **Work poses**: candidates are filtered against occupancy and the reservation table. A unit claims **only its final
  work pose, when its route is found**. If another unit took it first, the search accepts the next free candidate.
- **Claim lease**: a task whose unit neither moves nor works for about 200 ticks (10 s) is released and records the
  failure, for every order kind (today only build orders stall out).
- **Assignment at scale**: frontier tasks are indexed by chunk column, so an idle unit looks at nearby tasks instead of
  sorting all 256. The number of units assigned per tick grows with the idle count, inside the operation budget.
- All new fields (shares, aging, leases) are mixed into the hash and published in the orders list where the view
  shows them.

## 6. View sync

- **Playback on sim time**: every publication carries its tick number. The view keeps the last 4 poses per unit and
  draws at sim time (tick × 50 ms) minus a fixed delay of about one tick plus a jitter margin, with a smoothed clock
  offset. It interpolates between the two ticks around that instant, so speed does not follow message jitter, no tick
  is skipped, and a late sim holds units still instead of making them jump.
- **Order in the frame**: a new engine event fires before the camera update, so the view places units before a camera
  that follows one of them.
- **Precise barriers**: each dig or build publishes the edited chunk plus the neighbour chunks whose mesh also changes
  (edits on a chunk border). The view holds only the unit that made the edit and units whose next poses cross the
  edited voxels.
- **Failure**: a barrier on a chunk whose mesh failed releases at once; the hold cap drops from 1 s to 250 ms.

## 7. Benchmark, scenarios and success criteria

### Scale benchmark (`packages/engine/bench`, Node, no GPU)

- **World**: 1024 × 128 × 1024 generated with hills, a river and caves; 1,000 units in clusters.
- **Scenarios**:
  1. Mass move orders to scattered destinations 200–800 blocks away.
  2. Bottlenecks: the traffic scenarios below, at scale.
  3. Work: 20 concurrent orders, including orders larger than the frontier.
  4. Churn: terrain edits near active routes every second.
- **Metrics**: whole tick and the workers' share (p50, p95, p99, max); time to first action; share of units arrived
  and time until all arrive; repairs and `traffic` blocks; abstract cache bytes; operations per tick.
- **Rules**: the quiet-machine rules of sub-project 4 apply (no games or heavy apps, ≥ 8 GB free, worse of two runs,
  interleaved A/B for attribution).

### Path-quality bench

500 sampled start/goal pairs on the benchmark world, hierarchical cost against an exact flat A* with no node limit;
reachability must agree on every pair.

### Traffic scenarios (unit tests, small worlds)

One-wide corridor with pockets, opposite directions; two-wide corridor with two groups of 50 crossing; an X crossing;
a narrow gate; units working inside a passage. Every unit arrives within the scenario's bound, and an invariant check
proves no two bodies overlap in any tick.

### Sandbox

`?scene=crowd`: the benchmark world with 1,000 units in proxies, HUD buttons for the move, bottleneck and work
scenarios, for the user's visual checkpoint.

### Success criteria (worse of two runs)

| Metric | Target |
|---|---|
| Workers' share of the tick, 1,000 units walking | p95 ≤ 4 ms, max ≤ 12 ms; whole tick p95 ≤ 15 ms |
| Time to first action | p95 ≤ 1 s with 1,000 simultaneous orders; ≤ 250 ms with 100 — on a warm world, with regions already built (amended 2026-10-12, see below); cold first action is recorded, not gated |
| Arrival | ≥ 99% of reachable destinations within each unit's ideal walk time + 60 s of sim time; zero false `unreachable` (corrected 2026-10-09, see below) |
| Route quality | mean ≤ 1.10×, p95 ≤ 1.25× of the exact cost |
| Bottlenecks | every unit arrives; zero overlaps |
| Regressions | all unit and e2e suites green, replay hashes stable, the living benchmark no worse |

Plus: nothing visible changes without a checkpoint with the user (playback smoothness and the crowd scene).

Correction, 2026-10-09, approved by the user: the arrival target first read "within 60 s of sim time". That was a
spec error: units walk 5 blocks/s, so the 200–800-block moves of the benchmark take 40–160 s of walking alone. A unit's
ideal walk time is the cost in ticks of an exact flat A* under the live policy from its pose to its destination; the
benchmark phases run long enough to cover the longest moves.

Amendment, 2026-10-12, approved by the user (round 2): the quiet-machine measurements showed that on the crowd world a
cold group move must build ~3,400 regions (~11.5 M operations, ~70 s at the original budget) before anyone walks,
because a wide sand belt forces long detours. Regions are therefore built ahead in the background with the spare
budget, and the region store's cap may rise to 64 MiB. The first-action target is gated on a warm world (the bench
warms the regions before ordering); the cold first action is measured and reported.

## 8. Process and deliverables

- Branch `feat/navigation-scale` from `main` d63ffe1. This spec, then a plan in
  `docs/superpowers/plans/2026-10-09-navigation-at-scale.md`.
- Execution as in sub-project 4: one agent per workstream (hierarchy, cooperation, frontier, view), each in its own
  worktree, plus an expert agent that decides for them and escalates only determinant questions to the user. The
  hierarchy lands first; cooperation builds on refined segments.
- ADR 0003 records the hierarchy and the reservation table; ADR 0002 is corrected (no region shortcuts existed).
- `CONTEXT.md` gains **Portal** and **Reservation window**.
- Benchmark JSON in `docs/superpowers/research/`, a final report in `docs/superpowers/reviews/`.
- Merge into `main` only with the user's approval; no push unless asked.
