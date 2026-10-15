import { describe, expect, it } from 'vitest'
import { BlockRegistry, defineBlock } from '../src/blocks/registry.ts'
import { DecorationRegistry, GRASS_STYLE_DEFAULTS, defineDecoration, grassStyle, type GrassDef } from '../src/render/decorations/defs.ts'

const blocks = () => new BlockRegistry([defineBlock({ name: 'grass', decoration: 'meadow' })])
const meadow = (grass: GrassDef) => new DecorationRegistry([defineDecoration({ name: 'meadow', grass })], blocks()).defs[0]!.grass!

describe('soft grass style', () => {
  it("defaults to today's look: unit width, 0.3 brightness jitter, pointed tips, root shade 0.45, full coverage", () => {
    const s = grassStyle(meadow({}))
    expect(s.shape).toEqual([1, 0.3, 0, 0.45])
    // Coverage off: a threshold below any noise value, so every decorated top keeps its grass.
    expect(s.cover[1]! + s.cover[2]!).toBeLessThan(0)
    expect(s.cover[2]).toBeGreaterThan(0) // smoothstep needs edge0 < edge1
  })
  it('packs width, jitter, blunt and root shade, and coverage as frequency, threshold and soft', () => {
    const s = grassStyle(meadow({ width: 2.5, jitter: 0.1, blunt: 0.6, rootShade: 0.15, coverage: { scale: 20, threshold: 0.4, soft: 0.1 } }))
    expect(s.shape).toEqual([2.5, 0.1, 0.6, 0.15])
    expect(s.cover[0]).toBeCloseTo(1 / 20, 9)
    expect(s.cover.slice(1, 3)).toEqual([0.4, 0.1])
  })
  it('fills coverage defaults when only some fields are given', () => {
    const s = grassStyle(meadow({ coverage: { threshold: 0.5 } }))
    expect(s.cover[0]).toBeCloseTo(1 / GRASS_STYLE_DEFAULTS.coverage.scale, 9)
    expect(s.cover.slice(1, 3)).toEqual([0.5, GRASS_STYLE_DEFAULTS.coverage.soft])
  })
  it('a decoration without grass packs the defaults (its blades count is 0 anyway)', () => {
    expect(grassStyle(null).shape).toEqual([1, 0.3, 0, 0.45])
  })
  it('validates the new fields', () => {
    const bad = (grass: object) => () => meadow(grass as GrassDef)
    expect(bad({ width: 0 })).toThrow(/grass\.width/)
    expect(bad({ width: 4.5 })).toThrow(/grass\.width/)
    expect(bad({ jitter: -0.1 })).toThrow(/grass\.jitter/)
    expect(bad({ jitter: 1.2 })).toThrow(/grass\.jitter/)
    expect(bad({ blunt: 2 })).toThrow(/grass\.blunt/)
    expect(bad({ rootShade: 1.5 })).toThrow(/grass\.rootShade/)
    expect(bad({ coverage: { scale: 0 } })).toThrow(/grass\.coverage\.scale/)
    expect(bad({ coverage: { threshold: 1.2 } })).toThrow(/grass\.coverage\.threshold/)
    expect(bad({ coverage: { soft: 0 } })).toThrow(/grass\.coverage\.soft/)
    expect(bad({ coverage: { soft: 0.6 } })).toThrow(/grass\.coverage\.soft/)
    expect(bad({ coverage: 'patchy' })).toThrow(/grass\.coverage/)
  })
})
