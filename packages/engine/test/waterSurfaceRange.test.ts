import * as THREE from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { WaterSurface } from '../src/render/water/waterSurface.ts'
import { ColumnData } from '../src/render/water/surfaceView.ts'

/** A SurfaceView stand-in with what WaterSurface reads: 4 × 4 chunk columns, one draw layer, every column wet with one curtain. */
function fakeView() {
  const cx = 4, ccCount = 16
  const column = () => {
    const d = new ColumnData()
    d.info.fill(0); d.mark(0); d.mark(31); d.curtains.count = 1
    return d
  }
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
