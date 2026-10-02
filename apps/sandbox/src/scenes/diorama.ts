import { defineGenerator } from '@elovox/engine/sim-worker'
import { packVoxel } from '@elovox/engine/src/world/voxel.ts'

export type DioramaBlock = 'stone' | 'dirt' | 'grass' | 'sand' | 'water' | 'log' | 'leaves' | 'rock'
export const DIORAMA_SIZE = [128, 64, 128] as const
export const LOW = 22
export const HIGH = 42

type Noise = (x: number, z: number) => number // [0, 1)

const TREES = [{ x: 18, z: 84, base: HIGH + 1 }, { x: 112, z: 70, base: HIGH + 1 }, { x: 44, z: 40, base: LOW + 1 }]
const ROCKS = [{ x: 56, y: LOW + 1, z: 12, r: 2.6 }, { x: 116, y: HIGH + 1, z: 104, r: 3.2 }, { x: 86, y: LOW + 1, z: 50, r: 2.2 }]
const MOUNDS = [{ x: 100, z: 16, r: 9, h: 6 }, { x: 98, z: 46, r: 7, h: 8 }]

/** < 1 inside a noisy-edged ellipse. */
function ellipse(x: number, z: number, cx: number, cz: number, rx: number, rz: number, noise: Noise): number {
  return Math.hypot((x - cx) / rx, (z - cz) / rz) * (0.92 + noise(x / 8 + 11, z / 8) * 0.16)
}

/** The diorama's blocks for one column, bottom to top (index = y). Pure: the same (x, z, noise) gives the same column. */
export function dioramaColumn(x: number, z: number, noise: Noise): (DioramaBlock | null)[] {
  const col: (DioramaBlock | null)[] = new Array<DioramaBlock | null>(DIORAMA_SIZE[1]).fill(null)
  const upper = z >= 58 + Math.round((noise(x / 11, 3.7) - 0.5) * 10)
  let top = (upper ? HIGH : LOW) + Math.round((noise(x / 13, z / 13) - 0.5) * 2)
  let surface: DioramaBlock = 'grass'
  let water = 0

  if (!upper && x < 34 && z < 52) {
    const n = noise(x / 6 + 40, z / 6)
    if (n > 0.5) { top = LOW + 1 + Math.floor((n - 0.5) * 22); surface = 'stone' }
  }
  if (upper) {
    const lake = ellipse(x, z, 64, 92, 38, 21, noise)
    if (lake < 1) { water = 5; top = HIGH - 6; surface = 'sand' } else if (lake < 1.15) { top = HIGH - 1; surface = 'sand' }
    if (Math.hypot(x - 90, z - 98) < 4.5) { water = 0; top = HIGH - 1; surface = 'grass' }
  } else {
    const pond = ellipse(x, z, 70, 28, 15, 9, noise)
    if (pond < 1) { water = 3; top = LOW - 4; surface = 'sand' } else if (pond < 1.18 && surface === 'grass') surface = 'sand'
  }

  const dirtDepth = upper ? 5 : 3
  for (let y = 0; y <= top; y++) {
    if (y === top) col[y] = surface
    else if (surface === 'grass' && y > top - dirtDepth) col[y] = 'dirt'
    else if (surface === 'sand' && y === top - 1) col[y] = 'sand'
    else col[y] = 'stone'
  }
  for (let y = top + 1; y <= top + water; y++) col[y] = 'water'

  if (upper && z >= 116 && x >= 36 && x <= 56) {
    const base = HIGH - 9
    for (let y = base; y <= HIGH; y++) {
      const ax = (x - 46) / 9, ay = (y - base) / 7
      if (ax * ax + ay * ay < 1) col[y] = null
    }
  }
  if (!upper) {
    for (const m of MOUNDS) {
      const d = Math.hypot(x - m.x, z - m.z) / m.r
      if (d >= 1) continue
      const h = Math.floor(m.h * (1 - d * d))
      for (let y = top + 1; y <= top + h; y++) col[y] = 'sand'
    }
  }
  for (const r of ROCKS) {
    for (let y = 0; y < col.length; y++) {
      if ((x - r.x) ** 2 + ((y - r.y) * 1.3) ** 2 + (z - r.z) ** 2 < r.r * r.r) col[y] = 'rock'
    }
  }
  for (const t of TREES) {
    if (x === t.x && z === t.z) for (let y = top + 1; y <= t.base + 4; y++) col[y] = 'log'
    const cy = t.base + 5
    for (let y = cy - 3; y <= cy + 3; y++) {
      if (col[y] === null && Math.hypot(x - t.x, (y - cy) * 1.2, z - t.z) < 3.2) col[y] = 'leaves'
    }
  }
  return col
}

export const dioramaGenerator = defineGenerator({
  generateColumn(ctx, cx, cz) {
    const ids: Record<DioramaBlock, number> = {
      stone: ctx.id('stone'), dirt: ctx.id('dirt'), grass: ctx.id('grass'), sand: ctx.id('sand'),
      water: packVoxel(ctx.id('water'), 7), log: ctx.id('log'), leaves: ctx.id('leaves'), rock: ctx.id('rock'),
    }
    const noise: Noise = (x, z) => ctx.fbm2(x, z, 3)
    for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
      const col = dioramaColumn(cx * 32 + lx, cz * 32 + lz, noise)
      for (let y = 0; y < col.length; y++) {
        const b = col[y]
        if (b) ctx.set(lx, y, lz, ids[b])
      }
    }
  },
})
