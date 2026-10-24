import * as THREE from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { createBodyMaterials, createChunkMaterials } from '../src/render/materials.ts'
import { createLightUniforms } from '../src/render/voxelLighting.ts'

const tex = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1)

describe('body materials', () => {
  it('mask the layer cut in the colour and shadow passes (cutout strips stay out of the shadow); chunk materials are unchanged', () => {
    const lights = createLightUniforms()
    const body = createBodyMaterials(tex, lights, undefined, { fringe: true })
    for (const m of [body.opaque, body.cutout, body.translucent]) {
      expect(m.userData.body).toBe(true)
      expect(m.maskNode).not.toBeNull()
      expect(m.maskShadowNode).not.toBeNull()
    }
    expect(body.cutout.maskShadowNode).not.toBe(body.opaque.maskShadowNode)
    expect([body.cutout.alphaTest, body.cutout.side]).toEqual([0.5, THREE.DoubleSide])
    const chunk = createChunkMaterials(tex, lights, undefined, { fringe: true })
    for (const m of Object.values(chunk)) {
      expect(m.userData.body).toBeUndefined()
      expect(m.maskNode).toBeNull()
    }
    expect(chunk.opaque.maskShadowNode).toBeNull()
  })
})
