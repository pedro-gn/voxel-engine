import { describe, expect, it } from 'vitest'
import { problems, worseOf, type PhaseResult } from '../e2e/livingStats.ts'

const base: PhaseResult = {
  phase: 'work-far', windowMs: 30_000, frames: 900, fpsMedian: 30, fpsP5: 20, fpsMin: 10, cpuMedian: 20, cpuP95: 30, gpuMs: 2,
  ticks: 600, tickP95: 8, tickMax: 20, applyP95: 15, applyMax: 25, maxDraws: 1500, maxShadowCasters: 700, maxDecorationInstances: 40_000,
  maxSearches: 2, maxFragments: 0, maxWaterColumns: 13_000, maxMeshQueue: 8, meanActiveUnits: 12, settled: true, unitStates: { walking: 10 },
}

describe('living benchmark statistics', () => {
  it('merges two runs worst-wise on every metric, not only the headline ones', () => {
    const b: PhaseResult = { ...base, fpsMedian: 28, fpsP5: 22, fpsMin: 8, cpuMedian: 21.7, cpuP95: 29, gpuMs: 2.5, tickP95: 9, tickMax: 18, applyP95: 14, applyMax: 30, maxDraws: 1600, maxMeshQueue: 3, maxFragments: 4, meanActiveUnits: 5, settled: false }
    expect(worseOf(base, b)).toMatchObject({
      fpsMedian: 28, fpsP5: 20, fpsMin: 8, cpuMedian: 21.7, cpuP95: 30, gpuMs: 2.5, tickP95: 9, tickMax: 20, applyP95: 15, applyMax: 30,
      maxDraws: 1600, maxMeshQueue: 8, maxFragments: 4, meanActiveUnits: 5, settled: false,
    })
  })
  it('flags a throttled window (an occluded browser draws a few frames per second)', () => {
    expect(problems({ ...base, phase: 'idle-default', windowMs: 10_000, frames: 9 })).toContain('throttled: 9 frames in 10000 ms')
    expect(problems(base)).toEqual([])
  })
  it('flags a collapse window without a fragment, and a load window with less than one unit working on average', () => {
    expect(problems({ ...base, phase: 'collapse', maxFragments: 0 })).toContain('no collapse fragment in the collapse window')
    expect(problems({ ...base, phase: 'dam', meanActiveUnits: 0.4 })).toContain('less than one unit working, walking or planning on average')
    expect(problems({ ...base, phase: 'idle-far', meanActiveUnits: 0 })).toEqual([])
  })
})
