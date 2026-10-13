# Elovox — Sub-project 6: Persistence — Design

Status: approved in brainstorming on 2026-10-13 (three sections approved in chat). Last item of the original roadmap
([core spec](2026-10-01-voxel-core-design.md) §1 decomposition, item 6). Command-log replay, also listed there, is
out of scope (§9).

## 1. Context

What the code does today (mapped on 2026-10-13):

- **Every boot generates the world.** `createEngine` creates the shared world buffers and posts `init`; the sim
  configures the terrain generator and generates every column (`sim/simHost.ts` `init`). There is no way to pass in
  voxels, water, units or a tick. The only hook is `GeneratorModule`.
- **There is no serializer.** The only persistence code is the terrain editor's document JSON
  (`terrain-editor/src/core/docio.ts`, File System Access in `ui/files.ts`). No IndexedDB, OPFS or compression use.
- **The sim worker is the single writer.** `ChunkStore` (SharedArrayBuffer, 32³ chunks, one Uint16 voxel = 12-bit id +
  4 state bits, separate Uint8 light, uniform chunks stored as a negative chunk-table entry) is written only by the
  sim; the main thread, mesh, gen and water workers read it.
- **`Simulation.hash()` mixes the state that decides the future** (`sim/simulation.ts`), but not the scheduler queue,
  the leftover neighbour queue or gravity's pending positions.
- **Determinism is tested** for two sims and for a command-log replay (`test/determinism.test.ts`). Terrain
  regeneration and `setPaused` are applied between ticks and are not in the command log.
- **Some state is derivable**: light (`light.initialize()`), the whole navigation cache, water publish buffers and the
  water worker (`waterResync`), the collapse member counts.

| Topic | Decision |
|---|---|
| Purpose | **Save and continue a game.** The player saves the living world (edited terrain, water, units, work) and continues where they left off |
| Exactness | **Faithful, not bit-identical.** Everything the player perceives is saved exactly; navigation caches and in-flight searches are dropped and rebuilt. Loading the same save twice gives identical runs; a loaded run is not identical to one that never saved |
| Voxels | **Full snapshot of chunks** (approach A), split into regions. Rejected: deltas against the generated world (couples every save to the exact generator version, and every client/server to it in multiplayer; load must generate first); command-log replay from generation (log is trimmed, slow for long sessions, regeneration is not logged) |
| Storage | **Browser now (OPFS), a server database later** for multiplayer. The format is storage-agnostic: a package of a manifest plus content-addressed blobs behind a `SaveStore` interface |
| Player flow | **Named slots + periodic autosave**, load by URL (`?save=name`) |
| Versions | **Per-section versions; an incompatible save is refused** with a clear message. Blocks are stored by name. Migrations only when worth it, one at a time |
| Load | **Creates a new engine from the snapshot** (`createEngine({ restore })`); the sandbox reloads the page to do it |

### Multiplayer direction (not built here)

The intended game: each player owns a 1024² island, saves and loads it from a server, and other players can load it to
visit. This design keeps that path open:

- A save is a package of independent, content-addressed blobs: the server keeps blobs in object storage (key = hash)
  and the manifest plus owner metadata in a database. Uploads are incremental for free.
- Voxels are split into regions so an autosave rewrites, and later uploads, only the regions that changed; a visitor
  could later load the region near the camera first.
- Sections are independent, so a visitor could later load only what it needs to see.
- The sim already runs in Node (tests and benches), so a server could open a save and run or validate it.

Live visiting (watching another island change in real time) needs an authoritative sim that streams commands; it is a
later multiplayer sub-project and not part of this one.

## 2. Architecture

New pieces:

- **`packages/engine/src/persist/`**
  - `package.ts`: the package codec (manifest, section and region blobs, hashes, version checks).
  - `store.ts`: the `SaveStore` interface (`list`, `readManifest`, `writeManifest`, `hasBlob`, `readBlob`,
    `writeBlob`, `delete(slot)`, `gc()`, `estimate()`) and `MemoryStore` (tests, Node). A future `HttpStore` talks
    to the server with the same interface.
  - `opfs.ts`: `OpfsStore`, used inside the persistence worker.
  - `persist.worker.ts`: compresses, hashes and writes blobs; reads, verifies and decompresses on load.
- **Per-system `serialize()` / `restore()`** on the sim systems: world store, scheduler and neighbour queue, water,
  gravity, collapse, workers, pending commands.
- **Sim protocol**: `ToSim` gains `snapshot { id, regions }`; `FromSim` gains `snapshot { id, sections, regions }`.
  `SimInitOptions` gains `restore` (decoded sections + region buffers) which replaces generation.
- **Engine API**
  - `engine.save(slot, { app }): Promise<SaveResult>` — `app` is free JSON owned by the game.
    `SaveResult = { bytes, regionsWritten, blobsWritten, simStallMs, totalMs }`.
  - `engine.saves`: `list()`, `delete(slot)`, `estimate()` over the configured store.
  - `createEngine({ restore: slot })` boots from a save; `engine.restored: { app, manifest } | null`.
  - `EngineOptions.persistWorker` (factory, like the other workers) and `EngineOptions.saveStore` (override for tests).

Data flow on save: main → sim (`snapshot`) → main → persistence worker (compress, hash, write) → main resolves.
On load: persistence worker (read, verify, decompress) → main → sim `init { restore }` → `ready`.

## 3. Package format

A save slot holds one **manifest** (JSON) and the blobs it references.

**Manifest**

```ts
interface Manifest {
  format: 'elovox-save'; formatVersion: 1
  engine: string                 // engine version, informational
  created: string                // ISO date
  seed: number; size: [number, number, number]; tick: number; paused: boolean
  blocks: string[]               // block names by id (air first): ids are remapped by name on load
  terrain: TerrainDocument | null // for the editor and later regeneration; never used to rebuild voxels
  sections: { name: string; version: number; hash: string; bytes: number }[]
  regions: { rx: number; rz: number; hash: string; bytes: number }[]
  session: string                // id of the engine session that wrote it (incremental baseline, §5)
  revisions: number[]            // per-region revision at save time, for that session
}
```

**Blobs** are gzip-compressed (`CompressionStream`, available in browsers and Node) and named by the SHA-256 of their
compressed bytes (`crypto.subtle`). A blob already present in the store is not written again.

**Regions**: 256 × 256 blocks (8 × 8 chunk columns) over the full height; a 1024² world has 16 regions. A region blob
holds a small header (region coords, chunk count, region format version) and, per chunk in layout order, either
*uniform* (the voxel, 2 bytes) or *dense* (32³ Uint16 voxels, 64 KiB). Light is not stored. Block ids inside are the
saving engine's ids; the manifest's `blocks` table maps them by name.

**Sections** (each with its own version):

| Section | Contents |
|---|---|
| `scheduler` | scheduled block updates (pos, due tick, seq), the global seq, the leftover neighbour queue |
| `water` | per column `depth`, `flux`, `last`, `falls`; under segments (pool order kept); bodies; edge flux; `sea` account; springs (insertion order); sea mask; awake/quiet tiles; mirror; `steps`, `expected` |
| `gravity` | falling bodies `{id, voxel, x, z, y256, vy256}`, `nextId`, pending positions |
| `collapse` | fragments `{id, positions, voxels, runs, offset256, vy256}`, `nextId`, seeds, dirty chunks, scan cursor, search in progress, epochs |
| `workers` | units, orders, tasks, loose piles and counters (§4) |
| `pending` | commands received but not yet applied, with their stamps |
| `app` | the game's JSON (the sandbox's scene, camera and script state) |

Binary sections use typed arrays with a short header; `workers` and `app` are JSON.

**Atomic write**: blobs first, the manifest last, written under a temporary name and moved into place. A save that
dies midway leaves the previous manifest valid. Blobs no manifest references are removed by `gc()` after a successful
save.

**Versions**: each section and the region format have a version number. On load, a version that differs from the
engine's current one, with no registered migration, refuses the load with a message naming every mismatch
(`section water v2, engine expects v3`). A block name missing from the current registry also refuses the load.
Ids are remapped by name when the order differs.

## 4. What each system saves and drops

**Saved exactly**

- **World**: voxels of every chunk (state bits included: grass youth, water level, spring flow), tick, paused flag.
- **Scheduler**: scheduled updates and the neighbour queue left over from the last tick.
- **Water**: everything listed in §3, so water continues exactly where it stopped, with no jump.
- **Falling bodies and structural fragments**: positions in 1/256, velocities, shapes, ids, gravity's pending queue,
  the collapse scan in progress.
- **Units**: id, position, facing, state, tools, stock, goal, current task (order + index), vertical velocity,
  `available`, `allowDig`, `buildBlock`.
- **Orders**: all fields including build ring progress; loose drop piles; counters `nextUnit`, `nextOrder`, `time`.
- **Pending commands**.

**Dropped and rebuilt on load**

- **Light**: `light.initialize()` after the voxels are filled.
- **All navigation**: support graph, region store, landmarks, prebuild, revisions — it starts empty as in a new scene.
- **Units' in-flight work**: searches (A*, HPA* route, group field, space-time repair, engineering), path, motion,
  projection, reservations, repairs, yield state. Each unit plans again on its first tick. **A unit in the middle of a
  step is restored on the cell it stepped from**, so a restore never places a unit on an unvalidated pose (a pop of
  less than one block).
- **Cached task failures**: cleared; the unit tries again.
- **Publication state**: water republishes every tile (`waterResync`), every unit and pile is marked dirty, and
  fragment births are re-sent to the main thread.

## 5. Save and load pipelines

**Save**

1. `engine.save(slot, { app })` posts `snapshot { id, regions }` to the sim, where `regions` is the set of regions whose
   revision changed since the last save of this slot in this session (all regions when the slot was last written by
   another session, or never).
2. The sim answers **between two ticks**: it copies the requested regions' voxels and serializes every section into
   transferable buffers. Only this step stops the sim; rendering continues.
3. Main forwards the buffers to the persistence worker, which compresses, hashes, writes the missing blobs and writes
   the manifest last. Regions not re-sent keep their hashes from the previous manifest.
4. `engine.save` resolves with the `SaveResult`. A save requested while another is running is coalesced into the next
   one (both callers resolve with its result).

**Region revisions**: the sim keeps a Uint32 revision per region, bumped whenever a chunk in it is committed. A restore
resets them to zero and gives the engine a new session id; the slot it came from records that session and all-zero
revisions as its baseline.

**Load**

1. The sandbox reloads the page with `?save=name` (the robust way to release up to 384 MiB of SharedArrayBuffers).
2. The persistence worker reads the manifest, checks versions and the block table, reads and verifies every blob
   (hash mismatch or missing blob = corrupted save, refused) and decompresses.
3. `createEngine({ restore })` creates the world buffers from the manifest's size and posts `init { restore }`. The sim
   configures the terrain generator with the saved document (so later regeneration works), **skips generation**,
   fills the chunks (remapping ids), runs `light.initialize()`, restores each section, rebuilds derived state and posts
   `ready`. Meshing, water publication and rendering then follow the normal boot path.

**Targets** (measured in the plan, on the user's laptop, quiet machine, alternating runs)

| Metric | Target |
|---|---|
| Sim stall, incremental autosave, living scene | ≤ 50 ms (one tick) |
| Sim stall, full save, 1024² world | ≤ 250 ms |
| Load of a 1024² save until `ready` | ≤ generating the same world (~1.6 s) |
| Compressed size, living and 1024² | recorded, no target yet |

## 6. Sandbox

- **Save panel** (key `P`, styled like the existing HUD): slot list with name, scene, world size, date and size in
  MB; **Save as…**, **Load**, **Delete**; overwriting a slot asks for confirmation; shows storage used/available
  (`navigator.storage.estimate()`).
- **Autosave** every 5 minutes, rotating between `autosave-1` and `autosave-2` so a failed autosave leaves the other
  intact. It can be turned off in the panel and does not run while the terrain editor is open. A test URL parameter
  shortens the interval.
- **Load** reloads the page with `?save=name`; the parameter also works directly.
- The sandbox calls `navigator.storage.persist()` once so the browser does not evict saves under storage pressure.
- **`app` section**: scene name, camera pose and mode (orbit or first person) and the scene scripts' state. Each scene
  script gains `save(): unknown` and `restore(state)` (for example the living quarry cycle and its started/breached
  flags); scenes without a script save only the camera.

## 7. Errors

No error ever leaves a half-written save in place of a good one.

- **Incompatible section version or unknown block**: load refused; the message lists every mismatch.
- **Hash mismatch or missing blob**: save treated as corrupted; the panel offers the other autosave.
- **Quota exceeded**: the save fails, the previous manifest stays valid, the panel shows used and available space.
- **Save during a terrain regeneration**: queued behind it; the sim handles one message at a time.
- **Persistence worker dead or stuck**: timeout; the save fails with an error and the game keeps running.

## 8. Testing

- **Unit (Node, `MemoryStore`)**: round trip of every section; package codec (hashes, dedupe, manifest last, version
  and block refusal, id remap by name, corruption detection); incremental saves copy only dirty regions; a unit in mid
  step restores on its start cell; a restored unit replans and finishes its task.
- **Determinism**: run a scene N ticks, save, load twice, run N more ticks — the two loaded runs have equal hashes;
  save → load → save gives identical sections (navigation excluded); water arrays at load equal those of the
  uninterrupted run at the save tick.
- **e2e (Playwright)**: in the living scene, save, reload with `?save`, check units, water and tick; autosave fires with
  the short test interval; a corrupted save is refused with its message.
- **Bench `BENCH_SAVE=1`**: sim stall for an incremental autosave (living) and a full save (1024²), compressed sizes,
  load time to `ready` against generation time.

## 9. Out of scope

- Server, accounts, uploading and visiting islands.
- Exporting or importing a save as a single file.
- Persisting and replaying the command log.
- Opening saves from incompatible builds (no migrations ship with this sub-project).
- Bit-identical resume (navigation and in-flight searches are rebuilt).
