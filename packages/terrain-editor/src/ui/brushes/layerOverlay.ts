import { BIOME_CELL, BIOME_TILE, HEIGHT_SCALE, TILE, type TerrainLayers } from '@elovox/terrain'
import { Color, Group, InstancedMesh, Matrix4, MeshBasicNodeMaterial, PlaneGeometry } from 'three/webgpu'
import { LIFT } from '../handles/overlay.ts'
import { biomeColor, heightColor } from './colors.ts'

/** At most this many quads (a fully painted 1024² world has 65 536 biome cells). */
export const MAX_QUADS = 65536
/** Blocks per quad side: a biome cell, or 4 × 4 columns of the height layer. */
const QUAD = 4

/** Tints painted layers on the terrain: one flat quad per biome cell, or per 4 × 4 columns holding a height delta. */
export class LayerOverlay {
  readonly group = new Group()
  private readonly ground: (x: number, z: number) => number
  private readonly geometry = new PlaneGeometry(QUAD, QUAD).rotateX(-Math.PI / 2)
  private readonly material = new MeshBasicNodeMaterial({ transparent: true, opacity: 0.4, depthTest: false, depthWrite: false })
  private mesh: InstancedMesh | null = null

  constructor(ground: (x: number, z: number) => number) {
    this.ground = ground
    this.group.name = 'terrain-editor-layer-overlay'
  }

  get count(): number { return this.mesh?.count ?? 0 }

  draw(layers: TerrainLayers, mode: 'height' | 'biome' | null): void {
    this.clear()
    const quads: number[] = [] // centre x, centre z, colour
    if (mode === 'biome') {
      for (const t of layers.biome?.tiles ?? []) for (let i = 0; i < t.values.length; i++) {
        const v = t.values[i]!
        if (v === 0) continue
        quads.push(t.x * TILE + (i % BIOME_TILE) * BIOME_CELL + BIOME_CELL / 2, t.z * TILE + Math.floor(i / BIOME_TILE) * BIOME_CELL + BIOME_CELL / 2, biomeColor(v))
      }
    } else if (mode === 'height') {
      const blocks = TILE / QUAD
      for (const t of layers.height?.tiles ?? []) for (let bz = 0; bz < blocks; bz++) for (let bx = 0; bx < blocks; bx++) {
        let v = 0
        for (let dz = 0; dz < QUAD; dz++) for (let dx = 0; dx < QUAD; dx++) {
          const s = t.values[bx * QUAD + dx + (bz * QUAD + dz) * TILE]!
          if (Math.abs(s) > Math.abs(v)) v = s
        }
        if (v !== 0) quads.push(t.x * TILE + bx * QUAD + QUAD / 2, t.z * TILE + bz * QUAD + QUAD / 2, heightColor(v / HEIGHT_SCALE))
      }
    }
    const n = Math.min(MAX_QUADS, quads.length / 3)
    if (n === 0) return
    const mesh = new InstancedMesh(this.geometry, this.material, n)
    mesh.renderOrder = 999
    mesh.frustumCulled = false
    const m = new Matrix4(), c = new Color()
    for (let i = 0; i < n; i++) {
      const x = quads[i * 3]!, z = quads[i * 3 + 1]!
      mesh.setMatrixAt(i, m.makeTranslation(x, this.ground(x, z) + LIFT / 2, z))
      mesh.setColorAt(i, c.setHex(quads[i * 3 + 2]!))
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    this.group.add(mesh)
    this.mesh = mesh
  }

  /** Where quad `i` stands and its colour (for tests and debugging). */
  quad(i: number): { x: number; y: number; z: number; color: number } {
    const mesh = this.mesh
    if (!mesh || i >= mesh.count) throw new RangeError(`no quad ${i}`)
    const m = new Matrix4(), c = new Color()
    mesh.getMatrixAt(i, m)
    mesh.getColorAt(i, c)
    return { x: m.elements[12]!, y: m.elements[13]!, z: m.elements[14]!, color: c.getHex() }
  }

  dispose(): void {
    this.clear()
    this.geometry.dispose()
    this.material.dispose()
    this.group.removeFromParent()
  }

  private clear(): void {
    if (!this.mesh) return
    this.group.remove(this.mesh)
    this.mesh.dispose()
    this.mesh = null
  }
}
