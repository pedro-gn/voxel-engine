# Elovox — Sub-project 1: Voxel Core & Render — Design

Date: 2026-10-01
Status: Approved in brainstorming, pending spec review

## 1. Context

Elovox is a reusable three.js voxel engine. Games will be built on top of it; the
first is a **diorama/colony sim** (stylized textured cubes, 3/4 camera, units digging
and building, water flowing into holes). Later games may be Minecraft- or
Cube World-like.

### Engine-wide requirements (all sub-projects)

| Area | Decision |
|---|---|
| Platform | Desktop browser (Chrome/Edge/Firefox), mid-range laptop GPU |
| Stack | TypeScript, vanilla three.js, Vite, npm workspaces |
| World | Bounded, 1024 × 128 × 1024 (x × y × z) |
| Camera | Free orbit (RTS) **and** first-person |
| Look | Stylized textured cubes: painted textures, smooth vertex AO, grass/flower decorations, animated water |
| Simulation | Flowing water (levels), falling blocks, structural collapse, spreading/growth rules |
| Services | Collision + character controller, voxel pathfinding, save/load, multiplayer-ready deterministic core |

### Decomposition

1. **Core & render (this spec)** — world storage, block registry, commands, tick loop,
   rule API, workers, meshing, rendering, raycast, orbit camera, sandbox.
2. Terrain & visual polish — noise terrain like the reference image, grass/flower
   instancing, water shader, shadows, fog, sky.
3. Simulation — water, falling blocks, spreading, then structural collapse (region jobs).
4. View distance & first-person — chunk LOD, AABB collision, character controller.
5. Pathfinding.
6. Persistence — save/load, command-log replay.

Each later sub-project gets its own spec → plan → implementation cycle.

### Assumptions

- "Performant" = 60 fps on a mid-range laptop GPU at the default 3/4 view.
- Characters and props are ordinary three.js meshes; the engine does not voxelize them.
- No networking now. "Multiplayer-ready" = all world mutation through commands +
  fixed-rate deterministic tick, so networking can be added without a rewrite.

### Success criteria for this sub-project

- The sandbox runs a 1024 × 128 × 1024 test world at 60 fps at the 3/4 view.
- A local add/delete edit is visible within 2 frames of the click.
- All tests in §8 pass, including the determinism and torn-read tests.

## 2. Threading architecture

A SharedArrayBuffer world. The **sim worker is the only writer**; everyone else reads.

```
          SharedArrayBuffer: chunk table + chunk slots (u16 voxels, u8 light) + per-chunk version
          ▲ read                    ▲ read/WRITE                ▲ read
 ┌────────┴──────────┐   cmds  ┌────┴──────────────┐  dirty  ┌──┴──────────────┐
 │ Main thread       │────────▶│ Sim worker        │────────▶│ Mesh worker pool│
 │ render, input,    │         │ applies commands, │  list   │ zero-copy reads │
 │ raycast/collision │◀────────│ fixed-tick rules  │         └──┬──────────────┘
 │ (zero-copy reads) │ events  │ (water/fall/...)  │            │ geometry
 └───────────────────┘         └───────────────────┘◀───────────┘ (transferable)
```

- **Main thread:** rendering, input, raycasts and (later) collision, all reading live
  shared memory. It never writes voxels.
- **Sim worker:** owns all mutation: applying commands, scheduled and random ticks,
  light propagation, and allocating/freeing slots. It is a deterministic state
  machine: commands in, events out.
- **Mesh worker pool:** `max(1, min(6, hardwareConcurrency - 2))` workers. They read
  chunks and neighbours from shared memory and return geometry as transferables.
  The dirty list goes to the main thread, which owns the mesh queue and its
  priorities and dispatches jobs to the pool.
- Requires **cross-origin isolation** (COOP `same-origin`, COEP `require-corp`).
  The sandbox's Vite dev/preview servers set these headers.

## 3. World data model

### Coordinates

- x, z ∈ [0, 1023]; y ∈ [0, 127].
- Chunks are 32³, giving a grid of 32 × 4 × 32 = **4096 chunks**.
- Chunk index = `cx + cz * 32 + cy * 1024`; local voxel index = `lx + lz * 32 + ly * 1024`.
- Reads outside the world return air. The world's edges therefore render as exposed
  cliffs.

### Voxel encoding (`u16`)

```
bits 0–11   block id   (0 = air; up to 4096 block types)
bits 12–15  state      (block-defined: water level 0–7 + falling bit, growth stage, facing…)
```

### Light encoding (`u8`, parallel array)

```
bits 0–3  sky light   (0–15)
bits 4–7  block light (0–15)
```

Light is flood-filled by the sim worker, Minecraft-style. Sky light propagates down
without falloff through non-opaque blocks and spreads sideways with a falloff of 1;
block light spreads with a falloff of 1. Each block definition declares `emits`
(0–15) and whether it is opaque to light.

### Shared memory layout

```
chunkTable  Int32Array[4096]   ≥ 0 → slot index
                               < 0 → uniform chunk; voxel = -(value + 1); light implied:
                                     sky 15 / block 0 if the block is non-opaque, else 0 / 0
versions    Uint32Array[4096]  seqlock: odd = write in progress, even = stable
slot pages  N × SharedArrayBuffer, 256 slots each
            slot = 32768 × u16 voxels (64 KB) + 32768 × u8 light (32 KB) = 96 KB
            page ≈ 24 MB
```

- **Uniform chunks** (all air, all stone…) take no slot.
- The first write that breaks uniformity allocates a slot (sim worker only) and fills
  it with the uniform value.
- Light can also break uniformity. If light propagation would give a voxel in a
  uniform chunk a value other than the implied one, the sim allocates a slot first.
  An enclosed air cave chunk is one example, since it is dark rather than sky 15.
- A chunk is collapsed back to uniform when its voxels *and* its light are uniform and
  match the implied light. This is checked lazily when the chunk is written.
- **Pages are added on demand.** The sim allocates a new page and posts the new
  `SharedArrayBuffer` to the main thread and every mesh worker before any chunk table
  entry points into it. Growable shared buffers are not relied on.
- Expected budget: ~1500 non-uniform chunks ≈ 6 pages ≈ **150 MB**. Variable-size
  palette compression is a future optimization, not part of this spec.

### Seqlock protocol

- **Writer (sim):** `Atomics.add(versions[c], 1)` (becomes odd), then write voxels and
  light, then `Atomics.add(versions[c], 1)` (becomes even). It does this once per chunk
  per tick, wrapping all of that tick's writes to the chunk, not once per voxel.
- **Reader (main thread / mesher):**
  1. Read the version `v0`; if it is odd, retry.
  2. Read the data.
  3. Read `v1`; if `v1 !== v0`, retry.
- Meshers apply this to the chunk and each neighbour they sample. After 8 failed
  retries, the job is requeued.
- Single-voxel reads on the main thread (raycast, game `world.get`) may skip the
  seqlock. A `u16` read is atomic, and a momentarily stale voxel is acceptable there.

### Block registry

The game defines blocks as plain data, and an identical registry is constructed in
every thread:

```ts
defineBlock({
  name: 'grass',
  textures: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' }, // or textures: 'stone'
  solid: true,          // collides (used by sub-project 4)
  opaque: true,         // hides neighbour faces, blocks light
  layer: 'opaque',      // 'opaque' | 'cutout' | 'translucent'
  emits: 0,             // block light 0–15
  liquid: false,
  decoration: 'grassTuft', // opaque hint, consumed by sub-project 2
})
```

- Air is id 0 and is always registered. Ids are assigned in definition order, so the
  definition order is part of the save format.
- Texture names are resolved to texture-array layers at load.
- Behaviour lives in the rules module (§4), not in block definitions.

## 4. Commands, ticks and rule API

### Tick loop (sim worker, fixed 20 Hz)

```
1. apply commands stamped for this tick     (ordered by tick, clientId, seq)
2. run scheduled block updates due now      (FIFO within the same due tick)
3. random ticks: K random voxels per non-uniform chunk (K = 3, configurable)
4. propagate light for voxels changed this tick
5. close the seqlocks on the chunks written this tick → post
   { tick, dirtyChunks, events, acks } to main
```

The sim drives ticks with a fixed-step accumulator. If it falls behind, it runs at
most 4 catch-up ticks per wake-up, then drops the backlog and logs it.

### Commands

- Commands are the **only** way to mutate the world.
- Built-in commands are `setBlock { pos, voxel }` and `fillRegion { min, max, voxel }`.
  Games can register their own command types, with handlers in the rules module.
- `engine.submit(cmd)` assigns `{ clientId, seq }`. The sim stamps the command with
  the next tick and appends it to the **command log**: an in-memory ring of entries
  `{ tick, clientId, seq, cmd }`. Sub-project 6 persists that log.
- **Ack** `{ seq, ok, error? }`. A rejected command (out of bounds, unknown block,
  handler error) returns `ok: false`, which rolls back the matching ghost edit.

### Ghost edits (client prediction)

- On `submit`, the main thread records the predicted voxel in an overlay
  (`ghostEdits`).
- `engine.world.get` consults the overlay first.
- The edited chunk, and its neighbours if the edit is on a border, are queued at top
  mesh priority with the overrides attached to the job.
- The overlay entry is cleared when its ack arrives. The ack is posted together with
  the dirty list of the tick that applied it, so the authoritative remesh replaces the
  ghost mesh without a flicker.

### Rule API (game module, imported by the sim worker)

```ts
export default defineRules({
  blocks: {
    water: {
      onNeighborChanged(ctx, pos, voxel) { ctx.schedule(pos, 5) },
      onScheduledTick(ctx, pos, voxel) { /* flow logic */ },
    },
    grass: {
      onRandomTick(ctx, pos, voxel) { /* spread using ctx.random() */ },
    },
  },
  commands: {
    // custom command handlers: (ctx, cmd) => void
  },
})
```

`ctx` provides:

- `get(x, y, z)`
- `set(x, y, z, voxel)`: applies immediately and fires `onNeighborChanged` on the 6
  neighbours, which are queued in the same tick.
- `schedule(pos, delayTicks)`: deduplicated per position, keeping the earliest due
  tick.
- `random()`: PCG32, seeded from the world seed, the tick and the chunk index.
- `emit(type, payload)`: an event delivered to the main thread.
- `id(name)`, `state(voxel)`, `withState(voxel, s)`, `isAir(voxel)`.

### Determinism rules

- World state is integers only. Rules must not use `Math.random`, `Date`,
  `performance.now` or floats in stored state.
- Iteration order is fixed everywhere: command order, scheduler FIFO, random-tick
  chunk order by chunk index, light queue order.
- The per-tick work cap is a **count** (default 50 000 scheduled updates). Leftover
  updates carry into the next tick in order. A time-based cap is forbidden because it
  makes results depend on the machine.

### Out of scope here

Region jobs (multi-chunk support checks for structural collapse) belong to
sub-project 3 and will extend this API.

## 5. Meshing and rendering

### Renderer

- three.js `WebGPURenderer` with TSL node materials.
- It falls back to WebGL2 automatically, and the same TSL materials run on both
  backends.

### Mesh jobs

- A job is `{ chunkIndex, overrides? }`.
- The worker reads the chunk plus a 1-voxel border from its neighbours (via the
  seqlock), and returns, per render layer, the packed vertex buffer, the index buffer
  and the version it meshed.
- The main thread discards a result whose version is older than one it has already
  applied.

### Greedy meshing (opaque layer)

- Faces are emitted only where the neighbour is non-opaque, or belongs to the same
  translucent block type (culled).
- Per face direction, faces are merged into rectangles only when block id, the AO of
  all 4 corners and the light values all match. Merging never smears shading.
  - Note: the implementation merges by the face's texture layer rather than block id
    (plan Deviation 10).
- AO is per vertex, 0–3, from the classic side1/side2/corner test. When
  `ao0 + ao2 < ao1 + ao3`, the quad's diagonal is flipped to avoid the anisotropy
  artifact.

### Packed vertex (8 bytes)

```
u32 #1: x (6b) | y (6b) | z (6b) | normal (3b) | ao (2b) | corner (2b) | reserved (7b)
u32 #2: texture layer (12b) | sky light (4b) | block light (4b) | quad w (6b) | quad h (6b)
```

- Local position runs 0–32, so 6 bits per axis.
- The shader unpacks these fields and adds the chunk origin from a per-mesh uniform.
- UVs are computed by projecting the position onto the face plane, wrapped with
  `fract()`, so merged quads tile correctly.

### Render layers (3 meshes per chunk at most)

| Layer | Meshing | Material |
|---|---|---|
| opaque | greedy | opaque, depth write |
| cutout | per-face, no merge | alpha test, double-sided for flora |
| translucent | per-face | blended, depth test, no depth write; chunk meshes sorted back to front |

- **Liquid top faces** are lowered by level: height = (level + 1) / 9. Each corner
  height is the average of the up-to-4 liquid cells that share that corner, which
  gives a smooth surface.
- Side faces between liquid cells of different heights fill the gap.

### Mesh queue (main thread)

Priority order:

1. Jobs with ghost overrides.
2. Dirty chunks, nearest to the camera first.
3. Initial load, nearest first.

- At most one in-flight job per chunk. If a newer version is dirty while a job is
  running, it is requeued when the result returns.
- An edit within 1 voxel of a chunk border also dirties the neighbour.
- Mesh upload is capped by a per-frame time budget on the main thread (default 4 ms
  of geometry upload).

### Textures

- Each 64 × 64 PNG tile is loaded into one `DataArrayTexture` layer.
- Mipmaps are generated, filtering is linear with max anisotropy, and colours are
  sRGB.
- Missing textures use a magenta/black checker layer and log a warning.

### Lighting (core)

`final = albedo × (sunTerm × skyLight/15 + ambient × max(skyLight, blockLight)/15) × aoCurve(ao)`

- The sun is a directional light. Ambient is hemisphere-style (sky colour vs ground
  colour by normal).
- Shadows, fog, sky, decorations and the water shader belong to sub-project 2.

### Draw calls

- One `Mesh` per chunk per non-empty layer, with three.js frustum culling.
- The expected range is 300–1000 draws at the 3/4 view.
- `BatchedMesh` or multi-draw is the planned upgrade *only if profiling demands it*.

### Interaction

- **DDA raycast** (Amanatides–Woo) on the main thread reads `WorldReader`, ghosts
  included. It returns `{ pos, normal, voxel } | null` with a max distance in blocks,
  and it handles world-edge entry.
- **Highlight:** a wireframe box on the hovered block. Placement uses
  `pos + normal`.
- **RTS orbit camera:**
  - WASD and screen-edge pan, on a ground plane at the terrain height under the focus
    point.
  - Mouse wheel zoom, with min and max distance.
  - Right- or middle-drag to rotate the yaw and to adjust pitch within a clamp.
  - Damped motion.

### Performance targets

- Under 3 ms to mesh a typical chunk in a worker.
- Under 2 frames from a click to pixels for local edits.
- 60 fps at the 3/4 view on a mid-range laptop.

## 6. Package layout and public API

```
package.json                (npm workspaces)
packages/engine/src/
  world/     voxel.ts · layout.ts · reader.ts · chunkStore.ts
  blocks/    registry.ts
  sim/       sim.worker.ts · tick.ts · commands.ts · scheduler.ts · rules.ts · light.ts · rng.ts
  mesh/      mesh.worker.ts · greedy.ts · ao.ts · liquid.ts · vertexFormat.ts
  render/    renderer.ts · chunkMeshes.ts · materials.ts · textureArray.ts
  interact/  raycast.ts · orbitCamera.ts · ghostEdits.ts
  engine.ts  createEngine() — the only public entry point
  index.ts   public exports
apps/sandbox/
  1024² test world, place/delete tools, perf HUD
  (fps, frame ms, tick ms, mesh queue length, slots used, draw calls)
```

Worker files are thin message shells around pure modules. All logic is testable
without workers.

### Public API

```ts
const engine = await createEngine({
  canvas,
  size: [1024, 128, 1024],
  seed: 1234,
  blocks,                                              // defineBlock(...) list
  textures: { grass_top: '/tex/grass_top.png' /* ... */ },
  rules:     new URL('./rules.ts', import.meta.url),   // imported by the sim worker
  generator: new URL('./gen.ts',   import.meta.url),   // initial terrain, runs in the sim worker
})

engine.submit(cmd)                 // → seq
engine.world.get(x, y, z)          // live read (ghosts included)
engine.raycast(origin, dir, maxDist)
engine.on('tick' | 'event' | 'ack' | 'fatal', fn)
engine.scene; engine.camera        // plain three.js objects for game content
engine.blocks.id('stone')
engine.dispose()
```

### Generators

- A generator exports `generateColumn(ctx, cx, cz)`, where `ctx` has `seed`,
  `set(lx, y, lz, voxel)` and seeded noise helpers.
- The sim calls it for each of the 32 × 32 chunk columns before tick 0. Untouched
  chunks stay uniform air, and chunks completely filled with one block are stored as
  uniform.
- Generation is deterministic. The initial light pass runs after generation.
- The core ships one test generator: a layered 2D-noise heightmap with grass, dirt
  and stone layers. The final terrain look belongs to sub-project 2.

## 7. Error handling

| Situation | Behaviour |
|---|---|
| `crossOriginIsolated === false` | Error screen naming missing COOP/COEP headers |
| No WebGPU | Automatic WebGL2 fallback; if neither works, error screen |
| Rule throws | Update dropped; logged with block, pos, tick; sim continues |
| Mesh worker crash | Respawn worker and requeue job. After 3 failures, the chunk keeps its last good mesh and the HUD reports it |
| Sim worker crash | `fatal` event with the error; engine stops ticking |
| Slot page allocation fails | `fatal` event with slot count |
| Invalid command | Rejected with `ack { ok: false, error }`; ghost rolled back |
| Missing texture | Checker layer + warning |

## 8. Testing

**Unit tests (Vitest, pure modules):**

- Voxel and light packing round-trips, layout index math and world-bounds handling.
- Chunk store: a uniform chunk's first write allocates a slot, collapsing returns it,
  and a new page is added when a page fills.
- Seqlock reader against a writer, in a single thread with interleaved steps.
- Greedy mesher:
  - The expected quad counts for a single block, a 2×2×2 cube, a staircase, and a
    checkerboard (no merging).
  - Merging stops at AO and light differences.
  - Border faces use neighbour data, and world-edge faces are emitted.
- AO values for canonical corner configurations, and the diagonal flip.
- Liquid mesher corner averaging.
- DDA raycast:
  - Axis-aligned and diagonal rays.
  - Chunk borders, starting inside a block, the world-edge entry, max distance.
  - Ghost overrides.
- Scheduler:
  - FIFO within a tick and dedupe keeping the earliest due tick.
  - The work cap spills into the next tick.
- PCG32 reproducibility.
- Light:
  - A torch placed and then removed.
  - Digging a skylight shaft.
  - Opaque blocking.
  - Uniform-chunk implied light.
- Commands: ordering, validation and rejection acks.

**Determinism test (the critical one):**

1. Generate a world.
2. Submit a scripted command list, including rules that schedule and random-tick.
3. Run 500 ticks and hash the world.
4. Running the same sequence twice must give the same hash.
5. Replaying the command log from the same seed must also give the same hash.

**Concurrency test:** Node `worker_threads` share a buffer. One writer repeatedly
rewrites a chunk while a reader meshes it. Every mesh the reader returns must match
some fully written state, with no torn reads.

**Benchmarks (`vitest bench`):**

- Mesh a typical surface chunk; the target is under 3 ms.
- Tick cost with 10k scheduled updates.

**Browser smoke test (Playwright, sandbox):**

- The page loads, `crossOriginIsolated` is true and the canvas renders.
- There are no console errors.
- `setBlock` and then removing the block via the API reaches the expected
  `world.get` values.
- The HUD reports fps.

## 9. Out of scope for this sub-project

The following belong to later sub-projects:

- Terrain beauty pass, decorations, water shader, shadows, fog and sky (2).
- Water, falling-block, spreading and collapse rules (3). The rule API is in scope;
  the rules themselves are not.
- LOD, first-person camera, collision and the character controller (4).
- Pathfinding (5).
- Saving, loading and persisting the command log (6).
- Networking.
