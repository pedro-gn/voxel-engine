import type { BlockRegistry } from '../blocks/registry.ts'
import type { Layout } from '../world/layout.ts'
import { AIR, voxelId } from '../world/voxel.ts'

/** Added to a body's downward speed every tick, in 1/256 block per tick (≈ 1 g at 20 Hz). */
export const GRAVITY_256 = 24
/** Terminal speed: 2 blocks per tick. */
export const MAX_FALL_256 = 512

/** A block out of the grid while it falls. y256 is the height of its bottom face in 1/256 block. */
export interface FallingBodyState { id: number; voxel: number; x: number; z: number; y256: number; vy256: number }
/** A body that returned to the grid this tick. `version` is its chunk's version after the tick committed. */
export interface Landing { id: number; x: number; y: number; z: number; chunk: number; version: number }

export interface GravityPort {
  trackSweeps?: boolean
  readonly layout: Layout
  readonly registry: BlockRegistry
  get(x: number, y: number, z: number): number
  /** Writes through the simulation as a 'gravity' write. */
  write(x: number, y: number, z: number, v: number): void
  floorAt?(x: number, z: number, from256: number, to256: number): number | undefined
}

/** Falling blocks (spec §6): integer bodies, processed in id order, a write when they start and when they land. */
export class GravitySystem {
  private readonly swept = new Map<number, { lo: number; hi: number }[]>()
  sweptOverlaps(x: number, y: number, z: number): boolean {
    return this.swept.get(x + z * this.port.layout.size[0])?.some(b => y * 256 < b.hi && (y + 1) * 256 > b.lo) ?? false
  }
  /** Landings of the last step; Simulation sets their versions after commit. */
  landed: Landing[] = []
  private bodies: FallingBodyState[] = []
  private readonly pending: number[] = []
  private readonly pendingSet = new Set<number>()
  private nextId = 1
  private readonly port: GravityPort
  private readonly columns = new Map<number, FallingBodyState[]>()

  constructor(port: GravityPort) { this.port = port }

  get count(): number { return this.bodies.length }
  /** Whether a body in flight overlaps the cell now; writing a solid there breaks its landing scan. */
  occupies(x: number, y: number, z: number): boolean {
    return this.columns.get(x + z * this.port.layout.size[0])?.some(b => b.y256 < (y + 1) * 256 && b.y256 + 256 > y * 256) ?? false
  }
  /** Structural fragments query only the relevant column, after the ordinary gravity phase. */
  floorAt(x: number, z: number, from256: number, to256: number): number | undefined {
    let top: number | undefined
    for (const b of this.columns.get(x + z * this.port.layout.size[0]) ?? []) {
      const t = b.y256 + 256
      if (t <= from256 && t > to256 && (top === undefined || t > top)) top = t
    }
    return top
  }

  /** A write may have placed a falls block or taken a support away: check the cell and the one above. */
  afterWrite(x: number, y: number, z: number, v: number): void {
    const falls = this.port.registry.falls
    if (falls[voxelId(v)] === 1) this.queue(x, y, z)
    if (y + 1 < this.port.layout.size[1] && falls[voxelId(this.port.get(x, y + 1, z))] === 1) this.queue(x, y + 1, z)
  }

  step(): void {
    this.swept.clear()
    const L = this.port.layout, reg = this.port.registry
    this.landed = []
    // 1. Starts. Removing a block queues the one above, which this loop reaches in the same tick.
    for (let i = 0; i < this.pending.length; i++) {
      const pos = this.pending[i]!
      this.pendingSet.delete(pos)
      const [x, y, z] = L.voxelCoords(pos)
      const v = this.port.get(x, y, z)
      if (reg.falls[voxelId(v)] !== 1 || !this.open(x, y - 1, z)) continue
      this.bodies.push({ id: this.nextId++, voxel: v, x, z, y256: y * 256, vy256: 0 })
      this.port.write(x, y, z, AIR)
    }
    this.pending.length = 0
    // 2. Advance in id order. A later body never passes an earlier one still falling in its column.
    // If something throws mid-loop, `bodies` still reflects progress: bodies that landed are gone, a body whose
    // landing write threw is dropped (the write may have gone through), and the rest wait for the next tick.
    const bodies = this.bodies
    const keep: FallingBodyState[] = []
    const floorOf = new Map<number, number>()
    let i = 0, landing = false
    try {
      for (; i < bodies.length; i++) {
        const b = bodies[i]!
        b.vy256 = Math.min(b.vy256 + GRAVITY_256, MAX_FALL_256)
        const col = b.x + b.z * L.size[0]
        let target = b.y256 - b.vy256
        const limit = floorOf.get(col)
        if (limit !== undefined && limit <= b.y256) target = Math.max(target, limit)
        const fragment = this.port.floorAt?.(b.x, b.z, b.y256, target)
        if (fragment !== undefined) target = Math.max(target, fragment)
        let land = -1
        for (let k = Math.ceil(b.y256 / 256) - 1; k >= Math.floor(target / 256); k--) {
          if (k < 0) { land = 0; break }
          const id = voxelId(this.port.get(b.x, k, b.z))
          // A spring is a landing surface like a solid: a body never overwrites it.
          if (reg.solid[id] === 1 || (reg.liquid[id] === 1 && reg.source[id] === 1)) { land = k + 1; break }
        }
        if (land < 0 && target < 0) land = 0
        if (this.port.trackSweeps) {
          let a = this.swept.get(col); if (!a) { a = []; this.swept.set(col, a) }
          a.push({ lo: land >= 0 ? land * 256 : target, hi: b.y256 + 256 })
        }
        if (land >= 0) {
          landing = true
          this.port.write(b.x, land, b.z, b.voxel)
          landing = false
          this.landed.push({ id: b.id, x: b.x, y: land, z: b.z, chunk: L.chunkOf(b.x, land, b.z), version: 0 })
          continue
        }
        b.y256 = target
        floorOf.set(col, b.y256 + 256)
        keep.push(b)
      }
    } finally {
      if (i < bodies.length) for (let j = landing ? i + 1 : i; j < bodies.length; j++) keep.push(bodies[j]!)
      this.bodies = keep
      this.columns.clear()
      for (const b of keep) { const col = b.x + b.z * L.size[0]; let a = this.columns.get(col); if (!a) { a = []; this.columns.set(col, a) } a.push(b) }
    }
  }

  /** Copies of the bodies still falling, for the tick message. */
  snapshot(): FallingBodyState[] { return this.bodies.map((b) => ({ ...b })) }

  mixState(mix: (v: number) => void): void {
    mix(this.nextId)
    mix(this.bodies.length)
    for (const b of this.bodies) { mix(b.id); mix(b.voxel); mix(b.x); mix(b.z); mix(b.y256); mix(b.vy256) }
    mix(this.pending.length)
  }

  private queue(x: number, y: number, z: number): void {
    const pos = this.port.layout.voxelIndex(x, y, z)
    if (this.pendingSet.has(pos)) return
    this.pendingSet.add(pos)
    this.pending.push(pos)
  }

  /** A block falls into air or a flowing liquid; never through the world floor or a spring. */
  private open(x: number, y: number, z: number): boolean {
    if (y < 0) return false
    const v = this.port.get(x, y, z), id = voxelId(v), reg = this.port.registry
    return v === AIR || (reg.liquid[id] === 1 && reg.source[id] === 0)
  }
}
