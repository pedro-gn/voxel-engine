import { describe, expect, it } from 'vitest'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { WaterEdges, segmentsOf } from '../src/sim/water/edges.ts'
import { UnderSegments } from '../src/sim/water/under.ts'

const H = 32

/** A 32 × 32 world, every top floor at 1; column (5, 5) also holds a lower segment [2, 5) under a roof, its top at 6. */
function setup() {
  const cols = new WaterColumns(32, 32, new Int16Array(32 * 32))
  cols.floor.fill(1)
  const u = new UnderSegments(cols.n)
  const c = 5 + 5 * 32
  cols.floor[c] = 6
  const i = u.alloc(c, 2, 5, SUB)
  u.setChain(c, [i])
  const e = new WaterEdges(cols.tiles.count)
  e.markAll()
  e.ensure(cols, u, H)
  return { cols, u, e, c, ref: cols.n + i }
}

describe('WaterEdges', () => {
  it('lists every overlapping pair but the two tops, row-major, +x before +z, bottom-up', () => {
    const { cols, e, c, ref } = setup()
    const E = e.tiles[0]!
    const got = Array.from({ length: E.count }, (_, k) => [E.a[k], E.b[k], E.lo[k], E.axis[k]])
    expect(got).toEqual([
      [c - 32, ref, 2, 1], // (5, 4) +z into the lower segment
      [c - 1, ref, 2, 0], // (4, 5) +x
      [ref, c + 1, 2, 0], // (5, 5) lower segment +x
      [ref, c + 32, 2, 1], // (5, 5) lower segment +z
    ])
    expect(e.tiles[1]).toBeNull() // no lower segment in or beside tile 1
    expect(segmentsOf(c, setupUnder(cols), [])).toEqual([c])
  })

  it('keeps the flux of an edge whose two segments survive a rebuild, drops edges that vanished', () => {
    const { cols, u, e, c } = setup()
    const E = e.tiles[0]!
    E.flux[2] = 777
    e.markColumn(5, 5, cols)
    e.ensure(cols, u, H)
    expect(e.tiles[0]!.flux[2]).toBe(777)
    expect(e.rebuilt).toEqual([0])
    u.freeColumn(c)
    e.markColumn(5, 5, cols)
    e.ensure(cols, u, H)
    expect(e.tiles[0]).toBeNull()
  })

  it('marks the tiles owning a column edges: its own and its −x and −z neighbours', () => {
    const { cols, u, e } = setup()
    e.markColumn(16, 16, cols)
    e.ensure(cols, u, H)
    expect(e.rebuilt).toEqual([1, 2, 3]) // tiles (1,0), (0,1), (1,1) of a 2 × 2 tiling
  })

  it('makes no edge for an empty top (a column solid to the top) and none across no overlap', () => {
    const cols = new WaterColumns(16, 16, new Int16Array(256))
    cols.floor.fill(H) // every column solid to the top
    const u = new UnderSegments(cols.n)
    const i = u.alloc(0, 2, 4, 0), j = u.alloc(1, 5, 7, 0) // side by side, no overlap
    u.setChain(0, [i]); u.setChain(1, [j])
    const e = new WaterEdges(cols.tiles.count)
    e.markAll()
    e.ensure(cols, u, H)
    expect(e.tiles[0]).toBeNull()
  })
})

function setupUnder(cols: WaterColumns): UnderSegments { return new UnderSegments(cols.n) }
