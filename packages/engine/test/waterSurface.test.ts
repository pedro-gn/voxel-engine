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

/** A 32 × 32 world with water everywhere: `publish(tiles)` publishes and applies those tiles (all by default). */
function world(floor: (x: number) => number, depth: number) {
  const b = createWaterBuffers([32, 32, 32])
  const cols = new WaterColumns(32, 32, new Int16Array(b.floor))
  const set = (f: (x: number, z: number) => number, d: (x: number, z: number) => number) => {
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) { cols.floor[x + z * 32] = f(x, z); cols.depth[x + z * 32] = d(x, z) }
  }
  set((x) => floor(x), () => depth)
  const view = new SurfaceView([32, 32, 32], b, () => 15)
  const pub = new WaterPublisher(b)
  const publish = (tiles: number[] = [0, 1, 2, 3]) => { expect(view.apply(pub.publish(tiles, cols)!)).toBe(true) }
  publish()
  return { cols, view, publish, set }
}

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

  it('uploads on demand only: its attributes are static, so three does not rewrite them every frame', () => {
    const { view } = world(() => 2, SUB)
    const ws = new WaterSurface(32, view, mat(), mat())
    ws.update()
    const geo = (ws.group.getObjectByName('water-0') as THREE.Mesh).geometry as THREE.InstancedBufferGeometry
    for (const name of ['hPrev', 'hCur', 'info']) expect((geo.getAttribute(name) as THREE.BufferAttribute).usage).toBe(THREE.StaticDrawUsage)
    const cgeo = (ws.group.getObjectByName('water-0-curtains') as THREE.Mesh).geometry as THREE.InstancedBufferGeometry
    for (const name of ['cPrev', 'cCur', 'cInfo']) expect((cgeo.getAttribute(name) as THREE.BufferAttribute).usage).toBe(THREE.StaticDrawUsage)
  })

  it('merges the rows of several updates into one range until three uploads them', () => {
    const { cols, view, publish } = world(() => 2, SUB)
    publish([]) // the settling pass
    const ws = new WaterSurface(32, view, mat(), mat())
    ws.update()
    const hCur = ((ws.group.getObjectByName('water-0') as THREE.Mesh).geometry as THREE.InstancedBufferGeometry).getAttribute('hCur') as THREE.BufferAttribute
    hCur.clearUpdateRanges() // as three does once it has uploaded them
    for (let z = 16; z < 32; z++) for (let x = 0; x < 16; x++) cols.depth[x + z * 32] = 2 * SUB
    publish([2]) // tile (0, 1): rows 15..31 (its ring row 15 included)
    ws.update()
    expect(hCur.updateRanges).toEqual([{ start: 15 * 128, count: 17 * 128 }])
    publish([]) // settles tile 2: the same rows
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) cols.depth[x + z * 32] = 2 * SUB
    publish([0]) // tile (0, 0): rows 0..16
    ws.update()
    expect(hCur.updateRanges).toEqual([{ start: 0, count: 32 * 128 }])
  })

  it('wires the new curtain arrays when the view grows them', () => {
    const { view, publish, set } = world(() => 2, SUB)
    const ws = new WaterSurface(32, view, mat(), mat())
    ws.update()
    const d = view.column(0)!, before = d.curtains.generation
    const curtains = ws.group.getObjectByName('water-0-curtains') as THREE.Mesh
    expect(curtains.visible).toBe(false)
    set((x) => (x <= 10 ? 6 : 2), () => SUB) // a ledge: 32 curtains, more than the 16 the arrays hold
    publish()
    ws.update()
    expect(d.curtains.generation).toBeGreaterThan(before)
    const cgeo = curtains.geometry as THREE.InstancedBufferGeometry
    expect(cgeo.getAttribute('cPrev').array).toBe(d.curtains.prev)
    expect(cgeo.getAttribute('cCur').array).toBe(d.curtains.cur)
    expect(cgeo.getAttribute('cInfo').array).toBe(d.curtains.info)
    expect(cgeo.instanceCount).toBe(32)
    expect(curtains.visible).toBe(true)
  })

  it('hides the surface of a chunk column that dried out, and shows it again when water comes back', () => {
    const { view, publish, set } = world(() => 2, SUB)
    const ws = new WaterSurface(32, view, mat(), mat())
    ws.update()
    const surface = ws.group.getObjectByName('water-0') as THREE.Mesh
    expect(surface.visible).toBe(true)
    set(() => 2, () => 0)
    publish()
    ws.update()
    expect(surface.visible).toBe(true) // still sinking into the ground
    publish([])
    ws.update()
    expect(surface.visible).toBe(false)
    set(() => 2, (x, z) => (x === 5 && z === 5 ? SUB : 0))
    publish()
    ws.update()
    expect(surface.visible).toBe(true)
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
