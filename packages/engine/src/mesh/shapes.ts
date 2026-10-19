import { LAYER } from '../blocks/registry.ts'
import { SHAPE, shapeBoxes, stairForm, type Box } from '../blocks/shapes.ts'
import { PAD, padIndex, type ChunkSnapshot } from '../world/reader.ts'
import { voxelId, voxelState } from '../world/voxel.ts'
import { AXES, REVERSE } from './greedy.ts'
import type { QuadBuilder } from './quadBuilder.ts'
import type { MeshTables } from './tables.ts'
import { packA, packB } from './vertexFormat.ts'

/** Padded-index offset of the cell each face looks into: +x −x +y −y +z −z. */
const N_OFF = [1, -1, PAD * PAD, -PAD * PAD, PAD, -PAD] as const
const UP = 2
const STRAIGHT = { kind: 'straight' } as const

/**
 * The packed light a face looking into padded cell `pi` uses: the cell's own light, unless it is a shape that blocks light
 * (its cell holds none) — then the brightest of its in-bounds neighbours, sky from above passing at 15 unchanged, the
 * rest one less.
 */
export function faceLight(s: ChunkSnapshot, t: MeshTables, pi: number): number {
  const id = voxelId(s.voxels[pi]!)
  if (t.shape[id] === 0 || t.blocksLight[id] === 0) return s.light[pi]!
  const px = pi % PAD, pz = Math.floor(pi / PAD) % PAD, py = Math.floor(pi / (PAD * PAD))
  let sky = 0, blk = 0
  for (let d = 0; d < 6; d++) {
    const c = d < 2 ? px : d < 4 ? py : pz
    if ((d & 1) === 0 ? c === PAD - 1 : c === 0) continue
    const l = s.light[pi + N_OFF[d]!]!
    const ns = l & 15
    sky = Math.max(sky, d === UP && ns === 15 ? 15 : ns - 1)
    blk = Math.max(blk, (l >> 4) - 1)
  }
  return sky | (blk << 4)
}

type Rect = [u0: number, v0: number, u1: number, v1: number]

/** `a` minus `r`: up to four rectangles. */
function subtract(a: Rect, r: Rect): Rect[] {
  if (r[0] >= a[2] || r[2] <= a[0] || r[1] >= a[3] || r[3] <= a[1]) return [a]
  const out: Rect[] = []
  if (r[0] > a[0]) out.push([a[0], a[1], r[0], a[3]])
  if (r[2] < a[2]) out.push([r[2], a[1], a[2], a[3]])
  const u0 = Math.max(a[0], r[0]), u1 = Math.min(a[2], r[2])
  if (r[1] > a[1]) out.push([u0, a[1], u1, r[1]])
  if (r[3] < a[3]) out.push([u0, r[3], u1, a[3]])
  return out
}

/** Per piece, 8 entries: face, then the face's plane d and its rectangle u0 v0 u1 v1 (sixteenths), then 0 0 padding. */
const PIECE = 8
const pieceCache = new Map<readonly Box[], Int8Array>()

/** The faces of a shape's boxes, minus the parts that lie against another of its boxes. Cached by the (shared) box list. */
function piecesOf(boxes: readonly Box[]): Int8Array {
  const hit = pieceCache.get(boxes)
  if (hit) return hit
  const out: number[] = []
  boxes.forEach((b, i) => {
    for (let f = 0; f < 6; f++) {
      const [d, u, v] = AXES[f]!
      const pos = (f & 1) === 0
      const plane = pos ? b[d + 3]! : b[d]!
      let rects: Rect[] = [[b[u]!, b[v]!, b[u + 3]!, b[v + 3]!]]
      boxes.forEach((o, j) => {
        if (j === i || (pos ? o[d]! : o[d + 3]!) !== plane) return
        const r: Rect = [o[u]!, o[v]!, o[u + 3]!, o[v + 3]!]
        rects = rects.flatMap((a) => subtract(a, r))
      })
      for (const r of rects) out.push(f, plane, r[0], r[1], r[2], r[3], 0, 0)
    }
  })
  const pieces = Int8Array.from(out)
  pieceCache.set(boxes, pieces)
  return pieces
}

const qa = new Uint32Array(4)
const qb = new Uint32Array(4)
const p16 = [0, 0, 0]
const lights = new Int16Array(6)

let curVoxels: Uint16Array = new Uint16Array(0)
let curShape: Uint8Array = new Uint8Array(0)
let curPi = 0
/** A stair's horizontal neighbour for `stairForm`: its stair state, or −1. One shared closure, no allocation per cell. */
const stairAt = (dx: number, dz: number): number => {
  const v = curVoxels[curPi + dx + dz * PAD]!
  return curShape[voxelId(v)] === SHAPE.STAIR ? voxelState(v) : -1
}

/**
 * Emits every shaped cell of the 32³ chunk into the opaque stream: one quad per visible box face piece, tiled like the
 * cube of its material, AO 0, lit from the cell the face looks into (`faceLight`), never layer-cut-flagged. A piece on
 * the cell's side is culled against an opaque neighbour; faces between two shapes are drawn.
 */
export function meshShapes(s: ChunkSnapshot, t: MeshTables, out: QuadBuilder): void {
  if (!t.hasShapes) return
  curVoxels = s.voxels
  curShape = t.shape
  for (let ly = 0; ly < 32; ly++) for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
    const pi = padIndex(lx + 1, ly + 1, lz + 1)
    const v = s.voxels[pi]!
    const id = voxelId(v)
    if (t.layer[id] !== LAYER.SHAPE) continue
    const code = t.shape[id]!, state = voxelState(v)
    curPi = pi
    const form = code === SHAPE.STAIR ? stairForm(state, stairAt) : STRAIGHT
    const pieces = piecesOf(shapeBoxes(code, state, form))
    lights.fill(-1)
    for (let k = 0; k < pieces.length; k += PIECE) {
      const f = pieces[k]!, plane = pieces[k + 1]!
      const ni = pi + N_OFF[f]!
      if (plane === ((f & 1) === 0 ? 16 : 0) && t.opaque[voxelId(s.voxels[ni]!)]) continue
      if (lights[f] === -1) lights[f] = faceLight(s, t, ni)
      const l = lights[f]!
      const [d, u, vAx] = AXES[f]!
      const u0 = pieces[k + 2]!, v0 = pieces[k + 3]!, u1 = pieces[k + 4]!, v1 = pieces[k + 5]!
      const tex = t.faceLayers[id * 6 + f]!
      for (let c = 0; c < 4; c++) {
        p16[d] = plane
        p16[u] = c === 1 || c === 2 ? u1 : u0
        p16[vAx] = c >= 2 ? v1 : v0
        const x = lx * 16 + p16[0]!, y = ly * 16 + p16[1]!, z = lz * 16 + p16[2]!
        qa[c] = packA(x >> 4, y >> 4, z >> 4, f, 0, c)
        qb[c] = packB(tex, l & 15, l >> 4, x & 15, y & 15, z & 15)
      }
      out.push(qa, qb, false, REVERSE[f]!)
    }
  }
}
