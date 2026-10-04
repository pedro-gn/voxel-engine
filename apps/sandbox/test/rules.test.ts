import type { RuleContext } from '@elovox/engine/sim-worker'
import { describe, expect, it } from 'vitest'
import { BLOCKS } from '../src/blocks.ts'
import rules, { nearWater } from '../src/rules.ts'

const id = (name: string) => BLOCKS.findIndex((b) => b.name === name) + 1
const def = (v: number) => BLOCKS[(v & 0xfff) - 1]

/** A RuleContext over a Map, with fixed random numbers and sky light 15 unless a cell is listed as dark. */
function world(cells: Record<string, number>, o: { random?: number[]; dark?: string[] } = {}) {
  const m = new Map(Object.entries(cells))
  const rnd = [...(o.random ?? [])]
  const ctx = {
    tick: 0,
    get: (x: number, y: number, z: number) => m.get(`${x},${y},${z}`) ?? 0,
    set: (x: number, y: number, z: number, v: number) => { m.set(`${x},${y},${z}`, v) },
    schedule() {}, emit() {},
    random: () => rnd.shift() ?? 0,
    id,
    isAir: (v: number) => (v & 0xfff) === 0,
    state: (v: number) => (v >>> 12) & 15,
    withState: (v: number, s: number) => (v & 0xfff) | (s << 12),
    isSolid: (v: number) => (v & 0xfff) !== 0 && def(v)!.solid !== false && !def(v)!.liquid,
    isLiquid: (v: number) => (v & 0xfff) !== 0 && def(v)!.liquid === true,
    isOpaque: (v: number) => (v & 0xfff) !== 0 && (def(v)!.layer ?? (def(v)!.liquid ? 'liquid' : 'opaque')) === 'opaque',
    falls: (v: number) => (v & 0xfff) !== 0 && def(v)!.falls === true,
    skyLight: (x: number, y: number, z: number) => ((o.dark ?? []).includes(`${x},${y},${z}`) ? 0 : 15),
    blockLight: () => 0,
    level: (v: number) => ((v & 0xfff) === id('water') ? (v >>> 12) & 7 : -1),
  } satisfies RuleContext
  return { ctx, at: (x: number, y: number, z: number) => ctx.get(x, y, z) }
}
const tick = (block: string, ctx: RuleContext, x: number, y: number, z: number) =>
  rules.blocks![block]!.onRandomTick!(ctx, x, y, z, ctx.get(x, y, z))

describe('sandbox rules', () => {
  it('turns grass under an opaque block or water into dirt', () => {
    const { ctx, at } = world({ '0,0,0': id('grass'), '0,1,0': id('stone') })
    tick('grass', ctx, 0, 0, 0)
    expect(at(0, 0, 0)).toBe(id('dirt'))
    const w = world({ '0,0,0': id('grass'), '0,1,0': id('water') | (7 << 12) })
    tick('grass', w.ctx, 0, 0, 0)
    expect(w.at(0, 0, 0)).toBe(id('dirt'))
  })
  it('grows young grass back one step per tick', () => {
    const { ctx, at } = world({ '0,0,0': id('grass') | (3 << 12) })
    tick('grass', ctx, 0, 0, 0)
    expect(at(0, 0, 0)).toBe(id('grass') | (2 << 12))
  })
  it('spreads to lit dirt as young grass, and not into the dark', () => {
    // random: side 0 (+x), dy 1 → 0 (rounds to level)
    const { ctx, at } = world({ '0,0,0': id('grass'), '1,0,0': id('dirt') }, { random: [0, 0.5] })
    tick('grass', ctx, 0, 0, 0)
    expect(at(1, 0, 0)).toBe(id('grass') | (3 << 12))
    const dark = world({ '0,0,0': id('grass'), '1,0,0': id('dirt') }, { random: [0, 0.5], dark: ['1,1,0'] })
    tick('grass', dark.ctx, 0, 0, 0)
    expect(dark.at(1, 0, 0)).toBe(id('dirt'))
  })
  it('wets dirt and sand within two blocks of water, and dries them away from it', () => {
    const water = id('water') | (7 << 12)
    const w = world({ '0,0,0': id('dirt'), '2,0,0': water, '5,0,0': id('sand'), '5,0,2': water })
    expect(nearWater(w.ctx, 0, 0, 0)).toBe(true)
    tick('dirt', w.ctx, 0, 0, 0)
    tick('sand', w.ctx, 5, 0, 0)
    expect([w.at(0, 0, 0), w.at(5, 0, 0)]).toEqual([id('mud'), id('wet_sand')])
    const dry = world({ '0,0,0': id('mud'), '9,0,0': id('wet_sand') })
    tick('mud', dry.ctx, 0, 0, 0)
    tick('wet_sand', dry.ctx, 9, 0, 0)
    expect([dry.at(0, 0, 0), dry.at(9, 0, 0)]).toEqual([id('dirt'), id('sand')])
  })
  it('lets sand and gravel fall but not wet sand; springs feed water', () => {
    expect(BLOCKS.find((b) => b.name === 'sand')!.falls).toBe(true)
    expect(BLOCKS.find((b) => b.name === 'gravel')!.falls).toBe(true)
    expect(BLOCKS.find((b) => b.name === 'wet_sand')!.falls).toBeFalsy()
    expect(BLOCKS.find((b) => b.name === 'spring')).toMatchObject({ liquid: true, source: 'water' })
  })
})
