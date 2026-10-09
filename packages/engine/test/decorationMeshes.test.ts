import * as THREE from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { DecorationMeshes, RESELECT_DISTANCE } from '../src/render/decorations/decorationMeshes.ts'
import { Layout } from '../src/world/layout.ts'

const layout = new Layout([1024, 64, 1024])
const deco = () => new DecorationMeshes(layout, { grass: new THREE.MeshBasicMaterial(), flowers: new THREE.MeshBasicMaterial() })
const two = Uint32Array.of(0, 0, 1, 0)
const at = (x: number, z: number) => new THREE.Vector3(x, 40, z)

describe('DecorationMeshes', () => {
  it('keeps only selected meshes in the scene graph', () => {
    const d = deco()
    d.apply(layout.chunkIndex(0, 0, 0), two, two)
    d.apply(layout.chunkIndex(20, 0, 0), two, null) // 640 blocks away
    expect(d.group.children.length).toBe(0) // nothing selected before the first cull
    expect(d.cull(at(16, 16), 96, 1e6)).toEqual({ instances: 4, draws: 2 })
    expect(d.group.children.map(m => m.name)).toEqual(['deco-0-0-0', 'deco-0-0-0'])
  })
  it('re-selects only after the camera moved RESELECT_DISTANCE or the entries changed', () => {
    const d = deco()
    d.apply(layout.chunkIndex(0, 0, 0), two, null)
    d.cull(at(16, 16), 96, 1e6)
    d.apply(layout.chunkIndex(3, 0, 0), two, null) // centre x 112: 96 from the eye, within 96 + reach 28
    expect(d.cull(at(16, 16), 96, 1e6).draws).toBe(2) // entries changed: re-selected
    d.remove(layout.chunkIndex(3, 0, 0))
    d.apply(layout.chunkIndex(5, 0, 0), two, null) // centre x 176: out of reach from x 16 + 1.9, in reach from x 56
    expect(d.cull(at(16, 16), 96, 1e6).draws).toBe(1)
    expect(d.cull(at(16 + RESELECT_DISTANCE - 0.1, 16), 96, 1e6).draws).toBe(1) // kept: moved less than RESELECT_DISTANCE
    expect(d.cull(at(56, 16), 96, 1e6).draws).toBe(2)
  })
  it('re-selects when the radius or the ceiling changes', () => {
    const d = deco()
    d.apply(layout.chunkIndex(3, 0, 0), two, null)
    expect(d.cull(at(16, 16), 96, 1e6).draws).toBe(1)
    expect(d.cull(at(16, 16), 40, 1e6).draws).toBe(0)
    expect(d.cull(at(16, 16), 40, 0).draws).toBe(0)
  })
  it('removing a shown chunk takes its meshes out of the graph', () => {
    const d = deco()
    d.apply(0, two, two)
    d.cull(at(16, 16), 96, 1e6)
    d.remove(0)
    expect(d.group.children.length).toBe(0)
  })
})
