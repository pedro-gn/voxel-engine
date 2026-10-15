/**
 * A per-column grass factor over the world's x/z (0 = no grass, flattened; 1 = full), one byte per column, row-major
 * (index z · width + x). The game writes it (piles that press the grass down, trampled paths); the grass shader reads it
 * as an R8 texture and scales each tuft's blade count and height by it, so no remesh is needed. Starts full everywhere,
 * which is the grass without a mask.
 */
export class GrassMask {
  readonly width: number
  readonly depth: number
  readonly data: Uint8Array
  /** Called after any change that altered a byte (the owner re-uploads its texture). */
  onChange: (() => void) | null = null

  constructor(width: number, depth: number) {
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(depth) || depth < 1) {
      throw new RangeError(`grass mask size must be positive integers, got ${width} × ${depth}`)
    }
    this.width = width
    this.depth = depth
    this.data = new Uint8Array(width * depth).fill(255)
  }

  /** The factor at column (x, z), 0–1. */
  get(x: number, z: number): number {
    return this.data[this.index(x, z)]! / 255
  }

  /** Sets column (x, z) to `value` in [0, 1] (stored as a byte). */
  set(x: number, z: number, value: number): void {
    const i = this.index(x, z), b = byte(value)
    if (this.data[i] === b) return
    this.data[i] = b
    this.onChange?.()
  }

  /** Sets every column of flat [x0, z0, x1, z1, …] pairs to `value`; validates all of them before writing any. */
  setMany(cells: ArrayLike<number>, value: number): void {
    if (cells.length % 2 !== 0) throw new RangeError(`grass mask cells must be [x, z] pairs, got ${cells.length} numbers`)
    const b = byte(value), at: number[] = []
    for (let k = 0; k < cells.length; k += 2) at.push(this.index(cells[k]!, cells[k + 1]!))
    let changed = false
    for (const i of at) if (this.data[i] !== b) { this.data[i] = b; changed = true }
    if (changed) this.onChange?.()
  }

  /** Back to full grass everywhere. */
  clear(): void {
    if (this.data.every(v => v === 255)) return
    this.data.fill(255)
    this.onChange?.()
  }

  private index(x: number, z: number): number {
    if (!Number.isInteger(x) || !Number.isInteger(z) || x < 0 || z < 0 || x >= this.width || z >= this.depth) {
      throw new RangeError(`grass mask column (${x}, ${z}) is outside 0–${this.width - 1} × 0–${this.depth - 1}`)
    }
    return z * this.width + x
  }
}

function byte(value: number): number {
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) throw new RangeError(`grass mask value must be in [0, 1], got ${String(value)}`)
  return Math.round(value * 255)
}
