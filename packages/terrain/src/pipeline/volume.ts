import type { VolumeOp } from '../ops/registry.ts'
import { TerrainOpError, type CompiledTerrain } from './compile.ts'

/** Volume ops are sampled every LATTICE blocks on a grid aligned to world multiples of LATTICE. */
export const LATTICE = 4

interface OpLattice {
  op: VolumeOp
  /** Voxel ranges (inclusive) where the op applies, already clamped to the region and the world. */
  xa: number; xb: number; ya: number; yb: number; za: number; zb: number
  gx0: number; gy0: number; gz0: number
  nx: number; nz: number
  values: Float64Array
}

/**
 * The 3D stage for one rectangle of columns. Lattice values depend only on world coordinates, so any
 * rectangle that covers a voxel interpolates the same value for it: columns and regions agree.
 */
export class VolumeField {
  private readonly lattices: OpLattice[] = []
  private readonly height: number
  private readonly t: CompiledTerrain
  private readonly density: Float64Array
  private readonly useLayer: boolean

  constructor(t: CompiledTerrain, x0: number, z0: number, w: number, d: number) {
    this.t = t
    this.height = t.height
    this.density = new Float64Array(t.height)
    this.useLayer = t.densityLayer !== null && t.densityLayer.touches(x0, z0, x0 + w - 1, z0 + d - 1)
    for (const op of t.volumeOps) {
      const b = op.bounds
      const xa = Math.max(x0, Math.ceil(b.x0)), xb = Math.min(x0 + w - 1, Math.floor(b.x1))
      const za = Math.max(z0, Math.ceil(b.z0)), zb = Math.min(z0 + d - 1, Math.floor(b.z1))
      const ya = Math.max(0, Math.ceil(b.y0)), yb = Math.min(t.height - 1, Math.floor(b.y1))
      if (xa > xb || za > zb || ya > yb) continue
      const gx0 = Math.floor(xa / LATTICE), gy0 = Math.floor(ya / LATTICE), gz0 = Math.floor(za / LATTICE)
      const nx = Math.floor(xb / LATTICE) + 2 - gx0, ny = Math.floor(yb / LATTICE) + 2 - gy0, nz = Math.floor(zb / LATTICE) + 2 - gz0
      const values = new Float64Array(nx * ny * nz)
      try {
        for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
          values[i + k * nx + j * nx * nz] = op.density((gx0 + i) * LATTICE, (gy0 + j) * LATTICE, (gz0 + k) * LATTICE)
        }
      } catch (e) {
        throw new TerrainOpError(op.id, `at columns x ${xa}..${xb}, z ${za}..${zb}`, e)
      }
      this.lattices.push({ op, xa, xb, ya, yb, za, zb, gx0, gy0, gz0, nx, nz, values })
    }
  }

  /** Whether any volume op or density brick reaches this rectangle. */
  get empty(): boolean { return this.lattices.length === 0 && !this.useLayer }

  /** Fills solid[y] (1/0) for the column at (x, z) whose ground height is `top`. */
  column(x: number, z: number, top: number, solid: Uint8Array): void {
    const H = this.height
    let touched = this.useLayer
    if (!touched) for (const l of this.lattices) if (x >= l.xa && x <= l.xb && z >= l.za && z <= l.zb) { touched = true; break }
    if (!touched) {
      for (let y = 0; y < H; y++) solid[y] = y < top ? 1 : 0
      return
    }
    const dens = this.density
    for (let y = 0; y < H; y++) dens[y] = top - y - 0.5
    for (const l of this.lattices) {
      if (x < l.xa || x > l.xb || z < l.za || z > l.zb) continue
      const fx = x / LATTICE - l.gx0, fz = z / LATTICE - l.gz0
      const ix = Math.floor(fx), iz = Math.floor(fz)
      const tx = fx - ix, tz = fz - iz
      const nxz = l.nx * l.nz
      const add = l.op.mode === 'add'
      for (let y = l.ya; y <= l.yb; y++) {
        const fy = y / LATTICE - l.gy0
        const iy = Math.floor(fy), ty = fy - iy
        const b = ix + iz * l.nx + iy * nxz
        const v = l.values
        const c00 = v[b]! + (v[b + 1]! - v[b]!) * tx
        const c10 = v[b + l.nx]! + (v[b + l.nx + 1]! - v[b + l.nx]!) * tx
        const c01 = v[b + nxz]! + (v[b + nxz + 1]! - v[b + nxz]!) * tx
        const c11 = v[b + nxz + l.nx]! + (v[b + nxz + l.nx + 1]! - v[b + nxz + l.nx]!) * tx
        const lo = c00 + (c10 - c00) * tz, hi = c01 + (c11 - c01) * tz
        const s = lo + (hi - lo) * ty
        dens[y] = add ? Math.max(dens[y]!, s) : Math.min(dens[y]!, -s)
      }
    }
    if (this.useLayer) {
      const layer = this.t.densityLayer!
      for (let y = 0; y < H; y++) dens[y] = dens[y]! + layer.sample(x, y, z)
    }
    for (let y = 0; y < H; y++) solid[y] = dens[y]! > 0 ? 1 : 0
  }
}
