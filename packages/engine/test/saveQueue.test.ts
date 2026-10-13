import { describe, expect, it } from 'vitest'
import { SaveQueue } from '../src/persist/saveQueue.ts'

describe('save queue', () => {
  it('folds requests for the same key made during a run into one next run with the latest arguments', async () => {
    const runs: string[] = []
    let release!: () => void
    const q = new SaveQueue<string, string>(async (a) => {
      runs.push(a)
      if (runs.length === 1) await new Promise<void>(r => { release = r })
      return `done ${a}`
    })
    const p1 = q.request('slot', 'a')
    const p2 = q.request('slot', 'b'), p3 = q.request('slot', 'c')
    release()
    expect(await p1).toBe('done a')
    expect(await p2).toBe('done c')
    expect(await p3).toBe('done c')
    expect(runs).toEqual(['a', 'c'])
  })
  it('never folds two keys: each queued key runs once, in the order first asked', async () => {
    const runs: string[] = []
    let release!: () => void
    const q = new SaveQueue<string, string>(async (a) => {
      runs.push(a)
      if (runs.length === 1) await new Promise<void>(r => { release = r })
      return `done ${a}`
    })
    const p1 = q.request('a', 'a1')
    const pb = q.request('b', 'b1'), pc = q.request('autosave', 'c1'), pb2 = q.request('b', 'b2')
    release()
    expect(await p1).toBe('done a1')
    expect(await pb).toBe('done b2')
    expect(await pb2).toBe('done b2')
    expect(await pc).toBe('done c1')
    expect(runs).toEqual(['a1', 'b2', 'c1'])
  })
  it('a failed run rejects its callers and the queue keeps working', async () => {
    let n = 0
    const q = new SaveQueue<number, number>(async (a) => { if (n++ === 0) throw new Error('boom'); return a })
    await expect(q.request('k', 1)).rejects.toThrow('boom')
    expect(await q.request('k', 2)).toBe(2)
  })
})
