import { describe, expect, it } from 'vitest'
import { MeshQueue, PRIORITY } from '../src/render/meshQueue.ts'

const dist = (ci: number) => Math.abs(ci - 10)

describe('MeshQueue', () => {
  it('serves ghost, then dirty, then initial; nearest first within a class', () => {
    const q = new MeshQueue()
    q.mark(1, PRIORITY.INITIAL)
    q.mark(9, PRIORITY.DIRTY)
    q.mark(30, PRIORITY.DIRTY)
    q.mark(50, PRIORITY.GHOST)
    expect([q.next(dist), q.next(dist), q.next(dist), q.next(dist), q.next(dist)]).toEqual([50, 9, 30, 1, -1])
  })
  it('upgrades priority but never downgrades it', () => {
    const q = new MeshQueue()
    q.mark(4, PRIORITY.DIRTY)
    q.mark(4, PRIORITY.INITIAL)
    expect(q.priorityOf(4)).toBe(PRIORITY.DIRTY)
    q.mark(4, PRIORITY.GHOST)
    expect(q.priorityOf(4)).toBe(PRIORITY.GHOST)
  })
  it('keeps one job in flight per chunk and requeues one marked meanwhile', () => {
    const q = new MeshQueue()
    q.mark(7, PRIORITY.DIRTY)
    expect(q.next(dist)).toBe(7)
    q.mark(7, PRIORITY.GHOST)
    expect(q.next(dist)).toBe(-1)
    expect(q.inFlightCount).toBe(1)
    q.finish(7)
    expect(q.priorityOf(7)).toBe(PRIORITY.GHOST)
    expect(q.next(dist)).toBe(7)
  })
  it('requeues a retry result at its old priority and frees the in-flight slot', () => {
    const q = new MeshQueue()
    q.mark(7, PRIORITY.GHOST)
    expect(q.next(dist)).toBe(7)
    q.retry(7)
    expect(q.inFlightCount).toBe(0)
    expect(q.priorityOf(7)).toBe(PRIORITY.GHOST)
    expect(q.next(dist)).toBe(7)
  })
  it('retry keeps a higher priority marked while the job ran', () => {
    const q = new MeshQueue()
    q.mark(7, PRIORITY.INITIAL)
    q.next(dist)
    q.mark(7, PRIORITY.GHOST)
    q.retry(7)
    expect(q.priorityOf(7)).toBe(PRIORITY.GHOST)
    expect(q.size).toBe(1)
  })
  it('discards out-of-order results by version', () => {
    const q = new MeshQueue()
    expect(q.accept(3, 6)).toBe(true)
    expect(q.accept(3, 4)).toBe(false)
    expect(q.accept(3, 6)).toBe(true) // a ghost mesh of the same version is fine
    expect(q.accept(3, 8)).toBe(true)
  })
})
