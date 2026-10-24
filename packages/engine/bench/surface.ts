// Vitest-free benchmark fixture shared by mesher.bench.ts and mesher.node.ts.
import { postState, slabState, stairState, type Facing } from '../src/blocks/shapes.ts'
import { valueNoise2 } from '../src/sim/generator.ts'
import { padIndex, type ChunkSnapshot } from '../src/world/reader.ts'
import { packLight, packVoxel } from '../src/world/voxel.ts'
import { BlockRegistry, type BlockDef } from '../src/blocks/registry.ts'
import { DecorationRegistry } from '../src/render/decorations/defs.ts'
import { meshTablesFrom, type MeshTables } from '../src/mesh/tables.ts'
import { decoratedMeshTables, emptySnap, MEADOW } from '../test/meshFixtures.ts'
import { ID, TEST_BLOCKS } from '../test/helpers.ts'

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

/** The canopy registry's extra block: a log, after `TEST_BLOCKS` (id 8). */
const LOG = 8

/** `TEST_BLOCKS` with meadow grass and a log; `opts` turns on the leaves' tone and fringe (Tasks 3–4 of SP16). */
function canopyTables(opts: { tone?: boolean; fringe?: boolean }): MeshTables {
  const leaves = (b: BlockDef): BlockDef => ({
    ...b,
    ...(opts.tone && { tone: { dark: [0.45, 0.6, 0.5], light: [1.25, 1.2, 0.95] } as const }),
  })
  const blocks: BlockDef[] = TEST_BLOCKS.map((b) => (b.name === 'grass' ? { ...b, decoration: MEADOW.name } : b.name === 'leaves' ? leaves(b) : b))
  blocks.push({ name: 'log', textures: { top: 'log_top', side: 'log_side', bottom: 'log_top' } })
  const reg = new BlockRegistry(blocks)
  const deco = new DecorationRegistry([MEADOW], reg)
  return meshTablesFrom(reg, reg.faceLayers(new Map(reg.textureNames().map((n, i) => [n, i + 1]))), deco.tables)
}

/**
 * A forest chunk: a grass floor and 16 round leaf crowns (7 wide, ragged, two heights) on log trunks, spaced 9 apart so
 * the last row and column reach into the next chunks (the apron). Leaves carry a tone 0–3 in their state, lighter higher
 * up the crown; a world without the tone option ignores it.
 */
export function canopySnap(opts: { tone?: boolean; fringe?: boolean } = {}): { snap: ChunkSnapshot; tables: MeshTables } {
  const s = emptySnap()
  for (let pz = 0; pz < 34; pz++) for (let px = 0; px < 34; px++) for (let py = 0; py < 4; py++) {
    const i = padIndex(px, py, pz)
    s.voxels[i] = py < 2 ? ID.stone : py < 3 ? ID.dirt : ID.grass
    s.light[i] = 0
  }
  for (let tz = 0; tz < 4; tz++) for (let tx = 0; tx < 4; tx++) {
    const cx = 3 + tx * 9, cz = 3 + tz * 9, top = (tx + tz) % 2 === 0 ? 9 : 13, cy = top + 3
    for (let y = 3; y < top + 2; y++) set(s, cx, y, cz, LOG)
    for (let dy = -3; dy <= 3; dy++) for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
      const x = cx + dx, y = cy + dy, z = cz + dz
      if (x > 32 || z > 32 || dx * dx + dy * dy + dz * dz > 11) continue
      if (dx === 0 && dz === 0 && dy < 2) continue // the trunk runs into the crown
      if (valueNoise2(7, x * 0.9 + y * 0.31, z * 0.9 - y * 0.27) > 0.8) continue // ragged edge
      set(s, x, y, z, packVoxel(ID.leaves, Math.min(3, Math.max(0, dy + 2))))
    }
  }
  return { snap: s, tables: canopyTables(opts) }
}
