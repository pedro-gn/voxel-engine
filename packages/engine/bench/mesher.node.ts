// Absolute gate for the spec's < 3 ms/chunk target, run on plain Node (Vitest adds ~4x overhead).
import { Mesher } from '../src/mesh/mesher.ts'
import { meshTablesFrom } from '../src/mesh/tables.ts'
import { valueNoise2 } from '../src/sim/generator.ts'
import { createSnapshot, padIndex } from '../src/world/reader.ts'
import { AIR, FULL_SKY, packLight } from '../src/world/voxel.ts'
import { ID, testRegistry } from '../test/helpers.ts'

const LIMIT_MS = 3, WARMUP = 300, RUNS = 500

const reg = testRegistry()
const tables = meshTablesFrom(reg, reg.faceLayers(new Map(reg.textureNames().map((n, i) => [n, i + 1]))))

const snap = createSnapshot()
snap.voxels.fill(AIR)
snap.light.fill(FULL_SKY)
for (let pz = 0; pz < 34; pz++) for (let px = 0; px < 34; px++) {
  const h = 8 + Math.floor(valueNoise2(3, px / 9, pz / 9) * 16)
  for (let py = 0; py < 34; py++) {
    const i = padIndex(px, py, pz)
    if (py < h - 3) snap.voxels[i] = ID.stone
    else if (py < h - 1) snap.voxels[i] = ID.dirt
    else if (py === h - 1) snap.voxels[i] = ID.grass
    snap.light[i] = py < h ? 0 : packLight(15, 0)
  }
}

const mesher = new Mesher()
for (let i = 0; i < WARMUP; i++) mesher.mesh(snap, tables)
const t0 = performance.now()
for (let i = 0; i < RUNS; i++) mesher.mesh(snap, tables)
const mean = (performance.now() - t0) / RUNS
console.log(`mesher (plain node): ${mean.toFixed(3)} ms/chunk mean over ${RUNS} runs (limit ${LIMIT_MS} ms)`)
if (mean > LIMIT_MS) process.exit(1)
