import { HEIGHT_VALUES } from '@elovox/terrain'
import { describe, expect, it } from 'vitest'
import { removeOp, setParam, setSeaLevel, setShape } from '../src/core/edits.ts'
import { EditorSession, type ChangeEvent } from '../src/core/session.ts'
import { HEIGHT, doc } from './fixtures.ts'

function session() {
  const s = new EditorSession(doc(), { worldHeight: HEIGHT })
  const changes: ChangeEvent[] = []
  const selects: (string | null)[] = []
  s.on('change', (e) => changes.push(e))
  s.on('select', (id) => selects.push(id))
  return { s, changes, selects }
}
const circle = (x: number, r = 20) => ({ kind: 'circle' as const, center: [x, 64] as [number, number], radius: r, falloff: 8 })

describe('EditorSession edits', () => {
  it('applies a valid edit as one undo step and reports its area', () => {
    const { s, changes } = session()
    expect(s.apply('amplitude', setParam('hill', 'amplitude', 3))).toEqual({ ok: true })
    expect(s.doc.ops[0]!.params.amplitude).toBe(3)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ cause: 'edit', area: { x0: 0, z0: 0, x1: 128, z1: 128 } })
    expect(s.dirty && s.canUndo).toBe(true)
  })

  it('refuses an invalid edit and changes nothing', () => {
    const { s, changes } = session()
    const before = s.doc
    const r = s.apply('amplitude', setParam('hill', 'amplitude', -1))
    expect(r).toEqual({ ok: false, errors: ['ops[0].params.amplitude: must be >= 0'] })
    expect(s.doc).toBe(before)
    expect(changes).toHaveLength(0)
    expect(s.canUndo).toBe(false)
  })

  it('undoes and redoes back to the saved document', () => {
    const { s, changes } = session()
    const start = s.doc
    s.apply('amplitude', setParam('hill', 'amplitude', 3))
    expect(s.undo()).toBe(true)
    expect(s.doc).toBe(start)
    expect(s.dirty).toBe(false)
    expect(s.redo()).toBe(true)
    expect(s.doc.ops[0]!.params.amplitude).toBe(3)
    expect(changes.map((c) => c.cause)).toEqual(['edit', 'undo', 'redo'])
    expect(s.undo() && s.undo()).toBe(false)
  })

  it('reports the whole world for a sea level change', () => {
    const { s, changes } = session()
    s.apply('sea level', setSeaLevel(12))
    expect(changes[0]!.area).toBe('all')
  })
})

describe('EditorSession gestures', () => {
  it('applies each update to the start document and records one step on commit', () => {
    const { s, changes } = session()
    const start = s.doc
    s.begin('move hill')
    s.update(setShape('hill', circle(70)))
    s.update(setShape('hill', circle(80)))
    s.commit()
    expect(s.doc.ops[0]!.shape).toEqual(circle(80))
    expect(changes.map((c) => c.cause)).toEqual(['gesture', 'gesture', 'commit'])
    expect(changes[2]!.prev).toBe(start)
    s.undo()
    expect(s.doc).toBe(start)
    expect(s.canUndo).toBe(false)
  })

  it('keeps the last valid document when an update is invalid', () => {
    const { s } = session()
    s.begin('radius')
    s.update(setShape('hill', circle(64, 10)))
    const r = s.update(setShape('hill', circle(64, 0)))
    expect(r.ok).toBe(false)
    expect(s.doc.ops[0]!.shape).toEqual(circle(64, 10))
    s.commit()
    expect(s.doc.ops[0]!.shape).toEqual(circle(64, 10))
  })

  it('cancels back to the start document without a history step', () => {
    const { s, changes } = session()
    const start = s.doc
    s.begin('move hill')
    s.update(setShape('hill', circle(80)))
    s.cancel()
    expect(s.doc).toBe(start)
    expect(s.canUndo).toBe(false)
    expect(changes.map((c) => c.cause)).toEqual(['gesture', 'cancel'])
  })

  it('records nothing for a gesture that changed nothing', () => {
    const { s, changes } = session()
    s.begin('noop')
    s.commit()
    expect(s.canUndo).toBe(false)
    expect(changes).toHaveLength(0)
  })

  it('treats undo during a gesture as cancel, leaving earlier steps alone', () => {
    const { s } = session()
    s.apply('amplitude', setParam('hill', 'amplitude', 3))
    const afterEdit = s.doc
    s.begin('move hill')
    s.update(setShape('hill', circle(80)))
    expect(s.undo()).toBe(true)
    expect(s.doc).toBe(afterEdit)
    expect(s.inGesture).toBe(false)
    expect(s.canUndo).toBe(true)
  })

  it('refuses apply and begin during a gesture', () => {
    const { s } = session()
    s.begin('a')
    expect(() => s.apply('b', setSeaLevel(3))).toThrow('a gesture is in progress')
    expect(() => s.begin('c')).toThrow('a gesture is in progress')
  })
})

describe('EditorSession selection, open and save', () => {
  it('selects known ops only and clears the selection when the op goes away', () => {
    const { s, selects } = session()
    s.select('ridge')
    s.select('nope')
    s.select('pond')
    s.apply('remove', removeOp('pond'))
    expect(s.selected).toBeNull()
    expect(selects).toEqual(['ridge', null, 'pond', null])
  })

  it('opens a document: no history, nothing selected, saved, whole world', () => {
    const { s, changes } = session()
    s.apply('amplitude', setParam('hill', 'amplitude', 3))
    s.select('hill')
    const other = doc()
    s.open(other)
    expect(s.doc).toBe(other)
    expect(s.canUndo || s.dirty).toBe(false)
    expect(s.selected).toBeNull()
    expect(changes.at(-1)).toMatchObject({ cause: 'open', area: 'all' })
  })

  it('marks the current document saved', () => {
    const { s } = session()
    s.apply('amplitude', setParam('hill', 'amplitude', 3))
    s.markSaved()
    expect(s.dirty).toBe(false)
    s.undo()
    expect(s.dirty).toBe(true)
  })

  it('keeps edited documents normalized', () => {
    const { s } = session()
    s.apply('amplitude', setParam('hill', 'amplitude', 3))
    s.apply('offset', setParam('hill', 'offset', undefined))
    expect(JSON.parse(JSON.stringify(s.doc))).toEqual(s.doc)
  })
})

describe('EditorSession gesture and save edge cases', () => {
  it('treats a gesture that ends where it started as a cancel', () => {
    const { s, changes } = session()
    const start = s.doc
    s.begin('drag')
    s.update(setParam('hill', 'amplitude', 3))
    s.update(setParam('hill', 'amplitude', start.ops[0]!.params.amplitude as number))
    s.commit()
    expect(s.doc).toBe(start)
    expect(s.canUndo).toBe(false)
    expect(s.dirty).toBe(false)
    expect(s.inGesture).toBe(false)
    expect(changes[changes.length - 1]!.cause).toBe('cancel')
    expect(changes.some((c) => c.cause === 'commit')).toBe(false)
  })

  it('marks the given document saved, not whatever is current', () => {
    const { s } = session()
    s.apply('amplitude', setParam('hill', 'amplitude', 3))
    const serialized = s.doc
    s.apply('amplitude', setParam('hill', 'amplitude', 4))
    s.markSaved(serialized)
    expect(s.dirty).toBe(true)
    s.markSaved()
    expect(s.dirty).toBe(false)
  })
})

describe('EditorSession layers', () => {
  it('records a layers-only gesture as one step with the area it changed', () => {
    const { s, changes } = session()
    const values = new Int16Array(HEIGHT_VALUES)
    values[0] = 16 // column (0, 0)
    const painted = { ...s.doc, layers: { height: { tiles: [{ x: 0, z: 0, values }] } } }
    s.begin('raise')
    expect(s.update(() => painted)).toEqual({ ok: true })
    s.commit()
    expect(s.doc).toBe(painted)
    expect(changes.at(-1)).toMatchObject({ cause: 'commit', area: { x0: 0, z0: 0, x1: 32, z1: 32 } })
    s.undo()
    expect(s.doc.layers).toEqual({})
  })

  it('trusts a layers-only change without validating it (brushes clamp what they write)', () => {
    const { s } = session()
    const outside = { ...s.doc, layers: { height: { tiles: [{ x: 99, z: 0, values: new Int16Array(HEIGHT_VALUES).fill(1) }] } } }
    expect(s.apply('paint', () => outside)).toEqual({ ok: true })
  })
})
