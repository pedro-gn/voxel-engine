import { describe, expect, it } from 'vitest'
import { OrbitCamera } from '../src/interact/orbitCamera.ts'

const make = (heightAt?: (x: number, z: number) => number) =>
  new OrbitCamera({ worldSize: [256, 128, 256], heightAt })

describe('OrbitCamera', () => {
  it('reset() returns to the home yaw and pitch, keeps the target and distance, takes the short way round', () => {
    const cam = new OrbitCamera({ worldSize: [256, 100, 256], yaw: 0.5, pitch: 0.9 })
    cam.goal.target = [40, 0, 60]
    cam.rotate(2 * Math.PI * 3 + 1, -0.3) // three turns and a bit
    cam.zoom(500)
    const d = cam.goal.distance
    cam.reset()
    expect(cam.goal.pitch).toBeCloseTo(0.9)
    expect(Math.abs(cam.goal.yaw - cam.current.yaw)).toBeLessThanOrEqual(Math.PI) // never spins several turns back
    expect(((cam.goal.yaw - 0.5) / (2 * Math.PI)) % 1).toBeCloseTo(0)
    expect(cam.goal.target).toEqual([40, 0, 60])
    expect(cam.goal.distance).toBe(d)
  })
  it('starts at its home view', () => {
    const cam = new OrbitCamera({ worldSize: [256, 100, 256], yaw: 2, pitch: 1, distance: 120 })
    expect([cam.goal.yaw, cam.goal.pitch, cam.goal.distance]).toEqual([2, 1, 120])
    expect([cam.current.yaw, cam.current.pitch, cam.current.distance]).toEqual([2, 1, 120])
  })
  it('takes pitch and distance limits from its options', () => {
    const cam = new OrbitCamera({ worldSize: [256, 100, 256], minPitch: 0.6, maxPitch: 1.1, minDistance: 20, maxDistance: 150 })
    cam.rotate(0, 5); expect(cam.goal.pitch).toBe(1.1)
    cam.zoom(1e6); expect(cam.goal.distance).toBe(150)
  })
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
  it('exposes its minimum distance read-only', () => {
    const c = make()
    expect(c.minDistance).toBe(8)
    expect(() => { (c as unknown as { minDistance: number }).minDistance = 3 }).toThrow(TypeError)
  })
  it('handlers ignore events while disabled and behave identically once re-enabled', () => {
    const rig = () => {
      const handlers = new Map<string, (e: unknown) => void>()
      const canvas = {
        addEventListener: (n: string, h: (e: unknown) => void) => handlers.set(n, h),
        removeEventListener: (n: string) => handlers.delete(n),
        setPointerCapture: () => {}, releasePointerCapture: () => {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
      }
      return { handlers, canvas: canvas as unknown as HTMLCanvasElement }
    }
    const winHandlers = new Map<string, Set<(e: unknown) => void>>()
    ;(globalThis as { window?: unknown }).window = {
      addEventListener: (n: string, h: (e: unknown) => void) => { if (!winHandlers.has(n)) winHandlers.set(n, new Set()); winHandlers.get(n)!.add(h) },
      removeEventListener: (n: string, h: (e: unknown) => void) => winHandlers.get(n)?.delete(h),
    }
    try {
      const a = make(), b = make()
      const ra = rig(), rb = rig()
      const da = a.attach(ra.canvas), db = b.attach(rb.canvas)
      const script = (r: ReturnType<typeof rig>, x0: number) => {
        r.handlers.get('pointerdown')!({ pointerId: 1, button: 2, clientX: x0, clientY: 500 })
        r.handlers.get('pointermove')!({ pointerId: 1, clientX: x0 + 40, clientY: 530 })
        r.handlers.get('pointerup')!({ pointerId: 1, button: 2, clientX: x0 + 40, clientY: 530 })
        r.handlers.get('wheel')!({ deltaY: 300, preventDefault: () => {} })
        r.handlers.get('pointermove')!({ pointerId: 2, clientX: 2, clientY: 500 }) // left edge
      }
      a.enabled = false
      script(ra, 500)
      for (const h of winHandlers.get('keydown')!) h({ code: 'KeyW' })
      a.update(0.05)
      expect(a.goal).toEqual(make().goal)                         // nothing reached the disabled camera
      a.enabled = true
      const keysOf = (c: unknown) => (c as { keys: Set<string> }).keys
      keysOf(b).clear() // the shared window keydown above reached b (enabled): reset so both start equal
      script(ra, 500); script(rb, 500)
      a.update(0.05); b.update(0.05)
      expect(a.goal).toEqual(b.goal)
      expect(a.current).toEqual(b.current)
      da(); db()
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })
})
