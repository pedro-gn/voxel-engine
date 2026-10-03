import { BlockRegistry } from '@elovox/engine/src/blocks/registry.ts'
import { BUILTIN_OPS, compileTerrain, generateRegion, validateTerrainDoc, type CompiledTerrain } from '@elovox/terrain'
import { describe, expect, it } from 'vitest'
import { BLOCKS } from '../src/blocks.ts'
import e2eDoc from '../src/terrain/e2e.terrain.json'
import showcaseDoc from '../src/terrain/showcase.terrain.json'

const registry = new BlockRegistry(BLOCKS)

function compile(doc: unknown): CompiledTerrain {
  const r = validateTerrainDoc(doc)
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return compileTerrain(r.doc, { seed: 1234, height: 128, id: (name) => registry.id(name) })
}

function columnHash(t: CompiledTerrain, cx: number, cz: number): number {
  const out = new Uint16Array(32 * 32 * 128)
  generateRegion(t, cx * 32, cz * 32, 32, 32, out)
  let h = 0x811c9dc5
  for (let i = 0; i < out.length; i++) h = Math.imul(h ^ out[i]!, 0x01000193)
  return h >>> 0
}

describe('sandbox terrain documents', () => {
  it.each([['e2e', e2eDoc], ['showcase', showcaseDoc]] as const)('%s validates and compiles against the sandbox blocks', (_name, doc) => {
    expect(() => compile(doc)).not.toThrow()
  })

  it('the e2e document uses every built-in op', () => {
    expect(new Set(e2eDoc.ops.map((o) => o.type))).toEqual(new Set(BUILTIN_OPS.map((o) => o.type)))
  })

  it('showcase columns match their golden hashes (cave, mesa and canyon, river and lake, coast)', () => {
    const t = compile(showcaseDoc)
    expect([[16, 7], [25, 15], [13, 21], [4, 29]].map(([cx, cz]) => columnHash(t, cx!, cz!))).toEqual(GOLDEN)
  })
})

const GOLDEN = [3661734573, 2782277415, 447834565, 3048637645]
