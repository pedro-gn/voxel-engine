import { describe, expect, it } from 'vitest'
import { SaveQueue } from '../src/persist/saveQueue.ts'

describe('save queue', () => {
  it('coalesces requests made during a run into one next run with the latest arguments', async () => {
    const runs: string[] = []
    let release!: () => void
    const q = new SaveQueue<string, string>(async (a) => {
      runs.push(a)
      if (runs.length === 1) await new Promise<void>(r => { release = r })
      return `done ${a}`
    })
    const p1 = q.request('a')
    const p2 = q.request('b'), p3 = q.request('c')
    release()
    expect(await p1).toBe('done a')
    expect(await p2).toBe('done c')
    expect(await p3).toBe('done c')
    expect(runs).toEqual(['a', 'c'])
  })
  it('a failed run rejects its callers and the queue keeps working', async () => {
    let n = 0
    const q = new SaveQueue<number, number>(async (a) => { if (n++ === 0) throw new Error('boom'); return a })
    await expect(q.request(1)).rejects.toThrow('boom')
    expect(await q.request(2)).toBe(2)
  })
})
