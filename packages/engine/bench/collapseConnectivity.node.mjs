// Research microbenchmark for SP3b. Synthetic flat reads, not an engine/FPS acceptance test.
// Run: node packages/engine/bench/collapseConnectivity.node.mjs
import assert from 'node:assert/strict'
import { cpus } from 'node:os'

const SX = 256, SY = 128, SZ = 256, PLANE = SX * SZ, N = SX * SY * SZ
const WARMUP = 5, RUNS = 21
const world = new Uint8Array(N) // 0 = empty, 1 = collapsible, 2 = fixed support
const index = (x, y, z) => x + z * SX + y * PLANE

function box(x0, y0, z0, dx, dy, dz, value = 1) {
  for (let y = y0; y < y0 + dy; y++) for (let z = z0; z < z0 + dz; z++) {
    world.fill(value, index(x0, y, z), index(x0 + dx, y, z))
  }
}

function makeQueue() {
  let data = new Uint32Array(1024), length = 0
  return {
    clear() { length = 0 },
    push(p) {
      if (length === data.length) {
        const next = new Uint32Array(data.length * 2)
        next.set(data); data = next
      }
      data[length++] = p
    },
    get(i) { return data[i] },
    get length() { return length },
    get bytes() { return data.byteLength },
  }
}

function makeSearch(mode) {
  const queue = makeQueue()
  const marks = mode === 'dense-stamps' ? new Uint32Array(N) : null
  const pages = mode === 'chunk-bitsets' ? new Array(N / 32768) : null
  const pageRuns = mode === 'chunk-bitsets' ? new Uint32Array(N / 32768) : null
  let generation = 0, visited = null, pageCount = 0

  function seen(p) {
    if (mode === 'set') {
      if (visited.has(p)) return true
      visited.add(p); return false
    }
    if (marks) {
      if (marks[p] === generation) return true
      marks[p] = generation; return false
    }
    const x = p & 255, z = (p >>> 8) & 255, y = p >>> 16
    const ci = (x >>> 5) + (z >>> 5) * 8 + (y >>> 5) * 64
    const li = (x & 31) + ((z & 31) << 5) + ((y & 31) << 10)
    let page = pages[ci]
    if (!page) { page = pages[ci] = new Uint32Array(1024); pageCount++ }
    if (pageRuns[ci] !== generation) { page.fill(0); pageRuns[ci] = generation }
    const word = li >>> 5, mask = 1 << (li & 31)
    if ((page[word] & mask) !== 0) return true
    page[word] |= mask; return false
  }

  function search(seed) {
    generation++
    if (generation === 0x100000000) {
      marks?.fill(0); pageRuns?.fill(0); generation = 1
    }
    if (mode === 'set') visited = new Set()
    queue.clear()
    let supported = false, processed = 0, reads = 0
    function next(p) {
      reads++
      const value = world[p]
      if (value === 2) { supported = true; return }
      if (value !== 1 || seen(p)) return
      queue.push(p)
    }
    next(seed)
    for (let head = 0; head < queue.length && !supported; head++) {
      const p = queue.get(head)
      const x = p & 255, z = (p >>> 8) & 255, y = p >>> 16
      processed++
      if (y === 0) { supported = true; break } // the engine's finite world floor
      if (x < SX - 1) next(p + 1)
      if (supported) break
      if (x > 0) next(p - 1)
      if (supported) break
      if (y < SY - 1) next(p + PLANE)
      if (supported) break
      if (y > 0) next(p - PLANE)
      if (supported) break
      if (z < SZ - 1) next(p + SX)
      if (supported) break
      if (z > 0) next(p - SX)
    }
    return { supported, processed, reads, discovered: queue.length }
  }
  return {
    search,
    memory() {
      return {
        queueBytes: queue.bytes,
        visitedTypedBytes: marks?.byteLength ?? (pageCount * 4096 + (pageRuns?.byteLength ?? 0)),
        visitedSetEntries: visited?.size ?? 0,
      }
    },
  }
}

const scenarios = [
  { name: 'small-detached', cells: 1024, supported: false,
    build() { box(8, 20, 8, 8, 16, 8); return index(8, 20, 8) } },
  { name: 'wide-slab-detached', cells: 65536, supported: false,
    build() { box(32, 40, 32, 128, 4, 128); return index(32, 40, 32) } },
  { name: 'dense-detached', cells: 262144, supported: false,
    build() { box(64, 32, 64, 64, 64, 64); return index(64, 32, 64) } },
  { name: 'anchor-near', supported: true,
    build() { box(64, 32, 64, 64, 64, 64); world[index(63, 32, 64)] = 2; return index(64, 32, 64) } },
  { name: 'anchor-far', supported: true,
    build() { box(64, 32, 64, 64, 64, 64); world[index(128, 95, 127)] = 2; return index(64, 32, 64) } },
  { name: 'diagonal-is-not-support', cells: 1, supported: false,
    build() { world[index(20, 20, 20)] = 1; world[index(21, 21, 20)] = 2; return index(20, 20, 20) } },
  { name: 'world-bottom', cells: 1, supported: true,
    build() { world[index(20, 0, 20)] = 1; return index(20, 0, 20) } },
]

const modes = ['set', 'dense-stamps', 'chunk-bitsets']
const report = { node: process.version, cpu: cpus()[0].model, world: [SX, SY, SZ], warmup: WARMUP, runs: RUNS, results: [] }
for (const scenario of scenarios) {
  world.fill(0)
  const seed = scenario.build()
  const searches = modes.map(mode => {
    const t = performance.now(), solver = makeSearch(mode)
    const coldStart = solver.search(seed)
    const coldMs = performance.now() - t
    assert.equal(coldStart.supported, scenario.supported)
    if (scenario.cells !== undefined) assert.equal(coldStart.discovered, scenario.cells)
    return { mode, solver, coldMs, coldStart, samples: [] }
  })
  for (const entry of searches) assert.deepEqual(entry.coldStart, searches[0].coldStart)
  for (let run = 0; run < WARMUP + RUNS; run++) {
    // Rotate order so one variant does not always receive a warmer cache.
    for (let offset = 0; offset < searches.length; offset++) {
      const entry = searches[(run + offset) % searches.length]
      const t = performance.now(), result = entry.solver.search(seed)
      const ms = performance.now() - t
      assert.deepEqual(result, entry.coldStart)
      if (run >= WARMUP) entry.samples.push(ms)
    }
  }
  for (const entry of searches) {
    entry.samples.sort((a, b) => a - b)
    report.results.push({
      scenario: scenario.name, mode: entry.mode,
      coldMs: +entry.coldMs.toFixed(3),
      p50Ms: +entry.samples[Math.floor(RUNS * .5)].toFixed(3),
      p95Ms: +entry.samples[Math.ceil(RUNS * .95) - 1].toFixed(3),
      ...entry.coldStart, ...entry.solver.memory(),
    })
  }
}
console.log(JSON.stringify(report, null, 2))
