# Elovox Voxel Core & Render Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation of the Elovox voxel engine. A 1024×128×1024 shared-memory world, edited through deterministic commands in a simulation worker, meshed by a worker pool with AO-aware greedy meshing, and rendered with three.js WebGPU at 60 fps. A sandbox app lets you add and delete blocks.

**Architecture:**
- The world lives in SharedArrayBuffers: a chunk table, per-chunk seqlock versions, and pages of 96 KB chunk slots.
- A sim worker is the only writer. It runs a fixed 20 Hz tick that applies commands, game rules, and light propagation, then reports dirty chunks.
- The main thread renders and handles input. It reads shared memory directly for raycasts.
- A mesh worker pool snapshots chunks under the seqlock and returns packed 8-byte vertices as transferables.

**Tech Stack:** TypeScript (≥ 5.8), three.js (`three/webgpu` + TSL, latest), Vite, Vitest, Playwright, Node 24, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-01-voxel-core-design.md`. Read it before starting any task.

## Global Constraints

- The world size is a tuple `[x, y, z]` of multiples of 32. The sandbox default is `[1024, 128, 1024]`. Tests use small worlds such as `[64, 64, 64]`.
- A voxel is a `u16`: bits 0–11 are the block id (0 = air) and bits 12–15 the state. Light is a `u8`: bits 0–3 sky, bits 4–7 block.
- Chunks are 32³. Chunk index = `cx + cz*CX + cy*CX*CZ`. Local index = `lx + lz*32 + ly*1024`.
- Each slot is 96 KB (65536 B of voxels followed by 32768 B of light). A page holds 256 slots.
- The chunk table holds `≥0` for a slot index, or `<0` for a uniform chunk where voxel = `-(e+1)`. Implied light is sky 15 / block 0 for a non-opaque voxel, else 0.
- The sim ticks at 20 Hz. It runs at most 4 catch-up ticks per wake-up. The work cap is a count (default 50 000), never a time.
- Deterministic code (`sim/`, `world/`, generators, rules) must never use `Math.random`, `Date`, `performance.now` (except for the tick scheduler's wall-clock pacing), `Math.sin`, `Math.cos` or `Math.exp`. It must store no floats in world state.
- All relative imports use explicit `.ts` extensions. `tsconfig` sets `allowImportingTsExtensions`, `erasableSyntaxOnly` and `verbatimModuleSyntax`, so Node 24 can run sources directly (needed for `worker_threads` tests). That means no `enum`, no `namespace`, no constructor parameter properties, and `import type` for type-only imports.
- The page must be cross-origin isolated. The sandbox's Vite `server` and `preview` both send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
- Performance targets: under 3 ms to mesh a typical chunk in a worker, under 2 frames from click to pixels for local edits, and 60 fps at the 3/4 view.
- Commits: conventional messages (`feat:`, `test:`, `chore:`). **No `Co-Authored-By` trailer.** The project `.claude/settings.json` doesn't set `attribution.commit`, and the user's global rules forbid the trailer in that case.

## Deviations from the spec (decided while planning)

These are deliberate. Each one fixes something that would not work as the spec wrote it.

1. **Game sim modules are bundled into a game-owned worker.** `createEngine({ rules: URL, generator: URL })` can't work in production: Vite copies a `new URL('./rules.ts')` asset raw, without compiling it. Instead, the game writes a 3-line `sim.worker.ts` that calls `runSimWorker({ rules, generator })` and passes `simWorker: () => new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' })`. Block definitions are still plain data passed to `createEngine`; the engine forwards them to every worker.
2. **Rule callbacks take `(ctx, x, y, z, voxel)`** instead of a `pos` object, which avoids an allocation per update. `onNeighborChanged` also fires on the changed voxel itself, so a placed water block can start itself flowing.
3. **There is one random stream per tick**, seeded by `hash32(seed, tick)` and consumed in fixed order. It is deterministic and simpler than per-chunk streams.
4. **Texture UVs** use `RepeatWrapping` on the texture array instead of `fract()`. That tiles merged quads the same way without mip seams.
5. **Liquid top heights** use 5 of the 7 reserved bits of vertex word 1 (`drop`, in sixteenths). The spec's 6-bit integer positions can't express a water level.
6. **`fillRegion` is capped at 1 048 576 voxels**, and larger fills are rejected with an ack error. This stops one command from freezing the sim.
7. **Texture sources** in the `textures` map are URL strings. Data URLs are allowed, which is how the sandbox ships procedurally painted tiles.

## Review Focus

These are failure modes the spec implies but no feature test naturally exercises. Each line names the task whose tests pin it.

1. **A page arrives after the chunk table already points into it.** Shared memory is visible immediately, but the `page` message is asynchronous. `reader.get` must return air, and `snapshot` must return `null` (retry), never throw. Pinned in Task 5.
2. **Edits and rays at the world edges.** Coordinates at `y = 127`, `x = 0` or `x = max` must be accepted; one past the edge must be rejected with an ack error, not a crash. A ray starting outside the world must enter correctly. Pinned in Tasks 8 and 15.
3. **Spam-clicking the same voxel before acks arrive.** The newest ghost must win. Resolving an older seq must not delete a newer ghost on the same voxel. Pinned in Task 16.
4. **Out-of-order mesh results.** A slow worker can return version 4 after version 6 is already shown. The stale result must be discarded. Pinned in Task 16 (`MeshQueue.accept`).
5. **A rule that throws on every tick** must not stop other blocks' updates in the same tick, and must not leave a chunk's seqlock odd. Pinned in Task 9.

---

## File Structure

```
package.json                         npm workspaces root
tsconfig.base.json                   shared compiler options
.gitignore
packages/engine/
  package.json  tsconfig.json  vitest.config.ts
  src/
    index.ts                         public exports
    version.ts                       ENGINE_VERSION (kept three-free for Node tests)
    engine.ts                        createEngine(): wires workers, renderer, input
    errors.ts                        EngineError + error screen
    world/voxel.ts                   voxel/light bit packing
    world/layout.ts                  Layout: size, chunk/local index math
    world/buffers.ts                 SharedArrayBuffer layout, pages, slot views
    world/chunkStore.ts              writer: slots, seqlock open/commit, collapse (sim only)
    world/reader.ts                  WorldReader: get, padded seqlocked snapshot (main + mesh)
    blocks/registry.ts               defineBlock, BlockRegistry, lookup tables
    sim/rng.ts                       Pcg32, hash32
    sim/scheduler.ts                 Scheduler: dedupe, FIFO, capped drain
    sim/light.ts                     LightEngine: incremental + initial flood fill
    sim/commands.ts                  Command types, validation
    sim/rules.ts                     defineRules, RuleContext types
    sim/simulation.ts                Simulation: tick loop, ctx, command log, hash
    sim/generator.ts                 defineGenerator, GeneratorContext, value noise
    sim/testGenerator.ts             layered heightmap test terrain
    sim/simHost.ts                   message handling + fixed-step pacing (pure)
    sim/runSimWorker.ts              worker shell games call
    mesh/vertexFormat.ts             8-byte vertex pack/unpack, face constants
    mesh/ao.ts                       vertex AO, diagonal flip
    mesh/quadBuilder.ts              growable vertex/index buffers
    mesh/tables.ts                   MeshTables (typed-array block lookups posted to workers)
    mesh/greedy.ts                   opaque greedy + cutout per-face
    mesh/liquid.ts                   translucent + liquid faces
    mesh/mesher.ts                   meshChunk(): all layers
    mesh/meshJob.ts                  snapshot + overrides + trivial skip (pure)
    mesh/mesh.worker.ts              worker shell
    protocol.ts                      worker message types
    interact/raycast.ts              DDA raycast
    interact/ghostEdits.ts           predicted edits overlay
    interact/orbitCamera.ts          RTS orbit camera
    render/meshQueue.ts              dirty priorities, in-flight, version accept
    render/tiles.ts                  pure tile packing (checker, row flip)
    render/textureArray.ts           image loading + DataArrayTexture
    render/materials.ts              TSL chunk materials
    render/chunkMeshes.ts            THREE meshes per chunk/layer
  test/                              *.test.ts, one per module, plus helpers.ts and fixtures/
  bench/                             mesher.bench.ts, tick.bench.ts
apps/sandbox/
  package.json  tsconfig.json  vite.config.ts  index.html  playwright.config.ts
  src/main.ts  src/blocks.ts  src/textures.ts  src/rules.ts  src/sim.worker.ts  src/hud.ts
  e2e/smoke.spec.ts
```

---

### Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`
- Create: `packages/engine/package.json`, `packages/engine/tsconfig.json`, `packages/engine/vitest.config.ts`, `packages/engine/src/index.ts`, `packages/engine/test/scaffold.test.ts`
- Create: `apps/sandbox/package.json`, `apps/sandbox/tsconfig.json`, `apps/sandbox/vite.config.ts`, `apps/sandbox/index.html`, `apps/sandbox/src/main.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: the workspace package `@elovox/engine` (entry `src/index.ts`) and the root scripts `npm test`, `npm run dev`, `npm run typecheck`.

- [ ] **Step 1: Create the root files**

`package.json`:
```json
{
  "name": "elovox",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "test": "npm run test -w @elovox/engine",
    "bench": "npm run bench -w @elovox/engine",
    "dev": "npm run dev -w @elovox/sandbox",
    "e2e": "npm run e2e -w @elovox/sandbox",
    "typecheck": "npm run typecheck --workspaces"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true
  }
}
```

Append to `.gitignore`:
```
test-results/
playwright-report/
```

- [ ] **Step 2: Create the engine package**

`packages/engine/package.json`:
```json
{
  "name": "@elovox/engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./sim-worker": "./src/sim/runSimWorker.ts",
    "./src/*": "./src/*"
  },
  "scripts": {
    "test": "vitest run",
    "bench": "vitest bench --run",
    "typecheck": "tsc --noEmit -p ."
  }
}
```

`packages/engine/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test", "bench"]
}
```

`packages/engine/vitest.config.ts`:
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

`packages/engine/src/index.ts`:
```ts
export const ENGINE_VERSION = '0.1.0'
```

`packages/engine/test/scaffold.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { ENGINE_VERSION } from '../src/index.ts'

describe('scaffold', () => {
  it('exposes a version and supports SharedArrayBuffer', () => {
    expect(ENGINE_VERSION).toBe('0.1.0')
    expect(typeof SharedArrayBuffer).toBe('function')
  })
})
```

- [ ] **Step 3: Create the sandbox package**

`apps/sandbox/package.json`:
```json
{
  "name": "@elovox/sandbox",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "e2e": "playwright test",
    "typecheck": "tsc --noEmit -p ."
  },
  "dependencies": { "@elovox/engine": "0.1.0" }
}
```

`apps/sandbox/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["vite/client"] },
  "include": ["src", "e2e", "vite.config.ts", "playwright.config.ts"]
}
```

`apps/sandbox/vite.config.ts`:
```ts
import { defineConfig } from 'vite'

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  server: { headers: isolation, port: 5173, strictPort: true },
  preview: { headers: isolation, port: 4173, strictPort: true },
  worker: { format: 'es' },
  build: { target: 'es2022' },
})
```

`apps/sandbox/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Elovox Sandbox</title>
    <style>
      html, body { margin: 0; height: 100%; overflow: hidden; background: #dfe3e6; }
      #app { position: fixed; inset: 0; }
      canvas { display: block; width: 100%; height: 100%; }
    </style>
  </head>
  <body>
    <div id="app"><canvas id="view"></canvas></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`apps/sandbox/src/main.ts` (a minimal boot check; Task 18 replaces it with the render spike, and Task 20 with the real engine boot):
```ts
document.title = `Elovox Sandbox — isolated: ${String(crossOriginIsolated)}`
```

- [ ] **Step 4: Install dependencies**

Run:
```bash
npm i -D typescript@latest vitest@latest @types/node@latest -w @elovox/engine
npm i three@latest -w @elovox/engine
npm i -D @types/three@latest -w @elovox/engine
npm i -D vite@latest @playwright/test@latest -w @elovox/sandbox
```
Then edit `packages/engine/package.json` and replace the `^x.y.z` range on `three` with the exact installed version, so the TSL APIs can't drift under us.

- [ ] **Step 5: Verify that tests run and the dev server is isolated**

Run `npm test`. Expected: 1 test passes.
Run `npm run typecheck`. Expected: no errors.
Run `npm run dev` in the background, then `curl -sI http://localhost:5173/ | grep -i cross-origin`.
Expected: both the `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` lines. Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json .gitignore packages apps
git commit -m "chore: scaffold engine and sandbox workspaces"
```

---

### Task 2: Voxel and layout encoding

**Files:**
- Create: `packages/engine/src/world/voxel.ts`, `packages/engine/src/world/layout.ts`
- Test: `packages/engine/test/voxel.test.ts`, `packages/engine/test/layout.test.ts`

**Interfaces:**
- Produces (`world/voxel.ts`): `AIR = 0`, `MAX_BLOCK_ID = 4095`, `packVoxel(id: number, state?: number): number`, `voxelId(v): number`, `voxelState(v): number`, `withState(v, s): number`, `packLight(sky: number, block: number): number`, `skyLight(l): number`, `blockLight(l): number`, `FULL_SKY = packLight(15, 0)`.
- Produces (`world/layout.ts`): `CHUNK_SIZE = 32`, `CHUNK_VOLUME = 32768`, `type WorldSize = readonly [number, number, number]`, and `class Layout` with:
  - fields `size`, `cx`, `cy`, `cz`, `chunkCount`, `voxelCount`
  - `inBounds(x, y, z): boolean`
  - `chunkIndex(cx, cy, cz): number`
  - `chunkCoords(ci): [number, number, number]`
  - `chunkOf(x, y, z): number`
  - `chunkInBounds(cx, cy, cz): boolean`
  - `voxelIndex(x, y, z): number` and `voxelCoords(i): [number, number, number]` for packed world positions
  - static `localIndex(lx, ly, lz): number`

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/voxel.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import {
  AIR, FULL_SKY, blockLight, packLight, packVoxel, skyLight, voxelId, voxelState, withState,
} from '../src/world/voxel.ts'

describe('voxel packing', () => {
  it('round-trips id and state', () => {
    for (const [id, s] of [[0, 0], [1, 0], [4095, 15], [77, 9]] as const) {
      const v = packVoxel(id, s)
      expect(voxelId(v)).toBe(id)
      expect(voxelState(v)).toBe(s)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(0xffff)
    }
  })
  it('air is zero', () => expect(AIR).toBe(0))
  it('withState replaces only state', () => {
    const v = withState(packVoxel(12, 3), 7)
    expect(voxelId(v)).toBe(12)
    expect(voxelState(v)).toBe(7)
  })
  it('rejects out-of-range ids and states', () => {
    expect(() => packVoxel(4096)).toThrow(RangeError)
    expect(() => packVoxel(-1)).toThrow(RangeError)
    expect(() => packVoxel(1, 16)).toThrow(RangeError)
  })
  it('round-trips light', () => {
    const l = packLight(13, 6)
    expect(skyLight(l)).toBe(13)
    expect(blockLight(l)).toBe(6)
    expect(FULL_SKY).toBe(15)
  })
})
```

`packages/engine/test/layout.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { CHUNK_VOLUME, Layout } from '../src/world/layout.ts'

describe('Layout', () => {
  const L = new Layout([1024, 128, 1024])
  it('computes the chunk grid of the full world', () => {
    expect([L.cx, L.cy, L.cz]).toEqual([32, 4, 32])
    expect(L.chunkCount).toBe(4096)
    expect(L.voxelCount).toBe(1024 * 128 * 1024)
    expect(CHUNK_VOLUME).toBe(32768)
  })
  it('uses the spec chunk index formula', () => {
    expect(L.chunkIndex(0, 0, 0)).toBe(0)
    expect(L.chunkIndex(31, 0, 0)).toBe(31)
    expect(L.chunkIndex(0, 0, 1)).toBe(32)
    expect(L.chunkIndex(0, 1, 0)).toBe(1024)
    expect(L.chunkIndex(31, 3, 31)).toBe(4095)
    expect(L.chunkCoords(4095)).toEqual([31, 3, 31])
  })
  it('maps voxels to chunks and local indices', () => {
    expect(L.chunkOf(33, 0, 0)).toBe(1)
    expect(L.chunkOf(0, 127, 0)).toBe(3 * 1024)
    expect(Layout.localIndex(1, 0, 0)).toBe(1)
    expect(Layout.localIndex(0, 0, 1)).toBe(32)
    expect(Layout.localIndex(0, 1, 0)).toBe(1024)
    expect(Layout.localIndex(31, 31, 31)).toBe(32767)
  })
  it('checks bounds at every edge', () => {
    expect(L.inBounds(0, 0, 0)).toBe(true)
    expect(L.inBounds(1023, 127, 1023)).toBe(true)
    expect(L.inBounds(1024, 0, 0)).toBe(false)
    expect(L.inBounds(0, 128, 0)).toBe(false)
    expect(L.inBounds(-1, 0, 0)).toBe(false)
    expect(L.inBounds(0.5, 0, 0)).toBe(false)
  })
  it('round-trips packed voxel positions', () => {
    const i = L.voxelIndex(1023, 127, 1023)
    expect(i).toBe(L.voxelCount - 1)
    expect(L.voxelCoords(i)).toEqual([1023, 127, 1023])
    expect(L.voxelCoords(L.voxelIndex(5, 6, 7))).toEqual([5, 6, 7])
  })
  it('rejects sizes that are not positive multiples of 32', () => {
    expect(() => new Layout([100, 128, 128])).toThrow(RangeError)
    expect(() => new Layout([0, 32, 32])).toThrow(RangeError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run `npm test -- voxel layout`.
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 3: Implement**

`packages/engine/src/world/voxel.ts`:
```ts
export const AIR = 0
export const MAX_BLOCK_ID = 4095
const ID_MASK = 0x0fff

export function packVoxel(id: number, state = 0): number {
  if (!Number.isInteger(id) || id < 0 || id > MAX_BLOCK_ID) throw new RangeError(`block id out of range: ${id}`)
  if (!Number.isInteger(state) || state < 0 || state > 15) throw new RangeError(`block state out of range: ${state}`)
  return (state << 12) | id
}
export function voxelId(v: number): number { return v & ID_MASK }
export function voxelState(v: number): number { return (v >>> 12) & 0xf }
export function withState(v: number, s: number): number { return (v & ID_MASK) | ((s & 0xf) << 12) }

export function packLight(sky: number, block: number): number { return (sky & 0xf) | ((block & 0xf) << 4) }
export function skyLight(l: number): number { return l & 0xf }
export function blockLight(l: number): number { return (l >>> 4) & 0xf }
export const FULL_SKY = 15
```

`packages/engine/src/world/layout.ts`:
```ts
export const CHUNK_SIZE = 32
export const CHUNK_VOLUME = 32768
export type WorldSize = readonly [number, number, number]

export class Layout {
  readonly size: WorldSize
  readonly cx: number
  readonly cy: number
  readonly cz: number
  readonly chunkCount: number
  readonly voxelCount: number

  constructor(size: WorldSize) {
    for (const s of size) {
      if (!Number.isInteger(s) || s <= 0 || s % CHUNK_SIZE !== 0) {
        throw new RangeError(`world size must be positive multiples of 32, got [${size.join(', ')}]`)
      }
    }
    this.size = [size[0], size[1], size[2]]
    this.cx = size[0] >> 5
    this.cy = size[1] >> 5
    this.cz = size[2] >> 5
    this.chunkCount = this.cx * this.cy * this.cz
    this.voxelCount = size[0] * size[1] * size[2]
  }

  inBounds(x: number, y: number, z: number): boolean {
    return Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) &&
      x >= 0 && y >= 0 && z >= 0 && x < this.size[0] && y < this.size[1] && z < this.size[2]
  }
  chunkInBounds(cx: number, cy: number, cz: number): boolean {
    return cx >= 0 && cy >= 0 && cz >= 0 && cx < this.cx && cy < this.cy && cz < this.cz
  }
  chunkIndex(cx: number, cy: number, cz: number): number {
    return cx + cz * this.cx + cy * this.cx * this.cz
  }
  chunkCoords(ci: number): [number, number, number] {
    const layer = this.cx * this.cz
    const cy = Math.floor(ci / layer)
    const rest = ci - cy * layer
    const cz = Math.floor(rest / this.cx)
    return [rest - cz * this.cx, cy, cz]
  }
  chunkOf(x: number, y: number, z: number): number {
    return this.chunkIndex(x >> 5, y >> 5, z >> 5)
  }
  voxelIndex(x: number, y: number, z: number): number {
    return x + z * this.size[0] + y * this.size[0] * this.size[2]
  }
  voxelCoords(i: number): [number, number, number] {
    const layer = this.size[0] * this.size[2]
    const y = Math.floor(i / layer)
    const rest = i - y * layer
    const z = Math.floor(rest / this.size[0])
    return [rest - z * this.size[0], y, z]
  }
  static localIndex(lx: number, ly: number, lz: number): number {
    return lx + (lz << 5) + (ly << 10)
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run `npm test -- voxel layout`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/world packages/engine/test/voxel.test.ts packages/engine/test/layout.test.ts
git commit -m "feat(engine): voxel/light packing and world layout math"
```

---

### Task 3: Block registry

**Files:**
- Create: `packages/engine/src/blocks/registry.ts`, `packages/engine/test/helpers.ts`
- Test: `packages/engine/test/registry.test.ts`

**Interfaces:**
- Consumes: `MAX_BLOCK_ID` from `world/voxel.ts`.
- Produces:
  - `type RenderLayer = 'opaque' | 'cutout' | 'translucent'`
  - `LAYER = { NONE: 0, OPAQUE: 1, CUTOUT: 2, TRANSLUCENT: 3 } as const`
  - `FACE_COUNT = 6` (face order `+X, -X, +Y, -Y, +Z, -Z`)
  - `interface BlockDef { name; textures?: string | { top: string; side: string; bottom: string }; solid?; opaque?; layer?; emits?; liquid?; decoration? }`
  - `defineBlock(def): BlockDef`
  - `class BlockRegistry`:
    - built with `constructor(defs: readonly BlockDef[])`
    - fields `count`, `defs`, `opaque: Uint8Array`, `solid: Uint8Array`, `layer: Uint8Array`, `liquid: Uint8Array`, `emits: Uint8Array`
    - methods `id(name): number`, `name(id): string`, `textureNames(): string[]`, `faceLayers(layerOf: ReadonlyMap<string, number>): Uint16Array` (length `count*6`; a texture missing from `layerOf` maps to 0)
- Produces (`test/helpers.ts`): `TEST_BLOCKS: BlockDef[]` and `testRegistry(): BlockRegistry` with ids air=0, stone=1, dirt=2, grass=3, glass=4, water=5, torch=6, leaves=7.

- [ ] **Step 1: Write the test helpers and the failing test**

`packages/engine/test/helpers.ts`:
```ts
import { BlockRegistry, defineBlock, type BlockDef } from '../src/blocks/registry.ts'

export const TEST_BLOCKS: BlockDef[] = [
  defineBlock({ name: 'stone', textures: 'stone' }),
  defineBlock({ name: 'dirt', textures: 'dirt' }),
  defineBlock({ name: 'grass', textures: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' } }),
  defineBlock({ name: 'glass', textures: 'glass', layer: 'translucent' }),
  defineBlock({ name: 'water', textures: 'water', liquid: true, solid: false }),
  defineBlock({ name: 'torch', textures: 'torch', layer: 'cutout', emits: 14, solid: false }),
  defineBlock({ name: 'leaves', textures: 'leaves', layer: 'cutout' }),
]

export function testRegistry(): BlockRegistry {
  return new BlockRegistry(TEST_BLOCKS)
}

export const ID = { air: 0, stone: 1, dirt: 2, grass: 3, glass: 4, water: 5, torch: 6, leaves: 7 } as const
```

`packages/engine/test/registry.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { BlockRegistry, LAYER, defineBlock } from '../src/blocks/registry.ts'
import { ID, testRegistry } from './helpers.ts'

describe('BlockRegistry', () => {
  const r = testRegistry()
  it('reserves air as id 0 and assigns ids in definition order', () => {
    expect(r.id('air')).toBe(0)
    expect(r.id('stone')).toBe(ID.stone)
    expect(r.id('leaves')).toBe(ID.leaves)
    expect(r.name(ID.grass)).toBe('grass')
    expect(r.count).toBe(8)
  })
  it('derives flag tables with defaults', () => {
    expect(r.opaque[ID.air]).toBe(0)
    expect(r.opaque[ID.stone]).toBe(1)
    expect(r.opaque[ID.glass]).toBe(0)
    expect(r.opaque[ID.torch]).toBe(0)
    expect(r.solid[ID.stone]).toBe(1)
    expect(r.solid[ID.water]).toBe(0)
    expect(r.solid[ID.air]).toBe(0)
    expect(r.layer[ID.air]).toBe(LAYER.NONE)
    expect(r.layer[ID.stone]).toBe(LAYER.OPAQUE)
    expect(r.layer[ID.torch]).toBe(LAYER.CUTOUT)
    expect(r.layer[ID.water]).toBe(LAYER.TRANSLUCENT) // liquids default to translucent
    expect(r.liquid[ID.water]).toBe(1)
    expect(r.emits[ID.torch]).toBe(14)
  })
  it('lists unique texture names in first-appearance order', () => {
    // faces are visited side, side, top, bottom, side, side → grass_side comes before grass_top
    expect(r.textureNames()).toEqual(['stone', 'dirt', 'grass_side', 'grass_top', 'glass', 'water', 'torch', 'leaves'])
  })
  it('maps faces (+X,-X,+Y,-Y,+Z,-Z) to texture layers', () => {
    const layerOf = new Map(r.textureNames().map((n, i) => [n, i + 1]))
    layerOf.delete('leaves')
    const f = r.faceLayers(layerOf)
    const g = ID.grass * 6
    // grass_side = 3, grass_top = 4, dirt = 2
    expect(Array.from(f.subarray(g, g + 6))).toEqual([3, 3, 4, 2, 3, 3])
    expect(f[ID.stone * 6]).toBe(1)
    expect(f[ID.leaves * 6]).toBe(0) // missing texture → checker layer 0
  })
  it('validates definitions', () => {
    expect(() => r.id('nope')).toThrow(/unknown block/i)
    expect(() => new BlockRegistry([defineBlock({ name: 'air' })])).toThrow(/reserved/)
    expect(() => new BlockRegistry([defineBlock({ name: 'a' }), defineBlock({ name: 'a' })])).toThrow(/duplicate/)
    expect(() => new BlockRegistry([defineBlock({ name: 'a', emits: 16 })])).toThrow(/emits/)
    const many = Array.from({ length: 4096 }, (_, i) => defineBlock({ name: `b${i}` }))
    expect(() => new BlockRegistry(many)).toThrow(/too many/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run `npm test -- registry`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/engine/src/blocks/registry.ts`:
```ts
import { MAX_BLOCK_ID } from '../world/voxel.ts'

export type RenderLayer = 'opaque' | 'cutout' | 'translucent'
export const LAYER = { NONE: 0, OPAQUE: 1, CUTOUT: 2, TRANSLUCENT: 3 } as const
export const FACE_COUNT = 6 // +X, -X, +Y, -Y, +Z, -Z

export interface BlockDef {
  name: string
  textures?: string | { top: string; side: string; bottom: string }
  solid?: boolean
  opaque?: boolean
  layer?: RenderLayer
  emits?: number
  liquid?: boolean
  decoration?: string
}

export function defineBlock(def: BlockDef): BlockDef {
  return def
}

const LAYER_CODE: Record<RenderLayer, number> = { opaque: LAYER.OPAQUE, cutout: LAYER.CUTOUT, translucent: LAYER.TRANSLUCENT }

export class BlockRegistry {
  readonly count: number
  readonly defs: readonly BlockDef[]
  readonly opaque: Uint8Array
  readonly solid: Uint8Array
  readonly layer: Uint8Array
  readonly liquid: Uint8Array
  readonly emits: Uint8Array
  private readonly ids = new Map<string, number>()
  private readonly faceTex: (string | null)[] = []

  constructor(defs: readonly BlockDef[]) {
    if (defs.length + 1 > MAX_BLOCK_ID + 1) throw new RangeError(`too many blocks: ${defs.length + 1} > 4096`)
    const all: BlockDef[] = [{ name: 'air', solid: false, opaque: false }, ...defs]
    this.count = all.length
    this.defs = all
    this.opaque = new Uint8Array(this.count)
    this.solid = new Uint8Array(this.count)
    this.layer = new Uint8Array(this.count)
    this.liquid = new Uint8Array(this.count)
    this.emits = new Uint8Array(this.count)

    all.forEach((d, id) => {
      if (id > 0 && d.name === 'air') throw new Error(`block name "air" is reserved`)
      if (this.ids.has(d.name)) throw new Error(`duplicate block name "${d.name}"`)
      const emits = d.emits ?? 0
      if (!Number.isInteger(emits) || emits < 0 || emits > 15) throw new RangeError(`block "${d.name}": emits must be 0–15`)
      this.ids.set(d.name, id)
      if (id === 0) {
        for (let f = 0; f < 6; f++) this.faceTex.push(null)
        return
      }
      const liquid = d.liquid ?? false
      const layer: RenderLayer = d.layer ?? (liquid ? 'translucent' : 'opaque')
      this.layer[id] = LAYER_CODE[layer]
      this.opaque[id] = (d.opaque ?? layer === 'opaque') ? 1 : 0
      this.solid[id] = (d.solid ?? true) ? 1 : 0
      this.liquid[id] = liquid ? 1 : 0
      this.emits[id] = emits
      const t = d.textures ?? d.name
      const [top, side, bottom] = typeof t === 'string' ? [t, t, t] : [t.top, t.side, t.bottom]
      this.faceTex.push(side, side, top, bottom, side, side)
    })
  }

  id(name: string): number {
    const id = this.ids.get(name)
    if (id === undefined) throw new Error(`unknown block "${name}"`)
    return id
  }

  name(id: number): string {
    const d = this.defs[id]
    if (!d) throw new Error(`unknown block id ${id}`)
    return d.name
  }

  textureNames(): string[] {
    const seen = new Set<string>()
    for (const t of this.faceTex) if (t !== null) seen.add(t)
    return [...seen]
  }

  faceLayers(layerOf: ReadonlyMap<string, number>): Uint16Array {
    const out = new Uint16Array(this.count * 6)
    this.faceTex.forEach((t, i) => { out[i] = t === null ? 0 : (layerOf.get(t) ?? 0) })
    return out
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run `npm test -- registry`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/blocks packages/engine/test/helpers.ts packages/engine/test/registry.test.ts
git commit -m "feat(engine): block registry with flag and face-texture tables"
```

---

### Task 4: Shared buffers and ChunkStore (the writer)

**Files:**
- Create: `packages/engine/src/world/buffers.ts`, `packages/engine/src/world/chunkStore.ts`
- Test: `packages/engine/test/chunkStore.test.ts`

**Interfaces:**
- Consumes: `Layout`, `CHUNK_VOLUME`, `WorldSize` (Task 2); `AIR`, `FULL_SKY`, `voxelId` (Task 2); `BlockRegistry.opaque` (Task 3).
- Produces (`world/buffers.ts`):
  - `SLOTS_PER_PAGE = 256`, `SLOT_BYTES = 98304`, `PAGE_BYTES`
  - `interface WorldBuffers { size: WorldSize; chunkTable: SharedArrayBuffer; versions: SharedArrayBuffer }`
  - `createWorldBuffers(size): WorldBuffers` (every chunk starts as uniform air)
  - `encodeUniform(v)`, `decodeUniform(e)`, `impliedLight(voxel, opaque: Uint8Array): number`
  - `class SlotViews` with `addPage(index, page)`, `hasSlot(slot)`, `voxels(slot): Uint16Array`, `light(slot): Uint8Array`, `pageCount`, `pages: SharedArrayBuffer[]`
- Produces (`world/chunkStore.ts`):
  - `class WorldFullError extends Error`
  - `interface ChunkStoreOptions { buffers; opaque: Uint8Array; onNewPage?: (index: number, page: SharedArrayBuffer) => void; maxPages?: number }` (default `maxPages` 64)
  - `class ChunkStore` with:
    - fields `layout`, `table: Int32Array`, `versions: Uint32Array`, `views: SlotViews`
    - `getVoxel(x, y, z): number` (out of bounds → air)
    - `getLight(x, y, z): number` (out of bounds → `FULL_SKY`)
    - `setVoxel(x, y, z, v): boolean` (true if the voxel changed)
    - `setLight(x, y, z, l): void`
    - `writeChunkDense(ci, voxels: Uint16Array): void` (light filled with the implied value per voxel)
    - `slotOf(ci): number` (−1 if uniform), `slotsUsed(): number`
    - `commit(): number[]`: closes the seqlocks, collapses uniform chunks, and returns the sorted indices of written chunks plus their border neighbours

- [ ] **Step 1: Write the failing test**

`packages/engine/test/chunkStore.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ChunkStore, WorldFullError } from '../src/world/chunkStore.ts'
import { AIR, FULL_SKY } from '../src/world/voxel.ts'
import { ID, testRegistry } from './helpers.ts'

const reg = testRegistry()
function makeStore(size: [number, number, number], maxPages?: number) {
  const pages: number[] = []
  const store = new ChunkStore({
    buffers: createWorldBuffers(size), opaque: reg.opaque, maxPages,
    onNewPage: (i) => pages.push(i),
  })
  return { store, pages }
}

describe('ChunkStore', () => {
  it('starts as uniform air with full sky light', () => {
    const { store } = makeStore([64, 64, 64])
    expect(store.getVoxel(3, 4, 5)).toBe(AIR)
    expect(store.getLight(3, 4, 5)).toBe(FULL_SKY)
    expect(store.slotsUsed()).toBe(0)
    expect(store.getVoxel(-1, 0, 0)).toBe(AIR)
    expect(store.getLight(0, 999, 0)).toBe(FULL_SKY)
  })

  it('allocates a slot on the first non-uniform write and holds the seqlock odd until commit', () => {
    const { store, pages } = makeStore([64, 64, 64])
    expect(store.setVoxel(1, 1, 1, ID.stone)).toBe(true)
    expect(store.slotOf(0)).toBeGreaterThanOrEqual(0)
    expect(pages).toEqual([0])
    expect(store.versions[0]! & 1).toBe(1)
    expect(store.getVoxel(1, 1, 1)).toBe(ID.stone)
    expect(store.getVoxel(2, 1, 1)).toBe(AIR)
    expect(store.commit()).toEqual([0])
    expect(store.versions[0]).toBe(2)
  })

  it('ignores writes that change nothing and writes out of bounds', () => {
    const { store } = makeStore([64, 64, 64])
    expect(store.setVoxel(1, 1, 1, AIR)).toBe(false)
    expect(store.setVoxel(64, 0, 0, ID.stone)).toBe(false)
    store.setLight(1, 1, 1, FULL_SKY)
    expect(store.commit()).toEqual([])
    expect(store.versions[0]).toBe(0)
  })

  it('collapses a chunk back to uniform on commit and reuses the slot', () => {
    const { store } = makeStore([64, 64, 64])
    store.setVoxel(1, 1, 1, ID.stone)
    store.commit()
    store.setVoxel(1, 1, 1, AIR)
    store.commit()
    expect(store.slotOf(0)).toBe(-1)
    expect(store.slotsUsed()).toBe(0)
    store.setVoxel(40, 1, 1, ID.stone) // chunk 1 reuses the freed slot
    expect(store.slotsUsed()).toBe(1)
  })

  it('stores dense uniform chunks without a slot, with implied light', () => {
    const { store } = makeStore([64, 64, 64])
    store.writeChunkDense(0, new Uint16Array(32768).fill(ID.stone))
    expect(store.slotOf(0)).toBe(-1)
    expect(store.getVoxel(5, 5, 5)).toBe(ID.stone)
    expect(store.getLight(5, 5, 5)).toBe(0)
    expect(store.commit()).toEqual([0])
  })

  it('stores dense mixed chunks in a slot with per-voxel implied light', () => {
    const { store } = makeStore([64, 64, 64])
    const data = new Uint16Array(32768).fill(ID.stone)
    data[0] = ID.glass
    store.writeChunkDense(0, data)
    expect(store.getVoxel(0, 0, 0)).toBe(ID.glass)
    expect(store.getLight(0, 0, 0)).toBe(FULL_SKY)
    expect(store.getLight(1, 0, 0)).toBe(0)
  })

  it("a slot carved from a uniform chunk inherits that chunk's implied light", () => {
    const { store } = makeStore([64, 64, 64])
    store.writeChunkDense(0, new Uint16Array(32768).fill(ID.stone))
    store.commit()
    store.setVoxel(3, 3, 3, AIR)
    expect(store.getLight(4, 4, 4)).toBe(0)
  })

  it('collapses a chunk only when light matches the implied value too', () => {
    const { store } = makeStore([64, 64, 64])
    store.setLight(2, 2, 2, 0) // dark air: breaks uniformity through light alone
    store.commit()
    expect(store.slotOf(0)).toBeGreaterThanOrEqual(0)
    store.setLight(2, 2, 2, FULL_SKY)
    store.commit()
    expect(store.slotOf(0)).toBe(-1)
  })

  it('grows by pages of 256 slots', () => {
    const { store, pages } = makeStore([512, 64, 512]) // 16*2*16 = 512 chunks
    for (let ci = 0; ci < 300; ci++) {
      const [cx, cy, cz] = store.layout.chunkCoords(ci)
      store.setVoxel(cx * 32, cy * 32, cz * 32, ID.stone)
    }
    expect(pages).toEqual([0, 1])
    expect(store.slotsUsed()).toBe(300)
  })

  it('throws WorldFullError past maxPages', () => {
    const { store } = makeStore([512, 64, 512], 1)
    expect(() => {
      for (let ci = 0; ci < 257; ci++) {
        const [cx, cy, cz] = store.layout.chunkCoords(ci)
        store.setVoxel(cx * 32, cy * 32, cz * 32, ID.stone)
      }
    }).toThrow(WorldFullError)
  })

  it('reports border neighbours (including diagonals) as dirty', () => {
    const { store } = makeStore([64, 64, 64])
    store.setVoxel(31, 5, 5, ID.stone)
    expect(store.commit()).toEqual([0, 1])
    store.setVoxel(31, 31, 31, ID.stone)
    expect(store.commit()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run `npm test -- chunkStore`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement the buffers**

`packages/engine/src/world/buffers.ts`:
```ts
import { CHUNK_VOLUME, Layout, type WorldSize } from './layout.ts'
import { FULL_SKY, voxelId } from './voxel.ts'

export const SLOTS_PER_PAGE = 256
export const SLOT_VOXEL_BYTES = CHUNK_VOLUME * 2
export const SLOT_BYTES = SLOT_VOXEL_BYTES + CHUNK_VOLUME
export const PAGE_BYTES = SLOTS_PER_PAGE * SLOT_BYTES

export interface WorldBuffers {
  size: WorldSize
  chunkTable: SharedArrayBuffer
  versions: SharedArrayBuffer
}

export function encodeUniform(voxel: number): number { return -(voxel + 1) }
export function decodeUniform(entry: number): number { return -entry - 1 }

export function impliedLight(voxel: number, opaque: Uint8Array): number {
  return opaque[voxelId(voxel)] ? 0 : FULL_SKY
}

export function createWorldBuffers(size: WorldSize): WorldBuffers {
  const layout = new Layout(size)
  const chunkTable = new SharedArrayBuffer(layout.chunkCount * 4)
  new Int32Array(chunkTable).fill(encodeUniform(0))
  return { size: layout.size, chunkTable, versions: new SharedArrayBuffer(layout.chunkCount * 4) }
}

export class SlotViews {
  readonly pages: SharedArrayBuffer[] = []
  private readonly voxelViews: Uint16Array[] = []
  private readonly lightViews: Uint8Array[] = []

  get pageCount(): number { return this.pages.length }

  addPage(index: number, page: SharedArrayBuffer): void {
    if (this.pages[index]) return
    this.pages[index] = page
    for (let s = 0; s < SLOTS_PER_PAGE; s++) {
      const off = s * SLOT_BYTES
      this.voxelViews[index * SLOTS_PER_PAGE + s] = new Uint16Array(page, off, CHUNK_VOLUME)
      this.lightViews[index * SLOTS_PER_PAGE + s] = new Uint8Array(page, off + SLOT_VOXEL_BYTES, CHUNK_VOLUME)
    }
  }
  hasSlot(slot: number): boolean { return this.voxelViews[slot] !== undefined }
  voxels(slot: number): Uint16Array { return this.voxelViews[slot]! }
  light(slot: number): Uint8Array { return this.lightViews[slot]! }
}
```

- [ ] **Step 4: Implement ChunkStore**

`packages/engine/src/world/chunkStore.ts`:
```ts
import { PAGE_BYTES, SLOTS_PER_PAGE, SlotViews, decodeUniform, encodeUniform, impliedLight, type WorldBuffers } from './buffers.ts'
import { CHUNK_VOLUME, Layout } from './layout.ts'
import { AIR, FULL_SKY, voxelId } from './voxel.ts'

export class WorldFullError extends Error {
  constructor(message: string) { super(message); this.name = 'WorldFullError' }
}

export interface ChunkStoreOptions {
  buffers: WorldBuffers
  opaque: Uint8Array
  onNewPage?: (index: number, page: SharedArrayBuffer) => void
  maxPages?: number
}

/** The only writer of world memory. Lives in the sim worker (and in tests). */
export class ChunkStore {
  readonly layout: Layout
  readonly table: Int32Array
  readonly versions: Uint32Array
  readonly views = new SlotViews()
  private readonly opaque: Uint8Array
  private readonly onNewPage?: (index: number, page: SharedArrayBuffer) => void
  private readonly maxPages: number
  private readonly free: number[] = []
  private nextSlot = 0
  private readonly open = new Set<number>()
  private readonly dirty = new Set<number>()

  constructor(o: ChunkStoreOptions) {
    this.layout = new Layout(o.buffers.size)
    this.table = new Int32Array(o.buffers.chunkTable)
    this.versions = new Uint32Array(o.buffers.versions)
    this.opaque = o.opaque
    this.onNewPage = o.onNewPage
    this.maxPages = o.maxPages ?? 64
  }

  getVoxel(x: number, y: number, z: number): number {
    if (!this.layout.inBounds(x, y, z)) return AIR
    const e = this.table[this.layout.chunkOf(x, y, z)]!
    if (e < 0) return decodeUniform(e)
    return this.views.voxels(e)[Layout.localIndex(x & 31, y & 31, z & 31)]!
  }

  getLight(x: number, y: number, z: number): number {
    if (!this.layout.inBounds(x, y, z)) return FULL_SKY
    const e = this.table[this.layout.chunkOf(x, y, z)]!
    if (e < 0) return impliedLight(decodeUniform(e), this.opaque)
    return this.views.light(e)[Layout.localIndex(x & 31, y & 31, z & 31)]!
  }

  setVoxel(x: number, y: number, z: number, v: number): boolean {
    if (!this.layout.inBounds(x, y, z)) return false
    if (this.getVoxel(x, y, z) === v) return false
    const slot = this.writable(this.layout.chunkOf(x, y, z))
    this.views.voxels(slot)[Layout.localIndex(x & 31, y & 31, z & 31)] = v
    this.markBorder(x, y, z)
    return true
  }

  setLight(x: number, y: number, z: number, l: number): void {
    if (!this.layout.inBounds(x, y, z)) return
    if (this.getLight(x, y, z) === l) return
    const slot = this.writable(this.layout.chunkOf(x, y, z))
    this.views.light(slot)[Layout.localIndex(x & 31, y & 31, z & 31)] = l
    this.markBorder(x, y, z)
  }

  writeChunkDense(ci: number, voxels: Uint16Array): void {
    const v0 = voxels[0]!
    let uniform = true
    for (let i = 1; i < CHUNK_VOLUME; i++) if (voxels[i] !== v0) { uniform = false; break }
    if (uniform) {
      const e = this.table[ci]!
      if (e < 0 && decodeUniform(e) === v0) return
      this.openChunk(ci)
      if (e >= 0) this.free.push(e)
      Atomics.store(this.table, ci, encodeUniform(v0))
      return
    }
    const slot = this.writable(ci)
    this.views.voxels(slot).set(voxels)
    const light = this.views.light(slot)
    for (let i = 0; i < CHUNK_VOLUME; i++) light[i] = this.opaque[voxelId(voxels[i]!)] ? 0 : FULL_SKY
  }

  slotOf(ci: number): number {
    const e = this.table[ci]!
    return e >= 0 ? e : -1
  }

  slotsUsed(): number { return this.nextSlot - this.free.length }

  commit(): number[] {
    const out = new Set(this.dirty)
    for (const ci of this.open) {
      this.tryCollapse(ci)
      Atomics.add(this.versions, ci, 1) // back to even: stable
      out.add(ci)
    }
    this.open.clear()
    this.dirty.clear()
    return [...out].sort((a, b) => a - b)
  }

  private openChunk(ci: number): void {
    if (this.open.has(ci)) return
    Atomics.add(this.versions, ci, 1) // odd: write in progress
    this.open.add(ci)
  }

  private writable(ci: number): number {
    this.openChunk(ci)
    const e = this.table[ci]!
    if (e >= 0) return e
    const v = decodeUniform(e)
    const slot = this.allocSlot()
    this.views.voxels(slot).fill(v)
    this.views.light(slot).fill(impliedLight(v, this.opaque))
    Atomics.store(this.table, ci, slot)
    return slot
  }

  private allocSlot(): number {
    const reused = this.free.pop()
    if (reused !== undefined) return reused
    if (this.nextSlot >= this.views.pageCount * SLOTS_PER_PAGE) this.addPage()
    return this.nextSlot++
  }

  private addPage(): void {
    const index = this.views.pageCount
    if (index >= this.maxPages) throw new WorldFullError(`world full: ${index} pages (${index * SLOTS_PER_PAGE} slots) in use`)
    let page: SharedArrayBuffer
    try {
      page = new SharedArrayBuffer(PAGE_BYTES)
    } catch (err) {
      throw new WorldFullError(`could not allocate slot page ${index}: ${String(err)}`)
    }
    this.views.addPage(index, page)
    this.onNewPage?.(index, page)
  }

  private tryCollapse(ci: number): void {
    const e = this.table[ci]!
    if (e < 0) return
    const vox = this.views.voxels(e)
    const v0 = vox[0]!
    for (let i = 1; i < CHUNK_VOLUME; i++) if (vox[i] !== v0) return
    const l0 = impliedLight(v0, this.opaque)
    const light = this.views.light(e)
    for (let i = 0; i < CHUNK_VOLUME; i++) if (light[i] !== l0) return
    Atomics.store(this.table, ci, encodeUniform(v0))
    this.free.push(e)
  }

  /** A change on a chunk face/edge/corner affects neighbour meshes (face culling, AO, light). */
  private markBorder(x: number, y: number, z: number): void {
    const lx = x & 31, ly = y & 31, lz = z & 31
    const xs = lx === 0 ? [-1, 0] : lx === 31 ? [0, 1] : [0]
    const ys = ly === 0 ? [-1, 0] : ly === 31 ? [0, 1] : [0]
    const zs = lz === 0 ? [-1, 0] : lz === 31 ? [0, 1] : [0]
    if (xs.length + ys.length + zs.length === 3) return
    const cx = x >> 5, cy = y >> 5, cz = z >> 5
    for (const dy of ys) for (const dz of zs) for (const dx of xs) {
      if (dx === 0 && dy === 0 && dz === 0) continue
      if (this.layout.chunkInBounds(cx + dx, cy + dy, cz + dz)) this.dirty.add(this.layout.chunkIndex(cx + dx, cy + dy, cz + dz))
    }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run `npm test -- chunkStore`. Expected: PASS (11 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/world packages/engine/test/chunkStore.test.ts
git commit -m "feat(engine): shared-memory chunk store with slots, pages and seqlock"
```

---

### Task 5: WorldReader (reads plus seqlocked padded snapshots)

**Files:**
- Create: `packages/engine/src/world/reader.ts`, `packages/engine/test/fixtures/seqlockWriter.ts`
- Test: `packages/engine/test/reader.test.ts`, `packages/engine/test/seqlock.concurrency.test.ts`

**Interfaces:**
- Consumes: `WorldBuffers`, `SlotViews`, `decodeUniform`, `impliedLight` (Task 4); `Layout` (Task 2).
- Produces:
  - `PAD = 34`, `PAD_VOLUME = 39304`
  - `padIndex(px, py, pz): number` (`px + pz*34 + py*1156`, where padded coords are local + 1)
  - `interface ChunkSnapshot { voxels: Uint16Array; light: Uint8Array }`, `createSnapshot(): ChunkSnapshot`
  - `class WorldReader` with:
    - built with `constructor(buffers: WorldBuffers, opaque: Uint8Array)`
    - fields `layout`, `table`, `versions`
    - `addPage(index, page)`
    - `get(x, y, z): number` and `getLight(x, y, z): number`. Both are safe on an unknown page: they return air and `FULL_SKY`.
    - `snapshot(ci, out, retries = 8): number | null`. It returns the chunk version, or `null` on writer contention or a missing page.
    - `isTrivial(ci): boolean`

- [ ] **Step 1: Write the failing unit test**

`packages/engine/test/reader.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ChunkStore } from '../src/world/chunkStore.ts'
import { WorldReader, createSnapshot, padIndex } from '../src/world/reader.ts'
import { AIR, FULL_SKY } from '../src/world/voxel.ts'
import { ID, testRegistry } from './helpers.ts'

const reg = testRegistry()
function pair(size: [number, number, number] = [64, 64, 64], sharePages = true) {
  const buffers = createWorldBuffers(size)
  const reader = new WorldReader(buffers, reg.opaque)
  const store = new ChunkStore({
    buffers, opaque: reg.opaque,
    onNewPage: (i, p) => { if (sharePages) reader.addPage(i, p) },
  })
  return { store, reader }
}

describe('WorldReader', () => {
  it('reads what the store wrote', () => {
    const { store, reader } = pair()
    store.setVoxel(10, 20, 30, ID.stone)
    store.commit()
    expect(reader.get(10, 20, 30)).toBe(ID.stone)
    expect(reader.get(11, 20, 30)).toBe(AIR)
    expect(reader.get(-1, 0, 0)).toBe(AIR)
    expect(reader.getLight(-1, 0, 0)).toBe(FULL_SKY)
  })

  it('treats a slot on a page it has not received yet as air, and refuses to snapshot it', () => {
    const { store, reader } = pair([64, 64, 64], false)
    store.setVoxel(1, 1, 1, ID.stone)
    store.commit()
    expect(reader.get(1, 1, 1)).toBe(AIR)
    expect(reader.getLight(1, 1, 1)).toBe(FULL_SKY)
    expect(reader.snapshot(0, createSnapshot())).toBeNull()
  })

  it('copies a chunk with a 1-voxel border from face and diagonal neighbours', () => {
    const { store, reader } = pair()
    store.setVoxel(32, 0, 0, ID.stone)  // chunk 1, face neighbour of chunk 0
    store.setVoxel(32, 32, 32, ID.dirt) // diagonal neighbour of chunk 0
    store.setVoxel(5, 6, 7, ID.glass)   // inside chunk 0
    store.commit()
    const snap = createSnapshot()
    expect(reader.snapshot(0, snap)).not.toBeNull()
    expect(snap.voxels[padIndex(33, 1, 1)]).toBe(ID.stone)
    expect(snap.voxels[padIndex(33, 33, 33)]).toBe(ID.dirt)
    expect(snap.voxels[padIndex(6, 7, 8)]).toBe(ID.glass)
    expect(snap.voxels[padIndex(0, 1, 1)]).toBe(AIR)      // x = -1: outside the world
    expect(snap.light[padIndex(0, 1, 1)]).toBe(FULL_SKY)
  })

  it('copies uniform neighbours with their implied light', () => {
    const { store, reader } = pair()
    store.writeChunkDense(1, new Uint16Array(32768).fill(ID.stone))
    store.commit()
    const snap = createSnapshot()
    reader.snapshot(0, snap)
    expect(snap.voxels[padIndex(33, 5, 5)]).toBe(ID.stone)
    expect(snap.light[padIndex(33, 5, 5)]).toBe(0)
  })

  it('returns null while a writer holds the chunk, and the version once it commits', () => {
    const { store, reader } = pair()
    store.setVoxel(1, 1, 1, ID.stone)
    expect(reader.snapshot(0, createSnapshot())).toBeNull()
    store.commit()
    expect(reader.snapshot(0, createSnapshot())).toBe(2)
  })

  it('returns null when a neighbour is being written', () => {
    const { store, reader } = pair()
    store.setVoxel(40, 1, 1, ID.stone) // chunk 1 open
    expect(reader.snapshot(0, createSnapshot())).toBeNull()
  })

  it('identifies trivially empty chunks', () => {
    const { store, reader } = pair([96, 96, 96])
    expect(reader.isTrivial(0)).toBe(true) // uniform air
    const L = store.layout
    for (let ci = 0; ci < L.chunkCount; ci++) store.writeChunkDense(ci, new Uint16Array(32768).fill(ID.stone))
    store.commit()
    const centre = L.chunkIndex(1, 1, 1)
    expect(reader.isTrivial(centre)).toBe(true)  // enclosed solid
    expect(reader.isTrivial(0)).toBe(false)      // world-edge faces are visible
    store.setVoxel(64, 40, 40, ID.glass)         // chunk (2,1,1) no longer uniform opaque
    store.commit()
    expect(reader.isTrivial(centre)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run `npm test -- reader`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement WorldReader**

`packages/engine/src/world/reader.ts`:
```ts
import { SlotViews, decodeUniform, impliedLight, type WorldBuffers } from './buffers.ts'
import { Layout } from './layout.ts'
import { AIR, FULL_SKY, voxelId } from './voxel.ts'

export const PAD = 34
export const PAD_VOLUME = PAD * PAD * PAD
export function padIndex(px: number, py: number, pz: number): number { return px + pz * PAD + py * PAD * PAD }

export interface ChunkSnapshot { voxels: Uint16Array; light: Uint8Array }
export function createSnapshot(): ChunkSnapshot {
  return { voxels: new Uint16Array(PAD_VOLUME), light: new Uint8Array(PAD_VOLUME) }
}

const FACE_NEIGHBOURS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
]

/** Read-only view of world memory. Used by the main thread and mesh workers. */
export class WorldReader {
  readonly layout: Layout
  readonly table: Int32Array
  readonly versions: Uint32Array
  private readonly views = new SlotViews()
  private readonly opaque: Uint8Array

  constructor(buffers: WorldBuffers, opaque: Uint8Array) {
    this.layout = new Layout(buffers.size)
    this.table = new Int32Array(buffers.chunkTable)
    this.versions = new Uint32Array(buffers.versions)
    this.opaque = opaque
  }

  addPage(index: number, page: SharedArrayBuffer): void { this.views.addPage(index, page) }

  get(x: number, y: number, z: number): number {
    if (!this.layout.inBounds(x, y, z)) return AIR
    const e = this.table[this.layout.chunkOf(x, y, z)]!
    if (e < 0) return decodeUniform(e)
    if (!this.views.hasSlot(e)) return AIR
    return this.views.voxels(e)[Layout.localIndex(x & 31, y & 31, z & 31)]!
  }

  getLight(x: number, y: number, z: number): number {
    if (!this.layout.inBounds(x, y, z)) return FULL_SKY
    const e = this.table[this.layout.chunkOf(x, y, z)]!
    if (e < 0) return impliedLight(decodeUniform(e), this.opaque)
    if (!this.views.hasSlot(e)) return FULL_SKY
    return this.views.light(e)[Layout.localIndex(x & 31, y & 31, z & 31)]!
  }

  snapshot(ci: number, out: ChunkSnapshot, retries = 8): number | null {
    const L = this.layout
    const [cx, cy, cz] = L.chunkCoords(ci)
    const involved: number[] = []
    for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (L.chunkInBounds(cx + dx, cy + dy, cz + dz)) involved.push(L.chunkIndex(cx + dx, cy + dy, cz + dz))
    }
    const before = new Array<number>(involved.length)
    for (let attempt = 0; attempt < retries; attempt++) {
      let busy = false
      for (let i = 0; i < involved.length; i++) {
        before[i] = Atomics.load(this.versions, involved[i]!)
        if (before[i]! & 1) busy = true
      }
      if (busy) continue
      if (!this.copy(cx, cy, cz, out)) return null
      let stable = true
      for (let i = 0; i < involved.length; i++) {
        if (Atomics.load(this.versions, involved[i]!) !== before[i]) { stable = false; break }
      }
      if (stable) return Atomics.load(this.versions, ci)
    }
    return null
  }

  isTrivial(ci: number): boolean {
    const e = this.table[ci]!
    if (e >= 0) return false
    const id = voxelId(decodeUniform(e))
    if (id === 0) return true
    if (!this.opaque[id]) return false
    const [cx, cy, cz] = this.layout.chunkCoords(ci)
    for (const [dx, dy, dz] of FACE_NEIGHBOURS) {
      if (!this.layout.chunkInBounds(cx + dx, cy + dy, cz + dz)) return false
      const n = this.table[this.layout.chunkIndex(cx + dx, cy + dy, cz + dz)]!
      if (n >= 0 || !this.opaque[voxelId(decodeUniform(n))]) return false
    }
    return true
  }

  private copy(cx: number, cy: number, cz: number, out: ChunkSnapshot): boolean {
    const [SX, SY, SZ] = this.layout.size
    const bx = cx * 32, by = cy * 32, bz = cz * 32
    for (let py = 0; py < PAD; py++) {
      const y = by + py - 1
      for (let pz = 0; pz < PAD; pz++) {
        const z = bz + pz - 1
        const row = padIndex(0, py, pz)
        if (y < 0 || y >= SY || z < 0 || z >= SZ) {
          out.voxels.fill(AIR, row, row + PAD)
          out.light.fill(FULL_SKY, row, row + PAD)
          continue
        }
        if (!this.copySegment(bx - 1, 1, y, z, out, row, SX)) return false
        if (!this.copySegment(bx, 32, y, z, out, row + 1, SX)) return false
        if (!this.copySegment(bx + 32, 1, y, z, out, row + 33, SX)) return false
      }
    }
    return true
  }

  /** Copies `count` voxels starting at world x (all within one chunk) into out at `dst`. */
  private copySegment(x: number, count: number, y: number, z: number, out: ChunkSnapshot, dst: number, SX: number): boolean {
    if (x < 0 || x >= SX) {
      out.voxels.fill(AIR, dst, dst + count)
      out.light.fill(FULL_SKY, dst, dst + count)
      return true
    }
    const e = this.table[this.layout.chunkOf(x, y, z)]!
    if (e < 0) {
      const v = decodeUniform(e)
      out.voxels.fill(v, dst, dst + count)
      out.light.fill(impliedLight(v, this.opaque), dst, dst + count)
      return true
    }
    if (!this.views.hasSlot(e)) return false
    const local = Layout.localIndex(x & 31, y & 31, z & 31)
    out.voxels.set(this.views.voxels(e).subarray(local, local + count), dst)
    out.light.set(this.views.light(e).subarray(local, local + count), dst)
    return true
  }
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run `npm test -- reader`. Expected: PASS (7 tests).

- [ ] **Step 5: Write the cross-thread torn-read test**

`packages/engine/test/fixtures/seqlockWriter.ts` (Node runs it directly through type stripping):
```ts
import { parentPort, workerData } from 'node:worker_threads'
import { ChunkStore } from '../../src/world/chunkStore.ts'
import type { WorldBuffers } from '../../src/world/buffers.ts'

const { buffers, opaque, iterations } = workerData as { buffers: WorldBuffers; opaque: Uint8Array; iterations: number }
const store = new ChunkStore({ buffers, opaque, onNewPage: (index, page) => parentPort!.postMessage({ type: 'page', index, page }) })

// Voxel (0,0,0) is a fixed marker so the chunk never collapses to uniform.
store.setVoxel(0, 0, 0, 3)
store.commit()
parentPort!.once('message', () => {
  for (let k = 0; k < iterations; k++) {
    const v = 1 + (k % 2) // alternate stone/dirt across the other 32767 voxels
    for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
      if (x || y || z) store.setVoxel(x, y, z, v)
    }
    store.commit()
  }
  parentPort!.postMessage({ type: 'done' })
})
```

`packages/engine/test/seqlock.concurrency.test.ts`:
```ts
import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { WorldReader, createSnapshot, padIndex } from '../src/world/reader.ts'
import { testRegistry } from './helpers.ts'

describe('seqlock across threads', () => {
  it('never returns a torn chunk', async () => {
    const reg = testRegistry()
    const buffers = createWorldBuffers([64, 64, 64])
    const reader = new WorldReader(buffers, reg.opaque)
    const worker = new Worker(new URL('./fixtures/seqlockWriter.ts', import.meta.url), {
      workerData: { buffers, opaque: reg.opaque, iterations: 400 },
    })
    let done = false
    await new Promise<void>((resolve, reject) => {
      worker.on('error', reject)
      worker.on('message', (m: { type: string; index?: number; page?: SharedArrayBuffer }) => {
        if (m.type === 'page') { reader.addPage(m.index!, m.page!); worker.postMessage('start'); resolve() }
        if (m.type === 'done') done = true
      })
    })
    const snap = createSnapshot()
    let good = 0
    let torn = 0
    while (!done) {
      for (let i = 0; i < 50; i++) {
        if (reader.snapshot(0, snap) === null) continue
        const first = snap.voxels[padIndex(2, 1, 1)] // voxel (1,0,0)
        let same = true
        for (let y = 0; y < 32 && same; y++) for (let z = 0; z < 32 && same; z++) for (let x = 0; x < 32; x++) {
          if (!(x || y || z)) continue
          if (snap.voxels[padIndex(x + 1, y + 1, z + 1)] !== first) { same = false; break }
        }
        if (same) good++
        else torn++
      }
      await new Promise((r) => setImmediate(r))
    }
    await worker.terminate()
    expect(torn).toBe(0)
    expect(good).toBeGreaterThan(0)
  }, 30_000)
})
```

- [ ] **Step 6: Run the concurrency test**

Run `npm test -- seqlock`. Expected: PASS, with `torn = 0`.
If it fails with `ERR_UNKNOWN_FILE_EXTENSION`, confirm that `node --version` is ≥ 24 (type stripping is on by default there).

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/world/reader.ts packages/engine/test/reader.test.ts packages/engine/test/seqlock.concurrency.test.ts packages/engine/test/fixtures
git commit -m "feat(engine): world reader with seqlocked padded snapshots"
```

---

### Task 6: PCG32, hash and Scheduler

**Files:**
- Create: `packages/engine/src/sim/rng.ts`, `packages/engine/src/sim/scheduler.ts`
- Test: `packages/engine/test/rng.test.ts`, `packages/engine/test/scheduler.test.ts`

**Interfaces:**
- Produces (`sim/rng.ts`):
  - `class Pcg32` with `constructor(seed?)`, `reseed(seed)`, `nextU32(): number`, `next(): number` in [0, 1), `nextInt(n): number` in [0, n)
  - `hash32(...values: number[]): number` (unsigned 32-bit)
- Produces (`sim/scheduler.ts`): `class Scheduler` with:
  - `schedule(pos: number, dueTick: number): void`: dedupes per position and keeps the earliest due tick
  - `drain(tick: number, limit: number): number[]`: returns updates in (due tick, insertion) order; leftovers stay queued
  - `size: number`

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/rng.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { Pcg32, hash32 } from '../src/sim/rng.ts'

describe('Pcg32', () => {
  it('is reproducible per seed', () => {
    const a = new Pcg32(1234), b = new Pcg32(1234), c = new Pcg32(1235)
    const sa = Array.from({ length: 8 }, () => a.nextU32())
    const sb = Array.from({ length: 8 }, () => b.nextU32())
    const sc = Array.from({ length: 8 }, () => c.nextU32())
    expect(sa).toEqual(sb)
    expect(sa).not.toEqual(sc)
  })
  it('reseed restarts the stream', () => {
    const a = new Pcg32(7)
    const first = a.nextU32()
    a.nextU32()
    a.reseed(7)
    expect(a.nextU32()).toBe(first)
  })
  it('produces values in range with a sane mean', () => {
    const r = new Pcg32(99)
    let sum = 0
    for (let i = 0; i < 10_000; i++) {
      const u = r.nextU32()
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThanOrEqual(0xffffffff)
      const f = r.next()
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThan(1)
      sum += f
      const k = r.nextInt(6)
      expect(Number.isInteger(k) && k >= 0 && k < 6).toBe(true)
    }
    expect(sum / 10_000).toBeGreaterThan(0.45)
    expect(sum / 10_000).toBeLessThan(0.55)
  })
})

describe('hash32', () => {
  it('is deterministic, unsigned and order-sensitive', () => {
    expect(hash32(1, 2, 3)).toBe(hash32(1, 2, 3))
    expect(hash32(1, 2, 3)).not.toBe(hash32(3, 2, 1))
    expect(hash32(0)).toBeGreaterThanOrEqual(0)
    expect(hash32(-5)).toBeGreaterThanOrEqual(0)
  })
})
```

`packages/engine/test/scheduler.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { Scheduler } from '../src/sim/scheduler.ts'

describe('Scheduler', () => {
  it('drains FIFO within a due tick, earlier ticks first', () => {
    const s = new Scheduler()
    s.schedule(10, 6)
    s.schedule(20, 5)
    s.schedule(30, 5)
    expect(s.drain(4, 100)).toEqual([])
    expect(s.drain(6, 100)).toEqual([20, 30, 10])
    expect(s.size).toBe(0)
  })
  it('dedupes per position, keeping the earliest due tick', () => {
    const s = new Scheduler()
    s.schedule(1, 10)
    s.schedule(1, 12) // later: ignored
    s.schedule(1, 8)  // earlier: moves it
    expect(s.size).toBe(1)
    expect(s.drain(8, 100)).toEqual([1])
    expect(s.drain(20, 100)).toEqual([]) // the stale tick-10 entry is skipped
  })
  it('spills past the limit into the next drain, in order', () => {
    const s = new Scheduler()
    for (let p = 0; p < 5; p++) s.schedule(p, 3)
    s.schedule(99, 4)
    expect(s.drain(3, 2)).toEqual([0, 1])
    expect(s.drain(4, 10)).toEqual([2, 3, 4, 99])
  })
  it('allows a drained position to be scheduled again', () => {
    const s = new Scheduler()
    s.schedule(5, 1)
    expect(s.drain(1, 10)).toEqual([5])
    s.schedule(5, 2)
    expect(s.drain(2, 10)).toEqual([5])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run `npm test -- rng scheduler`. Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`packages/engine/src/sim/rng.ts`:
```ts
const MULT = 6364136223846793005n
const INC = 1442695040888963407n
const MASK64 = 0xffffffffffffffffn

/** PCG-XSH-RR 32-bit output, 64-bit state. BigInt keeps it exact on every engine. */
export class Pcg32 {
  private state = 0n

  constructor(seed = 0) { this.reseed(seed) }

  reseed(seed: number): void {
    this.state = 0n
    this.step()
    this.state = (this.state + BigInt(seed >>> 0)) & MASK64
    this.step()
  }

  nextU32(): number {
    const old = this.state
    this.step()
    const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & 0xffffffffn)
    const rot = Number(old >> 59n)
    return ((xorshifted >>> rot) | (xorshifted << ((32 - rot) & 31))) >>> 0
  }

  next(): number { return this.nextU32() / 4294967296 }

  nextInt(n: number): number { return Math.floor(this.next() * n) }

  private step(): void { this.state = (this.state * MULT + INC) & MASK64 }
}

function fmix(h: number): number {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h
}

export function hash32(...values: number[]): number {
  let h = 0x811c9dc5
  for (const v of values) h = Math.imul(h ^ fmix(v | 0), 0x01000193)
  return fmix(h) >>> 0
}
```

`packages/engine/src/sim/scheduler.ts`:
```ts
interface Bucket { items: number[]; head: number }

/** Scheduled block updates. Deterministic: (due tick, insertion order). */
export class Scheduler {
  private readonly due = new Map<number, number>()
  private readonly buckets = new Map<number, Bucket>()
  private readonly ticks: number[] = [] // ascending distinct due ticks that have a bucket

  get size(): number { return this.due.size }

  schedule(pos: number, dueTick: number): void {
    const cur = this.due.get(pos)
    if (cur !== undefined && cur <= dueTick) return
    this.due.set(pos, dueTick)
    let b = this.buckets.get(dueTick)
    if (!b) {
      b = { items: [], head: 0 }
      this.buckets.set(dueTick, b)
      let i = this.ticks.length
      while (i > 0 && this.ticks[i - 1]! > dueTick) i--
      this.ticks.splice(i, 0, dueTick)
    }
    b.items.push(pos)
  }

  drain(tick: number, limit: number): number[] {
    const out: number[] = []
    while (out.length < limit && this.ticks.length > 0 && this.ticks[0]! <= tick) {
      const t = this.ticks[0]!
      const b = this.buckets.get(t)!
      while (out.length < limit && b.head < b.items.length) {
        const pos = b.items[b.head++]!
        if (this.due.get(pos) !== t) continue // stale: moved earlier or already run
        this.due.delete(pos)
        out.push(pos)
      }
      if (b.head >= b.items.length) {
        this.buckets.delete(t)
        this.ticks.shift()
      }
    }
    return out
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run `npm test -- rng scheduler`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sim packages/engine/test/rng.test.ts packages/engine/test/scheduler.test.ts
git commit -m "feat(engine): PCG32 random stream and deterministic block-update scheduler"
```

---

### Task 7: Light engine

**Files:**
- Create: `packages/engine/src/sim/light.ts`
- Test: `packages/engine/test/light.test.ts`

**Interfaces:**
- Consumes: `ChunkStore` (Task 4), including `store.views`, `store.slotOf`, `store.table`; `voxelId`, `packLight`, `skyLight`, `blockLight` (Task 2); `decodeUniform` (Task 4).
- Produces: `interface LightTables { opaque: Uint8Array; emits: Uint8Array }` and `class LightEngine` with:
  - `constructor(store: ChunkStore, tables: LightTables)`
  - `onVoxelChanged(x, y, z, oldVoxel, newVoxel): void`, which queues work
  - `propagate(): void`: runs removal, then addition, for both channels
  - `initialize(): void`: the full-world pass after generation

**The rules this implements:**
- Sky light passes straight down at 15 through non-opaque voxels and spreads sideways and upward with a falloff of 1.
- Block light spreads with a falloff of 1. An emitter's own block light equals its `emits` value, even when the emitter is opaque.
- Opaque voxels have light 0 unless they emit.
- Outside the world, nothing is propagated, except that a non-opaque voxel at the top layer (`y = SY − 1`) always gets sky 15.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/light.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { LightEngine } from '../src/sim/light.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ChunkStore } from '../src/world/chunkStore.ts'
import { AIR, blockLight, skyLight } from '../src/world/voxel.ts'
import { ID, testRegistry } from './helpers.ts'

const reg = testRegistry()
function world(size: [number, number, number] = [64, 64, 64]) {
  const store = new ChunkStore({ buffers: createWorldBuffers(size), opaque: reg.opaque })
  const light = new LightEngine(store, { opaque: reg.opaque, emits: reg.emits })
  const edit = (x: number, y: number, z: number, v: number) => {
    const old = store.getVoxel(x, y, z)
    if (store.setVoxel(x, y, z, v)) light.onVoxelChanged(x, y, z, old, v)
  }
  const sky = (x: number, y: number, z: number) => skyLight(store.getLight(x, y, z))
  const blk = (x: number, y: number, z: number) => blockLight(store.getLight(x, y, z))
  return { store, light, edit, sky, blk }
}
function roof(store: ChunkStore, y: number, hole?: [number, number]) {
  for (let x = 0; x < 64; x++) for (let z = 0; z < 64; z++) {
    if (hole && hole[0] === x && hole[1] === z) continue
    store.setVoxel(x, y, z, ID.stone)
  }
}

describe('LightEngine.initialize', () => {
  it('lights open sky fully', () => {
    const w = world()
    w.light.initialize()
    expect(w.sky(5, 5, 5)).toBe(15)
  })
  it('darkens everything under a closed roof', () => {
    const w = world()
    roof(w.store, 40)
    w.light.initialize()
    expect(w.sky(10, 41, 10)).toBe(15)
    expect(w.sky(10, 20, 10)).toBe(0)
  })
  it('lets sky fall straight through a hole and fall off sideways', () => {
    const w = world()
    roof(w.store, 40, [32, 32])
    w.light.initialize()
    expect(w.sky(32, 20, 32)).toBe(15)
    expect(w.sky(35, 39, 32)).toBe(12)
  })
  it('spreads block light from emitters', () => {
    const w = world()
    roof(w.store, 40)
    w.store.setVoxel(10, 20, 10, ID.torch)
    w.light.initialize()
    expect(w.blk(10, 20, 10)).toBe(14)
    expect(w.blk(13, 20, 10)).toBe(11)
    expect(w.sky(13, 20, 10)).toBe(0)
  })
  it('darkens an enclosed uniform air chunk, giving it a slot', () => {
    const w = world([64, 96, 64])
    const L = w.store.layout
    for (let cz = 0; cz < 2; cz++) for (let cx = 0; cx < 2; cx++) {
      w.store.writeChunkDense(L.chunkIndex(cx, 2, cz), new Uint16Array(32768).fill(ID.stone))
    }
    w.light.initialize()
    expect(w.sky(5, 5, 5)).toBe(0)
    expect(w.store.slotOf(0)).toBeGreaterThanOrEqual(0)
  })
})

describe('LightEngine incremental updates', () => {
  it('places and removes a torch', () => {
    const w = world()
    roof(w.store, 40)
    w.light.initialize()
    w.edit(10, 20, 10, ID.torch)
    w.light.propagate()
    expect(w.blk(10, 20, 10)).toBe(14)
    expect(w.blk(13, 20, 10)).toBe(11)
    w.edit(10, 20, 10, AIR)
    w.light.propagate()
    expect(w.blk(10, 20, 10)).toBe(0)
    expect(w.blk(13, 20, 10)).toBe(0)
  })
  it('opens and closes a skylight shaft', () => {
    const w = world()
    roof(w.store, 40)
    w.light.initialize()
    w.edit(20, 40, 20, AIR)
    w.light.propagate()
    expect(w.sky(20, 10, 20)).toBe(15)
    expect(w.sky(22, 10, 20)).toBe(13)
    w.edit(20, 40, 20, ID.stone)
    w.light.propagate()
    expect(w.sky(20, 10, 20)).toBe(0)
    expect(w.sky(22, 10, 20)).toBe(0)
  })
  it('is blocked by opaque walls', () => {
    const w = world()
    roof(w.store, 40)
    for (let y = 0; y < 40; y++) for (let z = 0; z < 64; z++) w.store.setVoxel(12, y, z, ID.stone)
    w.light.initialize()
    w.edit(10, 20, 10, ID.torch)
    w.light.propagate()
    expect(w.blk(11, 20, 10)).toBe(13)
    expect(w.blk(13, 20, 10)).toBe(0)
  })
  it('relights the top layer when a block there is removed', () => {
    const w = world()
    w.light.initialize()
    w.edit(3, 63, 3, ID.stone)
    w.light.propagate()
    expect(w.sky(3, 62, 3)).toBe(14) // lit sideways from neighbours now
    w.edit(3, 63, 3, AIR)
    w.light.propagate()
    expect(w.sky(3, 63, 3)).toBe(15)
    expect(w.sky(3, 62, 3)).toBe(15)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run `npm test -- light`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/engine/src/sim/light.ts`:
```ts
import { decodeUniform } from '../world/buffers.ts'
import type { ChunkStore } from '../world/chunkStore.ts'
import { Layout } from '../world/layout.ts'
import { voxelId } from '../world/voxel.ts'

export interface LightTables { opaque: Uint8Array; emits: Uint8Array }

const SKY = 0
const BLOCK = 1
const DOWN = 3
const DX = [1, -1, 0, 0, 0, 0]
const DY = [0, 0, 1, -1, 0, 0]
const DZ = [0, 0, 0, 0, 1, -1]

function channel(l: number, ch: number): number { return ch === SKY ? l & 0xf : (l >>> 4) & 0xf }
function withChannel(l: number, ch: number, v: number): number {
  return ch === SKY ? (l & 0xf0) | v : (l & 0x0f) | (v << 4)
}

export class LightEngine {
  private readonly store: ChunkStore
  private readonly opaque: Uint8Array
  private readonly emits: Uint8Array
  private readonly sx: number
  private readonly sy: number
  private readonly sz: number
  private readonly removal: [number[], number[]] = [[], []] // pairs (pos, level)
  private readonly add: [number[], number[]] = [[], []]
  private ux = 0
  private uy = 0
  private uz = 0

  constructor(store: ChunkStore, tables: LightTables) {
    this.store = store
    this.opaque = tables.opaque
    this.emits = tables.emits
    ;[this.sx, this.sy, this.sz] = store.layout.size
  }

  onVoxelChanged(x: number, y: number, z: number, _oldVoxel: number, newVoxel: number): void {
    const pos = this.pack(x, y, z)
    const id = voxelId(newVoxel)
    for (const ch of [SKY, BLOCK]) {
      const l = channel(this.store.getLight(x, y, z), ch)
      if (l > 0) {
        this.setChannel(x, y, z, ch, 0)
        this.removal[ch]!.push(pos, l)
      }
      if (ch === BLOCK && this.emits[id]! > 0) {
        this.setChannel(x, y, z, BLOCK, this.emits[id]!)
        this.add[BLOCK]!.push(pos)
      }
      if (this.opaque[id]) continue
      if (ch === SKY && y === this.sy - 1) {
        this.setChannel(x, y, z, SKY, 15)
        this.add[SKY]!.push(pos)
      }
      for (let d = 0; d < 6; d++) {
        const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
        if (!this.inBounds(nx, ny, nz)) continue
        if (channel(this.store.getLight(nx, ny, nz), ch) > 0) this.add[ch]!.push(this.pack(nx, ny, nz))
      }
    }
  }

  propagate(): void {
    this.runRemoval(SKY)
    this.runRemoval(BLOCK)
    this.runAdd(SKY)
    this.runAdd(BLOCK)
  }

  initialize(): void {
    const store = this.store
    const L = store.layout
    // 1. Sky columns, top-down, chunk by chunk.
    for (let cz = 0; cz < L.cz; cz++) for (let cx = 0; cx < L.cx; cx++) {
      for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
        const x = cx * 32 + lx, z = cz * 32 + lz
        let covered = false
        for (let cy = L.cy - 1; cy >= 0; cy--) {
          const ci = L.chunkIndex(cx, cy, cz)
          const e = store.table[ci]!
          if (e < 0) {
            if (this.opaque[voxelId(decodeUniform(e))]) { covered = true; continue }
            if (!covered) continue // uniform non-opaque under open sky: implied 15 is right
            for (let ly = 31; ly >= 0; ly--) {
              const y = cy * 32 + ly
              this.setChannel(x, y, z, SKY, 0)
            }
            continue
          }
          const vox = store.views.voxels(e)
          const lt = store.views.light(e)
          for (let ly = 31; ly >= 0; ly--) {
            const i = Layout.localIndex(lx, ly, lz)
            if (this.opaque[voxelId(vox[i]!)]) { covered = true; lt[i] = lt[i]! & 0xf0; continue }
            lt[i] = covered ? lt[i]! & 0xf0 : (lt[i]! & 0xf0) | 15
          }
        }
      }
    }
    // 2. Seed dark non-opaque voxels from brighter neighbours; 3. seed emitters.
    for (let ci = 0; ci < L.chunkCount; ci++) {
      const slot = store.slotOf(ci)
      if (slot < 0) continue
      const [cx, cy, cz] = L.chunkCoords(ci)
      const vox = store.views.voxels(slot)
      const lt = store.views.light(slot)
      for (let ly = 0; ly < 32; ly++) for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
        const i = Layout.localIndex(lx, ly, lz)
        const id = voxelId(vox[i]!)
        const x = cx * 32 + lx, y = cy * 32 + ly, z = cz * 32 + lz
        if (this.emits[id]! > 0) {
          lt[i] = withChannel(lt[i]!, BLOCK, this.emits[id]!)
          this.add[BLOCK]!.push(this.pack(x, y, z))
        }
        if (this.opaque[id]) continue
        const own = lt[i]! & 0xf
        if (own >= 14) continue
        let best = 0
        for (let d = 0; d < 6; d++) {
          const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
          if (!this.inBounds(nx, ny, nz)) continue
          const nl = this.store.getLight(nx, ny, nz) & 0xf
          const t = d === 2 && nl === 15 ? 15 : nl - 1 // d === 2 is "above": light falling down
          if (t > best) best = t
        }
        if (best > own) {
          lt[i] = withChannel(lt[i]!, SKY, best)
          this.add[SKY]!.push(this.pack(x, y, z))
        }
      }
    }
    this.runAdd(SKY)
    this.runAdd(BLOCK)
  }

  private runRemoval(ch: number): void {
    const q = this.removal[ch]!
    for (let i = 0; i < q.length; i += 2) {
      const level = q[i + 1]!
      this.unpack(q[i]!)
      const x = this.ux, y = this.uy, z = this.uz
      for (let d = 0; d < 6; d++) {
        const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
        if (!this.inBounds(nx, ny, nz)) continue
        const nl = channel(this.store.getLight(nx, ny, nz), ch)
        if (nl === 0) continue
        const npos = this.pack(nx, ny, nz)
        const fromAbove = ch === SKY && d === DOWN && level === 15 && nl === 15
        if (nl < level || fromAbove) {
          this.setChannel(nx, ny, nz, ch, 0)
          q.push(npos, nl)
          if (ch === BLOCK) {
            const e = this.emits[voxelId(this.store.getVoxel(nx, ny, nz))]!
            if (e > 0) { this.setChannel(nx, ny, nz, BLOCK, e); this.add[BLOCK]!.push(npos) }
          }
        } else {
          this.add[ch]!.push(npos)
        }
      }
    }
    q.length = 0
  }

  private runAdd(ch: number): void {
    const q = this.add[ch]!
    for (let i = 0; i < q.length; i++) {
      this.unpack(q[i]!)
      const x = this.ux, y = this.uy, z = this.uz
      const l = channel(this.store.getLight(x, y, z), ch)
      if (l <= 1) continue
      for (let d = 0; d < 6; d++) {
        const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
        if (!this.inBounds(nx, ny, nz)) continue
        if (this.opaque[voxelId(this.store.getVoxel(nx, ny, nz))]) continue
        const target = ch === SKY && d === DOWN && l === 15 ? 15 : l - 1
        if (channel(this.store.getLight(nx, ny, nz), ch) < target) {
          this.setChannel(nx, ny, nz, ch, target)
          q.push(this.pack(nx, ny, nz))
        }
      }
    }
    q.length = 0
  }

  private setChannel(x: number, y: number, z: number, ch: number, v: number): void {
    this.store.setLight(x, y, z, withChannel(this.store.getLight(x, y, z), ch, v))
  }
  private inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz
  }
  private pack(x: number, y: number, z: number): number { return x + z * this.sx + y * this.sx * this.sz }
  private unpack(i: number): void {
    const layer = this.sx * this.sz
    this.uy = Math.floor(i / layer)
    const rest = i - this.uy * layer
    this.uz = Math.floor(rest / this.sx)
    this.ux = rest - this.uz * this.sx
  }
}
```

> Note: `initialize()` writes light directly into slot memory, bypassing the seqlock. That is safe only because it runs before the sim publishes `ready`, so no reader can be looking. `Simulation.generate` (Task 10) is its only caller.

- [ ] **Step 4: Run the test to verify it passes**

Run `npm test -- light`. Expected: PASS (9 tests).
If "relights the top layer" fails on the 14: the neighbours at y = 63 are 15, so (3, 62, 3) gets 15 − 1 = 14 from the sideways spread. Check that `runAdd` uses the straight-down 15 rule only for `d === DOWN`.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sim/light.ts packages/engine/test/light.test.ts
git commit -m "feat(engine): sky and block light flood fill with incremental updates"
```

---

### Task 8: Commands and validation

**Files:**
- Create: `packages/engine/src/sim/commands.ts`
- Test: `packages/engine/test/commands.test.ts`

**Interfaces:**
- Consumes: `Layout` (Task 2), `voxelId` (Task 2).
- Produces:
  - `type Vec3 = readonly [number, number, number]`
  - `interface SetBlockCommand { type: 'setBlock'; pos: Vec3; voxel: number }`
  - `interface FillRegionCommand { type: 'fillRegion'; min: Vec3; max: Vec3; voxel: number }`
  - `interface CustomCommand { type: string; [key: string]: unknown }`
  - `type Command = SetBlockCommand | FillRegionCommand | CustomCommand`
  - `interface StampedCommand { tick: number; clientId: number; seq: number; cmd: Command }`
  - `interface Ack { clientId: number; seq: number; ok: boolean; error?: string }`
  - `MAX_FILL_VOXELS = 1048576`
  - `validateCommand(cmd, layout, blockCount, customTypes: ReadonlySet<string>): string | null` (an error message, or `null` if valid)
  - `compareStamped(a, b): number` (by tick, then clientId, then seq)

- [ ] **Step 1: Write the failing test**

`packages/engine/test/commands.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MAX_FILL_VOXELS, compareStamped, validateCommand, type StampedCommand } from '../src/sim/commands.ts'
import { Layout } from '../src/world/layout.ts'
import { packVoxel } from '../src/world/voxel.ts'

const L = new Layout([1024, 128, 1024])
const none = new Set<string>()
const v = (cmd: unknown, custom = none) => validateCommand(cmd as never, L, 8, custom)

describe('validateCommand', () => {
  it('accepts setBlock anywhere inside the world, including every edge', () => {
    expect(v({ type: 'setBlock', pos: [0, 0, 0], voxel: 1 })).toBeNull()
    expect(v({ type: 'setBlock', pos: [1023, 127, 1023], voxel: packVoxel(7, 15) })).toBeNull()
  })
  it('rejects positions one past the edge', () => {
    expect(v({ type: 'setBlock', pos: [0, 128, 0], voxel: 1 })).toMatch(/out of bounds/)
    expect(v({ type: 'setBlock', pos: [-1, 0, 0], voxel: 1 })).toMatch(/out of bounds/)
    expect(v({ type: 'setBlock', pos: [1.5, 0, 0], voxel: 1 })).toMatch(/out of bounds/)
    expect(v({ type: 'setBlock', pos: [1, 2], voxel: 1 })).toMatch(/pos/)
  })
  it('rejects unknown blocks and malformed voxels', () => {
    expect(v({ type: 'setBlock', pos: [0, 0, 0], voxel: 8 })).toMatch(/unknown block/)
    expect(v({ type: 'setBlock', pos: [0, 0, 0], voxel: 0x10000 })).toMatch(/voxel/)
    expect(v({ type: 'setBlock', pos: [0, 0, 0], voxel: 1.5 })).toMatch(/voxel/)
  })
  it('validates fillRegion bounds, ordering and size', () => {
    expect(v({ type: 'fillRegion', min: [0, 0, 0], max: [1023, 0, 1023], voxel: 1 })).toBeNull() // exactly 1M
    expect(MAX_FILL_VOXELS).toBe(1024 * 1024)
    expect(v({ type: 'fillRegion', min: [0, 0, 0], max: [1023, 1, 1023], voxel: 1 })).toMatch(/too large/)
    expect(v({ type: 'fillRegion', min: [5, 0, 0], max: [4, 0, 0], voxel: 1 })).toMatch(/min/)
    expect(v({ type: 'fillRegion', min: [0, 0, 0], max: [0, 128, 0], voxel: 1 })).toMatch(/out of bounds/)
  })
  it('accepts only registered custom command types', () => {
    expect(v({ type: 'explode', at: [1, 2, 3] })).toMatch(/unknown command type "explode"/)
    expect(v({ type: 'explode', at: [1, 2, 3] }, new Set(['explode']))).toBeNull()
    expect(v({})).toMatch(/unknown command type/)
  })
})

describe('compareStamped', () => {
  it('orders by tick, then clientId, then seq', () => {
    const mk = (tick: number, clientId: number, seq: number): StampedCommand =>
      ({ tick, clientId, seq, cmd: { type: 'setBlock', pos: [0, 0, 0], voxel: 1 } })
    const list = [mk(2, 0, 0), mk(1, 1, 0), mk(1, 0, 5), mk(1, 0, 2)]
    expect(list.sort(compareStamped).map((c) => [c.tick, c.clientId, c.seq]))
      .toEqual([[1, 0, 2], [1, 0, 5], [1, 1, 0], [2, 0, 0]])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run `npm test -- commands`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/engine/src/sim/commands.ts`:
```ts
import type { Layout } from '../world/layout.ts'
import { voxelId } from '../world/voxel.ts'

export type Vec3 = readonly [number, number, number]
export interface SetBlockCommand { type: 'setBlock'; pos: Vec3; voxel: number }
export interface FillRegionCommand { type: 'fillRegion'; min: Vec3; max: Vec3; voxel: number }
export interface CustomCommand { type: string; [key: string]: unknown }
export type Command = SetBlockCommand | FillRegionCommand | CustomCommand

export interface StampedCommand { tick: number; clientId: number; seq: number; cmd: Command }
export interface Ack { clientId: number; seq: number; ok: boolean; error?: string }

export const MAX_FILL_VOXELS = 1 << 20

function checkPos(name: string, p: unknown, layout: Layout): string | null {
  if (!Array.isArray(p) || p.length !== 3) return `${name}: pos must be [x, y, z]`
  const [x, y, z] = p as number[]
  if (!layout.inBounds(x!, y!, z!)) return `${name}: position [${p.join(', ')}] is out of bounds`
  return null
}

function checkVoxel(v: unknown, blockCount: number): string | null {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 0xffff) return `invalid voxel ${String(v)}`
  if (voxelId(v) >= blockCount) return `unknown block id ${voxelId(v)}`
  return null
}

export function validateCommand(cmd: Command, layout: Layout, blockCount: number, customTypes: ReadonlySet<string>): string | null {
  if (cmd.type === 'setBlock') {
    const c = cmd as SetBlockCommand
    return checkPos('setBlock', c.pos, layout) ?? checkVoxel(c.voxel, blockCount)
  }
  if (cmd.type === 'fillRegion') {
    const c = cmd as FillRegionCommand
    const err = checkPos('fillRegion min', c.min, layout) ?? checkPos('fillRegion max', c.max, layout) ?? checkVoxel(c.voxel, blockCount)
    if (err) return err
    let volume = 1
    for (let a = 0; a < 3; a++) {
      if (c.min[a]! > c.max[a]!) return 'fillRegion: min must be <= max on every axis'
      volume *= c.max[a]! - c.min[a]! + 1
    }
    if (volume > MAX_FILL_VOXELS) return `fillRegion too large: ${volume} voxels (max ${MAX_FILL_VOXELS})`
    return null
  }
  if (typeof cmd.type !== 'string' || !customTypes.has(cmd.type)) return `unknown command type "${String(cmd.type)}"`
  return null
}

export function compareStamped(a: StampedCommand, b: StampedCommand): number {
  return a.tick - b.tick || a.clientId - b.clientId || a.seq - b.seq
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run `npm test -- commands`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sim/commands.ts packages/engine/test/commands.test.ts
git commit -m "feat(engine): command types, validation and deterministic ordering"
```

---

### Task 9: Rule API and the Simulation tick loop

**Files:**
- Create: `packages/engine/src/sim/rules.ts`, `packages/engine/src/sim/simulation.ts`
- Test: `packages/engine/test/simulation.test.ts`

**Interfaces:**
- Consumes:
  - `ChunkStore` (Task 4), `LightEngine` (Task 7), `Scheduler`, `Pcg32`, `hash32` (Task 6)
  - `validateCommand`, `compareStamped`, `Command`, `StampedCommand`, `Ack`, `SetBlockCommand`, `FillRegionCommand` (Task 8)
  - `BlockRegistry`, `BlockDef` (Task 3), `WorldBuffers` (Task 4)
- Produces (`sim/rules.ts`):
  - `interface RuleContext`:
    - `tick`, `get(x, y, z)`
    - `set(x, y, z, voxel)`: throws on an invalid voxel; out-of-bounds writes are ignored
    - `schedule(x, y, z, delayTicks)` (minimum delay 1), `random()`, `emit(type, payload?)`
    - `id(name)`, `isAir(v)`, `state(v)`, `withState(v, s)`
  - `interface BlockRules { onScheduledTick?, onNeighborChanged?, onRandomTick? }`, each `(ctx, x, y, z, voxel) => void`
  - `type CommandHandler = (ctx: RuleContext, cmd: Command) => void`
  - `interface RulesModule { blocks?: Record<string, BlockRules>; commands?: Record<string, CommandHandler> }`
  - `defineRules(r): RulesModule`
- Produces (`sim/simulation.ts`):
  - `interface SimulationOptions { buffers; blocks: readonly BlockDef[]; rules?; seed; workCap? (50000); randomTicksPerChunk? (3); maxPages?; commandLogLimit? (100000); onNewPage?; log? }`
  - `interface SimEvent { tick: number; type: string; payload?: unknown }`
  - `interface TickResult { tick: number; dirtyChunks: number[]; events: SimEvent[]; acks: Ack[] }`
  - `class Simulation` with:
    - fields `store`, `registry`, `light`, `layout`, `tick` (the next tick to run), `commandLog: StampedCommand[]`
    - `submit(clientId, seq, cmd): void`, `step(): TickResult`, `hash(): number`
    - `pendingWork: number` (neighbour notifications plus scheduled updates still queued)

**Semantics** (the spec's §4 plus Deviations 2–3):
- A successful set queues `onNeighborChanged` for the changed voxel and its 6 in-bounds neighbours.
- `fillRegion` queues notifications only for voxels on the region's outer shell, so a 1M-voxel fill doesn't queue 7M notifications.
- Each neighbour notification and each scheduled update costs 1 from the work cap. Notifications left over when the cap is hit carry into the next tick in order.
- Rule exceptions are caught and logged as `rule error block=<name> pos=(x,y,z) tick=<t>: <message>`. Steps 1–4 run inside `try/finally`, so `store.commit()` always runs and no seqlock is left odd.
- The one exception is `WorldFullError`, which is rethrown from both the command and the rule catch blocks. It propagates out of `step()` (after the commit), and the sim host (Task 14) turns it into a `fatal` message, as spec §7 requires.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/simulation.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { defineBlock } from '../src/blocks/registry.ts'
import { defineRules } from '../src/sim/rules.ts'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { AIR } from '../src/world/voxel.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

const BLOCKS = [...TEST_BLOCKS, defineBlock({ name: 'sand' }), defineBlock({ name: 'bomb' })]
const SAND = 8
const BOMB = 9

const rules = defineRules({
  blocks: {
    sand: {
      onNeighborChanged(ctx, x, y, z) { ctx.schedule(x, y, z, 2) },
      onScheduledTick(ctx, x, y, z, v) {
        if (y > 0 && ctx.isAir(ctx.get(x, y - 1, z))) { ctx.set(x, y, z, AIR); ctx.set(x, y - 1, z, v) }
      },
    },
    bomb: { onNeighborChanged() { throw new Error('boom') } },
  },
  commands: { ping(ctx, cmd) { ctx.emit('pong', (cmd as unknown as { n: number }).n) } },
})

function makeSim(opts: { workCap?: number; log?: (m: string) => void } = {}) {
  return new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks: BLOCKS, rules, seed: 42, ...opts })
}

describe('Simulation', () => {
  it('applies commands on the next step and acks them', () => {
    const sim = makeSim()
    sim.submit(1, 0, { type: 'setBlock', pos: [5, 5, 5], voxel: ID.stone })
    expect(sim.store.getVoxel(5, 5, 5)).toBe(AIR)
    const r = sim.step()
    expect(r.tick).toBe(0)
    expect(sim.tick).toBe(1)
    expect(sim.store.getVoxel(5, 5, 5)).toBe(ID.stone)
    expect(r.acks).toEqual([{ clientId: 1, seq: 0, ok: true }])
    expect(r.dirtyChunks).toContain(0)
    expect(sim.commandLog.map((c) => [c.tick, c.clientId, c.seq])).toEqual([[0, 1, 0]])
  })

  it('rejects invalid commands without touching the world or the log', () => {
    const sim = makeSim()
    sim.submit(1, 3, { type: 'setBlock', pos: [0, 64, 0], voxel: ID.stone })
    const r = sim.step()
    expect(r.acks[0]).toMatchObject({ clientId: 1, seq: 3, ok: false })
    expect(r.acks[0]!.error).toMatch(/out of bounds/)
    expect(sim.commandLog).toEqual([])
  })

  it('runs scheduled rules: sand falls to the floor', () => {
    const sim = makeSim()
    sim.submit(1, 0, { type: 'setBlock', pos: [5, 10, 5], voxel: SAND })
    for (let i = 0; i < 40; i++) sim.step()
    expect(sim.store.getVoxel(5, 10, 5)).toBe(AIR)
    expect(sim.store.getVoxel(5, 0, 5)).toBe(SAND)
  })

  it('keeps going when a rule throws, logs it, and leaves no seqlock odd', () => {
    const logs: string[] = []
    const sim = makeSim({ log: (m) => logs.push(m) })
    sim.submit(1, 0, { type: 'setBlock', pos: [6, 10, 5], voxel: BOMB })
    sim.submit(1, 1, { type: 'setBlock', pos: [5, 10, 5], voxel: SAND })
    for (let i = 0; i < 40; i++) sim.step()
    expect(sim.store.getVoxel(5, 0, 5)).toBe(SAND)
    expect(logs.some((l) => /rule error block=bomb pos=\(6,10,5\) tick=0: boom/.test(l))).toBe(true)
    expect(Array.from(sim.store.versions).every((v) => (v & 1) === 0)).toBe(true)
  })

  it('delivers custom commands and emitted events', () => {
    const sim = makeSim()
    sim.submit(2, 0, { type: 'ping', n: 7 })
    expect(sim.step().events).toEqual([{ tick: 0, type: 'pong', payload: 7 }])
  })

  it('caps work per tick by count and carries the rest over', () => {
    const sim = makeSim({ workCap: 5 })
    for (let i = 0; i < 10; i++) sim.submit(1, i, { type: 'setBlock', pos: [i * 3, 20, 5], voxel: ID.stone })
    sim.step()
    expect(sim.pendingWork).toBe(70 - 5)
    sim.step()
    expect(sim.pendingWork).toBe(70 - 10)
  })

  it('notifies only the shell of a fillRegion', () => {
    const sim = makeSim()
    sim.submit(1, 0, { type: 'fillRegion', min: [0, 0, 0], max: [9, 9, 9], voxel: ID.stone })
    sim.step()
    expect(sim.store.getVoxel(9, 9, 9)).toBe(ID.stone)
    expect(sim.pendingWork).toBe(0) // all shell notifications fit in the default cap
  })

  it('rejects rules for unknown blocks at construction', () => {
    expect(() => new Simulation({
      buffers: createWorldBuffers([32, 32, 32]), blocks: BLOCKS, seed: 1,
      rules: defineRules({ blocks: { nope: {} } }),
    })).toThrow(/unknown block "nope"/)
  })

  it('hashes world state', () => {
    const a = makeSim(), b = makeSim()
    expect(a.hash()).toBe(b.hash())
    a.submit(1, 0, { type: 'setBlock', pos: [1, 1, 1], voxel: ID.stone })
    a.step(); b.step()
    expect(a.hash()).not.toBe(b.hash())
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run `npm test -- simulation`. Expected: FAIL (modules not found).

- [ ] **Step 3: Implement the rule types**

`packages/engine/src/sim/rules.ts`:
```ts
import type { Command } from './commands.ts'

export interface RuleContext {
  readonly tick: number
  get(x: number, y: number, z: number): number
  set(x: number, y: number, z: number, voxel: number): void
  schedule(x: number, y: number, z: number, delayTicks: number): void
  random(): number
  emit(type: string, payload?: unknown): void
  id(name: string): number
  isAir(voxel: number): boolean
  state(voxel: number): number
  withState(voxel: number, state: number): number
}

export type BlockCallback = (ctx: RuleContext, x: number, y: number, z: number, voxel: number) => void

export interface BlockRules {
  onScheduledTick?: BlockCallback
  onNeighborChanged?: BlockCallback
  onRandomTick?: BlockCallback
}

export type CommandHandler = (ctx: RuleContext, cmd: Command) => void

export interface RulesModule {
  blocks?: Record<string, BlockRules>
  commands?: Record<string, CommandHandler>
}

export function defineRules(rules: RulesModule): RulesModule {
  return rules
}
```

- [ ] **Step 4: Implement Simulation**

`packages/engine/src/sim/simulation.ts`:
```ts
import { BlockRegistry, type BlockDef } from '../blocks/registry.ts'
import type { WorldBuffers } from '../world/buffers.ts'
import { ChunkStore, WorldFullError } from '../world/chunkStore.ts'
import { Layout } from '../world/layout.ts'
import { AIR, voxelId, voxelState, withState } from '../world/voxel.ts'
import {
  compareStamped, validateCommand,
  type Ack, type Command, type FillRegionCommand, type SetBlockCommand, type StampedCommand,
} from './commands.ts'
import { LightEngine } from './light.ts'
import { Pcg32, hash32 } from './rng.ts'
import type { BlockCallback, BlockRules, CommandHandler, RuleContext, RulesModule } from './rules.ts'
import { Scheduler } from './scheduler.ts'

export interface SimulationOptions {
  buffers: WorldBuffers
  blocks: readonly BlockDef[]
  rules?: RulesModule
  seed: number
  workCap?: number
  randomTicksPerChunk?: number
  maxPages?: number
  commandLogLimit?: number
  onNewPage?: (index: number, page: SharedArrayBuffer) => void
  log?: (message: string) => void
}

export interface SimEvent { tick: number; type: string; payload?: unknown }
export interface TickResult { tick: number; dirtyChunks: number[]; events: SimEvent[]; acks: Ack[] }

const DX = [1, -1, 0, 0, 0, 0]
const DY = [0, 0, 1, -1, 0, 0]
const DZ = [0, 0, 0, 0, 1, -1]

export class Simulation {
  readonly store: ChunkStore
  readonly registry: BlockRegistry
  readonly light: LightEngine
  readonly layout: Layout
  tick = 0
  readonly commandLog: StampedCommand[] = []

  private pending: StampedCommand[] = []
  private readonly scheduler = new Scheduler()
  private neighbors: number[] = []
  private neighborHead = 0
  private events: SimEvent[] = []
  private readonly rng = new Pcg32()
  private readonly byId: (BlockRules | undefined)[]
  private readonly handlers: Map<string, CommandHandler>
  private readonly customTypes: Set<string>
  private readonly hasRandom: boolean
  private readonly ctx: RuleContext
  private readonly seed: number
  private readonly workCap: number
  private readonly randomTicks: number
  private readonly logLimit: number
  private readonly log: (message: string) => void

  constructor(o: SimulationOptions) {
    this.registry = new BlockRegistry(o.blocks)
    this.store = new ChunkStore({ buffers: o.buffers, opaque: this.registry.opaque, onNewPage: o.onNewPage, maxPages: o.maxPages })
    this.layout = this.store.layout
    this.light = new LightEngine(this.store, { opaque: this.registry.opaque, emits: this.registry.emits })
    this.seed = o.seed
    this.workCap = o.workCap ?? 50_000
    this.randomTicks = o.randomTicksPerChunk ?? 3
    this.logLimit = o.commandLogLimit ?? 100_000
    this.log = o.log ?? ((m) => console.warn(m))
    const blockRules = o.rules?.blocks ?? {}
    for (const name of Object.keys(blockRules)) this.registry.id(name) // throws for unknown blocks
    this.byId = this.registry.defs.map((d) => blockRules[d.name])
    this.hasRandom = this.byId.some((r) => r?.onRandomTick)
    this.handlers = new Map(Object.entries(o.rules?.commands ?? {}))
    this.customTypes = new Set(this.handlers.keys())
    this.ctx = this.makeContext()
  }

  get pendingWork(): number { return this.neighbors.length - this.neighborHead + this.scheduler.size }

  submit(clientId: number, seq: number, cmd: Command): void {
    this.pending.push({ tick: this.tick, clientId, seq, cmd })
  }

  step(): TickResult {
    const t = this.tick
    const acks: Ack[] = []
    let dirtyChunks: number[] = []
    try {
      this.rng.reseed(hash32(this.seed, t))
      // 1. commands
      const cmds = this.pending.sort(compareStamped)
      this.pending = []
      for (const c of cmds) {
        const err = validateCommand(c.cmd, this.layout, this.registry.count, this.customTypes)
        if (err) { acks.push({ clientId: c.clientId, seq: c.seq, ok: false, error: err }); continue }
        try {
          this.applyCommand(c.cmd)
          this.appendLog(c)
          acks.push({ clientId: c.clientId, seq: c.seq, ok: true })
        } catch (e) {
          if (e instanceof WorldFullError) throw e // out of memory is fatal, not a bad command
          const msg = e instanceof Error ? e.message : String(e)
          this.log(`command error type=${c.cmd.type} tick=${t}: ${msg}`)
          acks.push({ clientId: c.clientId, seq: c.seq, ok: false, error: msg })
        }
      }
      // 2. neighbour notifications and scheduled updates, under the work cap
      let budget = this.processNeighbors(this.workCap)
      if (budget > 0) {
        for (const pos of this.scheduler.drain(t, budget)) {
          budget--
          this.runAt(pos, 'onScheduledTick')
          budget = this.processNeighbors(budget)
        }
      }
      // 3. random ticks
      if (this.hasRandom) {
        for (let ci = 0; ci < this.layout.chunkCount; ci++) {
          if (this.store.slotOf(ci) < 0) continue
          const [cx, cy, cz] = this.layout.chunkCoords(ci)
          for (let k = 0; k < this.randomTicks; k++) {
            const local = this.rng.nextInt(32768)
            const x = cx * 32 + (local & 31), z = cz * 32 + ((local >> 5) & 31), y = cy * 32 + (local >> 10)
            this.runAt(this.layout.voxelIndex(x, y, z), 'onRandomTick')
          }
        }
        this.processNeighbors(budget)
      }
      // 4. light
      this.light.propagate()
    } finally {
      // 5. always close seqlocks, even if something above threw
      dirtyChunks = this.store.commit()
      this.tick = t + 1
    }
    const events = this.events
    this.events = []
    return { tick: t, dirtyChunks, events, acks }
  }

  hash(): number {
    let h = 0x811c9dc5
    const mix = (v: number) => { h = Math.imul(h ^ v, 0x01000193) }
    mix(this.tick)
    for (let ci = 0; ci < this.layout.chunkCount; ci++) {
      const e = this.store.table[ci]!
      if (e < 0) { mix(e); continue }
      const vox = this.store.views.voxels(e)
      const lt = this.store.views.light(e)
      const v32 = new Uint32Array(vox.buffer, vox.byteOffset, vox.length >> 1)
      const l32 = new Uint32Array(lt.buffer, lt.byteOffset, lt.length >> 2)
      for (let i = 0; i < v32.length; i++) mix(v32[i]!)
      for (let i = 0; i < l32.length; i++) mix(l32[i]!)
    }
    return h >>> 0
  }

  private applyCommand(cmd: Command): void {
    if (cmd.type === 'setBlock') {
      const c = cmd as SetBlockCommand
      this.applySet(c.pos[0], c.pos[1], c.pos[2], c.voxel, true)
      return
    }
    if (cmd.type === 'fillRegion') {
      const c = cmd as FillRegionCommand
      const [x0, y0, z0] = c.min, [x1, y1, z1] = c.max
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const shell = x === x0 || x === x1 || y === y0 || y === y1 || z === z0 || z === z1
        this.applySet(x, y, z, c.voxel, shell)
      }
      return
    }
    this.handlers.get(cmd.type)!(this.ctx, cmd)
  }

  private applySet(x: number, y: number, z: number, v: number, notify: boolean): void {
    const old = this.store.getVoxel(x, y, z)
    if (!this.store.setVoxel(x, y, z, v)) return
    this.light.onVoxelChanged(x, y, z, old, v)
    if (!notify) return
    this.neighbors.push(this.layout.voxelIndex(x, y, z))
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
      if (this.layout.inBounds(nx, ny, nz)) this.neighbors.push(this.layout.voxelIndex(nx, ny, nz))
    }
  }

  private processNeighbors(budget: number): number {
    while (budget > 0 && this.neighborHead < this.neighbors.length) {
      budget--
      this.runAt(this.neighbors[this.neighborHead++]!, 'onNeighborChanged')
    }
    if (this.neighborHead === this.neighbors.length) {
      this.neighbors = []
      this.neighborHead = 0
    } else if (this.neighborHead > 4096 && this.neighborHead * 2 > this.neighbors.length) {
      this.neighbors = this.neighbors.slice(this.neighborHead)
      this.neighborHead = 0
    }
    return budget
  }

  private runAt(pos: number, hook: keyof BlockRules): void {
    const [x, y, z] = this.layout.voxelCoords(pos)
    const v = this.store.getVoxel(x, y, z)
    const fn: BlockCallback | undefined = this.byId[voxelId(v)]?.[hook]
    if (!fn) return
    try {
      fn(this.ctx, x, y, z, v)
    } catch (e) {
      if (e instanceof WorldFullError) throw e
      const msg = e instanceof Error ? e.message : String(e)
      this.log(`rule error block=${this.registry.name(voxelId(v))} pos=(${x},${y},${z}) tick=${this.tick}: ${msg}`)
    }
  }

  private appendLog(c: StampedCommand): void {
    this.commandLog.push(c)
    if (this.commandLog.length > this.logLimit) this.commandLog.splice(0, this.commandLog.length - this.logLimit)
  }

  private makeContext(): RuleContext {
    const sim = this
    return {
      get tick() { return sim.tick },
      get: (x, y, z) => sim.store.getVoxel(x, y, z),
      set: (x, y, z, v) => {
        if (!Number.isInteger(v) || v < 0 || v > 0xffff || voxelId(v) >= sim.registry.count) throw new Error(`invalid voxel ${v}`)
        sim.applySet(x, y, z, v, true)
      },
      schedule: (x, y, z, delay) => {
        if (!sim.layout.inBounds(x, y, z)) return
        sim.scheduler.schedule(sim.layout.voxelIndex(x, y, z), sim.tick + Math.max(1, Math.floor(delay)))
      },
      random: () => sim.rng.next(),
      emit: (type, payload) => { sim.events.push(payload === undefined ? { tick: sim.tick, type } : { tick: sim.tick, type, payload }) },
      id: (name) => sim.registry.id(name),
      isAir: (v) => voxelId(v) === AIR,
      state: (v) => voxelState(v),
      withState: (v, s) => withState(v, s),
    }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run `npm test -- simulation`. Expected: PASS (9 tests).
The work-cap test counts 7 notifications per `setBlock` (self + 6 in-bounds neighbours). All 10 blocks sit at `y = 20` with `x ≤ 27`, so every neighbour is in bounds and the total is 70.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/sim/rules.ts packages/engine/src/sim/simulation.ts packages/engine/test/simulation.test.ts
git commit -m "feat(engine): deterministic simulation tick with rule API and work cap"
```

---

### Task 10: Generator API, test terrain, and the determinism test

**Files:**
- Create: `packages/engine/src/sim/generator.ts`, `packages/engine/src/sim/testGenerator.ts`
- Modify: `packages/engine/src/sim/simulation.ts` (add `generate`)
- Test: `packages/engine/test/generator.test.ts`, `packages/engine/test/determinism.test.ts`

**Interfaces:**
- Consumes: `Simulation` (Task 9), `hash32` (Task 6), `Layout` (Task 2).
- Produces (`sim/generator.ts`):
  - `interface GeneratorContext { readonly seed; readonly height; set(lx, y, lz, voxel); id(name); noise2(x, z): number; fbm2(x, z, octaves): number }`
  - `interface GeneratorModule { generateColumn(ctx, cx, cz): void }`
  - `defineGenerator(g)`, `valueNoise2(seed, x, z): number` in [0, 1)
- Produces (`sim/testGenerator.ts`): `testGenerator: GeneratorModule`. It needs blocks named `stone`, `dirt` and `grass`.
- Produces: `Simulation.generate(gen: GeneratorModule): number[]`. It returns every chunk index (the initial mesh list), runs before tick 0, and leaves all seqlocks even.

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/generator.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { defineGenerator, valueNoise2 } from '../src/sim/generator.ts'
import { Simulation } from '../src/sim/simulation.ts'
import { testGenerator } from '../src/sim/testGenerator.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { AIR, skyLight } from '../src/world/voxel.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

const sim = () => new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks: TEST_BLOCKS, seed: 5 })

describe('valueNoise2', () => {
  it('is deterministic, in range and smooth', () => {
    expect(valueNoise2(1, 3.25, 7.5)).toBe(valueNoise2(1, 3.25, 7.5))
    expect(valueNoise2(1, 3.25, 7.5)).not.toBe(valueNoise2(2, 3.25, 7.5))
    for (let i = 0; i < 200; i++) {
      const n = valueNoise2(9, i * 0.37, i * 0.11)
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThan(1)
    }
    expect(Math.abs(valueNoise2(3, 10, 10) - valueNoise2(3, 10.001, 10))).toBeLessThan(0.01)
  })
})

describe('Simulation.generate', () => {
  it('fills columns and stores uniform chunks without slots', () => {
    const s = sim()
    const flat = defineGenerator({
      generateColumn(ctx) {
        for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) for (let y = 0; y < 32; y++) ctx.set(lx, y, lz, ctx.id('stone'))
      },
    })
    const all = s.generate(flat)
    expect(all).toHaveLength(8)
    expect(s.store.getVoxel(3, 31, 3)).toBe(ID.stone)
    expect(s.store.getVoxel(3, 32, 3)).toBe(AIR)
    expect(s.store.slotsUsed()).toBe(0)
    expect(Array.from(s.store.versions).every((v) => (v & 1) === 0)).toBe(true)
  })

  it('rejects out-of-column writes', () => {
    const bad = defineGenerator({ generateColumn(ctx) { ctx.set(32, 0, 0, 1) } })
    expect(() => sim().generate(bad)).toThrow(RangeError)
  })

  it('builds lit layered terrain with the test generator', () => {
    const s = sim()
    s.generate(testGenerator)
    let grassTops = 0
    for (let x = 0; x < 64; x += 7) for (let z = 0; z < 64; z += 7) {
      let y = 63
      while (y > 0 && s.store.getVoxel(x, y, z) === AIR) y--
      if (s.store.getVoxel(x, y, z) === ID.grass) grassTops++
      expect(s.store.getVoxel(x, 0, z)).toBe(ID.stone)
      expect(skyLight(s.store.getLight(x, y + 1, z))).toBe(15)
    }
    expect(grassTops).toBeGreaterThan(0)
  })
})
```

`packages/engine/test/determinism.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { defineBlock } from '../src/blocks/registry.ts'
import type { StampedCommand } from '../src/sim/commands.ts'
import { defineRules } from '../src/sim/rules.ts'
import { Simulation } from '../src/sim/simulation.ts'
import { testGenerator } from '../src/sim/testGenerator.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { AIR } from '../src/world/voxel.ts'
import { TEST_BLOCKS } from './helpers.ts'

const BLOCKS = [...TEST_BLOCKS, defineBlock({ name: 'sand' })]
const rules = defineRules({
  blocks: {
    sand: {
      onNeighborChanged(ctx, x, y, z) { ctx.schedule(x, y, z, 1 + Math.floor(ctx.random() * 3)) },
      onScheduledTick(ctx, x, y, z, v) {
        if (y > 0 && ctx.isAir(ctx.get(x, y - 1, z))) { ctx.set(x, y, z, AIR); ctx.set(x, y - 1, z, v) }
      },
    },
    grass: {
      onRandomTick(ctx, x, y, z) {
        const dx = ctx.random() < 0.5 ? -1 : 1
        if (ctx.get(x + dx, y, z) === ctx.id('dirt') && ctx.isAir(ctx.get(x + dx, y + 1, z))) ctx.set(x + dx, y, z, ctx.id('grass'))
      },
    },
  },
})

function makeSim(seed = 77) {
  const sim = new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks: BLOCKS, rules, seed })
  sim.generate(testGenerator)
  return sim
}

/** A scripted session: drop sand, dig holes, expose dirt for grass to spread onto. */
function script(sim: Simulation, t: number): void {
  if (t % 10 === 0) sim.submit(1, t, { type: 'setBlock', pos: [(t * 7) % 64, 60, (t * 13) % 64], voxel: 8 })
  if (t % 25 === 0) sim.submit(2, t, { type: 'fillRegion', min: [(t * 3) % 60, 20, 10], max: [(t * 3) % 60 + 3, 40, 13], voxel: AIR })
  if (t === 100) sim.submit(1, 9999, { type: 'setBlock', pos: [0, 99, 0], voxel: 1 }) // rejected: out of bounds
}

function run(sim: Simulation, ticks: number): number {
  for (let t = 0; t < ticks; t++) { script(sim, t); sim.step() }
  return sim.hash()
}

function replay(log: readonly StampedCommand[], ticks: number): number {
  const sim = makeSim()
  let i = 0
  for (let t = 0; t < ticks; t++) {
    while (i < log.length && log[i]!.tick === t) { const c = log[i++]!; sim.submit(c.clientId, c.seq, c.cmd) }
    sim.step()
  }
  return sim.hash()
}

describe('determinism', () => {
  it('produces the same world hash for the same seed and commands', () => {
    const a = makeSim()
    const b = makeSim()
    const ha = run(a, 500)
    const hb = run(b, 500)
    expect(ha).toBe(hb)
    expect(replay(a.commandLog, 500)).toBe(ha)
  }, 60_000)

  it('diverges for a different seed', () => {
    expect(run(makeSim(77), 200)).not.toBe(run(makeSim(78), 200))
  }, 60_000)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run `npm test -- generator determinism`. Expected: FAIL (modules or `generate` missing).

- [ ] **Step 3: Implement the generator API**

`packages/engine/src/sim/generator.ts`:
```ts
import { hash32 } from './rng.ts'

export interface GeneratorContext {
  readonly seed: number
  readonly height: number
  /** Local column coordinates: lx, lz in 0..31, y in 0..height-1. */
  set(lx: number, y: number, lz: number, voxel: number): void
  id(name: string): number
  noise2(x: number, z: number): number
  fbm2(x: number, z: number, octaves: number): number
}

export interface GeneratorModule {
  generateColumn(ctx: GeneratorContext, cx: number, cz: number): void
}

export function defineGenerator(g: GeneratorModule): GeneratorModule {
  return g
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

`packages/engine/src/sim/testGenerator.ts`:
```ts
import { defineGenerator } from './generator.ts'

/** Layered heightmap: stone, 2 blocks of dirt, a grass top. Needs blocks "stone", "dirt", "grass". */
export const testGenerator = defineGenerator({
  generateColumn(ctx, cx, cz) {
    const stone = ctx.id('stone'), dirt = ctx.id('dirt'), grass = ctx.id('grass')
    const base = Math.floor(ctx.height * 0.35)
    const amp = Math.floor(ctx.height * 0.25)
    for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
      const x = cx * 32 + lx, z = cz * 32 + lz
      const h = Math.max(4, Math.min(ctx.height - 2, base + Math.floor(ctx.fbm2(x / 48, z / 48, 4) * amp)))
      for (let y = 0; y < h; y++) ctx.set(lx, y, lz, y === h - 1 ? grass : y >= h - 3 ? dirt : stone)
    }
  },
})
```

- [ ] **Step 4: Add `generate` to Simulation**

In `packages/engine/src/sim/simulation.ts`, add this import:
```ts
import { fbm2, valueNoise2, type GeneratorContext, type GeneratorModule } from './generator.ts'
```
and this method on `Simulation` (after `submit`):
```ts
  /** Runs once before tick 0. Returns every chunk index; the mesher skips trivial ones. */
  generate(gen: GeneratorModule): number[] {
    const L = this.layout
    const H = L.size[1]
    const column = new Uint16Array(32 * 32 * H)
    const seed = this.seed
    const ctx: GeneratorContext = {
      seed,
      height: H,
      set: (lx, y, lz, v) => {
        if (!Number.isInteger(lx) || !Number.isInteger(y) || !Number.isInteger(lz) ||
            lx < 0 || lx > 31 || lz < 0 || lz > 31 || y < 0 || y >= H) {
          throw new RangeError(`generator write outside column: (${lx}, ${y}, ${lz})`)
        }
        column[lx + (lz << 5) + (y << 10)] = v
      },
      id: (name) => this.registry.id(name),
      noise2: (x, z) => valueNoise2(seed, x, z),
      fbm2: (x, z, octaves) => fbm2(seed, x, z, octaves),
    }
    for (let cz = 0; cz < L.cz; cz++) for (let cx = 0; cx < L.cx; cx++) {
      column.fill(AIR)
      gen.generateColumn(ctx, cx, cz)
      for (let cy = 0; cy < L.cy; cy++) {
        this.store.writeChunkDense(L.chunkIndex(cx, cy, cz), column.subarray(cy * 32768, (cy + 1) * 32768))
      }
    }
    this.light.initialize()
    this.store.commit()
    return Array.from({ length: L.chunkCount }, (_, i) => i)
  }
```

The column buffer index `lx + lz*32 + y*1024` equals the chunk-local index plus `cy * 32768`. That is why each chunk is a contiguous subarray.

- [ ] **Step 5: Run the tests to verify they pass**

Run `npm test -- generator determinism`. Expected: PASS.
If the determinism hashes differ, look for an iteration over a `Set` or `Map` built in a non-deterministic order, or a float stored in world state. Fix the cause; don't loosen the test.

- [ ] **Step 6: Run the full suite**

Run `npm test`. Expected: every test passes.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/sim packages/engine/test/generator.test.ts packages/engine/test/determinism.test.ts
git commit -m "feat(engine): column generator API, test terrain and determinism/replay test"
```

---

### Task 11: Vertex format, AO and the quad builder

**Files:**
- Create: `packages/engine/src/mesh/vertexFormat.ts`, `packages/engine/src/mesh/ao.ts`, `packages/engine/src/mesh/quadBuilder.ts`, `packages/engine/src/mesh/tables.ts`
- Test: `packages/engine/test/vertexFormat.test.ts`, `packages/engine/test/quadBuilder.test.ts`

**Interfaces:**
- Consumes: `BlockRegistry` (Task 3).
- Produces (`mesh/vertexFormat.ts`):
  - `FACE = { PX: 0, NX: 1, PY: 2, NY: 3, PZ: 4, NZ: 5 }` and `FACE_NORMALS`
  - `packA(x, y, z, normal, ao, corner, drop = 0): number` and `unpackA(a)` → `{ x, y, z, normal, ao, corner, drop }`
  - `packB(layer, sky, block, w, h): number` and `unpackB(b)` → `{ layer, sky, block, w, h }`
  - The bit layout matches spec §5; `drop` (bits 25–29, in sixteenths of a block below `y`) is Deviation 5.
- Produces (`mesh/ao.ts`):
  - `vertexAO(side1, side2, corner): number`, the occlusion count 0–3
  - `flipDiagonal(o0, o1, o2, o3): boolean`: true means split along the c1–c3 diagonal
  - `AO_CURVE = [1, 0.78, 0.62, 0.48]`
- Produces (`mesh/quadBuilder.ts`):
  - `interface LayerMesh { vertices: Uint32Array; indices: Uint32Array }`, with 2 u32 per vertex (`a`, `b`)
  - `class QuadBuilder` with `push(a: ArrayLike<number>, b: ArrayLike<number>, flip: boolean, reverse: boolean)`, `quadCount`, `build(): LayerMesh | null`, `reset()`
- Produces (`mesh/tables.ts`):
  - `interface MeshTables { opaque: Uint8Array; layer: Uint8Array; liquid: Uint8Array; faceLayers: Uint16Array }`
  - `meshTablesFrom(registry, faceLayers): MeshTables`

**Corner and winding conventions** (used by Tasks 12–13):
- For face `f`, the axis is `d = f >> 1` (0 = x, 1 = y, 2 = z), and the face is positive when `(f & 1) === 0`.
- The in-plane axes are `U/V`: x faces use (z, y), y faces use (x, z), z faces use (x, y).
- Corners run `c0 = (u, v)`, `c1 = (u+w, v)`, `c2 = (u+w, v+h)`, `c3 = (u, v+h)`. Their AO signs are `(su, sv)` = `(−,−)`, `(+,−)`, `(+,+)`, `(−,+)`.
- `REVERSE = [true, false, true, false, false, true]` marks the faces whose `U × V` points against the normal. Those faces get reversed index winding, so every triangle is counter-clockwise seen from outside.

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/vertexFormat.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { AO_CURVE, flipDiagonal, vertexAO } from '../src/mesh/ao.ts'
import { packA, packB, unpackA, unpackB } from '../src/mesh/vertexFormat.ts'

describe('vertex format', () => {
  it('round-trips word A at its limits', () => {
    const a = packA(32, 32, 32, 5, 3, 3, 16)
    expect(unpackA(a)).toEqual({ x: 32, y: 32, z: 32, normal: 5, ao: 3, corner: 3, drop: 16 })
    expect(unpackA(packA(0, 1, 2, 0, 0, 1))).toEqual({ x: 0, y: 1, z: 2, normal: 0, ao: 0, corner: 1, drop: 0 })
    expect(a).toBeLessThanOrEqual(0xffffffff)
  })
  it('round-trips word B at its limits', () => {
    expect(unpackB(packB(4095, 15, 15, 32, 32))).toEqual({ layer: 4095, sky: 15, block: 15, w: 32, h: 32 })
    expect(packB(4095, 15, 15, 63, 63)).toBeGreaterThan(0) // unsigned, even with the top bit set
  })
})

describe('ambient occlusion', () => {
  it('counts occluders, with two sides forcing full occlusion', () => {
    expect(vertexAO(false, false, false)).toBe(0)
    expect(vertexAO(false, false, true)).toBe(1)
    expect(vertexAO(true, false, true)).toBe(2)
    expect(vertexAO(true, true, false)).toBe(3)
    expect(AO_CURVE).toHaveLength(4)
  })
  it('flips to the c1–c3 diagonal when c0+c2 are darker', () => {
    expect(flipDiagonal(3, 0, 0, 0)).toBe(true)
    expect(flipDiagonal(0, 3, 0, 0)).toBe(false)
    expect(flipDiagonal(1, 1, 1, 1)).toBe(false)
  })
})
```

`packages/engine/test/quadBuilder.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { QuadBuilder } from '../src/mesh/quadBuilder.ts'

describe('QuadBuilder', () => {
  it('returns null when empty', () => expect(new QuadBuilder().build()).toBeNull())
  it('emits 4 vertices and 6 indices per quad with the four index patterns', () => {
    const q = new QuadBuilder(1)
    const a = [10, 11, 12, 13], b = [20, 21, 22, 23]
    q.push(a, b, false, false)
    q.push(a, b, false, true)
    q.push(a, b, true, false)
    q.push(a, b, true, true) // forces a grow from capacity 1
    const m = q.build()!
    expect(q.quadCount).toBe(4)
    expect(Array.from(m.vertices.subarray(0, 8))).toEqual([10, 20, 11, 21, 12, 22, 13, 23])
    expect(Array.from(m.indices)).toEqual([
      0, 1, 2, 0, 2, 3,
      4, 6, 5, 4, 7, 6,
      9, 10, 11, 9, 11, 8,
      13, 15, 14, 13, 12, 15,
    ])
  })
  it('reset clears and build returns trimmed copies', () => {
    const q = new QuadBuilder()
    q.push([1, 2, 3, 4], [5, 6, 7, 8], false, false)
    const m = q.build()!
    expect(m.vertices.length).toBe(8)
    expect(m.indices.length).toBe(6)
    q.reset()
    expect(q.build()).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run `npm test -- vertexFormat quadBuilder`. Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`packages/engine/src/mesh/vertexFormat.ts`:
```ts
export const FACE = { PX: 0, NX: 1, PY: 2, NY: 3, PZ: 4, NZ: 5 } as const
export const FACE_NORMALS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
]

/** Word A: x(6) y(6) z(6) normal(3) ao(2) corner(2) drop(5) reserved(2). */
export function packA(x: number, y: number, z: number, normal: number, ao: number, corner: number, drop = 0): number {
  return (x | (y << 6) | (z << 12) | (normal << 18) | (ao << 21) | (corner << 23) | (drop << 25)) >>> 0
}
export function unpackA(a: number) {
  return {
    x: a & 63, y: (a >>> 6) & 63, z: (a >>> 12) & 63, normal: (a >>> 18) & 7,
    ao: (a >>> 21) & 3, corner: (a >>> 23) & 3, drop: (a >>> 25) & 31,
  }
}

/** Word B: texture layer(12) sky(4) block(4) quad w(6) quad h(6). */
export function packB(layer: number, sky: number, block: number, w: number, h: number): number {
  return (layer | (sky << 12) | (block << 16) | (w << 20) | (h << 26)) >>> 0
}
export function unpackB(b: number) {
  return { layer: b & 4095, sky: (b >>> 12) & 15, block: (b >>> 16) & 15, w: (b >>> 20) & 63, h: (b >>> 26) & 63 }
}
```

`packages/engine/src/mesh/ao.ts`:
```ts
/** Occlusion count for one vertex (0 = open, 3 = fully occluded). */
export function vertexAO(side1: boolean, side2: boolean, corner: boolean): number {
  if (side1 && side2) return 3
  return (side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner ? 1 : 0)
}

/**
 * True → split the quad along the c1–c3 diagonal.
 * Equivalent to the spec's "ao0 + ao2 < ao1 + ao3" written in brightness terms.
 */
export function flipDiagonal(o0: number, o1: number, o2: number, o3: number): boolean {
  return o0 + o2 > o1 + o3
}

/** Brightness multiplier by occlusion count, shared with the shader. */
export const AO_CURVE: readonly number[] = [1, 0.78, 0.62, 0.48]
```

`packages/engine/src/mesh/quadBuilder.ts`:
```ts
export interface LayerMesh { vertices: Uint32Array; indices: Uint32Array }

const PATTERNS = [
  [0, 1, 2, 0, 2, 3], // diagonal 0–2, normal winding
  [0, 2, 1, 0, 3, 2], // diagonal 0–2, reversed
  [1, 2, 3, 1, 3, 0], // diagonal 1–3, normal
  [1, 3, 2, 1, 0, 3], // diagonal 1–3, reversed
] as const

export class QuadBuilder {
  private v: Uint32Array
  private idx: Uint32Array
  private quads = 0

  constructor(initialQuads = 256) {
    this.v = new Uint32Array(initialQuads * 8)
    this.idx = new Uint32Array(initialQuads * 6)
  }

  get quadCount(): number { return this.quads }

  push(a: ArrayLike<number>, b: ArrayLike<number>, flip: boolean, reverse: boolean): void {
    if ((this.quads + 1) * 8 > this.v.length) this.grow()
    const vo = this.quads * 8
    const base = this.quads * 4
    for (let k = 0; k < 4; k++) {
      this.v[vo + k * 2] = a[k]!
      this.v[vo + k * 2 + 1] = b[k]!
    }
    const p = PATTERNS[(flip ? 2 : 0) + (reverse ? 1 : 0)]!
    const io = this.quads * 6
    for (let k = 0; k < 6; k++) this.idx[io + k] = base + p[k]!
    this.quads++
  }

  build(): LayerMesh | null {
    if (this.quads === 0) return null
    return { vertices: this.v.slice(0, this.quads * 8), indices: this.idx.slice(0, this.quads * 6) }
  }

  reset(): void { this.quads = 0 }

  private grow(): void {
    const v = new Uint32Array(this.v.length * 2)
    v.set(this.v)
    this.v = v
    const idx = new Uint32Array(this.idx.length * 2)
    idx.set(this.idx)
    this.idx = idx
  }
}
```

`packages/engine/src/mesh/tables.ts`:
```ts
import type { BlockRegistry } from '../blocks/registry.ts'

/** Plain typed arrays, so they can be posted to mesh workers. */
export interface MeshTables {
  opaque: Uint8Array
  layer: Uint8Array
  liquid: Uint8Array
  faceLayers: Uint16Array
}

export function meshTablesFrom(registry: BlockRegistry, faceLayers: Uint16Array): MeshTables {
  return { opaque: registry.opaque, layer: registry.layer, liquid: registry.liquid, faceLayers }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run `npm test -- vertexFormat quadBuilder`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/mesh packages/engine/test/vertexFormat.test.ts packages/engine/test/quadBuilder.test.ts
git commit -m "feat(engine): packed vertex format, vertex AO and quad builder"
```

---

### Task 12: Greedy mesher (opaque) and cutout faces

**Files:**
- Create: `packages/engine/src/mesh/greedy.ts`, `packages/engine/test/meshHelpers.ts`
- Test: `packages/engine/test/greedy.test.ts`

**Interfaces:**
- Consumes: `ChunkSnapshot`, `padIndex` (Task 5); `MeshTables`, `QuadBuilder`, `packA`, `packB`, `vertexAO`, `flipDiagonal` (Task 11); `LAYER` (Task 3); `voxelId` (Task 2).
- Produces (`mesh/greedy.ts`):
  - `REVERSE: readonly boolean[]`, `AXES: readonly (readonly [number, number, number])[]` (`[d, u, v]` per face), `STRIDE = [1, 1156, 34]` (the padded-index stride per world axis x, y, z)
  - `faceAO(snap, tables, nIndex, f): number`, which packs the 4 corner occlusions as `o0 | o1<<2 | o2<<4 | o3<<6` for the voxel at padded index `nIndex` (the cell in front of the face)
  - `meshOpaqueAndCutout(snap, tables, opaque: QuadBuilder, cutout: QuadBuilder, mask: Int32Array /* 1024 */): void`
- Produces (`test/meshHelpers.ts`): `emptySnap()`, `put(snap, lx, ly, lz, voxel)`, `meshTables()`, `countByNormal(mesh, normal)`, `assertOutwardWinding(mesh)`

**Face rules:**
- **Opaque layer:** emit a face where the neighbour isn't opaque. Merge rectangles only when texture layer, all four AO values, sky light and block light are all equal (the mask key).
- **Cutout layer:** emit per face (no merging) where the neighbour isn't opaque and isn't the same block id.
- **Light:** each face takes the light of the voxel in front of it.

- [ ] **Step 1: Write the test helpers and the failing test**

`packages/engine/test/meshHelpers.ts`:
```ts
import { expect } from 'vitest'
import type { LayerMesh } from '../src/mesh/quadBuilder.ts'
import { meshTablesFrom, type MeshTables } from '../src/mesh/tables.ts'
import { FACE_NORMALS, unpackA } from '../src/mesh/vertexFormat.ts'
import { createSnapshot, padIndex, type ChunkSnapshot } from '../src/world/reader.ts'
import { AIR, FULL_SKY } from '../src/world/voxel.ts'
import { testRegistry } from './helpers.ts'

export function emptySnap(): ChunkSnapshot {
  const s = createSnapshot()
  s.voxels.fill(AIR)
  s.light.fill(FULL_SKY)
  return s
}

/** Local chunk coords; -1 and 32 address the 1-voxel border. */
export function put(s: ChunkSnapshot, lx: number, ly: number, lz: number, v: number): void {
  s.voxels[padIndex(lx + 1, ly + 1, lz + 1)] = v
}

export function meshTables(): MeshTables {
  const reg = testRegistry()
  return meshTablesFrom(reg, reg.faceLayers(new Map(reg.textureNames().map((n, i) => [n, i + 1]))))
}

export function countByNormal(m: LayerMesh | null, normal: number): number {
  if (!m) return 0
  let n = 0
  for (let i = 0; i < m.vertices.length; i += 8) if (unpackA(m.vertices[i]!).normal === normal) n++
  return n
}

/** Every triangle must face out along its vertex normal (CCW seen from outside). */
export function assertOutwardWinding(m: LayerMesh | null): void {
  if (!m) return
  const pos = (vi: number) => {
    const a = unpackA(m.vertices[vi * 2]!)
    return [a.x, a.y - a.drop / 16, a.z, a.normal] as const
  }
  for (let t = 0; t < m.indices.length; t += 3) {
    const p0 = pos(m.indices[t]!), p1 = pos(m.indices[t + 1]!), p2 = pos(m.indices[t + 2]!)
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]
    const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]]
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
    const fn = FACE_NORMALS[p0[3]]!
    expect(n[0]! * fn[0] + n[1]! * fn[1] + n[2]! * fn[2]).toBeGreaterThan(0)
  }
}
```

`packages/engine/test/greedy.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { meshOpaqueAndCutout } from '../src/mesh/greedy.ts'
import { QuadBuilder } from '../src/mesh/quadBuilder.ts'
import { FACE, unpackA } from '../src/mesh/vertexFormat.ts'
import { padIndex, type ChunkSnapshot } from '../src/world/reader.ts'
import { packLight } from '../src/world/voxel.ts'
import { ID } from './helpers.ts'
import { assertOutwardWinding, countByNormal, emptySnap, meshTables, put } from './meshHelpers.ts'

const tables = meshTables()
function mesh(s: ChunkSnapshot) {
  const o = new QuadBuilder(), c = new QuadBuilder()
  meshOpaqueAndCutout(s, tables, o, c, new Int32Array(1024))
  return { opaque: o.build(), cutout: c.build(), oq: o.quadCount, cq: c.quadCount }
}

describe('greedy opaque meshing', () => {
  it('emits 6 outward quads for a single block', () => {
    const s = emptySnap()
    put(s, 5, 5, 5, ID.stone)
    const m = mesh(s)
    expect(m.oq).toBe(6)
    expect(m.opaque!.vertices.length).toBe(6 * 4 * 2)
    expect(m.opaque!.indices.length).toBe(36)
    expect(m.cutout).toBeNull()
    assertOutwardWinding(m.opaque)
  })

  it('merges a 2x2x2 cube into 6 quads', () => {
    const s = emptySnap()
    for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) put(s, 10 + x, 10 + y, 10 + z, ID.stone)
    expect(mesh(s).oq).toBe(6)
  })

  it('does not merge a 3D checkerboard', () => {
    const s = emptySnap()
    let blocks = 0
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) {
      if ((x + y + z) % 2 === 0) { put(s, 4 + x, 4 + y, 4 + z, ID.stone); blocks++ }
    }
    expect(mesh(s).oq).toBe(blocks * 6)
  })

  it('stops merging at AO differences', () => {
    const s = emptySnap()
    for (let x = 0; x < 4; x++) put(s, x + 8, 0, 8, ID.stone)
    put(s, 8, 1, 8, ID.stone) // sits on block 0 and darkens block 1's top corners
    const m = mesh(s)
    expect(countByNormal(m.opaque, FACE.PY)).toBe(3) // occluder top, block 1 alone, blocks 2–3 merged
    assertOutwardWinding(m.opaque)
  })

  it('stops merging at light differences', () => {
    const s = emptySnap()
    for (let x = 0; x < 3; x++) put(s, x + 8, 0, 8, ID.stone)
    s.light[padIndex(9, 2, 9)] = packLight(5, 0) // the air above block x=8
    expect(countByNormal(mesh(s).opaque, FACE.PY)).toBe(2)
  })

  it('uses neighbour-chunk data across the border', () => {
    const s = emptySnap()
    put(s, 31, 0, 0, ID.stone)
    put(s, 32, 0, 0, ID.stone) // lives in the +X neighbour
    const m = mesh(s)
    expect(m.oq).toBe(5)
    expect(countByNormal(m.opaque, FACE.PX)).toBe(0)
  })

  it('writes the light of the cell in front of the face', () => {
    const s = emptySnap()
    put(s, 3, 3, 3, ID.stone)
    s.light[padIndex(4, 5, 4)] = packLight(9, 4) // above the block
    const m = mesh(s).opaque!
    for (let i = 0; i < m.vertices.length; i += 8) {
      if (unpackA(m.vertices[i]!).normal !== FACE.PY) continue
      const b = m.vertices[i + 1]!
      expect((b >>> 12) & 15).toBe(9)
      expect((b >>> 16) & 15).toBe(4)
    }
  })
})

describe('cutout faces', () => {
  it('emits per-face quads and culls between identical cutout blocks', () => {
    const s = emptySnap()
    put(s, 2, 2, 2, ID.torch)
    expect(mesh(s).cq).toBe(6)
    const t = emptySnap()
    put(t, 2, 2, 2, ID.leaves)
    put(t, 3, 2, 2, ID.leaves)
    const m = mesh(t)
    expect(m.cq).toBe(10)
    expect(m.oq).toBe(0)
    assertOutwardWinding(m.cutout)
  })
  it('lets opaque faces show behind cutout blocks', () => {
    const s = emptySnap()
    put(s, 2, 2, 2, ID.stone)
    put(s, 3, 2, 2, ID.leaves)
    const m = mesh(s)
    expect(m.oq).toBe(6)
    expect(m.cq).toBe(5)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run `npm test -- greedy`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/engine/src/mesh/greedy.ts`:
```ts
import { LAYER } from '../blocks/registry.ts'
import { padIndex, type ChunkSnapshot } from '../world/reader.ts'
import { voxelId } from '../world/voxel.ts'
import { flipDiagonal, vertexAO } from './ao.ts'
import type { QuadBuilder } from './quadBuilder.ts'
import type { MeshTables } from './tables.ts'
import { packA, packB } from './vertexFormat.ts'

/** Padded-index stride per world axis: x, y, z. */
export const STRIDE = [1, 34 * 34, 34] as const
/** [d, u, v] world axes per face. */
export const AXES: readonly (readonly [number, number, number])[] = [
  [0, 2, 1], [0, 2, 1], [1, 0, 2], [1, 0, 2], [2, 0, 1], [2, 0, 1],
]
export const REVERSE: readonly boolean[] = [true, false, true, false, false, true]
const SU = [-1, 1, 1, -1]
const SV = [-1, -1, 1, 1]

function isOpaque(s: ChunkSnapshot, t: MeshTables, pi: number): boolean {
  return t.opaque[voxelId(s.voxels[pi]!)] === 1
}

/** AO of the 4 corners of face f, for the face whose front cell is at padded index nIndex. */
export function faceAO(s: ChunkSnapshot, t: MeshTables, nIndex: number, f: number): number {
  const [, u, v] = AXES[f]!
  const su = STRIDE[u as 0 | 1 | 2], sv = STRIDE[v as 0 | 1 | 2]
  let packed = 0
  for (let c = 0; c < 4; c++) {
    const du = SU[c]! * su, dv = SV[c]! * sv
    const o = vertexAO(isOpaque(s, t, nIndex + du), isOpaque(s, t, nIndex + dv), isOpaque(s, t, nIndex + du + dv))
    packed |= o << (c * 2)
  }
  return packed
}

const qa = new Uint32Array(4)
const qb = new Uint32Array(4)
const pos = [0, 0, 0]

function emitQuad(
  out: QuadBuilder, f: number, s: number, u0: number, v0: number, w: number, h: number,
  tex: number, ao4: number, sky: number, blk: number,
): void {
  const [d, u, v] = AXES[f]!
  const plane = (f & 1) === 0 ? s + 1 : s
  const b = packB(tex, sky, blk, w, h)
  for (let c = 0; c < 4; c++) {
    pos[d] = plane
    pos[u] = c === 1 || c === 2 ? u0 + w : u0
    pos[v] = c >= 2 ? v0 + h : v0
    qa[c] = packA(pos[0]!, pos[1]!, pos[2]!, f, (ao4 >> (c * 2)) & 3, c)
    qb[c] = b
  }
  const flip = flipDiagonal(ao4 & 3, (ao4 >> 2) & 3, (ao4 >> 4) & 3, (ao4 >> 6) & 3)
  out.push(qa, qb, flip, REVERSE[f]!)
}

export function meshOpaqueAndCutout(s: ChunkSnapshot, t: MeshTables, opaque: QuadBuilder, cutout: QuadBuilder, mask: Int32Array): void {
  const q = [0, 0, 0]
  for (let f = 0; f < 6; f++) {
    const [d, u, v] = AXES[f]!
    const nOff = ((f & 1) === 0 ? 1 : -1) * STRIDE[d as 0 | 1 | 2]
    for (let sl = 0; sl < 32; sl++) {
      mask.fill(0)
      let any = false
      for (let vv = 0; vv < 32; vv++) for (let uu = 0; uu < 32; uu++) {
        q[d] = sl; q[u] = uu; q[v] = vv
        const pi = padIndex(q[0]! + 1, q[1]! + 1, q[2]! + 1)
        const id = voxelId(s.voxels[pi]!)
        const layer = t.layer[id]!
        if (layer !== LAYER.OPAQUE && layer !== LAYER.CUTOUT) continue
        const ni = pi + nOff
        const nid = voxelId(s.voxels[ni]!)
        if (t.opaque[nid]) continue
        if (layer === LAYER.CUTOUT && nid === id) continue
        const l = s.light[ni]!
        const ao4 = faceAO(s, t, ni, f)
        const tex = t.faceLayers[id * 6 + f]!
        if (layer === LAYER.CUTOUT) {
          emitQuad(cutout, f, sl, uu, vv, 1, 1, tex, ao4, l & 15, l >> 4)
          continue
        }
        mask[uu + vv * 32] = 1 + (tex | (ao4 << 12) | ((l & 15) << 20) | ((l >> 4) << 24))
        any = true
      }
      if (!any) continue
      for (let vv = 0; vv < 32; vv++) {
        for (let uu = 0; uu < 32;) {
          const k = mask[uu + vv * 32]!
          if (k === 0) { uu++; continue }
          let w = 1
          while (uu + w < 32 && mask[uu + w + vv * 32] === k) w++
          let h = 1
          grow: while (vv + h < 32) {
            for (let x = 0; x < w; x++) if (mask[uu + x + (vv + h) * 32] !== k) break grow
            h++
          }
          for (let y = 0; y < h; y++) mask.fill(0, uu + (vv + y) * 32, uu + w + (vv + y) * 32)
          const key = k - 1
          emitQuad(opaque, f, sl, uu, vv, w, h, key & 4095, (key >> 12) & 255, (key >> 20) & 15, (key >> 24) & 15)
          uu += w
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run `npm test -- greedy`. Expected: PASS (9 tests).
If `assertOutwardWinding` fails for one face direction, that face's `REVERSE` entry is wrong. Recompute `sign((U × V) · n)` for that face; don't patch individual indices.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/mesh/greedy.ts packages/engine/test/meshHelpers.ts packages/engine/test/greedy.test.ts
git commit -m "feat(engine): AO-aware greedy meshing for opaque blocks and cutout faces"
```

---

### Task 13: Translucent and liquid faces, `meshChunk`, and the mesher benchmark

**Files:**
- Create: `packages/engine/src/mesh/liquid.ts`, `packages/engine/src/mesh/mesher.ts`, `packages/engine/bench/mesher.bench.ts`
- Test: `packages/engine/test/liquid.test.ts`

**Interfaces:**
- Consumes: `AXES`, `REVERSE`, `STRIDE`, `meshOpaqueAndCutout` (Task 12); `QuadBuilder`, `LayerMesh`, `MeshTables`, `packA`, `packB` (Task 11); `ChunkSnapshot`, `padIndex` (Task 5); `voxelId`, `voxelState` (Task 2).
- Produces:
  - `liquidHeight(level: number): number` = `(level + 1) / 9`
  - `meshTranslucent(snap, tables, out: QuadBuilder): void`
  - `interface ChunkMeshData { opaque: LayerMesh | null; cutout: LayerMesh | null; translucent: LayerMesh | null }`
  - `class Mesher` with `mesh(snap, tables): ChunkMeshData`, which reuses its builders and mask between calls

**Liquid rules:**
- A liquid's level is `state & 7`. The cell height is 1 when the voxel above is the same liquid, else `liquidHeight(level)`.
- Each top corner's height is the average over the up-to-4 same-liquid cells sharing that corner. If any of those cells has the same liquid above it, the corner height is 1.
- Adjacent same-liquid cells share their corner heights, so no gap opens between them. The spec's "side faces fill the gap" therefore needs no extra faces between same-liquid cells.
- Side faces are emitted only toward cells that are neither opaque nor the same liquid. They run from the cell's floor up to its corner heights.
- A top face is emitted when the cell above is neither the same liquid nor opaque. A bottom face is emitted under the same rule for the cell below.
- Non-liquid translucent blocks (glass) emit per face where the neighbour is neither opaque nor the same id.
- The AO of translucent faces is 0.
- A vertex at height `hgt` within the cell is written as `y + 1` with `drop = round((1 − hgt) * 16)`.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/liquid.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { liquidHeight, meshTranslucent } from '../src/mesh/liquid.ts'
import { Mesher } from '../src/mesh/mesher.ts'
import { QuadBuilder } from '../src/mesh/quadBuilder.ts'
import { FACE, unpackA } from '../src/mesh/vertexFormat.ts'
import type { ChunkSnapshot } from '../src/world/reader.ts'
import { packVoxel } from '../src/world/voxel.ts'
import { ID } from './helpers.ts'
import { assertOutwardWinding, countByNormal, emptySnap, meshTables, put } from './meshHelpers.ts'

const tables = meshTables()
const water = (level: number) => packVoxel(ID.water, level)
function mesh(s: ChunkSnapshot) {
  const q = new QuadBuilder()
  meshTranslucent(s, tables, q)
  return { m: q.build(), n: q.quadCount }
}
function topDrops(s: ChunkSnapshot): number[] {
  const { m } = mesh(s)
  const out: number[] = []
  for (let i = 0; i < m!.vertices.length; i += 2) {
    const a = unpackA(m!.vertices[i]!)
    if (a.normal === FACE.PY) out.push(a.drop)
  }
  return out
}

describe('liquid meshing', () => {
  it('maps levels to heights', () => {
    expect(liquidHeight(7)).toBeCloseTo(8 / 9)
    expect(liquidHeight(0)).toBeCloseTo(1 / 9)
  })
  it('meshes a lone full cell as 6 faces with a lowered top', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, water(7))
    const { m, n } = mesh(s)
    expect(n).toBe(6)
    expect(topDrops(s)).toEqual([2, 2, 2, 2]) // round((1 - 8/9) * 16) = 2
    assertOutwardWinding(m)
  })
  it('hides faces between stacked water and fills the lower cell to the top', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, water(7))
    put(s, 4, 5, 4, water(7))
    const { m, n } = mesh(s)
    expect(n).toBe(10)
    expect(countByNormal(m, FACE.PY)).toBe(1)
    for (let i = 0; i < m!.vertices.length; i += 2) {
      const a = unpackA(m!.vertices[i]!)
      if (a.normal === FACE.PX && a.y === 5) expect(a.drop).toBe(0) // the lower cell's side top edge is full height
    }
  })
  it('averages shared corners between neighbouring cells', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, water(7))
    put(s, 5, 4, 4, water(3))
    const { n } = mesh(s)
    expect(n).toBe(10) // no faces between the two cells
    expect(topDrops(s)).toContain(5) // shared corner: (8/9 + 4/9) / 2 → drop round(16/3) = 5
  })
  it('culls water faces against opaque blocks', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, water(7))
    put(s, 5, 4, 4, ID.stone)
    expect(mesh(s).n).toBe(5)
  })
  it('meshes glass per face and culls between glass blocks', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, ID.glass)
    put(s, 5, 4, 4, ID.glass)
    const { m, n } = mesh(s)
    expect(n).toBe(10)
    assertOutwardWinding(m)
  })
})

describe('Mesher', () => {
  it('fills all three layers and reuses its buffers', () => {
    const s = emptySnap()
    put(s, 1, 1, 1, ID.stone)
    put(s, 3, 1, 1, ID.torch)
    put(s, 5, 1, 1, water(7))
    const mesher = new Mesher()
    const a = mesher.mesh(s, tables)
    expect(a.opaque).not.toBeNull()
    expect(a.cutout).not.toBeNull()
    expect(a.translucent).not.toBeNull()
    const b = mesher.mesh(emptySnap(), tables)
    expect(b).toEqual({ opaque: null, cutout: null, translucent: null })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run `npm test -- liquid`. Expected: FAIL (modules not found).

- [ ] **Step 3: Implement liquid and translucent faces**

`packages/engine/src/mesh/liquid.ts`:
```ts
import { LAYER } from '../blocks/registry.ts'
import { padIndex, type ChunkSnapshot } from '../world/reader.ts'
import { voxelId, voxelState } from '../world/voxel.ts'
import { AXES, REVERSE, STRIDE } from './greedy.ts'
import type { QuadBuilder } from './quadBuilder.ts'
import type { MeshTables } from './tables.ts'
import { packA, packB } from './vertexFormat.ts'

export function liquidHeight(level: number): number { return (level + 1) / 9 }

const UP = STRIDE[1]
const qa = new Uint32Array(4)
const qb = new Uint32Array(4)
const corners = [0, 0, 0, 0] // top-corner heights in order (−x,−z) (+x,−z) (+x,+z) (−x,+z)
const SX = [-1, 1, 1, -1]
const SZ = [-1, -1, 1, 1]

function cellHeight(s: ChunkSnapshot, pi: number, id: number): number {
  if (voxelId(s.voxels[pi + UP]!) === id) return 1
  return liquidHeight(voxelState(s.voxels[pi]!) & 7)
}

function cornerHeights(s: ChunkSnapshot, pi: number, id: number): void {
  for (let c = 0; c < 4; c++) {
    const cells = [pi, pi + SX[c]!, pi + SZ[c]! * STRIDE[2], pi + SX[c]! + SZ[c]! * STRIDE[2]]
    let sum = 0, n = 0, full = false
    for (const ci of cells) {
      if (voxelId(s.voxels[ci]!) !== id) continue
      const hgt = cellHeight(s, ci, id)
      if (hgt === 1) { full = true; break }
      sum += hgt
      n++
    }
    corners[c] = full ? 1 : sum / n
  }
}

function cornerIndex(sx: number, sz: number): number {
  return sz < 0 ? (sx < 0 ? 0 : 1) : (sx > 0 ? 2 : 3)
}

export function meshTranslucent(s: ChunkSnapshot, t: MeshTables, out: QuadBuilder): void {
  const p = [0, 0, 0]
  for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
    const pi = padIndex(x + 1, y + 1, z + 1)
    const id = voxelId(s.voxels[pi]!)
    if (t.layer[id] !== LAYER.TRANSLUCENT) continue
    const liquid = t.liquid[id] === 1
    if (liquid) cornerHeights(s, pi, id)
    for (let f = 0; f < 6; f++) {
      const [d, u, v] = AXES[f]!
      const ni = pi + ((f & 1) === 0 ? 1 : -1) * STRIDE[d as 0 | 1 | 2]
      const nid = voxelId(s.voxels[ni]!)
      if (t.opaque[nid] || nid === id) continue
      const l = s.light[ni]!
      const b = packB(t.faceLayers[id * 6 + f]!, l & 15, l >> 4, 1, 1)
      const plane = (f & 1) === 0 ? 1 : 0
      for (let c = 0; c < 4; c++) {
        const cu = c === 1 || c === 2 ? 1 : 0
        const cv = c >= 2 ? 1 : 0
        p[d] = plane; p[u] = cu; p[v] = cv
        const vx = x + p[0]!, vz = z + p[2]!
        let vy = y + p[1]!
        let drop = 0
        if (liquid && p[1] === 1) {
          const hgt = corners[cornerIndex(p[0] ? 1 : -1, p[2] ? 1 : -1)]!
          drop = Math.round((1 - hgt) * 16)
          vy = y + 1
        }
        qa[c] = packA(vx, vy, vz, f, 0, c, drop)
        qb[c] = b
      }
      out.push(qa, qb, false, REVERSE[f]!)
    }
  }
}
```

- [ ] **Step 4: Implement Mesher**

`packages/engine/src/mesh/mesher.ts`:
```ts
import type { ChunkSnapshot } from '../world/reader.ts'
import { meshOpaqueAndCutout } from './greedy.ts'
import { meshTranslucent } from './liquid.ts'
import { QuadBuilder, type LayerMesh } from './quadBuilder.ts'
import type { MeshTables } from './tables.ts'

export interface ChunkMeshData {
  opaque: LayerMesh | null
  cutout: LayerMesh | null
  translucent: LayerMesh | null
}

export class Mesher {
  private readonly opaque = new QuadBuilder(2048)
  private readonly cutout = new QuadBuilder(256)
  private readonly translucent = new QuadBuilder(512)
  private readonly mask = new Int32Array(1024)

  mesh(snap: ChunkSnapshot, tables: MeshTables): ChunkMeshData {
    this.opaque.reset()
    this.cutout.reset()
    this.translucent.reset()
    meshOpaqueAndCutout(snap, tables, this.opaque, this.cutout, this.mask)
    meshTranslucent(snap, tables, this.translucent)
    return { opaque: this.opaque.build(), cutout: this.cutout.build(), translucent: this.translucent.build() }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run `npm test -- liquid greedy`. Expected: PASS.

- [ ] **Step 6: Write and run the mesher benchmark**

`packages/engine/bench/mesher.bench.ts`:
```ts
import { bench, describe } from 'vitest'
import { Mesher } from '../src/mesh/mesher.ts'
import { valueNoise2 } from '../src/sim/generator.ts'
import { padIndex } from '../src/world/reader.ts'
import { packLight } from '../src/world/voxel.ts'
import { ID } from '../test/helpers.ts'
import { emptySnap, meshTables } from '../test/meshHelpers.ts'

/** A rolling grass surface crossing the chunk, typical of the diorama terrain. */
function surfaceSnap() {
  const s = emptySnap()
  for (let pz = 0; pz < 34; pz++) for (let px = 0; px < 34; px++) {
    const h = 8 + Math.floor(valueNoise2(3, px / 9, pz / 9) * 16)
    for (let py = 0; py < 34; py++) {
      const i = padIndex(px, py, pz)
      if (py < h - 3) s.voxels[i] = ID.stone
      else if (py < h - 1) s.voxels[i] = ID.dirt
      else if (py === h - 1) s.voxels[i] = ID.grass
      if (py < h) s.light[i] = 0
      else s.light[i] = packLight(15, 0)
    }
  }
  return s
}

describe('mesher', () => {
  const tables = meshTables()
  const mesher = new Mesher()
  const snap = surfaceSnap()
  bench('typical surface chunk', () => { mesher.mesh(snap, tables) }, { time: 2000 })
})
```

Run `npm run bench`.
Expected: a mean under **3 ms** for "typical surface chunk".
If it's over: profile with `node --cpu-prof`. The likely hotspot is `faceAO`, which runs 12 `isOpaque` lookups per face. Cache per-slice opacity in a `Uint8Array(34*34*34)` built once per mesh call. Record the number you measured in the commit message.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/mesh packages/engine/test/liquid.test.ts packages/engine/bench/mesher.bench.ts
git commit -m "feat(engine): liquid/translucent meshing, Mesher and benchmark" -m "mesher bench: <the mean you measured in Step 6> ms per surface chunk"
```

---

### Task 14: Worker protocol, mesh jobs, and the sim and mesh worker hosts

**Files:**
- Create:
  - `packages/engine/src/protocol.ts`
  - `packages/engine/src/mesh/meshJob.ts`, `packages/engine/src/mesh/mesh.worker.ts`
  - `packages/engine/src/sim/simHost.ts`, `packages/engine/src/sim/runSimWorker.ts`
- Test: `packages/engine/test/meshJob.test.ts`, `packages/engine/test/simHost.test.ts`

**Interfaces:**
- Consumes:
  - `WorldReader`, `createSnapshot`, `padIndex` (Task 5); `Mesher`, `ChunkMeshData` (Task 13); `MeshTables` (Task 11)
  - `Simulation`, `SimEvent` (Tasks 9–10); `GeneratorModule` (Task 10); `RulesModule` (Task 9)
  - `Ack`, `Command` (Task 8); `WorldFullError` (Task 4)
- Produces (`protocol.ts`): the message unions `ToSim`, `FromSim`, `ToMesh`, `FromMesh`; `type Override = readonly [number, number, number, number]`; `interface SimInitOptions`.
- Produces (`mesh/meshJob.ts`): `class MeshJobRunner` with `constructor(buffers, tables)`, `addPage(index, page)`, and `run(job: { id; chunk; overrides? }): FromMesh`.
- Produces (`sim/simHost.ts`):
  - `interface SimModules { rules?: RulesModule; generator: GeneratorModule }`
  - `interface Clock { now(); setTimeout(fn, ms); clearTimeout(handle) }`
  - `class SimHost` with `constructor(post: (m: FromSim) => void, modules, clock?)`, `handle(msg: ToSim)`, and `pump()` (one fixed-step wake-up, exposed for tests)
- Produces (`sim/runSimWorker.ts`): `runSimWorker(modules: SimModules): void`, the worker shell games call (Deviation 1). It is exported as `@elovox/engine/sim-worker`.

- [ ] **Step 1: Write the protocol**

`packages/engine/src/protocol.ts`:
```ts
import type { BlockDef } from './blocks/registry.ts'
import type { ChunkMeshData } from './mesh/mesher.ts'
import type { MeshTables } from './mesh/tables.ts'
import type { Ack, Command } from './sim/commands.ts'
import type { SimEvent } from './sim/simulation.ts'
import type { WorldBuffers } from './world/buffers.ts'

export interface SimInitOptions {
  workCap?: number
  randomTicksPerChunk?: number
  maxPages?: number
  tickHz?: number
}

export type ToSim =
  | { type: 'init'; buffers: WorldBuffers; blocks: BlockDef[]; seed: number; options: SimInitOptions }
  | { type: 'submit'; clientId: number; seq: number; cmd: Command }
  | { type: 'start' }
  | { type: 'stop' }

export type FromSim =
  | { type: 'page'; index: number; page: SharedArrayBuffer }
  | { type: 'ready'; chunks: number[]; slotsUsed: number }
  | { type: 'tick'; tick: number; dirtyChunks: number[]; events: SimEvent[]; acks: Ack[]; slotsUsed: number; tickMs: number }
  | { type: 'log'; message: string }
  | { type: 'fatal'; message: string }

/** World-space ghost voxel: [x, y, z, voxel]. */
export type Override = readonly [number, number, number, number]

export type ToMesh =
  | { type: 'init'; buffers: WorldBuffers; pages: SharedArrayBuffer[]; tables: MeshTables }
  | { type: 'page'; index: number; page: SharedArrayBuffer }
  | { type: 'job'; id: number; chunk: number; overrides?: Override[] }

export type FromMesh =
  | { type: 'result'; id: number; chunk: number; version: number; data: ChunkMeshData }
  | { type: 'retry'; id: number; chunk: number }
  | { type: 'error'; id: number; chunk: number; message: string }
```

- [ ] **Step 2: Write the failing tests**

`packages/engine/test/meshJob.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MeshJobRunner } from '../src/mesh/meshJob.ts'
import { FACE, unpackA, unpackB } from '../src/mesh/vertexFormat.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ChunkStore } from '../src/world/chunkStore.ts'
import { ID, testRegistry } from './helpers.ts'
import { meshTables } from './meshHelpers.ts'

function setup(sharePages = true) {
  const reg = testRegistry()
  const buffers = createWorldBuffers([64, 64, 64])
  const runner = new MeshJobRunner(buffers, meshTables())
  const store = new ChunkStore({ buffers, opaque: reg.opaque, onNewPage: (i, p) => { if (sharePages) runner.addPage(i, p) } })
  return { store, runner }
}

describe('MeshJobRunner', () => {
  it('returns an empty result for trivial chunks without snapshotting', () => {
    const { runner } = setup()
    const r = runner.run({ id: 1, chunk: 0 })
    expect(r).toEqual({ type: 'result', id: 1, chunk: 0, version: 0, data: { opaque: null, cutout: null, translucent: null } })
  })
  it('meshes a chunk and reports its version', () => {
    const { store, runner } = setup()
    store.setVoxel(3, 3, 3, ID.stone)
    store.commit()
    const r = runner.run({ id: 2, chunk: 0 })
    expect(r.type).toBe('result')
    if (r.type !== 'result') return
    expect(r.version).toBe(2)
    expect(r.data.opaque!.indices.length).toBe(36)
  })
  it('asks for a retry while the chunk is being written or its page is missing', () => {
    const a = setup()
    a.store.setVoxel(3, 3, 3, ID.stone) // seqlock still odd
    expect(a.runner.run({ id: 3, chunk: 0 }).type).toBe('retry')
    const b = setup(false)
    b.store.setVoxel(3, 3, 3, ID.stone)
    b.store.commit()
    expect(b.runner.run({ id: 4, chunk: 0 }).type).toBe('retry')
  })
  it('applies ghost overrides, including in otherwise trivial chunks', () => {
    const { runner } = setup()
    const r = runner.run({ id: 5, chunk: 0, overrides: [[4, 4, 4, ID.stone]] })
    expect(r.type === 'result' && r.data.opaque!.indices.length).toBe(36)
  })
  it('lights a ghost-removed block from its neighbours so the hole is not black', () => {
    const { store, runner } = setup()
    store.setVoxel(3, 10, 3, ID.stone)
    store.setVoxel(4, 10, 3, ID.stone)
    store.setLight(3, 10, 3, 0) // the block about to be dug is dark, as the sim would have it
    store.commit()
    const r = runner.run({ id: 6, chunk: 0, overrides: [[3, 10, 3, 0]] })
    if (r.type !== 'result') throw new Error('expected a result')
    const m = r.data.opaque!
    let checked = 0
    for (let i = 0; i < m.vertices.length; i += 8) {
      if (unpackA(m.vertices[i]!).normal !== FACE.NX) continue // block (4,10,3) facing into the hole
      expect(unpackB(m.vertices[i + 1]!).sky).toBe(15)       // lit from the open sky above the hole
      checked++
    }
    expect(checked).toBe(1)
  })
})
```

`packages/engine/test/simHost.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { defineGenerator } from '../src/sim/generator.ts'
import { defineRules } from '../src/sim/rules.ts'
import { SimHost, type Clock } from '../src/sim/simHost.ts'
import type { FromSim } from '../src/protocol.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

const empty = defineGenerator({ generateColumn() {} })
function setup(options = {}, rules = defineRules({})) {
  const out: FromSim[] = []
  const clock = { t: 0, now() { return this.t }, setTimeout() { return 0 }, clearTimeout() {} } satisfies Clock & { t: number }
  const host = new SimHost((m) => out.push(m), { rules, generator: empty }, clock)
  host.handle({ type: 'init', buffers: createWorldBuffers([64, 64, 64]), blocks: TEST_BLOCKS, seed: 1, options })
  return { out, clock, host, ticks: () => out.filter((m) => m.type === 'tick') }
}

describe('SimHost', () => {
  it('generates and reports ready with every chunk', () => {
    const { out } = setup()
    const ready = out.find((m) => m.type === 'ready')
    expect(ready && ready.type === 'ready' && ready.chunks).toHaveLength(8)
  })
  it('ticks at a fixed 20 Hz step', () => {
    const { host, clock, ticks } = setup()
    host.handle({ type: 'start' })
    clock.t = 49; host.pump()
    expect(ticks()).toHaveLength(0)
    clock.t = 50; host.pump()
    expect(ticks()).toHaveLength(1)
    clock.t = 170; host.pump()
    expect(ticks()).toHaveLength(3)
  })
  it('runs at most 4 catch-up ticks and logs the dropped backlog', () => {
    const { host, clock, ticks, out } = setup()
    host.handle({ type: 'start' })
    clock.t = 1000; host.pump()
    expect(ticks()).toHaveLength(4)
    expect(out.some((m) => m.type === 'log' && /dropped 16 ticks/.test(m.message))).toBe(true)
  })
  it('acks submitted commands on the next tick', () => {
    const { host, clock, ticks } = setup()
    host.handle({ type: 'start' })
    host.handle({ type: 'submit', clientId: 0, seq: 7, cmd: { type: 'setBlock', pos: [1, 1, 1], voxel: ID.stone } })
    clock.t = 50; host.pump()
    const t = ticks()[0]!
    expect(t.type === 'tick' && t.acks).toEqual([{ clientId: 0, seq: 7, ok: true }])
  })
  it('turns WorldFullError into fatal and stops ticking', () => {
    // 512 chunks, but only one 256-slot page allowed
    const out: FromSim[] = []
    const clock = { t: 0, now() { return this.t }, setTimeout() { return 0 }, clearTimeout() {} }
    const host = new SimHost((m) => out.push(m), { generator: empty }, clock)
    host.handle({ type: 'init', buffers: createWorldBuffers([512, 64, 512]), blocks: TEST_BLOCKS, seed: 1, options: { maxPages: 1 } })
    host.handle({ type: 'start' })
    let seq = 0
    for (let cz = 0; cz < 16; cz++) for (let cx = 0; cx < 16; cx++) for (let cy = 0; cy < 2; cy++) {
      host.handle({ type: 'submit', clientId: 0, seq: seq++, cmd: { type: 'setBlock', pos: [cx * 32, cy * 32, cz * 32], voxel: ID.stone } })
    }
    clock.t = 50; host.pump()
    const fatal = out.find((m) => m.type === 'fatal')
    expect(fatal && fatal.type === 'fatal' && fatal.message).toMatch(/world full/)
    clock.t = 500; host.pump()
    expect(out.filter((m) => m.type === 'tick')).toHaveLength(0)
  })
  it('reports init failures as fatal', () => {
    const out: FromSim[] = []
    const host = new SimHost((m) => out.push(m), { rules: defineRules({ blocks: { nope: {} } }), generator: empty })
    host.handle({ type: 'init', buffers: createWorldBuffers([32, 32, 32]), blocks: TEST_BLOCKS, seed: 1, options: {} })
    expect(out.at(-1)).toMatchObject({ type: 'fatal' })
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run `npm test -- meshJob simHost`. Expected: FAIL (modules not found).

- [ ] **Step 4: Implement MeshJobRunner and the mesh worker shell**

`packages/engine/src/mesh/meshJob.ts`:
```ts
import type { FromMesh, Override } from '../protocol.ts'
import type { WorldBuffers } from '../world/buffers.ts'
import { PAD, WorldReader, createSnapshot, padIndex, type ChunkSnapshot } from '../world/reader.ts'
import { voxelId } from '../world/voxel.ts'
import { Mesher, type ChunkMeshData } from './mesher.ts'
import type { MeshTables } from './tables.ts'

const EMPTY: ChunkMeshData = { opaque: null, cutout: null, translucent: null }
const OFFS = [1, -1, PAD * PAD, -PAD * PAD, PAD, -PAD] // +x -x +y -y +z -z in padded index space
const UP = 2

export class MeshJobRunner {
  private readonly reader: WorldReader
  private readonly tables: MeshTables
  private readonly snap: ChunkSnapshot = createSnapshot()
  private readonly mesher = new Mesher()

  constructor(buffers: WorldBuffers, tables: MeshTables) {
    this.reader = new WorldReader(buffers, tables.opaque)
    this.tables = tables
  }

  addPage(index: number, page: SharedArrayBuffer): void { this.reader.addPage(index, page) }

  run(job: { id: number; chunk: number; overrides?: readonly Override[] }): FromMesh {
    const { id, chunk } = job
    const hasOverrides = job.overrides !== undefined && job.overrides.length > 0
    if (!hasOverrides && this.reader.isTrivial(chunk)) {
      return { type: 'result', id, chunk, version: Atomics.load(this.reader.versions, chunk), data: EMPTY }
    }
    const version = this.reader.snapshot(chunk, this.snap)
    if (version === null) return { type: 'retry', id, chunk }
    if (hasOverrides) this.applyOverrides(chunk, job.overrides!)
    return { type: 'result', id, chunk, version, data: this.mesher.mesh(this.snap, this.tables) }
  }

  private applyOverrides(chunk: number, overrides: readonly Override[]): void {
    const [cx, cy, cz] = this.reader.layout.chunkCoords(chunk)
    const s = this.snap
    for (const [x, y, z, v] of overrides) {
      const px = x - cx * 32 + 1, py = y - cy * 32 + 1, pz = z - cz * 32 + 1
      if (px < 0 || py < 0 || pz < 0 || px >= PAD || py >= PAD || pz >= PAD) continue
      const pi = padIndex(px, py, pz)
      s.voxels[pi] = v
      if (this.tables.opaque[voxelId(v)]) { s.light[pi] = 0; continue }
      // Approximate the light the sim will compute, so a freshly dug hole is not black for a tick.
      let sky = 0, blk = 0
      for (let d = 0; d < 6; d++) {
        const ni = pi + OFFS[d]!
        if (ni < 0 || ni >= s.light.length) continue
        const l = s.light[ni]!
        const ns = l & 15
        sky = Math.max(sky, d === UP && ns === 15 ? 15 : ns - 1)
        blk = Math.max(blk, (l >> 4) - 1)
      }
      s.light[pi] = Math.max(0, sky) | (Math.max(0, blk) << 4)
    }
  }
}
```

`packages/engine/src/mesh/mesh.worker.ts`:
```ts
import type { FromMesh, ToMesh } from '../protocol.ts'
import { MeshJobRunner } from './meshJob.ts'
import type { ChunkMeshData } from './mesher.ts'

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<ToMesh>) => void) | null
}
const scope = globalThis as unknown as WorkerScope
let runner: MeshJobRunner | null = null

function transferables(d: ChunkMeshData): Transferable[] {
  const out: Transferable[] = []
  for (const m of [d.opaque, d.cutout, d.translucent]) if (m) out.push(m.vertices.buffer, m.indices.buffer)
  return out
}

scope.onmessage = (e) => {
  const m = e.data
  if (m.type === 'init') {
    runner = new MeshJobRunner(m.buffers, m.tables)
    m.pages.forEach((p, i) => runner!.addPage(i, p))
    return
  }
  if (m.type === 'page') { runner?.addPage(m.index, m.page); return }
  let out: FromMesh
  try {
    out = runner!.run(m)
  } catch (err) {
    out = { type: 'error', id: m.id, chunk: m.chunk, message: err instanceof Error ? (err.stack ?? err.message) : String(err) }
  }
  scope.postMessage(out, out.type === 'result' ? transferables(out.data) : [])
}
```

- [ ] **Step 5: Implement SimHost and runSimWorker**

`packages/engine/src/sim/simHost.ts`:
```ts
import type { FromSim, ToSim } from '../protocol.ts'
import type { GeneratorModule } from './generator.ts'
import type { RulesModule } from './rules.ts'
import { Simulation } from './simulation.ts'

export interface SimModules { rules?: RulesModule; generator: GeneratorModule }
export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

const MAX_CATCH_UP = 4

/** Owns the Simulation inside the sim worker. Wall-clock time only paces ticks; it never enters world state. */
export class SimHost {
  private readonly post: (m: FromSim) => void
  private readonly modules: SimModules
  private readonly clock: Clock
  private sim: Simulation | null = null
  private stepMs = 50
  private running = false
  private acc = 0
  private last = 0
  private timer: unknown = null

  constructor(post: (m: FromSim) => void, modules: SimModules, clock: Clock = realClock) {
    this.post = post
    this.modules = modules
    this.clock = clock
  }

  handle(msg: ToSim): void {
    switch (msg.type) {
      case 'init':
        try {
          this.stepMs = 1000 / (msg.options.tickHz ?? 20)
          this.sim = new Simulation({
            buffers: msg.buffers, blocks: msg.blocks, rules: this.modules.rules, seed: msg.seed,
            workCap: msg.options.workCap, randomTicksPerChunk: msg.options.randomTicksPerChunk, maxPages: msg.options.maxPages,
            onNewPage: (index, page) => this.post({ type: 'page', index, page }),
            log: (message) => this.post({ type: 'log', message }),
          })
          const chunks = this.sim.generate(this.modules.generator)
          this.post({ type: 'ready', chunks, slotsUsed: this.sim.store.slotsUsed() })
        } catch (e) {
          this.fail(e)
        }
        return
      case 'submit':
        this.sim?.submit(msg.clientId, msg.seq, msg.cmd)
        return
      case 'start':
        if (this.running || !this.sim) return
        this.running = true
        this.acc = 0
        this.last = this.clock.now()
        this.timer = this.clock.setTimeout(() => this.pump(), this.stepMs)
        return
      case 'stop':
        this.running = false
        this.clock.clearTimeout(this.timer)
        return
    }
  }

  pump(): void {
    if (!this.running || !this.sim) return
    const now = this.clock.now()
    this.acc += now - this.last
    this.last = now
    let n = 0
    while (this.acc >= this.stepMs && n < MAX_CATCH_UP && this.running) {
      this.runTick()
      this.acc -= this.stepMs
      n++
    }
    if (this.acc >= this.stepMs) {
      const dropped = Math.floor(this.acc / this.stepMs)
      this.acc -= dropped * this.stepMs
      this.post({ type: 'log', message: `sim behind: dropped ${dropped} ticks` })
    }
    if (this.running) this.timer = this.clock.setTimeout(() => this.pump(), Math.max(0, this.stepMs - this.acc))
  }

  private runTick(): void {
    const sim = this.sim!
    const t0 = this.clock.now()
    try {
      const r = sim.step()
      this.post({ type: 'tick', ...r, slotsUsed: sim.store.slotsUsed(), tickMs: this.clock.now() - t0 })
    } catch (e) {
      this.fail(e)
    }
  }

  private fail(e: unknown): void {
    this.running = false
    this.clock.clearTimeout(this.timer)
    this.post({ type: 'fatal', message: e instanceof Error ? `${e.name}: ${e.message}` : String(e) })
  }
}
```

`packages/engine/src/sim/runSimWorker.ts`:
```ts
import type { ToSim } from '../protocol.ts'
import { SimHost, type SimModules } from './simHost.ts'

interface WorkerScope {
  postMessage(message: unknown): void
  onmessage: ((e: MessageEvent<ToSim>) => void) | null
}

/** Call this from your game's `sim.worker.ts`. */
export function runSimWorker(modules: SimModules): void {
  const scope = globalThis as unknown as WorkerScope
  const host = new SimHost((m) => scope.postMessage(m), modules)
  scope.onmessage = (e) => host.handle(e.data)
}

export type { SimModules } from './simHost.ts'
export { defineRules } from './rules.ts'
export { defineGenerator } from './generator.ts'
export { testGenerator } from './testGenerator.ts'
```

- [ ] **Step 6: Run the tests to verify they pass**

Run `npm test -- meshJob simHost`. Expected: PASS.
The `WorldFullError` message starts with `world full:` (Task 4), and `SimHost.fail` prefixes the error name. That gives `WorldFullError: world full: 1 pages …`, which matches `/world full/`.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/protocol.ts packages/engine/src/mesh/meshJob.ts packages/engine/src/mesh/mesh.worker.ts packages/engine/src/sim/simHost.ts packages/engine/src/sim/runSimWorker.ts packages/engine/test/meshJob.test.ts packages/engine/test/simHost.test.ts
git commit -m "feat(engine): worker protocol, mesh job runner and fixed-step sim host"
```

---

### Task 15: DDA voxel raycast

**Files:**
- Create: `packages/engine/src/interact/raycast.ts`
- Test: `packages/engine/test/raycast.test.ts`

**Interfaces:**
- Consumes: `WorldSize` (Task 2).
- Produces:
  - `type Vec3Like = { x: number; y: number; z: number } | readonly [number, number, number]`
  - `interface RayHit { pos: [number, number, number]; normal: [number, number, number]; voxel: number; distance: number }`
  - `raycast(get: (x, y, z) => number, pickable: (voxel) => boolean, size: WorldSize, origin: Vec3Like, dir: Vec3Like, maxDist: number): RayHit | null`

**Behaviour:**
- The direction is normalised; a zero direction returns `null`.
- A ray starting outside the world is clipped to the world box and begins at its entry point.
- A ray starting inside a pickable voxel hits at distance 0 with normal `[0, 0, 0]`.
- Otherwise the normal is the face the ray entered through.
- Hits beyond `maxDist` and rays that miss the box return `null`.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/raycast.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { raycast } from '../src/interact/raycast.ts'

const SIZE = [64, 64, 64] as const
function world(blocks: [number, number, number, number][]) {
  const m = new Map(blocks.map(([x, y, z, v]) => [`${x},${y},${z}`, v]))
  return (x: number, y: number, z: number) => m.get(`${x},${y},${z}`) ?? 0
}
const solid = (v: number) => v !== 0 && v !== 5 // 5 = water, not pickable

describe('raycast', () => {
  it('hits along an axis and reports the entry face', () => {
    const hit = raycast(world([[5, 10, 0, 1]]), solid, SIZE, [0.5, 10.5, 0.5], [1, 0, 0], 64)
    expect(hit).toEqual({ pos: [5, 10, 0], normal: [-1, 0, 0], voxel: 1, distance: 4.5 })
  })
  it('hits diagonally', () => {
    const hit = raycast(world([[3, 3, 3, 1]]), solid, SIZE, [0.5, 0.5, 0.5], [1, 1, 1], 64)!
    expect(hit.pos).toEqual([3, 3, 3])
    expect(hit.distance).toBeCloseTo(2.5 * Math.sqrt(3), 5)
    expect(Math.abs(hit.normal[0]) + Math.abs(hit.normal[1]) + Math.abs(hit.normal[2])).toBe(1)
  })
  it('crosses chunk borders', () => {
    const hit = raycast(world([[32, 10, 0, 1]]), solid, SIZE, [30.5, 10.5, 0.5], [1, 0, 0], 64)
    expect(hit?.pos).toEqual([32, 10, 0])
  })
  it('hits at distance 0 when starting inside a block', () => {
    const hit = raycast(world([[2, 2, 2, 1]]), solid, SIZE, [2.5, 2.5, 2.5], [0, 1, 0], 64)
    expect(hit).toEqual({ pos: [2, 2, 2], normal: [0, 0, 0], voxel: 1, distance: 0 })
  })
  it('enters the world from outside', () => {
    const side = raycast(world([[0, 10, 0, 1]]), solid, SIZE, [-5, 10.5, 0.5], [1, 0, 0], 64)
    expect(side).toEqual({ pos: [0, 10, 0], normal: [-1, 0, 0], voxel: 1, distance: 5 })
    const top = world([[10, 3, 10, 1]])
    expect(raycast(top, solid, SIZE, [10.5, 100, 10.5], [0, -1, 0], 64)).toBeNull()
    expect(raycast(top, solid, SIZE, [10.5, 100, 10.5], [0, -1, 0], 200)).toEqual({ pos: [10, 3, 10], normal: [0, 1, 0], voxel: 1, distance: 96 })
  })
  it('returns null for misses, max distance and zero directions', () => {
    const w = world([[20, 10, 0, 1]])
    expect(raycast(w, solid, SIZE, [-5, 100, -5], [1, 0, 0], 500)).toBeNull()
    expect(raycast(w, solid, SIZE, [0.5, 10.5, 0.5], [1, 0, 0], 10)).toBeNull()
    expect(raycast(w, solid, SIZE, [0.5, 10.5, 0.5], [0, 0, 0], 10)).toBeNull()
  })
  it('skips voxels that are not pickable', () => {
    const hit = raycast(world([[3, 1, 0, 5], [6, 1, 0, 1]]), solid, SIZE, [0.5, 1.5, 0.5], [1, 0, 0], 64)
    expect(hit?.pos).toEqual([6, 1, 0])
  })
  it('accepts object vectors', () => {
    const hit = raycast(world([[5, 10, 0, 1]]), solid, SIZE, { x: 0.5, y: 10.5, z: 0.5 }, { x: 2, y: 0, z: 0 }, 64)
    expect(hit?.distance).toBe(4.5)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run `npm test -- raycast`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/engine/src/interact/raycast.ts`:
```ts
import type { WorldSize } from '../world/layout.ts'

export type Vec3Like = { x: number; y: number; z: number } | readonly [number, number, number]
export interface RayHit { pos: [number, number, number]; normal: [number, number, number]; voxel: number; distance: number }

function arr(v: Vec3Like): [number, number, number] {
  return 'x' in v ? [v.x, v.y, v.z] : [v[0], v[1], v[2]]
}

export function raycast(
  get: (x: number, y: number, z: number) => number,
  pickable: (voxel: number) => boolean,
  size: WorldSize,
  origin: Vec3Like,
  direction: Vec3Like,
  maxDist: number,
): RayHit | null {
  const o = arr(origin)
  const d = arr(direction)
  const len = Math.hypot(d[0], d[1], d[2])
  if (len === 0) return null
  d[0] /= len; d[1] /= len; d[2] /= len

  // Clip to the world box [0, size).
  let tEnter = 0
  let tExit = Infinity
  let enterAxis = -1
  for (let a = 0; a < 3; a++) {
    if (d[a] === 0) {
      if (o[a]! < 0 || o[a]! >= size[a]!) return null
      continue
    }
    let t0 = (0 - o[a]!) / d[a]!
    let t1 = (size[a]! - o[a]!) / d[a]!
    if (t0 > t1) [t0, t1] = [t1, t0]
    if (t0 > tEnter) { tEnter = t0; enterAxis = a }
    tExit = Math.min(tExit, t1)
  }
  if (tEnter > tExit || tEnter > maxDist) return null

  const p = [o[0] + d[0] * tEnter, o[1] + d[1] * tEnter, o[2] + d[2] * tEnter]
  const v: [number, number, number] = [0, 0, 0]
  for (let a = 0; a < 3; a++) {
    v[a] = Math.min(size[a]! - 1, Math.max(0, Math.floor(p[a]! + (a === enterAxis ? d[a]! * 1e-9 : 0))))
  }
  const first = get(v[0], v[1], v[2])
  if (pickable(first)) {
    const normal: [number, number, number] = [0, 0, 0]
    if (enterAxis >= 0) normal[enterAxis] = d[enterAxis]! > 0 ? -1 : 1
    return { pos: [v[0], v[1], v[2]], normal, voxel: first, distance: tEnter }
  }

  const step = [Math.sign(d[0]), Math.sign(d[1]), Math.sign(d[2])]
  const tDelta = [Math.abs(1 / d[0]), Math.abs(1 / d[1]), Math.abs(1 / d[2])]
  const tMax = [0, 0, 0]
  for (let a = 0; a < 3; a++) {
    if (step[a] === 0) tMax[a] = Infinity
    else if (step[a]! > 0) tMax[a] = (v[a]! + 1 - p[a]!) / d[a]!
    else tMax[a] = (p[a]! - v[a]!) / -d[a]!
  }
  for (;;) {
    const a = tMax[0]! < tMax[1]! ? (tMax[0]! < tMax[2]! ? 0 : 2) : (tMax[1]! < tMax[2]! ? 1 : 2)
    const t = tEnter + tMax[a]!
    if (t > maxDist) return null
    v[a] += step[a]!
    if (v[a]! < 0 || v[a]! >= size[a]!) return null
    tMax[a] += tDelta[a]!
    const voxel = get(v[0], v[1], v[2])
    if (pickable(voxel)) {
      const normal: [number, number, number] = [0, 0, 0]
      normal[a] = -step[a]!
      return { pos: [v[0], v[1], v[2]], normal, voxel, distance: t }
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run `npm test -- raycast`. Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/interact/raycast.ts packages/engine/test/raycast.test.ts
git commit -m "feat(engine): DDA voxel raycast with world-box entry"
```

---

### Task 16: Ghost edits and the mesh queue

**Files:**
- Create: `packages/engine/src/interact/ghostEdits.ts`, `packages/engine/src/render/meshQueue.ts`
- Test: `packages/engine/test/ghostEdits.test.ts`, `packages/engine/test/meshQueue.test.ts`

**Interfaces:**
- Consumes: `Layout` (Task 2), `Override` (Task 14), `raycast` (Task 15).
- Produces (`interact/ghostEdits.ts`):
  - `chunksTouching(layout, x, y, z): number[]` (sorted): the voxel's chunk, plus every neighbour chunk within 1 voxel, diagonals included
  - `class GhostEdits` with:
    - `constructor(layout)`, `size`
    - `add(seq, x, y, z, voxel): number[]` (returns affected chunks)
    - `get(x, y, z): number | undefined`
    - `resolve(seq): number[]` (returns affected chunks)
    - `overridesFor(chunk): Override[]`
- Produces (`render/meshQueue.ts`):
  - `PRIORITY = { GHOST: 0, DIRTY: 1, INITIAL: 2 }`
  - `class MeshQueue` with:
    - `mark(ci, priority)`, `next(distance: (ci) => number): number` (−1 when empty), `finish(ci)`
    - `accept(ci, version): boolean`
    - `size`, `inFlightCount`, `priorityOf(ci): number | undefined` (the priority of a queued or in-flight chunk)

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/ghostEdits.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { GhostEdits, chunksTouching } from '../src/interact/ghostEdits.ts'
import { raycast } from '../src/interact/raycast.ts'
import { Layout } from '../src/world/layout.ts'

const L = new Layout([64, 64, 64])

describe('chunksTouching', () => {
  it('includes border neighbours and diagonals', () => {
    expect(chunksTouching(L, 5, 5, 5)).toEqual([0])
    expect(chunksTouching(L, 31, 5, 5)).toEqual([0, 1])
    expect(chunksTouching(L, 31, 31, 31)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(chunksTouching(L, 0, 0, 0)).toEqual([0]) // world edge: no out-of-bounds chunks
  })
})

describe('GhostEdits', () => {
  it('overlays predicted voxels until resolved', () => {
    const g = new GhostEdits(L)
    expect(g.add(1, 31, 5, 5, 3)).toEqual([0, 1])
    expect(g.get(31, 5, 5)).toBe(3)
    expect(g.resolve(1)).toEqual([0, 1])
    expect(g.get(31, 5, 5)).toBeUndefined()
    expect(g.size).toBe(0)
  })
  it('keeps the newest ghost when an older seq resolves (spam-click)', () => {
    const g = new GhostEdits(L)
    g.add(1, 5, 5, 5, 3) // place
    g.add(2, 5, 5, 5, 0) // remove before ack 1 arrives
    expect(g.get(5, 5, 5)).toBe(0)
    g.resolve(1)
    expect(g.get(5, 5, 5)).toBe(0)
    g.resolve(2)
    expect(g.get(5, 5, 5)).toBeUndefined()
  })
  it('lists overrides for a chunk, including ghosts in its 1-voxel border', () => {
    const g = new GhostEdits(L)
    g.add(1, 32, 5, 5, 3) // inside chunk 1, on chunk 0's border
    g.add(2, 50, 5, 5, 3) // inside chunk 1, far from chunk 0
    expect(g.overridesFor(0)).toEqual([[32, 5, 5, 3]])
    expect(g.overridesFor(1)).toHaveLength(2)
  })
  it('feeds the raycast through an overlay getter', () => {
    const g = new GhostEdits(L)
    g.add(1, 5, 10, 0, 1)
    const get = (x: number, y: number, z: number) => g.get(x, y, z) ?? 0
    expect(raycast(get, (v) => v !== 0, L.size, [0.5, 10.5, 0.5], [1, 0, 0], 64)?.pos).toEqual([5, 10, 0])
  })
})
```

`packages/engine/test/meshQueue.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MeshQueue, PRIORITY } from '../src/render/meshQueue.ts'

const dist = (ci: number) => Math.abs(ci - 10)

describe('MeshQueue', () => {
  it('serves ghost, then dirty, then initial; nearest first within a class', () => {
    const q = new MeshQueue()
    q.mark(1, PRIORITY.INITIAL)
    q.mark(9, PRIORITY.DIRTY)
    q.mark(30, PRIORITY.DIRTY)
    q.mark(50, PRIORITY.GHOST)
    expect([q.next(dist), q.next(dist), q.next(dist), q.next(dist), q.next(dist)]).toEqual([50, 9, 30, 1, -1])
  })
  it('upgrades priority but never downgrades it', () => {
    const q = new MeshQueue()
    q.mark(4, PRIORITY.DIRTY)
    q.mark(4, PRIORITY.INITIAL)
    expect(q.priorityOf(4)).toBe(PRIORITY.DIRTY)
    q.mark(4, PRIORITY.GHOST)
    expect(q.priorityOf(4)).toBe(PRIORITY.GHOST)
  })
  it('keeps one job in flight per chunk and requeues one marked meanwhile', () => {
    const q = new MeshQueue()
    q.mark(7, PRIORITY.DIRTY)
    expect(q.next(dist)).toBe(7)
    q.mark(7, PRIORITY.GHOST)
    expect(q.next(dist)).toBe(-1)
    expect(q.inFlightCount).toBe(1)
    q.finish(7)
    expect(q.priorityOf(7)).toBe(PRIORITY.GHOST)
    expect(q.next(dist)).toBe(7)
  })
  it('discards out-of-order results by version', () => {
    const q = new MeshQueue()
    expect(q.accept(3, 6)).toBe(true)
    expect(q.accept(3, 4)).toBe(false)
    expect(q.accept(3, 6)).toBe(true) // a ghost mesh of the same version is fine
    expect(q.accept(3, 8)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run `npm test -- ghostEdits meshQueue`. Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`packages/engine/src/interact/ghostEdits.ts`:
```ts
import type { Override } from '../protocol.ts'
import type { Layout } from '../world/layout.ts'

export function chunksTouching(layout: Layout, x: number, y: number, z: number): number[] {
  const out = new Set<number>()
  for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const nx = x + dx, ny = y + dy, nz = z + dz
    if (!layout.inBounds(nx, ny, nz)) continue
    out.add(layout.chunkOf(nx, ny, nz))
  }
  return [...out].sort((a, b) => a - b)
}

interface Ghost { seq: number; x: number; y: number; z: number; voxel: number }

/** Predicted edits shown on the main thread until the sim acks them. */
export class GhostEdits {
  private readonly layout: Layout
  private readonly byPos = new Map<number, Ghost>()
  private readonly bySeq = new Map<number, number[]>()

  constructor(layout: Layout) { this.layout = layout }

  get size(): number { return this.byPos.size }

  add(seq: number, x: number, y: number, z: number, voxel: number): number[] {
    const key = this.layout.voxelIndex(x, y, z)
    this.byPos.set(key, { seq, x, y, z, voxel })
    const list = this.bySeq.get(seq)
    if (list) list.push(key)
    else this.bySeq.set(seq, [key])
    return chunksTouching(this.layout, x, y, z)
  }

  get(x: number, y: number, z: number): number | undefined {
    if (this.byPos.size === 0 || !this.layout.inBounds(x, y, z)) return undefined
    return this.byPos.get(this.layout.voxelIndex(x, y, z))?.voxel
  }

  resolve(seq: number): number[] {
    const keys = this.bySeq.get(seq)
    if (!keys) return []
    this.bySeq.delete(seq)
    const chunks = new Set<number>()
    for (const key of keys) {
      const g = this.byPos.get(key)
      if (!g || g.seq !== seq) continue // a newer edit owns this voxel now
      this.byPos.delete(key)
      for (const c of chunksTouching(this.layout, g.x, g.y, g.z)) chunks.add(c)
    }
    return [...chunks].sort((a, b) => a - b)
  }

  overridesFor(chunk: number): Override[] {
    const [cx, cy, cz] = this.layout.chunkCoords(chunk)
    const out: Override[] = []
    for (const g of this.byPos.values()) {
      const lx = g.x - cx * 32, ly = g.y - cy * 32, lz = g.z - cz * 32
      if (lx >= -1 && lx <= 32 && ly >= -1 && ly <= 32 && lz >= -1 && lz <= 32) out.push([g.x, g.y, g.z, g.voxel])
    }
    return out
  }
}
```

`packages/engine/src/render/meshQueue.ts`:
```ts
export const PRIORITY = { GHOST: 0, DIRTY: 1, INITIAL: 2 } as const

/** Which chunk to mesh next. Pure bookkeeping: no workers, no three.js. */
export class MeshQueue {
  private readonly queued = new Map<number, number>()
  private readonly inFlight = new Map<number, number>()
  private readonly again = new Map<number, number>()
  private readonly applied = new Map<number, number>()

  get size(): number { return this.queued.size }
  get inFlightCount(): number { return this.inFlight.size }

  priorityOf(ci: number): number | undefined {
    return this.queued.get(ci) ?? this.again.get(ci) ?? this.inFlight.get(ci)
  }

  mark(ci: number, priority: number): void {
    if (this.inFlight.has(ci)) {
      const cur = this.again.get(ci)
      if (cur === undefined || priority < cur) this.again.set(ci, priority)
      return
    }
    const cur = this.queued.get(ci)
    if (cur === undefined || priority < cur) this.queued.set(ci, priority)
  }

  next(distance: (ci: number) => number): number {
    let best = -1, bestP = Infinity, bestD = Infinity
    for (const [ci, p] of this.queued) {
      if (p > bestP) continue
      const d = distance(ci)
      if (p < bestP || d < bestD) { best = ci; bestP = p; bestD = d }
    }
    if (best >= 0) {
      this.queued.delete(best)
      this.inFlight.set(best, bestP)
    }
    return best
  }

  finish(ci: number): void {
    this.inFlight.delete(ci)
    const p = this.again.get(ci)
    if (p !== undefined) {
      this.again.delete(ci)
      this.mark(ci, p)
    }
  }

  /** True if a result with this version may replace what is shown. Same version is allowed (ghost meshes). */
  accept(ci: number, version: number): boolean {
    const last = this.applied.get(ci)
    if (last !== undefined && version < last) return false
    this.applied.set(ci, version)
    return true
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run `npm test -- ghostEdits meshQueue`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/interact/ghostEdits.ts packages/engine/src/render/meshQueue.ts packages/engine/test/ghostEdits.test.ts packages/engine/test/meshQueue.test.ts
git commit -m "feat(engine): ghost-edit overlay and prioritised mesh queue"
```

---

### Task 17: Texture tiles and the texture array

**Files:**
- Create: `packages/engine/src/render/tiles.ts` (pure), `packages/engine/src/render/textureArray.ts` (browser and three.js)
- Test: `packages/engine/test/tiles.test.ts`

**Interfaces:**
- Produces (`render/tiles.ts`):
  - `TILE = 64`, `checkerTile(size?): Uint8Array`
  - `interface PackedTiles { data: Uint8Array; layers: number; layerOf: Map<string, number>; missing: string[] }`
  - `packTiles(names, pixels: (name) => Uint8Array | null, size?): PackedTiles`. Layer 0 is the magenta/black checker. Present tiles take layers 1… in `names` order, and missing tiles are left out of `layerOf`, so `BlockRegistry.faceLayers` maps them to 0. Rows are flipped so the image's top row lands at v = 1 (the top of a block's side).
- Produces (`render/textureArray.ts`):
  - `loadTilePixels(url, size?): Promise<Uint8Array | null>`
  - `buildTextureArray(textures: Record<string, string>, names: string[]): Promise<{ texture: THREE.DataArrayTexture; layerOf: Map<string, number>; missing: string[] }>`

- [ ] **Step 1: Write the failing test**

`packages/engine/test/tiles.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { TILE, checkerTile, packTiles } from '../src/render/tiles.ts'

function solid(size: number, r: number, g: number, b: number): Uint8Array {
  const px = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) px.set([r, g, b, 255], i * 4)
  return px
}

describe('packTiles', () => {
  it('puts the checker at layer 0 and present tiles after it', () => {
    const tiles: Record<string, Uint8Array> = { stone: solid(4, 128, 128, 128), dirt: solid(4, 100, 60, 30) }
    const p = packTiles(['stone', 'missing', 'dirt'], (n) => tiles[n] ?? null, 4)
    expect(p.layers).toBe(3)
    expect([...p.layerOf]).toEqual([['stone', 1], ['dirt', 2]])
    expect(p.missing).toEqual(['missing'])
    expect(p.data.length).toBe(3 * 4 * 4 * 4)
    expect(Array.from(p.data.subarray(0, 4))).toEqual(Array.from(checkerTile(4).subarray(0, 4)))
    expect(Array.from(p.data.subarray(64, 68))).toEqual([128, 128, 128, 255])
  })
  it('flips rows so the top of the image is v = 1', () => {
    const img = new Uint8Array(2 * 2 * 4)
    img.set([255, 0, 0, 255], 0) // top-left red
    const p = packTiles(['t'], () => img, 2)
    const layer = p.data.subarray(16, 32)
    expect(Array.from(layer.subarray(8, 12))).toEqual([255, 0, 0, 255]) // now on the last row
  })
  it('rejects tiles of the wrong size', () => {
    expect(() => packTiles(['a'], () => new Uint8Array(10), 4)).toThrow(/expected 64 bytes/)
  })
  it('has a 64px default with a magenta/black checker', () => {
    expect(TILE).toBe(64)
    const c = checkerTile()
    expect(c.length).toBe(64 * 64 * 4)
    expect(Array.from(c.subarray(0, 4))).toEqual([255, 0, 255, 255])
    expect(Array.from(c.subarray(8 * 4, 8 * 4 + 4))).toEqual([0, 0, 0, 255])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run `npm test -- tiles`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement the pure tiles module**

`packages/engine/src/render/tiles.ts`:
```ts
export const TILE = 64

export function checkerTile(size = TILE): Uint8Array {
  const px = new Uint8Array(size * size * 4)
  const cell = Math.max(1, size >> 3)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const on = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 0
    px.set(on ? [255, 0, 255, 255] : [0, 0, 0, 255], (y * size + x) * 4)
  }
  return px
}

export interface PackedTiles { data: Uint8Array; layers: number; layerOf: Map<string, number>; missing: string[] }

export function packTiles(names: readonly string[], pixels: (name: string) => Uint8Array | null, size = TILE): PackedTiles {
  const bytes = size * size * 4
  const present: [string, Uint8Array][] = []
  const missing: string[] = []
  for (const n of names) {
    const px = pixels(n)
    if (!px) { missing.push(n); continue }
    if (px.length !== bytes) throw new Error(`texture "${n}": expected ${bytes} bytes, got ${px.length}`)
    present.push([n, px])
  }
  const layers = present.length + 1
  const data = new Uint8Array(layers * bytes)
  data.set(checkerTile(size), 0)
  const layerOf = new Map<string, number>()
  const row = size * 4
  present.forEach(([n, px], i) => {
    const base = (i + 1) * bytes
    for (let y = 0; y < size; y++) data.set(px.subarray(y * row, (y + 1) * row), base + (size - 1 - y) * row)
    layerOf.set(n, i + 1)
  })
  return { data, layers, layerOf, missing }
}
```

- [ ] **Step 4: Implement the browser loader**

`packages/engine/src/render/textureArray.ts`:
```ts
import * as THREE from 'three/webgpu'
import { TILE, packTiles } from './tiles.ts'

export async function loadTilePixels(url: string, size = TILE): Promise<Uint8Array | null> {
  try {
    const blob = await (await fetch(url)).blob()
    const bmp = await createImageBitmap(blob, { resizeWidth: size, resizeHeight: size, resizeQuality: 'high' })
    const canvas = new OffscreenCanvas(size, size)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    bmp.close()
    return new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer)
  } catch (err) {
    console.warn(`[elovox] could not load texture ${url}:`, err)
    return null
  }
}

export async function buildTextureArray(textures: Record<string, string>, names: string[]) {
  const loaded = new Map<string, Uint8Array | null>(
    await Promise.all(names.map(async (n) => [n, textures[n] ? await loadTilePixels(textures[n]!) : null] as const)),
  )
  const packed = packTiles(names, (n) => loaded.get(n) ?? null)
  for (const n of packed.missing) console.warn(`[elovox] missing texture "${n}" — using the checker layer`)
  const texture = new THREE.DataArrayTexture(packed.data, TILE, TILE, packed.layers)
  texture.format = THREE.RGBAFormat
  texture.type = THREE.UnsignedByteType
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 8
  texture.needsUpdate = true
  return { texture, layerOf: packed.layerOf, missing: packed.missing }
}
```

- [ ] **Step 5: Run the test, then typecheck**

Run `npm test -- tiles`. Expected: PASS.
Run `npm run typecheck`. Expected: no errors. If `three/webgpu` has no types, check that `@types/three` is installed and current.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/render/tiles.ts packages/engine/src/render/textureArray.ts packages/engine/test/tiles.test.ts
git commit -m "feat(engine): texture tile packing and DataArrayTexture loader"
```

---

### Task 18: Chunk materials (TSL) and chunk meshes

**Files:**
- Create: `packages/engine/src/render/materials.ts`, `packages/engine/src/render/chunkMeshes.ts`
- Modify: `apps/sandbox/src/main.ts` (temporary spike, replaced in Task 21)

**Interfaces:**
- Consumes: `ChunkMeshData` (Task 13), `AO_CURVE` (Task 11), `Layout` (Task 2).
- Produces (`render/materials.ts`):
  - `interface ChunkMaterials { opaque; cutout; translucent: THREE.MeshBasicNodeMaterial; lighting: { sunDir: THREE.Vector3; sunColor: THREE.Color; skyColor: THREE.Color; groundColor: THREE.Color; ambient: { value: number } } }`
  - `createChunkMaterials(texture: THREE.DataArrayTexture): ChunkMaterials`
- Produces (`render/chunkMeshes.ts`): `class ChunkMeshes` with:
  - `constructor(layout, materials)`, `group: THREE.Group`
  - `apply(ci, data: ChunkMeshData): void`, `remove(ci)`, `meshCount`, `dispose()`

**Shader contract** (spec §5, with Deviation 4 for UVs):
- Each mesh sits at its chunk centre (`origin + 16`). The vertex position is `(x, y − drop/16, z) − 16`.
- UVs project the local position onto the face plane: x faces → (z, y), y faces → (x, z), z faces → (x, y). `RepeatWrapping` tiles merged quads.
- `final = albedo × (sun × ndl × sky + hemi × ambient × max(sky, block) + 0.04) × AO_CURVE[ao]`. Sky and block light are /15, and the 0.04 floor keeps caves from rendering as pure black.

This task is a **render spike**. The integer-attribute path isn't unit-testable, so Step 1 proves it in a real browser under both backends before the engine is wired on top of it.

- [ ] **Step 1: Implement the materials**

`packages/engine/src/render/materials.ts`:
```ts
import * as THREE from 'three/webgpu'
import { attribute, dot, float, max, mix, select, texture, uint, uniform, varying, vec2, vec3, vec4 } from 'three/tsl'
import { AO_CURVE } from '../mesh/ao.ts'

export interface ChunkMaterials {
  opaque: THREE.MeshBasicNodeMaterial
  cutout: THREE.MeshBasicNodeMaterial
  translucent: THREE.MeshBasicNodeMaterial
  lighting: { sunDir: THREE.Vector3; sunColor: THREE.Color; skyColor: THREE.Color; groundColor: THREE.Color; ambient: { value: number } }
}

export function createChunkMaterials(tex: THREE.DataArrayTexture): ChunkMaterials {
  const sunDir = new THREE.Vector3(0.45, 0.85, 0.3).normalize()
  const sunColor = new THREE.Color(1.0, 0.96, 0.88)
  const skyColor = new THREE.Color(0.66, 0.76, 0.9)
  const groundColor = new THREE.Color(0.42, 0.37, 0.32)
  const ambient = uniform(0.6)
  const uSun = uniform(sunDir), uSunColor = uniform(sunColor), uSky = uniform(skyColor), uGround = uniform(groundColor)

  function build(mode: 'opaque' | 'cutout' | 'translucent'): THREE.MeshBasicNodeMaterial {
    const m = new THREE.MeshBasicNodeMaterial()
    const packed = attribute('packed', 'uvec2')
    const a = packed.x, b = packed.y
    const px = a.bitAnd(uint(63)).toFloat()
    const py = a.shiftRight(uint(6)).bitAnd(uint(63)).toFloat()
    const pz = a.shiftRight(uint(12)).bitAnd(uint(63)).toFloat()
    const nIdx = a.shiftRight(uint(18)).bitAnd(uint(7))
    const ao = a.shiftRight(uint(21)).bitAnd(uint(3))
    const drop = a.shiftRight(uint(25)).bitAnd(uint(31)).toFloat()
    const layer = b.bitAnd(uint(4095)).toFloat()
    const sky = b.shiftRight(uint(12)).bitAnd(uint(15)).toFloat().div(15)
    const blk = b.shiftRight(uint(16)).bitAnd(uint(15)).toFloat().div(15)

    const local = vec3(px, py.sub(drop.div(16)), pz)
    m.positionNode = local.sub(16)

    const normal = select(nIdx.equal(uint(0)), vec3(1, 0, 0),
      select(nIdx.equal(uint(1)), vec3(-1, 0, 0),
        select(nIdx.equal(uint(2)), vec3(0, 1, 0),
          select(nIdx.equal(uint(3)), vec3(0, -1, 0),
            select(nIdx.equal(uint(4)), vec3(0, 0, 1), vec3(0, 0, -1))))))
    const axis = nIdx.shiftRight(uint(1))
    const uv = select(axis.equal(uint(0)), vec2(local.z, local.y), select(axis.equal(uint(1)), vec2(local.x, local.z), vec2(local.x, local.y)))
    const aoF = select(ao.equal(uint(0)), float(AO_CURVE[0]!),
      select(ao.equal(uint(1)), float(AO_CURVE[1]!), select(ao.equal(uint(2)), float(AO_CURVE[2]!), float(AO_CURVE[3]!))))

    const vUv = varying(uv)
    const vLayer = varying(layer)
    const vNormal = varying(normal)
    const vLight = varying(vec2(sky, blk))
    const vAO = varying(aoF)

    const albedo = texture(tex, vUv).depth(vLayer.add(0.5).toInt())
    const ndl = max(dot(vNormal, uSun), 0)
    const hemi = mix(uGround, uSky, vNormal.y.mul(0.5).add(0.5))
    const light = uSunColor.mul(ndl.mul(vLight.x)).add(hemi.mul(ambient).mul(max(vLight.x, vLight.y))).add(0.04)
    const rgb = albedo.rgb.mul(light).mul(vAO)

    if (mode === 'opaque') {
      m.colorNode = vec4(rgb, 1)
    } else if (mode === 'cutout') {
      m.colorNode = vec4(rgb, albedo.a)
      m.alphaTest = 0.5
      m.side = THREE.DoubleSide
    } else {
      m.colorNode = vec4(rgb, albedo.a.mul(0.85))
      m.transparent = true
      m.depthWrite = false
    }
    return m
  }

  return {
    opaque: build('opaque'), cutout: build('cutout'), translucent: build('translucent'),
    lighting: { sunDir, sunColor, skyColor, groundColor, ambient },
  }
}
```

- [ ] **Step 2: Implement ChunkMeshes**

`packages/engine/src/render/chunkMeshes.ts`:
```ts
import * as THREE from 'three/webgpu'
import type { ChunkMeshData } from '../mesh/mesher.ts'
import type { LayerMesh } from '../mesh/quadBuilder.ts'
import type { Layout } from '../world/layout.ts'
import type { ChunkMaterials } from './materials.ts'

const LAYERS = ['opaque', 'cutout', 'translucent'] as const
const SPHERE = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 16 * Math.sqrt(3) + 0.5)

function geometryOf(m: LayerMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  const packed = new THREE.BufferAttribute(m.vertices, 2)
  packed.gpuType = THREE.IntType // integer attribute: read as uvec2 in the shader, never converted to float
  g.setAttribute('packed', packed)
  g.setIndex(new THREE.BufferAttribute(m.indices, 1))
  g.boundingSphere = SPHERE.clone()
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-16, -16, -16), new THREE.Vector3(16, 16, 16))
  return g
}

export class ChunkMeshes {
  readonly group = new THREE.Group()
  private readonly layout: Layout
  private readonly materials: ChunkMaterials
  private readonly meshes = new Map<number, (THREE.Mesh | null)[]>()

  constructor(layout: Layout, materials: ChunkMaterials) {
    this.layout = layout
    this.materials = materials
    this.group.name = 'elovox-chunks'
  }

  get meshCount(): number { return this.group.children.length }

  apply(ci: number, data: ChunkMeshData): void {
    let slots = this.meshes.get(ci)
    if (!slots) { slots = [null, null, null]; this.meshes.set(ci, slots) }
    const [cx, cy, cz] = this.layout.chunkCoords(ci)
    LAYERS.forEach((name, k) => {
      const lm = data[name]
      const existing = slots![k]!
      if (!lm) {
        if (existing) { this.group.remove(existing); existing.geometry.dispose(); slots![k] = null }
        return
      }
      const geo = geometryOf(lm)
      if (existing) {
        existing.geometry.dispose()
        existing.geometry = geo
        return
      }
      const mesh = new THREE.Mesh(geo, this.materials[name])
      mesh.position.set(cx * 32 + 16, cy * 32 + 16, cz * 32 + 16)
      mesh.matrixAutoUpdate = false
      mesh.updateMatrix()
      mesh.name = `chunk-${ci}-${name}`
      this.group.add(mesh)
      slots![k] = mesh
    })
  }

  remove(ci: number): void {
    const slots = this.meshes.get(ci)
    if (!slots) return
    for (const m of slots) if (m) { this.group.remove(m); m.geometry.dispose() }
    this.meshes.delete(ci)
  }

  dispose(): void {
    for (const ci of [...this.meshes.keys()]) this.remove(ci)
    for (const name of LAYERS) this.materials[name].dispose()
  }
}
```

- [ ] **Step 3: Write the render spike in the sandbox**

The sandbox needs `three` to import `three/webgpu` directly. Run `npm i three@<the exact version pinned in packages/engine> -w @elovox/sandbox`.

Then replace `apps/sandbox/src/main.ts` with this temporary spike. It meshes a hand-built snapshot on the main thread and draws it, so you can check the attribute and shader path in isolation (deep `src/*` imports are allowed by the engine's `exports` map):
```ts
import * as THREE from 'three/webgpu'
import { BlockRegistry, defineBlock } from '@elovox/engine/src/blocks/registry.ts'
import { Mesher } from '@elovox/engine/src/mesh/mesher.ts'
import { meshTablesFrom } from '@elovox/engine/src/mesh/tables.ts'
import { ChunkMeshes } from '@elovox/engine/src/render/chunkMeshes.ts'
import { createChunkMaterials } from '@elovox/engine/src/render/materials.ts'
import { checkerTile } from '@elovox/engine/src/render/tiles.ts'
import { Layout } from '@elovox/engine/src/world/layout.ts'
import { createSnapshot, padIndex } from '@elovox/engine/src/world/reader.ts'
import { packVoxel } from '@elovox/engine/src/world/voxel.ts'

const forceWebGL = new URLSearchParams(location.search).has('webgl')
const canvas = document.querySelector<HTMLCanvasElement>('#view')!
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL })
await renderer.init()
renderer.setSize(innerWidth, innerHeight, false)
const scene = new THREE.Scene()
scene.background = new THREE.Color(0xdfe3e6)
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 500)
camera.position.set(40, 40, 40)
camera.lookAt(16, 8, 16)

const reg = new BlockRegistry([defineBlock({ name: 'stone' }), defineBlock({ name: 'water', liquid: true })])
const tex = new THREE.DataArrayTexture(new Uint8Array([...checkerTile(64), ...checkerTile(64), ...checkerTile(64)]), 64, 64, 3)
tex.wrapS = tex.wrapT = THREE.RepeatWrapping
tex.needsUpdate = true
const snap = createSnapshot()
snap.light.fill(15)
for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) for (let y = 0; y < 4 + ((x * z) % 5); y++) snap.voxels[padIndex(x + 1, y + 1, z + 1)] = 1
snap.voxels[padIndex(10, 10, 10)] = packVoxel(2, 4)
const data = new Mesher().mesh(snap, meshTablesFrom(reg, new Uint16Array(reg.count * 6).fill(1)))
const meshes = new ChunkMeshes(new Layout([32, 32, 32]), createChunkMaterials(tex))
meshes.apply(0, data)
scene.add(meshes.group)
renderer.setAnimationLoop(() => renderer.render(scene, camera))
document.title = `spike: ${(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl'}`
```

- [ ] **Step 4: Verify the spike in both backends**

Run `npm run dev`. Open `http://localhost:5173/` and then `http://localhost:5173/?webgl`.
Expected in both:
- Checker-textured stepped terrain and a lowered water cube.
- Visible AO darkening in the inner corners, and no holes.
- The tab title shows the backend.
- No console errors.

If WebGL reports an integer-attribute or missing-`position` error, two workarounds are acceptable. Record whichever you use in `chunkMeshes.ts` with a comment that names the three.js version:
- (a) Add `geo.setAttribute('position', packed)`, so the attribute set is complete.
- (b) Read the attribute as `attribute('packed', 'ivec2')` with `Int32Array` storage.

If faces are missing only from one side, the winding is wrong. Check `REVERSE` in Task 12 against the outward-winding test; don't flip `side`.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/render/materials.ts packages/engine/src/render/chunkMeshes.ts apps/sandbox/src/main.ts apps/sandbox/package.json package-lock.json
git commit -m "feat(engine): TSL chunk materials and chunk meshes (spike-verified on WebGPU and WebGL2)"
```

---

### Task 19: RTS orbit camera

**Files:**
- Create: `packages/engine/src/interact/orbitCamera.ts`
- Test: `packages/engine/test/orbitCamera.test.ts`

**Interfaces:**
- Produces:
  - `interface OrbitOptions { worldSize: WorldSize; minDistance?: 8; maxDistance?: 400; minPitch?: 0.15; maxPitch?: 1.45; damping?: 10; moveSpeed?: 1.2; heightAt?: (x, z) => number }`
  - `interface CameraLike { position: { set(x, y, z): unknown }; lookAt(x: number, y: number, z: number): unknown }`
  - `class OrbitCamera` with:
    - fields `goal` and `current`, both `{ target: [x, y, z]; yaw; pitch; distance }`
    - `rotate(dYaw, dPitch)`, `zoom(deltaY)`, `pan(dxPx, dyPx)`, `move(forward, right, dt)`, `update(dt)`, `apply(camera)`
    - `attach(canvas): () => void` (returns a detach function) and `lastDragDistance: number`
- The camera sits at `target + distance × (cos(pitch)·sin(yaw), sin(pitch), cos(pitch)·cos(yaw))`. Forward is `(−sin yaw, 0, −cos yaw)` and right is `(cos yaw, 0, −sin yaw)`.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/orbitCamera.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { OrbitCamera } from '../src/interact/orbitCamera.ts'

const make = (heightAt?: (x: number, z: number) => number) =>
  new OrbitCamera({ worldSize: [256, 128, 256], heightAt })

describe('OrbitCamera', () => {
  it('clamps pitch and distance', () => {
    const c = make()
    c.rotate(0, 10)
    expect(c.goal.pitch).toBe(1.45)
    c.rotate(0, -10)
    expect(c.goal.pitch).toBe(0.15)
    c.zoom(1e6)
    expect(c.goal.distance).toBe(400)
    c.zoom(-1e6)
    expect(c.goal.distance).toBe(8)
  })
  it('moves along the camera yaw', () => {
    const c = make()
    c.goal.target = [100, 0, 100]
    c.goal.yaw = 0
    c.move(1, 0, 1) // forward at yaw 0 is −z
    expect(c.goal.target[2]).toBeLessThan(100)
    expect(c.goal.target[0]).toBeCloseTo(100)
    c.goal.yaw = Math.PI / 2
    const z = c.goal.target[2]
    c.move(0, 1, 1) // right at yaw 90° is −z
    expect(c.goal.target[2]).toBeLessThan(z)
  })
  it('keeps the target inside the world', () => {
    const c = make()
    c.goal.target = [1, 0, 1]
    c.move(-1000, -1000, 1)
    for (const v of [c.goal.target[0], c.goal.target[2]]) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(256)
    }
  })
  it('damps toward the goal and follows the terrain height', () => {
    const c = make(() => 40)
    c.goal.target = [50, 0, 50]
    for (let i = 0; i < 120; i++) c.update(1 / 60)
    expect(c.current.target[0]).toBeCloseTo(50, 1)
    expect(c.current.target[1]).toBeCloseTo(40, 1)
  })
  it('places the camera on the orbit sphere', () => {
    const c = make()
    c.current.target = [0, 0, 0]
    c.current.yaw = 0
    c.current.pitch = 0
    c.current.distance = 10
    const seen: number[][] = []
    c.apply({ position: { set: (x, y, z) => seen.push([x, y, z]) }, lookAt: (x, y, z) => seen.push([x, y, z]) })
    expect(seen[0]![2]).toBeCloseTo(10)
    expect(seen[1]).toEqual([0, 0, 0])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run `npm test -- orbitCamera`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/engine/src/interact/orbitCamera.ts`:
```ts
import type { WorldSize } from '../world/layout.ts'

export interface OrbitOptions {
  worldSize: WorldSize
  minDistance?: number
  maxDistance?: number
  minPitch?: number
  maxPitch?: number
  damping?: number
  moveSpeed?: number
  heightAt?: (x: number, z: number) => number
}
export interface CameraLike { position: { set(x: number, y: number, z: number): unknown }; lookAt(x: number, y: number, z: number): unknown }
export interface OrbitState { target: [number, number, number]; yaw: number; pitch: number; distance: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const EDGE_PX = 12

export class OrbitCamera {
  readonly goal: OrbitState
  readonly current: OrbitState
  lastDragDistance = 0
  private readonly o: Required<Omit<OrbitOptions, 'heightAt'>> & Pick<OrbitOptions, 'heightAt'>
  private readonly keys = new Set<string>()
  private edge: [number, number] = [0, 0]

  constructor(options: OrbitOptions) {
    this.o = {
      minDistance: 8, maxDistance: 400, minPitch: 0.15, maxPitch: 1.45, damping: 10, moveSpeed: 1.2, ...options,
    }
    const [sx, , sz] = options.worldSize
    this.goal = { target: [sx / 2, 0, sz / 2], yaw: 0.7, pitch: 0.85, distance: 70 }
    this.current = { ...this.goal, target: [...this.goal.target] }
  }

  rotate(dYaw: number, dPitch: number): void {
    this.goal.yaw += dYaw
    this.goal.pitch = clamp(this.goal.pitch + dPitch, this.o.minPitch, this.o.maxPitch)
  }

  zoom(deltaY: number): void {
    this.goal.distance = clamp(this.goal.distance * Math.exp(deltaY * 0.001), this.o.minDistance, this.o.maxDistance)
  }

  /** Drag-pan in screen pixels: the ground follows the cursor. */
  pan(dxPx: number, dyPx: number): void {
    const k = this.goal.distance * 0.0015
    this.translate(dyPx * k, -dxPx * k)
  }

  /** Continuous movement (WASD / screen edge): forward and right in [-1, 1]. */
  move(forward: number, right: number, dt: number): void {
    const speed = this.o.moveSpeed * this.goal.distance
    this.translate(forward * speed * dt, right * speed * dt)
  }

  update(dt: number): void {
    const f = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0) - this.edge[1]
    const r = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0) + this.edge[0]
    if (f || r) this.move(clamp(f, -1, 1), clamp(r, -1, 1), dt)
    if (this.o.heightAt) this.goal.target[1] = this.o.heightAt(this.goal.target[0], this.goal.target[2])
    const t = 1 - Math.exp(-this.o.damping * dt)
    const c = this.current, g = this.goal
    for (let i = 0; i < 3; i++) c.target[i] = c.target[i]! + (g.target[i]! - c.target[i]!) * t
    c.yaw += (g.yaw - c.yaw) * t
    c.pitch += (g.pitch - c.pitch) * t
    c.distance += (g.distance - c.distance) * t
  }

  apply(camera: CameraLike): void {
    const { target, yaw, pitch, distance } = this.current
    const cp = Math.cos(pitch)
    camera.position.set(target[0] + distance * cp * Math.sin(yaw), target[1] + distance * Math.sin(pitch), target[2] + distance * cp * Math.cos(yaw))
    camera.lookAt(target[0], target[1], target[2])
  }

  attach(canvas: HTMLCanvasElement): () => void {
    let dragging = false
    let lx = 0, ly = 0
    const down = (e: PointerEvent) => {
      if (e.button !== 1 && e.button !== 2) return
      dragging = true
      this.lastDragDistance = 0
      lx = e.clientX; ly = e.clientY
      canvas.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      const ex = e.clientX - rect.left, ey = e.clientY - rect.top
      this.edge = [ex < EDGE_PX ? -1 : ex > rect.width - EDGE_PX ? 1 : 0, ey < EDGE_PX ? -1 : ey > rect.height - EDGE_PX ? 1 : 0]
      if (!dragging) return
      const dx = e.clientX - lx, dy = e.clientY - ly
      lx = e.clientX; ly = e.clientY
      this.lastDragDistance += Math.abs(dx) + Math.abs(dy)
      this.rotate(-dx * 0.005, dy * 0.005)
    }
    const up = (e: PointerEvent) => { if (dragging) { dragging = false; canvas.releasePointerCapture(e.pointerId) } }
    const leave = () => { this.edge = [0, 0] }
    const wheel = (e: WheelEvent) => { e.preventDefault(); this.zoom(e.deltaY) }
    const menu = (e: Event) => e.preventDefault()
    const kd = (e: KeyboardEvent) => this.keys.add(e.code)
    const ku = (e: KeyboardEvent) => this.keys.delete(e.code)
    const blur = () => this.keys.clear()
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointerleave', leave)
    canvas.addEventListener('wheel', wheel, { passive: false })
    canvas.addEventListener('contextmenu', menu)
    window.addEventListener('keydown', kd)
    window.addEventListener('keyup', ku)
    window.addEventListener('blur', blur)
    return () => {
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointerleave', leave)
      canvas.removeEventListener('wheel', wheel)
      canvas.removeEventListener('contextmenu', menu)
      window.removeEventListener('keydown', kd)
      window.removeEventListener('keyup', ku)
      window.removeEventListener('blur', blur)
    }
  }

  private translate(forward: number, right: number): void {
    const { yaw } = this.goal
    const t = this.goal.target
    t[0] = clamp(t[0] + -Math.sin(yaw) * forward + Math.cos(yaw) * right, 0, this.o.worldSize[0])
    t[2] = clamp(t[2] + -Math.cos(yaw) * forward - Math.sin(yaw) * right, 0, this.o.worldSize[2])
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run `npm test -- orbitCamera`. Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/interact/orbitCamera.ts packages/engine/test/orbitCamera.test.ts
git commit -m "feat(engine): damped RTS orbit camera with WASD, edge pan and drag rotate"
```

---

### Task 20: `createEngine` (wiring workers, renderer and input) plus a minimal sandbox boot

**Files:**
- Create: `packages/engine/src/engine.ts`, `packages/engine/src/errors.ts`, `packages/engine/src/version.ts`
- Modify: `packages/engine/src/index.ts`, `packages/engine/test/scaffold.test.ts`
- Create: `apps/sandbox/src/blocks.ts`, `apps/sandbox/src/sim.worker.ts`
- Modify: `apps/sandbox/src/main.ts` (replaces the Task 18 spike)

**Interfaces:**
- Consumes everything above: `WorldReader`, `createWorldBuffers`, `BlockRegistry`, `GhostEdits`, `MeshQueue`/`PRIORITY`, `ChunkMeshes`, `createChunkMaterials`, `buildTextureArray`, `meshTablesFrom`, `OrbitCamera`, `raycast`, and the protocol types.
- Produces (`engine.ts`):
  - `interface EngineOptions { canvas; size?: WorldSize (default [1024,128,1024]); seed; blocks: BlockDef[]; textures: Record<string, string>; simWorker: () => Worker; sim?: SimInitOptions; meshWorkers?: number; forceWebGL?: boolean }`
  - `interface EngineEvents { ready: { chunks: number }; tick: { tick: number; tickMs: number }; event: SimEvent; ack: Ack; log: { message: string }; fatal: { message: string } }`
  - `interface EngineStats { fps; frameMs; tick; tickMs; meshQueue; meshInFlight; failedChunks; slotsUsed; meshes; drawCalls; backend: 'webgpu' | 'webgl' }`
  - `interface Engine`:
    - fields `scene`, `camera`, `renderer`, `blocks: BlockRegistry`, `layout: Layout`, `controls: OrbitCamera`, `world: { get(x, y, z): number; getLight(x, y, z): number }`
    - `submit(cmd: Command): number` (returns seq)
    - `raycast(origin, dir, maxDist?)`, `pickScreen(clientX, clientY, maxDist?)`, `setHighlight(pos | null)`
    - `on(type, fn): () => void`, `stats(): EngineStats`, `dispose()`
  - `createEngine(o: EngineOptions): Promise<Engine>` resolves once the sim has generated the world and started ticking.
- Produces (`errors.ts`): `class EngineError extends Error { code: 'not-isolated' | 'no-gpu' | 'fatal' }` and `showErrorScreen(canvas, title, detail): HTMLElement`, which uses `textContent` only, never `innerHTML`.

**Wiring rules (spec §5 and §7):**
- **Result handling.** A mesh result calls `queue.finish`. The result is applied in the frame loop, oldest first, within a 4 ms budget, and only if `queue.accept(chunk, version)`.
- **Retries and failures.** `retry` re-marks the chunk at the same priority. A mesh `error` or a worker crash counts as a failure. After 3 failures the chunk keeps its last mesh and counts in `stats().failedChunks`; becoming dirty again resets that count.
- **Ghost edits.** Only `setBlock` commands with a valid voxel are ghosted. On each ack from client 0, `ghosts.resolve(seq)` runs and its chunks are marked `GHOST`. The tick's `dirtyChunks` are marked `DIRTY` in the same handler, so the authoritative remesh replaces the ghost mesh without a gap.
- **Fatal errors.** A sim `fatal` message or a sim worker crash triggers `fatal`, shows the error screen, and rejects the startup promise if it is still pending.

- [ ] **Step 1: Move the version constant so the index can import three.js**

`packages/engine/src/version.ts`:
```ts
export const ENGINE_VERSION = '0.1.0'
```
In `packages/engine/test/scaffold.test.ts`, change the import to `import { ENGINE_VERSION } from '../src/version.ts'`. That way the Node test no longer loads `three/webgpu` through the index.

- [ ] **Step 2: Write `errors.ts`**

`packages/engine/src/errors.ts`:
```ts
export type EngineErrorCode = 'not-isolated' | 'no-gpu' | 'fatal'

export class EngineError extends Error {
  readonly code: EngineErrorCode
  constructor(code: EngineErrorCode, message: string) {
    super(message)
    this.name = 'EngineError'
    this.code = code
  }
}

/** Covers the canvas with a readable message. Text only, so error details can't inject markup. */
export function showErrorScreen(canvas: HTMLCanvasElement, title: string, detail: string): HTMLElement {
  const host = canvas.parentElement ?? document.body
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
  const el = document.createElement('div')
  el.className = 'elovox-error'
  el.setAttribute('role', 'alert')
  Object.assign(el.style, {
    position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', padding: '24px', zIndex: '10',
    background: 'rgba(20, 22, 26, 0.85)', color: '#f3f4f6', font: '14px/1.5 system-ui, sans-serif',
  })
  const box = document.createElement('div')
  box.style.maxWidth = '560px'
  const h = document.createElement('h2')
  h.textContent = title
  h.style.margin = '0 0 8px'
  const p = document.createElement('p')
  p.textContent = detail
  p.style.margin = '0'
  box.append(h, p)
  el.append(box)
  host.append(el)
  return el
}
```

- [ ] **Step 3: Write `engine.ts`**

`packages/engine/src/engine.ts`:
```ts
import * as THREE from 'three/webgpu'
import { BlockRegistry, type BlockDef } from './blocks/registry.ts'
import { EngineError, showErrorScreen } from './errors.ts'
import { GhostEdits } from './interact/ghostEdits.ts'
import { OrbitCamera } from './interact/orbitCamera.ts'
import { raycast, type RayHit, type Vec3Like } from './interact/raycast.ts'
import { meshTablesFrom } from './mesh/tables.ts'
import type { FromMesh, FromSim, SimInitOptions, ToMesh, ToSim } from './protocol.ts'
import { ChunkMeshes } from './render/chunkMeshes.ts'
import { createChunkMaterials } from './render/materials.ts'
import { MeshQueue, PRIORITY } from './render/meshQueue.ts'
import { buildTextureArray } from './render/textureArray.ts'
import type { Ack, Command, SetBlockCommand } from './sim/commands.ts'
import type { SimEvent } from './sim/simulation.ts'
import { createWorldBuffers } from './world/buffers.ts'
import { Layout, type WorldSize } from './world/layout.ts'
import { WorldReader } from './world/reader.ts'
import { voxelId } from './world/voxel.ts'

export interface EngineOptions {
  canvas: HTMLCanvasElement
  size?: WorldSize
  seed: number
  blocks: BlockDef[]
  textures: Record<string, string>
  simWorker: () => Worker
  sim?: SimInitOptions
  meshWorkers?: number
  forceWebGL?: boolean
}

export interface EngineEvents {
  ready: { chunks: number }
  tick: { tick: number; tickMs: number }
  event: SimEvent
  ack: Ack
  log: { message: string }
  fatal: { message: string }
}

export interface EngineStats {
  fps: number; frameMs: number; tick: number; tickMs: number
  meshQueue: number; meshInFlight: number; failedChunks: number
  slotsUsed: number; meshes: number; drawCalls: number; backend: 'webgpu' | 'webgl'
}

export interface Engine {
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly renderer: THREE.WebGPURenderer
  readonly blocks: BlockRegistry
  readonly layout: Layout
  readonly controls: OrbitCamera
  readonly world: { get(x: number, y: number, z: number): number; getLight(x: number, y: number, z: number): number }
  submit(cmd: Command): number
  raycast(origin: Vec3Like, dir: Vec3Like, maxDist?: number): RayHit | null
  pickScreen(clientX: number, clientY: number, maxDist?: number): RayHit | null
  setHighlight(pos: readonly [number, number, number] | null): void
  on<K extends keyof EngineEvents>(type: K, fn: (e: EngineEvents[K]) => void): () => void
  stats(): EngineStats
  dispose(): void
}

const CLIENT_ID = 0
const UPLOAD_BUDGET_MS = 4
const MAX_FAILURES = 3

class Emitter<E> {
  private readonly fns = new Map<keyof E, Set<(e: never) => void>>()
  on<K extends keyof E>(type: K, fn: (e: E[K]) => void): () => void {
    let set = this.fns.get(type)
    if (!set) { set = new Set(); this.fns.set(type, set) }
    set.add(fn as (e: never) => void)
    return () => { set!.delete(fn as (e: never) => void) }
  }
  emit<K extends keyof E>(type: K, e: E[K]): void {
    for (const fn of this.fns.get(type) ?? []) (fn as (e: E[K]) => void)(e)
  }
}

interface PoolSlot { worker: Worker; job: { id: number; chunk: number } | null }
type MeshResult = Extract<FromMesh, { type: 'result' }>

export async function createEngine(o: EngineOptions): Promise<Engine> {
  const { canvas } = o
  if (!globalThis.crossOriginIsolated) {
    showErrorScreen(canvas, 'Cross-origin isolation is off',
      'Elovox needs SharedArrayBuffer. Serve the page with "Cross-Origin-Opener-Policy: same-origin" and ' +
      '"Cross-Origin-Embedder-Policy: require-corp" (see apps/sandbox/vite.config.ts).')
    throw new EngineError('not-isolated', 'COOP/COEP headers missing: crossOriginIsolated is false')
  }

  const size: WorldSize = o.size ?? [1024, 128, 1024]
  const layout = new Layout(size)
  const registry = new BlockRegistry(o.blocks)
  const buffers = createWorldBuffers(size)
  const reader = new WorldReader(buffers, registry.opaque)
  const ghosts = new GhostEdits(layout)
  const queue = new MeshQueue()
  const events = new Emitter<EngineEvents>()
  const pages: SharedArrayBuffer[] = []

  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: o.forceWebGL ?? false })
  try {
    await renderer.init()
  } catch (err) {
    showErrorScreen(canvas, 'No WebGPU or WebGL2', `This browser could not create a GPU context: ${String(err)}`)
    throw new EngineError('no-gpu', String(err))
  }
  const backend: 'webgpu' | 'webgl' = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl'
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0xdfe3e6)
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 3000)
  const resize = () => {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  resize()
  const ro = new ResizeObserver(resize)
  ro.observe(canvas)

  const tex = await buildTextureArray(o.textures, registry.textureNames())
  const tables = meshTablesFrom(registry, registry.faceLayers(tex.layerOf))
  const chunkMeshes = new ChunkMeshes(layout, createChunkMaterials(tex.texture))
  scene.add(chunkMeshes.group)
  const highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
    new THREE.LineBasicNodeMaterial({ color: 0x1b1f24 }),
  )
  highlight.visible = false
  scene.add(highlight)

  const world = {
    get: (x: number, y: number, z: number) => ghosts.get(x, y, z) ?? reader.get(x, y, z),
    getLight: (x: number, y: number, z: number) => reader.getLight(x, y, z),
  }
  const heightAt = (x: number, z: number) => {
    const xi = Math.min(size[0] - 1, Math.max(0, Math.floor(x))), zi = Math.min(size[2] - 1, Math.max(0, Math.floor(z)))
    for (let y = size[1] - 1; y >= 0; y--) if (registry.solid[voxelId(world.get(xi, y, zi))]) return y + 1
    return 0
  }
  const controls = new OrbitCamera({ worldSize: size, heightAt })
  const detachControls = controls.attach(canvas)

  // ---- mesh worker pool ----
  const results: MeshResult[] = []
  const failures = new Map<number, number>()
  const failed = new Set<number>()
  const pool: PoolSlot[] = []
  let jobId = 0

  const markDirty = (ci: number, priority: number) => {
    if (failed.delete(ci)) failures.delete(ci)
    queue.mark(ci, priority)
  }
  const requeue = (ci: number) => {
    const p = queue.priorityOf(ci) ?? PRIORITY.DIRTY
    queue.finish(ci)
    queue.mark(ci, p)
  }
  const jobFailed = (ci: number, message: string) => {
    const n = (failures.get(ci) ?? 0) + 1
    failures.set(ci, n)
    if (n >= MAX_FAILURES) {
      queue.finish(ci)
      failed.add(ci)
      console.error(`[elovox] chunk ${ci} failed to mesh ${n} times; keeping its last mesh. ${message}`)
    } else {
      requeue(ci)
    }
  }
  const onMeshMessage = (slot: PoolSlot, m: FromMesh) => {
    slot.job = null
    if (m.type === 'result') { queue.finish(m.chunk); failures.delete(m.chunk); results.push(m) }
    else if (m.type === 'retry') requeue(m.chunk)
    else jobFailed(m.chunk, m.message)
  }
  const spawn = (i: number) => {
    const worker = new Worker(new URL('./mesh/mesh.worker.ts', import.meta.url), { type: 'module' })
    const slot: PoolSlot = { worker, job: null }
    worker.onmessage = (e: MessageEvent<FromMesh>) => onMeshMessage(slot, e.data)
    worker.onerror = (e) => {
      e.preventDefault()
      const job = slot.job
      worker.terminate()
      if (job) jobFailed(job.chunk, `mesh worker crashed: ${e.message}`)
      spawn(i)
    }
    worker.postMessage({ type: 'init', buffers, pages: [...pages], tables } satisfies ToMesh)
    pool[i] = slot
  }
  const poolSize = o.meshWorkers ?? Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 2))
  for (let i = 0; i < poolSize; i++) spawn(i)

  // ---- sim worker ----
  let lastTick = 0, lastTickMs = 0, slotsUsed = 0
  let fatal: string | null = null
  const sim = o.simWorker()
  const fail = (message: string) => {
    if (fatal) return
    fatal = message
    console.error(`[elovox] fatal: ${message}`)
    events.emit('fatal', { message })
    showErrorScreen(canvas, 'The simulation stopped', message)
  }
  const onTick = (m: Extract<FromSim, { type: 'tick' }>) => {
    lastTick = m.tick
    lastTickMs = m.tickMs
    slotsUsed = m.slotsUsed
    for (const a of m.acks) if (a.clientId === CLIENT_ID) for (const ci of ghosts.resolve(a.seq)) markDirty(ci, PRIORITY.GHOST)
    for (const ci of m.dirtyChunks) markDirty(ci, PRIORITY.DIRTY)
    for (const a of m.acks) events.emit('ack', a)
    for (const ev of m.events) events.emit('event', ev)
    events.emit('tick', { tick: m.tick, tickMs: m.tickMs })
  }
  const ready = new Promise<number>((resolve, reject) => {
    sim.onmessage = (e: MessageEvent<FromSim>) => {
      const m = e.data
      switch (m.type) {
        case 'page':
          pages[m.index] = m.page
          reader.addPage(m.index, m.page)
          for (const s of pool) s.worker.postMessage({ type: 'page', index: m.index, page: m.page } satisfies ToMesh)
          break
        case 'ready':
          slotsUsed = m.slotsUsed
          for (const ci of m.chunks) queue.mark(ci, PRIORITY.INITIAL)
          sim.postMessage({ type: 'start' } satisfies ToSim)
          events.emit('ready', { chunks: m.chunks.length })
          resolve(m.chunks.length)
          break
        case 'tick':
          onTick(m)
          break
        case 'log':
          console.info(`[elovox sim] ${m.message}`)
          events.emit('log', { message: m.message })
          break
        case 'fatal':
          fail(m.message)
          reject(new EngineError('fatal', m.message))
          break
      }
    }
    sim.onerror = (e) => {
      e.preventDefault()
      const message = `sim worker crashed: ${e.message}`
      fail(message)
      reject(new EngineError('fatal', message))
    }
  })
  sim.postMessage({ type: 'init', buffers, blocks: o.blocks, seed: o.seed, options: o.sim ?? {} } satisfies ToSim)

  // ---- frame loop ----
  const distanceTo = (ci: number) => {
    const [cx, cy, cz] = layout.chunkCoords(ci)
    const dx = cx * 32 + 16 - camera.position.x, dy = cy * 32 + 16 - camera.position.y, dz = cz * 32 + 16 - camera.position.z
    return dx * dx + dy * dy + dz * dz
  }
  const dispatch = () => {
    for (const slot of pool) {
      if (slot.job) continue
      const ci = queue.next(distanceTo)
      if (ci < 0) return
      const overrides = ghosts.size > 0 ? ghosts.overridesFor(ci) : []
      const msg: ToMesh = overrides.length > 0
        ? { type: 'job', id: ++jobId, chunk: ci, overrides }
        : { type: 'job', id: ++jobId, chunk: ci }
      slot.job = { id: msg.id, chunk: ci }
      slot.worker.postMessage(msg)
    }
  }
  const upload = () => {
    const start = performance.now()
    while (results.length > 0 && performance.now() - start < UPLOAD_BUDGET_MS) {
      const r = results.shift()!
      if (queue.accept(r.chunk, r.version)) chunkMeshes.apply(r.chunk, r.data)
    }
  }
  let last = performance.now(), fpsT = last, frames = 0, fps = 0, frameMs = 0
  renderer.setAnimationLoop(() => {
    const now = performance.now()
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    controls.update(dt)
    controls.apply(camera)
    dispatch()
    upload()
    renderer.render(scene, camera)
    frameMs = performance.now() - now
    frames++
    if (now - fpsT >= 500) { fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now }
  })

  await ready

  // ---- public API ----
  let seq = 0
  const pickable = (v: number) => { const id = voxelId(v); return id !== 0 && registry.liquid[id] === 0 }
  const rc = (origin: Vec3Like, dir: Vec3Like, maxDist = 256) => raycast(world.get, pickable, size, origin, dir, maxDist)
  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()

  return {
    scene, camera, renderer, blocks: registry, layout, controls, world,
    submit(cmd) {
      const s = ++seq
      if (cmd.type === 'setBlock') {
        const c = cmd as SetBlockCommand
        if (layout.inBounds(c.pos[0], c.pos[1], c.pos[2]) && Number.isInteger(c.voxel) && voxelId(c.voxel) < registry.count) {
          for (const ci of ghosts.add(s, c.pos[0], c.pos[1], c.pos[2], c.voxel)) markDirty(ci, PRIORITY.GHOST)
        }
      }
      sim.postMessage({ type: 'submit', clientId: CLIENT_ID, seq: s, cmd } satisfies ToSim)
      return s
    },
    raycast: rc,
    pickScreen(clientX, clientY, maxDist = 256) {
      const r = canvas.getBoundingClientRect()
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
      raycaster.setFromCamera(ndc, camera)
      return rc(raycaster.ray.origin, raycaster.ray.direction, maxDist)
    },
    setHighlight(pos) {
      highlight.visible = pos !== null
      if (pos) highlight.position.set(pos[0] + 0.5, pos[1] + 0.5, pos[2] + 0.5)
    },
    on: (type, fn) => events.on(type, fn),
    stats: () => ({
      fps, frameMs, tick: lastTick, tickMs: lastTickMs,
      meshQueue: queue.size, meshInFlight: queue.inFlightCount, failedChunks: failed.size,
      slotsUsed, meshes: chunkMeshes.meshCount, drawCalls: renderer.info.render.drawCalls, backend,
    }),
    dispose() {
      renderer.setAnimationLoop(null)
      sim.terminate()
      for (const s of pool) s.worker.terminate()
      detachControls()
      ro.disconnect()
      chunkMeshes.dispose()
      tex.texture.dispose()
      renderer.dispose()
    },
  }
}
```

- [ ] **Step 4: Export the public API**

Replace `packages/engine/src/index.ts`:
```ts
export { ENGINE_VERSION } from './version.ts'
export { createEngine, type Engine, type EngineEvents, type EngineOptions, type EngineStats } from './engine.ts'
export { EngineError } from './errors.ts'
export { BlockRegistry, LAYER, defineBlock, type BlockDef, type RenderLayer } from './blocks/registry.ts'
export { AIR, blockLight, packLight, packVoxel, skyLight, voxelId, voxelState, withState } from './world/voxel.ts'
export type { Ack, Command, FillRegionCommand, SetBlockCommand, Vec3 } from './sim/commands.ts'
export type { SimEvent } from './sim/simulation.ts'
export type { RayHit } from './interact/raycast.ts'
export type { WorldSize } from './world/layout.ts'
export type { SimInitOptions } from './protocol.ts'
```

- [ ] **Step 5: Boot the real engine from the sandbox**

`apps/sandbox/src/blocks.ts`:
```ts
import { defineBlock } from '@elovox/engine'

export const BLOCKS = [
  defineBlock({ name: 'stone', textures: 'stone' }),
  defineBlock({ name: 'dirt', textures: 'dirt' }),
  defineBlock({ name: 'grass', textures: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' }, decoration: 'grassTuft' }),
  defineBlock({ name: 'sand', textures: 'sand' }),
  defineBlock({ name: 'log', textures: { top: 'log_top', side: 'log_side', bottom: 'log_top' } }),
  defineBlock({ name: 'planks', textures: 'planks' }),
  defineBlock({ name: 'leaves', textures: 'leaves', layer: 'cutout' }),
  defineBlock({ name: 'glass', textures: 'glass', layer: 'translucent' }),
  defineBlock({ name: 'water', textures: 'water', liquid: true, solid: false }),
  defineBlock({ name: 'torch', textures: 'torch', layer: 'cutout', emits: 14, solid: false }),
]
```

`apps/sandbox/src/sim.worker.ts`:
```ts
import { runSimWorker, testGenerator } from '@elovox/engine/sim-worker'

runSimWorker({ generator: testGenerator })
```

`apps/sandbox/src/main.ts` (replaces the spike):
```ts
import { createEngine } from '@elovox/engine'
import { BLOCKS } from './blocks.ts'

const params = new URLSearchParams(location.search)
const n = Number(params.get('size') ?? 1024)
const engine = await createEngine({
  canvas: document.querySelector<HTMLCanvasElement>('#view')!,
  size: [n, 128, n],
  seed: Number(params.get('seed') ?? 1234),
  blocks: BLOCKS,
  textures: {},
  simWorker: () => new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' }),
  forceWebGL: params.has('webgl'),
})
Object.assign(window, { __elovox: { engine, ready: true } })
```

- [ ] **Step 6: Verify typecheck, unit tests and the live boot**

Run `npm run typecheck` and `npm test`. Expected: both clean.

Run `npm run dev`, then open `http://localhost:5173/?size=256`. Expected:
- Checker-textured rolling terrain, with exposed cliffs at the world edges.
- WASD and screen edges pan, the wheel zooms, and right-drag rotates.
- No console errors.

In the DevTools console, run:
`__elovox.engine.submit({ type: 'setBlock', pos: [128, 100, 128], voxel: __elovox.engine.blocks.id('stone') })`
A floating block should appear at once (the ghost), and `__elovox.engine.stats().slotsUsed` should be greater than 0.

Repeat with `?size=256&webgl`. Expected: the same result, with `stats().backend === 'webgl'`.

- [ ] **Step 7: Verify the startup error screens by hand**

- Temporarily delete the `headers: isolation` entry from `server` in `apps/sandbox/vite.config.ts` and reload. Expected: the overlay reads "Cross-origin isolation is off". Restore the line.
- In the DevTools console of a working page, run `__elovox.engine.dispose()`. Expected: the canvas stops updating and the console shows no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/engine/src packages/engine/test/scaffold.test.ts apps/sandbox/src
git commit -m "feat(engine): createEngine wiring sim worker, mesh pool, renderer and input"
```

---

### Task 21: Sandbox tools, painted textures, demo rules and HUD

**Files:**
- Create: `apps/sandbox/src/textures.ts`, `apps/sandbox/src/rules.ts`, `apps/sandbox/src/hud.ts`
- Modify: `apps/sandbox/src/sim.worker.ts`, `apps/sandbox/src/main.ts`

**Interfaces:**
- Consumes: `Engine`, `EngineStats`, `AIR`, `RayHit` from `@elovox/engine`; `defineRules`, `runSimWorker`, `testGenerator` from `@elovox/engine/sim-worker`.
- Produces: `paintTextures(): Record<string, string>` (data URLs), the default-export `RulesModule` in `rules.ts`, `createHud(engine, getSelected): () => void`, and a HUD element with `id="hud"`, which the e2e test relies on.

- [ ] **Step 1: Paint the textures procedurally**

`apps/sandbox/src/textures.ts`:
```ts
type Paint = (ctx: CanvasRenderingContext2D, rand: () => number) => void

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296
}

function tile(seed: number, paint: Paint): string {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  paint(c.getContext('2d')!, lcg(seed))
  return c.toDataURL('image/png')
}

function speckle(ctx: CanvasRenderingContext2D, r: () => number, base: string, spots: string[], count: number, size: number): void {
  ctx.fillStyle = base
  ctx.fillRect(0, 0, 64, 64)
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = spots[Math.floor(r() * spots.length)]!
    const s = Math.max(1, Math.round(size * (0.5 + r())))
    ctx.fillRect(Math.floor(r() * 64), Math.floor(r() * 64), s, s)
  }
}

export function paintTextures(): Record<string, string> {
  return {
    stone: tile(1, (c, r) => speckle(c, r, '#8f959e', ['#7e848d', '#a5abb3', '#737981'], 140, 6)),
    dirt: tile(2, (c, r) => speckle(c, r, '#7a4f33', ['#6a432b', '#8b5d3d', '#5e3a25'], 160, 5)),
    grass_top: tile(3, (c, r) => speckle(c, r, '#6fae3f', ['#7fc04a', '#5f9b35', '#8ccf55'], 240, 4)),
    grass_side: tile(4, (c, r) => {
      speckle(c, r, '#7a4f33', ['#6a432b', '#8b5d3d'], 120, 5)
      c.fillStyle = '#6fae3f'
      for (let x = 0; x < 64; x += 4) c.fillRect(x, 0, 4, 12 + Math.floor(r() * 10))
    }),
    sand: tile(5, (c, r) => speckle(c, r, '#dcc98f', ['#cfba7c', '#e8d8a3', '#c9b06e'], 200, 3)),
    log_top: tile(6, (c) => {
      c.fillStyle = '#a07a4a'
      c.fillRect(0, 0, 64, 64)
      c.strokeStyle = '#7d5a33'
      c.lineWidth = 3
      for (let rr = 6; rr < 32; rr += 7) { c.beginPath(); c.arc(32, 32, rr, 0, Math.PI * 2); c.stroke() }
    }),
    log_side: tile(7, (c, r) => {
      c.fillStyle = '#6e4b2a'
      c.fillRect(0, 0, 64, 64)
      c.fillStyle = '#5a3c21'
      for (let x = 0; x < 64; x += 6) c.fillRect(x + Math.floor(r() * 3), 0, 2, 64)
    }),
    planks: tile(8, (c, r) => {
      for (let y = 0; y < 64; y += 16) {
        c.fillStyle = r() < 0.5 ? '#b48a55' : '#a87f4c'
        c.fillRect(0, y, 64, 15)
        c.fillStyle = '#7d5a33'
        c.fillRect(0, y + 15, 64, 1)
      }
    }),
    leaves: tile(9, (c, r) => {
      speckle(c, r, '#4f8f35', ['#5fa040', '#3f7a2a', '#6bb04a'], 220, 5)
      for (let i = 0; i < 60; i++) c.clearRect(Math.floor(r() * 64), Math.floor(r() * 64), 3, 3)
    }),
    glass: tile(10, (c) => {
      c.fillStyle = 'rgba(215, 236, 255, 0.22)'
      c.fillRect(0, 0, 64, 64)
      c.strokeStyle = 'rgba(255, 255, 255, 0.85)'
      c.lineWidth = 4
      c.strokeRect(2, 2, 60, 60)
    }),
    water: tile(11, (c, r) => {
      c.fillStyle = 'rgba(64, 140, 210, 0.78)'
      c.fillRect(0, 0, 64, 64)
      c.fillStyle = 'rgba(160, 210, 245, 0.55)'
      for (let i = 0; i < 18; i++) c.fillRect(Math.floor(r() * 56), Math.floor(r() * 64), 8, 2)
    }),
    torch: tile(12, (c) => {
      c.clearRect(0, 0, 64, 64)
      c.fillStyle = '#6e4b2a'
      c.fillRect(28, 26, 8, 38)
      c.fillStyle = '#ffb02e'
      c.fillRect(26, 12, 12, 14)
      c.fillStyle = '#fff3a0'
      c.fillRect(29, 15, 6, 8)
    }),
  }
}
```

- [ ] **Step 2: Add the demo rules**

These two rules exist only to exercise the pipeline. The real simulations belong to sub-project 3.

`apps/sandbox/src/rules.ts`:
```ts
import { defineRules } from '@elovox/engine/sim-worker'

const AIR = 0

export default defineRules({
  blocks: {
    sand: {
      onNeighborChanged(ctx, x, y, z) { ctx.schedule(x, y, z, 2) },
      onScheduledTick(ctx, x, y, z, v) {
        if (y > 0 && ctx.isAir(ctx.get(x, y - 1, z))) { ctx.set(x, y, z, AIR); ctx.set(x, y - 1, z, v) }
      },
    },
    grass: {
      onRandomTick(ctx, x, y, z) {
        const dx = ctx.random() < 0.5 ? -1 : 1
        const dz = ctx.random() < 0.5 ? -1 : 1
        const dirt = ctx.id('dirt')
        for (const [nx, nz] of [[x + dx, z], [x, z + dz]] as const) {
          if (ctx.get(nx, y, nz) === dirt && ctx.isAir(ctx.get(nx, y + 1, nz))) ctx.set(nx, y, nz, ctx.id('grass'))
        }
      },
    },
  },
})
```

Update `apps/sandbox/src/sim.worker.ts`:
```ts
import { runSimWorker, testGenerator } from '@elovox/engine/sim-worker'
import rules from './rules.ts'

runSimWorker({ rules, generator: testGenerator })
```

- [ ] **Step 3: Add the HUD**

`apps/sandbox/src/hud.ts`:
```ts
import type { Engine } from '@elovox/engine'

export function createHud(engine: Engine, getSelected: () => string): () => void {
  const el = document.createElement('div')
  el.id = 'hud'
  Object.assign(el.style, {
    position: 'fixed', top: '12px', left: '12px', padding: '10px 12px', borderRadius: '8px',
    background: 'rgba(255, 255, 255, 0.82)', color: '#1b1f24', font: '12px/1.45 ui-monospace, Menlo, Consolas, monospace',
    whiteSpace: 'pre', pointerEvents: 'none', zIndex: '5',
  })
  document.body.append(el)
  const render = () => {
    const s = engine.stats()
    el.textContent = [
      `fps ${s.fps.toFixed(0)}   frame ${s.frameMs.toFixed(1)} ms   [${s.backend}]`,
      `tick ${s.tick}   ${s.tickMs.toFixed(2)} ms`,
      `mesh queue ${s.meshQueue}   in flight ${s.meshInFlight}   failed ${s.failedChunks}`,
      `slots ${s.slotsUsed}   meshes ${s.meshes}   draws ${s.drawCalls}`,
      `block [${getSelected()}]   1–9 select · LMB dig · RMB place · WASD/edges pan · RMB-drag rotate · wheel zoom`,
    ].join('\n')
  }
  render()
  const timer = setInterval(render, 250)
  return () => { clearInterval(timer); el.remove() }
}
```

- [ ] **Step 4: Wire the tools into main**

Replace `apps/sandbox/src/main.ts`:
```ts
import { AIR, createEngine } from '@elovox/engine'
import { BLOCKS } from './blocks.ts'
import { createHud } from './hud.ts'
import { paintTextures } from './textures.ts'

const HOTBAR = ['stone', 'dirt', 'grass', 'sand', 'planks', 'log', 'leaves', 'glass', 'torch']
const params = new URLSearchParams(location.search)
const n = Number(params.get('size') ?? 1024)
const canvas = document.querySelector<HTMLCanvasElement>('#view')!

const engine = await createEngine({
  canvas,
  size: [n, 128, n],
  seed: Number(params.get('seed') ?? 1234),
  blocks: BLOCKS,
  textures: paintTextures(),
  simWorker: () => new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' }),
  forceWebGL: params.has('webgl'),
})

let selected = 0
createHud(engine, () => HOTBAR[selected]!)
window.addEventListener('keydown', (e) => {
  const k = Number(e.key)
  if (k >= 1 && k <= HOTBAR.length) selected = k - 1
})

canvas.addEventListener('pointermove', (e) => {
  engine.setHighlight(engine.pickScreen(e.clientX, e.clientY)?.pos ?? null)
})
canvas.addEventListener('pointerup', (e) => {
  const hit = engine.pickScreen(e.clientX, e.clientY)
  if (!hit) return
  if (e.button === 0) {
    engine.submit({ type: 'setBlock', pos: hit.pos, voxel: AIR })
  } else if (e.button === 2 && engine.controls.lastDragDistance < 6) {
    const [nx, ny, nz] = hit.normal
    if (nx === 0 && ny === 0 && nz === 0) return
    const p = [hit.pos[0] + nx, hit.pos[1] + ny, hit.pos[2] + nz] as const
    if (!engine.layout.inBounds(p[0], p[1], p[2])) return
    engine.submit({ type: 'setBlock', pos: p, voxel: engine.blocks.id(HOTBAR[selected]!) })
  }
  engine.setHighlight(engine.pickScreen(e.clientX, e.clientY)?.pos ?? null)
})

Object.assign(window, { __elovox: { engine, ready: true } })
```

- [ ] **Step 5: Verify by hand**

Run `npm run dev` and open `http://localhost:5173/?size=256`. Expected:
- Painted textures: green grass tops, grass sides with a green fringe at the **top**, and grey stone.
- Soft AO in the corners, and exposed dirt/stone cliffs at the world edges.
- **Left click** removes a block instantly. **Right click** places the selected block on the face you clicked. A right-**drag** rotates without placing.
- Placing `sand` in the air makes it fall. A dug hole edged with dirt slowly turns green.
- Placing a `torch` inside a dug cave lights its surroundings.
- The HUD updates four times a second.

- [ ] **Step 6: Commit**

```bash
git add apps/sandbox/src
git commit -m "feat(sandbox): painted textures, dig/place tools, demo rules and HUD"
```

---

### Task 22: E2E smoke test, tick benchmark, and final verification

**Files:**
- Create: `apps/sandbox/playwright.config.ts`, `apps/sandbox/e2e/smoke.spec.ts`, `packages/engine/bench/tick.bench.ts`

**Interfaces:**
- Consumes: `window.__elovox = { engine, ready }` (Task 21) and `#hud` (Task 21).

- [ ] **Step 1: Write the Playwright config and the smoke test**

`apps/sandbox/playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  use: { baseURL: 'http://localhost:5173', headless: true },
  webServer: { command: 'npm run dev', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 60_000 },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu'] } } }],
})
```

`apps/sandbox/e2e/smoke.spec.ts`:
```ts
import { expect, test } from '@playwright/test'

test('sandbox boots isolated, renders, and round-trips an edit', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/?size=128')
  await page.waitForFunction(() => (window as unknown as { __elovox?: { ready: boolean } }).__elovox?.ready === true, null, { timeout: 90_000 })
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)

  const r = await page.evaluate(async () => {
    type A = { seq: number; ok: boolean }
    const e = (window as unknown as { __elovox: { engine: {
      submit(c: unknown): number
      on(t: 'ack', fn: (a: A) => void): () => void
      world: { get(x: number, y: number, z: number): number }
      blocks: { id(n: string): number }
    } } }).__elovox.engine
    const ack = (seq: number) => new Promise<A>((res) => { const off = e.on('ack', (a) => { if (a.seq === seq) { off(); res(a) } }) })
    const stone = e.blocks.id('stone')
    const s1 = e.submit({ type: 'setBlock', pos: [10, 120, 10], voxel: stone })
    const ghost = e.world.get(10, 120, 10)
    const a1 = await ack(s1)
    const placed = e.world.get(10, 120, 10)
    const s2 = e.submit({ type: 'setBlock', pos: [10, 120, 10], voxel: 0 })
    const a2 = await ack(s2)
    const bad = await ack(e.submit({ type: 'setBlock', pos: [10, 128, 10], voxel: stone }))
    return { stone, ghost, a1: a1.ok, placed, a2: a2.ok, removed: e.world.get(10, 120, 10), bad: bad.ok }
  })
  expect(r).toEqual({ stone: r.stone, ghost: r.stone, a1: true, placed: r.stone, a2: true, removed: 0, bad: false })

  await expect(page.locator('#hud')).toContainText('fps')
  const shot = await page.locator('canvas').screenshot()
  expect(shot.byteLength).toBeGreaterThan(10_000) // a blank canvas compresses to far less
  expect(errors).toEqual([])
})
```

- [ ] **Step 2: Run the e2e test**

Run:
```bash
npx playwright install chromium
npm run e2e
```
Expected: 1 test passes. Headless Chromium usually has no WebGPU, so this exercises the WebGL2 fallback; that's intended.
If it fails on `errors`, read the logged messages. A "missing texture" message is a `console.warn` and doesn't count; anything at error level is a bug to fix.

- [ ] **Step 3: Write and run the tick benchmark**

`packages/engine/bench/tick.bench.ts`:
```ts
import { bench, describe } from 'vitest'
import { defineBlock } from '../src/blocks/registry.ts'
import { defineRules } from '../src/sim/rules.ts'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { TEST_BLOCKS } from '../test/helpers.ts'

describe('simulation tick', () => {
  const blocks = [...TEST_BLOCKS, defineBlock({ name: 'ticker' })]
  const rules = defineRules({
    blocks: {
      ticker: {
        onNeighborChanged(ctx, x, y, z) { ctx.schedule(x, y, z, 1) },
        onScheduledTick(ctx, x, y, z) { ctx.schedule(x, y, z, 1) },
      },
    },
  })
  const sim = new Simulation({ buffers: createWorldBuffers([256, 64, 256]), blocks, rules, seed: 1, workCap: 200_000 })
  let seq = 0
  for (let x = 0; x < 100; x++) for (let z = 0; z < 100; z++) sim.submit(0, seq++, { type: 'setBlock', pos: [x * 2, 40, z * 2], voxel: 8 })
  sim.step()
  sim.step() // steady state: 10 000 scheduled updates per tick
  bench('tick with 10k scheduled updates', () => { sim.step() }, { time: 2000 })
})
```

Run `npm run bench`. Expected: both benchmarks report.
- The tick has to fit well inside its 50 ms budget. Aim for under 10 ms; if it's over 25 ms, profile before moving on.
- The mesher must stay under 3 ms.

Record both numbers.

- [ ] **Step 4: Run the full automated suite**

Run `npm run typecheck`, `npm test` and `npm run e2e`. Expected: all clean. Paste the summary lines into your report.

- [ ] **Step 5: Verify performance on the target machine**

Run `npm run dev` and open `http://localhost:5173/` (the full 1024 × 128 × 1024 world) in desktop Chrome on a mid-range laptop, then:
1. Wait until the HUD shows `mesh queue 0` and `in flight 0`. Record how long that took.
2. At the default 3/4 view, record `fps`, `frame`, `draws` and `slots`. Then pan around for 30 seconds and record the lowest fps you see.
3. Dig and place 20 blocks quickly. The edit must appear in the same or the next frame, with no black flash on the faces it exposes.

Success means 60 fps at the 3/4 view and instant edits.
If fps < 60, don't claim success. Record the numbers, capture a Chrome Performance profile, and report the hotspot:
- **Draw-call bound** (`draws` in the thousands, with GPU idle time): the planned upgrade in spec §5 is `BatchedMesh`/multi-draw.
- **Main-thread bound**: check `upload()` and `heightAt` first.

- [ ] **Step 6: Commit**

```bash
git add apps/sandbox/playwright.config.ts apps/sandbox/e2e packages/engine/bench/tick.bench.ts
git commit -m "test: e2e smoke test and tick benchmark; record perf results"
```
Put the measured numbers from Steps 3 and 5 in the commit body.

---

## Spec coverage map

| Spec section | Tasks |
|---|---|
| §2 Threading (SAB, single writer, pool, COOP/COEP) | 1, 4, 5, 14, 20 |
| §3 Coordinates, voxel/light encoding, layout, uniform chunks, pages, seqlock | 2, 4, 5 |
| §3 Block registry | 3 |
| §3 Light flood fill, implied light breaking uniformity | 4, 7 |
| §4 Tick loop order, catch-up cap | 9, 14 |
| §4 Commands, log, acks, validation | 8, 9 |
| §4 Ghost edits | 16, 20 |
| §4 Rule API, determinism rules, work cap | 9, 10 |
| §5 Renderer, mesh jobs, greedy + AO + flip, packed vertex | 11, 12, 14, 18 |
| §5 Render layers, liquids | 12, 13, 18 |
| §5 Mesh queue priorities, upload budget | 16, 20 |
| §5 Textures, lighting formula | 17, 18 |
| §5 Draw calls, raycast, highlight, orbit camera | 15, 18, 19, 20 |
| §6 Package layout, public API, generators | 1, 10, 14, 20 |
| §7 Error handling table | 4, 9, 14, 17, 20 |
| §8 Testing (unit, determinism, concurrency, bench, e2e) | 2–17, 19, 22 |
| Success criteria (60 fps, 2-frame edits) | 22 |
