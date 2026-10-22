// The flood scene's dam break on plain Node (Vitest's module transform makes the sim several times slower): sim tick
// p50/p95/max, the water step and the mirror + publish, and with `settle` the ticks until every tile sleeps and how flat
// the lake ends. Usage: node bench/damBreak.node.ts [ticks | settle]   (from apps/sandbox; default 3000 ticks)
// Water options from the environment: WATER_RETAIN and WATER_LOSS_EVERY (unset: the engine's defaults, retain 4, no loss).
import { Simulation, createWorldBuffers } from '@elovox/engine/testing'
import { BLOCKS } from '../src/blocks.ts'
import rules from '../src/rules.ts'
import { breachCommands, FLOOD_SIZE, floodGenerator, LAKE, stopSpringCommands } from '../src/scenes/flood.ts'

const settle = process.argv[2] === 'settle'
const ticks = settle ? 300_000 : Number(process.argv[2] ?? 3000)

const env = (k: string): number | undefined => (process.env[k] === undefined ? undefined : Number(process.env[k]))
const waterOptions = { ...(env('WATER_RETAIN') !== undefined && { retain: env('WATER_RETAIN')! }), ...(env('WATER_LOSS_EVERY') !== undefined && { lossEvery: env('WATER_LOSS_EVERY')! }) }
const sim = new Simulation({ buffers: createWorldBuffers([...FLOOD_SIZE]), blocks: BLOCKS, rules, seed: 1, randomTicksPerChunk: 0, log: (m) => console.log(m), water: waterOptions })
sim.configure(floodGenerator, {})
sim.generate(floodGenerator)
const v0 = sim.water.total()
;[...stopSpringCommands(sim.registry.id('stone')), ...breachCommands()].forEach((c, i) => sim.submit(0, i, c))

const water = sim.water
const phase = { step: 0, flush: 0 }
const step = water.step.bind(water), flush = water.flush.bind(water)
water.step = () => { const t0 = performance.now(); step(); phase.step = performance.now() - t0 }
water.flush = () => { const t0 = performance.now(); const r = flush(); phase.flush = performance.now() - t0; return r }

const tick: number[] = [], stepMs: number[] = [], flushMs: number[] = []
let off = 0, settledAt = -1
const wall = performance.now()
for (let t = 1; t <= ticks; t++) {
  phase.step = phase.flush = 0
  const t0 = performance.now()
  const r = sim.step()
  tick.push(performance.now() - t0); stepMs.push(phase.step); flushMs.push(phase.flush)
  if (water.total() !== v0) off++
  if (settle && t % 5000 === 0) console.log(`tick ${t}: ${r.physics.waterTiles} tiles awake, lake surface ${(water.column(60, 60).surface / 256).toFixed(3)}`)
  if (settle && !r.physics.busy) { settledAt = t; break }
}

const pct = (a: number[], p: number): number => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0
const most = (a: number[]): number => { let m = 0; for (const v of a) if (v > m) m = v; return m } // no spread: settle runs exceed the argument limit
const line = (a: number[]): string => `p50 ${pct(a, 0.5).toFixed(2)}  p95 ${pct(a, 0.95).toFixed(2)}  max ${most(a).toFixed(2)} ms`
console.log(`water options ${JSON.stringify(waterOptions)}; lost ${water.lost}`)
console.log(`dam break, ${tick.length} ticks in ${((performance.now() - wall) / 1000).toFixed(1)} s; Σ depth + sea off on ${off} ticks`)
console.log(`  sim tick        ${line(tick)}`)
console.log(`  water step      ${line(stepMs)}`)
console.log(`  mirror+publish  ${line(flushMs)}`)
if (settle) {
  let lo = Infinity, hi = -Infinity
  for (let x = LAKE.x0; x <= LAKE.x1; x++) for (let z = LAKE.z0; z <= LAKE.z1; z++) {
    const c = water.column(x, z)
    if (c.depth > 0) { lo = Math.min(lo, c.surface); hi = Math.max(hi, c.surface) }
  }
  console.log(`  settled at tick ${settledAt}; lake surfaces ${lo}..${hi} (spread ${hi - lo} / 256 block)`)
}
