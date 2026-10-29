import { ROOF_FORM_CODES, ROOF_NORMALS, roofFacesOf, roofFormCode, type RoofFace } from '../blocks/roofs.ts'
import { SHAPE } from '../blocks/shapes.ts'
import { PAD, type ChunkSnapshot } from '../world/reader.ts'
import { voxelId, voxelState } from '../world/voxel.ts'
import type { QuadBuilder } from './quadBuilder.ts'
import { faceLight } from './shapes.ts'
import type { MeshTables } from './tables.ts'
import { packA, packB, packTilted } from './vertexFormat.ts'

/** Padded-index offset of the cell each face looks into: +x −x +y −y +z −z. */
const N_OFF = [1, -1, PAD * PAD, -PAD * PAD, PAD, -PAD] as const
const NO_CULL = 255
const TEX_FACE = { top: 2, side: 0, bottom: 3 } as const

/** The look-into cell (dx, dy, dz in −1..1) as (dx + 1) + 3 (dy + 1) + 9 (dz + 1); `OWN` is the roof's own cell. */
const OWN = 13
const LOOK_OFF = Array.from({ length: 27 }, (_, i) => (i % 3) - 1 + ((Math.floor(i / 3) % 3) - 1) * PAD * PAD + (Math.floor(i / 9) - 1) * PAD)
const CULL_LOOK = [14, 12, 16, 10, 22, 4] as const

/**
 * The cell whose light a face takes: across its cull face; else, for a face looking down or sideways (wedge sides,
 * soffits, undersides, butts), the cell just in front of its centre; boards and caps (`top`, or a normal with any rise)
 * keep the roof cell's own (`OWN`).
 */
function lookOf(f: RoofFace): number {
  if (f.cull >= 0) return CULL_LOOK[f.cull]!
  const n = ROOF_NORMALS[f.normal]!.n
  if (f.texture === 'top' || n[1] > 1e-6) return OWN
  const d = [0, 1, 2].map((a) => {
    const c = f.pts.reduce((sum, p) => sum + p[a]!, 0) / f.pts.length + n[a]!
    return Math.max(-1, Math.min(1, Math.floor(c / 16)))
  })
  return d[0]! + 1 + (d[1]! + 1) * 3 + (d[2]! + 1) * 9
}

/**
 * Per face, 11 words: its cull face (NO_CULL: never), the face whose texture layer it wears (2 top, 0 side, 3 bottom),
 * then per corner word A for a cell at the origin (TILT_NORMAL, the normal index, the corner's whole-block offset,
 * biased) and word B's fx/fy/fz, then the cell it takes its light from (`lookOf`). A triangle repeats its last corner.
 */
const STRIDE = 11
const packedCache = new Map<readonly RoofFace[], Uint32Array>()
function packedOf(faces: readonly RoofFace[]): Uint32Array {
  const hit = packedCache.get(faces)
  if (hit) return hit
  const out = new Uint32Array(faces.length * STRIDE)
  faces.forEach((f, i) => {
    const o = i * STRIDE
    out[o] = f.cull < 0 ? NO_CULL : f.cull
    out[o + 1] = TEX_FACE[f.texture]
    for (let c = 0; c < 4; c++) {
      const [x, y, z] = f.pts[Math.min(c, f.pts.length - 1)]!
      out[o + 2 + c] = packTilted(Math.floor(x / 16), Math.floor(y / 16), Math.floor(z / 16), f.normal, c)
      out[o + 6 + c] = packB(0, 0, 0, x & 15, y & 15, z & 15)
    }
    out[o + 10] = lookOf(f)
  })
  packedCache.set(faces, out)
  return out
}

let curVoxels: Uint16Array = new Uint16Array(0)
let curShape: Uint8Array = new Uint8Array(0)
let curPi = 0
/** A neighbour's roof state for `roofFormCode`, or −1. One shared closure, no allocation per cell. */
const roofAt = (dx: number, dy: number, dz: number): number => {
  const v = curVoxels[curPi + dx + dz * PAD + dy * PAD * PAD]!
  return curShape[voxelId(v)] === SHAPE.ROOF ? voxelState(v) : -1
}

/** Packed faces by (state, form code), filled on first use. */
const packedByCode: (Uint32Array | undefined)[] = new Array(16 * ROOF_FORM_CODES)

const qa = new Uint32Array(4)
const qb = new Uint32Array(4)
/** Per roof cell, the light of each look-into cell, filled on first use (−1: not yet). */
const lookLight = new Int32Array(27)

/**
 * One roof cell's quads into the opaque stream (blocks/roofs.ts): its form from the roof cells around it, then every
 * polygon as a tilted quad (a triangle repeats a corner), lit as a box face is: by the cell it looks into (`lookOf`;
 * `faceLight` of that cell, the roof's own when it is opaque), boards and caps by the light around the roof's own cell,
 * in the block's top, side or bottom texture (`RoofFace.texture`; projected as the normal's `uvFace`), AO 0, never
 * layer-cut-flagged. A polygon lying on a cell side is dropped against an opaque neighbour.
 */
export function meshRoofCell(s: ChunkSnapshot, t: MeshTables, pi: number, x: number, y: number, z: number, out: QuadBuilder): void {
  const v = s.voxels[pi]!
  const id = voxelId(v), state = voxelState(v)
  curVoxels = s.voxels
  curShape = t.shape
  curPi = pi
  const code = roofFormCode(state, roofAt), ci = (state & 15) * ROOF_FORM_CODES + code
  const faces = packedByCode[ci] ??= packedOf(roofFacesOf(state, code))
  const own = faceLight(s, t, pi)
  lookLight.fill(-1)
  lookLight[OWN] = own
  const cellA = packA(x, y, z, 0, 0, 0)
  for (let k = 0; k < faces.length; k += STRIDE) {
    const cull = faces[k]!
    if (cull !== NO_CULL && t.opaque[voxelId(s.voxels[pi + N_OFF[cull]!]!)]) continue
    const look = faces[k + 10]!
    let l = lookLight[look]!
    if (l < 0) {
      const npi = pi + LOOK_OFF[look]!
      l = lookLight[look] = t.opaque[voxelId(s.voxels[npi]!)] ? own : faceLight(s, t, npi)
    }
    const b = packB(t.faceLayers[id * 6 + faces[k + 1]!]!, l & 15, l >> 4)
    for (let c = 0; c < 4; c++) {
      qa[c] = cellA + faces[k + 2 + c]!
      qb[c] = (b | faces[k + 6 + c]!) >>> 0
    }
    out.push(qa, qb, false, false)
  }
}
