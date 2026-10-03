import { decodeUniform } from '../world/buffers.ts'
import type { ChunkStore } from '../world/chunkStore.ts'
import { Layout } from '../world/layout.ts'
import { voxelId } from '../world/voxel.ts'

export interface LightTables { opaque: Uint8Array; emits: Uint8Array }

const SKY = 0
const BLOCK = 1
const DOWN = 3

/** Light reaches 15 blocks from a source; a relit area extends this far past the changed columns. */
export const RELIGHT_MARGIN = 16
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

  /**
   * Recomputes light after the voxels of columns [ax0, ax1) × [az0, az1) (full height) were replaced
   * wholesale. The pass covers the area plus RELIGHT_MARGIN; light beyond that cannot have changed,
   * and it flows back in across the border. The result equals a full initialize() of the new world.
   * Works on slot arrays directly, like initialize(), and leaves the touched chunks open for commit().
   */
  relightRegion(ax0: number, az0: number, ax1: number, az1: number): void {
    const store = this.store
    const L = store.layout
    const x0 = Math.max(0, ax0 - RELIGHT_MARGIN), z0 = Math.max(0, az0 - RELIGHT_MARGIN)
    const x1 = Math.min(this.sx, ax1 + RELIGHT_MARGIN), z1 = Math.min(this.sz, az1 + RELIGHT_MARGIN)
    // 1. Reset, chunk column by chunk column, top down: sky light 15 until the first opaque voxel of
    // each voxel column, 0 below; block light cleared; emitters re-seeded. Lanes (lx, lz) run innermost
    // so slot memory is read in order.
    const covered = new Uint8Array(1024)
    const dark: number[] = [] // covered open voxels: the only ones step 2 has to light
    const changed = new Set<number>() // chunks whose light step 1 wrote
    for (let cz = z0 >> 5; cz <= (z1 - 1) >> 5; cz++) for (let cx = x0 >> 5; cx <= (x1 - 1) >> 5; cx++) {
      const lx0 = Math.max(x0 - cx * 32, 0), lx1 = Math.min(x1 - cx * 32, 32)
      const lz0 = Math.max(z0 - cz * 32, 0), lz1 = Math.min(z1 - cz * 32, 32)
      covered.fill(0)
      for (let cy = L.cy - 1; cy >= 0; cy--) {
        const ci = L.chunkIndex(cx, cy, cz)
        const e = store.table[ci]!
        if (e < 0) {
          const id = voxelId(decodeUniform(e))
          if (this.emits[id] === 0) {
            if (this.opaque[id]) { // implied 0 is right, and everything below is covered
              for (let lz = lz0; lz < lz1; lz++) covered.fill(1, lx0 + (lz << 5), lx1 + (lz << 5))
              continue
            }
            let anyCovered = false
            for (let lz = lz0; lz < lz1 && !anyCovered; lz++) for (let lx = lx0; lx < lx1; lx++) if (covered[lx + (lz << 5)]) { anyCovered = true; break }
            if (!anyCovered) continue // open sky everywhere: implied 15 is right
          }
        }
        // A slot chunk is opened (and so remeshed) only if its light actually changes.
        let opened = e < 0
        if (opened) changed.add(ci)
        const slot = opened ? store.writableSlot(ci) : e
        const vox = store.views.voxels(slot), lt = store.views.light(slot)
        for (let ly = 31; ly >= 0; ly--) for (let lz = lz0; lz < lz1; lz++) for (let lx = lx0; lx < lx1; lx++) {
          const lane = lx + (lz << 5), i = lane + (ly << 10)
          const id = voxelId(vox[i]!)
          if (this.opaque[id]) covered[lane] = 1
          const em = this.emits[id]!
          const l = (covered[lane] ? 0 : 15) | (em << 4)
          if (lt[i] !== l) {
            if (!opened) { store.writableSlot(ci); changed.add(ci); opened = true }
            lt[i] = l
          }
          if (em > 0) this.add[BLOCK]!.push(this.pack(cx * 32 + lx, cy * 32 + ly, cz * 32 + lz))
          else if (covered[lane] && !this.opaque[id]) dark.push(this.pack(cx * 32 + lx, cy * 32 + ly, cz * 32 + lz))
        }
      }
    }
    // Direct slot writes bypass the store's border marking: chunks around a relit one sample its light when meshing.
    for (const ci of changed) {
      const [cx, cy, cz] = L.chunkCoords(ci)
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (L.chunkInBounds(cx + dx, cy + dy, cz + dz)) store.markDirty(L.chunkIndex(cx + dx, cy + dy, cz + dz))
      }
    }
    // 2. Dark open voxels take light from their brightest neighbour (inside or outside the area).
    for (const pos of dark) {
      this.unpack(pos)
      const x = this.ux, y = this.uy, z = this.uz
      let best = 0
      for (let d = 0; d < 6; d++) {
        const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
        if (!this.inBounds(nx, ny, nz)) continue
        const nl = store.getLight(nx, ny, nz) & 0xf
        const t = d === 2 && nl === 15 ? 15 : nl - 1
        if (t > best) best = t
      }
      if (best > (store.getLight(x, y, z) & 0xf)) {
        this.setChannel(x, y, z, SKY, best)
        this.add[SKY]!.push(pos)
      }
    }
    // 3. Block light from outside the area flows back in across its border.
    for (let y = 0; y < this.sy; y++) {
      for (let x = x0; x < x1; x++) {
        if (z0 > 0) this.seedBlockFrom(x, y, z0 - 1)
        if (z1 < this.sz) this.seedBlockFrom(x, y, z1)
      }
      for (let z = z0; z < z1; z++) {
        if (x0 > 0) this.seedBlockFrom(x0 - 1, y, z)
        if (x1 < this.sx) this.seedBlockFrom(x1, y, z)
      }
    }
    this.runAdd(SKY)
    this.runAdd(BLOCK)
  }

  private seedBlockFrom(x: number, y: number, z: number): void {
    if (channel(this.store.getLight(x, y, z), BLOCK) > 1) this.add[BLOCK]!.push(this.pack(x, y, z))
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
