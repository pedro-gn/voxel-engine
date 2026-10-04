import { LAYER } from '../blocks/registry.ts'
import { OUTSIDE, PAD, padIndex, type ChunkSnapshot } from '../world/reader.ts'
import { AIR, voxelId, voxelState } from '../world/voxel.ts'
import { AXES, REVERSE, STRIDE } from './greedy.ts'
import type { QuadBuilder } from './quadBuilder.ts'
import type { MeshTables } from './tables.ts'
import { FACE, FLOW, LIQUID_DEEP, flowCode, packA, packB, packFlow } from './vertexFormat.ts'

export function liquidHeight(level: number): number { return (level + 1) / 9 }

/** Below this corner-height slope (blocks per block) a surface reads as still. */
const FLOW_EPS = 0.05
/** Above it, as steep. */
const FLOW_STEEP = 0.5

const UP = STRIDE[1]
const qa = new Uint32Array(4)
const qb = new Uint32Array(4)
const corners = [0, 0, 0, 0] // top-corner heights in order (-x,-z) (+x,-z) (+x,+z) (-x,+z)
const SX = [-1, 1, 1, -1]
const SZ = [-1, -1, 1, 1]

function level(s: ChunkSnapshot, t: MeshTables, pi: number): number {
  const v = s.voxels[pi]!
  return t.source[voxelId(v)] === 1 ? 7 : voxelState(v) & 7
}

function cellHeight(s: ChunkSnapshot, t: MeshTables, pi: number, group: number): number {
  if (t.liquidGroup[voxelId(s.voxels[pi + UP]!)] === group) return 1
  return liquidHeight(level(s, t, pi))
}

/** Whether padded index pi is a border cell outside the world (the snapshot reads it as air; the sim treats it as a wall). */
function outsideWorld(outside: number, pi: number): boolean {
  const px = pi % PAD, pz = Math.floor(pi / PAD) % PAD
  return (px === 0 && (outside & OUTSIDE.NX) !== 0) || (px === PAD - 1 && (outside & OUTSIDE.PX) !== 0) ||
    (pz === 0 && (outside & OUTSIDE.NZ) !== 0) || (pz === PAD - 1 && (outside & OUTSIDE.PZ) !== 0)
}

function cornerHeights(s: ChunkSnapshot, t: MeshTables, pi: number, group: number): void {
  for (let c = 0; c < 4; c++) {
    const cells = [pi, pi + SX[c]!, pi + SZ[c]! * STRIDE[2], pi + SX[c]! + SZ[c]! * STRIDE[2]]
    let sum = 0, n = 0, full = false
    for (const ci of cells) {
      const id = voxelId(s.voxels[ci]!)
      if (id === AIR) {
        if (s.outside !== 0 && outsideWorld(s.outside, ci)) continue // beyond the world's edge: a wall, left out
        n++ // open air counts as height 0, so edges and falls taper to the ground
        continue
      }
      if (t.liquidGroup[id] !== group) continue // walls (solids, other liquids, plants) are left out
      const hgt = cellHeight(s, t, ci, group)
      if (hgt === 1) { full = true; break }
      sum += hgt
      n++
    }
    corners[c] = full ? 1 : sum / n
  }
}

/** Downhill direction of the current top face from its corner heights, as a flow code. */
function topFlow(): number {
  const fx = (corners[0]! + corners[3]!) - (corners[1]! + corners[2]!) // -gradient along x
  const fz = (corners[0]! + corners[1]!) - (corners[2]! + corners[3]!) // -gradient along z
  const m = Math.hypot(fx, fz)
  if (m < FLOW_EPS) return FLOW.STILL
  const dir = ((Math.round(Math.atan2(fz, fx) / (Math.PI / 4)) % 8) + 8) % 8
  return flowCode(dir, m > FLOW_STEEP)
}

function cornerIndex(sx: number, sz: number): number {
  return sz < 0 ? (sx < 0 ? 0 : 1) : (sx > 0 ? 2 : 3)
}

export function meshTranslucent(s: ChunkSnapshot, t: MeshTables, translucent: QuadBuilder, liquidOut: QuadBuilder): void {
  const p = [0, 0, 0]
  for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
    const pi = padIndex(x + 1, y + 1, z + 1)
    const id = voxelId(s.voxels[pi]!)
    const layer = t.layer[id]
    if (layer !== LAYER.TRANSLUCENT && layer !== LAYER.LIQUID) continue
    const out = layer === LAYER.LIQUID ? liquidOut : translucent
    const liquid = t.liquid[id] === 1
    const group = liquid ? t.liquidGroup[id]! : 0
    // Water at or above its column's floor is the heightfield's (render/water): only static water is meshed here.
    if (liquid && id === t.waterGroup && y >= s.floor[x + 1 + (z + 1) * PAD]!) continue
    if (liquid) cornerHeights(s, t, pi, group)
    const falling = liquid && t.liquidGroup[voxelId(s.voxels[pi + UP]!)] === group
    // Water over water: its top-row vertices carry LIQUID_DEEP, so foam treats the surface as full height however thin
    // the top layer is.
    const deep = liquid && t.liquidGroup[voxelId(s.voxels[pi - UP]!)] === group
    for (let f = 0; f < 6; f++) {
      const [d, u, v] = AXES[f]!
      const ni = pi + ((f & 1) === 0 ? 1 : -1) * STRIDE[d as 0 | 1 | 2]
      const nid = voxelId(s.voxels[ni]!)
      if (t.opaque[nid] || (liquid ? t.liquidGroup[nid] === group : nid === id)) continue
      const l = s.light[ni]!
      const b = packB(t.faceLayers[id * 6 + f]!, l & 15, l >> 4, 1, 1)
      const plane = (f & 1) === 0 ? 1 : 0
      const flow = !liquid ? FLOW.STILL : f === FACE.PY ? topFlow() : f !== FACE.NY && falling ? flowCode(0, true) : FLOW.STILL
      for (let c = 0; c < 4; c++) {
        const cu = c === 1 || c === 2 ? 1 : 0
        const cv = c >= 2 ? 1 : 0
        p[d] = plane; p[u] = cu; p[v] = cv
        const vx = x + p[0]!, vz = z + p[2]!
        let vy = y + p[1]!
        let drop = 0, flags = 0
        if (liquid && p[1] === 1) {
          const hgt = corners[cornerIndex(p[0] ? 1 : -1, p[2] ? 1 : -1)]!
          drop = Math.round((1 - hgt) * 16)
          vy = y + 1
          if (deep) flags = LIQUID_DEEP
        }
        qa[c] = packA(vx, vy, vz, f, flags, c, drop)
        qb[c] = b
        if (flow !== FLOW.STILL) [qa[c], qb[c]] = packFlow(qa[c]!, qb[c]!, flow)
      }
      out.push(qa, qb, false, REVERSE[f]!)
    }
  }
}
