import { expect, it } from 'vitest'
import { ReservationTable } from '../src/sim/workers/reservations.ts'

const sig = (t: ReservationTable) => { const v: number[] = []; t.mixState(n => v.push(n)); return v }

it('timed entries are owned per tick and expire as time advances', () => {
  const t = new ReservationTable(4)
  t.reserve(1, 0, [10, 11]); t.reserve(1, 1, [11, 12])
  expect(t.owner(10, 0)).toBe(1); expect(t.owner(10, 1)).toBe(0); expect(t.horizon(1)).toBe(1)
  t.advance(1)
  expect(t.owner(10, 0)).toBe(0); expect(t.owner(12, 1)).toBe(1)
})
it('holds win over timed entries and never expire', () => {
  const t = new ReservationTable(4)
  t.hold(2, [5]); t.reserve(1, 3, [5])
  expect(t.owner(5, 3)).toBe(2)
  t.advance(100); expect(t.owner(5, 100)).toBe(2)
  t.releaseHold(2); expect(t.owner(5, 100)).toBe(0)
})
it('releaseFrom and releaseOwner free exactly the owner’s cells', () => {
  const t = new ReservationTable(8)
  for (let k = 0; k < 6; k++) { t.reserve(1, k, [k]); t.reserve(2, k, [100 + k]) }
  t.releaseFrom(1, 3)
  expect(t.owner(2, 2)).toBe(1); expect(t.owner(3, 3)).toBe(0); expect(t.owner(103, 3)).toBe(2)
  t.hold(1, [50]); t.releaseOwner(1)
  expect(t.owner(50, 0)).toBe(0); expect(t.owner(0, 0)).toBe(0); expect(t.horizon(1)).toBe(-1)
})
it('free() ignores the asking owner’s own entries', () => {
  const t = new ReservationTable(4); t.reserve(1, 0, [7])
  expect(t.free(1, 0, [7])).toBe(true); expect(t.free(2, 0, [7])).toBe(false)
})
it('mixes the same state the same way regardless of insertion order of owners', () => {
  const a = new ReservationTable(4), b = new ReservationTable(4)
  a.reserve(1, 0, [1]); a.reserve(2, 0, [2]); b.reserve(2, 0, [2]); b.reserve(1, 0, [1])
  expect(sig(a)).toEqual(sig(b))
})
it('ignores ticks outside the window and never overwrites another owner', () => {
  const t = new ReservationTable(4)
  t.reserve(1, -1, [1]); t.reserve(1, 8, [1]); t.reserve(1, 7, [2])
  expect(t.owner(1, 8)).toBe(0); expect(t.owner(2, 7)).toBe(1); expect(t.horizon(1)).toBe(7)
  t.reserve(2, 7, [2, 3])
  expect(t.owner(2, 7)).toBe(1); expect(t.owner(3, 7)).toBe(2)
  t.releaseOwner(2); expect(t.owner(2, 7)).toBe(1)
})
it('free() also refuses another owner’s timed entry under the asker’s own hold', () => {
  const t = new ReservationTable(4); t.reserve(2, 1, [9]); t.hold(1, [9])
  expect(t.free(1, 1, [9])).toBe(false); expect(t.free(1, 2, [9])).toBe(true)
})
it('a new hold replaces the owner’s previous one', () => {
  const t = new ReservationTable(4); t.hold(1, [1, 2]); t.hold(1, [3])
  expect([1, 2, 3].map(c => t.owner(c, 0))).toEqual([0, 0, 1]); expect(t.size).toBe(1)
})
it('a slot reused by a later tick reads as empty and the window slides', () => {
  const t = new ReservationTable(2)
  for (let k = 0; k < 4; k++) t.reserve(1, k, [k])
  t.advance(3)
  expect(t.owner(0, 0)).toBe(0); expect(t.owner(3, 3)).toBe(1); expect(t.size).toBe(1)
  t.reserve(1, 6, [6]); expect(t.owner(6, 6)).toBe(1); expect(t.horizon(1)).toBe(6)
  t.advance(50); expect(t.size).toBe(0); expect(t.horizon(1)).toBe(49)
})
it('lists the other owners with timed entries on given cells from a tick on', () => {
  const t = new ReservationTable(4)
  t.reserve(3, 1, [5]); t.reserve(2, 4, [5, 6]); t.reserve(1, 4, [7])
  expect(t.timedOwners([5, 7], 0, 1)).toEqual([2, 3]); expect(t.timedOwners([5, 7], 2, 0)).toEqual([1, 2])
})
it('state signature changes with the entries and returns after a release', () => {
  const t = new ReservationTable(4), empty = sig(t)
  t.reserve(3, 2, [4]); const one = sig(t); expect(one).not.toEqual(empty)
  t.hold(3, [4]); expect(sig(t)).not.toEqual(one)
  t.releaseOwner(3); expect(sig(t)).toEqual(empty)
})
