import { ROOF_NORMALS, roofFacesOf, roofFormCode, type RoofFace } from '../blocks/roofs.ts'
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

/**
 * Per face, 10 words: its cull face (NO_CULL: never), its texture face (ROOF_NORMALS uvFace), then per corner word A
 * for a cell at the origin (TILT_NORMAL, the normal index, the corner's whole-block offset, biased) and word B's
 * fx/fy/fz. A triangle repeats its last corner.
 */
const STRIDE = 10
const packedCache = new Map<readonly RoofFace[], Uint32Array>()
function packedOf(faces: readonly RoofFace[]): Uint32Array {
  const hit = packedCache.get(faces)
  if (hit) return hit
  const out = new Uint32Array(faces.length * STRIDE)
  faces.forEach((f, i) => {
    const o = i * STRIDE
    out[o] = f.cull < 0 ? NO_CULL : f.cull
    out[o + 1] = ROOF_NORMALS[f.normal]!.uvFace
    for (let c = 0; c < 4; c++) {
      const [x, y, z] = f.pts[Math.min(c, f.pts.length - 1)]!
      out[o + 2 + c] = packTilted(Math.floor(x / 16), Math.floor(y / 16), Math.floor(z / 16), f.normal, c)
      out[o + 6 + c] = packB(0, 0, 0, x & 15, y & 15, z & 15)
    }
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

const qa = new Uint32Array(4)
const qb = new Uint32Array(4)

/**
 * One roof cell's quads into the opaque stream (blocks/roofs.ts): its form from the roof cells around it, then every
 * polygon as a tilted quad (a triangle repeats a corner), lit by the light around the roof's own cell (`faceLight`),
 * tiled by its texture face, AO 0, never layer-cut-flagged. A polygon lying on a cell side is dropped against an opaque
 * neighbour.
 */
export function meshRoofCell(s: ChunkSnapshot, t: MeshTables, pi: number, x: number, y: number, z: number, out: QuadBuilder): void {
  const v = s.voxels[pi]!
  const id = voxelId(v), state = voxelState(v)
  curVoxels = s.voxels
  curShape = t.shape
  curPi = pi
  const faces = packedOf(roofFacesOf(state, roofFormCode(state, roofAt)))
  const l = faceLight(s, t, pi)
  const cellA = packA(x, y, z, 0, 0, 0)
  for (let k = 0; k < faces.length; k += STRIDE) {
    const cull = faces[k]!
    if (cull !== NO_CULL && t.opaque[voxelId(s.voxels[pi + N_OFF[cull]!]!)]) continue
    const b = packB(t.faceLayers[id * 6 + faces[k + 1]!]!, l & 15, l >> 4)
    for (let c = 0; c < 4; c++) {
      qa[c] = cellA + faces[k + 2 + c]!
      qb[c] = (b | faces[k + 6 + c]!) >>> 0
    }
    out.push(qa, qb, false, false)
  }
}
