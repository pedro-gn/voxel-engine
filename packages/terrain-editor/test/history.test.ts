import { describe, expect, it } from 'vitest'
import { History, type Step } from '../src/core/history.ts'
import { doc } from './fixtures.ts'

const step = (label: string): Step => ({ label, before: doc(), after: doc() })

describe('History', () => {
  it('undoes and redoes in order', () => {
    const h = new History()
    const a = step('a'), b = step('b')
    h.push(a); h.push(b)
    expect(h.undo()).toBe(b)
    expect(h.undo()).toBe(a)
    expect(h.undo()).toBeNull()
    expect(h.redo()).toBe(a)
    expect(h.canUndo && h.canRedo).toBe(true)
  })

  it('drops the redo branch on a new step', () => {
    const h = new History()
    h.push(step('a')); h.undo(); h.push(step('b'))
    expect(h.canRedo).toBe(false)
  })

  it('keeps at most `limit` steps', () => {
    const h = new History(2)
    h.push(step('a')); h.push(step('b')); h.push(step('c'))
    expect([h.undo()?.label, h.undo()?.label, h.undo()]).toEqual(['c', 'b', null])
  })

  it('clears', () => {
    const h = new History()
    h.push(step('a')); h.clear()
    expect(h.canUndo || h.canRedo).toBe(false)
  })
})
