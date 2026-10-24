import { LAYER } from '../blocks/registry.ts'
import { padIndex, type ChunkSnapshot } from '../world/reader.ts'
import { voxelId, voxelState } from '../world/voxel.ts'
import { flipDiagonal, vertexAO } from './ao.ts'
import type { QuadBuilder } from './quadBuilder.ts'
import type { MeshTables } from './tables.ts'
import { CUT_BIT, packA, packB, toneLayer } from './vertexFormat.ts'
import type { CutPlane } from './meshJob.ts'
import { faceLight } from './shapes.ts'

/** Padded-index stride per world axis: x, y, z. */
export const STRIDE = [1, 34 * 34, 34] as const
/** [d, u, v] world axes per face. */
export const AXES: readonly (readonly [number, number, number])[] = [
  [0, 2, 1], [0, 2, 1], [1, 0, 2], [1, 0, 2], [2, 0, 1], [2, 0, 1],
]
export const REVERSE: readonly boolean[] = [true, false, true, false, false, true]
const SU = [-1, 1, 1, -1]
const SV = [-1, -1, 1, 1]

function isOpaque(s: ChunkSnapshot, t: MeshTables, pi: number): boolean {
  return t.opaque[voxelId(s.voxels[pi]!)] === 1
}

/** AO of the 4 corners of face f, for the face whose front cell is at padded index nIndex. */
export function faceAO(s: ChunkSnapshot, t: MeshTables, nIndex: number, f: number): number {
  const [, u, v] = AXES[f]!
  const su = STRIDE[u as 0 | 1 | 2], sv = STRIDE[v as 0 | 1 | 2]
  let packed = 0
  for (let c = 0; c < 4; c++) {
    const du = SU[c]! * su, dv = SV[c]! * sv
    const o = vertexAO(isOpaque(s, t, nIndex + du), isOpaque(s, t, nIndex + dv), isOpaque(s, t, nIndex + du + dv))
    packed |= o << (c * 2)
  }
  return packed
}

const qa = new Uint32Array(4)
const qb = new Uint32Array(4)
const pos = [0, 0, 0]

function emitQuad(
  out: QuadBuilder, f: number, s: number, u0: number, v0: number, w: number, h: number,
  tex: number, ao4: number, sky: number, blk: number, cut = 0,
): void {
  const [d, u, v] = AXES[f]!
  const plane = (f & 1) === 0 ? s + 1 : s
  const b = packB(tex, sky, blk)
  for (let c = 0; c < 4; c++) {
    pos[d] = plane
    pos[u] = c === 1 || c === 2 ? u0 + w : u0
    pos[v] = c >= 2 ? v0 + h : v0
    qa[c] = (packA(pos[0]!, pos[1]!, pos[2]!, f, (ao4 >> (c * 2)) & 3, c) | (cut ? CUT_BIT : 0)) >>> 0
    qb[c] = b
  }
  const flip = flipDiagonal(ao4 & 3, (ao4 >> 2) & 3, (ao4 >> 4) & 3, (ao4 >> 6) & 3)
  out.push(qa, qb, flip, REVERSE[f]!)
}

/** A 2-bit hash of a world cell: the tone jitter of a tone block there (BlockDef.tone), so neighbours differ slightly. */
export function toneJitter(x: number, y: number, z: number): number {
  let h = Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(z, 0xcb1ab31f)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h ^= h >>> 12
  return (h >>> 7) & 3
}

/** The layer field of a tone block's face: its texture layer, the voxel's tone level and the cell's jitter. */
export function toneTex(tex: number, v: number, wx: number, wy: number, wz: number): number {
  return toneLayer(tex, voxelState(v) & 3, toneJitter(wx, wy, wz))
}

/**
 * `plane`: a layer cut through the chunk; a top face it creates (an opaque block lay on it) is flagged CUT_BIT and never merges with others.
 * `ox, oy, oz`: the chunk's world origin, hashed into a tone block's jitter.
 * Returns true when it emitted a face of a fringe block (BlockDef.fringe): only then has the fringe pass anything to do.
 */
export function meshOpaqueAndCutout(
  s: ChunkSnapshot, t: MeshTables, opaque: QuadBuilder, cutout: QuadBuilder, mask: Int32Array, plane?: CutPlane, ox = 0, oy = 0, oz = 0,
): boolean {
  const q = [0, 0, 0]
  const fringeWidth = t.hasFringe ? t.fringeWidth : undefined
  let fringeFace = false
  for (let f = 0; f < 6; f++) {
    const [d, u, v] = AXES[f]!
    const nOff = ((f & 1) === 0 ? 1 : -1) * STRIDE[d as 0 | 1 | 2]
    for (let sl = 0; sl < 32; sl++) {
      mask.fill(0)
      let any = false
      for (let vv = 0; vv < 32; vv++) for (let uu = 0; uu < 32; uu++) {
        q[d] = sl; q[u] = uu; q[v] = vv
        const pi = padIndex(q[0]! + 1, q[1]! + 1, q[2]! + 1)
        const id = voxelId(s.voxels[pi]!)
        const layer = t.layer[id]!
        if (layer !== LAYER.OPAQUE && layer !== LAYER.CUTOUT) continue
        const ni = pi + nOff
        const nid = voxelId(s.voxels[ni]!)
        if (t.opaque[nid]) continue
        if (layer === LAYER.CUTOUT && nid === id) continue
        const l = t.hasShapes && t.shape[nid] !== 0 ? faceLight(s, t, ni) : s.light[ni]!
        const ao4 = faceAO(s, t, ni, f)
        const tex = t.faceLayers[id * 6 + f]!
        const cut = plane !== undefined && f === 2 && sl + 1 === plane.py && plane.covered[q[0]! + 1 + (q[2]! + 1) * 34] === 1 ? 1 : 0
        if (layer === LAYER.CUTOUT) {
          const ct = t.hasTone && t.tone![id] ? toneTex(tex, s.voxels[pi]!, ox + q[0]!, oy + q[1]!, oz + q[2]!) : tex
          emitQuad(cutout, f, sl, uu, vv, 1, 1, ct, ao4, l & 15, l >> 4, cut)
          if (fringeWidth !== undefined && fringeWidth[id] !== 0) fringeFace = true
          continue
        }
        mask[uu + vv * 32] = 1 + (tex | (ao4 << 12) | ((l & 15) << 20) | ((l >> 4) << 24) | (cut << 28))
        any = true
      }
      if (!any) continue
      for (let vv = 0; vv < 32; vv++) {
        for (let uu = 0; uu < 32;) {
          const k = mask[uu + vv * 32]!
          if (k === 0) { uu++; continue }
          let w = 1
          while (uu + w < 32 && mask[uu + w + vv * 32] === k) w++
          let h = 1
          grow: while (vv + h < 32) {
            for (let x = 0; x < w; x++) if (mask[uu + x + (vv + h) * 32] !== k) break grow
            h++
          }
          for (let y = 0; y < h; y++) mask.fill(0, uu + (vv + y) * 32, uu + w + (vv + y) * 32)
          const key = k - 1
          emitQuad(opaque, f, sl, uu, vv, w, h, key & 4095, (key >> 12) & 255, (key >> 20) & 15, (key >> 24) & 15, (key >> 28) & 1)
          uu += w
        }
      }
    }
  }
  return fringeFace
}
