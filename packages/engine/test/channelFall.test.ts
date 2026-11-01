import { describe, expect, it } from 'vitest'
import { channelFall, edgeFlow, springRate, SUB } from '../src/sim/runSimWorker.ts'
import { MAX_HEAD, SPRING_RATES, SPRING_SCALE } from '../src/sim/water/constants.ts'
import { defineGenerator } from '../src/sim/generator.ts'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, fillGenerator, run, spring, WATER_BLOCKS, type Fill } from './waterHelpers.ts'

/**
 * A generator planning a river needs the surface fall that carries a spring's flow (world-gen river diagnosis R1): steady
 * flux per lane ≈ GAIN·2^(FRICTION_SHIFT−FLUX_FP)·h − 1. Checked on a flat-bedded stone channel `lanes` wide along x: the
 * spring (flow index `flow`) at its head, the floor ending at x = END so the water falls into a void world and leaves.
 */
function flatChannel(lanes: number, flow: number): { fall: number; want: number } {
  const END = 90, FLOOR = 4, Z0 = 8
  const fill: Fill = (x, y, z) => {
    const inLane = z >= Z0 && z < Z0 + lanes
    if (x >= END || z < Z0 - 1 || z > Z0 + lanes) return AIR
    if (inLane && x >= 1) return y < FLOOR ? B.stone : x === 1 && z === Z0 && y === FLOOR ? spring(flow) : AIR
    return y <= FLOOR + 8 ? B.stone : AIR
  }
  const gen = defineGenerator({ ...fillGenerator(fill), configure: () => ({ void: true }) })
  const sim = new Simulation({ buffers: createWorldBuffers([96, 32, 32]), blocks: WATER_BLOCKS, seed: 1, log: () => {}, randomTicksPerChunk: 0 })
  sim.configure(gen, null)
  sim.generate(gen)
  run(sim, 6000)
  // The mean surface fall per column over the middle of the channel, averaged across its lanes and over 200 steps.
  const A = 30, Z = 70
  let sum = 0
  for (let t = 0; t < 200; t++) {
    run(sim, 1)
    for (let z = Z0; z < Z0 + lanes; z++) sum += sim.water.column(A, z).surface - sim.water.column(Z, z).surface
  }
  return { fall: sum / 200 / lanes / (Z - A), want: channelFall(springRate(flow) / lanes) }
}

describe('channelFall', () => {
  it('springRate is the spring table scaled to sub per step', () => {
    for (let f = 0; f < 16; f++) expect(springRate(f)).toBe(SPRING_RATES[f]! * SPRING_SCALE)
    expect(SUB).toBe(256)
  })

  it('edgeFlow inverts channelFall, with a dead band and the MAX_HEAD clamp', () => {
    for (const q of [0, 1, 7.5, 21, 64, 300]) expect(edgeFlow(channelFall(q))).toBeCloseTo(q, 9)
    expect(edgeFlow(channelFall(0) / 2)).toBe(0)
    expect(edgeFlow(MAX_HEAD * 3)).toBe(edgeFlow(MAX_HEAD))
  })

  it('matches the steady surface fall of flat channels 1, 3 and 5 lanes wide', () => {
    const bad: string[] = []
    for (const [lanes, flow] of [[1, 2], [3, 3], [5, 4]] as const) {
      const { fall, want } = flatChannel(lanes, flow)
      if (Math.abs(fall - want) > 0.08 * want + 0.3) bad.push(`${lanes} lanes, flow ${flow}: fall ${fall.toFixed(2)} vs ${want.toFixed(2)}`)
    }
    expect(bad).toEqual([])
  }, 60_000)
})
