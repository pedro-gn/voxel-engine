import { PerspectiveCamera } from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { distanceToPolyline, hitHorizontal, hitVertical, nearest, rayAt, toScreen } from '../src/ui/handles/pick.ts'

/** Looks from (0, 100, 100) at the origin; a 200 × 200 viewport. */
function camera(): PerspectiveCamera {
  const c = new PerspectiveCamera(60, 1, 0.1, 1000)
  c.position.set(0, 100, 100)
  c.lookAt(0, 0, 0)
  c.updateMatrixWorld()
  return c
}
const vp = { width: 200, height: 200 }

describe('toScreen', () => {
  it('projects the looked-at point to the centre and hides points behind the camera', () => {
    const s = toScreen({ x: 0, y: 0, z: 0 }, camera(), vp)!
    expect(s.x).toBeCloseTo(100)
    expect(s.y).toBeCloseTo(100)
    expect(toScreen({ x: 0, y: 200, z: 200 }, camera(), vp)).toBeNull()
  })

  it('puts a point to the right of the target right of centre', () => {
    expect(toScreen({ x: 10, y: 0, z: 0 }, camera(), vp)!.x).toBeGreaterThan(100)
  })
})

describe('rays and planes', () => {
  it('casts the centre ray onto the ground at the target', () => {
    const hit = hitHorizontal(rayAt(camera(), vp, { x: 100, y: 100 }), 0)!
    expect(hit.x).toBeCloseTo(0)
    expect(hit.z).toBeCloseTo(0)
  })

  it('round-trips a ground point through the screen', () => {
    const c = camera()
    const s = toScreen({ x: 12, y: 5, z: -7 }, c, vp)!
    const hit = hitHorizontal(rayAt(c, vp, s), 5)!
    expect(hit.x).toBeCloseTo(12)
    expect(hit.z).toBeCloseTo(-7)
  })

  it('misses a plane the ray is parallel to or points away from', () => {
    const c = camera()
    const ray = rayAt(c, vp, { x: 100, y: 100 })
    expect(hitHorizontal(ray, 150)).toBeNull() // above the camera, the ray goes down
    expect(hitHorizontal({ origin: ray.origin, dir: ray.dir.clone().setY(0) }, 0)).toBeNull()
  })

  it('reads a height on a vertical plane facing the camera', () => {
    const ray = rayAt(camera(), vp, { x: 100, y: 100 })
    expect(hitVertical(ray, { x: 0, z: 0 }, { x: 0, z: -1 })).toBeCloseTo(0)
    expect(hitVertical(ray, { x: 0, z: 0 }, { x: 1, z: 0 })).toBeNull() // plane parallel to the ray
  })
})

describe('nearest and distanceToPolyline', () => {
  it('picks the closest item within the radius', () => {
    const items = [{ id: 'a', p: { x: 10, y: 10 } }, { id: 'b', p: { x: 14, y: 10 } }, { id: 'c', p: null }]
    expect(nearest(items, (i) => i.p, { x: 13, y: 10 }, 5)?.id).toBe('b')
    expect(nearest(items, (i) => i.p, { x: 50, y: 50 }, 5)).toBeNull()
  })

  it('measures the distance to the nearest visible segment', () => {
    expect(distanceToPolyline({ x: 5, y: 3 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }], false)).toBeCloseTo(3)
    expect(distanceToPolyline({ x: 0, y: 5 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], true)).toBeCloseTo(Math.SQRT1_2 * 5)
    expect(distanceToPolyline({ x: 0, y: 0 }, [{ x: 0, y: 0 }, null], false)).toBe(Infinity)
  })
})
