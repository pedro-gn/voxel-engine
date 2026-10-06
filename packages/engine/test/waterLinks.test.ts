import { describe, expect, it } from 'vitest'
import { RANKS, SUB } from '../src/sim/water/constants.ts'
import { LINK_GROUND, LINK_WALL, RECORD } from '../src/sim/water/links.ts'
import { WaterPublisher } from '../src/sim/water/publish.ts'
import { AIR, STONE, layered, wv } from './layerHelpers.ts'

/** A channel (z 1–3, floor 2, walls round) holding water y 2–5 everywhere, with a bridge deck at x = 15, y = 7. */
const bridged = (x: number, y: number, z: number) => {
  if (y < 2 || x === 0 || x === 31 || z === 0 || z >= 4) return STONE
  if (x === 15 && y === 7) return STONE
  return y <= 5 ? wv(7) : AIR
}

/** The records of a tick's layers, by tile: [local, rank, surface, floor, ceil, fluxX, fluxZ, links ×4]. */
function records(layers: Int32Array): Map<number, number[][]> {
  const out = new Map<number, number[][]>()
  for (let o = 0; o < layers.length;) {
    const t = layers[o]!, n = layers[o + 1]!, list: number[][] = []
    for (let k = 0; k < n; k++) {
      const r = layers.subarray(o + 2 + k * RECORD, o + 2 + (k + 1) * RECORD)
      list.push([r[0]! & 0xff, r[0]! >> 8, r[1]!, r[2]! & 0xffff, r[2]! >>> 16, (r[3]! << 16) >> 16, r[3]! >> 16,
        r[4]! & 0xffff, r[4]! >>> 16, r[5]! & 0xffff, r[5]! >>> 16])
    }
    out.set(t, list)
    o += 2 + n * RECORD
  }
  return out
}

function publish(w: ReturnType<typeof layered>) {
  const pub = new WaterPublisher(w.buffers.water)
  const all = Array.from({ length: w.cols.tiles.count }, (_, t) => t)
  const tick = pub.publish(all, w.cols, { under: w.under, edges: w.edges, height: 32 })!
  return { pub, tick, recs: records(tick.layers!) }
}

describe('layer records', () => {
  it('a world with no lower segment publishes an empty block per tile', () => {
    const w = layered((x, y, z) => (y < 2 ? STONE : y <= 4 && x < 10 && z < 10 ? wv(7) : AIR))
    const { recs } = publish(w)
    expect([...recs.keys()]).toEqual([0, 1, 2, 3])
    for (const list of recs.values()) expect(list).toEqual([])
  })

  it('the water under a bridge is a rank-1 slot; the lake beside it links to it on that side', () => {
    const w = layered(bridged)
    w.edges.ensure(w.cols, w.under, 32)
    const { recs } = publish(w)
    const t0 = recs.get(0)!
    const under = t0.find((r) => r[0] === 15 + 2 * 16 && r[1] === 1)!
    expect(under.slice(2, 5)).toEqual([2 * SUB + 4 * SUB, 2, 7]) // wet, its surface; floor 2, ceil 7
    expect(under.slice(7)).toEqual([0, 0, 1, 1]) // ±x: the lake's tops; ±z: the slots under the same deck
    const edge = t0.find((r) => r[0] === 15 + 1 * 16 && r[1] === 1)!
    expect(edge[10]).toBe(LINK_WALL) // −z of the row at z = 1: the stone wall
    const beside = t0.find((r) => r[0] === 14 + 2 * 16 && r[1] === 0)!
    expect(beside.slice(7, 9)).toEqual([1, 0]) // +x: the slot under the deck; −x: the next lake column's top
  })

  it('a dry lower segment met by wet water links as ground at its floor', () => {
    // a dry cave (y 2–3) under a roof beside a lake: the lake's side links to the cave's floor
    const w = layered((x, y, z) => {
      if (y < 2 || z === 0 || z >= 4 || x >= 20) return STONE
      if (x <= 9) return y <= 5 ? wv(7) : AIR
      return y <= 3 ? AIR : STONE
    })
    w.under.depth.fill(0) // keep the cave dry for this publish
    const { recs } = publish(w)
    const edge = recs.get(0)!.find((r) => r[0] === 9 + 2 * 16 && r[1] === 0)!
    expect(edge[7]).toBe(LINK_GROUND | 2)
  })

  it('a wet segment ranked past the draw layers is counted as hidden, never published (Review Focus 4)', () => {
    // five stacked water pockets in column (5, 5): ranks 1–5 under its top
    const w = layered((x, y, z) => (x === 5 && z === 5 && y > 1 && y < 22 && y % 4 !== 1 ? wv(7) : x === 5 && z === 5 && y >= 22 ? AIR : STONE))
    const { pub, recs } = publish(w)
    const ranks = recs.get(0)!.filter((r) => r[0] === 5 + 5 * 16).map((r) => r[1])
    expect(ranks.every((r) => r! < RANKS)).toBe(true)
    expect(pub.hidden).toBe(2)
  })
})
