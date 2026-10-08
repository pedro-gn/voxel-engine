# First-person camera and character controller (4d) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first-person mode, switchable with the orbit camera. It covers pointer-lock look, walking, sprinting, jumping, auto-step, ground snap and swimming over `engine.collision`, plus dig/place from the crosshair in the sandbox.

**Architecture:**
- `FirstPersonController` (engine, `interact/firstPerson.ts`) is shaped like `OrbitCamera`: `update(dt)`, `apply(camera)`, `attach(canvas)`. It holds pure motion policy over the time-agnostic collision functions of 4c.
- `engine.ts` owns the mode (`cameraMode` / `setCameraMode`), and the frame loop drives only the active controller.
- The sandbox adds the C key, a capture-phase input gate, a crosshair and hint, and centre-ray dig/place.

**Tech Stack:** TypeScript, three.js r186 (WebGPU/TSL), vitest (Node), Playwright (Edge).

**Spec:** `docs/superpowers/specs/2026-10-08-first-person-design.md` (approved). The consumed collision API is §3 of
`docs/superpowers/specs/2026-10-08-collision-design.md` on `feat/collision` 68eff31.

## Global Constraints

- Units are blocks, seconds and blocks/s, with y up. Voxel (x, y, z) occupies [x, x+1).
- Body 0.6 × 1.8 × 0.6, eye at 1.62. Walk 4.3 b/s, sprint ×1.3. Gravity 30 b/s², terminal speed 50. Jump apex 1.25. Reach 5. FOV 50 in orbit and 70 in first person. First-person `viewDistance` is 48. All of these are tunables for the feel checkpoint.
- The player is main-thread state and not deterministic. The sim is touched only through `engine.submit` (setBlock).
- There is no private collision code. Product code uses `engine.collision` only. Before the rebase, tests may use a stub of the frozen signatures.
- Orbit mode stays byte-identical while `enabled` is true. Every existing unit test and e2e stays green, including water hashes and the units' replay.
- Shared files (`engine.ts`, `index.ts`, `main.ts`, `hud.ts`) get small additive hunks in 4d's own region only. Exports are appended on their own line. No reformatting.
- 4d writes only `camera.fov` and assumes nothing about `camera.far` or fog (lod owns both). `visuals.ts` and `shadowFit.ts` are not edited.
- Commits use `type(scope): message`, with no Co-Authored-By trailer. Never push or merge.
- Shell output that serves as evidence is redirected to a file and read back (the RTK summarizer can be wrong). e2e always runs with `E2E_PORT=5183`.

## Review Focus

1. **The C key while typing in the terrain panel's or the units panel's inputs** must not toggle modes. Pinned by `isModeKey` tests (Task 5).
2. **A click in first person in the units scenes** must never select or order units with a stale cursor position. Pinned by an e2e that counts submits (Task 9).
3. **Spawning over a lake, or on a column narrower than the body** (neighbour taller) must not bury the player or drop the camera to the lake bed. Pinned by spawn-on-water and spawn-unstick tests (Task 6).
4. **A huge frame dt** (a tab switch gives 0.1 s after the clamp) at terminal speed must never tunnel through a 1-block floor. Pinned by a tunnelling test (Task 6).
5. **Leaving first person mid-key-hold** (W held while pressing C) must not leave the orbit or the controller drifting. Pinned by an `enabled = false` input-clearing test (Task 2) and the orbit `enabled` setter test (Task 1).

---

### Task 1: `OrbitCamera.enabled` and `minDistance`

**Files:**
- Modify: `packages/engine/src/interact/orbitCamera.ts`
- Test: `packages/engine/test/orbitCamera.test.ts`

**Interfaces:**
- Produces: `OrbitCamera.enabled: boolean` (getter/setter; setting false clears held keys and the edge-pan state) and `OrbitCamera.minDistance: number` (getter).

- [ ] **Step 1: Write the failing tests** (append to the `describe('OrbitCamera')` block)

```ts
  it('ignores and clears input while disabled, unchanged while enabled', () => {
    const c = make()
    expect(c.enabled).toBe(true)
    const keys = (c as unknown as { keys: Set<string> }).keys
    keys.add('KeyW')
    ;(c as unknown as { edge: [number, number] }).edge = [1, 0]
    c.enabled = false
    expect(keys.size).toBe(0)
    expect((c as unknown as { edge: [number, number] }).edge).toEqual([0, 0])
    const before = [...c.goal.target]
    c.update(0.1)
    expect(c.goal.target[0]).toBe(before[0])
    expect(c.goal.target[2]).toBe(before[2])
    c.enabled = true
    keys.add('KeyW')
    c.update(0.1)
    expect(c.goal.target[2]).toBeLessThan(before[2]!)
  })
  it('exposes its minimum distance', () => {
    expect(make().minDistance).toBe(8)
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/engine && npx vitest run test/orbitCamera.test.ts > $SCRATCH/t1.log 2>&1` and read the log.
Expected: FAIL (`enabled` is undefined).

- [ ] **Step 3: Implement**

In `OrbitCamera`, add the following below `private edge: [number, number] = [0, 0]`:

```ts
  private _enabled = true
  /** False while another controller (first person) owns the input: handlers ignore events; held keys and edge pan clear. */
  get enabled(): boolean { return this._enabled }
  set enabled(v: boolean) {
    this._enabled = v
    if (!v) { this.keys.clear(); this.edge = [0, 0] }
  }
  get minDistance(): number { return this.o.minDistance }
```

In `attach`, add an early return to the first line of four handlers. Leave every other line unchanged.

```ts
    const down = (e: PointerEvent) => {
      if (!this._enabled) return
      if (e.button !== 1 && e.button !== 2) return
```
```ts
    const move = (e: PointerEvent) => {
      if (!this._enabled) return
      const rect = canvas.getBoundingClientRect()
```
```ts
    const wheel = (e: WheelEvent) => { if (!this._enabled) return; e.preventDefault(); this.zoom(e.deltaY) }
```
```ts
    const kd = (e: KeyboardEvent) => { if (this._enabled) this.keys.add(e.code) }
```

- [ ] **Step 4: Run the orbit tests to verify they pass**

Run: `npx vitest run test/orbitCamera.test.ts > $SCRATCH/t1.log 2>&1`. Expected: all pass, including the old ones.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/interact/orbitCamera.ts packages/engine/test/orbitCamera.test.ts
git commit -m "feat(camera): OrbitCamera.enabled lets another controller own the input"
```

---

### Task 2: `firstPerson.ts`: types, look, input and geometry helpers

**Files:**
- Create: `packages/engine/src/interact/firstPerson.ts`
- Test: `packages/engine/test/firstPerson.test.ts`

**Interfaces:**
- Consumes: `WorldSize` (`world/layout.ts`), `voxelId` (`world/voxel.ts`).
- Produces:
  - Collision mirror types (replaced by 4c's imports in Task 6): `FpBox`, `FpMoveResult`, `FpLiquid`, `CollisionLike { move(box, delta: readonly [n,n,n], options?: { stepHeight?: number }): FpMoveResult; overlaps(box): boolean; groundDistance(box, maxDown?): number | null; liquid(box, eyeY?): FpLiquid; unstick(box, maxUp): number | null }`.
  - `CameraMode = 'orbit' | 'firstPerson'`, `FirstPersonTuning`, `FP_TUNING`, `FP_FOV = 70`, `FP_VIEW_DISTANCE = 48`.
  - `FpInput`, `FpCameraLike`, `FirstPersonOptions`.
  - Pure helpers: `wishDir(forward, right, yaw): [number, number]`, `lookDelta(mx, my, sensitivity, maxPx): [number, number] | null`, `createLookFilter(sensitivity, maxPx): { lock(): void; delta(mx, my): [number, number] | null }`, `surfaceTop(get, solid, liquid, size, x, z): number`.
  - `class FirstPersonController`:
    - fields `position`, `velocity`, `yaw`, `pitch`, `input`, `tuning`, `lastSubsteps`;
    - getters `grounded`, `swimming`, `eyeLag`, and `enabled` (get/set);
    - methods `box(): FpBox`, `look(dYaw, dPitch)`, `spawn(x, z)`, `cellOverlapsBody(x, y, z)`, `eye()`, `forward()`, `apply(camera)`, `attach(canvas)`;
    - `update(dt)` arrives in Task 3.

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/firstPerson.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  FP_TUNING, FirstPersonController, createLookFilter, lookDelta, surfaceTop, wishDir,
  type CollisionLike, type FpBox,
} from '../src/interact/firstPerson.ts'

/** A stub of 4c's frozen signatures: an infinite floor at y = floorY, nothing else, no water. Replaced in Task 6. */
function flatFloor(floorY = 0): CollisionLike & { calls: number } {
  const s = {
    calls: 0,
    move(box: FpBox, d: readonly [number, number, number]) {
      s.calls++
      let dy = d[1]
      const blockedY = box.minY + dy < floorY
      if (blockedY) dy = floorY - box.minY
      return { dx: d[0], dy, dz: d[2], blockedX: false, blockedY, blockedZ: false, grounded: box.minY + dy <= floorY + 1e-3, ceiling: false, stepped: 0 }
    },
    overlaps: (box: FpBox) => box.minY < floorY - 1e-7,
    groundDistance: (box: FpBox, maxDown = 1e-3) => { const d = box.minY - floorY; return d <= maxDown ? Math.max(0, d) : null },
    liquid: () => ({ submerged: 0, eyeUnder: false, surfaceY: null }),
    unstick: (box: FpBox, maxUp: number) => { const d = floorY - box.minY; return d <= 0 ? 0 : d <= maxUp ? d : null },
  }
  return s
}
const makeFp = (collision: CollisionLike = flatFloor(), surface = 0) =>
  new FirstPersonController({ worldSize: [64, 64, 64], collision, surfaceAt: () => surface })

describe('first-person helpers', () => {
  it('maps input to a unit wish direction in the yaw frame', () => {
    const [fx, fz] = wishDir(1, 0, 0)                           // forward at yaw 0 is −z
    expect(fx).toBeCloseTo(0); expect(fz).toBeCloseTo(-1)
    const [x, z] = wishDir(0, 1, Math.PI / 2)                   // right at yaw 90° is −z (as OrbitCamera)
    expect(x).toBeCloseTo(0); expect(z).toBeCloseTo(-1)
    const d = wishDir(1, 1, 0)
    expect(Math.sqrt(d[0] ** 2 + d[1] ** 2)).toBeCloseTo(1)    // diagonals are normalized
    expect(wishDir(0, 0, 1)).toEqual([0, 0])
    expect(wishDir(Number.NaN, 0, 0)).toEqual([0, 0])
  })
  it('maps mouse movement to look deltas and drops spikes', () => {
    const [dy, dp] = lookDelta(10, -20, 0.002, 200)!             // right turns right (−yaw), up looks up (+pitch)
    expect(dy).toBeCloseTo(-0.02); expect(dp).toBeCloseTo(0.04)
    expect(lookDelta(201, 0, 0.002, 200)).toBeNull()
    expect(lookDelta(0, -250, 0.002, 200)).toBeNull()
    expect(lookDelta(Number.NaN, 0, 0.002, 200)).toBeNull()
  })
  it('ignores the first movement after the pointer locks', () => {
    const f = createLookFilter(0.002, 200)
    expect(f.delta(10, 0)![0]).toBeCloseTo(-0.02)
    f.lock()
    expect(f.delta(10, 0)).toBeNull()
    expect(f.delta(10, 0)![0]).toBeCloseTo(-0.02)
  })
  it('finds the top of the highest solid or liquid cell', () => {
    const solid = new Uint8Array([0, 1, 0]), liquid = new Uint8Array([0, 0, 1])
    const cells = new Map<string, number>([['3,4,3', 1], ['3,5,3', 2], ['3,6,3', 2], ['7,2,7', 1]])
    const get = (x: number, y: number, z: number) => cells.get(`${x},${y},${z}`) ?? 0
    expect(surfaceTop(get, solid, liquid, [16, 16, 16], 3.5, 3.5)).toBe(7) // stands on the water, not the bed
    expect(surfaceTop(get, solid, liquid, [16, 16, 16], 7.2, 7.9)).toBe(3)
    expect(surfaceTop(get, solid, liquid, [16, 16, 16], 1, 1)).toBe(0)
    expect(surfaceTop(get, solid, liquid, [16, 16, 16], -5, 99)).toBe(0) // clamped into the world, finite
  })
})

describe('FirstPersonController (no motion)', () => {
  it('clamps pitch and accumulates yaw', () => {
    const fp = makeFp()
    fp.look(0.5, 10)
    expect(fp.pitch).toBeCloseTo(Math.PI / 2 - 0.01)
    fp.look(0.5, -10)
    expect(fp.pitch).toBeCloseTo(-(Math.PI / 2 - 0.01))
    expect(fp.yaw).toBeCloseTo(1)
  })
  it('spawns on the surface inside the world and faces the given yaw', () => {
    const fp = makeFp(flatFloor(), 12)
    fp.velocity[1] = -9
    fp.spawn(100, -3)
    expect(fp.position[0]).toBeCloseTo(64 - 0.301, 9)
    expect(fp.position[1]).toBe(12)
    expect(fp.position[2]).toBeCloseTo(0.301, 9)
    expect(fp.velocity).toEqual([0, 0, 0])
  })
  it('puts the eye at 1.62 and looks along yaw/pitch', () => {
    const fp = makeFp()
    fp.spawn(10, 10)
    expect(fp.eye()).toEqual([10, 1.62, 10])
    fp.yaw = Math.PI / 2; fp.pitch = 0
    const f = fp.forward()
    expect(f[0]).toBeCloseTo(-1); expect(f[1]).toBeCloseTo(0); expect(f[2]).toBeCloseTo(0)
    const seen: unknown[] = []
    fp.apply({ position: { set: (...a: number[]) => seen.push(a) }, rotation: { set: (...a: unknown[]) => seen.push(a) } })
    expect(seen).toEqual([[10, 1.62, 10], [0, Math.PI / 2, 0, 'YXZ']])
  })
  it('tells which cells the body overlaps (touching is not overlapping)', () => {
    const fp = makeFp()
    fp.spawn(10.5, 10.5)                         // body [10.2, 10.8] × [0, 1.8] × [10.2, 10.8]
    expect(fp.cellOverlapsBody(10, 0, 10)).toBe(true)
    expect(fp.cellOverlapsBody(10, 1, 10)).toBe(true)
    expect(fp.cellOverlapsBody(10, 2, 10)).toBe(false)
    expect(fp.cellOverlapsBody(10, -1, 10)).toBe(false) // the floor it stands on
    expect(fp.cellOverlapsBody(11, 0, 10)).toBe(false)
  })
  it('clears its input when disabled', () => {
    const fp = makeFp()
    Object.assign(fp.input, { forward: 1, right: -1, jump: true, sprint: true })
    fp.enabled = false
    expect(fp.input).toEqual({ forward: 0, right: 0, jump: false, sprint: false })
  })
  it('defaults to the spec tuning', () => {
    expect(makeFp().tuning).toEqual(FP_TUNING)
    expect(FP_TUNING).toMatchObject({ halfWidth: 0.3, height: 1.8, eye: 1.62, walk: 4.3, sprint: 1.3, gravity: 30, jumpHeight: 1.25 })
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/firstPerson.test.ts > $SCRATCH/t2.log 2>&1`. Expected: FAIL (the module does not exist).

- [ ] **Step 3: Implement** `packages/engine/src/interact/firstPerson.ts`

```ts
import type { WorldSize } from '../world/layout.ts'
import { voxelId } from '../world/voxel.ts'

// ---- collision, as consumed (4c §3 at 68eff31; replaced by imports from collision.ts once it lands) ----
export interface FpBox { readonly minX: number; readonly minY: number; readonly minZ: number; readonly maxX: number; readonly maxY: number; readonly maxZ: number }
export interface FpMoveResult { dx: number; dy: number; dz: number; blockedX: boolean; blockedY: boolean; blockedZ: boolean; grounded: boolean; ceiling: boolean; stepped: number }
export interface FpLiquid { submerged: number; eyeUnder: boolean; surfaceY: number | null }
/** The part of engine.collision the controller uses. */
export interface CollisionLike {
  move(box: FpBox, delta: readonly [number, number, number], options?: { stepHeight?: number }): FpMoveResult
  overlaps(box: FpBox): boolean
  groundDistance(box: FpBox, maxDown?: number): number | null
  liquid(box: FpBox, eyeY?: number): FpLiquid
  unstick(box: FpBox, maxUp: number): number | null
}

export type CameraMode = 'orbit' | 'firstPerson'

/** Every feel number of the controller (blocks, seconds). Spec 4d §4; all go to the feel checkpoint. */
export interface FirstPersonTuning {
  halfWidth: number; height: number; eye: number
  walk: number; sprint: number
  accelGround: number; accelAir: number; accelSwim: number
  gravity: number; terminal: number; jumpHeight: number
  swimThreshold: number; swimFactor: number; shallowFactor: number; swimUp: number; sink: number; swimAccel: number
  stepHeight: number; stepSmoothing: number; snapDown: number; unstickUp: number
  sensitivity: number; maxLookPx: number; substep: number
}
export const FP_TUNING: Readonly<FirstPersonTuning> = Object.freeze({
  halfWidth: 0.3, height: 1.8, eye: 1.62,
  walk: 4.3, sprint: 1.3,
  accelGround: 14, accelAir: 3, accelSwim: 6,
  gravity: 30, terminal: 50, jumpHeight: 1.25,
  swimThreshold: 0.5, swimFactor: 0.5, shallowFactor: 0.75, swimUp: 2.5, sink: 1.0, swimAccel: 5,
  stepHeight: 1, stepSmoothing: 0.05, snapDown: 1, unstickUp: 2,
  sensitivity: 0.0022, maxLookPx: 200, substep: 1 / 120,
})
/** Camera field of view in first person (orbit keeps the camera's construction value). */
export const FP_FOV = 70
/** What the engine passes as Visuals' viewDistance in first person: shadowDistance(48) = 144 blocks. */
export const FP_VIEW_DISTANCE = 48

export interface FpInput { forward: number; right: number; jump: boolean; sprint: boolean }
export interface FpCameraLike {
  position: { set(x: number, y: number, z: number): unknown }
  rotation: { set(x: number, y: number, z: number, order?: 'YXZ'): unknown }
}
export interface FirstPersonOptions {
  worldSize: WorldSize
  collision: CollisionLike
  /** One above the highest solid or liquid cell of the column under (x, z): where spawn() stands the player. */
  surfaceAt: (x: number, z: number) => number
  tuning?: Partial<FirstPersonTuning>
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const PITCH_LIMIT = Math.PI / 2 - 0.01

/** Horizontal wish direction (x, z) for input in [-1, 1], in the yaw frame (forward = (−sin, −cos)); length ≤ 1. */
export function wishDir(forward: number, right: number, yaw: number): [number, number] {
  const f = Number.isFinite(forward) ? clamp(forward, -1, 1) : 0
  const r = Number.isFinite(right) ? clamp(right, -1, 1) : 0
  const len = Math.sqrt(f * f + r * r)
  if (!(len > 0)) return [0, 0]
  const k = len > 1 ? 1 / len : 1
  const s = Math.sin(yaw), c = Math.cos(yaw)
  return [(-s * f + c * r) * k, (-c * f - s * r) * k]
}

/** Mouse movement (px) to (dYaw, dPitch); null for a non-finite or spiking event (|d| > maxPx). */
export function lookDelta(mx: number, my: number, sensitivity: number, maxPx: number): [number, number] | null {
  if (!Number.isFinite(mx) || !Number.isFinite(my) || Math.abs(mx) > maxPx || Math.abs(my) > maxPx) return null
  return [-mx * sensitivity, -my * sensitivity]
}

/** lookDelta that also drops the first event after the pointer locks (Chromium sends a jump there). */
export function createLookFilter(sensitivity: number, maxPx: number): { lock(): void; delta(mx: number, my: number): [number, number] | null } {
  let skip = false
  return {
    lock() { skip = true },
    delta(mx, my) {
      if (skip) { skip = false; return null }
      return lookDelta(mx, my, sensitivity, maxPx)
    },
  }
}

/** One above the highest solid or liquid cell in the column under (x, z), clamped into the world. Always finite. */
export function surfaceTop(
  get: (x: number, y: number, z: number) => number, solid: Uint8Array, liquid: Uint8Array, size: WorldSize, x: number, z: number,
): number {
  const cell = (v: number, n: number) => (Number.isFinite(v) ? clamp(Math.floor(v), 0, n - 1) : 0)
  const xi = cell(x, size[0]), zi = cell(z, size[2])
  for (let y = size[1] - 1; y >= 0; y--) {
    const id = voxelId(get(xi, y, zi))
    if (solid[id] || liquid[id]) return y + 1
  }
  return 0
}

export class FirstPersonController {
  /** Feet centre, blocks. */
  readonly position: [number, number, number] = [0, 0, 0]
  /** Blocks per second. */
  readonly velocity: [number, number, number] = [0, 0, 0]
  /** Same convention as OrbitCamera: forward = (−sin yaw, 0, −cos yaw). */
  yaw = 0
  pitch = 0
  /** Written by attach() from the keyboard, or directly by tests / e2e. */
  readonly input: FpInput = { forward: 0, right: 0, jump: false, sprint: false }
  readonly tuning: Readonly<FirstPersonTuning>
  /** Substeps taken by the last update(). */
  lastSubsteps = 0
  protected _grounded = false
  protected _swimming = false
  protected eyeOffset = 0
  private _enabled = true
  private readonly keys = new Set<string>()
  private readonly look_ = { sens: 0, max: 0 }

  constructor(protected readonly o: FirstPersonOptions) {
    this.tuning = Object.freeze({ ...FP_TUNING, ...o.tuning })
    this.look_.sens = this.tuning.sensitivity
    this.look_.max = this.tuning.maxLookPx
  }

  get grounded(): boolean { return this._grounded }
  get swimming(): boolean { return this._swimming }
  /** Camera height smoothing (blocks): negative right after a step up, positive after a snap down; decays to 0. */
  get eyeLag(): number { return this.eyeOffset }
  /** False while the orbit camera owns the input: attach()'s handlers ignore events; input clears. */
  get enabled(): boolean { return this._enabled }
  set enabled(v: boolean) {
    this._enabled = v
    if (!v) {
      this.keys.clear()
      Object.assign(this.input, { forward: 0, right: 0, jump: false, sprint: false })
    }
  }

  box(): FpBox {
    const [x, y, z] = this.position, hw = this.tuning.halfWidth
    return { minX: x - hw, minY: y, minZ: z - hw, maxX: x + hw, maxY: y + this.tuning.height, maxZ: z + hw }
  }

  look(dYaw: number, dPitch: number): void {
    if (Number.isFinite(dYaw)) this.yaw += dYaw
    if (Number.isFinite(dPitch)) this.pitch = clamp(this.pitch + dPitch, -PITCH_LIMIT, PITCH_LIMIT)
  }

  /** Stands the player on the surface at (x, z) (kept inside the world), at rest. */
  spawn(x: number, z: number): void {
    const [sx, , sz] = this.o.worldSize, m = this.tuning.halfWidth + 1e-3
    const px = clamp(Number.isFinite(x) ? x : sx / 2, m, sx - m), pz = clamp(Number.isFinite(z) ? z : sz / 2, m, sz - m)
    this.position[0] = px; this.position[1] = this.o.surfaceAt(px, pz); this.position[2] = pz
    this.velocity.fill(0)
    this._grounded = false
    this._swimming = false
    this.eyeOffset = 0
  }

  /** Whether voxel cell (x, y, z) overlaps the body (touching faces do not): refuses placing a block into the player. */
  cellOverlapsBody(x: number, y: number, z: number): boolean {
    const b = this.box()
    return x < b.maxX && x + 1 > b.minX && y < b.maxY && y + 1 > b.minY && z < b.maxZ && z + 1 > b.minZ
  }

  eye(): [number, number, number] {
    return [this.position[0], this.position[1] + this.tuning.eye + this.eyeOffset, this.position[2]]
  }

  forward(): [number, number, number] {
    const cp = Math.cos(this.pitch)
    return [-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp]
  }

  apply(camera: FpCameraLike): void {
    const [x, y, z] = this.eye()
    camera.position.set(x, y, z)
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ')
  }

  /** Keys → input (WASD, Space, Shift); mouse movement under pointer lock → look. Requests no lock itself. */
  attach(canvas: HTMLCanvasElement): () => void {
    const filter = createLookFilter(this.look_.sens, this.look_.max)
    const sync = () => {
      const k = this.keys
      this.input.forward = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0)
      this.input.right = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0)
      this.input.jump = k.has('Space')
      this.input.sprint = k.has('ShiftLeft') || k.has('ShiftRight')
    }
    const kd = (e: KeyboardEvent) => {
      if (!this._enabled) return
      if (e.code === 'Space') e.preventDefault()
      this.keys.add(e.code); sync()
    }
    const ku = (e: KeyboardEvent) => { if (this.keys.delete(e.code) && this._enabled) sync() }
    const blur = () => { if (this.keys.size) { this.keys.clear(); if (this._enabled) sync() } }
    const lockChange = () => { if (document.pointerLockElement === canvas) filter.lock() }
    const mm = (e: MouseEvent) => {
      if (!this._enabled || document.pointerLockElement !== canvas) return
      const d = filter.delta(e.movementX, e.movementY)
      if (d) this.look(d[0], d[1])
    }
    window.addEventListener('keydown', kd)
    window.addEventListener('keyup', ku)
    window.addEventListener('blur', blur)
    document.addEventListener('pointerlockchange', lockChange)
    document.addEventListener('mousemove', mm)
    return () => {
      window.removeEventListener('keydown', kd)
      window.removeEventListener('keyup', ku)
      window.removeEventListener('blur', blur)
      document.removeEventListener('pointerlockchange', lockChange)
      document.removeEventListener('mousemove', mm)
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/firstPerson.test.ts > $SCRATCH/t2.log 2>&1`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/interact/firstPerson.ts packages/engine/test/firstPerson.test.ts
git commit -m "feat(camera): first-person controller look, input and geometry helpers"
```

---

### Task 3: Movement integration (`update`)

**Files:**
- Modify: `packages/engine/src/interact/firstPerson.ts`
- Test: `packages/engine/test/firstPerson.test.ts`

**Interfaces:**
- Consumes: `CollisionLike`, `FirstPersonController` internals (Task 2).
- Produces: `FirstPersonController.update(dt: number): void`, plus `lastSubsteps`.

- [ ] **Step 1: Write the failing tests** (a new `describe` in `firstPerson.test.ts`)

```ts
const run = (fp: FirstPersonController, seconds: number, dt = 1 / 60) => { for (let t = 0; t < seconds - 1e-9; t += dt) fp.update(dt) }
const hSpeed = (fp: FirstPersonController) => Math.sqrt(fp.velocity[0] ** 2 + fp.velocity[2] ** 2)

describe('FirstPersonController.update (flat floor stub)', () => {
  it('takes equal substeps of at most 1/120 s, and none for a bad dt', () => {
    const floor = flatFloor(), fp = makeFp(floor)
    fp.spawn(10, 10)
    fp.update(0.1); expect(fp.lastSubsteps).toBe(12)
    fp.update(1 / 60); expect(fp.lastSubsteps).toBe(2)
    fp.update(5); expect(fp.lastSubsteps).toBe(12)      // dt clamps to 0.1
    const calls = floor.calls
    fp.update(Number.NaN); fp.update(-1); fp.update(0)
    expect(floor.calls).toBe(calls)
  })
  it('lands and stays grounded on the floor', () => {
    const fp = makeFp(flatFloor(), 3)
    fp.spawn(10, 10)
    run(fp, 1)
    expect(fp.grounded).toBe(true)
    expect(fp.position[1]).toBe(0)
    expect(fp.velocity[1]).toBe(0)
  })
  it('reaches walking speed in ~0.2 s and stops as fast', () => {
    const fp = makeFp()
    fp.spawn(32, 32); run(fp, 0.1)
    fp.input.forward = 1
    run(fp, 0.2)
    expect(hSpeed(fp)).toBeGreaterThan(0.9 * 4.3)
    run(fp, 0.5)
    expect(hSpeed(fp)).toBeCloseTo(4.3, 2)
    expect(fp.velocity[2]).toBeLessThan(0)               // yaw 0 walks toward −z
    fp.input.forward = 0
    run(fp, 0.3)
    expect(hSpeed(fp)).toBeLessThan(0.1)
  })
  it('sprints only forward, and diagonals are no faster', () => {
    const fp = makeFp()
    fp.spawn(32, 32); run(fp, 0.1)
    Object.assign(fp.input, { forward: 1, sprint: true }); run(fp, 1)
    expect(hSpeed(fp)).toBeCloseTo(4.3 * 1.3, 2)
    Object.assign(fp.input, { forward: -1, sprint: true }); run(fp, 1)
    expect(hSpeed(fp)).toBeCloseTo(4.3, 2)
    Object.assign(fp.input, { forward: 1, right: 1, sprint: false }); run(fp, 1)
    expect(hSpeed(fp)).toBeCloseTo(4.3, 2)
  })
  it('jumps to ~1.25 blocks and lands', () => {
    const fp = makeFp()
    fp.spawn(10, 10); run(fp, 0.1)
    fp.input.jump = true
    fp.update(1 / 60)
    fp.input.jump = false
    let apex = 0
    for (let i = 0; i < 120; i++) { fp.update(1 / 60); apex = Math.max(apex, fp.position[1]) }
    expect(apex).toBeGreaterThan(1.15)
    expect(apex).toBeLessThanOrEqual(1.26)
    expect(fp.grounded).toBe(true)
  })
  it('does not jump in the air and caps the fall at terminal speed', () => {
    const fp = makeFp(flatFloor(-1000), 0)
    fp.spawn(10, 10)
    fp.input.jump = true
    run(fp, 3)
    expect(fp.velocity[1]).toBe(-50)
  })
  it('decays the eye offset', () => {
    const fp = makeFp()
    fp.spawn(10, 10)
    ;(fp as unknown as { eyeOffset: number }).eyeOffset = -1
    run(fp, 0.15)
    expect(Math.abs(fp.eyeLag)).toBeLessThan(0.06)
  })
})
```

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run test/firstPerson.test.ts > $SCRATCH/t3.log 2>&1`. Expected: FAIL (`update` is not a function).

- [ ] **Step 3: Implement.** Add to `FirstPersonController` (fields beside the others):

```ts
  private blockedH = false
  private readonly delta: [number, number, number] = [0, 0, 0]

  update(rawDt: number): void {
    const dt = Number.isFinite(rawDt) ? clamp(rawDt, 0, 0.1) : 0
    if (!(dt > 0)) { this.lastSubsteps = 0; return }
    this.recover()
    const n = Math.max(1, Math.ceil(dt / this.tuning.substep - 1e-9))
    const h = dt / n
    for (let i = 0; i < n; i++) this.step(h)
    this.lastSubsteps = n
    this.eyeOffset *= Math.exp(-dt / this.tuning.stepSmoothing)
    if (Math.abs(this.eyeOffset) < 1e-4) this.eyeOffset = 0
  }

  /** A body overlapping solid (an edit, a landed block) is lifted out; buried deeper than unstickUp, it stays put. */
  private recover(): void {
    const c = this.o.collision, box = this.box()
    if (!c.overlaps(box)) return
    const lift = c.unstick(box, this.tuning.unstickUp)
    if (lift === null || !(lift > 0)) return
    this.position[1] += lift
    this.eyeOffset -= lift
    if (this.velocity[1] < 0) this.velocity[1] = 0
  }

  private step(h: number): void {
    const t = this.tuning, c = this.o.collision, v = this.velocity, input = this.input
    const water = c.liquid(this.box(), this.position[1] + t.eye)
    const swimming = water.submerged >= t.swimThreshold
    const shallow = !swimming && water.submerged > 0
    this._swimming = swimming

    const [wx, wz] = wishDir(input.forward, input.right, this.yaw)
    const sprinting = input.sprint && input.forward > 0
    const speed = t.walk * (sprinting ? t.sprint : 1) * (swimming ? t.swimFactor : shallow ? t.shallowFactor : 1)
    const k = swimming ? t.accelSwim : this._grounded ? t.accelGround : t.accelAir
    const a = 1 - Math.exp(-k * h)
    v[0] += (wx * speed - v[0]) * a
    v[2] += (wz * speed - v[2]) * a

    const jumpSpeed = Math.sqrt(2 * t.gravity * t.jumpHeight)
    let jumped = false
    if (swimming) {
      v[1] += ((input.jump ? t.swimUp : -t.sink) - v[1]) * (1 - Math.exp(-t.swimAccel * h))
      if (input.jump && this.blockedH && !water.eyeUnder) { v[1] = jumpSpeed; jumped = true } // climb out onto a bank
    } else {
      if (input.jump && this._grounded) { v[1] = jumpSpeed; jumped = true }
      v[1] = Math.max(-t.terminal, v[1] - t.gravity * h)
    }

    const wasGrounded = this._grounded
    const d = this.delta
    d[0] = v[0] * h; d[1] = v[1] * h; d[2] = v[2] * h
    const r = c.move(this.box(), d, { stepHeight: wasGrounded && !swimming ? t.stepHeight : 0 })
    this.position[0] += r.dx; this.position[1] += r.dy; this.position[2] += r.dz
    if (r.blockedX) v[0] = 0
    if (r.blockedZ) v[2] = 0
    if (r.blockedY) v[1] = 0
    if (r.stepped > 0) this.eyeOffset -= r.stepped
    this.blockedH = r.blockedX || r.blockedZ
    this._grounded = r.grounded

    // Ground snap: walking off a ledge of ≤ snapDown follows it down instead of hopping.
    if (wasGrounded && !r.grounded && !jumped && !swimming && v[1] <= 0) {
      const drop = c.groundDistance(this.box(), t.snapDown)
      if (drop !== null && drop > 0) {
        d[0] = 0; d[1] = -drop; d[2] = 0
        const s = c.move(this.box(), d)
        this.position[1] += s.dy
        this.eyeOffset -= s.dy
        this._grounded = s.grounded
        v[1] = 0
      }
    }
  }
```

- [ ] **Step 4: Run to verify they pass** (the whole file). Run: `npx vitest run test/firstPerson.test.ts > $SCRATCH/t3.log 2>&1`. Expected: all pass. Rerun Task 2's tests too; they live in the same file.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/interact/firstPerson.ts packages/engine/test/firstPerson.test.ts
git commit -m "feat(camera): first-person movement: substeps, walk/sprint, jump, swim, step smoothing, ground snap"
```

---

### Task 4: Hand-off between orbit and first person

**Files:**
- Modify: `packages/engine/src/interact/firstPerson.ts`
- Test: `packages/engine/test/firstPerson.test.ts`

**Interfaces:**
- Consumes: `OrbitCamera` (`goal`, `current`, `enabled`, `minDistance`) from Task 1.
- Produces: `orbitToFirstPerson(orbit: OrbitCamera, fp: FirstPersonController): number` (returns the orbit distance to restore) and `firstPersonToOrbit(orbit: OrbitCamera, fp: FirstPersonController, distance: number): void`.

- [ ] **Step 1: Write the failing test**

```ts
import { OrbitCamera } from '../src/interact/orbitCamera.ts'
import { firstPersonToOrbit, orbitToFirstPerson } from '../src/interact/firstPerson.ts'

describe('orbit ⇄ first person hand-off', () => {
  it('starts the player at the orbit target and centres the orbit on the player on the way back', () => {
    const orbit = new OrbitCamera({ worldSize: [64, 64, 64] })
    for (const s of [orbit.goal, orbit.current]) { s.target = [20, 5, 30]; s.yaw = 1.2; s.distance = 150; s.pitch = 0.9 }
    const fp = makeFp(flatFloor(), 7)
    fp.enabled = false
    const remembered = orbitToFirstPerson(orbit, fp)
    expect(remembered).toBe(150)
    expect(fp.position).toEqual([20, 7, 30])
    expect(fp.yaw).toBe(1.2); expect(fp.pitch).toBe(0)
    expect(fp.enabled).toBe(true); expect(orbit.enabled).toBe(false)

    fp.position[0] = 25; fp.position[1] = 7; fp.position[2] = 33; fp.yaw = -0.4
    firstPersonToOrbit(orbit, fp, remembered)
    expect(orbit.goal.target).toEqual([25, 7, 33]); expect(orbit.current.target).toEqual([25, 7, 33])
    expect(orbit.goal.yaw).toBe(-0.4); expect(orbit.current.yaw).toBe(-0.4)
    expect(orbit.current.distance).toBe(8); expect(orbit.goal.distance).toBe(150)
    expect(orbit.goal.pitch).toBe(0.9)
    expect(fp.enabled).toBe(false); expect(orbit.enabled).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails.** Expected: FAIL (the exports are missing).

- [ ] **Step 3: Implement** (append to `firstPerson.ts`; add `import type { OrbitCamera } from './orbitCamera.ts'` at the top)

```ts
/** Orbit → first person: the player stands at the orbit target facing the orbit's way. Returns the orbit distance to restore. */
export function orbitToFirstPerson(orbit: OrbitCamera, fp: FirstPersonController): number {
  const t = orbit.current.target
  fp.spawn(t[0], t[2])
  fp.yaw = orbit.current.yaw
  fp.pitch = 0
  orbit.enabled = false
  fp.enabled = true
  return orbit.goal.distance
}

/** First person → orbit: centred on the player's feet, same yaw; the camera pulls back from the head to `distance`. */
export function firstPersonToOrbit(orbit: OrbitCamera, fp: FirstPersonController, distance: number): void {
  const [x, y, z] = fp.position
  for (const s of [orbit.goal, orbit.current]) {
    s.target[0] = x; s.target[1] = y; s.target[2] = z
    s.yaw = fp.yaw
  }
  orbit.current.distance = orbit.minDistance
  orbit.goal.distance = distance
  fp.enabled = false
  orbit.enabled = true
}
```

- [ ] **Step 4: Run to verify it passes** (the whole file plus `orbitCamera.test.ts`).

- [ ] **Step 5: Commit** `feat(camera): orbit ⇄ first-person hand-off`

---

### Task 5: Sandbox pure helpers (`isModeKey`, `placementTarget`)

**Files:**
- Create: `apps/sandbox/src/firstPerson.ts` (helpers only; the UI comes in Task 8)
- Test: `apps/sandbox/test/firstPerson.test.ts`

**Interfaces:**
- Produces:
  - `REACH = 5`
  - `KeyLike`, `FocusLike`
  - `isModeKey(e: KeyLike, focus: FocusLike | null): boolean`
  - `placementTarget(hit: { pos: readonly [n,n,n]; normal: readonly [n,n,n] } | null, inBounds: (x, y, z) => boolean, overlapsBody: (x, y, z) => boolean): [number, number, number] | null`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { isModeKey, placementTarget } from '../src/firstPerson.ts'

const key = (o: Partial<{ code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean }> = {}) =>
  ({ code: 'KeyC', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...o })

describe('isModeKey', () => {
  it('is a bare C press outside text fields', () => {
    expect(isModeKey(key(), null)).toBe(true)
    expect(isModeKey(key(), { tagName: 'BODY' })).toBe(true)
    expect(isModeKey(key(), { tagName: 'BUTTON' })).toBe(true)
    expect(isModeKey(key(), { tagName: 'INPUT', type: 'checkbox' })).toBe(true)
  })
  it('ignores other keys, modifiers, repeats and typing', () => {
    expect(isModeKey(key({ code: 'KeyV' }), null)).toBe(false)
    for (const m of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'repeat'] as const) expect(isModeKey(key({ [m]: true }), null)).toBe(false)
    expect(isModeKey(key(), { tagName: 'INPUT' })).toBe(false)
    expect(isModeKey(key(), { tagName: 'INPUT', type: 'number' })).toBe(false)
    expect(isModeKey(key(), { tagName: 'TEXTAREA' })).toBe(false)
    expect(isModeKey(key(), { tagName: 'SELECT' })).toBe(false)
    expect(isModeKey(key(), { tagName: 'DIV', isContentEditable: true })).toBe(false)
  })
})

describe('placementTarget', () => {
  const yes = () => true, no = () => false
  it('is the cell on the hit face', () => {
    expect(placementTarget({ pos: [4, 5, 6], normal: [0, 1, 0] }, yes, no)).toEqual([4, 6, 6])
    expect(placementTarget({ pos: [4, 5, 6], normal: [-1, 0, 0] }, yes, no)).toEqual([3, 5, 6])
  })
  it('refuses no hit, an inside hit, out of bounds and the player body', () => {
    expect(placementTarget(null, yes, no)).toBeNull()
    expect(placementTarget({ pos: [4, 5, 6], normal: [0, 0, 0] }, yes, no)).toBeNull()
    expect(placementTarget({ pos: [4, 5, 6], normal: [0, 1, 0] }, no, no)).toBeNull()
    expect(placementTarget({ pos: [4, 5, 6], normal: [0, 1, 0] }, yes, (x, y, z) => x === 4 && y === 6 && z === 6)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify they fail.** Run: `cd apps/sandbox && npx vitest run test/firstPerson.test.ts > $SCRATCH/t5.log 2>&1`. Expected: FAIL.

- [ ] **Step 3: Implement** `apps/sandbox/src/firstPerson.ts`

```ts
/** First-person dig/place reach, blocks (spec 4d §6). */
export const REACH = 5

export interface KeyLike { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean }
export interface FocusLike { tagName: string; type?: string; isContentEditable?: boolean }
const NOT_TEXT = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'color'])

/** A bare C press (no modifier, not a repeat) while focus is not in a text field. */
export function isModeKey(e: KeyLike, focus: FocusLike | null): boolean {
  if (e.code !== 'KeyC' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false
  if (!focus) return true
  if (focus.isContentEditable || focus.tagName === 'TEXTAREA' || focus.tagName === 'SELECT') return false
  return !(focus.tagName === 'INPUT' && !NOT_TEXT.has(focus.type ?? 'text'))
}

type V3 = readonly [number, number, number]
/** The cell a placement on `hit` fills, or null: no hit, a hit from inside, outside the world, or into the player. */
export function placementTarget(
  hit: { readonly pos: V3; readonly normal: V3 } | null,
  inBounds: (x: number, y: number, z: number) => boolean,
  overlapsBody: (x: number, y: number, z: number) => boolean,
): [number, number, number] | null {
  if (!hit) return null
  const [nx, ny, nz] = hit.normal
  if (nx === 0 && ny === 0 && nz === 0) return null
  const x = hit.pos[0] + nx, y = hit.pos[1] + ny, z = hit.pos[2] + nz
  if (!inBounds(x, y, z) || overlapsBody(x, y, z)) return null
  return [x, y, z]
}
```

- [ ] **Step 4: Run to verify they pass.**

- [ ] **Step 5: Commit** `feat(sandbox): first-person mode key filter and placement target`

---

### Task 6: Rebase onto `feat/collision`, then use the real collision

Gate: start only after the expert relays collision's "implementation green" SHA. Until then, continue with no task, or end the turn.

**Files:**
- Modify: `packages/engine/src/interact/firstPerson.ts` (the mirror types → imports)
- Test: `packages/engine/test/firstPerson.test.ts` (the real-collision describe)

**Interfaces:**
- Consumes: `bodyBox`, `bindCollision`, `type Box`, `type Collision`, `type CollisionWorld` from `src/interact/collision.ts`. `testRegistry`, `ID` from `test/helpers.ts`. `packVoxel` from `src/world/voxel.ts`.
- Produces: `CollisionLike = Pick<Collision, 'move' | 'overlaps' | 'groundDistance' | 'liquid' | 'unstick'>`. `FpBox` becomes an alias of `Box`.

- [ ] **Step 1: Rebase.** `git fetch` is not needed (it's a local branch). Run `git rebase <collision SHA>`. Spec/plan docs never conflict with collision's files. Run both suites: `npx vitest run > $SCRATCH/t6-rebase.log 2>&1` in `packages/engine`. Expected: all green.

- [ ] **Step 2: Swap the mirror types.** At the top of `firstPerson.ts`, replace the "collision, as consumed" block with the following and remove the now-unused mirror interfaces:

```ts
import { bodyBox, type Box, type Collision } from './collision.ts'
/** The part of engine.collision the controller uses (4c §3). */
export type CollisionLike = Pick<Collision, 'move' | 'overlaps' | 'groundDistance' | 'liquid' | 'unstick'>
export type FpBox = Box
```

`box()` becomes `return bodyBox(this.position[0], this.position[1], this.position[2], this.tuning.halfWidth, this.tuning.height)`. In the test stub, `flatFloor` keeps its shape; its `move` parameter type becomes `Vec3Like`-compatible. If typecheck complains, change the stub signature to `(box: FpBox, d: readonly [number, number, number] | { x: number; y: number; z: number })` and read `d` via `'x' in d ? d.y : d[1]`. Run `npx tsc --noEmit -p . > $SCRATCH/t6-tsc.log 2>&1`. Expected: clean.

- [ ] **Step 3: Write the real-collision tests** (they should mostly pass. Any failure is a real bug in Task 3's policy: debug it with superpowers:systematic-debugging, never by changing collision)

```ts
import { bindCollision } from '../src/interact/collision.ts'
import { packVoxel } from '../src/world/voxel.ts'
import { ID, testRegistry } from './helpers.ts'

const reg = testRegistry()
const WATER = packVoxel(ID.water, 7)
function world(size: [number, number, number] = [32, 32, 32]) {
  const cells = new Map<number, number>()
  const key = (x: number, y: number, z: number) => x + size[0] * (z + size[2] * y)
  const get = (x: number, y: number, z: number) => cells.get(key(x, y, z)) ?? 0
  const fill = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, v: number) => {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) cells.set(key(x, y, z), v)
  }
  fill(0, 0, 0, size[0] - 1, 3, size[2] - 1, ID.stone) // floor top at y = 4
  const fp = (tuning?: Partial<typeof FP_TUNING>) => new FirstPersonController({
    worldSize: size,
    collision: bindCollision({ size, get, solid: reg.solid, liquid: reg.liquid, source: reg.source }),
    surfaceAt: (x, z) => surfaceTop(get, reg.solid, reg.liquid, size, x, z),
    tuning,
  })
  return { size, get, fill, fp }
}
const settle = (p: FirstPersonController) => run(p, 0.2)

describe('FirstPersonController over 4c collision', () => {
  it('steps up a 1-block ledge with a smoothed eye, but not a 2-block one', () => {
    const w = world()
    w.fill(0, 4, 0, 31, 4, 10, ID.stone)                          // 1-high ledge for z ≤ 10
    const p = w.fp(); p.spawn(16.5, 14.5); settle(p)
    p.input.forward = 1
    let sawLag = false
    for (let i = 0; i < 120 && p.position[1] < 5; i++) { p.update(1 / 60); if (p.eyeLag < -0.5) sawLag = true }
    expect(p.position[1]).toBe(5)
    expect(sawLag).toBe(true)
    run(p, 0.3)
    expect(Math.abs(p.eyeLag)).toBeLessThan(0.01)

    const w2 = world()
    w2.fill(0, 4, 0, 31, 5, 10, ID.stone)                         // 2-high wall
    const q = w2.fp(); q.spawn(16.5, 14.5); settle(q)
    q.input.forward = 1; run(q, 2)
    expect(q.position[1]).toBe(4)
    expect(q.position[2]).toBeCloseTo(11.3, 5)
  })
  it('snaps down 1-block stairs but falls off a cliff', () => {
    const w = world()
    w.fill(0, 4, 12, 31, 4, 31, ID.stone)                         // ledge top 5 for z ≥ 12
    const p = w.fp(); p.spawn(16.5, 14.5); settle(p)
    expect(p.position[1]).toBe(5)
    p.input.forward = 1
    let airborne = 0
    for (let i = 0; i < 90; i++) { p.update(1 / 60); if (!p.grounded) airborne++ }
    expect(p.position[1]).toBe(4)
    expect(airborne).toBe(0)

    const c = world()
    c.fill(0, 4, 12, 31, 7, 31, ID.stone)                         // 4-high cliff
    const q = c.fp(); q.spawn(16.5, 14.5); settle(q)
    q.input.forward = 1
    let fell = 0
    for (let i = 0; i < 90; i++) { q.update(1 / 60); if (!q.grounded) fell++ }
    expect(q.position[1]).toBe(4)
    expect(fell).toBeGreaterThan(3)
  })
  it('swims up with Space, sinks without it, and wades slower in shallow water', () => {
    const w = world()
    w.fill(4, 4, 4, 27, 11, 27, WATER)                            // a pool 8 deep, surface at 12
    const p = w.fp(); p.spawn(16, 16)
    expect(p.position[1]).toBe(12)                                // spawned on the water, not the bed
    run(p, 3)
    expect(p.swimming).toBe(true)
    expect(p.velocity[1]).toBeCloseTo(-1, 1)                      // sinking
    p.input.jump = true; run(p, 1)
    expect(p.velocity[1]).toBeGreaterThan(2)                      // swimming up
    p.input.jump = false; run(p, 10)
    expect(p.position[1]).toBe(4)                                 // rests on the bed
    p.input.forward = 1; run(p, 1)
    expect(hSpeed(p)).toBeCloseTo(4.3 * 0.5, 1)

    const s = world()
    s.fill(0, 4, 0, 31, 4, 31, packVoxel(ID.water, 3))           // half a block deep
    const q = s.fp(); q.spawn(16, 16); settle(q)
    expect(q.swimming).toBe(false)
    q.input.forward = 1; run(q, 1)
    expect(hSpeed(q)).toBeCloseTo(4.3 * 0.75, 1)
  })
  it('climbs out of the water onto a 1-block bank', () => {
    const w = world()
    w.fill(0, 4, 0, 31, 9, 31, ID.stone)                          // ground top at 10
    w.fill(8, 4, 8, 23, 9, 23, WATER)                             // a pool in it, surface at 10
    const p = w.fp(); p.spawn(16, 12); run(p, 1)
    expect(p.swimming).toBe(true)
    Object.assign(p.input, { forward: 1, jump: true })            // toward −z, bank at z < 8
    for (let i = 0; i < 360 && !(p.grounded && p.position[1] === 10 && p.position[2] < 8); i++) p.update(1 / 60)
    expect(p.position[1]).toBe(10)
    expect(p.position[2]).toBeLessThan(8)
  })
  it('never tunnels through a 1-block floor at terminal speed with 0.1 s frames', () => {
    const w = world([32, 128, 32])
    w.fill(0, 0, 0, 31, 3, 31, 0)
    w.fill(0, 60, 0, 31, 60, 31, ID.stone)                         // a 1-block slab at y = 60
    const p = w.fp(); p.spawn(16, 16)
    p.position[1] = 120; p.velocity[1] = -50
    for (let i = 0; i < 40; i++) { p.update(0.1); expect(p.position[1]).toBeGreaterThanOrEqual(61) }
    expect(p.position[1]).toBe(61)
    expect(p.grounded).toBe(true)
  })
  it('is lifted out of a block placed into it, and stays put when buried deeper than 2', () => {
    const w = world()
    const p = w.fp(); p.spawn(16.5, 16.5); settle(p)
    w.fill(16, 4, 16, 16, 4, 16, ID.stone)
    p.update(1 / 60)
    expect(p.position[1]).toBe(5)

    const b = world()
    const q = b.fp(); q.spawn(16.5, 16.5); settle(q)
    b.fill(16, 4, 16, 16, 8, 16, ID.stone)                          // a 5-block pillar through the body
    q.update(1 / 60)
    expect(q.position).toEqual([16.5, 4, 16.5])                    // no lift possible within 2
    q.input.forward = 1; run(q, 1)
    expect(q.position[2]).toBeLessThan(15.7)                       // but it can walk out of the cells it is in
  })
  it('spawn on a column narrower than the body is unstuck on the first update', () => {
    const w = world()
    w.fill(17, 4, 16, 17, 4, 16, ID.stone)                          // the neighbour is 1 higher
    const p = w.fp(); p.spawn(16.9, 16.5)                           // body overlaps x = 17
    expect(p.position[1]).toBe(4)
    p.update(1 / 60)
    expect(p.position[1]).toBe(5)
  })
})
```

- [ ] **Step 4: Run, debug and fix until green.** Run: `npx vitest run test/firstPerson.test.ts > $SCRATCH/t6.log 2>&1`.

- [ ] **Step 5: Commit** `test(camera): first-person movement over the real 4c collision` (plus `refactor(camera): consume 4c collision types` if Step 2 was committed separately).

---

### Task 7: Engine wiring (camera block, `index.ts`)

**Files:**
- Modify: `packages/engine/src/engine.ts` (only the camera block: the interface lines after `readonly controls`, the controls creation, the Visuals `viewDistance`, the two frame-loop lines, dispose, the public object)
- Modify: `packages/engine/src/index.ts` (one appended line)

**Interfaces:**
- Consumes: `engine.collision` (4c's hunk, `const collision = bindCollision(...)` beside `world`). From Tasks 2–4: `FirstPersonController`, `orbitToFirstPerson`, `firstPersonToOrbit`, `surfaceTop`, `FP_FOV`, `FP_VIEW_DISTANCE`, `CameraMode`.
- Produces: `engine.firstPerson: FirstPersonController`, `engine.cameraMode: CameraMode`, `engine.setCameraMode(mode: CameraMode): void`.

- [ ] **Step 1: Interface.** After `readonly controls: OrbitCamera` in `interface Engine`:

```ts
  /** The first-person controller; drives the camera while cameraMode is 'firstPerson' (spec 4d). */
  readonly firstPerson: FirstPersonController
  readonly cameraMode: CameraMode
  /** Switches the camera controller with a hand-off: first person starts at the orbit target; orbit comes back centred on the player. */
  setCameraMode(mode: CameraMode): void
```

Import line after the OrbitCamera import:

```ts
import { FP_FOV, FP_VIEW_DISTANCE, FirstPersonController, firstPersonToOrbit, orbitToFirstPerson, surfaceTop, type CameraMode } from './interact/firstPerson.ts'
```

- [ ] **Step 2: Creation.** After `const detachControls = controls.attach(canvas)`:

```ts
  const firstPerson = new FirstPersonController({
    worldSize: size, collision,
    surfaceAt: (x, z) => surfaceTop(world.get, registry.solid, registry.liquid, size, x, z),
  })
  firstPerson.enabled = false
  const detachFirstPerson = firstPerson.attach(canvas)
  let cameraMode: CameraMode = 'orbit'
  let orbitDistance = controls.goal.distance
  const orbitFov = camera.fov
  const setCameraMode = (mode: CameraMode) => {
    if (mode !== 'orbit' && mode !== 'firstPerson') throw new TypeError(`setCameraMode expects 'orbit' or 'firstPerson', got ${String(mode)}`)
    if (mode === cameraMode) return
    if (mode === 'firstPerson') orbitDistance = orbitToFirstPerson(controls, firstPerson)
    else firstPersonToOrbit(controls, firstPerson, orbitDistance)
    cameraMode = mode
    camera.fov = mode === 'orbit' ? orbitFov : FP_FOV
    camera.updateProjectionMatrix()
  }
```

If 4c's `const collision = ...` sits after this point, move these lines below it rather than moving 4c's hunk.

- [ ] **Step 3: Visuals and the frame loop.**

`viewDistance: () => controls.current.distance,` → `viewDistance: () => cameraMode === 'orbit' ? controls.current.distance : FP_VIEW_DISTANCE,`

```ts
    controls.update(dt)
    controls.apply(camera)
```
→
```ts
    if (cameraMode === 'orbit') { controls.update(dt); controls.apply(camera) } else { firstPerson.update(dt); firstPerson.apply(camera) }
```

In `dispose`, after `detachControls()`, add `detachFirstPerson()`. In the public object, add a new line after `scene, camera, renderer, blocks: registry, layout, controls, world,`:

```ts
    firstPerson, get cameraMode() { return cameraMode }, setCameraMode,
```

- [ ] **Step 4: Export.** Append to `index.ts`:

```ts
export { FP_TUNING, FirstPersonController, type CameraMode, type FirstPersonTuning, type FpInput } from './interact/firstPerson.ts'
```

- [ ] **Step 5: Verify.** Run `npx tsc --noEmit -p . > $SCRATCH/t7-tsc.log 2>&1` and `npx vitest run > $SCRATCH/t7.log 2>&1` (engine). Expected: clean and green. Commit `feat(engine): first-person camera mode (engine.firstPerson, cameraMode, setCameraMode)`.

---

### Task 8: Sandbox first-person UI and wiring

**Files:**
- Modify: `apps/sandbox/src/firstPerson.ts` (add `createFirstPerson`)
- Modify: `apps/sandbox/src/main.ts` (import, `hotbarVoxel`, `createFirstPerson`, `__elovox.fp`)
- Modify: `apps/sandbox/src/hud.ts` (append ` · C first person` to the two default hints)

**Interfaces:**
- Consumes: `engine.firstPerson` (`eye()`, `forward()`, `cellOverlapsBody()`), `engine.cameraMode`, `engine.setCameraMode`, `engine.raycast`, `engine.on('frame')`, `engine.setHighlight`, `engine.submit`, `engine.layout.inBounds`. `isModeKey`, `placementTarget`, `REACH` from Task 5.
- Produces: `createFirstPerson(engine, canvas, { edits: boolean; voxel: () => number }): FirstPersonUi`, where `FirstPersonUi = { toggle(): void; dig(): boolean; place(): boolean; dispose(): void }`. `dig`/`place` return whether a command was submitted.

- [ ] **Step 1: Implement** (append to `apps/sandbox/src/firstPerson.ts`; add `import { AIR, type Engine } from '@elovox/engine'` at the top)

```ts
export interface FirstPersonUi {
  toggle(): void
  /** Digs / places along the crosshair; false when nothing was submitted (no hit, refused, or not allowed here). */
  dig(): boolean
  place(): boolean
  dispose(): void
}

const GATED = ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'contextmenu'] as const

/**
 * C toggles first person (pointer lock), shows a crosshair and hint, and routes canvas pointer events to
 * first person only: a capture-phase window listener stops them before the orbit, dig/highlight and units
 * handlers. `edits`: dig/place from the crosshair (off in the units scenes).
 */
export function createFirstPerson(engine: Engine, canvas: HTMLCanvasElement, o: { edits: boolean; voxel: () => number }): FirstPersonUi {
  const fp = engine.firstPerson
  const active = () => engine.cameraMode === 'firstPerson'
  const locked = () => document.pointerLockElement === canvas
  const lock = () => { void Promise.resolve(canvas.requestPointerLock()).catch(() => {}) }
  const centreHit = () => engine.raycast(fp.eye(), fp.forward(), REACH)

  const crosshair = document.createElement('div')
  crosshair.id = 'crosshair'
  Object.assign(crosshair.style, {
    position: 'fixed', left: '50%', top: '50%', width: '16px', height: '16px', transform: 'translate(-50%, -50%)',
    background: 'linear-gradient(#fff, #fff) center / 2px 16px no-repeat, linear-gradient(#fff, #fff) center / 16px 2px no-repeat',
    mixBlendMode: 'difference', pointerEvents: 'none', zIndex: '6', display: 'none',
  })
  const hint = document.createElement('div')
  hint.id = 'fp-hint'
  Object.assign(hint.style, {
    position: 'fixed', left: '50%', bottom: '12px', transform: 'translateX(-50%)', padding: '6px 10px', borderRadius: '6px',
    background: 'rgba(255, 255, 255, 0.82)', color: '#1b1f24', font: '12px/1.4 ui-monospace, Menlo, Consolas, monospace',
    whiteSpace: 'pre', textAlign: 'center', pointerEvents: 'none', zIndex: '6', display: 'none',
  })
  const HINT = `C orbit · WASD walk · Shift sprint · Space jump/swim${o.edits ? ' · LMB dig · RMB place' : ''} · Esc free mouse`
  const render = () => {
    const on = active()
    crosshair.style.display = on ? 'block' : 'none'
    hint.style.display = on ? 'block' : 'none'
    hint.textContent = on && !locked() ? `click to look\n${HINT}` : HINT
  }
  document.body.append(crosshair, hint)

  const dig = () => {
    if (!active() || !o.edits) return false
    const hit = centreHit()
    if (!hit) return false
    engine.submit({ type: 'setBlock', pos: hit.pos, voxel: AIR })
    return true
  }
  const place = () => {
    if (!active() || !o.edits) return false
    const p = placementTarget(centreHit(), (x, y, z) => engine.layout.inBounds(x, y, z), (x, y, z) => fp.cellOverlapsBody(x, y, z))
    if (!p) return false
    engine.submit({ type: 'setBlock', pos: p, voxel: o.voxel() })
    return true
  }
  const toggle = () => {
    if (active()) {
      if (locked()) document.exitPointerLock()
      engine.setCameraMode('orbit')
      engine.setHighlight(null)
    } else {
      engine.setCameraMode('firstPerson')
      lock()
    }
    render()
  }
  const gate = (e: Event) => {
    if (!active() || e.target !== canvas) return
    e.stopPropagation()
    if (e.type === 'wheel' || e.type === 'contextmenu') { e.preventDefault(); return }
    if (e.type !== 'pointerdown') return
    if (!locked()) { lock(); return } // the click that takes the mouse back never digs
    const button = (e as PointerEvent).button
    if (button === 0) dig()
    else if (button === 2) place()
  }
  const key = (e: KeyboardEvent) => { if (isModeKey(e, document.activeElement as FocusLike | null)) toggle() }
  const offFrame = engine.on('frame', () => { if (active() && o.edits) engine.setHighlight(centreHit()?.pos ?? null) })
  for (const t of GATED) window.addEventListener(t, gate, { capture: true, passive: false })
  window.addEventListener('keydown', key)
  document.addEventListener('pointerlockchange', render)
  render()
  return {
    toggle, dig, place,
    dispose() {
      offFrame()
      for (const t of GATED) window.removeEventListener(t, gate, { capture: true })
      window.removeEventListener('keydown', key)
      document.removeEventListener('pointerlockchange', render)
      crosshair.remove(); hint.remove()
    },
  }
}
```

- [ ] **Step 2: main.ts hunks.**
  - Import after `import { createTerrainPanel } ...`: `import { createFirstPerson } from './firstPerson.ts'`.
  - After `let selected = 0`: `const hotbarVoxel = () => { const id = engine.blocks.id(HOTBAR[selected]!); return engine.blocks.liquid[id] ? packVoxel(id, 7) : id }`.
  - Replace the two orbit RMB lines `const id = engine.blocks.id(HOTBAR[selected]!)` and `engine.submit({ type: 'setBlock', pos: p, voxel: engine.blocks.liquid[id] ? packVoxel(id, 7) : id })` with `engine.submit({ type: 'setBlock', pos: p, voxel: hotbarVoxel() })`. Behaviour is identical.
  - After the keydown listener: `const fp = editing ? null : createFirstPerson(engine, canvas, { edits: !unitsScene, voxel: hotbarVoxel })`.
  - In the final `Object.assign(window, { __elovox: { ... } })`, add `fp,` after `living,`.

- [ ] **Step 3: hud.ts hunk.** Append ` · C first person` to the end of both default hint literals: the workers line `'LMB select · … · Escape clear'` and the block line `` `block [...] … · V bean walk` ``.

- [ ] **Step 4: Verify.** Run `npm run typecheck > $SCRATCH/t8-tsc.log 2>&1` (repo root) and `cd apps/sandbox && npx vitest run > $SCRATCH/t8.log 2>&1`. Expected: clean and green. Then do a manual smoke on port 5183, which needs no window: `npm run dev -- --port 5183 --strictPort`. Open `/?size=128`, press C, walk, look, dig and place, press C again. Stop the server. Commit `feat(sandbox): first-person mode (C), crosshair, input gate and crosshair dig/place`.

---

### Task 9: e2e `first-person.spec.ts`

**Files:**
- Create: `apps/sandbox/e2e/first-person.spec.ts`

**Interfaces:**
- Consumes: `window.__elovox.{engine, fp}` (Tasks 7–8).

- [ ] **Step 1: Write the e2e**

```ts
import { expect, test, type Page } from '@playwright/test'
import type { Engine } from '@elovox/engine'
import type { FirstPersonUi } from '../src/firstPerson.ts'

type W = Window & { __elovox?: { engine: Engine; fp: FirstPersonUi | null; ready: boolean } }

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}
async function boot(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 90_000 })
}

test('first person: walk, jump, place refusal, place, dig, back to orbit', async ({ page }) => {
  const errors = watchErrors(page)
  await boot(page, '/?size=128&still')
  // A stone pad at y = 120 (top 121) above any terrain, with the orbit target at its centre.
  await page.evaluate(async () => {
    const e = (window as W).__elovox!.engine
    const seq = e.submit({ type: 'fillRegion', min: [8, 120, 8], max: [39, 120, 39], voxel: e.blocks.id('stone') })
    await new Promise<void>((res) => { const off = e.on('ack', (a) => { if (a.seq === seq) { off(); res() } }) })
    for (const s of [e.controls.goal, e.controls.current]) { s.target[0] = 24; s.target[2] = 24 }
  })
  await page.keyboard.press('c')
  const state = () => page.evaluate(() => {
    const { engine: e } = (window as W).__elovox!
    return { mode: e.cameraMode, fov: e.camera.fov, pos: [...e.firstPerson.position], grounded: e.firstPerson.grounded }
  })
  expect(await state()).toMatchObject({ mode: 'firstPerson', fov: 70 })
  await page.waitForFunction(() => { const f = (window as W).__elovox!.engine.firstPerson; return f.grounded && f.position[1] === 121 })

  // Walk toward −z for a second.
  await page.evaluate(() => { const f = (window as W).__elovox!.engine.firstPerson; f.yaw = 0; f.pitch = 0; f.input.forward = 1 })
  await page.waitForFunction(() => (window as W).__elovox!.engine.firstPerson.position[2] < 21, null, { timeout: 5_000 })
  await page.evaluate(() => { (window as W).__elovox!.engine.firstPerson.input.forward = 0 })
  const walked = await state()
  expect(walked.pos[1]).toBe(121)
  expect(walked.pos[0]).toBeCloseTo(24, 5)

  // Jump: rises above 122 and lands back on 121.
  const apex = await page.evaluate(() => new Promise<number>((res) => {
    const e = (window as W).__elovox!.engine, f = e.firstPerson
    let max = 0
    f.input.jump = true
    setTimeout(() => { f.input.jump = false }, 50)
    const off = e.on('frame', () => { max = Math.max(max, f.position[1]) })
    setTimeout(() => { off(); res(max) }, 1200)
  }))
  expect(apex).toBeGreaterThan(122)
  await page.waitForFunction(() => { const f = (window as W).__elovox!.engine.firstPerson; return f.grounded && f.position[1] === 121 })

  const r = await page.evaluate(async () => {
    const { engine: e, fp } = (window as W).__elovox!
    const f = e.firstPerson, stone = e.blocks.id('stone')
    const centre = () => e.raycast(f.eye(), f.forward(), 5)!
    f.pitch = -(Math.PI / 2 - 0.02)                    // straight down: the cell above the hit is the player's own
    const refused = fp!.place()
    f.pitch = -Math.atan2(1.62, 2.5)                    // the pad top 2.5 blocks ahead
    const a = centre().pos
    const placed = fp!.place()
    const ahead = e.world.get(a[0], a[1] + 1, a[2])   // a ghost edit reads back at once
    f.pitch = -(Math.PI / 2 - 0.02)
    const u = centre().pos
    const dug = fp!.dig()
    const under = e.world.get(u[0], u[1], u[2])
    return { refused, placed, aheadIsStone: ahead === stone, dug, under }
  })
  expect(r).toEqual({ refused: false, placed: true, aheadIsStone: true, dug: true, under: 0 })

  await page.keyboard.press('c')
  const back = await page.evaluate(() => {
    const e = (window as W).__elovox!.engine
    return { mode: e.cameraMode, fov: e.camera.fov, target: [...e.controls.goal.target], pos: [...e.firstPerson.position] }
  })
  expect(back).toMatchObject({ mode: 'orbit', fov: 50 })
  expect(back.target[0]).toBeCloseTo(back.pos[0]!, 5)
  expect(back.target[2]).toBeCloseTo(back.pos[2]!, 5)
  expect(errors).toEqual([])
})

test('first person in a units scene: look and walk, no dig/place, clicks submit nothing', async ({ page }) => {
  const errors = watchErrors(page)
  await boot(page, '/?scene=workers&still')
  await page.keyboard.press('c')
  await page.evaluate(() => {
    const e = (window as W).__elovox!.engine as Engine & { __submits?: number }
    const submit = e.submit.bind(e)
    e.__submits = 0
    e.submit = (c) => { e.__submits!++; return submit(c) }
  })
  const box = (await page.locator('canvas').boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  const r = await page.evaluate(() => {
    const { engine, fp } = (window as W).__elovox!
    return { mode: engine.cameraMode, dug: fp!.dig(), placed: fp!.place(), submits: (engine as Engine & { __submits?: number }).__submits }
  })
  expect(r).toEqual({ mode: 'firstPerson', dug: false, placed: false, submits: 0 })
  expect(errors).toEqual([])
})
```

- [ ] **Step 2: Run it** (there is no RED phase for an e2e written after the feature, so it must pass. If it fails, the bug is in Tasks 7–8). This needs no quiet window, because it is not a benchmark. If the expert has a HOLD active, wait for RELEASE.

Run: `cd apps/sandbox && E2E_PORT=5183 E2E_CHANNEL=msedge npm run e2e -- --workers=1 e2e/first-person.spec.ts > $SCRATCH/t9.log 2>&1` and read the log. Expected: 2 passed.

- [ ] **Step 3: Commit** `test(sandbox): first-person e2e (walk, jump, dig/place, units-scene gate)`

---

### Task 10: Full verification and report

- [ ] Engine and sandbox unit suites: `npm test > $SCRATCH/v-unit.log 2>&1` (root). Expected: all files pass.
- [ ] `npm run typecheck > $SCRATCH/v-tsc.log 2>&1`. Expected: no errors.
- [ ] Full e2e (outside any HOLD): `cd apps/sandbox && E2E_PORT=5183 E2E_CHANNEL=msedge npm run e2e -- --workers=1 > $SCRATCH/v-e2e.log 2>&1`. Expected: every spec passes (benches are skipped unless their env flag is set).
- [ ] Write `docs/superpowers/reviews/2026-10-08-first-person.md` only if the expert asks for a review file. Otherwise the report goes to the expert by message: branch, HEAD, the collision base SHA, results with log excerpts, and open items (the underwater tint/fog for lod; tunables pending the checkpoint).

---

### Task 11: Feel/visual checkpoint (user, through the expert)

- [ ] Send the expert a checkpoint request with how-to steps: `npm run dev -- --port 5183 --strictPort` in the fpcontrol worktree. Open `http://localhost:5183/?size=512` and `?scene=living`, press C, then try:
  - walk, sprint (Shift), jump (Space);
  - step-up onto 1-block terraces and down stairs;
  - swim in the lake/sea (Space up);
  - climb out onto a bank;
  - dig/place at the crosshair;
  - Esc, then click to re-lock;
  - C back to orbit.
- [ ] Ask the user to judge each of these numbers as OK, too low or too high:
  - walk 4.3, sprint ×1.3;
  - jump 1.25, gravity 30;
  - acceleration k (ground 14, air 3);
  - swim up 2.5, sink 1.0, swim ×0.5, shallow ×0.75;
  - step smoothing 0.05 s;
  - mouse sensitivity 0.0022 rad/px;
  - FOV 70;
  - first-person shadow reach (viewDistance 48 → 144 blocks).
- [ ] Apply the adjusted numbers to `FP_TUNING` / `FP_FOV` / `FP_VIEW_DISTANCE`, update any test that pins a changed default, rerun Task 10, and commit `tune(camera): first-person feel numbers from the user checkpoint`.
