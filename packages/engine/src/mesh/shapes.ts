import { LAYER } from '../blocks/registry.ts'
import { SHAPE, shapeBoxes, stairForm, type Box, type StairForm } from '../blocks/shapes.ts'
import { PAD, padIndex, type ChunkSnapshot } from '../world/reader.ts'
import { voxelId, voxelState } from '../world/voxel.ts'
import { AXES, REVERSE } from './greedy.ts'
import type { QuadBuilder } from './quadBuilder.ts'
import { meshRoofCell } from './roofs.ts'
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

/**
 * Per piece, 10 entries: face; 0 inside the cell, else 1 | quadrants << 1 when it lies on the cell's side (the side's 8 × 8
 * quadrants it spans, bit u + 2v; 0 when not aligned to them); then per corner (quad corner order) word A for a cell at the
 * origin (normal, corner, the corner's whole-block offset), then per corner word B's fx/fy/fz bits.
 */
const PIECE = 10
const pieceCache = new Map<readonly Box[], Uint32Array>()

/** Bit (u ≥ 8) + 2 (v ≥ 8) of each 8 × 8 quadrant of a side that a rectangle on it covers whole. */
function quadrants(r: Rect): number {
  let bits = 0
  for (let q = 0; q < 4; q++) {
    const u = (q & 1) * 8, v = (q >> 1) * 8
    if (r[0] <= u && r[2] >= u + 8 && r[1] <= v && r[3] >= v + 8) bits |= 1 << q
  }
  return bits
}

/** Per side, the quadrants the boxes cover whole. */
function coverOf(boxes: readonly Box[]): number[] {
  const out = [0, 0, 0, 0, 0, 0]
  for (let f = 0; f < 6; f++) {
    const [d, u, v] = AXES[f]!
    for (const b of boxes) if ((f & 1) === 0 ? b[d + 3] === 16 : b[d] === 0) out[f]! |= quadrants([b[u]!, b[v]!, b[u + 3]!, b[v + 3]!])
  }
  return out
}

const FORMS: readonly StairForm[] = [{ kind: 'straight' }, ...([0, 1, 2, 3] as const).flatMap((side) => [{ kind: 'outer', side } as const, { kind: 'inner', side } as const])]
/**
 * `SIDE_COVER[code * 16 + state]`: per side, the quadrants a shaped neighbour covers whatever its form (a stair's form
 * depends on cells a chunk's apron may not hold, so it is never read for culling: one rule on both sides of a border).
 * Filled on first use: greedy.ts (AXES) and this module import each other.
 */
const SIDE_COVER: Int8Array[] = []
function fillSideCover(): void {
  // A ladder and a roof cover nothing (a roof's sides depend on its form and reach past its cell).
  for (const code of [SHAPE.LADDER, SHAPE.ROOF]) for (let state = 0; state < 16; state++) SIDE_COVER[code * 16 + state] = new Int8Array(6)
  for (const code of [SHAPE.SLAB, SHAPE.STAIR, SHAPE.POST]) for (let state = 0; state < 16; state++) {
    const sides = [15, 15, 15, 15, 15, 15]
    for (const form of code === SHAPE.STAIR ? FORMS : [STRAIGHT]) coverOf(shapeBoxes(code, state, form)).forEach((c, f) => { sides[f]! &= c })
    SIDE_COVER[code * 16 + state] = Int8Array.from(sides)
  }
}

/** The faces of a shape's boxes, minus the parts that lie against another of its boxes. Cached by the (shared) box list. */
function piecesOf(boxes: readonly Box[]): Uint32Array {
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
      for (const r of rects) {
        const aligned = r.every((e) => e % 8 === 0)
        out.push(f, plane === (pos ? 16 : 0) ? 1 | (aligned ? quadrants(r) << 1 : 0) : 0)
        const corners = [0, 1, 2, 3].map((c) => {
          const p = [0, 0, 0]
          p[d] = plane
          p[u] = c === 1 || c === 2 ? r[2] : r[0]
          p[v] = c >= 2 ? r[3] : r[1]
          return p
        })
        for (let c = 0; c < 4; c++) out.push(packA(corners[c]![0]! >> 4, corners[c]![1]! >> 4, corners[c]![2]! >> 4, f, 0, c))
        for (let c = 0; c < 4; c++) out.push(packB(0, 0, 0, corners[c]![0]! & 15, corners[c]![1]! & 15, corners[c]![2]! & 15))
      }
    }
  })
  const pieces = Uint32Array.from(out)
  pieceCache.set(boxes, pieces)
  return pieces
}

const qa = new Uint32Array(4)
const qb = new Uint32Array(4)
/** Light per face direction for pieces on the cell's sides, then (index 6) the light of the cell's own free space. */
const lights = new Int16Array(7)

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
 * cube of its material, AO 0, never layer-cut-flagged, lit (`faceLight`) from the neighbour a piece on the cell's side
 * looks into, or from the shape's own cell for a piece inside it. A piece on the cell's side is culled against an opaque
 * neighbour, or against a shaped one whose facing side covers it whatever that neighbour's stair form (the slab part of a
 * stair, a slab's full face); other faces between shapes are drawn.
 */
export function meshShapes(s: ChunkSnapshot, t: MeshTables, out: QuadBuilder): void {
  if (!t.hasShapes) return
  if (SIDE_COVER.length === 0) fillSideCover()
  curVoxels = s.voxels
  curShape = t.shape
  for (let ly = 0; ly < 32; ly++) for (let lz = 0; lz < 32; lz++) for (let lx = 0, pi = padIndex(1, ly + 1, lz + 1); lx < 32; lx++, pi++) {
    if (t.layer[voxelId(s.voxels[pi]!)] === LAYER.SHAPE) shapeCell(s, t, out, pi, lx, ly, lz)
  }
}

/** One shaped cell's quads (a function of its own, so a chunk with no shapes leaves its optimised code alone). */
function shapeCell(s: ChunkSnapshot, t: MeshTables, out: QuadBuilder, pi: number, lx: number, ly: number, lz: number): void {
  const v = s.voxels[pi]!
  const id = voxelId(v)
  const code = t.shape[id]!, state = voxelState(v)
  if (code === SHAPE.ROOF) { meshRoofCell(s, t, pi, lx, ly, lz, out); return }
  curPi = pi
  const cellA = packA(lx, ly, lz, 0, 0, 0)
  const form = code === SHAPE.STAIR ? stairForm(state, stairAt) : STRAIGHT
  const pieces = piecesOf(shapeBoxes(code, state, form))
  lights.fill(-1)
  for (let k = 0; k < pieces.length; k += PIECE) {
    const f = pieces[k]!
    const ni = pi + N_OFF[f]!
    const side = pieces[k + 1]!
    if (side !== 0) {
      const nv = s.voxels[ni]!, nid = voxelId(nv)
      if (t.opaque[nid]) continue
      const need = side >> 1
      if (need !== 0 && t.shape[nid] !== 0 && (need & ~SIDE_COVER[t.shape[nid]! * 16 + voxelState(nv)]![f ^ 1]!) === 0) continue
    }
    // A piece on the cell's side looks into the neighbour; one inside the cell (a step, a slab's top) into the cell's own
    // free space, lit as the shape's cell (the neighbour across may be an opaque cube, which holds no light).
    const li = side !== 0 ? f : 6
    if (lights[li] === -1) lights[li] = faceLight(s, t, side !== 0 ? ni : pi)
    const l = lights[li]!
    const b = packB(t.faceLayers[id * 6 + f]!, l & 15, l >> 4)
    for (let c = 0; c < 4; c++) {
      qa[c] = cellA + pieces[k + 2 + c]!
      qb[c] = (b | pieces[k + 6 + c]!) >>> 0
    }
    out.push(qa, qb, false, REVERSE[f]!)
  }
}
