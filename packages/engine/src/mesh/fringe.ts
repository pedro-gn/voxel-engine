import { padIndex, PAD, type ChunkSnapshot } from '../world/reader.ts'
import { voxelId } from '../world/voxel.ts'
import { AXES, STRIDE, toneTex } from './greedy.ts'
import type { CutPlane } from './meshJob.ts'
import type { QuadBuilder } from './quadBuilder.ts'
import { faceLight } from './shapes.ts'
import type { MeshTables } from './tables.ts'
import { CUT_BIT, FRINGE_BIT, packA, packB } from './vertexFormat.ts'

/** Per face (6) × edge (4): padded offset to the cell beyond the edge. */
const EDGE_OFF = new Int32Array(24)
/** Per face × edge: 1 when the quad's triangles are reversed to face out like the face. */
const EDGE_REVERSE = new Uint8Array(24)
/** Per face × edge: 1 for the edge that points up (+Y), 2 for the one that points down (−Y), else 0. */
const EDGE_VERT = new Uint8Array(24)
/** Per face: padded offset to the cell in front. */
const FRONT_OFF = new Int32Array(6)
/** Per face: offset to the column in front in CutPlane.covered (x + z × PAD); 0 for the top and bottom faces. */
const FRONT_COL = new Int32Array(6)
/**
 * Per reach w (1..16, in sixteenths) × face × edge × corner: what the corner adds to the cell's packed words. `A` adds
 * to (x + 1) | (y + 1) << 6 | (z + 1) << 12 (fields never leave 0..63, so the signed sum packs exactly) and carries the
 * face's normal and the corner; `B` holds the fx/fy/fz sixteenths. Corners: 0 edge start, 1 edge end, 2 outer end,
 * 3 outer start.
 */
const CORNER_A = new Int32Array(17 * 96)
const CORNER_B = new Uint32Array(17 * 96)

for (let f = 0; f < 6; f++) {
  const [d, u, v] = AXES[f]!
  const ns = (f & 1) === 0 ? 1 : -1
  FRONT_OFF[f] = ns * STRIDE[d as 0 | 1 | 2]
  FRONT_COL[f] = d === 0 ? ns : d === 2 ? ns * PAD : 0
  let k = 0
  for (const [a, b] of [[u, v], [v, u]] as const) {
    for (const sg of [1, -1]) {
      const e = f * 4 + k
      EDGE_OFF[e] = sg * STRIDE[a as 0 | 1 | 2]
      // (c1 − c0) × (c3 − c0) = sg × (e_b × e_a); e_b × e_a = +e_d when (b, a, d) is cyclic.
      const cyc = (a - b + 3) % 3 === 1 ? 1 : -1
      EDGE_REVERSE[e] = sg * cyc * ns < 0 ? 1 : 0
      EDGE_VERT[e] = a === 1 ? (sg > 0 ? 1 : 2) : 0
      for (let w = 1; w <= 16; w++) {
        for (let c = 0; c < 4; c++) {
          // The corner in sixteenths from the cell's low corner, then split into whole cells and sixteenths.
          const p = [0, 0, 0]
          p[d] = ns > 0 ? 16 : 0
          const edge = sg > 0 ? 16 : 0
          p[a] = c < 2 ? edge : edge + sg * w
          p[b] = c === 1 || c === 2 ? 16 : 0
          const cell = p.map((x) => Math.floor(x / 16)), frac = p.map((x) => x - Math.floor(x / 16) * 16)
          const i = (w * 24 + e) * 4 + c
          CORNER_A[i] = cell[0]! + cell[1]! * 64 + cell[2]! * 4096 + packA(0, 0, 0, f, 0, c)
          CORNER_B[i] = packB(0, 0, 0, frac[0]!, frac[1]!, frac[2]!)
        }
      }
      k++
    }
  }
}

const qa = new Uint32Array(4)
const qb = new Uint32Array(4)

/**
 * The fringe pass (BlockDef.fringe), after the cutout pass, into the same cutout builder. For each exposed face of a
 * fringe block (the face test of meshOpaqueAndCutout: the cell in front is neither opaque nor the same block), each of
 * its 4 edges gets a strip when the cell beyond the edge, in the face's plane, and the cell diagonal to it (beyond the
 * edge, one step out along the normal) are both neither opaque, shaped (a slab, stair, post or ladder) nor the same
 * block: a convex silhouette edge. The strip
 * lies in the face's plane, reaches out `fringeWidth` sixteenths (`fringeHang` when it points down), and carries the
 * face's light, the block's tone and no occlusion. Its vertices are FRINGE_BIT vertices (vertexFormat.ts).
 *
 * `plane`: the layer cut. The snapshot is already cut (meshJob.ts applyCut); a cell of the cut layer grows no strip up
 * through the cut when the cell above it or the diagonal cell above held something before the cut (so nothing rises
 * above the plane that the uncut world would not show), and its strips on a created top face take CUT_BIT like the face.
 * Mesher calls this only when the cutout pass emitted a face of a fringe block (meshOpaqueAndCutout's result).
 * `ox, oy, oz`: the chunk's world origin, for the tone jitter.
 */
export function meshFringe(s: ChunkSnapshot, t: MeshTables, out: QuadBuilder, plane?: CutPlane, ox = 0, oy = 0, oz = 0): void {
  if (!t.hasFringe) return
  const width = t.fringeWidth!, hang = t.fringeHang!, layers = t.fringeLayers!, sides = t.fringeSides
  const vox = s.voxels, light = s.light, opaque = t.opaque, shape = t.shape
  for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) {
    const row = padIndex(1, y + 1, z + 1)
    for (let x = 0; x < 32; x++) {
      const pi = row + x
      const v = vox[pi]!
      const id = voxelId(v)
      if (width[id] === 0) continue
      const cutRow = plane !== undefined && y + 1 === plane.py
      const col = x + 1 + (z + 1) * PAD
      const covered = cutRow ? plane.covered[col]! : 0
      let tex = -1 // the strips' layer field, computed at the first exposed face
      const cellA = (x + 1) | ((y + 1) << 6) | ((z + 1) << 12)
      const wSide = width[id]! * 24, wDown = hang[id]! * 24
      const sideways = sides === undefined || sides[id] === 1
      for (let f = 0; f < 6; f++) {
        const ni = pi + FRONT_OFF[f]!
        const nid = voxelId(vox[ni]!)
        if (opaque[nid] || nid === id) continue
        if (tex < 0) tex = t.hasTone && t.tone![id] ? toneTex(layers[id]!, v, ox + x, oy + y, oz + z) : layers[id]!
        const l = t.hasShapes && t.shape[nid] !== 0 ? faceLight(s, t, ni) : light[ni]!
        const bFace = packB(tex, l & 15, l >> 4)
        const flags = FRINGE_BIT | (f === 2 && covered === 1 ? CUT_BIT : 0)
        for (let e = f * 4; e < f * 4 + 4; e++) {
          const bi = pi + EDGE_OFF[e]!
          const beyond = voxelId(vox[bi]!)
          if (opaque[beyond] || beyond === id || shape[beyond]) continue
          const diag = voxelId(vox[bi + FRONT_OFF[f]!]!)
          if (opaque[diag] || diag === id || shape[diag]) continue
          const vert = EDGE_VERT[e]!
          if (vert === 0 && !sideways && f !== 2 && f !== 3) continue // a side face's vertical edge
          // Up through the layer cut: only where the cut removed neither the cell above nor the diagonal above.
          if (vert === 1 && cutRow && (covered !== 0 || plane.covered[col + FRONT_COL[f]!] !== 0)) continue
          const ci = ((vert === 2 ? wDown : wSide) + e) * 4
          for (let c = 0; c < 4; c++) {
            qa[c] = ((cellA + CORNER_A[ci + c]!) | flags) >>> 0
            qb[c] = (bFace | CORNER_B[ci + c]!) >>> 0
          }
          out.push(qa, qb, false, EDGE_REVERSE[e] === 1)
        }
      }
    }
  }
}
