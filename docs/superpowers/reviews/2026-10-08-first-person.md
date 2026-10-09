# Elovox — Sub-project 4d: First-person camera and character controller — Review

Branch `feat/first-person`. Code HEAD 48039a6, rebased onto `feat/collision` ea69a20 (the final 4c API is f29ad7c; ea69a20
adds only 4c's review). Spec `specs/2026-10-08-first-person-design.md`, plan `plans/2026-10-08-first-person.md`, both
approved by the expert (the sub-project 4 decider) on 2026-10-08. Merge order: collision → first-person.

## Delivered against the spec

| Spec | Delivered | Where |
|---|---|---|
| §3 `FirstPersonController`, shaped like `OrbitCamera` | `update(dt)`, `apply(camera)`, `attach(canvas)`, `look`, injectable `input`, `spawn`, `eye`/`forward`, `cellOverlapsBody`, `enabled`. Tunables in `FP_TUNING` | `packages/engine/src/interact/firstPerson.ts` |
| §3 `CollisionLike` = the subset of `engine.collision` it uses | `Pick<Collision, 'move' \| 'overlaps' \| 'groundDistance' \| 'liquid' \| 'unstick'>`, boxes from 4c's `bodyBox`; no collision code of 4d's own | same |
| §3 `OrbitCamera.enabled` | Handlers ignore events and held keys/edge pan clear while it is false; orbit is unchanged while true (pinned by a handler-level test) | `interact/orbitCamera.ts` |
| §3 engine API | `engine.firstPerson`, `engine.cameraMode`, `engine.setCameraMode()`. The frame loop drives only the active controller. `viewDistance` is 48 in first person; FOV is 50 in orbit and 70 in first person. 4d writes only `camera.fov` | `engine.ts` (camera block, plus one hunk after 4c's `bindCollision` line), `index.ts` (one export line) |
| §3 hand-off | orbit → first person: spawn at the orbit target on `surfaceTop` (highest solid **or liquid**), orbit yaw, pitch 0. First person → orbit: centred on the feet, same yaw, `current.distance` = 8 easing back to the remembered distance | `orbitToFirstPerson`, `firstPersonToOrbit` |
| §4 movement | Equal substeps ≤ 1/120 s; walk 4.3, sprint ×1.3 (forward only); exponential acceleration (ground 14, air 3, swim 6); gravity 30, terminal 50, jump apex 1.25; swimming at submerged ≥ 0.5 (+2.5 / −1.0 b/s, ×0.5); shallow ×0.75; water-exit hop at a bank; auto-step 1 block with eye smoothing τ 0.05 s; ground snap ≤ 1 block; `unstick(box, 2)`, which leaves the position unchanged on null; `lookDelta` with the first-after-lock and > 200 px spike filter | `firstPerson.ts` |
| §6 sandbox | The C key (`isModeKey`: bare C, not while typing; not in the terrain editor); pointer lock; a capture-phase input gate (canvas pointer events reach only first person); a crosshair and hint; Esc then click re-locks without digging; centre-ray dig/place within 5 blocks, refusing a placement into the player (`placementTarget` + `cellOverlapsBody`); no dig/place in the units scenes; `__elovox.fp = { toggle, dig, place }`; ` · C first person` added to the HUD hints | `apps/sandbox/src/firstPerson.ts`, `main.ts`, `hud.ts` |

Deviation, approved by the expert: the engine camera block came after the rebase onto collision (plan Task 7), so no
no-op collision stub ever entered product code.

## Evidence

All output was redirected to files and read back.

- **Unit tests**, `npm test` on 48039a6, quiet machine: engine 74 files, 854 passed and 2 expected-fail; terrain 18 files,
  174 passed; terrain-editor 23 files, 200 passed; sandbox 12 files, 108 passed. 4d's own tests:
  - `firstPerson.test.ts`: 25 tests. Look and input helpers, substeps, walk, sprint and jump on a stub; and, over the real
    4c collision: step 1 but not 2 with the eye lag, snap down stairs against a fall off a cliff, swim/sink/shallow, the
    bank exit, no tunnelling at 50 b/s with 0.1 s frames, unstick plus the buried-null walk-out, and spawn next to a
    taller column.
  - `orbitCamera.test.ts`: 3 new tests.
  - sandbox `firstPerson.test.ts`: 4 tests.
- **Typecheck**: `npm run typecheck` exits 0 on 48039a6.
- **e2e**, `E2E_PORT=5183 E2E_CHANNEL=msedge`, full suite on the rebased branch: 28 passed, 8 skipped (benchmarks), 4.2 min.
  `first-person.spec.ts`:
  - On a stone pad: C, walk, jump (apex > 1 block, lands at 121), placement into the player refused, a placement 2.5
    blocks ahead accepted, dig under the crosshair, C back to orbit centred on the player with FOV 50.
  - In the units scene: first-person clicks submit nothing, and dig/place return false.
- **Finding passed on to 4c**: `groundDistance(box, d)` returned null for a drop of exactly `d`, so a full 1-block stair
  was never seen. 4c fixed it in f29ad7c. 4d's snap still probes `snapDown + GROUND_EPS`, which is correct under either behaviour.
- **Unrelated, recorded for main**: the terrain-editor `densityBrush` property test timed out once at 5 s under a parallel
  4-workspace run on a loaded machine. Run alone it passed 3 times out of 3 at about 2.1 s, and 4d does not touch
  terrain/terrain-editor. It is a pre-existing, load-sensitive timeout.

## Open items

- **Feel checkpoint**, in progress with the user: walk, sprint, jump/gravity, acceleration, swim, step smoothing,
  sensitivity, FOV 70, and first-person shadow reach 48 (→ 144 blocks). Answers go into `FP_TUNING` / `FP_FOV` /
  `FP_VIEW_DISTANCE`.
- **Underwater view tint/fog**: there is none yet. Fog belongs to lod (4b).
- **Camera bob**: not built (YAGNI); it can be added if the checkpoint asks for it.
- First person does not collide with units, falling blocks or fragments (out of scope in 4c).
- `livingScript` set pieces still write the orbit camera while first person is active. That has no effect until C returns to orbit.
