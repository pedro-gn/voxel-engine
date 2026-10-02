import { decodeUniform } from '../world/buffers.ts'
import type { ChunkStore } from '../world/chunkStore.ts'
import { Layout } from '../world/layout.ts'
import { voxelId } from '../world/voxel.ts'

export interface LightTables { opaque: Uint8Array; emits: Uint8Array }

const SKY = 0
const BLOCK = 1
const DOWN = 3
const DX = [1, -1, 0, 0, 0, 0]
const DY = [0, 0, 1, -1, 0, 0]
const DZ = [0, 0, 0, 0, 1, -1]

function channel(l: number, ch: number): number { return ch === SKY ? l & 0xf : (l >>> 4) & 0xf }
function withChannel(l: number, ch: number, v: number): number {
  return ch === SKY ? (l & 0xf0) | v : (l & 0x0f) | (v << 4)
}

export class LightEngine {
  private readonly store: ChunkStore
  private readonly opaque: Uint8Array
  private readonly emits: Uint8Array
  private readonly sx: number
  private readonly sy: number
  private readonly sz: number
  private readonly removal: [number[], number[]] = [[], []] // pairs (pos, level)
  private readonly add: [number[], number[]] = [[], []]
  private ux = 0
  private uy = 0
  private uz = 0

  constructor(store: ChunkStore, tables: LightTables) {
    this.store = store
    this.opaque = tables.opaque
    this.emits = tables.emits
    ;[this.sx, this.sy, this.sz] = store.layout.size
  }

  onVoxelChanged(x: number, y: number, z: number, _oldVoxel: number, newVoxel: number): void {
    const pos = this.pack(x, y, z)
    const id = voxelId(newVoxel)
    for (const ch of [SKY, BLOCK]) {
      const l = channel(this.store.getLight(x, y, z), ch)
      if (l > 0) {
        this.setChannel(x, y, z, ch, 0)
        this.removal[ch]!.push(pos, l)
      }
      if (ch === BLOCK && this.emits[id]! > 0) {
        this.setChannel(x, y, z, BLOCK, this.emits[id]!)
        this.add[BLOCK]!.push(pos)
      }
      if (this.opaque[id]) continue
      if (ch === SKY && y === this.sy - 1) {
        this.setChannel(x, y, z, SKY, 15)
        this.add[SKY]!.push(pos)
      }
      for (let d = 0; d < 6; d++) {
        const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
        if (!this.inBounds(nx, ny, nz)) continue
        if (channel(this.store.getLight(nx, ny, nz), ch) > 0) this.add[ch]!.push(this.pack(nx, ny, nz))
      }
    }
  }

  propagate(): void {
    this.runRemoval(SKY)
    this.runRemoval(BLOCK)
    this.runAdd(SKY)
    this.runAdd(BLOCK)
  }

  initialize(): void {
    const store = this.store
    const L = store.layout
    // 1. Sky columns, top-down, chunk by chunk.
    for (let cz = 0; cz < L.cz; cz++) for (let cx = 0; cx < L.cx; cx++) {
      for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
        const x = cx * 32 + lx, z = cz * 32 + lz
        let covered = false
        for (let cy = L.cy - 1; cy >= 0; cy--) {
          const ci = L.chunkIndex(cx, cy, cz)
          const e = store.table[ci]!
          if (e < 0) {
            if (this.opaque[voxelId(decodeUniform(e))]) { covered = true; continue }
            if (!covered) continue // uniform non-opaque under open sky: implied 15 is right
            for (let ly = 31; ly >= 0; ly--) {
              const y = cy * 32 + ly
              this.setChannel(x, y, z, SKY, 0)
            }
            continue
          }
          const vox = store.views.voxels(e)
          const lt = store.views.light(e)
          for (let ly = 31; ly >= 0; ly--) {
            const i = Layout.localIndex(lx, ly, lz)
            if (this.opaque[voxelId(vox[i]!)]) { covered = true; lt[i] = lt[i]! & 0xf0; continue }
            lt[i] = covered ? lt[i]! & 0xf0 : (lt[i]! & 0xf0) | 15
          }
        }
      }
    }
    // Uniform chunks of an emitter would be skipped by the slot loop below: give them a slot first.
    for (let ci = 0; ci < L.chunkCount; ci++) {
      const e = store.table[ci]!
      if (e >= 0) continue
      const em = this.emits[voxelId(decodeUniform(e))]!
      if (em === 0) continue
      const [cx, cy, cz] = L.chunkCoords(ci)
      const x = cx * 32, y = cy * 32, z = cz * 32
      store.setLight(x, y, z, withChannel(store.getLight(x, y, z), BLOCK, em))
    }
    // 2. Seed dark non-opaque voxels from brighter neighbours; 3. seed emitters.
    for (let ci = 0; ci < L.chunkCount; ci++) {
      const slot = store.slotOf(ci)
      if (slot < 0) continue
      const [cx, cy, cz] = L.chunkCoords(ci)
      const vox = store.views.voxels(slot)
      const lt = store.views.light(slot)
      for (let ly = 0; ly < 32; ly++) for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
        const i = Layout.localIndex(lx, ly, lz)
        const id = voxelId(vox[i]!)
        const x = cx * 32 + lx, y = cy * 32 + ly, z = cz * 32 + lz
        if (this.emits[id]! > 0) {
          lt[i] = withChannel(lt[i]!, BLOCK, this.emits[id]!)
          this.add[BLOCK]!.push(this.pack(x, y, z))
        }
        if (this.opaque[id]) continue
        const own = lt[i]! & 0xf
        if (own >= 14) continue
        let best = 0
        for (let d = 0; d < 6; d++) {
          const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
          if (!this.inBounds(nx, ny, nz)) continue
          const nl = this.store.getLight(nx, ny, nz) & 0xf
          const t = d === 2 && nl === 15 ? 15 : nl - 1 // d === 2 is "above": light falling down
          if (t > best) best = t
        }
        if (best > own) {
          lt[i] = withChannel(lt[i]!, SKY, best)
          this.add[SKY]!.push(this.pack(x, y, z))
        }
      }
    }
    this.runAdd(SKY)
    this.runAdd(BLOCK)
  }

  private runRemoval(ch: number): void {
    const q = this.removal[ch]!
    for (let i = 0; i < q.length; i += 2) {
      const level = q[i + 1]!
      this.unpack(q[i]!)
      const x = this.ux, y = this.uy, z = this.uz
      for (let d = 0; d < 6; d++) {
        const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
        if (!this.inBounds(nx, ny, nz)) continue
        const nl = channel(this.store.getLight(nx, ny, nz), ch)
        if (nl === 0) continue
        const npos = this.pack(nx, ny, nz)
        const fromAbove = ch === SKY && d === DOWN && level === 15 && nl === 15
        if (nl < level || fromAbove) {
          this.setChannel(nx, ny, nz, ch, 0)
          q.push(npos, nl)
          if (ch === BLOCK) {
            const e = this.emits[voxelId(this.store.getVoxel(nx, ny, nz))]!
            if (e > 0) { this.setChannel(nx, ny, nz, BLOCK, e); this.add[BLOCK]!.push(npos) }
          }
        } else {
          this.add[ch]!.push(npos)
        }
      }
    }
    q.length = 0
  }

  private runAdd(ch: number): void {
    const q = this.add[ch]!
    for (let i = 0; i < q.length; i++) {
      this.unpack(q[i]!)
      const x = this.ux, y = this.uy, z = this.uz
      const l = channel(this.store.getLight(x, y, z), ch)
      if (l <= 1) continue
      for (let d = 0; d < 6; d++) {
        const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
        if (!this.inBounds(nx, ny, nz)) continue
        if (this.opaque[voxelId(this.store.getVoxel(nx, ny, nz))]) continue
        const target = ch === SKY && d === DOWN && l === 15 ? 15 : l - 1
        if (channel(this.store.getLight(nx, ny, nz), ch) < target) {
          this.setChannel(nx, ny, nz, ch, target)
          q.push(this.pack(nx, ny, nz))
        }
      }
    }
    q.length = 0
  }

  private setChannel(x: number, y: number, z: number, ch: number, v: number): void {
    this.store.setLight(x, y, z, withChannel(this.store.getLight(x, y, z), ch, v))
  }
  private inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz
  }
  private pack(x: number, y: number, z: number): number { return x + z * this.sx + y * this.sx * this.sz }
  private unpack(i: number): void {
    const layer = this.sx * this.sz
    this.uy = Math.floor(i / layer)
    const rest = i - this.uy * layer
    this.uz = Math.floor(rest / this.sx)
    this.ux = rest - this.uz * this.sx
  }
}
