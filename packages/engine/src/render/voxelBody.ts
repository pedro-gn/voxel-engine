import * as THREE from 'three/webgpu'
import { Mesher, type ChunkMeshData } from '../mesh/mesher.ts'
import type { MeshTables } from '../mesh/tables.ts'
import { createSnapshot, padIndex } from '../world/reader.ts'
import { AIR, blockLight, FULL_SKY, skyLight, voxelId } from '../world/voxel.ts'
import { geometryOf } from './chunkMeshes.ts'

/** One voxel of a body: its world cell and its full voxel (id and state). */
export interface VoxelBodyCell { x: number; y: number; z: number; voxel: number }

/**
 * A set of voxels meshed by the engine's mesher and drawn like the world, as one movable THREE object (engine.voxelBody).
 * `object` is in the scene and starts exactly over the cells; `min`/`max` are the cells' world box (`max` = the largest
 * cell + 1). `ease` (0..1) blends the light baked at build time towards open sky. Materials are shared with every body.
 */
export interface VoxelBody {
  readonly object: THREE.Group
  readonly min: [number, number, number]
  readonly max: [number, number, number]
  ease: number
  /**
   * Re-parents the body's meshes under a new group whose origin is the world point (x, y, z), keeping their world
   * transforms, and returns it: rotate or move that group to turn the body about the point. The group is a child of
   * `object`; an earlier pivot group is dropped.
   */
  pivot(x: number, y: number, z: number): THREE.Group
  /** Removes the body from the scene and frees its geometry. Idempotent. */
  dispose(): void
}

/** The largest body extent per axis: one padded snapshot. */
export const BODY_MAX_EXTENT = 32

const snap = createSnapshot()
const mesher = new Mesher()

/**
 * Meshes `cells` as a standalone chunk (plan D2): a snapshot of air and full sky, the world's light (`getLight`, packed
 * sky | block << 4) over the cells' box plus a 1-cell border, each cell at `cell − origin` with `origin` the box's min
 * corner, and the mesher given the world origin so the leaf tone jitter and fringe variants match the standing blocks.
 * Liquid cells and decorations are dropped. Throws RangeError on no cells or a box wider than BODY_MAX_EXTENT.
 * The mesh is in the chunk-centred frame (local − 16): its world place is `origin + 16`.
 */
export function buildBodyMeshData(cells: readonly VoxelBodyCell[], tables: MeshTables, getLight: (x: number, y: number, z: number) => number): { data: ChunkMeshData; origin: [number, number, number] } {
  if (cells.length === 0) throw new RangeError('voxelBody needs at least one cell')
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
  for (const c of cells) {
    if (!Number.isInteger(c.x) || !Number.isInteger(c.y) || !Number.isInteger(c.z)) throw new RangeError(`voxelBody cells must be integer, got (${c.x}, ${c.y}, ${c.z})`)
    if (c.x < x0) x0 = c.x
    if (c.y < y0) y0 = c.y
    if (c.z < z0) z0 = c.z
    if (c.x > x1) x1 = c.x
    if (c.y > y1) y1 = c.y
    if (c.z > z1) z1 = c.z
  }
  if (x1 - x0 >= BODY_MAX_EXTENT || y1 - y0 >= BODY_MAX_EXTENT || z1 - z0 >= BODY_MAX_EXTENT) {
    throw new RangeError(`a voxel body spans at most ${BODY_MAX_EXTENT} cells per axis, got ${x1 - x0 + 1} × ${y1 - y0 + 1} × ${z1 - z0 + 1}`)
  }
  snap.voxels.fill(AIR)
  snap.light.fill(FULL_SKY)
  // The light of the cells in front of every face: the box plus its 1-cell border (padded index = cell − origin + 1).
  for (let y = y0 - 1; y <= y1 + 1; y++) for (let z = z0 - 1; z <= z1 + 1; z++) for (let x = x0 - 1; x <= x1 + 1; x++) {
    snap.light[padIndex(x - x0 + 1, y - y0 + 1, z - z0 + 1)] = lightAround(getLight, x, y, z)
  }
  for (const c of cells) {
    const id = voxelId(c.voxel)
    if (id === 0 || tables.liquid[id] || tables.liquidGroup[id]) continue
    snap.voxels[padIndex(c.x - x0 + 1, c.y - y0 + 1, c.z - z0 + 1)] = c.voxel
  }
  const data = mesher.mesh(snap, tables, x0, y0, z0)
  return { data: { ...data, liquid: null, grass: null, flowers: null }, origin: [x0, y0, z0] }
}

/**
 * The light a body face takes from the world cell in front of it. A solid world cell holds light 0 — in the world the
 * face against it was hidden — so it lends the brightest light of its six neighbours instead (review I1: the base log's
 * bottom face would otherwise rotate into view near-black as the tree tips).
 */
function lightAround(getLight: (x: number, y: number, z: number) => number, x: number, y: number, z: number): number {
  const l = getLight(x, y, z)
  if (l !== 0) return l
  let best = 0
  for (const [dx, dy, dz] of SIX) {
    const n = getLight(x + dx, y + dy, z + dz)
    if (skyLight(n) + blockLight(n) > skyLight(best) + blockLight(best)) best = n
  }
  return best
}
const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const

export interface VoxelBodyDeps {
  tables: MeshTables
  getLight: (x: number, y: number, z: number) => number
  materials: { opaque: THREE.Material; cutout: THREE.Material; translucent: THREE.Material }
  /** Where `object` is added (the engine's scene). */
  parent: THREE.Object3D
  /** How far fringe strips poke out of a block (BlockRegistry.fringeReach). */
  reach: number
  onDispose?: (body: VoxelBody) => void
}

const LAYERS = ['opaque', 'cutout', 'translucent'] as const

/** Builds a body over `cells` and adds it to `deps.parent` (engine.voxelBody). */
export function createVoxelBody(cells: readonly VoxelBodyCell[], deps: VoxelBodyDeps): VoxelBody {
  const { data, origin } = buildBodyMeshData(cells, deps.tables, deps.getLight)
  const [x0, y0, z0] = origin
  let x1 = x0, y1 = y0, z1 = z0
  for (const c of cells) { x1 = Math.max(x1, c.x + 1); y1 = Math.max(y1, c.y + 1); z1 = Math.max(z1, c.z + 1) }
  const object = new THREE.Group()
  object.name = 'elovox-voxel-body'
  // The world point of the mesh frame's origin: the body's UVs stay the standing blocks' (chunkVertex.ts body).
  const uvOrigin = new THREE.Vector3(x0 + 16, y0 + 16, z0 + 16)
  // Bounds of the cells (plus the strips' reach) in the chunk-centred mesh frame.
  const lo = new THREE.Vector3(-16 - deps.reach, -16 - deps.reach, -16 - deps.reach)
  const hi = new THREE.Vector3(x1 - x0 - 16 + deps.reach, y1 - y0 - 16 + deps.reach, z1 - z0 - 16 + deps.reach)
  const meshes: THREE.Mesh[] = []
  for (const name of LAYERS) {
    const lm = data[name]
    if (!lm) continue
    const geo = geometryOf(lm, deps.reach)
    geo.boundingBox = new THREE.Box3(lo.clone(), hi.clone())
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere())
    const mesh = new THREE.Mesh(geo, deps.materials[name])
    mesh.name = `elovox-voxel-body-${name}`
    mesh.raycast = () => {} // `position` aliases the packed attribute (chunkMeshes.ts)
    mesh.castShadow = name !== 'translucent'
    mesh.receiveShadow = true
    mesh.position.copy(uvOrigin)
    mesh.userData.uvOrigin = uvOrigin
    mesh.userData.ease = 0
    object.add(mesh)
    meshes.push(mesh)
  }
  deps.parent.add(object)
  let ease = 0, pivotGroup: THREE.Group | null = null, disposed = false
  const body: VoxelBody = {
    object,
    min: [x0, y0, z0],
    max: [x1, y1, z1],
    get ease() { return ease },
    set ease(v: number) {
      ease = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
      for (const m of meshes) m.userData.ease = ease
    },
    pivot(x, y, z) {
      object.updateWorldMatrix(true, true)
      const g = new THREE.Group()
      g.name = 'elovox-voxel-body-pivot'
      object.add(g)
      g.position.copy(object.worldToLocal(new THREE.Vector3(x, y, z)))
      g.updateWorldMatrix(true, false)
      for (const m of meshes) g.attach(m) // keeps each mesh's world transform
      if (pivotGroup) object.remove(pivotGroup)
      pivotGroup = g
      return g
    },
    dispose() {
      if (disposed) return
      disposed = true
      object.removeFromParent()
      for (const m of meshes) m.geometry.dispose()
      deps.onDispose?.(body)
    },
  }
  return body
}
