import { describe, expect, it } from 'vitest'
import { LayerStore } from '../src/render/water/layerStore.ts'
import { patch, resolve, hit, type SlotSource } from '../src/render/water/slotPatch.ts'
import { OUTSIDE, effective } from '../src/render/water/surfaceMesh.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { LINK_GROUND, LINK_WALL, RECORD } from '../src/sim/water/links.ts'

/** A layers block for one tile: records [local, rank, surface, floor, ceil, links ×4]. */
function block(t: number, recs: number[][]): Int32Array {
  const out = [t, recs.length]
  for (const [local, rank, surface, floor, ceil, l0, l1, l2, l3] of recs) {
    out.push(local! | (rank! << 8), surface!, floor! | (ceil! << 16), 0, l0! | (l1! << 16), l2! | (l3! << 16))
  }
  return Int32Array.from(out)
}

describe('LayerStore', () => {
  it('a new slot rises from its floor; named again it moves on from where it was', () => {
    const L = new LayerStore(32, 32)
    L.stage(block(0, [[3, 1, 5 * SUB, 2, 7, 0, 0, 0, 0]]))
    expect(L.commit(0, false)).toBe(true)
    expect([L.prev(3, 1), L.cur(3, 1), L.floor(3, 1), L.ceil(3, 1)]).toEqual([~(2 * SUB), 5 * SUB, 2, 7])
    L.stage(block(0, [[3, 1, 5 * SUB + 9, 2, 7, 0, 0, 0, 0]]))
    L.commit(0, false)
    expect([L.prev(3, 1), L.cur(3, 1)]).toEqual([5 * SUB, 5 * SUB + 9])
    expect(L.layered(0)).toBe(true)
    expect(L.layeredAround(3)).toBe(true) // tile (1, 1) of a 2 × 2 tiling touches tile 0
  })

  it('a slot no longer named sinks to its floor, then goes (Review Focus 5)', () => {
    const L = new LayerStore(32, 32)
    L.stage(block(0, [[3, 1, 5 * SUB, 2, 7, 0, 0, 0, 0]])); L.commit(0, true)
    L.stage(block(0, [])); L.commit(0, false)
    expect([L.has(3, 1), L.prev(3, 1), L.cur(3, 1)]).toEqual([true, 5 * SUB, ~(2 * SUB)])
    L.stage(block(0, [])); L.commit(0, false)
    expect([L.has(3, 1), L.prev(3, 1), L.cur(3, 1)]).toEqual([true, ~(2 * SUB), ~(2 * SUB)])
    L.stage(block(0, [])); L.commit(0, false)
    expect(L.has(3, 1)).toBe(false)
  })

  it('a new slot that continues the top water (a block placed over a lake) starts where that water was drawn, not at its floor', () => {
    const L = new LayerStore(32, 32)
    const prev = new Int32Array(32 * 32).fill(~(5 * SUB)), cur = new Int32Array(32 * 32)
    L.stage(block(0, [])); L.commit(0, true, prev, cur) // the tile seen once, no slot yet
    prev[3] = 5 * SUB // column 3 drew the lake at 5 blocks in layer 0 …
    L.stage(block(0, [[3, 1, 5 * SUB, 2, 7, 0, 0, 0, 0]])) // … now a deck at y 7 over it: the lake is the lower run [2, 7)
    L.commit(0, false, prev, cur)
    expect([L.prev(3, 1), L.cur(3, 1)]).toEqual([5 * SUB, 5 * SUB])
  })

  it('a slot whose water goes back to the top (the block over it removed) hands its level to the top at once, with no sink', () => {
    const L = new LayerStore(32, 32)
    const prev = new Int32Array(32 * 32).fill(~(8 * SUB)), cur = new Int32Array(32 * 32).fill(~(8 * SUB))
    L.stage(block(0, [[3, 1, 5 * SUB, 2, 7, 0, 0, 0, 0]])); L.commit(0, true, prev, cur)
    prev[3] = ~(8 * SUB); cur[3] = 5 * SUB // the deck is gone: the top holds the lake again
    L.stage(block(0, [])); L.commit(0, false, prev, cur)
    expect(L.has(3, 1)).toBe(false)
    expect(prev[3]).toBe(5 * SUB) // the top starts from the slot's level
  })

  it('keeps the latest staged block per tile, and links default to the neighbour top without a record', () => {
    const L = new LayerStore(32, 32)
    L.stage(block(0, [[3, 0, 0, 1, 32, 1, 0, LINK_WALL, 0]]))
    L.stage(block(0, [[3, 0, 0, 1, 32, 2, 0, LINK_WALL, 0]]))
    L.commit(0, false)
    expect([L.link(3, 0, 0), L.link(3, 0, 2), L.link(4, 0, 0)]).toEqual([2, LINK_WALL, 0])
    expect(L.commit(0, false)).toBe(false) // nothing staged
  })
})

describe('patch', () => {
  /** Rank 0 everywhere at surface 4 blocks over floor 1; a rank-1 slot at (5, 5) under a deck. */
  const src: SlotSource = {
    sx: 16, sz: 16,
    value: (c, r) => (r === 0 ? (c === 5 + 5 * 16 ? ~(8 * SUB) : 4 * SUB) : 4 * SUB),
    floor: (c, r) => (r === 0 && c === 5 + 5 * 16 ? 8 : 1),
    ceil: (c, r) => (r === 0 ? 32 : 6),
    link: (c, r, dir) => {
      if (r === 1) return 0 // the slot under the deck meets the tops around
      const x = c % 16, z = Math.floor(c / 16)
      // tops beside (5, 5) meet its rank-1 slot on the side facing it
      if ((x === 4 && z === 5 && dir === 0) || (x === 6 && z === 5 && dir === 1) || (x === 5 && z === 4 && dir === 2) || (x === 5 && z === 6 && dir === 3)) return 1
      return 0
    },
  }

  it('resolves sides through links: the slot under the deck sees the lake, the lake sees it', () => {
    resolve(src, 5, 5, 1, 0, true)
    expect([hit.c, hit.r, hit.e]).toEqual([6 + 5 * 16, 0, 4 * SUB])
    resolve(src, 4, 5, 0, 0, true)
    expect([hit.c, hit.r, hit.e]).toEqual([5 + 5 * 16, 1, 4 * SUB])
    resolve(src, 0, 0, 0, 1, true)
    expect(hit.e).toBe(OUTSIDE)
  })

  it('the 3 × 3 of the slot under the deck is the lake all round: no seam', () => {
    const e = new Int32Array(9)
    patch(src, 5, 5, 1, true, e)
    expect([...e]).toEqual(new Array(9).fill(4 * SUB))
  })

  it('ground and walls: a dry link reads as ground at its height, a wall above the slot', () => {
    const s2: SlotSource = { ...src, link: (c, r, dir) => (dir === 0 ? LINK_GROUND | 3 : dir === 1 ? LINK_WALL : 0) }
    const e = new Int32Array(9)
    patch(s2, 5, 5, 1, true, e)
    expect(e[5]).toBe(~(3 * SUB))
    expect(e[3]).toBe(~(6 * SUB))
    expect(e[4]).toBe(effective(4 * SUB, 1))
  })
})
