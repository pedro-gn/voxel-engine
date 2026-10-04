import { TILE } from './constants.ts'

/** The world's columns in TILE × TILE tiles (spec §3 Sleeping tiles). Only awake tiles step. */
export class WaterTiles {
  readonly sx: number
  readonly sz: number
  readonly tx: number
  readonly tz: number
  readonly count: number
  /** 1 while the tile steps. */
  readonly awake: Uint8Array
  /** Consecutive quiet steps. */
  readonly quiet: Uint8Array
  /** 1 when a column of the tile changed since the last flush: mirror it and publish it. */
  readonly dirty: Uint8Array
  /** 1 when an edge of the tile moved water at its last step: publish bookkeeping, like `dirty`. */
  readonly moving: Uint8Array

  constructor(sx: number, sz: number) {
    if (sx % TILE !== 0 || sz % TILE !== 0) throw new RangeError(`water tiles need world sizes that are multiples of ${TILE}, got ${sx} × ${sz}`)
    this.sx = sx
    this.sz = sz
    this.tx = sx / TILE
    this.tz = sz / TILE
    this.count = this.tx * this.tz
    this.awake = new Uint8Array(this.count)
    this.quiet = new Uint8Array(this.count)
    this.dirty = new Uint8Array(this.count)
    this.moving = new Uint8Array(this.count)
  }

  of(x: number, z: number): number { return Math.floor(x / TILE) + Math.floor(z / TILE) * this.tx }

  /** Calls `fn` for every column of tile t, row-major (the fixed column order inside a tile). */
  forEachColumn(t: number, fn: (c: number, x: number, z: number) => void): void {
    const x0 = (t % this.tx) * TILE, z0 = Math.floor(t / this.tx) * TILE
    for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) fn(x + z * this.sx, x, z)
  }

  wake(t: number): void {
    this.awake[t] = 1
    this.quiet[t] = 0
    this.dirty[t] = 1
  }

  /** An edit at column (x, z): wakes its tile and the tiles of its four neighbour columns (1 to 3 tiles). */
  wakeAround(x: number, z: number): void {
    this.wake(this.of(x, z))
    if (x > 0) this.wake(this.of(x - 1, z))
    if (x + 1 < this.sx) this.wake(this.of(x + 1, z))
    if (z > 0) this.wake(this.of(x, z - 1))
    if (z + 1 < this.sz) this.wake(this.of(x, z + 1))
  }

  awakeCount(): number {
    let n = 0
    for (let t = 0; t < this.count; t++) n += this.awake[t]!
    return n
  }

  clear(): void {
    this.awake.fill(0)
    this.quiet.fill(0)
    this.dirty.fill(0)
    this.moving.fill(0)
  }

  /** `dirty` is publish bookkeeping, cleared every tick: not world state. */
  mixState(mix: (v: number) => void): void {
    for (let t = 0; t < this.count; t++) mix(this.awake[t]! | (this.quiet[t]! << 1))
  }
}
