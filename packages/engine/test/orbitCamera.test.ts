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
