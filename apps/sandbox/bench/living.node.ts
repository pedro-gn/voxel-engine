// Node bench of the living scene's simulation: tick p50/p95/max per phase, no rendering.
// Run: node --experimental-strip-types apps/sandbox/bench/living.node.ts
// Profile: node --experimental-strip-types --cpu-prof --cpu-prof-dir=test-results apps/sandbox/bench/living.node.ts
import { Simulation, createWorldBuffers } from '@elovox/engine/testing'
import { packVoxel } from '@elovox/engine/sim-worker'
import { terrainGenerator } from '@elovox/terrain'
import { readFileSync } from 'node:fs'
import { BLOCKS } from '../src/blocks.ts'
import rules, { randomTickRate } from '../src/rules.ts'
import {
  LIVING_SIZE, LIVING_WORKER_OPTIONS, SITES, breachCommands, clearCommands, collapseCommands, moveGroupCommands,
  quarryCycle, reservoirCommands, spawnCommands, towerCommands, workCommands, workSiteCommands, type Ids,
} from '../src/scenes/living.ts'

const doc = JSON.parse(readFileSync(new URL('../src/terrain/living.terrain.json', import.meta.url), 'utf8'))
const sim = new Simulation({ buffers: createWorldBuffers([...LIVING_SIZE]), blocks: BLOCKS, rules, seed: 1234, randomTicksPerChunk: randomTickRate(LIVING_SIZE[0], LIVING_SIZE[2]), workers: LIVING_WORKER_OPTIONS, log: () => {} })
const t0 = performance.now()
sim.configure(terrainGenerator, doc); sim.generate(terrainGenerator)
console.log(`generate ${(performance.now() - t0).toFixed(0)} ms`)
const r = sim.registry
const ids: Ids = { water: packVoxel(r.id('water'), 7), stone: r.id('stone'), planks: r.id('planks'), beam: r.id('structural_planks'), glass: r.id('structural_glass'), dirt: r.id('dirt') }
let seq = 0
const submit = (cmds: ReturnType<typeof clearCommands>) => { for (const c of cmds) sim.submit(0, ++seq, c) }
const check = (label: string) => { for (const a of sim.step().acks) if (!a.ok) throw new Error(`${label}: ${a.error}`) }
submit([...Object.values(SITES).flatMap(clearCommands), ...reservoirCommands(SITES.reservoir, ids), ...towerCommands(SITES.tower, ids), ...workSiteCommands(SITES.work, ids)])
check('set pieces'); submit(spawnCommands(SITES.work, ids)); check('spawn')
let settle = 0
while (settle < 3000 && sim.step().physics.busy) settle++
console.log(`settled after ${settle} ticks`)

/** [phase, event, ticks] at 20 Hz: the browser script's windows. */
const SCRIPT: [string, (() => void) | null, number][] = [
  ['idle', null, 400], ['work', () => submit([...workCommands(SITES.work, ids), ...moveGroupCommands(SITES.rest)]), 1200],
  ['dam', () => submit(breachCommands(SITES.reservoir)), 900], ['collapse', () => submit(collapseCommands(SITES.tower)), 400],
]
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]! }
const results: Record<string, { p50: number; p95: number; max: number }> = {}
for (const [phase, event, n] of SCRIPT) {
  event?.()
  const ms: number[] = []
  for (let i = 0; i < n; i++) {
    if (i % 20 === 0) submit(quarryCycle(sim.workers!.publication().orders, SITES.work, ids))
    const a = performance.now(); sim.step(); ms.push(performance.now() - a)
  }
  results[phase] = { p50: +q(ms, .5).toFixed(3), p95: +q(ms, .95).toFixed(3), max: +Math.max(...ms).toFixed(3) }
}
console.log(JSON.stringify({ node: process.version, results }, null, 2))
