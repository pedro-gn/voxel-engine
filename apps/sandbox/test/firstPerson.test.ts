import { describe, expect, it } from 'vitest'
import { isModeKey, placementTarget } from '../src/firstPerson.ts'

const key = (o: Partial<{ code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean }> = {}) =>
  ({ code: 'KeyC', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...o })

describe('isModeKey', () => {
  it('is a bare C press outside text fields', () => {
    expect(isModeKey(key(), null)).toBe(true)
    expect(isModeKey(key(), { tagName: 'BODY' })).toBe(true)
    expect(isModeKey(key(), { tagName: 'BUTTON' })).toBe(true)
    expect(isModeKey(key(), { tagName: 'INPUT', type: 'checkbox' })).toBe(true)
  })
  it('ignores other keys, modifiers, repeats and typing', () => {
    expect(isModeKey(key({ code: 'KeyV' }), null)).toBe(false)
    for (const m of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'repeat'] as const) expect(isModeKey(key({ [m]: true }), null)).toBe(false)
    expect(isModeKey(key(), { tagName: 'INPUT' })).toBe(false)
    expect(isModeKey(key(), { tagName: 'INPUT', type: 'number' })).toBe(false)
    expect(isModeKey(key(), { tagName: 'TEXTAREA' })).toBe(false)
    expect(isModeKey(key(), { tagName: 'SELECT' })).toBe(false)
    expect(isModeKey(key(), { tagName: 'DIV', isContentEditable: true })).toBe(false)
  })
})

describe('placementTarget', () => {
  const yes = () => true, no = () => false
  it('is the cell on the hit face', () => {
    expect(placementTarget({ pos: [4, 5, 6], normal: [0, 1, 0] }, yes, no)).toEqual([4, 6, 6])
    expect(placementTarget({ pos: [4, 5, 6], normal: [-1, 0, 0] }, yes, no)).toEqual([3, 5, 6])
  })
  it('refuses no hit, an inside hit, out of bounds and the player body', () => {
    expect(placementTarget(null, yes, no)).toBeNull()
    expect(placementTarget({ pos: [4, 5, 6], normal: [0, 0, 0] }, yes, no)).toBeNull()
    expect(placementTarget({ pos: [4, 5, 6], normal: [0, 1, 0] }, no, no)).toBeNull()
    expect(placementTarget({ pos: [4, 5, 6], normal: [0, 1, 0] }, yes, (x, y, z) => x === 4 && y === 6 && z === 6)).toBeNull()
  })
})
