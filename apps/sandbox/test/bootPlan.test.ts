import { describe, expect, it } from 'vitest'
import { bootPlan, sceneOf } from '../src/scene.ts'

const app = (scene: string) => ({ scene, camera: { mode: 'orbit', orbit: { target: [0, 0, 0], distance: 1, pitch: 0, yaw: 0 }, fp: { position: [0, 0, 0], yaw: 0, pitch: 0 } }, scripts: {} })

describe('boot plan', () => {
  it('uses ?scene without a save', () => {
    expect(bootPlan(new URLSearchParams('scene=flood'), null)).toEqual({ scene: 'flood', fromSave: false })
    expect(sceneOf('nonsense')).toBe('world')
    expect(sceneOf(null)).toBe('world')
  })
  it("the save's scene wins over ?scene", () => {
    expect(bootPlan(new URLSearchParams('save=a&scene=flood&size=64'), { app: app('living') })).toMatchObject({ scene: 'living', fromSave: true })
  })
  it("the save's terrain document wins over the one the URL would pick", () => {
    const doc = { size: [256, 256], ops: [] }
    expect(bootPlan(new URLSearchParams('save=a'), { app: app('terrain'), manifest: { terrain: doc } }).terrain).toBe(doc)
    expect(bootPlan(new URLSearchParams('scene=terrain'), null).terrain).toBeUndefined()
  })
  it('a save without sandbox app state, or naming an unknown scene, boots the world scene', () => {
    expect(bootPlan(new URLSearchParams('save=a'), { app: null })).toMatchObject({ scene: 'world', fromSave: true })
    expect(bootPlan(new URLSearchParams('save=a'), { app: app('moon') })).toMatchObject({ scene: 'world', fromSave: true })
  })
})
