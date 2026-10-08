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
  it('spawns on the surface inside the world, at rest', () => {
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
