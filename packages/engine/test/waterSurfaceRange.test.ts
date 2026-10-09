import * as THREE from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { WaterSurface } from '../src/render/water/waterSurface.ts'

/** A SurfaceView stand-in with what WaterSurface reads: 4 × 4 chunk columns, one draw layer, every column wet with one curtain. */
function fakeView() {
  const cx = 4, ccCount = 16
  const column = () => ({
    hPrev: new Float32Array(4096), hCur: new Float32Array(4096), info: new Float32Array(4096), rowLo: 0, rowHi: 31,
    curtains: {
      prev: new Float32Array(4), cur: new Float32Array(4), reach: new Float32Array(4), thick: new Float32Array(4),
      flare: new Float32Array(4), info: new Float32Array(4), count: 1, generation: 0,
    },
  })
  const cols = Array.from({ length: ccCount }, column)
  let dirty = cols.map((_, i) => i)
  return { cx, ccCount, column: (cc: number) => cols[cc], takeDirty: () => { const d = dirty; dirty = []; return d } }
}

describe('WaterSurface.setRange (view distance)', () => {
  it('hides chunk columns beyond the range, new slots follow the last range, and Infinity shows them again', () => {
    const w = new WaterSurface(128, fakeView() as never, new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial())
    w.setRange({ x: 16, y: 60, z: 16 }, 64) // before any slot exists
    w.update()
    const get = (name: string) => w.group.getObjectByName(name)!
    expect(get('water-0-0').visible).toBe(true) // the column the eye stands in
    expect(get('water-0-0-curtains').visible).toBe(true)
    expect(get('water-0-3').visible).toBe(false) // x from 96: 80 away
    expect(get('water-0-3-curtains').visible).toBe(false)
    expect(get('water-0-5').visible).toBe(true) // (32, 32): 16√2 away
    w.setRange({ x: 16, y: 60, z: 16 }, Infinity)
    expect(get('water-0-3').visible).toBe(true)
    expect(get('water-0-3-curtains').visible).toBe(true)
    w.setRange({ x: 16, y: 60, z: 16 }, 64)
    expect(get('water-0-3').visible).toBe(false)
  })
})
