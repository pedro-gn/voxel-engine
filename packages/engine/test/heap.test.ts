import { expect, it } from 'vitest'
import { IdHeap } from '../src/sim/navigation/heap.ts'

it('pops by f, then h, then id, and grows past its initial size', () => {
  const h = new IdHeap(), keys = new Map<number, [number, number]>()
  for (let i = 0; i < 1000; i++) { const f = (i * 7919) % 101, k = i % 3; h.push(999 - i, f, k); keys.set(999 - i, [f, k]) }
  let last: [number, number, number] = [-1, -1, -1], n = 0
  while (h.size) {
    const f = h.peekF(), id = h.pop(), [kf, kh] = keys.get(id)!
    expect(kf).toBe(f)
    const after = kf > last[0] || kf === last[0] && (kh > last[1] || kh === last[1] && id > last[2])
    expect(after).toBe(true)
    last = [kf, kh, id]; n++
  }
  expect(n).toBe(1000); expect(h.peekF()).toBe(Infinity)
})
it('mixes its contents in heap order', () => {
  const a = new IdHeap(), b = new IdHeap(); a.push(1, 5, 0); b.push(1, 6, 0)
  const sig = (h: IdHeap) => { const v: number[] = []; h.mixState(n => v.push(n)); return v }
  expect(sig(a)).not.toEqual(sig(b))
  a.clear(); expect(a.size).toBe(0)
})
