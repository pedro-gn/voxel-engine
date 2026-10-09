# Living-world performance, round 2 (4a-r2): final report

Date: 2026-10-09. Branch `feat/living-perf-2`, from `main` 90e5c97.

- [Spec](../specs/2026-10-08-living-world-performance-round-2-design.md)
- [Plan, with every result](../plans/2026-10-08-living-world-performance-round-2.md) (Parts 1–3; "Results" sections)
- Data, all in `../research/` (`2026-10-08-living-r2-*`):
  - `baseline.json` and `anatomy-baseline.json`;
  - `node-ab-5.json` and `after-5.json` (provisional, CS2 running);
  - `water-ab.json`, `anatomy-after-2.json` and `after-2.json`;
  - `node-ab-5b.json`, `browser-ab-5b.json` and `after-5b.json`.

Round 2 took the targets 4a left open. fps p5 ≥ 60 and main-thread water apply p95 ≤ 4 ms now hold in every phase of
the living benchmark. Sim tick p95 ≤ 10 ms still misses in the dam and collapse phases. The expert has taken that
target's re-scope to main and the user; see "Still open".

## What was delivered

- **#2, the water host in a dedicated worker** (`ca129f1`, built on `8abaf86`, `553cfb4` and `51e778b`). The engine
  spawns a water worker that runs `SurfaceView` on the sim's publishes:
  - **The main thread.** It only copies the rows that changed into a `SurfaceMirror`, which answers surface queries
    synchronously, bit-identical to an in-thread view.
  - **Publishes in flight.** `WaterLink` keeps one publish in flight and queues the rest in tick order, with no
    coalescing (spec §4.1).
  - **Crashes.** A crash respawns the worker once, and the sim republishes every tile (`waterResync`). A second crash is
    fatal.
  - **The before side.** `?nowaterworker` keeps the in-thread host in the same build.
  - **Stats.** `waterHostMs`, `waterLagMs` and `waterQueue`/`waterQueueMax`, plus `waterInWorker`.
- **#5, a cheaper sim tick.** All items are pure refactors, pinned by two golden hashes: every publish (`6583a16`) and
  the whole simulation state per tick (`21313ea`).
  - `7f9dfc0`: publish's layer records without closures, maps or chain arrays.
  - `42a76b6`: publish's dense loop on locals.
  - `a5953da`: `limitAll` reads the under-edge marks inline.
  - `9fe45d7`: `chunkStore.commit`'s collapse test checks a remembered differing cell before scanning a chunk. A seeded
    property test against the full scan comes first, in `4cf8947`.
- **Tools.**
  - `e2e/water-ab.spec.ts`: in-thread against worker, with lag, host cost, mesh backlog and clips.
  - `e2e/living-anatomy.spec.ts` and `bench/anatomy.node.mjs`: per-frame anatomy.
  - `bench/nodeAb.node.mjs` and `bench/nodeChain.node.mjs`: Node A/B, between two checkouts or along a chain of
    commits.
  - `E2E_PREVIEW_DIR`: serves another build's dist on the same port, for browser A/Bs.

## Results

**Gate** (worse of two runs, Edge headed, prod build, 179 Hz display; ms except fps):

| Phase | fps p5: baseline → after #2 → final | tick p95: baseline → final | apply p95: baseline → final |
|---|---|---|---|
| idle-default | 90.3 → 89.5 → 89.9 | 5.0 → 5.5 | 5.65 → 0.35 |
| idle-far | 89.8 → 89.4 → 89.8 | 5.4 → 5.2 | 6.0 → 0.33 |
| work-default | 89.9 → 89.4 → 89.9 | 7.2 → 7.8 | 6.4 → 0.38 |
| work-far | 60.1 → 89.5 → 89.7 | 7.7 → 7.9 | 6.9 → 0.37 |
| dam | 36.0 → 60.2 → 60.1 | 13.4 → **11.8** | 21.6 → 0.76 |
| collapse | 30.1 → 88.6 → 60.0 | 15.6 → **13.9** | 22.6 → 0.88 |

**Attribution.** Each A/B ran interleaved, in alternating order, in one quiet session.
- **#2** (water A/B, ABBA + BABA):
  - B beats A in every adjacent dam and collapse pair. Apply p95 goes from 22–30 ms to 0.6–1.2 ms, and fps p5 from
    26–36 to 60–90.
  - The host costs about the same in the worker.
  - The mesh backlog does not grow.
  - Long frames (> 16.7 ms) in the dam fall from 298 to 17. None of the remaining ones carry an apply.
- **#5** (Node):
  - Step 1: dam and collapse tick p95 −27–30% (ABBA).
  - Steps 2–3: dam p95 −14% and p50 −20% from base to all five items, most of it from the collapse witness. 2b and 3b
    showed no gain and were reverted (spec rule 4).
- **Browser tick A/B** for steps 2–3 (base against HEAD, ABBA, one 20 s window per page): **inconclusive**. The first
  page of the session is an outlier, and the second pair goes the other way. It is a method limit, not a finding that
  Node gains shrink in the browser.

## Process notes

- **Benchmark protocol.** Windows granted by the expert, RAM and heavy-app stamps around every step, gates as the worse
  of two runs, and attribution only from interleaved A/Bs.
  - A window with CS2 running made the first #5 gate provisional. It was re-run in a quiet window.
  - A run that exceeded the tool's 10-minute foreground limit was split into halves, with expert approval. Pairs across
    the split are never used alone.
- **Headless smoke.** It suggested that #2 doubled the host cost and added a quarter-second of lag. The headed quiet
  A/B showed that this was SwiftShader starving the CPU.
- **Goldens.** Both golden hashes were recorded before any refactor and checked against mutations:
  - a partial-cell off-by-one in the mirror;
  - the lower-segment mirror forced off;
  - the under-sender path disabled;
  - a throw in the dry-edge exit, to prove the path is reached.

  They stayed unchanged through every kept item and both reverts.

## Still open

- **Tick p95 misses 10 ms in dam (11.8) and collapse (13.9).** It is pending the expert's re-scope question to main and
  the user. The options, none of them started:
  - (i) a tile-major water layout: a large 3c/3d refactor with an unproven gain;
  - (ii) stepping fewer tiles per tick: a behaviour change, visible;
  - (iii) re-scoping the target. Since #2 the tick runs only in the sim worker at 20 Hz (50 ms budget), and fps and
    apply pass.

  The profile shows that the remaining cost scales with the number of awake tiles and is mostly memory traffic. Pure
  refactors are spent.
- **Water lag under CPU load** (informational, no checkpoint by expert ruling):
  - Quiet machine: the worker adds +6–15 ms of lag at p95, under one 60 Hz frame, and the queue stays at most 2.
  - With video recording loading the CPU: the queue reaches 3 and lag p95 72 ms (dam) / 120 ms (collapse), 4–7 frames
    at 60 Hz. The in-thread host never queues.
  - Clips: the water-ab runs 1 (A) and 2 (B), recorded 2026-10-09 (worker scratchpad, path given to the expert).
- **Edge frame pacing on 2026-10-09.** In both builds alike, frames alternated one and two vsyncs about 50/50, even when
  idle. That is ~120 fps, against ~170 at the 2026-10-08 baseline.
  - fps p5 against 60 keeps its meaning: no frame longer than three vsyncs.
  - fps medians from that day are not comparable with the baseline.
  - In the last gate's first run, idle phases were back at one vsync (fps p5 ~178).
- **Browser tick attribution.** The open question is the gap between Node and browser gains. It needs several pages
  per build in one session.
- **Load-sensitive tests** (pre-existing): the terrain-editor `densityBrush` property test, and one `surfaceView` test
  under full parallel load.
