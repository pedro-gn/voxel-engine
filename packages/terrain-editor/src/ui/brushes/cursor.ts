import { BufferGeometry, Group, Line, LineBasicNodeMaterial, LineSegments, Vector3 } from 'three/webgpu'
import { LIFT } from '../handles/overlay.ts'

const SEGMENTS = 64
const COLOR = { ring: 0xffffff, inner: 0xffb020, cells: 0xffffff, sphere: 0x8cc8ff, locked: 0xffb020 }

/** The brush cursor, drawn over the terrain without depth test. Each draw replaces the previous one. */
export class BrushCursor {
  readonly group = new Group()
  /** What the last draw drew: each line's points (vertex pairs for the cell outlines). */
  lines: Vector3[][] = []
  private readonly ground: (x: number, z: number) => number
  private readonly materials = new Map<number, LineBasicNodeMaterial>()
  private readonly geometries: BufferGeometry[] = []

  constructor(ground: (x: number, z: number) => number) {
    this.ground = ground
    this.group.name = 'terrain-editor-brush-cursor'
  }

  /** A circle draped on the terrain, and an inner ring where the falloff begins (when it lies inside the circle). */
  circle(x: number, z: number, radius: number, inner: number | null): void {
    this.clear()
    this.line(this.draped(x, z, radius), COLOR.ring, false)
    if (inner !== null && inner > 0 && inner < radius) this.line(this.draped(x, z, inner), COLOR.inner, false)
  }

  /** The outlines of the cells (of `cell` blocks) whose centres lie within the radius. */
  cells(x: number, z: number, radius: number, cell: number): void {
    this.clear()
    const pts: Vector3[] = []
    const c0 = Math.floor((x - radius) / cell), c1 = Math.floor((x + radius) / cell)
    const k0 = Math.floor((z - radius) / cell), k1 = Math.floor((z + radius) / cell)
    for (let cz = k0; cz <= k1; cz++) for (let cx = c0; cx <= c1; cx++) {
      const mx = cx * cell + cell / 2, mz = cz * cell + cell / 2
      if (Math.hypot(mx - x, mz - z) > radius) continue
      const y = this.ground(mx, mz) + LIFT
      const a = new Vector3(cx * cell, y, cz * cell), b = new Vector3((cx + 1) * cell, y, cz * cell)
      const c = new Vector3((cx + 1) * cell, y, (cz + 1) * cell), d = new Vector3(cx * cell, y, (cz + 1) * cell)
      pts.push(a, b, b, c, c, d, d, a)
    }
    if (pts.length > 0) this.line(pts, COLOR.cells, true)
  }

  /** Three great circles of a sphere; `locked` tints them (Shift keeps the depth). */
  sphere(x: number, y: number, z: number, radius: number, locked: boolean): void {
    this.clear()
    const color = locked ? COLOR.locked : COLOR.sphere
    for (const plane of ['xz', 'xy', 'zy'] as const) {
      const pts: Vector3[] = []
      for (let i = 0; i <= SEGMENTS; i++) {
        const a = (i / SEGMENTS) * Math.PI * 2
        const u = Math.cos(a) * radius, v = Math.sin(a) * radius
        pts.push(plane === 'xz' ? new Vector3(x + u, y, z + v) : plane === 'xy' ? new Vector3(x + u, y + v, z) : new Vector3(x, y + v, z + u))
      }
      this.line(pts, color, false)
    }
  }

  hide(): void { this.clear() }

  dispose(): void {
    this.clear()
    for (const m of this.materials.values()) m.dispose()
    this.materials.clear()
    this.group.removeFromParent()
  }

  /** A closed circle on the ground; the last point repeats the first (the WebGPU renderer has no LineLoop). */
  private draped(x: number, z: number, r: number): Vector3[] {
    const pts: Vector3[] = []
    for (let i = 0; i <= SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r
      pts.push(new Vector3(px, this.ground(px, pz) + LIFT, pz))
    }
    return pts
  }

  private line(pts: Vector3[], color: number, segments: boolean): void {
    const g = new BufferGeometry().setFromPoints(pts)
    this.geometries.push(g)
    const obj = segments ? new LineSegments(g, this.material(color)) : new Line(g, this.material(color))
    obj.renderOrder = 1002
    this.group.add(obj)
    this.lines.push(pts)
  }

  private material(color: number): LineBasicNodeMaterial {
    let m = this.materials.get(color)
    if (!m) {
      m = new LineBasicNodeMaterial({ color, transparent: true, opacity: 0.9, depthTest: false })
      this.materials.set(color, m)
    }
    return m
  }

  private clear(): void {
    this.group.clear()
    for (const g of this.geometries) g.dispose()
    this.geometries.length = 0
    this.lines = []
  }
}
