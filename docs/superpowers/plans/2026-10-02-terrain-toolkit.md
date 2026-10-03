# Terrain Toolkit (Sub-project 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate any relief from a serializable terrain document (`TerrainDoc`), in parallel across a generation worker pool, with partial regeneration for the future editor, and ship a 1024² showcase map that mixes plains, mountains, mesas, arches, caves, a river, a lake and a coast.

**Architecture:** A new pure-TypeScript package `@elovox/terrain` turns a validated `TerrainDoc` into a `GeneratorModule` (the engine's existing generator interface). Generation is a density field with a 2D fast path: height ops build `h(x, z)`, and bounded volume ops (arch, cave, overhang, blob) combine with it through CSG on a coarse, globally aligned lattice. Surface rules, biomes and cross-column features (trees, rocks) follow. The engine gains only generic capabilities: `configure(doc)` on generators, a generation worker pool wired to the sim worker over `MessagePort`s, partial regeneration with regional relighting, and `engine.terrain`.

**Tech Stack:** TypeScript 7 (erasable syntax only, `.ts` import suffixes), npm workspaces, Vitest 4, Vite 8, Playwright, three.js 0.186 (engine only; the terrain package has no three.js).

**Spec:** `docs/superpowers/specs/2026-10-02-terrain-toolkit-design.md`

## Global Constraints

- World size stays `[x, 128, z]`; chunks are 32³; a generator column is 32 × 32 × height, indexed `lx + (lz << 5) + (y << 10)`.
- The sim worker is the only writer to world memory. Generation workers only compute column buffers and transfer them to the sim.
- Everything in `@elovox/terrain` is deterministic: no `Math.random`, no `Date`, no iteration over unordered hash maps for output. Same `(doc, seed, x, z)` → same voxels on every JS engine.
- `@elovox/terrain` has no three.js and no workers. It imports from `@elovox/engine` only types, `packVoxel` (`@elovox/engine/src/world/voxel.ts`), and nothing else.
- Static water voxel = `packVoxel(waterId, 7)` (the value the diorama uses).
- A water level `L` means: every non-solid voxel with `y < L` is water.
- Height-op values are relative for blend `add`/`carve` and absolute world y for `max`/`min`/`set`.
- Every op `id` is stable and unique within a document.
- Performance budgets (§5 of the spec): 1024² full generation ≤ 6 s with 6 generation workers; regenerating 128 × 128 ≤ 300 ms request → visible mesh.
- The `world` and `diorama` sandbox scenes must not change; every sub-project 1 and 2a test keeps passing.
- Repo artifacts (code, comments, commit messages, docs) are in English.
- Commits: conventional style (`feat(terrain): …`, `feat(engine): …`, `test: …`). Do **not** add a `Co-Authored-By` trailer (the user's global rule; the project sets no `attribution.commit`).
- The user is editing textures (`apps/sandbox/public/textures/*`, `apps/sandbox/src/textures.ts`, `apps/sandbox/src/main.ts`, `packages/engine/src/render/tiles.ts`) on this branch. Never revert or overwrite their uncommitted work: `git add` only the files your task names, and if a file you must edit has uncommitted changes, edit around them and keep them.
- Dev server: use `npx vite --port 5174` in `apps/sandbox`, and run the e2e with `E2E_PORT=5174 npm run e2e` (an old server on :5173 has served stale code before).

## Review Focus

1. **A document the user edits by hand with a mistake** (missing field, typo in an op type, block name that is not registered, a `path` with one point). Expected: a readable error that names the path (`ops[3].shape.points: must have at least 2 items`) or the block, and the world does not change. Pinned in Task 6 (validator cases) and Task 14 (unknown block at configure).
2. **An op or feature on a chunk border.** Expected: identical voxels whether the area is generated as 32 × 32 columns or as one region. Pinned in Task 12 (3 × 3 columns == one 96 × 96 region, features and volume ops included).
3. **Ops near the world edge or the top of the world** (a mountain taller than 128, a blob that sticks out of the world, a tree on a peak). Expected: heights clamp to `[1, height - 2]`, out-of-world writes are skipped, nothing throws. Pinned in Task 11 (clamp + out-of-world volume op) and Task 12 (tree near the top).
4. **`regenerate` while another regeneration or a `setDocument` is in flight.** Expected: queued requests run in order; a newer document discards in-flight results and the request is re-run with it. Pinned in Task 19.
5. **A generation worker that dies after the world is ready.** Expected: an active regeneration rejects, later regenerations fall back to the remaining workers (or to serial generation in the sim), and the engine stays alive. Pinned in Task 16 (`GenPool.lose`) and Task 19 (`genLost` fallback).

---

## File Structure

### New package `packages/terrain` (`@elovox/terrain`)

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Workspace package setup (mirrors `packages/engine`) |
| `src/index.ts` | Public exports |
| `src/noise/hash.ts` | Fixed-arity integer hashes `hash2`, `hash3`, `unit` |
| `src/noise/gradient.ts` | Gradient (Perlin) noise `perlin2`, `perlin3` in [-1, 1] |
| `src/noise/fractal.ts` | `fbm2/3`, `ridged2/3`, `billow2/3` |
| `src/noise/cellular.ts` | `cellular2`, `cellular3` (F1 distance) |
| `src/noise/def.ts` | `NoiseDef` → `makeNoise2`, `makeNoise3` samplers in [0, 1], with optional domain warp |
| `src/doc/types.ts` | `TerrainDoc` and every document type |
| `src/doc/check.ts` | `Check` error collector with paths; `checkNoise`, `checkRange` |
| `src/doc/base64.ts` | Base64 ↔ bytes (no Node `Buffer`) |
| `src/doc/validate.ts` | `validateTerrainDoc` (normalizes defaults) and `TerrainDocError` |
| `src/shapes/shape.ts` | `compileShape` (circle, polygon, path), `ShapeSample`, `weight`, `checkShape` |
| `src/shapes/profile.ts` | Profiles and `smoothstep01` |
| `src/shapes/blend.ts` | Height blend modes |
| `src/layers/raster.ts` | Raster/brick encode/decode; `HeightLayer`, `BiomeLayer`, `DensityLayer`; `checkLayers` |
| `src/ops/registry.ts` | Op interfaces, `OpRegistry`, `defineTerrainOp`, `Rect`/`Box` helpers |
| `src/ops/builtin.ts` | `BUILTIN_OPS` list and `builtinRegistry` |
| `src/ops/common.ts` | Shared param readers and validators for ops |
| `src/ops/hills.ts`, `mountain.ts`, `plateau.ts`, `flatten.ts`, `biome.ts` | Height ops (Task 7) |
| `src/ops/valley.ts`, `river.ts`, `lake.ts` | Height ops with water (Task 8) |
| `src/ops/tube.ts` | 3D polyline tube with elliptical cross-section |
| `src/ops/volume.ts` | Volume ops: arch, cave, overhang, blob (Task 9) |
| `src/biomes/biomes.ts` | Compiled biomes, `surfaceBlock`, biome rule |
| `src/pipeline/compile.ts` | `compileTerrain` → `CompiledTerrain` |
| `src/pipeline/cells.ts` | 2D stage: `fillCells` (height, water, wet, biome) |
| `src/pipeline/volume.ts` | Global-aligned lattices and per-column solidity |
| `src/pipeline/region.ts` | `generateRegion` (height → density → water → surface → features) |
| `src/pipeline/probe.ts` | Single-column probe used by feature placement |
| `src/geom.ts` | `Rect`/`Box` bounds helpers |
| `src/features/rand.ts` | `mulberry32` per-feature PRNG |
| `src/features/trees.ts` | Broadleaf, pine and bush stamps |
| `src/features/rocks.ts` | Rock stamp |
| `src/features/place.ts` | `stampFeatures` (jittered global grid, clipped stamps) |
| `src/generator.ts` | `createTerrainGenerator`, `terrainGenerator` |
| `test/*.test.ts` | Unit tests per module |
| `test/fixtures.ts` | Small documents and a fake block-id table for tests |
| `bench/column.bench.ts` | ms per column (2D-only and with volume ops) |

### Engine (`packages/engine`)

| File | Change |
|---|---|
| `src/sim/generator.ts` | `GeneratorInfo`, `ctx.column`, `configure?`, `makeColumnContext` |
| `src/sim/simulation.ts` | `configure`, `generateColumnData`, `applyColumn`, `finishGenerate`, `replaceColumns` |
| `src/sim/light.ts` | `relightRegion` |
| `src/world/chunkStore.ts` | `writableSlot` (open a chunk for a bulk slot write) |
| `src/sim/genPool.ts` (new) | Sim-side generation pool over ports |
| `src/sim/simHost.ts` | Parallel initial generation, `setTerrain`, `regenerate`, `genLost` |
| `src/gen/genHost.ts` (new) | Generation-worker logic (pure, testable) |
| `src/gen/runGenWorker.ts` (new) | Generation-worker shell; package export `./gen-worker` |
| `src/protocol.ts` | `ToGen`, `FromGen`, `GenConnect`, `TerrainRect`, new sim messages |
| `src/errors.ts` | Error code `'terrain'` |
| `src/engine.ts` | `terrain`, `genWorker`, `genWorkers` options; `engine.terrain`; `generated` event |
| `src/index.ts` | Export `TerrainRect` |
| `package.json` | Export `./gen-worker` |

### Sandbox (`apps/sandbox`)

| File | Change |
|---|---|
| `src/blocks.ts` | Blocks `snow`, `gravel`, `sandstone`, `sandstone_red`, `pine_leaves` |
| `src/paint/materials.ts`, `src/paint/index.ts`, `test/painter.test.ts` | Placeholder tiles for the new blocks |
| `src/terrain/showcase.terrain.json` (new) | The 1024² showcase document |
| `src/terrain/e2e.terrain.json` (new) | The 256² e2e document |
| `src/terrain.worker.ts` (new) | Sim worker for the terrain scene |
| `src/gen.worker.ts` (new) | Generation worker |
| `src/main.ts`, `tsconfig.json` | Scene `terrain` (JSON documents imported, `resolveJsonModule`) |
| `src/terrainPanel.ts` (new) | Terrain scene panel: generation time, regenerate-around-view button |
| `test/terrainDocs.test.ts` (new) | Both documents validate; every op is in the e2e doc; showcase golden hashes |
| `e2e/smoke.spec.ts` | Terrain scene boots and regenerates |
| `package.json` | Dependency `@elovox/terrain` |

---

## Part A — The `@elovox/terrain` package

Every file in this part lives in `packages/terrain`. Run its tests with `npm test -w @elovox/terrain` from the repo root (or `npx vitest run` inside the package), and typecheck with `npm run typecheck -w @elovox/terrain`.

### Task 1: Package scaffold and integer hashes

**Files:**
- Create: `packages/terrain/package.json`, `packages/terrain/tsconfig.json`, `packages/terrain/vitest.config.ts`
- Create: `packages/terrain/src/noise/hash.ts`, `packages/terrain/src/index.ts`
- Test: `packages/terrain/test/hash.test.ts`

**Interfaces:**
- Produces: `fmix(h): number`, `hash2(seed, x, z): number` and `hash3(seed, x, y, z): number` (unsigned 32-bit), `unit(h): number` in [0, 1). Everything random in the package derives from these.

The hashes have fixed arity on purpose: the engine's `hash32(...values)` allocates a rest array per call, which is too slow for per-voxel use.

- [ ] **Step 1: Create the package files**

`packages/terrain/package.json`:

```json
{
  "name": "@elovox/terrain",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "bench": "vitest bench --run",
    "typecheck": "tsc --noEmit -p ."
  },
  "dependencies": {
    "@elovox/engine": "0.1.0"
  },
  "devDependencies": {
    "@types/node": "^26.6.4",
    "typescript": "^7.0.2",
    "vitest": "4.1.11"
  }
}
```

`packages/terrain/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test", "bench"]
}
```

`packages/terrain/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    benchmark: { include: ['bench/**/*.bench.ts'] },
  },
})
```

`packages/terrain/src/index.ts` (later tasks replace it with the full export list in Task 14):

```ts
export { hash2, hash3, unit } from './noise/hash.ts'
```

- [ ] **Step 2: Link the workspace**

Run: `npm install` (repo root)
Expected: exit 0; `node_modules/@elovox/terrain` now links to `packages/terrain`.

- [ ] **Step 3: Write the failing test**

`packages/terrain/test/hash.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { hash2, hash3, unit } from '../src/noise/hash.ts'

describe('hash2 / hash3', () => {
  it('is deterministic and sensitive to every input', () => {
    expect(hash2(1, 3, 5)).toBe(hash2(1, 3, 5))
    expect(hash2(1, 3, 5)).not.toBe(hash2(2, 3, 5))
    expect(hash2(1, 3, 5)).not.toBe(hash2(1, 5, 3))
    expect(hash3(1, 3, 5, 7)).not.toBe(hash3(1, 3, 7, 5))
  })
  it('matches golden values, so output is identical on every JS engine', () => {
    expect([hash2(0, 0, 0), hash2(1234, -7, 99), hash3(1234, 5, -6, 7)]).toEqual(GOLDEN)
  })
  it('returns unsigned 32-bit integers that map uniformly into [0, 1)', () => {
    const buckets = new Array<number>(10).fill(0)
    for (let i = 0; i < 20000; i++) {
      const h = hash2(7, i, i * 3)
      expect(Number.isInteger(h) && h >= 0 && h < 2 ** 32).toBe(true)
      buckets[Math.floor(unit(h) * 10)]!++
    }
    for (const b of buckets) expect(b).toBeGreaterThan(1800)
    for (const b of buckets) expect(b).toBeLessThan(2200)
  })
})

const GOLDEN = [1680814304, 3461463847, 3409246125]
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm test -w @elovox/terrain`
Expected: FAIL — `Failed to resolve import "../src/noise/hash.ts"`.

- [ ] **Step 5: Implement**

`packages/terrain/src/noise/hash.ts`:

```ts
/** Murmur3 32-bit finalizer. Returns an unsigned 32-bit integer. */
export function fmix(h: number): number {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** Hash of a seed and two integers. Fixed arity (no rest array), so hot loops stay allocation-free. */
export function hash2(seed: number, x: number, z: number): number {
  let h = fmix((seed | 0) ^ 0x9e3779b9)
  h = fmix(h ^ Math.imul(x | 0, 0x27d4eb2d))
  return fmix(h ^ Math.imul(z | 0, 0x165667b1))
}

export function hash3(seed: number, x: number, y: number, z: number): number {
  let h = fmix((seed | 0) ^ 0x9e3779b9)
  h = fmix(h ^ Math.imul(x | 0, 0x27d4eb2d))
  h = fmix(h ^ Math.imul(y | 0, 0x1b873593))
  return fmix(h ^ Math.imul(z | 0, 0x165667b1))
}

/** Maps a 32-bit hash to [0, 1). */
export function unit(h: number): number { return h / 4294967296 }
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npm test -w @elovox/terrain` then `npm run typecheck -w @elovox/terrain`
Expected: 3 tests pass; typecheck exits 0. If a golden value differs, the hash was transcribed wrong. Fix the code, never the golden.

- [ ] **Step 7: Commit**

```bash
git add packages/terrain/package.json packages/terrain/tsconfig.json packages/terrain/vitest.config.ts packages/terrain/src package-lock.json packages/terrain/test
git commit -m "feat(terrain): package scaffold and fixed-arity hashes"
```

### Task 2: Noise library

**Files:**
- Create: `packages/terrain/src/noise/gradient.ts`, `fractal.ts`, `cellular.ts`, `def.ts`
- Test: `packages/terrain/test/noise.test.ts`

**Interfaces:**
- Consumes: `hash2`, `hash3`, `unit` (Task 1).
- Produces:
  - `perlin2(seed, x, z)` and `perlin3(seed, x, y, z)`, in [-1, 1].
  - `fbm2/3`, `ridged2/3` and `billow2/3(seed, …, o: Octaves)`, where `Octaves = { octaves, lacunarity, gain }`.
  - `cellular2/3`, in [0, 1].
  - `NoiseDef` (`{ type?, scale, octaves?, lacunarity?, gain?, seed?, warp?: { scale, amount } }`) and `NOISE_TYPES`.
  - `makeNoise2(def, worldSeed): Sampler2` and `makeNoise3(def, worldSeed): Sampler3`. Both samplers return values in [0, 1].

`NoiseDef` is what documents contain. Every op reads its noise through `makeNoise2/3`, so domain warp and the four noise types are available to every op.

- [ ] **Step 1: Write the failing test**

`packages/terrain/test/noise.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { cellular2, cellular3 } from '../src/noise/cellular.ts'
import { makeNoise2, makeNoise3, type NoiseDef } from '../src/noise/def.ts'
import { billow2, fbm2, fbm3, ridged2 } from '../src/noise/fractal.ts'
import { perlin2, perlin3 } from '../src/noise/gradient.ts'

const O = { octaves: 4, lacunarity: 2, gain: 0.5 }

function sample2(f: (x: number, z: number) => number, n = 4000): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(f(i * 0.173 + 0.31, i * 0.291 - 7.7))
  return out
}

describe('perlin2 / perlin3', () => {
  it('is zero on lattice points, continuous, and in [-1, 1]', () => {
    expect(perlin2(3, 4, -9)).toBe(0)
    expect(perlin3(3, 4, 5, -9)).toBe(0)
    expect(Math.abs(perlin2(3, 10.5, 10.5) - perlin2(3, 10.5001, 10.5))).toBeLessThan(0.001)
    for (const v of sample2((x, z) => perlin2(9, x, z))) expect(Math.abs(v)).toBeLessThanOrEqual(1)
    for (const v of sample2((x, z) => perlin3(9, x, z * 0.5, z))) expect(Math.abs(v)).toBeLessThanOrEqual(1)
  })
  it('uses most of its range', () => {
    const vs = sample2((x, z) => perlin2(9, x, z))
    expect(Math.max(...vs)).toBeGreaterThan(0.6)
    expect(Math.min(...vs)).toBeLessThan(-0.6)
  })
  it('matches golden values', () => {
    expect([perlin2(1234, 3.7, -2.2), perlin3(1234, 3.7, 8.1, -2.2)].map((v) => v.toFixed(12))).toEqual(GOLDEN_PERLIN)
  })
})

describe('fractal noise', () => {
  it('keeps fbm and billow in [-1, 1] and ridged in [0, 1]', () => {
    for (const v of sample2((x, z) => fbm2(5, x, z, O))) expect(Math.abs(v)).toBeLessThanOrEqual(1)
    for (const v of sample2((x, z) => billow2(5, x, z, O))) expect(Math.abs(v)).toBeLessThanOrEqual(1)
    for (const v of sample2((x, z) => ridged2(5, x, z, O))) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1) }
    for (const v of sample2((x, z) => fbm3(5, x, x - z, z, O))) expect(Math.abs(v)).toBeLessThanOrEqual(1)
  })
  it('matches golden values', () => {
    expect([fbm2(77, 1.25, 2.5, O), ridged2(77, 1.25, 2.5, O)].map((v) => v.toFixed(12))).toEqual(GOLDEN_FRACTAL)
  })
})

describe('cellular', () => {
  it('stays in [0, 1]', () => {
    for (const v of sample2((x, z) => cellular2(4, x, z))) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1) }
    for (const v of sample2((x, z) => cellular3(4, x, z, x))) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1) }
  })
})

describe('makeNoise2 / makeNoise3', () => {
  const types: NoiseDef['type'][] = ['fbm', 'ridged', 'billow', 'cellular']
  it.each(types)('%s samples stay in [0, 1]', (type) => {
    const n2 = makeNoise2({ type, scale: 20 }, 42)
    const n3 = makeNoise3({ type, scale: 20 }, 42)
    for (let i = 0; i < 2000; i++) {
      const a = n2(i * 1.7, i * -2.3), b = n3(i * 1.7, i * 0.4, i * -2.3)
      expect(a).toBeGreaterThanOrEqual(0); expect(a).toBeLessThanOrEqual(1)
      expect(b).toBeGreaterThanOrEqual(0); expect(b).toBeLessThanOrEqual(1)
    }
  })
  it('scales features: a larger scale changes slower', () => {
    const fine = makeNoise2({ scale: 4 }, 1), coarse = makeNoise2({ scale: 64 }, 1)
    let dFine = 0, dCoarse = 0
    for (let i = 0; i < 500; i++) { dFine += Math.abs(fine(i, 0) - fine(i + 1, 0)); dCoarse += Math.abs(coarse(i, 0) - coarse(i + 1, 0)) }
    expect(dCoarse).toBeLessThan(dFine / 4)
  })
  it('is deterministic and decorrelates with def.seed', () => {
    const a = makeNoise2({ scale: 16 }, 1), b = makeNoise2({ scale: 16, seed: 1 }, 1), a2 = makeNoise2({ scale: 16 }, 1)
    expect(a(10.5, 3.25)).toBe(a2(10.5, 3.25))
    expect(a(10.5, 3.25)).not.toBe(b(10.5, 3.25))
  })
  it('warps the domain', () => {
    const plain = makeNoise2({ scale: 16 }, 1), warped = makeNoise2({ scale: 16, warp: { scale: 32, amount: 12 } }, 1)
    let diff = 0
    for (let i = 0; i < 100; i++) diff += Math.abs(plain(i * 3, i * 2) - warped(i * 3, i * 2))
    expect(diff).toBeGreaterThan(1)
  })
})

const GOLDEN_PERLIN = ['-0.212200062533', '-0.275491585529']
const GOLDEN_FRACTAL = ['0.326661480368', '0.517216437445']
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @elovox/terrain`
Expected: FAIL — cannot resolve `../src/noise/cellular.ts`.

- [ ] **Step 3: Implement gradient noise**

`packages/terrain/src/noise/gradient.ts`:

```ts
import { hash2, hash3 } from './hash.ts'

/** 8 unit gradients for 2D, flattened [x0, z0, x1, z1, …]. */
const G2 = new Float64Array([
  1, 0, -1, 0, 0, 1, 0, -1,
  Math.SQRT1_2, Math.SQRT1_2, -Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2, -Math.SQRT1_2, -Math.SQRT1_2, -Math.SQRT1_2,
])
/** The 12 cube-edge gradients of improved Perlin noise, plus 4 repeats so a 4-bit hash indexes them. */
const G3 = new Float64Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
  1, 1, 0, -1, 1, 0, 0, -1, 1, 0, -1, -1,
])

function fade(t: number): number { return t * t * t * (t * (t * 6 - 15) + 10) }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t }
function clamp1(v: number): number { return v < -1 ? -1 : v > 1 ? 1 : v }

function grad2(seed: number, ix: number, iz: number, dx: number, dz: number): number {
  const k = (hash2(seed, ix, iz) & 7) * 2
  return G2[k]! * dx + G2[k + 1]! * dz
}
function grad3(seed: number, ix: number, iy: number, iz: number, dx: number, dy: number, dz: number): number {
  const k = (hash3(seed, ix, iy, iz) & 15) * 3
  return G3[k]! * dx + G3[k + 1]! * dy + G3[k + 2]! * dz
}

/** 2D gradient noise in [-1, 1]; 0 at every integer lattice point. */
export function perlin2(seed: number, x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z)
  const fx = x - ix, fz = z - iz
  const u = fade(fx), v = fade(fz)
  const a = lerp(grad2(seed, ix, iz, fx, fz), grad2(seed, ix + 1, iz, fx - 1, fz), u)
  const b = lerp(grad2(seed, ix, iz + 1, fx, fz - 1), grad2(seed, ix + 1, iz + 1, fx - 1, fz - 1), u)
  return clamp1(lerp(a, b, v) * Math.SQRT2)
}

/** 3D gradient noise in [-1, 1]. */
export function perlin3(seed: number, x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
  const fx = x - ix, fy = y - iy, fz = z - iz
  const u = fade(fx), v = fade(fy), w = fade(fz)
  const x00 = lerp(grad3(seed, ix, iy, iz, fx, fy, fz), grad3(seed, ix + 1, iy, iz, fx - 1, fy, fz), u)
  const x10 = lerp(grad3(seed, ix, iy + 1, iz, fx, fy - 1, fz), grad3(seed, ix + 1, iy + 1, iz, fx - 1, fy - 1, fz), u)
  const x01 = lerp(grad3(seed, ix, iy, iz + 1, fx, fy, fz - 1), grad3(seed, ix + 1, iy, iz + 1, fx - 1, fy, fz - 1), u)
  const x11 = lerp(grad3(seed, ix, iy + 1, iz + 1, fx, fy - 1, fz - 1), grad3(seed, ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1), u)
  return clamp1(lerp(lerp(x00, x10, v), lerp(x01, x11, v), w))
}
```

- [ ] **Step 4: Implement fractal noise**

`packages/terrain/src/noise/fractal.ts`:

```ts
import { perlin2, perlin3 } from './gradient.ts'

export interface Octaves {
  octaves: number
  /** Frequency multiplier per octave. */
  lacunarity: number
  /** Amplitude multiplier per octave. */
  gain: number
}

/** Each octave gets its own seed so octaves never line up. */
const OCTAVE_SEED = 1013

/** Fractal Brownian motion in [-1, 1]. */
export function fbm2(seed: number, x: number, z: number, o: Octaves): number {
  let sum = 0, amp = 1, freq = 1, norm = 0
  for (let i = 0; i < o.octaves; i++) {
    sum += amp * perlin2(seed + i * OCTAVE_SEED, x * freq, z * freq)
    norm += amp
    amp *= o.gain
    freq *= o.lacunarity
  }
  return sum / norm
}

/** Sharp crests where the noise crosses zero, in [0, 1]. Good for mountain ridges. */
export function ridged2(seed: number, x: number, z: number, o: Octaves): number {
  let sum = 0, amp = 1, freq = 1, norm = 0
  for (let i = 0; i < o.octaves; i++) {
    const r = 1 - Math.abs(perlin2(seed + i * OCTAVE_SEED, x * freq, z * freq))
    sum += amp * r * r
    norm += amp
    amp *= o.gain
    freq *= o.lacunarity
  }
  return sum / norm
}

/** Rounded bumps (|noise| folded), in [-1, 1]. */
export function billow2(seed: number, x: number, z: number, o: Octaves): number {
  let sum = 0, amp = 1, freq = 1, norm = 0
  for (let i = 0; i < o.octaves; i++) {
    sum += amp * (Math.abs(perlin2(seed + i * OCTAVE_SEED, x * freq, z * freq)) * 2 - 1)
    norm += amp
    amp *= o.gain
    freq *= o.lacunarity
  }
  return sum / norm
}

export function fbm3(seed: number, x: number, y: number, z: number, o: Octaves): number {
  let sum = 0, amp = 1, freq = 1, norm = 0
  for (let i = 0; i < o.octaves; i++) {
    sum += amp * perlin3(seed + i * OCTAVE_SEED, x * freq, y * freq, z * freq)
    norm += amp
    amp *= o.gain
    freq *= o.lacunarity
  }
  return sum / norm
}

export function ridged3(seed: number, x: number, y: number, z: number, o: Octaves): number {
  let sum = 0, amp = 1, freq = 1, norm = 0
  for (let i = 0; i < o.octaves; i++) {
    const r = 1 - Math.abs(perlin3(seed + i * OCTAVE_SEED, x * freq, y * freq, z * freq))
    sum += amp * r * r
    norm += amp
    amp *= o.gain
    freq *= o.lacunarity
  }
  return sum / norm
}

export function billow3(seed: number, x: number, y: number, z: number, o: Octaves): number {
  let sum = 0, amp = 1, freq = 1, norm = 0
  for (let i = 0; i < o.octaves; i++) {
    sum += amp * (Math.abs(perlin3(seed + i * OCTAVE_SEED, x * freq, y * freq, z * freq)) * 2 - 1)
    norm += amp
    amp *= o.gain
    freq *= o.lacunarity
  }
  return sum / norm
}
```

- [ ] **Step 5: Implement cellular noise**

`packages/terrain/src/noise/cellular.ts`:

```ts
import { hash2, hash3, unit } from './hash.ts'

/** Distance to the nearest jittered feature point (Worley F1), clamped to [0, 1]. */
export function cellular2(seed: number, x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z)
  let best = Infinity
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const cx = ix + dx, cz = iz + dz
    const px = cx + unit(hash2(seed, cx, cz))
    const pz = cz + unit(hash2(seed ^ 0x5bd1e995, cx, cz))
    const d = (px - x) * (px - x) + (pz - z) * (pz - z)
    if (d < best) best = d
  }
  return Math.min(1, Math.sqrt(best))
}

export function cellular3(seed: number, x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
  let best = Infinity
  for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const cx = ix + dx, cy = iy + dy, cz = iz + dz
    const px = cx + unit(hash3(seed, cx, cy, cz))
    const py = cy + unit(hash3(seed ^ 0x5bd1e995, cx, cy, cz))
    const pz = cz + unit(hash3(seed ^ 0x27d4eb2f, cx, cy, cz))
    const d = (px - x) * (px - x) + (py - y) * (py - y) + (pz - z) * (pz - z)
    if (d < best) best = d
  }
  return Math.min(1, Math.sqrt(best))
}
```

- [ ] **Step 6: Implement the document-facing sampler factory**

`packages/terrain/src/noise/def.ts`:

```ts
import { cellular2, cellular3 } from './cellular.ts'
import { billow2, billow3, fbm2, fbm3, ridged2, ridged3, type Octaves } from './fractal.ts'

export type NoiseType = 'fbm' | 'ridged' | 'billow' | 'cellular'
export const NOISE_TYPES: readonly NoiseType[] = ['fbm', 'ridged', 'billow', 'cellular']

/** A noise description as it appears in a terrain document. */
export interface NoiseDef {
  /** Default 'fbm'. */
  type?: NoiseType
  /** Feature size in blocks: the sampler reads noise at (x / scale, z / scale). */
  scale: number
  /** Default 4. Ignored by 'cellular'. */
  octaves?: number
  /** Default 2. */
  lacunarity?: number
  /** Default 0.5. */
  gain?: number
  /** Added to the world seed, so two ops with the same noise can still differ. Default 0. */
  seed?: number
  /** Domain warp: offsets the sample point by fbm noise of this feature size and amount (blocks). */
  warp?: { scale: number; amount: number }
}

export type Sampler2 = (x: number, z: number) => number
export type Sampler3 = (x: number, y: number, z: number) => number

const WARP_X = 0x68e31da4
const WARP_Z = 0x1b56c4e9
const WARP_OCTAVES: Octaves = { octaves: 3, lacunarity: 2, gain: 0.5 }

function octavesOf(def: NoiseDef): Octaves {
  return { octaves: def.octaves ?? 4, lacunarity: def.lacunarity ?? 2, gain: def.gain ?? 0.5 }
}

/** A 2D sampler in [0, 1] for `def`, seeded from the world seed. */
export function makeNoise2(def: NoiseDef, worldSeed: number): Sampler2 {
  const seed = (worldSeed + (def.seed ?? 0)) | 0
  const inv = 1 / def.scale
  const o = octavesOf(def)
  const type = def.type ?? 'fbm'
  const base: Sampler2 =
    type === 'fbm' ? (x, z) => (fbm2(seed, x * inv, z * inv, o) + 1) * 0.5
    : type === 'ridged' ? (x, z) => ridged2(seed, x * inv, z * inv, o)
    : type === 'billow' ? (x, z) => (billow2(seed, x * inv, z * inv, o) + 1) * 0.5
    : (x, z) => cellular2(seed, x * inv, z * inv)
  const warp = def.warp
  if (!warp) return base
  const winv = 1 / warp.scale, amt = warp.amount
  return (x, z) => base(
    x + amt * fbm2(seed ^ WARP_X, x * winv, z * winv, WARP_OCTAVES),
    z + amt * fbm2(seed ^ WARP_Z, x * winv, z * winv, WARP_OCTAVES),
  )
}

/** A 3D sampler in [0, 1]. A warp, if any, offsets x and z only. */
export function makeNoise3(def: NoiseDef, worldSeed: number): Sampler3 {
  const seed = (worldSeed + (def.seed ?? 0)) | 0
  const inv = 1 / def.scale
  const o = octavesOf(def)
  const type = def.type ?? 'fbm'
  const base: Sampler3 =
    type === 'fbm' ? (x, y, z) => (fbm3(seed, x * inv, y * inv, z * inv, o) + 1) * 0.5
    : type === 'ridged' ? (x, y, z) => ridged3(seed, x * inv, y * inv, z * inv, o)
    : type === 'billow' ? (x, y, z) => (billow3(seed, x * inv, y * inv, z * inv, o) + 1) * 0.5
    : (x, y, z) => cellular3(seed, x * inv, y * inv, z * inv)
  const warp = def.warp
  if (!warp) return base
  const winv = 1 / warp.scale, amt = warp.amount
  return (x, y, z) => base(
    x + amt * fbm2(seed ^ WARP_X, x * winv, z * winv, WARP_OCTAVES),
    y,
    z + amt * fbm2(seed ^ WARP_Z, x * winv, z * winv, WARP_OCTAVES),
  )
}
```

- [ ] **Step 7: Run the tests and the typecheck**

Run: `npm test -w @elovox/terrain` then `npm run typecheck -w @elovox/terrain`
Expected: all pass (16 tests in total so far).

- [ ] **Step 8: Commit**

```bash
git add packages/terrain/src/noise packages/terrain/test/noise.test.ts
git commit -m "feat(terrain): gradient, fractal, ridged, billow, cellular and warped noise"
```

### Task 3: Document types, validation helpers and base64

**Files:**
- Create: `packages/terrain/src/doc/types.ts`, `packages/terrain/src/doc/check.ts`, `packages/terrain/src/doc/base64.ts`
- Test: `packages/terrain/test/check.test.ts`

**Interfaces:**
- Consumes: `NOISE_TYPES`, `NoiseDef` (Task 2).
- Produces:
  - Every document type: `TerrainDoc`, `ShapeDef`, `PathPoint`, `OpDef`, `BlendMode`/`BLEND_MODES`, `BaseDef`, `SurfaceRule`, `BiomeDef`, `TreeKind`/`TREE_KINDS`, `BiomeRule`, `BlockNames`/`DEFAULT_BLOCKS`, `RasterRef`, `BrickRef`, `BrickSetRef`, `TerrainLayers` and `Vec2`.
  - `class Check`, with methods `fail`, `obj`, `arr`, `num`, `str`, `bool`, `range` and `vec2`. Each returns a type guard and records `"path: message"` on failure.
  - `checkNoise(c, path, v, optional?)`.
  - `bytesToBase64` and `base64ToBytes`.

These types are the format the 2c editor will read and write, so the doc comments on each field are part of the contract.

- [ ] **Step 1: Write the types (no test: types only)**

`packages/terrain/src/doc/types.ts`:

```ts
import type { NoiseDef } from '../noise/def.ts'

export type Vec2 = [number, number]

/** A path vertex. `y` is used by volume ops; `width` overrides the path's width at this vertex. */
export interface PathPoint { x: number; z: number; y?: number; width?: number }

/**
 * Where an op acts. `falloff` (blocks, default 0) widens the op's mask past the shape's edge with a
 * smooth fade. `inset` (polygons, default 16) is how far inside the edge the profile reaches full strength.
 */
export type ShapeDef =
  | { kind: 'circle'; center: Vec2; radius: number; falloff?: number }
  | { kind: 'polygon'; points: Vec2[]; inset?: number; falloff?: number }
  | { kind: 'path'; points: PathPoint[]; width: number; falloff?: number }

export type ShapeKind = ShapeDef['kind']

/** How a height op combines with the height so far. add/carve take relative values; max/min/set take absolute y. */
export type BlendMode = 'add' | 'carve' | 'max' | 'min' | 'set'
export const BLEND_MODES: readonly BlendMode[] = ['add', 'carve', 'max', 'min', 'set']

export interface OpDef {
  /** Stable and unique within the document; the editor selects ops by id. */
  id: string
  type: string
  enabled: boolean
  shape: ShapeDef
  params: Record<string, unknown>
  /** Height ops only; each op type has a default. */
  blend?: BlendMode
}

/** The procedural fill under every op: `height + amplitude * noise(x, z)`, noise in [0, 1]. */
export interface BaseDef { height: number; amplitude: number; noise: NoiseDef }

/** One surface rule. A voxel takes the block of the first rule of its biome that matches. */
export interface SurfaceRule {
  /** Required unless `bands` is given. */
  block?: string
  /** Solid voxels between this one and the nearest air or water above it. Default [0, 0]. */
  depth?: Vec2
  /** Rise per block, from the height field. Default: any. */
  slope?: Vec2
  /** Absolute y. Default: any. */
  y?: Vec2
  /** true: only under water; false: only under air. Default: either. */
  underwater?: boolean
  /** Matches only within this many blocks above the column's water reference. Default: any. */
  nearWater?: number
  /** true: only voxels with air right below (cave roofs, overhangs). false: never those. Default: either. */
  ceiling?: boolean
  /** Instead of `block`, pick blocks[floor(y / thickness) % blocks.length]: horizontal strata. */
  bands?: { blocks: string[]; thickness: number }
}

export type TreeKind = 'broadleaf' | 'pine' | 'bush'
export const TREE_KINDS: readonly TreeKind[] = ['broadleaf', 'pine', 'bush']

export interface BiomeDef {
  name: string
  surface: SurfaceRule[]
  /** density: chance per 8 × 8 feature cell. on: surface blocks a tree may stand on (default ['grass']). */
  trees?: { density: number; kinds: TreeKind[]; on?: string[] }
  /** density: chance per feature cell (after trees). size: radius range in blocks, at most 6. */
  rocks?: { density: number; size: Vec2 }
}

export interface BiomeRuleEntry { biome: string; minHeight?: number; maxHeight?: number; moisture?: Vec2 }

/** The biome of a column when no biome op or biome layer sets one: first matching rule, else `default`. */
export interface BiomeRule {
  default: string
  /** Moisture noise read by entries with a `moisture` range. Default { scale: 300 }. */
  moisture?: NoiseDef
  rules?: BiomeRuleEntry[]
}

/** Block names the pipeline places by itself. */
export interface BlockNames { fill: string; water: string; log: string; leaves: string; pineLeaves: string; rock: string }
export const DEFAULT_BLOCKS: BlockNames = { fill: 'stone', water: 'water', log: 'log', leaves: 'leaves', pineLeaves: 'pine_leaves', rock: 'rock' }

/** A 2D raster stored as little-endian bytes in base64. */
export interface RasterRef { width: number; height: number; type: 'i16' | 'u8'; data: string }
/** One 8³ brick of signed density samples (Int8, 1/8 block per unit) spaced 2 blocks apart. x, y, z in bricks. */
export interface BrickRef { x: number; y: number; z: number; data: string }
export interface BrickSetRef { bricks: BrickRef[] }

export interface TerrainLayers {
  /** Int16 height delta per column (width = world x, height = world z). */
  height?: RasterRef
  /** Uint8 per 4 × 4 columns: 0 = none, k = biomes[k - 1]. */
  biome?: RasterRef
  /** Sparse 3D density added after every op. */
  density?: BrickSetRef
}

/** A validated, normalized terrain document (every default filled in). */
export interface TerrainDoc {
  format: 'elovox-terrain'
  version: 1
  /** World x and z. Must equal the engine world's. */
  size: Vec2
  /** Every non-solid voxel below this y is water, in every column. Keep inland ground above it. */
  seaLevel: number
  blocks: BlockNames
  base: BaseDef
  biomes: BiomeDef[]
  biomeRule: BiomeRule
  ops: OpDef[]
  layers: TerrainLayers
}
```

- [ ] **Step 2: Write the failing test**

`packages/terrain/test/check.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64 } from '../src/doc/base64.ts'
import { Check, checkNoise } from '../src/doc/check.ts'

describe('Check', () => {
  it('collects every error with its path', () => {
    const c = new Check()
    c.num('a', 'x')
    c.num('b', 1.5, { int: true })
    c.num('c', -1, { min: 0 })
    c.num('d', 0, { gt: 0 })
    c.str('e', 'q', ['p', 'r'])
    c.arr('f', [1], 2)
    c.range('g', [3, 1])
    c.vec2('h', [1])
    c.obj('i', undefined)
    c.bool('j', 1)
    expect(c.errors).toEqual([
      'a: must be a finite number',
      'b: must be an integer',
      'c: must be >= 0',
      'd: must be > 0',
      'e: must be one of p, r',
      'f: must have at least 2 items',
      'g: min must be <= max',
      'h: must be [x, z]',
      'i: is required',
      'j: must be true or false',
    ])
  })
  it('accepts valid values and skips optional missing ones', () => {
    const c = new Check()
    expect(c.num('a', 3, { int: true, min: 0, max: 3 })).toBe(true)
    expect(c.num('b', undefined, { optional: true })).toBe(false)
    expect(c.str('c', undefined, undefined, true)).toBe(false)
    expect(c.range('d', [1, 1])).toBe(true)
    expect(c.errors).toEqual([])
  })
})

describe('checkNoise', () => {
  it('validates every field', () => {
    const c = new Check()
    checkNoise(c, 'n', { type: 'wavy', scale: 0, octaves: 9, warp: { scale: 10, amount: -1 } })
    expect(c.errors).toEqual([
      'n.type: must be one of fbm, ridged, billow, cellular',
      'n.scale: must be > 0',
      'n.octaves: must be <= 8',
      'n.warp.amount: must be >= 0',
    ])
  })
  it('accepts a minimal definition', () => {
    const c = new Check()
    checkNoise(c, 'n', { scale: 32 })
    expect(c.errors).toEqual([])
  })
})

describe('base64', () => {
  it('round-trips bytes, including large arrays', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 37) & 255)
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=')
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -w @elovox/terrain`
Expected: FAIL — cannot resolve `../src/doc/base64.ts`.

- [ ] **Step 4: Implement**

`packages/terrain/src/doc/check.ts`:

```ts
import { NOISE_TYPES } from '../noise/def.ts'

export interface NumOpts { min?: number; max?: number; int?: boolean; optional?: boolean; gt?: number }

/** Collects validation errors as "path: message" without stopping at the first one. */
export class Check {
  readonly errors: string[] = []

  fail(path: string, message: string): void { this.errors.push(`${path}: ${message}`) }

  obj(path: string, v: unknown, optional = false): v is Record<string, unknown> {
    if (v === undefined && optional) return false
    if (typeof v !== 'object' || v === null || Array.isArray(v)) { this.fail(path, v === undefined ? 'is required' : 'must be an object'); return false }
    return true
  }

  arr(path: string, v: unknown, min = 0, optional = false): v is unknown[] {
    if (v === undefined && optional) return false
    if (!Array.isArray(v)) { this.fail(path, v === undefined ? 'is required' : 'must be an array'); return false }
    if (v.length < min) { this.fail(path, `must have at least ${min} item${min === 1 ? '' : 's'}`); return false }
    return true
  }

  num(path: string, v: unknown, o: NumOpts = {}): v is number {
    if (v === undefined && o.optional) return false
    if (typeof v !== 'number' || !Number.isFinite(v)) { this.fail(path, v === undefined ? 'is required' : 'must be a finite number'); return false }
    if (o.int && !Number.isInteger(v)) { this.fail(path, 'must be an integer'); return false }
    if (o.min !== undefined && v < o.min) { this.fail(path, `must be >= ${o.min}`); return false }
    if (o.gt !== undefined && v <= o.gt) { this.fail(path, `must be > ${o.gt}`); return false }
    if (o.max !== undefined && v > o.max) { this.fail(path, `must be <= ${o.max}`); return false }
    return true
  }

  str(path: string, v: unknown, oneOf?: readonly string[], optional = false): v is string {
    if (v === undefined && optional) return false
    if (typeof v !== 'string' || v.length === 0) { this.fail(path, v === undefined ? 'is required' : 'must be a non-empty string'); return false }
    if (oneOf && !oneOf.includes(v)) { this.fail(path, `must be one of ${oneOf.join(', ')}`); return false }
    return true
  }

  bool(path: string, v: unknown, optional = false): v is boolean {
    if (v === undefined && optional) return false
    if (typeof v !== 'boolean') { this.fail(path, v === undefined ? 'is required' : 'must be true or false'); return false }
    return true
  }

  /** [a, b] with a <= b. */
  range(path: string, v: unknown, optional = false): v is [number, number] {
    if (v === undefined && optional) return false
    if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && !Number.isNaN(n))) {
      this.fail(path, 'must be [min, max]')
      return false
    }
    if (v[0] > v[1]) { this.fail(path, 'min must be <= max'); return false }
    return true
  }

  /** [x, z] of finite numbers. */
  vec2(path: string, v: unknown): v is [number, number] {
    if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      this.fail(path, 'must be [x, z]')
      return false
    }
    return true
  }
}

/** Validates a NoiseDef (see noise/def.ts). */
export function checkNoise(c: Check, path: string, v: unknown, optional = false): void {
  if (!c.obj(path, v, optional)) return
  c.str(`${path}.type`, v.type, NOISE_TYPES, true)
  c.num(`${path}.scale`, v.scale, { gt: 0 })
  c.num(`${path}.octaves`, v.octaves, { int: true, min: 1, max: 8, optional: true })
  c.num(`${path}.lacunarity`, v.lacunarity, { gt: 0, optional: true })
  c.num(`${path}.gain`, v.gain, { gt: 0, max: 1, optional: true })
  c.num(`${path}.seed`, v.seed, { int: true, optional: true })
  if (c.obj(`${path}.warp`, v.warp, true)) {
    c.num(`${path}.warp.scale`, v.warp.scale, { gt: 0 })
    c.num(`${path}.warp.amount`, v.warp.amount, { min: 0 })
  }
}
```

`packages/terrain/src/doc/base64.ts`:

```ts
/** Base64 for the document's binary layers. Uses atob/btoa, which Node, browsers and workers all have. */

const CHUNK = 0x8000

export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(s)
}

/** Throws a SyntaxError-like Error on malformed input. */
export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npm test -w @elovox/terrain` then `npm run typecheck -w @elovox/terrain`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/terrain/src/doc packages/terrain/test/check.test.ts
git commit -m "feat(terrain): document types, path-aware validation helpers, base64"
```

### Task 4: Geometry, shapes, profiles and blend modes

**Files:**
- Create: `packages/terrain/src/geom.ts`, `packages/terrain/src/shapes/shape.ts`, `packages/terrain/src/shapes/profile.ts`, `packages/terrain/src/shapes/blend.ts`
- Test: `packages/terrain/test/shape.test.ts`

**Interfaces:**
- Consumes: `Check` (Task 3), `ShapeDef`, `ShapeKind`, `BlendMode` (Task 3).
- Produces:
  - `Rect`/`Box` (closed bounds), plus `expandRect`, `inRect`, `overlaps` and `clamp`.
  - `ShapeSample = { dist, edge, along, y, width }`, `Shape = { kind, bounds, falloff, sample(x, z, out) }`, `newSample()`, `compileShape(def)`, `weight(sample, falloff)` and `checkShape(c, path, v, kinds?, needY?)`.
  - `Profile`, `PROFILES`, `profile(p, edge)` and `smoothstep01(t)`.
  - `blend(mode, h, v, w)`.

`ShapeSample` is the single description every op reads:
- `dist` is the signed distance outside the edge.
- `edge` is 0 at the centre or axis and 1 at the edge.
- `along`, `y` and `width` are interpolated along a path.

`sample` writes into a reused object, so hot loops allocate nothing.

- [ ] **Step 1: Write the failing test**

`packages/terrain/test/shape.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Check } from '../src/doc/check.ts'
import { blend } from '../src/shapes/blend.ts'
import { PROFILES, profile } from '../src/shapes/profile.ts'
import { checkShape, compileShape, newSample, weight } from '../src/shapes/shape.ts'

const s = newSample()

describe('circle', () => {
  const c = compileShape({ kind: 'circle', center: [10, 20], radius: 5, falloff: 4 })
  it('reports distance, edge and bounds', () => {
    c.sample(10, 20, s)
    expect([s.dist, s.edge, s.width]).toEqual([-5, 0, 10])
    c.sample(13, 24, s) // 5 away: on the edge
    expect([s.dist, s.edge]).toEqual([0, 1])
    expect(c.bounds).toEqual({ x0: 5, z0: 15, x1: 15, z1: 25 })
  })
  it('weights 1 inside, fades over the falloff, 0 beyond', () => {
    c.sample(10, 20, s); expect(weight(s, c.falloff)).toBe(1)
    c.sample(17, 20, s); expect(weight(s, c.falloff)).toBeCloseTo(0.5, 5) // 2 of 4 blocks out
    c.sample(19, 20, s); expect(weight(s, c.falloff)).toBe(0)
  })
})

describe('polygon', () => {
  const square = compileShape({ kind: 'polygon', points: [[0, 0], [40, 0], [40, 40], [0, 40]], inset: 10 })
  it('is negative inside, positive outside, with a signed distance to the nearest edge', () => {
    square.sample(20, 20, s); expect(s.dist).toBe(-20); expect(s.edge).toBe(0)
    square.sample(35, 20, s); expect(s.dist).toBe(-5); expect(s.edge).toBe(0.5)
    square.sample(45, 20, s); expect(s.dist).toBe(5); expect(s.edge).toBe(1.5)
    expect(square.bounds).toEqual({ x0: 0, z0: 0, x1: 40, z1: 40 })
  })
  it('handles a concave polygon', () => {
    const l = compileShape({ kind: 'polygon', points: [[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]] })
    l.sample(20, 20, s); expect(s.dist).toBeGreaterThan(0) // in the notch
    l.sample(5, 20, s); expect(s.dist).toBeLessThan(0)
  })
})

describe('path', () => {
  const p = compileShape({ kind: 'path', width: 10, points: [{ x: 0, z: 0, y: 10 }, { x: 100, z: 0, y: 30, width: 20 }] })
  it('measures distance to the polyline with interpolated width, y and along', () => {
    p.sample(50, 3, s)
    expect(s.along).toBe(0.5)
    expect(s.y).toBe(20)
    expect(s.width).toBe(15)
    expect(s.dist).toBe(3 - 7.5)
    expect(s.edge).toBeCloseTo(3 / 7.5, 10)
  })
  it('clamps to the end points', () => {
    p.sample(-10, 0, s)
    expect(s.along).toBe(0)
    expect(s.dist).toBe(10 - 5)
  })
  it('pads bounds by the widest half-width', () => {
    expect(p.bounds).toEqual({ x0: -10, z0: -10, x1: 110, z1: 10 })
  })
})

describe('profiles', () => {
  it.each(PROFILES)('%s is 1-ish at the centre, 0 at and beyond the edge, never negative', (name) => {
    expect(profile(name, 0)).toBe(1)
    expect(profile(name, 1)).toBe(0)
    expect(profile(name, 2)).toBe(0)
    for (let e = 0; e < 1; e += 0.05) expect(profile(name, e)).toBeGreaterThanOrEqual(0)
  })
  it('has the expected shapes', () => {
    expect(profile('linear', 0.5)).toBe(0.5)
    expect(profile('round', 0.6)).toBeCloseTo(0.8, 10)
    expect(profile('box', 0.5)).toBe(1)
    expect(profile('flat', 0.99)).toBe(1)
  })
})

describe('blend', () => {
  it('combines heights per mode', () => {
    expect(blend('add', 10, 4, 0.5)).toBe(12)
    expect(blend('carve', 10, 4, 0.5)).toBe(8)
    expect(blend('max', 10, 20, 0.5)).toBe(15)
    expect(blend('max', 10, 5, 1)).toBe(10)
    expect(blend('min', 10, 4, 0.5)).toBe(7)
    expect(blend('min', 10, 40, 1)).toBe(10)
    expect(blend('set', 10, 40, 0.25)).toBe(17.5)
  })
})

describe('checkShape', () => {
  it('reports bad shapes with paths', () => {
    const c = new Check()
    checkShape(c, 'ops[0].shape', { kind: 'path', width: 0, points: [{ x: 1, z: 2 }] })
    checkShape(c, 'ops[1].shape', { kind: 'circle', center: [1], radius: -1 })
    checkShape(c, 'ops[2].shape', { kind: 'blob' })
    checkShape(c, 'ops[3].shape', { kind: 'path', width: 4, points: [{ x: 0, z: 0 }, { x: 1, z: 1 }] }, ['path'], true)
    checkShape(c, 'ops[4].shape', { kind: 'circle', center: [0, 0], radius: 3 }, ['path'])
    expect(c.errors).toEqual([
      'ops[0].shape.width: must be > 0',
      'ops[0].shape.points: must have at least 2 items',
      'ops[1].shape.center: must be [x, z]',
      'ops[1].shape.radius: must be > 0',
      'ops[2].shape.kind: must be one of circle, polygon, path',
      'ops[3].shape.points[0].y: is required',
      'ops[3].shape.points[1].y: is required',
      'ops[4].shape.kind: must be one of path',
    ])
  })
  it('accepts valid shapes', () => {
    const c = new Check()
    expect(checkShape(c, 's', { kind: 'polygon', points: [[0, 0], [1, 0], [0, 1]], falloff: 4 })).toBe(true)
    expect(c.errors).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @elovox/terrain`
Expected: FAIL — cannot resolve `../src/shapes/blend.ts`.

- [ ] **Step 3: Implement**

`packages/terrain/src/geom.ts`:

```ts
/** Closed axis-aligned rectangle in world x/z: x0 <= x <= x1, z0 <= z <= z1. */
export interface Rect { x0: number; z0: number; x1: number; z1: number }
/** Closed box: a Rect plus y0 <= y <= y1. */
export interface Box extends Rect { y0: number; y1: number }

export function expandRect(r: Rect, by: number): Rect {
  return { x0: r.x0 - by, z0: r.z0 - by, x1: r.x1 + by, z1: r.z1 + by }
}

export function inRect(r: Rect, x: number, z: number): boolean {
  return x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1
}

/** Whether r overlaps the closed rectangle [x0, x1] × [z0, z1]. */
export function overlaps(r: Rect, x0: number, z0: number, x1: number, z1: number): boolean {
  return r.x0 <= x1 && r.x1 >= x0 && r.z0 <= z1 && r.z1 >= z0
}

export function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v }
```

`packages/terrain/src/shapes/profile.ts`:

```ts
/**
 * Cross-section profiles: map `edge` (0 at the centre or axis, 1 at the shape's edge) to a strength
 * in [0, 1]. Every profile is 0 for edge >= 1.
 *  - linear: a cone / V
 *  - round:  a dome / U (circular arc)
 *  - smooth: smoothstep, flat top and soft foot
 *  - flat:   full strength up to the edge
 *  - box:    full strength to 0.75, then a steep smooth wall
 */
export type Profile = 'linear' | 'round' | 'smooth' | 'flat' | 'box'
export const PROFILES: readonly Profile[] = ['linear', 'round', 'smooth', 'flat', 'box']

export function smoothstep01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t
  return c * c * (3 - 2 * c)
}

export function profile(p: Profile, edge: number): number {
  if (edge >= 1) return 0
  const e = edge < 0 ? 0 : edge
  switch (p) {
    case 'linear': return 1 - e
    case 'round': return Math.sqrt(1 - e * e)
    case 'smooth': return smoothstep01(1 - e)
    case 'flat': return 1
    case 'box': return e < 0.75 ? 1 : smoothstep01((1 - e) / 0.25)
  }
}
```

`packages/terrain/src/shapes/blend.ts`:

```ts
import type { BlendMode } from '../doc/types.ts'

/**
 * Combines the height so far `h` with an op's value `v` under mask weight `w` in [0, 1].
 * add/carve: v is relative (blocks up/down). max/min/set: v is an absolute y.
 */
export function blend(mode: BlendMode, h: number, v: number, w: number): number {
  switch (mode) {
    case 'add': return h + v * w
    case 'carve': return h - v * w
    case 'max': return v > h ? h + (v - h) * w : h
    case 'min': return v < h ? h + (v - h) * w : h
    case 'set': return h + (v - h) * w
  }
}
```

`packages/terrain/src/shapes/shape.ts`:

```ts
import type { Check } from '../doc/check.ts'
import type { ShapeDef, ShapeKind } from '../doc/types.ts'
import type { Rect } from '../geom.ts'
import { smoothstep01 } from './profile.ts'

/** What an op learns about a point from its shape. Reused across calls: `sample` overwrites it. */
export interface ShapeSample {
  /** Distance outside the shape's edge in blocks; <= 0 inside. */
  dist: number
  /** 0 at the centre (circle) or axis (path), 1 at the edge, > 1 outside. Polygons: 0 at `inset` inside the edge. */
  edge: number
  /** Paths: position along the path, 0 at the first point, 1 at the last. 0 for other shapes. */
  along: number
  /** Paths: y interpolated at the closest point (0 where points have no y). 0 for other shapes. */
  y: number
  /** Paths: width at the closest point. Circles: the diameter. Polygons: 0. */
  width: number
}

export interface Shape {
  readonly kind: ShapeKind
  /** The shape itself, without falloff. */
  readonly bounds: Rect
  readonly falloff: number
  sample(x: number, z: number, out: ShapeSample): void
}

export function newSample(): ShapeSample { return { dist: 0, edge: 0, along: 0, y: 0, width: 0 } }

/** 1 inside the shape, fading smoothly to 0 at `falloff` blocks outside its edge. */
export function weight(s: ShapeSample, falloff: number): number {
  if (s.dist <= 0) return 1
  if (s.dist >= falloff) return 0
  return smoothstep01(1 - s.dist / falloff)
}

export function compileShape(def: ShapeDef): Shape {
  switch (def.kind) {
    case 'circle': return circle(def.center[0], def.center[1], def.radius, def.falloff ?? 0)
    case 'polygon': return polygon(def.points, def.inset ?? 16, def.falloff ?? 0)
    case 'path': return path(def.points, def.width, def.falloff ?? 0)
  }
}

function circle(cx: number, cz: number, radius: number, falloff: number): Shape {
  return {
    kind: 'circle',
    bounds: { x0: cx - radius, z0: cz - radius, x1: cx + radius, z1: cz + radius },
    falloff,
    sample(x, z, out) {
      const r = Math.hypot(x - cx, z - cz)
      out.dist = r - radius
      out.edge = r / radius
      out.along = 0
      out.y = 0
      out.width = radius * 2
    },
  }
}

function polygon(points: readonly [number, number][], inset: number, falloff: number): Shape {
  const n = points.length
  const xs = Float64Array.from(points, (p) => p[0]), zs = Float64Array.from(points, (p) => p[1])
  return {
    kind: 'polygon',
    bounds: { x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) },
    falloff,
    sample(x, z, out) {
      let best = Infinity, inside = false
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ax = xs[j]!, az = zs[j]!, bx = xs[i]!, bz = zs[i]!
        if ((bz > z) !== (az > z) && x < ((ax - bx) * (z - bz)) / (az - bz) + bx) inside = !inside
        const ex = bx - ax, ez = bz - az
        const len2 = ex * ex + ez * ez
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2)) : 0
        const d = Math.hypot(x - (ax + ex * t), z - (az + ez * t))
        if (d < best) best = d
      }
      out.dist = inside ? -best : best
      out.edge = inside ? Math.max(0, 1 - best / inset) : 1 + best / inset
      out.along = 0
      out.y = 0
      out.width = 0
    },
  }
}

function path(points: readonly { x: number; z: number; y?: number; width?: number }[], width: number, falloff: number): Shape {
  const n = points.length
  const xs = Float64Array.from(points, (p) => p.x), zs = Float64Array.from(points, (p) => p.z)
  const ys = Float64Array.from(points, (p) => p.y ?? 0), ws = Float64Array.from(points, (p) => p.width ?? width)
  const cum = new Float64Array(n) // cumulative length at each vertex
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1]! + Math.hypot(xs[i]! - xs[i - 1]!, zs[i]! - zs[i - 1]!)
  const total = cum[n - 1]! || 1
  const half = Math.max(...ws) / 2
  return {
    kind: 'path',
    bounds: { x0: Math.min(...xs) - half, z0: Math.min(...zs) - half, x1: Math.max(...xs) + half, z1: Math.max(...zs) + half },
    falloff,
    sample(x, z, out) {
      let best = Infinity, bi = 0, bt = 0
      for (let i = 0; i < n - 1; i++) {
        const ax = xs[i]!, az = zs[i]!, ex = xs[i + 1]! - ax, ez = zs[i + 1]! - az
        const len2 = ex * ex + ez * ez
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2)) : 0
        const d = Math.hypot(x - (ax + ex * t), z - (az + ez * t))
        if (d < best) { best = d; bi = i; bt = t }
      }
      const w = ws[bi]! + (ws[bi + 1]! - ws[bi]!) * bt
      const hw = w / 2
      out.dist = best - hw
      out.edge = best / hw
      out.along = (cum[bi]! + (cum[bi + 1]! - cum[bi]!) * bt) / total
      out.y = ys[bi]! + (ys[bi + 1]! - ys[bi]!) * bt
      out.width = w
    },
  }
}

const KINDS: readonly ShapeKind[] = ['circle', 'polygon', 'path']

/** Validates a ShapeDef. `kinds` restricts the kinds an op accepts; `needY` requires y on every path point. */
export function checkShape(c: Check, path: string, v: unknown, kinds: readonly ShapeKind[] = KINDS, needY = false): v is ShapeDef {
  if (!c.obj(path, v)) return false
  if (!c.str(`${path}.kind`, v.kind, kinds)) return false
  const before = c.errors.length
  c.num(`${path}.falloff`, v.falloff, { min: 0, optional: true })
  if (v.kind === 'circle') {
    c.vec2(`${path}.center`, v.center)
    c.num(`${path}.radius`, v.radius, { gt: 0 })
  } else if (v.kind === 'polygon') {
    c.num(`${path}.inset`, v.inset, { gt: 0, optional: true })
    if (c.arr(`${path}.points`, v.points, 3)) v.points.forEach((p, i) => c.vec2(`${path}.points[${i}]`, p))
  } else {
    c.num(`${path}.width`, v.width, { gt: 0 })
    if (c.arr(`${path}.points`, v.points, 2)) {
      v.points.forEach((p, i) => {
        const pp = `${path}.points[${i}]`
        if (!c.obj(pp, p)) return
        c.num(`${pp}.x`, p.x)
        c.num(`${pp}.z`, p.z)
        c.num(`${pp}.y`, p.y, { optional: !needY })
        c.num(`${pp}.width`, p.width, { gt: 0, optional: true })
      })
    }
  }
  return c.errors.length === before
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npm test -w @elovox/terrain` then `npm run typecheck -w @elovox/terrain`
Expected: all pass (37 tests in total).

- [ ] **Step 5: Commit**

```bash
git add packages/terrain/src/geom.ts packages/terrain/src/shapes packages/terrain/test/shape.test.ts
git commit -m "feat(terrain): shapes (circle, polygon, path), profiles and blend modes"
```

### Task 5: Brush layers (rasters and density bricks)

**Files:**
- Create: `packages/terrain/src/layers/raster.ts`
- Test: `packages/terrain/test/layers.test.ts`

**Interfaces:**
- Consumes: `base64ToBytes`, `bytesToBase64`, `Check` and the types (Task 3).
- Produces:
  - Constants `BIOME_CELL = 4`, `BRICK_SAMPLES = 8`, `BRICK_SPACING = 2` and `DENSITY_SCALE = 8`.
  - `encodeRaster`, `decodeRaster` and `encodeBrick`.
  - `HeightLayer.at(x, z)`, `BiomeLayer.at(x, z)` (-1 where unpainted), and `DensityLayer.touches(x0, z0, x1, z1)` and `.sample(x, y, z)` (in blocks).
  - `checkLayers(c, path, v, sizeX, sizeZ)`.

The 2c brushes write these layers. 2b only reads them, and the editor-facing encoders exist so tests and the editor build them the same way.

- [ ] **Step 1: Write the failing test**

`packages/terrain/test/layers.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Check } from '../src/doc/check.ts'
import { BiomeLayer, DensityLayer, HeightLayer, checkLayers, decodeRaster, encodeBrick, encodeRaster } from '../src/layers/raster.ts'

describe('rasters', () => {
  it('round-trips i16 (negative values included) and u8', () => {
    const i16 = Int16Array.from([0, -1, 300, -32768, 32767, 5])
    expect(decodeRaster(encodeRaster('i16', 3, 2, i16))).toEqual(i16)
    const u8 = Uint8Array.from([0, 1, 2, 255])
    expect(decodeRaster(encodeRaster('u8', 2, 2, u8))).toEqual(u8)
  })
  it('rejects a size mismatch', () => {
    expect(() => encodeRaster('u8', 3, 3, new Uint8Array(4))).toThrow(RangeError)
    expect(() => decodeRaster({ width: 3, height: 3, type: 'u8', data: 'AAAA' })).toThrow(/expected 9/)
  })
})

describe('HeightLayer / BiomeLayer', () => {
  it('reads per-column heights', () => {
    const v = new Int16Array(64 * 32)
    v[5 + 7 * 64] = -12
    const layer = new HeightLayer(encodeRaster('i16', 64, 32, v))
    expect(layer.at(5, 7)).toBe(-12)
    expect(layer.at(6, 7)).toBe(0)
  })
  it('reads 4 × 4-column biome cells, -1 where unpainted', () => {
    const v = new Uint8Array(16 * 8)
    v[2 + 1 * 16] = 3 // biome index 2
    const layer = new BiomeLayer(encodeRaster('u8', 16, 8, v))
    expect(layer.at(8, 4)).toBe(2)
    expect(layer.at(11, 7)).toBe(2)
    expect(layer.at(12, 7)).toBe(-1)
  })
})

describe('DensityLayer', () => {
  const samples = new Int8Array(512)
  samples[1 + 1 * 8 + 1 * 64] = 80 // sample (1, 1, 1) of brick (1, 0, 0) = block (18, 2, 2): +10 blocks
  const layer = new DensityLayer({ bricks: [encodeBrick(1, 0, 0, samples)] })
  it('samples exactly on grid points and interpolates between them', () => {
    expect(layer.sample(18, 2, 2)).toBe(10)
    expect(layer.sample(19, 2, 2)).toBe(5)
    expect(layer.sample(17, 3, 2)).toBe(2.5)
    expect(layer.sample(100, 2, 2)).toBe(0)
  })
  it('knows which columns it can touch', () => {
    expect(layer.touches(0, 0, 13, 40)).toBe(false)
    expect(layer.touches(0, 0, 14, 40)).toBe(true)
    expect(layer.touches(33, 0, 40, 40)).toBe(false)
  })
})

describe('checkLayers', () => {
  it('validates sizes, types and brick payloads', () => {
    const c = new Check()
    checkLayers(c, 'layers', {
      height: encodeRaster('i16', 32, 32, new Int16Array(32 * 32)),
      biome: encodeRaster('u8', 4, 4, new Uint8Array(16)),
      density: { bricks: [{ x: 0, y: 0, z: -1, data: 'AAAA' }] },
    }, 64, 32)
    expect(c.errors).toEqual([
      'layers.height: must be 64 × 32, got 32 × 32',
      'layers.biome: must be 16 × 8, got 4 × 4',
      'layers.density.bricks[0].z: must be >= 0',
      'layers.density.bricks[0].data: must hold 512 samples, got 3',
    ])
  })
  it('accepts missing layers', () => {
    const c = new Check()
    checkLayers(c, 'layers', {}, 64, 64)
    checkLayers(c, 'layers', undefined, 64, 64)
    expect(c.errors).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @elovox/terrain`
Expected: FAIL — cannot resolve `../src/layers/raster.ts`.

- [ ] **Step 3: Implement**

`packages/terrain/src/layers/raster.ts`:

```ts
import { base64ToBytes, bytesToBase64 } from '../doc/base64.ts'
import type { Check } from '../doc/check.ts'
import type { BrickRef, BrickSetRef, RasterRef } from '../doc/types.ts'

/** Columns per biome-layer cell, per side. */
export const BIOME_CELL = 4
/** Samples per brick side; samples are BRICK_SPACING blocks apart, so a brick spans 16 blocks. */
export const BRICK_SAMPLES = 8
export const BRICK_SPACING = 2
/** Density units per block. */
export const DENSITY_SCALE = 8

export function encodeRaster(type: 'i16' | 'u8', width: number, height: number, values: Int16Array | Uint8Array): RasterRef {
  if (values.length !== width * height) throw new RangeError(`raster has ${values.length} values, expected ${width * height}`)
  const bytes = type === 'u8' ? new Uint8Array(values.buffer, values.byteOffset, values.length) : new Uint8Array(width * height * 2)
  if (type === 'i16') {
    const dv = new DataView(bytes.buffer)
    for (let i = 0; i < values.length; i++) dv.setInt16(i * 2, values[i]!, true)
  }
  return { width, height, type, data: bytesToBase64(bytes) }
}

export function decodeRaster(ref: RasterRef): Int16Array | Uint8Array {
  const bytes = base64ToBytes(ref.data)
  const n = ref.width * ref.height
  if (ref.type === 'u8') {
    if (bytes.length !== n) throw new RangeError(`raster data has ${bytes.length} bytes, expected ${n}`)
    return bytes
  }
  if (bytes.length !== n * 2) throw new RangeError(`raster data has ${bytes.length} bytes, expected ${n * 2}`)
  const out = new Int16Array(n)
  const dv = new DataView(bytes.buffer)
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true)
  return out
}

export function encodeBrick(x: number, y: number, z: number, samples: Int8Array): BrickRef {
  if (samples.length !== BRICK_SAMPLES ** 3) throw new RangeError(`brick needs ${BRICK_SAMPLES ** 3} samples`)
  return { x, y, z, data: bytesToBase64(new Uint8Array(samples.buffer, samples.byteOffset, samples.length)) }
}

/** Height delta per column, added after every height op. */
export class HeightLayer {
  private readonly values: Int16Array
  private readonly width: number
  constructor(ref: RasterRef) {
    this.values = decodeRaster(ref) as Int16Array
    this.width = ref.width
  }
  at(x: number, z: number): number { return this.values[x + z * this.width] ?? 0 }
}

/** Biome index per 4 × 4 columns, or -1 where the layer is unpainted (stored 0). */
export class BiomeLayer {
  private readonly values: Uint8Array
  private readonly width: number
  constructor(ref: RasterRef) {
    this.values = decodeRaster(ref) as Uint8Array
    this.width = ref.width
  }
  at(x: number, z: number): number {
    const v = this.values[Math.floor(x / BIOME_CELL) + Math.floor(z / BIOME_CELL) * this.width] ?? 0
    return v - 1
  }
}

/** Sparse density sculpt: trilinear over a global 2-block sample grid; missing samples are 0. */
export class DensityLayer {
  private readonly bricks = new Map<number, Int8Array>()
  /** Block-space bounds of every brick, padded by one sample spacing for the trilinear reach. */
  readonly bounds: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }[] = []

  constructor(ref: BrickSetRef) {
    const span = BRICK_SAMPLES * BRICK_SPACING
    for (const b of ref.bricks) {
      const bytes = base64ToBytes(b.data)
      this.bricks.set(key(b.x, b.y, b.z), new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length))
      this.bounds.push({
        x0: b.x * span - BRICK_SPACING, y0: b.y * span - BRICK_SPACING, z0: b.z * span - BRICK_SPACING,
        x1: (b.x + 1) * span, y1: (b.y + 1) * span, z1: (b.z + 1) * span,
      })
    }
  }

  /** Whether any brick can affect the columns in [x0, x1] × [z0, z1]. */
  touches(x0: number, z0: number, x1: number, z1: number): boolean {
    return this.bounds.some((b) => b.x0 <= x1 && b.x1 >= x0 && b.z0 <= z1 && b.z1 >= z0)
  }

  /** Density delta in blocks at a voxel. */
  sample(x: number, y: number, z: number): number {
    const gx = x / BRICK_SPACING, gy = y / BRICK_SPACING, gz = z / BRICK_SPACING
    const ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz)
    const fx = gx - ix, fy = gy - iy, fz = gz - iz
    let v = 0
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1
      const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz)
      if (w > 0) v += w * this.at(ix + dx, iy + dy, iz + dz)
    }
    return v / DENSITY_SCALE
  }

  private at(sx: number, sy: number, sz: number): number {
    const b = this.bricks.get(key(Math.floor(sx / BRICK_SAMPLES), Math.floor(sy / BRICK_SAMPLES), Math.floor(sz / BRICK_SAMPLES)))
    if (!b) return 0
    const lx = sx & (BRICK_SAMPLES - 1), ly = sy & (BRICK_SAMPLES - 1), lz = sz & (BRICK_SAMPLES - 1)
    return b[lx + lz * BRICK_SAMPLES + ly * BRICK_SAMPLES * BRICK_SAMPLES]!
  }
}

/** Brick coordinates fit in 10 bits each (1024 bricks = 16 384 blocks per axis). */
function key(x: number, y: number, z: number): number { return (x & 1023) | ((y & 1023) << 10) | ((z & 1023) << 20) }

function checkRaster(c: Check, path: string, v: unknown, type: 'i16' | 'u8', width: number, height: number): void {
  if (!c.obj(path, v, true)) return
  if (v.type !== type) c.fail(`${path}.type`, `must be ${type}`)
  if (v.width !== width || v.height !== height) c.fail(path, `must be ${width} × ${height}, got ${String(v.width)} × ${String(v.height)}`)
  if (typeof v.data !== 'string') { c.fail(`${path}.data`, 'must be a base64 string'); return }
  try {
    decodeRaster(v as unknown as RasterRef)
  } catch (e) {
    c.fail(`${path}.data`, e instanceof Error ? e.message : String(e))
  }
}

/** Validates the layers object against the world's x/z size. */
export function checkLayers(c: Check, path: string, v: unknown, sizeX: number, sizeZ: number): void {
  if (!c.obj(path, v, true)) return
  checkRaster(c, `${path}.height`, v.height, 'i16', sizeX, sizeZ)
  checkRaster(c, `${path}.biome`, v.biome, 'u8', Math.ceil(sizeX / BIOME_CELL), Math.ceil(sizeZ / BIOME_CELL))
  if (!c.obj(`${path}.density`, v.density, true)) return
  if (!c.arr(`${path}.density.bricks`, v.density.bricks)) return
  v.density.bricks.forEach((b, i) => {
    const bp = `${path}.density.bricks[${i}]`
    if (!c.obj(bp, b)) return
    for (const k of ['x', 'y', 'z'] as const) c.num(`${bp}.${k}`, b[k], { int: true, min: 0, max: 1023 })
    if (typeof b.data !== 'string') { c.fail(`${bp}.data`, 'must be a base64 string'); return }
    try {
      const n = base64ToBytes(b.data).length
      if (n !== BRICK_SAMPLES ** 3) c.fail(`${bp}.data`, `must hold ${BRICK_SAMPLES ** 3} samples, got ${n}`)
    } catch {
      c.fail(`${bp}.data`, 'must be a base64 string')
    }
  })
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npm test -w @elovox/terrain` then `npm run typecheck -w @elovox/terrain`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/terrain/src/layers packages/terrain/test/layers.test.ts
git commit -m "feat(terrain): height, biome and sparse density brush layers"
```

### Task 6: Op registry and document validation

**Files:**
- Create: `packages/terrain/src/ops/registry.ts`, `packages/terrain/src/ops/builtin.ts`, `packages/terrain/src/doc/validate.ts`
- Create: `packages/terrain/test/fixtures.ts`
- Test: `packages/terrain/test/validate.test.ts`

**Interfaces:**
- Consumes: `Check`, `checkNoise`, the types (Task 3), `checkShape` (Task 4), `checkLayers` (Task 5).
- Produces:
  - `Cell = { h, water, wet, biome }`.
  - `ValidateContext = { biomes, height }` and `CompileContext = { seed, height, seaLevel, biomeIndex(name) }`.
  - `HeightOp = { id, bounds: Rect, apply(x, z, cell) }` and `VolumeOp = { id, bounds: Box, mode: 'add' | 'carve', density(x, y, z) }`.
  - `HeightOpImpl` / `VolumeOpImpl`, with fields `type`, `kind`, `shapes`, `needY?`, `validate(c, path, def, ctx)`, `compile(def, ctx)`, and `defaultBlend` for height ops.
  - `OpImpl`, `defineTerrainOp` (overloaded for height and volume ops), and `OpRegistry` with `get`, `types` and `with`.
  - `BUILTIN_OPS` (empty for now; Tasks 7–9 fill it) and `builtinOps`.
  - `validateTerrainDoc(json, { ops?, worldHeight? }): ValidateResult`, `TerrainDocError`, `TERRAIN_FORMAT` and `TERRAIN_VERSION`.
  - Test fixtures `minimalDoc()`, `IDS` and `idOf(name)`.

The validator normalizes the document:
- `blocks` is merged over `DEFAULT_BLOCKS`;
- `layers` defaults to `{}`;
- each op gets `enabled: true` and `params: {}` by default.

Later code can therefore trust a `TerrainDoc`. Errors are collected, never thrown, and each one carries its path.

- [ ] **Step 1: Write the registry**

`packages/terrain/src/ops/registry.ts`:

```ts
import type { Check } from '../doc/check.ts'
import type { BlendMode, OpDef, ShapeKind } from '../doc/types.ts'
import type { Box, Rect } from '../geom.ts'

/** The 2D state of one column while height ops run. */
export interface Cell {
  /** Ground height: voxels with y < round(h) are solid (before volume ops). */
  h: number
  /** Water level from rivers and lakes (non-solid voxels below it become water); -1 = none. */
  water: number
  /** Water reference for `nearWater` surface rules (banks and shores); -Infinity = none. */
  wet: number
  /** Biome index set by a biome op; -1 = none. */
  biome: number
}

export interface ValidateContext {
  /** Biome names declared by the document, in order. */
  readonly biomes: readonly string[]
  /** World height (y size). */
  readonly height: number
}

export interface CompileContext {
  readonly seed: number
  readonly height: number
  readonly seaLevel: number
  biomeIndex(name: string): number
}

export interface HeightOp {
  readonly id: string
  /** Columns outside these bounds are never touched by `apply`. */
  readonly bounds: Rect
  apply(x: number, z: number, cell: Cell): void
}

export interface VolumeOp {
  readonly id: string
  /** Where `density` can be positive (for 'add') or where it carves (for 'carve'). */
  readonly bounds: Box
  /** add: solid = max(solid, density); carve: solid = min(solid, -density). */
  readonly mode: 'add' | 'carve'
  /** Signed distance-like field in blocks: > 0 inside the op's volume. */
  density(x: number, y: number, z: number): number
}

interface OpImplBase {
  readonly type: string
  /** Shape kinds this op accepts. */
  readonly shapes: readonly ShapeKind[]
  /** Requires y on every path point (volume ops along paths). */
  readonly needY?: boolean
  /** Validates `def.params` (shape and common fields are already valid). */
  validate(c: Check, path: string, def: OpDef, ctx: ValidateContext): void
}
export interface HeightOpImpl extends OpImplBase {
  readonly kind: 'height'
  readonly defaultBlend: BlendMode
  compile(def: OpDef, ctx: CompileContext): HeightOp
}
export interface VolumeOpImpl extends OpImplBase {
  readonly kind: 'volume'
  compile(def: OpDef, ctx: CompileContext): VolumeOp
}
export type OpImpl = HeightOpImpl | VolumeOpImpl

/** Identity helper that types a custom op. Register it with `builtinOps.with(myOp)`. */
export function defineTerrainOp(impl: HeightOpImpl): HeightOpImpl
export function defineTerrainOp(impl: VolumeOpImpl): VolumeOpImpl
export function defineTerrainOp(impl: OpImpl): OpImpl { return impl }

export class OpRegistry {
  private readonly byType = new Map<string, OpImpl>()

  constructor(impls: readonly OpImpl[]) {
    for (const impl of impls) {
      if (this.byType.has(impl.type)) throw new Error(`duplicate terrain op type "${impl.type}"`)
      this.byType.set(impl.type, impl)
    }
  }

  get(type: string): OpImpl | undefined { return this.byType.get(type) }

  types(): string[] { return [...this.byType.keys()] }

  /** A new registry with extra (custom) ops. */
  with(...impls: OpImpl[]): OpRegistry { return new OpRegistry([...this.byType.values(), ...impls]) }
}
```

`packages/terrain/src/ops/builtin.ts` (the list stays empty until Task 7):

```ts
import { OpRegistry, type OpImpl } from './registry.ts'

/** Every built-in op, in a stable order. */
export const BUILTIN_OPS: readonly OpImpl[] = []

export const builtinOps = new OpRegistry(BUILTIN_OPS)
```

- [ ] **Step 2: Write the fixtures and the failing test**

`packages/terrain/test/fixtures.ts`:

```ts
/** A small valid document as plain JSON-like data. Tests copy it and change one thing. */
export function minimalDoc(): Record<string, unknown> {
  return {
    format: 'elovox-terrain',
    version: 1,
    size: [64, 64],
    seaLevel: 10,
    base: { height: 20, amplitude: 0, noise: { scale: 32 } },
    biomes: [
      { name: 'plain', surface: [{ block: 'grass' }, { block: 'dirt', depth: [1, 3] }] },
      { name: 'beach', surface: [{ block: 'sand', depth: [0, 2] }] },
    ],
    biomeRule: { default: 'plain' },
    ops: [],
  }
}

/** Block ids used by pipeline tests (any stable mapping works; ids must be < 4096). */
export const IDS: Record<string, number> = {
  stone: 1, dirt: 2, grass: 3, sand: 4, water: 5, log: 6, leaves: 7, pine_leaves: 8, rock: 9, snow: 10, gravel: 11,
  sandstone: 12, sandstone_red: 13,
}

export function idOf(name: string): number {
  const id = IDS[name]
  if (id === undefined) throw new Error(`unknown block "${name}"`)
  return id
}
```

`packages/terrain/test/validate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { TerrainDocError, validateTerrainDoc } from '../src/doc/validate.ts'
import { encodeRaster } from '../src/layers/raster.ts'
import { OpRegistry, defineTerrainOp } from '../src/ops/registry.ts'
import { minimalDoc } from './fixtures.ts'

/** A custom op, which also proves custom ops plug into validation. */
const bump = defineTerrainOp({
  type: 'bump', kind: 'height', defaultBlend: 'add', shapes: ['circle'],
  validate(c, path, def) { c.num(`${path}.params.height`, def.params.height, { min: 0 }) },
  compile(def) { return { id: def.id, bounds: { x0: 0, z0: 0, x1: 0, z1: 0 }, apply() {} } },
})
const ops = new OpRegistry([bump])
const circle = { kind: 'circle', center: [10, 10], radius: 5 }

function errorsOf(doc: unknown): string[] {
  const r = validateTerrainDoc(doc, { ops })
  return r.ok ? [] : r.errors
}

describe('validateTerrainDoc', () => {
  it('accepts a minimal document and fills defaults', () => {
    const r = validateTerrainDoc(minimalDoc(), { ops })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.doc.blocks).toEqual({ fill: 'stone', water: 'water', log: 'log', leaves: 'leaves', pineLeaves: 'pine_leaves', rock: 'rock' })
    expect(r.doc.layers).toEqual({})
    expect(r.doc.ops).toEqual([])
  })

  it('normalizes ops: enabled defaults to true, params to {}', () => {
    const doc = { ...minimalDoc(), ops: [{ id: 'a', type: 'bump', shape: circle, params: { height: 3 } }, { id: 'b', type: 'bump', enabled: false, shape: circle, params: { height: 1 }, blend: 'max' }] }
    const r = validateTerrainDoc(doc, { ops })
    expect(r.ok && r.doc.ops).toEqual([
      { id: 'a', type: 'bump', enabled: true, shape: circle, params: { height: 3 } },
      { id: 'b', type: 'bump', enabled: false, shape: circle, params: { height: 1 }, blend: 'max' },
    ])
  })

  it('rejects things that are not documents', () => {
    expect(errorsOf(null)).toEqual(['(document): must be an object'])
    expect(errorsOf([])).toEqual(['(document): must be an object'])
  })

  it('reports format, version, size and sea level problems', () => {
    expect(errorsOf({ ...minimalDoc(), format: 'x', version: 2, size: [64, 50], seaLevel: 128 })).toEqual([
      'format: must be "elovox-terrain"',
      'version: unsupported version 2 (this build reads version 1)',
      'size[1]: must be a positive multiple of 32',
      'seaLevel: must be <= 127',
    ])
  })

  it('reports biome problems with paths', () => {
    const doc = {
      ...minimalDoc(),
      biomes: [
        { name: 'plain', surface: [{ depth: [1, 0] }], trees: { density: 2, kinds: ['palm'] }, rocks: { density: 0.1, size: [1, 9] } },
        { name: 'plain', surface: [{ bands: { blocks: [], thickness: 0 } }] },
      ],
      biomeRule: { default: 'desert', rules: [{ biome: 'plain', moisture: [0.8, 0.2] }] },
    }
    expect(errorsOf(doc)).toEqual([
      'biomes[0].surface[0].block: is required',
      'biomes[0].surface[0].depth: min must be <= max',
      'biomes[0].trees.density: must be <= 1',
      'biomes[0].trees.kinds[0]: must be one of broadleaf, pine, bush',
      'biomes[0].rocks.size: must be within [1, 6]',
      'biomes[1].name: duplicate biome "plain"',
      'biomes[1].surface[0].bands.blocks: must have at least 1 item',
      'biomes[1].surface[0].bands.thickness: must be >= 1',
      'biomeRule.default: must be one of plain',
      'biomeRule.rules[0].moisture: min must be <= max',
    ])
  })

  it('reports op problems with paths, including unknown types and custom-op params', () => {
    const doc = {
      ...minimalDoc(),
      ops: [
        { id: 'a', type: 'bump', shape: circle, params: { height: -1 } },
        { id: 'a', type: 'bump', shape: { kind: 'path', width: 3, points: [{ x: 0, z: 0 }, { x: 1, z: 1 }] }, params: { height: 1 } },
        { id: 'c', type: 'volcano', shape: circle },
        { id: 'd', type: 'bump', shape: circle, params: { height: 1 }, blend: 'mix', enabled: 'yes' },
      ],
    }
    expect(errorsOf(doc)).toEqual([
      'ops[0].params.height: must be >= 0',
      'ops[1].id: duplicate id "a"',
      'ops[1].shape.kind: must be one of circle',
      'ops[2].type: unknown op type "volcano" (known: bump)',
      'ops[3].enabled: must be true or false',
      'ops[3].blend: must be one of add, carve, max, min, set',
    ])
  })

  it('validates layers against the document size', () => {
    const doc = { ...minimalDoc(), layers: { height: encodeRaster('i16', 32, 32, new Int16Array(1024)) } }
    expect(errorsOf(doc)).toEqual(['layers.height: must be 64 × 64, got 32 × 32'])
  })

  it('rejects unknown block keys', () => {
    expect(errorsOf({ ...minimalDoc(), blocks: { fill: 'stone', lava: 'x' } })).toEqual(['blocks.lava: unknown key (known: fill, water, log, leaves, pineLeaves, rock)'])
  })
})

describe('TerrainDocError', () => {
  it('lists every error in its message', () => {
    const e = new TerrainDocError(['a: x', 'b: y'])
    expect(e.message).toBe('invalid terrain document:\n  - a: x\n  - b: y')
    expect(e.errors).toEqual(['a: x', 'b: y'])
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -w @elovox/terrain`
Expected: FAIL — cannot resolve `../src/doc/validate.ts`.

- [ ] **Step 4: Implement the validator**

`packages/terrain/src/doc/validate.ts`:

```ts
import { checkLayers } from '../layers/raster.ts'
import { builtinOps } from '../ops/builtin.ts'
import type { OpRegistry } from '../ops/registry.ts'
import { checkShape } from '../shapes/shape.ts'
import { Check, checkNoise } from './check.ts'
import {
  BLEND_MODES, DEFAULT_BLOCKS, TREE_KINDS,
  type BlendMode, type BlockNames, type OpDef, type ShapeDef, type TerrainDoc,
} from './types.ts'

export const TERRAIN_FORMAT = 'elovox-terrain'
export const TERRAIN_VERSION = 1

export type ValidateResult = { ok: true; doc: TerrainDoc } | { ok: false; errors: string[] }

export interface ValidateOptions {
  /** Op types the document may use. Default: the built-in ops. */
  ops?: OpRegistry
  /** World height, for y ranges. Default 128. */
  worldHeight?: number
}

export class TerrainDocError extends Error {
  readonly errors: readonly string[]
  constructor(errors: readonly string[]) {
    super(`invalid terrain document:\n  - ${errors.join('\n  - ')}`)
    this.name = 'TerrainDocError'
    this.errors = errors
  }
}

/**
 * Checks a parsed JSON value against the TerrainDoc format and returns it normalized (defaults
 * filled in), or every error found, each prefixed with its path.
 */
export function validateTerrainDoc(json: unknown, o: ValidateOptions = {}): ValidateResult {
  const ops = o.ops ?? builtinOps
  const height = o.worldHeight ?? 128
  const c = new Check()
  if (!c.obj('(document)', json)) return { ok: false, errors: c.errors }
  const d = json

  if (d.format !== TERRAIN_FORMAT) c.fail('format', `must be "${TERRAIN_FORMAT}"`)
  if (d.version !== TERRAIN_VERSION) c.fail('version', `unsupported version ${JSON.stringify(d.version)} (this build reads version ${TERRAIN_VERSION})`)
  if (c.vec2('size', d.size)) {
    d.size.forEach((s, i) => {
      if (!Number.isInteger(s) || s <= 0 || s % 32 !== 0) c.fail(`size[${i}]`, 'must be a positive multiple of 32')
    })
  }
  c.num('seaLevel', d.seaLevel, { int: true, min: 0, max: height - 1 })
  if (c.obj('blocks', d.blocks, true)) {
    for (const [k, v] of Object.entries(d.blocks)) {
      if (!(k in DEFAULT_BLOCKS)) c.fail(`blocks.${k}`, `unknown key (known: ${Object.keys(DEFAULT_BLOCKS).join(', ')})`)
      else c.str(`blocks.${k}`, v)
    }
  }
  if (c.obj('base', d.base)) {
    c.num('base.height', d.base.height, { min: 0, max: height })
    c.num('base.amplitude', d.base.amplitude, { min: 0 })
    checkNoise(c, 'base.noise', d.base.noise)
  }

  const biomeNames: string[] = []
  if (c.arr('biomes', d.biomes, 1)) {
    d.biomes.forEach((b, i) => {
      const p = `biomes[${i}]`
      if (!c.obj(p, b)) return
      if (c.str(`${p}.name`, b.name)) {
        if (biomeNames.includes(b.name)) c.fail(`${p}.name`, `duplicate biome "${b.name}"`)
        else biomeNames.push(b.name)
      }
      if (c.arr(`${p}.surface`, b.surface)) b.surface.forEach((r, j) => checkRule(c, `${p}.surface[${j}]`, r))
      if (c.obj(`${p}.trees`, b.trees, true)) {
        c.num(`${p}.trees.density`, b.trees.density, { min: 0, max: 1 })
        if (c.arr(`${p}.trees.kinds`, b.trees.kinds, 1)) b.trees.kinds.forEach((k, j) => c.str(`${p}.trees.kinds[${j}]`, k, TREE_KINDS))
        if (c.arr(`${p}.trees.on`, b.trees.on, 1, true)) b.trees.on.forEach((k, j) => c.str(`${p}.trees.on[${j}]`, k))
      }
      if (c.obj(`${p}.rocks`, b.rocks, true)) {
        c.num(`${p}.rocks.density`, b.rocks.density, { min: 0, max: 1 })
        if (c.range(`${p}.rocks.size`, b.rocks.size) && (b.rocks.size[0] < 1 || b.rocks.size[1] > 6)) c.fail(`${p}.rocks.size`, 'must be within [1, 6]')
      }
    })
  }

  if (c.obj('biomeRule', d.biomeRule)) {
    const r = d.biomeRule
    c.str('biomeRule.default', r.default, biomeNames)
    checkNoise(c, 'biomeRule.moisture', r.moisture, true)
    if (c.arr('biomeRule.rules', r.rules, 0, true)) {
      r.rules.forEach((e, i) => {
        const p = `biomeRule.rules[${i}]`
        if (!c.obj(p, e)) return
        c.str(`${p}.biome`, e.biome, biomeNames)
        c.num(`${p}.minHeight`, e.minHeight, { optional: true })
        c.num(`${p}.maxHeight`, e.maxHeight, { optional: true })
        c.range(`${p}.moisture`, e.moisture, true)
      })
    }
  }

  const outOps: OpDef[] = []
  if (c.arr('ops', d.ops)) {
    const ids = new Set<string>()
    d.ops.forEach((raw, i) => {
      const p = `ops[${i}]`
      if (!c.obj(p, raw)) return
      if (c.str(`${p}.id`, raw.id)) {
        if (ids.has(raw.id)) c.fail(`${p}.id`, `duplicate id "${raw.id}"`)
        ids.add(raw.id)
      }
      const impl = typeof raw.type === 'string' ? ops.get(raw.type) : undefined
      if (!impl) {
        c.fail(`${p}.type`, typeof raw.type === 'string' ? `unknown op type "${raw.type}" (known: ${ops.types().join(', ')})` : 'is required')
        return
      }
      c.bool(`${p}.enabled`, raw.enabled, true)
      if (raw.blend !== undefined) {
        if (impl.kind !== 'height') c.fail(`${p}.blend`, 'only height ops take a blend')
        else c.str(`${p}.blend`, raw.blend, BLEND_MODES)
      }
      const params = raw.params === undefined ? {} : raw.params
      if (!c.obj(`${p}.params`, params)) return
      if (!checkShape(c, `${p}.shape`, raw.shape, impl.shapes, impl.needY ?? false)) return
      const op: OpDef = {
        id: String(raw.id), type: impl.type, enabled: raw.enabled !== false,
        shape: raw.shape as ShapeDef, params: params as Record<string, unknown>,
      }
      if (raw.blend !== undefined) op.blend = raw.blend as BlendMode
      impl.validate(c, p, op, { biomes: biomeNames, height })
      outOps.push(op)
    })
  }

  const size = Array.isArray(d.size) ? d.size : null
  if (size && size.length === 2) checkLayers(c, 'layers', d.layers, Number(size[0]), Number(size[1]))

  if (c.errors.length > 0) return { ok: false, errors: c.errors }
  const doc: TerrainDoc = {
    format: TERRAIN_FORMAT, version: TERRAIN_VERSION,
    size: [...(d.size as [number, number])],
    seaLevel: d.seaLevel as number,
    blocks: { ...DEFAULT_BLOCKS, ...(d.blocks as Partial<BlockNames> | undefined) },
    base: d.base as unknown as TerrainDoc['base'],
    biomes: d.biomes as TerrainDoc['biomes'],
    biomeRule: d.biomeRule as unknown as TerrainDoc['biomeRule'],
    ops: outOps,
    layers: (d.layers ?? {}) as TerrainDoc['layers'],
  }
  return { ok: true, doc }
}

function checkRule(c: Check, p: string, r: unknown): void {
  if (!c.obj(p, r)) return
  const hasBands = c.obj(`${p}.bands`, r.bands, true)
  c.str(`${p}.block`, r.block, undefined, hasBands)
  if (hasBands) {
    const b = r.bands as Record<string, unknown>
    if (c.arr(`${p}.bands.blocks`, b.blocks, 1)) b.blocks.forEach((k, j) => c.str(`${p}.bands.blocks[${j}]`, k))
    c.num(`${p}.bands.thickness`, b.thickness, { int: true, min: 1 })
  }
  if (c.range(`${p}.depth`, r.depth, true) && r.depth[0] < 0) c.fail(`${p}.depth`, 'must be >= 0')
  c.range(`${p}.slope`, r.slope, true)
  c.range(`${p}.y`, r.y, true)
  c.bool(`${p}.underwater`, r.underwater, true)
  c.num(`${p}.nearWater`, r.nearWater, { min: 0, optional: true })
  c.bool(`${p}.ceiling`, r.ceiling, true)
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npm test -w @elovox/terrain` then `npm run typecheck -w @elovox/terrain`
Expected: all pass. The error-list tests pin message text and order. If one fails, compare the strings: the editor (2c) will show them to people.

- [ ] **Step 6: Commit**

```bash
git add packages/terrain/src/ops packages/terrain/src/doc/validate.ts packages/terrain/test/fixtures.ts packages/terrain/test/validate.test.ts
git commit -m "feat(terrain): op registry and TerrainDoc validation with error paths"
```


### Task 7: Height ops — hills, mountain, plateau, flatten, biome

**Files:**
- Create: `packages/terrain/src/ops/common.ts`, `hills.ts`, `mountain.ts`, `plateau.ts`, `flatten.ts`, `biome.ts` (all in `packages/terrain/src/ops/`)
- Modify: `packages/terrain/src/ops/builtin.ts`
- Test: `packages/terrain/test/heightOps.test.ts`

**Interfaces:**
- Consumes: `defineTerrainOp`, `Cell`, `CompileContext`, `HeightOpImpl` (Task 6), shapes/profiles/blend (Task 4), `makeNoise2/3` (Task 2), `Check`/`checkNoise` (Task 3).
- Produces:
  - `param`, `paramStr`, `noise2Of`, `noise3Of`, `checkParamNum`, `checkParamProfile`, `checkParamNoise` and `checkParamMode` (in `common.ts`).
  - The op impls `hills`, `mountain`, `plateau` (plus `terrace(t, k)`), `flatten` and `biome`.

Op params, as the showcase and the editor use them:

| Op | Params (defaults) | Shapes | Default blend |
|---|---|---|---|
| `hills` | `amplitude`, `offset` (0), `noise` ({scale 64}) | any | `add` |
| `mountain` | `height`, `roughness` (0.5), `profile` ('smooth'), `noise` (ridged, scale 96, 5 octaves) | circle, path | `add` |
| `plateau` | `top`, `base`, `wall` (6), `terraces` (0), `jitter` (0), `noise` | circle, polygon | `max` |
| `flatten` | `y` | any | `set` |
| `biome` | `biome`, `jitter` (0), `noise` ({scale 48}) | any | — |

- [ ] **Step 1: Write the failing test**

`packages/terrain/test/heightOps.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Check } from '../src/doc/check.ts'
import type { OpDef } from '../src/doc/types.ts'
import { biome } from '../src/ops/biome.ts'
import { flatten } from '../src/ops/flatten.ts'
import { hills } from '../src/ops/hills.ts'
import { mountain } from '../src/ops/mountain.ts'
import { plateau, terrace } from '../src/ops/plateau.ts'
import type { Cell, CompileContext, HeightOpImpl } from '../src/ops/registry.ts'

const ctx: CompileContext = { seed: 7, height: 128, seaLevel: 10, biomeIndex: (n) => ['plain', 'mesa'].indexOf(n) }
const cell = (h = 40): Cell => ({ h, water: -1, wet: -Infinity, biome: -1 })
function run(impl: HeightOpImpl, def: Omit<OpDef, 'type' | 'enabled'>, x: number, z: number, h = 40): Cell {
  const c = cell(h)
  impl.compile({ ...def, type: impl.type, enabled: true }, ctx).apply(x, z, c)
  return c
}
function errors(impl: HeightOpImpl, params: Record<string, unknown>): string[] {
  const c = new Check()
  impl.validate(c, 'ops[0]', { id: 'a', type: impl.type, enabled: true, shape: { kind: 'circle', center: [0, 0], radius: 5 }, params }, { biomes: ['plain', 'mesa'], height: 128 })
  return c.errors
}
const disc = (radius: number, falloff = 0) => ({ kind: 'circle' as const, center: [100, 100] as [number, number], radius, falloff })

describe('hills', () => {
  it('adds offset + amplitude * noise inside, fading over the falloff', () => {
    const def = { id: 'h', shape: disc(20, 10), params: { amplitude: 0, offset: 6 } }
    expect(run(hills, def, 100, 100).h).toBe(46)
    expect(run(hills, def, 125, 100).h).toBeCloseTo(43, 5) // 5 of 10 blocks into the falloff
    expect(run(hills, def, 140, 100).h).toBe(40)
  })
  it('lowers an area with blend min (a sea floor)', () => {
    expect(run(hills, { id: 'h', shape: disc(20), params: { amplitude: 0, offset: 12 }, blend: 'min' }, 100, 100).h).toBe(12)
  })
  it('validates params', () => {
    expect(errors(hills, { amplitude: -1, noise: { scale: 0 } })).toEqual(['ops[0].params.amplitude: must be >= 0', 'ops[0].params.noise.scale: must be > 0'])
  })
})

describe('mountain', () => {
  it('peaks at the centre and vanishes at the edge', () => {
    const def = { id: 'm', shape: disc(50), params: { height: 60, roughness: 0 } }
    expect(run(mountain, def, 100, 100).h).toBe(100)
    expect(run(mountain, def, 125, 100).h).toBe(70) // smoothstep(0.5) = 0.5
    expect(run(mountain, def, 150, 100).h).toBe(40)
  })
  it('roughness modulates height with ridged noise, never above the full height', () => {
    const def = { id: 'm', shape: disc(50), params: { height: 60, roughness: 1 } }
    const hs = [0, 3, 6, 9, 12].map((d) => run(mountain, def, 100 + d, 100).h)
    for (const h of hs) { expect(h).toBeGreaterThanOrEqual(40); expect(h).toBeLessThanOrEqual(100) }
    expect(new Set(hs).size).toBeGreaterThan(1)
  })
  it('follows a path as a range', () => {
    const def = { id: 'r', shape: { kind: 'path' as const, width: 40, points: [{ x: 0, z: 0 }, { x: 200, z: 0 }] }, params: { height: 50, roughness: 0, profile: 'linear' } }
    expect(run(mountain, def, 120, 0).h).toBe(90)
    expect(run(mountain, def, 120, 10).h).toBe(65)
  })
})

describe('plateau', () => {
  it('terrace() rises from 0 to 1 in flat steps', () => {
    expect(terrace(0, 3)).toBe(0)
    expect(terrace(1, 3)).toBe(1)
    expect(terrace(0.4, 3)).toBeCloseTo(1 / 3, 10) // on the first tread
    expect(terrace(0.5, 0)).toBe(0.5)
  })
  it('raises a mesa with a wall `wall` blocks wide and leaves outside ground alone', () => {
    const def = { id: 'p', shape: disc(30), params: { top: 80, base: 40, wall: 10 } }
    expect(run(plateau, def, 100, 100).h).toBe(80)
    expect(run(plateau, def, 125, 100).h).toBe(60) // 5 of 10 wall blocks in
    expect(run(plateau, def, 135, 100, 20).h).toBe(20) // outside: low ground is not raised
    expect(run(plateau, def, 100, 100, 90).h).toBe(90) // blend max: higher ground wins
  })
  it('validates top and base against the world height', () => {
    expect(errors(plateau, { top: 200, base: 10, terraces: 1.5 })).toEqual(['ops[0].params.top: must be <= 128', 'ops[0].params.terraces: must be an integer'])
  })
})

describe('flatten', () => {
  it('sets the height inside and blends over the falloff', () => {
    const def = { id: 'f', shape: disc(10, 10), params: { y: 50 } }
    expect(run(flatten, def, 100, 100).h).toBe(50)
    expect(run(flatten, def, 115, 100).h).toBe(45)
    expect(run(flatten, def, 121, 100).h).toBe(40)
  })
})

describe('biome', () => {
  it('sets the biome index where the weight is >= 0.5', () => {
    const def = { id: 'b', shape: disc(10, 10), params: { biome: 'mesa' } }
    expect(run(biome, def, 100, 100).biome).toBe(1)
    expect(run(biome, def, 114, 100).biome).toBe(1)
    expect(run(biome, def, 116, 100).biome).toBe(-1)
    expect(run(biome, def, 100, 100).h).toBe(40)
  })
  it('jitters its border with noise', () => {
    const def = { id: 'b', shape: { kind: 'polygon' as const, points: [[0, 0], [200, 0], [200, 200], [0, 200]] as [number, number][] }, params: { biome: 'mesa', jitter: 12 } }
    const along = Array.from({ length: 60 }, (_, i) => run(biome, def, i * 3, 2).biome) // 2 blocks inside the top edge
    expect(along).toContain(1)
    expect(along).toContain(-1)
  })
  it('rejects unknown biomes', () => {
    expect(errors(biome, { biome: 'swamp' })).toEqual(['ops[0].params.biome: must be one of plain, mesa'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @elovox/terrain`
Expected: FAIL — cannot resolve `../src/ops/biome.ts`.

- [ ] **Step 3: Implement the shared param helpers**

`packages/terrain/src/ops/common.ts`:

```ts
import { Check, checkNoise } from '../doc/check.ts'
import type { OpDef } from '../doc/types.ts'
import { makeNoise2, makeNoise3, type NoiseDef, type Sampler2, type Sampler3 } from '../noise/def.ts'
import { PROFILES, type Profile } from '../shapes/profile.ts'

/** Typed reads of already-validated params. */
export function param(def: OpDef, key: string, fallback: number): number {
  const v = def.params[key]
  return typeof v === 'number' ? v : fallback
}
export function paramStr<T extends string>(def: OpDef, key: string, fallback: T): T {
  const v = def.params[key]
  return typeof v === 'string' ? (v as T) : fallback
}
export function noise2Of(def: OpDef, key: string, fallback: NoiseDef, seed: number): Sampler2 {
  return makeNoise2((def.params[key] as NoiseDef | undefined) ?? fallback, seed)
}
export function noise3Of(def: OpDef, key: string, fallback: NoiseDef, seed: number): Sampler3 {
  return makeNoise3((def.params[key] as NoiseDef | undefined) ?? fallback, seed)
}

/** Validation shorthands for `${path}.params.<key>`. */
export function checkParamNum(c: Check, path: string, def: OpDef, key: string, o: Parameters<Check['num']>[2]): void {
  c.num(`${path}.params.${key}`, def.params[key], o)
}
export function checkParamProfile(c: Check, path: string, def: OpDef, key = 'profile'): void {
  c.str(`${path}.params.${key}`, def.params[key], PROFILES, true)
}
export function checkParamNoise(c: Check, path: string, def: OpDef, key = 'noise'): void {
  checkNoise(c, `${path}.params.${key}`, def.params[key], true)
}
export function checkParamMode(c: Check, path: string, def: OpDef): void {
  c.str(`${path}.params.mode`, def.params.mode, ['add', 'carve'], true)
}

export type { Profile }
```

- [ ] **Step 4: Implement the ops**

`packages/terrain/src/ops/hills.ts`:

```ts
import { expandRect } from '../geom.ts'
import { blend } from '../shapes/blend.ts'
import { compileShape, newSample, weight } from '../shapes/shape.ts'
import { checkParamNoise, checkParamNum, noise2Of, param } from './common.ts'
import { defineTerrainOp } from './registry.ts'

/**
 * Procedural fill inside an area: value = offset + amplitude * noise (noise in [0, 1]).
 * Default blend 'add' (bumps on top of the ground); with 'min' and a low offset it lowers an area
 * into a sea floor; with 'set' it replaces the ground.
 */
export const hills = defineTerrainOp({
  type: 'hills', kind: 'height', defaultBlend: 'add', shapes: ['circle', 'polygon', 'path'],
  validate(c, path, def) {
    checkParamNum(c, path, def, 'amplitude', { min: 0 })
    checkParamNum(c, path, def, 'offset', { optional: true })
    checkParamNoise(c, path, def)
  },
  compile(def, ctx) {
    const shape = compileShape(def.shape)
    const amplitude = param(def, 'amplitude', 0), offset = param(def, 'offset', 0)
    const noise = noise2Of(def, 'noise', { scale: 64 }, ctx.seed)
    const mode = def.blend ?? 'add'
    const s = newSample()
    return {
      id: def.id,
      bounds: expandRect(shape.bounds, shape.falloff),
      apply(x, z, cell) {
        shape.sample(x, z, s)
        const w = weight(s, shape.falloff)
        if (w > 0) cell.h = blend(mode, cell.h, offset + amplitude * noise(x, z), w)
      },
    }
  },
})
```

`packages/terrain/src/ops/mountain.ts`:

```ts
import { blend } from '../shapes/blend.ts'
import { profile } from '../shapes/profile.ts'
import { compileShape, newSample } from '../shapes/shape.ts'
import { checkParamNoise, checkParamNum, checkParamProfile, noise2Of, param, paramStr, type Profile } from './common.ts'
import { defineTerrainOp } from './registry.ts'

/**
 * A peak (circle) or a range (path): value = height * profile(edge) * (1 - roughness + roughness * noise).
 * The default noise is ridged, which gives sharp crests. Default blend 'add'.
 */
export const mountain = defineTerrainOp({
  type: 'mountain', kind: 'height', defaultBlend: 'add', shapes: ['circle', 'path'],
  validate(c, path, def) {
    checkParamNum(c, path, def, 'height', { min: 0 })
    checkParamNum(c, path, def, 'roughness', { min: 0, max: 1, optional: true })
    checkParamProfile(c, path, def)
    checkParamNoise(c, path, def)
  },
  compile(def, ctx) {
    const shape = compileShape(def.shape)
    const height = param(def, 'height', 0), roughness = param(def, 'roughness', 0.5)
    const prof = paramStr<Profile>(def, 'profile', 'smooth')
    const noise = noise2Of(def, 'noise', { type: 'ridged', scale: 96, octaves: 5 }, ctx.seed)
    const mode = def.blend ?? 'add'
    const s = newSample()
    return {
      id: def.id,
      bounds: shape.bounds,
      apply(x, z, cell) {
        shape.sample(x, z, s)
        if (s.edge >= 1) return
        const v = height * profile(prof, s.edge) * (1 - roughness + roughness * noise(x, z))
        cell.h = blend(mode, cell.h, v, 1)
      },
    }
  },
})
```

`packages/terrain/src/ops/plateau.ts`:

```ts
import { clamp, expandRect } from '../geom.ts'
import { blend } from '../shapes/blend.ts'
import { smoothstep01 } from '../shapes/profile.ts'
import { compileShape, newSample } from '../shapes/shape.ts'
import { checkParamNoise, checkParamNum, noise2Of, param } from './common.ts'
import { defineTerrainOp } from './registry.ts'

/** 0 → 1 rise; with k terraces, flat treads joined by steep smooth risers. */
export function terrace(t: number, k: number): number {
  if (k <= 0) return smoothstep01(t)
  const x = t * k
  const i = Math.floor(x)
  return Math.min(1, (i + smoothstep01((x - i - 0.65) / 0.35)) / k)
}

/**
 * A mesa: rises from `base` at the shape's edge to `top` over `wall` blocks inward, optionally in
 * `terraces` steps. `jitter` (blocks) roughens the wall line with noise. Default blend 'max', so the
 * wall's foot merges with higher ground.
 */
export const plateau = defineTerrainOp({
  type: 'plateau', kind: 'height', defaultBlend: 'max', shapes: ['circle', 'polygon'],
  validate(c, path, def, ctx) {
    checkParamNum(c, path, def, 'top', { min: 0, max: ctx.height })
    checkParamNum(c, path, def, 'base', { min: 0, max: ctx.height })
    checkParamNum(c, path, def, 'wall', { gt: 0, optional: true })
    checkParamNum(c, path, def, 'terraces', { int: true, min: 0, max: 16, optional: true })
    checkParamNum(c, path, def, 'jitter', { min: 0, optional: true })
    checkParamNoise(c, path, def)
  },
  compile(def, ctx) {
    const shape = compileShape(def.shape)
    const top = param(def, 'top', 0), base = param(def, 'base', 0)
    const wall = param(def, 'wall', 6), k = param(def, 'terraces', 0), jitter = param(def, 'jitter', 0)
    const noise = noise2Of(def, 'noise', { scale: 24, octaves: 3 }, ctx.seed)
    const mode = def.blend ?? 'max'
    const s = newSample()
    return {
      id: def.id,
      bounds: expandRect(shape.bounds, jitter),
      apply(x, z, cell) {
        shape.sample(x, z, s)
        const inward = -s.dist + (jitter > 0 ? jitter * (noise(x, z) * 2 - 1) : 0)
        if (inward <= 0) return
        const v = base + (top - base) * terrace(clamp(inward / wall, 0, 1), k)
        cell.h = blend(mode, cell.h, v, 1)
      },
    }
  },
})
```

`packages/terrain/src/ops/flatten.ts`:

```ts
import { expandRect } from '../geom.ts'
import { blend } from '../shapes/blend.ts'
import { compileShape, newSample, weight } from '../shapes/shape.ts'
import { checkParamNum, param } from './common.ts'
import { defineTerrainOp } from './registry.ts'

/** A flat site at height `y`, blended into the surroundings over the shape's falloff. Default blend 'set'. */
export const flatten = defineTerrainOp({
  type: 'flatten', kind: 'height', defaultBlend: 'set', shapes: ['circle', 'polygon', 'path'],
  validate(c, path, def, ctx) {
    checkParamNum(c, path, def, 'y', { min: 0, max: ctx.height })
  },
  compile(def) {
    const shape = compileShape(def.shape)
    const y = param(def, 'y', 0)
    const mode = def.blend ?? 'set'
    const s = newSample()
    return {
      id: def.id,
      bounds: expandRect(shape.bounds, shape.falloff),
      apply(x, z, cell) {
        shape.sample(x, z, s)
        const w = weight(s, shape.falloff)
        if (w > 0) cell.h = blend(mode, cell.h, y, w)
      },
    }
  },
})
```

`packages/terrain/src/ops/biome.ts`:

```ts
import { expandRect } from '../geom.ts'
import { compileShape, newSample, weight } from '../shapes/shape.ts'
import { checkParamNoise, checkParamNum, noise2Of, param } from './common.ts'
import { defineTerrainOp } from './registry.ts'

/**
 * Paints a biome over an area (where the falloff weight is at least 0.5). `jitter` (blocks) moves the
 * border in and out with noise so it does not follow the shape's straight edges. Changes no height.
 */
export const biome = defineTerrainOp({
  type: 'biome', kind: 'height', defaultBlend: 'set', shapes: ['circle', 'polygon', 'path'],
  validate(c, path, def, ctx) {
    c.str(`${path}.params.biome`, def.params.biome, ctx.biomes)
    checkParamNum(c, path, def, 'jitter', { min: 0, optional: true })
    checkParamNoise(c, path, def)
  },
  compile(def, ctx) {
    const shape = compileShape(def.shape)
    const index = ctx.biomeIndex(String(def.params.biome))
    const jitter = param(def, 'jitter', 0)
    const noise = noise2Of(def, 'noise', { scale: 48, octaves: 3 }, ctx.seed)
    const s = newSample()
    return {
      id: def.id,
      bounds: expandRect(shape.bounds, shape.falloff + jitter),
      apply(x, z, cell) {
        shape.sample(x, z, s)
        if (jitter > 0) s.dist += jitter * (noise(x, z) * 2 - 1)
        if (weight(s, shape.falloff) >= 0.5) cell.biome = index
      },
    }
  },
})
```

- [ ] **Step 5: Register them**

Replace `packages/terrain/src/ops/builtin.ts` with:

```ts
import { biome } from './biome.ts'
import { flatten } from './flatten.ts'
import { hills } from './hills.ts'
import { mountain } from './mountain.ts'
import { plateau } from './plateau.ts'
import { OpRegistry, type OpImpl } from './registry.ts'

/** Every built-in op, in a stable order. */
export const BUILTIN_OPS: readonly OpImpl[] = [hills, mountain, plateau, flatten, biome]

export const builtinOps = new OpRegistry(BUILTIN_OPS)
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npm test -w @elovox/terrain` then `npm run typecheck -w @elovox/terrain`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/terrain/src/ops packages/terrain/test/heightOps.test.ts
git commit -m "feat(terrain): hills, mountain, plateau, flatten and biome ops"
```

### Task 8: Height ops with water — valley, river, lake

**Files:**
- Create: `packages/terrain/src/ops/valley.ts`, `packages/terrain/src/ops/river.ts`, `packages/terrain/src/ops/lake.ts`
- Modify: `packages/terrain/src/ops/builtin.ts`
- Test: `packages/terrain/test/waterOps.test.ts`

**Interfaces:**
- Consumes: the same as Task 7.
- Produces: `valley`, `river` and `lake`. River and lake set `cell.water` (non-solid voxels below it become water) and `cell.wet` (the reference for `nearWater` surface rules on banks and shores).

| Op | Params (defaults) | Shapes | Default blend |
|---|---|---|---|
| `valley` | `depth`, `profile` ('round'; 'box' = canyon), `noiseAmount` (0), `noise` | path, circle, polygon | `carve` |
| `river` | `start`, `end` (water levels), `depth` (3), `bank` (16), `bankSlope` (0.5) | path | `min` |
| `lake` | `level`, `depth` (6), `shore` (16), `shoreSlope` (0.4) | circle, polygon | `min` |

Banks and shores fade back into the ground over the outer half of `bank`/`shore`. Without that fade, a river through high ground leaves a cliff where its bank ends; the prototype's top-down render showed one.

- [ ] **Step 1: Write the failing test**

`packages/terrain/test/waterOps.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Check } from '../src/doc/check.ts'
import type { OpDef } from '../src/doc/types.ts'
import { lake } from '../src/ops/lake.ts'
import type { Cell, CompileContext, HeightOpImpl } from '../src/ops/registry.ts'
import { river } from '../src/ops/river.ts'
import { valley } from '../src/ops/valley.ts'

const ctx: CompileContext = { seed: 7, height: 128, seaLevel: 10, biomeIndex: () => 0 }
function run(impl: HeightOpImpl, def: Omit<OpDef, 'type' | 'enabled'>, x: number, z: number, h = 40): Cell {
  const c: Cell = { h, water: -1, wet: -Infinity, biome: -1 }
  impl.compile({ ...def, type: impl.type, enabled: true }, ctx).apply(x, z, c)
  return c
}
const straight = (width: number) => ({ kind: 'path' as const, width, points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] })

describe('valley', () => {
  it('carves a U across the path, deepest on the axis', () => {
    const def = { id: 'v', shape: straight(20), params: { depth: 10 } }
    expect(run(valley, def, 50, 0).h).toBe(30)
    expect(run(valley, def, 50, 6).h).toBeCloseTo(32, 10) // round(0.6) = 0.8
    expect(run(valley, def, 50, 10).h).toBe(40)
  })
  it('makes a canyon with the box profile', () => {
    const def = { id: 'v', shape: straight(20), params: { depth: 30, profile: 'box' } }
    expect(run(valley, def, 50, 7).h).toBe(10)
    expect(run(valley, def, 50, 9.5).h).toBeGreaterThan(10)
  })
})

describe('river', () => {
  const def = { id: 'r', shape: straight(8), params: { start: 30, end: 20, depth: 2, bank: 10, bankSlope: 0.5 } }
  it('steps the water level down along the path in whole blocks', () => {
    expect(run(river, def, 0, 0).water).toBe(30)
    expect(run(river, def, 55, 0).water).toBe(24) // 30 - 5.5 floored
    expect(run(river, def, 100, 0).water).toBe(20)
  })
  it('cuts a bed below the water and banks that climb outward', () => {
    expect(run(river, def, 50, 0).h).toBe(25 - 1 - 2)
    const edge = run(river, def, 50, 4)
    expect(edge.h).toBe(24) // level - 1 at the channel edge: one block of water
    expect(edge.water).toBe(25)
    const bank = run(river, def, 50, 8)
    expect(bank.h).toBe(26) // 4 blocks out at slope 0.5
    expect(bank.water).toBe(-1)
    expect(bank.wet).toBe(25)
  })
  it('fades the banks back into high ground instead of leaving a step', () => {
    const at = (z: number) => run(river, def, 50, z, 60).h
    expect(at(8)).toBe(26) // inner half of the bank: full cut
    expect(at(11.5)).toBeGreaterThan(at(10))
    expect(at(14)).toBe(60) // bank edge: back to the ground
    for (let z = 9; z < 14; z += 0.5) expect(at(z + 0.5) - at(z)).toBeLessThan(12) // no cliff
  })
  it('leaves low ground alone and stops past the bank', () => {
    expect(run(river, def, 50, 8, 20).h).toBe(20)
    const far = run(river, def, 50, 15)
    expect([far.h, far.wet]).toEqual([40, -Infinity])
  })
  it('validates levels', () => {
    const c = new Check()
    river.validate(c, 'ops[0]', { id: 'r', type: 'river', enabled: true, shape: straight(4), params: { start: 0 } }, { biomes: [], height: 128 })
    expect(c.errors).toEqual(['ops[0].params.start: must be >= 1', 'ops[0].params.end: is required'])
  })
})

describe('lake', () => {
  const def = { id: 'l', shape: { kind: 'circle' as const, center: [0, 0] as [number, number], radius: 20 }, params: { level: 30, depth: 5, shore: 10, shoreSlope: 0.5 } }
  it('fills a basin with water to its level', () => {
    const mid = run(lake, def, 0, 0)
    expect(mid.h).toBe(24)
    expect(mid.water).toBe(30)
    const rim = run(lake, def, 19, 0)
    expect(rim.h).toBe(30 - 1 - 1.5)
  })
  it('shapes a shore that rises outside the shape', () => {
    const shore = run(lake, def, 24, 0)
    expect(shore.h).toBe(31)
    expect(shore.water).toBe(-1)
    expect(shore.wet).toBe(30)
    expect(run(lake, def, 31, 0).wet).toBe(-Infinity)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @elovox/terrain`
Expected: FAIL — cannot resolve `../src/ops/lake.ts`.

- [ ] **Step 3: Implement**

`packages/terrain/src/ops/valley.ts`:

```ts
import { blend } from '../shapes/blend.ts'
import { profile } from '../shapes/profile.ts'
import { compileShape, newSample } from '../shapes/shape.ts'
import { checkParamNoise, checkParamNum, checkParamProfile, noise2Of, param, paramStr, type Profile } from './common.ts'
import { defineTerrainOp } from './registry.ts'

/**
 * Cuts a valley (profile 'round' = U, 'linear' = V) or a canyon (profile 'box') along a path or in
 * an area: value = profile(edge) * (depth + noiseAmount * (2 * noise - 1)). Default blend 'carve'.
 */
export const valley = defineTerrainOp({
  type: 'valley', kind: 'height', defaultBlend: 'carve', shapes: ['path', 'circle', 'polygon'],
  validate(c, path, def) {
    checkParamNum(c, path, def, 'depth', { min: 0 })
    checkParamNum(c, path, def, 'noiseAmount', { min: 0, optional: true })
    checkParamProfile(c, path, def)
    checkParamNoise(c, path, def)
  },
  compile(def, ctx) {
    const shape = compileShape(def.shape)
    const depth = param(def, 'depth', 0), amount = param(def, 'noiseAmount', 0)
    const prof = paramStr<Profile>(def, 'profile', 'round')
    const noise = noise2Of(def, 'noise', { scale: 32, octaves: 3 }, ctx.seed)
    const mode = def.blend ?? 'carve'
    const s = newSample()
    return {
      id: def.id,
      bounds: shape.bounds,
      apply(x, z, cell) {
        shape.sample(x, z, s)
        if (s.edge >= 1) return
        const v = profile(prof, s.edge) * (depth + (amount > 0 ? amount * (noise(x, z) * 2 - 1) : 0))
        cell.h = blend(mode, cell.h, v, 1)
      },
    }
  },
})
```

`packages/terrain/src/ops/river.ts`:

```ts
import { expandRect } from '../geom.ts'
import { blend } from '../shapes/blend.ts'
import { smoothstep01 } from '../shapes/profile.ts'
import { compileShape, newSample } from '../shapes/shape.ts'
import { checkParamNum, param } from './common.ts'
import { defineTerrainOp } from './registry.ts'

/**
 * A river along a path. The water level goes from `start` (first point) to `end` (last point) in
 * whole-block steps. Inside the path's width the bed is a U `depth` blocks below the water; outside,
 * banks climb at `bankSlope` per block and fade back into the ground over the outer half of `bank`,
 * so the river cuts a valley through high ground without leaving a step. Default blend 'min'.
 */
export const river = defineTerrainOp({
  type: 'river', kind: 'height', defaultBlend: 'min', shapes: ['path'],
  validate(c, path, def, ctx) {
    checkParamNum(c, path, def, 'start', { min: 1, max: ctx.height - 1 })
    checkParamNum(c, path, def, 'end', { min: 1, max: ctx.height - 1 })
    checkParamNum(c, path, def, 'depth', { min: 0, optional: true })
    checkParamNum(c, path, def, 'bank', { min: 0, optional: true })
    checkParamNum(c, path, def, 'bankSlope', { gt: 0, optional: true })
  },
  compile(def) {
    const shape = compileShape(def.shape)
    const start = param(def, 'start', 1), end = param(def, 'end', 1)
    const depth = param(def, 'depth', 3), bank = param(def, 'bank', 16), slope = param(def, 'bankSlope', 0.5)
    const mode = def.blend ?? 'min'
    const s = newSample()
    return {
      id: def.id,
      bounds: expandRect(shape.bounds, bank),
      apply(x, z, cell) {
        shape.sample(x, z, s)
        const hw = s.width / 2
        const d = s.edge * hw // distance to the axis
        if (d > hw + bank) return
        const level = Math.floor(start + (end - start) * s.along)
        const target = d <= hw
          ? level - 1 - depth * Math.sqrt(1 - (d / hw) * (d / hw))
          : level - 1 + (d - hw) * slope
        const out = d - hw
        const fade = out <= bank * 0.5 ? 1 : smoothstep01((bank - out) / (bank * 0.5))
        cell.h = blend(mode, cell.h, target, fade)
        if (d <= hw && level > cell.water) cell.water = level
        if (level > cell.wet) cell.wet = level
      },
    }
  },
})
```

`packages/terrain/src/ops/lake.ts`:

```ts
import { expandRect } from '../geom.ts'
import { blend } from '../shapes/blend.ts'
import { smoothstep01 } from '../shapes/profile.ts'
import { compileShape, newSample } from '../shapes/shape.ts'
import { checkParamNum, param } from './common.ts'
import { defineTerrainOp } from './registry.ts'

/**
 * A lake: a basin under water `level`. The floor drops half a block per block inward, down to
 * `depth` below the water; the shore rises at `shoreSlope` per block outside the shape and fades back
 * into the ground over the outer half of `shore`. Default blend 'min'.
 */
export const lake = defineTerrainOp({
  type: 'lake', kind: 'height', defaultBlend: 'min', shapes: ['circle', 'polygon'],
  validate(c, path, def, ctx) {
    checkParamNum(c, path, def, 'level', { min: 1, max: ctx.height - 1 })
    checkParamNum(c, path, def, 'depth', { min: 1, optional: true })
    checkParamNum(c, path, def, 'shore', { min: 0, optional: true })
    checkParamNum(c, path, def, 'shoreSlope', { gt: 0, optional: true })
  },
  compile(def) {
    const shape = compileShape(def.shape)
    const level = Math.floor(param(def, 'level', 1))
    const depth = param(def, 'depth', 6), shore = param(def, 'shore', 16), slope = param(def, 'shoreSlope', 0.4)
    const mode = def.blend ?? 'min'
    const s = newSample()
    return {
      id: def.id,
      bounds: expandRect(shape.bounds, shore),
      apply(x, z, cell) {
        shape.sample(x, z, s)
        if (s.dist > shore) return
        const target = s.dist <= 0
          ? level - 1 - Math.min(depth, 1 + -s.dist * 0.5)
          : level - 1 + s.dist * slope
        const fade = s.dist <= shore * 0.5 ? 1 : smoothstep01((shore - s.dist) / (shore * 0.5))
        cell.h = blend(mode, cell.h, target, fade)
        if (s.dist <= 0 && level > cell.water) cell.water = level
        if (level > cell.wet) cell.wet = level
      },
    }
  },
})
```

- [ ] **Step 4: Register them**

In `packages/terrain/src/ops/builtin.ts`, add the imports and extend the list:

```ts
import { lake } from './lake.ts'
import { river } from './river.ts'
import { valley } from './valley.ts'
// …
export const BUILTIN_OPS: readonly OpImpl[] = [hills, mountain, plateau, flatten, biome, valley, river, lake]
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npm test -w @elovox/terrain` then `npm run typecheck -w @elovox/terrain`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/terrain/src/ops packages/terrain/test/waterOps.test.ts
git commit -m "feat(terrain): valley, river and lake ops with water and wet levels"
```

### Task 9: Volume ops — arch, cave, overhang, blob

**Files:**
- Create: `packages/terrain/src/ops/tube.ts`, `packages/terrain/src/ops/volume.ts`
- Modify: `packages/terrain/src/ops/builtin.ts`
- Test: `packages/terrain/test/volumeOps.test.ts`

**Interfaces:**
- Consumes: Tasks 2–7 (`noise3Of`, `checkParamMode`, …).
- Produces:
  - `TubePoint`, `compileTube(points, pad): { bounds, field }` and `archCurve(p0, p2, rise, segments)`.
  - The volume ops `arch`, `cave`, `overhang` and `blob`. All four return a `VolumeOp` whose `density` is a signed distance-like field in blocks (> 0 inside), with `mode` 'add' (solid = max) or 'carve' (solid = min with −density).

| Op | Shape | Params (defaults) | Default mode |
|---|---|---|---|
| `arch` | path with exactly 2 points, each with `y` | `rise`, `height` (= width), `wobble` (1.5), `noise` | add |
| `cave` | path, every point with `y` | `height` (= width), `wobble` (2), `noise` | carve |
| `overhang` | path, every point with `y` | `height` (= width / 3), `wobble` (1), `noise` | carve |
| `blob` | circle | `y`, `height` (vertical radius), `wobble` (2), `noise` | add |

`mode` can be overridden on any of them: an `overhang` with mode `add` builds a ledge, a `blob` with mode `carve` digs a pit, and so on.

- [ ] **Step 1: Write the failing test**

`packages/terrain/test/volumeOps.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Check } from '../src/doc/check.ts'
import type { OpDef } from '../src/doc/types.ts'
import type { CompileContext, VolumeOpImpl } from '../src/ops/registry.ts'
import { archCurve, compileTube } from '../src/ops/tube.ts'
import { arch, blob, cave, overhang } from '../src/ops/volume.ts'

const ctx: CompileContext = { seed: 3, height: 128, seaLevel: 10, biomeIndex: () => 0 }
function compile(impl: VolumeOpImpl, def: Omit<OpDef, 'type' | 'enabled'>) {
  return impl.compile({ ...def, type: impl.type, enabled: true }, ctx)
}

describe('compileTube', () => {
  const tube = compileTube([{ x: 0, y: 50, z: 0, hw: 4, hh: 2 }, { x: 40, y: 50, z: 0, hw: 4, hh: 2 }], 0)
  it('is positive inside the elliptical section, 0 on the wall, negative outside', () => {
    expect(tube.field(20, 50, 0)).toBe(2)
    expect(tube.field(20, 50, 4)).toBe(0)
    expect(tube.field(20, 52, 0)).toBe(0)
    expect(tube.field(20, 50, 8)).toBeLessThan(0)
  })
  it('bounds the tube with its radii', () => {
    expect(tube.bounds).toEqual({ x0: -4, x1: 44, y0: 48, y1: 52, z0: -4, z1: 4 })
  })
  it('archCurve peaks `rise` above the endpoints', () => {
    const pts = archCurve({ x: 0, y: 10, z: 0, hw: 2, hh: 2 }, { x: 20, y: 10, z: 0, hw: 2, hh: 2 }, 8, 24)
    expect(pts).toHaveLength(25)
    expect(pts[12]).toEqual({ x: 10, y: 18, z: 0, hw: 2, hh: 2 })
  })
})

describe('arch', () => {
  const op = compile(arch, {
    id: 'a', shape: { kind: 'path', width: 4, points: [{ x: 0, z: 0, y: 40 }, { x: 30, z: 0, y: 40 }] }, params: { rise: 12, wobble: 0 },
  })
  it('adds solid along the curve and leaves the space under it open', () => {
    expect(op.mode).toBe('add')
    expect(op.density(15, 52, 0)).toBeGreaterThan(1) // the keystone
    expect(op.density(15, 44, 0)).toBeLessThan(0) // under the arch
  })
  it('requires exactly two points with y', () => {
    const c = new Check()
    arch.validate(c, 'ops[0]', { id: 'a', type: 'arch', enabled: true, shape: { kind: 'path', width: 4, points: [{ x: 0, z: 0, y: 1 }, { x: 1, z: 0, y: 1 }, { x: 2, z: 0, y: 1 }] }, params: {} }, { biomes: [], height: 128 })
    expect(c.errors).toEqual(['ops[0].shape.points: an arch takes exactly 2 points', 'ops[0].params.rise: is required'])
  })
})

describe('cave and overhang', () => {
  it('cave carves a round tunnel', () => {
    const op = compile(cave, { id: 'c', shape: { kind: 'path', width: 6, points: [{ x: 0, z: 0, y: 30 }, { x: 0, z: 40, y: 20 }] }, params: { wobble: 0 } })
    expect(op.mode).toBe('carve')
    expect(op.density(0, 25, 20)).toBe(3)
  })
  it('overhang is flat: a third as tall as it is wide by default', () => {
    const op = compile(overhang, { id: 'o', shape: { kind: 'path', width: 12, points: [{ x: 0, z: 0, y: 30 }, { x: 40, z: 0, y: 30 }] }, params: { wobble: 0 } })
    expect(op.density(20, 30, 5.9)).toBeGreaterThan(0)
    expect(op.density(20, 32.1, 0)).toBeLessThan(0)
  })
})

describe('blob', () => {
  const op = compile(blob, { id: 'b', shape: { kind: 'circle', center: [100, 100], radius: 10 }, params: { y: 90, height: 4, wobble: 0 } })
  it('is an ellipsoid at y with vertical radius `height`', () => {
    expect(op.density(100, 90, 100)).toBe(4)
    expect(op.density(110, 90, 100)).toBe(0)
    expect(op.density(100, 94, 100)).toBe(0)
    expect(op.bounds).toEqual({ x0: 90, x1: 110, y0: 86, y1: 94, z0: 90, z1: 110 })
  })
  it('wobbles with noise and pads its bounds by the wobble', () => {
    const w = compile(blob, { id: 'b', shape: { kind: 'circle', center: [100, 100], radius: 10 }, params: { y: 90, height: 4, mode: 'carve' } })
    expect(w.mode).toBe('carve')
    expect(w.bounds.x0).toBe(88)
    let differs = false
    for (let i = 0; i < 10; i++) if (w.density(95 + i, 90, 100) !== op.density(95 + i, 90, 100)) differs = true
    expect(differs).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @elovox/terrain`
Expected: FAIL — cannot resolve `../src/ops/tube.ts`.

- [ ] **Step 3: Implement**

`packages/terrain/src/ops/tube.ts`:

```ts
import type { Box } from '../geom.ts'

/** A tube vertex: centre, horizontal half-width `hw`, vertical half-height `hh`. */
export interface TubePoint { x: number; y: number; z: number; hw: number; hh: number }

export interface Tube {
  readonly bounds: Box
  /** Blocks inside the elliptical cross-section: > 0 inside, 0 on the wall, < 0 outside. */
  field(x: number, y: number, z: number): number
}

/** A tube along a 3D polyline with an elliptical cross-section that can change along the way. */
export function compileTube(points: readonly TubePoint[], pad: number): Tube {
  const n = points.length
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y), zs = points.map((p) => p.z)
  const r = Math.max(...points.map((p) => p.hw)) + pad, rh = Math.max(...points.map((p) => p.hh)) + pad
  return {
    bounds: {
      x0: Math.min(...xs) - r, x1: Math.max(...xs) + r,
      y0: Math.min(...ys) - rh, y1: Math.max(...ys) + rh,
      z0: Math.min(...zs) - r, z1: Math.max(...zs) + r,
    },
    field(x, y, z) {
      let best = Infinity
      for (let i = 0; i < n - 1; i++) {
        const a = points[i]!, b = points[i + 1]!
        const ex = b.x - a.x, ey = b.y - a.y, ez = b.z - a.z
        const len2 = ex * ex + ey * ey + ez * ez
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * ex + (y - a.y) * ey + (z - a.z) * ez) / len2)) : 0
        const hw = a.hw + (b.hw - a.hw) * t, hh = a.hh + (b.hh - a.hh) * t
        const dx = x - (a.x + ex * t), dy = y - (a.y + ey * t), dz = z - (a.z + ez * t)
        const q = Math.sqrt((dx * dx + dz * dz) / (hw * hw) + (dy * dy) / (hh * hh))
        const s = (1 - q) * Math.min(hw, hh)
        if (-s < best) best = -s
      }
      return -best
    },
  }
}

/** Points of the quadratic Bézier from p0 to p2 whose middle is lifted by `rise`. */
export function archCurve(p0: TubePoint, p2: TubePoint, rise: number, segments: number): TubePoint[] {
  const c = { x: (p0.x + p2.x) / 2, y: (p0.y + p2.y) / 2 + rise * 2, z: (p0.z + p2.z) / 2 }
  const out: TubePoint[] = []
  for (let i = 0; i <= segments; i++) {
    const t = i / segments, u = 1 - t
    out.push({
      x: u * u * p0.x + 2 * u * t * c.x + t * t * p2.x,
      y: u * u * p0.y + 2 * u * t * c.y + t * t * p2.y,
      z: u * u * p0.z + 2 * u * t * c.z + t * t * p2.z,
      hw: p0.hw + (p2.hw - p0.hw) * t,
      hh: p0.hh + (p2.hh - p0.hh) * t,
    })
  }
  return out
}
```

`packages/terrain/src/ops/volume.ts`:

```ts
import type { OpDef, PathPoint, ShapeDef } from '../doc/types.ts'
import type { Box } from '../geom.ts'
import { checkParamMode, checkParamNoise, checkParamNum, noise3Of, param, paramStr } from './common.ts'
import { defineTerrainOp, type CompileContext, type VolumeOp } from './registry.ts'
import { archCurve, compileTube, type TubePoint } from './tube.ts'

type PathShape = Extract<ShapeDef, { kind: 'path' }>

function tubePoints(shape: PathShape, height: (width: number) => number): TubePoint[] {
  return shape.points.map((p: PathPoint) => {
    const w = p.width ?? shape.width
    return { x: p.x, y: p.y ?? 0, z: p.z, hw: w / 2, hh: height(w) / 2 }
  })
}

/** Wraps a tube or blob field with noise wobble into a VolumeOp. */
function volumeOp(def: OpDef, ctx: CompileContext, bounds: Box, field: (x: number, y: number, z: number) => number, defaultMode: 'add' | 'carve', defaultWobble: number): VolumeOp {
  const wobble = param(def, 'wobble', defaultWobble)
  const noise = noise3Of(def, 'noise', { scale: 12, octaves: 2 }, ctx.seed)
  const mode = paramStr(def, 'mode', defaultMode)
  return {
    id: def.id, mode,
    bounds: { x0: bounds.x0 - wobble, x1: bounds.x1 + wobble, y0: bounds.y0 - wobble, y1: bounds.y1 + wobble, z0: bounds.z0 - wobble, z1: bounds.z1 + wobble },
    density: wobble > 0 ? (x, y, z) => field(x, y, z) + wobble * (noise(x, y, z) * 2 - 1) : field,
  }
}

function checkCommon(c: Parameters<typeof checkParamNum>[0], path: string, def: OpDef): void {
  checkParamNum(c, path, def, 'wobble', { min: 0, optional: true })
  checkParamNoise(c, path, def)
  checkParamMode(c, path, def)
}

/** A stone arch: a tube along a Bézier from the first path point to the second, lifted by `rise`. Default mode 'add'. */
export const arch = defineTerrainOp({
  type: 'arch', kind: 'volume', shapes: ['path'], needY: true,
  validate(c, path, def) {
    if ((def.shape as PathShape).points.length !== 2) c.fail(`${path}.shape.points`, 'an arch takes exactly 2 points')
    checkParamNum(c, path, def, 'rise', { min: 0 })
    checkParamNum(c, path, def, 'height', { gt: 0, optional: true })
    checkCommon(c, path, def)
  },
  compile(def, ctx) {
    const thick = param(def, 'height', 0)
    const [p0, p2] = tubePoints(def.shape as PathShape, (w) => thick || w)
    const tube = compileTube(archCurve(p0!, p2!, param(def, 'rise', 0), 24), 0)
    return volumeOp(def, ctx, tube.bounds, tube.field, 'add', 1.5)
  },
})

/** A cave tunnel along a 3D path; start the path above ground for a visible entrance. Default mode 'carve'. */
export const cave = defineTerrainOp({
  type: 'cave', kind: 'volume', shapes: ['path'], needY: true,
  validate(c, path, def) {
    checkParamNum(c, path, def, 'height', { gt: 0, optional: true })
    checkCommon(c, path, def)
  },
  compile(def, ctx) {
    const height = param(def, 'height', 0)
    const tube = compileTube(tubePoints(def.shape as PathShape, (w) => height || w), 0)
    return volumeOp(def, ctx, tube.bounds, tube.field, 'carve', 2)
  },
})

/**
 * A flat horizontal slot along a wall, at the path's y: carving it under a cliff leaves an
 * overhanging lip; with mode 'add' it builds a ledge. `height` defaults to a third of the width.
 */
export const overhang = defineTerrainOp({
  type: 'overhang', kind: 'volume', shapes: ['path'], needY: true,
  validate(c, path, def) {
    checkParamNum(c, path, def, 'height', { gt: 0, optional: true })
    checkCommon(c, path, def)
  },
  compile(def, ctx) {
    const height = param(def, 'height', 0)
    const tube = compileTube(tubePoints(def.shape as PathShape, (w) => height || w / 3), 0)
    return volumeOp(def, ctx, tube.bounds, tube.field, 'carve', 1)
  },
})

/**
 * A noisy ellipsoid centred on the circle at height `y`: horizontal radius = the circle's radius,
 * vertical radius = `height`. Floating islands, spires, boulders (mode 'add') or pits (mode 'carve').
 */
export const blob = defineTerrainOp({
  type: 'blob', kind: 'volume', shapes: ['circle'],
  validate(c, path, def, ctx) {
    checkParamNum(c, path, def, 'y', { min: 0, max: ctx.height })
    checkParamNum(c, path, def, 'height', { gt: 0 })
    checkCommon(c, path, def)
  },
  compile(def, ctx) {
    const shape = def.shape as Extract<ShapeDef, { kind: 'circle' }>
    const [cx, cz] = shape.center
    const r = shape.radius, cy = param(def, 'y', 0), hy = param(def, 'height', 1)
    const k = Math.min(r, hy)
    const field = (x: number, y: number, z: number) => {
      const q = Math.sqrt(((x - cx) / r) ** 2 + ((y - cy) / hy) ** 2 + ((z - cz) / r) ** 2)
      return (1 - q) * k
    }
    return volumeOp(def, ctx, { x0: cx - r, x1: cx + r, y0: cy - hy, y1: cy + hy, z0: cz - r, z1: cz + r }, field, 'add', 2)
  },
})
```

- [ ] **Step 4: Register them**

Replace `packages/terrain/src/ops/builtin.ts` with its final form:

```ts
import { biome } from './biome.ts'
import { flatten } from './flatten.ts'
import { hills } from './hills.ts'
import { lake } from './lake.ts'
import { mountain } from './mountain.ts'
import { plateau } from './plateau.ts'
import { OpRegistry, type OpImpl } from './registry.ts'
import { river } from './river.ts'
import { valley } from './valley.ts'
import { arch, blob, cave, overhang } from './volume.ts'

/** Every built-in op, in a stable order. */
export const BUILTIN_OPS: readonly OpImpl[] = [hills, mountain, plateau, flatten, biome, valley, river, lake, arch, cave, overhang, blob]

export const builtinOps = new OpRegistry(BUILTIN_OPS)
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npm test -w @elovox/terrain` then `npm run typecheck -w @elovox/terrain`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/terrain/src/ops packages/terrain/test/volumeOps.test.ts
git commit -m "feat(terrain): arch, cave, overhang and blob volume ops"
```

### Task 10: Biomes and surface rules

**Files:**
- Create: `packages/terrain/src/biomes/biomes.ts`
- Test: `packages/terrain/test/biomes.test.ts`

**Interfaces:**
- Consumes: `BiomeDef`, `BiomeRule`, `SurfaceRule`, `TreeKind` (Task 3), `makeNoise2` (Task 2), test fixtures (Task 6).
- Produces:
  - `SurfaceInput = { depth, slope, y, underwater, wetRef, ceiling }`.
  - `CompiledBiome = { name, rules, maxDepth, trees: { density, kinds, on: Set<id> } | null, rocks: { density, size } | null }`.
  - `compileBiome(def, id)`, `surfaceBlock(biome, fill, input)` and `compileBiomeRule(rule, index, seed): (x, z, h) => biomeIndex`.

`depth` is counted vertically: the number of solid voxels between this voxel and the nearest air or water above it. A cliff face's side voxels can therefore have a large depth. To colour whole walls (the mesa strata), give the rule a deep range, as the showcase does with `depth: [0, 96]`.

- [ ] **Step 1: Write the failing test**

`packages/terrain/test/biomes.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { compileBiome, compileBiomeRule, surfaceBlock, type SurfaceInput } from '../src/biomes/biomes.ts'
import { IDS, idOf } from './fixtures.ts'

const at = (o: Partial<SurfaceInput>): SurfaceInput => ({ depth: 0, slope: 0, y: 40, underwater: false, wetRef: 10, ceiling: false, ...o })

describe('surfaceBlock', () => {
  const temperate = compileBiome({
    name: 'temperate',
    surface: [
      { block: 'stone', slope: [1.5, 99] },
      { block: 'gravel', underwater: true, depth: [0, 1] },
      { block: 'sand', nearWater: 2, depth: [0, 2] },
      { block: 'snow', y: [90, 999] },
      { block: 'stone', ceiling: true, depth: [0, 9] },
      { block: 'grass' },
      { block: 'dirt', depth: [1, 3] },
    ],
  }, idOf)
  it('picks the first matching rule', () => {
    expect(surfaceBlock(temperate, IDS.stone!, at({}))).toBe(IDS.grass)
    expect(surfaceBlock(temperate, IDS.stone!, at({ depth: 2 }))).toBe(IDS.dirt)
    expect(surfaceBlock(temperate, IDS.stone!, at({ slope: 2 }))).toBe(IDS.stone)
    expect(surfaceBlock(temperate, IDS.stone!, at({ underwater: true }))).toBe(IDS.gravel)
    expect(surfaceBlock(temperate, IDS.stone!, at({ y: 12 }))).toBe(IDS.sand)
    expect(surfaceBlock(temperate, IDS.stone!, at({ y: 13 }))).toBe(IDS.grass)
    expect(surfaceBlock(temperate, IDS.stone!, at({ y: 95 }))).toBe(IDS.snow)
    expect(surfaceBlock(temperate, IDS.stone!, at({ ceiling: true, depth: 5 }))).toBe(IDS.stone)
  })
  it('falls back to fill below every rule', () => {
    expect(temperate.maxDepth).toBe(9)
    expect(surfaceBlock(temperate, IDS.rock!, at({ depth: 4 }))).toBe(IDS.rock)
    expect(surfaceBlock(temperate, IDS.rock!, at({ depth: 50 }))).toBe(IDS.rock)
  })
  it('stacks bands by y', () => {
    const mesa = compileBiome({ name: 'mesa', surface: [{ bands: { blocks: ['sandstone', 'sandstone_red'], thickness: 3 }, depth: [0, 4] }] }, idOf)
    expect([0, 2, 3, 5, 6].map((y) => surfaceBlock(mesa, 0, at({ y })))).toEqual([IDS.sandstone, IDS.sandstone, IDS.sandstone_red, IDS.sandstone_red, IDS.sandstone])
  })
  it('compiles trees and rocks, with trees on grass by default', () => {
    const b = compileBiome({ name: 'f', surface: [], trees: { density: 0.2, kinds: ['pine'] }, rocks: { density: 0.05, size: [1, 3] } }, idOf)
    expect(b.trees?.on.has(IDS.grass!)).toBe(true)
    expect(b.rocks?.size).toEqual([1, 3])
  })
})

describe('compileBiomeRule', () => {
  const names = ['plain', 'alpine', 'wet']
  const index = (n: string) => names.indexOf(n)
  it('uses the first matching height rule, else the default', () => {
    const rule = compileBiomeRule({ default: 'plain', rules: [{ biome: 'alpine', minHeight: 90 }] }, index, 1)
    expect(rule(0, 0, 50)).toBe(0)
    expect(rule(0, 0, 95)).toBe(1)
  })
  it('reads moisture noise for moisture ranges', () => {
    const rule = compileBiomeRule({ default: 'plain', moisture: { scale: 8 }, rules: [{ biome: 'wet', moisture: [0.5, 1] }] }, index, 1)
    const seen = new Set<number>()
    for (let i = 0; i < 200; i++) seen.add(rule(i * 3, i * 5, 40))
    expect([...seen].sort()).toEqual([0, 2])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @elovox/terrain`
Expected: FAIL — cannot resolve `../src/biomes/biomes.ts`.

- [ ] **Step 3: Implement**

`packages/terrain/src/biomes/biomes.ts`:

```ts
import type { BiomeDef, BiomeRule, SurfaceRule, TreeKind } from '../doc/types.ts'
import { makeNoise2 } from '../noise/def.ts'

/** What surface rules see about one solid voxel. */
export interface SurfaceInput {
  /** Solid voxels between this one and the nearest air or water above. 0 = exposed. */
  depth: number
  slope: number
  y: number
  /** The nearest non-solid voxel above is water. */
  underwater: boolean
  /** Water reference of the column (max of river/lake wet level and sea level). */
  wetRef: number
  /** The voxel right below is air. */
  ceiling: boolean
}

interface CompiledRule {
  block: number
  d0: number; d1: number
  s0: number; s1: number
  y0: number; y1: number
  /** -1 any, 0 must be false, 1 must be true */
  underwater: number
  ceiling: number
  /** -1 = any */
  nearWater: number
  bands: Int32Array | null
  thickness: number
}

export interface CompiledBiome {
  readonly name: string
  readonly rules: readonly CompiledRule[]
  /** Deepest depth any rule can match; deeper voxels take the fill block without checking rules. */
  readonly maxDepth: number
  readonly trees: { density: number; kinds: readonly TreeKind[]; on: ReadonlySet<number> } | null
  readonly rocks: { density: number; size: readonly [number, number] } | null
}

const tri = (v: boolean | undefined) => (v === undefined ? -1 : v ? 1 : 0)

function compileRule(r: SurfaceRule, id: (name: string) => number): CompiledRule {
  return {
    block: r.block === undefined ? 0 : id(r.block),
    d0: r.depth?.[0] ?? 0, d1: r.depth?.[1] ?? 0,
    s0: r.slope?.[0] ?? -Infinity, s1: r.slope?.[1] ?? Infinity,
    y0: r.y?.[0] ?? -Infinity, y1: r.y?.[1] ?? Infinity,
    underwater: tri(r.underwater), ceiling: tri(r.ceiling),
    nearWater: r.nearWater ?? -1,
    bands: r.bands ? Int32Array.from(r.bands.blocks, id) : null,
    thickness: r.bands?.thickness ?? 1,
  }
}

export function compileBiome(b: BiomeDef, id: (name: string) => number): CompiledBiome {
  const rules = b.surface.map((r) => compileRule(r, id))
  return {
    name: b.name,
    rules,
    maxDepth: rules.reduce((m, r) => Math.max(m, r.d1), -1),
    trees: b.trees ? { density: b.trees.density, kinds: b.trees.kinds, on: new Set((b.trees.on ?? ['grass']).map(id)) } : null,
    rocks: b.rocks ? { density: b.rocks.density, size: b.rocks.size } : null,
  }
}

/** The block for a solid voxel: the first matching rule of the biome, else `fill`. */
export function surfaceBlock(b: CompiledBiome, fill: number, i: SurfaceInput): number {
  if (i.depth > b.maxDepth) return fill
  for (const r of b.rules) {
    if (i.depth < r.d0 || i.depth > r.d1) continue
    if (i.slope < r.s0 || i.slope > r.s1) continue
    if (i.y < r.y0 || i.y > r.y1) continue
    if (r.underwater !== -1 && r.underwater !== (i.underwater ? 1 : 0)) continue
    if (r.ceiling !== -1 && r.ceiling !== (i.ceiling ? 1 : 0)) continue
    if (r.nearWater >= 0 && i.y > i.wetRef + r.nearWater) continue
    if (r.bands) {
      const n = r.bands.length
      return r.bands[((Math.floor(i.y / r.thickness) % n) + n) % n]!
    }
    return r.block
  }
  return fill
}

/** The default biome of a column of ground height `h`, from the document's biomeRule. */
export function compileBiomeRule(rule: BiomeRule, index: (name: string) => number, seed: number): (x: number, z: number, h: number) => number {
  const fallback = index(rule.default)
  const entries = (rule.rules ?? []).map((e) => ({
    biome: index(e.biome),
    min: e.minHeight ?? -Infinity, max: e.maxHeight ?? Infinity,
    m0: e.moisture?.[0] ?? -Infinity, m1: e.moisture?.[1] ?? Infinity,
  }))
  const needsMoisture = entries.some((e) => e.m0 !== -Infinity || e.m1 !== Infinity)
  const moisture = makeNoise2(rule.moisture ?? { scale: 300 }, seed ^ 0x6d6f6973)
  return (x, z, h) => {
    const m = needsMoisture ? moisture(x, z) : 0
    for (const e of entries) if (h >= e.min && h <= e.max && m >= e.m0 && m <= e.m1) return e.biome
    return fallback
  }
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npm test -w @elovox/terrain` then `npm run typecheck -w @elovox/terrain`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/terrain/src/biomes packages/terrain/test/biomes.test.ts
git commit -m "feat(terrain): biomes, surface rules and biome selection"
```


### Task 11: The generation pipeline (height → density → water → surface)

**Files:**
- Create: `packages/terrain/src/pipeline/compile.ts`, `cells.ts`, `volume.ts`, `region.ts` (all in `packages/terrain/src/pipeline/`)
- Test: `packages/terrain/test/pipeline.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–10. Also `packVoxel` from `@elovox/engine/src/world/voxel.ts`, which is already a dependency through `package.json`.
- Produces:
  - `CompiledTerrain` (fields `doc`, `seed`, `height`, `sizeX`, `sizeZ`, `seaLevel`, `base`, `heightOps`, `volumeOps`, `biomes`, `biomeRule`, `heightLayer`, `biomeLayer`, `densityLayer` and `blocks`), `TerrainBlocks`, `WATER_STATE = 7` and `TerrainOpError` (with `opId`).
  - `compileTerrain(doc, { seed, height, id, ops? })`.
  - `CellGrid` (`top`, `water`, `wet`, `biome` over a rectangle), `fillCells(t, x0, z0, w, d)` and `slopeAt(grid, i)`.
  - `LATTICE = 4` and `class VolumeField(t, x0, z0, w, d)` with `.column(x, z, top, solid)` and `.empty`.
  - `generateRegion(t, x0, z0, w, d, out, { features? })`, writing voxels at index `lx + lz * w + y * w * d`. For a 32 × 32 column, that is exactly the engine's column layout.

How the stages fit:
- `fillCells` runs base → height ops → height layer → clamp to `[1, height - 2]` → biome, on a grid with a one-column border so slope works on the edges.
- Ops run op-outer, cell-inner. That way a thrown error is wrapped once, with the op id and the column range: `op "x" failed at columns x a..b, z c..d: …`.
- `VolumeField` samples each volume op on a lattice aligned to world multiples of 4. Its values therefore depend only on world coordinates, and every rectangle that covers a voxel interpolates the same value for it. Task 12's seam test depends on this.
- The column density starts at `top - y - 0.5`, then each volume op applies `max(d, s)` (add) or `min(d, -s)` (carve) in document order. The density layer is added last, and solid means `d > 0`.
- Water: every non-solid voxel below `max(cell.water, seaLevel)` is water. This is column-local, so a cave below sea level floods. Keep caves above `seaLevel`.

Features (trees and rocks) come in Task 12. Here `generateRegion` takes the `features` option but does not stamp anything yet.

- [ ] **Step 1: Write the failing test**

`packages/terrain/test/pipeline.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { validateTerrainDoc } from '../src/doc/validate.ts'
import { builtinOps } from '../src/ops/builtin.ts'
import { defineTerrainOp } from '../src/ops/registry.ts'
import { compileTerrain, type CompiledTerrain } from '../src/pipeline/compile.ts'
import { generateRegion } from '../src/pipeline/region.ts'
import { IDS, idOf, minimalDoc } from './fixtures.ts'

const H = 64
const WATER = IDS.water! | (7 << 12)

export function compileDoc(json: unknown, ops = builtinOps): CompiledTerrain {
  const r = validateTerrainDoc(json, { ops, worldHeight: H })
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return compileTerrain(r.doc, { seed: 99, height: H, id: idOf, ops })
}
function region(t: CompiledTerrain, x0: number, z0: number, w = 32, d = 32, features = false): (x: number, y: number, z: number) => number {
  const out = new Uint16Array(w * d * H)
  generateRegion(t, x0, z0, w, d, out, { features })
  return (x, y, z) => out[(x - x0) + (z - z0) * w + y * w * d]!
}
const column = (get: (x: number, y: number, z: number) => number, x: number, z: number) => Array.from({ length: H }, (_, y) => get(x, y, z))

describe('generateRegion: height, water and surface', () => {
  it('builds flat layered ground from the base and surface rules', () => {
    const get = region(compileDoc(minimalDoc()), 0, 0)
    const col = column(get, 5, 5)
    expect(col.slice(0, 16).every((v) => v === IDS.stone)).toBe(true)
    expect(col.slice(16, 19)).toEqual([IDS.dirt, IDS.dirt, IDS.dirt])
    expect(col[19]).toBe(IDS.grass)
    expect(col.slice(20).every((v) => v === 0)).toBe(true)
  })

  it('fills everything below sea level with water', () => {
    const get = region(compileDoc({ ...minimalDoc(), base: { height: 6, amplitude: 0, noise: { scale: 9 } } }), 0, 0)
    expect(column(get, 3, 3).slice(5, 11)).toEqual([IDS.grass, WATER, WATER, WATER, WATER, 0])
  })

  it('clamps heights to [1, height - 2] instead of throwing', () => {
    const t = compileDoc({ ...minimalDoc(), ops: [{ id: 'm', type: 'mountain', shape: { kind: 'circle', center: [16, 16], radius: 40 }, params: { height: 500, roughness: 0 } }] })
    const col = column(region(t, 0, 0), 16, 16)
    expect(col[H - 3]).not.toBe(0)
    expect(col[H - 2]).toBe(0)
  })

  it('applies height ops in document order', () => {
    const flat = (id: string, y: number) => ({ id, type: 'flatten', shape: { kind: 'circle', center: [16, 16], radius: 30 }, params: { y } })
    const t = compileDoc({ ...minimalDoc(), ops: [flat('a', 30), flat('b', 25)] })
    expect(column(region(t, 0, 0), 16, 16)[24]).toBe(IDS.grass)
  })

  it('places river water in its channel and sand on the banks via nearWater', () => {
    const doc = {
      ...minimalDoc(),
      biomes: [{ name: 'plain', surface: [{ block: 'sand', nearWater: 1, depth: [0, 1] }, { block: 'grass' }] }],
      ops: [{ id: 'r', type: 'river', shape: { kind: 'path', width: 6, points: [{ x: 0, z: 16 }, { x: 63, z: 16 }] }, params: { start: 19, end: 19, depth: 2, bank: 8, bankSlope: 0.5 } }],
    }
    const get = region(compileDoc(doc), 0, 0)
    const mid = column(get, 10, 16)
    expect(mid[18]).toBe(WATER)
    expect(mid[19]).toBe(0)
    expect(column(get, 10, 20)[18]).toBe(IDS.sand) // bank, 1 block above water level - 1
    expect(column(get, 10, 30)[19]).toBe(IDS.grass) // far from the river
  })

  it('carves volume ops through the ground and marks cave roofs as ceilings', () => {
    const doc = {
      ...minimalDoc(),
      biomes: [{ name: 'plain', surface: [{ block: 'rock', ceiling: true, depth: [0, 20] }, { block: 'grass' }, { block: 'dirt', depth: [1, 3] }] }],
      ops: [{ id: 'c', type: 'cave', shape: { kind: 'path', width: 6, points: [{ x: 0, z: 16, y: 10 }, { x: 63, z: 16, y: 10 }] }, params: { wobble: 0 } }],
    }
    const col = column(region(compileDoc(doc), 0, 0), 16, 16)
    expect(col[10]).toBe(0) // tunnel
    expect(col[14]).toBe(IDS.rock) // roof: air below
    expect(col[19]).toBe(IDS.grass)
  })

  it('adds a floating island above the ground, out-of-world parts clipped', () => {
    const doc = {
      ...minimalDoc(),
      ops: [
        { id: 'island', type: 'blob', shape: { kind: 'circle', center: [16, 16], radius: 8 }, params: { y: 40, height: 4, wobble: 0 } },
        { id: 'sky', type: 'blob', shape: { kind: 'circle', center: [0, 0], radius: 20 }, params: { y: 60, height: 10, wobble: 0 } },
      ],
    }
    const col = column(region(compileDoc(doc), 0, 0), 16, 16)
    expect(col[30]).toBe(0)
    expect(col[43]).toBe(IDS.grass) // island top: exposed, depth 0
    expect(col[38]).toBe(IDS.stone)
  })

  it('names the op when it throws, with the columns it was working on', () => {
    const boom = defineTerrainOp({
      type: 'boom', kind: 'height', defaultBlend: 'add', shapes: ['circle'],
      validate() {},
      compile(def) { return { id: def.id, bounds: { x0: 0, z0: 0, x1: 100, z1: 100 }, apply() { throw new Error('kaboom') } } },
    })
    const ops = builtinOps.with(boom)
    const t = compileDoc({ ...minimalDoc(), ops: [{ id: 'bad', type: 'boom', shape: { kind: 'circle', center: [1, 1], radius: 1 } }] }, ops)
    expect(() => region(t, 32, 0)).toThrow('op "bad" failed at columns x 31..64, z 0..32: kaboom')
  })

  it('reports an unregistered block by name', () => {
    expect(() => compileDoc({ ...minimalDoc(), biomes: [{ name: 'plain', surface: [{ block: 'lava' }] }] })).toThrow('the terrain document uses block "lava", which is not registered')
  })

  it('checks the buffer size', () => {
    expect(() => generateRegion(compileDoc(minimalDoc()), 0, 0, 32, 32, new Uint16Array(10))).toThrow(RangeError)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @elovox/terrain`
Expected: FAIL — cannot resolve `../src/pipeline/compile.ts`.

- [ ] **Step 3: Implement compile**

`packages/terrain/src/pipeline/compile.ts`:

```ts
import { packVoxel } from '@elovox/engine/src/world/voxel.ts'
import { compileBiome, compileBiomeRule, type CompiledBiome } from '../biomes/biomes.ts'
import type { TerrainDoc } from '../doc/types.ts'
import { BiomeLayer, DensityLayer, HeightLayer } from '../layers/raster.ts'
import { makeNoise2, type Sampler2 } from '../noise/def.ts'
import { builtinOps } from '../ops/builtin.ts'
import type { CompileContext, HeightOp, OpRegistry, VolumeOp } from '../ops/registry.ts'

/** Voxel value of placed water: full level (state 7), like the sandbox diorama. */
export const WATER_STATE = 7

export interface TerrainBlocks { fill: number; water: number; log: number; leaves: number; pineLeaves: number; rock: number }

export interface CompiledTerrain {
  readonly doc: TerrainDoc
  readonly seed: number
  /** World height (y size). */
  readonly height: number
  readonly sizeX: number
  readonly sizeZ: number
  readonly seaLevel: number
  /** Base ground height before ops. */
  readonly base: Sampler2
  readonly heightOps: readonly HeightOp[]
  readonly volumeOps: readonly VolumeOp[]
  readonly biomes: readonly CompiledBiome[]
  readonly biomeRule: (x: number, z: number, h: number) => number
  readonly heightLayer: HeightLayer | null
  readonly biomeLayer: BiomeLayer | null
  readonly densityLayer: DensityLayer | null
  /** Voxel values (water already carries its level state). */
  readonly blocks: TerrainBlocks
}

export interface CompileOptions {
  seed: number
  height: number
  /** Block name → block id. Throws for unknown names (the engine registry does). */
  id(name: string): number
  ops?: OpRegistry
}

/** An op threw while compiling or running. The message names the op so a document author can find it. */
export class TerrainOpError extends Error {
  readonly opId: string
  constructor(opId: string, where: string, cause: unknown) {
    super(`op "${opId}" failed ${where}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'TerrainOpError'
    this.opId = opId
  }
}

export function compileTerrain(doc: TerrainDoc, o: CompileOptions): CompiledTerrain {
  const registry = o.ops ?? builtinOps
  const id = (name: string): number => {
    try {
      return o.id(name)
    } catch {
      throw new Error(`the terrain document uses block "${name}", which is not registered`)
    }
  }
  const biomeNames = doc.biomes.map((b) => b.name)
  const biomeIndex = (name: string) => {
    const i = biomeNames.indexOf(name)
    if (i < 0) throw new Error(`unknown biome "${name}"`)
    return i
  }
  const ctx: CompileContext = { seed: o.seed, height: o.height, seaLevel: doc.seaLevel, biomeIndex }
  const heightOps: HeightOp[] = []
  const volumeOps: VolumeOp[] = []
  for (const def of doc.ops) {
    if (!def.enabled) continue
    const impl = registry.get(def.type)
    if (!impl) throw new TerrainOpError(def.id, 'to compile', new Error(`unknown op type "${def.type}"`))
    try {
      if (impl.kind === 'height') heightOps.push(impl.compile(def, ctx))
      else volumeOps.push(impl.compile(def, ctx))
    } catch (e) {
      throw new TerrainOpError(def.id, 'to compile', e)
    }
  }
  const baseNoise = makeNoise2(doc.base.noise, o.seed)
  const { height: baseHeight, amplitude } = doc.base
  return {
    doc, seed: o.seed, height: o.height, sizeX: doc.size[0], sizeZ: doc.size[1], seaLevel: doc.seaLevel,
    base: (x, z) => baseHeight + amplitude * baseNoise(x, z),
    heightOps, volumeOps,
    biomes: doc.biomes.map((b) => compileBiome(b, id)),
    biomeRule: compileBiomeRule(doc.biomeRule, biomeIndex, o.seed),
    heightLayer: doc.layers.height ? new HeightLayer(doc.layers.height) : null,
    biomeLayer: doc.layers.biome ? new BiomeLayer(doc.layers.biome) : null,
    densityLayer: doc.layers.density ? new DensityLayer(doc.layers.density) : null,
    blocks: {
      fill: id(doc.blocks.fill), water: packVoxel(id(doc.blocks.water), WATER_STATE),
      log: id(doc.blocks.log), leaves: id(doc.blocks.leaves), pineLeaves: id(doc.blocks.pineLeaves), rock: id(doc.blocks.rock),
    },
  }
}
```

- [ ] **Step 4: Implement the 2D stage**

`packages/terrain/src/pipeline/cells.ts`:

```ts
import type { Cell } from '../ops/registry.ts'
import { TerrainOpError, type CompiledTerrain } from './compile.ts'

/** The 2D stage for a rectangle of columns [x0, x0 + w) × [z0, z0 + d). Index: (x - x0) + (z - z0) * w. */
export interface CellGrid {
  readonly x0: number
  readonly z0: number
  readonly w: number
  readonly d: number
  /** Ground height rounded and clamped to [1, height - 2]: voxels y < top are solid before volume ops. */
  readonly top: Int32Array
  /** Water level from rivers and lakes, or -1. */
  readonly water: Float64Array
  /** Water reference for nearWater rules, or -Infinity. */
  readonly wet: Float64Array
  readonly biome: Int32Array
}

/** Runs base, height ops (in document order), the height layer and biome selection for every column. */
export function fillCells(t: CompiledTerrain, x0: number, z0: number, w: number, d: number): CellGrid {
  const n = w * d
  const h = new Float64Array(n)
  const water = new Float64Array(n).fill(-1)
  const wet = new Float64Array(n).fill(-Infinity)
  const opBiome = new Int32Array(n).fill(-1)
  for (let lz = 0; lz < d; lz++) for (let lx = 0; lx < w; lx++) h[lx + lz * w] = t.base(x0 + lx, z0 + lz)

  const cell: Cell = { h: 0, water: -1, wet: -Infinity, biome: -1 }
  for (const op of t.heightOps) {
    const b = op.bounds
    const xa = Math.max(x0, Math.ceil(b.x0)), xb = Math.min(x0 + w - 1, Math.floor(b.x1))
    const za = Math.max(z0, Math.ceil(b.z0)), zb = Math.min(z0 + d - 1, Math.floor(b.z1))
    if (xa > xb || za > zb) continue
    try {
      for (let z = za; z <= zb; z++) for (let x = xa; x <= xb; x++) {
        const i = (x - x0) + (z - z0) * w
        cell.h = h[i]!; cell.water = water[i]!; cell.wet = wet[i]!; cell.biome = opBiome[i]!
        op.apply(x, z, cell)
        h[i] = cell.h; water[i] = cell.water; wet[i] = cell.wet; opBiome[i] = cell.biome
      }
    } catch (e) {
      throw new TerrainOpError(op.id, `at columns x ${xa}..${xb}, z ${za}..${zb}`, e)
    }
  }

  const top = new Int32Array(n)
  const biome = new Int32Array(n)
  const maxTop = t.height - 2
  for (let lz = 0; lz < d; lz++) for (let lx = 0; lx < w; lx++) {
    const i = lx + lz * w, x = x0 + lx, z = z0 + lz
    const inWorld = x >= 0 && z >= 0 && x < t.sizeX && z < t.sizeZ
    const hh = h[i]! + (inWorld && t.heightLayer ? t.heightLayer.at(x, z) : 0)
    const tp = Math.min(maxTop, Math.max(1, Math.round(hh)))
    top[i] = tp
    const painted = inWorld && t.biomeLayer ? t.biomeLayer.at(x, z) : -1
    biome[i] = painted >= 0 ? painted : opBiome[i]! >= 0 ? opBiome[i]! : t.biomeRule(x, z, tp)
  }
  return { x0, z0, w, d, top, water, wet, biome }
}

/** Rise per block at grid index `i` (not on the grid's border), from its four neighbours' ground heights. */
export function slopeAt(g: CellGrid, i: number): number {
  return Math.max(Math.abs(g.top[i + 1]! - g.top[i - 1]!), Math.abs(g.top[i + g.w]! - g.top[i - g.w]!)) / 2
}
```

- [ ] **Step 5: Implement the 3D stage**

`packages/terrain/src/pipeline/volume.ts`:

```ts
import type { VolumeOp } from '../ops/registry.ts'
import { TerrainOpError, type CompiledTerrain } from './compile.ts'

/** Volume ops are sampled every LATTICE blocks on a grid aligned to world multiples of LATTICE. */
export const LATTICE = 4

interface OpLattice {
  op: VolumeOp
  /** Voxel ranges (inclusive) where the op applies, already clamped to the region and the world. */
  xa: number; xb: number; ya: number; yb: number; za: number; zb: number
  gx0: number; gy0: number; gz0: number
  nx: number; nz: number
  values: Float64Array
}

/**
 * The 3D stage for one rectangle of columns. Lattice values depend only on world coordinates, so any
 * rectangle that covers a voxel interpolates the same value for it: columns and regions agree.
 */
export class VolumeField {
  private readonly lattices: OpLattice[] = []
  private readonly height: number
  private readonly t: CompiledTerrain
  private readonly density: Float64Array
  private readonly useLayer: boolean

  constructor(t: CompiledTerrain, x0: number, z0: number, w: number, d: number) {
    this.t = t
    this.height = t.height
    this.density = new Float64Array(t.height)
    this.useLayer = t.densityLayer !== null && t.densityLayer.touches(x0, z0, x0 + w - 1, z0 + d - 1)
    for (const op of t.volumeOps) {
      const b = op.bounds
      const xa = Math.max(x0, Math.ceil(b.x0)), xb = Math.min(x0 + w - 1, Math.floor(b.x1))
      const za = Math.max(z0, Math.ceil(b.z0)), zb = Math.min(z0 + d - 1, Math.floor(b.z1))
      const ya = Math.max(0, Math.ceil(b.y0)), yb = Math.min(t.height - 1, Math.floor(b.y1))
      if (xa > xb || za > zb || ya > yb) continue
      const gx0 = Math.floor(xa / LATTICE), gy0 = Math.floor(ya / LATTICE), gz0 = Math.floor(za / LATTICE)
      const nx = Math.floor(xb / LATTICE) + 2 - gx0, ny = Math.floor(yb / LATTICE) + 2 - gy0, nz = Math.floor(zb / LATTICE) + 2 - gz0
      const values = new Float64Array(nx * ny * nz)
      try {
        for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
          values[i + k * nx + j * nx * nz] = op.density((gx0 + i) * LATTICE, (gy0 + j) * LATTICE, (gz0 + k) * LATTICE)
        }
      } catch (e) {
        throw new TerrainOpError(op.id, `at columns x ${xa}..${xb}, z ${za}..${zb}`, e)
      }
      this.lattices.push({ op, xa, xb, ya, yb, za, zb, gx0, gy0, gz0, nx, nz, values })
    }
  }

  /** Whether any volume op or density brick reaches this rectangle. */
  get empty(): boolean { return this.lattices.length === 0 && !this.useLayer }

  /** Fills solid[y] (1/0) for the column at (x, z) whose ground height is `top`. */
  column(x: number, z: number, top: number, solid: Uint8Array): void {
    const H = this.height
    let touched = this.useLayer
    if (!touched) for (const l of this.lattices) if (x >= l.xa && x <= l.xb && z >= l.za && z <= l.zb) { touched = true; break }
    if (!touched) {
      for (let y = 0; y < H; y++) solid[y] = y < top ? 1 : 0
      return
    }
    const dens = this.density
    for (let y = 0; y < H; y++) dens[y] = top - y - 0.5
    for (const l of this.lattices) {
      if (x < l.xa || x > l.xb || z < l.za || z > l.zb) continue
      const fx = x / LATTICE - l.gx0, fz = z / LATTICE - l.gz0
      const ix = Math.floor(fx), iz = Math.floor(fz)
      const tx = fx - ix, tz = fz - iz
      const nxz = l.nx * l.nz
      const add = l.op.mode === 'add'
      for (let y = l.ya; y <= l.yb; y++) {
        const fy = y / LATTICE - l.gy0
        const iy = Math.floor(fy), ty = fy - iy
        const b = ix + iz * l.nx + iy * nxz
        const v = l.values
        const c00 = v[b]! + (v[b + 1]! - v[b]!) * tx
        const c10 = v[b + l.nx]! + (v[b + l.nx + 1]! - v[b + l.nx]!) * tx
        const c01 = v[b + nxz]! + (v[b + nxz + 1]! - v[b + nxz]!) * tx
        const c11 = v[b + nxz + l.nx]! + (v[b + nxz + l.nx + 1]! - v[b + nxz + l.nx]!) * tx
        const lo = c00 + (c10 - c00) * tz, hi = c01 + (c11 - c01) * tz
        const s = lo + (hi - lo) * ty
        dens[y] = add ? Math.max(dens[y]!, s) : Math.min(dens[y]!, -s)
      }
    }
    if (this.useLayer) {
      const layer = this.t.densityLayer!
      for (let y = 0; y < H; y++) dens[y] = dens[y]! + layer.sample(x, y, z)
    }
    for (let y = 0; y < H; y++) solid[y] = dens[y]! > 0 ? 1 : 0
  }
}
```

- [ ] **Step 6: Implement the region generator (no features yet)**

`packages/terrain/src/pipeline/region.ts`:

```ts
import { surfaceBlock, type SurfaceInput } from '../biomes/biomes.ts'
import { fillCells, slopeAt } from './cells.ts'
import type { CompiledTerrain } from './compile.ts'
import { VolumeField } from './volume.ts'

export interface RegionOptions {
  /** Stamp trees and rocks. Default true. */
  features?: boolean
}

/**
 * Generates the voxels of columns [x0, x0 + w) × [z0, z0 + d), full height, into `out`
 * (index lx + lz * w + y * w * d; for a 32 × 32 column that is the engine's column layout).
 * Pure: the same terrain gives the same voxels for a voxel whatever rectangle contains it.
 */
export function generateRegion(t: CompiledTerrain, x0: number, z0: number, w: number, d: number, out: Uint16Array, o: RegionOptions = {}): void {
  const H = t.height
  if (out.length !== w * d * H) throw new RangeError(`region buffer has ${out.length} voxels, expected ${w * d * H}`)
  const g = fillCells(t, x0 - 1, z0 - 1, w + 2, d + 2)
  const field = new VolumeField(t, x0, z0, w, d)
  const solid = new Uint8Array(H)
  const input: SurfaceInput = { depth: 0, slope: 0, y: 0, underwater: false, wetRef: 0, ceiling: false }
  const layer = w * d
  for (let lz = 0; lz < d; lz++) for (let lx = 0; lx < w; lx++) {
    const x = x0 + lx, z = z0 + lz
    const gi = (lx + 1) + (lz + 1) * g.w
    field.column(x, z, g.top[gi]!, solid)
    const water = Math.max(g.water[gi]!, t.seaLevel)
    const biome = t.biomes[g.biome[gi]!]!
    input.slope = slopeAt(g, gi)
    input.wetRef = Math.max(g.wet[gi]!, t.seaLevel)
    let depth = -1, aboveWater = false
    for (let y = H - 1; y >= 0; y--) {
      const i = lx + lz * w + y * layer
      if (!solid[y]) {
        const wet = y < water
        out[i] = wet ? t.blocks.water : 0
        depth = -1
        aboveWater = wet
        continue
      }
      depth++
      input.depth = depth
      input.y = y
      input.underwater = aboveWater
      input.ceiling = y > 0 && !solid[y - 1] && y - 1 >= water
      out[i] = surfaceBlock(biome, t.blocks.fill, input)
    }
  }
}
```

- [ ] **Step 7: Run the tests and the typecheck**

Run: `npm test -w @elovox/terrain` then `npm run typecheck -w @elovox/terrain`
Expected: all pass. `region.ts` has an unused `RegionOptions.features` until Task 12, and that is fine: it is part of the public signature.

- [ ] **Step 8: Commit**

```bash
git add packages/terrain/src/pipeline packages/terrain/test/pipeline.test.ts
git commit -m "feat(terrain): region pipeline (height ops, volume lattice, water, surface)"
```

### Task 12: Trees and rocks across columns

**Files:**
- Create: `packages/terrain/src/pipeline/probe.ts`, `packages/terrain/src/features/rand.ts`, `trees.ts`, `rocks.ts`, `place.ts`
- Modify: `packages/terrain/src/pipeline/region.ts` (stamp features)
- Test: `packages/terrain/test/features.test.ts`

**Interfaces:**
- Consumes: Task 11 (`fillCells`, `slopeAt`, `VolumeField`, `CompiledTerrain`), `surfaceBlock` (Task 10), `hash2`/`hash3`/`unit` (Task 1).
- Produces:
  - `ProbeResult = { top, biome, slope, water, block }`, `newProbe()` and `probe(t, x, z, out)`.
  - `mulberry32(seed)` and `Put`.
  - `MAX_TREE_HEIGHT = 12` and `stampTree(kind, x, base, z, rnd, blocks, put)`.
  - `stampRock(x, top, z, r, rnd, rock, put)`.
  - `FEATURE_CELL = 8`, `FEATURE_REACH = 7` and `stampFeatures(t, x0, z0, w, d, out)`.

How placement stays seamless:
- There is one candidate per 8 × 8 cell of a global grid. The cell hash gives a jittered position, a roll that decides tree, rock or nothing, and a shape seed.
- Each candidate probes its own column. `probe` runs stages 1–4 for that column exactly as `generateRegion` would.
- A region stamps every candidate within `FEATURE_REACH`, in global (gz, gx) order, clipped to the region. A tree on a chunk border is therefore identical in both columns.
- Trees and bushes stand only on the biome's `trees.on` blocks (default grass), with slope ≤ 1, not under water, and with room below the top of the world.
- Rocks need slope ≤ 2 and overwrite whatever they cover. Trees only fill air.

- [ ] **Step 1: Write the failing test**

`packages/terrain/test/features.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { stampFeatures } from '../src/features/place.ts'
import { mulberry32 } from '../src/features/rand.ts'
import { stampRock } from '../src/features/rocks.ts'
import { stampTree } from '../src/features/trees.ts'
import { validateTerrainDoc } from '../src/doc/validate.ts'
import { compileTerrain, type CompiledTerrain } from '../src/pipeline/compile.ts'
import { newProbe, probe } from '../src/pipeline/probe.ts'
import { generateRegion } from '../src/pipeline/region.ts'
import { IDS, idOf, minimalDoc } from './fixtures.ts'

const H = 64
const BLOCKS = { log: IDS.log!, leaves: IDS.leaves!, pineLeaves: IDS.pine_leaves! }

function compileDoc(json: unknown, size = 128): CompiledTerrain {
  const r = validateTerrainDoc({ ...(json as object), size: [size, size] }, { worldHeight: H })
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return compileTerrain(r.doc, { seed: 5, height: H, id: idOf })
}

/** A forest on rolling ground with a river, a cave, an arch and a blob: every stage that can cross a border. */
function busyDoc(): unknown {
  return {
    ...minimalDoc(),
    base: { height: 22, amplitude: 10, noise: { scale: 40 } },
    biomes: [
      { name: 'plain', surface: [{ block: 'sand', nearWater: 1, depth: [0, 1] }, { block: 'grass' }, { block: 'dirt', depth: [1, 3] }], trees: { density: 0.6, kinds: ['broadleaf', 'pine', 'bush'] }, rocks: { density: 0.3, size: [1, 4] } },
    ],
    ops: [
      { id: 'river', type: 'river', shape: { kind: 'path', width: 6, points: [{ x: 0, z: 40 }, { x: 127, z: 60 }] }, params: { start: 24, end: 20 } },
      { id: 'cave', type: 'cave', shape: { kind: 'path', width: 5, points: [{ x: 10, z: 10, y: 18 }, { x: 80, z: 70, y: 14 }] } },
      { id: 'arch', type: 'arch', shape: { kind: 'path', width: 4, points: [{ x: 20, z: 80, y: 28 }, { x: 50, z: 84, y: 28 }] }, params: { rise: 10 } },
      { id: 'island', type: 'blob', shape: { kind: 'circle', center: [64, 30], radius: 9 }, params: { y: 48, height: 4 } },
    ],
  }
}

function regionOf(t: CompiledTerrain, x0: number, z0: number, w: number, d: number, features = true): Uint16Array {
  const out = new Uint16Array(w * d * H)
  generateRegion(t, x0, z0, w, d, out, { features })
  return out
}

describe('tree and rock stamps', () => {
  function stamped(f: (put: (x: number, y: number, z: number, v: number, overwrite: boolean) => void) => void) {
    const cells = new Map<string, number>()
    f((x, y, z, v, overwrite) => { const k = `${x},${y},${z}`; if (overwrite || !cells.has(k)) cells.set(k, v) })
    const xs = [...cells.keys()].map((k) => k.split(',').map(Number))
    return { cells, reach: Math.max(...xs.map(([x, , z]) => Math.max(Math.abs(x!), Math.abs(z!)))), top: Math.max(...xs.map(([, y]) => y!)) }
  }
  it('keeps every tree kind within reach and height limits', () => {
    for (const kind of ['broadleaf', 'pine', 'bush'] as const) {
      for (let s = 0; s < 50; s++) {
        const { cells, reach, top } = stamped((put) => stampTree(kind, 0, 0, 0, mulberry32(s), BLOCKS, put))
        expect(reach).toBeLessThanOrEqual(5)
        expect(top).toBeLessThanOrEqual(12)
        expect(cells.get('0,0,0')).toBe(IDS.log)
      }
    }
  })
  it('keeps rocks within reach and partly buried', () => {
    for (let s = 0; s < 50; s++) {
      const { cells, reach } = stamped((put) => stampRock(0, 10, 0, 6, mulberry32(s), IDS.rock!, put))
      expect(reach).toBeLessThanOrEqual(7)
      expect(cells.get('0,9,0')).toBe(IDS.rock) // below the ground line
    }
  })
  it('varies tree shapes with the seed', () => {
    const a = stamped((put) => stampTree('broadleaf', 0, 0, 0, mulberry32(1), BLOCKS, put)).cells
    const b = stamped((put) => stampTree('broadleaf', 0, 0, 0, mulberry32(2), BLOCKS, put)).cells
    expect([...a.keys()].sort()).not.toEqual([...b.keys()].sort())
  })
})

describe('probe', () => {
  it('matches the region it probes', () => {
    const t = compileDoc(busyDoc())
    const out = regionOf(t, 0, 0, 32, 32, false)
    const p = newProbe()
    for (const [x, z] of [[3, 4], [17, 30], [25, 11]] as const) {
      probe(t, x, z, p)
      let top = H - 1
      while (top >= 0 && (out[x + z * 32 + top * 1024] === 0 || out[x + z * 32 + top * 1024] === (IDS.water! | (7 << 12)))) top--
      expect(p.top).toBe(top)
      expect(p.block).toBe(out[x + z * 32 + top * 1024])
    }
  })
})

describe('stampFeatures', () => {
  it('generates the same voxels as 3 × 3 columns or as one 96 × 96 region', () => {
    const t = compileDoc(busyDoc())
    const whole = regionOf(t, 0, 0, 96, 96)
    let trees = 0, mismatches = 0
    for (let cz = 0; cz < 3; cz++) for (let cx = 0; cx < 3; cx++) {
      const col = regionOf(t, cx * 32, cz * 32, 32, 32)
      for (let y = 0; y < H; y++) for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
        const v = col[lx + lz * 32 + y * 1024]!
        if (v !== whole[cx * 32 + lx + (cz * 32 + lz) * 96 + y * 96 * 96]) mismatches++
        if (v === IDS.log) trees++
      }
    }
    expect(mismatches).toBe(0)
    expect(trees).toBeGreaterThan(100) // the test is not vacuous
  })

  it('never stands a tree on sand, water or air', () => {
    const t = compileDoc(busyDoc())
    const out = regionOf(t, 0, 0, 128, 128)
    const WATER = IDS.water! | (7 << 12)
    let trunks = 0
    for (let z = 0; z < 128; z++) for (let x = 0; x < 128; x++) for (let y = 1; y < H; y++) {
      const i = x + z * 128 + y * 128 * 128, below = out[i - 128 * 128]!
      if (out[i] !== IDS.log || below === IDS.log) continue
      trunks++
      expect([IDS.sand, WATER, 0]).not.toContain(below)
    }
    expect(trunks).toBeGreaterThan(50)
  })

  it('skips trees that would leave the top of the world', () => {
    const t = compileDoc({
      ...minimalDoc(),
      base: { height: H - 6, amplitude: 0, noise: { scale: 9 } },
      biomes: [{ name: 'plain', surface: [{ block: 'grass' }], trees: { density: 1, kinds: ['pine'] } }],
    })
    const out = regionOf(t, 0, 0, 32, 32)
    expect(out.includes(IDS.log!)).toBe(false)
  })

  it('writes nothing outside its region', () => {
    const t = compileDoc(busyDoc())
    const out = new Uint16Array(32 * 32 * H)
    stampFeatures(t, 40, 40, 32, 32, out) // empty terrain buffer: every candidate column is probed, stamps are clipped
    expect(out.length).toBe(32 * 32 * H)
  })

  it('matches a golden hash, so generation is identical on every JS engine', () => {
    const out = regionOf(compileDoc(busyDoc()), 32, 32, 32, 32)
    let h = 0x811c9dc5
    for (let i = 0; i < out.length; i++) h = Math.imul(h ^ out[i]!, 0x01000193)
    expect(h >>> 0).toBe(GOLDEN)
  })
})

const GOLDEN = 84444143
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @elovox/terrain`
Expected: FAIL — cannot resolve `../src/features/place.ts`.

- [ ] **Step 3: Implement the probe**

`packages/terrain/src/pipeline/probe.ts`:

```ts
import { surfaceBlock } from '../biomes/biomes.ts'
import { fillCells, slopeAt } from './cells.ts'
import type { CompiledTerrain } from './compile.ts'
import { VolumeField } from './volume.ts'

export interface ProbeResult {
  /** y of the highest solid voxel, or -1 for an empty column. */
  top: number
  biome: number
  slope: number
  /** Effective water level (river/lake/sea): non-solid voxels below it are water. */
  water: number
  /** Surface block at `top` (before features). */
  block: number
}

export function newProbe(): ProbeResult { return { top: -1, biome: 0, slope: 0, water: 0, block: 0 } }

/** One column through stages 1–4 of the pipeline, exactly as generateRegion would build it. */
export function probe(t: CompiledTerrain, x: number, z: number, out: ProbeResult): void {
  const g = fillCells(t, x - 1, z - 1, 3, 3)
  const solid = new Uint8Array(t.height)
  new VolumeField(t, x, z, 1, 1).column(x, z, g.top[4]!, solid)
  let top = t.height - 1
  while (top >= 0 && !solid[top]) top--
  const water = Math.max(g.water[4]!, t.seaLevel)
  out.top = top
  out.biome = g.biome[4]!
  out.slope = slopeAt(g, 4)
  out.water = water
  out.block = top < 0 ? 0 : surfaceBlock(t.biomes[out.biome]!, t.blocks.fill, {
    depth: 0, slope: out.slope, y: top,
    underwater: top + 1 < water,
    wetRef: Math.max(g.wet[4]!, t.seaLevel),
    ceiling: top > 0 && !solid[top - 1] && top - 1 >= water,
  })
}
```

- [ ] **Step 4: Implement the stamps**

`packages/terrain/src/features/rand.ts`:

```ts
/** Small deterministic PRNG (mulberry32) for one feature's shape. Returns values in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Writes one voxel of a feature; the writer clips to its region and world. */
export type Put = (x: number, y: number, z: number, voxel: number, overwrite: boolean) => void
```

`packages/terrain/src/features/trees.ts`:

```ts
import type { TreeKind } from '../doc/types.ts'
import { hash3, unit } from '../noise/hash.ts'
import type { Put } from './rand.ts'

export interface TreeBlocks { log: number; leaves: number; pineLeaves: number }

/** Tallest tree above its base, so placement can keep trees inside the world. */
export const MAX_TREE_HEIGHT = 12

/** A leaf ellipsoid with a ragged outer shell (deterministic per voxel). */
function leafBall(cx: number, cy: number, cz: number, r: number, squash: number, leaves: number, seed: number, put: Put): void {
  const R = Math.ceil(r)
  const inner = (r - 0.8) * (r - 0.8)
  for (let dy = -R; dy <= R; dy++) for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
    const d2 = dx * dx + dy * squash * (dy * squash) + dz * dz
    if (d2 > r * r) continue
    if (d2 > inner && unit(hash3(seed, cx + dx, cy + dy, cz + dz)) < 0.35) continue
    put(cx + dx, cy + dy, cz + dz, leaves, false)
  }
}

/** Stamps a tree standing on (x, base - 1, z): its trunk starts at y = base. */
export function stampTree(kind: TreeKind, x: number, base: number, z: number, rnd: () => number, b: TreeBlocks, put: Put): void {
  const seed = Math.floor(rnd() * 2 ** 31)
  if (kind === 'bush') {
    put(x, base, z, b.log, false)
    leafBall(x, base + 1, z, 1.7, 1.3, b.leaves, seed, put)
    return
  }
  if (kind === 'pine') {
    const th = 7 + Math.floor(rnd() * 4)
    for (let y = base; y < base + th; y++) put(x, y, z, b.log, false)
    const y0 = base + 2, span = th
    for (let y = y0; y <= base + th; y++) {
      let r = 3.4 * (1 - (y - y0) / span) + 0.5
      if ((y - base) % 2 === 1) r *= 0.7
      const R = Math.ceil(r)
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dz * dz <= r * r) put(x + dx, y, z + dz, b.pineLeaves, false)
      }
    }
    put(x, base + th, z, b.pineLeaves, false)
    put(x, base + th + 1, z, b.pineLeaves, false)
    return
  }
  // broadleaf
  const th = 4 + Math.floor(rnd() * 3)
  for (let y = base; y < base + th; y++) put(x, y, z, b.log, false)
  const cy = base + th
  leafBall(x, cy, z, 2.6, 1.25, b.leaves, seed, put)
  for (let k = 0; k < 3; k++) {
    const a = rnd() * Math.PI * 2
    const dx = Math.round(Math.cos(a) * 2), dz = Math.round(Math.sin(a) * 2), dy = Math.floor(rnd() * 3) - 1
    leafBall(x + dx, cy + dy, z + dz, 1.8 + rnd() * 0.6, 1.25, b.leaves, seed + k + 1, put)
  }
}
```

`packages/terrain/src/features/rocks.ts`:

```ts
import { hash3, unit } from '../noise/hash.ts'
import type { Put } from './rand.ts'

/** A boulder of radius r on the ground at (x, top, z), partly buried; overwrites whatever is there. */
export function stampRock(x: number, top: number, z: number, r: number, rnd: () => number, rock: number, put: Put): void {
  const seed = Math.floor(rnd() * 2 ** 31)
  const cy = top + Math.round(r * 0.2)
  const ry = r * 0.75
  const R = Math.ceil(r * 1.07)
  for (let dy = -R; dy <= R; dy++) for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
    const q = (dx / r) ** 2 + (dy / ry) ** 2 + (dz / r) ** 2
    if (q <= 1 + 0.25 * (unit(hash3(seed, x + dx, cy + dy, z + dz)) - 0.5)) put(x + dx, cy + dy, z + dz, rock, true)
  }
}
```

- [ ] **Step 5: Implement placement**

`packages/terrain/src/features/place.ts`:

```ts
import { hash2, unit } from '../noise/hash.ts'
import type { CompiledTerrain } from '../pipeline/compile.ts'
import { newProbe, probe } from '../pipeline/probe.ts'
import { mulberry32, type Put } from './rand.ts'
import { stampRock } from './rocks.ts'
import { MAX_TREE_HEIGHT, stampTree } from './trees.ts'

/** One feature candidate per FEATURE_CELL × FEATURE_CELL columns. */
export const FEATURE_CELL = 8
/** No feature reaches farther than this from its anchor column (trees ≤ 5, rocks ≤ 7). */
export const FEATURE_REACH = 7

const JITTER_SEED = 0x6a09e667
const ROLL_SEED = 0x3c6ef372
const SHAPE_SEED = 0x510e527f

/**
 * Stamps every tree and rock that reaches [x0, x0 + w) × [z0, z0 + d) into `out` (generateRegion's
 * layout). Candidates come from a global jittered grid and are visited in global (gz, gx) order, and
 * each one probes its own column, so overlapping stamps resolve the same way in any region.
 */
export function stampFeatures(t: CompiledTerrain, x0: number, z0: number, w: number, d: number, out: Uint16Array): void {
  const H = t.height
  const layer = w * d
  const put: Put = (x, y, z, v, overwrite) => {
    if (x < x0 || x >= x0 + w || z < z0 || z >= z0 + d || y < 0 || y >= H) return
    const i = (x - x0) + (z - z0) * w + y * layer
    if (overwrite || out[i] === 0) out[i] = v
  }
  const p = newProbe()
  const gx0 = Math.floor((x0 - FEATURE_REACH) / FEATURE_CELL), gx1 = Math.floor((x0 + w - 1 + FEATURE_REACH) / FEATURE_CELL)
  const gz0 = Math.floor((z0 - FEATURE_REACH) / FEATURE_CELL), gz1 = Math.floor((z0 + d - 1 + FEATURE_REACH) / FEATURE_CELL)
  for (let gz = gz0; gz <= gz1; gz++) for (let gx = gx0; gx <= gx1; gx++) {
    const j = hash2(t.seed ^ JITTER_SEED, gx, gz)
    const px = gx * FEATURE_CELL + (j & 7), pz = gz * FEATURE_CELL + ((j >>> 3) & 7)
    if (px < 0 || pz < 0 || px >= t.sizeX || pz >= t.sizeZ) continue
    const roll = unit(hash2(t.seed ^ ROLL_SEED, gx, gz))
    probe(t, px, pz, p)
    if (p.top < 0 || p.top + 1 < p.water) continue // empty column or under water
    const biome = t.biomes[p.biome]!
    const treeChance = biome.trees?.density ?? 0
    const rnd = mulberry32(hash2(t.seed ^ SHAPE_SEED, gx, gz))
    if (roll < treeChance) {
      const trees = biome.trees!
      if (p.slope > 1 || !trees.on.has(p.block) || p.top + 2 + MAX_TREE_HEIGHT >= H) continue
      const kind = trees.kinds[Math.floor(rnd() * trees.kinds.length)]!
      stampTree(kind, px, p.top + 1, pz, rnd, t.blocks, put)
    } else if (biome.rocks && roll < treeChance + biome.rocks.density) {
      if (p.slope > 2) continue
      const [r0, r1] = biome.rocks.size
      stampRock(px, p.top, pz, r0 + rnd() * (r1 - r0), rnd, t.blocks.rock, put)
    }
  }
}
```

- [ ] **Step 6: Stamp features at the end of generateRegion**

In `packages/terrain/src/pipeline/region.ts`, add the import:

```ts
import { stampFeatures } from '../features/place.ts'
```

and make this the last line of `generateRegion`:

```ts
  if (o.features !== false) stampFeatures(t, x0, z0, w, d, out)
```

- [ ] **Step 7: Run the tests and the typecheck**

Run: `npm test -w @elovox/terrain` then `npm run typecheck -w @elovox/terrain`
Expected: all pass. The seam test (3 × 3 columns == one 96 × 96 region) is the key one. If it fails, look for something that depends on the region rather than on world coordinates: lattice alignment, candidate order, or a clip that skips a write.

- [ ] **Step 8: Commit**

```bash
git add packages/terrain/src/pipeline packages/terrain/src/features packages/terrain/test/features.test.ts
git commit -m "feat(terrain): trees and rocks on a global jittered grid, seamless across columns"
```

---

## Part B — Engine: generator documents, parallel generation, regeneration

Run the engine tests with `npm test -w @elovox/engine` and its typecheck with `npm run typecheck -w @elovox/engine`. Several engine files may use CRLF line endings. Keep each file's existing endings.

### Task 13: Generator documents and the column buffer

**Files:**
- Modify: `packages/engine/src/sim/generator.ts`
- Modify: `packages/engine/src/sim/simulation.ts` (generation split into steps)
- Modify: `packages/engine/src/protocol.ts`, `packages/engine/src/sim/simHost.ts`, `packages/engine/src/engine.ts`, `packages/engine/src/sim/runSimWorker.ts`
- Test: `packages/engine/test/generator.test.ts` (append)

**Interfaces:**
- Produces:
  - `GeneratorInfo = { size, seed, id(name) }`.
  - `GeneratorContext.column: Uint16Array` (index `lx + (lz << 5) + (y << 10)`, air on entry).
  - `GeneratorModule.configure?(doc, info)` and `makeColumnContext(seed, height, id, column)`.
  - `Simulation.configure(gen, doc)`, `.generateColumnData(gen, cx, cz, column)`, `.applyColumn(cx, cz, column)` and `.finishGenerate()`. `generate(gen)` is now built from these.
  - `ToSim` init gains `terrain?: unknown`. `FromSim` 'ready' gains `genMs` and `columns`.
  - `EngineOptions.terrain?: unknown`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/engine/test/generator.test.ts`, and extend its imports:

```ts
import { defineGenerator, makeColumnContext, valueNoise2, type GeneratorInfo } from '../src/sim/generator.ts'
import { SimHost } from '../src/sim/simHost.ts'
import type { FromSim } from '../src/protocol.ts'
```

```ts
describe('generator configure and column context', () => {
  it('writes through ctx.column directly, in the engine column layout', () => {
    const s = sim()
    s.generate(defineGenerator({
      generateColumn(ctx) { ctx.column[3 + (4 << 5) + (5 << 10)] = ctx.id('glass') },
    }))
    expect(s.store.getVoxel(3, 5, 4)).toBe(ID.glass)
    expect(s.store.getVoxel(35, 5, 4)).toBe(ID.glass) // every column ran
  })

  it('makeColumnContext checks set() bounds and clears nothing itself', () => {
    const col = new Uint16Array(32 * 32 * 8)
    const ctx = makeColumnContext(1, 8, () => 7, col)
    ctx.set(31, 7, 31, 9)
    expect(col[31 + (31 << 5) + (7 << 10)]).toBe(9)
    expect(() => ctx.set(0, 8, 0, 1)).toThrow(RangeError)
  })

  function host(gen: ReturnType<typeof defineGenerator>, terrain?: unknown) {
    const out: FromSim[] = []
    const clock = { now: () => 0, setTimeout: () => 0, clearTimeout() {} }
    const h = new SimHost((m) => out.push(m), { generator: gen }, clock)
    h.handle({ type: 'init', buffers: createWorldBuffers([64, 64, 64]), blocks: TEST_BLOCKS, seed: 5, options: {}, terrain })
    return out
  }

  it('passes the terrain document and world info to configure before generating', () => {
    const calls: string[] = []
    let info: GeneratorInfo | null = null
    const out = host(defineGenerator({
      configure(doc, i) { calls.push(`configure ${JSON.stringify(doc)}`); info = i },
      generateColumn() { calls.push('column') },
    }), { level: 3 })
    expect(calls[0]).toBe('configure {"level":3}')
    expect(calls.length).toBe(5)
    expect(info!.size).toEqual([64, 64, 64])
    expect(info!.seed).toBe(5)
    expect(info!.id('stone')).toBe(ID.stone)
    const ready = out.find((m) => m.type === 'ready')
    expect(ready?.type === 'ready' && ready.columns).toBe(4)
  })

  it('skips configure when there is no document', () => {
    let configured = false
    host(defineGenerator({ configure() { configured = true }, generateColumn() {} }))
    expect(configured).toBe(false)
  })

  it('reports a rejected document as fatal with the generator message', () => {
    const out = host(defineGenerator({ configure() { throw new Error('bad doc: ops[0].id: is required') }, generateColumn() {} }), {})
    expect(out).toEqual([{ type: 'fatal', message: 'Error: bad doc: ops[0].id: is required' }])
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w @elovox/engine`
Expected: FAIL — `makeColumnContext` is not exported; `ctx.column` is undefined.

- [ ] **Step 3: Rewrite generator.ts**

`packages/engine/src/sim/generator.ts` (keeps `valueNoise2`/`fbm2` unchanged; adds the column buffer, `configure` and `makeColumnContext`):

```ts
import type { WorldSize } from '../world/layout.ts'
import { hash32 } from './rng.ts'

/** What a generator learns about the world when it receives a document. */
export interface GeneratorInfo {
  readonly size: WorldSize
  readonly seed: number
  /** Block name → id; throws for an unknown name. */
  id(name: string): number
}

export interface GeneratorContext {
  readonly seed: number
  readonly height: number
  /**
   * The column's voxels, index lx + (lz << 5) + (y << 10), all air on entry. Writing here directly is
   * the fast path; `set` is the checked one.
   */
  readonly column: Uint16Array
  /** Local column coordinates: lx, lz in 0..31, y in 0..height-1. */
  set(lx: number, y: number, lz: number, voxel: number): void
  id(name: string): number
  noise2(x: number, z: number): number
  fbm2(x: number, z: number, octaves: number): number
}

export interface GeneratorModule {
  generateColumn(ctx: GeneratorContext, cx: number, cz: number): void
  /**
   * Receives the engine's `terrain` document before the first column, and again on every
   * `engine.terrain.setDocument`. Throw to reject the document; the error message reaches the caller.
   */
  configure?(doc: unknown, info: GeneratorInfo): void
}

export function defineGenerator(g: GeneratorModule): GeneratorModule {
  return g
}

/** The context the sim and the generation workers hand to `generateColumn`. */
export function makeColumnContext(seed: number, height: number, id: (name: string) => number, column: Uint16Array): GeneratorContext {
  return {
    seed,
    height,
    column,
    set: (lx, y, lz, v) => {
      if (!Number.isInteger(lx) || !Number.isInteger(y) || !Number.isInteger(lz) ||
          lx < 0 || lx > 31 || lz < 0 || lz > 31 || y < 0 || y >= height) {
        throw new RangeError(`generator write outside column: (${lx}, ${y}, ${lz})`)
      }
      column[lx + (lz << 5) + (y << 10)] = v
    },
    id,
    noise2: (x, z) => valueNoise2(seed, x, z),
    fbm2: (x, z, octaves) => fbm2(seed, x, z, octaves),
  }
}

function lattice(seed: number, ix: number, iz: number): number {
  return hash32(seed, ix, iz) / 4294967296
}
function smooth(t: number): number { return t * t * (3 - 2 * t) }

/** Bilinear value noise in [0, 1). Arithmetic only, so it is identical on every JS engine. */
export function valueNoise2(seed: number, x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z)
  const fx = smooth(x - ix), fz = smooth(z - iz)
  const a = lattice(seed, ix, iz), b = lattice(seed, ix + 1, iz)
  const c = lattice(seed, ix, iz + 1), d = lattice(seed, ix + 1, iz + 1)
  const top = a + (b - a) * fx
  const bottom = c + (d - c) * fx
  return top + (bottom - top) * fz
}

export function fbm2(seed: number, x: number, z: number, octaves: number): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2(seed + o * 1013, x * freq, z * freq)
    norm += amp
    amp *= 0.5
    freq *= 2
  }
  return Math.min(sum / norm, 0.999999)
}
```

- [ ] **Step 4: Split Simulation.generate into steps**

In `packages/engine/src/sim/simulation.ts`, change the generator import to:

```ts
import { makeColumnContext, type GeneratorModule } from './generator.ts'
```

and replace the whole `generate(gen)` method (from its doc comment down to just before `step(): TickResult {`) with:

```ts
  /** Hands the generator its document (GeneratorModule.configure). Throws if the generator rejects it. */
  configure(gen: GeneratorModule, doc: unknown): void {
    gen.configure?.(doc, { size: this.layout.size, seed: this.seed, id: (name) => this.registry.id(name) })
  }

  /** Runs the generator for chunk column (cx, cz) into `column` (32 × 32 × height voxels, cleared to air first). */
  generateColumnData(gen: GeneratorModule, cx: number, cz: number, column: Uint16Array): void {
    column.fill(AIR)
    gen.generateColumn(makeColumnContext(this.seed, this.layout.size[1], (name) => this.registry.id(name), column), cx, cz)
  }

  /** Writes a generated column into the world. Chunks stay open until finishGenerate or replaceColumns commits. */
  applyColumn(cx: number, cz: number, column: Uint16Array): void {
    const L = this.layout
    if (column.length !== 32 * 32 * L.size[1]) throw new RangeError(`column has ${column.length} voxels, expected ${32 * 32 * L.size[1]}`)
    for (let cy = 0; cy < L.cy; cy++) {
      this.store.writeChunkDense(L.chunkIndex(cx, cy, cz), column.subarray(cy * 32768, (cy + 1) * 32768))
    }
  }

  /** After every column is applied: the initial light pass, then commit. Returns every chunk index. */
  finishGenerate(): number[] {
    // No commit between the dense writes and initialize(): initialize writes slots directly and
    // relies on generation having left those chunks open. Commit after, so every version is even.
    this.light.initialize()
    this.store.commit()
    return Array.from({ length: this.layout.chunkCount }, (_, i) => i)
  }

  /** Runs once before tick 0, serially. Returns every chunk index; the mesher skips trivial ones. */
  generate(gen: GeneratorModule): number[] {
    const L = this.layout
    const column = new Uint16Array(32 * 32 * L.size[1])
    for (let cz = 0; cz < L.cz; cz++) for (let cx = 0; cx < L.cx; cx++) {
      this.generateColumnData(gen, cx, cz, column)
      this.applyColumn(cx, cz, column)
    }
    return this.finishGenerate()
  }
```

- [ ] **Step 5: Pass the document through the protocol and SimHost**

In `packages/engine/src/protocol.ts`, change the `init` and `ready` members to:

```ts
  /** `terrain`: the document handed to the generator's configure() before generation. */
  | { type: 'init'; buffers: WorldBuffers; blocks: BlockDef[]; seed: number; options: SimInitOptions; terrain?: unknown }
```

```ts
  /** `genMs`: wall time of the initial generation, light pass included. `columns`: chunk columns generated. */
  | { type: 'ready'; chunks: number[]; slotsUsed: number; genMs: number; columns: number }
```

In `packages/engine/src/sim/simHost.ts`, inside `case 'init'`, replace

```ts
          const chunks = this.sim.generate(this.modules.generator)
          this.post({ type: 'ready', chunks, slotsUsed: this.sim.store.slotsUsed() })
```

with

```ts
          if (msg.terrain !== undefined) this.sim.configure(this.modules.generator, msg.terrain)
          const t0 = this.clock.now()
          const chunks = this.sim.generate(this.modules.generator)
          const L = this.sim.layout
          this.post({ type: 'ready', chunks, slotsUsed: this.sim.store.slotsUsed(), genMs: this.clock.now() - t0, columns: L.cx * L.cz })
```

In `packages/engine/src/engine.ts`, add to `EngineOptions` (after `textureScale`):

```ts
  /** A terrain document for the generator (structured-cloneable, e.g. parsed JSON). Passed to its configure(). */
  terrain?: unknown
```

and pass it in the init message:

```ts
  sim.postMessage({ type: 'init', buffers, blocks: o.blocks, seed: o.seed, options: o.sim ?? {}, terrain: o.terrain } satisfies ToSim)
```

In `packages/engine/src/sim/runSimWorker.ts`, export the new type as well:

```ts
export type { GeneratorContext, GeneratorInfo, GeneratorModule } from './generator.ts'
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npm test -w @elovox/engine` then `npm run typecheck -w @elovox/engine`
Expected: all pass. The determinism test and the existing generator tests must not change.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/sim/generator.ts packages/engine/src/sim/simulation.ts packages/engine/src/protocol.ts packages/engine/src/sim/simHost.ts packages/engine/src/engine.ts packages/engine/src/sim/runSimWorker.ts packages/engine/test/generator.test.ts
git commit -m "feat(engine): generator documents (configure) and direct column writes"
```

### Task 14: The terrain generator, package exports and benchmark

**Files:**
- Create: `packages/terrain/src/generator.ts`, `packages/terrain/bench/column.bench.ts`
- Modify: `packages/terrain/src/index.ts` (full export list)
- Test: `packages/terrain/test/generator.test.ts`

**Interfaces:**
- Consumes: `GeneratorInfo`, `GeneratorModule` from `@elovox/engine/sim-worker` (Task 13); `validateTerrainDoc`/`TerrainDocError` (Task 6); `compileTerrain`/`generateRegion` (Tasks 11–12).
- Produces: `createTerrainGenerator({ ops? }): GeneratorModule`, `terrainGenerator`, `TerrainGeneratorOptions`, and the package's public API in `index.ts`.

`configure` validates, checks the size and compiles, and only then replaces the current terrain. A rejected document leaves the previous one in force; `engine.terrain.setDocument` depends on that.

- [ ] **Step 1: Write the failing test**

`packages/terrain/test/generator.test.ts`:

```ts
import { defineBlock } from '@elovox/engine/src/blocks/registry.ts'
import { Simulation } from '@elovox/engine/src/sim/simulation.ts'
import { createWorldBuffers } from '@elovox/engine/src/world/buffers.ts'
import { describe, expect, it } from 'vitest'
import { createTerrainGenerator, terrainGenerator } from '../src/generator.ts'
import { encodeRaster } from '../src/layers/raster.ts'
import { builtinOps } from '../src/ops/builtin.ts'
import { defineTerrainOp } from '../src/ops/registry.ts'
import { minimalDoc } from './fixtures.ts'

const BLOCKS = ['stone', 'dirt', 'grass', 'sand', 'water', 'log', 'leaves', 'pine_leaves', 'rock'].map((name) =>
  defineBlock(name === 'water' ? { name, liquid: true, solid: false } : { name }))

function sim(): Simulation {
  return new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks: BLOCKS, seed: 9 })
}

describe('terrainGenerator', () => {
  it('generates the document into the world through the engine', () => {
    const s = sim()
    s.configure(terrainGenerator, minimalDoc())
    s.generate(terrainGenerator)
    expect(s.store.getVoxel(10, 19, 10)).toBe(s.registry.id('grass'))
    expect(s.store.getVoxel(10, 20, 10)).toBe(0)
  })

  it('rejects an invalid document with every error and its path', () => {
    expect(() => sim().configure(terrainGenerator, { ...minimalDoc(), seaLevel: -1, ops: [{ id: 'x', type: 'volcano', shape: { kind: 'circle', center: [0, 0], radius: 1 } }] }))
      .toThrow('invalid terrain document:\n  - seaLevel: must be >= 0\n  - ops[0].type: unknown op type "volcano"')
  })

  it('rejects a document whose size differs from the world', () => {
    expect(() => sim().configure(terrainGenerator, { ...minimalDoc(), size: [128, 64] }))
      .toThrow("terrain document size [128, 64] does not match the world's x, z [64, 64]")
  })

  it('rejects a document that uses an unregistered block, naming it', () => {
    expect(() => sim().configure(terrainGenerator, { ...minimalDoc(), biomes: [{ name: 'plain', surface: [{ block: 'snow' }] }] }))
      .toThrow('the terrain document uses block "snow", which is not registered')
  })

  it('keeps the previous document when a new one is rejected', () => {
    const gen = createTerrainGenerator()
    const s = sim()
    s.configure(gen, minimalDoc())
    expect(() => s.configure(gen, { ...minimalDoc(), base: 'flat' })).toThrow()
    s.generate(gen)
    expect(s.store.getVoxel(10, 19, 10)).toBe(s.registry.id('grass'))
  })

  it('explains a missing document', () => {
    expect(() => sim().generate(createTerrainGenerator())).toThrow('the terrain generator has no document: pass `terrain` to createEngine')
  })

  it('accepts custom ops', () => {
    const raise = defineTerrainOp({
      type: 'raise', kind: 'height', defaultBlend: 'add', shapes: ['circle'],
      validate() {},
      compile(def) { return { id: def.id, bounds: { x0: 0, z0: 0, x1: 63, z1: 63 }, apply(_x, _z, cell) { cell.h += 5 } } },
    })
    const gen = createTerrainGenerator({ ops: builtinOps.with(raise) })
    const s = sim()
    s.configure(gen, { ...minimalDoc(), ops: [{ id: 'r', type: 'raise', shape: { kind: 'circle', center: [0, 0], radius: 1 } }] })
    s.generate(gen)
    expect(s.store.getVoxel(10, 24, 10)).toBe(s.registry.id('grass'))
  })

  it('round-trips a document with layers through JSON', () => {
    const height = new Int16Array(64 * 64).fill(3)
    const doc = { ...minimalDoc(), layers: { height: encodeRaster('i16', 64, 64, height) } }
    const s = sim()
    s.configure(terrainGenerator, JSON.parse(JSON.stringify(doc)))
    s.generate(terrainGenerator)
    expect(s.store.getVoxel(10, 22, 10)).toBe(s.registry.id('grass'))
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @elovox/terrain`
Expected: FAIL — cannot resolve `../src/generator.ts`.

- [ ] **Step 3: Implement**

`packages/terrain/src/generator.ts`:

```ts
import type { GeneratorInfo, GeneratorModule } from '@elovox/engine/sim-worker'
import { TerrainDocError, validateTerrainDoc } from './doc/validate.ts'
import { builtinOps } from './ops/builtin.ts'
import type { OpRegistry } from './ops/registry.ts'
import { compileTerrain, type CompiledTerrain } from './pipeline/compile.ts'
import { generateRegion } from './pipeline/region.ts'

export interface TerrainGeneratorOptions {
  /** Op types documents may use. Default: the built-in ops. Add custom ops with `builtinOps.with(...)`. */
  ops?: OpRegistry
}

/**
 * A GeneratorModule that builds the world from a TerrainDoc. The engine hands it the document through
 * configure() (createEngine's `terrain` option, then engine.terrain.setDocument). Use the same
 * generator in the sim worker and the generation workers.
 */
export function createTerrainGenerator(o: TerrainGeneratorOptions = {}): GeneratorModule {
  const ops = o.ops ?? builtinOps
  let terrain: CompiledTerrain | null = null
  return {
    configure(doc: unknown, info: GeneratorInfo) {
      const r = validateTerrainDoc(doc, { ops, worldHeight: info.size[1] })
      if (!r.ok) throw new TerrainDocError(r.errors)
      const [sx, , sz] = info.size
      if (r.doc.size[0] !== sx || r.doc.size[1] !== sz) {
        throw new Error(`terrain document size [${r.doc.size.join(', ')}] does not match the world's x, z [${sx}, ${sz}]`)
      }
      // Compile before replacing: a document that fails here leaves the previous one in force.
      terrain = compileTerrain(r.doc, { seed: info.seed, height: info.size[1], id: (name) => info.id(name), ops })
    },
    generateColumn(ctx, cx, cz) {
      if (!terrain) throw new Error('the terrain generator has no document: pass `terrain` to createEngine')
      generateRegion(terrain, cx * 32, cz * 32, 32, 32, ctx.column)
    },
  }
}

/** The terrain generator with the built-in ops. */
export const terrainGenerator = createTerrainGenerator()
```

Replace `packages/terrain/src/index.ts` with:

```ts
export { createTerrainGenerator, terrainGenerator, type TerrainGeneratorOptions } from './generator.ts'
export { TERRAIN_FORMAT, TERRAIN_VERSION, TerrainDocError, validateTerrainDoc, type ValidateOptions, type ValidateResult } from './doc/validate.ts'
export type {
  BaseDef, BiomeDef, BiomeRule, BiomeRuleEntry, BlendMode, BlockNames, BrickRef, BrickSetRef, OpDef, PathPoint,
  RasterRef, ShapeDef, SurfaceRule, TerrainDoc, TerrainLayers, TreeKind, Vec2,
} from './doc/types.ts'
export { Check, checkNoise } from './doc/check.ts'
export { BUILTIN_OPS, builtinOps } from './ops/builtin.ts'
export {
  OpRegistry, defineTerrainOp,
  type Cell, type CompileContext, type HeightOp, type HeightOpImpl, type OpImpl, type ValidateContext, type VolumeOp, type VolumeOpImpl,
} from './ops/registry.ts'
export { compileShape, newSample, weight, type Shape, type ShapeSample } from './shapes/shape.ts'
export { PROFILES, profile, smoothstep01, type Profile } from './shapes/profile.ts'
export { blend } from './shapes/blend.ts'
export { encodeBrick, encodeRaster, decodeRaster } from './layers/raster.ts'
export { makeNoise2, makeNoise3, type NoiseDef, type NoiseType, type Sampler2, type Sampler3 } from './noise/def.ts'
export { compileTerrain, TerrainOpError, type CompiledTerrain } from './pipeline/compile.ts'
export { generateRegion } from './pipeline/region.ts'
export { hash2, hash3, unit } from './noise/hash.ts'
```

- [ ] **Step 4: Add the benchmark**

`packages/terrain/bench/column.bench.ts`:

```ts
import { bench, describe } from 'vitest'
import { validateTerrainDoc } from '../src/doc/validate.ts'
import { compileTerrain, type CompiledTerrain } from '../src/pipeline/compile.ts'
import { generateRegion } from '../src/pipeline/region.ts'
import { idOf, minimalDoc } from '../test/fixtures.ts'

const H = 128
function compile(extra: Record<string, unknown>): CompiledTerrain {
  const r = validateTerrainDoc({ ...minimalDoc(), size: [512, 512], ...extra }, { worldHeight: H })
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return compileTerrain(r.doc, { seed: 1, height: H, id: idOf })
}

const rolling = {
  base: { height: 40, amplitude: 24, noise: { scale: 120, octaves: 5, warp: { scale: 200, amount: 30 } } },
  biomes: [{ name: 'plain', surface: [{ block: 'stone', slope: [1.5, 99] }, { block: 'grass' }, { block: 'dirt', depth: [1, 3] }], trees: { density: 0.15, kinds: ['broadleaf', 'pine'] }, rocks: { density: 0.03, size: [1, 3] } }],
}
const twoD = compile({
  ...rolling,
  ops: [
    { id: 'm', type: 'mountain', shape: { kind: 'path', width: 300, points: [{ x: 0, z: 100 }, { x: 511, z: 120 }] }, params: { height: 50 } },
    { id: 'r', type: 'river', shape: { kind: 'path', width: 10, points: [{ x: 0, z: 300 }, { x: 511, z: 330 }] }, params: { start: 40, end: 34 } },
  ],
})
const threeD = compile({
  ...rolling,
  ops: [
    { id: 'c', type: 'cave', shape: { kind: 'path', width: 8, points: [{ x: 0, z: 16, y: 30 }, { x: 511, z: 16, y: 40 }] } },
    { id: 'a', type: 'arch', shape: { kind: 'path', width: 6, points: [{ x: 0, z: 10, y: 50 }, { x: 40, z: 20, y: 50 }] }, params: { rise: 12 } },
  ],
})
const out = new Uint16Array(32 * 32 * H)

describe('generateRegion, one 32 × 32 × 128 column', () => {
  bench('2D ops only (mountain, river, trees)', () => { generateRegion(twoD, 64, 96, 32, 32, out) })
  bench('with volume ops (cave, arch)', () => { generateRegion(threeD, 0, 0, 32, 32, out) })
})
```

- [ ] **Step 5: Run the tests, the typecheck and the benchmark**

Run: `npm test -w @elovox/terrain`, then `npm run typecheck -w @elovox/terrain`, then `npm run bench -w @elovox/terrain`
Expected: all tests pass and the typecheck is clean. The benchmark prints ms per column. On the prototype machine both cases took about 6.3 ms (≈ 160 hz). Record the numbers in the commit message. If either case is above 15 ms, profile before going on: the 6 s budget for 1024² depends on it.

- [ ] **Step 6: Commit**

```bash
git add packages/terrain/src/generator.ts packages/terrain/src/index.ts packages/terrain/bench packages/terrain/test/generator.test.ts
git commit -m "feat(terrain): terrainGenerator adapter, public API and column benchmark"
```


### Task 15: The generation worker

**Files:**
- Create: `packages/engine/src/gen/genHost.ts`, `packages/engine/src/gen/runGenWorker.ts`
- Modify: `packages/engine/src/protocol.ts`, `packages/engine/package.json` (export `./gen-worker`)
- Test: `packages/engine/test/genHost.test.ts`

**Interfaces:**
- Consumes: `makeColumnContext`, `GeneratorModule` (Task 13), `BlockRegistry`.
- Produces:
  - `ToGen` (`configure { epoch, doc, size, seed, blocks }` | `job { id, cx, cz }`).
  - `FromGen` (`column { id, epoch, cx, cz, data }` | `error { id, epoch, message }`).
  - `GenConnect { type: 'connect', port }`.
  - `class GenHost(post, gen)` with `.handle(msg)`.
  - `runGenWorker({ generator })` from `@elovox/engine/gen-worker`.

A generation worker holds one configuration. It answers every job with the epoch it was generated under, and an error if its document was rejected. Columns are transferred, not copied.

- [ ] **Step 1: Add the protocol types**

In `packages/engine/src/protocol.ts`, add the import `import type { WorldSize } from './world/layout.ts'` and, above `/** World-space ghost voxel …`, the types:

```ts
/** Sim worker → generation worker (over a MessagePort). Jobs answer with the configuration in force. */
export type ToGen =
  | { type: 'configure'; epoch: number; doc: unknown; size: WorldSize; seed: number; blocks: BlockDef[] }
  | { type: 'job'; id: number; cx: number; cz: number }

/** Generation worker → sim worker. `epoch` is the configuration the column was generated with. */
export type FromGen =
  | { type: 'column'; id: number; epoch: number; cx: number; cz: number; data: Uint16Array }
  | { type: 'error'; id: number; epoch: number; message: string }

/** Main thread → generation worker, once: the port to the sim worker. */
export interface GenConnect { type: 'connect'; port: MessagePort }
```

- [ ] **Step 2: Write the failing test**

`packages/engine/test/genHost.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { GenHost } from '../src/gen/genHost.ts'
import type { FromGen } from '../src/protocol.ts'
import { defineGenerator } from '../src/sim/generator.ts'
import { Simulation } from '../src/sim/simulation.ts'
import { testGenerator } from '../src/sim/testGenerator.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { TEST_BLOCKS } from './helpers.ts'

function setup(gen = testGenerator) {
  const out: { m: FromGen; transfer: Transferable[] }[] = []
  const host = new GenHost((m, transfer) => out.push({ m, transfer }), gen)
  return { host, out }
}
const configure = (epoch: number, doc?: unknown) =>
  ({ type: 'configure', epoch, doc, size: [64, 64, 64], seed: 5, blocks: TEST_BLOCKS }) as const

describe('GenHost', () => {
  it('generates the same column as the sim does, and transfers its buffer', () => {
    const { host, out } = setup()
    host.handle(configure(1))
    host.handle({ type: 'job', id: 7, cx: 1, cz: 0 })
    const r = out[0]!
    expect(r.m.type === 'column' && [r.m.id, r.m.epoch, r.m.cx, r.m.cz]).toEqual([7, 1, 1, 0])
    const sim = new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks: TEST_BLOCKS, seed: 5 })
    const expected = new Uint16Array(32 * 32 * 64)
    sim.generateColumnData(testGenerator, 1, 0, expected)
    expect(r.m.type === 'column' && r.m.data).toEqual(expected)
    expect(r.transfer).toEqual([r.m.type === 'column' && r.m.data.buffer])
  })

  it('answers jobs with an error until configured', () => {
    const { host, out } = setup()
    host.handle({ type: 'job', id: 1, cx: 0, cz: 0 })
    expect(out[0]!.m).toEqual({ type: 'error', id: 1, epoch: -1, message: 'not configured' })
  })

  it('reports a rejected document on every job of that epoch, and recovers on the next configure', () => {
    let reject = true
    const gen = defineGenerator({
      configure() { if (reject) throw new Error('ops[2].type: unknown op type "x"') },
      generateColumn() {},
    })
    const { host, out } = setup(gen)
    host.handle(configure(3, {}))
    host.handle({ type: 'job', id: 1, cx: 0, cz: 0 })
    expect(out[0]!.m).toEqual({ type: 'error', id: 1, epoch: 3, message: 'Error: ops[2].type: unknown op type "x"' })
    reject = false
    host.handle(configure(4, {}))
    host.handle({ type: 'job', id: 2, cx: 0, cz: 0 })
    expect(out[1]!.m.type).toBe('column')
  })

  it('reports a column that throws', () => {
    const { host, out } = setup(defineGenerator({ generateColumn(_ctx, cx) { if (cx === 1) throw new RangeError('boom') } }))
    host.handle(configure(1))
    host.handle({ type: 'job', id: 9, cx: 1, cz: 0 })
    expect(out[0]!.m).toEqual({ type: 'error', id: 9, epoch: 1, message: 'RangeError: boom' })
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -w @elovox/engine`
Expected: FAIL — cannot resolve `../src/gen/genHost.ts`.

- [ ] **Step 4: Implement**

`packages/engine/src/gen/genHost.ts`:

```ts
import { BlockRegistry } from '../blocks/registry.ts'
import type { FromGen, ToGen } from '../protocol.ts'
import { makeColumnContext, type GeneratorModule } from '../sim/generator.ts'

/** The logic of a generation worker: holds one configuration and turns column jobs into voxel buffers. */
export class GenHost {
  private readonly post: (m: FromGen, transfer: Transferable[]) => void
  private readonly gen: GeneratorModule
  private epoch = -1
  private error: string | null = 'not configured'
  private seed = 0
  private height = 0
  private registry: BlockRegistry | null = null

  constructor(post: (m: FromGen, transfer: Transferable[]) => void, gen: GeneratorModule) {
    this.post = post
    this.gen = gen
  }

  handle(m: ToGen): void {
    if (m.type === 'configure') {
      this.epoch = m.epoch
      this.error = null
      try {
        const registry = new BlockRegistry(m.blocks)
        this.registry = registry
        this.seed = m.seed
        this.height = m.size[1]
        if (m.doc !== undefined) this.gen.configure?.(m.doc, { size: m.size, seed: m.seed, id: (name) => registry.id(name) })
      } catch (e) {
        this.error = message(e)
      }
      return
    }
    if (this.error !== null) {
      this.post({ type: 'error', id: m.id, epoch: this.epoch, message: this.error }, [])
      return
    }
    const registry = this.registry!
    const column = new Uint16Array(32 * 32 * this.height)
    try {
      this.gen.generateColumn(makeColumnContext(this.seed, this.height, (name) => registry.id(name), column), m.cx, m.cz)
    } catch (e) {
      this.post({ type: 'error', id: m.id, epoch: this.epoch, message: message(e) }, [])
      return
    }
    this.post({ type: 'column', id: m.id, epoch: this.epoch, cx: m.cx, cz: m.cz, data: column }, [column.buffer])
  }
}

function message(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}
```

`packages/engine/src/gen/runGenWorker.ts`:

```ts
import type { GenConnect, ToGen } from '../protocol.ts'
import type { GeneratorModule } from '../sim/generator.ts'
import { GenHost } from './genHost.ts'

interface WorkerScope { onmessage: ((e: MessageEvent<GenConnect>) => void) | null }

/** Call this from your game's `gen.worker.ts` with the same generator the sim worker uses. */
export function runGenWorker(modules: { generator: GeneratorModule }): void {
  const scope = globalThis as unknown as WorkerScope
  scope.onmessage = (e) => {
    if (e.data.type !== 'connect') return
    const port = e.data.port
    const host = new GenHost((m, transfer) => port.postMessage(m, transfer), modules.generator)
    port.onmessage = (ev: MessageEvent<ToGen>) => host.handle(ev.data)
  }
}

export { defineGenerator } from '../sim/generator.ts'
export type { GeneratorContext, GeneratorInfo, GeneratorModule } from '../sim/generator.ts'
```

In `packages/engine/package.json`, add the export next to `./sim-worker`:

```json
    "./gen-worker": "./src/gen/runGenWorker.ts",
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npm test -w @elovox/engine` then `npm run typecheck -w @elovox/engine`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/gen packages/engine/src/protocol.ts packages/engine/package.json packages/engine/test/genHost.test.ts
git commit -m "feat(engine): generation worker host and runGenWorker"
```

### Task 16: The sim-side generation pool

**Files:**
- Create: `packages/engine/src/sim/genPool.ts`
- Test: `packages/engine/test/genPool.test.ts`

**Interfaces:**
- Consumes: `ToGen`, `FromGen` (Task 15).
- Produces:
  - `PortLike` and `GenBatch = { columns, onColumn(cx, cz, data), onDone(), onError(message) }`.
  - `class GenPool(ports)` with `.size`, `.running`, `.configure(doc, size, seed, blocks)`, `.run(batch)`, `.cancel()` and `.lose(index)`.

The pool runs one batch at a time and keeps two jobs in flight per worker. Answers from an older configuration, or that arrive after `cancel`, are ignored. A failed column fails the whole batch with `column (cx, cz): <message>`. `lose` fails the running batch with `a generation worker stopped` and stops using that port.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/genPool.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { FromGen, ToGen } from '../src/protocol.ts'
import { GenPool, type PortLike } from '../src/sim/genPool.ts'
import { TEST_BLOCKS } from './helpers.ts'

class FakePort implements PortLike {
  readonly posted: ToGen[] = []
  onmessage: ((e: MessageEvent<FromGen>) => void) | null = null
  postMessage(m: ToGen): void { this.posted.push(m) }
  jobs() { return this.posted.filter((m) => m.type === 'job') as Extract<ToGen, { type: 'job' }>[] }
  /** Answers job `id` with a column (data = [cx, cz]) or an error. */
  answer(id: number, epoch = 1, error?: string): void {
    const job = this.jobs().find((j) => j.id === id)!
    const m: FromGen = error
      ? { type: 'error', id, epoch, message: error }
      : { type: 'column', id, epoch, cx: job.cx, cz: job.cz, data: Uint16Array.from([job.cx, job.cz]) }
    this.onmessage?.({ data: m } as MessageEvent<FromGen>)
  }
}

function batch(columns: [number, number][]) {
  const log: string[] = []
  return {
    log,
    b: {
      columns,
      onColumn: (cx: number, cz: number, d: Uint16Array) => { log.push(`col ${cx},${cz} [${d.join(',')}]`) },
      onDone: () => { log.push('done') },
      onError: (m: string) => { log.push(`error ${m}`) },
    },
  }
}
const cols = (n: number): [number, number][] => Array.from({ length: n }, (_, i) => [i, 0])

describe('GenPool', () => {
  it('broadcasts configure with a new epoch each time', () => {
    const a = new FakePort(), b = new FakePort()
    const pool = new GenPool([a, b])
    pool.configure({ x: 1 }, [64, 64, 64], 3, TEST_BLOCKS)
    pool.configure({ x: 2 }, [64, 64, 64], 3, TEST_BLOCKS)
    expect(a.posted.map((m) => m.type === 'configure' && m.epoch)).toEqual([1, 2])
    expect(b.posted).toHaveLength(2)
  })

  it('keeps at most two jobs in flight per worker and finishes once', () => {
    const a = new FakePort(), b = new FakePort()
    const pool = new GenPool([a, b])
    pool.configure(undefined, [64, 64, 64], 3, TEST_BLOCKS)
    const { b: run, log } = batch(cols(5))
    pool.run(run)
    expect([a.jobs().length, b.jobs().length]).toEqual([2, 2])
    a.answer(a.jobs()[0]!.id)
    expect(a.jobs().length).toBe(3) // refilled
    for (const p of [a, b]) for (const j of p.jobs()) if (!log.some((l) => l.startsWith(`col ${j.cx},`))) p.answer(j.id)
    expect(log.filter((l) => l.startsWith('col'))).toHaveLength(5)
    expect(log.at(-1)).toBe('done')
    expect(pool.running).toBe(false)
  })

  it('fails the batch on a worker error and ignores later answers', () => {
    const a = new FakePort()
    const pool = new GenPool([a])
    pool.configure(undefined, [64, 64, 64], 3, TEST_BLOCKS)
    const { b: run, log } = batch(cols(3))
    pool.run(run)
    a.answer(a.jobs()[0]!.id, 1, 'Error: op "m" failed')
    a.answer(a.jobs()[1]!.id)
    expect(log).toEqual(['error column (0, 0): Error: op "m" failed'])
    expect(pool.running).toBe(false)
  })

  it('ignores answers from an older configuration after cancel', () => {
    const a = new FakePort()
    const pool = new GenPool([a])
    pool.configure(undefined, [64, 64, 64], 3, TEST_BLOCKS)
    const first = batch(cols(1))
    pool.run(first.b)
    const stale = a.jobs()[0]!.id
    pool.cancel()
    pool.configure({ v: 2 }, [64, 64, 64], 3, TEST_BLOCKS)
    const second = batch(cols(1))
    pool.run(second.b)
    a.answer(stale, 1)
    expect(first.log).toEqual([])
    expect(second.log).toEqual([])
    a.answer(a.jobs()[1]!.id, 2)
    expect(second.log).toEqual(['col 0,0 [0,0]', 'done'])
  })

  it('fails the batch when a worker is lost and carries on with the others', () => {
    const a = new FakePort(), b = new FakePort()
    const pool = new GenPool([a, b])
    pool.configure(undefined, [64, 64, 64], 3, TEST_BLOCKS)
    const first = batch(cols(4))
    pool.run(first.b)
    pool.lose(1)
    expect(first.log).toEqual(['error a generation worker stopped'])
    expect(pool.size).toBe(1)
    const second = batch(cols(1))
    pool.run(second.b)
    a.answer(a.jobs().at(-1)!.id)
    expect(second.log).toEqual(['col 0,0 [0,0]', 'done'])
    pool.lose(0)
    const third = batch(cols(1))
    pool.run(third.b)
    expect(third.log).toEqual(['error no generation workers are running'])
  })

  it('refuses a second batch while one runs, and finishes an empty batch at once', () => {
    const pool = new GenPool([new FakePort()])
    const empty = batch([])
    pool.run(empty.b)
    expect(empty.log).toEqual(['done'])
    pool.run(batch(cols(1)).b)
    expect(() => pool.run(batch(cols(1)).b)).toThrow('GenPool is busy')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @elovox/engine`
Expected: FAIL — cannot resolve `../src/sim/genPool.ts`.

- [ ] **Step 3: Implement**

`packages/engine/src/sim/genPool.ts`:

```ts
import type { BlockDef } from '../blocks/registry.ts'
import type { FromGen, ToGen } from '../protocol.ts'
import type { WorldSize } from '../world/layout.ts'

/** The part of MessagePort the pool uses (tests pass fakes). */
export interface PortLike {
  postMessage(m: ToGen, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<FromGen>) => void) | null
}

export interface GenBatch {
  readonly columns: readonly (readonly [number, number])[]
  onColumn(cx: number, cz: number, data: Uint16Array): void
  onDone(): void
  onError(message: string): void
}

/** Jobs in flight per worker: one generating and one waiting, so a worker never idles between jobs. */
const IN_FLIGHT = 2

/** Sim-side view of the generation workers: one batch of columns at a time, spread over every live port. */
export class GenPool {
  private readonly ports: (PortLike | null)[]
  private readonly busy: number[]
  private readonly jobs = new Map<number, { port: number; cx: number; cz: number }>()
  private batch: GenBatch | null = null
  private next = 0
  private remaining = 0
  private nextId = 0
  private epoch = 0

  constructor(ports: readonly PortLike[]) {
    this.ports = [...ports]
    this.busy = ports.map(() => 0)
    this.ports.forEach((p, i) => { p!.onmessage = (e) => this.onMessage(i, e.data) })
  }

  /** Live workers. */
  get size(): number { return this.ports.filter((p) => p !== null).length }

  get running(): boolean { return this.batch !== null }

  /** Sends a new configuration to every worker. Columns of earlier configurations are ignored from now on. */
  configure(doc: unknown, size: WorldSize, seed: number, blocks: BlockDef[]): void {
    this.epoch++
    for (const p of this.ports) p?.postMessage({ type: 'configure', epoch: this.epoch, doc, size, seed, blocks })
  }

  run(batch: GenBatch): void {
    if (this.batch) throw new Error('GenPool is busy')
    if (this.size === 0) { batch.onError('no generation workers are running'); return }
    this.batch = batch
    this.next = 0
    this.remaining = batch.columns.length
    if (this.remaining === 0) { this.batch = null; batch.onDone(); return }
    this.pump()
  }

  /** Drops the current batch without calling it back; answers still in flight are ignored. */
  cancel(): void {
    this.batch = null
    this.jobs.clear()
    this.busy.fill(0)
  }

  /** A worker died: stop using it, and fail the current batch (its jobs may never come back). */
  lose(index: number): void {
    const p = this.ports[index]
    if (!p) return
    p.onmessage = null
    this.ports[index] = null
    const b = this.batch
    if (b) { this.cancel(); b.onError('a generation worker stopped') }
  }

  private pump(): void {
    const b = this.batch!
    for (let i = 0; i < this.ports.length; i++) {
      const p = this.ports[i]
      if (!p) continue
      while (this.busy[i]! < IN_FLIGHT && this.next < b.columns.length) {
        const [cx, cz] = b.columns[this.next++]!
        const id = ++this.nextId
        this.jobs.set(id, { port: i, cx, cz })
        this.busy[i]!++
        p.postMessage({ type: 'job', id, cx, cz })
      }
    }
  }

  private onMessage(port: number, m: FromGen): void {
    const job = this.jobs.get(m.id)
    if (!job || job.port !== port || m.epoch !== this.epoch) return // cancelled, stale or foreign
    this.jobs.delete(m.id)
    this.busy[port]!--
    const b = this.batch
    if (!b) return
    if (m.type === 'error') {
      this.cancel()
      b.onError(`column (${job.cx}, ${job.cz}): ${m.message}`)
      return
    }
    this.remaining--
    b.onColumn(m.cx, m.cz, m.data)
    if (this.batch !== b) return // the callback cancelled us
    if (this.remaining === 0) { this.batch = null; b.onDone() } else this.pump()
  }
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npm test -w @elovox/engine` then `npm run typecheck -w @elovox/engine`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sim/genPool.ts packages/engine/test/genPool.test.ts
git commit -m "feat(engine): sim-side generation pool"
```

### Task 17: Parallel initial generation

**Files:**
- Modify: `packages/engine/src/protocol.ts` (`genPorts` on init), `packages/engine/src/sim/simHost.ts`
- Create: `packages/engine/test/genHelpers.ts`
- Test: `packages/engine/test/simHostGen.test.ts`

**Interfaces:**
- Consumes: `GenPool` (Task 16), `GenHost` (Task 15), `Simulation.applyColumn`/`finishGenerate` (Task 13).
- Produces:
  - `ToSim` init gains `genPorts?: MessagePort[]`.
  - `SimHost.simulation` getter and `allColumns(layout)`.
  - Test helpers `genPorts(n, gen)`, `makeHost(gen, init?)` (a 96 × 64 × 64 world), `waitFor(out, match)` and `closePorts()`.

With ports, the sim configures the pool with the document, runs every column on it, applies columns as they arrive, and posts `ready` after `finishGenerate`. Arrival order cannot change the world: columns are pure and do not overlap. A failed column is fatal: `terrain generation failed at column (cx, cz): …`.

- [ ] **Step 1: Write the helpers and the failing test**

`packages/engine/test/genHelpers.ts`:

```ts
import { vi } from 'vitest'
import { GenHost } from '../src/gen/genHost.ts'
import type { FromSim, ToGen, ToSim } from '../src/protocol.ts'
import type { GeneratorModule } from '../src/sim/generator.ts'
import { SimHost, type Clock } from '../src/sim/simHost.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { TEST_BLOCKS } from './helpers.ts'

const open: MessagePort[] = []

/** Call from afterEach: open ports keep Node's event loop alive. */
export function closePorts(): void { for (const p of open.splice(0)) p.close() }

/** Real MessageChannels with a GenHost on the far end, as in the browser. */
export function genPorts(n: number, gen: GeneratorModule): MessagePort[] {
  return Array.from({ length: n }, () => {
    const ch = new MessageChannel()
    const host = new GenHost((m, transfer) => ch.port2.postMessage(m, transfer), gen)
    ch.port2.onmessage = (e: MessageEvent<ToGen>) => host.handle(e.data)
    open.push(ch.port1, ch.port2)
    return ch.port1
  })
}

/** A SimHost on a 96 × 64 × 64 world (3 × 2 chunk columns) with a manual clock. */
export function makeHost(gen: GeneratorModule, init: Partial<Extract<ToSim, { type: 'init' }>> = {}) {
  const out: FromSim[] = []
  const clock: Clock = { now: () => 0, setTimeout: () => 0, clearTimeout() {} }
  const host = new SimHost((m) => out.push(m), { generator: gen }, clock)
  host.handle({ type: 'init', buffers: createWorldBuffers([96, 64, 64]), blocks: TEST_BLOCKS, seed: 11, options: {}, ...init })
  return { host, out }
}

/** Resolves once a posted message matches. */
export function waitFor(out: FromSim[], match: (m: FromSim) => boolean): Promise<void> {
  return vi.waitFor(() => { if (!out.some(match)) throw new Error('waiting for the sim') }, { timeout: 5000 })
}
```

`packages/engine/test/simHostGen.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { defineGenerator } from '../src/sim/generator.ts'
import { testGenerator } from '../src/sim/testGenerator.ts'
import { closePorts, genPorts, makeHost, waitFor } from './genHelpers.ts'

afterEach(closePorts)
const settled = (out: Parameters<typeof waitFor>[0]) => waitFor(out, (m) => m.type === 'ready' || m.type === 'fatal')

describe('SimHost parallel generation', () => {
  it('builds the same world on generation workers as serially', async () => {
    const serial = makeHost(testGenerator)
    const parallel = makeHost(testGenerator, { genPorts: genPorts(3, testGenerator) })
    expect(parallel.out.some((m) => m.type === 'ready')).toBe(false) // waits for the workers
    await settled(parallel.out)
    const ready = parallel.out.find((m) => m.type === 'ready')
    expect(ready?.type === 'ready' && [ready.chunks.length, ready.columns]).toEqual([12, 6])
    expect(parallel.host.simulation!.hash()).toBe(serial.host.simulation!.hash())
  })

  it('configures the workers with the terrain document', async () => {
    const seen: unknown[] = []
    const gen = defineGenerator({ configure(doc) { seen.push(doc) }, generateColumn() {} })
    const { out } = makeHost(gen, { terrain: { v: 1 }, genPorts: genPorts(2, gen) })
    await settled(out)
    expect(seen).toEqual([{ v: 1 }, { v: 1 }, { v: 1 }]) // the sim's own copy, then each worker
  })

  it('is fatal, naming the column, when a worker fails a column', async () => {
    const gen = defineGenerator({ generateColumn(_ctx, cx, cz) { if (cx === 2 && cz === 1) throw new Error('op "spire" failed') } })
    const { out } = makeHost(gen, { genPorts: genPorts(2, gen) })
    await settled(out)
    expect(out.at(-1)).toEqual({ type: 'fatal', message: 'Error: terrain generation failed at column (2, 1): Error: op "spire" failed' })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @elovox/engine`
Expected: FAIL — `host.simulation` is undefined, and the init type does not accept `genPorts`.

- [ ] **Step 3: Add genPorts to the protocol**

In `packages/engine/src/protocol.ts`, replace the `init` member with:

```ts
  /**
   * `terrain`: the document handed to the generator's configure() before generation.
   * `genPorts`: one port per generation worker; when present, columns are generated there in parallel.
   */
  | { type: 'init'; buffers: WorldBuffers; blocks: BlockDef[]; seed: number; options: SimInitOptions; terrain?: unknown; genPorts?: MessagePort[] }
```

- [ ] **Step 4: Generate on the pool in SimHost**

In `packages/engine/src/sim/simHost.ts`:

1. Add the imports:

```ts
import type { BlockDef } from '../blocks/registry.ts'
import type { Layout } from '../world/layout.ts'
import { GenPool, type PortLike } from './genPool.ts'
```

2. Below `const MAX_CATCH_UP = 4`, add:

```ts
/** Every chunk column, row by row. */
export function allColumns(L: Layout): [number, number][] {
  const out: [number, number][] = []
  for (let cz = 0; cz < L.cz; cz++) for (let cx = 0; cx < L.cx; cx++) out.push([cx, cz])
  return out
}
```

3. Add these fields after `private rejected: Ack[] = []`:

```ts
  private pool: GenPool | null = null
  private blocks: BlockDef[] = []
  private seed = 0
  /** The generator's current document (undefined: none). */
  private terrain: unknown = undefined
```

4. Add this getter before `handle`:

```ts
  /** The simulation, for tests and tools; null before init and after a fatal error. */
  get simulation(): Simulation | null { return this.sim }
```

5. In `case 'init'`, replace the lines added in Task 13 (from `if (msg.terrain !== undefined)` to the `ready` post) with:

```ts
          this.blocks = msg.blocks
          this.seed = msg.seed
          this.terrain = msg.terrain
          if (msg.terrain !== undefined) this.sim.configure(this.modules.generator, msg.terrain)
          if (msg.genPorts && msg.genPorts.length > 0) {
            this.pool = new GenPool(msg.genPorts as PortLike[])
            this.generateInPool()
            return
          }
          const t0 = this.clock.now()
          const chunks = this.sim.generate(this.modules.generator)
          const L = this.sim.layout
          this.post({ type: 'ready', chunks, slotsUsed: this.sim.store.slotsUsed(), genMs: this.clock.now() - t0, columns: L.cx * L.cz })
```

6. Add the method before `private runTick()`:

```ts
  /** Initial generation on the generation workers; 'ready' is posted once every column is in. */
  private generateInPool(): void {
    const sim = this.sim!, pool = this.pool!, L = sim.layout
    const t0 = this.clock.now()
    pool.configure(this.terrain, L.size, this.seed, this.blocks)
    pool.run({
      columns: allColumns(L),
      onColumn: (cx, cz, data) => {
        if (this.sim !== sim) return
        try {
          sim.applyColumn(cx, cz, data)
        } catch (e) {
          pool.cancel()
          this.fail(e)
        }
      },
      onDone: () => {
        if (this.sim !== sim) return
        try {
          const chunks = sim.finishGenerate()
          this.post({ type: 'ready', chunks, slotsUsed: sim.store.slotsUsed(), genMs: this.clock.now() - t0, columns: L.cx * L.cz })
        } catch (e) {
          this.fail(e)
        }
      },
      onError: (message) => this.fail(new Error(`terrain generation failed at ${message}`)),
    })
  }
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npm test -w @elovox/engine` then `npm run typecheck -w @elovox/engine`
Expected: all pass. `simHostGen.test.ts` uses Node's real `MessageChannel`. If vitest hangs at the end, a port was left open; every test file that uses `genPorts` must call `afterEach(closePorts)`.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/protocol.ts packages/engine/src/sim/simHost.ts packages/engine/test/genHelpers.ts packages/engine/test/simHostGen.test.ts
git commit -m "feat(engine): parallel initial generation on generation workers"
```

### Task 18: Regional relight

**Files:**
- Modify: `packages/engine/src/world/chunkStore.ts` (`writableSlot`), `packages/engine/src/sim/light.ts` (`relightRegion`)
- Test: `packages/engine/test/relight.test.ts`

**Interfaces:**
- Consumes: `Simulation.generateColumnData`/`applyColumn` (Task 13).
- Produces: `ChunkStore.writableSlot(ci): number`, `RELIGHT_MARGIN = 16` and `LightEngine.relightRegion(ax0, az0, ax1, az1)`.

After columns `[ax0, ax1) × [az0, az1)` are replaced, light can change up to 15 blocks away. `relightRegion` therefore recomputes the area plus a 16-block margin; light beyond that is still right, and flows back in across the border. It runs in three passes:
1. Reset each voxel column top-down, writing slot arrays directly with lanes innermost. This is cache-friendly and opens a slot chunk only if its light changes, so only those chunks are remeshed.
2. Seed the covered open voxels from their brightest neighbour.
3. Re-seed block light from just outside the border, then propagate with the existing queues.

The test compares against a world generated from scratch.

The prototype took a 128² area from 180 ms to about 45 ms in Node. Two changes did it: direct slot access, and seeding only covered open voxels instead of rescanning every voxel.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/relight.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { defineGenerator, type GeneratorModule } from '../src/sim/generator.ts'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

const SIZE = [128, 64, 96] as const

/** Ground at y 20 with a stone roof over x 40..69 at y 30, a torch under it, and a glass pillar. */
function scene(variant: 'a' | 'b'): GeneratorModule {
  return defineGenerator({
    generateColumn(ctx, cx, cz) {
      for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
        const x = cx * 32 + lx, z = cz * 32 + lz
        const ground = variant === 'b' && x > 44 && x < 52 && z > 8 && z < 20 ? 12 : 20 // a pit in b
        for (let y = 0; y < ground; y++) ctx.set(lx, y, lz, ID.stone)
        const roof = variant === 'a' ? x >= 40 && x < 70 : x >= 34 && x < 50 && z < 40
        if (roof && z < 50) ctx.set(lx, 30, lz, ID.stone)
        if (variant === 'a' && x === 50 && z === 10) ctx.set(lx, 21, lz, ID.torch)
        if (variant === 'b' && x === 40 && z === 20) ctx.set(lx, 21, lz, ID.torch)
        if (x === 75 && z === 30) for (let y = 20; y < 40; y++) ctx.set(lx, y, lz, ID.glass)
      }
    },
  })
}

/** Column (1, 0) — x 32..63, z 0..31 — from b, everything else from a. */
const mixed = defineGenerator({
  generateColumn(ctx, cx, cz) {
    (cx === 1 && cz === 0 ? scene('b') : scene('a')).generateColumn(ctx, cx, cz)
  },
})

function world(gen: GeneratorModule): Simulation {
  const sim = new Simulation({ buffers: createWorldBuffers([...SIZE]), blocks: TEST_BLOCKS, seed: 1 })
  sim.generate(gen)
  return sim
}

function sameLight(a: Simulation, b: Simulation): number {
  let diff = 0
  for (let y = 0; y < SIZE[1]; y++) for (let z = 0; z < SIZE[2]; z++) for (let x = 0; x < SIZE[0]; x++) {
    if (a.store.getVoxel(x, y, z) !== b.store.getVoxel(x, y, z) || a.store.getLight(x, y, z) !== b.store.getLight(x, y, z)) diff++
  }
  return diff
}

describe('LightEngine.relightRegion', () => {
  it('gives the same light as generating the changed world from scratch', () => {
    const fresh = world(mixed)
    const replaced = (relight: boolean) => {
      const sim = world(scene('a'))
      const column = new Uint16Array(32 * 32 * SIZE[1])
      sim.generateColumnData(scene('b'), 1, 0, column)
      sim.applyColumn(1, 0, column)
      if (relight) sim.light.relightRegion(32, 0, 64, 32)
      sim.store.commit()
      return sim
    }
    expect(sameLight(replaced(false), fresh)).toBeGreaterThan(100) // the test is not vacuous
    expect(sameLight(replaced(true), fresh)).toBe(0)
  })

  it('is a no-op on light when nothing changed', () => {
    const sim = world(scene('a'))
    sim.light.relightRegion(32, 32, 96, 64)
    sim.store.commit()
    expect(sameLight(sim, world(scene('a')))).toBe(0)
  })

  it('handles an area on the world edge', () => {
    const sim = world(scene('a'))
    const column = new Uint16Array(32 * 32 * SIZE[1])
    sim.generateColumnData(scene('b'), 0, 0, column)
    sim.applyColumn(0, 0, column)
    sim.light.relightRegion(0, 0, 32, 32)
    sim.store.commit()
    const edge = defineGenerator({ generateColumn(ctx, cx, cz) { (cx === 0 && cz === 0 ? scene('b') : scene('a')).generateColumn(ctx, cx, cz) } })
    expect(sameLight(sim, world(edge))).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @elovox/engine`
Expected: FAIL — `sim.light.relightRegion is not a function`.

- [ ] **Step 3: Expose a writable slot on ChunkStore**

In `packages/engine/src/world/chunkStore.ts`, add before `slotOf`:

```ts
  /**
   * Opens chunk `ci` for a bulk write and returns its slot, giving a uniform chunk a slot first.
   * Callers then write the slot's voxel/light arrays directly; commit() closes the chunk.
   */
  writableSlot(ci: number): number { return this.writable(ci) }
```

- [ ] **Step 4: Implement relightRegion**

In `packages/engine/src/sim/light.ts`, change the voxel import to `import { packLight, voxelId } from '../world/voxel.ts'`, add below `const DOWN = 3`:

```ts
/** Light reaches 15 blocks from a source; a relit area extends this far past the changed columns. */
export const RELIGHT_MARGIN = 16
```

and add these methods before `private runRemoval`:

```ts
  /**
   * Recomputes light after the voxels of columns [ax0, ax1) × [az0, az1) (full height) were replaced
   * wholesale. The pass covers the area plus RELIGHT_MARGIN; light beyond that cannot have changed,
   * and it flows back in across the border. The result equals a full initialize() of the new world.
   * Works on slot arrays directly, like initialize(), and leaves the touched chunks open for commit().
   */
  relightRegion(ax0: number, az0: number, ax1: number, az1: number): void {
    const store = this.store
    const L = store.layout
    const x0 = Math.max(0, ax0 - RELIGHT_MARGIN), z0 = Math.max(0, az0 - RELIGHT_MARGIN)
    const x1 = Math.min(this.sx, ax1 + RELIGHT_MARGIN), z1 = Math.min(this.sz, az1 + RELIGHT_MARGIN)
    // 1. Reset, chunk column by chunk column, top down: sky light 15 until the first opaque voxel of
    // each voxel column, 0 below; block light cleared; emitters re-seeded. Lanes (lx, lz) run innermost
    // so slot memory is read in order.
    const covered = new Uint8Array(1024)
    const dark: number[] = [] // covered open voxels: the only ones step 2 has to light
    for (let cz = z0 >> 5; cz <= (z1 - 1) >> 5; cz++) for (let cx = x0 >> 5; cx <= (x1 - 1) >> 5; cx++) {
      const lx0 = Math.max(x0 - cx * 32, 0), lx1 = Math.min(x1 - cx * 32, 32)
      const lz0 = Math.max(z0 - cz * 32, 0), lz1 = Math.min(z1 - cz * 32, 32)
      covered.fill(0)
      for (let cy = L.cy - 1; cy >= 0; cy--) {
        const ci = L.chunkIndex(cx, cy, cz)
        const e = store.table[ci]!
        if (e < 0) {
          const id = voxelId(decodeUniform(e))
          if (this.emits[id] === 0) {
            if (this.opaque[id]) { // implied 0 is right, and everything below is covered
              for (let lz = lz0; lz < lz1; lz++) covered.fill(1, lx0 + (lz << 5), lx1 + (lz << 5))
              continue
            }
            let anyCovered = false
            for (let lz = lz0; lz < lz1 && !anyCovered; lz++) for (let lx = lx0; lx < lx1; lx++) if (covered[lx + (lz << 5)]) { anyCovered = true; break }
            if (!anyCovered) continue // open sky everywhere: implied 15 is right
          }
        }
        // A slot chunk is opened (and so remeshed) only if its light actually changes.
        let opened = e < 0
        const slot = opened ? store.writableSlot(ci) : e
        const vox = store.views.voxels(slot), lt = store.views.light(slot)
        for (let ly = 31; ly >= 0; ly--) for (let lz = lz0; lz < lz1; lz++) for (let lx = lx0; lx < lx1; lx++) {
          const lane = lx + (lz << 5), i = lane + (ly << 10)
          const id = voxelId(vox[i]!)
          if (this.opaque[id]) covered[lane] = 1
          const em = this.emits[id]!
          const l = (covered[lane] ? 0 : 15) | (em << 4)
          if (lt[i] !== l) {
            if (!opened) { store.writableSlot(ci); opened = true }
            lt[i] = l
          }
          if (em > 0) this.add[BLOCK]!.push(this.pack(cx * 32 + lx, cy * 32 + ly, cz * 32 + lz))
          else if (covered[lane] && !this.opaque[id]) dark.push(this.pack(cx * 32 + lx, cy * 32 + ly, cz * 32 + lz))
        }
      }
    }
    // 2. Dark open voxels take light from their brightest neighbour (inside or outside the area).
    for (const pos of dark) {
      this.unpack(pos)
      const x = this.ux, y = this.uy, z = this.uz
      let best = 0
      for (let d = 0; d < 6; d++) {
        const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
        if (!this.inBounds(nx, ny, nz)) continue
        const nl = store.getLight(nx, ny, nz) & 0xf
        const t = d === 2 && nl === 15 ? 15 : nl - 1
        if (t > best) best = t
      }
      if (best > (store.getLight(x, y, z) & 0xf)) {
        this.setChannel(x, y, z, SKY, best)
        this.add[SKY]!.push(pos)
      }
    }
    // 3. Block light from outside the area flows back in across its border.
    for (let y = 0; y < this.sy; y++) {
      for (let x = x0; x < x1; x++) {
        if (z0 > 0) this.seedBlockFrom(x, y, z0 - 1)
        if (z1 < this.sz) this.seedBlockFrom(x, y, z1)
      }
      for (let z = z0; z < z1; z++) {
        if (x0 > 0) this.seedBlockFrom(x0 - 1, y, z)
        if (x1 < this.sx) this.seedBlockFrom(x1, y, z)
      }
    }
    this.runAdd(SKY)
    this.runAdd(BLOCK)
  }

  private seedBlockFrom(x: number, y: number, z: number): void {
    if (channel(this.store.getLight(x, y, z), BLOCK) > 1) this.add[BLOCK]!.push(this.pack(x, y, z))
  }
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npm test -w @elovox/engine` then `npm run typecheck -w @elovox/engine`
Expected: all pass. The first relight test also checks that skipping the relight leaves more than 100 voxels wrong, so the test cannot pass vacuously.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/world/chunkStore.ts packages/engine/src/sim/light.ts packages/engine/test/relight.test.ts
git commit -m "feat(engine): regional relight after bulk column replacement"
```

### Task 19: Partial regeneration in the sim

**Files:**
- Modify: `packages/engine/src/protocol.ts`, `packages/engine/src/sim/simulation.ts` (`replaceColumns`), `packages/engine/src/sim/simHost.ts`
- Test: `packages/engine/test/regenerate.test.ts`

**Interfaces:**
- Consumes: `relightRegion` (Task 18), `GenPool` (Task 16), the helpers from Task 17.
- Produces:
  - `TerrainRect = { x0, z0, x1, z1 }` (blocks, `[x0, x1) × [z0, z1)`).
  - New `ToSim` messages: `setTerrain { id, doc }`, `regenerate { id, rect }` and `genLost { index }`.
  - New `FromSim` messages: `terrain { id, ok, message? }` and `regenerated { id, ok: true, dirtyChunks, ms, slotsUsed } | { id, ok: false, message }`.
  - `Simulation.replaceColumns(cols): number[]` and `columnsIn(rect)`.

Behaviour (Review Focus 4 and 5):
- **`setTerrain`** configures the sim's own generator first. A rejection is answered with `ok: false` and changes nothing.
- **Requests run one at a time, in order.** On the pool, columns are collected and then applied in one go between two ticks: replace, relight, commit, then `regenerated` with the chunks to remesh. Without a pool, the sim generates the columns itself.
- **A newer document during an active pool request** cancels the in-flight columns and re-runs the same request with the new document.
- **A failed column** answers `ok: false` and leaves the area untouched, because nothing is applied until every column is in.
- **`genLost`** fails an active request. Once the last worker is gone, later requests run serially in the sim.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/regenerate.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import type { FromSim } from '../src/protocol.ts'
import { defineGenerator } from '../src/sim/generator.ts'
import { columnsIn } from '../src/sim/simHost.ts'
import type { Simulation } from '../src/sim/simulation.ts'
import { AIR } from '../src/world/voxel.ts'
import { closePorts, genPorts, makeHost, waitFor } from './genHelpers.ts'
import { ID } from './helpers.ts'

afterEach(closePorts)

/** Flat stone ground `level` blocks high; a document without a numeric level is rejected. */
function levelGenerator(failColumn?: [number, number]) {
  let level = 0
  return defineGenerator({
    configure(doc) {
      const l = (doc as { level?: unknown }).level
      if (typeof l !== 'number') throw new Error('level must be a number')
      level = l
    },
    generateColumn(ctx, cx, cz) {
      if (failColumn && cx === failColumn[0] && cz === failColumn[1] && level === 50) throw new Error('cannot build 50')
      for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) for (let y = 0; y < level; y++) ctx.set(lx, y, lz, ID.stone)
    },
  })
}

const groundAt = (sim: Simulation, x: number, z: number) => {
  let y = 63
  while (y >= 0 && sim.store.getVoxel(x, y, z) === AIR) y--
  return y + 1
}
const answer = (out: FromSim[], type: 'terrain' | 'regenerated', id: number) =>
  out.find((m) => m.type === type && m.id === id) as Extract<FromSim, { type: 'terrain' | 'regenerated' }> | undefined

describe('columnsIn', () => {
  it('lists the chunk columns a block rectangle overlaps', () => {
    expect(columnsIn({ x0: 40, z0: 0, x1: 50, z1: 10 })).toEqual([[1, 0]])
    expect(columnsIn({ x0: 31, z0: 31, x1: 33, z1: 33 })).toEqual([[0, 0], [1, 0], [0, 1], [1, 1]])
  })
})

describe('SimHost regeneration (serial)', () => {
  it('regenerates only the chunk columns under the rectangle, with the new document', () => {
    const { host, out } = makeHost(levelGenerator(), { terrain: { level: 20 } })
    host.handle({ type: 'setTerrain', id: 1, doc: { level: 30 } })
    expect(answer(out, 'terrain', 1)).toEqual({ type: 'terrain', id: 1, ok: true })
    host.handle({ type: 'regenerate', id: 2, rect: { x0: 40, z0: 0, x1: 50, z1: 10 } })
    const r = answer(out, 'regenerated', 2)
    expect(r?.ok).toBe(true)
    const sim = host.simulation!
    expect(groundAt(sim, 32, 0)).toBe(30)
    expect(groundAt(sim, 63, 31)).toBe(30)
    expect(groundAt(sim, 64, 0)).toBe(20)
    expect(groundAt(sim, 40, 32)).toBe(20)
    expect(r?.type === 'regenerated' && r.ok && r.dirtyChunks.length).toBeGreaterThan(0)
  })

  it('leaves the world identical when regenerating with the same document', () => {
    const { host } = makeHost(levelGenerator(), { terrain: { level: 20 } })
    const before = host.simulation!.hash()
    host.handle({ type: 'regenerate', id: 1, rect: { x0: 0, z0: 0, x1: 96, z1: 64 } })
    expect(host.simulation!.hash()).toBe(before)
  })

  it('rejects an invalid document and keeps using the old one', () => {
    const { host, out } = makeHost(levelGenerator(), { terrain: { level: 20 } })
    host.handle({ type: 'setTerrain', id: 1, doc: { level: 'high' } })
    expect(answer(out, 'terrain', 1)).toEqual({ type: 'terrain', id: 1, ok: false, message: 'Error: level must be a number' })
    host.handle({ type: 'regenerate', id: 2, rect: { x0: 0, z0: 0, x1: 32, z1: 32 } })
    expect(groundAt(host.simulation!, 5, 5)).toBe(20)
  })

  it('reports a column that fails and leaves the area untouched', () => {
    const { host, out } = makeHost(levelGenerator([1, 0]), { terrain: { level: 20 } })
    host.handle({ type: 'setTerrain', id: 1, doc: { level: 50 } })
    host.handle({ type: 'regenerate', id: 2, rect: { x0: 0, z0: 0, x1: 64, z1: 32 } })
    expect(answer(out, 'regenerated', 2)).toEqual({ type: 'regenerated', id: 2, ok: false, message: 'Error: cannot build 50' })
    expect(groundAt(host.simulation!, 5, 5)).toBe(20)
  })

  it('rejects a rectangle outside the world', () => {
    const { host, out } = makeHost(levelGenerator(), { terrain: { level: 20 } })
    host.handle({ type: 'regenerate', id: 1, rect: { x0: 0, z0: 0, x1: 97, z1: 10 } })
    expect(answer(out, 'regenerated', 1)).toEqual({ type: 'regenerated', id: 1, ok: false, message: 'rect must be integers with 0 <= x0 < x1 <= 96 and 0 <= z0 < z1 <= 64' })
  })
})

describe('SimHost regeneration (generation workers)', () => {
  async function pooled(workers = 2) {
    const gen = levelGenerator()
    const h = makeHost(gen, { terrain: { level: 20 }, genPorts: genPorts(workers, gen) })
    await waitFor(h.out, (m) => m.type === 'ready')
    return h
  }

  it('matches serial regeneration', async () => {
    const { host, out } = await pooled()
    host.handle({ type: 'setTerrain', id: 1, doc: { level: 26 } })
    host.handle({ type: 'regenerate', id: 2, rect: { x0: 10, z0: 10, x1: 70, z1: 40 } })
    await waitFor(out, (m) => m.type === 'regenerated')
    const serial = makeHost(levelGenerator(), { terrain: { level: 20 } })
    serial.host.handle({ type: 'setTerrain', id: 1, doc: { level: 26 } })
    serial.host.handle({ type: 'regenerate', id: 2, rect: { x0: 10, z0: 10, x1: 70, z1: 40 } })
    expect(host.simulation!.hash()).toBe(serial.host.simulation!.hash())
  })

  it('runs queued requests in order', async () => {
    const { host, out } = await pooled()
    host.handle({ type: 'setTerrain', id: 1, doc: { level: 25 } })
    host.handle({ type: 'regenerate', id: 2, rect: { x0: 0, z0: 0, x1: 32, z1: 32 } })
    host.handle({ type: 'regenerate', id: 3, rect: { x0: 64, z0: 32, x1: 96, z1: 64 } })
    await waitFor(out, (m) => m.type === 'regenerated' && m.id === 3)
    expect(out.filter((m) => m.type === 'regenerated').map((m) => m.type === 'regenerated' && m.id)).toEqual([2, 3])
    expect(groundAt(host.simulation!, 70, 40)).toBe(25)
  })

  it('reruns an in-flight request with a newer document', async () => {
    const { host, out } = await pooled()
    host.handle({ type: 'setTerrain', id: 1, doc: { level: 25 } })
    host.handle({ type: 'regenerate', id: 2, rect: { x0: 0, z0: 0, x1: 96, z1: 64 } })
    host.handle({ type: 'setTerrain', id: 3, doc: { level: 33 } })
    await waitFor(out, (m) => m.type === 'regenerated')
    expect(out.filter((m) => m.type === 'regenerated')).toHaveLength(1)
    expect(groundAt(host.simulation!, 50, 50)).toBe(33)
  })

  it('fails the active request when a worker dies, then falls back to serial generation', async () => {
    const { host, out } = await pooled(1)
    host.handle({ type: 'setTerrain', id: 1, doc: { level: 28 } })
    host.handle({ type: 'regenerate', id: 2, rect: { x0: 0, z0: 0, x1: 96, z1: 64 } })
    host.handle({ type: 'genLost', index: 0 })
    expect(answer(out, 'regenerated', 2)).toEqual({ type: 'regenerated', id: 2, ok: false, message: 'a generation worker stopped' })
    host.handle({ type: 'regenerate', id: 3, rect: { x0: 0, z0: 0, x1: 32, z1: 32 } })
    expect(answer(out, 'regenerated', 3)?.ok).toBe(true) // synchronous: no workers left
    expect(groundAt(host.simulation!, 5, 5)).toBe(28)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @elovox/engine`
Expected: FAIL — `columnsIn` is not exported.

- [ ] **Step 3: Add the protocol messages**

In `packages/engine/src/protocol.ts`, add above `export type ToSim =`:

```ts
/** World blocks [x0, x1) × [z0, z1), full height. */
export interface TerrainRect { x0: number; z0: number; x1: number; z1: number }
```

add to `ToSim` (after `{ type: 'stop' }`):

```ts
  /** Replaces the generator's document (configure) everywhere; answered by 'terrain'. */
  | { type: 'setTerrain'; id: number; doc: unknown }
  /** Regenerates the chunk columns overlapping `rect` between two ticks; answered by 'regenerated'. */
  | { type: 'regenerate'; id: number; rect: TerrainRect }
  /** Main thread: generation worker `index` died. */
  | { type: 'genLost'; index: number }
```

and add to `FromSim` (after the `log` member):

```ts
  | { type: 'terrain'; id: number; ok: true }
  | { type: 'terrain'; id: number; ok: false; message: string }
  | { type: 'regenerated'; id: number; ok: true; dirtyChunks: number[]; ms: number; slotsUsed: number }
  | { type: 'regenerated'; id: number; ok: false; message: string }
```

- [ ] **Step 4: Add Simulation.replaceColumns**

In `packages/engine/src/sim/simulation.ts`, add before `generate(gen)`:

```ts
  /**
   * Swaps in freshly generated columns between ticks, relights around them and commits.
   * Returns the chunks to remesh.
   */
  replaceColumns(cols: readonly { cx: number; cz: number; data: Uint16Array }[]): number[] {
    if (cols.length === 0) return []
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
    for (const c of cols) {
      this.applyColumn(c.cx, c.cz, c.data)
      x0 = Math.min(x0, c.cx * 32); z0 = Math.min(z0, c.cz * 32)
      x1 = Math.max(x1, c.cx * 32 + 32); z1 = Math.max(z1, c.cz * 32 + 32)
    }
    this.light.relightRegion(x0, z0, x1, z1)
    return this.store.commit()
  }
```

- [ ] **Step 5: Handle the messages in SimHost**

In `packages/engine/src/sim/simHost.ts`:

1. Import `TerrainRect`: `import type { FromSim, TerrainRect, ToSim } from '../protocol.ts'`.

2. Above `allColumns`, add:

```ts
function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

/** Chunk columns overlapping a block rectangle. */
export function columnsIn(r: TerrainRect): [number, number][] {
  const out: [number, number][] = []
  for (let cz = r.z0 >> 5; cz <= (r.z1 - 1) >> 5; cz++) for (let cx = r.x0 >> 5; cx <= (r.x1 - 1) >> 5; cx++) out.push([cx, cz])
  return out
}

interface RegenRequest { id: number; rect: TerrainRect }
interface Column { cx: number; cz: number; data: Uint16Array }
```

3. Add two fields after `private terrain: unknown = undefined`:

```ts
  private readonly regenQueue: RegenRequest[] = []
  /** The regeneration running on the pool, if any. */
  private active: RegenRequest | null = null
```

4. Add these cases at the end of the `switch` in `handle` (after `case 'stop'`):

```ts
      case 'setTerrain':
        this.setTerrain(msg.id, msg.doc)
        return
      case 'regenerate': {
        if (!this.sim) return
        const [sx, , sz] = this.sim.layout.size
        const r = msg.rect
        const ok = typeof r === 'object' && r !== null && [r.x0, r.z0, r.x1, r.z1].every(Number.isInteger) &&
          r.x0 >= 0 && r.z0 >= 0 && r.x0 < r.x1 && r.z0 < r.z1 && r.x1 <= sx && r.z1 <= sz
        if (!ok) {
          this.post({ type: 'regenerated', id: msg.id, ok: false, message: `rect must be integers with 0 <= x0 < x1 <= ${sx} and 0 <= z0 < z1 <= ${sz}` })
          return
        }
        this.regenQueue.push({ id: msg.id, rect: { x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1 } })
        this.nextRegen()
        return
      }
      case 'genLost': {
        const pool = this.pool
        if (!pool) return
        pool.lose(msg.index)
        if (pool.size === 0 && this.pool === pool) this.pool = null // later work runs serially here
        return
      }
```

5. Add these methods before `generateInPool`:

```ts
  private setTerrain(id: number, doc: unknown): void {
    const sim = this.sim
    if (!sim) return
    try {
      sim.configure(this.modules.generator, doc)
    } catch (e) {
      this.post({ type: 'terrain', id, ok: false, message: errorMessage(e) })
      return
    }
    this.terrain = doc
    this.post({ type: 'terrain', id, ok: true })
    const pool = this.pool
    if (!pool) return
    pool.configure(doc, sim.layout.size, this.seed, this.blocks)
    const active = this.active
    if (active) {
      // Columns in flight were generated from the old document: drop them and run the request again.
      pool.cancel()
      this.active = null
      this.regenQueue.unshift(active)
      this.nextRegen()
    }
  }

  /** Starts the next queued regeneration unless one is running. */
  private nextRegen(): void {
    const sim = this.sim
    if (!sim || this.active || this.regenQueue.length === 0) return
    const req = this.regenQueue.shift()!
    const columns = columnsIn(req.rect)
    const t0 = this.clock.now()
    const pool = this.pool && this.pool.size > 0 ? this.pool : null
    if (!pool) {
      const H = sim.layout.size[1]
      let cols: Column[]
      try {
        cols = columns.map(([cx, cz]) => {
          const data = new Uint16Array(32 * 32 * H)
          sim.generateColumnData(this.modules.generator, cx, cz, data)
          return { cx, cz, data }
        })
      } catch (e) {
        this.post({ type: 'regenerated', id: req.id, ok: false, message: errorMessage(e) })
        this.nextRegen()
        return
      }
      this.finishRegen(req.id, t0, cols)
      this.nextRegen()
      return
    }
    const cols: Column[] = []
    this.active = req
    pool.run({
      columns,
      onColumn: (cx, cz, data) => { cols.push({ cx, cz, data }) },
      onDone: () => {
        this.active = null
        this.finishRegen(req.id, t0, cols)
        this.nextRegen()
      },
      onError: (message) => {
        this.active = null
        this.post({ type: 'regenerated', id: req.id, ok: false, message })
        this.nextRegen()
      },
    })
  }

  /** Applies a finished regeneration atomically (we are between ticks) and reports the chunks to remesh. */
  private finishRegen(id: number, t0: number, cols: Column[]): void {
    const sim = this.sim
    if (!sim) return
    try {
      const dirtyChunks = sim.replaceColumns(cols)
      this.post({ type: 'regenerated', id, ok: true, dirtyChunks, ms: this.clock.now() - t0, slotsUsed: sim.store.slotsUsed() })
    } catch (e) {
      this.fail(e)
    }
  }
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npm test -w @elovox/engine` then `npm run typecheck -w @elovox/engine`
Expected: all pass (the engine suite now has 277 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/protocol.ts packages/engine/src/sim/simulation.ts packages/engine/src/sim/simHost.ts packages/engine/test/regenerate.test.ts
git commit -m "feat(engine): partial terrain regeneration with document swaps and a queue"
```

### Task 20: `engine.terrain` on the main thread

**Files:**
- Modify: `packages/engine/src/engine.ts`, `packages/engine/src/errors.ts`, `packages/engine/src/index.ts`

**Interfaces:**
- Consumes: the protocol from Tasks 15–19 and `columnsIn` (Task 19).
- Produces:
  - `EngineOptions.genWorker?: () => Worker` and `genWorkers?: number`.
  - `EngineEvents.generated: { ms, columns }`, emitted after each successful regeneration.
  - `Engine.terrain = { initial: { ms, columns }, setDocument(doc): Promise<void>, regenerate(rect): Promise<{ ms, chunks }> }`.
  - `EngineErrorCode` gains `'terrain'`. `TerrainRect` is exported from `@elovox/engine`.

`createEngine` resolves only after the initial generation, so a `generated` listener could never see it. That is why the initial timing is a property, `engine.terrain.initial`. A generation worker that crashes before `ready` is fatal; one that crashes after it is reported to the sim as `genLost`. On fatal, every pending terrain promise is rejected.

This code is browser-only (no Node test). Task 22's e2e test covers it.

- [ ] **Step 1: Error code and export**

In `packages/engine/src/errors.ts`:

```ts
export type EngineErrorCode = 'not-isolated' | 'no-gpu' | 'fatal' | 'terrain'
```

In `packages/engine/src/index.ts`, change the protocol export to:

```ts
export type { SimInitOptions, TerrainRect } from './protocol.ts'
```

- [ ] **Step 2: Options, events and the Engine interface**

In `packages/engine/src/engine.ts`:

1. Imports:

```ts
import type { FromMesh, FromSim, GenConnect, SimInitOptions, TerrainRect, ToMesh, ToSim } from './protocol.ts'
import { columnsIn } from './sim/simHost.ts'
```

2. `EngineOptions`, after `terrain?: unknown`:

```ts
  /**
   * Starts a generation worker, e.g. `() => new Worker(new URL('./gen.worker.ts', import.meta.url), { type: 'module' })`
   * running `runGenWorker` with the sim's generator. With it, (re)generation runs in parallel; without it, the sim generates serially.
   */
  genWorker?: () => Worker
  /** Generation workers to start. Default: the mesh worker count. */
  genWorkers?: number
```

3. `EngineEvents`, after `fatal`:

```ts
  /** A regeneration finished: wall time from request to the new voxels being in the world, and chunk columns rebuilt. */
  generated: { ms: number; columns: number }
```

4. `Engine`, after `world`:

```ts
  readonly terrain: {
    /** The initial generation: wall time (light pass included) and chunk columns. */
    readonly initial: { ms: number; columns: number }
    /** Hands the generator a new document. Rejects with EngineError 'terrain' if it refuses it; the world changes only on regenerate(). */
    setDocument(doc: unknown): Promise<void>
    /** Regenerates the chunk columns overlapping `rect`; resolves once the new voxels and light are in the world. */
    regenerate(rect: TerrainRect): Promise<{ ms: number; chunks: number }>
  }
```

- [ ] **Step 3: Lifecycle state**

Right after `const pool: PoolSlot[] = []`, add:

```ts
  const genWorkers: Worker[] = []
```

and after `let fatal: string | null = null`:

```ts
  let generated = false
  let initialGen = { ms: 0, columns: 0 }
  let terrainSeq = 0
  const terrainWaits = new Map<number, { resolve: (v: never) => void; reject: (e: EngineError) => void; columns: number }>()
```

In `halt()`, after the mesh-pool loop, add `for (const w of genWorkers) w.terminate()`. In `fail()`, after `rejectReady(...)`, add:

```ts
    for (const w of terrainWaits.values()) w.reject(new EngineError('fatal', message))
    terrainWaits.clear()
```

- [ ] **Step 4: Start the generation workers**

Directly after `for (let i = 0; i < poolSize; i++) spawn(i, 0)`, add:

```ts
  // ---- generation workers (optional) ----
  const genPorts: MessagePort[] = []
  if (o.genWorker) {
    const n = Math.max(1, o.genWorkers ?? poolSize)
    for (let i = 0; i < n; i++) {
      const worker = o.genWorker()
      const ch = new MessageChannel()
      worker.postMessage({ type: 'connect', port: ch.port2 } satisfies GenConnect, [ch.port2])
      worker.onerror = (e) => {
        e.preventDefault()
        worker.terminate()
        const reason = e.message || 'the worker failed to load or crashed'
        if (!generated) fail(`generation worker crashed: ${reason}`)
        else if (!halted) sim.postMessage({ type: 'genLost', index: i } satisfies ToSim)
      }
      genWorkers.push(worker)
      genPorts.push(ch.port1)
    }
  }
```

and replace the init `postMessage` with:

```ts
  const init: Extract<ToSim, { type: 'init' }> = { type: 'init', buffers, blocks: o.blocks, seed: o.seed, options: o.sim ?? {}, terrain: o.terrain }
  if (genPorts.length > 0) init.genPorts = genPorts
  sim.postMessage(init, genPorts)
```

- [ ] **Step 5: Handle the sim's answers**

In `sim.onmessage`:
- In `case 'ready'`, add `generated = true` and `initialGen = { ms: m.genMs, columns: m.columns }` before `slotsUsed = m.slotsUsed`.
- Add these two cases before `case 'log'`:

```ts
      case 'terrain': {
        const w = terrainWaits.get(m.id)
        terrainWaits.delete(m.id)
        if (m.ok) w?.resolve(undefined as never)
        else w?.reject(new EngineError('terrain', m.message))
        break
      }
      case 'regenerated': {
        const w = terrainWaits.get(m.id)
        terrainWaits.delete(m.id)
        if (!m.ok) { w?.reject(new EngineError('terrain', m.message)); break }
        slotsUsed = m.slotsUsed
        for (const ci of m.dirtyChunks) markDirty(ci, PRIORITY.DIRTY)
        events.emit('generated', { ms: m.ms, columns: w?.columns ?? 0 })
        w?.resolve({ ms: m.ms, chunks: m.dirtyChunks.length } as never)
        break
      }
```

- [ ] **Step 6: The public API**

After `const ndc = new THREE.Vector2()`, add:

```ts
  /** Posts a terrain request and settles with the sim's answer. */
  const terrainRequest = <T>(msg: (id: number) => ToSim, columns = 0): Promise<T> => {
    if (halted) return Promise.reject(new EngineError('fatal', fatal ?? 'the engine is stopped'))
    const id = ++terrainSeq
    return new Promise<T>((resolve, reject) => {
      terrainWaits.set(id, { resolve: resolve as (v: never) => void, reject, columns })
      sim.postMessage(msg(id))
    })
  }
```

and in the returned object, after `world,`:

```ts
    terrain: {
      get initial() { return initialGen },
      setDocument: (doc) => terrainRequest<void>((id) => ({ type: 'setTerrain', id, doc })),
      regenerate: (rect) => terrainRequest<{ ms: number; chunks: number }>(
        (id) => ({ type: 'regenerate', id, rect }),
        Number.isInteger(rect.x0) && rect.x1 > rect.x0 && rect.z1 > rect.z0 ? columnsIn(rect).length : 0,
      ),
    },
```

- [ ] **Step 7: Typecheck and run every engine test**

Run: `npm run typecheck -w @elovox/engine` then `npm test -w @elovox/engine`
Expected: typecheck clean; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/engine/src/engine.ts packages/engine/src/errors.ts packages/engine/src/index.ts
git commit -m "feat(engine): engine.terrain (setDocument, regenerate) and generation workers"
```


---

## Part C — Sandbox: blocks, the terrain scene and the showcase

Run the sandbox unit tests with `npm test -w @elovox/sandbox`, its typecheck with `npm run typecheck -w @elovox/sandbox`, and the e2e with `E2E_PORT=5174 npm run e2e` (start `npx vite --port 5174` in `apps/sandbox` first, or let Playwright start it).

### Task 21: Terrain blocks and placeholder tiles

**Files:**
- Modify: `apps/sandbox/src/blocks.ts`, `apps/sandbox/src/paint/materials.ts`, `apps/sandbox/src/paint/index.ts`
- Test: `apps/sandbox/test/painter.test.ts`

**Interfaces:**
- Produces:
  - The blocks `snow`, `gravel`, `sandstone`, `sandstone_red` and `pine_leaves` (cutout).
  - The tiles of the same names, made by the procedural painter (the functions `snow`, `gravel`, `sandstone`, `sandstoneRed` and `pineLeaves`, plus the shared `strata`).

These tiles are placeholders. At checkpoint 2 (Task 24), the user may replace any of them with a hand-painted PNG through `HAND_PAINTED` in `textures.ts`, as they did with grass and stone. `textures.ts` has uncommitted user changes, so do not touch it in this task.

- [ ] **Step 1: Update the painter test (it fails first)**

In `apps/sandbox/test/painter.test.ts`, extend `NAMES` and the opaque list:

```ts
const NAMES = ['stone', 'dirt', 'grass_top', 'grass_side', 'sand', 'log_side', 'log_top', 'planks', 'leaves', 'rock', 'glass', 'torch', 'water', 'snow', 'gravel', 'sandstone', 'sandstone_red', 'pine_leaves']
```

```ts
    for (const n of ['stone', 'dirt', 'grass_top', 'grass_side', 'sand', 'log_side', 'log_top', 'planks', 'rock', 'snow', 'gravel', 'sandstone', 'sandstone_red']) {
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @elovox/sandbox`
Expected: FAIL — `paintTiles()` keys lack `snow`, `gravel`, ….

- [ ] **Step 3: Paint the tiles**

In `apps/sandbox/src/paint/materials.ts`, add above `export const TILES`:

```ts
export function snow(_r: Rand): Layer {
  const base = hex('#eef3f8')
  const l = createLayer(base, 0.5)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y), n = tileFbm(121, x, y, 4, 3), c = worley(122, x, y, 6)
    const drift = c.d < 0.4 ? (1 - c.d / 0.4) * 0.15 : 0
    paint(l, i, mixRgb(hex('#c9d6e6'), base, 0.55 + 0.45 * n), 0.4 + 0.3 * n + drift)
  }
  return l
}

export function gravel(r: Rand): Layer {
  const l = createLayer(hex('#6f6a64'), 0.3)
  const stones = ['#8c867e', '#7a746d', '#9b958c', '#66615b'].map(hex)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y), c = worley(131, x, y, 10)
    if (c.d < 0.38) paint(l, i, vary(stones[c.id % stones.length]!, r, 0.04), 0.45 + 0.5 * (1 - c.d / 0.38))
    else paint(l, i, hex('#4f4b46'), 0.15)
  }
  return l
}

/** Horizontal strata, 8 px per band; tones cycle through `tones`. Shared by both sandstones. */
function strata(seed: number, tones: readonly string[], line: string): Layer {
  const cols = tones.map(hex)
  const l = createLayer(cols[0]!)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y), band = Math.floor(y / 8), n = tileFbm(seed, x, y, 8, 3)
    const edge = y % 8 === 0 && tileNoise(seed + 1, x, band, 8, 8) < 0.7
    if (edge) { paint(l, i, hex(line), 0.25); continue }
    paint(l, i, scaleRgb(cols[band % cols.length]!, 0.9 + 0.2 * n), 0.45 + 0.25 * n)
  }
  return l
}

export function sandstone(_r: Rand): Layer {
  return strata(141, ['#d9b98a', '#cfa977', '#e2c597', '#c9a06c'], '#a8835a')
}

export function sandstoneRed(_r: Rand): Layer {
  return strata(151, ['#b8603f', '#a85536', '#c47050', '#9c4b2f'], '#7a3a24')
}

export function pineLeaves(_r: Rand): Layer {
  const l = createLayer(hex('#2f5e3a'), 0.3)
  const greens = ['#356b41', '#2a5534', '#3f7a4a', '#2f5e3a'].map(hex)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y), c = worley(161, x, y, 12)
    if (c.d < 0.45) {
      const k = 1 - c.d / 0.45
      paint(l, i, scaleRgb(greens[c.id % greens.length]!, 0.85 + 0.25 * k), 0.4 + 0.5 * k, 1)
    } else if (tileNoise(162, x, y, 8) < 0.45) {
      paint(l, i, hex('#1d3a24'), 0.05, 0)
    } else {
      paint(l, i, hex('#1d3a24'), 0.15, 1)
    }
  }
  return l
}
```

and append to `TILES`:

```ts
  ['snow', snow, { highlight: 0.3 }],
  ['gravel', gravel, {}],
  ['sandstone', sandstone, {}],
  ['sandstone_red', sandstoneRed, {}],
  ['pine_leaves', pineLeaves, {}],
```

In `apps/sandbox/src/paint/index.ts`, replace the two `SEAMLESS_*` lines with:

```ts
const TERRAIN_TILES = ['snow', 'gravel', 'sandstone', 'sandstone_red', 'pine_leaves']
export const SEAMLESS_X: readonly string[] = ['stone', 'dirt', 'grass_top', 'grass_side', 'sand', 'log_side', 'planks', 'leaves', 'rock', 'glass', 'water', ...TERRAIN_TILES]
export const SEAMLESS_Y: readonly string[] = ['stone', 'dirt', 'grass_top', 'sand', 'log_side', 'planks', 'leaves', 'rock', 'glass', 'water', ...TERRAIN_TILES]
```

- [ ] **Step 4: Register the blocks**

In `apps/sandbox/src/blocks.ts`, append to `BLOCKS` (after `rock`):

```ts
  // terrain toolkit (sub-project 2b)
  defineBlock({ name: 'snow', textures: 'snow' }),
  defineBlock({ name: 'gravel', textures: 'gravel' }),
  defineBlock({ name: 'sandstone', textures: 'sandstone' }),
  defineBlock({ name: 'sandstone_red', textures: 'sandstone_red' }),
  defineBlock({ name: 'pine_leaves', textures: 'pine_leaves', layer: 'cutout' }),
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npm test -w @elovox/sandbox` then `npm run typecheck -w @elovox/sandbox`
Expected: all pass, including the seam tests for the new tiles.

- [ ] **Step 6: Commit**

```bash
git add apps/sandbox/src/blocks.ts apps/sandbox/src/paint/materials.ts apps/sandbox/src/paint/index.ts apps/sandbox/test/painter.test.ts
git commit -m "feat(sandbox): snow, gravel, sandstone and pine leaves blocks with placeholder tiles"
```

### Task 22: The terrain scene

**Files:**
- Create: `apps/sandbox/src/terrain.worker.ts`, `apps/sandbox/src/gen.worker.ts`, `apps/sandbox/src/terrainPanel.ts`
- Create: `apps/sandbox/src/terrain/e2e.terrain.json`, and `apps/sandbox/src/terrain/showcase.terrain.json` as a stub (Task 23 writes the real map)
- Modify: `apps/sandbox/src/main.ts`, `apps/sandbox/tsconfig.json` (`resolveJsonModule`), `apps/sandbox/package.json` (dependency), `apps/sandbox/e2e/smoke.spec.ts`
- Test: `apps/sandbox/test/terrainDocs.test.ts`

**Interfaces:**
- Consumes: `terrainGenerator`, `validateTerrainDoc`, `compileTerrain`, `generateRegion`, `BUILTIN_OPS` (`@elovox/terrain`); `runGenWorker` (`@elovox/engine/gen-worker`); `engine.terrain` (Task 20).
- Produces:
  - The scene URLs `?scene=terrain` (showcase, 1024²) and `?scene=terrain&size=256` (e2e document).
  - The panel element ids `#terrain-panel`, `#terrain-info`, `#terrain-regen` and `#terrain-last`.

`main.ts` has uncommitted user edits (texture work). Apply the edits below as targeted insertions and keep everything else as it is.

- [ ] **Step 1: Wire the package**

In `apps/sandbox/package.json`, add `"@elovox/terrain": "0.1.0"` to `dependencies`, then run `npm install` at the repo root. In `apps/sandbox/tsconfig.json`, add `"resolveJsonModule": true` to `compilerOptions`.

- [ ] **Step 2: Write the e2e document and a showcase stub**

`apps/sandbox/src/terrain/e2e.terrain.json` (one op of every built-in type on 256 × 256):

```json
{
  "format": "elovox-terrain",
  "version": 1,
  "size": [256, 256],
  "seaLevel": 24,
  "base": { "height": 34, "amplitude": 10, "noise": { "scale": 90, "octaves": 4 } },
  "biomes": [
    {
      "name": "temperate",
      "surface": [
        { "block": "stone", "slope": [1.6, 99] },
        { "block": "gravel", "underwater": true, "depth": [0, 1] },
        { "block": "sand", "nearWater": 2, "depth": [0, 2] },
        { "block": "stone", "ceiling": true, "depth": [0, 40] },
        { "block": "grass" },
        { "block": "dirt", "depth": [1, 3] }
      ],
      "trees": { "density": 0.18, "kinds": ["broadleaf", "bush"] },
      "rocks": { "density": 0.04, "size": [1, 3] }
    },
    {
      "name": "alpine",
      "surface": [
        { "block": "stone", "slope": [1.6, 99] },
        { "block": "snow" },
        { "block": "stone", "depth": [1, 3] }
      ],
      "trees": { "density": 0.1, "kinds": ["pine"], "on": ["snow"] }
    },
    {
      "name": "mesa",
      "surface": [{ "bands": { "blocks": ["sandstone", "sandstone_red"], "thickness": 3 }, "depth": [0, 96] }]
    }
  ],
  "biomeRule": { "default": "temperate", "rules": [{ "biome": "alpine", "minHeight": 72 }] },
  "ops": [
    { "id": "peak", "type": "mountain", "shape": { "kind": "circle", "center": [64, 60], "radius": 60 }, "params": { "height": 48 } },
    { "id": "cave", "type": "cave", "shape": { "kind": "path", "width": 7, "points": [{ "x": 92, "z": 104, "y": 40 }, { "x": 80, "z": 80, "y": 44 }, { "x": 60, "z": 66, "y": 46 }] } },
    { "id": "mesa", "type": "plateau", "shape": { "kind": "polygon", "points": [[170, 30], [236, 40], [228, 110], [160, 96]] }, "params": { "top": 66, "base": 36, "wall": 6, "terraces": 2, "jitter": 3 } },
    { "id": "mesa-biome", "type": "biome", "shape": { "kind": "polygon", "points": [[160, 22], [244, 32], [236, 118], [150, 104]] }, "params": { "biome": "mesa" } },
    { "id": "ledge", "type": "overhang", "shape": { "kind": "path", "width": 10, "points": [{ "x": 164, "z": 99, "y": 44 }, { "x": 226, "z": 112, "y": 44 }] } },
    { "id": "arch", "type": "arch", "shape": { "kind": "path", "width": 5, "points": [{ "x": 150, "z": 150, "y": 38 }, { "x": 180, "z": 156, "y": 38 }] }, "params": { "rise": 12 } },
    { "id": "river", "type": "river", "shape": { "kind": "path", "width": 8, "points": [{ "x": 100, "z": 110 }, { "x": 110, "z": 160 }, { "x": 96, "z": 200 }] }, "params": { "start": 34, "end": 30 } },
    { "id": "lake", "type": "lake", "shape": { "kind": "circle", "center": [92, 218], "radius": 22 }, "params": { "level": 30, "depth": 5 } },
    { "id": "bumps", "type": "hills", "shape": { "kind": "circle", "center": [190, 180], "radius": 50, "falloff": 20 }, "params": { "amplitude": 8, "noise": { "scale": 24, "octaves": 3 } } },
    { "id": "gully", "type": "valley", "shape": { "kind": "path", "width": 20, "points": [{ "x": 20, "z": 150 }, { "x": 80, "z": 170 }] }, "params": { "depth": 8, "profile": "linear" } },
    { "id": "site", "type": "flatten", "shape": { "kind": "circle", "center": [200, 210], "radius": 14, "falloff": 10 }, "params": { "y": 36 } },
    { "id": "island", "type": "blob", "shape": { "kind": "circle", "center": [190, 200], "radius": 12 }, "params": { "y": 76, "height": 5 } }
  ]
}
```

`apps/sandbox/src/terrain/showcase.terrain.json` starts as a copy of the e2e document with `"size": [1024, 1024]`. Task 23 replaces it.

- [ ] **Step 3: Write the failing unit test**

`apps/sandbox/test/terrainDocs.test.ts`. Task 23 adds the showcase golden-hash test, so leave it out for now:

```ts
import { BlockRegistry } from '@elovox/engine/src/blocks/registry.ts'
import { BUILTIN_OPS, compileTerrain, generateRegion, validateTerrainDoc, type CompiledTerrain } from '@elovox/terrain'
import { describe, expect, it } from 'vitest'
import { BLOCKS } from '../src/blocks.ts'
import e2eDoc from '../src/terrain/e2e.terrain.json'
import showcaseDoc from '../src/terrain/showcase.terrain.json'

const registry = new BlockRegistry(BLOCKS)

function compile(doc: unknown): CompiledTerrain {
  const r = validateTerrainDoc(doc)
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return compileTerrain(r.doc, { seed: 1234, height: 128, id: (name) => registry.id(name) })
}

function columnHash(t: CompiledTerrain, cx: number, cz: number): number {
  const out = new Uint16Array(32 * 32 * 128)
  generateRegion(t, cx * 32, cz * 32, 32, 32, out)
  let h = 0x811c9dc5
  for (let i = 0; i < out.length; i++) h = Math.imul(h ^ out[i]!, 0x01000193)
  return h >>> 0
}

describe('sandbox terrain documents', () => {
  it.each([['e2e', e2eDoc], ['showcase', showcaseDoc]] as const)('%s validates and compiles against the sandbox blocks', (_name, doc) => {
    expect(() => compile(doc)).not.toThrow()
  })

  it('the e2e document uses every built-in op', () => {
    expect(new Set(e2eDoc.ops.map((o) => o.type))).toEqual(new Set(BUILTIN_OPS.map((o) => o.type)))
  })
})
```

- [ ] **Step 4: Run it**

Run: `npm test -w @elovox/sandbox`
Expected: PASS. This test guards the documents (they validate and compile against the sandbox blocks from Task 21), and it should pass as soon as they exist. The failing test for the scene code is the e2e test in Step 7. To check that this test is not vacuous, temporarily change a block name in `e2e.terrain.json` to `lava`: the test must fail with `the terrain document uses block "lava", which is not registered`. Then revert the change.

- [ ] **Step 5: Add the workers and the panel**

`apps/sandbox/src/terrain.worker.ts`:

```ts
import { runSimWorker } from '@elovox/engine/sim-worker'
import { terrainGenerator } from '@elovox/terrain'
import rules from './rules.ts'

runSimWorker({ rules, generator: terrainGenerator })
```

`apps/sandbox/src/gen.worker.ts`:

```ts
import { runGenWorker } from '@elovox/engine/gen-worker'
import { terrainGenerator } from '@elovox/terrain'

runGenWorker({ generator: terrainGenerator })
```

`apps/sandbox/src/terrainPanel.ts`:

```ts
import type { Engine } from '@elovox/engine'

/** Side of the square the "regenerate" button rebuilds around the orbit target (the spec's editor budget case). */
const REGEN_SIDE = 128

/** Terrain scene panel, bottom right: generation times and a regenerate-around-view button. */
export function createTerrainPanel(engine: Engine): () => void {
  const el = document.createElement('div')
  el.id = 'terrain-panel'
  Object.assign(el.style, {
    position: 'fixed', right: '12px', bottom: '12px', padding: '10px 12px', borderRadius: '8px', display: 'grid', gap: '6px',
    background: 'rgba(255, 255, 255, 0.82)', color: '#1b1f24', font: '12px/1.4 ui-monospace, Menlo, Consolas, monospace', zIndex: '5',
  })
  const info = document.createElement('div')
  info.id = 'terrain-info'
  const { ms, columns } = engine.terrain.initial
  info.textContent = `generated ${columns} columns in ${ms.toFixed(0)} ms`
  const button = document.createElement('button')
  button.id = 'terrain-regen'
  button.textContent = `regenerate ${REGEN_SIDE}² around view`
  const last = document.createElement('div')
  last.id = 'terrain-last'
  button.addEventListener('click', async () => {
    const [sx, , sz] = engine.layout.size
    const t = engine.controls.current.target
    const x0 = Math.max(0, Math.min(sx - REGEN_SIDE, Math.round(t[0] - REGEN_SIDE / 2)))
    const z0 = Math.max(0, Math.min(sz - REGEN_SIDE, Math.round(t[2] - REGEN_SIDE / 2)))
    button.disabled = true
    const start = performance.now()
    try {
      const r = await engine.terrain.regenerate({ x0, z0, x1: x0 + REGEN_SIDE, z1: z0 + REGEN_SIDE })
      // Visible = the regenerated chunks are meshed; poll the mesh queue until it drains.
      while (engine.stats().meshQueue + engine.stats().meshInFlight > 0) await new Promise((res) => requestAnimationFrame(res))
      last.textContent = `regen: ${r.ms.toFixed(0)} ms in sim, ${(performance.now() - start).toFixed(0)} ms to mesh, ${r.chunks} chunks`
    } catch (e) {
      last.textContent = `regen failed: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      button.disabled = false
    }
  })
  el.append(info, button, last)
  document.body.append(el)
  return () => el.remove()
}
```

- [ ] **Step 6: Add the scene to main.ts**

1. Imports, after `import { paintTextures } from './textures.ts'`:

```ts
import e2eDoc from './terrain/e2e.terrain.json'
import showcaseDoc from './terrain/showcase.terrain.json'
import { createTerrainPanel } from './terrainPanel.ts'
```

2. Replace the `sceneName` line with:

```ts
const sceneParam = params.get('scene')
const sceneName = sceneParam === 'diorama' || sceneParam === 'terrain' ? sceneParam : 'world'
```

3. After `const n = worldSide(params.get('size'))`:

```ts
/** The terrain scene loads the 1024² showcase, or the small e2e document when `?size=` is 256 or less. */
const terrainDoc = sceneName === 'terrain' ? (n <= 256 ? e2eDoc : showcaseDoc) : undefined
const size: [number, number, number] = sceneName === 'diorama' ? [...DIORAMA_SIZE]
  : terrainDoc ? [terrainDoc.size[0]!, 128, terrainDoc.size[1]!]
  : [n, 128, n]
```

4. In the `createEngine` options, use `size,` for `size`, and replace `simWorker` with the following (keep every other option, including any the user added):

```ts
  simWorker: sceneName === 'diorama'
    ? () => new Worker(new URL('./diorama.worker.ts', import.meta.url), { type: 'module' })
    : sceneName === 'terrain'
      ? () => new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' })
      : () => new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' }),
  terrain: terrainDoc,
  genWorker: terrainDoc ? () => new Worker(new URL('./gen.worker.ts', import.meta.url), { type: 'module' }) : undefined,
```

5. Before `createControls(engine)`:

```ts
if (sceneName === 'terrain') {
  for (const s of [engine.controls.goal, engine.controls.current]) {
    s.target[0] = size[0] / 2; s.target[1] = 50; s.target[2] = size[2] / 2
    s.distance = Math.min(400, size[0] * 0.6)
    s.pitch = 0.75
  }
  createTerrainPanel(engine)
}
```

The terrain scene uses the `open` atmosphere, which the existing `engine.atmosphere.set(...)` line already gives every non-diorama scene.

- [ ] **Step 7: Add the e2e test**

Append to `apps/sandbox/e2e/smoke.spec.ts`:

```ts
test('terrain scene generates on workers and regenerates an area', async ({ page }) => {
  const errors = watchErrors(page)
  await boot(page, '/?scene=terrain&size=256')
  const r = await page.evaluate(async () => {
    const e = (window as W).__elovox!.engine
    const initial = e.terrain.initial
    const regen = await e.terrain.regenerate({ x0: 64, z0: 64, x1: 192, z1: 192 })
    let rejected = ''
    try { await e.terrain.setDocument({ format: 'elovox-terrain' }) } catch (err) { rejected = (err as Error).message }
    let bad = ''
    try { await e.terrain.regenerate({ x0: 0, z0: 0, x1: 999, z1: 10 }) } catch (err) { bad = (err as Error).message }
    return { columns: initial.columns, ms: initial.ms, chunks: regen.chunks, rejected, bad }
  })
  expect(r.columns).toBe(64)
  expect(r.ms).toBeGreaterThan(0)
  expect(r.chunks).toBeGreaterThan(0)
  expect(r.rejected).toContain('invalid terrain document')
  expect(r.bad).toContain('rect must be integers')
  await page.locator('#terrain-regen').click()
  await expect(page.locator('#terrain-last')).toContainText('regen:', { timeout: 60_000 })
  const shot = await page.locator('canvas').screenshot()
  expect(shot.byteLength).toBeGreaterThan(10_000)
  expect(errors).toEqual([])
})
```

- [ ] **Step 8: Run unit tests, typecheck and e2e**

Run:
- `npm test -w @elovox/sandbox`
- `npm run typecheck -w @elovox/sandbox`
- `E2E_PORT=5174 npm run e2e`

Expected: all pass, and the `world` and `diorama` e2e tests are unchanged. In the prototype, the terrain e2e took about 1.5 min in headless Chromium.

- [ ] **Step 9: Commit**

```bash
git add apps/sandbox/package.json apps/sandbox/tsconfig.json apps/sandbox/src/terrain.worker.ts apps/sandbox/src/gen.worker.ts apps/sandbox/src/terrainPanel.ts apps/sandbox/src/terrain apps/sandbox/test/terrainDocs.test.ts apps/sandbox/e2e/smoke.spec.ts package-lock.json
git add -p apps/sandbox/src/main.ts   # stage only the terrain-scene hunks; leave the user's texture edits unstaged
git commit -m "feat(sandbox): terrain scene with generation workers and a regenerate panel"
```

### Task 23: Showcase map — checkpoint 1 (layout and relief)

**Files:**
- Modify: `apps/sandbox/src/terrain/showcase.terrain.json`
- Modify: `apps/sandbox/test/terrainDocs.test.ts` (golden hashes)

**Interfaces:**
- Consumes: Task 22.
- Produces: the showcase map of spec §8, and golden hashes for four of its columns.

The layout (x east, z south):

| Region | Ops |
|---|---|
| North | `north-range` (ridged mountain path), `north-peak`, `north-cliff` (plateau wall) with `cliff-overhang`, `north-cave` (entrance on the south slope) |
| East | `mesa-a`, `mesa-b`, `mesa-c` (terraced plateaus), `mesa-biome` (jittered border), `canyon` (box valley), `canyon-arch` across it, `plain-arch` on the plain |
| Centre | `centre-hills`, plus the base noise; biomes temperate and meadow (moisture), foothills and alpine (height) |
| River and lake | `river` (46 → 37) into `lake` (level 37) |
| South-west | `sea` (hills with blend `min` under `seaLevel` 30), `coast` (beach biome), `rock-1..3` (blobs) |
| Generic ops | `site` (flatten), `island` (floating blob) |

The prototype's top-down render of this document: snowy peaks along the north, the cliff band below them, the river winding south into a round lake, a sea in the south-west corner with three rocks, and the mesa desert in the east with the canyon and arch. Banks and shores fade into the ground without steps.

- [ ] **Step 1: Write the showcase document**

Replace `apps/sandbox/src/terrain/showcase.terrain.json` with:

```json
{
  "format": "elovox-terrain",
  "version": 1,
  "size": [1024, 1024],
  "seaLevel": 30,
  "base": { "height": 40, "amplitude": 12, "noise": { "scale": 160, "octaves": 5, "warp": { "scale": 300, "amount": 40 } } },
  "biomes": [
    {
      "name": "temperate",
      "surface": [
        { "block": "stone", "slope": [1.6, 99] },
        { "block": "gravel", "underwater": true, "depth": [0, 1] },
        { "block": "sand", "nearWater": 2, "depth": [0, 2] },
        { "block": "stone", "ceiling": true, "depth": [0, 40] },
        { "block": "grass" },
        { "block": "dirt", "depth": [1, 3] }
      ],
      "trees": { "density": 0.12, "kinds": ["broadleaf", "broadleaf", "bush"] },
      "rocks": { "density": 0.015, "size": [1, 3] }
    },
    {
      "name": "meadow",
      "surface": [
        { "block": "stone", "slope": [1.6, 99] },
        { "block": "gravel", "underwater": true, "depth": [0, 1] },
        { "block": "sand", "nearWater": 2, "depth": [0, 2] },
        { "block": "grass" },
        { "block": "dirt", "depth": [1, 3] }
      ],
      "trees": { "density": 0.015, "kinds": ["broadleaf", "bush"] },
      "rocks": { "density": 0.01, "size": [1, 2] }
    },
    {
      "name": "foothills",
      "surface": [
        { "block": "stone", "slope": [1.4, 99] },
        { "block": "gravel", "underwater": true, "depth": [0, 1] },
        { "block": "stone", "ceiling": true, "depth": [0, 40] },
        { "block": "grass" },
        { "block": "dirt", "depth": [1, 2] }
      ],
      "trees": { "density": 0.14, "kinds": ["pine", "pine", "broadleaf"] },
      "rocks": { "density": 0.03, "size": [1, 4] }
    },
    {
      "name": "alpine",
      "surface": [
        { "block": "stone", "slope": [1.3, 99] },
        { "block": "stone", "ceiling": true, "depth": [0, 40] },
        { "block": "snow" }
      ],
      "trees": { "density": 0.04, "kinds": ["pine"], "on": ["snow"] }
    },
    {
      "name": "mesa",
      "surface": [
        { "block": "sand", "slope": [0, 0.5], "depth": [0, 1] },
        { "bands": { "blocks": ["sandstone", "sandstone_red", "sandstone", "sandstone_red", "sandstone_red"], "thickness": 3 }, "depth": [0, 96] }
      ],
      "rocks": { "density": 0.02, "size": [1, 3] }
    },
    {
      "name": "beach",
      "surface": [
        { "block": "gravel", "underwater": true, "depth": [0, 1] },
        { "block": "sand", "depth": [0, 3] }
      ],
      "rocks": { "density": 0.05, "size": [2, 5] }
    }
  ],
  "biomeRule": {
    "default": "temperate",
    "moisture": { "scale": 140, "octaves": 3 },
    "rules": [
      { "biome": "alpine", "minHeight": 90 },
      { "biome": "foothills", "minHeight": 62 },
      { "biome": "meadow", "moisture": [0, 0.42] }
    ]
  },
  "ops": [
    {
      "id": "north-range", "type": "mountain",
      "shape": { "kind": "path", "width": 300, "points": [{ "x": 60, "z": 150 }, { "x": 260, "z": 110 }, { "x": 470, "z": 140 }, { "x": 680, "z": 100 }, { "x": 900, "z": 150 }] },
      "params": { "height": 64, "roughness": 0.6, "noise": { "type": "ridged", "scale": 110, "octaves": 5 } }
    },
    {
      "id": "north-peak", "type": "mountain",
      "shape": { "kind": "circle", "center": [360, 90], "radius": 110 },
      "params": { "height": 16, "roughness": 0.4 }
    },
    {
      "id": "north-cliff", "type": "plateau",
      "shape": { "kind": "polygon", "points": [[120, 240], [330, 225], [340, 275], [110, 290]] },
      "params": { "top": 72, "base": 44, "wall": 4, "jitter": 6 }
    },
    {
      "id": "cliff-overhang", "type": "overhang",
      "shape": { "kind": "path", "width": 12, "points": [{ "x": 118, "z": 289, "y": 52 }, { "x": 338, "z": 275, "y": 52 }] },
      "params": { "height": 5 }
    },
    {
      "id": "north-cave", "type": "cave",
      "shape": { "kind": "path", "width": 8, "points": [{ "x": 520, "z": 240, "y": 56 }, { "x": 530, "z": 200, "y": 58 }, { "x": 560, "z": 165, "y": 60 }, { "x": 600, "z": 150, "y": 56 }] }
    },
    {
      "id": "mesa-a", "type": "plateau",
      "shape": { "kind": "polygon", "points": [[660, 320], [840, 300], [880, 420], [720, 460]] },
      "params": { "top": 82, "base": 44, "wall": 8, "terraces": 3, "jitter": 8 }
    },
    {
      "id": "mesa-b", "type": "plateau",
      "shape": { "kind": "circle", "center": [900, 600], "radius": 80 },
      "params": { "top": 74, "base": 44, "wall": 6, "terraces": 2, "jitter": 6 }
    },
    {
      "id": "mesa-c", "type": "plateau",
      "shape": { "kind": "polygon", "points": [[700, 560], [800, 545], [820, 680], [690, 700]] },
      "params": { "top": 70, "base": 44, "wall": 5, "terraces": 2, "jitter": 6 }
    },
    {
      "id": "mesa-biome", "type": "biome",
      "shape": { "kind": "polygon", "points": [[640, 290], [860, 270], [1024, 300], [1024, 760], [880, 790], [660, 760], [610, 560]], "falloff": 20 },
      "params": { "biome": "mesa", "jitter": 28 }
    },
    {
      "id": "canyon", "type": "valley",
      "shape": { "kind": "path", "width": 46, "points": [{ "x": 640, "z": 490 }, { "x": 780, "z": 500 }, { "x": 860, "z": 480 }, { "x": 1010, "z": 505 }] },
      "params": { "depth": 14, "profile": "box", "noiseAmount": 3 }
    },
    {
      "id": "canyon-arch", "type": "arch",
      "shape": { "kind": "path", "width": 6, "points": [{ "x": 800, "z": 466, "y": 50 }, { "x": 806, "z": 532, "y": 50 }] },
      "params": { "rise": 10 }
    },
    {
      "id": "plain-arch", "type": "arch",
      "shape": { "kind": "path", "width": 5, "points": [{ "x": 600, "z": 640, "y": 44 }, { "x": 636, "z": 650, "y": 44 }] },
      "params": { "rise": 14 }
    },
    {
      "id": "centre-hills", "type": "hills",
      "shape": { "kind": "circle", "center": [380, 520], "radius": 180, "falloff": 60 },
      "params": { "amplitude": 10, "noise": { "scale": 60, "octaves": 3 } }
    },
    {
      "id": "river", "type": "river",
      "shape": { "kind": "path", "width": 10, "points": [{ "x": 452, "z": 250 }, { "x": 470, "z": 330 }, { "x": 436, "z": 420 }, { "x": 470, "z": 520 }, { "x": 440, "z": 610 }, { "x": 432, "z": 650 }] },
      "params": { "start": 46, "end": 37, "depth": 3, "bank": 18, "bankSlope": 0.4 }
    },
    {
      "id": "lake", "type": "lake",
      "shape": { "kind": "circle", "center": [430, 700], "radius": 70 },
      "params": { "level": 37, "depth": 7, "shore": 20 }
    },
    {
      "id": "sea", "type": "hills", "blend": "min",
      "shape": { "kind": "polygon", "points": [[0, 820], [150, 790], [270, 850], [340, 960], [380, 1024], [0, 1024]], "falloff": 80 },
      "params": { "amplitude": 6, "offset": 16, "noise": { "scale": 50 } }
    },
    {
      "id": "coast", "type": "biome",
      "shape": { "kind": "polygon", "points": [[0, 820], [150, 790], [270, 850], [340, 960], [380, 1024], [0, 1024]], "falloff": 70 },
      "params": { "biome": "beach", "jitter": 12 }
    },
    { "id": "rock-1", "type": "blob", "shape": { "kind": "circle", "center": [190, 880], "radius": 9 }, "params": { "y": 26, "height": 7 } },
    { "id": "rock-2", "type": "blob", "shape": { "kind": "circle", "center": [280, 930], "radius": 7 }, "params": { "y": 24, "height": 6 } },
    { "id": "rock-3", "type": "blob", "shape": { "kind": "circle", "center": [100, 930], "radius": 11 }, "params": { "y": 22, "height": 8 } },
    {
      "id": "site", "type": "flatten",
      "shape": { "kind": "circle", "center": [600, 880], "radius": 34, "falloff": 18 },
      "params": { "y": 44 }
    },
    {
      "id": "island", "type": "blob",
      "shape": { "kind": "circle", "center": [560, 420], "radius": 22 },
      "params": { "y": 96, "height": 7, "wobble": 2.5 }
    }
  ]
}
```

- [ ] **Step 2: Add the golden-hash test**

Add to `apps/sandbox/test/terrainDocs.test.ts`, inside the `describe` (after the e2e-ops test):

```ts
  it('showcase columns match their golden hashes (cave, mesa and canyon, river and lake, coast)', () => {
    const t = compile(showcaseDoc)
    expect([[16, 7], [25, 15], [13, 21], [4, 29]].map(([cx, cz]) => columnHash(t, cx!, cz!))).toEqual(GOLDEN)
  })
```

and at the end of the file:

```ts
const GOLDEN = [3661734573, 2782277415, 447834565, 3048637645]
```

These values are what the prototype produced for this exact document with seed 1234.

- [ ] **Step 3: Run the tests**

Run: `npm test -w @elovox/sandbox`
Expected: all pass. If the golden test fails while every terrain-package test passes, the document was transcribed wrong. Diff it against the plan.

- [ ] **Step 4: Commit**

```bash
git add apps/sandbox/src/terrain/showcase.terrain.json apps/sandbox/test/terrainDocs.test.ts
git commit -m "feat(sandbox): showcase terrain map mixing every relief"
```

- [ ] **Step 5: Visual checkpoint 1 — layout and relief (with the user)**

Start `npx vite --port 5174` in `apps/sandbox` and open `http://localhost:5174/?scene=terrain`. Then:
1. Check the panel. `generated 1024 columns in … ms` should show about 6 s or less.
2. Tour the regions with the user: the mountain range and peaks, the cliff band and its overhang (look from the south, low pitch), the cave entrance, the mesas with terraces, the canyon and its arch, the plain arch, the river and lake, the coast with rocks, the flat site, and the floating island.
3. Collect the user's adjustments. They are edits to op params or shapes in `showcase.terrain.json`.
4. To try an edit live without a reload: in the devtools console, `__elovox.engine.terrain.setDocument(editedDoc)`, then press `regenerate 128² around view`. For the whole map, call `__elovox.engine.terrain.regenerate({ x0: 0, z0: 0, x1: 1024, z1: 1024 })`.
5. After the user approves, update `GOLDEN` in `terrainDocs.test.ts`: run the test, copy the received values, and check that only the regions you edited changed (each hash covers a known region). Commit `feat(sandbox): showcase tuned at checkpoint 1`.

Do not change terrain-package code at this checkpoint unless the user asks for something no op can express. In that case, stop and discuss it: it is a new op, or a new param on an existing one, with its own test.

### Task 24: Checkpoints 2 and 3 — surface, biomes and textures; trees and rocks

**Files:**
- Modify (as the user directs): `apps/sandbox/src/terrain/showcase.terrain.json` (surface rules, biome rules, tree/rock densities), `apps/sandbox/src/paint/materials.ts` (placeholder tiles), `apps/sandbox/src/textures.ts` (only to add hand-painted PNGs the user provides, keeping their uncommitted edits)
- Modify: `apps/sandbox/test/terrainDocs.test.ts` (`GOLDEN`)

**Interfaces:**
- Consumes: Task 23.
- Produces: a showcase the user approved at checkpoints 2 and 3.

- [ ] **Step 1: Visual checkpoint 2 — surface rules, biomes, textures**

With the user, at `?scene=terrain`:
- **Surface rules:**
  - stone on steep slopes;
  - sand on beaches, river banks and lake shores;
  - gravel under water;
  - snow above the alpine line (`minHeight` 90);
  - sandstone strata on mesa walls;
  - stone on cave roofs and overhang undersides.
- **Biome transitions:** meadow against temperate, foothills, alpine, the mesa border, and the coast.
- **The placeholder tiles** for snow, gravel, sandstone and sandstone_red.

The user may hand over PNGs. Put them in `apps/sandbox/public/textures/` and map them in `HAND_PAINTED`.

Apply the changes, re-run `npm test -w @elovox/sandbox`, update `GOLDEN` as in Task 23 Step 5, and commit `feat(sandbox): showcase surfaces and textures tuned at checkpoint 2`.

- [ ] **Step 2: Visual checkpoint 3 — trees and rocks**

With the user:
- tree density per biome (`trees.density`) and the mix of tree kinds;
- rock density and size (`rocks`);
- whether trees float on rocks (a known trade-off: rocks are stamped in global order and trees only fill air);
- tree shapes, which come from `packages/terrain/src/features/trees.ts`.

If the user wants different tree shapes:
- Change `trees.ts` with a test-first edit in `features.test.ts`. The reach and height limits there must keep holding (reach ≤ 5, height ≤ `MAX_TREE_HEIGHT`).
- Update the terrain package's `GOLDEN` in `features.test.ts`.
- Update the sandbox `GOLDEN` too.

Commit `feat(terrain): tree shapes tuned at checkpoint 3` and/or `feat(sandbox): showcase vegetation tuned at checkpoint 3`.

### Task 25: Performance measurement and final verification

**Files:**
- Modify: `docs/superpowers/plans/2026-10-02-terrain-toolkit.md` (this plan: record the measurements under "Results" at the end)

**Interfaces:**
- Consumes: everything.
- Produces: measured numbers against the spec's budgets.

Prototype numbers, for reference. These are not the acceptance numbers: headless Chromium renders in software, and its main thread is mostly busy rendering.

| Measure | Prototype |
|---|---|
| Column benchmark (Node) | about 6.3 ms per column, 2D-only and with volume ops |
| Full 1024² in headless Chromium (12 cores, 6 generation workers) | 6.0–10.7 s, light pass included; the SP1 light pass is the largest part |
| Regenerating 128² (16 columns) in the sim | about 50–65 ms typical, outliers up to about 450 ms; the promise resolved 450–850 ms after the request |
| Relight of 128² + margin (Node) | about 45 ms, after the optimization in Task 18 |

- [ ] **Step 1: Measure on the user's laptop (real GPU)**

With `npx vite --port 5174` running, open `?scene=terrain` in Chrome and wait for the mesh queue in the HUD to reach 0. Record:
1. `generated … ms` from the panel. Budget: **≤ 6 s**.
2. Press `regenerate 128² around view` five times, waiting for each to finish, and record the `to mesh` times. Budget: **≤ 300 ms** for the median.
3. fps at the 3/4 view (the default camera of the scene). Budget: **60 fps**. If it is draw-bound, note it against the BatchedMesh follow-up from 2a; that does not block 2b (spec §2).

- [ ] **Step 2: If a budget is missed, profile before changing anything**

Use the Chrome performance panel with the sim and generation workers selected. Known suspects, in order:
1. `LightEngine.initialize` (SP1) for the full-map time.
2. `ChunkStore.writeChunkDense`'s per-voxel light fill for regeneration (about 40 ms for 64 chunks in Node).
3. Message latency on a busy main thread.

Fix only what the profile shows, test-first, and re-measure.

- [ ] **Step 3: Run every suite**

Run:
- `npm run typecheck`
- `npm test`
- `npm run bench -w @elovox/terrain`
- `E2E_PORT=5174 npm run e2e`

Expected: everything passes, the `world` and `diorama` scenes look as before, and the console is clean on WebGPU and on WebGL2 (`?scene=terrain&webgl`).

- [ ] **Step 4: Record and commit**

Append a `## Results` section to this plan with the Step 1 numbers and the date. Then commit:

```bash
git add docs/superpowers/plans/2026-10-02-terrain-toolkit.md
git commit -m "docs(plan): terrain toolkit performance results"
```

---

## Self-review notes

- **Spec coverage:**
  - §3 package layout → Tasks 1–14.
  - §4 document, ops, extension and validation → Tasks 3, 5–9.
  - §5 pipeline and performance → Tasks 11, 12, 14 and 25.
  - §6 features → Task 12.
  - §7 API, parallel generation, regeneration and errors → Tasks 13, 15–20.
  - §8 showcase and blocks → Tasks 21–23.
  - §9 tests → each task, plus the e2e in Task 22.
  - §10 checkpoints → Tasks 23 and 24.
- **Deviations from the spec, all small:**
  - The arch, cave, overhang and blob ops live in one file, `ops/volume.ts`, instead of four files.
  - Sea water is column-local: everything below `seaLevel` is water. The spec now says this in `TerrainDoc.seaLevel`.
  - `biome` ops and `blocks` names are document fields the spec did not list.
  - The initial generation time is `engine.terrain.initial` rather than a `generated` event, because `createEngine` resolves only after generation; `generated` fires for regenerations.

## Results

Measured by the user on their laptop (real GPU), 2026-10-02, at `?scene=terrain` after the merge into feat/grass-textures (d66905e).

- Visual checkpoints 1–3 (relief; surface, biomes and textures; trees and rocks): approved as is, no showcase changes.
- Full 1024² generation: **1642 ms** (budget ≤ 6 s) — met.
- Regenerate 128² around the view: **92 ms** in the sim, **713 ms** until the mesh queue drained, **217 chunks** remeshed (budget ≤ 300 ms request → visible mesh) — **missed**. The sim side is well inside budget; the time goes to remeshing 217 chunks (the 4 × 4 regenerated columns plus the one-chunk ring and the 26-neighbour marks added by the relight fix). Next step per Task 25 step 2: profile the remesh before changing anything.
