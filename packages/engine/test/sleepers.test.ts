import { expect, it } from 'vitest'
import { Sleepers } from '../src/sim/workers/sleepers.ts'

it('a sleeper dozes from the tick after it fell asleep until something wakes it', () => {
  const s = new Sleepers()
  s.sleep(7, 10, 3, 100, 26)
  expect(s.asleep(7)).toBe(true)
  expect(s.dozing(7, 10)).toBe(false) // the tick it fell asleep it still runs its second pass
  expect(s.dozing(7, 11)).toBe(true)
  s.wakeOwner(3)
  expect(s.asleep(7)).toBe(false); expect(s.size).toBe(0)
})
it('wakes by tile, by deadline, one by one and all at once', () => {
  const s = new Sleepers()
  s.sleep(1, 0, 9, 5, 16); s.sleep(2, 0, 9, 6, 16); s.sleep(3, 0, 8, 6, 4); s.sleep(4, 0, 8, 7, 16)
  s.wakeTile(6); expect([1, 2, 3, 4].map(id => s.asleep(id))).toEqual([true, false, false, true])
  s.sleep(3, 1, 8, 6, 4); s.expire(3); expect(s.asleep(3)).toBe(true); s.expire(4); expect(s.asleep(3)).toBe(false)
  s.wake(1); expect(s.asleep(1)).toBe(false)
  s.wakeAll(); expect(s.size).toBe(0)
})
it('sleeping again replaces the old owner and tile', () => {
  const s = new Sleepers()
  s.sleep(1, 0, 9, 5, 16); s.sleep(1, 2, 8, 6, 18)
  s.wakeOwner(9); s.wakeTile(5); expect(s.asleep(1)).toBe(true)
  s.wakeOwner(8); expect(s.asleep(1)).toBe(false)
})
it('mixes the same state the same way regardless of insertion order', () => {
  const a = new Sleepers(), b = new Sleepers(), ha: number[] = [], hb: number[] = []
  a.sleep(1, 0, 9, 5, 16); a.sleep(2, 0, 8, 6, 16)
  b.sleep(2, 0, 8, 6, 16); b.sleep(1, 0, 9, 5, 16)
  a.mixState(n => ha.push(n)); b.mixState(n => hb.push(n))
  expect(ha).toEqual(hb)
})
