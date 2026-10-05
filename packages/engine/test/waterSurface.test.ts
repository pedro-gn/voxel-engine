import * as THREE from 'three/webgpu'
import { describe, expect, it, vi } from 'vitest'
import { WaterMaterial } from '../src/render/water.ts'
import {
  ARC_GAP, ARC_REACH, ARC_SEGMENTS, CURTAIN_TOP, SPLASH_LIFT, arcPoint, backPoint, flareAmount, flareCode, flareOpen, packFlux, splashCode,
  lipCode, splashHalfOf, splashSlopeOf,
} from '../src/render/water/surfaceMesh.ts'
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
    for (const name of ['cPrev', 'cCur', 'cInfo', 'cReach', 'cThick', 'cFlare']) expect((cgeo.getAttribute(name) as THREE.BufferAttribute).usage).toBe(THREE.StaticDrawUsage)
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
    expect(cgeo.getAttribute('cThick').array).toBe(d.curtains.thick)
    expect(cgeo.getAttribute('cFlare').array).toBe(d.curtains.flare)
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

  it('draws each curtain as a body: front and back faces and a side face at each end, of ARC_SEGMENTS segments that share their vertices, and a splash, bounded past its chunk column by the reach', () => {
    const view = published(32, 32, (x) => (x <= 10 ? 6 : 2), () => SUB)
    const ws = new WaterSurface(32, view, mat(), mat())
    ws.update()
    const cgeo = (ws.group.getObjectByName('water-0-curtains') as THREE.Mesh).geometry as THREE.InstancedBufferGeometry
    const strip = cgeo.getAttribute('strip')
    const rows = ARC_SEGMENTS + 1
    expect(strip.itemSize).toBe(4)
    expect(strip.count).toBe(8 * rows + 6)
    expect(cgeo.getAttribute('position').count).toBe(strip.count)
    const vertex = (v: number) => [strip.getX(v), strip.getY(v), strip.getZ(v), strip.getW(v)] // (s, end, face, kind)
    for (let k = 0; k < rows; k++) for (let end = 0; end < 2; end++) for (let face = 0; face < 2; face++) {
      expect(vertex(face * rows * 2 + k * 2 + end)).toEqual([k / ARC_SEGMENTS, end, face, 0]) // front, back
      expect(vertex(4 * rows + end * rows * 2 + k * 2 + face)).toEqual([k / ARC_SEGMENTS, end, face, 1]) // sides, front edge then back edge
    }
    for (let row = 0; row < 3; row++) for (let end = 0; end < 2; end++) expect(vertex(8 * rows + row * 2 + end)).toEqual([row - 1, end, 0, 2])
    const index = [...cgeo.getIndex()!.array]
    expect(index.length).toBe(6 * ARC_SEGMENTS * 4 + 12)
    const quad = (n: number) => [...new Set(index.slice(6 * n, 6 * n + 6))].sort((a, b) => a - b)
    for (let k = 0; k < ARC_SEGMENTS; k++) {
      // Segment k of each face spans rows k and k + 1, both ends: its lower row is the next segment's upper row (no gap).
      const front = [2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 3], back = front.map((v) => v + 2 * rows)
      const sideA = [0, 1, 2, 3].map((v) => 4 * rows + 2 * k + v), sideB = sideA.map((v) => v + 2 * rows)
      expect([quad(4 * k), quad(4 * k + 1), quad(4 * k + 2), quad(4 * k + 3)]).toEqual([front, back, sideA, sideB])
    }
    // The splash: two quads across the foot, rows −1, 0 and 0, 1.
    const splash = (row: number) => [8 * rows + 2 * row, 8 * rows + 2 * row + 1, 8 * rows + 2 * row + 2, 8 * rows + 2 * row + 3]
    expect([quad(4 * ARC_SEGMENTS), quad(4 * ARC_SEGMENTS + 1)]).toEqual([splash(0), splash(1)])
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
 * curtain's position uses. A node it does not know fails the test rather than being guessed. Each node is evaluated once per
 * call (`done`): the graph shares its nodes widely.
 */
function evaluate(node: unknown, attributes: Record<string, number[]>, done = new Map<unknown, number[]>()): number[] {
  const known = done.get(node)
  if (known) return known
  const value = evaluateNode(node, attributes, done)
  done.set(node, value)
  return value
}

function evaluateNode(node: unknown, attributes: Record<string, number[]>, done: Map<unknown, number[]>): number[] {
  const n = node as Record<string, unknown> & { constructor: { name: string } }
  const at = (v: number[], i: number) => v[v.length === 1 ? 0 : i]!
  const zip = (a: number[], b: number[], f: (x: number, y: number) => number) =>
    Array.from({ length: Math.max(a.length, b.length) }, (_, i) => f(at(a, i), at(b, i)))
  const e = (k: string) => evaluate(n[k], attributes, done)
  switch (n.constructor.name) {
    case 'VarNode': case 'VaryingNode': case 'SubBuildNode': return e('node')
    case 'ConstNode': { const c = n.value as number | { toArray(): number[] }; return typeof c === 'number' ? [c] : c.toArray() }
    case 'UniformNode': return [n.value as number]
    case 'AttributeNode': return attributes[n._attributeName as string]!
    case 'JoinNode': return (n.nodes as unknown[]).flatMap((m) => evaluate(m, attributes, done))
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
        case 'sqrt': return a.map(Math.sqrt)
        case 'abs': return a.map(Math.abs)
        case 'min': return zip(a, e('bNode'), Math.min)
        case 'max': return zip(a, e('bNode'), Math.max)
        case 'step': return zip(a, e('bNode'), (edge, x) => +(x >= edge))
        case 'smoothstep': { const b = e('bNode'), c = e('cNode'); return c.map((x, i) => { const t = Math.min(1, Math.max(0, (x - at(a, i)) / (at(b, i) - at(a, i)))); return t * t * (3 - 2 * t) }) }
        case 'normalize': { const l = Math.hypot(...a); return a.map((x) => x / l) }
        case 'mix': { const b = e('bNode'), c = e('cNode'); return zip(a, b, (x) => x).map((x, i) => x + (at(b, i) - x) * at(c, i)) }
        default: throw new Error(`math ${n.method as string}`)
      }
    }
    default: throw new Error(`node ${n.constructor.name}`)
  }
}

describe('curtainVertex', () => {
  it('lays every vertex of the body and the splash where the CPU formulas do', () => {
    const position = curtainVertex().position
    const p = new Float64Array(2), q = new Float64Array(2)
    const before = waterAlpha.value
    let checked = 0
    try {
      for (let dir = 0; dir < 4; dir++) for (const alpha of [0, 0.3, 1]) {
        // Flares (A prev, B prev, A cur, B cur) as stored: open or shared, with their widening; the splash bytes of both ends.
        for (const [flare, splash] of [
          [[flareCode(1, 0.5), flareCode(1, 0.3), flareCode(1, 0.4), flareCode(1, 0.1)], [splashCode(0.5, 0.25), splashCode(0.3, -0.5)]],
          [[flareCode(0, 0), flareCode(1, 0.2), flareCode(0, 0.4), flareCode(0.5, 0.5)], [splashCode(0.75, 0.875), splashCode(0.1, -1)]],
          [[flareCode(1, 0.5), flareCode(0.4, 0.1), flareCode(0, 0), flareCode(0, 0)], [splashCode(0, 0), splashCode(0.4, 0.125)]],
        ] as [number[], number[]][]) {
          const prev = [7, 7.5, 3, 3.25], cur = [6, 6.5, 2.5, 2], reach = [0.4, 0.9, 2.2, 1.6], thick = [0.1, 0.4, 0.3, 0.5]
          // Column (5, 9), its ends' brinks 0.75 and 1.25 blocks deep; water at end B only.
          const lips = [0.75, 1.25]
          const info = [lipCode(5, lips[0]!), lipCode(9, lips[1]!), dir + 4 * (37 + 256 * 2), packFlux(50, splash[0]!, splash[1]!)]
          const mixed = (a: number, b: number) => a + (b - a) * alpha
          waterAlpha.value = alpha
          const ox = [1, -1, 0, 0][dir]!, oz = [0, 0, 1, -1][dir]!
          // The ends' corners of the upper column (CURTAIN_TOP), in the order (−x,−z) (+x,−z) (+x,+z) (−x,+z).
          const corner = (end: number) => { const c = CURTAIN_TOP[dir]![end]!; return [c === 1 || c === 2 ? 1 : 0, c >= 2 ? 1 : 0] as const }
          const vertices: number[][] = [] // (s, end, face, kind)
          for (let k = 0; k <= ARC_SEGMENTS; k++) for (let end = 0; end < 2; end++) for (let face = 0; face < 2; face++) {
            vertices.push([k / ARC_SEGMENTS, end, face, 0], [k / ARC_SEGMENTS, end, face, 1])
          }
          for (let row = -1; row <= 1; row++) for (let end = 0; end < 2; end++) vertices.push([row, end, 0, 2])
          for (const [s, end, face, kind] of vertices as [number, number, number, number][]) {
            const got = evaluate(position, { strip: [s, end, face, kind], cPrev: prev, cCur: cur, cReach: reach, cThick: thick, cFlare: flare, cInfo: info })
            const top = mixed(prev[end]!, cur[end]!), foot = mixed(prev[2 + end]!, cur[2 + end]!), r = mixed(reach[end]!, reach[2 + end]!)
            const t = mixed(thick[end]!, thick[2 + end]!), fp = flare[end]!, fc = flare[2 + end]!
            const open = mixed(flareOpen(fp), flareOpen(fc)), amount = mixed(flareAmount(fp), flareAmount(fc))
            let u: number, y: number, along: number
            if (kind === 2) {
              // The splash: across the landing column, about the landing point, as wide as its byte says, at the foot plus the
              // slope of the water along the fall from the landing point, a little up.
              const land = ARC_GAP + r, base = Math.floor(land), byte = splash[end]!
              u = Math.min(base + 1, Math.max(Math.max(base, ARC_GAP), land + s * splashHalfOf(byte)))
              y = foot + splashSlopeOf(byte) * (u - land) + SPLASH_LIFT
              along = amount
            } else {
              // A side face's back edge is only as thick and as deep under the arc as it is open; the front is the arc itself.
              const shut = kind === 1 ? open : 1
              backPoint(top, foot, r, face === 0 ? 0 : t * shut, s, p, 0, face === 0 ? 0 : lips[end]! * shut)
              u = p[0]!
              y = p[1]!
              along = amount * s
            }
            const [ex, ez] = corner(end), [fx, fz] = corner(1 - end)
            const want = [5 + ex + ox * u + (ex - fx) * along, y, 9 + ez + oz * u + (ez - fz) * along]
            for (let i = 0; i < 3; i++) expect(got[i], `dir ${dir} α ${alpha} s ${s} end ${end} face ${face} kind ${kind} [${i}]`).toBeCloseTo(want[i]!, 5)
            checked++
          }
        }
      }
    } finally { waterAlpha.value = before }
    expect(checked).toBe(4 * 3 * 3 * (9 * 2 * 2 * 2 + 6))
  })

  it('shows no splash while the drawn foot is away from the current one (a curtain unrolling), and the full splash once it has settled (4)', () => {
    const alphaNode = curtainVertex().alpha
    const before = waterAlpha.value
    try {
      const splash = (prevFoot: number, a: number) => {
        waterAlpha.value = a
        // End A, row 0 of the splash, water under it (bit 0), a wide fall; the foot is 3 now, and was `prevFoot` before.
        const attributes = {
          strip: [0, 0, 0, 2], cPrev: [7, 7, prevFoot, prevFoot], cCur: [7, 7, 3, 3], cReach: [1, 1, 1, 1], cThick: [0.3, 0.3, 0.3, 0.3],
          cFlare: [flareCode(1, 0.3), 0, flareCode(1, 0.3), 0], cInfo: [5, 9, 0 + 4 * (37 + 256 * 1), packFlux(100, splashCode(0.5, 0), 0)],
        }
        return evaluate(alphaNode, attributes)[0]!
      }
      expect(splash(3, 0.5)).toBeGreaterThan(0.5) // the foot is where it was: the splash shows
      expect(splash(7, 0.3)).toBe(0) // a newborn curtain: its foot starts at its top and is 4 blocks up at 70 % of the step
      expect(splash(7, 0.97)).toBeLessThan(0.6 * splash(7, 1)) // and still fading in 3 % before the end, 0.12 block up
      expect(splash(7, 1)).toBeGreaterThan(0.5) // arrived
    } finally { waterAlpha.value = before }
  })

  it('has no conditional node: three builds a node shared with a select() branch inside it, unset elsewhere', () => {
    // r186 drew curtain bodies black: this end's light was first needed inside the splash's select() branch.
    const v = curtainVertex()
    const seen = new Set<unknown>(), kinds = new Set<string>()
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object' || seen.has(n)) return
      seen.add(n)
      if (Array.isArray(n)) { n.forEach(walk); return }
      if (!(n as { isNode?: boolean }).isNode) return
      kinds.add((n as object).constructor.name)
      for (const value of Object.values(n)) walk(value)
    }
    for (const output of Object.values(v)) walk(output)
    expect(kinds.has('AttributeNode')).toBe(true) // the walk reaches the attributes
    expect(kinds.has('ConditionalNode')).toBe(false)
  })

  it('winds every triangle of the body and the splash toward the side its normal lights', () => {
    const view = published(32, 32, (x) => (x <= 10 ? 6 : 2), () => SUB)
    const ws = new WaterSurface(32, view, mat(), mat())
    ws.update()
    const cgeo = (ws.group.getObjectByName('water-0-curtains') as THREE.Mesh).geometry as THREE.InstancedBufferGeometry
    const strip = cgeo.getAttribute('strip'), index = [...cgeo.getIndex()!.array]
    const { position, normal } = curtainVertex()
    const before = waterAlpha.value
    let checked = 0
    try {
      waterAlpha.value = 1
      for (let dir = 0; dir < 4; dir++) {
        // Both ends free (open, flared) and thick, so no face collapses; water under both.
        const attributes = (v: number) => ({
          strip: [strip.getX(v), strip.getY(v), strip.getZ(v), strip.getW(v)], cPrev: [7, 7, 3, 3], cCur: [7, 7, 3, 3],
          cReach: [1.5, 1.5, 1.5, 1.5], cThick: [0.4, 0.4, 0.4, 0.4], cFlare: [flareCode(1, 0.3), flareCode(1, 0.3), flareCode(1, 0.3), flareCode(1, 0.3)],
          cInfo: [5, 9, dir + 4 * (240 + 256 * 3), packFlux(100, splashCode(0.5, 0), splashCode(0.5, 0))],
        })
        const p = (v: number) => evaluate(position, attributes(v)), nrm = (v: number) => evaluate(normal, attributes(v))
        for (let t = 0; t < index.length; t += 3) {
          const [a, b, c] = [p(index[t]!), p(index[t + 1]!), p(index[t + 2]!)]
          const u = [0, 1, 2].map((i) => b[i]! - a[i]!), w = [0, 1, 2].map((i) => c[i]! - a[i]!)
          const wound = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!]
          if (Math.hypot(...wound) < 1e-6) continue // the splash's row −1 can fold onto row 0 at the landing column's side
          const lit = [index[t]!, index[t + 1]!, index[t + 2]!].map(nrm).reduce((s, n) => s.map((x, i) => x + n[i]!))
          const kind = strip.getW(index[t]!), face = strip.getZ(index[t]!)
          expect(wound[0]! * lit[0]! + wound[1]! * lit[1]! + wound[2]! * lit[2]!, `dir ${dir} triangle ${t / 3} kind ${kind} face ${face}`).toBeGreaterThan(0)
          checked++
        }
      }
    } finally { waterAlpha.value = before }
    expect(checked).toBeGreaterThanOrEqual(4 * 2 * 2 * 2 * ARC_SEGMENTS) // every body triangle: front, back, both sides
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
    // A curtain's body is closed, every face wound outward: front faces alone draw it, one layer of water deep.
    expect(m.curtain.side).toBe(THREE.FrontSide)
    expect(m.plainCurtain.side).toBe(THREE.FrontSide)
    expect(m.surface.transparent).toBe(true)
    expect(m.voxel.depthWrite).toBe(false)
    m.dispose()
  })
})
