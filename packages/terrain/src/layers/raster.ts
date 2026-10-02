import { base64ToBytes, bytesToBase64 } from '../doc/base64.ts'
import type { Check } from '../doc/check.ts'
import type { BrickRef, BrickSetRef, RasterRef } from '../doc/types.ts'

/** Columns per biome-layer cell, per side. */
export const BIOME_CELL = 4
/** Samples per brick side; samples are BRICK_SPACING blocks apart, so a brick spans 16 blocks. */
export const BRICK_SAMPLES = 8
export const BRICK_SPACING = 2
/** Density units per block. */
export const DENSITY_SCALE = 8

export function encodeRaster(type: 'i16' | 'u8', width: number, height: number, values: Int16Array | Uint8Array): RasterRef {
  if (values.length !== width * height) throw new RangeError(`raster has ${values.length} values, expected ${width * height}`)
  const bytes = type === 'u8' ? new Uint8Array(values.buffer, values.byteOffset, values.length) : new Uint8Array(width * height * 2)
  if (type === 'i16') {
    const dv = new DataView(bytes.buffer)
    for (let i = 0; i < values.length; i++) dv.setInt16(i * 2, values[i]!, true)
  }
  return { width, height, type, data: bytesToBase64(bytes) }
}

export function decodeRaster(ref: RasterRef): Int16Array | Uint8Array {
  const bytes = base64ToBytes(ref.data)
  const n = ref.width * ref.height
  if (ref.type === 'u8') {
    if (bytes.length !== n) throw new RangeError(`raster data has ${bytes.length} bytes, expected ${n}`)
    return bytes
  }
  if (bytes.length !== n * 2) throw new RangeError(`raster data has ${bytes.length} bytes, expected ${n * 2}`)
  const out = new Int16Array(n)
  const dv = new DataView(bytes.buffer)
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true)
  return out
}

export function encodeBrick(x: number, y: number, z: number, samples: Int8Array): BrickRef {
  if (samples.length !== BRICK_SAMPLES ** 3) throw new RangeError(`brick needs ${BRICK_SAMPLES ** 3} samples`)
  return { x, y, z, data: bytesToBase64(new Uint8Array(samples.buffer, samples.byteOffset, samples.length)) }
}

/** Height delta per column, added after every height op. */
export class HeightLayer {
  private readonly values: Int16Array
  private readonly width: number
  constructor(ref: RasterRef) {
    this.values = decodeRaster(ref) as Int16Array
    this.width = ref.width
  }
  at(x: number, z: number): number { return this.values[x + z * this.width] ?? 0 }
}

/** Biome index per 4 × 4 columns, or -1 where the layer is unpainted (stored 0). */
export class BiomeLayer {
  private readonly values: Uint8Array
  private readonly width: number
  constructor(ref: RasterRef) {
    this.values = decodeRaster(ref) as Uint8Array
    this.width = ref.width
  }
  at(x: number, z: number): number {
    const v = this.values[Math.floor(x / BIOME_CELL) + Math.floor(z / BIOME_CELL) * this.width] ?? 0
    return v - 1
  }
}

/** Sparse density sculpt: trilinear over a global 2-block sample grid; missing samples are 0. */
export class DensityLayer {
  private readonly bricks = new Map<number, Int8Array>()
  /** Block-space bounds of every brick, padded by one sample spacing for the trilinear reach. */
  readonly bounds: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }[] = []

  constructor(ref: BrickSetRef) {
    const span = BRICK_SAMPLES * BRICK_SPACING
    for (const b of ref.bricks) {
      const bytes = base64ToBytes(b.data)
      this.bricks.set(key(b.x, b.y, b.z), new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length))
      this.bounds.push({
        x0: b.x * span - BRICK_SPACING, y0: b.y * span - BRICK_SPACING, z0: b.z * span - BRICK_SPACING,
        x1: (b.x + 1) * span, y1: (b.y + 1) * span, z1: (b.z + 1) * span,
      })
    }
  }

  /** Whether any brick can affect the columns in [x0, x1] × [z0, z1]. */
  touches(x0: number, z0: number, x1: number, z1: number): boolean {
    return this.bounds.some((b) => b.x0 <= x1 && b.x1 >= x0 && b.z0 <= z1 && b.z1 >= z0)
  }

  /** Density delta in blocks at a voxel. */
  sample(x: number, y: number, z: number): number {
    const gx = x / BRICK_SPACING, gy = y / BRICK_SPACING, gz = z / BRICK_SPACING
    const ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz)
    const fx = gx - ix, fy = gy - iy, fz = gz - iz
    let v = 0
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1
      const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz)
      if (w > 0) v += w * this.at(ix + dx, iy + dy, iz + dz)
    }
    return v / DENSITY_SCALE
  }

  private at(sx: number, sy: number, sz: number): number {
    const b = this.bricks.get(key(Math.floor(sx / BRICK_SAMPLES), Math.floor(sy / BRICK_SAMPLES), Math.floor(sz / BRICK_SAMPLES)))
    if (!b) return 0
    const lx = sx & (BRICK_SAMPLES - 1), ly = sy & (BRICK_SAMPLES - 1), lz = sz & (BRICK_SAMPLES - 1)
    return b[lx + lz * BRICK_SAMPLES + ly * BRICK_SAMPLES * BRICK_SAMPLES]!
  }
}

/** Brick coordinates fit in 10 bits each (1024 bricks = 16 384 blocks per axis). */
function key(x: number, y: number, z: number): number { return (x & 1023) | ((y & 1023) << 10) | ((z & 1023) << 20) }

function checkRaster(c: Check, path: string, v: unknown, type: 'i16' | 'u8', width: number, height: number): void {
  if (!c.obj(path, v, true)) return
  if (v.type !== type) c.fail(`${path}.type`, `must be ${type}`)
  if (v.width !== width || v.height !== height) c.fail(path, `must be ${width} × ${height}, got ${String(v.width)} × ${String(v.height)}`)
  if (typeof v.data !== 'string') { c.fail(`${path}.data`, 'must be a base64 string'); return }
  try {
    decodeRaster(v as unknown as RasterRef)
  } catch (e) {
    c.fail(`${path}.data`, e instanceof Error ? e.message : String(e))
  }
}

/** Validates the layers object against the world's x/z size. */
export function checkLayers(c: Check, path: string, v: unknown, sizeX: number, sizeZ: number): void {
  if (!c.obj(path, v, true)) return
  checkRaster(c, `${path}.height`, v.height, 'i16', sizeX, sizeZ)
  checkRaster(c, `${path}.biome`, v.biome, 'u8', Math.ceil(sizeX / BIOME_CELL), Math.ceil(sizeZ / BIOME_CELL))
  if (!c.obj(`${path}.density`, v.density, true)) return
  if (!c.arr(`${path}.density.bricks`, v.density.bricks)) return
  v.density.bricks.forEach((b, i) => {
    const bp = `${path}.density.bricks[${i}]`
    if (!c.obj(bp, b)) return
    for (const k of ['x', 'y', 'z'] as const) c.num(`${bp}.${k}`, b[k], { int: true, min: 0, max: 1023 })
    if (typeof b.data !== 'string') { c.fail(`${bp}.data`, 'must be a base64 string'); return }
    try {
      const n = base64ToBytes(b.data).length
      if (n !== BRICK_SAMPLES ** 3) c.fail(`${bp}.data`, `must hold ${BRICK_SAMPLES ** 3} samples, got ${n}`)
    } catch {
      c.fail(`${bp}.data`, 'must be a base64 string')
    }
  })
}
