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
  readonly layout: Layout
  readonly registry: BlockRegistry
  get(x: number, y: number, z: number): number
  /** Writes through the simulation as a 'gravity' write. */
  write(x: number, y: number, z: number, v: number): void
}

/** Falling blocks (spec §6): integer bodies, processed in id order, a write when they start and when they land. */
export class GravitySystem {
  /** Landings of the last step; Simulation sets their versions after commit. */
  landed: Landing[] = []
  private bodies: FallingBodyState[] = []
  private readonly pending: number[] = []
  private readonly pendingSet = new Set<number>()
  private nextId = 1
  private readonly port: GravityPort

  constructor(port: GravityPort) { this.port = port }

  get count(): number { return this.bodies.length }

  /** A write may have placed a falls block or taken a support away: check the cell and the one above. */
  afterWrite(x: number, y: number, z: number, v: number): void {
    const falls = this.port.registry.falls
    if (falls[voxelId(v)] === 1) this.queue(x, y, z)
    if (y + 1 < this.port.layout.size[1] && falls[voxelId(this.port.get(x, y + 1, z))] === 1) this.queue(x, y + 1, z)
  }

  step(): void {
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
    const keep: FallingBodyState[] = []
    const floorOf = new Map<number, number>()
    for (const b of this.bodies) {
      b.vy256 = Math.min(b.vy256 + GRAVITY_256, MAX_FALL_256)
      const col = b.x + b.z * L.size[0]
      let target = b.y256 - b.vy256
      const limit = floorOf.get(col)
      if (limit !== undefined && limit <= b.y256) target = Math.max(target, limit)
      let land = -1
      for (let k = Math.ceil(b.y256 / 256) - 1; k >= Math.floor(target / 256); k--) {
        if (k < 0) { land = 0; break }
        if (reg.solid[voxelId(this.port.get(b.x, k, b.z))] === 1) { land = k + 1; break }
      }
      if (land < 0 && target < 0) land = 0
      if (land >= 0) {
        this.port.write(b.x, land, b.z, b.voxel)
        this.landed.push({ id: b.id, x: b.x, y: land, z: b.z, chunk: L.chunkOf(b.x, land, b.z), version: 0 })
        continue
      }
      b.y256 = target
      floorOf.set(col, b.y256 + 256)
      keep.push(b)
    }
    this.bodies = keep
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
