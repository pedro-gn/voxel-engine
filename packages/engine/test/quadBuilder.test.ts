import { describe, expect, it } from 'vitest'
import { QuadBuilder } from '../src/mesh/quadBuilder.ts'

describe('QuadBuilder', () => {
  it('returns null when empty', () => expect(new QuadBuilder().build()).toBeNull())
  it('emits 4 vertices and 6 indices per quad with the four index patterns', () => {
    const q = new QuadBuilder(1)
    const a = [10, 11, 12, 13], b = [20, 21, 22, 23]
    q.push(a, b, false, false)
    q.push(a, b, false, true)
    q.push(a, b, true, false)
    q.push(a, b, true, true) // forces a grow from capacity 1
    const m = q.build()!
    expect(q.quadCount).toBe(4)
    expect(Array.from(m.vertices.subarray(0, 8))).toEqual([10, 20, 11, 21, 12, 22, 13, 23])
    expect(Array.from(m.indices)).toEqual([
      0, 1, 2, 0, 2, 3,
      4, 6, 5, 4, 7, 6,
      9, 10, 11, 9, 11, 8,
      13, 15, 14, 13, 12, 15,
    ])
  })
  it('reset clears and build returns trimmed copies', () => {
    const q = new QuadBuilder()
    q.push([1, 2, 3, 4], [5, 6, 7, 8], false, false)
    const m = q.build()!
    expect(m.vertices.length).toBe(8)
    expect(m.indices.length).toBe(6)
    q.reset()
    expect(q.build()).toBeNull()
  })
})
