import { LAYER } from '../blocks/registry.ts'
import { padIndex, type ChunkSnapshot } from '../world/reader.ts'
import { voxelId, voxelState } from '../world/voxel.ts'
import { AXES, REVERSE, STRIDE } from './greedy.ts'
import type { QuadBuilder } from './quadBuilder.ts'
import type { MeshTables } from './tables.ts'
import { packA, packB } from './vertexFormat.ts'

export function liquidHeight(level: number): number { return (level + 1) / 9 }

const UP = STRIDE[1]
const qa = new Uint32Array(4)
const qb = new Uint32Array(4)
const corners = [0, 0, 0, 0] // top-corner heights in order (−x,−z) (+x,−z) (+x,+z) (−x,+z)
const SX = [-1, 1, 1, -1]
const SZ = [-1, -1, 1, 1]

function cellHeight(s: ChunkSnapshot, pi: number, id: number): number {
  if (voxelId(s.voxels[pi + UP]!) === id) return 1
  return liquidHeight(voxelState(s.voxels[pi]!) & 7)
}

function cornerHeights(s: ChunkSnapshot, pi: number, id: number): void {
  for (let c = 0; c < 4; c++) {
    const cells = [pi, pi + SX[c]!, pi + SZ[c]! * STRIDE[2], pi + SX[c]! + SZ[c]! * STRIDE[2]]
    let sum = 0, n = 0, full = false
    for (const ci of cells) {
      if (voxelId(s.voxels[ci]!) !== id) continue
      const hgt = cellHeight(s, ci, id)
      if (hgt === 1) { full = true; break }
      sum += hgt
      n++
    }
    corners[c] = full ? 1 : sum / n
  }
}

function cornerIndex(sx: number, sz: number): number {
  return sz < 0 ? (sx < 0 ? 0 : 1) : (sx > 0 ? 2 : 3)
}

export function meshTranslucent(s: ChunkSnapshot, t: MeshTables, out: QuadBuilder): void {
  const p = [0, 0, 0]
  for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
    const pi = padIndex(x + 1, y + 1, z + 1)
    const id = voxelId(s.voxels[pi]!)
    if (t.layer[id] !== LAYER.TRANSLUCENT) continue
    const liquid = t.liquid[id] === 1
    if (liquid) cornerHeights(s, pi, id)
    for (let f = 0; f < 6; f++) {
      const [d, u, v] = AXES[f]!
      const ni = pi + ((f & 1) === 0 ? 1 : -1) * STRIDE[d as 0 | 1 | 2]
      const nid = voxelId(s.voxels[ni]!)
      if (t.opaque[nid] || nid === id) continue
      const l = s.light[ni]!
      const b = packB(t.faceLayers[id * 6 + f]!, l & 15, l >> 4, 1, 1)
      const plane = (f & 1) === 0 ? 1 : 0
      for (let c = 0; c < 4; c++) {
        const cu = c === 1 || c === 2 ? 1 : 0
        const cv = c >= 2 ? 1 : 0
        p[d] = plane; p[u] = cu; p[v] = cv
        const vx = x + p[0]!, vz = z + p[2]!
        let vy = y + p[1]!
        let drop = 0
        if (liquid && p[1] === 1) {
          const hgt = corners[cornerIndex(p[0] ? 1 : -1, p[2] ? 1 : -1)]!
          drop = Math.round((1 - hgt) * 16)
          vy = y + 1
        }
        qa[c] = packA(vx, vy, vz, f, 0, c, drop)
        qb[c] = b
      }
      out.push(qa, qb, false, REVERSE[f]!)
    }
  }
}
