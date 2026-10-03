import { voxelId } from '@elovox/engine'
import type { OpDef, OpImpl, Vec2 } from '@elovox/terrain'
import {
  BoxGeometry, BufferGeometry, Group, Line, LineBasicNodeMaterial, Mesh, MeshBasicNodeMaterial, Vector3,
  type PerspectiveCamera,
} from 'three/webgpu'
import { handlesOf, outlinesOf, resample, type Handle } from './geometry.ts'

/** Blocks the overlay floats above the ground, so lines do not sink into it. */
export const LIFT = 0.6
/** Blocks between draped outline samples. */
const STEP = 2
const COLOR = { selected: 0xffb020, other: 0xffffff, failed: 0xff4040, handle: 0xffffff, insert: 0x8cc8ff, stem: 0xffb020 }

/** Ground height lookup: the y just above the column's top voxel, skipping tree blocks; 0 for an empty column. */
export function groundSampler(get: (x: number, y: number, z: number) => number, skip: ReadonlySet<number>, height: number, size: Vec2): (x: number, z: number) => number {
  return (x, z) => {
    const ix = Math.min(size[0] - 1, Math.max(0, Math.floor(x)))
    const iz = Math.min(size[1] - 1, Math.max(0, Math.floor(z)))
    for (let y = height - 1; y >= 0; y--) {
      const v = get(ix, y, iz)
      if (v !== 0 && !skip.has(voxelId(v))) return y + 1
    }
    return 0
  }
}

export interface DrawOp { def: OpDef; impl: OpImpl; selected: boolean; failed: boolean }
export interface PlacedHandle { handle: Handle; pos: Vector3 }
export interface PlacedOutline { id: string; points: Vector3[]; closed: boolean }

/** The editor's lines and handle markers, drawn over the terrain (no depth test). */
export class Overlay {
  readonly group = new Group()
  handles: PlacedHandle[] = []
  outlines: PlacedOutline[] = []
  private readonly ground: (x: number, z: number) => number
  private readonly lineMaterials = new Map<string, LineBasicNodeMaterial>()
  private readonly markerGeometry = new BoxGeometry(1, 1, 1)
  private readonly handleMaterial = new MeshBasicNodeMaterial({ color: COLOR.handle, depthTest: false, transparent: true })
  private readonly insertMaterial = new MeshBasicNodeMaterial({ color: COLOR.insert, depthTest: false, transparent: true, opacity: 0.8 })
  private readonly markers: Mesh[] = []
  private readonly geometries: BufferGeometry[] = []

  constructor(ground: (x: number, z: number) => number) {
    this.ground = ground
    this.group.name = 'terrain-editor-overlay'
  }

  draw(ops: readonly DrawOp[], showAll: boolean): void {
    this.clear()
    for (const op of ops) {
      if (!op.selected && !op.failed && !showAll) continue
      const color = op.failed ? COLOR.failed : op.selected ? COLOR.selected : COLOR.other
      for (const o of outlinesOf(op.def)) {
        const points = resample(o.points, o.closed, STEP).map(([x, z]) => new Vector3(x, this.ground(x, z) + LIFT, z))
        const opacity = (op.selected || op.failed ? 1 : 0.45) * (o.faint ? 0.5 : 1)
        this.addLine(points, o.closed, color, opacity)
        if (!o.faint) this.outlines.push({ id: op.def.id, points, closed: o.closed })
      }
      if (!op.selected) continue
      for (const h of handlesOf(op.def, op.impl)) {
        const ground = this.ground(h.x, h.z)
        const pos = new Vector3(h.x, (h.y ?? ground) + LIFT, h.z)
        const m = new Mesh(this.markerGeometry, h.kind === 'insert' ? this.insertMaterial : this.handleMaterial)
        m.position.copy(pos)
        m.renderOrder = 1001
        this.group.add(m)
        this.markers.push(m)
        if (h.y !== undefined) this.addLine([new Vector3(h.x, ground + LIFT, h.z), pos], false, COLOR.stem, 0.8)
        this.handles.push({ handle: h, pos })
      }
    }
  }

  /** Scales the handle markers to about `px` pixels at their distance from the camera. */
  scaleMarkers(camera: PerspectiveCamera, viewportHeight: number, px = 9): void {
    const k = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, viewportHeight)
    for (const m of this.markers) m.scale.setScalar(Math.max(0.2, camera.position.distanceTo(m.position) * k * px))
  }

  dispose(): void {
    this.clear()
    for (const m of this.lineMaterials.values()) m.dispose()
    this.lineMaterials.clear()
    this.markerGeometry.dispose()
    this.handleMaterial.dispose()
    this.insertMaterial.dispose()
    this.group.removeFromParent()
  }

  private addLine(points: Vector3[], closed: boolean, color: number, opacity: number): void {
    // The WebGPU renderer does not support LineLoop: close the loop by repeating the first point.
    const geometry = new BufferGeometry().setFromPoints(closed && points[0] ? [...points, points[0]] : points)
    this.geometries.push(geometry)
    const line = new Line(geometry, this.lineMaterial(color, opacity))
    line.renderOrder = 1000
    this.group.add(line)
  }

  private lineMaterial(color: number, opacity: number): LineBasicNodeMaterial {
    const key = `${color}:${opacity}`
    let m = this.lineMaterials.get(key)
    if (!m) {
      m = new LineBasicNodeMaterial({ color, transparent: true, opacity, depthTest: false })
      this.lineMaterials.set(key, m)
    }
    return m
  }

  private clear(): void {
    this.group.clear()
    for (const g of this.geometries) g.dispose()
    this.geometries.length = 0
    this.markers.length = 0
    this.handles = []
    this.outlines = []
  }
}
