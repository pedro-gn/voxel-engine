import { describe, expect, it } from 'vitest'
import { actionFor, isTyping } from '../src/ui/keys.ts'
import { statusText } from '../src/ui/panels/toolbar.ts'

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods })

describe('actionFor', () => {
  it('maps the editor shortcuts', () => {
    expect(actionFor(key('z', { ctrlKey: true }), false)).toBe('undo')
    expect(actionFor(key('Z', { ctrlKey: true, shiftKey: true }), false)).toBe('redo')
    expect(actionFor(key('y', { ctrlKey: true }), false)).toBe('redo')
    expect(actionFor(key('z', { metaKey: true }), false)).toBe('undo')
    expect(actionFor(key('d', { ctrlKey: true }), false)).toBe('duplicate')
    expect(actionFor(key('Delete'), false)).toBe('delete')
    expect(actionFor(key('Backspace'), false)).toBe('delete')
    expect(actionFor(key('h'), false)).toBe('toggle')
    expect(actionFor(key('Escape'), false)).toBe('cancel')
    expect(actionFor(key('s', { ctrlKey: true }), false)).toBe('save')
    expect(actionFor(key('w'), false)).toBeNull()
  })

  it('leaves keys to a focused text field, except save and cancel', () => {
    expect(actionFor(key('Delete'), true)).toBeNull()
    expect(actionFor(key('z', { ctrlKey: true }), true)).toBeNull()
    expect(actionFor(key('s', { ctrlKey: true }), true)).toBe('save')
    expect(actionFor(key('Escape'), true)).toBe('cancel')
  })
})

describe('isTyping', () => {
  it('is true for text inputs, selects and text areas, false for sliders, checkboxes and nothing', () => {
    expect(isTyping({ tagName: 'INPUT', type: 'number' })).toBe(true)
    expect(isTyping({ tagName: 'SELECT' })).toBe(true)
    expect(isTyping({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTyping({ tagName: 'INPUT', type: 'range' })).toBe(false)
    expect(isTyping({ tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(isTyping({ tagName: 'CANVAS' })).toBe(false)
    expect(isTyping(null)).toBe(false)
  })
})

describe('statusText', () => {
  it('describes each preview state', () => {
    expect(statusText({ state: 'idle', last: null })).toBe('ready')
    expect(statusText({ state: 'idle', last: { ms: 84.4, chunks: 12, wallMs: 131.6 } })).toBe('regen 84 ms · 12 chunks · 132 ms to mesh')
    expect(statusText({ state: 'idle', last: { ms: 37, chunks: 9, wallMs: 150.2, meshMs: 61.4, meshFrames: 3 } })).toBe('regen 37 ms · 9 chunks · 150 ms to mesh (meshing 3 frames, 61 ms)')
    expect(statusText({ state: 'busy' })).toBe('updating…')
    expect(statusText({ state: 'error', message: 'op "x" failed: boom', opId: 'x' })).toBe('error: op "x" failed: boom')
  })
})
