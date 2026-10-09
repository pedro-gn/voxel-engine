# Elovox — Sub-project 4d: First-person camera and character controller — Review

Branch `feat/first-person`. Code HEAD cba02f8 (feel-checkpoint round, 2026-10-09; the first round's code was 48039a6),
rebased onto `feat/collision` ea69a20 (the final 4c API is f29ad7c; ea69a20 adds only 4c's review). Spec `specs/2026-10-08-first-person-design.md`, plan `plans/2026-10-08-first-person.md`, both
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
| §3 underwater view (added 2026-10-09) | `cameraInLiquid` (one voxel read of the camera point, skipped when no liquid block is registered); `UnderwaterFade` (linear 0.1 s ramp, exact 0 and 1); a branch-free post stage driven by one `amount` uniform: wobble (UV offset × amount), exp fog on −viewZ from the scene pass depth (90 % at 12 blocks) towards `WaterParams.deep`, a multiply towards `WaterParams.shallow` (0.6); `Visuals.setUnderwater`; `engine.underwater` | `render/underwater.ts` (new), `render/post.ts` (stage), `render/visuals.ts` (one method), `engine.ts` (camera block) |
| §4 item 6 after the feel checkpoint | No eye smoothing on the way down: the snap-down eye lag line is commented out with a note; ground snap and the step-up smoothing are unchanged | `firstPerson.ts` |
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

### Feel-checkpoint round (2026-10-09)

User answers: walk, sprint, jump, acceleration, swim, mouse sensitivity, FOV 70 and first-person shadow reach 48 all OK
as built. Step smoothing: up OK, down not wanted (done, 924b17c). New: an underwater screen effect (expert ruling A:
a post-pipeline stage, not a fog change; spec amended 8a270c9).

Commits: 8a270c9 spec, 7aaaf49 underwater logic + tests, 0e28868 CONTEXT term, 924b17c descent smoothing off,
9cee4e0 wiring (post/visuals/engine), cba02f8 e2e.

- **Unit tests**: `underwater.test.ts` 8 tests (camera in a pool, above it, inside a partial cell under and over its
  fill, outside the world, NaN, no liquid registered → no query; fade in/out timing, exact 0/1, dt clamp, NaN dt, zero
  fade; 90 % fog at 12). `firstPerson.test.ts` 25 tests: "snaps down 1-block stairs" now also requires zero eye lag on
  the way down (it failed before the change with 0.72 blocks of lag).
- **`npm test`** on 9cee4e0 (machine under load: Spotify, Discord, Docker): engine 75 files, 862 passed and 2
  expected-fail. Three 5 s timeouts in packages 4d does not touch: terrain `volumeOps` blob test and sandbox
  `painter` determinism, both green when rerun alone (10/10, 39/39); terrain-editor `densityBrush`, which also timed
  out alone (6.3 s, 8.9 s) - the pre-existing load-sensitive test recorded below, slower today because of the load.
- **Typecheck**: `npm run typecheck` exits 0 on cba02f8.
- **e2e**, `E2E_PORT=5185 E2E_CHANNEL=msedge --workers=1`, full suite on cba02f8: 29 passed, 8 skipped (benchmarks),
  7.4 min. New test: a still-water basin; first person sinks until `engine.underwater === 1`; C back to orbit → 0; a low
  orbit camera inside the basin → 1; pulled out → 0.
- **Picture at amount 0** (the stage must not change today's picture): a capture script on `?scene=terrain&still`
  (the 1024² showcase), 1280×720, Edge headless WebGPU, decorations off, clouds speed 0, `performance.now` frozen and
  three's node time pinned. Poses: orbit above the showcase's deepest water (sea at x 32, z 864, surface 30, depth 13)
  and first person on the shore (16.5, 782.5). Two captures of 924b17c's render files against two of 9cee4e0:
  - water hidden (the water surface follows the sim's water step, which differs by 1 LSB from run to run): **0 px**
    differ, before vs after and run vs run, in both camera modes;
  - water shown: before vs after 116-225 px differ by at most 1 LSB, inside the same build's run-to-run noise
    (82-254 px, 1 LSB).
- **Scene-pass depth under MSAA 4** works on both backends (the fog gradient follows distance in the shots below; WebGL
  shows no flip).
- **Checkpoint shots** (`reviews/2026-10-09-underwater-checkpoint/`): `webgpu-orbit-above`, `webgpu-orbit-under`,
  `webgpu-fp-above`, `webgpu-fp-under`, `webgl-orbit-under`.

## Open items

- **Underwater view look check** with the user (shots above): colour, fog strength (90 % at 12 blocks), tint 0.6,
  wobble 0.003 are tunables in `UNDERWATER`.
- **Underwater view limitations** (spec §3): one state for the whole screen, so a near plane straddling the surface is
  all-under or all-over; the switch follows the voxel water level, not the animated surface (up to about one wave
  height off); no underwater view with `effects.post` off.
- **Camera bob**: not built (YAGNI); it can be added if the checkpoint asks for it.
- First person does not collide with units, falling blocks or fragments (out of scope in 4c).
- `livingScript` set pieces still write the orbit camera while first person is active. That has no effect until C returns to orbit.
