// Research prototype. No production navigation or unit behavior is installed by this file.
// Run: node packages/engine/bench/navigation.node.mjs
import assert from 'node:assert/strict'
import { cpus } from 'node:os'
import { BlockRegistry } from '../src/blocks/registry.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ChunkStore } from '../src/world/chunkStore.ts'
import { Layout } from '../src/world/layout.ts'

const WARMUP = 5, RUNS = 21, HEIGHT = 64
const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const registry = new BlockRegistry([{ name: 'stone' }])
const summarize = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return { p50: +sorted[Math.floor(sorted.length / 2)].toFixed(3), p95: +sorted[Math.ceil(sorted.length * .95) - 1].toFixed(3), max: +sorted.at(-1).toFixed(3) }
}

function makeWorld(side, sample) {
  const store = new ChunkStore({ buffers: createWorldBuffers([side, HEIGHT, side]), opaque: registry.opaque })
  const scratch = new Uint16Array(32768)
  for (let cy = 0; cy < store.layout.cy; cy++) for (let cz = 0; cz < store.layout.cz; cz++) for (let cx = 0; cx < store.layout.cx; cx++) {
    for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
      scratch[Layout.localIndex(x, y, z)] = sample(cx * 32 + x, cy * 32 + y, cz * 32 + z)
    }
    store.writeChunkDense(store.layout.chunkIndex(cx, cy, cz), scratch)
  }
  store.commit()
  return store
}

function makeGraph(store) {
  const started = performance.now()
  const side = store.layout.size[0], plane = side * side
  const encode = (x, y, z) => x + z * side + y * plane
  const clear = (x, y, z) => y >= 0 && y < HEIGHT && store.getVoxel(x, y, z) === 0
  const stand = (x, y, z) => x >= 0 && z >= 0 && x < side && z < side &&
    clear(x, y, z) && clear(x, y + 1, z) && (y === 0 || store.getVoxel(x, y - 1, z) === 1)
  const offsets = new Uint32Array(plane + 1), list = []
  for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
    offsets[x + z * side] = list.length
    for (let y = 0; y < HEIGHT - 1; y++) if (stand(x, y, z)) list.push(encode(x, y, z))
  }
  offsets[plane] = list.length
  const positions = Uint32Array.from(list)
  const at = (x, y, z) => {
    if (x < 0 || z < 0 || x >= side || z >= side || y < 0 || y >= HEIGHT - 1) return -1
    const col = x + z * side, p = encode(x, y, z)
    let lo = offsets[col], hi = offsets[col + 1]
    while (lo < hi) { const m = (lo + hi) >>> 1; if (positions[m] < p) lo = m + 1; else hi = m }
    return lo < offsets[col + 1] && positions[lo] === p ? lo : -1
  }
  // Four cardinal transitions, one-block ascent, two-block descent, two-cell body.
  // A descent must clear the entire destination column between old and new feet.
  function neighbor(id, direction) {
    const p = positions[id], y = Math.floor(p / plane), x = p % side, z = Math.floor((p % plane) / side)
    const [dx, dz] = DIRECTIONS[direction], nx = x + dx, nz = z + dz
    if (nx < 0 || nz < 0 || nx >= side || nz >= side) return [-1, 0]
    if (stand(nx, y, nz)) return [at(nx, y, nz), 4]
    if (stand(nx, y + 1, nz) && clear(x, y + 2, z)) return [at(nx, y + 1, nz), 6]
    if (!clear(nx, y, nz) || !clear(nx, y + 1, nz)) return [-1, 0]
    for (let drop = 1; drop <= 2; drop++) {
      if (stand(nx, y - drop, nz)) return [at(nx, y - drop, nz), 4 + drop]
      if (!clear(nx, y - drop, nz)) break
    }
    return [-1, 0]
  }
  const edges = new Int32Array(positions.length * 4).fill(-1), costs = new Uint8Array(edges.length)
  const extracted = performance.now()
  for (let i = 0; i < positions.length; i++) for (let d = 0; d < 4; d++) {
    const [to, cost] = neighbor(i, d); edges[i * 4 + d] = to; costs[i * 4 + d] = cost
  }
  return { side, plane, positions, offsets, edges, costs, at, neighbor,
    extractionMs: +(extracted - started).toFixed(3), adjacencyMs: +(performance.now() - extracted).toFixed(3),
    bytes: positions.byteLength + offsets.byteLength + edges.byteLength + costs.byteLength }
}

// Reused typed heap, shared by all strategies. Keys: f, h, node id, g.
class Heap {
  ids = new Uint32Array(1024)
  gs = new Uint32Array(1024)
  fs = new Uint32Array(1024)
  hs = new Uint32Array(1024)
  length = 0
  get bytes() { return this.ids.byteLength * 4 }
  less(a, b) {
    return this.fs[a] < this.fs[b] || this.fs[a] === this.fs[b] &&
      (this.hs[a] < this.hs[b] || this.hs[a] === this.hs[b] &&
      (this.ids[a] < this.ids[b] || this.ids[a] === this.ids[b] && this.gs[a] < this.gs[b]))
  }
  swap(a, b) {
    for (const data of [this.ids, this.gs, this.fs, this.hs]) { const t = data[a]; data[a] = data[b]; data[b] = t }
  }
  push(id, g, h) {
    if (this.length === this.ids.length) for (const key of ['ids', 'gs', 'fs', 'hs']) {
      const data = new Uint32Array(this[key].length * 2); data.set(this[key]); this[key] = data
    }
    let at = this.length++
    this.ids[at] = id; this.gs[at] = g; this.fs[at] = g + h; this.hs[at] = h
    while (at > 0) { const parent = (at - 1) >>> 1; if (!this.less(at, parent)) break; this.swap(at, parent); at = parent }
  }
  pop() {
    const id = this.ids[0], g = this.gs[0]
    this.length--
    if (this.length > 0) {
      for (const data of [this.ids, this.gs, this.fs, this.hs]) data[0] = data[this.length]
      let at = 0
      while (at * 2 + 1 < this.length) {
        let child = at * 2 + 1
        if (child + 1 < this.length && this.less(child + 1, child)) child++
        if (!this.less(child, at)) break
        this.swap(at, child); at = child
      }
    }
    return [id, g]
  }
}

function makeSearch(graph, mode) {
  const heap = new Heap(), typed = mode !== 'map-cached', n = graph.positions.length
  const seen = typed ? new Uint32Array(n) : null, closed = typed ? new Uint32Array(n) : null
  const gs = typed ? new Uint32Array(n) : null, parents = typed ? new Int32Array(n) : null
  let generation = 0, records = new Map(), goal = -1, expanded = 0, pops = 0, status = 'idle', gx = 0, gz = 0
  const heuristic = id => {
    const p = graph.positions[id]
    return 4 * (Math.abs(p % graph.side - gx) + Math.abs(Math.floor((p % graph.plane) / graph.side) - gz))
  }
  const mark = (id, g, parent) => {
    if (typed) { seen[id] = generation; gs[id] = g; parents[id] = parent }
    else records.set(id, { g, parent, closed: false })
    heap.push(id, g, heuristic(id))
  }
  function begin(start, target) {
    if (++generation === 0x100000000) { seen?.fill(0); closed?.fill(0); generation = 1 }
    heap.length = 0; records.clear(); goal = target; expanded = 0; pops = 0; status = 'pending'
    const p = graph.positions[goal]; gx = p % graph.side; gz = Math.floor((p % graph.plane) / graph.side)
    mark(start, 0, -1)
  }
  function step(cap = Infinity) {
    let used = 0
    while (heap.length && used < cap && status === 'pending') {
      const [id, g] = heap.pop(); used++; pops++
      if (typed ? seen[id] !== generation || gs[id] !== g || closed[id] === generation : records.get(id).g !== g || records.get(id).closed) continue
      expanded++
      if (id === goal) { status = 'found'; break }
      if (typed) closed[id] = generation; else records.get(id).closed = true
      for (let d = 0; d < 4; d++) {
        const [to, cost] = mode === 'typed-live' ? graph.neighbor(id, d) : [graph.edges[id * 4 + d], graph.costs[id * 4 + d]]
        if (to < 0) continue
        const ng = g + cost
        if (typed ? seen[to] === generation && gs[to] <= ng : records.has(to) && records.get(to).g <= ng) continue
        mark(to, ng, id)
      }
    }
    if (!heap.length && status === 'pending') status = 'unreachable'
    return { status, used }
  }
  function result() {
    const path = []
    if (status === 'found') for (let p = goal; p >= 0; p = typed ? parents[p] : records.get(p).parent) path.push(graph.positions[p])
    path.reverse()
    return { status, cost: status === 'found' ? typed ? gs[goal] : records.get(goal).g : null, expanded, pops, path,
      scratchBytes: typed ? seen.byteLength + closed.byteLength + gs.byteLength + parents.byteLength : null,
      mapEntries: typed ? 0 : records.size, heapBytes: heap.bytes }
  }
  return { begin, step, result, run(start, target) { begin(start, target); step(); return result() } }
}

// A deliberately slow Dijkstra oracle on the same graph checks search optimality only.
function oracle(graph, start, goal) {
  const distances = new Map([[start, 0]]), queue = [[start, 0]]
  while (queue.length) {
    queue.sort((a, b) => b[1] - a[1]); const [id, g] = queue.pop()
    if (distances.get(id) !== g) continue
    if (id === goal) return g
    for (let d = 0; d < 4; d++) {
      const to = graph.edges[id * 4 + d], ng = g + graph.costs[id * 4 + d]
      if (to < 0 || ng >= (distances.get(to) ?? Infinity)) continue
      distances.set(to, ng); queue.push([to, ng])
    }
  }
  return null
}

function graphChecks() {
  const store = makeWorld(32, (x, y, z) => y < 4 || x === 9 && z === 8 && y === 4 ? 1 : 0)
  let graph = makeGraph(store), a = graph.at(8, 4, 8), b = graph.at(9, 5, 8)
  assert.equal(graph.edges[a * 4], b, 'one-block ascent')
  assert.equal(graph.edges[b * 4 + 1], a, 'one-block descent')
  store.setVoxel(8, 6, 8, 1); store.commit(); graph = makeGraph(store)
  a = graph.at(8, 4, 8); assert.ok(a >= 0); assert.notEqual(graph.edges[a * 4], graph.at(9, 5, 8), 'ascent must check source headroom')
  assert.equal(graph.at(-1, 4, 8), -1); assert.equal(graph.at(8, HEIGHT - 1, 8), -1)
  const drops = makeGraph(makeWorld(32, (x, y) => y < (x < 8 ? 7 : 4) ? 1 : 0))
  assert.equal(drops.edges[drops.at(7, 7, 8) * 4], -1, 'three-block drop rejected')
  const two = makeGraph(makeWorld(32, (x, y) => y < (x < 8 ? 6 : 4) ? 1 : 0))
  assert.equal(two.edges[two.at(7, 6, 8) * 4], two.at(8, 4, 8), 'two-block drop permitted')
  assert.equal(two.edges[two.at(8, 4, 8) * 4 + 1], -1, 'two-block ascent rejected')
  const empty = makeGraph(makeWorld(32, () => 0))
  assert.ok(empty.at(8, 0, 8) >= 0, 'finite world floor')
  // All 64 source/target pairs, including reverse directions and source == goal.
  const points = [[2, 4, 2], [7, 4, 8], [9, 5, 8], [15, 4, 8], [30, 4, 30], [8, 4, 8], [9, 4, 9], [0, 4, 0]]
  graph = makeGraph(store)
  for (const from of points) for (const to of points) {
    const start = graph.at(...from), goal = graph.at(...to); assert.ok(start >= 0 && goal >= 0)
    const cost = oracle(graph, start, goal)
    for (const mode of ['map-cached', 'typed-cached', 'typed-live']) {
      const search = makeSearch(graph, mode); search.begin(start, goal)
      while (search.step(3).status === 'pending') { /* resumable search */ }
      assert.equal(search.result().cost, cost)
    }
  }
  return { dijkstraPairs: 64, strategies: 3, popBudget: 3, fixtures: ['ascent', 'source-headroom', 'drop-limit', 'directed-drop', 'bounds', 'world-floor'] }
}

const cases = [
  { name: 'open-256', side: 256, sample: (x, y, z) => y < 8 ? 1 : 0, start: [2, 8, 2], goal: [253, 8, 253] },
  { name: 'terraces-128', side: 128, sample: (x, y, z) => y < 8 + Math.floor(x / 8) ? 1 : 0, start: [2, 8, 2], goal: [125, 23, 125] },
  { name: 'two-floors-128', side: 128, sample: (x, y, z) => y < 8 || y >= 16 && y < 18 && !(x >= 60 && x < 68) ? 1 : 0, start: [2, 8, 2], goal: [125, 8, 125] },
  { name: 'maze-128', side: 128, sample: (x, y, z) => y < 8 || y < 11 && x % 12 === 6 && (Math.floor(x / 12) % 2 === 0 ? z < 120 : z > 7) ? 1 : 0, start: [2, 8, 2], goal: [125, 8, 125] },
  { name: 'unreachable-128', side: 128, sample: (x, y, z) => y < 8 || x === 64 && y < 11 ? 1 : 0, start: [2, 8, 2], goal: [125, 8, 125] },
]
const graphReport = []
const correctness = graphChecks()
for (const c of cases) {
  const store = makeWorld(c.side, c.sample), started = performance.now(), graph = makeGraph(store), buildMs = performance.now() - started
  const start = graph.at(...c.start), goal = graph.at(...c.goal); assert.ok(start >= 0 && goal >= 0)
  const modes = ['map-cached', 'typed-cached', 'typed-live'], searches = modes.map(mode => makeSearch(graph, mode)), times = modes.map(() => [])
  const coldQueryMs = []
  const initial = searches.map(s => { const t = performance.now(), result = s.run(start, goal); coldQueryMs.push(+(performance.now() - t).toFixed(3)); return result })
  for (const r of initial) {
    assert.deepEqual(r.path, initial[0].path); assert.equal(r.cost, initial[0].cost); assert.equal(r.expanded, initial[0].expanded)
  }
  for (let round = 0; round < WARMUP + RUNS; round++) for (let m = 0; m < modes.length; m++) {
    const i = (m + round) % modes.length, t = performance.now(), r = searches[i].run(start, goal), ms = performance.now() - t
    assert.equal(r.cost, initial[0].cost)
    if (round >= WARMUP) times[i].push(ms)
  }
  const sliced = makeSearch(graph, 'typed-cached'); sliced.begin(start, goal)
  let slices = 0, maxSlicePops = 0, sliceResult
  const sliceTimes = []
  do { const t = performance.now(); sliceResult = sliced.step(256); sliceTimes.push(performance.now() - t); slices++; maxSlicePops = Math.max(maxSlicePops, sliceResult.used) } while (sliceResult.status === 'pending')
  assert.deepEqual(sliced.result().path, initial[0].path)
  const layersAt = (x, z) => Array.from(graph.positions.slice(graph.offsets[x + z * c.side], graph.offsets[x + z * c.side + 1]), p => Math.floor(p / graph.plane))
  if (c.name === 'two-floors-128') assert.deepEqual(layersAt(2, 2), [8, 18], 'caves and upper floor must both survive extraction')
  graphReport.push({ name: c.name, size: store.layout.size, nodes: graph.positions.length, graphBytes: graph.bytes, buildMs: +buildMs.toFixed(3), extractionMs: graph.extractionMs, adjacencyMs: graph.adjacencyMs,
    status: initial[0].status, cost: initial[0].cost, pathNodes: initial[0].path.length, expanded: initial[0].expanded,
    searches: modes.map((mode, i) => ({ mode, ms: summarize(times[i]), coldQueryMs: coldQueryMs[i], scratchBytes: initial[i].scratchBytes, mapEntries: initial[i].mapEntries, heapBytes: searches[i].result().heapBytes })),
    sliced: { popBudget: 256, slices, maxSlicePops, ms: summarize(sliceTimes) } })
}

// Exact, tiny planar action planner. Every wall occupies feet + head; bridges add one floor.
// State includes remaining inventory AND the local edit overlay. Not a global production planner.
function actionSearch({ width, depth = 1, wall = [], gaps = [], inventory = 0, canDig = true, canBuild = true, start = [0, 0], goal = [width - 1, 0], digTicks = 8, placeTicks = 8 }) {
  const n = width * depth; assert.ok(n <= 30)
  const walls = new Set(wall), holes = new Set(gaps), encode = (x, z) => x + z * width
  const first = { p: encode(...start), remaining: inventory, removed: 0, placed: 0, cost: 0, actions: [] }
  const key = s => `${s.p}:${s.remaining}:${s.removed}:${s.placed}`, best = new Map([[key(first), 0]]), queue = [first]
  let expanded = 0
  while (queue.length) {
    queue.sort((a, b) => b.cost - a.cost || b.p - a.p); const s = queue.pop()
    if (s.cost !== best.get(key(s))) continue
    expanded++
    if (s.p === encode(...goal)) return { status: 'found', cost: s.cost, remaining: s.remaining, actions: s.actions, expanded }
    for (const [dx, dz] of DIRECTIONS) {
      const x = s.p % width + dx, z = Math.floor(s.p / width) + dz
      if (x < 0 || z < 0 || x >= width || z >= depth) continue
      const p = encode(x, z), bit = 1 << p, actions = [...s.actions]
      let removed = s.removed, placed = s.placed, remaining = s.remaining, cost = s.cost
      if (walls.has(p) && !(removed & bit)) {
        if (!canDig) continue
        removed |= bit; cost += 2 * digTicks
        actions.push({ type: 'dig', cell: p, bodyCell: 'feet' }, { type: 'dig', cell: p, bodyCell: 'head' })
      }
      if (holes.has(p) && !(placed & bit)) {
        if (!canBuild || remaining === 0) continue
        placed |= bit; remaining--; cost += placeTicks; actions.push({ type: 'place-floor', cell: p })
      }
      cost += 4; actions.push({ type: 'walk', cell: p })
      const next = { p, remaining, removed, placed, cost, actions }, k = key(next)
      if (cost >= (best.get(k) ?? Infinity)) continue
      best.set(k, cost); queue.push(next)
    }
  }
  return { status: 'unreachable', cost: null, expanded }
}

function verifyActionReplay(options, result) {
  if (result.status !== 'found') return
  const width = options.width, walls = new Set(options.wall ?? []), holes = new Set(options.gaps ?? []), dug = new Map()
  let p = (options.start?.[0] ?? 0) + (options.start?.[1] ?? 0) * width, inventory = options.inventory ?? 0, cost = 0
  const adjacent = cell => Math.abs(cell % width - p % width) + Math.abs(Math.floor(cell / width) - Math.floor(p / width)) === 1
  for (const action of result.actions) {
    assert.ok(adjacent(action.cell), 'each interaction/move is adjacent to current pose')
    if (action.type === 'dig') {
      assert.ok(walls.has(action.cell)); const mask = (dug.get(action.cell) ?? 0) | (action.bodyCell === 'feet' ? 1 : 2)
      dug.set(action.cell, mask); if (mask === 3) walls.delete(action.cell); cost += options.digTicks ?? 8
    } else if (action.type === 'place-floor') {
      assert.ok(holes.has(action.cell)); assert.ok(inventory > 0); inventory--; holes.delete(action.cell); cost += options.placeTicks ?? 8
    } else {
      assert.ok(!walls.has(action.cell) && !holes.has(action.cell), 'walk only after clearance and support exist'); p = action.cell; cost += 4
    }
  }
  const goal = options.goal ?? [width - 1, 0]
  assert.equal(p, goal[0] + goal[1] * width)
  assert.equal(inventory, result.remaining); assert.equal(cost, result.cost)
}
const actionCases = [
  { name: 'prefer-existing-detour', options: { width: 5, depth: 3, wall: [7], start: [0, 1], goal: [4, 1] }, cost: 24, digs: 0 },
  { name: 'dig-forced-tunnel', options: { width: 5, wall: [2] }, cost: 32, digs: 2 },
  { name: 'dig-disabled', options: { width: 5, wall: [2], canDig: false }, cost: null },
  { name: 'bridge-two-blocks', options: { width: 6, gaps: [2, 3], inventory: 2 }, cost: 36, places: 2 },
  { name: 'insufficient-material', options: { width: 6, gaps: [2, 3], inventory: 1 }, cost: null },
  { name: 'preserve-material-via-detour', options: { width: 6, depth: 3, start: [0, 1], goal: [5, 1], wall: [4, 16], gaps: [8, 10], inventory: 1, canDig: false, placeTicks: 4 }, cost: 32, places: 1 },
  { name: 'build-disabled', options: { width: 6, gaps: [2, 3], inventory: 2, canBuild: false }, cost: null },
]
const actionReport = actionCases.map(({ name, options, cost, digs, places }) => {
  const result = actionSearch(options); assert.equal(result.cost, cost); verifyActionReplay(options, result)
  if (digs !== undefined) assert.equal(result.actions.filter(a => a.type === 'dig').length, digs)
  if (places !== undefined) assert.equal(result.actions.filter(a => a.type === 'place-floor').length, places)
  return { name, ...result }
})

console.log(JSON.stringify({ date: '2026-10-07', node: process.version, cpu: cpus()[0]?.model, warmup: WARMUP, runs: RUNS,
  scope: 'Static stand-position graph and exact tiny planar action cases. Graph build reads real ChunkStore. No physics, units, GPU, worker transport, dynamic graph maintenance or production HPA* measured.',
  correctness, graph: graphReport, actions: actionReport,
  memoryModel: { defaultWorldVoxels: 1024 * 128 * 1024, denseScratch16Bytes: 1024 * 128 * 1024 * 16, singleFloorNodes: 1024 * 1024, compactScratch16Bytes: 1024 * 1024 * 16 } }, null, 2))
