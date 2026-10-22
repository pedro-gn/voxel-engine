// The routeFuzz terrain, shared by routeFuzz.test.ts and the ladder navigation tests.
import { BlockRegistry } from '../src/blocks/registry.ts'
import { Layout } from '../src/world/layout.ts'
import { Pcg32 } from '../src/sim/rng.ts'
import type { NavigationSystem } from '../src/sim/navigation/navigation.ts'

export const SIDE = 96
/** Block ids of the fuzz worlds: 1 stone, 2 a ladder (only placed when `ladders` is set). */
export const FUZZ_LADDER = 2

/**
 * Seeded 96 × 32 × 96 terrain: hills 4–9 high, three walls, and a cave tunnel whose stair entrance exists every other world.
 * `ladders`: after the terrain, ladders are sprinkled on wall faces (columns of 1–6 rungs in clear cells beside stone),
 * drawn from a second generator so the terrain stays the same. `ladderDef`: the registry knows a ladder (navigation then has
 * six directions) even when none is placed.
 */
export function fuzzWorld(seed: number, ladders = false, ladderDef = ladders) {
  const rng = new Pcg32(seed), layout = new Layout([SIDE, 32, SIDE]), solid = new Uint8Array(layout.voxelCount)
  const hills = Array.from({ length: 4 }, () => [rng.nextInt(SIDE), rng.nextInt(SIDE), 10 + rng.nextInt(30), 1 + rng.nextInt(5)] as const)
  for (let z = 0; z < SIDE; z++) for (let x = 0; x < SIDE; x++) {
    let h = 4
    for (const [hx, hz, r, top] of hills) h += Math.max(0, Math.floor(top * (r - Math.hypot(x - hx, z - hz)) / r))
    for (let y = 0; y < Math.min(9, h); y++) solid[layout.voxelIndex(x, y, z)] = 1
  }
  const top = (x: number, z: number) => { let y = 31; while (y > 0 && !solid[layout.voxelIndex(x, y - 1, z)]) y--; return y }
  for (let w = 0; w < 3; w++) {
    const along = rng.nextInt(2), length = 10 + rng.nextInt(40), x0 = rng.nextInt(SIDE), z0 = rng.nextInt(SIDE)
    for (let i = 0; i < length; i++) {
      const x = along ? Math.min(SIDE - 1, x0 + i) : x0, z = along ? z0 : Math.min(SIDE - 1, z0 + i), y0 = top(x, z)
      for (let y = y0; y < Math.min(31, y0 + 4); y++) solid[layout.voxelIndex(x, y, z)] = 1
    }
  }
  // A tunnel at y = 1..2 along x; its stair climbs one block per step toward -x up to the surface.
  const tz = 8 + rng.nextInt(SIDE - 16), tx0 = 30 + rng.nextInt(20), tx1 = Math.min(SIDE - 2, tx0 + 20 + rng.nextInt(30))
  for (let x = tx0; x <= tx1; x++) for (let y = 1; y <= 2; y++) solid[layout.voxelIndex(x, y, tz)] = 0
  if (seed % 2 === 0) {
    solid[layout.voxelIndex(tx0, 3, tz)] = 0 // headroom to climb out of the tunnel
    for (let s = 1; tx0 - s >= 0 && 1 + s < top(tx0 - s, tz); s++) for (let y = 1 + s; y < 31; y++) solid[layout.voxelIndex(tx0 - s, y, tz)] = 0
  }
  if (ladders) {
    const lr = new Pcg32(seed * 7919 + 13)
    for (let n = 0; n < 160; n++) {
      const x = 1 + lr.nextInt(SIDE - 2), z = 1 + lr.nextInt(SIDE - 2), y0 = top(x, z), rungs = 1 + lr.nextInt(6)
      for (let y = y0; y < Math.min(31, y0 + rungs); y++) {
        const at = layout.voxelIndex(x, y, z)
        if (solid[at]) break
        const wall = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => solid[layout.voxelIndex(x + dx!, y, z + dz!)] === 1)
        if (!wall) break
        solid[at] = FUZZ_LADDER
      }
    }
  }
  const registry = new BlockRegistry(ladderDef ? [{ name: 'stone' }, { name: 'ladder', solid: false, climbable: true }] : [{ name: 'stone' }])
  return { layout, rng, solid, port: { layout, registry, get: (x: number, y: number, z: number) => layout.inBounds(x, y, z) ? solid[layout.voxelIndex(x, y, z)]! : 0 } }
}

export function standing(nav: NavigationSystem, layout: Layout, rng: Pcg32): number {
  for (;;) {
    const x = rng.nextInt(SIDE), z = rng.nextInt(SIDE), ys: number[] = []
    for (let y = 0; y < 31; y++) if (nav.stand(x, y, z)) ys.push(y)
    if (ys.length) return layout.voxelIndex(x, ys[rng.nextInt(ys.length)]!, z)
  }
}
