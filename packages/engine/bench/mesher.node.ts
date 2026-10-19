// Absolute gate for the spec's < 3 ms/chunk target, run on plain Node (Vitest adds ~4x overhead).
// Each chunk is timed in a fresh process: a second workload timed in the same process runs ~25 % slower (the same surface
// chunk measured twice in a row shows it), which would gate the order of the runs rather than the mesher.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Mesher } from '../src/mesh/mesher.ts'
import { meshTables, roofsSnap, shapedMeshTables, stairsSnap, surfaceSnap } from './surface.ts'

const LIMIT_MS = 3, WARMUP = 300, RUNS = 500
const WORKLOADS = {
  surface: { snap: surfaceSnap, tables: meshTables, gated: true },
  roofs: { snap: roofsSnap, tables: shapedMeshTables, gated: true },
  'all stairs': { snap: stairsSnap, tables: shapedMeshTables, gated: false },
} as const
type Name = keyof typeof WORKLOADS

const only = process.argv[2] as Name | undefined
if (only) {
  const w = WORKLOADS[only], snap = w.snap(), tables = w.tables(), mesher = new Mesher()
  for (let i = 0; i < WARMUP; i++) mesher.mesh(snap, tables)
  const t0 = performance.now()
  for (let i = 0; i < RUNS; i++) mesher.mesh(snap, tables)
  const mean = (performance.now() - t0) / RUNS
  console.log(`mesher ${only} (plain node): ${mean.toFixed(3)} ms/chunk mean over ${RUNS} runs (${w.gated ? `limit ${LIMIT_MS} ms` : 'reported, not gated'})`)
  if (w.gated && mean > LIMIT_MS) process.exit(1)
} else {
  let failed = false
  for (const name of Object.keys(WORKLOADS)) {
    try { process.stdout.write(execFileSync(process.execPath, [fileURLToPath(import.meta.url), name])) } catch (e) {
      failed = true
      process.stdout.write((e as { stdout?: Buffer }).stdout ?? '')
    }
  }
  if (failed) process.exit(1)
}
