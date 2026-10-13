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
    expect(bootPlan(new URLSearchParams('save=a&scene=flood&size=64'), { app: app('living') })).toEqual({ scene: 'living', fromSave: true })
  })
  it('a save without sandbox app state, or naming an unknown scene, boots the world scene', () => {
    expect(bootPlan(new URLSearchParams('save=a'), { app: null })).toEqual({ scene: 'world', fromSave: true })
    expect(bootPlan(new URLSearchParams('save=a'), { app: app('moon') })).toEqual({ scene: 'world', fromSave: true })
  })
})
