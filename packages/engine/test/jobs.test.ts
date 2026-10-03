import { describe, expect, it } from 'vitest'
import { JobRunner, MAX_RESTARTS, type JobReader, type RegionJob } from '../src/sim/jobs.ts'
import { Layout } from '../src/world/layout.ts'

/** Reads `cells` voxels at (i, 0, 0), one per budget unit, then reports the sum it saw. */
class CountJob implements RegionJob {
  readonly kind = 'count'
  done = false
  i = 0
  sum = 0
  finished: number[] = []
  resets = 0
  private readonly cells: number
  constructor(cells: number) { this.cells = cells }
  step(r: JobReader, budget: number): number {
    let used = 0
    while (used < budget && this.i < this.cells) { this.sum += r.get(this.i, 0, 0); this.i++; used++ }
    if (this.i >= this.cells) this.done = true
    return used
  }
  finish(): void { this.finished.push(this.sum) }
  reset(): void { this.i = 0; this.sum = 0; this.resets++ }
  mixState(mix: (v: number) => void): void { mix(this.i) }
}

function setup() {
  const layout = new Layout([64, 32, 32])
  const epochs = new Uint32Array(layout.chunkCount)
  const world = new Map<number, number>()
  const read = (x: number, y: number, z: number) => world.get(layout.voxelIndex(x, y, z)) ?? 1
  return { layout, epochs, world, runner: new JobRunner(layout, epochs, read) }
}

describe('JobRunner', () => {
  it('splits a job across ticks under the budget and finishes it once', () => {
    const { runner } = setup()
    const job = new CountJob(10)
    runner.start(job)
    runner.run(4)
    expect([job.i, job.finished]).toEqual([4, []])
    runner.run(4)
    runner.run(4)
    expect(job.finished).toEqual([10])
    expect(runner.size).toBe(0)
  })
  it('runs jobs in start order and gives the rest of the budget to the next one', () => {
    const { runner } = setup()
    const a = new CountJob(3), b = new CountJob(5)
    runner.start(a); runner.start(b)
    runner.run(6)
    expect([a.finished, b.i]).toEqual([[3], 3])
  })
  it('restarts a job whose chunks were written, and runs it unbounded after MAX_RESTARTS', () => {
    const { runner, epochs } = setup()
    const job = new CountJob(40) // spans chunks 0 and 1 along x
    runner.start(job)
    for (let k = 0; k < MAX_RESTARTS; k++) {
      runner.run(5)
      epochs[0]!++
    }
    expect(job.resets).toBe(MAX_RESTARTS - 1)
    runner.run(5) // stale again → third restart → unbounded: finishes now
    expect(job.resets).toBe(MAX_RESTARTS)
    expect(job.finished).toEqual([40])
  })
  it('drains every job now, including jobs started by a finish', () => {
    const { runner } = setup()
    const later = new CountJob(2)
    const first = new CountJob(2)
    first.finish = () => { first.finished.push(first.sum); runner.start(later) }
    runner.start(first)
    runner.drain()
    expect([first.finished, later.finished, runner.size]).toEqual([[2], [2], 0])
  })
  it('cancels matching jobs', () => {
    const { runner } = setup()
    const a = new CountJob(3)
    runner.start(a)
    runner.cancel((j) => j.kind === 'count')
    runner.run(10)
    expect([a.finished, runner.size]).toEqual([[], 0])
  })
})
