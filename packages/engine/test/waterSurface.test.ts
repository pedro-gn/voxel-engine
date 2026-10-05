import * as THREE from 'three/webgpu'
import { describe, expect, it, vi } from 'vitest'
import { WaterMaterial } from '../src/render/water.ts'
import { ARC_REACH, ARC_SEGMENTS, CURTAIN_TOP, arcPoint } from '../src/render/water/surfaceMesh.ts'
import { SurfaceView } from '../src/render/water/surfaceView.ts'
import { curtainVertex, waterAlpha } from '../src/render/water/waterVertex.ts'
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
    for (const name of ['cPrev', 'cCur', 'cInfo', 'cReach']) expect((cgeo.getAttribute(name) as THREE.BufferAttribute).usage).toBe(THREE.StaticDrawUsage)
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
    expect(cgeo.getAttribute('cReach').array).toBe(d.curtains.reach)
    expect(cgeo.getAttribute('cReach').itemSize).toBe(4)
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

  it('draws each curtain as a strip of ARC_SEGMENTS segments that share their vertices, bounded past its chunk column by the reach', () => {
    const view = published(32, 32, (x) => (x <= 10 ? 6 : 2), () => SUB)
    const ws = new WaterSurface(32, view, mat(), mat())
    ws.update()
    const cgeo = (ws.group.getObjectByName('water-0-curtains') as THREE.Mesh).geometry as THREE.InstancedBufferGeometry
    const strip = cgeo.getAttribute('strip')
    expect(strip.itemSize).toBe(2)
    expect(strip.count).toBe(2 * (ARC_SEGMENTS + 1))
    expect(cgeo.getAttribute('position').count).toBe(strip.count)
    for (let k = 0; k <= ARC_SEGMENTS; k++) for (let side = 0; side < 2; side++) {
      expect([strip.getX(2 * k + side), strip.getY(2 * k + side)]).toEqual([k / ARC_SEGMENTS, side]) // (fall fraction, end A or B)
    }
    const index = [...cgeo.getIndex()!.array]
    expect(index.length).toBe(6 * ARC_SEGMENTS)
    for (let k = 0; k < ARC_SEGMENTS; k++) {
      // Segment k spans rows k and k + 1, both ends: its lower row is the next segment's upper row (no gap between them).
      expect([...new Set(index.slice(6 * k, 6 * k + 6))].sort((a, b) => a - b)).toEqual([2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 3])
    }
    const box = cgeo.boundingBox!
    expect(box.min.x).toBeLessThanOrEqual(-ARC_REACH - 1)
    expect(box.max.z).toBeGreaterThanOrEqual(32 + ARC_REACH + 1)
    expect(cgeo.boundingSphere!.containsPoint(new THREE.Vector3(-ARC_REACH - 1, 0, -ARC_REACH - 1))).toBe(true)
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

/** Builds the WGSL of `mesh`'s material in Node (no GPU): the node graph must resolve against its geometry. */
function wgsl(mesh: THREE.Mesh): { vertex: string; fragment: string } {
  const canvas = { width: 1, height: 1, style: {}, addEventListener() {}, removeEventListener() {}, getContext: () => null }
  const renderer = new THREE.WebGPURenderer({ canvas } as never)
  ;(renderer as unknown as { hasFeature: () => boolean }).hasFeature = () => false // no backend in Node
  // The typings leave out what the renderer sets on a builder before building it, and what it builds.
  const b = new THREE.WGSLNodeBuilder(mesh, renderer) as unknown as {
    material: THREE.Material; camera: THREE.Camera; scene: THREE.Scene; build(): void; vertexShader: string; fragmentShader: string
  }
  b.material = mesh.material as THREE.Material
  b.camera = new THREE.PerspectiveCamera()
  b.scene = new THREE.Scene()
  b.build()
  return { vertex: b.vertexShader, fragment: b.fragmentShader }
}

/**
 * Evaluates a TSL node graph on the CPU for given attribute values (each a number[]), component-wise: just the nodes the
 * curtain's position uses. A node it does not know fails the test rather than being guessed.
 */
function evaluate(node: unknown, attributes: Record<string, number[]>): number[] {
  const n = node as Record<string, unknown> & { constructor: { name: string } }
  const at = (v: number[], i: number) => v[v.length === 1 ? 0 : i]!
  const zip = (a: number[], b: number[], f: (x: number, y: number) => number) =>
    Array.from({ length: Math.max(a.length, b.length) }, (_, i) => f(at(a, i), at(b, i)))
  const e = (k: string) => evaluate(n[k], attributes)
  switch (n.constructor.name) {
    case 'VarNode': return e('node')
    case 'ConstNode': return [n.value as number]
    case 'UniformNode': return [n.value as number]
    case 'AttributeNode': return attributes[n._attributeName as string]!
    case 'JoinNode': return (n.nodes as unknown[]).flatMap((m) => evaluate(m, attributes))
    case 'SplitNode': { const v = e('node'); return [...(n.components as string)].map((c) => v['xyzw'.indexOf(c)]!) }
    case 'ConditionalNode': return e('condNode')[0] ? e('ifNode') : e('elseNode')
    case 'OperatorNode': {
      const ops: Record<string, (x: number, y: number) => number> = {
        '+': (x, y) => x + y, '-': (x, y) => x - y, '*': (x, y) => x * y, '/': (x, y) => x / y, '%': (x, y) => x % y,
        '<': (x, y) => +(x < y), '>': (x, y) => +(x > y), '<=': (x, y) => +(x <= y), '>=': (x, y) => +(x >= y), '&&': (x, y) => +(x && y),
      }
      const op = ops[n.op as string]
      if (!op) throw new Error(`operator ${n.op as string}`)
      return zip(e('aNode'), e('bNode'), op)
    }
    case 'MathNode': {
      const a = e('aNode')
      switch (n.method) {
        case 'floor': return a.map(Math.floor)
        case 'min': return zip(a, e('bNode'), Math.min)
        case 'max': return zip(a, e('bNode'), Math.max)
        case 'mix': { const b = e('bNode'), c = e('cNode'); return zip(a, b, (x) => x).map((x, i) => x + (at(b, i) - x) * at(c, i)) }
        default: throw new Error(`math ${n.method as string}`)
      }
    }
    default: throw new Error(`node ${n.constructor.name}`)
  }
}

describe('curtainVertex', () => {
  it('lays each end where arcPoint does: in front of the wall along its side, from its top down to its foot', () => {
    const position = curtainVertex().position
    const p = new Float64Array(2)
    const before = waterAlpha.value
    try {
      for (let dir = 0; dir < 4; dir++) for (const alpha of [0, 0.3, 1]) for (let k = 0; k <= ARC_SEGMENTS; k++) for (let end = 0; end < 2; end++) {
        const s = k / ARC_SEGMENTS
        const prev = [7, 7.5, 3, 3.25], cur = [6, 6.5, 2.5, 2], reach = [0.4, 0.9, 2.2, 1.6], info = [5, 9, dir + 4 * 37, 50]
        waterAlpha.value = alpha
        const got = evaluate(position, { strip: [s, end], cPrev: prev, cCur: cur, cReach: reach, cInfo: info })
        const mix = (a: number, b: number) => a + (b - a) * alpha
        arcPoint(mix(prev[end]!, cur[end]!), mix(prev[2 + end]!, cur[2 + end]!), mix(reach[end]!, reach[2 + end]!), s, p, 0)
        // The end's corner of the upper column (CURTAIN_TOP): its x and z offsets in the order (−x,−z) (+x,−z) (+x,+z) (−x,+z).
        const corner = CURTAIN_TOP[dir]![end]!, ex = corner === 1 || corner === 2 ? 1 : 0, ez = corner >= 2 ? 1 : 0
        const ox = [1, -1, 0, 0][dir]!, oz = [0, 0, 1, -1][dir]!
        const want = [5 + ex + ox * p[0]!, p[1]!, 9 + ez + oz * p[0]!]
        for (let i = 0; i < 3; i++) expect(got[i], `dir ${dir} α ${alpha} s ${s} end ${end}`).toBeCloseTo(want[i]!, 5)
      }
    } finally { waterAlpha.value = before }
  })
})

describe('WaterMaterial', () => {
  it('builds the curtain and surface shaders against their meshes\' attributes', () => {
    const warn = vi.spyOn(console, 'warn')
    try {
      const m = new WaterMaterial(createLightUniforms(), false) // depth effects need a GPU backend's depth texture
      const view = published(32, 32, (x) => (x <= 10 ? 6 : 2), () => SUB)
      const ws = new WaterSurface(32, view, m.surface, m.curtain)
      ws.update()
      for (const name of ['water-0', 'water-0-curtains']) {
        const { vertex, fragment } = wgsl(ws.group.getObjectByName(name) as THREE.Mesh)
        expect(vertex).toContain('@vertex')
        expect(fragment).toContain('@fragment')
      }
      ws.setMaterials(m.plainSurface, m.plainCurtain)
      wgsl(ws.group.getObjectByName('water-0-curtains') as THREE.Mesh)
      expect(warn).not.toHaveBeenCalled() // e.g. "Vertex attribute … not found on geometry"
      m.dispose()
    } finally { warn.mockRestore() }
  })

  it('builds the voxel, surface and curtain materials, stylised and plain', () => {
    const m = new WaterMaterial(createLightUniforms(), true)
    expect(m.curtain.side).toBe(THREE.DoubleSide)
    expect(m.plainCurtain.side).toBe(THREE.DoubleSide)
    expect(m.surface.transparent).toBe(true)
    expect(m.voxel.depthWrite).toBe(false)
    m.dispose()
  })
})
