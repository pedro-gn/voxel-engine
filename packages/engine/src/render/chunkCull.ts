import type * as THREE from 'three/webgpu'
import { chunkInRange, type Vec3Like } from './viewDistance.ts'

/** The bounding sphere chunk geometries carry (chunkMeshes.ts geometryOf): three's batch cull used the same one. */
export const CHUNK_SPHERE_RADIUS = 16 * Math.sqrt(3) + 0.5

/** The chunk sphere grown by `reach` blocks: fringe strips (BlockRegistry.fringeReach) poke that far out of their chunk. */
export function chunkSphereRadius(reach = 0): number {
  return CHUNK_SPHERE_RADIUS + reach
}

/** A frustum's six planes as (nx, ny, nz, constant), in three's order. */
export function frustumPlanes(frustum: THREE.Frustum, out = new Float64Array(24)): Float64Array {
  for (let i = 0; i < 6; i++) {
    const p = frustum.planes[i]!
    out[i * 4] = p.normal.x
    out[i * 4 + 1] = p.normal.y
    out[i * 4 + 2] = p.normal.z
    out[i * 4 + 3] = p.constant
  }
  return out
}

/** three's Frustum.intersectsSphere, over frustumPlanes. */
export function sphereInFrustum(planes: Float64Array, x: number, y: number, z: number, r: number): boolean {
  for (let i = 0; i < 24; i += 4) if (planes[i]! * x + planes[i + 1]! * y + planes[i + 2]! * z + planes[i + 3]! < -r) return false
  return true
}

/** three r186 BatchedMesh records this module reads: `_instanceInfo` and `_geometryInfo` entries. */
export interface InstanceRecord { active: boolean; visible: boolean; geometryIndex: number }
export interface GeometryRecord { start: number; count: number }

/**
 * The multi-draw list of one batch for one pass: every active, visible chunk whose sphere meets the frustum, whose box
 * is within `range` of `eye` and that does not lie wholly at or above `cutTop` (the layer cut's plane), in instance order (opaque and alpha-tested layers depth-test, so order does not change the
 * picture). Geometry ranges are read now, never cached, so remeshes and compaction between passes are always current.
 * `centres` holds each instance's chunk centre (x, y, z); `radius` is the chunk sphere's (chunkSphereRadius); returns the
 * number of draws written.
 */
export function buildDrawList(
  instances: readonly InstanceRecord[], geometries: readonly GeometryRecord[], centres: Float32Array, planes: Float64Array,
  eye: Vec3Like, range: number, bytesPerElement: number, starts: Int32Array, counts: Int32Array, indirect: Uint32Array, cutTop = Infinity,
  radius = CHUNK_SPHERE_RADIUS,
): number {
  let n = 0
  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i]!
    if (!inst.active || !inst.visible) continue
    const x = centres[i * 3]!, y = centres[i * 3 + 1]!, z = centres[i * 3 + 2]!
    if (y - 16 >= cutTop) continue // hidden by the layer cut
    if (!sphereInFrustum(planes, x, y, z, radius)) continue
    if (!chunkInRange(eye, range, x, y, z)) continue
    const g = geometries[inst.geometryIndex]!
    starts[n] = g.start * bytesPerElement
    counts[n] = g.count
    indirect[n] = i
    n++
  }
  return n
}
