import type { BlockRegistry } from '../blocks/registry.ts'
import type { FragmentBirth } from '../sim/collapse.ts'
import type { Layout } from '../world/layout.ts'
import { cubeLight } from './fallingTrack.ts'

const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const
const CORNERS = [
  [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]],
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
] as const
export interface FragmentGeometry { layer: number; positions: Float32Array; normals: Float32Array; uv: Float32Array; info: Float32Array; indices: Uint32Array }

/** Pure exposed-face builder, called once per birth. Faces against opaque members and equal glass are culled. */
export function fragmentGeometry(birth: FragmentBirth, layout: Layout, registry: BlockRegistry, faceLayers: Uint16Array,
  light: (x: number, y: number, z: number) => number): FragmentGeometry[] {
  const own = new Map<number, number>()
  birth.positions.forEach((p, i) => own.set(p, birth.voxels[i]! & 0xfff))
  const layers = new Map<number, { positions: number[]; normals: number[]; uv: number[]; info: number[]; indices: number[] }>()
  birth.positions.forEach((p, i) => {
    const [x, y, z] = layout.voxelCoords(p), id = birth.voxels[i]! & 0xfff, layer = registry.layer[id]!
    let b = layers.get(layer)
    if (!b) { b = { positions: [], normals: [], uv: [], info: [], indices: [] }; layers.set(layer, b) }
    const illumination = cubeLight(light, x, y, z)
    for (let face = 0; face < 6; face++) {
      const [dx, dy, dz] = DIRS[face]!, neighbor = layout.inBounds(x + dx, y + dy, z + dz) ? own.get(layout.voxelIndex(x + dx, y + dy, z + dz)) : undefined
      if (neighbor !== undefined && (registry.opaque[neighbor] || (neighbor === id && layer === 3))) continue
      const start = b.positions.length / 3
      CORNERS[face]!.forEach(([cx, cy, cz], k) => {
        b!.positions.push(x + cx, y + cy, z + cz); b!.normals.push(dx, dy, dz)
        b!.uv.push(k === 1 || k === 2 ? 1 : 0, k >= 2 ? 1 : 0)
        b!.info.push(faceLayers[id * 6 + face]!, illumination & 15, illumination >> 4)
      })
      b.indices.push(start, start + 1, start + 2, start, start + 2, start + 3)
    }
  })
  return [...layers].filter(([, b]) => b.indices.length > 0).map(([layer, b]) => ({ layer, positions: Float32Array.from(b.positions), normals: Float32Array.from(b.normals),
    uv: Float32Array.from(b.uv), info: Float32Array.from(b.info), indices: Uint32Array.from(b.indices) }))
}
