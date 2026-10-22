import * as THREE from 'three/webgpu'
import { ARC_GAP, ARC_REACH } from './surfaceMesh.ts'
import { SURFACE_ATTRIBUTES, type ColumnData } from './surfaceView.ts'
import type { SurfaceSource } from './surfaceMirror.ts'

/** Base quad corners, in the order (−x,−z) (+x,−z) (+x,+z) (−x,+z). */
const CORNERS = [0, 1, 2, 3]
/** Facing +y, counter-clockwise seen from above. */
const SURFACE_INDEX = [0, 2, 1, 0, 3, 2]
/** How far (blocks) a curtain reaches past its chunk column: from its column's edge, ARC_GAP + ARC_REACH out. */
const CURTAIN_MARGIN = Math.ceil(ARC_GAP + ARC_REACH)
const SHADING_ATTRIBUTES = SURFACE_ATTRIBUTES.slice(3)
const SHADING_STRIDE = SHADING_ATTRIBUTES.length * 4
/** Finer rendering of the same physical arc: a long fall must turn smoothly over its brink. */
export const CURTAIN_SEGMENTS = 24

interface Slot {
  surface: THREE.Mesh
  geo: THREE.InstancedBufferGeometry
  attrs: THREE.InstancedBufferAttribute[]
  shading: THREE.InstancedInterleavedBuffer
  curtains: THREE.Mesh
  cgeo: THREE.InstancedBufferGeometry
  generation: number
  /** Within the view distance (setRange). */
  inRange: boolean
}

/** Bounds of a chunk column's instances, `margin` blocks past its sides (+ 1), over the world's height. */
function bound(g: THREE.InstancedBufferGeometry, height: number, margin: number): void {
  const half = 16 + margin + 1
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(16, height / 2, 16), Math.hypot(half, height / 2, half))
  g.boundingBox = new THREE.Box3(new THREE.Vector3(16 - half, 0, 16 - half), new THREE.Vector3(16 + half, height, 16 + half))
}

/** The surface's base quad: `corner` (0–3) picks the corner of the instance's heights. */
function baseQuad(height: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry()
  g.setAttribute('corner', new THREE.BufferAttribute(Float32Array.from(CORNERS), 1))
  // three's node materials expect a `position` attribute; the shaders build positions from the instance data instead.
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3))
  g.setIndex(SURFACE_INDEX)
  bound(g, height, 0)
  return g
}

/** Rows of a curtain's strips (top to foot), and the first vertex of its front, back, side and splash vertices (see baseBody). */
const ROWS = CURTAIN_SEGMENTS + 1
const FACE = (face: number, k: number, end: number): number => face * ROWS * 2 + k * 2 + end
const SIDE = (end: number, k: number, face: number): number => 4 * ROWS + end * ROWS * 2 + k * 2 + face
const SPLASH = (row: number, end: number): number => 8 * ROWS + row * 2 + end
const BODY_VERTICES = 8 * ROWS + 6

/**
 * A curtain's base geometry: its body and its splash, `strip` = (s, end, face, kind) per vertex (see curtainVertex).
 * - The front (face 0) and back (face 1) faces are strips of CURTAIN_SEGMENTS segments, rows 0..CURTAIN_SEGMENTS from the top to the
 *   foot, with `end` 0 at the edge's end A and 1 at B; segment k is the quad between rows k and k + 1, so neighbouring
 *   segments share their row of vertices. The back face has the opposite winding.
 * - Each end has a side face: a strip of the same rows between the front and the back (kind 1).
 * - The splash is two quads across the foot (kind 2): rows −1, 0, 1 by the two ends.
 */
function baseBody(height: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry()
  const strip = new Float32Array(BODY_VERTICES * 4), index: number[] = []
  const put = (v: number, s: number, end: number, face: number, kind: number): void => { strip.set([s, end, face, kind], v * 4) }
  for (let k = 0; k < ROWS; k++) for (let end = 0; end < 2; end++) for (let face = 0; face < 2; face++) {
    put(FACE(face, k, end), k / CURTAIN_SEGMENTS, end, face, 0)
    put(SIDE(end, k, face), k / CURTAIN_SEGMENTS, end, face, 1)
  }
  for (let row = 0; row < 3; row++) for (let end = 0; end < 2; end++) put(SPLASH(row, end), row - 1, end, 0, 2)
  for (let k = 0; k < CURTAIN_SEGMENTS; k++) {
    // top A, top B, foot B, foot A of the segment
    for (let face = 0; face < 2; face++) {
      const a = FACE(face, k, 0), b = FACE(face, k, 1), c = FACE(face, k + 1, 1), d = FACE(face, k + 1, 0)
      index.push(...(face === 0 ? [a, b, c, a, c, d] : [a, c, b, a, d, c]))
    }
    for (let end = 0; end < 2; end++) {
      const a = SIDE(end, k, 0), b = SIDE(end, k, 1), c = SIDE(end, k + 1, 1), d = SIDE(end, k + 1, 0)
      // Wound to face out of the body, away from the other end (the material draws front faces only).
      index.push(...(end === 0 ? [a, c, b, a, d, c] : [a, b, c, a, c, d]))
    }
  }
  const bodies = index.length
  for (let row = 0; row < 2; row++) index.push(SPLASH(row, 0), SPLASH(row, 1), SPLASH(row + 1, 1), SPLASH(row, 0), SPLASH(row + 1, 1), SPLASH(row + 1, 0))
  g.setAttribute('strip', new THREE.BufferAttribute(strip, 4))
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BODY_VERTICES * 3), 3))
  g.setIndex(index)
  // Every curtain's splash first, then every body. The water is translucent and writes no depth, so it blends in draw order:
  // drawn per instance (body, splash, next body…), each body covered part of the previous curtain's splash on screen, a
  // tooth per block along a wide fall's foot. A splash lies on the water under the bodies, so the bodies blend over it.
  g.addGroup(bodies, index.length - bodies, 0)
  g.addGroup(0, bodies, 0)
  bound(g, height, CURTAIN_MARGIN)
  return g
}

/**
 * An instance attribute over one of the view's arrays. It keeps three's static usage: with DynamicDrawUsage three would
 * rewrite the whole buffer every frame; here `needsUpdate` and the row range (uploadRows) say what to upload.
 */
function instanced(array: Float32Array, size = 4): THREE.InstancedBufferAttribute {
  return new THREE.InstancedBufferAttribute(array, size)
}

/** The view's curtain arrays, by attribute name. */
const CURTAIN_ATTRIBUTES: readonly (readonly [string, (cs: ColumnData['curtains']) => Float32Array, number])[] = [
  ['cPrev', (cs) => cs.prev, 4], ['cCur', (cs) => cs.cur, 4], ['cReach', (cs) => cs.reach, 4], ['cThick', (cs) => cs.thick, 4], ['cFlare', (cs) => cs.flare, 4], ['cInfo', (cs) => cs.info, 4],
]

function wireCurtains(g: THREE.InstancedBufferGeometry, cs: ColumnData['curtains']): void {
  for (const [name, array, size] of CURTAIN_ATTRIBUTES) g.setAttribute(name, instanced(array(cs), size))
}

/** Whether any quad of the chunk column is drawn (a negative packed light hides one). */
function anyDrawn(info: Float32Array): boolean {
  for (let o = 3; o < info.length; o += 4) if (info[o]! >= 0) return true
  return false
}

/**
 * Marks rows [start, start + count) for upload. three keeps the ranges until it next uploads the attribute, which it skips
 * while the mesh is culled, so the ranges of several frames merge into the one range spanning them all.
 */
function uploadRows(a: THREE.BufferAttribute | THREE.InterleavedBuffer, start: number, count: number): void {
  const r = a.updateRanges[0]
  if (r) {
    const end = Math.max(r.start + r.count, start + count)
    r.start = Math.min(r.start, start)
    r.count = end - r.start
  } else a.addUpdateRange(start, count)
  a.needsUpdate = true
}

/** One interleaved GPU buffer for all shading fields: WebGPU's default limit is eight vertex buffers, not eight attributes. */
function copyShading(d: ColumnData, buffer: THREE.InstancedInterleavedBuffer, start: number, count: number): void {
  for (let field = 0; field < SHADING_ATTRIBUTES.length; field++) {
    const src = d[SHADING_ATTRIBUTES[field]!]!
    for (let i = start; i < start + count; i += 4) {
      const dst = (i / 4) * SHADING_STRIDE + field * 4
      for (let k = 0; k < 4; k++) buffer.array[dst + k] = src[i + k]!
    }
  }
  uploadRows(buffer, (start / 4) * SHADING_STRIDE, (count / 4) * SHADING_STRIDE)
}

/**
 * Draws the heightfield (spec §5): per chunk column, 32 × 32 instanced quads whose corners interpolate between the
 * previous and the current water step, and its waterfall curtains. Instance data lives in the SurfaceView; this class
 * only wires it to three.js and uploads the rows that changed.
 */
export class WaterSurface {
  readonly group = new THREE.Group()
  private readonly view: SurfaceSource
  private readonly height: number
  private readonly slots = new Map<number, Slot>()
  private surfaceMaterial: THREE.Material
  private curtainMaterial: THREE.Material
  private eye = { x: 0, y: 0, z: 0 }
  private range = Infinity

  constructor(height: number, view: SurfaceSource, surface: THREE.Material, curtain: THREE.Material) {
    this.height = height
    this.view = view
    this.surfaceMaterial = surface
    this.curtainMaterial = curtain
    this.group.name = 'elovox-water'
  }

  get meshCount(): number { return this.slots.size }

  setMaterials(surface: THREE.Material, curtain: THREE.Material): void {
    this.surfaceMaterial = surface
    this.curtainMaterial = curtain
    for (const s of this.slots.values()) {
      s.surface.material = surface
      s.curtains.material = [curtain] // one material over its two groups (baseBody)
    }
  }

  /** Uploads every (draw layer, chunk column) the view changed since the last call. */
  update(): void {
    const n = this.view.ccCount
    for (const key of this.view.takeDirty()) {
      const cc = key % n, r = (key - cc) / n, d = this.view.column(cc, r)
      if (d) this.sync(key, cc, r, d)
    }
  }

  /** View distance: hides the chunk columns whose nearest point is farther than `range` blocks from `eye`; Infinity shows all. */
  setRange(eye: { x: number; y: number; z: number }, range: number): void {
    this.eye = { x: eye.x, y: eye.y, z: eye.z }
    this.range = range
    const n = this.view.ccCount
    for (const [key, s] of this.slots) {
      const cc = key % n, inRange = this.near(cc)
      if (inRange === s.inRange) continue
      s.inRange = inRange
      const d = this.view.column(cc, (key - cc) / n)
      s.surface.visible = inRange && d !== undefined && anyDrawn(d.info)
      s.curtains.visible = inRange && d !== undefined && d.curtains.count > 0
    }
  }

  dispose(): void {
    for (const s of this.slots.values()) { s.geo.dispose(); s.cgeo.dispose() }
    this.slots.clear()
    this.group.clear()
  }

  /** Key r × ccCount + cc: chunk column cc of draw layer r. */
  private sync(key: number, cc: number, r: number, d: ColumnData): void {
    const s = this.slots.get(key) ?? this.create(key, cc, r, d)
    if (d.rowLo <= d.rowHi) {
      const start = d.rowLo * 32 * 4, count = (d.rowHi - d.rowLo + 1) * 32 * 4
      for (const a of s.attrs) uploadRows(a, start, count)
      copyShading(d, s.shading, start, count)
      d.rowLo = 32
      d.rowHi = -1
      // A chunk column that dried out draws nothing: skip its 1024 collapsed quads.
      s.surface.visible = anyDrawn(d.info) && s.inRange
    }
    const cs = d.curtains
    if (cs.generation !== s.generation) {
      wireCurtains(s.cgeo, cs)
      s.generation = cs.generation
    } else {
      for (const [name] of CURTAIN_ATTRIBUTES) s.cgeo.getAttribute(name).needsUpdate = true
    }
    s.cgeo.instanceCount = cs.count
    s.curtains.visible = cs.count > 0 && s.inRange
  }

  private near(cc: number): boolean {
    if (this.range === Infinity) return true
    const x0 = (cc % this.view.cx) * 32, z0 = Math.floor(cc / this.view.cx) * 32, e = this.eye
    const dx = Math.max(x0 - e.x, 0, e.x - x0 - 32), dz = Math.max(z0 - e.z, 0, e.z - z0 - 32)
    const dy = Math.max(-e.y, 0, e.y - this.height)
    return dx * dx + dy * dy + dz * dz <= this.range * this.range
  }

  private create(key: number, cc: number, r: number, d: ColumnData): Slot {
    const ox = (cc % this.view.cx) * 32, oz = Math.floor(cc / this.view.cx) * 32
    const geo = baseQuad(this.height)
    const attrs = SURFACE_ATTRIBUTES.slice(0, 3).map(name => instanced(d[name]))
    SURFACE_ATTRIBUTES.slice(0, 3).forEach((name, i) => geo.setAttribute(name, attrs[i]!))
    const shading = new THREE.InstancedInterleavedBuffer(new Float32Array(1024 * SHADING_STRIDE), SHADING_STRIDE)
    SHADING_ATTRIBUTES.forEach((name, i) => geo.setAttribute(name, new THREE.InterleavedBufferAttribute(shading, 4, i * 4)))
    geo.instanceCount = 1024
    const surface = this.mesh(geo, this.surfaceMaterial, ox, oz, `water-${r}-${cc}`)
    const cgeo = baseBody(this.height)
    wireCurtains(cgeo, d.curtains)
    cgeo.instanceCount = 0
    const curtains = this.mesh(cgeo, [this.curtainMaterial], ox, oz, `water-${r}-${cc}-curtains`)
    curtains.visible = false
    const slot: Slot = { surface, geo, attrs, shading, curtains, cgeo, generation: d.curtains.generation, inRange: this.near(cc) }
    this.slots.set(key, slot)
    return slot
  }

  private mesh(geo: THREE.InstancedBufferGeometry, material: THREE.Material | THREE.Material[], ox: number, oz: number, name: string): THREE.Mesh {
    const m = new THREE.Mesh(geo, material)
    m.position.set(ox, 0, oz)
    m.matrixAutoUpdate = false
    m.updateMatrix()
    m.renderOrder = 1 // after opaque terrain and glass, like the liquid layer
    m.castShadow = false
    m.receiveShadow = true
    m.raycast = () => {}
    m.name = name
    this.group.add(m)
    return m
  }
}
