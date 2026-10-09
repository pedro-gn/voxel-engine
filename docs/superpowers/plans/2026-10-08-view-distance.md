# View Distance (4b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Meet fps p5 ≥ 60 on the 1024² worlds at the default view distance with an identical picture (part 1), then add
`Quality.viewDistance`: nothing beyond R is drawn, and a fog edge dissolves it into the sky (part 2).

**Architecture:**
- Part 1 replaces three's per-chunk BatchedMesh cull with the engine's own. It runs over precomputed chunk spheres in both
  passes, with no sort. It also detaches hidden decoration meshes from the scene graph, and enters REGION 8 only on a
  measured gain.
- Part 2 threads one number, `Quality.viewDistance`, through `Visuals.frame`:
  - region and chunk visibility (`ChunkMeshes.beginFrame`);
  - the decoration radius, the water hook (`WaterSurface.setRange`) and the shadow reach;
  - `camera.far`;
  - a height-independent edge term in the fog (`sky.ts`).
- At `Infinity` (the default) every one of these is a no-op.

**Tech Stack:** TypeScript, three.js r186 (WebGPU/WebGL2, TSL), vitest 4, Playwright (Edge), Vite 8.

**Spec:** `docs/superpowers/specs/2026-10-08-view-distance-design.md` (approved 661769d, with the three expert notes
folded in here: Task 9 Step 1, Task 2/§`threeCull` doc, Task 3 Step 8).

## Global Constraints

- Default `viewDistance` is `Infinity`. At the default every visible pixel stays as on `main`: pixel diff ≤ 0.5% of
  pixels, channel tolerance 8, WebGPU and WebGL2.
- Gate: fps p5 ≥ 60, worse of two runs, at all 4 poses (orbit 70, orbit 400, orbit 400 at pitch 0.3, ground at pitch
  0.15 / distance 8) in `?scene=world&size=1024` and `?scene=terrain&size=1024`, at the default R.
- A finite view distance is `Infinity` or a finite number in [64, 4096] blocks.
- Edge band: `smoothstep(R · 0.75, R, viewDistance)`, max'ed with the fog factor. `camera.far = R + 64`, or 3000 at
  `Infinity`.
- Water: the only change in `render/water/` is the `waterSurface.ts` hook of spec §5.2 (`inRange`, `setRange`, `near`).
  Never touch `surfaceView.ts` or the water materials (`render/water.ts`).
- Shared files (`engine.ts`, `index.ts`, `EngineStats`, `settings.ts`, sandbox `main.ts`, `controls.ts`, `hud.ts`):
  - small additive hunks only;
  - new fields and exports go on their own lines;
  - no reformatting.
- Benchmarks used as evidence run only inside an expert-granted quiet window.
  - Use the production build, Edge headed, port 5181, and record free RAM at start and end. Abort if free RAM is under 8 GB.
  - Attribute gains with an interleaved alternating-order A/B in one session (A B B A A B). Gates use the worse of two runs.
- Commits use `type(scope): message`, with no Co-Authored-By trailer. Never push or merge.
- Shell output that is evidence goes to a file first, and is read from there.

## Review Focus

1. **Shadow casters just beyond R** (a mountain at R + 20 at sunset casting into the 0.75R–R band). They are culled in
   the shadow pass too, so their shadow disappears. The band is fogged and shadows fade by `min(shadowDistance, R)`, so it
   must not show as a hard shadow edge. Task 8 Step 6 pins that shadow reach ≤ R.
2. **Switching R back to `Infinity` at runtime** must restore everything: regions, unbatched meshes, water slots,
   `camera.far` 3000, edge uniform off, and fog node back to plain fog (or null with fog off). This is tested in Tasks 8,
   9 and 7.
3. **`effects.fog = false` with a finite R** must still fade (edge-only node), and with R = `Infinity` there must be no
   fog node at all, as on `main` (Task 9 Step 3).
4. **A remesh, grow or compaction of a batch between passes** must not leave stale draw ranges, because the cull reads
   three's `_geometryInfo` at cull time and keeps no copy (Task 2 Step 6).
5. **Camera inside a region or chunk** has distance 0 and is always in range. The camera below y 0 or above the world top
   is still in range by box distance (Task 1 Step 1 cases).

## File Structure

| File | Responsibility |
|---|---|
| `packages/engine/src/render/viewDistance.ts` (new) | Pure helpers: box distance, `boxInRange`, `cameraFar`, `edgeBand`, constants |
| `packages/engine/src/render/chunkCull.ts` (new) | Pure: frustum planes, sphere test, `buildDrawList` over three's batch records |
| `packages/engine/src/render/chunkBatches.ts` | Own cull wiring, region option, slot sizes, `beginFrame`, drawn count, retired buffers, `PassGuard.reset` |
| `packages/engine/src/render/chunkMeshes.ts` | Forwards options and `beginFrame`; unbatched range visibility; `drawnCount` |
| `packages/engine/src/render/decorations/decorationMeshes.ts` | Hidden meshes leave the group; re-select after ≥ 2 blocks |
| `packages/engine/src/render/water/waterSurface.ts` | The one `setRange` hook |
| `packages/engine/src/render/sky.ts` | Edge term, edge-only fog node, `fogFor` |
| `packages/engine/src/render/visuals.ts` | Wires R each frame; shadow clamp; `camera.far`; fog node selection |
| `packages/engine/src/render/settings.ts` | `Quality.viewDistance` |
| `packages/engine/src/engine.ts` | `threeCull` and `regionChunks` options (@internal); the `chunksDrawn` stat; the `shadowCasters` doc |
| `apps/sandbox/src/main.ts`, `controls.ts` | `?cull=three`, `?region=`, `?view=`, view-distance field |
| `apps/sandbox/e2e/view-bench.spec.ts` | Poses, edit-latency probe, edit max-CPU probe, batch memory |
| `apps/sandbox/bench/viewAB.mjs` (new) | Interleaved A/B runner over prebuilt bundles |
| `apps/sandbox/e2e/batching.spec.ts` | Own cull vs `?cull=three` pixel diff; no "normal" warning |
| `apps/sandbox/e2e/view-distance.spec.ts` (new) | R behaviour, fog coverage, checkpoint screenshots |

---

## Phase 0 — tooling

### Task 0: A/B runner and bench probes

**Files:**
- Create: `apps/sandbox/bench/viewAB.mjs`
- Modify: `apps/sandbox/e2e/view-bench.spec.ts`

**Interfaces:**
- Produces:
  - `VIEW_AB_VARIANTS` (JSON `{ "<name>": { "dist": "<abs dir>", "query": "<extra query>" } }`), `VIEW_AB_ORDER`
    (e.g. `ABBAAB`, letters = first letters of names), `VIEW_AB_SCENES` (default `world,terrain`), `VIEW_AB_OUT` (json
    path).
  - view-bench output gains `probes: { editFrames: number[]; editMaxCpu: number; batchBytes: number }` when
    `VIEW_PROBES=1`.

- [ ] **Step 1: Add the probes to `view-bench.spec.ts`.** After the pose loop, before writing the result:

```ts
  if (process.env.VIEW_PROBES) {
    out.probes = await page.evaluate(async () => {
      const e = (window as W).__elovox!.engine
      const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()))
      const [tx, , tz] = e.controls.current.target
      const editFrames: number[] = []
      for (let i = 0; i < 10; i++) {
        const x = Math.floor(tx) + i * 3, z = Math.floor(tz)
        let y = 127
        while (y > 0 && e.world.get(x, y, z) === 0) y--
        const ci = e.layout.chunkIndex(x >> 5, y >> 5, z >> 5)
        const before = e.meshVersion(ci)
        e.submit({ type: 'setBlock', pos: [x, y, z], voxel: 0 })
        let frames = 0
        while (e.meshVersion(ci) === before && frames < 120) { await frame(); frames++ }
        editFrames.push(frames)
        await frame()
      }
      // A 128² terrain edit next to the camera: the largest CPU frame while it remeshes.
      let editMaxCpu = 0
      const x0 = Math.max(0, Math.floor(tx) - 64), z0 = Math.max(0, Math.floor(tz) - 64)
      e.submit({ type: 'fillRegion', min: [x0, 60, z0], max: [x0 + 127, 63, z0 + 127], voxel: 0 })
      const t0 = performance.now()
      while (performance.now() - t0 < 3000) { await frame(); editMaxCpu = Math.max(editMaxCpu, e.stats().frameMs) }
      const s = e.stats() as unknown as { batchBytes?: number }
      return { editFrames, editMaxCpu: Math.round(editMaxCpu * 100) / 100, batchBytes: s.batchBytes ?? -1 }
    })
  }
```

`batchBytes` reads `-1` until Task 4 adds the stat. That is intended: the probe runs before and after.

- [ ] **Step 2: Write `apps/sandbox/bench/viewAB.mjs`.**

```js
// Interleaved A/B of prebuilt sandbox bundles on the view bench (spec 4b §6). One preview server per slot, port 5181.
// VIEW_AB_VARIANTS='{"main":{"dist":"C:/…/ab/main","query":""},"branch":{"dist":"C:/…/ab/branch","query":""}}'
// VIEW_AB_ORDER=mbbmmb (first letters) VIEW_AB_SCENES=world,terrain VIEW_AB_OUT=…/ab.json node apps/sandbox/bench/viewAB.mjs
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sandbox = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(sandbox, '../..')
const vite = join(root, 'node_modules/vite/bin/vite.js')
const playwright = join(root, 'node_modules/@playwright/test/cli.js')
const variants = JSON.parse(process.env.VIEW_AB_VARIANTS)
const order = (process.env.VIEW_AB_ORDER ?? 'ABBAAB').split('')
const scenes = (process.env.VIEW_AB_SCENES ?? 'world,terrain').split(',')
const outPath = process.env.VIEW_AB_OUT ?? join(sandbox, 'test-results/view-ab.json')
const byLetter = Object.fromEntries(Object.keys(variants).map(n => [n[0], n]))

async function waitFor(url, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { try { if ((await fetch(url)).ok) return } catch {} await new Promise(r => setTimeout(r, 300)) }
  throw new Error(`no server at ${url}`)
}
const runs = []
for (const letter of order) {
  const name = byLetter[letter]
  if (!name) throw new Error(`order letter ${letter} names no variant`)
  const v = variants[name]
  const server = spawn(process.execPath, [vite, 'preview', '--outDir', v.dist, '--port', '5181', '--strictPort'], { cwd: sandbox, stdio: 'ignore' })
  try {
    await waitFor('http://localhost:5181/', 30_000)
    for (const scene of scenes) {
      const out = join(dirname(outPath), `ab-${runs.length}-${name}-${scene}.json`)
      const query = `scene=${scene}&size=1024&gpu${v.query ? `&${v.query}` : ''}`
      const r = spawnSync(process.execPath, [playwright, 'test', 'e2e/view-bench.spec.ts', '--workers=1', '--headed'], {
        cwd: sandbox, stdio: 'inherit',
        env: { ...process.env, BENCH_VIEW: '1', VIEW_QUERY: query, VIEW_BENCH_OUT: out, E2E_PORT: '5181', E2E_PREVIEW: '1', E2E_CHANNEL: 'msedge' },
      })
      if (r.status !== 0) throw new Error(`bench failed: ${name} ${scene}`)
      runs.push({ variant: name, scene, ...JSON.parse(readFileSync(out, 'utf8')) })
    }
  } finally { server.kill() }
}
// Per variant, scene and pose: worst fps p5, median of the CPU medians, max GPU ms.
const summary = {}
for (const r of runs) for (const [pose, p] of Object.entries(r.poses)) {
  if (!p || typeof p.fpsP5 !== 'number') continue
  const k = `${r.variant} ${r.scene} ${pose}`
  const s = summary[k] ??= { fpsP5: Infinity, cpu: [], gpuMs: 0 }
  s.fpsP5 = Math.min(s.fpsP5, p.fpsP5); s.cpu.push(p.cpuMedian); s.gpuMs = Math.max(s.gpuMs, p.gpuMs ?? 0)
}
for (const s of Object.values(summary)) { const c = s.cpu.sort((a, b) => a - b); s.cpuMedian = c[Math.floor(c.length / 2)]; delete s.cpu }
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify({ date: new Date().toISOString(), order: order.join(''), variants, runs, summary }, null, 2))
console.log(JSON.stringify(summary, null, 2))
```

- [ ] **Step 3: Smoke-check the runner outside a window, with tiny windows.** Numbers are not evidence. Build once:

```bash
cd apps/sandbox && npx vite build --outDir C:/Users/pedro/AppData/Local/Temp/claude/C--Users-pedro-Desktop-Projetos-voxel-engine/1797a91b-bf9b-4f33-91bd-6ff03649229d/scratchpad/ab/head --emptyOutDir
```

Then run, writing to a file, with `VIEW_WINDOW_MS=500`, `VIEW_AB_SCENES=world`, `VIEW_AB_ORDER=hh`,
`VIEW_AB_VARIANTS={"head":{"dist":"<that dir>","query":"size=256"}}`. Because `size=` appears twice, the later one wins.
The extra `size=256` keeps it light. Expected: exit 0, two runs in the JSON, and a summary line per pose.

- [ ] **Step 4: Commit.**

```bash
git add apps/sandbox/bench/viewAB.mjs apps/sandbox/e2e/view-bench.spec.ts
git commit -m "test(view): interleaved A/B runner and edit-latency, edit-CPU and batch-memory probes"
```

---

## Phase 1 — CPU cuts, same picture

### Task 1: `viewDistance.ts` helpers

**Files:**
- Create: `packages/engine/src/render/viewDistance.ts`
- Test: `packages/engine/test/viewDistance.test.ts`

**Interfaces:**
- Produces:
  - `boxDistanceSq(px, py, pz, x0, y0, z0, x1, y1, z1): number`
  - `boxInRange(eye: Vec3Like, range: number, x0, y0, z0, x1, y1, z1): boolean`
  - `chunkInRange(eye: Vec3Like, range: number, cx: number, cy: number, cz: number): boolean` (centre coordinates)
  - `cameraFar(range: number): number`
  - `edgeBand(range: number): [near: number, far: number]`
  - `DEFAULT_CAMERA_FAR = 3000`, `EDGE_SHARE = 0.25`, `FAR_MARGIN = 64`
  - `Vec3Like = { x: number; y: number; z: number }`

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_CAMERA_FAR, boxDistanceSq, boxInRange, cameraFar, chunkInRange, edgeBand } from '../src/render/viewDistance.ts'

describe('viewDistance helpers', () => {
  it('measures the distance to a box\'s nearest point, 0 inside', () => {
    expect(boxDistanceSq(5, 5, 5, 0, 0, 0, 10, 10, 10)).toBe(0)
    expect(boxDistanceSq(13, 5, 5, 0, 0, 0, 10, 10, 10)).toBe(9)
    expect(boxDistanceSq(13, 14, 5, 0, 0, 0, 10, 10, 10)).toBe(9 + 16)
    expect(boxDistanceSq(-3, -4, 5, 0, 0, 0, 10, 10, 10)).toBe(25)
  })
  it('keeps everything at Infinity, and a box exactly at range', () => {
    expect(boxInRange({ x: 1e9, y: 0, z: 0 }, Infinity, 0, 0, 0, 1, 1, 1)).toBe(true)
    expect(boxInRange({ x: 20, y: 0, z: 0 }, 10, 0, 0, 0, 10, 10, 10)).toBe(true)
    expect(boxInRange({ x: 20.01, y: 0, z: 0 }, 10, 0, 0, 0, 10, 10, 10)).toBe(false)
  })
  it('tests a chunk by its 32³ box around its centre, also with the eye below or above the world', () => {
    expect(chunkInRange({ x: 16, y: -50, z: 16 }, 50, 16, 16, 16)).toBe(true) // 50 below the box bottom at y 0
    expect(chunkInRange({ x: 16, y: -51, z: 16 }, 50, 16, 16, 16)).toBe(false)
    expect(chunkInRange({ x: 100, y: 16, z: 16 }, 68, 16, 16, 16)).toBe(true) // x face at 32
  })
  it('ties the far plane to R plus a chunk diagonal, 3000 at Infinity', () => {
    expect(cameraFar(Infinity)).toBe(DEFAULT_CAMERA_FAR)
    expect(cameraFar(256)).toBe(320)
  })
  it('puts the edge band at [0.75 R, R], and out of reach at Infinity', () => {
    expect(edgeBand(400)).toEqual([300, 400])
    const [n, f] = edgeBand(Infinity)
    expect(n).toBeGreaterThan(1e29)
    expect(f).toBeGreaterThan(n) // smoothstep(n, f, d) is 0 for every real distance, never NaN
  })
})
```

- [ ] **Step 2: Run it to verify it fails.** `cd packages/engine && npx vitest run test/viewDistance.test.ts`. Expected:
  FAIL, cannot resolve `../src/render/viewDistance.ts`.

- [ ] **Step 3: Implement `viewDistance.ts`.**

```ts
/** Pure view-distance helpers (spec 4b §5): distances are 3D, from the eye to a box's nearest point, as the fog measures. */
export interface Vec3Like { x: number; y: number; z: number }

/** The camera far plane while the view distance is Infinity (as before 4b). */
export const DEFAULT_CAMERA_FAR = 3000
/** Share of R over which the edge fades to the fog colour: [R · (1 − EDGE_SHARE), R]. */
export const EDGE_SHARE = 0.25
/** Far plane past R: a chunk is kept while its nearest point is within R, so its far corner can be a chunk diagonal (55.4) beyond. */
export const FAR_MARGIN = 64
/** Edge band while the view distance is Infinity: smoothstep(OFF, 2 · OFF, d) is exactly 0 for any real distance. */
const OFF = 1e30

export function boxDistanceSq(px: number, py: number, pz: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  const dx = Math.max(x0 - px, 0, px - x1), dy = Math.max(y0 - py, 0, py - y1), dz = Math.max(z0 - pz, 0, pz - z1)
  return dx * dx + dy * dy + dz * dz
}

export function boxInRange(eye: Vec3Like, range: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
  return range === Infinity || boxDistanceSq(eye.x, eye.y, eye.z, x0, y0, z0, x1, y1, z1) <= range * range
}

/** A chunk by its centre (cx, cy, cz): its 32³ box. */
export function chunkInRange(eye: Vec3Like, range: number, cx: number, cy: number, cz: number): boolean {
  return boxInRange(eye, range, cx - 16, cy - 16, cz - 16, cx + 16, cy + 16, cz + 16)
}

export function cameraFar(range: number): number {
  return range === Infinity ? DEFAULT_CAMERA_FAR : range + FAR_MARGIN
}

export function edgeBand(range: number): [number, number] {
  return range === Infinity ? [OFF, 2 * OFF] : [range * (1 - EDGE_SHARE), range]
}
```

- [ ] **Step 4: Run the test.** Same command. Expected: PASS (5 tests).

- [ ] **Step 5: Commit.** `git add` both files, then `git commit -m "feat(render): view-distance helpers (box distance, far plane, edge band)"`.

### Task 2: `chunkCull.ts`, the pure cull

**Files:**
- Create: `packages/engine/src/render/chunkCull.ts`
- Test: `packages/engine/test/chunkCull.test.ts`

**Interfaces:**
- Consumes: `chunkInRange`, `Vec3Like` (Task 1).
- Produces:
  - `CHUNK_SPHERE_RADIUS = 16 * Math.sqrt(3) + 0.5`
  - `frustumPlanes(frustum: THREE.Frustum, out?: Float64Array): Float64Array` (24 numbers: nx, ny, nz, constant × 6)
  - `sphereInFrustum(planes: Float64Array, x, y, z, r): boolean`
  - `interface InstanceRecord { active: boolean; visible: boolean; geometryIndex: number }`
  - `interface GeometryRecord { start: number; count: number }`
  - `buildDrawList(instances: readonly InstanceRecord[], geometries: readonly GeometryRecord[], centres: Float32Array, planes: Float64Array, eye: Vec3Like, range: number, bytesPerElement: number, starts: Int32Array, counts: Int32Array, indirect: Uint32Array): number`

- [ ] **Step 1: Write the failing test.**

```ts
import * as THREE from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { CHUNK_SPHERE_RADIUS, buildDrawList, frustumPlanes, sphereInFrustum } from '../src/render/chunkCull.ts'

function frustumOf(camera: THREE.PerspectiveCamera): THREE.Frustum {
  camera.updateMatrixWorld()
  return new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem)
}
const cam = () => {
  const c = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 3000)
  c.position.set(100, 60, 100); c.lookAt(300, 20, 300)
  return c
}

describe('chunkCull', () => {
  it('agrees with three\'s Frustum.intersectsSphere on a grid of chunk spheres', () => {
    const f = frustumOf(cam()), planes = frustumPlanes(f)
    let inside = 0
    for (let x = 0; x < 1024; x += 32) for (let z = 0; z < 1024; z += 32) for (let y = 0; y < 128; y += 32) {
      const s = new THREE.Sphere(new THREE.Vector3(x + 16, y + 16, z + 16), CHUNK_SPHERE_RADIUS)
      const want = f.intersectsSphere(s)
      expect(sphereInFrustum(planes, x + 16, y + 16, z + 16, CHUNK_SPHERE_RADIUS)).toBe(want)
      if (want) inside++
    }
    expect(inside).toBeGreaterThan(50) // the grid really straddles the frustum
  })
  it('lists active, visible chunks in the frustum and within range, in instance order, with byte starts', () => {
    const planes = frustumPlanes(frustumOf(cam()))
    const instances = [
      { active: true, visible: true, geometryIndex: 2 }, // in view, near
      { active: false, visible: true, geometryIndex: 0 }, // freed
      { active: true, visible: true, geometryIndex: 1 }, // behind the camera
      { active: true, visible: true, geometryIndex: 0 }, // in view, far
      { active: true, visible: false, geometryIndex: 3 }, // hidden instance
    ]
    const geometries = [{ start: 0, count: 6 }, { start: 6, count: 12 }, { start: 18, count: 3 }, { start: 21, count: 6 }]
    const centres = Float32Array.from([208, 48, 208, 0, 0, 0, 16, 48, 16, 848, 16, 848, 208, 48, 208])
    const starts = new Int32Array(5), counts = new Int32Array(5), indirect = new Uint32Array(5)
    const eye = { x: 100, y: 60, z: 100 }
    expect(buildDrawList(instances, geometries, centres, planes, eye, Infinity, 4, starts, counts, indirect)).toBe(2)
    expect([...starts.subarray(0, 2)]).toEqual([18 * 4, 0])
    expect([...counts.subarray(0, 2)]).toEqual([3, 6])
    expect([...indirect.subarray(0, 2)]).toEqual([0, 3])
    expect(buildDrawList(instances, geometries, centres, planes, eye, 300, 4, starts, counts, indirect)).toBe(1) // the far one is out of range
    expect(indirect[0]).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails.** `npx vitest run test/chunkCull.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `chunkCull.ts`.**

```ts
import type * as THREE from 'three/webgpu'
import { chunkInRange, type Vec3Like } from './viewDistance.ts'

/** The bounding sphere chunk geometries carry (chunkMeshes.ts geometryOf): three's batch cull used the same one. */
export const CHUNK_SPHERE_RADIUS = 16 * Math.sqrt(3) + 0.5

/** A frustum's six planes as (nx, ny, nz, constant), in three's order. */
export function frustumPlanes(frustum: THREE.Frustum, out = new Float64Array(24)): Float64Array {
  for (let i = 0; i < 6; i++) {
    const p = frustum.planes[i]!
    out[i * 4] = p.normal.x; out[i * 4 + 1] = p.normal.y; out[i * 4 + 2] = p.normal.z; out[i * 4 + 3] = p.constant
  }
  return out
}

/** three's Frustum.intersectsSphere, over frustumPlanes. */
export function sphereInFrustum(planes: Float64Array, x: number, y: number, z: number, r: number): boolean {
  for (let i = 0; i < 24; i += 4) if (planes[i]! * x + planes[i + 1]! * y + planes[i + 2]! * z + planes[i + 3]! < -r) return false
  return true
}

/** three r186 BatchedMesh records this module reads: `_instanceInfo` and `_geometryInfo` entries. */
export interface InstanceRecord { active: boolean; visible: boolean; geometryIndex: number }
export interface GeometryRecord { start: number; count: number }

/**
 * The multi-draw list of one batch for one pass: every active, visible chunk whose sphere meets the frustum and whose box
 * is within `range` of `eye`, in instance order (opaque and alpha-tested layers depth-test, so order does not change the
 * picture). Geometry ranges are read now, never cached, so remeshes and compaction between passes are always current.
 */
export function buildDrawList(
  instances: readonly InstanceRecord[], geometries: readonly GeometryRecord[], centres: Float32Array, planes: Float64Array,
  eye: Vec3Like, range: number, bytesPerElement: number, starts: Int32Array, counts: Int32Array, indirect: Uint32Array,
): number {
  let n = 0
  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i]!
    if (!inst.active || !inst.visible) continue
    const x = centres[i * 3]!, y = centres[i * 3 + 1]!, z = centres[i * 3 + 2]!
    if (!sphereInFrustum(planes, x, y, z, CHUNK_SPHERE_RADIUS)) continue
    if (!chunkInRange(eye, range, x, y, z)) continue
    const g = geometries[inst.geometryIndex]!
    starts[n] = g.start * bytesPerElement
    counts[n] = g.count
    indirect[n] = i
    n++
  }
  return n
}
```

- [ ] **Step 4: Run the test.** Expected: PASS (2 tests).

- [ ] **Step 5: Commit.** `git commit -m "feat(render): pure chunk cull over precomputed spheres (frustum + view distance)"`.

- [ ] **Step 6: Add a Review Focus 4 test to `chunkCull.test.ts`.** A geometry whose `start` changes between two calls
  (compaction) is listed at its new start:

```ts
  it('reads geometry ranges at cull time, so a compaction between passes is seen', () => {
    const planes = frustumPlanes(frustumOf(cam()))
    const instances = [{ active: true, visible: true, geometryIndex: 0 }]
    const geometries = [{ start: 30, count: 6 }]
    const centres = Float32Array.from([208, 48, 208])
    const starts = new Int32Array(1), counts = new Int32Array(1), indirect = new Uint32Array(1)
    buildDrawList(instances, geometries, centres, planes, { x: 100, y: 60, z: 100 }, Infinity, 4, starts, counts, indirect)
    geometries[0]!.start = 6
    buildDrawList(instances, geometries, centres, planes, { x: 100, y: 60, z: 100 }, Infinity, 4, starts, counts, indirect)
    expect(starts[0]).toBe(24)
  })
```

  Run it (PASS), then commit with `test(render): chunk cull reads ranges at cull time`.

### Task 3: The engine's own batch cull in `ChunkBatches`

**Files:**
- Modify: `packages/engine/src/render/chunkBatches.ts`, `chunkMeshes.ts`, `visuals.ts`, `engine.ts`
- Modify: `apps/sandbox/src/main.ts`
- Test: `packages/engine/test/chunkBatches.test.ts`, `apps/sandbox/e2e/batching.spec.ts`

**Interfaces:**
- Consumes: `buildDrawList`, `frustumPlanes` (Task 2); `Vec3Like` (Task 1).
- Produces:
  - `new ChunkBatches(layout, material, name, castShadow, options?: ChunkBatchOptions)`, with
    `interface ChunkBatchOptions { threeCull?: boolean; region?: number; verticesPerSlot?: number; indicesPerSlot?: number }`
  - `ChunkBatches.beginFrame(eye: Vec3Like, range: number): void`
  - `ChunkBatches.drawnCount: number` (main-pass chunk draws in the current frame)
  - `ChunkMeshesOptions` gains `threeCull?: boolean; region?: number`
  - `ChunkMeshes.beginFrame(eye: Vec3Like, range: number): void`; `ChunkMeshes.drawnCount: number`
  - `PassGuard.depth: number`, `PassGuard.reset(): void`
  - `EngineOptions.threeCull?: boolean` (`@internal`)
  - `VisualsOptions.threeCull?: boolean`

- [ ] **Step 1: Write failing unit tests in `chunkBatches.test.ts`.** Add a helper and tests. The cull is called
  through the batch's `onBeforeRender`, as three calls it:

```ts
/** Runs a batch's onBeforeRender for `camera`, as three's renderer does, and returns its draw count. */
function render(b: THREE.BatchedMesh, camera: THREE.Camera): number {
  camera.updateMatrixWorld()
  ;(b.onBeforeRender as unknown as (...a: unknown[]) => void)(null, null, camera, b.geometry, b.material, null)
  ;(b.onAfterRender as unknown as (...a: unknown[]) => void)(null, null, camera, b.geometry, b.material, null)
  return (b as unknown as { _multiDrawCount: number })._multiDrawCount
}
const lookingAt = (x: number, z: number) => {
  const c = new THREE.PerspectiveCamera(50, 1, 0.1, 3000)
  c.position.set(x, 40, z - 60); c.lookAt(x, 0, z)
  return c
}

describe('ChunkBatches own cull', () => {
  it('turns three\'s per-instance cull and sort off, and draws what is in view', () => {
    const b = batches()
    for (let cx = 0; cx < REGION; cx++) b.set(layout.chunkIndex(cx, 0, 0), cx, 0, 0, quads(1))
    const mesh = bm(b)[0]!
    expect(mesh.perObjectFrustumCulled).toBe(false)
    expect(mesh.sortObjects).toBe(false)
    b.beginFrame({ x: 16, y: 40, z: -44 }, Infinity)
    expect(render(mesh, lookingAt(16, 16))).toBeGreaterThan(0)
    expect(render(mesh, lookingAt(16, 16))).toBeLessThan(REGION + 1)
    expect(b.drawnCount).toBeGreaterThan(0)
  })
  it('skips chunks beyond the view distance and hides regions entirely beyond it', () => {
    const b = batches()
    b.set(layout.chunkIndex(0, 0, 0), 0, 0, 0, quads(1))
    b.set(layout.chunkIndex(REGION, 0, 0), REGION, 0, 0, quads(1))
    b.beginFrame({ x: 16, y: 16, z: 16 }, 64)
    const [near, far] = bm(b)
    expect(near!.visible).toBe(true)
    expect(far!.visible).toBe(false) // region 1 starts at x 128: 112 > 64 away
    b.beginFrame({ x: 16, y: 16, z: 16 }, Infinity)
    expect(far!.visible).toBe(true)
  })
  it('keeps three\'s cull with threeCull', () => {
    const b = new ChunkBatches(layout, new THREE.MeshBasicMaterial(), 'opaque', true, { threeCull: true })
    b.set(0, 0, 0, 0, quads(1))
    expect(bm(b)[0]!.perObjectFrustumCulled).toBe(true)
    expect(bm(b)[0]!.sortObjects).toBe(true)
  })
  it('restores the outer pass\'s list after a nested pass', () => {
    const b = batches()
    for (let cx = 0; cx < REGION; cx++) b.set(layout.chunkIndex(cx, 0, 0), cx, 0, 0, quads(1))
    const mesh = bm(b)[0]!
    b.beginFrame({ x: 16, y: 40, z: -44 }, Infinity)
    const main = lookingAt(16, 16), shadow = lookingAt(1000, 1000) // sees nothing of this region
    main.updateMatrixWorld(); shadow.updateMatrixWorld()
    const call = (f: unknown, c: THREE.Camera) => (f as (...a: unknown[]) => void)(null, null, c, mesh.geometry, mesh.material, null)
    call(mesh.onBeforeRender, main)
    const outer = (mesh as unknown as { _multiDrawCount: number })._multiDrawCount
    call(mesh.onBeforeRender, shadow)
    expect((mesh as unknown as { _multiDrawCount: number })._multiDrawCount).toBe(0)
    call(mesh.onAfterRender, shadow) // the nested pass ends: main's list again
    expect((mesh as unknown as { _multiDrawCount: number })._multiDrawCount).toBe(outer)
    call(mesh.onAfterRender, main)
  })
})

describe('PassGuard reset', () => {
  it('forgets a stack a throwing render left behind', () => {
    const g = new PassGuard()
    g.enter(new THREE.PerspectiveCamera()); g.enter(new THREE.PerspectiveCamera())
    g.reset()
    expect(g.depth).toBe(0)
    expect(g.exit()).toBeNull()
  })
})
```

Also extend the internals test's key list with `'_instanceInfo', '_multiDrawStarts', '_multiDrawCounts', '_multiDrawCount', '_multiDrawBytesPerElement', '_visibilityChanged'`.

- [ ] **Step 2: Run to verify the failures.** `npx vitest run test/chunkBatches.test.ts`. Expected: the new tests FAIL
  (`beginFrame` is not a function; `perObjectFrustumCulled` is true).

- [ ] **Step 3: Implement in `chunkBatches.ts`.**
  - Extend `BatchInternals` with:

```ts
  _instanceInfo: InstanceRecord[]
  _geometryInfo: (GeometryRecord & { reservedVertexCount: number; reservedIndexCount: number })[]
  _multiDrawStarts: Int32Array
  _multiDrawCounts: Int32Array
  _multiDrawCount: number
  _multiDrawBytesPerElement: number
  _indirectTexture: THREE.DataTexture
```

  - `PassGuard` gains:

```ts
  get depth(): number { return this.stack.length }
  /** Drops the stack: called at the start of a frame, so a render that threw cannot leave a stale outer pass. */
  reset(): void { this.stack.length = 0 }
```

  - Replace the free function `guardNestedPasses(bm)` with a method `wire(batch)`. `Batch` becomes
    `{ mesh; freedVertices; freedIndices; centres: Float32Array; guard: PassGuard; drawn: number; box: THREE.Box3 }`.

```ts
  private wire(batch: Batch): void {
    const bm = batch.mesh, guard = batch.guard
    const three = bm.onBeforeRender.bind(bm) as unknown as BeforeRender
    const before: BeforeRender = this.threeCull ? three : (_r, _s, camera) => this.cull(batch, camera)
    let lastGeometry: unknown = null, lastMaterial: unknown = null
    bm.onBeforeRender = ((renderer: unknown, scene: unknown, camera: THREE.Camera, geometry: unknown, material: unknown, group: unknown) => {
      guard.enter(camera)
      lastGeometry = geometry
      lastMaterial = material
      before(renderer, scene, camera, geometry, material, group)
    }) as unknown as typeof bm.onBeforeRender
    bm.onBeforeShadow = () => {}
    bm.onAfterRender = ((renderer: unknown) => {
      const outer = guard.exit()
      if (!outer) return
      internals(bm)._visibilityChanged = true
      before(renderer, null, outer, lastGeometry, lastMaterial, null)
    }) as unknown as typeof bm.onAfterRender
  }

  /** The engine's cull (spec §4.1): world-space frustum of the pass camera, precomputed chunk spheres, view distance, no sort. */
  private cull(batch: Batch, camera: THREE.Camera): void {
    const b = internals(batch.mesh)
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.projView, camera.coordinateSystem, (camera as { reversedDepth?: boolean }).reversedDepth ?? false)
    frustumPlanes(this.frustum, this.planes)
    const n = buildDrawList(b._instanceInfo, b._geometryInfo, batch.centres, this.planes, this.eye, this.range, 4,
      b._multiDrawStarts, b._multiDrawCounts, b._indirectTexture.image.data as Uint32Array)
    b._multiDrawCount = n
    b._multiDrawBytesPerElement = 4 // the batch index is a Uint32Array (newBatch)
    b._indirectTexture.needsUpdate = true
    b._visibilityChanged = false
    if (batch.guard.depth === 1) batch.drawn = n // the outermost pass is the camera's
  }
```

  - Fields `private readonly frustum = new THREE.Frustum(); private readonly projView = new THREE.Matrix4();
    private readonly planes = new Float64Array(24); private eye: Vec3Like = { x: 0, y: 0, z: 0 }; private range = Infinity`.
  - The constructor's 5th parameter is `options: ChunkBatchOptions = {}`. Store `this.threeCull = options.threeCull ?? false`,
    `this.region = options.region ?? REGION`, `this.verticesPerSlot = options.verticesPerSlot ?? VERTICES_PER_SLOT`,
    `this.indicesPerSlot = options.indicesPerSlot ?? INDICES_PER_SLOT`.
  - Every use of `REGION` inside the class becomes `this.region`: the region key, `rw`/`rd`, `x0`/`z0`. Slot sizes use
    the fields. The exported `REGION` stays as the default.
  - `batchFor`:
    - when `!this.threeCull`, set `bm.perObjectFrustumCulled = false; bm.sortObjects = false`;
    - the batch literal gets `centres: new Float32Array(maxInstances * 3)`, `guard: new PassGuard()`, `drawn: 0` and
      `box: bm.boundingBox.clone()`;
    - call `this.wire(batch)` instead of `guardNestedPasses(bm)`.
  - `set()`: after `setMatrixAt`, `batch.centres.set([cx * 32 + 16, cy * 32 + 16, cz * 32 + 16], instanceId * 3)`.
  - New methods:

```ts
  /** Once per frame before rendering: the viewer and the view distance; resets the per-frame counts and pass guards. */
  beginFrame(eye: Vec3Like, range: number): void {
    this.eye = { x: eye.x, y: eye.y, z: eye.z }
    this.range = range
    for (const b of this.batches.values()) {
      b.guard.reset()
      b.drawn = 0
      const x = b.box
      b.mesh.visible = boxInRange(this.eye, range, x.min.x, x.min.y, x.min.z, x.max.x, x.max.y, x.max.z)
    }
  }

  /** Chunk draws of the camera's pass in the current frame (after the frustum and view-distance cull). */
  get drawnCount(): number {
    let n = 0
    for (const b of this.batches.values()) if (b.mesh.visible) n += b.drawn
    return n
  }
```

  - Delete the now-unused `guardNestedPasses` function. Update the file header's trap 4 note to: "the engine's own cull
    (chunkCull.ts) runs per pass; PassGuard restores the outer list".

- [ ] **Step 4: Wire the options through.**
  - `chunkMeshes.ts`: `ChunkMeshesOptions` gains `threeCull?: boolean; region?: number`. The constructor passes
    `{ threeCull, region }` to each `ChunkBatches`. Add:

```ts
  /** Once per frame before rendering (Visuals.frame). */
  beginFrame(eye: Vec3Like, range: number): void {
    for (const b of Object.values(this.batches)) b.beginFrame(eye, range)
  }
  /** Chunk layer draws of the camera's pass this frame: batched after the cull, plus per-chunk meshes in range. */
  get drawnCount(): number {
    let n = 0
    for (const b of Object.values(this.batches)) n += b.drawnCount
    for (const m of this.group.children) if ((m as THREE.Mesh).isMesh && m.visible) n++
    return n
  }
```

  - `visuals.ts`: `VisualsOptions` gains `/** @internal three's own batch cull (the pixel-diff reference). */ threeCull?: boolean`.
    Pass it to `new ChunkMeshes(..., { batched: ..., threeCull: o.threeCull ?? false })`. First line of `frame()`:
    `this.chunks.beginFrame(this.o.camera.position, Infinity)`. Task 8 replaces `Infinity` with the setting.
  - `engine.ts` `EngineOptions`, appended:

```ts
  /**
   * @internal Debug only: keep three's own per-chunk BatchedMesh cull and sort instead of the engine's. The batching
   * pixel-diff e2e uses it as its reference picture. Default false.
   */
  threeCull?: boolean
```

    and `threeCull: o.threeCull ?? false` in the `new Visuals({...})` literal (its own line).
  - `apps/sandbox/src/main.ts`, after the `batchChunks` line:

```ts
  // ?cull=three: three's own batch cull, the reference picture of the engine's cull (e2e/batching.spec.ts).
  threeCull: params.get('cull') === 'three',
```

- [ ] **Step 5: Run the unit tests.** `npx vitest run test/chunkBatches.test.ts test/chunkMeshes.test.ts test/chunkCull.test.ts`.
  Expected: PASS. Then `npm run typecheck`. Expected: no errors.

- [ ] **Step 6: Extend `batching.spec.ts` with our cull vs three's.** Add a third test per backend after the existing one:

```ts
for (const backend of ['webgpu', 'webgl'] as const) {
  for (const [label, scene, pose] of [
    ['256² orbit', SCENE, { t: [128, 40, 128], d: 260, p: 0.75, y: 0.7 }],
    ['1024² far', '/?scene=terrain&size=1024&still', { t: [512, 50, 512], d: 400, p: 0.3, y: 0.7 }],
  ] as const) {
    test(`${backend}: the engine's cull draws the picture three's cull draws (${label})`, async ({ page }, info) => {
      test.setTimeout(300_000)
      await page.setViewportSize({ width: 1280, height: 720 })
      const flag = backend === 'webgl' ? '&webgl' : ''
      const ours = await shoot(page, scene + flag, pose)
      const three = await shoot(page, scene + flag + '&cull=three', pose)
      const diff = await pixelDiff(page, ours.png, three.png)
      writeFileSync(info.outputPath('ours.png'), ours.png); writeFileSync(info.outputPath('three.png'), three.png)
      writeFileSync(info.outputPath('diff.png'), Buffer.from(diff.mask, 'base64'))
      console.log(`cull pixel diff (${backend}, ${label}): ${(diff.share * 100).toFixed(4)}%`)
      expect(ours.camera).toEqual(three.camera)
      expect(diff.share).toBeLessThan(MAX_DIFF_SHARE)
      expect(ours.errors).toEqual([]); expect(three.errors).toEqual([])
    })
  }
}
```

  To support it, refactor `shoot(page, url)` into `shoot(page, url, pose = { t: [128, 40, 128], d: 260, p: 0.75, y: 0.7 })`:
  - its first `page.evaluate` sets `s.target` from `pose.t`, `s.distance = pose.d`, `s.pitch = pose.p`, `s.yaw = pose.y`;
  - its `waitForFunction` timeouts go to 240 s for the 1024² world;
  - move the in-page decoder and diff from the existing test into a helper `pixelDiff(page, a: Buffer, b: Buffer)` that
    returns `{ share, differing, pixels, mask }`, and use it in the existing test too.

  The existing test's calls keep their default pose, so its behaviour is unchanged.

- [ ] **Step 7: Run the batching e2e.** It is a light check; outside windows it is fine unless HOLD is in force:
  `E2E_PORT=5181 E2E_CHANNEL=msedge npx playwright test e2e/batching.spec.ts --workers=1`, output redirected to a file.
  Expected: all 6 tests pass. Each diff is logged below 0.5%.

- [ ] **Step 8: Commit, then A/B in a window.**
  - Commit: `git commit -m "perf(render): the engine's own batch cull (precomputed spheres, no sort, both passes)"`.
  - Build two bundles into the scratchpad:
    - `main`: run `git checkout 90e5c97 -- packages/engine/src apps/sandbox/src`, then `npx vite build --outDir <scratch>/ab/main --emptyOutDir` in apps/sandbox, then `git checkout HEAD -- packages/engine/src apps/sandbox/src` and `git status --short` (expected: clean apart from untracked files);
    - `cull`: HEAD, into `<scratch>/ab/cull`.
  - Send the expert `WINDOW REQUEST: lod part-1 #4.1 A/B (main vs own cull), 25 min`.
  - On GO, run `viewAB.mjs` with `VIEW_AB_ORDER=mccmmc` and both scenes, with free RAM logged before and after. Send
    DONE.
  - Copy the summary JSON to `docs/superpowers/research/2026-10-08-view-ab-cull.json`.
  - **Keep rule:** CPU median falls at the far and ground poses, and **GPU ms at the ground pose** (no sort: overdraw
    toward the horizon) does not rise by more than the CPU gain. Otherwise revert the commit (`git revert`), and report.
  - Commit the research JSON with the before/after numbers in the message.

### Task 4: Smaller cutout batches, region option, memory stat

**Files:**
- Modify: `packages/engine/src/render/chunkBatches.ts`, `chunkMeshes.ts`, `visuals.ts`, `engine.ts`; `apps/sandbox/src/main.ts`
- Test: `packages/engine/test/chunkBatches.test.ts`

**Interfaces:**
- Produces:
  - `ChunkBatches.capacityBytes: number`, `ChunkMeshes.batchBytes: number`
  - `EngineStats.batchBytes: number` (appended)
  - `EngineOptions.regionChunks?: number` (`@internal`)
  - `CUTOUT_VERTICES_PER_SLOT`, `CUTOUT_INDICES_PER_SLOT`

- [ ] **Step 1: Measure the cutout share.** It's a light dev run, not timing. Temporarily log at `ready + settle` in a
  scratch Playwright evaluate:
  - per layer, the sum of `_geometryInfo[].reservedVertexCount` over active geometries;
  - and `_maxVertexCount` over batches.

  Use `?scene=terrain&size=1024` and `?scene=world&size=1024`. Record the used and capacity numbers in the plan's
  results section below. Pick `CUTOUT_VERTICES_PER_SLOT` as the smallest power of two ≥ 1.25 × (cutout used ÷ cutout
  slots) over both scenes, with a minimum of 64. `CUTOUT_INDICES_PER_SLOT = 1.5 × CUTOUT_VERTICES_PER_SLOT`.

- [ ] **Step 2: Write the failing test.**

```ts
  it('starts cutout batches smaller than opaque ones, and reports capacity bytes', () => {
    const opaque = new ChunkBatches(layout, new THREE.MeshBasicMaterial(), 'opaque', true)
    const cutout = new ChunkBatches(layout, new THREE.MeshBasicMaterial(), 'cutout', true, { verticesPerSlot: CUTOUT_VERTICES_PER_SLOT, indicesPerSlot: CUTOUT_INDICES_PER_SLOT })
    opaque.set(0, 0, 0, 0, quads(1)); cutout.set(0, 0, 0, 0, quads(1))
    expect(cutout.capacityBytes).toBeLessThan(opaque.capacityBytes / 4)
    expect(opaque.capacityBytes).toBe(REGION * REGION * 2 * (1024 * 8 + 1536 * 4)) // layout is 64 tall: 2 chunk layers
  })
  it('groups 8 × 8 columns per batch with region 8', () => {
    const b = new ChunkBatches(layout, new THREE.MeshBasicMaterial(), 'opaque', true, { region: 8 })
    b.set(layout.chunkIndex(0, 0, 0), 0, 0, 0, quads(1)); b.set(layout.chunkIndex(7, 0, 7), 7, 0, 7, quads(1))
    expect(b.batchCount).toBe(1)
  })
```

- [ ] **Step 3: Run the tests to verify they fail**, then implement:
  - export the two cutout constants;
  - add `get capacityBytes()`: the sum over batches of `_maxVertexCount * 8 + _maxIndexCount * 4`;
  - `ChunkMeshes`:
    - creates the cutout `ChunkBatches` with the cutout slot sizes;
    - passes `region`;
    - gets `get batchBytes()` (the sum).
  - `EngineStats`, appended:

```ts
  /** Bytes reserved by the chunk region batches (vertex + index buffers, CPU side; the GPU mirrors it). */
  batchBytes: number
```

    and `batchBytes: visuals.chunks.batchBytes,` on its own line in `stats()`;
  - `EngineOptions.regionChunks?: number` with an `@internal` doc ("Chunk columns per region batch side; default 4.
    For the REGION A/B only."). Forward it through `VisualsOptions.regionChunks` to `ChunkMeshes`;
  - sandbox `main.ts`: `regionChunks: params.has('region') ? Number(params.get('region')) : undefined,`.

- [ ] **Step 4: Run the tests, typecheck, and the batching e2e with `?region=8`.** Add a one-off run of the first
  batching test with `&region=8` appended to `SCENE` by an env var `BATCH_REGION` (`const SCENE = '/?scene=terrain&size=256&still' + (process.env.BATCH_REGION ? `&region=${process.env.BATCH_REGION}` : '')`).
  Expected: PASS, diff < 0.5%.

- [ ] **Step 5: Commit** with `perf(render): smaller cutout batches; batch memory stat; region size option (internal)`.

- [ ] **Step 6: REGION 8 A/B in a window.**
  - Use one `cull` build. The variants are `r4` (query `region=4`) and `r8` (query `region=8`). Set `VIEW_PROBES=1`
    and order `488448` (letters `4` and `8`: name the variants `4` and `8`).
  - Send `WINDOW REQUEST: lod part-1 #4.2 REGION A/B with probes, 25 min`.
  - **Keep rule:** REGION 8 must meet all of these, otherwise the default stays 4:
    - CPU median falls at the far and ground poses;
    - `editFrames` median and max are no worse than r4, and r4's ≤ 2 frames stays ≤ 2;
    - `editMaxCpu` is no worse by more than 10%;
    - `batchBytes` is not higher.
  - On keep: change `export const REGION = 8` and the test expectations that mention 4.
  - Commit the research JSON (`2026-10-08-view-ab-region.json`) and the decision.
  - Also run the remesh micro-bench (Step 7) and log its numbers in the commit.

- [ ] **Step 7: Remesh micro-bench (logged, not asserted), in `chunkBatches.test.ts`.**

```ts
  it('logs remesh costs per region size (spec §4.2; numbers are logged, not asserted)', () => {
    for (const region of [4, 8]) {
      const b = new ChunkBatches(new Layout([1024, 128, 1024]), new THREE.MeshBasicMaterial(), 'opaque', true, { region })
      for (let i = 0; i < region * region * 4; i++) b.set(i, i % region, (i / (region * region)) | 0, ((i / region) | 0) % region, quads(400))
      const time = (f: () => void) => { const t = performance.now(); f(); return performance.now() - t }
      const inPlace = time(() => b.set(0, 0, 0, 0, quads(410)))
      const append = time(() => b.set(0, 0, 0, 0, quads(900)))
      for (let i = 1; i < region * region; i++) b.remove(i)
      const compact = time(() => b.set(1, 1, 0, 0, quads(5000)))
      console.log(`region ${region}: in place ${inPlace.toFixed(2)} ms, append ${append.toFixed(2)} ms, compact ${compact.toFixed(2)} ms (compacted ${b.stats.compacted}, grown ${b.stats.grown})`)
    }
  })
```

### Task 5: Hidden decorations cost nothing

**Files:**
- Modify: `packages/engine/src/render/decorations/decorationMeshes.ts`
- Test: `packages/engine/test/decorationMeshes.test.ts` (new)

**Interfaces:**
- Produces: `RESELECT_DISTANCE = 2` (exported); `DecorationMeshes.cull` keeps its signature and return.

- [ ] **Step 1: Write the failing test.**

```ts
import * as THREE from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { DecorationMeshes, RESELECT_DISTANCE } from '../src/render/decorations/decorationMeshes.ts'
import { Layout } from '../src/world/layout.ts'

const layout = new Layout([1024, 64, 1024])
const deco = () => new DecorationMeshes(layout, { grass: new THREE.MeshBasicMaterial(), flowers: new THREE.MeshBasicMaterial() })
const two = Uint32Array.of(0, 0, 1, 0)
const at = (x: number, z: number) => new THREE.Vector3(x, 40, z)

describe('DecorationMeshes', () => {
  it('keeps only selected meshes in the scene graph', () => {
    const d = deco()
    d.apply(layout.chunkIndex(0, 0, 0), two, two)
    d.apply(layout.chunkIndex(20, 0, 0), two, null) // 640 blocks away
    expect(d.group.children.length).toBe(0) // nothing selected before the first cull
    const r = d.cull(at(16, 16), 96, 1e6)
    expect(r).toEqual({ instances: 4, draws: 2 })
    expect(d.group.children.map(m => m.name).sort()).toEqual(['deco-0-0-0', 'deco-0-0-0'])
  })
  it('re-selects only after the camera moved RESELECT_DISTANCE or the entries changed', () => {
    const d = deco()
    d.apply(layout.chunkIndex(0, 0, 0), two, null)
    d.cull(at(16, 16), 96, 1e6)
    d.apply(layout.chunkIndex(3, 0, 0), two, null) // centre x 112: 96 from the eye, within 96 + reach 28
    expect(d.cull(at(16, 16), 96, 1e6).draws).toBe(2) // entries changed: re-selected
    d.remove(layout.chunkIndex(3, 0, 0))
    d.apply(layout.chunkIndex(5, 0, 0), two, null) // centre x 176: out of reach from x 16 + 1.9, in reach from 16 + 40
    d.cull(at(16, 16), 96, 1e6)
    expect(d.cull(at(16 + RESELECT_DISTANCE - 0.1, 16), 96, 1e6).draws).toBe(1)
    expect(d.cull(at(56, 16), 96, 1e6).draws).toBe(2)
  })
  it('removing a shown chunk takes its meshes out of the graph', () => {
    const d = deco()
    d.apply(0, two, two)
    d.cull(at(16, 16), 96, 1e6)
    d.remove(0)
    expect(d.group.children.length).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails.** `npx vitest run test/decorationMeshes.test.ts`. Expected: FAIL (the
  `RESELECT_DISTANCE` export is missing; the meshes are in the group before the cull).

- [ ] **Step 3: Implement.**
  - `Entry` gains `shown: boolean`.
  - `mesh()` no longer calls `this.group.add(m)`.
  - `apply()` and `remove()` set `this.dirty = true`.
  - `remove()` calls `this.group.remove(m)` only if `e.shown`.
  - `cull`:

```ts
/** Camera movement (blocks, horizontal) below which the last selection is kept: CHUNK_REACH leaves ≥ 5 blocks of slack. */
export const RESELECT_DISTANCE = 2

  cull(camera: THREE.Vector3, radius: number, maxInstances: number): { instances: number; draws: number } {
    const last = this.lastEye
    if (!this.dirty && last && radius === this.lastRadius && maxInstances === this.lastMax &&
        Math.hypot(camera.x - last.x, camera.z - last.z) < RESELECT_DISTANCE) return this.result
    this.dirty = false
    this.lastEye = camera.clone(); this.lastRadius = radius; this.lastMax = maxInstances
    const list: DecorationChunk[] = []
    for (const [ci, e] of this.entries) list.push({ ci, dist: Math.hypot(e.centre.x - camera.x, e.centre.z - camera.z), count: e.count })
    const show = selectVisible(list, radius, maxInstances)
    let instances = 0, draws = 0
    for (const [ci, e] of this.entries) {
      const on = show.has(ci)
      if (on !== e.shown) {
        for (const m of [e.grass, e.flowers]) if (m) { if (on) this.group.add(m); else this.group.remove(m) }
        e.shown = on
      }
      if (on) { instances += e.count; draws += (e.grass ? 1 : 0) + (e.flowers ? 1 : 0) }
    }
    this.result = { instances, draws }
    return this.result
  }
```

  - Fields: `private dirty = true; private lastEye: THREE.Vector3 | null = null; private lastRadius = -1; private lastMax = -1; private result = { instances: 0, draws: 0 }`.
  - `Visuals.frame` still sets `this.deco.group.visible = this.effects.decorations` and keeps calling `cull` only when
    decorations are on. That is unchanged.

- [ ] **Step 4: Run the test (PASS), the engine suite for decorations
  (`npx vitest run test/decorationMeshes.test.ts test/decorations.test.ts`), and typecheck.**

- [ ] **Step 5: Commit, then A/B in a window.**
  - Commit: `perf(render): hidden decoration meshes leave the scene graph; re-select after 2 blocks`.
  - Build `prev` (the commit before this one) and `deco` (HEAD) bundles as in Task 3 Step 8.
  - Send `WINDOW REQUEST: lod part-1 #4.3 decorations A/B, 25 min`. Order `pddppd`.
  - **Keep rule:** CPU median falls at any pose without rising at another. Otherwise revert.
  - Commit `docs/superpowers/research/2026-10-08-view-ab-deco.json`.

### Task 6: Part-1 gate

- [ ] **Step 1: Request a window and run the gate.** Send `WINDOW REQUEST: lod part-1 gate, 2 runs × 2 scenes, 15 min`.
  Run `viewAB.mjs` with a single variant `head` (current HEAD build), order `hh`, both scenes, free RAM logged. Save
  `docs/superpowers/research/2026-10-08-view-gate-part1.json`.
- [ ] **Step 2: Check the gate.** Every pose in both scenes must have worst fps p5 ≥ 60. Commit the JSON with the table in
  the message, and report the phase to the expert (SHA + table). If a pose misses, send the expert the residual, the
  profile (`VIEW_PROFILE` run on dev) and the remaining candidates, and wait for a ruling before part 2.

---

## Phase 2 — `Quality.viewDistance`

### Task 7: The setting

**Files:**
- Modify: `packages/engine/src/render/settings.ts`
- Test: `packages/engine/test/settings.test.ts`

**Interfaces:**
- Produces: `Quality.viewDistance: number`; `DEFAULT_QUALITY.viewDistance === Infinity`.

- [ ] **Step 1: Update the tests first.**
  - In 'has the spec defaults', the expectation becomes
    `{ shadowMapSize: 2048, decorationRadius: 96, decorationMaxInstances: 400_000, msaa: 4, viewDistance: Infinity }`.
  - Add:

```ts
  it('accepts Infinity or [64, 4096] for viewDistance, and back to Infinity', () => {
    expect(mergeQuality(DEFAULT_QUALITY, { viewDistance: 256 }).viewDistance).toBe(256)
    expect(mergeQuality(mergeQuality(DEFAULT_QUALITY, { viewDistance: 256 }), { viewDistance: Infinity }).viewDistance).toBe(Infinity)
    for (const bad of [63, 4097, Number.NaN, -Infinity, 0]) expect(() => mergeQuality(DEFAULT_QUALITY, { viewDistance: bad })).toThrow(/quality\.viewDistance/)
  })
```

- [ ] **Step 2: Run to fail**, then implement:
  - `Quality` gains:

```ts
  /** Blocks from the camera beyond which the world is not drawn, faded into the fog over its last quarter. Infinity (default) draws everything. */
  viewDistance: number
```

  - `DEFAULT_QUALITY` gets `viewDistance: Infinity` appended.
  - In `mergeQuality`:

```ts
  if (q.viewDistance !== Infinity && !(Number.isFinite(q.viewDistance) && q.viewDistance >= 64 && q.viewDistance <= 4096)) {
    throw new RangeError(`quality.viewDistance must be Infinity or in [64, 4096], got ${q.viewDistance}`)
  }
```

- [ ] **Step 3: Run `test/settings.test.ts` (PASS) and typecheck.** Commit `feat(render): Quality.viewDistance setting (default Infinity)`.

### Task 8: R removes the world beyond it

**Files:**
- Modify:
  - `packages/engine/src/render/water/waterSurface.ts` (the spec §5.2 hunk only);
  - `chunkMeshes.ts`, `visuals.ts`, `engine.ts` (stat).
- Test:
  - `packages/engine/test/waterSurfaceRange.test.ts` (new);
  - `chunkMeshes.test.ts`;
  - `packages/engine/test/visualsView.test.ts` (new, pure parts).

**Interfaces:**
- Consumes: `boxInRange`, `chunkInRange`, `cameraFar` (Task 1); `ChunkMeshes.beginFrame` (Task 3); `Quality.viewDistance` (Task 7).
- Produces:
  - `WaterSurface.setRange(eye: Vec3Like, range: number): void`
  - `EngineStats.chunksDrawn: number`
  - `shadowReach(orbitDistance: number, range: number): number` in `viewDistance.ts`

- [ ] **Step 1: Re-read `waterSurface.ts` at HEAD.** If perf changed it since 90e5c97, adapt the hunk to the new data
  source, keeping the same three edits. If the change is not small, stop and ask the expert.

- [ ] **Step 2: Write the failing water test with a fake view.**

```ts
import * as THREE from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { WaterSurface } from '../src/render/water/waterSurface.ts'

/** A SurfaceView stand-in: 4 × 4 chunk columns, one draw layer, every column wet. */
function fakeView() {
  const cx = 4, ccCount = 16
  const column = () => ({
    hPrev: new Float32Array(4096), hCur: new Float32Array(4096), info: new Float32Array(4096).fill(0), rowLo: 0, rowHi: 31,
    curtains: { prev: new Float32Array(4), cur: new Float32Array(4), reach: new Float32Array(4), thick: new Float32Array(4), flare: new Float32Array(4), info: new Float32Array(4), count: 1, generation: 0 },
  })
  const cols = Array.from({ length: ccCount }, column)
  let dirty = cols.map((_, i) => i)
  return { cx, ccCount, column: (cc: number) => cols[cc]!, takeDirty: () => { const d = dirty; dirty = []; return d } }
}

describe('WaterSurface.setRange', () => {
  it('hides chunk columns beyond the range, shows them again at Infinity, and new slots follow the last range', () => {
    const view = fakeView()
    const w = new WaterSurface(128, view as never, new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial())
    w.setRange({ x: 16, y: 60, z: 16 }, 64) // before any slot exists
    w.update()
    const surface = (cc: number) => w.group.getObjectByName(`water-0-${cc}`)!
    expect(surface(0).visible).toBe(true) // the column the eye stands in
    expect(surface(3).visible).toBe(false) // x from 96: 80 away
    expect(w.group.getObjectByName('water-0-3-curtains')!.visible).toBe(false)
    w.setRange({ x: 16, y: 60, z: 16 }, Infinity)
    expect(surface(3).visible).toBe(true)
    expect(w.group.getObjectByName('water-0-3-curtains')!.visible).toBe(true)
  })
})
```

  Check the exact `ColumnData` field names against `surfaceView.ts` before running. The fake must match what
  `WaterSurface` reads; adjust the fake, never `surfaceView.ts`.

- [ ] **Step 3: Run to fail, then apply the spec §5.2 hunk to `waterSurface.ts`, verbatim.** It adds the `inRange` slot
  field, `inRange: this.near(cc)` in `create()`'s slot literal, `&& s.inRange` in the two `sync()` expressions, the
  `eye`/`range` fields, and `setRange` / `near`. Run the test: PASS.

- [ ] **Step 4: Write the failing tests for unbatched meshes in `chunkMeshes.test.ts`.**

```ts
  it('hides per-chunk meshes beyond the view distance, also ones created later, and shows them at Infinity', () => {
    const cm = new ChunkMeshes(new Layout([512, 64, 64]), mats(), {})
    cm.apply(0, data(quad(), quad()))
    cm.beginFrame({ x: 16, y: 16, z: 16 }, 100)
    cm.apply(10, data(quad(), null)) // chunk x 320–352: 304 away
    expect(cm.group.getObjectByName('chunk-0-liquid')!.visible).toBe(true)
    expect(cm.group.getObjectByName('chunk-10-liquid')!.visible).toBe(false)
    expect(cm.drawnCount).toBe(2)
    cm.beginFrame({ x: 16, y: 16, z: 16 }, Infinity)
    expect(cm.group.getObjectByName('chunk-10-liquid')!.visible).toBe(true)
  })
```

  Factor the existing `setup()` materials into `mats()`.

- [ ] **Step 5: Implement in `chunkMeshes.ts`.**
  - Add the fields `private eye: Vec3Like = { x: 0, y: 0, z: 0 }; private range = Infinity`.
  - `beginFrame`:

```ts
  beginFrame(eye: Vec3Like, range: number): void {
    for (const b of Object.values(this.batches)) b.beginFrame(eye, range)
    const was = this.range
    this.eye = { x: eye.x, y: eye.y, z: eye.z }
    this.range = range
    if (range === Infinity && was === Infinity) return // the default: nothing to test
    for (const [ci, slots] of this.meshes) {
      const on = this.inRange(ci)
      for (const m of slots) if (m) m.visible = on
    }
  }
  private inRange(ci: number): boolean {
    const [cx, cy, cz] = this.layout.chunkCoords(ci)
    return chunkInRange(this.eye, this.range, cx * 32 + 16, cy * 32 + 16, cz * 32 + 16)
  }
```

  - In `apply()`, a new mesh gets `mesh.visible = this.inRange(ci)`.
  - Run: PASS.

- [ ] **Step 6: Write the failing test for the shadow reach.** Add `shadowReach` to `viewDistance.ts`; the test goes in
  `viewDistance.test.ts`:

```ts
  it('clamps the shadow reach to the view distance', () => {
    expect(shadowReach(400, Infinity)).toBe(shadowDistance(400))
    expect(shadowReach(400, 256)).toBe(256)
    expect(shadowReach(8, 256)).toBe(shadowDistance(8))
  })
```

  Implementation in `viewDistance.ts`:
  `import { shadowDistance } from './shadowFit.ts'` and
  `export function shadowReach(orbitDistance: number, range: number): number { return Math.min(shadowDistance(orbitDistance), range) }`.

- [ ] **Step 7: Wire `Visuals.frame`.** Replace its first lines with:

```ts
  frame(dt: number): void {
    const range = this.quality.viewDistance, eye = this.o.camera.position
    this.chunks.beginFrame(eye, range)
    this.waterSurface.setRange(eye, range)
    const cf = cameraFar(range)
    if (this.o.camera.far !== cf) { this.o.camera.far = cf; this.o.camera.updateProjectionMatrix() }
    ripples.update(dt)
    syncRipples()
    if (this.atmosphere.update(dt)) this.applyAtmosphere(this.atmosphere.current)
    const far = shadowReach(this.o.viewDistance(), range)
```

  The rest is unchanged, except:
  - `this.decoRadius.value = Math.min(this.quality.decorationRadius, range)`;
  - the `deco.cull` call's radius argument is `Math.min(this.quality.decorationRadius, range)`.

  `stats()` gains `chunksDrawn: this.chunks.drawnCount`. Its return type gets `chunksDrawn: number`.

- [ ] **Step 8: Add the stat to `engine.ts`.** `EngineStats`, appended:

```ts
  /** Chunk layer draws of the camera's pass in the last frame: batched chunks after the frustum and view-distance cull, plus per-chunk meshes within the view distance. */
  chunksDrawn: number
```

  In `stats()`, on its own line: `chunksDrawn: vs.chunksDrawn,`.

- [ ] **Step 9: Run** `npx vitest run test/waterSurfaceRange.test.ts test/chunkMeshes.test.ts test/viewDistance.test.ts test/chunkBatches.test.ts`
  and typecheck. Expected: PASS and no errors. Commit
  `feat(render): view distance hides chunks, regions, water, decorations and shadows beyond R; camera far follows R`.

### Task 9: The edge: fog and sky

**Files:**
- Modify: `packages/engine/src/render/sky.ts`, `visuals.ts`
- Test: `packages/engine/test/sky.test.ts` (new), `packages/engine/test/fogCoverage.test.ts` (new)

**Interfaces:**
- Consumes: `edgeBand` (Task 1).
- Produces:
  - `Sky.setViewDistance(range: number): void`
  - `Sky.fogFor(fogOn: boolean, range: number): THREE.Node | null`
  - `Sky.edgeNode`

- [ ] **Step 1: Write the fog-coverage test (expert note 1).** It checks that every world material takes the scene's fog:

```ts
import * as THREE from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { BlockRegistry } from '../src/blocks/registry.ts'
import { DecorationRegistry } from '../src/render/decorations/defs.ts'
import { createDecorationMaterials } from '../src/render/decorations/material.ts'
import { FallingCubes } from '../src/render/falling.ts'
import { FragmentMeshes } from '../src/render/fragments.ts'
import { createChunkMaterials } from '../src/render/materials.ts'
import { createLightUniforms } from '../src/render/voxelLighting.ts'
import { WaterMaterial } from '../src/render/water.ts'
import { Layout } from '../src/world/layout.ts'

describe('every world material takes the scene fog node (so the view-distance edge reaches it)', () => {
  it('chunks (4 layers), decorations, water (surface, curtain, voxel, plain), falling cubes and fragments', () => {
    const tex = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1)
    const lights = createLightUniforms()
    const registry = new BlockRegistry([{ name: 'stone', textures: { all: 'stone' } }] as never)
    const faceLayers = new Uint16Array(registry.count * 6)
    const materials: THREE.Material[] = [
      ...Object.values(createChunkMaterials(tex, lights)),
      ...Object.values(createDecorationMaterials(new DecorationRegistry([], registry), lights)).filter((m): m is THREE.Material => m instanceof THREE.Material),
      ...((w) => [w.surface, w.curtain, w.voxel, w.plainSurface, w.plainCurtain])(new WaterMaterial(lights, true)),
      (new FallingCubes(tex, lights, faceLayers).mesh.material as THREE.Material),
    ]
    const fragments = new FragmentMeshes(new Layout([64, 64, 64]), registry, faceLayers, tex, lights)
    fragments.group.traverse(o => { const m = (o as THREE.Mesh).material; if (m) materials.push(...([] as THREE.Material[]).concat(m)) })
    for (const m of materials) expect((m as THREE.Material & { fog?: boolean }).fog, m.type).not.toBe(false)
    for (const m of materials) expect((m as unknown as { isNodeMaterial?: boolean }).isNodeMaterial, m.type).toBe(true) // node materials apply scene.fogNode in setupOutput
  })
})
```

  The `BlockRegistry` definition shape must match `blocks/registry.ts` (`BlockDef`); copy a minimal def from an existing
  test (`test/registry.test.ts`). If `FragmentMeshes` creates its material lazily, read it through its public material
  accessor or the constructor's material field, whichever exists. Adapt the read, never the class. Run it. Expected:
  PASS. It documents today's coverage, and no product change is needed. Units and the bean are covered by the e2e in
  Task 10. If anything fails, stop and report to the expert with the owner and the smallest fix (expert note 1).

- [ ] **Step 2: Write the failing sky test.**

```ts
import { describe, expect, it } from 'vitest'
import { Sky } from '../src/render/sky.ts'

describe('Sky view-distance edge', () => {
  it('sets the edge band from R, out of reach at Infinity', () => {
    const s = new Sky()
    s.setViewDistance(400)
    expect(s.edgeUniforms()).toEqual([300, 400])
    s.setViewDistance(Infinity)
    expect(s.edgeUniforms()[0]).toBeGreaterThan(1e29)
  })
  it('picks the fog node: plain fog, edge-only with fog off and finite R, none with fog off at Infinity', () => {
    const s = new Sky()
    expect(s.fogFor(true, Infinity)).toBe(s.fogNode)
    expect(s.fogFor(true, 256)).toBe(s.fogNode)
    expect(s.fogFor(false, 256)).toBe(s.edgeNode)
    expect(s.fogFor(false, Infinity)).toBeNull()
  })
})
```

- [ ] **Step 3: Run to fail, then implement in `sky.ts`.**
  - Uniforms: `edgeNear: uniform(edgeBand(Infinity)[0])`, `edgeFar: uniform(edgeBand(Infinity)[1])`.
  - In the constructor, after `factor`:

```ts
    // View distance (spec 4b §5.3): height-independent, so a mountain at R is fully fog-coloured however high it stands.
    const edge = smoothstep(u.edgeNear, u.edgeFar, dist)
```

  - `this.fogNode = fog(warm, factor.max(edge))` and `this.edgeNode = fog(warm, edge)`.
  - Methods:

```ts
  setViewDistance(range: number): void {
    const [near, far] = edgeBand(range)
    this.u.edgeNear.value = near
    this.u.edgeFar.value = far
  }
  /** For tests: the current edge band. */
  edgeUniforms(): [number, number] { return [this.u.edgeNear.value, this.u.edgeFar.value] }
  /** The scene fog node for the fog effect and view distance: an edge-only node keeps a finite R from showing a hard cut with fog off. */
  fogFor(fogOn: boolean, range: number): THREE.Node | null {
    return fogOn ? this.fogNode : range === Infinity ? null : this.edgeNode
  }
```

  - `attach(scene, fogOn)` keeps its signature and sets `scene.fogNode = this.fogFor(fogOn, Infinity)`. `Visuals.frame`
    (next step) refines it each frame.

- [ ] **Step 4: Wire it in `Visuals.frame`,** after the `camera.far` lines:

```ts
    this.sky.setViewDistance(range)
    const fogNode = this.sky.fogFor(this.effects.fog, range)
    if (this.o.scene.fogNode !== fogNode) this.o.scene.fogNode = fogNode
```

- [ ] **Step 5: Run** `npx vitest run test/sky.test.ts test/fogCoverage.test.ts` and typecheck. Expected: PASS. Then run
  the batching e2e again. The default picture must be unchanged: all pass, < 0.5%. Commit
  `feat(render): view-distance edge in the fog (height-independent), edge-only fog when fog is off`.

### Task 10: Sandbox controls and the view-distance e2e

**Files:**
- Modify: `apps/sandbox/src/main.ts`, `apps/sandbox/src/controls.ts`
- Create: `apps/sandbox/e2e/view-distance.spec.ts`

- [ ] **Step 1: `main.ts`.** After `engine.atmosphere.set(...)`, on its own lines:

```ts
// ?view=<blocks>: the view distance (Quality.viewDistance), for the 4b checkpoints.
if (params.has('view')) engine.quality = { viewDistance: Number(params.get('view')) }
```

- [ ] **Step 2: `controls.ts`.** After the effect toggles:

```ts
  const view = document.createElement('label')
  const input = document.createElement('input')
  input.id = 'view-distance'
  input.type = 'number'; input.min = '64'; input.max = '4096'; input.step = '32'; input.placeholder = '∞'
  input.style.width = '6em'
  input.value = Number.isFinite(engine.quality.viewDistance) ? String(engine.quality.viewDistance) : ''
  input.addEventListener('change', () => {
    const v = input.value.trim() === '' ? Infinity : Number(input.value)
    try { engine.quality = { viewDistance: v } } catch { input.value = Number.isFinite(engine.quality.viewDistance) ? String(engine.quality.viewDistance) : '' }
  })
  view.append('view ', input)
  el.append(view)
```

- [ ] **Step 3: Write `view-distance.spec.ts`.**

```ts
import { expect, test, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import type { Engine } from '@elovox/engine'

type W = Window & { __elovox?: { engine: Engine; ready: boolean } }
const SCENE = '/?scene=terrain&size=1024&still'

async function boot(page: Page, url: string, errors: string[]) {
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(url)
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 240_000 })
  await page.waitForFunction(() => { const s = (window as W).__elovox!.engine.stats(); return s.meshQueue + s.meshInFlight === 0 }, null, { timeout: 240_000 })
}
async function pose(page: Page, p: { t: number[]; d: number; pitch: number; yaw: number }) {
  await page.evaluate(p => {
    const e = (window as W).__elovox!.engine
    for (const s of [e.controls.goal, e.controls.current]) { s.target[0] = p.t[0]!; s.target[2] = p.t[2]!; s.distance = p.d; s.pitch = p.pitch; s.yaw = p.yaw }
  }, p)
  await page.waitForTimeout(1500)
}
const drawn = (page: Page) => page.evaluate(() => (window as W).__elovox!.engine.stats().chunksDrawn)

test('a finite view distance draws less, beyond-R batches are hidden, and Infinity restores everything', async ({ page }) => {
  test.setTimeout(400_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  const errors: string[] = []
  await boot(page, SCENE, errors)
  await pose(page, { t: [120, 0, 120], d: 8, pitch: 0.15, yaw: -3 * Math.PI / 4 })
  const all = await drawn(page)
  await page.evaluate(() => { (window as W).__elovox!.engine.quality = { viewDistance: 256 } })
  await page.waitForTimeout(500)
  const near = await drawn(page)
  const state = await page.evaluate(() => {
    const e = (window as W).__elovox!.engine, p = e.camera.position
    let beyond = 0
    e.scene.traverse(o => {
      if (!(o as { isBatchedMesh?: boolean }).isBatchedMesh || !o.visible) return
      const b = (o as unknown as { boundingBox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } }).boundingBox
      const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x), dy = Math.max(b.min.y - p.y, 0, p.y - b.max.y), dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z)
      if (Math.hypot(dx, dy, dz) > 256) beyond++
    })
    return { beyond, far: e.camera.far }
  })
  expect(near).toBeLessThan(all)
  expect(state.beyond).toBe(0)
  expect(state.far).toBe(320)
  await page.evaluate(() => { (window as W).__elovox!.engine.quality = { viewDistance: Infinity } })
  await page.waitForTimeout(500)
  expect(await drawn(page)).toBe(all)
  expect(await page.evaluate(() => (window as W).__elovox!.engine.camera.far)).toBe(3000)
  expect(errors).toEqual([])
})

test('?nobatch also draws less at a finite view distance', async ({ page }) => {
  test.setTimeout(400_000)
  const errors: string[] = []
  await boot(page, SCENE + '&nobatch&view=256', errors)
  await pose(page, { t: [120, 0, 120], d: 8, pitch: 0.15, yaw: -3 * Math.PI / 4 })
  const near = await drawn(page)
  await page.evaluate(() => { (window as W).__elovox!.engine.quality = { viewDistance: Infinity } })
  await page.waitForTimeout(500)
  expect(near).toBeLessThan(await drawn(page))
  expect(errors).toEqual([])
})

test('every drawn material takes the scene fog (units and their models included)', async ({ page }) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  await boot(page, '/?scene=workers&view=256', errors)
  await page.waitForTimeout(3000) // units spawn and load their models
  const bad = await page.evaluate(() => {
    const e = (window as W).__elovox!.engine, out: string[] = []
    e.scene.traverse(o => {
      const m = (o as { material?: unknown }).material
      for (const mat of ([] as { fog?: boolean; name?: string; type?: string }[]).concat((m as never) ?? [])) if (mat.fog === false) out.push(`${o.name}:${mat.type}`)
    })
    return { out, fogNode: e.scene.fogNode !== null }
  })
  expect(bad.out).toEqual([])
  expect(bad.fogNode).toBe(true)
  expect(errors).toEqual([])
})

test('checkpoint screenshots: R = 384, 256 and Infinity at the ground and the low orbit poses', async ({ page }, info) => {
  test.skip(!process.env.VIEW_SHOTS, 'set VIEW_SHOTS=1 for the checkpoint screenshots')
  test.setTimeout(600_000)
  await page.setViewportSize({ width: 1920, height: 889 })
  const errors: string[] = []
  await boot(page, SCENE, errors)
  for (const [name, p] of [['ground', { t: [120, 0, 120], d: 8, pitch: 0.15, yaw: -3 * Math.PI / 4 }], ['orbit-low', { t: [512, 0, 512], d: 400, pitch: 0.3, yaw: 0.7 }]] as const) {
    await pose(page, p)
    for (const preset of ['open', 'sunset', 'diorama']) {
      await page.evaluate(n => (window as W).__elovox!.engine.atmosphere.set(n), preset)
      for (const r of [Infinity, 384, 256]) {
        await page.evaluate(r => { (window as W).__elovox!.engine.quality = { viewDistance: r } }, r)
        await page.waitForTimeout(800)
        writeFileSync(info.outputPath(`${name}-${preset}-${r}.png`), await page.locator('#view').screenshot())
      }
    }
  }
  expect(errors).toEqual([])
})
```

  `page.evaluate` cannot pass `Infinity` through JSON. In every evaluate that sets `Infinity`, pass `-1` and map it
  inside (`r < 0 ? Infinity : r`). Apply that in the checkpoint loop (`for (const r of [-1, 384, 256])`, file name
  `inf`), and set Infinity literally inside the other evaluates as written.

- [ ] **Step 4: Run** `E2E_PORT=5181 E2E_CHANNEL=msedge npx playwright test e2e/view-distance.spec.ts --workers=1`
  (output to a file), unless HOLD is in force. Expected: 3 pass, 1 skipped. Typecheck. Commit
  `feat(sandbox): ?view= and a view-distance field; view-distance e2e (R, nobatch, fog coverage, checkpoint shots)`.

### Task 11: Batching follow-ups

**Files:** `chunkBatches.ts`, `chunkMeshes.ts`, `visuals.ts`, `engine.ts`, `chunkBatches.test.ts`, `batching.spec.ts`

- [ ] **Step 1: The "normal" warning: test first.** In `chunkBatches.test.ts`:

```ts
  it('aliases normal (and position) to the packed attribute, also after growing, so three\'s batch normal finds one', () => {
    const b = batches()
    for (let i = 0; i < 16; i++) b.set(i, i % 8, 0, 0, quads(900))
    const g = bm(b)[0]!.geometry
    expect(g.getAttribute('normal')).toBe(g.getAttribute('packed'))
  })
```

  Then implement it in `newBatch`, `growBatch` and `unaliased`:
  - `newBatch` and `growBatch` add `setAttribute('normal', packed)`;
  - `unaliased` deletes and restores `normal` as well as `position`.

  In `batching.spec.ts` `shoot()`, collect warnings matching `/Vertex attribute "normal" not found/` and expect none.
  Run the unit test, then the batching e2e (both backends). Expected: PASS, diff < 0.5%, no warning.

  If the WebGL2 or WebGPU pipeline rejects the alias, revert this step and record "three r186 needs a real normal
  attribute; warning kept" in the report.

- [ ] **Step 2: Remove `ChunkBatches.setMaterial`** (unused). Grep first: no callers. Typecheck.

- [ ] **Step 3: Free replaced GPU buffers.**
  - `growBatch` pushes the replaced `packed` and index attributes onto `ChunkBatches.retired`.
  - Add `releaseRetired(free: (a: THREE.BufferAttribute) => void): void`, which calls `free` for each and clears the list.
  - `ChunkMeshes.releaseRetired(free)` forwards it.
  - `Visuals.frame`, after the render call:
    `this.chunks.releaseRetired(a => (this.o.renderer as unknown as { _attributes: { delete(a: THREE.BufferAttribute): unknown } })._attributes.delete(a))`.
  - Pin `_attributes` in the internals test: `expect('_attributes' in new THREE.WebGPURenderer()).toBe(true)`. If the
    renderer cannot be constructed in node, check `THREE.WebGPURenderer.prototype` or skip it with a note.
  - Unit test: after a forced grow, `releaseRetired` receives exactly 2 attributes, and then none.
  - Run the batching e2e again. Expected: PASS, with no WebGPU validation errors in the console.

- [ ] **Step 4: Add the `shadowCasters` doc.** In `EngineStats`, above `shadowCasters: number`:
  `/** Render objects drawn into the sun's shadow map: region batches plus per-chunk meshes (not chunks). */`.

- [ ] **Step 5: Run the engine suite and typecheck. Commit**
  `chore(render): batching follow-ups (normal alias, setMaterial removed, replaced buffers freed, shadowCasters doc)`.

### Task 12: Checkpoint, part-2 measurements, final verification

- [ ] **Step 1: Take the checkpoint shots.** Run `VIEW_SHOTS=1` view-distance e2e (light, no timing). Copy the PNGs as
  JPGs into `docs/superpowers/research/2026-10-08-view-checkpoint/` and commit. Send the expert checkpoint 1:
  - URLs `?scene=terrain&size=1024&view=384` and `&view=256`;
  - the ground pose (target 120, 120; pitch 0.15; distance 8; yaw −3π/4) and orbit 400 at pitch 0.3;
  - presets open, sunset and diorama;
  - the image paths;
  - the question: keep the default at Infinity, or adopt a finite default.
- [ ] **Step 2: Measure the R sweep in a window.** Run `viewAB.mjs`:
  - variants `inf` (no query), `512` (`view=512`), `384` (`view=384`), `256` (`view=256`);
  - order `i532235i`, letters `i`, `5`, `3`, `2`;
  - both scenes;
  - free RAM logged.

  Commit `docs/superpowers/research/2026-10-08-view-sweep.json`.
- [ ] **Step 3: Same picture against `main` (spec §6).**
  - Run the view bench at the 4 poses × 2 scenes, with `?still` added and decorations off (`engine.effects = { decorations: false }` via an env flag `VIEW_STILL=1` in `view-bench.spec.ts` that also appends `&still`).
  - Do this on the `main` bundle and on the HEAD bundle (not timing, so no window needed).
  - Diff the screenshots pairwise with the in-page decoder (a small `e2e/compare-shots.spec.ts` skipped unless
    `COMPARE_A`/`COMPARE_B` dirs are set).
  - Expected: every pair < 0.5%. Record the table in the review.
- [ ] **Step 4: Run the living-bench A/B, main vs branch (exit condition), in a window.** Use
  `BENCH_LIVING=1 LIVING_BENCH_SHORT=` and the full windows; build the two bundles as before. The living bench has no
  bundle switch, so run it four times alternating (main, branch, branch, main): before each run, start
  `vite preview --outDir <bundle> --port 5181`, then stop it after. Compare the idle and work phases' CPU frame median
  and fps. Commit `docs/superpowers/research/2026-10-08-view-living-ab.json`.
- [ ] **Step 5: Final verification, outside any HOLD.**
  - `npm test -w @elovox/engine`, `npm test -w @elovox/sandbox` and `npm run typecheck`, each redirected to a file and
    read.
  - The e2e suites touched: `batching`, `view-distance`, `smoke`, `living`, `water-render`.
  - Record the actual counts.
- [ ] **Step 6: Append to `CONTEXT.md` (at the end):**

```markdown
**View distance**:
The distance from the camera beyond which the world is not drawn; the fog dissolves its last quarter into the sky. Infinity draws the whole world.
_Avoid_: Render distance, chunk radius, LOD
```

- [ ] **Step 7: Write the report.** Write `docs/superpowers/reviews/2026-10-08-view-distance.md`: what was delivered
  against the spec, measurements (gate, A/Bs, sweep), screenshots, verification output, and open items. Commit, then send
  the expert "done" with the SHA.

## Results (filled in during execution)

- **Task 4 Step 1, cutout share.**
  - Terrain 1024²: 52 cutout batches, 702 chunks, 925,700 vertices reserved, 278 per slot.
  - World 1024²: no cutout layer.
  - Result: `CUTOUT_VERTICES_PER_SLOT = 512` (smallest power of two ≥ 1.25 × 278), indices 768 (e442e87).
- **Task 3, own cull: kept** (window 1, `research/2026-10-08-view-ab-cull.json`). CPU falls at every pose; ground GPU is flat.
- **Task 5, decoration detach: kept** (window 2, `-view-ab-deco.json`). CPU falls at every pose, by up to 2.7 ms on world.
- **Task 4, REGION 8.**
  - The window-1 A/B (`-view-ab-region.json`) failed the frames-based latency rule and the memory rule.
  - Diagnosis: frame counts are biased by frame length. The expert ruled that wall ms decides, with batchBytes allowed up
    to +10%.
  - The re-A/B (window 4, `-view-ab-region-2.json`, probe 9a5a45c) passed: editMs median and max no worse, edit CPU
    better, batchBytes +3.5–8%.
  - Kept at c41f0ec.
- **Part-1 gate.**
  - Missed with region 4 on terrain far / far-low (59.9–60.0): `-view-gate-part1.json` and `-gate-part1-2.json`.
  - Met on the final bundle c41f0ec (window 5, `-view-gate-part1-3.json`): worse fps p5 ≥ 176.4 at every pose in both
    scenes.
