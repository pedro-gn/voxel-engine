// Vitest-free benchmark fixture shared by mesher.bench.ts and mesher.node.ts.
import { postState, slabState, stairState, type Facing } from '../src/blocks/shapes.ts'
import { valueNoise2 } from '../src/sim/generator.ts'
import { padIndex, type ChunkSnapshot } from '../src/world/reader.ts'
import { packLight, packVoxel } from '../src/world/voxel.ts'
import { decoratedMeshTables, emptySnap, MEADOW } from '../test/meshFixtures.ts'
import { ID } from '../test/helpers.ts'

export { decoratedMeshTables as meshTables } from '../test/meshFixtures.ts'

/** The bench tables with the shaped stone blocks (ids 8–10) registered. */
export function shapedMeshTables() { return decoratedMeshTables([MEADOW], true) }

/** A rolling grass surface crossing the chunk, typical of the diorama terrain. */
export function surfaceSnap(): ChunkSnapshot {
  const s = emptySnap()
  for (let pz = 0; pz < 34; pz++) for (let px = 0; px < 34; px++) {
    const h = 8 + Math.floor(valueNoise2(3, px / 9, pz / 9) * 16)
    for (let py = 0; py < 34; py++) {
      const i = padIndex(px, py, pz)
      if (py < h - 3) s.voxels[i] = ID.stone
      else if (py < h - 1) s.voxels[i] = ID.dirt
      else if (py === h - 1) s.voxels[i] = ID.grass
      if (py < h) s.light[i] = 0
      else s.light[i] = packLight(15, 0)
    }
  }
  return s
}

/** Sets a chunk-local cell (−1..32 reach the apron); a light-blocking shape's cell holds no light, as the sim stores it. */
function set(s: ChunkSnapshot, x: number, y: number, z: number, v: number): void {
  const i = padIndex(x + 1, y + 1, z + 1)
  s.voxels[i] = v
  if ((v & 0xfff) !== ID.stone_post) s.light[i] = 0
}

/** The facing of a ring cell that looks into a square ring's centre: rows face ±z, columns ±x, corners take their row's. */
function inward(lx: number, lz: number, n: number): Facing {
  return lz === 0 ? 1 : lz === n - 1 ? 3 : lx === 0 ? 0 : 2
}

/** A hip roof over an n × n square (n odd) at (x0, y0, z0): rings of upright stairs facing in, each held by an upside-down ring facing out, a cube peak. */
function hipRoof(s: ChunkSnapshot, x0: number, y0: number, z0: number, n: number): void {
  for (let k = 0; 2 * k < n - 1; k++) {
    const m = n - 2 * k
    for (let lz = 0; lz < m; lz++) for (let lx = 0; lx < m; lx++) {
      if (lx > 0 && lx < m - 1 && lz > 0 && lz < m - 1) continue
      set(s, x0 + k + lx, y0 + k, z0 + k + lz, packVoxel(ID.stone_stair, stairState(inward(lx, lz, m))))
    }
    const inner = m - 2
    if (inner < 3) continue
    for (let lz = 0; lz < inner; lz++) for (let lx = 0; lx < inner; lx++) {
      if (lx > 0 && lx < inner - 1 && lz > 0 && lz < inner - 1) continue
      const f = inward(lx, lz, inner)
      set(s, x0 + k + 1 + lx, y0 + k, z0 + k + 1 + lz, packVoxel(ID.stone_stair, stairState(((f + 2) & 3) as Facing, true)))
    }
  }
  const c = (n - 1) / 2
  set(s, x0 + c, y0 + c - 1, z0 + c, ID.stone) // the peak, in the middle of the last ring
}

/** The surface chunk with dense roofs above it: four 7 × 7 hip roofs, a slab ridge row, posts and x/z beams. */
export function roofsSnap(): ChunkSnapshot {
  const s = surfaceSnap()
  for (const [x, z] of [[1, 1], [9, 1], [1, 9], [9, 9]] as const) hipRoof(s, x, 25, z, 7)
  for (let x = 0; x < 32; x++) set(s, x, 27, 20, packVoxel(ID.stone_slab, slabState(x % 2 === 1)))
  for (const [x, z] of [[18, 2], [24, 2], [18, 8], [24, 8], [30, 2], [30, 8]] as const) {
    for (let y = 24; y < 28; y++) set(s, x, y, z, packVoxel(ID.stone_post, postState('y')))
  }
  for (let x = 18; x < 31; x++) { set(s, x, 28, 2, packVoxel(ID.stone_post, postState('x'))); set(s, x, 28, 8, packVoxel(ID.stone_post, postState('x'))) }
  for (let z = 2; z <= 8; z++) set(s, 24, 29, z, packVoxel(ID.stone_post, postState('z')))
  return s
}

/** The worst case, reported not gated: every cell of the chunk a stair, facings and halves mixed. */
export function stairsSnap(): ChunkSnapshot {
  const s = emptySnap()
  for (let y = -1; y <= 32; y++) for (let z = -1; z <= 32; z++) for (let x = -1; x <= 32; x++) {
    set(s, x, y, z, packVoxel(ID.stone_stair, stairState(((x * 3 + z * 5 + y) & 3) as Facing, ((x + y + z) & 4) !== 0)))
  }
  return s
}
