import { expect, it } from 'vitest'
import { ReservationTable } from '../src/sim/workers/reservations.ts'
import { SpaceTimeSearch, type SpaceTimePort, type SpaceTimePlan } from '../src/sim/workers/spaceTime.ts'

function corridor(lines: string[]) {
  const W = lines[0]!.length, D = lines.length, idx = (x: number, z: number) => x + z * W
  const open = (x: number, z: number) => x >= 0 && z >= 0 && x < W && z < D && lines[z]![x] !== '#'
  const port: SpaceTimePort = {
    neighbor: (p, d) => { const x = p % W + [1, -1, 0, 0][d]!, z = Math.floor(p / W) + [0, 0, 1, -1][d]!; return open(x, z) ? idx(x, z) : -1 },
    allowed: () => true, cellsOf: p => [p], stepCells: (a, b) => [a, b], ticksOf: () => 4, coords: p => [p % W, 0, Math.floor(p / W)],
  }
  return { port, idx }
}
/** Cells the plan occupies per tick: standing until `until`, then both poses during each 4-tick step. */
function occupancy(plan: SpaceTimePlan, start: number) {
  const at = new Map<number, Set<number>>(), put = (t: number, c: number) => { let s = at.get(t); if (!s) { s = new Set(); at.set(t, s) }; s.add(c) }
  let t = start
  plan.steps.forEach((s, i) => {
    for (; t <= s.until; t++) put(t, s.pose)
    const n = plan.steps[i + 1]; if (n) for (let k = 1; k <= 4; k++) { put(t - 1 + k, s.pose); put(t - 1 + k, n.pose) }
    if (n) t += 3
  })
  return at
}
function run(s: SpaceTimeSearch) { while (s.status === 'pending') expect(s.step(64)).toBeLessThanOrEqual(64); return s }
/** No tick of the plan uses a cell another owner has in the table. */
function clear(plan: SpaceTimePlan, start: number, table: ReservationTable, owner: number) {
  for (const [t, cells] of occupancy(plan, start)) expect(table.free(owner, t, [...cells]), `tick ${t}`).toBe(true)
}

it('waits for a crossing unit instead of walking into it', () => {
  const { port, idx } = corridor(['........']), table = new ReservationTable(32)
  for (let t = 1; t <= 12; t++) table.reserve(2, t, [idx(3, 0)])
  const targets = [1, 2, 3, 4, 5, 6, 7].map(x => idx(x, 0))
  const s = run(new SpaceTimeSearch(port, table, 1, idx(0, 0), 0, targets))
  expect(s.status).toBe('found'); expect(s.plan!.rejoin).toBe(6)
  for (const [t, cells] of occupancy(s.plan!, 0)) if (t <= 12) expect(cells.has(idx(3, 0)), `tick ${t}`).toBe(false)
  clear(s.plan!, 0, table, 1)
})
it('backs off into a side pocket when a unit with the right of way sweeps the corridor', () => {
  // The sweeper enters one step after the start so the pocket, three steps away, is reachable before it passes.
  const { port, idx } = corridor(['........', '...P....'.replace(/[^P]/g, '#')]), table = new ReservationTable(32)
  for (let k = 0; k <= 7; k++) for (let t = 4 * k + 4; t <= 4 * k + 8; t++) table.reserve(2, t, [idx(7 - k, 0)])
  const s = run(new SpaceTimeSearch(port, table, 1, idx(0, 0), 0, [1, 2, 3, 4, 5, 6, 7].map(x => idx(x, 0))))
  expect(s.status).toBe('found')
  expect(s.plan!.steps.some(st => st.pose === idx(3, 1))).toBe(true)
  clear(s.plan!, 0, table, 1)
})
it('fails, never loops, when every cell is taken', () => {
  const { port, idx } = corridor(['....']), table = new ReservationTable(32)
  for (let t = 1; t <= 32; t++) table.reserve(2, t, [0, 1, 2, 3].map(x => idx(x, 0)))
  const s = run(new SpaceTimeSearch(port, table, 1, idx(0, 0), 0, [idx(3, 0)]))
  expect(s.status).toBe('failed')
})
it('is deterministic: same inputs, same plan and the same mixState', () => {
  const make = () => { const { port, idx } = corridor(['........']), table = new ReservationTable(32); table.reserve(2, 5, [idx(2, 0)]); return run(new SpaceTimeSearch(port, table, 1, idx(0, 0), 0, [idx(7, 0)])) }
  const a = make(), b = make(), sig = (s: SpaceTimeSearch) => { const v: number[] = []; s.mixState(n => v.push(n)); return v }
  expect(a.plan).toEqual(b.plan); expect(sig(a)).toEqual(sig(b))
})
it('rejoins mid-route when the route outlasts the window', () => {
  const { port, idx } = corridor(['................']), table = new ReservationTable(8)
  const s = run(new SpaceTimeSearch(port, table, 1, idx(0, 0), 0, Array.from({ length: 15 }, (_, i) => idx(i + 1, 0))))
  expect(s.plan).toEqual({ steps: [0, 4, 8].map((t, i) => ({ pose: idx(i, 0), until: t })), rejoin: 1 })
})
it('ends in a pocket off the route when it only has to survive the window', () => {
  const { port, idx } = corridor(['...', '...']), table = new ReservationTable(8)
  for (let t = 1; t <= 16; t++) table.reserve(2, t, [idx(0, 0), idx(1, 0), idx(2, 0)].filter((_, i) => i !== 0 || t > 4))
  const s = run(new SpaceTimeSearch(port, table, 1, idx(0, 0), 0, [idx(1, 0), idx(2, 0)]))
  expect(s.status).toBe('found'); expect(s.plan!.rejoin).toBe(-1)
  expect(s.plan!.steps).toEqual([{ pose: idx(0, 0), until: 0 }, { pose: idx(0, 1), until: 4 }, { pose: idx(1, 1), until: 8 }])
  clear(s.plan!, 0, table, 1)
})
it('stays inside its box and gives up past its operation cap', () => {
  const { port, idx } = corridor(['....................']), table = new ReservationTable(32)
  for (let t = 1; t <= 64; t++) table.reserve(2, t, [idx(3, 0)])
  const boxed = run(new SpaceTimeSearch(port, table, 1, idx(0, 0), 0, [idx(19, 0)], 2))
  expect(boxed.status).toBe('found'); expect(Math.max(...boxed.plan!.steps.map(s => s.pose))).toBeLessThanOrEqual(2)
  const capped = run(new SpaceTimeSearch(port, table, 1, idx(0, 0), 0, [idx(19, 0)], 8, 10))
  expect(capped.status).toBe('failed'); expect(capped.ops).toBeLessThanOrEqual(10)
})
it('never steps onto a pose the policy forbids', () => {
  const { port, idx } = corridor(['....', '....']), table = new ReservationTable(8)
  for (let t = 1; t <= 16; t++) table.reserve(2, t, [idx(1, 0)])
  const s = run(new SpaceTimeSearch({ ...port, allowed: p => p !== idx(1, 1) && p !== idx(0, 1) }, table, 1, idx(0, 0), 0, [idx(3, 0)]))
  expect(s.status).toBe('found'); expect(s.plan!.steps).toEqual([{ pose: idx(0, 0), until: 8 }]); expect(s.plan!.rejoin).toBe(-1)
})
it('with a refuge it ends only off the route, holding there to the window’s end', () => {
  const { port, idx } = corridor(['........', '###P####']), table = new ReservationTable(32)
  for (let k = 0; k <= 7; k++) for (let t = 4 * k + 4; t <= 4 * k + 8; t++) table.reserve(2, t, [idx(7 - k, 0)])
  const route = new Set([0, 1, 2, 3, 4, 5, 6, 7].map(x => idx(x, 0)))
  const s = run(new SpaceTimeSearch(port, table, 1, idx(2, 0), 0, [], 8, 4096, p => !route.has(p)))
  expect(s.status).toBe('found'); expect(s.plan!.rejoin).toBe(-1)
  expect(s.plan!.steps.at(-1)).toEqual({ pose: idx(3, 1), until: 32 })
  clear(s.plan!, 0, table, 1)
  const none = run(new SpaceTimeSearch(corridor(['........']).port, table, 1, idx(2, 0), 0, [], 8, 4096, p => !route.has(p)))
  expect(none.status).toBe('failed')
})
it('does not end on a pocket someone else needs after the window', () => {
  const { port, idx } = corridor(['........', 'P#######']), table = new ReservationTable(32)
  for (let t = 1; t <= 32; t++) table.reserve(2, t, [1, 2, 3, 4, 5, 6, 7].map(x => idx(x, 0)))
  for (let t = 33; t < 64; t++) table.reserve(2, t, [idx(0, 0)])
  const s = run(new SpaceTimeSearch(port, table, 1, idx(0, 0), 0, [idx(7, 0)]))
  expect(s.status).toBe('found'); expect(s.plan!.steps.at(-1)!.pose).toBe(idx(0, 1)); expect(s.plan!.rejoin).toBe(-1)
})
