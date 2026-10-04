import * as THREE from 'three/webgpu'
import type { ColumnData, SurfaceView } from './surfaceView.ts'

/** Base quad corners, in the order (−x,−z) (+x,−z) (+x,+z) (−x,+z) (surface) or top A, top B, bottom B, bottom A (curtain). */
const CORNERS = [0, 1, 2, 3]
/** Facing +y, counter-clockwise seen from above. */
const SURFACE_INDEX = [0, 2, 1, 0, 3, 2]
const CURTAIN_INDEX = [0, 1, 2, 0, 2, 3]

interface Slot {
  surface: THREE.Mesh
  geo: THREE.InstancedBufferGeometry
  attrs: THREE.InstancedBufferAttribute[]
  curtains: THREE.Mesh
  cgeo: THREE.InstancedBufferGeometry
  generation: number
}

function baseQuad(index: number[], height: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry()
  g.setAttribute('corner', new THREE.BufferAttribute(Float32Array.from(CORNERS), 1))
  // three's node materials expect a `position` attribute; the shaders build positions from the instance data instead.
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3))
  g.setIndex(index)
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(16, height / 2, 16), Math.hypot(16, height / 2, 16) + 1)
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(33, height, 33))
  return g
}

/**
 * An instance attribute over one of the view's arrays. It keeps three's static usage: with DynamicDrawUsage three would
 * rewrite the whole buffer every frame; here `needsUpdate` and the row range (uploadRows) say what to upload.
 */
function instanced(array: Float32Array): THREE.InstancedBufferAttribute {
  return new THREE.InstancedBufferAttribute(array, 4)
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
function uploadRows(a: THREE.BufferAttribute, start: number, count: number): void {
  const r = a.updateRanges[0]
  if (r) {
    const end = Math.max(r.start + r.count, start + count)
    r.start = Math.min(r.start, start)
    r.count = end - r.start
  } else a.addUpdateRange(start, count)
  a.needsUpdate = true
}

/**
 * Draws the heightfield (spec §5): per chunk column, 32 × 32 instanced quads whose corners interpolate between the
 * previous and the current water step, and its waterfall curtains. Instance data lives in the SurfaceView; this class
 * only wires it to three.js and uploads the rows that changed.
 */
export class WaterSurface {
  readonly group = new THREE.Group()
  private readonly view: SurfaceView
  private readonly height: number
  private readonly slots = new Map<number, Slot>()
  private surfaceMaterial: THREE.Material
  private curtainMaterial: THREE.Material

  constructor(height: number, view: SurfaceView, surface: THREE.Material, curtain: THREE.Material) {
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
      s.curtains.material = curtain
    }
  }

  /** Uploads every chunk column the view changed since the last call. */
  update(): void {
    for (const cc of this.view.takeDirty()) {
      const d = this.view.column(cc)
      if (d) this.sync(cc, d)
    }
  }

  dispose(): void {
    for (const s of this.slots.values()) { s.geo.dispose(); s.cgeo.dispose() }
    this.slots.clear()
    this.group.clear()
  }

  private sync(cc: number, d: ColumnData): void {
    const s = this.slots.get(cc) ?? this.create(cc, d)
    if (d.rowLo <= d.rowHi) {
      const start = d.rowLo * 32 * 4, count = (d.rowHi - d.rowLo + 1) * 32 * 4
      for (const a of s.attrs) uploadRows(a, start, count)
      d.rowLo = 32
      d.rowHi = -1
      // A chunk column that dried out draws nothing: skip its 1024 collapsed quads.
      s.surface.visible = anyDrawn(d.info)
    }
    const cs = d.curtains
    if (cs.generation !== s.generation) {
      s.cgeo.setAttribute('cPrev', instanced(cs.prev))
      s.cgeo.setAttribute('cCur', instanced(cs.cur))
      s.cgeo.setAttribute('cInfo', instanced(cs.info))
      s.generation = cs.generation
    } else {
      for (const name of ['cPrev', 'cCur', 'cInfo']) s.cgeo.getAttribute(name).needsUpdate = true
    }
    s.cgeo.instanceCount = cs.count
    s.curtains.visible = cs.count > 0
  }

  private create(cc: number, d: ColumnData): Slot {
    const ox = (cc % this.view.cx) * 32, oz = Math.floor(cc / this.view.cx) * 32
    const geo = baseQuad(SURFACE_INDEX, this.height)
    const attrs = [instanced(d.hPrev), instanced(d.hCur), instanced(d.info)]
    geo.setAttribute('hPrev', attrs[0]!)
    geo.setAttribute('hCur', attrs[1]!)
    geo.setAttribute('info', attrs[2]!)
    geo.instanceCount = 1024
    const surface = this.mesh(geo, this.surfaceMaterial, ox, oz, `water-${cc}`)
    const cgeo = baseQuad(CURTAIN_INDEX, this.height)
    cgeo.setAttribute('cPrev', instanced(d.curtains.prev))
    cgeo.setAttribute('cCur', instanced(d.curtains.cur))
    cgeo.setAttribute('cInfo', instanced(d.curtains.info))
    cgeo.instanceCount = 0
    const curtains = this.mesh(cgeo, this.curtainMaterial, ox, oz, `water-${cc}-curtains`)
    curtains.visible = false
    const slot: Slot = { surface, geo, attrs, curtains, cgeo, generation: d.curtains.generation }
    this.slots.set(cc, slot)
    return slot
  }

  private mesh(geo: THREE.InstancedBufferGeometry, material: THREE.Material, ox: number, oz: number, name: string): THREE.Mesh {
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
