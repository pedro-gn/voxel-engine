import { describe, expect, it } from 'vitest'
import { OrbitCamera } from '../src/interact/orbitCamera.ts'

const make = (heightAt?: (x: number, z: number) => number) =>
  new OrbitCamera({ worldSize: [256, 128, 256], heightAt })

describe('OrbitCamera', () => {
  it('clamps pitch and distance', () => {
    const c = make()
    c.rotate(0, 10)
    expect(c.goal.pitch).toBe(1.45)
    c.rotate(0, -10)
    expect(c.goal.pitch).toBe(0.15)
    c.zoom(1e6)
    expect(c.goal.distance).toBe(400)
    c.zoom(-1e6)
    expect(c.goal.distance).toBe(8)
  })
  it('moves along the camera yaw', () => {
    const c = make()
    c.goal.target = [100, 0, 100]
    c.goal.yaw = 0
    c.move(1, 0, 1) // forward at yaw 0 is −z
    expect(c.goal.target[2]).toBeLessThan(100)
    expect(c.goal.target[0]).toBeCloseTo(100)
    c.goal.yaw = Math.PI / 2
    const z = c.goal.target[2]
    c.move(0, 1, 1) // right at yaw 90° is −z
    expect(c.goal.target[2]).toBeLessThan(z)
  })
  it('keeps the target inside the world', () => {
    const c = make()
    c.goal.target = [1, 0, 1]
    c.move(-1000, -1000, 1)
    for (const v of [c.goal.target[0], c.goal.target[2]]) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(256)
    }
  })
  it('damps toward the goal and follows the terrain height', () => {
    const c = make(() => 40)
    c.goal.target = [50, 0, 50]
    for (let i = 0; i < 120; i++) c.update(1 / 60)
    expect(c.current.target[0]).toBeCloseTo(50, 1)
    expect(c.current.target[1]).toBeCloseTo(40, 1)
  })
  it('places the camera on the orbit sphere', () => {
    const c = make()
    c.current.target = [0, 0, 0]
    c.current.yaw = 0
    c.current.pitch = 0
    c.current.distance = 10
    const seen: number[][] = []
    c.apply({ position: { set: (x, y, z) => seen.push([x, y, z]) }, lookAt: (x, y, z) => seen.push([x, y, z]) })
    expect(seen[0]![2]).toBeCloseTo(10)
    expect(seen[1]).toEqual([0, 0, 0])
  })
})

describe('OrbitCamera robustness', () => {
  const finite = (c: OrbitCamera) =>
    [...c.current.target, c.current.yaw, c.current.pitch, c.current.distance, ...c.goal.target].every(Number.isFinite)
  const press = (c: OrbitCamera) => (c as unknown as { keys: Set<string> }).keys.add('KeyW')
  it('ignores NaN and negative dt', () => {
    const c = make()
    press(c)
    const before = JSON.stringify([c.goal, c.current])
    c.update(NaN)
    c.update(-1)
    expect(finite(c)).toBe(true)
    expect(JSON.stringify([c.goal, c.current])).toBe(before)
  })
  it('caps a huge dt at 0.1 s', () => {
    const a = make(), b = make()
    press(a); press(b)
    a.update(60)
    b.update(0.1)
    expect(a.goal.target).toEqual(b.goal.target)
    expect(a.current.target).toEqual(b.current.target)
  })
  it('ends the drag only for the dragging pointer, and on cancel / lost capture', () => {
    const handlers = new Map<string, (e: unknown) => void>()
    const canvas = {
      addEventListener: (n: string, h: (e: unknown) => void) => handlers.set(n, h),
      removeEventListener: (n: string) => handlers.delete(n),
      setPointerCapture: () => {}, releasePointerCapture: () => {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    }
    const win = { addEventListener: () => {}, removeEventListener: () => {} }
    ;(globalThis as { window?: unknown }).window = win
    try {
      const c = make()
      const detach = c.attach(canvas as unknown as HTMLCanvasElement)
      const ev = (id: number, x: number) => ({ pointerId: id, button: 2, clientX: x, clientY: 500 })
      let x = 500
      const rotates = () => { const y = c.goal.yaw; x += 10; handlers.get('pointermove')!(ev(1, x)); return c.goal.yaw !== y }
      for (const end of ['pointercancel', 'lostpointercapture', 'pointerup']) {
        handlers.get('pointerdown')!(ev(1, x))
        handlers.get('pointerup')!(ev(2, x)) // another pointer: drag continues
        expect(rotates()).toBe(true)
        handlers.get(end)!(ev(1, x))
        expect(rotates()).toBe(false)
      }
      detach()
      expect(handlers.size).toBe(0)
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })
})
