import { defineGenerator, packVoxel, postState, roofState, slabState, stairState, type Facing, type PostAxis } from '@elovox/engine/sim-worker'

export const SHAPES_SIZE = [96, 32, 64] as const
/** The ground's top layer; everything stands on it from y GROUND + 1. */
export const GROUND = 8

type Put = (x: number, y: number, z: number, block: string, state?: number) => void

/** Every shape in every orientation, each next to a cube of its material: planks stairs, stone stairs, slabs and posts. */
function rows(put: Put): void {
  for (const [z, mat] of [[6, 'planks'], [10, 'stone']] as const) {
    for (let i = 0; i < 8; i++) {
      const x = 4 + i * 3, facing = (i & 3) as Facing, upsideDown = i >= 4
      put(x, GROUND + 1, z, `${mat}_stair`, stairState(facing, upsideDown))
      put(x + 1, GROUND + 1, z, mat)
    }
  }
  const slabs: [string, boolean][] = [['planks_slab', false], ['planks_slab', true], ['stone_slab', false], ['stone_slab', true]]
  slabs.forEach(([block, top], i) => { put(4 + i * 3, GROUND + 1, 14, block, slabState(top)); put(5 + i * 3, GROUND + 1, 14, block.replace('_slab', '')) })
  ;(['y', 'x', 'z'] as PostAxis[]).forEach((axis, i) => { put(16 + i * 3, GROUND + 1, 14, 'planks_post', postState(axis)); put(17 + i * 3, GROUND + 1, 14, 'planks') })
}

/** A planks box with walls GROUND + 1..GROUND + 3 around (x0..x1, z0..z1), a door on its −z side. */
function walls(put: Put, x0: number, z0: number, x1: number, z1: number, inside = (x: number, z: number) => x >= x0 && x <= x1 && z >= z0 && z <= z1): void {
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    if (!inside(x, z)) continue
    const edge = !inside(x - 1, z) || !inside(x + 1, z) || !inside(x, z - 1) || !inside(x, z + 1) || !inside(x - 1, z - 1) || !inside(x + 1, z - 1) || !inside(x - 1, z + 1) || !inside(x + 1, z + 1)
    if (!edge) continue
    for (let y = GROUND + 1; y <= GROUND + 3; y++) if (!(z === z0 && x === x0 + 2 && y < GROUND + 3)) put(x, y, z, 'planks')
  }
}

/** A gable roof along x over (x0..x1, z0..z0 + 6): stairs climbing from both long sides, a cube and a slab on the ridge, gable ends filled. */
function gable(put: Put, x0: number, x1: number, z0: number): void {
  walls(put, x0, z0, x1, z0 + 6)
  const y0 = GROUND + 4
  for (let k = 0; k < 3; k++) for (let x = x0; x <= x1; x++) {
    put(x, y0 + k, z0 + k, 'planks_stair', stairState(1))
    put(x, y0 + k, z0 + 6 - k, 'planks_stair', stairState(3))
    if (x === x0 || x === x1) for (let z = z0 + k + 1; z < z0 + 6 - k; z++) put(x, y0 + k, z, 'planks')
  }
  for (let x = x0; x <= x1; x++) { put(x, y0 + 2, z0 + 3, 'planks'); put(x, y0 + 3, z0 + 3, 'planks_slab', slabState(false)) }
}

/**
 * A hip roof over any footprint: ring k (Chebyshev distance k from the outside) holds upright stairs facing inward at
 * height k, each held by an upside-down stair facing out one below; cells with nothing deeper (the peak or the ridge)
 * hold a cube in the last ring's layer. Facing: the one deeper side; at a concave corner (two) the z one; at an outer
 * corner (only a diagonal is deeper) the z part of that diagonal, so rows' facings win at corners.
 */
function hipRoof(put: Put, inside: (x: number, z: number) => boolean, x0: number, z0: number, x1: number, z1: number, y0: number, block: string): void {
  const dist = (x: number, z: number): number => {
    if (!inside(x, z)) return -1
    for (let r = 1; ; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) === r && !inside(x + dx, z + dz)) return r - 1
    }
  }
  const DIRS: [Facing, number, number][] = [[0, 1, 0], [1, 0, 1], [2, -1, 0], [3, 0, -1]]
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    const k = dist(x, z)
    if (k < 0) continue
    const deeper = DIRS.filter(([, dx, dz]) => dist(x + dx, z + dz) > k)
    let facing: Facing | null = deeper.length === 1 ? deeper[0]![0] : deeper.length === 2 ? deeper.find(([, dx]) => dx === 0)![0] : null
    if (deeper.length === 0) {
      for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) if (dist(x + dx, z + dz) > k) facing = dz > 0 ? 1 : 3
    }
    if (facing === null) { put(x, y0 + k - 1, z, block.replace('_stair', '')); continue }
    put(x, y0 + k, z, block, stairState(facing))
    if (k > 0) put(x, y0 + k - 1, z, block, stairState(((facing + 2) & 3) as Facing, true))
  }
}

/** Posts at the ends of a planks wall, an x beam over it and z beams across the posts' tops. */
function frame(put: Put, x0: number, x1: number, z: number): void {
  for (let x = x0 + 1; x < x1; x++) for (let y = GROUND + 1; y <= GROUND + 3; y++) put(x, y, z, 'planks')
  for (const x of [x0, x1]) {
    for (let y = GROUND + 1; y <= GROUND + 4; y++) put(x, y, z, 'planks_post', postState('y'))
    for (let dz = -2; dz <= 2; dz++) if (dz !== 0) put(x, GROUND + 4, z + dz, 'planks_post', postState('z'))
  }
  for (let x = x0 + 1; x < x1; x++) put(x, GROUND + 4, z, 'planks_post', postState('x'))
}

/** A roof block by cell: one block, or alternating two by cell parity (a roof mid-upgrade, half tile half thatch). */
type RoofBlock = string | readonly [string, string]
const roofBlock = (b: RoofBlock, x: number, z: number): string => (typeof b === 'string' ? b : b[(x + z) & 1]!)

/** A 5-wide gable of roof pieces over planks walls (x0..x1, z0..z0 + 4): eave rows, upper rows, a ridge along x, gable ends filled. */
function roofGable(put: Put, x0: number, x1: number, z0: number, b: RoofBlock): void {
  walls(put, x0, z0, x1, z0 + 4)
  const y = GROUND + 4
  for (let x = x0; x <= x1; x++) {
    const r = (dy: number, z: number, state: number) => put(x, y + dy, z, roofBlock(b, x, z), state)
    r(0, z0, roofState('slope', 1)); r(0, z0 + 4, roofState('slope', 3))
    r(1, z0 + 1, roofState('slope', 1)); r(1, z0 + 3, roofState('slope', 3))
    r(1, z0 + 2, roofState('ridge', 1))
  }
  for (const x of [x0, x1]) for (let z = z0 + 1; z <= z0 + 3; z++) put(x, y, z, 'planks')
}

/** A 5 × 5 hip of roof pieces over planks walls at (x0, z0): the outer ring, the inner ring one up, an apex. */
function roofHip(put: Put, x0: number, z0: number, b: RoofBlock): void {
  walls(put, x0, z0, x0 + 4, z0 + 4)
  const inward = (lx: number, lz: number, n: number): Facing => (lz === 0 ? 1 : lz === n - 1 ? 3 : lx === 0 ? 0 : 2)
  for (let k = 0; k < 2; k++) {
    const n = 5 - 2 * k
    for (let lz = 0; lz < n; lz++) for (let lx = 0; lx < n; lx++) {
      if (lx > 0 && lx < n - 1 && lz > 0 && lz < n - 1) continue
      const x = x0 + k + lx, z = z0 + k + lz
      put(x, GROUND + 4 + k, z, roofBlock(b, x, z), roofState('slope', inward(lx, lz, n)))
    }
  }
  put(x0 + 2, GROUND + 5, z0 + 2, roofBlock(b, x0 + 2, z0 + 2), roofState('apex'))
}

/**
 * An L of 4-wide wings (x0..x0 + 9 by z0..z0 + 3, and x0..x0 + 3 by z0..z0 + 9) under a hip of roof pieces: the outline
 * ring facing in (hip corners outside, a valley at the inner corner), and one up the 2-wide top strip whose rows face
 * each other, hip ends at the wings' ends, a hip and a valley where the wings meet.
 */
function roofEll(put: Put, x0: number, z0: number, b: RoofBlock): void {
  const inside = (x: number, z: number) => (x >= 0 && x <= 9 && z >= 0 && z <= 3) || (x >= 0 && x <= 3 && z >= 0 && z <= 9)
  walls(put, x0, z0, x0 + 9, z0 + 9, (x, z) => inside(x - x0, z - z0))
  const r = (x: number, dy: number, z: number, f: Facing) => put(x0 + x, GROUND + 4 + dy, z0 + z, roofBlock(b, x0 + x, z0 + z), roofState('slope', f))
  // The outline: rows face ±z, columns ±x; outer corners take their row's facing, the inner corner (3, 3) too.
  for (let x = 0; x <= 9; x++) r(x, 0, 0, 1)
  for (let x = 3; x <= 9; x++) r(x, 0, 3, 3)
  for (let z = 1; z <= 9; z++) r(0, 0, z, z === 9 ? 3 : 0)
  for (let z = 4; z <= 9; z++) r(3, 0, z, z === 9 ? 3 : 2)
  r(9, 0, 1, 2); r(9, 0, 2, 2)
  r(1, 0, 9, 3); r(2, 0, 9, 3)
  // The top strip, one up.
  for (let x = 1; x <= 7; x++) { r(x, 1, 1, 1); if (x >= 2) r(x, 1, 2, 3) }
  for (let z = 2; z <= 7; z++) { r(1, 1, z, 0); if (z >= 3) r(2, 1, z, 2) }
  r(8, 1, 1, 2); r(8, 1, 2, 2) // hip end of the x wing
  r(1, 1, 8, 3); r(2, 1, 8, 3) // hip end of the z wing
}

/** Every placement of the scene, by world position. Pure. */
export function shapesScene(): Map<string, [string, number]> {
  const out = new Map<string, [string, number]>()
  const put: Put = (x, y, z, block, state = 0) => { out.set(`${x},${y},${z}`, [block, state]) }
  rows(put)
  gable(put, 36, 44, 4)
  const square = (x: number, z: number) => x >= 52 && x <= 58 && z >= 4 && z <= 10
  walls(put, 52, 4, 58, 10, square)
  hipRoof(put, square, 52, 4, 58, 10, GROUND + 4, 'planks_stair')
  // An L: an 11 × 5 wing and a 5 × 11 wing; its concave corner draws inner corners.
  const ell = (x: number, z: number) => (x >= 36 && x <= 46 && z >= 30 && z <= 34) || (x >= 36 && x <= 40 && z >= 30 && z <= 40)
  walls(put, 36, 30, 46, 40, ell)
  hipRoof(put, ell, 36, 30, 46, 40, GROUND + 4, 'stone_stair')
  frame(put, 64, 74, 34)
  // The roof kit (the roof shape): each form in both roof blocks, the hip once mixed (half tile, half thatch).
  roofGable(put, 4, 10, 22, 'roof_tile')
  roofGable(put, 14, 20, 22, 'roof_thatch')
  roofHip(put, 24, 22, 'roof_tile')
  roofHip(put, 4, 34, ['roof_tile', 'roof_thatch'])
  roofEll(put, 12, 34, 'roof_tile')
  roofEll(put, 78, 4, 'roof_thatch')
  roofHip(put, 84, 34, 'roof_thatch')
  return out
}

export const shapesGenerator = defineGenerator({
  generateColumn(ctx, cx, cz) {
    const placed = shapesScene()
    const stone = ctx.id('stone'), dirt = ctx.id('dirt'), grass = ctx.id('grass')
    for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
      for (let y = 0; y <= GROUND; y++) ctx.set(lx, y, lz, y === GROUND ? grass : y > GROUND - 3 ? dirt : stone)
    }
    for (const [key, [block, state]] of placed) {
      const [x, y, z] = key.split(',').map(Number) as [number, number, number]
      if (x >> 5 === cx && z >> 5 === cz) ctx.set(x & 31, y, z & 31, packVoxel(ctx.id(block), state))
    }
  },
})
