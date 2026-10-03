import { BIOME_TILE, HEIGHT_VALUES, TILE, type TerrainDoc } from '@elovox/terrain'
import { describe, expect, it } from 'vitest'
import { BrushController } from '../src/core/brushes.ts'
import type { Point3 } from '../src/core/brush.ts'
import { TileWriter } from '../src/core/layerWriter.ts'
import { TerrainSampler } from '../src/core/sampler.ts'
import { EditorSession } from '../src/core/session.ts'
import { HEIGHT, flatDoc } from './fixtures.ts'

function setup(d: TerrainDoc = flatDoc()) {
  const session = new EditorSession(d, { worldHeight: HEIGHT })
  const b = new BrushController(session, new TerrainSampler({ seed: 1, height: HEIGHT }))
  return { session, b }
}
/** Nine points from (x0, z) to (x1, z). */
const line = (z: number, x0: number, x1: number, y = 0): Point3[] => Array.from({ length: 9 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / 8, y, z }))
const height = (d: TerrainDoc, x: number, z: number) => new TileWriter(d.layers.height?.tiles, TILE, (n) => new Int16Array(n)).get(x, z)

describe('BrushController', () => {
  it('does nothing in ops mode', () => {
    const { session, b } = setup()
    b.strokeThrough(line(100.5, 100.5, 140.5))
    expect(session.canUndo).toBe(false)
    expect(b.current).toBeNull()
  })

  it('raises the ground along a stroke as one undo step', () => {
    const { session, b } = setup()
    b.setMode('height')
    b.setSettings({ radius: 4, strength: 1, falloff: 0 })
    b.strokeThrough(line(100.5, 100.5, 140.5))
    expect(height(session.doc, 120, 100)).toBeGreaterThan(0)
    expect(b.stroking).toBe(false)
    session.undo()
    expect(session.doc.layers).toEqual({})
    expect(session.canUndo).toBe(false)
  })

  it('flattens toward the height where the stroke began', () => {
    const raised = { ...flatDoc(), layers: { height: { tiles: [{ x: 1, z: 1, values: new Int16Array(HEIGHT_VALUES).fill(32) }] } } } // +2 over 64..127
    const { session, b } = setup(raised)
    b.setMode('height')
    b.setTool('flatten')
    b.setSettings({ radius: 4, strength: 1, falloff: 0 })
    b.strokeThrough(line(90.5, 30.5, 90.5)) // starts on plain ground (30)
    expect(height(session.doc, 90, 90)).toBe(0)
    expect(height(session.doc, 120, 120)).toBe(32)
  })

  it('paints the chosen biome, and erase clears it', () => {
    const { session, b } = setup()
    b.setMode('biome')
    b.setBiome(2)
    b.setSettings({ radius: 8 })
    b.strokeThrough(line(130, 120, 140))
    expect(new TileWriter(session.doc.layers.biome?.tiles, BIOME_TILE, (n) => new Uint8Array(n)).get(32, 32)).toBe(2)
    b.setTool('erase')
    b.strokeThrough(line(130, 110, 150))
    expect(session.doc.layers.biome).toBeUndefined()
  })

  it('carves density when inverted', () => {
    const { session, b } = setup()
    b.setMode('density')
    b.setSettings({ radius: 3, strength: 1, falloff: 0 })
    b.strokeThrough([{ x: 100, y: 28, z: 100 }, { x: 106, y: 28, z: 100 }], true)
    expect(session.doc.layers.density!.bricks.some((br) => br.values.some((v) => v < 0))).toBe(true)
  })

  it('does not change mode during a stroke', () => {
    const { b } = setup()
    b.setMode('height')
    b.begin({ x: 100, y: 0, z: 100 }, false)
    expect(b.setMode('biome')).toBe(false)
    expect(b.mode).toBe('height')
    b.end()
    expect(b.setMode('biome')).toBe(true)
  })

  it('a Ctrl+Z mid-stroke cancels the stroke; later moves do nothing and do not throw', () => {
    const { session, b } = setup()
    const before = session.doc
    b.setMode('height')
    b.begin({ x: 100, y: 0, z: 100 }, false)
    b.move({ x: 110, y: 0, z: 100 }, false)
    expect(session.doc).not.toBe(before)
    session.undo() // during a gesture this cancels it
    expect(session.doc).toBe(before)
    expect(() => b.move({ x: 120, y: 0, z: 100 }, false)).not.toThrow()
    b.end()
    expect(session.doc).toBe(before)
    expect(session.canUndo).toBe(false)
    expect(b.stroking).toBe(false)
  })

  it('spaces 2D dabs by distance in x and z only, whatever the height under the aim', () => {
    const { session, b } = setup()
    b.setMode('height')
    b.setSettings({ radius: 4, strength: 1, falloff: 0 })
    b.begin({ x: 100.5, y: 31, z: 100.5 }, false)
    const afterFirst = session.doc
    b.move({ x: 100.5, y: 40, z: 100.5 }, false) // same column, 9 blocks higher: no dab
    b.move({ x: 100.5, y: 20, z: 100.5 }, false)
    expect(session.doc).toBe(afterFirst)
    b.end()

    // a climbing aim along x paints exactly what a level aim does
    const tall = setup()
    const level = setup()
    for (const t of [tall, level]) { t.b.setMode('height'); t.b.setSettings({ radius: 4, strength: 1, falloff: 0 }) }
    const along = (y: (i: number) => number): Point3[] => Array.from({ length: 9 }, (_, i) => ({ x: 100.5 + i, y: y(i), z: 100.5 }))
    tall.b.strokeThrough(along((i) => 31 + i * 20))
    level.b.strokeThrough(along(() => 31))
    expect(tall.session.doc.layers).toEqual(level.session.doc.layers)
  })

  it('remembers radius, strength and falloff per tool', () => {
    const { b } = setup()
    b.setMode('height')
    b.setSettings({ radius: 30 })
    b.setTool('smooth')
    expect(b.current!.settings.radius).toBe(12)
    b.setSettings({ radius: 5, strength: 0.1 })
    b.setTool('raise')
    expect(b.current!.settings).toMatchObject({ radius: 30, strength: 0.5 })
    b.setTool('smooth')
    expect(b.current!.settings).toMatchObject({ radius: 5, strength: 0.1 })
  })

  it('leaves no gesture open when the sampler throws in begin or in a move', () => {
    class Throwing extends TerrainSampler {
      armed = true
      override heights(...a: Parameters<TerrainSampler['heights']>): Float64Array {
        if (this.armed) throw new Error('op failed')
        return super.heights(...a)
      }
    }
    const session = new EditorSession(flatDoc(), { worldHeight: HEIGHT })
    const sampler = new Throwing({ seed: 1, height: HEIGHT })
    const b = new BrushController(session, sampler)
    b.setMode('height')
    expect(() => b.begin({ x: 100, y: 0, z: 100 }, false)).toThrow('op failed')
    expect(session.inGesture).toBe(false)
    expect(b.stroking).toBe(false)

    sampler.armed = false
    b.begin({ x: 100, y: 0, z: 100 }, false)
    expect(b.stroking).toBe(true)
    sampler.armed = true
    expect(() => b.move({ x: 120, y: 0, z: 100 }, false)).toThrow('op failed')
    expect(session.inGesture).toBe(false)
    expect(b.stroking).toBe(false)
    expect(session.canUndo).toBe(false)
  })

  it('clamps settings, ignores unknown tools, keeps the biome in range and reports changes', () => {
    const { b } = setup()
    let changes = 0
    b.onChange(() => changes++)
    b.setMode('density')
    b.setSettings({ radius: 999, strength: -1 })
    expect(b.current!.settings).toMatchObject({ radius: 64, strength: 0 })
    b.setTool('raise')
    expect(b.current!.tool).toBe('add')
    b.setBiome(9)
    expect(b.biome).toBe(2) // the fixture has 2 biomes
    expect(changes).toBe(3)
  })
})
