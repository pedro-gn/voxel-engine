// Node scale benchmark of navigation (5b): 1,000 units on the 1024² crowd world, per phase, no rendering.
// Run: node --experimental-strip-types apps/sandbox/bench/crowd.node.ts [--units=1000]
// Flags: --phase=name (setup + one phase), --ticks=N (per phase, default 1200), --opcost (ns per navigation operation),
// --assert (exit 1 when a phase misses a spec §7 criterion; arrival within each unit's ideal walk + grace),
// --quality [--pairs=500 --seed=5] (route cost and reachability against an exact flat A* on seeded surface pairs),
// --buildcost [--radius=8] (ns per region-build step by phase, to calibrate BUILD_WEIGHT).
// Every phase respawns its units on known pads, so a phase measures the same thing alone or after the others.
import type { Command } from '@elovox/engine'
import { NavigationSystem } from '@elovox/engine/src/sim/navigation/navigation.ts'
import { RouteSearch } from '@elovox/engine/src/sim/navigation/routeSearch.ts'
import { Pcg32 } from '@elovox/engine/src/sim/rng.ts'
import { BUILD_WEIGHT, RegionBuild } from '@elovox/engine/src/sim/navigation/regions.ts'
import { Simulation, type TickResult } from '@elovox/engine/src/sim/simulation.ts'
import { WORKER_STATES } from '@elovox/engine/src/sim/workers/types.ts'
import { HIER_MIN } from '@elovox/engine/src/sim/workers/workers.ts'
import { createWorldBuffers } from '@elovox/engine/src/world/buffers.ts'
import { terrainGenerator } from '@elovox/terrain'
import { readFileSync } from 'node:fs'
import { BLOCKS } from '../src/blocks.ts'
import rules, { randomTickRate } from '../src/rules.ts'
import {
  CROWD_SIZE, CROWD_WORKER_OPTIONS, PADS, bottleneckCommands, massMove, padClearCommands, scatterMoves, spawnCrowd, workOrders, type PadName,
} from '../src/scenes/crowd.ts'

const flag = (name: string) => process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))?.split('=')[1] ?? (process.argv.includes(`--${name}`) ? '' : undefined)
const UNITS = Number(flag('units') ?? 1000), TICKS = Number(flag('ticks') ?? 1200), ONLY = flag('phase')
const doc = JSON.parse(readFileSync(new URL('../src/terrain/crowd.terrain.json', import.meta.url), 'utf8'))
const sim = new Simulation({ buffers: createWorldBuffers([...CROWD_SIZE]), blocks: BLOCKS, rules, seed: 1234, randomTicksPerChunk: randomTickRate(CROWD_SIZE[0], CROWD_SIZE[2]), workers: CROWD_WORKER_OPTIONS, log: () => {} })
const t0 = performance.now()
sim.configure(terrainGenerator, doc); sim.generate(terrainGenerator)
const generateMs = Math.round(performance.now() - t0)
console.error(`generate ${generateMs} ms, rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MiB`)
const w = sim.workers!, r = sim.registry
const stone = r.id('stone'), planks = r.id('planks')
let seq = 0, last: TickResult
const submit = (cmds: Command[]) => { for (const c of cmds) sim.submit(0, ++seq, c) }
/** One untimed tick; returns how many commands failed, and throws on a failure unless `tolerant`. */
const check = (label: string, tolerant = false) => {
  last = sim.step()
  const failed = last.acks.filter(a => !a.ok)
  if (failed.length && !tolerant) throw new Error(`${label}: ${failed[0]!.error}`)
  return failed.length
}
submit(padClearCommands()); check('clear pads')

/** The workers' share: both hooks, timed in the bench only. */
let workersMs = 0
for (const k of ['beforePhysics', 'afterPhysics'] as const) {
  const f = w[k].bind(w)
  w[k] = () => { const a = performance.now(); f(); workersMs += performance.now() - a }
}

if (flag('opcost') !== undefined) {
  // Where a navigation operation's time goes. Every search is sliced like the workers slice it (nav.step(4096)).
  //  long: west pad centre to east pad centre on a fresh system, then again on the same system (warm edge cache),
  //        with the default 512-tile cache and with a 65,536-tile one; then at the workers' node limit (16,384).
  //  short: 200 searches of 10–30 blocks inside the west pad, timed on a second pass over a warm system.
  // Each row also gives operations per discovered node and per expanded node (4 neighbour probes per expansion),
  // counted on an untimed replay: the searches are deterministic, so the replay does the same work.
  const L = sim.layout, at = (p: typeof PADS.west, dx = 0, dz = 0) => L.voxelIndex(p.min[0] + 32 + dx, p.y, p.min[2] + 32 + dz)
  const from = at(PADS.west), to = at(PADS.east)
  const run = (nav: NavigationSystem, pairs: [number, number][]) => {
    let visited = 0, ms = 0, nodes = 0, found = 0
    for (const [a, b] of pairs) {
      const s = nav.request(a, [b])
      while (s.status === 'pending') { const t = performance.now(); nav.step(4096); ms += performance.now() - t; visited += nav.visited }
      nodes += (s as unknown as { count: number }).count; if (s.status === 'found') found++
    }
    return { visited, ms, nodes, found }
  }
  const probes = (nav: NavigationSystem) => { let n = 0; const f = nav.neighbor.bind(nav); nav.neighbor = (p, d, seen) => { n++; return f(p, d, seen) }; return () => n }
  const row = (label: string, r: ReturnType<typeof run>, expansions: number, extra: object = {}) => ({
    label, ...extra, searches: undefined as number | undefined, found: r.found, visited: r.visited, ms: +r.ms.toFixed(1), nsPerOp: +(r.ms * 1e6 / r.visited).toFixed(1),
    nodes: r.nodes, opsPerNode: +(r.visited / r.nodes).toFixed(2), expansions, opsPerExpansion: +(r.visited / expansions).toFixed(2),
  })
  const rows = []
  const replay = (maxNodes: number, cache: number, pairs: [number, number][]) => { const nav = new NavigationSystem(w.nav.port, maxNodes, cache), n = probes(nav); run(nav, pairs); return n() / 4 }
  run(new NavigationSystem(w.nav.port, 1 << 20), [[from, to]]) // JIT warm-up
  for (const cache of [512, 1 << 16]) {
    const nav = new NavigationSystem(w.nav.port, 1 << 20, cache), e = replay(1 << 20, cache, [[from, to]])
    rows.push(row('long, cold edge cache', run(nav, [[from, to]]), e, { cacheTiles: cache }))
    rows.push(row('long, same system again', run(nav, [[from, to]]), e, { cacheTiles: cache, tilesHeld: nav.cacheTiles }))
  }
  rows.push(row('long, workers node limit', run(new NavigationSystem(w.nav.port, 16384), [[from, to]]), replay(16384, 512, [[from, to]])))
  const rng = new Pcg32(5), pairs: [number, number][] = []
  while (pairs.length < 200) {
    const sx = rng.nextInt(64) - 32, sz = rng.nextInt(64) - 32, gx = rng.nextInt(64) - 32, gz = rng.nextInt(64) - 32, d = Math.hypot(gx - sx, gz - sz)
    if (d >= 10 && d <= 30) pairs.push([at(PADS.west, sx, sz), at(PADS.west, gx, gz)])
  }
  const short = new NavigationSystem(w.nav.port); run(short, pairs)
  rows.push({ ...row('short 10-30 blocks, warm', run(short, pairs), replay(16384, 512, pairs)), searches: pairs.length })
  console.log(JSON.stringify({ node: process.version, opcost: rows }, null, 2))
  process.exit(0)
}

if (flag('buildcost') !== undefined) {
  // ns per region-build step, by phase, to calibrate BUILD_WEIGHT against --opcost: builds every tile of a square of
  // tiles around the west pad (the pad's tile layer and the ones above and below), twice (the first warms the JIT).
  // A slice of 64 charged operations is timed under the phase it starts in, so phase splits are approximate.
  const L = sim.layout, radius = Number(flag('radius') ?? 8), cx = (PADS.west.min[0] + 32) >> 4, cz = (PADS.west.min[2] + 32) >> 4, cy = PADS.west.y >> 4
  const tx = L.size[0] >> 4, tz = L.size[2] >> 4, ty = L.size[1] >> 4, runs = []
  for (let run = 0; run < 2; run++) {
    const nav = new NavigationSystem({ layout: L, registry: w.nav.port.registry, get: w.nav.port.get })
    const steps: Record<string, number> = {}, ms: Record<string, number> = {}
    let charged = 0, regions = 0, empty = 0, exits = 0
    for (let y = Math.max(0, cy - 1); y <= Math.min(ty - 1, cy + 1); y++) for (let z = cz - radius; z <= cz + radius; z++) for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < 0 || z < 0 || x >= tx || z >= tz) continue
      const b = new RegionBuild(nav, x + z * tx + y * tx * tz)
      while (!b.done) { const phase = b.stage, a = performance.now(); charged += b.step(64); ms[phase] = (ms[phase] ?? 0) + performance.now() - a }
      for (const [phase, n] of Object.entries(b.counts)) steps[phase] = (steps[phase] ?? 0) + n
      const r = b.result(); regions++; if (!r.poses.length) empty++; exits += r.exits.length
    }
    const totalMs = Object.values(ms).reduce((s, n) => s + n, 0), totalSteps = Object.values(steps).reduce((s, n) => s + n, 0)
    runs.push({ regions, empty, meanExits: +(exits / regions).toFixed(1), buildWeight: BUILD_WEIGHT, charged, steps, ms: Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, +v.toFixed(1)])),
      nsPerStep: Object.fromEntries(Object.keys(steps).map(k => [k, +((ms[k] ?? 0) * 1e6 / steps[k]!).toFixed(1)])), nsPerStepAll: +(totalMs * 1e6 / totalSteps).toFixed(1), nsPerChargedOp: +(totalMs * 1e6 / charged).toFixed(1) })
  }
  console.log(JSON.stringify({ node: process.version, buildcost: runs }, null, 2))
  process.exit(0)
}

const q = (a: number[], p: number) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]! }
const r3 = (n: number | null) => n === null ? null : +n.toFixed(3)

if (flag('quality') !== undefined) {
  // Path quality (Task H7): 500 seeded pairs of surface poses, an exact flat A* (node limit 2^22) against a route search,
  // both on geometry alone (no water or hazard policy, which routes leave to refinement). Regions stay cached across pairs.
  const L = sim.layout, port = { layout: L, registry: w.nav.port.registry, get: w.nav.port.get }, nav = new NavigationSystem(port, 1 << 22)
  const rng = new Pcg32(Number(flag('seed') ?? 5)), pairs = Number(flag('pairs') ?? 500)
  const surface = () => { for (;;) { const x = rng.nextInt(CROWD_SIZE[0]), z = rng.nextInt(CROWD_SIZE[2]); for (let y = CROWD_SIZE[1] - 2; y > 0; y--) if (nav.stand(x, y, z)) return L.voxelIndex(x, y, z) } }
  const ratios: number[] = [], shortRatios: number[] = [], flatOps: number[] = [], routeOps: number[] = [], flatMs: number[] = [], routeMs: number[] = [], disagree: unknown[] = []
  let agree = 0, unreachable = 0
  for (let i = 0; i < pairs; i++) {
    const start = surface(), goal = surface()
    const flat = nav.request(start, [goal])
    let ops = 0, a = performance.now()
    while (flat.status === 'pending') { nav.step(1 << 16); ops += nav.visited }
    flatMs.push(performance.now() - a); flatOps.push(ops)
    const route = new RouteSearch(nav, nav.regions, start, [goal])
    a = performance.now()
    while (route.status === 'pending') route.step(32768)
    routeMs.push(performance.now() - a); routeOps.push(route.spent)
    if (route.status === flat.status) agree++
    else if (disagree.length < 10) disagree.push({ i, start: L.voxelCoords(start), goal: L.voxelCoords(goal), flat: flat.status, route: route.status })
    if (flat.status === 'unreachable') unreachable++
    // The gate is over pairs units would route (estimate past HIER_MIN); shorter walks stay flat in the workers.
    const [x, y, z] = L.voxelCoords(start), [gx, gy, gz] = L.voxelCoords(goal), routed = (Math.abs(x - gx) + Math.abs(z - gz)) * 4 + Math.max(0, gy - y) * 2 > HIER_MIN
    if (flat.status === 'found' && route.status === 'found' && flat.cost) (routed ? ratios : shortRatios).push(route.cost / flat.cost)
    if (i % 50 === 49) console.error(`quality ${i + 1}/${pairs}`)
  }
  const stats = (a: number[]) => ({ mean: r3(a.reduce((s, n) => s + n, 0) / a.length), p50: r3(q(a, .5)), p95: r3(q(a, .95)), max: r3(Math.max(...a)) })
  console.log(JSON.stringify({ node: process.version, pairs, agree, unreachable, disagree, routedFound: ratios.length, costRatio: stats(ratios), gate: { meanMax: 1.10, p95Max: 1.25, pass: (stats(ratios).mean ?? 9) <= 1.10 && (stats(ratios).p95 ?? 9) <= 1.25 && agree === pairs }, shortFound: shortRatios.length, shortCostRatio: shortRatios.length ? stats(shortRatios) : null, flatOps: stats(flatOps), routeOps: stats(routeOps), flatMs: stats(flatMs), routeMs: stats(routeMs), regions: nav.regions.size, regionBytes: nav.regions.bytes }, null, 2))
  process.exit(0)
}
const WALKING = WORKER_STATES.indexOf('walking')
/** The hierarchy's region store, read defensively: absent before it exists (the baseline), so cold or warm shows. */
const regions = () => { const s = (w.nav as unknown as { regions?: { size?: number; bytes?: number } }).regions; return { count: s?.size ?? 0, bytes: s?.bytes ?? 0 } }

/** Despawns everyone and cancels every open order, then spawns `UNITS` on `pads`; returns the new ids. */
function respawn(pads: PadName[], before: Command[] = [], stock: { block: number; count: number }[] = []): { ids: number[]; spawnFailed: number } {
  const open = (last.workers?.orders ?? []).filter(o => !o.cancelled && o.done < o.total)
  submit([...open.map(o => ({ type: 'workCancel', order: o.id }) as Command), ...(w.units.size ? [{ type: 'unitDespawn', ids: [...w.units.keys()] } as Command] : []), ...before])
  check('reset')
  submit(spawnCrowd(UNITS, pads, stock)); const spawnFailed = check('spawn', true)
  return { ids: [...w.units.keys()], spawnFailed }
}

type Phase = { spawn: PadName[]; before?: () => Command[]; stock?: boolean; orders: (ids: number[]) => Command[]; each?: (i: number) => void }
let churnEdits = 0
/** Every 20 ticks a 1 × 3 × 3 stone wall on the next path node of the lowest-id walking unit whose wall overlaps no unit. */
function churn(i: number) {
  if (i % 20 !== 10) return
  for (const u of w.units.values()) {
    const p = u.path[u.cursor]
    if (u.state !== 'walking' || p === undefined) continue
    const [x, y, z] = sim.layout.voxelCoords(p)
    if (z < 1 || z + 1 >= CROWD_SIZE[2] || y + 2 >= CROWD_SIZE[1] || w.overlapsRegion([x, y, z - 1], [x, y + 2, z + 1])) continue
    submit([{ type: 'fillRegion', min: [x, y, z - 1], max: [x, y + 2, z + 1], voxel: stone }]); churnEdits++; return
  }
}
const PHASES: Record<string, Phase> = {
  mass: { spawn: ['west', 'north'], orders: ids => [massMove(ids, 'east')] },
  scatter: { spawn: ['west', 'north'], orders: ids => scatterMoves(ids, 7) },
  bottleneck: { spawn: ['west', 'east'], before: () => bottleneckCommands(stone), orders: ids => [massMove(ids.slice(0, ids.length >> 1), 'east'), massMove(ids.slice(ids.length >> 1), 'west')] },
  work: { spawn: ['west', 'east', 'north', 'south', 'centre'], stock: true, orders: () => workOrders(stone, planks) },
  churn: { spawn: ['west', 'north'], orders: ids => scatterMoves(ids, 11), each: churn },
}
if (ONLY !== undefined && !PHASES[ONLY]) throw new Error(`unknown phase ${ONLY}; one of ${Object.keys(PHASES).join(', ')}`)

/** Runs `n` timed ticks and returns the phase metrics; `moved` are the ids given move orders at `from`. */
function measure(n: number, moved: number[], each?: (i: number) => void) {
  const from = sim.tick, ms: number[] = [], share: number[] = [], ordered = new Set(moved)
  const first = new Map<number, number>(), arrived = new Map<number, number>(), blockedAs = new Map<number, string>(), blocks: Record<string, number> = {}
  const orderIds = new Set<number>()
  let visitedMax = 0, navBytesMax = 0, failedCommands = 0, ordersDoneAt: number | null = null
  for (let i = 0; i < n; i++) {
    each?.(i)
    workersMs = 0
    const a = performance.now(); last = sim.step(); ms.push(performance.now() - a); share.push(workersMs)
    const t = last.tick - from
    failedCommands += last.acks.filter(x => !x.ok).length
    for (const e of last.events) {
      const id = (e.payload as { id?: number } | undefined)?.id
      if (e.type === 'unitArrived' && id !== undefined && ordered.has(id) && !arrived.has(id)) arrived.set(id, t)
      if (e.type === 'workOrdered' && id !== undefined) orderIds.add(id)
    }
    const wt = last.workers!, poses = wt.poses
    for (let k = 0; k < poses.length; k += 9) if (poses[k + 5] === WALKING && !first.has(poses[k]!)) first.set(poses[k]!, t)
    for (const d of wt.details) {
      const key = d.state === 'blocked' ? d.reason ?? 'none' : ''
      if (key && blockedAs.get(d.id) !== key) blocks[key] = (blocks[key] ?? 0) + 1
      blockedAs.set(d.id, key)
    }
    visitedMax = Math.max(visitedMax, wt.stats.visited); navBytesMax = Math.max(navBytesMax, wt.stats.navBytes)
    const mine = wt.orders.filter(o => orderIds.has(o.id))
    if (ordersDoneAt === null && mine.length && mine.every(o => o.cancelled || o.done === o.total)) ordersDoneAt = t
  }
  // Over every ordered unit: a unit that never walked counts as Infinity, so a percentile landing on it reports null.
  const latency = moved.map(id => first.get(id) ?? Infinity), started = latency.filter(Number.isFinite).length
  const arrival = moved.map(id => arrived.get(id) ?? Infinity)
  const finite = (n: number | null) => n === null || !Number.isFinite(n) ? null : n
  const work = last.workers!.orders.filter(o => orderIds.has(o.id))
  return {
    tickMs: { p50: r3(q(ms, .5)), p95: r3(q(ms, .95)), p99: r3(q(ms, .99)), max: r3(Math.max(...ms)) },
    workersMs: { p50: r3(q(share, .5)), p95: r3(q(share, .95)), p99: r3(q(share, .99)), max: r3(Math.max(...share)) },
    ...(moved.length > 0 && {
      firstActionTicks: { p50: finite(q(latency, .5)), p95: finite(q(latency, .95)), started, ordered: moved.length },
      arrived: { pct: +(100 * arrived.size / moved.length).toFixed(1), p50Ticks: finite(q(arrival, .5)), p95Ticks: finite(q(arrival, .95)), allAfterTicks: arrived.size === moved.length ? Math.max(...arrived.values()) : null },
    }),
    ...(work.length > 0 && { work: { orders: work.length, done: work.reduce((s, o) => s + o.done, 0), total: work.reduce((s, o) => s + o.total, 0), allDoneAfterTicks: ordersDoneAt } }),
    trafficBlocks: blocks.traffic ?? 0, blocks, visitedMax, navBytesMax, failedCommands,
  }
}

const results: Record<string, unknown> = {}
const setup = respawn(['west', 'north'])
results.setup = { spawnFailed: setup.spawnFailed, ...measure(120, []) }
for (const [name, phase] of Object.entries(PHASES)) {
  if (ONLY !== undefined && name !== ONLY) continue
  const { ids, spawnFailed } = respawn(phase.spawn, phase.before?.() ?? [], phase.stock ? [{ block: planks, count: 64 }, { block: stone, count: 64 }] : [])
  const atOrder = regions(), orders = phase.orders(ids); submit(orders)
  const moved = orders.flatMap(c => c.type === 'unitMove' ? (c as unknown as { ids: number[] }).ids : [])
  churnEdits = 0
  const m = measure(TICKS, moved, phase.each)
  const atEnd = regions()
  results[name] = { units: ids.length, spawnFailed, regionsAtOrder: atOrder.count, regionBytesAtOrder: atOrder.bytes, regionsAtEnd: atEnd.count, regionBytesAtEnd: atEnd.bytes, ...m, ...(phase.each && { churnEdits }) }
  console.error(`${name} done`)
}
console.log(JSON.stringify({ node: process.version, units: UNITS, ticks: TICKS, generateMs, searchCap: CROWD_WORKER_OPTIONS.searchCap, results }, null, 2))
if (flag('assert') !== undefined) {
  // Spec §7 success criteria, per phase: the workers' share and the whole tick, the first action and arrival.
  type M = {
    tickMs: { p95: number | null }; workersMs: { p95: number | null; max: number | null }; firstActionTicks?: { p95: number | null }
    arrived?: { withinIdealPlusGrace?: { pct: number } }; falseUnreachable?: { count: number }
  }
  const firstLimit = UNITS <= 100 ? 5 : 20, failures: string[] = []
  const over = (name: string, what: string, value: number | null | undefined, limit: number) => { if (value === null || value === undefined || value > limit) failures.push(`${name}: ${what} ${value ?? 'none'} > ${limit}`) }
  for (const [name, r] of Object.entries(results)) {
    if (name === 'setup') continue
    const m = r as M
    over(name, 'workers p95 ms', m.workersMs.p95, 4); over(name, 'workers max ms', m.workersMs.max, 12); over(name, 'tick p95 ms', m.tickMs.p95, 15)
    if (m.firstActionTicks) over(name, 'first action p95 ticks', m.firstActionTicks.p95, firstLimit)
    // Arrival: within each unit's ideal walk plus the grace (60 s), as the bench measures it; all of them at the bottleneck.
    if (m.arrived) {
      const need = name === 'bottleneck' ? 100 : 99, pct = m.arrived.withinIdealPlusGrace?.pct
      if (pct === undefined || pct < need) failures.push(`${name}: arrived within ideal + grace ${pct ?? 'not measured'}% < ${need}%`)
    }
    if (m.falseUnreachable && m.falseUnreachable.count > 0) failures.push(`${name}: ${m.falseUnreachable.count} false unreachable`)
  }
  for (const f of failures) console.error(`FAIL ${f}`)
  if (failures.length) process.exit(1)
  console.error('all criteria met')
}
