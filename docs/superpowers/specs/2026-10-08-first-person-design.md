# Elovox — Sub-project 4d: First-person camera and character controller — Design

Status: approved by the expert (standing in for the user) on 2026-10-08: sections 1–3 approved in
brainstorming, Q1 water = Minecraft-style swimming, Q2 auto-step 1 block.
Amended 2026-10-09 after the user feel checkpoint: no eye smoothing on the way down (§4 item 6),
and the underwater view (§3 "Underwater view", approved by the expert: post-pipeline stage, option A).
Builds on 1 (voxel core: orbit camera, raycast, setBlock) and runs alongside 4c (AABB collision,
`feat/collision`), which it consumes.

## 1. Context

The roadmap (`2026-10-01-voxel-core-design.md`) promises "free orbit (RTS) **and** first-person"
and, for sub-project 4, "AABB collision, character controller". Today the only camera is
`OrbitCamera` (`packages/engine/src/interact/orbitCamera.ts`). The engine builds it as `engine.controls`
and drives it from the frame loop with `controls.update(dt); controls.apply(camera)`. The sandbox digs
and places with LMB/RMB through `engine.pickScreen` and `engine.submit`.

Sub-project 4 is split across four workers. 4c (collision) delivers `engine.collision`: pure,
time-agnostic AABB-vs-voxel functions over the ghost-aware client world. 4d (this document) delivers
the first-person camera and the character controller that uses them, plus the sandbox entry point.

| Topic | Decision |
|---|---|
| Where | An engine service, `FirstPersonController` in `interact/firstPerson.ts`, shaped like `OrbitCamera` (`update(dt)`, `apply(camera)`, `attach(canvas)`). The mode key, the dig/place reach and the HUD belong to the sandbox |
| Player state | Main-thread, client-side, not sim state, not deterministic. It reads the ghost-aware `engine.world` through `engine.collision`. World edits still go through `engine.submit`, so the sim stays deterministic |
| Collision | Only through `engine.collision` (4c). The controller holds no voxel collision code of its own |
| Body | 0.6 × 1.8 × 0.6 blocks, eye at 1.62 (fits the units' 2-high tunnels) |
| Water | Minecraft-style swimming from the liquid query (submerged fraction, eye under the surface) |
| Ledges | Auto-step 1 block when grounded and not swimming; the eye is smoothed over ~0.15 s on the way up only |
| Underwater view | When the camera (either mode) is in liquid, the post pipeline fogs and tints the picture blue-green, with a slight wobble |
| Approach | One extra controller plus a mode switch in `engine.ts`. Rejected: a generic `CameraRig` interface with `engine.setController` (one extra camera does not need it, YAGNI); a sandbox-only controller (the roadmap puts the character controller in the engine) |

## 2. Scope and success criteria

### In scope

- `FirstPersonController`: pointer-lock mouse look, walk, sprint, jump, swim, auto-step, ground snap.
- `engine.firstPerson`, `engine.cameraMode`, `engine.setCameraMode()`, and an `enabled` flag on `OrbitCamera`.
- Sandbox: the C key toggles modes, plus a crosshair, a mode hint, and dig/place from the crosshair.

### Out of scope

- Avatar / third-person view, multiplayer, inventory, fall damage, fly/noclip.
- Collision with units, falling blocks and structural fragments (4c rules them out).
- The far plane (lod owns `camera.far`). Scene fog and sky (lod's `sky.ts`/`atmosphere.ts`) are not touched:
  the underwater view is a post-pipeline stage, not a fog change.
- LOD and view distance (4b).

### Success criteria

- In every sandbox scene except the terrain editor, C drops into first person at the orbit target.
  You can then walk, sprint, jump, step up 1-block ledges and swim without passing through blocks,
  and C returns to the orbit camera centred where you stand.
- In first person, LMB digs and RMB places at the crosshair within 5 blocks, wherever orbit mode
  digs/places today (not in the units scenes). A placement that would overlap the player is refused.
- Orbit mode behaves exactly as today. Every existing unit test and e2e passes, including the water
  state hashes and the units' deterministic replay.
- Controller logic is unit-tested in Node. An e2e drives first person through `window.__elovox` without pointer lock.
- The feel numbers (speeds, jump, swim, step smoothing, sensitivity, FOV, FP shadow reach) pass a user feel checkpoint.

## 3. Architecture and public API

### `FirstPersonController` (`packages/engine/src/interact/firstPerson.ts`)

```ts
interface FirstPersonOptions {
  worldSize: WorldSize
  collision: CollisionLike          // the subset of engine.collision used here (§5)
  surfaceAt: (x: number, z: number) => number   // one above the highest solid OR liquid cell (spawn)
  tuning?: Partial<FirstPersonTuning>
}
class FirstPersonController {
  enabled: boolean                    // false: attach()'s listeners ignore input; input is cleared
  readonly position: [number, number, number]   // feet centre
  readonly velocity: [number, number, number]
  yaw: number; pitch: number          // same yaw convention as OrbitCamera: forward = (−sin yaw, 0, −cos yaw)
  readonly grounded: boolean; readonly swimming: boolean
  readonly input: { forward: number; right: number; jump: boolean; sprint: boolean }  // injectable
  look(dYaw: number, dPitch: number): void       // pitch clamped to ±(π/2 − 0.01)
  spawn(x: number, z: number): void              // feet at surfaceAt(x, z), then unstick
  update(dt: number): void                       // substeps ≤ 1/120 s
  apply(camera: FpCameraLike): void              // position.set(eye) + rotation.set(pitch, yaw, 0, 'YXZ')
  eye(): [number, number, number]; forward(): [number, number, number]
  attach(canvas: HTMLCanvasElement): () => void  // keys → input; mousemove under pointer lock → look
}
```

`attach` only reads mouse movement while `document.pointerLockElement === canvas`, and requests no
lock itself. The sandbox requests it. Tests and e2e drive `look()` and `input` directly.

### `OrbitCamera`

Gains `enabled = true`. While false, its key, drag, wheel and edge-pan handlers return early, and its
held keys and edge state are cleared. Everything else is unchanged, so orbit behaviour is identical while enabled.

### Engine (`engine.ts`, the camera block)

- `engine.firstPerson: FirstPersonController`, built with `collision: engine.collision`.
- `engine.cameraMode: 'orbit' | 'firstPerson'` (getter) and `engine.setCameraMode(mode)`.
- The frame loop updates and applies the active controller only.
- Visuals' `viewDistance` becomes `orbit ? controls.current.distance : FP_SHADOW_REACH` (48, so
  `shadowDistance(48)` = 144 blocks of shadow around the eye). This value is a tunable for the visual checkpoint.
- Camera FOV is 50 in orbit (unchanged) and 70 in first person, set on switch. 4d writes only
  `camera.fov` (in its own block). It assumes nothing about `camera.far` or fog, which lod may tie to
  the view-distance setting later.
- `surfaceAt` scans the column like `columnTop`, but counts liquid cells as well as solid ones, so
  switching to first person over a lake stands the player on the water surface, not on the lake bed.
  From there the swim rules take over.

### Underwater view (added 2026-10-09)

- **Term:** the *underwater view* is the screen effect shown while the camera is in liquid.
- **Detection** (engine camera block, every frame after the active camera is applied):
  `cameraInLiquid(...)` in `render/underwater.ts` is `collision.liquidAt(camera.position)`. It is skipped
  (false) when the registry has no liquid block, or the camera is outside the world box or non-finite.
  It is the same voxel query as the swim rules and works in both camera modes.
- **Fade:** `UnderwaterFade.update(dt, under)` ramps `amount` linearly to 1 (entering) or 0 (leaving)
  over `fade` = 0.1 s. It reaches exactly 0 and 1. A non-finite dt counts as 0, and dt is clamped to 0.1.
  `engine.underwater` (getter) exposes `amount` for tests.
- **Render:** one branch-free stage at the start of the post pipeline (`render/post.ts`), built by
  `underwaterColor()` in `render/underwater.ts`, driven by one `amount` uniform (no recompile on enter or exit):
  - wobble: the scene colour and depth are sampled at `screenUV + amount · wobble · sin(...)`, so at
    amount 0 the UV is exact;
  - fog: `f = 1 − exp(−density · distance)`, with `distance` = −viewZ from the scene pass depth and
    density = ln 10 / 12 (90 % at 12 blocks), towards the water colour (WaterParams.deep, so `setWater` restyles it);
  - tint: the result is multiplied by WaterParams.shallow mixed towards white by `tintStrength`;
  - `colour = mix(scene, fogged·tint, amount)`: at amount 0 the picture is today's, bit for bit
    (checked by a picture diff).
  - Colour, density, tint strength and wobble are tunables for the user's visual checkpoint.
  - `Visuals.setUnderwater(amount)` passes the amount to the post pipeline (one additive hunk).
- **Limitations:** the whole screen has one state, so with the near plane straddling the surface it
  is all-under or all-over; the switch follows the voxel water level, not the animated surface (off by
  up to about one wave height); with `effects.post` off there is no underwater view.

### Hand-off

- **orbit → first person:** spawn at the orbit `current.target` (x, z) with `yaw = orbit yaw` and
  `pitch = 0`, and remember the orbit distance. Disable the orbit and enable first person.
- **first person → orbit:** set orbit `goal.target` and `current.target` to the player's feet, and `yaw` to the player's yaw.
  `current.distance` starts at the orbit minimum (8) and `goal.distance` at the remembered distance,
  so the camera pulls back out of the head smoothly.

## 4. Movement

Every number below is a tunable (`FirstPersonTuning`) and goes to the user feel checkpoint.

### Frame and substeps

`update(dt)`: a non-finite dt counts as 0, and dt is clamped to 0.1 s. If the body overlaps solid (a
placed block, sand landing on the player), the controller first lifts it by `unstick(box, 2)`. When
unstick returns null (buried deeper than 2 blocks, e.g. a fillRegion over the player), the position is
left unchanged. Collision's escape semantics still let the player walk out of the cells it is in, but
never into new solid. Then n = ceil(dt · 120) equal substeps h run; the 0.1 s clamp means at most 12.

### Per substep

1. **Wish direction** from `input` in the yaw frame: forward = (−sin yaw, 0, −cos yaw),
   right = (cos yaw, 0, −sin yaw). Diagonals are normalized to length 1. Target horizontal speed =
   walk 4.3 b/s × (sprint ? 1.3 : 1) × medium factor. Sprint is Shift held while moving forward.
2. **Horizontal velocity** approaches the target exponentially: v += (target − v)(1 − e^(−k·h)), with
   k = 14/s on the ground (~0.2 s to full speed or to a stop), 3/s in the air (momentum with a little
   air control), and 6/s swimming.
3. **Vertical.**
   - *Not swimming:* gravity 30 b/s², terminal speed 50 b/s. Jump (Space held while grounded):
     vy = √(2 · 30 · 1.25) ≈ 8.66, an apex of 1.25 blocks. Holding Space re-jumps on landing.
   - *Swimming* (`liquid(box, eyeY).submerged ≥ 0.5`): no gravity. vy approaches +2.5 b/s with
     Space or −1.0 b/s without, at k = 5/s. Medium factor ×0.5.
   - *Shallow water* (0 < submerged < 0.5): medium factor ×0.75, normal gravity and jump.
   - *Water exit:* swimming, Space held, blocked horizontally on the previous substep and the eye
     not under the surface → one jump impulse (vy = 8.66), which climbs a 1-block bank.
4. **Move:** `move(box, v · h, { stepHeight: groundedBefore && !swimming ? 1 : 0 })`.
   - A blocked x/z axis zeroes that velocity component.
   - A blocked y zeroes vy when vy was pushing into the obstacle (down onto ground, up into a ceiling).
   - `grounded` comes from the result.
5. **Step smoothing:** after a step of `stepped = s`, the eye offset becomes offset − s, and it decays
   as e^(−t/0.05) (≈ 0.15 s to settle). The camera rises smoothly instead of popping.
6. **Ground snap down stairs:** the conditions are grounded before, not jumping, not swimming,
   vy ≤ 0, and airborne after the move. When they hold, d = `groundDistance(box, 1)`. If d ≠ null,
   the controller moves down by d through `move`, sets grounded and sets vy = 0. Walking off a
   1-block stair follows it down instead of hopping. The eye drops with the body: descent smoothing
   (adding d to the eye offset) was removed at the feel checkpoint and is kept commented out in the code.

### Look

`look(dYaw, dPitch)` adds to yaw and clamps pitch to ±(π/2 − 0.01). Mouse mapping in `attach`: under
pointer lock, `movementX/Y × 0.0022 rad/px` (Y not inverted), so dYaw = −mx·s and dPitch = −my·s.
Chromium/Edge sometimes deliver a spike, so the first mousemove after the lock engages is ignored,
and any event with |movementX| or |movementY| > 200 px is discarded. The mapping is the pure function
`lookDelta(mx, my, sensitivity)`, which returns null for a discarded event, and it is unit-tested.
There is no camera bob (YAGNI; it can come up at the feel checkpoint).

## 5. Collision contract (consumed)

Source: §3 of `2026-10-08-collision-design.md` on `feat/collision` 68eff31, approved by the expert.
Changes go through the expert. 4d uses this subset of `engine.collision` (`Collision`):

```ts
bodyBox(x, y, z, halfWidth, height): Box      // feet centre
move(box, delta, { stepHeight }?): MoveResult // dx dy dz, blockedX/Y/Z, grounded, ceiling, stepped
overlaps(box): boolean
groundDistance(box, maxDown?): number | null  // support at box.minY - d
liquid(box, eyeY?): { submerged: 0..1, eyeUnder, surfaceY | null }
unstick(box, maxUp): number | null            // smallest lift to a free position
```

What 4d relies on: displacements go in and the allowed displacement comes out, with no dt and no
gravity. Y is swept first, then the larger horizontal axis. Nothing tunnels at any length. A box that
already overlaps solid can move out but never into new solid, and there is no auto-push, so the
controller calls `unstick`. Step-up happens only when the box is grounded after the Y phase, blocked
horizontally, and the step improves progress. Ground snap is a downward `move` the controller makes
itself. The x/z sides and y < 0 are solid; above the world top is air. `CollisionLike` in
firstPerson.ts is `Pick<Collision, 'move' | 'overlaps' | 'groundDistance' | 'liquid' | 'unstick'>`.
Unit tests use a fake world through 4c's pure functions once they land (`bindCollision`), and a
minimal stub with these signatures before that.

## 6. Sandbox

A new file, `apps/sandbox/src/firstPerson.ts`, is wired in by small additive hunks in `main.ts`.
`workersView.ts`, `controls.ts` and the terrain editor are not edited.

- **Mode key C.** It toggles on `keydown` when `e.code === 'KeyC'`, with no modifiers, not a repeat,
  and focus not in a text field (pure `isModeKey(e, activeElement)`). It is not installed in
  `?scene=terrain&edit`. Entering calls `engine.setCameraMode('firstPerson')` and
  `canvas.requestPointerLock()` (the keydown is a user activation). Leaving calls
  `document.exitPointerLock()` and `engine.setCameraMode('orbit')`.
- **Esc.** The browser drops the lock and the player stays in first person. A "click to look" line
  shows, and the next click only re-locks; it never digs or places.
- **Input gate.** While in first person, a capture-phase `window` listener takes `pointerdown`,
  `pointermove`, `pointerup`, `wheel` and `contextmenu` events aimed at the canvas and stops their
  propagation. No orbit dig/highlight handler in `main.ts`, and no `workersView` select/order handler,
  ever sees a locked-cursor click with a stale `clientX`. In orbit mode the gate is inert.
- **Dig/place in first person**, only where orbit digs/places today (not the units scenes, not the editor):
  - The hit is `engine.raycast(eye, forward, 5)`. LMB digs (`setBlock` AIR). RMB places the hotbar
    block at `hit.pos + hit.normal`, with today's liquid `packVoxel(id, 7)` rule and in-bounds check.
  - A placement is refused when the target cell overlaps the player box: `cellOverlapsBody(x, y, z)`
    on the controller, a box-vs-cell interval test, not a collision query. The decision is the pure
    `placementTarget(hit, inBounds, overlapsBody)`.
  - One action per click; no hold-to-repeat. The highlight follows the crosshair on the engine's `frame` event.
  - In the units scenes a first-person click only (re-)locks; look and walk work.
- **UI.**
  - A centred CSS crosshair, and a bottom-centre hint, both shown only in first person:
    `C orbit · WASD walk · Shift sprint · Space jump/swim · LMB dig · RMB place · Esc free mouse`
    (without dig/place in the units scenes).
  - One additive hunk in `hud.ts` appends ` · C first person` to the default orbit hint lines.
- **Test hook.** `window.__elovox.fp = { toggle, dig, place }` acts along the centre ray and needs no
  pointer lock. The e2e also drives `engine.firstPerson.input` and `look()` directly.

## 7. Testing

- **Engine unit tests** (`packages/engine/test/firstPerson.test.ts`, Node):
  - Look and input: input mapping and diagonal normalization; `lookDelta` (first event after lock
    dropped, |d| > 200 px dropped); pitch clamp.
  - Walking: the reach-speed and stop curves; sprint.
  - Jumping, stepping, landing: jump apex ≈ 1.25 and landing sets grounded; the 1-block step with eye
    smoothing, and no step onto 2 blocks; the ground snap down stairs with no eye lag.
  - Water: swim up and sink, the shallow-water factor, and the water-exit hop.
  - Substeps and safety: substep count (dt 0.1 → 12) with no tunnelling at terminal speed; unstick on
    overlap, and position unchanged when unstick returns null.
  - Spawn and hand-off: `spawn` on land and on water (via `surfaceAt`); the hand-off both ways with a
    real `OrbitCamera`. In `orbitCamera.test.ts`: `enabled = false` ignores input, and orbit is
    unchanged while enabled.
  - These tests run against a stub of the frozen 68eff31 signatures until 4c lands, then against a
    fake world through 4c's real `bindCollision`.
- **Underwater unit tests** (`packages/engine/test/underwater.test.ts`, Node): `cameraInLiquid` (in a
  pool, above it, in a partial-level cell above and below its top, no liquid in the registry, outside the
  world, NaN); `UnderwaterFade` (ramps in and out in 0.1 s, exact 0 and 1, dt clamp, NaN dt); the fog
  density gives 90 % at 12 blocks.
- **Sandbox unit tests** (vitest, Node): `isModeKey`, `placementTarget`.
- **e2e** `apps/sandbox/e2e/first-person.spec.ts` on a small world scene:
  - Camera mode: C gives `cameraMode === 'firstPerson'`.
  - Walking and jumping: `input.forward = 1` for ~1 s moves ≥ 3 blocks with the feet on the ground;
    a jump rises and lands.
  - Dig/place: `fp.dig` removes the centre block; `fp.place` into the player's own cell is refused.
  - Back to orbit: C gives an orbit target ≈ the player's feet.
  - Units scene: a first-person click submits nothing.
  - Underwater: with the camera in a pool (first person and orbit) `engine.underwater` reaches 1, and
    returns to 0 above the surface.
  - Picture: above water, the frame is identical (0 px) to the branch before the stage.
  - The existing unit and e2e suites stay green.
- **Feel/visual checkpoint** with the user, arranged by the expert: walk, sprint, jump, swim,
  step-up, the first-person shadow reach 48, FOV 70; then the underwater view (above/below shots at
  the showcase pool in both modes).
