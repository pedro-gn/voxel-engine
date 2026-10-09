# Elovox — Sub-project 4, 4a round 2: Living-world performance — Design

Status: approved by the expert (sub-project 4 decider) on 2026-10-08.
- §3 (#5) was approved as written.
- §4 (#2) was approved. Its back-to-back publish rule (§4.1) was added at the expert's review.

Builds on the closed 4a: [spec](2026-10-08-living-world-performance-design.md),
[plan](../plans/2026-10-08-living-world-performance.md) and
[report](../reviews/2026-10-08-living-world-performance.md). Those stay unchanged.

## 1. Context and evidence

4a delivered the `?scene=living` benchmark and two optimizations: #1, cheaper layered water apply, and #3, chunks drawn in
region batches. It left all three targets open. Round 2 finishes them with candidates from 4a's list.

### Method

Everything below was measured in quiet window #2 (2026-10-08, 20:40–21:08), granted by the expert.
- **Machine:** the reference desktop (Ryzen 5 5600, 32 GB, Edge headed, production build, WebGPU, 1920 × 889 viewport),
  with the other workers holding.
- **Free RAM:** 14.0 GB at the start, 17.0 GB at the end.
- **A stray benchmark** from another worker ran in parallel for part of the window. Every run in flight before it was
  stopped was discarded and redone.

**The display now runs at 180 Hz.** 4a measured on a ~75 Hz display, so fps medians now go up to ~180 and are not
comparable with 4a's. CPU frame time is also lower than in 4a's sessions: 4.4–7.9 ms median against 11–13 ms, a machine
state difference. Round 2 compares only round-2 numbers. The targets are unchanged.

### Baseline at `main` 90e5c97

`research/2026-10-08-living-r2-baseline.json`, worse of two runs, `invalid: []`. Times in ms.

| Phase | fps p5 | fps median | CPU frame median | GPU | tick p95 | water apply p95 | Misses |
|---|---:|---:|---:|---:|---:|---:|---|
| idle-default | 90.3 | 179.9 | 4.4 | 1.4 | 5.0 | 5.65 | apply |
| idle-far | 89.8 | 179.7 | 5.8 | 1.8 | 5.4 | 6.0 | apply |
| work-default | 89.9 | 179.9 | 5.2 | 1.3 | 7.2 | 6.4 | apply |
| work-far | 60.1 | 179.5 | 6.3 | 1.8 | 7.7 | 6.9 | apply (fps p5 on the edge) |
| dam | 36.0 | 90.1 | 7.9 | 1.6 | 13.4 | 21.6 | fps, tick, apply |
| collapse | 30.1 | 90.1 | 7.9 | 1.5 | 15.6 | 22.6 | fps, tick, apply |

### What binds each metric

**fps p5: the main-thread water apply.**

The per-frame anatomy (`research/2026-10-08-living-r2-anatomy-baseline.json`, production build) records, for every frame:
- the previous frame's CPU time;
- the water applies that arrived during the frame interval;
- GPU samples.

What it shows:
- GPU time is 1.3–2.1 ms in every sample.
- Dam: 298 long frames (> 16.7 ms), 297 of them with an apply. 74% of the frames with an apply are long, against 0.1% of the
  frames without one.
- Collapse: 100% of the frames with an apply are long, against 0.5% of those without.
- No long frame anywhere has CPU + apply under 12 ms.
- Idle and work have almost no long frames.

**Water apply p95: `SurfaceView.apply` itself.**

Main-thread CPU profiles per phase (`LIVING_PROFILE=1`, unminified production build), dam:
- apply is 29.6% of the main thread;
- `refreshLayered` is 24.7%: `refreshSlot` 10.2%, `refreshColumn` 5.9%, `region`/`shares` 5.3%.

Collapse: apply is 33.4%.

Meeting ≤ 4 ms from 21–23 ms needs a ~5× cut on the main thread.

**Tick p95: the sim's water code.**

Node sim profile of the dam window (`bench/living.node.ts`, profiling only that window):
- `WaterSystem.flush` is 46.7% of the tick.
  - `WaterPublisher.publish` is 38.8%. Of that, `records()` is 30%: `link`/`linkOf` 24%, `under.chain` 6%,
    `segmentsOf` 5.6%.
  - The rest of flush is the mirror loop, 5.9% self.
- The water step (`columns.step`) is 37.4%: `accelerateAll` 12.3%, `transferAll` 7.0%, `limitAll` 6.7%, `settle` 5.1%.

Collapse has the same shares.

**Render is not binding any target.** Shadows are 22–36% of the main thread (three's shadow pass: `renderObject` and
cache keys). But frames without an apply are never long, and the GPU is idle most of the frame.

### Decisions

Expert, 2026-10-08:
- **#4 (near-only shadow casters) and #6 (fewer animated unit models) are out.** No measured target depends on them.
  `chunkBatches.ts` stays with lod.
- **Order: #5, then #2.**
  - #5 (cheaper water publish, then the water step if needed) attacks tick p95.
  - #2 (water apply in a worker) attacks water apply p95 in all phases and fps p5 in dam, collapse and work-far.

## 2. Scope, targets and rules

**Targets.** Unchanged from 4a §2: per benchmark phase, worse of two runs, reference desktop, production build:
- fps p5 ≥ 60;
- sim tick p95 ≤ 10 ms;
- main-thread water apply p95 ≤ 4 ms.

**Re-scope, 2026-10-09 (user, through the expert).** The tick target is now sim tick p95 ≤ 15 ms, which keeps at least
3× headroom inside the sim worker's 50 ms budget at 20 Hz. After #2, the tick runs only in that worker and no longer
costs frames. 10 ms stays a stretch goal for later.

**In scope:** #5 and #2 as below.

**Out of scope:**
- #4 and #6;
- the batching follow-ups (lod);
- new behaviour of any system.

**Rules.** 4a §5, plus the round-2 benchmark protocol:
1. One optimization at a time. Each is its own commit, with before/after numbers in the commit message.
2. Attribution comes from an interleaved, alternating-order A/B in one quiet window (A B B A A B).
3. Gates use the 4a benchmark's worse of two runs, in a quiet window.
4. A change with no measured gain is reverted.
5. No behaviour change. The water state hashes, the units' deterministic replay and every unit and e2e suite stay green.
   `?nobatch` keeps working.
6. Any visible change goes to a user checkpoint through the expert.
7. New data goes to `research/2026-10-08-living-r2-*.json`, committed right after its window.

## 3. #5: cheaper water publish (and, if needed, the water step)

### 3.1 What changes

`WaterPublisher.records()` (`sim/water/publish.ts`) is rewritten for speed. Its output stays bit-identical: the same
`WaterTick.layers` Int32Array, the same `hidden` count, and the same writes to `U.shown`.

The waste in today's loop, by the profile:
- **Four closures per column per tick** (`fx`, `fz`, `link`, `record`): 46,080 columns × 4 per tick in the dam.
  - Fix: hoist them into private methods that read the current column from fields.
- **Flux sums kept in two `Map`s, cleared per tile.**
  - Fix: two Int32Array sums indexed by segment ref, with a per-tile stamp array, so nothing is cleared.
  - Size: `cols.n` + the lower-segment capacity, grown with it.
- **`linkOf` is generic.** For every link it rebuilds the neighbour's segment list (`segmentsOf` into an array), calls
  `floorOf`/`ceilOf`/`depthOf` through ref tests, and finds a rank with `rankOf`, which walks the chain again.
  - Fix: `records` calls a specialized `linkOf` variant. It walks the neighbour's chain in place and counts the matched
    segment's rank on the way.
  - The decision logic stays exactly that of `linkOf`, which stays as the reference for other callers and tests.
- **`U.chain(c, this.chain)` builds an array per column** only to number the ranks from the top.
  - Fix: count the chain once, then walk it with `rank = k − j`.

Done when, in a quiet-window A/B with the living Node bench, dam and collapse tick p95 drop, and the gate's tick p95 is
re-measured.

**If tick p95 still misses 10 ms after 3.1**, the next steps come one at a time, each its own commit and measurement:
1. **The rest of publish:** its own dense loop (8.7% self) and `flush`'s mirror loop (5.9% self). Same pattern: hoist,
   no per-call closures.
2. **The water step's hot loops:** `accelerateAll`, `limitAll`, `transferAll`, `settle`. Pure refactors only: identical
   integer arithmetic in the same order.

Before 2. starts, the expert gets a short note with the new profile. It is a larger refactor of 3c/3d code.

### 3.2 Proof of no behaviour change

**A characterization test, written first and passing on the old code** (`packages/engine/test/waterPublishGolden.test.ts`):
- Setup: a layered world with running water through lower segments, and a dam break. It builds on the existing
  `layerHelpers`/`waterHelpers` worlds.
- It runs N ticks and hashes, per tick:
  - the `WaterTick`: seq, parity, tiles, and the layer records;
  - the published surface and flux of every listed tile;
  - `publisher.hidden`.
- It asserts the final hash equals a constant recorded on the pre-change code.

The test must also fail on purpose when one record field is altered. That shows it pins the records and is not vacuous.

**Existing suites:**
- `waterPublish`, `waterLinks`, `surfaceLayers`, `waterLayersWorld`, `waterWorld`, the water fuzz and `determinism` stay
  green, as does the units' replay in `workers.test.ts`.
- For any water-step change in 3.1's follow-ups, a second golden test hashes the column state (depth, flux, the
  lower-segment arrays) per tick over the same worlds.

### 3.3 Measurement

**Node A/B** (commit messages):
- `bench/living.node.ts` at the parent commit and at the change, alternating A B B A in one quiet window.
- The parent commit runs from a detached temporary worktree.
- Numbers: tick p50/p95 for dam and collapse, and the time spent in `publish`.

**Browser gate:** the living benchmark, worse of two runs, in a quiet window after #5 is complete. File:
`research/2026-10-08-living-r2-after-5.json`.

## 4. #2: water apply in a dedicated worker

Decision (expert, Q1): option A.
- `SurfaceView` runs unchanged in a new worker that the engine spawns.
- The main thread only copies the changed rows and curtains into the arrays three uploads.

Rejected:
- time-slicing the apply on the main thread: same total cost, and borderline metric-gaming;
- more algorithmic cuts in the layered path: no 5× in it.

### 4.1 Threads and data flow

**`render/water/water.worker.ts`** is spawned by `createEngine` like the mesh workers (`new URL(…, import.meta.url)`),
so the sandbox does not change. It owns:
- a `SurfaceView` over the shared `WaterBuffers`;
- a `WorldReader` for light: it receives the same `page` messages as the mesh workers.

**Per sim tick with `m.water`:**
1. The main thread forwards `{ tick, water, shown }` to the water worker.
   - `shown` is the water alpha drawn at that moment.
   - From then until the reply, the main thread **freezes** the drawn water alpha at `shown`.
   - It does not apply the tick itself.
2. The worker runs `view.apply(water, shown)`, then any queued relights. It packs every dirty key (`view.takeDirty()`)
   into one transferable message:
   - per key: its rows `[rowLo, rowHi]` of `hPrev`, `hCur` and `info`;
   - its curtains: count, plus the first count × 4 floats of the six arrays.

   The message also carries the worker's apply time and the drawn-surface update (§4.3).
3. The main thread copies each key into its own `ColumnData` and marks the rows, as `WaterSurface.sync` reads them today.
   Then, as `engine.ts` does after an apply today:
   - `waterTick` becomes the tick;
   - `waterShown` becomes 0;
   - `clock.hold(water, tick + 1)`.

   The time this takes is the new `waterApplyMs`, the metric the target gates.

**A deferred apply** (the stamp check failed) answers "not applied". The main thread keeps the old hold, as today.

**Back-to-back publishes: one request in flight, the rest queued in order** (expert, §4 review). When tick N + 1 carries
water while N is still in the worker, the main thread does not forward it. A slow frame or GC can bunch ticks; a dam
apply takes ~20 ms against a 50 ms tick.
- **Queueing.** The main thread appends N + 1's `{ tick, water }` to a FIFO.
- **Forwarding.** Right after N's copy, the main thread forwards the head of the FIFO. Its `shown` is computed then: the
  alpha on screen after N's copy, which is 0. Only one request is ever in flight, so publishes apply in tick order and each
  `shown` matches the screen.
- **Relights.** A tick's relight goes with its publish: it is queued behind it, never ahead.
- **No coalescing.** Consecutive publishes are deltas: each lists the tiles changed since the last, plus that one's tiles.
  `SurfaceView` must see them all, in order.
  - A queued publish whose parity buffer the sim has reused meanwhile (N + 2 written over N's parity) fails the stamp
    check in the worker.
  - It is then deferred and read from the next publish's buffer, exactly as today's recovery does on the main thread.
  - So a long queue degrades into today's tested recovery path, not into wrong data.
- **Lag with a queue.** `waterLagMs` runs from the tick message's arrival to the first frame that draws its step, so it
  includes the time spent queued. A growing queue shows up in the stat's p95.
- **Queue length.** A new stat `waterQueue` (current length, and the max over the last 200 ticks) is appended in the water
  path, so the benchmark can see bunching.
- **Test.** A Node test of the main-side scheduler (`WaterLink`, pure, with a fake worker port):
  - two publishes arrive before the first reply;
  - only the first is forwarded;
  - the second is forwarded after the first's copy, with `shown = 0`, in order;
  - the hold and `waterTick` follow each copy.

  The ColumnData differential test (§4.4) also runs the scenario with publishes queued two and three deep.

**Relight.** `relightWater(dirtyChunks)` becomes a message with the chunk-column ranges, handled in order after the tick's
apply. The worker is single-threaded, so the order is today's.

**The main thread's view of the water.** It becomes a small `SurfaceMirror`:
- the ColumnData mirror, `takeDirty()`, `ccCount`/`cx`;
- the drawn-surface lookup (§4.3).

`WaterSurface` is typed against an interface that both `SurfaceView` and `SurfaceMirror` implement, so it stays unchanged.

**Why a freeze, not a carry at the copy.** The carry (`hPrev ← mix(hPrev, hCur, shown)`) is interleaved through
`refreshColumn`, `refreshSlot`, `settleRest` and `buildCurtains`. Moving it to the copy would re-implement apply's alpha
mode. Freezing the alpha keeps the worker's `shown` equal to what is on screen when the result lands.

Today the whole frame stalls for the apply's duration, water included. With the worker, only the water holds, and
everything else keeps drawing.

### 4.2 Lag

**Expected.** Today a publish is applied when its tick message is handled, and drawn on the next frame after that
apply's stall. With the worker:
- one message hop each way, each picked up between frames;
- the apply runs in parallel instead of stalling.

The surface should start a new step at most about one frame later than today: 0–1 frame at 180 Hz. The SimClock is held
at the water's last step until the copy, as today, so falling cubes and fragments stay in step with the water.

**Measured.** A new stat, `EngineStats.waterLagMs` (CostMeter p50/p95), appended in the water path. It is the time from
the tick message's arrival to the first frame that draws its step. It is reported in ms and in frames at 180 Hz and
60 Hz.

**Shown to the expert** for a possible user checkpoint: A and B in one quiet window, plus a before/after clip
(Playwright video) of the dam breach at the dam camera.

### 4.3 Main-thread queries stay synchronous

`editRipples` (`Visuals.noteEdit`, at submit) reads `view.surfaceNear` on the frame of the edit, and must keep doing so.

**Shared drawn-surface buffer.** The worker keeps a SharedArrayBuffer `Int32Array(n × RANKS)`. Per column and rank it
holds the encoded surface the view would answer with (`cur` / `layers.cur`) when `shows(v, floor)`, else a sentinel.
- The worker rewrites the entries of every column of the tiles an apply read, and of the tiles it read again at the next
  apply.
- `SurfaceMirror.surfaceNear` / `surfaceAt` implement today's logic over that buffer.
- An aligned Int32 element is never torn. A query racing an apply may see some columns at the new step and some at the
  old, which is harmless for a ripple's start height.

**Memory:** 4 MB at 512², 16 MB at the default 1024² world.

**Proof:** a Node differential test checks that `SurfaceMirror.surfaceNear(x, z, y)` = `SurfaceView.surfaceNear(x, z, y)`
over every column and several heights, after each apply of a layered running-water scenario.

**Other main-thread consumers, all accounted for:**
- `engine.ts`: apply, `relightWater` (tick and `regenerated`), `clock.hold` / `stepAlpha` / `waterShown`;
- `Visuals.noteEdit` → `editRipples`;
- `WaterSurface`.

The sandbox reads nothing of `SurfaceView`, and collision reads the voxel mirror.

### 4.4 Bit-identical output

A Node differential test (`packages/engine/test/surfaceMirror.test.ts`) runs one scenario through two paths:
- **reference:** `SurfaceView` applied in-thread;
- **worker path:** `SurfaceView` → pack → `SurfaceMirror.copy`.

The scenario has layered running water, curtains and relights, with alpha mode on (`shown` given). After every apply,
each key's `hPrev`, `hCur` and `info` (all 4096 floats) and its curtains (count and the six arrays up to count × 4) must
be equal in the mirror and the reference.

### 4.5 Failure handling

A worker error or `messageerror` gets **one** respawn:
- The main thread drops the in-flight request and unfreezes the alpha.
- It sends the sim a new `waterResync` message (`protocol.ts`, sim side perf-owned). The sim's next publish then lists
  every tile, with layer records, like the first publish after generation.
- The new worker builds a fresh `SurfaceView` from it. The shared surface buffers alone hold no layer records, so a resync
  is needed.

A second crash is fatal (`fail(...)`), as with the mesh pool's crash limit. `dispose()` terminates the worker.

### 4.6 Thread budget

The water worker is added on top of the mesh pool (`min(6, hardwareConcurrency − 2)`) rather than taken from it. It
replaces main-thread work, so total CPU stays the same.

**Checked in the A/B:** the mesh backlog (`meshQueue + meshInFlight`, mean and p95 over the dam and collapse windows) does
not grow. If it does, the pool gives up one worker and the A/B is repeated.

### 4.7 Measurement

**Gate:** the living benchmark, worse of two runs, in a quiet window. File:
`research/2026-10-08-living-r2-after-2.json`.

**Attribution:** an A/B of the parent against the change, alternating, in one window. Per phase it records:
- CPU frame;
- fps p5;
- main-thread apply p95;
- worker apply p95;
- `waterLagMs` p50/p95;
- mesh backlog.

**Tools.** The scratch frame-anatomy spec is promoted to `e2e/living-anatomy.spec.ts` (`ANATOMY=1`), with its summary
script in `bench/`, so the "long frames carry an apply" check can be repeated after #2.

## 5. Deliverables

- This spec.
- `docs/superpowers/plans/2026-10-08-living-world-performance-round-2.md`.
- Research JSONs `research/2026-10-08-living-r2-*.json`.
- The final report `reviews/2026-10-08-living-world-performance-round-2.md`.
- All on branch `feat/living-perf-2`. Never pushed, never merged by this worker.
