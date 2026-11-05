import * as THREE from 'three/webgpu'
import { uniform } from 'three/tsl'

/**
 * How exposed each part of the world is to the wind, one byte per cell of `cell × cell` columns (0 sheltered … 255
 * exposed), `side × side` cells row-major (index cz · side + cx). The game writes it whole (`set`); the grass and flower
 * shader reads it as an R8 texture and scales the sway by it, so no remesh is needed. Starts all exposed (255).
 */
export class WindMask {
  readonly side: number
  readonly cell: number
  readonly data: Uint8Array
  /** Called after a `set` that altered a byte (the owner re-uploads its texture). */
  onChange?: () => void

  constructor(side: number, cell: number) {
    if (!Number.isInteger(side) || side < 1 || !Number.isInteger(cell) || cell < 1) {
      throw new RangeError(`wind mask side and cell must be positive integers, got ${side} and ${cell}`)
    }
    this.side = side
    this.cell = cell
    this.data = new Uint8Array(side * side).fill(255)
  }

  /** Copies `side × side` bytes (0–255, row-major); validates all of them before writing any. */
  set(values: ArrayLike<number>): void {
    const n = this.data.length
    if (values.length !== n) throw new RangeError(`wind mask takes ${n} values (${this.side} × ${this.side}), got ${values.length}`)
    if (!(values instanceof Uint8Array)) {
      for (let i = 0; i < n; i++) {
        const v = values[i]!
        if (typeof v !== 'number' || !(v >= 0 && v <= 255)) throw new RangeError(`wind mask value ${i} must be in [0, 255], got ${String(v)}`)
      }
    }
    let changed = false
    for (let i = 0; i < n; i++) {
      const b = Math.round(values[i]!)
      if (this.data[i] !== b) { this.data[i] = b; changed = true }
    }
    if (changed) this.onChange?.()
  }

  /** The byte (0–255) of the cell holding world column (x, z); columns outside the world read the nearest edge cell. */
  at(x: number, z: number): number {
    const cx = clamp(Math.floor(x / this.cell), this.side - 1), cz = clamp(Math.floor(z / this.cell), this.side - 1)
    return this.data[cz * this.side + cx]!
  }
}

function clamp(v: number, max: number): number {
  return v < 0 ? 0 : v > max ? max : v
}

/** The sway's amplitude for a wind strength (0–1) and an exposure (0–1); the decoration shader computes the same. */
export function windAmplitude(strength: number, exposure: number): number {
  return 0.25 + 1.1 * strength * exposure
}

/** The direction the default wind blows towards (x, z), before normalising, and its strength: a gentle breeze. */
export const DEFAULT_WIND = { dirX: 1, dirZ: 0.3, strength: 0.35 } as const

/**
 * The wind inputs of the grass and flower material: `dir` is the unit (x, z) direction the wind blows towards, `strength`
 * 0 (still) … 1 (gale), `mask` the exposure per cell. `set` normalises the direction; a zero direction keeps the last one.
 */
export interface DecorationWind {
  readonly dir: { value: THREE.Vector2 }
  readonly strength: { value: number }
  readonly mask: WindMask
  set(o: { dirX: number; dirZ: number; strength: number }): void
}

export function createDecorationWind(mask: WindMask): DecorationWind {
  const dir = uniform(new THREE.Vector2(DEFAULT_WIND.dirX, DEFAULT_WIND.dirZ).normalize())
  const strength = uniform(DEFAULT_WIND.strength)
  return {
    dir, strength, mask,
    set(o) {
      if (!Number.isFinite(o.dirX) || !Number.isFinite(o.dirZ)) throw new RangeError(`wind direction must be finite, got (${o.dirX}, ${o.dirZ})`)
      if (!Number.isFinite(o.strength) || o.strength < 0) throw new RangeError(`wind strength must be a finite number ≥ 0, got ${o.strength}`)
      const len = Math.hypot(o.dirX, o.dirZ)
      if (len > 0) dir.value.set(o.dirX / len, o.dirZ / len)
      strength.value = o.strength
    },
  }
}
