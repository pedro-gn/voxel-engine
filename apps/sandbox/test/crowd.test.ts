import { BlockRegistry } from '@elovox/engine/testing'
import { compileTerrain, generateRegion, validateTerrainDoc } from '@elovox/terrain'
import { expect, it } from 'vitest'
import { BLOCKS } from '../src/blocks.ts'
import { CROWD_SIZE, PADS, spawnCrowd, scatterMoves, workOrders, bottleneckCommands } from '../src/scenes/crowd.ts'
import doc from '../src/terrain/crowd.terrain.json'

it('pads in the document match the exported boxes and heights', () => {
  const flats = (doc.ops as { type: string }[]).filter(o => o.type === 'flatten')
  expect(flats).toHaveLength(5)
  for (const pad of Object.values(PADS)) expect(pad.max[0] - pad.min[0]).toBe(63)
})
it('spawns 1,000 distinct positions on the pads, deterministically', () => {
  const a = spawnCrowd(1000, ['west', 'north']), b = spawnCrowd(1000, ['west', 'north'])
  expect(a).toEqual(b)
  const keys = new Set(a.map(c => (c as { pos: readonly number[] }).pos.join(',')))
  expect(keys.size).toBe(1000)
})
it('scatter moves go 200–800 blocks away, 25 ids per order', () => {
  const moves = scatterMoves([...Array(1000).keys()].map(i => i + 1), 7)
  expect(moves).toHaveLength(40)
  for (const m of moves) expect((m as unknown as { ids: readonly number[] }).ids).toHaveLength(25)
  moves.forEach((m, g) => {
    const from = PADS[g < 20 ? 'west' : 'north'], [x, , z] = (m as { pos: readonly number[] }).pos
    const d = Math.hypot(x! - from.min[0] - 32, z! - from.min[2] - 32)
    expect(d).toBeGreaterThanOrEqual(200 - 24); expect(d).toBeLessThanOrEqual(800 + 24)
  })
  expect(scatterMoves([...Array(1000).keys()].map(i => i + 1), 7)).toEqual(moves)
})
it('work orders include two larger than the frontier', () => {
  const orders = workOrders(1, 2)
  expect(orders).toHaveLength(20)
  const cells = orders.map(o => { const { min, max } = o as { min: readonly number[]; max: readonly number[] }; return (max[0]! - min[0]! + 1) * (max[1]! - min[1]! + 1) * (max[2]! - min[2]! + 1) })
  expect(cells.filter(n => n > 256)).toHaveLength(2)
  expect(bottleneckCommands(1).length).toBeGreaterThan(0)
})
it('every pad is flat at its height over the whole box, in a 1024² document', () => {
  const registry = new BlockRegistry(BLOCKS), water = registry.id('water')
  const r = validateTerrainDoc(doc)
  if (!r.ok) throw new Error(r.errors.join('\n'))
  expect(doc.size).toEqual([CROWD_SIZE[0], CROWD_SIZE[2]])
  const t = compileTerrain(r.doc, { seed: 1234, height: CROWD_SIZE[1], id: (name) => registry.id(name) })
  const out = new Uint16Array(CROWD_SIZE[1])
  const groundAt = (x: number, z: number) => {
    generateRegion(t, x, z, 1, 1, out, { features: false })
    for (let y = CROWD_SIZE[1] - 1; y >= 0; y--) if (out[y] !== 0 && (out[y]! & 0xfff) !== water) return y + 1
    return 0
  }
  for (const [name, pad] of Object.entries(PADS)) {
    for (let z = pad.min[2]; z <= pad.max[2]; z += 9) for (let x = pad.min[0]; x <= pad.max[0]; x += 9) expect(groundAt(x, z), `${name} (${x}, ${z})`).toBe(pad.y)
    expect(groundAt(pad.max[0], pad.max[2]), name).toBe(pad.y)
  }
})
