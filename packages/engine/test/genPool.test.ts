import { describe, expect, it } from 'vitest'
import type { FromGen, ToGen } from '../src/protocol.ts'
import { GenPool, type PortLike } from '../src/sim/genPool.ts'
import { TEST_BLOCKS } from './helpers.ts'

class FakePort implements PortLike {
  readonly posted: ToGen[] = []
  onmessage: ((e: MessageEvent<FromGen>) => void) | null = null
  postMessage(m: ToGen): void { this.posted.push(m) }
  jobs() { return this.posted.filter((m) => m.type === 'job') as Extract<ToGen, { type: 'job' }>[] }
  /** Answers job `id` with a column (data = [cx, cz]) or an error. */
  answer(id: number, epoch = 1, error?: string): void {
    const job = this.jobs().find((j) => j.id === id)!
    const m: FromGen = error
      ? { type: 'error', id, epoch, message: error }
      : { type: 'column', id, epoch, cx: job.cx, cz: job.cz, data: Uint16Array.from([job.cx, job.cz]) }
    this.onmessage?.({ data: m } as MessageEvent<FromGen>)
  }
}

function batch(columns: [number, number][]) {
  const log: string[] = []
  return {
    log,
    b: {
      columns,
      onColumn: (cx: number, cz: number, d: Uint16Array) => { log.push(`col ${cx},${cz} [${d.join(',')}]`) },
      onDone: () => { log.push('done') },
      onError: (m: string) => { log.push(`error ${m}`) },
    },
  }
}
const cols = (n: number): [number, number][] => Array.from({ length: n }, (_, i) => [i, 0])

describe('GenPool', () => {
  it('broadcasts configure with a new epoch each time', () => {
    const a = new FakePort(), b = new FakePort()
    const pool = new GenPool([a, b])
    pool.configure({ x: 1 }, [64, 64, 64], 3, TEST_BLOCKS)
    pool.configure({ x: 2 }, [64, 64, 64], 3, TEST_BLOCKS)
    expect(a.posted.map((m) => m.type === 'configure' && m.epoch)).toEqual([1, 2])
    expect(b.posted).toHaveLength(2)
  })

  it('keeps at most two jobs in flight per worker and finishes once', () => {
    const a = new FakePort(), b = new FakePort()
    const pool = new GenPool([a, b])
    pool.configure(undefined, [64, 64, 64], 3, TEST_BLOCKS)
    const { b: run, log } = batch(cols(5))
    pool.run(run)
    expect([a.jobs().length, b.jobs().length]).toEqual([2, 2])
    a.answer(a.jobs()[0]!.id)
    expect(a.jobs().length).toBe(3) // refilled
    for (const p of [a, b]) for (const j of p.jobs()) if (!log.some((l) => l.startsWith(`col ${j.cx},`))) p.answer(j.id)
    expect(log.filter((l) => l.startsWith('col'))).toHaveLength(5)
    expect(log.at(-1)).toBe('done')
    expect(pool.running).toBe(false)
  })

  it('fails the batch on a worker error and ignores later answers', () => {
    const a = new FakePort()
    const pool = new GenPool([a])
    pool.configure(undefined, [64, 64, 64], 3, TEST_BLOCKS)
    const { b: run, log } = batch(cols(3))
    pool.run(run)
    a.answer(a.jobs()[0]!.id, 1, 'Error: op "m" failed')
    a.answer(a.jobs()[1]!.id)
    expect(log).toEqual(['error column (0, 0): Error: op "m" failed'])
    expect(pool.running).toBe(false)
  })

  it('ignores answers from an older configuration after cancel', () => {
    const a = new FakePort()
    const pool = new GenPool([a])
    pool.configure(undefined, [64, 64, 64], 3, TEST_BLOCKS)
    const first = batch(cols(1))
    pool.run(first.b)
    const stale = a.jobs()[0]!.id
    pool.cancel()
    pool.configure({ v: 2 }, [64, 64, 64], 3, TEST_BLOCKS)
    const second = batch(cols(1))
    pool.run(second.b)
    a.answer(stale, 1)
    expect(first.log).toEqual([])
    expect(second.log).toEqual([])
    a.answer(a.jobs()[1]!.id, 2)
    expect(second.log).toEqual(['col 0,0 [0,0]', 'done'])
  })

  it('fails the batch when a worker is lost and carries on with the others', () => {
    const a = new FakePort(), b = new FakePort()
    const pool = new GenPool([a, b])
    pool.configure(undefined, [64, 64, 64], 3, TEST_BLOCKS)
    const first = batch(cols(4))
    pool.run(first.b)
    pool.lose(1)
    expect(first.log).toEqual(['error a generation worker stopped'])
    expect(pool.size).toBe(1)
    const second = batch(cols(1))
    pool.run(second.b)
    a.answer(a.jobs().at(-1)!.id)
    expect(second.log).toEqual(['col 0,0 [0,0]', 'done'])
    pool.lose(0)
    const third = batch(cols(1))
    pool.run(third.b)
    expect(third.log).toEqual(['error no generation workers are running'])
  })

  it('refuses a second batch while one runs, and finishes an empty batch at once', () => {
    const pool = new GenPool([new FakePort()])
    const empty = batch([])
    pool.run(empty.b)
    expect(empty.log).toEqual(['done'])
    pool.run(batch(cols(1)).b)
    expect(() => pool.run(batch(cols(1)).b)).toThrow('GenPool is busy')
  })
})
