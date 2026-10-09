import * as THREE from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { Sky } from '../src/render/sky.ts'

describe('Sky view-distance edge', () => {
  it('sets the edge band from R, and out of reach at Infinity', () => {
    const s = new Sky()
    expect(s.edgeUniforms()[0]).toBeGreaterThan(1e29) // the default: no edge
    s.setViewDistance(400)
    expect(s.edgeUniforms()).toEqual([300, 400])
    s.setViewDistance(Infinity)
    expect(s.edgeUniforms()[0]).toBeGreaterThan(1e29)
  })
  it('picks the fog node: fog with its edge, edge-only with fog off and a finite R, none with fog off at Infinity', () => {
    const s = new Sky()
    expect(s.fogFor(true, Infinity)).toBe(s.fogNode)
    expect(s.fogFor(true, 256)).toBe(s.fogNode)
    expect(s.fogFor(false, 256)).toBe(s.edgeNode)
    expect(s.fogFor(false, Infinity)).toBeNull()
    expect(s.edgeNode).not.toBe(s.fogNode)
  })
  it('attaches the plain choice for Infinity', () => {
    const s = new Sky(), scene = new THREE.Scene()
    s.attach(scene, true)
    expect(scene.fogNode).toBe(s.fogNode)
    s.attach(scene, false)
    expect(scene.fogNode).toBeNull()
  })
})
