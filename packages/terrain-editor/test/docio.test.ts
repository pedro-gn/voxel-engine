import { HEIGHT_VALUES } from '@elovox/terrain'
import { describe, expect, it } from 'vitest'
import { parseTerrainText, serializeTerrain } from '../src/core/docio.ts'
import { HEIGHT, SIZE, doc, rawDoc } from './fixtures.ts'

const o = { size: SIZE, worldHeight: HEIGHT }

describe('parseTerrainText', () => {
  it('reads a valid document', () => {
    const r = parseTerrainText(JSON.stringify(rawDoc()), o)
    expect(r.ok && r.doc.ops.map((op) => op.id)).toEqual(['hill', 'ridge', 'pond', 'rock'])
  })

  it('rejects text that is not JSON', () => {
    const r = parseTerrainText('{ nope', o)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.errors[0]).toMatch(/^not JSON: /)
  })

  it('returns validation errors with their paths', () => {
    expect(parseTerrainText(JSON.stringify({ ...rawDoc(), seaLevel: -1 }), o)).toEqual({ ok: false, errors: ['seaLevel: must be >= 0'] })
  })

  it('rejects a document of another size', () => {
    expect(parseTerrainText(JSON.stringify({ ...rawDoc(), size: [512, 512] }), o)).toEqual({
      ok: false, errors: ['size: the document is 512 × 512 but the world is 256 × 256'],
    })
  })
})

describe('serializeTerrain', () => {
  it('writes two-space JSON with a final newline that reads back equal', () => {
    const d = doc()
    const text = serializeTerrain(d)
    expect(text.endsWith('}\n')).toBe(true)
    expect(text.split('\n')[1]).toBe('  "format": "elovox-terrain",')
    const r = parseTerrainText(text, o)
    expect(r.ok && r.doc).toEqual(d)
  })
})

describe('serializeTerrain with layers', () => {
  it('writes painted layers as base64 tiles that read back as the same document', () => {
    const values = Int16Array.from({ length: HEIGHT_VALUES }, (_, i) => (i % 7) - 3)
    const d = { ...doc(), layers: { height: { tiles: [{ x: 1, z: 2, values }] } } }
    const r = parseTerrainText(serializeTerrain(d), { size: SIZE, worldHeight: HEIGHT })
    expect(r.ok && r.doc).toEqual(d)
  })

  it('writes "layers": {} when nothing is painted', () => {
    expect(serializeTerrain(doc())).toContain('"layers": {}')
  })
})
