import * as THREE from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { WaterMaterial } from '../src/render/water.ts'
import { SurfaceView } from '../src/render/water/surfaceView.ts'
import { WaterSurface } from '../src/render/water/waterSurface.ts'
import { createLightUniforms } from '../src/render/voxelLighting.ts'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { WaterPublisher } from '../src/sim/water/publish.ts'
import { createWaterBuffers } from '../src/world/waterBuffers.ts'

function published(sx: number, sz: number, floor: (x: number) => number, depth: (x: number) => number): SurfaceView {
  const b = createWaterBuffers([sx, 32, sz])
  const cols = new WaterColumns(sx, sz, new Int16Array(b.floor))
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) { cols.floor[x + z * sx] = floor(x); cols.depth[x + z * sx] = depth(x) }
  const view = new SurfaceView([sx, 32, sz], b, () => 15)
  view.apply(new WaterPublisher(b).publish(Array.from({ length: cols.tiles.count }, (_, t) => t), cols)!)
  return view
}
const mat = () => new THREE.MeshBasicMaterial()

describe('WaterSurface', () => {
  it('builds one instanced surface per chunk column with water, wired to the view\'s arrays with a row range', () => {
    const view = published(64, 32, () => 2, (x) => (x < 20 ? SUB : 0))
    const ws = new WaterSurface(32, view, mat(), mat())
    ws.update()
    expect(ws.meshCount).toBe(1)
    const mesh = ws.group.getObjectByName('water-0') as THREE.Mesh
    const geo = mesh.geometry as THREE.InstancedBufferGeometry
    expect(geo.instanceCount).toBe(1024)
    expect(geo.getAttribute('hCur').array).toBe(view.column(0)!.hCur)
    expect(geo.getAttribute('info').array).toBe(view.column(0)!.info)
    expect(mesh.position.toArray()).toEqual([0, 0, 0])
    expect(mesh.renderOrder).toBe(1)
    expect((geo.getAttribute('hCur') as THREE.BufferAttribute).updateRanges).toEqual([{ start: 0, count: 32 * 32 * 4 }])
  })

  it('sizes the curtain instances to the view\'s curtain list', () => {
    const view = published(32, 32, (x) => (x <= 10 ? 6 : 2), () => SUB)
    const ws = new WaterSurface(32, view, mat(), mat())
    ws.update()
    const curtains = ws.group.getObjectByName('water-0-curtains') as THREE.Mesh
    expect((curtains.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(32)
    expect(curtains.visible).toBe(true)
  })

  it('swaps the materials of every mesh', () => {
    const view = published(32, 32, () => 2, () => SUB)
    const ws = new WaterSurface(32, view, mat(), mat())
    ws.update()
    const a = mat(), b = mat()
    ws.setMaterials(a, b)
    expect((ws.group.getObjectByName('water-0') as THREE.Mesh).material).toBe(a)
    expect((ws.group.getObjectByName('water-0-curtains') as THREE.Mesh).material).toBe(b)
  })
})

describe('WaterMaterial', () => {
  it('builds the voxel, surface and curtain materials, stylised and plain', () => {
    const m = new WaterMaterial(createLightUniforms(), true)
    expect(m.curtain.side).toBe(THREE.DoubleSide)
    expect(m.plainCurtain.side).toBe(THREE.DoubleSide)
    expect(m.surface.transparent).toBe(true)
    expect(m.voxel.depthWrite).toBe(false)
    m.dispose()
  })
})
