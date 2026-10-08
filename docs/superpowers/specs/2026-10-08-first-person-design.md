# Elovox — Sub-project 4d: First-person camera and character controller — Design

Status: DRAFT, in brainstorming. Decisions so far: water = Minecraft-style swimming (Q1), auto-step
1 block (Q2), section 1 (architecture + API, §3 here) approved with two notes (spawn on water, no
far/fog assumptions). Sections 2–3 (§4, §6 here) are not yet presented.
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
| Ledges | Auto-step 1 block when grounded and not swimming; the eye is smoothed over ~0.15 s |
| Approach | One extra controller plus a mode switch in `engine.ts`. Rejected: a generic `CameraRig` interface with `engine.setController` (one extra camera does not need it, YAGNI); a sandbox-only controller (the roadmap puts the character controller in the engine) |

## 2. Scope and success criteria

### In scope

- `FirstPersonController`: pointer-lock mouse look, walk, sprint, jump, swim, auto-step, ground snap.
- `engine.firstPerson`, `engine.cameraMode`, `engine.setCameraMode()`, and an `enabled` flag on `OrbitCamera`.
- Sandbox: the C key toggles modes, plus a crosshair, a mode hint, and dig/place from the crosshair.

### Out of scope

- Avatar / third-person view, multiplayer, inventory, fall damage, fly/noclip.
- Collision with units, falling blocks and structural fragments (4c rules them out).
- The underwater view tint/fog (lod owns fog), and the far plane (lod owns `camera.far`). Both are open items.
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
  apply(camera: CameraLike & { rotation: ... }): void
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

### Hand-off

- **orbit → first person:** spawn at the orbit `current.target` (x, z) with `yaw = orbit yaw` and
  `pitch = 0`, and remember the orbit distance. Disable the orbit and enable first person.
- **first person → orbit:** set orbit `goal.target` and `current.target` to the player's feet, and `yaw` to the player's yaw.
  `current.distance` starts at the orbit minimum (8) and `goal.distance` at the remembered distance,
  so the camera pulls back out of the head smoothly.

## 4. Movement

DRAFT, to be presented as section 2.

## 5. Collision contract (consumed)

DRAFT, pending 4c's approved API text (forwarded by the expert).

## 6. Sandbox

DRAFT, to be presented as section 3.

## 7. Testing

DRAFT.
