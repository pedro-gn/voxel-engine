# Sub-project 6: Persistence — review

Branch `feat/persistence`, from main 39d14b6. Spec: [persistence design](../specs/2026-10-13-persistence-design.md).
Plan: [persistence plan](../plans/2026-10-13-persistence.md). Executed inline, task by task under TDD, followed by one
fresh whole-branch review (opus) and one fix pass. Closed by the user on 2026-10-13 without the visual checkpoints (listed under open items); the
benchmark ran after the merge.

## What shipped

- **Engine.**
  - `engine.save(slot, { app, meta })`, `engine.saves` (list, delete, estimate), `createEngine({ restore })`,
    `openSave()`, and the `persistWorker` option with `@elovox/engine/persist-worker`.
  - Saves are packages: a JSON manifest plus gzip blobs named by SHA-256, behind `SaveStore`. The implementations are
    `OpfsStore` (A/B manifests, in a worker, under a cross-tab lock) and `MemoryStore`.
  - Voxels are stored in 256² save regions. Only regions written since this engine's last save of the slot are copied.
  - Each section and the region format carry a version. The block table must be a prefix of the engine's.
- **Sim.**
  - `Simulation.snapshot(since)` and `restore()` cover the voxels, the scheduler and neighbour queue, water, falling
    blocks, structural fragments, and units with their orders, frontier tasks and piles.
  - On restore, light is recomputed. Water segments are rebuilt from the voxels and then given back their exact water.
    Navigation starts empty and units plan again.
- **Sandbox.**
  - `?save=name` boots from a save. The save's scene, size, seed and terrain document win over the URL.
  - The app section holds the camera (orbit or first person) and the living and crowd script state.
  - The P panel offers save as, load, delete, autosave on/off and storage use.
  - Autosave runs every 5 minutes, alternating `autosave-1` and `autosave-2`.
  - Load errors (missing, corrupted, incompatible, unknown block) are shown with a link back to the scene.
- **Docs.** CONTEXT gains save, save slot and save region; ADR 0004 records the format decision.

## Verification

- Typecheck is clean.
- Quiet run: engine 1134 + 2 xfail, terrain 174, terrain-editor 200, sandbox 134.
- After the fix pass the engine has 1136 tests and the sandbox 135. These runs were made while a game ran on the
  machine. Each one hit 1–2 five-second timeouts in files the pass did not touch; all of them pass when run alone.
- e2e:
  - `save.spec` 7/7: living save, load and continue; incremental save after a load; workers crew kept; autosave
    rotation; corrupted save refused; unknown block refused.
  - Regression: living, smoke, workers, flood, first-person, collapse, caves, water-render and crowd all pass.
- Unit coverage:
  - Two loads run identically for 400 ticks, for saves taken at ticks 5, 11, 14, 40 and 200.
  - save → load → save gives identical sections.
  - Water conservation holds after a load.
  - Units resume and every order completes.

## Measurements (informal, machine not quiet)

| Scene | Save | Sim stall | Compressed |
|---|---|---|---|
| Living 512² | each save (all 4 regions change within ~250 ms) | 19–25 ms | ~310 KB |
| Terrain 256², `?still` | first save | 6.7 ms | 84 KB |
| Terrain 256², `?still` | second save | 1–2 ms (0 regions, 0 blobs) | — |

`BENCH_SAVE=1`, run twice on 2026-10-13 after the merge, on the user's laptop with other programs running (the user
judged that acceptable). The table gives the worse of the two runs:

| Metric | Target | Measured | |
|---|---|---|---|
| Living 512², sim stall per save (10 saves, 10 s apart, crews working) | ≤ 50 ms | p50 18.0, p95 20.6, first 24.6 ms | ✓ |
| Living 512², save wall time p95 (snapshot + gzip + hash + OPFS) | — | 326 ms | |
| Living 512², compressed size | recorded | 270–285 KB | |
| 1024² (crowd world), full save sim stall | ≤ 250 ms | 88 ms | ✓ |
| 1024², save wall time | — | 1.28 s | |
| 1024², compressed size | recorded | 962 KB | |
| 1024², sim restore to `ready` vs generating the same world | ≤ generation | 1,645 vs 2,209 ms (run 2: 1,460 vs 1,971) | ✓ |
| 1024², page reload to `ready` (fetch, verify, gunzip, restore, first mesh) | — | 3.4–6.5 s | |

Every living save copied all 4 regions (see Open items). The 1024² world is mostly flat pads, so it compresses to under
1 MB; a heavily built island would be larger.

## Deviations from the spec

- **From the plan:** see the plan's eight planning deviations. In short:
  - incremental baselines are kept in the engine, not the manifest;
  - block tables must be prefixes;
  - pending commands are not saved;
  - water is rebuilt, then its exact volumes are put back;
  - an in-progress collapse search is re-seeded;
  - worker claims are dropped.
- **Made during execution:**
  - Frontier tasks are saved rather than re-parked. Re-parked build cells never exposed, so the layer stalled.
  - A unit in mid flat motion stays where it stands; a unit mid vertical step goes back to where the step began.
  - Restored fragments are re-announced at their current offset.
  - Collapse seeds are reset to the saved ones.
  - A restored engine reports its saved tick from the start.
  - Saves fold only per slot.
  - A `stale` incremental save is retried in full.

## Open items

- Not done:
  - The user checkpoints:
    - living mid-flood;
    - mid-collapse;
    - first person;
    - the autosave alternating between its two slots;
    - the incompatible-save message.
- Deferred minors from the final review:
  - `terrain.patch()` is not folded into the saved document.
  - A unit overlapping another at restore fails the load instead of moving the unit.
  - `readSave` does not check that every region is listed.
  - A crashed persist worker makes later requests wait 120 s.
  - Light-only writes bump region revisions, so busy worlds copy more than they need to.
  - The flood and collapse one-shot buttons come back enabled after a load.
  - Water dropped at restore is only logged.
- Incremental saving barely helps busy worlds. Random ticks touch every region; the light-only bump above is part of
  the cause.
- Multiplayer (server store, visiting islands) is out of scope. The format was chosen for it (ADR 0004).
