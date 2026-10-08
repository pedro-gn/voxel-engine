import type { WorldSize } from '../world/layout.ts'
import { voxelId } from '../world/voxel.ts'
import type { OrbitCamera } from './orbitCamera.ts'

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
  private _grounded = false
  private _swimming = false
  private eyeOffset = 0
  private _enabled = true
  private readonly keys = new Set<string>()
  private blockedH = false
  private readonly delta: [number, number, number] = [0, 0, 0]

  constructor(private readonly o: FirstPersonOptions) {
    this.tuning = Object.freeze({ ...FP_TUNING, ...o.tuning })
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

  /** Advances the player by dt seconds (clamped to 0.1) in equal substeps of at most tuning.substep. */
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
    const filter = createLookFilter(this.tuning.sensitivity, this.tuning.maxLookPx)
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
