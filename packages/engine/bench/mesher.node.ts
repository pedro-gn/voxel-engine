// Absolute gate for the spec's < 3 ms/chunk target, run on plain Node (Vitest adds ~4x overhead).
import { Mesher } from '../src/mesh/mesher.ts'
import { meshTables, surfaceSnap } from './surface.ts'

const LIMIT_MS = 3, WARMUP = 300, RUNS = 500

const tables = meshTables()
const snap = surfaceSnap()
const mesher = new Mesher()
for (let i = 0; i < WARMUP; i++) mesher.mesh(snap, tables)
const t0 = performance.now()
for (let i = 0; i < RUNS; i++) mesher.mesh(snap, tables)
const mean = (performance.now() - t0) / RUNS
console.log(`mesher (plain node): ${mean.toFixed(3)} ms/chunk mean over ${RUNS} runs (limit ${LIMIT_MS} ms)`)
if (mean > LIMIT_MS) process.exit(1)
