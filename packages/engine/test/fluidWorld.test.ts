import { describe, expect, it } from 'vitest'
import type { Command, FillRegionCommand, SetBlockCommand } from '../src/sim/commands.ts'
import { volumeOf } from '../src/sim/fluids/cell.ts'
import { Pcg32 } from '../src/sim/rng.ts'
import type { Simulation } from '../src/sim/simulation.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, fluidSim, lake, poolProblems, volume, w, type Fill } from './fluidHelpers.ts'

/** Random ground 1–6 high, with water up to y = 5 above it. */
function terrain(seed: number): Fill {
  const rng = new Pcg32(seed)
  const h = Array.from({ length: 32 * 32 }, () => 1 + rng.nextInt(6))
  return (x, y, z) => {
    const top = h[x + z * 32]!
    if (y < top) return B.stone
    return y <= 5 ? w(7) : AIR
  }
}

function command(rng: Pcg32): Command | null {
  const k = rng.nextInt(5)
  const x = rng.nextInt(32), y = 1 + rng.nextInt(9), z = rng.nextInt(32)
  switch (k) {
    case 0: return { type: 'setBlock', pos: [x, y, z], voxel: AIR }
    case 1: return { type: 'setBlock', pos: [x, y, z], voxel: B.stone }
    case 2: return { type: 'setBlock', pos: [x, y, z], voxel: w(rng.nextInt(8)) }
    case 3: return { type: 'fillRegion', min: [x, y, z], max: [Math.min(31, x + 2), y, Math.min(31, z + 2)], voxel: AIR }
    default: return null
  }
}

/** Units a command creates (> 0) or deletes (< 0), read before it applies. A solid displaces water: 0. */
function commandDelta(sim: Simulation, cmd: Command): number {
  const cells: (readonly [number, number, number])[] = []
  let voxel: number
  if (cmd.type === 'setBlock') {
    const c = cmd as SetBlockCommand
    cells.push(c.pos)
    voxel = c.voxel
  } else {
    const c = cmd as FillRegionCommand
    for (let y = c.min[1]; y <= c.max[1]; y++) for (let z = c.min[2]; z <= c.max[2]; z++) for (let x = c.min[0]; x <= c.max[0]; x++) cells.push([x, y, z])
    voxel = c.voxel
  }
  let d = 0
  for (const [x, y, z] of cells) {
    const old = sim.store.getVoxel(x, y, z)
    if (old === voxel) continue
    const before = volumeOf(sim.registry, old)
    if (voxel === AIR) d -= before
    else if (volumeOf(sim.registry, voxel) > 0) d += volumeOf(sim.registry, voxel) - before
  }
  return d
}

function script(sim: Simulation, seed: number, ticks: number, check?: (t: number) => void): void {
  const rng = new Pcg32(seed * 7919)
  for (let t = 0; t < ticks; t++) {
    const cmd = t % 3 === 0 ? command(rng) : null
    if (cmd) sim.submit(1, t, cmd)
    sim.step()
    check?.(t)
  }
}

describe('fluid world', () => {
  it.each([1, 2, 3])('conserves volume through random digging, filling and pouring (seed %i)', (seed) => {
    const sim = fluidSim(terrain(seed), { seed })
    const rng = new Pcg32(seed * 7919)
    let expected = volume(sim)
    for (let t = 0; t < 300; t++) {
      const cmd = t % 3 === 0 ? command(rng) : null
      if (cmd) { expected += commandDelta(sim, cmd); sim.submit(1, t, cmd) }
      sim.step()
      expect(volume(sim)).toBe(expected)
      if (t % 50 === 49) expect(poolProblems(sim)).toEqual([])
    }
  }, 120_000)

  it('is deterministic and replays from the command log', () => {
    const a = fluidSim(terrain(5), { seed: 5 }), b = fluidSim(terrain(5), { seed: 5 })
    script(a, 5, 200)
    script(b, 5, 200)
    expect(a.hash()).toBe(b.hash())
    const c = fluidSim(terrain(5), { seed: 5 })
    let i = 0
    for (let t = 0; t < 200; t++) {
      while (i < a.commandLog.length && a.commandLog[i]!.tick === t) { const e = a.commandLog[i++]!; c.submit(e.clientId, e.seq, e.cmd) }
      c.step()
    }
    expect(c.hash()).toBe(a.hash())
  }, 60_000)

  it('rebuilds cleanly after a regeneration while paused (review focus 4)', () => {
    const sim = fluidSim(terrain(9), { seed: 9 })
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 9, 5], voxel: w(7) })
    sim.step()
    sim.setPaused(true)
    const data = new Uint16Array(32 * 32 * 32)
    for (let y = 0; y < 32; y++) for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
      data[lx + (lz << 5) + (y << 10)] = y === 0 ? B.stone : y <= 3 ? w(7) : AIR
    }
    sim.replaceColumns([{ cx: 0, cz: 0, data }])
    sim.step(); sim.step()
    expect(sim.fluids.needsRebuild).toBe(true) // paused: the rebuild waits
    sim.setPaused(false)
    sim.step()
    expect(sim.fluids.needsRebuild).toBe(false)
    const ps = sim.fluids.pools.all()
    expect(ps).toHaveLength(1)
    expect(ps[0]).toMatchObject({ id: 1, surfaceY: 3, area: 1024 })
    expect(volume(sim)).toBe(3 * 1024 * 8)
    expect(poolProblems(sim)).toEqual([])
  })

  it('debug checks catch a corrupted pool and rebuild it', () => {
    const logs: string[] = []
    const sim = fluidSim(lake(4), { fluids: { debug: true }, log: (m) => logs.push(m) })
    sim.fluids.pools.all()[0]!.grid += 8
    sim.step()
    expect(logs.some((m) => /invariant check failed/.test(m))).toBe(true)
    sim.step()
    expect(poolProblems(sim)).toEqual([])
  })
})
