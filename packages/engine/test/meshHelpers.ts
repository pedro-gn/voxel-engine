import { expect } from 'vitest'
import type { LayerMesh } from '../src/mesh/quadBuilder.ts'
import { ROOF_NORMALS } from '../src/blocks/roofs.ts'
import { FACE_NORMALS, TILT_NORMAL, unpackA, unpackB } from '../src/mesh/vertexFormat.ts'
import { padIndex, type ChunkSnapshot } from '../src/world/reader.ts'

export { emptySnap, meshTables, roofMeshTables } from './meshFixtures.ts'

/** Local chunk coords; -1 and 32 address the 1-voxel border. */
export function put(s: ChunkSnapshot, lx: number, ly: number, lz: number, v: number): void {
  s.voxels[padIndex(lx + 1, ly + 1, lz + 1)] = v
}

export function countByNormal(m: LayerMesh | null, normal: number): number {
  if (!m) return 0
  let n = 0
  for (let i = 0; i < m.vertices.length; i += 8) if (unpackA(m.vertices[i]!).normal === normal) n++
  return n
}

/** A vertex's face normal: an axis normal, or a tilted roof normal (`TILT_NORMAL`, the index in its drop bits). */
export function normalOf(a: number): readonly [number, number, number] {
  const u = unpackA(a)
  return u.normal === TILT_NORMAL ? ROOF_NORMALS[u.tilt!]!.n : FACE_NORMALS[u.normal]!
}

/** Every triangle must face out along its vertex normal (CCW seen from outside); degenerate ones (a triangle sent as a quad) are skipped. */
export function assertOutwardWinding(m: LayerMesh | null): void {
  if (!m) return
  const pos = (vi: number) => {
    const a = unpackA(m.vertices[vi * 2]!), b = unpackB(m.vertices[vi * 2 + 1]!)
    return [a.x + b.fx / 16, a.y + b.fy / 16 - a.drop / 16, a.z + b.fz / 16, m.vertices[vi * 2]!] as const
  }
  for (let t = 0; t < m.indices.length; t += 3) {
    const p0 = pos(m.indices[t]!), p1 = pos(m.indices[t + 1]!), p2 = pos(m.indices[t + 2]!)
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]
    const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]]
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
    if (Math.hypot(n[0]!, n[1]!, n[2]!) === 0) continue
    const fn = normalOf(p0[3])
    expect(n[0]! * fn[0] + n[1]! * fn[1] + n[2]! * fn[2]).toBeGreaterThan(0)
  }
}
