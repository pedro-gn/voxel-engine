# Persistence (Sub-project 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save the living world to named browser slots (plus a rotating autosave) and boot a new engine from a save, faithfully and deterministically.

**Architecture:** The sim worker serializes each system between two ticks into packed sections plus 256²-block voxel regions (only regions written since the slot's last save in this session). A persistence worker gzips, SHA-256-names and writes the blobs, then the manifest last, behind a `SaveStore` interface (OPFS now, a server later). Loading reads and verifies the package, and `createEngine({ restore })` makes the sim fill the chunks, relight, and restore each system instead of generating.

**Tech Stack:** TypeScript 7, vitest 4 (Node 24: `CompressionStream`, `crypto.subtle`, `Blob`, `Response` are globals), Playwright, OPFS (`navigator.storage.getDirectory`, `createSyncAccessHandle` in a worker), Vite 8.

**Spec:** `docs/superpowers/specs/2026-10-13-persistence-design.md`

## Global Constraints

- Purpose: save and continue a game; **faithful, not bit-identical**. Loading the same save twice gives identical runs.
- Voxels: full chunk snapshot in **save regions of 256 × 256 blocks (8 × 8 chunk columns), full height**; light is not stored (relit on load).
- Blobs are **gzip** (`CompressionStream('gzip')`) and named by the **SHA-256 hex of their compressed bytes**; a blob already in the store is not written again; the **manifest is written last**.
- Every section and the region format carry a version; a mismatch **refuses the load with a message naming every mismatch** (`section water v2, engine expects v3`).
- Blocks are stored by name in the manifest; an unknown block refuses the load.
- Load = **page reload with `?save=name`** → `createEngine({ restore })`.
- Autosave every **5 minutes**, rotating `autosave-1` / `autosave-2`; off while the terrain editor is open; can be turned off in the panel.
- Save panel on key **`P`**; `navigator.storage.persist()` requested once.
- Targets (measured, quiet machine, alternating runs): sim stall incremental autosave living **≤ 50 ms**; full save 1024² **≤ 250 ms**; load 1024² to `ready` **≤ generation (~1.6 s)**; compressed sizes recorded.
- Repo artifacts in English; chat with the user in Portuguese. No `Co-Authored-By` unless the project's settings ask (the session's attribution reminder applies to commits made in this session).
- One implementer then one reviewer (user preference): no agent teams.
- Never run benches while the user is gaming; benches need a quiet window the user grants.

## Review Focus

1. **A save taken while units are mid-step, falling or working** — the loaded units stand on valid cells, nobody overlaps, and every work order still completes (Task 6 tests).
2. **A save requested before the world is ready, or while a terrain regeneration is in flight** — refused with a clear `EngineError('save')` before ready, consistent (pre- or post-regeneration world) during one (Task 10 tests).
3. **Two saves requested at once** (autosave firing while the player clicks Save) — coalesced, both promises settle, the manifest is never half-written (Task 11 `saveQueue` test).
4. **`?save=x` combined with other URL params** (`scene`, `size`, `seed`) — the save's scene, size and seed win (Task 12 `bootPlan` test).
5. **OPFS missing or quota exceeded** (Firefox private window, full disk) — the save fails with a readable message, the previous manifest stays loadable, the game keeps running (Task 8 quota test, Task 9 `OpfsStore.open` unavailable test).

## Planning deviations from the spec

Recorded here so the reviewer can check them against the spec:

1. **Manifest has no `session` / `revisions`.** The incremental baseline lives in the engine (memory): `slot → { created, revisions }`. A save is incremental only when the slot's current manifest is the one this engine wrote or loaded (`created` matches); otherwise every region is copied (dedupe still skips unchanged blobs). Simpler, and a manifest stays pure data for a server.
2. **No block-id remap.** The saved block table must be a **prefix** of the current registry (same names in the same order; appending blocks is allowed). Otherwise the load is refused with the first differing name. The sandbox block list is append-only by policy (`apps/sandbox/src/blocks.ts`). A remap would have to touch voxels, falling bodies, fragments, stocks, orders and piles.
3. **Pending commands are not saved.** A save is the world at a tick boundary; commands not yet applied belong to the session that sent them (their acks and ghost edits die with it).
4. **Water internals rebuilt, volumes exact.** After the voxels, `water.rebuild()` re-derives floors, segments, sea mask and mirror state from the voxels; the save then overwrites the exact per-column `depth`, `flux`, `last`, each lower segment's `depth`/`last`/`excess` (matched by column + floor + ceil), non-zero under-edge flux (matched by both ends' column + floor), the sea account, springs (order kept), awake/quiet tiles and the step counters. Bodies regroup from seeds; a body's excess is folded into its first member's excess (what `dropBody` does). The per-step `falls` scratch is not saved.
5. **Collapse:** an in-progress support search is not saved; its queued positions are re-seeded. Fragments in flight are saved and re-announced to the main thread as births with no source chunks.
6. **Workers:** frontier tasks go back to their orders' `parked` lists (they re-expand); unit task claims, partial work progress, parked failure histories and internal (negative-id) orders' tasks are dropped. A unit's saved state is normalized to what restore gives it (`falling`/`incapacitated` kept, else `planning` with a goal or `idle`), so save → load → save is idempotent.
7. **Region index** `r = rx + rz × regionsX` instead of `(rx, rz)` pairs in the manifest.
8. **Engine-tracked terrain document:** the manifest stores the last document given to `createEngine` or `terrain.setDocument`; patches are not folded in (autosave is off while the editor is open).

## File Structure

Engine (`packages/engine/src`):

| File | Responsibility |
|---|---|
| `persist/pack.ts` (new) | `pack`/`unpack`: one section = JSON header + aligned typed arrays |
| `persist/codec.ts` (new) | `gzip`, `gunzip`, `sha256` |
| `persist/regions.ts` (new) | save-region geometry, `encodeRegion`, `decodeRegion` |
| `persist/manifest.ts` (new) | `Manifest` type, versions, `checkManifest`, `checkBlocks`, `SaveError` |
| `persist/store.ts` (new) | `SaveStore` interface, `MemoryStore`, slot-name validation |
| `persist/package.ts` (new) | `writeSave`, `readSave`, `gcBlobs` over any `SaveStore` |
| `persist/opfs.ts` (new) | `OpfsStore` (worker only) |
| `persist/worker.ts` (new) | persist worker protocol, `handlePersist`, `runPersistWorker` |
| `persist/client.ts` (new) | main-thread request/response wrapper around the persist worker; `openSave` |
| `persist/saveQueue.ts` (new) | coalescing of concurrent saves |
| `sim/snapshot.ts` (new) | `SimSnapshot`, `SimRestore`, `SectionName` types |
| `world/chunkStore.ts` | per-save-region write revisions |
| `sim/scheduler.ts` | `entries()` / `restore()` |
| `sim/simulation.ts` | `snapshot(since)`, `restore(s)` |
| `sim/water/columns.ts`, `sim/water/waterSystem.ts` | water snapshot/restore |
| `sim/gravity.ts`, `sim/collapse.ts` | snapshot/restore |
| `sim/workers/workers.ts`, `sim/workers/snapshot.ts` (new) | workers snapshot/restore |
| `protocol.ts`, `sim/simHost.ts` | `snapshot` message, `init.restore` |
| `engine.ts`, `errors.ts`, `index.ts`, `package.json` | `save`, `saves`, `restore`, `persistWorker`, `'save'` error code, `./persist-worker` export |

Tests (`packages/engine/test`): `pack.test.ts`, `saveRegions.test.ts`, `persistHelpers.ts`, `simSnapshot.test.ts`, `waterSnapshot.test.ts`, `physicsSnapshot.test.ts`, `workersSnapshot.test.ts`, `persistRoundTrip.test.ts`, `savePackage.test.ts`, `persistWorker.test.ts`, `simHostSnapshot.test.ts`, `saveQueue.test.ts`.

Sandbox (`apps/sandbox`): `src/persist.worker.ts` (new), `src/scene.ts` (new: scene → engine options), `src/appState.ts` (new), `src/savePanel.ts` (new), `src/autosave.ts` (new), `src/main.ts`, `src/livingScript.ts`, `src/crowdScript.ts`, `test/autosave.test.ts`, `test/bootPlan.test.ts`, `e2e/save.spec.ts`, `e2e/save-bench.spec.ts`.

Docs: `CONTEXT.md` (Save, Save slot, Save region), `docs/adr/0004-saves-are-chunk-snapshots-in-content-addressed-blobs.md`, results appended to this plan.

**Commands used throughout** (from the repo root):
- one engine test file: `npx vitest run test/<file>.test.ts` in `packages/engine`
- engine typecheck: `npm run typecheck -w @elovox/engine`
- all suites: `npm test` ; all typechecks: `npm run typecheck`
- e2e: `E2E_PORT=5197 E2E_CHANNEL=msedge npx playwright test e2e/<file>.spec.ts --workers=1` in `apps/sandbox`

---

### Task 1: Section packing and blob codec

**Files:**
- Create: `packages/engine/src/persist/pack.ts`, `packages/engine/src/persist/codec.ts`
- Test: `packages/engine/test/pack.test.ts`

**Interfaces:**
- Produces:
  - `type PackArray = Int32Array | Uint32Array | Int16Array | Uint16Array | Uint8Array`
  - `interface Packed { json: unknown; arrays: Record<string, PackArray> }`
  - `pack(p: Packed): Uint8Array`, `unpack(bytes: Uint8Array): Packed` (arrays come back as fresh, aligned copies of the same types)
  - `gzip(b: Uint8Array): Promise<Uint8Array>`, `gunzip(b: Uint8Array): Promise<Uint8Array>`, `sha256(b: Uint8Array): Promise<string>` (64 lowercase hex chars)

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/pack.test.ts
import { describe, expect, it } from 'vitest'
import { pack, unpack } from '../src/persist/pack.ts'
import { gunzip, gzip, sha256 } from '../src/persist/codec.ts'

describe('section packing', () => {
  it('round-trips JSON and every array type, aligned', () => {
    const p = {
      json: { a: 1, list: [3, 'x'], nested: { ok: true } },
      arrays: {
        i32: Int32Array.from([-1, 2, 2147483647]), u32: Uint32Array.from([4294967295, 0]),
        i16: Int16Array.from([-32768, 7]), u16: Uint16Array.from([65535, 1, 2]), u8: Uint8Array.from([255]),
        empty: new Int32Array(0),
      },
    }
    const back = unpack(pack(p))
    expect(back.json).toEqual(p.json)
    for (const [k, v] of Object.entries(p.arrays)) {
      expect(back.arrays[k]!.constructor).toBe(v.constructor)
      expect([...back.arrays[k]!]).toEqual([...v])
      expect(back.arrays[k]!.byteOffset % 4).toBe(0)
    }
  })
  it('refuses bytes that are not a pack', () => {
    expect(() => unpack(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a packed section/)
  })
})

describe('blob codec', () => {
  it('gzip round-trips and shrinks zeros', async () => {
    const zeros = new Uint8Array(1 << 20)
    const z = await gzip(zeros)
    expect(z.length).toBeLessThan(4096)
    expect(await gunzip(z)).toEqual(zeros)
  })
  it('sha256 is the hex digest', async () => {
    expect(await sha256(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pack.test.ts` (in `packages/engine`)
Expected: FAIL — cannot resolve `../src/persist/pack.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/engine/src/persist/pack.ts
export type PackArray = Int32Array | Uint32Array | Int16Array | Uint16Array | Uint8Array
/** One save section: JSON for small structured state, typed arrays for bulk state. */
export interface Packed { json: unknown; arrays: Record<string, PackArray> }

const MAGIC = 0x4b505645 // 'EVPK' little endian
const TYPES = { Int32Array, Uint32Array, Int16Array, Uint16Array, Uint8Array } as const
type TypeName = keyof typeof TYPES
interface ArrayMeta { name: string; type: TypeName; length: number; offset: number }

const align4 = (n: number) => (n + 3) & ~3

/** [magic u32][header length u32][header JSON][pad to 4][arrays, each 4-aligned]. Array offsets count from the data start (after the pad). */
export function pack(p: Packed): Uint8Array {
  const metas: ArrayMeta[] = []
  let data = 0
  for (const [name, a] of Object.entries(p.arrays)) {
    metas.push({ name, type: a.constructor.name as TypeName, length: a.length, offset: data })
    data = align4(data + a.byteLength)
  }
  const header = new TextEncoder().encode(JSON.stringify({ json: p.json, arrays: metas }))
  const base = align4(8 + header.length)
  const out = new Uint8Array(base + data)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, MAGIC, true)
  dv.setUint32(4, header.length, true)
  out.set(header, 8)
  for (const m of metas) {
    const a = p.arrays[m.name]!
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), base + m.offset)
  }
  return out
}

export function unpack(bytes: Uint8Array): Packed {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 8 || dv.getUint32(0, true) !== MAGIC) throw new Error('not a packed section')
  const len = dv.getUint32(4, true)
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len))) as { json: unknown; arrays: ArrayMeta[] }
  const base = align4(8 + len)
  const arrays: Record<string, PackArray> = {}
  for (const m of head.arrays) {
    const T = TYPES[m.type]
    if (!T) throw new Error(`packed section: unknown array type ${m.type}`)
    // Copy into a fresh buffer: aligned, and the caller may keep or transfer it.
    const copy = bytes.slice(base + m.offset, base + m.offset + m.length * T.BYTES_PER_ELEMENT)
    arrays[m.name] = new T(copy.buffer, 0, m.length)
  }
  return { json: head.json, arrays }
}
```

```ts
// packages/engine/src/persist/codec.ts
async function through(b: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = await new Response(new Blob([b as BlobPart]).stream().pipeThrough(stream)).arrayBuffer()
  return new Uint8Array(out)
}
export const gzip = (b: Uint8Array): Promise<Uint8Array> => through(b, new CompressionStream('gzip'))
export const gunzip = (b: Uint8Array): Promise<Uint8Array> => through(b, new DecompressionStream('gzip'))
export async function sha256(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))
  let s = ''
  for (const x of d) s += x.toString(16).padStart(2, '0')
  return s
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pack.test.ts`
Expected: PASS (4 tests). Then `npm run typecheck -w @elovox/engine`: 0 errors (if `BlobPart`/`BufferSource` casts are rejected by TS 7, drop the cast the compiler complains about; keep the runtime code).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/persist/pack.ts packages/engine/src/persist/codec.ts packages/engine/test/pack.test.ts
git commit -m "feat(persist): section packing and gzip/sha-256 blob codec"
```

---

### Task 2: Save regions and region write revisions

**Files:**
- Modify: `packages/engine/src/world/chunkStore.ts` (constructor, `openChunk`)
- Create: `packages/engine/src/persist/regions.ts`
- Test: `packages/engine/test/saveRegions.test.ts`

**Interfaces:**
- Consumes: `ChunkStore`, `Layout`, `CHUNK_VOLUME`, `decodeUniform`.
- Produces:
  - `REGION_CHUNKS = 8`, `REGION_FORMAT = 1`
  - `regionGrid(L: Layout): { rx: number; rz: number; count: number }`
  - `regionOfChunk(L: Layout, ci: number): number`
  - `ChunkStore.regionRevisions: Uint32Array` — bumped once per chunk each time a chunk is opened for writing (every voxel, light, quiet or dense write; `touchChunks` too)
  - `encodeRegion(store: ChunkStore, r: number): Uint8Array`
  - `decodeRegion(bytes: Uint8Array, L: Layout, r: number, put: (ci: number, data: Uint16Array | number) => void): void` — `number` = uniform voxel. The blob does not name its region (the manifest does), so equal regions share a blob.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/saveRegions.test.ts
import { describe, expect, it } from 'vitest'
import { ChunkStore } from '../src/world/chunkStore.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { CHUNK_VOLUME, Layout } from '../src/world/layout.ts'
import { decodeRegion, encodeRegion, regionGrid, regionOfChunk } from '../src/persist/regions.ts'

const opaque = new Uint8Array(16).fill(1); opaque[0] = 0
const store = (size: [number, number, number]) => new ChunkStore({ buffers: createWorldBuffers(size), opaque })

describe('save regions', () => {
  it('tiles the world in 8 × 8 chunk columns, clipping the last row', () => {
    const L = new Layout([320, 64, 256])
    expect(regionGrid(L)).toEqual({ rx: 2, rz: 1, count: 2 })
    expect(regionOfChunk(L, L.chunkIndex(7, 1, 7))).toBe(0)
    expect(regionOfChunk(L, L.chunkIndex(8, 0, 0))).toBe(1)
  })
  it('round-trips uniform and dense chunks, state bits included', () => {
    const s = store([256, 64, 256])
    s.setVoxel(3, 40, 5, 2 | (5 << 12)); s.setVoxel(200, 1, 200, 7)
    s.commit()
    const got = new Map<number, Uint16Array | number>()
    decodeRegion(encodeRegion(s, 0), s.layout, 0, (ci, d) => got.set(ci, typeof d === 'number' ? d : d.slice()))
    expect(got.size).toBe(8 * 8 * 2)
    const dense = got.get(s.layout.chunkOf(3, 40, 5)) as Uint16Array
    expect(dense.length).toBe(CHUNK_VOLUME)
    expect(dense[Layout.localIndex(3, 40 & 31, 5)]).toBe(2 | (5 << 12))
    expect(got.get(s.layout.chunkIndex(4, 0, 4))).toBe(0)
  })
  it('bumps the region revision on every kind of write, and only that region', () => {
    const s = store([512, 32, 256])
    const before = s.regionRevisions.slice()
    s.setVoxel(300, 1, 10, 1); s.commit()
    expect(s.regionRevisions[1]).toBeGreaterThan(before[1]!)
    expect(s.regionRevisions[0]).toBe(before[0])
    s.setVoxelQuiet(10, 1, 10, 3); s.commit()
    expect(s.regionRevisions[0]).toBeGreaterThan(before[0]!)
  })
  it('refuses another format version', () => {
    const s = store([256, 32, 256])
    const b = encodeRegion(s, 0); b[4] = 99
    expect(() => decodeRegion(b, s.layout, 0, () => {})).toThrow(/region format 99/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/saveRegions.test.ts`
Expected: FAIL — cannot resolve `../src/persist/regions.ts`.

- [ ] **Step 3: Write the implementation**

`packages/engine/src/persist/regions.ts`:

```ts
import { decodeUniform } from '../world/buffers.ts'
import type { ChunkStore } from '../world/chunkStore.ts'
import { CHUNK_VOLUME, type Layout } from '../world/layout.ts'

/** A save region is REGION_CHUNKS × REGION_CHUNKS chunk columns (256 × 256 blocks), full height; edge regions are clipped. */
export const REGION_CHUNKS = 8
export const REGION_FORMAT = 1
const MAGIC = 0x47525645 // 'EVRG'

export function regionGrid(L: Layout): { rx: number; rz: number; count: number } {
  const rx = Math.ceil(L.cx / REGION_CHUNKS), rz = Math.ceil(L.cz / REGION_CHUNKS)
  return { rx, rz, count: rx * rz }
}
export function regionOfChunk(L: Layout, ci: number): number {
  const [cx, , cz] = L.chunkCoords(ci)
  return Math.floor(cx / REGION_CHUNKS) + Math.floor(cz / REGION_CHUNKS) * regionGrid(L).rx
}
/** Region r's chunks in a fixed order: cy, then cz, then cx. */
function regionChunks(L: Layout, r: number): number[] {
  const { rx } = regionGrid(L), x0 = (r % rx) * REGION_CHUNKS, z0 = Math.floor(r / rx) * REGION_CHUNKS
  const out: number[] = []
  for (let cy = 0; cy < L.cy; cy++) for (let cz = z0; cz < Math.min(L.cz, z0 + REGION_CHUNKS); cz++) for (let cx = x0; cx < Math.min(L.cx, x0 + REGION_CHUNKS); cx++) out.push(L.chunkIndex(cx, cy, cz))
  return out
}

/** [magic u32][format u16][chunks u16] then per chunk: kind u8 (0 uniform, 1 dense), then a u16 voxel or 32³ u16 voxels. */
export function encodeRegion(store: ChunkStore, r: number): Uint8Array {
  const chunks = regionChunks(store.layout, r)
  let size = 8
  for (const ci of chunks) size += store.table[ci]! < 0 ? 3 : 1 + CHUNK_VOLUME * 2
  const out = new Uint8Array(size), dv = new DataView(out.buffer)
  dv.setUint32(0, MAGIC, true); dv.setUint16(4, REGION_FORMAT, true); dv.setUint16(6, chunks.length, true)
  let at = 8
  for (const ci of chunks) {
    const e = store.table[ci]!
    if (e < 0) { out[at] = 0; dv.setUint16(at + 1, decodeUniform(e), true); at += 3; continue }
    out[at++] = 1
    const v = store.views.voxels(e)
    out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), at) // little-endian hosts only (every browser/Node we run)
    at += CHUNK_VOLUME * 2
  }
  return out
}

export function decodeRegion(bytes: Uint8Array, L: Layout, r: number, put: (ci: number, data: Uint16Array | number) => void): void {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 8 || dv.getUint32(0, true) !== MAGIC) throw new Error('not a save region')
  const format = dv.getUint16(4, true)
  if (format !== REGION_FORMAT) throw new Error(`region format ${format}, engine expects ${REGION_FORMAT}`)
  const chunks = regionChunks(L, r)
  if (dv.getUint16(6, true) !== chunks.length) throw new Error(`region ${r} holds ${dv.getUint16(6, true)} chunks, the world expects ${chunks.length}`)
  let at = 8
  for (const ci of chunks) {
    if (bytes[at] === 0) { put(ci, dv.getUint16(at + 1, true)); at += 3; continue }
    const copy = bytes.slice(at + 1, at + 1 + CHUNK_VOLUME * 2)
    put(ci, new Uint16Array(copy.buffer))
    at += 1 + CHUNK_VOLUME * 2
  }
}
```

`packages/engine/src/world/chunkStore.ts` — add the counter (import `regionGrid`, `regionOfChunk` from `../persist/regions.ts`):

```ts
  /** Per save region (persist/regions.ts): bumped whenever one of its chunks is opened for writing. Incremental saves copy regions whose count moved. */
  readonly regionRevisions: Uint32Array
  private readonly regionOf: Uint16Array
```

In the constructor, after `this.versions = ...`:

```ts
    this.regionRevisions = new Uint32Array(regionGrid(this.layout).count)
    this.regionOf = new Uint16Array(this.layout.chunkCount)
    for (let ci = 0; ci < this.layout.chunkCount; ci++) this.regionOf[ci] = regionOfChunk(this.layout, ci)
```

In `openChunk`, after `this.open.add(ci)`:

```ts
    this.regionRevisions[this.regionOf[ci]!]!++
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/saveRegions.test.ts test/chunkStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/persist/regions.ts packages/engine/src/world/chunkStore.ts packages/engine/test/saveRegions.test.ts
git commit -m "feat(persist): save regions and per-region write revisions"
```

---

### Task 3: Simulation snapshot and restore core (voxels, tick, scheduler)

**Files:**
- Create: `packages/engine/src/sim/snapshot.ts`, `packages/engine/test/persistHelpers.ts`
- Modify: `packages/engine/src/sim/scheduler.ts`, `packages/engine/src/sim/simulation.ts`
- Test: `packages/engine/test/simSnapshot.test.ts`

**Interfaces:**
- Consumes: Task 1 `pack/unpack`, Task 2 `encodeRegion/decodeRegion/regionRevisions`.
- Produces:

```ts
// sim/snapshot.ts
export type SectionName = 'scheduler' | 'water' | 'gravity' | 'collapse' | 'workers'
/** Bumped when a section's packed layout changes; a save with another version is refused (persist/manifest.ts). */
export const SECTION_VERSIONS: Readonly<Record<SectionName | 'app', number>> = { scheduler: 1, water: 1, gravity: 1, collapse: 1, workers: 1, app: 1 }
export interface RegionBlob { r: number; bytes: Uint8Array }
export interface SimSnapshot {
  tick: number; paused: boolean
  /** Every save region's write revision at the snapshot: the baseline of the next incremental save. */
  revisions: Uint32Array
  /** Only the regions asked for. */
  regions: RegionBlob[]
  sections: { name: SectionName; bytes: Uint8Array }[]
  /** Wall time the sim spent (its stall). */
  ms: number
}
export interface SimRestore {
  tick: number; paused: boolean
  /** Every region of the world. */
  regions: RegionBlob[]
  sections: Partial<Record<SectionName, Uint8Array>>
}
```

  - `Scheduler.entries(): { pairs: Int32Array; seq: number }` (pairs = `[pos, dueTick, …]` in drain order) and `Scheduler.restore(pairs: Int32Array, seq: number): void`
  - `Simulation.snapshot(since: Uint32Array | null): SimSnapshot`
  - `Simulation.restore(s: SimRestore): number[]` — call on a fresh `Simulation` instead of `generate()`, after `configure()`; returns every chunk index (like `finishGenerate`)
  - test helpers: `richSim()`, `richScript(sim, t)`, `richOptions(buffers)`, `RICH_SIZE`, `R` (block ids), `toRestore(snapshot)`, `restored(snapshot)`, `fullRestore(sim)`, `voxelsEqual(a, b)`

- [ ] **Step 1: Write the helpers and the failing test**

```ts
// packages/engine/test/persistHelpers.ts
import { defineBlock, type BlockDef } from '../src/blocks/registry.ts'
import { defineRules } from '../src/sim/rules.ts'
import { Simulation, type SimulationOptions } from '../src/sim/simulation.ts'
import type { SimRestore, SimSnapshot } from '../src/sim/snapshot.ts'
import { createWorldBuffers, type WorldBuffers } from '../src/world/buffers.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, WATER_BLOCKS, fillGenerator, w } from './waterHelpers.ts'
import type { Command } from '../src/sim/commands.ts'

export const RICH_BLOCKS: BlockDef[] = [...WATER_BLOCKS, defineBlock({ name: 'beam', collapses: true }), defineBlock({ name: 'planks' })]
export const R = { ...B, beam: 10, planks: 11 } as const
export const RICH_SIZE: [number, number, number] = [64, 32, 64]

/** Sand schedules itself when a neighbour changes and slides down into air: keeps the scheduler busy. */
const RULES = defineRules({ blocks: {
  dirt: {
    onNeighborChanged(ctx, x, y, z) { ctx.schedule(x, y, z, 2 + Math.floor(ctx.random() * 3)) },
    onScheduledTick(ctx, x, y, z, v) { if (y > 4 && ctx.isAir(ctx.get(x, y - 1, z))) { ctx.set(x, y, z, AIR); ctx.set(x, y - 1, z, v) } },
  },
} })

export function richOptions(buffers: WorldBuffers): SimulationOptions {
  return { buffers, blocks: RICH_BLOCKS, rules: RULES, seed: 5, randomTicksPerChunk: 0, log: () => {},
    workers: { materials: { stone: { digTicks: 4, buildTicks: 3 }, planks: { digTicks: 2, buildTicks: 3 } } } }
}

/** Stone floor (y < 4); a walled basin of water at x, z ∈ [4, 15]; a beam bridge on two stone posts at z = 30. */
function richFill(x: number, y: number, z: number): number {
  if (y < 4) return R.stone
  const inBasin = x >= 4 && x <= 15 && z >= 4 && z <= 15
  if (inBasin && (x === 4 || x === 15 || z === 4 || z === 15) && y <= 9) return R.stone
  if (inBasin && y <= 8) return w(7)
  if (z === 30 && (x === 20 || x === 26) && y <= 8) return R.stone
  if (z === 30 && x >= 20 && x <= 26 && y === 9) return R.beam
  return AIR
}

export function richSim(): Simulation {
  const sim = new Simulation(richOptions(createWorldBuffers(RICH_SIZE)))
  const gen = fillGenerator(richFill)
  sim.configure(gen, null)
  sim.generate(gen)
  return sim
}

let seq = 0
const submit = (sim: Simulation, cmd: Command) => sim.submit(0, ++seq, cmd)
/** Everything at once: units, a dig and a build order, a breached basin, falling dirt, a cut beam post, a long walk. */
export function richScript(sim: Simulation, t: number): void {
  if (t === 0) { submit(sim, { type: 'unitSpawn', pos: [40, 4, 40], stock: [{ block: R.planks, count: 30 }] }); submit(sim, { type: 'unitSpawn', pos: [44, 4, 40] }) }
  if (t === 2) submit(sim, { type: 'workDig', min: [48, 3, 48], max: [50, 3, 50] })
  if (t === 3) submit(sim, { type: 'workBuild', min: [36, 4, 50], max: [38, 5, 52], voxel: R.planks })
  if (t === 6) submit(sim, { type: 'fillRegion', min: [15, 5, 8], max: [15, 9, 11], voxel: AIR })
  if (t === 8) for (let x = 30; x < 34; x++) submit(sim, { type: 'setBlock', pos: [x, 20, 20], voxel: R.dirt })
  if (t === 9) submit(sim, { type: 'setBlock', pos: [34, 25, 25], voxel: R.sand })
  // Remove the east post, then cut the beam next to the west post: the east part falls as one fragment.
  if (t === 10) submit(sim, { type: 'fillRegion', min: [26, 4, 30], max: [26, 8, 30], voxel: AIR })
  if (t === 11) submit(sim, { type: 'setBlock', pos: [21, 9, 30], voxel: AIR })
  if (t === 12) submit(sim, { type: 'unitMove', ids: [2], pos: [60, 4, 10] })
}

/** The SimRestore a full snapshot stands for (every region was included). */
export function toRestore(s: SimSnapshot): SimRestore {
  return { tick: s.tick, paused: s.paused, regions: s.regions, sections: Object.fromEntries(s.sections.map(x => [x.name, x.bytes])) }
}

/** A new Simulation (same options, fresh buffers) restored from a full snapshot. */
export function restored(s: SimSnapshot): Simulation {
  const sim = new Simulation(richOptions(createWorldBuffers(RICH_SIZE)))
  sim.configure(fillGenerator(richFill), null)
  sim.restore(toRestore(s))
  return sim
}
export const fullRestore = (sim: Simulation): Simulation => restored(sim.snapshot(null))

export function voxelsEqual(a: Simulation, b: Simulation): boolean {
  const [sx, sy, sz] = a.layout.size
  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) if (a.store.getVoxel(x, y, z) !== b.store.getVoxel(x, y, z)) return false
  return true
}
```

```ts
// packages/engine/test/simSnapshot.test.ts
import { describe, expect, it } from 'vitest'
import { Scheduler } from '../src/sim/scheduler.ts'
import { fullRestore, richScript, richSim, restored, voxelsEqual } from './persistHelpers.ts'

describe('scheduler entries', () => {
  it('restores the same drain order and keeps counting', () => {
    const a = new Scheduler()
    a.schedule(5, 10); a.schedule(3, 4); a.schedule(9, 10); a.schedule(5, 7) // 5 moves earlier
    const { pairs, seq } = a.entries()
    const b = new Scheduler(); b.restore(pairs, seq)
    expect(b.size).toBe(3)
    expect(b.drain(100, 10)).toEqual(a.drain(100, 10))
    expect(b.entries().seq).toBe(seq)
  })
})

describe('simulation snapshot', () => {
  it('restores voxels, tick, paused and the scheduler; the run continues identically', () => {
    const sim = richSim()
    for (let t = 0; t < 10; t++) { richScript(sim, t); sim.step() }
    sim.setPaused(true); sim.setPaused(false)
    const a = fullRestore(sim), b = fullRestore(sim)
    expect(a.tick).toBe(sim.tick)
    expect(voxelsEqual(a, sim)).toBe(true)
    expect(a.pendingWork).toBe(sim.pendingWork)
    for (let t = 0; t < 40; t++) { a.step(); b.step() }
    expect(a.hash()).toBe(b.hash())
  })
  it('copies only regions written since the baseline', () => {
    const sim = richSim()
    const first = sim.snapshot(null)
    expect(first.regions.length).toBe(1) // 64² is one region
    const again = sim.snapshot(first.revisions)
    expect(again.regions.length).toBe(0)
    sim.submit(0, 1, { type: 'setBlock', pos: [1, 20, 1], voxel: 1 }); sim.step()
    expect(sim.snapshot(first.revisions).regions.length).toBe(1)
  })
  it('starts a restored world with zero revisions', () => {
    const r = restored(richSim().snapshot(null))
    expect([...r.store.regionRevisions]).toEqual([0])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/simSnapshot.test.ts`
Expected: FAIL — `../src/sim/snapshot.ts` missing / `entries` not a function.

- [ ] **Step 3: Implement**

`sim/snapshot.ts`: the types and `SECTION_VERSIONS` from the Interfaces block above.

`sim/scheduler.ts` — add:

```ts
  /** Every pending update as [pos, due tick] pairs in drain order (due tick, then insertion), and the sequence counter. */
  entries(): { pairs: Int32Array; seq: number } {
    const all = [...this.due].sort((a, b) => a[1].tick - b[1].tick || a[1].seq - b[1].seq)
    const pairs = new Int32Array(all.length * 2)
    all.forEach(([pos, d], i) => { pairs[2 * i] = pos; pairs[2 * i + 1] = d.tick })
    return { pairs, seq: this.seq }
  }

  /** Replaces the queue with `pairs` (entries() order) and resumes the sequence at `seq`. */
  restore(pairs: Int32Array, seq: number): void {
    this.due.clear(); this.buckets.clear(); this.ticks.length = 0; this.seq = 0
    for (let i = 0; i < pairs.length; i += 2) this.schedule(pairs[i]!, pairs[i + 1]!)
    this.seq = seq
  }
```

`sim/simulation.ts` — imports: `pack, unpack, type Packed` from `../persist/pack.ts`; `decodeRegion, encodeRegion` from `../persist/regions.ts`; `type RegionBlob, type SectionName, type SimRestore, type SimSnapshot` from `./snapshot.ts`. Add the methods (the water/gravity/collapse/workers lines arrive in Tasks 4–6; leave a `sections` array with only `scheduler` now):

```ts
  /**
   * The state a save needs, taken between two ticks (spec §4–5): the regions whose revision differs from `since` (all when
   * null) and every section. Navigation, light and publication state are not included: restore() rebuilds them.
   */
  snapshot(since: Uint32Array | null): SimSnapshot {
    const t0 = performance.now()
    const revs = this.store.regionRevisions
    const regions: RegionBlob[] = []
    for (let r = 0; r < revs.length; r++) if (!since || since[r] !== revs[r]) regions.push({ r, bytes: encodeRegion(this.store, r) })
    const sections: { name: SectionName; bytes: Uint8Array }[] = [{ name: 'scheduler', bytes: pack(this.schedulerState()) }]
    return { tick: this.tick, paused: this.isPaused, revisions: revs.slice(), regions, sections, ms: performance.now() - t0 }
  }

  /**
   * Boots this (fresh, configured, never generated) simulation from a save instead of generate(): fills every chunk,
   * relights, rebuilds water from the voxels, then restores each section over it. Returns every chunk index.
   */
  restore(s: SimRestore): number[] {
    const scratch = new Uint16Array(CHUNK_VOLUME)
    for (const { r, bytes } of s.regions) decodeRegion(bytes, this.layout, r, (ci, data) => {
      const vox = typeof data === 'number' ? scratch.fill(data) : data
      this.store.writeChunkDense(ci, vox)
      this.collapse.replaceChunk(ci, vox, true)
    })
    const chunks = this.finishGenerate()
    this.tick = s.tick
    this.isPaused = s.paused
    const section = (name: SectionName): Packed | null => { const b = s.sections[name]; return b ? unpack(b) : null }
    const sched = section('scheduler')
    if (sched) {
      const j = sched.json as { seq: number }
      this.scheduler.restore(sched.arrays.pairs as Int32Array, j.seq)
      this.neighbors = [...(sched.arrays.neighbors as Int32Array)]
      this.neighborHead = 0
    }
    this.store.regionRevisions.fill(0)
    return chunks
  }

  private schedulerState(): Packed {
    const { pairs, seq } = this.scheduler.entries()
    return { json: { seq }, arrays: { pairs, neighbors: Int32Array.from(this.neighbors.slice(this.neighborHead)) } }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/simSnapshot.test.ts test/determinism.test.ts test/simulation.test.ts`
Expected: PASS. (The hash test passes even though water/units are not restored yet: both restored sims are equal to each other.)

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sim/snapshot.ts packages/engine/src/sim/scheduler.ts packages/engine/src/sim/simulation.ts packages/engine/test/persistHelpers.ts packages/engine/test/simSnapshot.test.ts
git commit -m "feat(persist): simulation snapshot/restore of voxels, tick and scheduler"
```

---

### Task 4: Water snapshot and restore

**Files:**
- Modify: `packages/engine/src/sim/water/columns.ts`, `packages/engine/src/sim/water/waterSystem.ts`, `packages/engine/src/sim/simulation.ts`
- Test: `packages/engine/test/waterSnapshot.test.ts`

**Interfaces:**
- Consumes: Task 1 `Packed`; Task 3 `Simulation.snapshot/restore`, helpers.
- Produces:
  - `WaterColumns.state(): { depth: Int32Array; flux: Int32Array; last: Int32Array; cursor: number; stepNo: number }` (live arrays, caller copies)
  - `WaterColumns.restoreState(depth, flux, last, cursor, stepNo): void`
  - `WaterSystem.snapshot(): Packed`, `WaterSystem.restore(p: Packed): void` (call right after `rebuild()`)
  - section `water` in `Simulation.snapshot/restore`

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/waterSnapshot.test.ts
import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, WATER_BLOCKS, fillGenerator, lake, spring, w } from './waterHelpers.ts'

function sim(fill: (x: number, y: number, z: number) => number, seaLevel?: number) {
  const s = new Simulation({ buffers: createWorldBuffers([64, 32, 64]), blocks: WATER_BLOCKS, seed: 1, randomTicksPerChunk: 0, log: () => {} })
  const gen = fillGenerator(fill, seaLevel); s.configure(gen, null); s.generate(gen); return s
}
function restore(src: Simulation, fill: (x: number, y: number, z: number) => number, seaLevel?: number) {
  const snap = src.snapshot(null)
  const s = new Simulation({ buffers: createWorldBuffers([64, 32, 64]), blocks: WATER_BLOCKS, seed: 1, randomTicksPerChunk: 0, log: () => {} })
  s.configure(fillGenerator(fill, seaLevel), null)
  s.restore({ tick: snap.tick, paused: snap.paused, regions: snap.regions, sections: Object.fromEntries(snap.sections.map(x => [x.name, x.bytes])) })
  return s
}
const cols = (s: Simulation) => s.water.cols.state()

describe('water snapshot', () => {
  it('continues a moving flood with no jump: depth, flux and the sea account are exact at load', () => {
    const fill = lake(6, 12, 8)
    const a = sim(fill)
    a.submit(0, 1, { type: 'fillRegion', min: [11, 1, 3], max: [11, 7, 6], voxel: AIR }) // breach
    for (let t = 0; t < 25; t++) a.step()
    const b = restore(a, fill)
    expect([...cols(b).depth]).toEqual([...cols(a).depth])
    expect([...cols(b).flux]).toEqual([...cols(a).flux])
    expect(b.water.sea).toBe(a.water.sea)
    expect(b.water.check()).toEqual([])
    // Two loads run identically, and the water keeps the same total.
    const c = restore(a, fill)
    for (let t = 0; t < 200; t++) { b.step(); c.step() }
    expect(b.hash()).toBe(c.hash())
    expect(b.water.check()).toEqual([])
  })
  it('keeps springs in order and lower segments with their water', () => {
    // A roofed pocket (lower segment) beside a spring under open sky.
    const fill = (x: number, y: number, z: number) => {
      if (y === 0) return B.stone
      if (y === 6 && x >= 20 && x < 30 && z >= 20 && z < 30) return B.stone // roof
      if (y >= 1 && y <= 4 && x >= 20 && x < 30 && z >= 20 && z < 30) return w(7)
      if (x === 40 && z === 40 && y === 1) return spring(4)
      return AIR
    }
    const a = sim(fill)
    for (let t = 0; t < 30; t++) a.step()
    const b = restore(a, fill)
    expect([...b.water.cycle.springs]).toEqual([...a.water.cycle.springs])
    expect(b.water.segments(25, 25)).toEqual(a.water.segments(25, 25))
    expect(b.water.check()).toEqual([])
  })
  it('save → load → save gives the same water section', () => {
    const fill = lake(6, 12, 8)
    const a = sim(fill)
    a.submit(0, 1, { type: 'fillRegion', min: [11, 1, 3], max: [11, 7, 6], voxel: AIR })
    for (let t = 0; t < 15; t++) a.step()
    const b = restore(a, fill)
    const wa = a.snapshot(null).sections.find(s => s.name === 'water')!.bytes
    const wb = b.snapshot(null).sections.find(s => s.name === 'water')!.bytes
    expect(wb).toEqual(wa)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/waterSnapshot.test.ts`
Expected: FAIL — `state` is not a function.

- [ ] **Step 3: Implement**

`sim/water/columns.ts` — inside `WaterColumns`:

```ts
  /** The per-column state a save keeps (live arrays: copy them). `falls` is per-step scratch and is not part of it. */
  state(): { depth: Int32Array; flux: Int32Array; last: Int32Array; cursor: number; stepNo: number } {
    return { depth: this.depth, flux: this.flux, last: this.last, cursor: this.cursor, stepNo: this.stepNo }
  }
  restoreState(depth: Int32Array, flux: Int32Array, last: Int32Array, cursor: number, stepNo: number): void {
    if (depth.length !== this.n || flux.length !== 2 * this.n || last.length !== this.n) throw new Error('water restore: column count differs from the world')
    this.depth.set(depth); this.flux.set(flux); this.last.set(last)
    this.cursor = cursor; this.stepNo = stepNo
  }
```

`sim/water/waterSystem.ts` — import `type Packed` from `../../persist/pack.ts`; add:

```ts
interface WaterJson { steps: number; sea: number; springs: number[]; cursor: number; stepNo: number; needsRebuild: boolean }
const UNDER_FIELDS = 6, EDGE_FIELDS = 5
```

and inside `WaterSystem`:

```ts
  /**
   * Plan deviation 4: what a rebuild from the voxels cannot recover. Lower segments and under edges are named by column
   * and floor (ceil checked), never by pool index; a body's excess goes to its first member, as dropBody does.
   */
  snapshot(): Packed {
    const cols = this.cols, U = this.under, n = cols.n
    const bodyExcess = new Map<number, number>()
    for (const b of this.bodies.list) if (b.members.length) bodyExcess.set(b.members[0]!, b.excess)
    const under: number[] = []
    for (let c = 0; c < n; c++) for (let i = U.first[c]!; i >= 0; i = U.next[i]!) {
      under.push(c, U.floor[i]!, U.ceil[i]!, U.depth[i]!, U.last[i]!, U.excess[i]! + (bodyExcess.get(i) ?? 0))
    }
    const end = (ref: number): [number, number] => ref < n ? [ref, -1] : [U.col[ref - n]!, U.floor[ref - n]!]
    const edges: number[] = []
    for (const E of this.edges.tiles) if (E) for (let e = 0; e < E.count; e++) if (E.flux[e] !== 0) edges.push(...end(E.a[e]!), ...end(E.b[e]!), E.flux[e]!)
    const s = cols.state()
    const json: WaterJson = { steps: this.steps, sea: this.cycle.sea, springs: [...this.cycle.springs], cursor: s.cursor, stepNo: s.stepNo, needsRebuild: this.needsRebuild }
    return { json, arrays: {
      depth: s.depth.slice(), flux: s.flux.slice(), last: s.last.slice(),
      awake: cols.tiles.awake.slice(), quiet: cols.tiles.quiet.slice(),
      under: Int32Array.from(under), edges: Int32Array.from(edges),
    } }
  }

  /** Over a fresh rebuild() of the same voxels: puts back the exact water (plan deviation 4). */
  restore(p: Packed): void {
    if (this.water === 0) return
    const j = p.json as WaterJson, a = p.arrays, cols = this.cols, U = this.under
    if (j.needsRebuild) { this.needsRebuild = true; return }
    cols.restoreState(a.depth as Int32Array, a.flux as Int32Array, a.last as Int32Array, j.cursor, j.stepNo)
    const u = a.under as Int32Array
    for (let k = 0; k < u.length; k += UNDER_FIELDS) {
      const i = this.lowerAt(u[k]!, u[k + 1]!)
      if (i < 0 || U.ceil[i] !== u[k + 2]) { this.port.log(`water restore: column ${u[k]} has no lower segment ${u[k + 1]}–${u[k + 2]}; its water is dropped`); continue }
      U.depth[i] = u[k + 3]!; U.last[i] = u[k + 4]!; U.excess[i] = u[k + 5]!
    }
    this.bodies.dropAll()
    this.bodies.seedFull()
    this.edges.ensure(cols, U, this.height)
    const byEnds = new Map<number, { E: TileEdges; e: number }>()
    for (const E of this.edges.tiles) if (E) for (let e = 0; e < E.count; e++) byEnds.set(E.a[e]! * 4294967296 + E.b[e]!, { E, e })
    const ed = a.edges as Int32Array
    for (let k = 0; k < ed.length; k += EDGE_FIELDS) {
      const ra = this.refAt(ed[k]!, ed[k + 1]!), rb = this.refAt(ed[k + 2]!, ed[k + 3]!)
      const hit = ra < 0 || rb < 0 ? undefined : byEnds.get(ra * 4294967296 + rb)
      if (hit) hit.E.flux[hit.e] = ed[k + 4]!
    }
    const cy = this.cycle
    cy.findSea(cols)
    cy.sea = j.sea
    cy.springs.clear()
    for (const s of j.springs) cy.springs.add(s)
    cols.tiles.awake.set(a.awake as Uint8Array)
    cols.tiles.quiet.set(a.quiet as Uint8Array)
    cols.tiles.dirty.fill(1)
    this.steps = j.steps
    this.needsRebuild = false
    this.expected = this.total()
  }

  private lowerAt(c: number, floor: number): number {
    for (let i = this.under.first[c]!; i >= 0; i = this.under.next[i]!) if (this.under.floor[i] === floor) return i
    return -1
  }
  /** A segment ref from its column and floor (−1: the top segment). −1 when the column has no such segment. */
  private refAt(c: number, floor: number): number {
    if (floor < 0) return c
    const i = this.lowerAt(c, floor)
    return i < 0 ? -1 : this.under.n + i
  }
```

Import `type TileEdges` from `./edges.ts`. `total()` is a member of the same class, so it is reachable even if private.

`sim/simulation.ts` — in `snapshot()` push `{ name: 'water', bytes: pack(this.water.snapshot()) }`; in `restore()` after the scheduler block:

```ts
    const water = section('water')
    if (water) this.water.restore(water)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/waterSnapshot.test.ts test/simSnapshot.test.ts test/waterLayersWorld.test.ts test/waterBodies.test.ts`
Expected: PASS. If the lower-segment test finds a different `segments()` result, print both and check that `rebuildSegments` produced the same floors/ceils (it must: they come from the voxels); a mismatch is a real bug in the restore matching, not a test to loosen.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sim/water/columns.ts packages/engine/src/sim/water/waterSystem.ts packages/engine/src/sim/simulation.ts packages/engine/test/waterSnapshot.test.ts
git commit -m "feat(persist): water snapshot/restore over a rebuild (exact depth, flux, sea, springs)"
```

---

### Task 5: Falling blocks and structural fragments

**Files:**
- Modify: `packages/engine/src/sim/gravity.ts`, `packages/engine/src/sim/collapse.ts`, `packages/engine/src/sim/simulation.ts`
- Test: `packages/engine/test/physicsSnapshot.test.ts`

**Interfaces:**
- Produces: `GravitySystem.snapshot(): Packed`, `GravitySystem.restore(p: Packed): void`, `CollapseSystem.snapshot(): Packed`, `CollapseSystem.restore(p: Packed): void` (restore queues a `born` entry with `source: []` per fragment so the next `publication()` announces it); sections `gravity`, `collapse`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/physicsSnapshot.test.ts
import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { AIR } from '../src/world/voxel.ts'

const blocks = [{ name: 'stone' }, { name: 'beam', collapses: true }, { name: 'sand', falls: true }, { name: 'water', liquid: true }]
const gen = { generateColumn(ctx: { set(x: number, y: number, z: number, v: number): void }) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) ctx.set(x, 0, z, 1) } }
function make() { const s = new Simulation({ buffers: createWorldBuffers([64, 32, 32]), blocks, seed: 17, randomTicksPerChunk: 0, log: () => {} }); s.generate(gen); return s }
function load(src: Simulation) {
  const snap = src.snapshot(null), s = new Simulation({ buffers: createWorldBuffers([64, 32, 32]), blocks, seed: 17, randomTicksPerChunk: 0, log: () => {} })
  s.restore({ tick: snap.tick, paused: snap.paused, regions: snap.regions, sections: Object.fromEntries(snap.sections.map(x => [x.name, x.bytes])) })
  return s
}

describe('falling bodies and fragments in a save', () => {
  it('keeps sand in mid-air falling where it was', () => {
    const a = make()
    a.submit(0, 1, { type: 'setBlock', pos: [5, 25, 5], voxel: 3 })
    for (let t = 0; t < 6; t++) a.step()
    expect(a.gravity.count).toBe(1)
    const b = load(a)
    expect(b.gravity.snapshot()).toEqual(a.gravity.snapshot())
    for (let t = 0; t < 60; t++) b.step()
    expect(b.store.getVoxel(5, 1, 5)).toBe(3)
  })
  it('keeps a falling fragment, announces it again, and lands it', () => {
    const a = make()
    a.submit(0, 1, { type: 'fillRegion', min: [10, 1, 10], max: [10, 9, 10], voxel: 1 })
    a.submit(0, 2, { type: 'fillRegion', min: [10, 10, 10], max: [16, 10, 10], voxel: 2 })
    a.step()
    a.submit(0, 3, { type: 'fillRegion', min: [10, 1, 10], max: [10, 9, 10], voxel: AIR })
    let t = 0
    while (a.collapse.stats().fragments === 0 && t++ < 200) a.step()
    a.step(); a.step()
    expect(a.collapse.stats().fragments).toBe(1)
    const b = load(a)
    expect(b.collapse.stats().fragments).toBe(1)
    const first = b.step()
    expect(first.collapse?.born.length).toBe(1)
    for (let i = 0; i < 200 && b.collapse.busy; i++) b.step()
    expect(b.collapse.stats().fragments).toBe(0)
    let beams = 0
    for (let x = 10; x <= 16; x++) if ((b.store.getVoxel(x, 1, 10) & 0xfff) === 2) beams++
    expect(beams).toBe(7)
  })
  it('two loads of a save taken mid-collapse run identically', () => {
    const a = make()
    a.submit(0, 1, { type: 'fillRegion', min: [10, 1, 10], max: [10, 9, 10], voxel: 1 })
    a.submit(0, 2, { type: 'fillRegion', min: [10, 10, 10], max: [16, 10, 10], voxel: 2 })
    a.step()
    a.submit(0, 3, { type: 'setBlock', pos: [10, 5, 10], voxel: AIR })
    a.step()
    const b = load(a), c = load(a)
    for (let t = 0; t < 150; t++) { b.step(); c.step() }
    expect(b.hash()).toBe(c.hash())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/physicsSnapshot.test.ts`
Expected: FAIL — the restored sim has no falling body (`gravity.count` 0 / snapshot mismatch).

- [ ] **Step 3: Implement**

`sim/gravity.ts` (import `type Packed`):

```ts
  snapshot(): Packed {
    return { json: { nextId: this.nextId, bodies: this.bodies.map(b => ({ ...b })), pending: [...this.pending] }, arrays: {} }
  }
  restore(p: Packed): void {
    const j = p.json as { nextId: number; bodies: FallingBodyState[]; pending: number[] }
    this.nextId = j.nextId
    this.bodies = j.bodies.map(b => ({ ...b }))
    this.pending.length = 0; this.pendingSet.clear()
    for (const pos of j.pending) { this.pending.push(pos); this.pendingSet.add(pos) }
    this.columns.clear()
    for (const b of this.bodies) { const col = b.x + b.z * this.port.layout.size[0]; let a = this.columns.get(col); if (!a) { a = []; this.columns.set(col, a) } a.push(b) }
  }
```

`sim/collapse.ts` (import `type Packed`). First extract the run computation from `detach` into a helper and use it there:

```ts
  private runsOf(positions: Uint32Array): Run[] {
    const L = this.port.layout, set = new Set(positions), plane = L.size[0] * L.size[2], runs: Run[] = []
    for (const p of positions) {
      if (set.has(p - plane)) continue
      const [x, y, z] = L.voxelCoords(p); let height = 1
      while (set.has(p + height * plane)) height++
      runs.push({ x, y, z, height })
    }
    return runs
  }
```

(In `detach`, replace the inline loop with `const runs = this.runsOf(positions)`; keep the rest.) Then:

```ts
  /** Plan deviation 5: an in-progress search is not kept; its queued positions are seeded again. */
  snapshot(): Packed {
    const seeds = new Set<number>(this.seeds.slice(this.seedHead))
    if (this.search) for (let i = 0; i < this.search.queue.length; i++) seeds.add(this.search.queue.data[i]!)
    const total = this.fragments.reduce((n, f) => n + f.positions.length, 0)
    const positions = new Uint32Array(total), voxels = new Uint16Array(total)
    let at = 0
    for (const f of this.fragments) { positions.set(f.positions, at); voxels.set(f.voxels, at); at += f.positions.length }
    return {
      json: { nextId: this.nextId, dirty: [...this.dirty], scanChunk: this.scanChunk, scanCell: this.scanCell,
        fragments: this.fragments.map(f => ({ id: f.id, offset256: f.offset256, vy256: f.vy256, n: f.positions.length })) },
      arrays: { seeds: Uint32Array.from(seeds), positions, voxels },
    }
  }
  restore(p: Packed): void {
    if (!this.enabled) return
    const j = p.json as { nextId: number; dirty: number[]; scanChunk: number | null; scanCell: number; fragments: { id: number; offset256: number; vy256: number; n: number }[] }
    this.nextId = j.nextId
    for (const s of p.arrays.seeds as Uint32Array) if (!this.seedSet.has(s)) { this.seedSet.add(s); this.seeds.push(s) }
    for (const ci of j.dirty) this.dirty.add(ci)
    this.scanChunk = j.scanChunk; this.scanCell = j.scanCell
    const pos = p.arrays.positions as Uint32Array, vox = p.arrays.voxels as Uint16Array
    let at = 0
    for (const f of j.fragments) {
      const positions = pos.slice(at, at + f.n), voxels = vox.slice(at, at + f.n); at += f.n
      const body: Fragment = { id: f.id, positions, voxels, runs: this.runsOf(positions), offset256: f.offset256, vy256: f.vy256 }
      this.fragments.push(body); this.index(body)
      this.born.push({ id: body.id, positions: positions.slice(), voxels: voxels.slice(), source: [] })
    }
  }
```

`sim/simulation.ts`: add `{ name: 'gravity', bytes: pack(this.gravity.snapshot()) }` and `{ name: 'collapse', bytes: pack(this.collapse.snapshot()) }` to `snapshot()`; in `restore()`:

```ts
    const gravity = section('gravity'); if (gravity) this.gravity.restore(gravity)
    const collapse = section('collapse'); if (collapse) this.collapse.restore(collapse)
```

Check the main-thread side handles a birth with `source: []`: read `render/fragmentTrack.ts` `update()` and confirm an empty `source` list holds no chunk (no barrier to wait for). If it would wait forever, make it treat an empty list as ready and add a `fragmentTrack.test.ts`-style case (`test/fragments.test.ts` is the existing file) with `born: [{ id: 1, positions, voxels, source: [] }]` expecting the fragment to draw on the next frame.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/physicsSnapshot.test.ts test/collapse.test.ts test/gravity.test.ts test/fragments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sim/gravity.ts packages/engine/src/sim/collapse.ts packages/engine/src/sim/simulation.ts packages/engine/test/physicsSnapshot.test.ts
git commit -m "feat(persist): falling blocks and structural fragments survive a save"
```

---

### Task 6: Worker units, orders and piles

**Files:**
- Create: `packages/engine/src/sim/workers/snapshot.ts`
- Modify: `packages/engine/src/sim/workers/workers.ts`, `packages/engine/src/sim/simulation.ts`
- Test: `packages/engine/test/workersSnapshot.test.ts`

**Interfaces:**
- Produces:

```ts
// sim/workers/snapshot.ts
import type { Vec3 } from '../commands.ts'
import type { WorkBlockReason, WorkerState } from './types.ts'
export interface UnitSnapshot { id: number; x: number; y: number; z: number; facing: number; state: WorkerState; vy: number; tools: string[]; stock: [number, number][]; goal: number | null; available: boolean; allowDig: boolean; buildBlock: number }
export interface OrderSnapshot {
  id: number; kind: 'dig' | 'build'; min: Vec3; max: Vec3; voxel: number; total: number; done: number; pending: number; cancelled: boolean; reason?: WorkBlockReason
  cursor: number; ids: number[] | null; priority: number; parked: number[]
  ringPending: number[] | null; rings: number; floor: number; ring: number; progress: number; stalled: boolean; idleSince: number; noCrewSince: number
}
export interface WorkersSnapshot { nextUnit: number; nextOrder: number; time: number; assignmentCursor: number; units: UnitSnapshot[]; orders: OrderSnapshot[]; loose: [number, [number, number][]][] }
```

  - `WorkerSystem.snapshot(): WorkersSnapshot`, `WorkerSystem.restore(s: WorkersSnapshot): void` (empty system only); section `workers` (packed as `{ json: snapshot, arrays: {} }`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/workersSnapshot.test.ts
import { describe, expect, it } from 'vitest'
import type { Simulation } from '../src/sim/simulation.ts'
import { R, fullRestore, richScript, richSim } from './persistHelpers.ts'

function runTo(t: number): Simulation { const s = richSim(); for (let i = 0; i < t; i++) { richScript(s, i); s.step() } return s }
const units = (s: Simulation) => [...s.workers!.units.values()].map(u => ({ id: u.id, x: u.x, y: u.y, z: u.z, stock: [...u.stock], tools: [...u.tools] }))

describe('workers in a save', () => {
  it('restores units on whole cells, mid-step units on the cell they left', () => {
    const a = runTo(14)
    const moving = [...a.workers!.units.values()].filter(u => u.motion)
    const b = fullRestore(a)
    expect(b.workers!.units.size).toBe(a.workers!.units.size)
    for (const u of b.workers!.units.values()) { expect(u.x & 255).toBe(128); expect(u.z & 255).toBe(128); expect(u.y & 255).toBe(0) }
    for (const m of moving) {
      const [fx, fy, fz] = a.layout.voxelCoords(m.motion!.from)
      const r = b.workers!.units.get(m.id)!
      expect([r.x, r.y, r.z]).toEqual([fx * 256 + 128, fy * 256, fz * 256 + 128])
    }
  })
  it('finishes every order after a load, and keeps stock and piles', () => {
    const a = runTo(14)
    const b = fullRestore(a)
    for (let i = 0; i < 4000 && b.workers!.busy; i++) b.step()
    const orders = b.workers!.publication().orders
    expect(orders.length).toBeGreaterThan(0)
    for (const o of orders) expect(o.done).toBe(o.total)
    for (let x = 48; x <= 50; x++) expect(b.store.getVoxel(x, 3, 49) & 0xfff).toBe(0)
    expect(b.store.getVoxel(37, 4, 51) & 0xfff).toBe(R.planks)
  })
  it('two loads run identically and save → load → save is idempotent', () => {
    const a = runTo(14)
    const b = fullRestore(a), c = fullRestore(a)
    const sa = a.workers!.snapshot(), sb = b.workers!.snapshot()
    expect(sb).toEqual(sa)
    for (let t = 0; t < 300; t++) { b.step(); c.step() }
    expect(b.hash()).toBe(c.hash())
    expect(units(b)).toEqual(units(c))
  })
  it('refuses to restore into a system that already has units', () => {
    const a = runTo(3)
    expect(() => a.workers!.restore(a.workers!.snapshot())).toThrow(/empty/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/workersSnapshot.test.ts`
Expected: FAIL — `snapshot` is not a function / restored sim has 0 units.

- [ ] **Step 3: Implement**

`sim/workers/snapshot.ts`: the types above.

`sim/workers/workers.ts` — factor the unit literal out of `unitSpawn` so spawn and restore share it:

```ts
  private newUnit(id: number, x: number, y: number, z: number, tools: Iterable<string>, stock: Map<number, number>): Unit {
    return { id, x, y, z, facing: 0, state: 'idle', tools: new Set(tools), stock,
      goal: null, search: null, path: [], cursor: 0, task: null, progress: 0, duration: 0, cells: [], motion: null, vy: 0, wait: 0, retry: 0, revision: -1,
      allowDig: false, buildBlock: 0, engineering: null, searchLimited: false, actions: [], actionCursor: 0, alternative: [], alternativeCost: 0, workPoses: [], validatedWorld: -1, validatedPose: [0, 0, 0], available: true, escape: [], exposed: 0, unsafeHere: false, stale: 0, progressAt: this.time, route: null, segment: null,
      projection: null, conflict: null, stuck: 0, best: 0, bestTarget: -1, repair: null, repairFrom: null, repairAfter: 0, schedule: null, yieldTo: 0, yieldUntil: 0, passUntil: 0, laned: null }
  }
```

and in `unitSpawn`: `const u = this.newUnit(this.nextUnit, c.pos[0] * 256 + 128, c.pos[1] * 256, c.pos[2] * 256 + 128, c.tools ?? [], stock)`.

Add (import the snapshot types):

```ts
  /** Plan deviation 6: durable state only; navigation, searches, reservations, claims and failure histories are rebuilt. */
  snapshot(): WorkersSnapshot {
    const L = this.port.layout
    const back = new Map<Order, number[]>()
    for (const t of this.tasks) if (t.order.id > 0) { let a = back.get(t.order); if (!a) { a = []; back.set(t.order, a) } a.push(t.i) }
    return {
      nextUnit: this.nextUnit, nextOrder: this.nextOrder, time: this.time, assignmentCursor: this.assignmentCursor,
      units: [...this.units.values()].map(u => {
        let x = u.x, y = u.y, z = u.z
        if (u.motion) { const [fx, fy, fz] = L.voxelCoords(u.motion.from); x = fx * 256 + 128; y = fy * 256; z = fz * 256 + 128 }
        const state: WorkerState = u.state === 'falling' || u.state === 'incapacitated' ? u.state : u.goal === null ? 'idle' : 'planning'
        return { id: u.id, x, y, z, facing: u.facing, state, vy: u.vy, tools: [...u.tools], stock: [...u.stock], goal: u.goal, available: u.available, allowDig: u.allowDig, buildBlock: u.buildBlock }
      }),
      orders: this.orders.map(o => ({
        id: o.id, kind: o.kind, min: [...o.min] as Vec3, max: [...o.max] as Vec3, voxel: o.voxel, total: o.total, done: o.done, pending: o.pending, cancelled: o.cancelled,
        ...(o.reason && { reason: o.reason }), cursor: o.cursor, ids: o.ids ? [...o.ids] : null, priority: o.priority,
        parked: [...(back.get(o) ?? []), ...o.parked], ringPending: o.ringPending ? [...o.ringPending] : null,
        rings: o.rings, floor: o.floor, ring: o.ring, progress: o.progress, stalled: o.stalled, idleSince: o.idleSince, noCrewSince: o.noCrewSince,
      })),
      loose: [...this.loose].map(([p, pile]) => [p, [...pile]] as [number, [number, number][]]),
    }
  }

  restore(s: WorkersSnapshot): void {
    if (this.units.size || this.orders.length || this.loose.size) throw new Error('workers restore needs an empty system')
    this.nextUnit = s.nextUnit; this.nextOrder = s.nextOrder; this.time = s.time; this.assignmentCursor = s.assignmentCursor
    for (const o of s.orders) this.orders.push({ ...o, min: [...o.min] as Vec3, max: [...o.max] as Vec3, ids: o.ids ? new Set(o.ids) : null, parked: [...o.parked], parkedRevision: -1, ringPending: o.ringPending ? Int32Array.from(o.ringPending) : null })
    for (const v of s.units) {
      const u = this.newUnit(v.id, v.x, v.y, v.z, v.tools, new Map(v.stock))
      Object.assign(u, { facing: v.facing, state: v.state, vy: v.vy, goal: v.goal, available: v.available, allowDig: v.allowDig, buildBlock: v.buildBlock })
      if (!this.reserve(u, this.body(u.x, u.y, u.z))) throw new Error(`restored unit ${u.id} overlaps another unit`)
      this.units.set(u.id, u); this.dirty.add(u.id)
    }
    for (const [p, pile] of s.loose) {
      this.loose.set(p, new Map(pile))
      for (const [block, count] of pile) this.dirtyDrops.set(`${p}:${block}`, { pos: this.port.layout.voxelCoords(p), block, count })
    }
    this.buildReservationsChanged()
    this.goalsVersion++
  }
```

`sim/simulation.ts`: in `snapshot()` add `...(this.workers ? [{ name: 'workers' as const, bytes: pack({ json: this.workers.snapshot(), arrays: {} }) }] : [])`; in `restore()`:

```ts
    const workers = section('workers')
    if (workers && !this.workers) throw new Error('the save has worker units but this simulation runs without workers')
    if (workers) this.workers!.restore(workers.json as WorkersSnapshot)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/workersSnapshot.test.ts test/workers.test.ts test/workersRoutes.test.ts`
Expected: PASS. If "finishes every order" stalls, print `b.workers!.publication()` (orders + details) — the usual cause is a restored order whose `parked` lost a task index (check the `back` map) or a unit left in `planning` without a goal.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sim/workers/snapshot.ts packages/engine/src/sim/workers/workers.ts packages/engine/src/sim/simulation.ts packages/engine/test/workersSnapshot.test.ts
git commit -m "feat(persist): worker units, orders and piles survive a save; units replan on load"
```

---

### Task 7: Whole-simulation round trip

**Files:**
- Test: `packages/engine/test/persistRoundTrip.test.ts` (plus fixes in the systems if it finds any)

**Interfaces:**
- Consumes: Tasks 3–6.

- [ ] **Step 1: Write the test**

```ts
// packages/engine/test/persistRoundTrip.test.ts
import { describe, expect, it } from 'vitest'
import { fullRestore, richScript, richSim, voxelsEqual } from './persistHelpers.ts'
import type { Simulation } from '../src/sim/simulation.ts'

const sections = (s: Simulation) => Object.fromEntries(s.snapshot(null).sections.map(x => [x.name, x.bytes]))

describe('whole-simulation save', () => {
  for (const at of [5, 11, 14, 40, 200]) {
    it(`saved at tick ${at}: two loads run identically for 400 ticks with the same later commands`, () => {
      const a = richSim()
      for (let t = 0; t < at; t++) { richScript(a, t); a.step() }
      const b = fullRestore(a), c = fullRestore(a)
      expect(voxelsEqual(a, b)).toBe(true)
      for (let t = at; t < at + 400; t++) { richScript(b, t); richScript(c, t); b.step(); c.step() }
      expect(b.hash()).toBe(c.hash())
    })
  }
  it('save → load → save gives identical sections and regions', () => {
    const a = richSim()
    for (let t = 0; t < 14; t++) { richScript(a, t); a.step() }
    const b = fullRestore(a)
    expect(sections(b)).toEqual(sections(a))
    expect(b.snapshot(null).regions).toEqual(a.snapshot(null).regions)
  })
  it('a paused world stays paused', () => {
    const a = richSim(); a.setPaused(true)
    expect(fullRestore(a).paused).toBe(true)
  })
})
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/persistRoundTrip.test.ts`
Expected: PASS. A failure here is a real bug in Tasks 3–6: find which section differs (compare `unpack(bytes).json` / arrays of each), fix it in its system with a focused test in that task's file, and re-run. Do not weaken the assertions.

- [ ] **Step 3: Run the engine suite**

Run: `npm test -w @elovox/engine` and `npm run typecheck -w @elovox/engine`
Expected: all green (same counts as main plus the new files; the known load-sensitive timeouts `densityBrush`, `surfaceView incremental` may need a rerun alone).

- [ ] **Step 4: Commit**

```bash
git add packages/engine/test/persistRoundTrip.test.ts
git commit -m "test(persist): whole-simulation save round trip and two-load determinism"
```

---

### Task 8: Manifest, SaveStore and the package writer/reader

**Files:**
- Create: `packages/engine/src/persist/manifest.ts`, `packages/engine/src/persist/store.ts`, `packages/engine/src/persist/package.ts`
- Modify: `packages/engine/src/errors.ts` (add `'save'` to `EngineErrorCode`)
- Test: `packages/engine/test/savePackage.test.ts`

**Interfaces:**
- Consumes: Task 1 `gzip/gunzip/sha256`, Task 2 `regionGrid`, `REGION_FORMAT`, Task 3 `SECTION_VERSIONS`, `SectionName`, `RegionBlob`.
- Produces:

```ts
// persist/manifest.ts
export const FORMAT_VERSION = 1
export interface BlobRef { hash: string; bytes: number }
export interface Manifest {
  format: 'elovox-save'; formatVersion: number; engine: string; created: string
  /** Bumped on every write of the slot; the store keeps the two newest (plan: atomic write). */
  generation: number
  seed: number; size: [number, number, number]; tick: number; paused: boolean
  blocks: string[]
  terrain: unknown
  /** Small labels for slot lists (the sandbox puts its scene here). */
  meta: Record<string, string | number>
  regionFormat: number
  sections: ({ name: SectionName | 'app'; version: number } & BlobRef)[]
  regions: ({ r: number } & BlobRef)[]
}
export type ManifestDraft = Omit<Manifest, 'generation' | 'sections' | 'regions'>
export type SaveErrorCode = 'missing' | 'incompatible' | 'corrupted' | 'quota' | 'unavailable' | 'not-ready' | 'invalid'
export class SaveError extends Error { readonly code: SaveErrorCode; constructor(code: SaveErrorCode, message: string) }
/** Every incompatibility, one per line; empty when the engine can load it. */
export function checkManifest(m: Manifest): string[]
/** The saved table must be a prefix of `names` (plan deviation 2). Empty when it is. */
export function checkBlocks(saved: readonly string[], names: readonly string[]): string[]

// persist/store.ts
export interface SaveStore {
  listSlots(): Promise<string[]>
  /** The newest readable manifest of the slot, or null. */
  readManifest(slot: string): Promise<Manifest | null>
  /** Every manifest the store keeps for the slot (gc keeps their blobs). */
  readManifests(slot: string): Promise<Manifest[]>
  /** Atomic: until it resolves, readManifest returns the previous one. */
  writeManifest(slot: string, m: Manifest): Promise<void>
  deleteSlot(slot: string): Promise<void>
  hasBlob(hash: string): Promise<boolean>
  readBlob(hash: string): Promise<Uint8Array | null>
  writeBlob(hash: string, bytes: Uint8Array): Promise<void>
  listBlobs(): Promise<string[]>
  deleteBlob(hash: string): Promise<void>
  estimate(): Promise<{ usage: number; quota: number } | null>
}
export function checkSlotName(slot: string): void   // throws SaveError('invalid') unless /^[A-Za-z0-9 _-]{1,40}$/
export class MemoryStore implements SaveStore { /* + failWrites?: SaveErrorCode for tests */ }

// persist/package.ts
export interface SectionInput { name: SectionName | 'app'; bytes: Uint8Array }
export interface WriteResult { bytes: number; blobsWritten: number; regionsWritten: number; manifest: Manifest }
export function writeSave(store: SaveStore, slot: string, draft: ManifestDraft, sections: SectionInput[], regions: RegionBlob[], reuse: Manifest['regions']): Promise<WriteResult>
export interface LoadedSave { slot: string; manifest: Manifest; sections: Partial<Record<SectionName | 'app', Uint8Array>>; regions: RegionBlob[] }
export function readSave(store: SaveStore, slot: string): Promise<LoadedSave>
export function gcBlobs(store: SaveStore): Promise<number>
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/savePackage.test.ts
import { describe, expect, it } from 'vitest'
import { MemoryStore, checkSlotName } from '../src/persist/store.ts'
import { SaveError, checkBlocks, checkManifest, type ManifestDraft } from '../src/persist/manifest.ts'
import { gcBlobs, readSave, writeSave } from '../src/persist/package.ts'
import { SECTION_VERSIONS } from '../src/sim/snapshot.ts'

const draft = (over: Partial<ManifestDraft> = {}): ManifestDraft => ({
  format: 'elovox-save', formatVersion: 1, engine: '0.1.0', created: new Date(0).toISOString(), seed: 1, size: [512, 32, 256], tick: 7, paused: false,
  blocks: ['air', 'stone'], terrain: null, meta: { scene: 'test' }, regionFormat: 1, ...over,
})
const bytes = (n: number, v = 1) => new Uint8Array(n).fill(v)
const sections = () => (['scheduler', 'water', 'gravity', 'collapse', 'app'] as const).map(name => ({ name, bytes: bytes(100, name.length) }))
const regions = () => [{ r: 0, bytes: bytes(5000, 1) }, { r: 1, bytes: bytes(5000, 2) }]

describe('save package', () => {
  it('writes blobs then the manifest and reads everything back verified', async () => {
    const store = new MemoryStore()
    const w = await writeSave(store, 'a', draft(), sections(), regions(), [])
    expect(w.regionsWritten).toBe(2)
    const back = await readSave(store, 'a')
    expect(back.manifest.tick).toBe(7)
    expect(back.regions.map(r => r.bytes)).toEqual(regions().map(r => r.bytes))
    expect(back.sections.water).toEqual(bytes(100, 5))
    expect(back.manifest.sections.find(s => s.name === 'water')!.version).toBe(SECTION_VERSIONS.water)
  })
  it('does not write a blob twice and reuses regions from the previous manifest', async () => {
    const store = new MemoryStore()
    const first = await writeSave(store, 'a', draft(), sections(), regions(), [])
    const again = await writeSave(store, 'a', draft({ tick: 8 }), sections(), [{ r: 1, bytes: bytes(5000, 3) }], first.manifest.regions.filter(r => r.r === 0))
    expect(again.blobsWritten).toBe(1)
    expect(again.manifest.generation).toBe(first.manifest.generation + 1)
    expect((await readSave(store, 'a')).regions[0]!.bytes).toEqual(bytes(5000, 1))
  })
  it('refuses a package with missing regions', async () => {
    await expect(writeSave(new MemoryStore(), 'a', draft(), sections(), [regions()[0]!], [])).rejects.toThrow(/region 1/)
  })
  it('keeps the previous manifest readable when a write fails, and reports quota', async () => {
    const store = new MemoryStore()
    await writeSave(store, 'a', draft(), sections(), regions(), [])
    store.failWrites = 'quota'
    const err = await writeSave(store, 'a', draft({ tick: 99 }), sections(), [{ r: 0, bytes: bytes(5000, 9) }, { r: 1, bytes: bytes(10, 9) }], []).catch(e => e)
    expect(err).toBeInstanceOf(SaveError); expect((err as SaveError).code).toBe('quota')
    store.failWrites = undefined
    expect((await readSave(store, 'a')).manifest.tick).toBe(7)
  })
  it('detects a corrupted or missing blob', async () => {
    const store = new MemoryStore()
    const w = await writeSave(store, 'a', draft(), sections(), regions(), [])
    const h = w.manifest.regions[0]!.hash
    const blob = (await store.readBlob(h))!; blob[blob.length - 1]! ^= 0xff; await store.writeBlob(h, blob)
    await expect(readSave(store, 'a')).rejects.toMatchObject({ code: 'corrupted' })
    await store.deleteBlob(h)
    await expect(readSave(store, 'a')).rejects.toMatchObject({ code: 'corrupted' })
  })
  it('names every incompatibility', () => {
    const m = { ...draft({ formatVersion: 2, regionFormat: 3 }), generation: 1, regions: [], sections: [{ name: 'water' as const, version: 9, hash: 'x', bytes: 1 }] }
    expect(checkManifest(m)).toEqual(['format v2, engine expects v1', 'region format v3, engine expects v1', `section water v9, engine expects v${SECTION_VERSIONS.water}`])
    expect(checkBlocks(['air', 'stone'], ['air', 'stone', 'glass'])).toEqual([])
    expect(checkBlocks(['air', 'dirt'], ['air', 'stone'])).toEqual(['block 1 is "dirt" in the save but "stone" in this engine'])
    expect(checkBlocks(['air', 'stone', 'x'], ['air', 'stone'])).toEqual(['block 2 "x" is unknown to this engine'])
  })
  it('collects blobs no kept manifest references', async () => {
    const store = new MemoryStore()
    await writeSave(store, 'a', draft(), sections(), regions(), [])
    await writeSave(store, 'a', draft(), sections(), [{ r: 0, bytes: bytes(10, 7) }, { r: 1, bytes: bytes(10, 8) }], [])
    await writeSave(store, 'a', draft(), sections(), [{ r: 0, bytes: bytes(10, 5) }, { r: 1, bytes: bytes(10, 6) }], [])
    expect(await gcBlobs(store)).toBe(0) // writeSave already collected the first generation's two regions
    await store.deleteSlot('a')
    expect(await gcBlobs(store)).toBeGreaterThan(0)
    expect(await store.listBlobs()).toEqual([])
  })
  it('validates slot names', () => {
    expect(() => checkSlotName('ok name_1-2')).not.toThrow()
    for (const bad of ['', '../x', 'a/b', 'x'.repeat(41)]) expect(() => checkSlotName(bad)).toThrow(SaveError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/savePackage.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

`errors.ts`: `export type EngineErrorCode = 'not-isolated' | 'no-gpu' | 'fatal' | 'terrain' | 'save'`.

`persist/manifest.ts`:

```ts
import { REGION_FORMAT } from './regions.ts'
import { SECTION_VERSIONS, type SectionName } from '../sim/snapshot.ts'

export const FORMAT_VERSION = 1
/* (Manifest, BlobRef, ManifestDraft, SaveErrorCode types exactly as in Interfaces) */

export class SaveError extends Error {
  readonly code: SaveErrorCode
  constructor(code: SaveErrorCode, message: string) { super(message); this.name = 'SaveError'; this.code = code }
}

export function checkManifest(m: Manifest): string[] {
  const out: string[] = []
  if (m.format !== 'elovox-save') return ['not an Elovox save']
  if (m.formatVersion !== FORMAT_VERSION) out.push(`format v${m.formatVersion}, engine expects v${FORMAT_VERSION}`)
  if (m.regionFormat !== REGION_FORMAT) out.push(`region format v${m.regionFormat}, engine expects v${REGION_FORMAT}`)
  for (const s of m.sections) {
    const want = SECTION_VERSIONS[s.name]
    if (want === undefined) out.push(`section ${s.name} is unknown to this engine`)
    else if (s.version !== want) out.push(`section ${s.name} v${s.version}, engine expects v${want}`)
  }
  return out
}

export function checkBlocks(saved: readonly string[], names: readonly string[]): string[] {
  for (let i = 0; i < saved.length; i++) {
    if (i >= names.length) return [`block ${i} "${saved[i]}" is unknown to this engine`]
    if (saved[i] !== names[i]) return [`block ${i} is "${saved[i]}" in the save but "${names[i]}" in this engine`]
  }
  return []
}
```

`persist/store.ts`:

```ts
import { SaveError, type Manifest, type SaveErrorCode } from './manifest.ts'

/* SaveStore interface exactly as in Interfaces */

export function checkSlotName(slot: string): void {
  if (typeof slot !== 'string' || !/^[A-Za-z0-9 _-]{1,40}$/.test(slot)) throw new SaveError('invalid', `slot names are 1–40 letters, digits, spaces, _ or -: got ${JSON.stringify(slot)}`)
}

/** In-memory store for tests and Node tools. Keeps the two newest manifests of a slot, like OpfsStore. */
export class MemoryStore implements SaveStore {
  failWrites: SaveErrorCode | undefined
  private readonly slots = new Map<string, Manifest[]>()
  private readonly blobs = new Map<string, Uint8Array>()
  private fail(): void { if (this.failWrites) throw new SaveError(this.failWrites, `memory store: ${this.failWrites}`) }
  async listSlots() { return [...this.slots.keys()].sort() }
  async readManifest(slot: string) { const l = this.slots.get(slot); return l?.length ? structuredClone(l[l.length - 1]!) : null }
  async readManifests(slot: string) { return structuredClone(this.slots.get(slot) ?? []) }
  async writeManifest(slot: string, m: Manifest) { this.fail(); const l = this.slots.get(slot) ?? []; l.push(structuredClone(m)); this.slots.set(slot, l.slice(-2)) }
  async deleteSlot(slot: string) { this.slots.delete(slot) }
  async hasBlob(h: string) { return this.blobs.has(h) }
  async readBlob(h: string) { const b = this.blobs.get(h); return b ? b.slice() : null }
  async writeBlob(h: string, b: Uint8Array) { this.fail(); this.blobs.set(h, b.slice()) }
  async listBlobs() { return [...this.blobs.keys()].sort() }
  async deleteBlob(h: string) { this.blobs.delete(h) }
  async estimate() { let usage = 0; for (const b of this.blobs.values()) usage += b.length; return { usage, quota: Infinity } }
}
```

`persist/package.ts`:

```ts
import { gunzip, gzip, sha256 } from './codec.ts'
import { SaveError, checkManifest, type BlobRef, type Manifest, type ManifestDraft } from './manifest.ts'
import { regionGrid } from './regions.ts'
import { checkSlotName, type SaveStore } from './store.ts'
import { SECTION_VERSIONS, type RegionBlob, type SectionName } from '../sim/snapshot.ts'
import { Layout } from '../world/layout.ts'

/* SectionInput, WriteResult, LoadedSave as in Interfaces */

async function putBlob(store: SaveStore, raw: Uint8Array, count: { written: number; bytes: number }): Promise<BlobRef> {
  const gz = await gzip(raw), hash = await sha256(gz)
  count.bytes += gz.length
  if (!(await store.hasBlob(hash))) { await store.writeBlob(hash, gz); count.written++ }
  return { hash, bytes: gz.length }
}

export async function writeSave(store: SaveStore, slot: string, draft: ManifestDraft, sections: SectionInput[], regions: RegionBlob[], reuse: Manifest['regions']): Promise<WriteResult> {
  checkSlotName(slot)
  const total = regionGrid(new Layout(draft.size)).count
  const count = { written: 0, bytes: 0 }
  const outRegions = new Map<number, { r: number } & BlobRef>()
  for (const r of reuse) outRegions.set(r.r, r)
  for (const r of regions) outRegions.set(r.r, { r: r.r, ...(await putBlob(store, r.bytes, count)) })
  for (let r = 0; r < total; r++) if (!outRegions.has(r)) throw new SaveError('invalid', `the save is missing region ${r} of ${total}`)
  const outSections: Manifest['sections'] = []
  for (const s of sections) outSections.push({ name: s.name, version: SECTION_VERSIONS[s.name], ...(await putBlob(store, s.bytes, count)) })
  for (const r of reuse) count.bytes += r.bytes
  const prev = await store.readManifest(slot)
  const manifest: Manifest = { ...draft, generation: (prev?.generation ?? 0) + 1, sections: outSections, regions: [...outRegions.values()].sort((a, b) => a.r - b.r) }
  await store.writeManifest(slot, manifest)
  await gcBlobs(store)
  return { bytes: count.bytes, blobsWritten: count.written, regionsWritten: regions.length, manifest }
}

async function getBlob(store: SaveStore, ref: BlobRef, what: string): Promise<Uint8Array> {
  const gz = await store.readBlob(ref.hash)
  if (!gz) throw new SaveError('corrupted', `${what} is missing from the store`)
  if ((await sha256(gz)) !== ref.hash) throw new SaveError('corrupted', `${what} does not match its hash`)
  return gunzip(gz)
}

export async function readSave(store: SaveStore, slot: string): Promise<LoadedSave> {
  checkSlotName(slot)
  const manifest = await store.readManifest(slot)
  if (!manifest) throw new SaveError('missing', `no save named "${slot}"`)
  const bad = checkManifest(manifest)
  if (bad.length) throw new SaveError('incompatible', `save "${slot}" cannot be loaded by this engine:\n${bad.join('\n')}`)
  const sections: LoadedSave['sections'] = {}
  for (const s of manifest.sections) sections[s.name] = await getBlob(store, s, `section ${s.name}`)
  const regions: RegionBlob[] = []
  for (const r of manifest.regions) regions.push({ r: r.r, bytes: await getBlob(store, r, `region ${r.r}`) })
  return { slot, manifest, sections, regions }
}

/** Deletes blobs that no kept manifest of any slot references. Returns how many. */
export async function gcBlobs(store: SaveStore): Promise<number> {
  const keep = new Set<string>()
  for (const slot of await store.listSlots()) for (const m of await store.readManifests(slot)) {
    for (const s of m.sections) keep.add(s.hash)
    for (const r of m.regions) keep.add(r.hash)
  }
  let n = 0
  for (const h of await store.listBlobs()) if (!keep.has(h)) { await store.deleteBlob(h); n++ }
  return n
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/savePackage.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/persist/manifest.ts packages/engine/src/persist/store.ts packages/engine/src/persist/package.ts packages/engine/src/errors.ts packages/engine/test/savePackage.test.ts
git commit -m "feat(persist): manifest, SaveStore, content-addressed package writer/reader with gc"
```

---

### Task 9: OPFS store and the persistence worker

**Files:**
- Create: `packages/engine/src/persist/opfs.ts`, `packages/engine/src/persist/worker.ts`
- Modify: `packages/engine/package.json` (`"./persist-worker": "./src/persist/worker.ts"` in `exports`)
- Test: `packages/engine/test/persistWorker.test.ts`

**Interfaces:**
- Consumes: Task 8.
- Produces:

```ts
// persist/worker.ts
export type ToPersist =
  | { type: 'manifest'; id: number; slot: string }
  | { type: 'write'; id: number; slot: string; draft: ManifestDraft; sections: SectionInput[]; regions: RegionBlob[]; reuse: Manifest['regions'] }
  | { type: 'read'; id: number; slot: string }
  | { type: 'list'; id: number }
  | { type: 'delete'; id: number; slot: string }
  | { type: 'estimate'; id: number }
export type FromPersist =
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; code: SaveErrorCode; message: string }
export interface SlotInfo { slot: string; created: string; tick: number; size: [number, number, number]; bytes: number; meta: Record<string, string | number> }
export function handlePersist(store: SaveStore, msg: ToPersist): Promise<{ value: unknown; transfer: Transferable[] }>
/** Call from your game's persist.worker.ts. Opens OPFS lazily; answers 'unavailable' when it cannot. */
export function runPersistWorker(): void
```

  - `OpfsStore implements SaveStore` (static `open(): Promise<OpfsStore>`; layout `elovox-saves/blobs/<hash>`, `elovox-saves/slots/<slot>.a.json` and `.b.json`: write the one not holding the newest generation, read the newest that parses).

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/persistWorker.test.ts
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/persist/store.ts'
import { handlePersist, type SlotInfo } from '../src/persist/worker.ts'
import { OpfsStore } from '../src/persist/opfs.ts'
import type { ManifestDraft } from '../src/persist/manifest.ts'

const draft: ManifestDraft = { format: 'elovox-save', formatVersion: 1, engine: '0.1.0', created: '2026-10-13T00:00:00.000Z', seed: 1, size: [256, 32, 256], tick: 3, paused: false, blocks: ['air'], terrain: null, meta: { scene: 'living' }, regionFormat: 1 }

describe('persist worker handler', () => {
  it('writes, lists, reads (transferring the bytes) and deletes', async () => {
    const store = new MemoryStore()
    await handlePersist(store, { type: 'write', id: 1, slot: 'one', draft, sections: [{ name: 'app', bytes: new Uint8Array([1, 2]) }], regions: [{ r: 0, bytes: new Uint8Array(10) }], reuse: [] })
    const list = (await handlePersist(store, { type: 'list', id: 2 })).value as SlotInfo[]
    expect(list).toEqual([{ slot: 'one', created: draft.created, tick: 3, size: [256, 32, 256], bytes: expect.any(Number), meta: { scene: 'living' } }])
    const read = await handlePersist(store, { type: 'read', id: 3, slot: 'one' })
    expect(read.transfer.length).toBe(2)
    await handlePersist(store, { type: 'delete', id: 4, slot: 'one' })
    expect((await handlePersist(store, { type: 'list', id: 5 })).value).toEqual([])
    expect(await store.listBlobs()).toEqual([])
  })
  it('answers null for a missing manifest', async () => {
    expect((await handlePersist(new MemoryStore(), { type: 'manifest', id: 1, slot: 'nope' })).value).toBeNull()
  })
  it('reports a browser without OPFS as unavailable', async () => {
    // Node has a navigator but no navigator.storage, like a browser without the origin private file system.
    await expect(OpfsStore.open()).rejects.toMatchObject({ code: 'unavailable' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/persistWorker.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`persist/worker.ts`:

```ts
import { SaveError, type Manifest, type ManifestDraft, type SaveErrorCode } from './manifest.ts'
import { OpfsStore } from './opfs.ts'
import { gcBlobs, readSave, writeSave, type SectionInput } from './package.ts'
import { checkSlotName, type SaveStore } from './store.ts'
import type { RegionBlob } from '../sim/snapshot.ts'

/* ToPersist, FromPersist, SlotInfo as in Interfaces */

export async function handlePersist(store: SaveStore, msg: ToPersist): Promise<{ value: unknown; transfer: Transferable[] }> {
  switch (msg.type) {
    case 'manifest': checkSlotName(msg.slot); return { value: await store.readManifest(msg.slot), transfer: [] }
    case 'write': {
      const r = await writeSave(store, msg.slot, msg.draft, msg.sections, msg.regions, msg.reuse)
      return { value: r, transfer: [] }
    }
    case 'read': {
      const s = await readSave(store, msg.slot)
      const transfer = [...Object.values(s.sections).map(b => b!.buffer), ...s.regions.map(r => r.bytes.buffer)]
      return { value: s, transfer }
    }
    case 'list': {
      const out: SlotInfo[] = []
      for (const slot of await store.listSlots()) {
        const m = await store.readManifest(slot)
        if (m) out.push({ slot, created: m.created, tick: m.tick, size: m.size, bytes: [...m.sections, ...m.regions].reduce((n, b) => n + b.bytes, 0), meta: m.meta })
      }
      return { value: out, transfer: [] }
    }
    case 'delete': checkSlotName(msg.slot); await store.deleteSlot(msg.slot); await gcBlobs(store); return { value: null, transfer: [] }
    case 'estimate': return { value: await store.estimate(), transfer: [] }
  }
}

export function runPersistWorker(): void {
  const scope = globalThis as unknown as { postMessage(m: FromPersist, t?: Transferable[]): void; onmessage: ((e: MessageEvent<ToPersist>) => void) | null }
  let store: Promise<SaveStore> | null = null
  // One request at a time: writes and gc must not interleave.
  let chain = Promise.resolve()
  scope.onmessage = (e) => {
    const msg = e.data
    chain = chain.then(async () => {
      try {
        store ??= OpfsStore.open()
        const { value, transfer } = await handlePersist(await store, msg)
        scope.postMessage({ type: 'result', id: msg.id, ok: true, value }, transfer)
      } catch (err) {
        if (store && !(err instanceof SaveError)) store = null // retry opening next time
        const code: SaveErrorCode = err instanceof SaveError ? err.code : 'unavailable'
        scope.postMessage({ type: 'result', id: msg.id, ok: false, code, message: err instanceof Error ? err.message : String(err) })
      }
    })
  }
}
```

`persist/opfs.ts`:

```ts
import { SaveError, type Manifest } from './manifest.ts'
import type { SaveStore } from './store.ts'

/** Minimal typing for the worker-only sync handle (lib.dom may lack it). */
interface SyncHandle { read(b: Uint8Array, o?: { at: number }): number; write(b: Uint8Array, o?: { at: number }): number; truncate(n: number): void; getSize(): number; flush(): void; close(): void }
type FileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> }

const quota = (e: unknown) => e instanceof DOMException && e.name === 'QuotaExceededError'

/** Saves in the origin private file system (worker only). Slot manifests alternate between .a and .b (atomic write). */
export class OpfsStore implements SaveStore {
  private constructor(private readonly blobs: FileSystemDirectoryHandle, private readonly slots: FileSystemDirectoryHandle) {}

  static async open(): Promise<OpfsStore> {
    if (!globalThis.navigator?.storage?.getDirectory) throw new SaveError('unavailable', 'this browser has no origin private file system (OPFS)')
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('elovox-saves', { create: true })
    return new OpfsStore(await dir.getDirectoryHandle('blobs', { create: true }), await dir.getDirectoryHandle('slots', { create: true }))
  }

  private async readFile(dir: FileSystemDirectoryHandle, name: string): Promise<Uint8Array | null> {
    let h: FileHandle
    try { h = await dir.getFileHandle(name) as FileHandle } catch { return null }
    const s = await h.createSyncAccessHandle()
    try { const b = new Uint8Array(s.getSize()); s.read(b, { at: 0 }); return b } finally { s.close() }
  }
  private async writeFile(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void> {
    const h = await dir.getFileHandle(name, { create: true }) as FileHandle
    const s = await h.createSyncAccessHandle()
    try { s.truncate(0); s.write(bytes, { at: 0 }); s.flush() }
    catch (e) { throw quota(e) ? new SaveError('quota', 'not enough storage space for this save') : e }
    finally { s.close() }
  }
  private async manifests(slot: string): Promise<Manifest[]> {
    const out: Manifest[] = []
    for (const side of ['a', 'b']) {
      const b = await this.readFile(this.slots, `${slot}.${side}.json`)
      if (!b) continue
      try { out.push(JSON.parse(new TextDecoder().decode(b)) as Manifest) } catch { /* a torn write: the other side is the good one */ }
    }
    return out.sort((x, y) => x.generation - y.generation)
  }

  async listSlots(): Promise<string[]> {
    const names = new Set<string>()
    for await (const name of (this.slots as unknown as { keys(): AsyncIterable<string> }).keys()) { const m = /^(.*)\.[ab]\.json$/.exec(name); if (m) names.add(m[1]!) }
    return [...names].sort()
  }
  async readManifest(slot: string) { const l = await this.manifests(slot); return l[l.length - 1] ?? null }
  async readManifests(slot: string) { return this.manifests(slot) }
  async writeManifest(slot: string, m: Manifest): Promise<void> {
    const l = await this.manifests(slot)
    const newest = l[l.length - 1]
    const a = await this.readFile(this.slots, `${slot}.a.json`)
    // Overwrite the side that does not hold the newest generation.
    const aIsNewest = !!newest && !!a && (JSON.parse(new TextDecoder().decode(a)) as Manifest).generation === newest.generation
    await this.writeFile(this.slots, `${slot}.${aIsNewest ? 'b' : 'a'}.json`, new TextEncoder().encode(JSON.stringify(m)))
  }
  async deleteSlot(slot: string): Promise<void> {
    for (const side of ['a', 'b']) try { await this.slots.removeEntry(`${slot}.${side}.json`) } catch { /* absent */ }
  }
  async hasBlob(hash: string) { try { await this.blobs.getFileHandle(hash); return true } catch { return false } }
  async readBlob(hash: string) { return this.readFile(this.blobs, hash) }
  async writeBlob(hash: string, bytes: Uint8Array) { await this.writeFile(this.blobs, hash, bytes) }
  async listBlobs(): Promise<string[]> {
    const out: string[] = []
    for await (const name of (this.blobs as unknown as { keys(): AsyncIterable<string> }).keys()) out.push(name)
    return out.sort()
  }
  async deleteBlob(hash: string) { try { await this.blobs.removeEntry(hash) } catch { /* absent */ } }
  async estimate() { const e = await navigator.storage.estimate?.(); return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null }
}
```

Note: a torn `.a.json` that fails to parse is skipped, so a crash mid-manifest leaves the `.b` generation (the previous save) readable. OPFS is only exercised by the e2e (Task 14); the Node test covers the handler logic with `MemoryStore`.

`package.json` exports: add `"./persist-worker": "./src/persist/worker.ts"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/persistWorker.test.ts` and `npm run typecheck -w @elovox/engine`
Expected: PASS, 0 type errors (adjust only the local `SyncHandle`/`keys()` casts if TS 7's lib already declares them differently).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/persist/opfs.ts packages/engine/src/persist/worker.ts packages/engine/package.json packages/engine/test/persistWorker.test.ts
git commit -m "feat(persist): OPFS store with A/B manifests and the persistence worker"
```

---

### Task 10: Sim protocol — snapshot requests and booting from a save

**Files:**
- Modify: `packages/engine/src/protocol.ts`, `packages/engine/src/sim/simHost.ts`
- Test: `packages/engine/test/simHostSnapshot.test.ts`

**Interfaces:**
- Consumes: Task 3 `SimSnapshot`, `SimRestore`.
- Produces:
  - `ToSim` `init` gains `restore?: SimRestore`; new `{ type: 'snapshot'; id: number; since: Uint32Array | null }`
  - `FromSim` new `{ type: 'snapshot'; id: number; ok: true; snapshot: SimSnapshot } | { type: 'snapshot'; id: number; ok: false; message: string }`
  - `ready.genMs` is the restore time when booting from a save.

- [ ] **Step 1: Write the failing test**

Look at `test/simHost.test.ts` for how it builds a `SimHost` with a fake clock and collects posted messages; reuse that pattern:

```ts
// packages/engine/test/simHostSnapshot.test.ts
import { describe, expect, it } from 'vitest'
import type { FromSim, ToSim } from '../src/protocol.ts'
import { SimHost } from '../src/sim/simHost.ts'
import { testGenerator } from '../src/sim/testGenerator.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { TEST_BLOCKS } from './helpers.ts'

function host() {
  const out: FromSim[] = []
  const h = new SimHost(m => out.push(m), { generator: testGenerator }, { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} })
  return { h, out }
}
const init = (extra: Partial<Extract<ToSim, { type: 'init' }>> = {}): ToSim => ({ type: 'init', buffers: createWorldBuffers([64, 32, 64]), blocks: TEST_BLOCKS, seed: 3, options: { randomTicksPerChunk: 0 }, ...extra })

describe('sim host snapshots', () => {
  it('answers a snapshot between ticks and boots a second host from it', () => {
    const a = host()
    a.h.handle(init())
    a.h.handle({ type: 'submit', clientId: 0, seq: 1, cmd: { type: 'setBlock', pos: [3, 30, 3], voxel: 1 } })
    a.h.handle({ type: 'start' }); a.h.pump()
    for (let i = 0; i < 5; i++) a.h.simulation!.step()
    a.h.handle({ type: 'snapshot', id: 7, since: null })
    const snap = a.out.find((m): m is Extract<FromSim, { type: 'snapshot'; ok: true }> => m.type === 'snapshot' && m.ok)!
    expect(snap.id).toBe(7)
    const b = host()
    b.h.handle(init({ restore: { tick: snap.snapshot.tick, paused: snap.snapshot.paused, regions: snap.snapshot.regions, sections: Object.fromEntries(snap.snapshot.sections.map(s => [s.name, s.bytes])) } }))
    expect(b.out.some(m => m.type === 'ready')).toBe(true)
    expect(b.h.simulation!.tick).toBe(a.h.simulation!.tick)
    expect(b.h.simulation!.store.getVoxel(3, 30, 3)).toBe(1)
  })
  it('refuses a snapshot before the world is ready', () => {
    const a = host()
    a.h.handle({ type: 'snapshot', id: 1, since: null })
    expect(a.out).toEqual([{ type: 'snapshot', id: 1, ok: false, message: 'the world is not ready' }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/simHostSnapshot.test.ts`
Expected: FAIL — type error / no `snapshot` answer.

- [ ] **Step 3: Implement**

`protocol.ts`: add the `restore?: SimRestore` field to `init`, the `snapshot` request and the two `snapshot` answers (import types from `./sim/snapshot.ts`).

`sim/simHost.ts`:
- In `init`, after `if (msg.terrain !== undefined) this.sim.configure(...)`:

```ts
          if (msg.restore) {
            // Gen workers still configure, for later regenerations; nothing is generated.
            if (msg.genPorts && msg.genPorts.length > 0) { this.pool = new GenPool(msg.genPorts as PortLike[]); this.pool.onFatal = (message) => this.fail(new Error(`a generation worker refused a patch the sim accepted: ${message}`)); this.pool.configure(this.terrain, this.sim.layout.size, this.seed, this.blocks) }
            const t0 = this.clock.now()
            const chunks = this.sim.restore(msg.restore)
            const L = this.sim.layout
            this.ready = true
            this.post({ type: 'ready', chunks, slotsUsed: this.sim.store.slotsUsed(), genMs: this.clock.now() - t0, columns: L.cx * L.cz })
            return
          }
```

- New case:

```ts
      case 'snapshot': {
        const sim = this.sim
        if (!sim || !this.ready) { this.post({ type: 'snapshot', id: msg.id, ok: false, message: 'the world is not ready' }); return }
        try {
          const snapshot = sim.snapshot(msg.since)
          this.post({ type: 'snapshot', id: msg.id, ok: true, snapshot })
        } catch (e) {
          this.post({ type: 'snapshot', id: msg.id, ok: false, message: errorMessage(e) })
        }
        return
      }
```

- The worker post must transfer the region and section buffers. `runSimWorker` posts with `scope.postMessage(m)`; change the `SimHost` post signature to `(m: FromSim, transfer?: Transferable[]) => void`, pass `[...snapshot.regions.map(r => r.bytes.buffer), ...snapshot.sections.map(s => s.bytes.buffer), snapshot.revisions.buffer]` for snapshots, and forward it in `runSimWorker` (`(m, t) => scope.postMessage(m, t ?? [])`). Tests that pass a one-argument post keep working.

A snapshot arriving while a pooled regeneration is in flight is answered from the world as it stands (before the regeneration lands): `finishRegen` applies atomically between messages, so the snapshot is never half-regenerated (Review Focus 2). Add that as a third test if `simHostGen.test.ts` has a pooled-regeneration harness to reuse; otherwise note it in the review doc.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/simHostSnapshot.test.ts test/simHost.test.ts test/simHostGen.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/protocol.ts packages/engine/src/sim/simHost.ts packages/engine/src/sim/runSimWorker.ts packages/engine/test/simHostSnapshot.test.ts
git commit -m "feat(persist): sim host answers snapshots and boots from a save"
```

---

### Task 11: Engine API — save, slots, boot from a save

**Files:**
- Create: `packages/engine/src/persist/client.ts`, `packages/engine/src/persist/saveQueue.ts`
- Modify: `packages/engine/src/engine.ts`, `packages/engine/src/index.ts`
- Test: `packages/engine/test/saveQueue.test.ts`

**Interfaces:**
- Consumes: Tasks 8–10.
- Produces:

```ts
// persist/client.ts
export class PersistClient {
  constructor(worker: Worker)
  request<T>(msg: DistributiveOmit<ToPersist, 'id'>, transfer?: Transferable[]): Promise<T>   // rejects with SaveError(code, message)
  terminate(): void
}
/** Reads and verifies a save in a short-lived persistence worker, before createEngine. */
export function openSave(slot: string, persistWorker: () => Worker): Promise<LoadedSave & { app: unknown }>

// persist/saveQueue.ts
/** Runs one job at a time; a request made while one runs joins the next run (latest arguments win) and every caller gets that run's result. */
export class SaveQueue<A, R> { constructor(run: (a: A) => Promise<R>); request(a: A): Promise<R> }

// engine.ts additions
export interface SaveResult { bytes: number; blobsWritten: number; regionsWritten: number; simStallMs: number; totalMs: number }
interface EngineOptions { restore?: LoadedSave; persistWorker?: () => Worker }
interface Engine {
  save(slot: string, o?: { app?: unknown; meta?: Record<string, string | number> }): Promise<SaveResult>
  readonly saves: { list(): Promise<SlotInfo[]>; delete(slot: string): Promise<void>; estimate(): Promise<{ usage: number; quota: number } | null> }
  /** The save this engine booted from: its slot, manifest and app state; null after a normal boot. */
  readonly restored: { slot: string; manifest: Manifest; app: unknown } | null
}
```

- [ ] **Step 1: Write the failing test (the queue is the only part testable without a browser)**

```ts
// packages/engine/test/saveQueue.test.ts
import { describe, expect, it } from 'vitest'
import { SaveQueue } from '../src/persist/saveQueue.ts'

describe('save queue', () => {
  it('coalesces requests made during a run into one next run with the latest arguments', async () => {
    const runs: string[] = []
    let release!: () => void
    const q = new SaveQueue<string, string>(async (a) => { runs.push(a); if (runs.length === 1) await new Promise<void>(r => { release = r }); return `done ${a}` })
    const p1 = q.request('a')
    const p2 = q.request('b'), p3 = q.request('c')
    release()
    expect(await p1).toBe('done a')
    expect(await p2).toBe('done c')
    expect(await p3).toBe('done c')
    expect(runs).toEqual(['a', 'c'])
  })
  it('a failed run rejects its callers and the queue keeps working', async () => {
    let n = 0
    const q = new SaveQueue<number, number>(async (a) => { if (n++ === 0) throw new Error('boom'); return a })
    await expect(q.request(1)).rejects.toThrow('boom')
    expect(await q.request(2)).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/saveQueue.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`persist/saveQueue.ts`:

```ts
export class SaveQueue<A, R> {
  private running: Promise<R> | null = null
  private next: { args: A; waiters: { resolve(r: R): void; reject(e: unknown): void }[] } | null = null
  constructor(private readonly run: (a: A) => Promise<R>) {}
  request(args: A): Promise<R> {
    if (!this.running) return this.start(args)
    return new Promise<R>((resolve, reject) => {
      if (this.next) this.next.args = args
      else this.next = { args, waiters: [] }
      this.next.waiters.push({ resolve, reject })
    })
  }
  private start(args: A): Promise<R> {
    const p = this.run(args)
    this.running = p
    const after = () => {
      this.running = null
      const n = this.next
      this.next = null
      if (n) this.start(n.args).then(r => n.waiters.forEach(w => w.resolve(r)), e => n.waiters.forEach(w => w.reject(e)))
    }
    p.then(after, after)
    return p
  }
}
```

`persist/client.ts`:

```ts
import { SaveError } from './manifest.ts'
import { unpack } from './pack.ts'
import type { LoadedSave } from './package.ts'
import type { FromPersist, ToPersist } from './worker.ts'

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

export class PersistClient {
  private seq = 0
  private readonly waits = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>()
  constructor(private readonly worker: Worker) {
    worker.onmessage = (e: MessageEvent<FromPersist>) => {
      const m = e.data, w = this.waits.get(m.id)
      if (!w) return
      this.waits.delete(m.id)
      if (m.ok) w.resolve(m.value); else w.reject(new SaveError(m.code, m.message))
    }
    worker.onerror = (e) => { e.preventDefault(); for (const w of this.waits.values()) w.reject(new SaveError('unavailable', `the persistence worker crashed: ${e.message}`)); this.waits.clear() }
  }
  request<T>(msg: DistributiveOmit<ToPersist, 'id'>, transfer: Transferable[] = [], timeoutMs = 60_000): Promise<T> {
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.waits.delete(id); reject(new SaveError('unavailable', 'the persistence worker did not answer')) }, timeoutMs)
      this.waits.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v as T) }, reject: (e) => { clearTimeout(timer); reject(e) } })
      this.worker.postMessage({ ...msg, id } as ToPersist, transfer)
    })
  }
  terminate(): void { this.worker.terminate() }
}

export async function openSave(slot: string, persistWorker: () => Worker): Promise<LoadedSave & { app: unknown }> {
  const client = new PersistClient(persistWorker())
  try {
    const s = await client.request<LoadedSave>({ type: 'read', slot })
    return { ...s, app: s.sections.app ? unpack(s.sections.app).json : null }
  } finally { client.terminate() }
}
```

`engine.ts`:
1. Options: add `restore?: LoadedSave` and `persistWorker?: () => Worker` (doc comments: "boot from this save instead of generating; size, seed, paused and terrain come from it" / "starts the persistence worker running `runPersistWorker`; needed for save() and saves").
2. At the top of `createEngine`, after the isolation check, build the registry first (it does not depend on the size) and check the save against it — `registry.defs` starts with the air the registry prepends, and the manifest's `blocks` is written from the same list:

```ts
  const registry = new BlockRegistry(o.blocks)
  const restore = o.restore ?? null
  if (restore) {
    const bad = checkBlocks(restore.manifest.blocks, registry.defs.map(d => d.name))
    if (bad.length) throw new EngineError('save', `save "${restore.slot}" cannot be loaded:\n${bad.join('\n')}`)
  }
  const size: WorldSize = restore ? restore.manifest.size : o.size ?? [1024, 128, 1024]
  const seed = restore ? restore.manifest.seed : o.seed
```

   Remove the later `const registry = new BlockRegistry(o.blocks)` line. Replace later uses of `o.seed` with `seed`, and `o.terrain` with `restore ? restore.manifest.terrain : o.terrain`; `physicsPaused` starts at `restore ? restore.manifest.paused : o.sim?.paused === true`.
3. `init`: when `restore`, set `init.restore = { tick: restore.manifest.tick, paused: restore.manifest.paused, regions: restore.regions, sections: restore.sections }` (drop `app` from `sections`) and post with transfer list of the region/section buffers.
4. Track the terrain document: `let terrainDoc = restore ? restore.manifest.terrain : o.terrain`, updated in `setDocument` after the sim accepts it.
5. Persist state: `const persist = o.persistWorker ? new PersistClient(o.persistWorker()) : null`; `const baselines = new Map<string, { created: string; revisions: Uint32Array }>()`; if `restore`, `baselines.set(restore.slot, { created: restore.manifest.created, revisions: new Uint32Array(regionGrid(layout).count) })`. Terminate it in `dispose`/`halt`.
6. Sim snapshot request: `const snapshotWaits = new Map<number, { resolve(s: SimSnapshot): void; reject(e: unknown): void }>()`; in `sim.onmessage` add `case 'snapshot'` resolving/rejecting by id (`new EngineError('save', m.message)`).
7. `save`:

```ts
  const saveQueue = new SaveQueue<{ slot: string; app: unknown; meta: Record<string, string | number> }, SaveResult>(async ({ slot, app, meta }) => {
    if (!persist) throw new EngineError('save', 'saving needs EngineOptions.persistWorker')
    if (halted) throw new EngineError('fatal', fatal ?? 'the engine is stopped')
    checkSlotName(slot)
    const t0 = performance.now()
    const prev = await persist.request<Manifest | null>({ type: 'manifest', slot })
    const base = baselines.get(slot)
    const since = base && prev && prev.created === base.created ? base.revisions : null
    const id = ++snapshotSeq
    const snap = await new Promise<SimSnapshot>((resolve, reject) => { snapshotWaits.set(id, { resolve, reject }); sim.postMessage({ type: 'snapshot', id, since } satisfies ToSim) })
    const draft: ManifestDraft = { format: 'elovox-save', formatVersion: FORMAT_VERSION, engine: ENGINE_VERSION, created: new Date().toISOString(), seed, size, tick: snap.tick, paused: snap.paused,
      blocks: registry.defs.map(d => d.name), terrain: terrainDoc ?? null, meta, regionFormat: REGION_FORMAT }
    const sections = [...snap.sections, { name: 'app' as const, bytes: pack({ json: app ?? null, arrays: {} }) }]
    const reuse = since ? prev!.regions.filter(r => !snap.regions.some(n => n.r === r.r)) : []
    const transfer = [...snap.regions.map(r => r.bytes.buffer), ...sections.map(s => s.bytes.buffer)]
    const w = await persist.request<WriteResult>({ type: 'write', slot, draft, sections, regions: snap.regions, reuse }, transfer)
    baselines.set(slot, { created: w.manifest.created, revisions: snap.revisions })
    return { bytes: w.bytes, blobsWritten: w.blobsWritten, regionsWritten: w.regionsWritten, simStallMs: snap.ms, totalMs: performance.now() - t0 }
  })
```

   API members: `save: (slot, so = {}) => saveQueue.request({ slot, app: so.app, meta: so.meta ?? {} })`; `saves: { list: () => need(persist).request({ type: 'list' }), delete: (slot) => need(persist).request({ type: 'delete', slot }).then(() => { baselines.delete(slot) }), estimate: () => need(persist).request({ type: 'estimate' }) }` where `need` throws `EngineError('save', …)` when there is no persist worker; `restored: restore ? { slot: restore.slot, manifest: restore.manifest, app: restore.sections.app ? unpack(restore.sections.app).json : null } : null`.
   `SaveError`s from the worker propagate as they are (their `.code` tells quota/unavailable/corrupted apart); wrap only non-`SaveError` failures in `EngineError('save', …)`.
8. `index.ts`: export `type SaveResult`, `SaveError`, `type SaveErrorCode`, `type Manifest`, `type LoadedSave`, `type SlotInfo`, `openSave`, `MemoryStore`, `type SaveStore`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/saveQueue.test.ts` then `npm test -w @elovox/engine` and `npm run typecheck`
Expected: PASS / 0 errors. (The engine itself is exercised in the browser by Task 14.)

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/persist/client.ts packages/engine/src/persist/saveQueue.ts packages/engine/src/engine.ts packages/engine/src/index.ts packages/engine/test/saveQueue.test.ts
git commit -m "feat(persist): engine.save, engine.saves and createEngine({ restore })"
```

---

### Task 12: Sandbox — boot from a save, app state, scene scripts

**Files:**
- Create: `apps/sandbox/src/persist.worker.ts`, `apps/sandbox/src/scene.ts`, `apps/sandbox/src/appState.ts`, `apps/sandbox/test/bootPlan.test.ts`
- Modify: `apps/sandbox/src/main.ts`, `apps/sandbox/src/livingScript.ts`, `apps/sandbox/src/crowdScript.ts`

**Interfaces:**
- Consumes: Task 11 (`openSave`, `engine.save`, `engine.restored`).
- Produces:

```ts
// scene.ts
export const SCENES = ['world', 'diorama', 'terrain', 'flood', 'caves', 'collapse', 'workers', 'living', 'crowd'] as const
export type SceneName = typeof SCENES[number]
export function sceneOf(raw: string | null): SceneName
/** What the page boots: from ?save= the save's scene wins over ?scene, ?size and ?seed (Review Focus 4). */
export function bootPlan(params: URLSearchParams, saved: { app: unknown } | null): { scene: SceneName; fromSave: boolean }

// appState.ts
export interface CameraState { mode: 'orbit' | 'firstPerson'; orbit: { target: [number, number, number]; distance: number; pitch: number; yaw: number }; fp: { position: [number, number, number]; yaw: number; pitch: number } }
export interface AppState { scene: SceneName; camera: CameraState; scripts: { living?: LivingState; crowd?: CrowdState } }
export function captureCamera(engine: Engine): CameraState
export function applyCamera(engine: Engine, c: CameraState): void
export function isAppState(v: unknown): v is AppState

// livingScript.ts
export interface LivingState { started: boolean; breached: boolean; collapsed: boolean; groupAtRest: boolean }
Living gains: save(): LivingState; restore(s: LivingState): void   // restore re-attaches the quarry cycle when started; never re-runs setup()
// crowdScript.ts
export interface CrowdState { scatters: number }
Crowd gains: save(): CrowdState; restore(s: CrowdState): void
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/sandbox/test/bootPlan.test.ts
import { describe, expect, it } from 'vitest'
import { bootPlan, sceneOf } from '../src/scene.ts'

describe('boot plan', () => {
  it('uses ?scene without a save', () => {
    expect(bootPlan(new URLSearchParams('scene=flood'), null)).toEqual({ scene: 'flood', fromSave: false })
    expect(sceneOf('nonsense')).toBe('world')
  })
  it("the save's scene wins over ?scene", () => {
    const app = { scene: 'living', camera: { mode: 'orbit', orbit: { target: [0, 0, 0], distance: 1, pitch: 0, yaw: 0 }, fp: { position: [0, 0, 0], yaw: 0, pitch: 0 } }, scripts: {} }
    expect(bootPlan(new URLSearchParams('save=a&scene=flood&size=64'), { app })).toEqual({ scene: 'living', fromSave: true })
  })
  it('a save without sandbox app state falls back to the world scene', () => {
    expect(bootPlan(new URLSearchParams('save=a'), { app: null })).toEqual({ scene: 'world', fromSave: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bootPlan.test.ts` (in `apps/sandbox`)
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`src/persist.worker.ts`:

```ts
import { runPersistWorker } from '@elovox/engine/persist-worker'
runPersistWorker()
```

`src/scene.ts`: `SCENES`, `sceneOf` (the same accept-list `main.ts` uses today), and:

```ts
export function bootPlan(params: URLSearchParams, saved: { app: unknown } | null): { scene: SceneName; fromSave: boolean } {
  if (saved) return { scene: isAppState(saved.app) ? saved.app.scene : 'world', fromSave: true }
  return { scene: sceneOf(params.get('scene')), fromSave: false }
}
```

`src/appState.ts`:

```ts
import type { Engine } from '@elovox/engine'
export function captureCamera(engine: Engine): CameraState {
  const g = engine.controls.goal, fp = engine.firstPerson
  return { mode: engine.cameraMode, orbit: { target: [...g.target] as [number, number, number], distance: g.distance, pitch: g.pitch, yaw: g.yaw },
    fp: { position: [...fp.position] as [number, number, number], yaw: fp.yaw, pitch: fp.pitch } }
}
export function applyCamera(engine: Engine, c: CameraState): void {
  for (const s of [engine.controls.goal, engine.controls.current]) { s.target[0] = c.orbit.target[0]; s.target[1] = c.orbit.target[1]; s.target[2] = c.orbit.target[2]; s.distance = c.orbit.distance; s.pitch = c.orbit.pitch; s.yaw = c.orbit.yaw }
  engine.controls.apply(engine.camera)
  if (c.mode === 'firstPerson') {
    engine.setCameraMode('firstPerson')
    const fp = engine.firstPerson
    fp.position[0] = c.fp.position[0]; fp.position[1] = c.fp.position[1]; fp.position[2] = c.fp.position[2]; fp.yaw = c.fp.yaw; fp.pitch = c.fp.pitch
  }
}
export function isAppState(v: unknown): v is AppState {
  return typeof v === 'object' && v !== null && typeof (v as AppState).scene === 'string' && typeof (v as AppState).camera === 'object'
}
```

(The sandbox's `createFirstPerson` wraps `setCameraMode`; if it keeps its own mode flag, call its toggle instead so its UI stays in sync — read `src/firstPerson.ts` first.)

`livingScript.ts`: hoist the quarry-cycle listener into a local `startCycle()` used by `startWork()` and `restore()`; add

```ts
    save: () => ({ started, breached, collapsed, groupAtRest }),
    restore(s) { started = s.started; breached = s.breached; collapsed = s.collapsed; groupAtRest = s.groupAtRest; if (started) startCycle() },
```

and make `createLivingBar` disable the once-buttons whose flag is already set (pass the state in, or read `living.save()`).

`crowdScript.ts`: `save: () => ({ scatters })`, `restore(s) { scatters = s.scatters }`.

`main.ts`:
1. Top: `const saveParam = params.get('save')`; `const persistWorker = () => new Worker(new URL('./persist.worker.ts', import.meta.url), { type: 'module' })`.
2. `const saved = saveParam ? await openSave(saveParam, persistWorker).catch(e => { showLoadError(e); return null }) : null` — `showLoadError` renders the message (incompatible / corrupted / missing) in a fixed box with a "Start the scene fresh" link (`location.search` without `save`), then the page stops (no engine).
3. `const { scene: sceneName, fromSave } = bootPlan(params, saved)` replaces the current `sceneName` constant; size comes from the save when `fromSave` (`createEngine` ignores `size` with `restore` anyway).
4. `createEngine({ ..., persistWorker, ...(saved && { restore: saved }) })`.
5. The per-scene camera presets only run when `!fromSave`; after scene objects exist, when `fromSave && isAppState(engine.restored?.app)`: `applyCamera(engine, app.camera)`, `living?.restore(app.scripts.living!)` instead of `await living.setup()`, `crowd?.restore(...)`.
6. A `captureApp(): AppState` closure (`{ scene: sceneName, camera: captureCamera(engine), scripts: { ...(living && { living: living.save() }), ...(crowd && { crowd: crowd.save() }) } }`) exposed on `window.__elovox.save = (slot) => engine.save(slot, { app: captureApp(), meta: { scene: sceneName } })` for the panel and the e2e.
7. Request `navigator.storage.persist?.()` once (ignore the answer).

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/bootPlan.test.ts` (sandbox), `npm run typecheck`
Expected: PASS / 0 errors. Manual: `npm run dev -- --port 5174 --strictPort` in `apps/sandbox`, open `?scene=living`, run `await __elovox.save('t1')` in the console, then open `?save=t1`: same tick region, units, water; the living bar's used buttons are disabled.

- [ ] **Step 5: Commit**

```bash
git add apps/sandbox/src apps/sandbox/test/bootPlan.test.ts
git commit -m "feat(sandbox): boot from ?save=, save camera and scene script state"
```

---

### Task 13: Save panel and autosave

**Files:**
- Create: `apps/sandbox/src/savePanel.ts`, `apps/sandbox/src/autosave.ts`, `apps/sandbox/test/autosave.test.ts`
- Modify: `apps/sandbox/src/main.ts`

**Interfaces:**
- Consumes: Task 12 `captureApp`, `engine.save`, `engine.saves`.
- Produces:

```ts
// autosave.ts
export const AUTOSAVE_SLOTS = ['autosave-1', 'autosave-2'] as const
export interface AutosaveClock { now(): number; setInterval(fn: () => void, ms: number): unknown; clearInterval(h: unknown): void }
export interface Autosave { enabled: boolean; readonly lastSlot: string | null; stop(): void }
/** Every `intervalMs` (default 300 000) saves to the autosave slot not written last; skips while `blocked()` (editor open) or a save is running. */
export function startAutosave(save: (slot: string) => Promise<unknown>, o: { intervalMs?: number; blocked?: () => boolean; clock?: AutosaveClock; onResult?: (slot: string, r: unknown, err?: unknown) => void }): Autosave
// savePanel.ts
export function createSavePanel(engine: Engine, o: { save(slot: string): Promise<SaveResult>; autosave: Autosave; load(slot: string): void }): { toggle(): void; refresh(): Promise<void> }
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/sandbox/test/autosave.test.ts
import { describe, expect, it } from 'vitest'
import { startAutosave } from '../src/autosave.ts'

function fakeClock() {
  let fn: (() => void) | null = null
  return { clock: { now: () => 0, setInterval: (f: () => void) => { fn = f; return 1 }, clearInterval: () => { fn = null } }, fire: () => fn?.() }
}
const flush = () => new Promise(r => setTimeout(r, 0))

describe('autosave', () => {
  it('rotates between the two slots', async () => {
    const { clock, fire } = fakeClock(), slots: string[] = []
    startAutosave(async s => { slots.push(s) }, { clock })
    fire(); await flush(); fire(); await flush(); fire(); await flush()
    expect(slots).toEqual(['autosave-1', 'autosave-2', 'autosave-1'])
  })
  it('skips while blocked, while a save runs, and when disabled', async () => {
    const { clock, fire } = fakeClock(), slots: string[] = []
    let blocked = true, release!: () => void
    const a = startAutosave(s => { slots.push(s); return new Promise<void>(r => { release = r }) }, { clock, blocked: () => blocked })
    fire(); expect(slots).toEqual([])
    blocked = false; fire(); fire()
    expect(slots).toEqual(['autosave-1'])
    release(); await flush()
    a.enabled = false; fire(); expect(slots).toEqual(['autosave-1'])
  })
  it('a failed autosave does not stop the next one', async () => {
    const { clock, fire } = fakeClock(), results: string[] = []
    let n = 0
    startAutosave(async () => { if (n++ === 0) throw new Error('quota') }, { clock, onResult: (s, _r, e) => results.push(`${s}:${e ? 'fail' : 'ok'}`) })
    fire(); await flush(); fire(); await flush()
    expect(results).toEqual(['autosave-1:fail', 'autosave-2:ok'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/autosave.test.ts` (sandbox)
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`src/autosave.ts`:

```ts
export const AUTOSAVE_SLOTS = ['autosave-1', 'autosave-2'] as const
/* AutosaveClock, Autosave as in Interfaces */
const realClock: AutosaveClock = { now: () => performance.now(), setInterval: (f, ms) => setInterval(f, ms), clearInterval: h => clearInterval(h as ReturnType<typeof setInterval>) }

export function startAutosave(save: (slot: string) => Promise<unknown>, o: { intervalMs?: number; blocked?: () => boolean; clock?: AutosaveClock; onResult?: (slot: string, r: unknown, err?: unknown) => void } = {}): Autosave {
  const clock = o.clock ?? realClock
  let running = false, turn = 0, lastSlot: string | null = null
  const state: Autosave = {
    enabled: true,
    get lastSlot() { return lastSlot },
    stop: () => clock.clearInterval(handle),
  }
  const handle = clock.setInterval(() => {
    if (!state.enabled || running || o.blocked?.()) return
    const slot = AUTOSAVE_SLOTS[turn++ % 2]!
    running = true
    save(slot).then(r => { lastSlot = slot; o.onResult?.(slot, r) }, e => o.onResult?.(slot, undefined, e)).finally(() => { running = false })
  }, o.intervalMs ?? 300_000)
  return state
}
```

`src/savePanel.ts` — a fixed panel (top right, hidden by default, same look as `hud.ts`: white 82% background, 8px radius, monospace 12px), toggled by `P` (ignore key events from inputs):
- header: "Saves" + storage line `used X MB of Y MB` from `engine.saves.estimate()`;
- a name input + **Save as…** button (calls `o.save(name)`; when the name exists in the list, `confirm('Overwrite "name"?')` first); shows `Saved in N ms (sim stall M ms, K MB)` or the error message (`SaveError.message`; for `quota` add the storage line);
- the slot list from `engine.saves.list()` sorted newest first: name, `meta.scene`, `size[0]×size[2]`, local date, MB; per row **Load** (`o.load(slot)`) and **Delete** (`confirm` first, then `engine.saves.delete` and refresh);
- an **Autosave every 5 min** checkbox bound to `o.autosave.enabled`;
- every DOM text set through `textContent` (slot names are user text).

`main.ts`: `const autosave = startAutosave(slot => save(slot), { intervalMs: Number(params.get('autosaveMs') ?? 300_000), blocked: () => editing, onResult: (s, _r, e) => e && console.warn(`[sandbox] autosave ${s} failed`, e) })` where `save` is the `__elovox.save` function from Task 12; `createSavePanel(engine, { save, autosave, load: slot => { location.search = `?save=${encodeURIComponent(slot)}` } })`; add `autosave` to `window.__elovox`. The HUD hint line gains `· P saves`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/autosave.test.ts`, `npm test -w @elovox/sandbox`, `npm run typecheck`
Expected: PASS / 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/sandbox/src/savePanel.ts apps/sandbox/src/autosave.ts apps/sandbox/src/main.ts apps/sandbox/test/autosave.test.ts
git commit -m "feat(sandbox): save panel (P) and rotating 5-minute autosave"
```

---

### Task 14: End-to-end tests and the save benchmark

**Files:**
- Create: `apps/sandbox/e2e/save.spec.ts`, `apps/sandbox/e2e/save-bench.spec.ts`

**Interfaces:**
- Consumes: `window.__elovox.{ engine, save, autosave, living }`, `?save=`, `?autosaveMs=`.

- [ ] **Step 1: Write the e2e**

```ts
// apps/sandbox/e2e/save.spec.ts
import { expect, test, type Page } from '@playwright/test'
import type { Engine, SaveResult } from '@elovox/engine'
import type { Living } from '../src/livingScript.ts'

type W = Window & { __elovox?: { engine: Engine; living: Living | null; ready: boolean; save(slot: string): Promise<SaveResult> } }
const ready = (page: Page) => page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 300_000 })
const clear = (page: Page) => page.evaluate(async () => { const root = await navigator.storage.getDirectory(); try { await root.removeEntry('elovox-saves', { recursive: true }) } catch { /* none */ } })

test('living: save, reload from the save, and continue', async ({ page }) => {
  test.setTimeout(600_000)
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto('/?scene=living'); await ready(page); await clear(page)
  await page.evaluate(() => (window as W).__elovox!.living!.startWork())
  await page.waitForFunction(() => (window as W).__elovox!.engine.workers?.orders.some(o => o.done > 0) ?? false, null, { timeout: 120_000 })
  const result = await page.evaluate(() => (window as W).__elovox!.save('e2e-living'))
  expect(result.regionsWritten).toBeGreaterThan(0)
  const before = await page.evaluate(() => { const e = (window as W).__elovox!.engine; return { tick: e.stats().tick, units: e.workers!.stats.units, done: e.workers!.orders.map(o => o.done) } })

  await page.goto('/?save=e2e-living'); await ready(page)
  const after = await page.evaluate(() => { const e = (window as W).__elovox!.engine; return { tick: e.stats().tick, restored: e.restored?.slot, scene: (e.restored?.app as { scene: string }).scene } })
  expect(after.restored).toBe('e2e-living'); expect(after.scene).toBe('living')
  expect(after.tick).toBeGreaterThanOrEqual(before.tick)
  await page.waitForFunction((n) => (window as W).__elovox!.engine.workers?.stats.units === n, before.units, { timeout: 60_000 })
  // Work continues from where it was: no order went backwards, and one moves forward.
  const done0 = await page.evaluate(() => (window as W).__elovox!.engine.workers!.orders.map(o => o.done))
  for (let i = 0; i < before.done.length; i++) expect(done0[i]!).toBeGreaterThanOrEqual(before.done[i]!)
  await page.waitForFunction((d) => (window as W).__elovox!.engine.workers!.orders.some((o, i) => o.done > (d[i] ?? 0)), done0, { timeout: 120_000 })
  // A second save after a load is incremental.
  const again = await page.evaluate(() => (window as W).__elovox!.save('e2e-living'))
  expect(again.regionsWritten).toBeLessThan(4)
  expect(errors).toEqual([])
})

test('autosave rotates slots on a short interval', async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto('/?scene=flood&autosaveMs=3000'); await ready(page); await clear(page)
  await page.waitForFunction(async () => { const s = await (window as W).__elovox!.engine.saves.list(); return s.some(x => x.slot === 'autosave-1') && s.some(x => x.slot === 'autosave-2') }, null, { timeout: 60_000, polling: 1000 })
})

test('a corrupted save is refused with its message', async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto('/?scene=flood'); await ready(page); await clear(page)
  await page.evaluate(() => (window as W).__elovox!.save('broken'))
  await page.evaluate(async () => {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('elovox-saves')).getDirectoryHandle('blobs')
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) { const w = await (await dir.getFileHandle(name)).createWritable(); await w.write(new Uint8Array([1, 2, 3])); await w.close(); break }
  })
  await page.goto('/?save=broken')
  await expect(page.getByText(/does not match its hash|is missing from the store/)).toBeVisible({ timeout: 60_000 })
})
```

- [ ] **Step 2: Run the e2e**

Run (in `apps/sandbox`): `E2E_PORT=5197 E2E_CHANNEL=msedge npx playwright test e2e/save.spec.ts --workers=1`
Expected: 3 passed. Then the regression set: `E2E_PORT=5197 E2E_CHANNEL=msedge npx playwright test e2e/living.spec.ts e2e/smoke.spec.ts e2e/flood.spec.ts --workers=1`.

- [ ] **Step 3: Write the bench (skipped unless `BENCH_SAVE=1`)**

```ts
// apps/sandbox/e2e/save-bench.spec.ts
import { expect, test, type Page } from '@playwright/test'
import type { Engine, SaveResult } from '@elovox/engine'
import type { Living } from '../src/livingScript.ts'

type W = Window & { __elovox?: { engine: Engine; living: Living | null; ready: boolean; save(slot: string): Promise<SaveResult> } }
test.skip(process.env.BENCH_SAVE !== '1', 'set BENCH_SAVE=1 (quiet machine only)')
const ready = (page: Page) => page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 600_000 })
const p = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]! }

test('save and load costs', async ({ page }) => {
  test.setTimeout(1_800_000)
  const out: Record<string, unknown> = {}
  // Living: one full save, then 10 incremental saves 10 s apart while the crews work.
  await page.goto('/?scene=living'); await ready(page)
  await page.evaluate(() => (window as W).__elovox!.living!.startWork())
  const full = await page.evaluate(() => (window as W).__elovox!.save('bench-living'))
  const stalls: number[] = [], totals: number[] = []
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(10_000)
    const r = await page.evaluate(() => (window as W).__elovox!.save('bench-living'))
    stalls.push(r.simStallMs); totals.push(r.totalMs)
  }
  out.living = { fullStallMs: full.simStallMs, fullBytes: full.bytes, incStallP50: p(stalls, 0.5), incStallP95: p(stalls, 0.95), incTotalP95: p(totals, 0.95) }
  // 1024²: the crowd scene's world; full save, then load to ready vs its generation time.
  await page.goto('/?scene=crowd'); await ready(page)
  const gen = await page.evaluate(() => (window as W).__elovox!.engine.terrain.initial.ms)
  const big = await page.evaluate(() => (window as W).__elovox!.save('bench-1024'))
  const t0 = Date.now()
  await page.goto('/?save=bench-1024'); await ready(page)
  const restoreMs = await page.evaluate(() => (window as W).__elovox!.engine.terrain.initial.ms)
  out.world1024 = { genMs: gen, fullStallMs: big.simStallMs, bytes: big.bytes, loadToReadySimMs: restoreMs, pageToReadyMs: Date.now() - t0 }
  console.log(JSON.stringify(out, null, 2))
  expect(out).toBeTruthy()
})
```

- [ ] **Step 4: Commit**

```bash
git add apps/sandbox/e2e/save.spec.ts apps/sandbox/e2e/save-bench.spec.ts
git commit -m "test(persist): save/load e2e and the BENCH_SAVE benchmark"
```

The bench runs in Task 15, in a window the user grants.

---

### Task 15: Checkpoints, measurements and docs

**Files:**
- Modify: `CONTEXT.md`, this plan (results section)
- Create: `docs/adr/0004-saves-are-chunk-snapshots-in-content-addressed-blobs.md`, `docs/superpowers/reviews/2026-10-13-persistence.md`

- [ ] **Step 1: Domain docs.** Add to `CONTEXT.md`:

```markdown
**Save**:
A package that lets a world continue where it stopped: a manifest plus content-addressed blobs (voxel regions and system sections). Faithful, not bit-identical: navigation and in-flight searches are rebuilt on load.
_Avoid_: Snapshot (the sim's in-memory capture), replay

**Save slot**:
A name under which the store keeps the newest save (and the one before it, for an atomic write).
_Avoid_: File, save file

**Save region**:
256 × 256 blocks of the world, full height (8 × 8 chunk columns): the unit a save copies and stores; only regions written since the slot's last save are copied again.
_Avoid_: Region (navigation regions are 16³; render batch regions are 8 × 8 chunks of meshes)
```

ADR 0004 (context, decision, consequences in the repo's ADR style — read `docs/adr/0003-*.md` first): full chunk snapshots instead of deltas against the generator (generator-version coupling, multiplayer); content-addressed gzip blobs + manifest last (incremental + atomic, server-ready); faithful-not-exact resume (navigation and searches rebuilt; units replan; tasks re-expand); block tables must be prefixes.

- [ ] **Step 2: Full verification.** `npm run typecheck`, `npm test`, e2e `save`, `living`, `smoke`, `flood`, `workers`, `collapse` with `--workers=1`. Record counts.

- [ ] **Step 3: Benchmark (quiet window from the user).** Ask the user for a quiet window (no games, no other dev servers). Run `BENCH_SAVE=1 E2E_PORT=5197 E2E_CHANNEL=msedge npx playwright test e2e/save-bench.spec.ts --workers=1` twice; report the worse of the two against the targets (incremental living stall ≤ 50 ms, full 1024² stall ≤ 250 ms, 1024² `loadToReadySimMs` ≤ `genMs`). If a target fails, profile before changing anything (likely: `encodeRegion` copying many dense chunks; water `snapshot` at 1024² packing 4 arrays of 1M ints) and bring numbers + candidates to the user.

- [ ] **Step 4: User checkpoints (in Portuguese).**
  1. Living: start work, break the dam, save mid-flood (P → Save as…), reload from the panel: water continues with no jump, units resume, tower state kept.
  2. Save mid-collapse and mid-fall; load: pieces keep falling and land.
  3. First person: save in FP, load: camera comes back in FP at the same spot.
  4. Autosave: wait 5 min (or `?autosaveMs=20000`), see `autosave-1`/`autosave-2` alternate in the panel.
  5. Incompatible save message: bump `SECTION_VERSIONS.water` locally, load an old save, read the message; revert.

- [ ] **Step 5: Review doc and commit.** Write `docs/superpowers/reviews/2026-10-13-persistence.md` (what shipped, measurements, deviations 1–8, open items), append a "Results" section to this plan, then:

```bash
git add CONTEXT.md docs/adr/0004-saves-are-chunk-snapshots-in-content-addressed-blobs.md docs/superpowers/reviews/2026-10-13-persistence.md docs/superpowers/plans/2026-10-13-persistence.md
git commit -m "docs(persist): CONTEXT terms, ADR 0004, review and measurements"
```

Then hand over to superpowers:finishing-a-development-branch (merge is the user's call).
