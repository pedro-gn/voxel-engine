# Terrain Editor (brushes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Height, biome and 3D density brushes in the terrain editor, painting the document's layers with a live preview of ≤ 150 ms per update at radius 16, undo, and save.

**Architecture:** `@elovox/terrain` stores layers as sparse tiles (base64 in the file, typed arrays in memory), adds the height layer in 1/16 block, clamps the density field to ±4 before the density layer, and exposes `sampleHeights`/`sampleDensity` plus `TerrainPatch` (`diffLayers`, `checkPatch`, `applyPatch`) and the generator's `patch`. The engine gains a generic `engine.terrain.patch` that reaches the sim and every generation worker. In `@elovox/terrain-editor`, `core/` holds the brush math over copy-on-write tiles, a `TerrainSampler`, a `BrushController` (strokes as session gestures), layer-aware dirty areas and a preview that patches instead of resending the document; `ui/` adds mode tabs, the brush panel, cursors and the layer overlay.

**Tech Stack:** TypeScript 7 (strict, ESM, `.ts` imports), Vitest 4.1.11 (Node environment), three.js 0.186.1 via `three/webgpu`, Vite 8, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-03-terrain-brushes-design.md`

## Global Constraints

- TypeScript config is `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess` (index reads need `!` or a check), `verbatimModuleSyntax` (type-only imports use `import type`), `erasableSyntaxOnly` (**no** enums, **no** constructor parameter properties, **no** namespaces), `allowImportingTsExtensions` (relative imports end in `.ts`).
- three.js is imported **only** from `'three/webgpu'`. It loads fine in Node tests.
- No new runtime or dev dependencies (no jsdom, no fast-check).
- Code, comments and commit messages are in English. Commit messages follow the repo style (`feat(terrain): …`, `feat(engine): …`, `feat(terrain-editor): …`, `test(…)`, `docs(…)`). Do **not** add a `Co-Authored-By` trailer (the user's global rule; the project's `.claude/settings.json` sets no `attribution.commit`).
- Dev server: an old Vite may serve stale code on :5173. Run the dev server with `npx vite --port 5174` in `apps/sandbox`, and the e2e with `E2E_PORT=5174 npm run e2e`.
- The rtk shell hook rewrites `grep`: patterns with `\|` fail. Use the Grep tool or separate greps.
- The golden column hashes of the showcase (`apps/sandbox/test/terrainDocs.test.ts`) must not change. No document in the repo has layer data, so the layer format changes in place with `version: 1`.
- Units (spec §3): height layer Int16 in **1/16 block**, tiles of **64 × 64** columns; biome layer Uint8 per **4 × 4** columns, tiles of **16 × 16** cells; density Int8 in **1/8 block**, bricks of **8³** samples **2 blocks** apart; the density field is clamped to **±4** blocks before the density layer.
- Brush ranges (spec §5): radius **2–64** blocks, strength **0–1**, falloff **0–1**; dab spacing **radius × 0.25** (at least 1 block); raise **±1 block × weight** per dab; density add **±2 blocks × weight** per dab.
- Performance target (spec §2): a moving radius-16 height stroke updates in **≤ 150 ms** request → visible mesh on the user's laptop, before and after 512² is painted. Measured by the user with the bench (Task 14), not by unit tests.

## Review Focus

1. **A brush partly or wholly outside the world** (painting at the edge, the cursor past the last column) — expected: only in-world columns, cells and samples change, and a dab entirely outside returns the same layers object. Pinned in Task 8 (height and biome) and Task 9 (density).
2. **Esc or Ctrl+Z in the middle of a stroke** — expected: the stroke is cancelled and the world returns to where the stroke began; the step before it is not undone; further pointer moves do nothing and do not throw. Pinned in Task 10 (`BrushController` after `session.undo()` mid-stroke).
3. **Editing an op after painting** — expected: the preview sends the whole document with its layers, so the workers keep the paint. Pinned in Task 6 (layers and ops both changed → `setDocument` with the layers) and Task 4 (configure-with-layers equals configure-then-patch).
4. **Opening a file in the old full-raster format, or with corrupt tile data** — expected: a validation error naming the field; nothing loads. Pinned in Task 1 (`checkLayers` old-format and bad-data errors).
5. **Painting, then erasing everything, then saving** — expected: all-zero tiles vanish and the file has `"layers": {}`. Pinned in Task 7 (`TileWriter.result()` drops zero tiles), Task 9 (a brick added then carved back is removed) and Task 5 (serializing empty layers).

## Deviations from the spec, decided while planning

- **Slope (spec §3, "Height precision"):** the pipeline computes the slope from the rounded column tops, so the slope does not see the fractional delta. Only the rounding of the top does. The spec sentence is corrected in this plan's commit.
- **`engine.terrain.patch` takes no `transfer` list (spec §4):** the editor's typed arrays live in documents kept by the history; transferring them would detach them. The patch is structured-cloned.
- **A refused patch (spec §5, §7):** like a refused `setDocument` in 2c, the status shows the error and the next change retries. There is no separate "paused" state.
- **Brush panel (spec §6):** it builds its own slider + number rows with the inspector's look. The inspector's field widgets are tied to document edits (`Edit`), which brush settings are not.
- **Layer overlay (spec §6):** instanced flat quads at ground height (one per painted biome cell, or per 4 × 4 columns of height delta) instead of a projected texture. It is rebuilt whole when it changes, and only while it is visible.
- **`sampleDensity` (spec §3)** takes a sample grid (`SampleGrid`), which is what the smooth brush needs, rather than a list of points.
- **The editor takes a `seed` option:** `Engine` does not expose its seed, and the sampler needs it to reproduce the base heights.
- **The density cursor** is three great circles of the sphere (lines), not a wireframe mesh.

## File Structure

### `packages/terrain` (modified)

| File | Responsibility |
|---|---|
| `src/doc/types.ts` | `TileRef`, `BrickRef`, `TerrainLayersJSON`, `HeightTile`, `BiomeTile`, `DensityBrick`, new `TerrainLayers`; `RasterRef` and `BrickSetRef` removed |
| `src/layers/tiles.ts` (new) | Tile constants and keys, `encodeValues`/`decodeValues`, `layersToJSON`, `checkLayers` (both forms), `LayerLimits` |
| `src/layers/layers.ts` (new) | `HeightLayer`, `BiomeLayer`, `DensityLayer` over tile maps (replaceable tiles), `compileLayers` |
| `src/layers/raster.ts` | Deleted |
| `src/layers/patch.ts` (new) | `TerrainPatch`, `diffLayers`, `checkPatch`, `applyPatch` |
| `src/doc/json.ts` (new) | `toTerrainJSON` |
| `src/doc/validate.ts` | Uses the new `checkLayers` |
| `src/pipeline/compile.ts` | Layers always present (`compileLayers`) |
| `src/pipeline/cells.ts` | `fillHeights` split out of `fillCells`; height layer in 1/16 block |
| `src/pipeline/volume.ts` | `DENSITY_CLAMP`, `VolumeField.densities` |
| `src/pipeline/sample.ts` (new) | `sampleHeights`, `sampleDensity`, `SampleGrid`, `withLayers` |
| `src/generator.ts` | `patch` |
| `src/index.ts` | Exports |
| `test/layers.test.ts` (rewritten), `test/patch.test.ts` (new), `test/sample.test.ts` (new) | |
| `test/validate.test.ts`, `test/generator.test.ts`, `test/pipeline.test.ts` | Layer tests move to tiles |

### `packages/engine` (modified)

| File | Responsibility |
|---|---|
| `src/sim/generator.ts` | `GeneratorModule.patch?` |
| `src/protocol.ts` | `patchTerrain` (to sim), `patch` (to gen), `fatal` (from gen) |
| `src/sim/simHost.ts` | `patchTerrain`, `ready` flag, `restartActive` |
| `src/sim/genPool.ts` | `patch`, `onFatal` |
| `src/gen/genHost.ts` | Applies patches; reports a refusal as fatal |
| `src/engine.ts` | `engine.terrain.patch` |
| `test/patch.test.ts` (new) | |

### `packages/terrain-editor` (modified)

| File | Responsibility |
|---|---|
| `src/core/area.ts` | `onlyLayersDiffer`, `changedLayerRect`; `diffArea` no longer treats layers as global |
| `src/core/session.ts` | Trusts layers-only changes |
| `src/core/docio.ts` | Serializes through `toTerrainJSON` |
| `src/core/preview.ts` | `patch` for layers-only changes; `TerrainTarget.patch` |
| `src/core/brush.ts` (new) | `BrushSettings`, `Point3`, `brushWeight`, `DabSpacer`, `dabSpacing`, `clampSettings` |
| `src/core/layerWriter.ts` (new) | `TileWriter`, `BrickWriter`, `replaceLayer` |
| `src/core/sampler.ts` (new) | `TerrainSampler` |
| `src/core/heightBrush.ts`, `biomeBrush.ts`, `densityBrush.ts` (new) | One dab of each brush |
| `src/core/brushes.ts` (new) | `BrushController`, modes and tools |
| `src/ui/keys.ts` | Mode and radius keys |
| `src/ui/editor.ts` | Wires the controller, panel, cursor and overlay |
| `src/ui/panels/modes.ts`, `src/ui/panels/brushPanel.ts` (new) | Mode tabs, brush panel |
| `src/ui/panels/toolbar.ts` | "show layers" toggle |
| `src/ui/brushes/colors.ts`, `cursor.ts`, `layerOverlay.ts` (new) | Colours, cursors, overlay |
| `src/index.ts` | Exports |
| `test/fixtures.ts` | `deepFreeze` skips typed arrays; `flatDoc` |

### `apps/sandbox` (modified)

| File | Responsibility |
|---|---|
| `src/main.ts` | Passes `seed`; hint text |
| `e2e/smoke.spec.ts` | Brush e2e |
| `e2e/brush-bench.spec.ts` (new) | The latency bench (`BENCH=1`) |

---

### Task 1: Sparse tiled layer format

**Files:**
- Modify: `packages/terrain/src/doc/types.ts:83-96`, `packages/terrain/src/doc/validate.ts`, `packages/terrain/src/pipeline/compile.ts`, `packages/terrain/src/pipeline/cells.ts`, `packages/terrain/src/pipeline/volume.ts`, `packages/terrain/src/index.ts`
- Create: `packages/terrain/src/layers/tiles.ts`, `packages/terrain/src/layers/layers.ts`, `packages/terrain/src/doc/json.ts`
- Delete: `packages/terrain/src/layers/raster.ts`
- Test: `packages/terrain/test/layers.test.ts` (rewrite), `packages/terrain/test/validate.test.ts`, `packages/terrain/test/generator.test.ts`, `packages/terrain/test/pipeline.test.ts`

**Interfaces:**
- Consumes: `Check` (`src/doc/check.ts`), `base64ToBytes`/`bytesToBase64` (`src/doc/base64.ts`).
- Produces (all exported from `@elovox/terrain`):
  - Types `TileRef`, `BrickRef`, `TerrainLayersJSON`, `HeightTile { x; z; values: Int16Array }`, `BiomeTile { x; z; values: Uint8Array }`, `DensityBrick { x; y; z; values: Int8Array }`, `TerrainLayers { height?: { tiles: HeightTile[] }; biome?: { tiles: BiomeTile[] }; density?: { bricks: DensityBrick[] } }`, `LayerValues`, `LayerLimits { sizeX; sizeZ; height; biomeCount }`.
  - Constants `TILE = 64`, `BIOME_CELL = 4`, `BIOME_TILE = 16`, `HEIGHT_SCALE = 16`, `BRICK_SAMPLES = 8`, `BRICK_SPACING = 2`, `BRICK_SPAN = 16`, `DENSITY_SCALE = 8`, `HEIGHT_VALUES = 4096`, `BIOME_VALUES = 256`, `BRICK_VALUES = 512`.
  - `tileKey(x, z): number`, `brickKey(x, y, z): number`, `encodeValues(values): string`, `decodeValues(kind: 'i16' | 'u8' | 'i8', data, n): LayerValues`, `layersToJSON(l): TerrainLayersJSON`, `checkLayers(c, path, v, limits): TerrainLayers`, `toTerrainJSON(doc)`.
  - `HeightLayer`, `BiomeLayer`, `DensityLayer` with `empty`, `at`/`sample`, `set(…, values | null)`; `DensityLayer.touches`; `compileLayers(l): CompiledLayers`.
  - `CompiledTerrain.heightLayer`, `.biomeLayer` and `.densityLayer` are now never null.

- [ ] **Step 1: Write the failing layer tests**

Replace `packages/terrain/test/layers.test.ts` with:

```ts
import { describe, expect, it } from 'vitest'
import { Check } from '../src/doc/check.ts'
import { BiomeLayer, DensityLayer, HeightLayer } from '../src/layers/layers.ts'
import { BIOME_VALUES, BRICK_VALUES, HEIGHT_VALUES, checkLayers, decodeValues, encodeValues, layersToJSON } from '../src/layers/tiles.ts'

const limits = { sizeX: 128, sizeZ: 128, height: 64, biomeCount: 2 }
function filled<T extends Int16Array | Uint8Array | Int8Array>(a: T, at: number, v: number): T {
  a[at] = v
  return a
}

describe('encodeValues / decodeValues', () => {
  it('round-trips Int16 (little-endian, negatives included), Uint8 and Int8', () => {
    const i16 = Int16Array.from([0, -1, 300, -32768, 32767])
    expect(decodeValues('i16', encodeValues(i16), 5)).toEqual(i16)
    const u8 = Uint8Array.from([0, 1, 255])
    expect(decodeValues('u8', encodeValues(u8), 3)).toEqual(u8)
    const i8 = Int8Array.from([-128, 0, 127])
    expect(decodeValues('i8', encodeValues(i8), 3)).toEqual(i8)
  })

  it('rejects data holding another number of values', () => {
    expect(() => decodeValues('u8', 'AAAA', 9)).toThrow('holds 3 values, expected 9')
    expect(() => decodeValues('i16', 'AAAAAA==', 4096)).toThrow('holds 2 values, expected 4096')
  })
})

describe('HeightLayer', () => {
  it('reads the delta in blocks (1/16 units) per column; 0 where unpainted', () => {
    const layer = new HeightLayer([{ x: 1, z: 0, values: filled(new Int16Array(HEIGHT_VALUES), 5 + 7 * 64, -24) }])
    expect(layer.at(64 + 5, 7)).toBe(-1.5)
    expect(layer.at(64 + 6, 7)).toBe(0)
    expect(layer.at(5, 7)).toBe(0)
  })

  it('replaces and removes tiles', () => {
    const layer = new HeightLayer()
    expect(layer.empty).toBe(true)
    layer.set(0, 0, filled(new Int16Array(HEIGHT_VALUES), 0, 16))
    expect(layer.at(0, 0)).toBe(1)
    layer.set(0, 0, new Int16Array(HEIGHT_VALUES)) // all zeros removes it
    expect(layer.empty).toBe(true)
  })
})

describe('BiomeLayer', () => {
  it('reads 4 × 4-column cells, -1 where unpainted', () => {
    const layer = new BiomeLayer([{ x: 0, z: 1, values: filled(new Uint8Array(BIOME_VALUES), 2 + 1 * 16, 3) }])
    expect(layer.at(8, 64 + 4)).toBe(2)
    expect(layer.at(11, 64 + 7)).toBe(2)
    expect(layer.at(12, 64 + 7)).toBe(-1)
    expect(layer.at(8, 4)).toBe(-1)
  })
})

describe('DensityLayer', () => {
  // sample (1, 1, 1) of brick (1, 0, 0) = block (18, 2, 2): +10 blocks
  const layer = new DensityLayer([{ x: 1, y: 0, z: 0, values: filled(new Int8Array(BRICK_VALUES), 1 + 1 * 8 + 1 * 64, 80) }])

  it('samples exactly on grid points and interpolates between them', () => {
    expect(layer.sample(18, 2, 2)).toBe(10)
    expect(layer.sample(19, 2, 2)).toBe(5)
    expect(layer.sample(17, 3, 2)).toBe(2.5)
    expect(layer.sample(100, 2, 2)).toBe(0)
    expect(layer.sample(0, 0, 0)).toBe(0)
  })

  it('reads 0 for samples at negative coordinates instead of colliding with another brick', () => {
    // Brick (-1, 1, 0) has key -1 + 1024 = 1023, the key of brick (1023, 0, 0).
    const far = new DensityLayer([{ x: 1023, y: 0, z: 0, values: new Int8Array(BRICK_VALUES).fill(80) }])
    expect(far.sample(-1, 20, 1)).toBe(0)
  })

  it('knows which columns it can touch, and follows replaced bricks', () => {
    expect(layer.touches(0, 0, 13, 40)).toBe(false)
    expect(layer.touches(0, 0, 14, 40)).toBe(true)
    expect(layer.touches(33, 0, 40, 40)).toBe(false)
    const l2 = new DensityLayer()
    expect(l2.empty).toBe(true)
    l2.set(2, 0, 0, filled(new Int8Array(BRICK_VALUES), 0, 8))
    expect(l2.touches(33, 0, 40, 40)).toBe(true)
    l2.set(2, 0, 0, null)
    expect(l2.touches(33, 0, 40, 40)).toBe(false)
  })
})

describe('checkLayers', () => {
  const tile = (v: number) => filled(new Int16Array(HEIGHT_VALUES), 0, v)
  function run(v: unknown) {
    const c = new Check()
    const out = checkLayers(c, 'layers', v, limits)
    return { errors: c.errors, out }
  }

  it('reads base64 tiles and decoded tiles alike: sorted by z then x, all-zero tiles dropped', () => {
    const a = tile(16), b = tile(-8), zero = new Int16Array(HEIGHT_VALUES)
    const json = run({ height: { tiles: [{ x: 1, z: 1, data: encodeValues(b) }, { x: 0, z: 1, data: encodeValues(a) }, { x: 1, z: 0, data: encodeValues(zero) }] } })
    const decoded = run({ height: { tiles: [{ x: 1, z: 1, values: b }, { x: 0, z: 1, values: a }, { x: 1, z: 0, values: zero }] } })
    expect(json.errors).toEqual([])
    expect(json.out).toEqual({ height: { tiles: [{ x: 0, z: 1, values: a }, { x: 1, z: 1, values: b }] } })
    expect(decoded.out).toEqual(json.out)
  })

  it('reports bad tiles with their paths', () => {
    const { errors } = run({
      height: { tiles: [{ x: 2, z: 0, data: encodeValues(tile(1)) }, { x: 0, z: 0, data: 'AAAAAA==' }, { x: 0, z: 1, values: new Uint8Array(4) }] },
      density: { bricks: [{ x: 0, y: 4, z: 0, data: encodeValues(new Int8Array(BRICK_VALUES)) }] },
      paint: {},
    })
    expect(errors).toEqual([
      'layers.paint: unknown layer (known: height, biome, density)',
      'layers.height.tiles[0].x: must be <= 1',
      'layers.height.tiles[1].data: holds 2 values, expected 4096',
      'layers.height.tiles[2].values: must be an Int16Array of 4096 values',
      'layers.density.bricks[0].y: must be <= 3',
    ])
  })

  it('rejects a duplicate tile', () => {
    expect(run({ height: { tiles: [{ x: 0, z: 0, values: tile(1) }, { x: 0, z: 0, values: tile(2) }] } }).errors)
      .toEqual(['layers.height.tiles[1]: duplicate tile (0, 0)'])
  })

  it('rejects the old full-raster format with a message that says so', () => {
    expect(run({ height: { width: 128, height: 128, type: 'i16', data: '' } }).errors)
      .toEqual(['layers.height: is a full raster (the old format); layers are now sparse: { tiles: [{ x, z, data }] }'])
  })

  it('rejects a biome value past the biome count', () => {
    const v = filled(new Uint8Array(BIOME_VALUES), 2 + 3 * 16, 3) // 2 biomes: 1..2 are valid
    expect(run({ biome: { tiles: [{ x: 0, z: 0, values: v }] } }).errors)
      .toEqual(['layers.biome.tiles[0]: value 3 at cell (2, 3) exceeds the 2 biomes'])
    v[2 + 3 * 16] = 2
    expect(run({ biome: { tiles: [{ x: 0, z: 0, values: v }] } }).errors).toEqual([])
  })

  it('accepts missing layers', () => {
    expect(run({})).toEqual({ errors: [], out: {} })
    expect(run(undefined)).toEqual({ errors: [], out: {} })
  })

  it('round-trips through layersToJSON', () => {
    const out = run({
      height: { tiles: [{ x: 0, z: 0, values: tile(-5) }] },
      biome: { tiles: [{ x: 1, z: 1, values: filled(new Uint8Array(BIOME_VALUES), 7, 2) }] },
      density: { bricks: [{ x: 1, y: 2, z: 3, values: filled(new Int8Array(BRICK_VALUES), 9, -100) }] },
    }).out
    expect(run(JSON.parse(JSON.stringify(layersToJSON(out)))).out).toEqual(out)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/terrain -- layers`
Expected: FAIL (cannot resolve `../src/layers/layers.ts` and `../src/layers/tiles.ts`).

- [ ] **Step 3: Replace the layer types**

In `packages/terrain/src/doc/types.ts`, replace everything from `/** A 2D raster stored as little-endian bytes in base64. */` through the closing brace of `interface TerrainLayers` with:

```ts
/** A tile of a 2D layer in the file. x and z count tiles; data holds the values as little-endian base64. */
export interface TileRef { x: number; z: number; data: string }
/** An 8³ brick of density samples in the file. x, y and z count bricks. */
export interface BrickRef { x: number; y: number; z: number; data: string }

/** The layers as a .terrain.json file stores them: only painted tiles. */
export interface TerrainLayersJSON {
  height?: { tiles: TileRef[] }
  biome?: { tiles: TileRef[] }
  density?: { bricks: BrickRef[] }
}

/** 64 × 64 columns of height delta in 1/16 block; index lx + lz * 64. */
export interface HeightTile { x: number; z: number; values: Int16Array }
/** 16 × 16 biome cells of 4 × 4 columns (0 = unpainted, k = biomes[k - 1]); index cx + cz * 16. */
export interface BiomeTile { x: number; z: number; values: Uint8Array }
/** 8³ density samples 2 blocks apart, in 1/8 block; index lx + lz * 8 + ly * 64. */
export interface DensityBrick { x: number; y: number; z: number; values: Int8Array }

/**
 * The decoded brush layers. Lists are sorted (tiles by z then x; bricks by y, z, x), hold no all-zero
 * tile, and are absent when empty. A tile is never mutated once it is in a document: edits replace
 * it, so documents share the tiles they have in common.
 */
export interface TerrainLayers {
  /** Added to the height after every height op. */
  height?: { tiles: HeightTile[] }
  /** Overrides the biome rule and biome ops. */
  biome?: { tiles: BiomeTile[] }
  /** Added to the density after every volume op. */
  density?: { bricks: DensityBrick[] }
}
```

- [ ] **Step 4: Write the tile module**

Create `packages/terrain/src/layers/tiles.ts`:

```ts
import { base64ToBytes, bytesToBase64 } from '../doc/base64.ts'
import type { Check } from '../doc/check.ts'
import type { TerrainLayers, TerrainLayersJSON } from '../doc/types.ts'

/** Columns per side of a height or biome tile. */
export const TILE = 64
/** Columns per side of a biome cell. */
export const BIOME_CELL = 4
/** Biome cells per side of a tile. */
export const BIOME_TILE = TILE / BIOME_CELL
/** Height layer units per block. */
export const HEIGHT_SCALE = 16
/** Samples per brick side; samples are BRICK_SPACING blocks apart, so a brick spans BRICK_SPAN blocks. */
export const BRICK_SAMPLES = 8
export const BRICK_SPACING = 2
export const BRICK_SPAN = BRICK_SAMPLES * BRICK_SPACING
/** Density layer units per block. */
export const DENSITY_SCALE = 8

export const HEIGHT_VALUES = TILE * TILE
export const BIOME_VALUES = BIOME_TILE * BIOME_TILE
export const BRICK_VALUES = BRICK_SAMPLES ** 3

export type LayerValues = Int16Array | Uint8Array | Int8Array
type Kind = 'i16' | 'u8' | 'i8'

/** What layers are checked against. */
export interface LayerLimits {
  /** World size in blocks. */
  sizeX: number
  sizeZ: number
  height: number
  biomeCount: number
}

/** Key of a tile (x, z < 65536). */
export function tileKey(x: number, z: number): number { return x + z * 65536 }
/** Key of a brick (each coordinate in 0..1023). */
export function brickKey(x: number, y: number, z: number): number { return x + y * 1024 + z * 1048576 }

/** The values as little-endian base64. */
export function encodeValues(values: LayerValues): string {
  if (!(values instanceof Int16Array)) return bytesToBase64(new Uint8Array(values.buffer, values.byteOffset, values.length))
  const bytes = new Uint8Array(values.length * 2)
  const dv = new DataView(bytes.buffer)
  for (let i = 0; i < values.length; i++) dv.setInt16(i * 2, values[i]!, true)
  return bytesToBase64(bytes)
}

/** Decodes `n` values. Throws a RangeError when the data holds another count, and an Error on bad base64. */
export function decodeValues(kind: Kind, data: string, n: number): LayerValues {
  const bytes = base64ToBytes(data)
  const width = kind === 'i16' ? 2 : 1
  if (bytes.length !== n * width) throw new RangeError(`holds ${bytes.length / width} values, expected ${n}`)
  if (kind === 'u8') return bytes
  if (kind === 'i8') return new Int8Array(bytes.buffer, bytes.byteOffset, n)
  const out = new Int16Array(n)
  const dv = new DataView(bytes.buffer, bytes.byteOffset)
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true)
  return out
}

/** The layers as the file stores them. */
export function layersToJSON(l: TerrainLayers): TerrainLayersJSON {
  const out: TerrainLayersJSON = {}
  if (l.height) out.height = { tiles: l.height.tiles.map((t) => ({ x: t.x, z: t.z, data: encodeValues(t.values) })) }
  if (l.biome) out.biome = { tiles: l.biome.tiles.map((t) => ({ x: t.x, z: t.z, data: encodeValues(t.values) })) }
  if (l.density) out.density = { bricks: l.density.bricks.map((b) => ({ x: b.x, y: b.y, z: b.z, data: encodeValues(b.values) })) }
  return out
}

const CTORS: Record<Kind, new (n: number) => LayerValues> = { i16: Int16Array, u8: Uint8Array, i8: Int8Array }
const NAMES: Record<Kind, string> = { i16: 'an Int16Array', u8: 'a Uint8Array', i8: 'an Int8Array' }

interface Entry { x: number; y: number; z: number; values: LayerValues; path: string }

/**
 * Validates layers given either as the file stores them (base64 `data`) or decoded (`values`), and
 * returns them decoded: sorted, all-zero tiles dropped, empty lists removed. Errors go to `c`.
 */
export function checkLayers(c: Check, path: string, v: unknown, o: LayerLimits): TerrainLayers {
  const out: TerrainLayers = {}
  if (!c.obj(path, v, true)) return out
  for (const k of Object.keys(v)) {
    if (k !== 'height' && k !== 'biome' && k !== 'density') c.fail(`${path}.${k}`, 'unknown layer (known: height, biome, density)')
  }
  const tx = Math.ceil(o.sizeX / TILE), tz = Math.ceil(o.sizeZ / TILE)
  const height = checkList(c, `${path}.height`, v.height, 'tiles', 'i16', HEIGHT_VALUES, [tx, tz])
  if (height) out.height = { tiles: height.map((e) => ({ x: e.x, z: e.z, values: e.values as Int16Array })) }
  const biome = checkList(c, `${path}.biome`, v.biome, 'tiles', 'u8', BIOME_VALUES, [tx, tz])
  if (biome) {
    const before = c.errors.length
    for (const e of biome) {
      const i = e.values.findIndex((b) => b > o.biomeCount)
      if (i >= 0) c.fail(e.path, `value ${e.values[i]} at cell (${i % BIOME_TILE}, ${Math.floor(i / BIOME_TILE)}) exceeds the ${o.biomeCount} biomes`)
    }
    if (c.errors.length === before) out.biome = { tiles: biome.map((e) => ({ x: e.x, z: e.z, values: e.values as Uint8Array })) }
  }
  const bricks = [Math.ceil(o.sizeX / BRICK_SPAN), Math.ceil(o.height / BRICK_SPAN), Math.ceil(o.sizeZ / BRICK_SPAN)]
  const density = checkList(c, `${path}.density`, v.density, 'bricks', 'i8', BRICK_VALUES, bricks)
  if (density) out.density = { bricks: density.map((e) => ({ x: e.x, y: e.y, z: e.z, values: e.values as Int8Array })) }
  return out
}

/** One layer's list; null when absent, invalid, or empty once all-zero tiles are dropped. */
function checkList(c: Check, path: string, v: unknown, listKey: 'tiles' | 'bricks', kind: Kind, n: number, limits: number[]): Entry[] | null {
  if (!c.obj(path, v, true)) return null
  const brick = listKey === 'bricks'
  if ('type' in v || 'width' in v) {
    c.fail(path, `is a full raster (the old format); layers are now sparse: { ${listKey}: [{ x, ${brick ? 'y, ' : ''}z, data }] }`)
    return null
  }
  const list = v[listKey]
  if (!c.arr(`${path}.${listKey}`, list)) return null
  const axes = brick ? (['x', 'y', 'z'] as const) : (['x', 'z'] as const)
  const before = c.errors.length
  const seen = new Set<number>()
  const out: Entry[] = []
  list.forEach((t, i) => {
    const p = `${path}.${listKey}[${i}]`
    if (!c.obj(p, t)) return
    let ok = true
    axes.forEach((a, j) => { if (!c.num(`${p}.${a}`, t[a], { int: true, min: 0, max: limits[j]! - 1 })) ok = false })
    const values = valuesOf(c, p, t, kind, n)
    if (!ok || !values) return
    const x = t.x as number, z = t.z as number, y = brick ? (t.y as number) : 0
    const key = brick ? brickKey(x, y, z) : tileKey(x, z)
    if (seen.has(key)) { c.fail(p, `duplicate ${brick ? 'brick' : 'tile'} (${brick ? `${x}, ${y}, ${z}` : `${x}, ${z}`})`); return }
    seen.add(key)
    if (values.some((s) => s !== 0)) out.push({ x, y, z, values, path: p })
  })
  if (c.errors.length > before || out.length === 0) return null
  out.sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)
  return out
}

function valuesOf(c: Check, p: string, t: Record<string, unknown>, kind: Kind, n: number): LayerValues | null {
  if (t.values !== undefined) {
    if (t.values instanceof CTORS[kind] && t.values.length === n) return t.values
    c.fail(`${p}.values`, `must be ${NAMES[kind]} of ${n} values`)
    return null
  }
  if (typeof t.data !== 'string') { c.fail(`${p}.data`, t.data === undefined ? 'is required' : 'must be a base64 string'); return null }
  try {
    return decodeValues(kind, t.data, n)
  } catch (e) {
    c.fail(`${p}.data`, e instanceof RangeError ? e.message : 'must be a base64 string')
    return null
  }
}
```

- [ ] **Step 5: Write the runtime layers**

Create `packages/terrain/src/layers/layers.ts`:

```ts
import type { BiomeTile, DensityBrick, HeightTile, TerrainLayers } from '../doc/types.ts'
import { BIOME_TILE, BRICK_SAMPLES, BRICK_SPACING, BRICK_SPAN, DENSITY_SCALE, HEIGHT_SCALE, TILE, brickKey, tileKey } from './tiles.ts'

const anyNonZero = (v: ArrayLike<number>) => { for (let i = 0; i < v.length; i++) if (v[i] !== 0) return true; return false }

/** Height delta per column, added after every height op. Tiles can be replaced (engine.terrain.patch). */
export class HeightLayer {
  private readonly tiles = new Map<number, Int16Array>()
  constructor(tiles: readonly HeightTile[] = []) { for (const t of tiles) this.set(t.x, t.z, t.values) }
  get empty(): boolean { return this.tiles.size === 0 }
  /** Height delta in blocks at a column inside the world; 0 where unpainted. */
  at(x: number, z: number): number {
    const t = this.tiles.get(tileKey(Math.floor(x / TILE), Math.floor(z / TILE)))
    return t ? t[(x & (TILE - 1)) + (z & (TILE - 1)) * TILE]! / HEIGHT_SCALE : 0
  }
  /** Replaces a tile; null or all zeros removes it. */
  set(x: number, z: number, values: Int16Array | null): void {
    if (values && anyNonZero(values)) this.tiles.set(tileKey(x, z), values)
    else this.tiles.delete(tileKey(x, z))
  }
}

/** Biome index per 4 × 4 columns, or -1 where unpainted. */
export class BiomeLayer {
  private readonly tiles = new Map<number, Uint8Array>()
  constructor(tiles: readonly BiomeTile[] = []) { for (const t of tiles) this.set(t.x, t.z, t.values) }
  get empty(): boolean { return this.tiles.size === 0 }
  at(x: number, z: number): number {
    const t = this.tiles.get(tileKey(Math.floor(x / TILE), Math.floor(z / TILE)))
    if (!t) return -1
    const cx = (x & (TILE - 1)) >> 2, cz = (z & (TILE - 1)) >> 2
    return t[cx + cz * BIOME_TILE]! - 1
  }
  set(x: number, z: number, values: Uint8Array | null): void {
    if (values && anyNonZero(values)) this.tiles.set(tileKey(x, z), values)
    else this.tiles.delete(tileKey(x, z))
  }
}

interface Bounds { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }

/** Sparse density sculpt: trilinear over a global 2-block sample grid; missing samples are 0. */
export class DensityLayer {
  private readonly bricks = new Map<number, { x: number; y: number; z: number; values: Int8Array }>()
  private boundsCache: Bounds[] | null = null
  constructor(bricks: readonly DensityBrick[] = []) { for (const b of bricks) this.set(b.x, b.y, b.z, b.values) }

  get empty(): boolean { return this.bricks.size === 0 }

  set(x: number, y: number, z: number, values: Int8Array | null): void {
    if (values && anyNonZero(values)) this.bricks.set(brickKey(x, y, z), { x, y, z, values })
    else this.bricks.delete(brickKey(x, y, z))
    this.boundsCache = null
  }

  /** Block-space bounds of every brick, padded by one sample spacing for the trilinear reach. */
  get bounds(): readonly Bounds[] {
    if (!this.boundsCache) {
      this.boundsCache = [...this.bricks.values()].map((b) => ({
        x0: b.x * BRICK_SPAN - BRICK_SPACING, y0: b.y * BRICK_SPAN - BRICK_SPACING, z0: b.z * BRICK_SPAN - BRICK_SPACING,
        x1: (b.x + 1) * BRICK_SPAN, y1: (b.y + 1) * BRICK_SPAN, z1: (b.z + 1) * BRICK_SPAN,
      }))
    }
    return this.boundsCache
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
    if (sx < 0 || sy < 0 || sz < 0) return 0 // keys of negative bricks would collide with real ones
    const b = this.bricks.get(brickKey(Math.floor(sx / BRICK_SAMPLES), Math.floor(sy / BRICK_SAMPLES), Math.floor(sz / BRICK_SAMPLES)))
    if (!b) return 0
    const lx = sx & (BRICK_SAMPLES - 1), ly = sy & (BRICK_SAMPLES - 1), lz = sz & (BRICK_SAMPLES - 1)
    return b.values[lx + lz * BRICK_SAMPLES + ly * BRICK_SAMPLES * BRICK_SAMPLES]!
  }
}

export interface CompiledLayers { heightLayer: HeightLayer; biomeLayer: BiomeLayer; densityLayer: DensityLayer }

export function compileLayers(l: TerrainLayers): CompiledLayers {
  return { heightLayer: new HeightLayer(l.height?.tiles), biomeLayer: new BiomeLayer(l.biome?.tiles), densityLayer: new DensityLayer(l.density?.bricks) }
}
```

- [ ] **Step 6: Write `toTerrainJSON`**

Create `packages/terrain/src/doc/json.ts`:

```ts
import { layersToJSON } from '../layers/tiles.ts'
import type { TerrainDoc, TerrainLayersJSON } from './types.ts'

/** The document as a .terrain.json file stores it (layers as base64 tiles). JSON.stringify it to save. */
export function toTerrainJSON(doc: TerrainDoc): Omit<TerrainDoc, 'layers'> & { layers: TerrainLayersJSON } {
  return { ...doc, layers: layersToJSON(doc.layers) }
}
```

- [ ] **Step 7: Use the new layers in validation, compile and the pipeline**

In `packages/terrain/src/doc/validate.ts`:
- Change the import `import { checkLayers } from '../layers/raster.ts'` to `import { checkLayers } from '../layers/tiles.ts'`.
- Replace the two lines

```ts
  const size = Array.isArray(d.size) ? d.size : null
  if (size && size.length === 2) checkLayers(c, 'layers', d.layers, Number(size[0]), Number(size[1]), biomeNames.length)
```

with

```ts
  const size = Array.isArray(d.size) ? d.size : null
  const layers = size && size.length === 2
    ? checkLayers(c, 'layers', d.layers, { sizeX: Number(size[0]), sizeZ: Number(size[1]), height, biomeCount: biomeNames.length })
    : {}
```

- In the returned document, replace `layers: (d.layers ?? {}) as TerrainDoc['layers'],` with `layers,`.

In `packages/terrain/src/pipeline/compile.ts`:
- Replace `import { BiomeLayer, DensityLayer, HeightLayer } from '../layers/raster.ts'` with `import { compileLayers, type BiomeLayer, type DensityLayer, type HeightLayer } from '../layers/layers.ts'`.
- In `interface CompiledTerrain`, make the three layer fields non-null:

```ts
  readonly heightLayer: HeightLayer
  readonly biomeLayer: BiomeLayer
  readonly densityLayer: DensityLayer
```

- In `compileTerrain`'s return, replace the three `heightLayer: …`, `biomeLayer: …`, `densityLayer: …` lines with `...compileLayers(doc.layers),`.

In `packages/terrain/src/pipeline/cells.ts`, in `fillCells`, replace

```ts
  const top = new Int32Array(n)
  const biome = new Int32Array(n)
  const maxTop = t.height - 2
```

with

```ts
  const top = new Int32Array(n)
  const biome = new Int32Array(n)
  const maxTop = t.height - 2
  const heightLayer = t.heightLayer.empty ? null : t.heightLayer
  const biomeLayer = t.biomeLayer.empty ? null : t.biomeLayer
```

and in the loop below it replace the two layer reads with

```ts
    const hh = h[i]! + (inWorld && heightLayer ? heightLayer.at(x, z) : 0)
```

and

```ts
    const painted = inWorld && biomeLayer ? biomeLayer.at(x, z) : -1
```

In `packages/terrain/src/pipeline/volume.ts`:
- In the constructor, replace `this.useLayer = t.densityLayer !== null && t.densityLayer.touches(x0, z0, x0 + w - 1, z0 + d - 1)` with `this.useLayer = !t.densityLayer.empty && t.densityLayer.touches(x0, z0, x0 + w - 1, z0 + d - 1)`.
- In `column`, replace `const layer = this.t.densityLayer!` with `const layer = this.t.densityLayer`.

Delete `packages/terrain/src/layers/raster.ts`.

- [ ] **Step 8: Update the exports**

In `packages/terrain/src/index.ts`:
- In the `export type { … } from './doc/types.ts'` list, replace `BrickRef, BrickSetRef,` with `BiomeTile, BrickRef, DensityBrick, HeightTile,` and replace `RasterRef,` with `TerrainLayersJSON, TileRef,`.
- Replace `export { encodeBrick, encodeRaster, decodeRaster } from './layers/raster.ts'` with:

```ts
export {
  BIOME_CELL, BIOME_TILE, BIOME_VALUES, BRICK_SAMPLES, BRICK_SPACING, BRICK_SPAN, BRICK_VALUES, DENSITY_SCALE, HEIGHT_SCALE, HEIGHT_VALUES, TILE,
  brickKey, checkLayers, decodeValues, encodeValues, layersToJSON, tileKey,
  type LayerLimits, type LayerValues,
} from './layers/tiles.ts'
export { BiomeLayer, DensityLayer, HeightLayer, compileLayers, type CompiledLayers } from './layers/layers.ts'
export { toTerrainJSON } from './doc/json.ts'
```

- [ ] **Step 9: Move the other layer tests to tiles**

In `packages/terrain/test/validate.test.ts`:
- Replace `import { encodeRaster } from '../src/layers/raster.ts'` with `import { encodeValues } from '../src/layers/tiles.ts'` and add `import { toTerrainJSON } from '../src/doc/json.ts'`.
- Replace the test `it('validates layers against the document size', …)` with:

```ts
  it('validates layers against the document size', () => {
    const doc = { ...minimalDoc(), layers: { height: { tiles: [{ x: 1, z: 0, data: encodeValues(new Int16Array(4096).fill(1)) }] } } }
    expect(errorsOf(doc)).toEqual(['layers.height.tiles[0].x: must be <= 0'])
  })

  it('toTerrainJSON writes the layers back as base64 that validates to the same document', () => {
    const raw = { ...minimalDoc(), layers: { biome: { tiles: [{ x: 0, z: 0, data: encodeValues(new Uint8Array(256).fill(2)) }] } } }
    const r = validateTerrainDoc(raw, { ops })
    if (!r.ok) throw new Error(r.errors.join('\n'))
    const again = validateTerrainDoc(JSON.parse(JSON.stringify(toTerrainJSON(r.doc))), { ops })
    expect(again.ok && again.doc).toEqual(r.doc)
  })
```

In `packages/terrain/test/generator.test.ts`:
- Replace `import { encodeRaster } from '../src/layers/raster.ts'` with `import { encodeValues } from '../src/layers/tiles.ts'`.
- Replace the body of `it('round-trips a document with layers through JSON', …)` with:

```ts
    const height = new Int16Array(64 * 64).fill(48) // +3 blocks
    const doc = { ...minimalDoc(), layers: { height: { tiles: [{ x: 0, z: 0, data: encodeValues(height) }] } } }
    const s = sim()
    s.configure(terrainGenerator, JSON.parse(JSON.stringify(doc)))
    s.generate(terrainGenerator)
    expect(s.store.getVoxel(10, 22, 10)).toBe(s.registry.id('grass'))
```

In `packages/terrain/test/pipeline.test.ts`, add `import { HEIGHT_VALUES } from '../src/layers/tiles.ts'` and, inside `describe('generateRegion: height, water and surface', …)`, add:

```ts
  it('adds the height layer in 1/16 block before rounding the ground', () => {
    const values = new Int16Array(HEIGHT_VALUES).fill(8) // +0.5 block: 20.5 rounds to 21
    const get = region(compileDoc({ ...minimalDoc(), layers: { height: { tiles: [{ x: 0, z: 0, values }] } } }), 0, 0)
    expect(get(5, 20, 5)).toBe(IDS.grass)
    expect(get(5, 21, 5)).toBe(0)
  })
```

- [ ] **Step 10: Run the terrain tests and typecheck**

Run: `npm test -w @elovox/terrain`
Expected: PASS (all files, including `layers`, `validate`, `generator`, `pipeline`).

Run: `npm run typecheck -w @elovox/terrain`
Expected: no errors. If anything else in the repo imported `encodeRaster`, `encodeBrick`, `decodeRaster`, `RasterRef` or `BrickSetRef`, the typecheck names it; move it to the tile API the same way.

Run: `npm test -w @elovox/sandbox -- terrainDocs`
Expected: PASS (the golden hashes are unchanged).

- [ ] **Step 11: Commit**

```bash
git add packages/terrain
git commit -m "feat(terrain): sparse tiled brush layers, decoded in memory, height in 1/16 block"
```

---

### Task 2: Density clamp and samplers

**Files:**
- Modify: `packages/terrain/src/pipeline/volume.ts`, `packages/terrain/src/pipeline/cells.ts`, `packages/terrain/src/index.ts`
- Create: `packages/terrain/src/pipeline/sample.ts`
- Test: `packages/terrain/test/sample.test.ts`

**Interfaces:**
- Consumes: `CompiledTerrain`, `compileLayers`, `fillCells`, `VolumeField` (Task 1 state).
- Produces (exported from `@elovox/terrain`):
  - `DENSITY_CLAMP = 4`; `VolumeField.densities(x, z, top, out: Float64Array): void`.
  - `fillHeights(t, x0, z0, w, d): HeightGrid` (internal to the package; not exported).
  - `sampleHeights(t, x0, z0, w, d): Float64Array` — height before the layer, index `(x - x0) + (z - z0) * w`.
  - `interface SampleGrid { x0; y0; z0; nx; ny; nz; step }`; `sampleDensity(t, g): Float32Array` — index `i + k * nx + j * nx * nz`.
  - `withLayers(t, layers): CompiledTerrain`.

- [ ] **Step 1: Write the failing tests**

Create `packages/terrain/test/sample.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { validateTerrainDoc } from '../src/doc/validate.ts'
import { BRICK_VALUES, HEIGHT_VALUES } from '../src/layers/tiles.ts'
import { fillCells } from '../src/pipeline/cells.ts'
import { compileTerrain, type CompiledTerrain } from '../src/pipeline/compile.ts'
import { generateRegion } from '../src/pipeline/region.ts'
import { sampleDensity, sampleHeights, withLayers } from '../src/pipeline/sample.ts'
import { IDS, idOf, minimalDoc } from './fixtures.ts'

const H = 64
const WATER = IDS.water! | (7 << 12)

function compileDoc(json: unknown): CompiledTerrain {
  const r = validateTerrainDoc(json, { worldHeight: H })
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return compileTerrain(r.doc, { seed: 99, height: H, id: idOf })
}
function region(t: CompiledTerrain): (x: number, y: number, z: number) => number {
  const out = new Uint16Array(64 * 64 * H)
  generateRegion(t, 0, 0, 64, 64, out, { features: false })
  return (x, y, z) => out[x + z * 64 + y * 64 * 64]!
}

describe('density clamp', () => {
  it('lets a brush change solidity by the same amount at any depth', () => {
    const deep = new Int8Array(BRICK_VALUES)
    deep[2 + 2 * 8 + 5 * 64] = -40 // block (4, 10, 4): 50 below the ground, -5 blocks
    const surface = new Int8Array(BRICK_VALUES)
    surface[2 + 2 * 8 + 5 * 64] = -40 // block (4, 58, 4): just under the ground
    surface[2 + 2 * 8 + 7 * 64] = 40 // block (4, 62, 4): in the air above it, +5 blocks
    const t = compileDoc({
      ...minimalDoc(), base: { height: 60, amplitude: 0, noise: { scale: 32 } },
      layers: { density: { bricks: [{ x: 0, y: 0, z: 0, values: deep }, { x: 0, y: 3, z: 0, values: surface }] } },
    })
    const get = region(t)
    expect(get(4, 10, 4)).toBe(0)
    expect(get(4, 58, 4)).toBe(0)
    expect(get(4, 62, 4)).not.toBe(0)
    expect(get(4, 30, 4)).toBe(IDS.stone)
    expect(get(10, 10, 10)).toBe(IDS.stone)
  })
})

describe('sampleHeights', () => {
  it('is the ground before the height layer', () => {
    const t = compileDoc({
      ...minimalDoc(),
      ops: [{ id: 'h', type: 'hills', shape: { kind: 'circle', center: [32, 32], radius: 20 }, params: { amplitude: 10 } }],
      layers: { height: { tiles: [{ x: 0, z: 0, values: new Int16Array(HEIGHT_VALUES).fill(32) }] } }, // +2 blocks
    })
    const h = sampleHeights(t, 20, 20, 8, 8)
    const cells = fillCells(t, 20, 20, 8, 8)
    for (let i = 0; i < 64; i++) expect(cells.top[i]).toBe(Math.min(H - 2, Math.max(1, Math.round(h[i]! + 2))))
  })
})

describe('sampleDensity', () => {
  it('is positive exactly where the pipeline puts solid voxels', () => {
    const values = new Int8Array(BRICK_VALUES).fill(-24) // -3 blocks over the whole brick
    const t = compileDoc({
      ...minimalDoc(),
      ops: [{ id: 'b', type: 'blob', shape: { kind: 'circle', center: [20, 20], radius: 6 }, params: { y: 30, height: 5 } }],
      layers: { density: { bricks: [{ x: 1, y: 1, z: 1, values }] } },
    })
    const d = sampleDensity(t, { x0: 4, y0: 4, z0: 4, nx: 16, ny: 20, nz: 16, step: 2 })
    const get = region(t)
    for (let j = 0; j < 20; j++) for (let k = 0; k < 16; k++) for (let i = 0; i < 16; i++) {
      const v = get(4 + i * 2, 4 + j * 2, 4 + k * 2)
      expect(d[i + k * 16 + j * 256]! > 0).toBe(v !== 0 && v !== WATER)
    }
  })

  it('reads the nearest y inside the world for points outside it', () => {
    const t = compileDoc(minimalDoc())
    const d = sampleDensity(t, { x0: 0, y0: -4, z0: 0, nx: 1, ny: 2, nz: 1, step: 4 }) // y -4 and 0
    expect(d[0]).toBe(d[1])
  })
})

describe('withLayers', () => {
  it('swaps the layers and keeps everything else', () => {
    const t = compileDoc(minimalDoc())
    const values = new Int16Array(HEIGHT_VALUES).fill(16)
    const u = withLayers(t, { height: { tiles: [{ x: 0, z: 0, values }] } })
    expect(u.heightLayer.at(3, 3)).toBe(1)
    expect(t.heightLayer.empty).toBe(true)
    expect(u.heightOps).toBe(t.heightOps)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/terrain -- sample`
Expected: FAIL (cannot resolve `../src/pipeline/sample.ts`).

- [ ] **Step 3: Clamp the density and expose per-column densities**

In `packages/terrain/src/pipeline/volume.ts`, after `export const LATTICE = 4`, add:

```ts
/**
 * The height field and volume ops are clamped to ±DENSITY_CLAMP blocks before the density layer is
 * added, so a brush stroke changes solidity by the same amount at any depth. Clamping keeps the sign,
 * so without a layer the voxels are unchanged.
 */
export const DENSITY_CLAMP = 4
```

Replace the whole `column` method with these two methods:

```ts
  /**
   * The density at every y of the column at (x, z) whose ground height is `top`: the height field and
   * volume ops clamped to ±DENSITY_CLAMP, plus the density layer. Solid means > 0.
   */
  densities(x: number, z: number, top: number, out: Float64Array): void {
    const H = this.height
    for (let y = 0; y < H; y++) out[y] = top - y - 0.5
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
        out[y] = add ? Math.max(out[y]!, s) : Math.min(out[y]!, -s)
      }
    }
    const C = DENSITY_CLAMP
    for (let y = 0; y < H; y++) {
      const v = out[y]!
      out[y] = v > C ? C : v < -C ? -C : v
    }
    if (this.useLayer) {
      const layer = this.t.densityLayer
      for (let y = 0; y < H; y++) out[y] = out[y]! + layer.sample(x, y, z)
    }
  }

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
    this.densities(x, z, top, dens)
    for (let y = 0; y < H; y++) solid[y] = dens[y]! > 0 ? 1 : 0
  }
```

- [ ] **Step 4: Split the height stage out of `fillCells`**

In `packages/terrain/src/pipeline/cells.ts`, add before `fillCells`:

```ts
/** Ground height and water before the height layer, for a rectangle of columns. Index: (x - x0) + (z - z0) * w. */
export interface HeightGrid {
  readonly h: Float64Array
  readonly water: Float64Array
  readonly wet: Float64Array
  readonly opBiome: Int32Array
}

/** Runs base and height ops (in document order) for every column of [x0, x0 + w) × [z0, z0 + d). */
export function fillHeights(t: CompiledTerrain, x0: number, z0: number, w: number, d: number): HeightGrid {
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
  return { h, water, wet, opBiome }
}
```

Then replace the start of `fillCells` — everything from `const n = w * d` through the closing `}` of the `for (const op of t.heightOps)` loop — with:

```ts
  const n = w * d
  const { h, water, wet, opBiome } = fillHeights(t, x0, z0, w, d)
```

Update the doc comment of `fillCells` to: `/** Runs fillHeights, then the height layer and biome selection for every column. */`

- [ ] **Step 5: Write the samplers**

Create `packages/terrain/src/pipeline/sample.ts`:

```ts
import type { TerrainLayers } from '../doc/types.ts'
import { compileLayers } from '../layers/layers.ts'
import { fillCells, fillHeights } from './cells.ts'
import type { CompiledTerrain } from './compile.ts'
import { VolumeField } from './volume.ts'

/** Ground height before the height layer (base and height ops) for columns [x0, x0 + w) × [z0, z0 + d); index (x - x0) + (z - z0) * w. */
export function sampleHeights(t: CompiledTerrain, x0: number, z0: number, w: number, d: number): Float64Array {
  return fillHeights(t, x0, z0, w, d).h
}

/** A lattice of points: (x0 + i·step, y0 + j·step, z0 + k·step) for i < nx, j < ny, k < nz. */
export interface SampleGrid { x0: number; y0: number; z0: number; nx: number; ny: number; nz: number; step: number }

/**
 * The density the pipeline thresholds (solid where > 0) at each grid point: the height field and volume
 * ops clamped to ±DENSITY_CLAMP, plus the density layer. Index i + k·nx + j·nx·nz. A y outside the
 * world reads the nearest y inside it.
 */
export function sampleDensity(t: CompiledTerrain, g: SampleGrid): Float32Array {
  const w = (g.nx - 1) * g.step + 1, d = (g.nz - 1) * g.step + 1
  const cells = fillCells(t, g.x0, g.z0, w, d)
  const field = new VolumeField(t, g.x0, g.z0, w, d)
  const col = new Float64Array(t.height)
  const out = new Float32Array(g.nx * g.ny * g.nz)
  for (let k = 0; k < g.nz; k++) for (let i = 0; i < g.nx; i++) {
    const lx = i * g.step, lz = k * g.step
    field.densities(g.x0 + lx, g.z0 + lz, cells.top[lx + lz * w]!, col)
    for (let j = 0; j < g.ny; j++) {
      const y = Math.min(t.height - 1, Math.max(0, g.y0 + j * g.step))
      out[i + k * g.nx + j * g.nx * g.nz] = col[y]!
    }
  }
  return out
}

/** The terrain with other layers. Brushes sample documents that differ from the compiled one only in their layers. */
export function withLayers(t: CompiledTerrain, layers: TerrainLayers): CompiledTerrain {
  return { ...t, ...compileLayers(layers) }
}
```

- [ ] **Step 6: Export**

In `packages/terrain/src/index.ts`, add:

```ts
export { sampleDensity, sampleHeights, withLayers, type SampleGrid } from './pipeline/sample.ts'
export { DENSITY_CLAMP } from './pipeline/volume.ts'
```

- [ ] **Step 7: Run the tests**

Run: `npm test -w @elovox/terrain`
Expected: PASS.

Run: `npm test -w @elovox/sandbox -- terrainDocs`
Expected: PASS (the clamp keeps the golden hashes: the showcase's cave column is in them).

Run: `npm run typecheck -w @elovox/terrain`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/terrain
git commit -m "feat(terrain): clamp the density field before the density layer; sampleHeights and sampleDensity"
```

---

### Task 3: Engine `terrain.patch`

**Files:**
- Modify: `packages/engine/src/sim/generator.ts`, `packages/engine/src/protocol.ts`, `packages/engine/src/sim/simHost.ts`, `packages/engine/src/sim/genPool.ts`, `packages/engine/src/gen/genHost.ts`, `packages/engine/src/engine.ts`
- Test: `packages/engine/test/patch.test.ts`

**Interfaces:**
- Consumes: existing `SimHost`, `GenPool`, `GenHost`, `terrainRequest` in `engine.ts`.
- Produces:
  - `GeneratorModule.patch?(patch: unknown): void`.
  - `ToSim`: `{ type: 'patchTerrain'; id: number; patch: unknown }`, answered by the existing `{ type: 'terrain'; id; ok … }`.
  - `ToGen`: `{ type: 'patch'; epoch: number; patch: unknown }`. `FromGen`: `{ type: 'fatal'; epoch: number; message: string }`.
  - `GenPool.patch(patch)`, `GenPool.onFatal: ((message: string) => void) | null`.
  - `Engine.terrain.patch(patch: unknown): Promise<void>` (rejects with `EngineError('terrain', message)`).
  - Messages: `'the generator does not support patches'`, `'the world is still generating'`, fatal `'a generation worker refused a patch the sim accepted: <message>'`.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/test/patch.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { GenHost } from '../src/gen/genHost.ts'
import type { FromGen, FromSim } from '../src/protocol.ts'
import { defineGenerator } from '../src/sim/generator.ts'
import type { Simulation } from '../src/sim/simulation.ts'
import { AIR } from '../src/world/voxel.ts'
import { closePorts, genPorts, makeHost, waitFor } from './genHelpers.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

afterEach(closePorts)

/**
 * Flat stone `level` blocks high. A patch { level } sets the level (idempotent: in tests the sim and
 * every "worker" share this one object). `refuse(call)` makes a patch call throw.
 */
function patchable(refuse: (call: number) => boolean = () => false) {
  let level = 0, calls = 0
  return defineGenerator({
    configure(doc) { level = (doc as { level: number }).level },
    patch(p) {
      calls++
      const l = (p as { level?: unknown }).level
      if (typeof l !== 'number') throw new Error('level must be a number')
      if (refuse(calls)) throw new Error('diverged')
      level = l
    },
    generateColumn(ctx) {
      for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) for (let y = 0; y < level; y++) ctx.set(lx, y, lz, ID.stone)
    },
  })
}

const groundAt = (sim: Simulation, x: number, z: number) => {
  let y = 63
  while (y >= 0 && sim.store.getVoxel(x, y, z) === AIR) y--
  return y + 1
}
const answer = (out: FromSim[], id: number) => out.find((m) => m.type === 'terrain' && m.id === id)
const WHOLE = { x0: 0, z0: 0, x1: 96, z1: 64 }

describe('SimHost terrain patches (serial)', () => {
  it('applies a patch to the generator; the next regeneration uses it', () => {
    const { host, out } = makeHost(patchable(), { terrain: { level: 20 } })
    host.handle({ type: 'patchTerrain', id: 1, patch: { level: 27 } })
    expect(answer(out, 1)).toEqual({ type: 'terrain', id: 1, ok: true })
    host.handle({ type: 'regenerate', id: 2, rect: { x0: 0, z0: 0, x1: 32, z1: 32 } })
    expect(groundAt(host.simulation!, 5, 5)).toBe(27)
    expect(groundAt(host.simulation!, 40, 5)).toBe(20)
  })

  it('answers a refused patch with its message and changes nothing', () => {
    const { host, out } = makeHost(patchable(), { terrain: { level: 20 } })
    host.handle({ type: 'patchTerrain', id: 1, patch: { level: 'x' } })
    expect(answer(out, 1)).toEqual({ type: 'terrain', id: 1, ok: false, message: 'Error: level must be a number' })
    host.handle({ type: 'regenerate', id: 2, rect: WHOLE })
    expect(groundAt(host.simulation!, 5, 5)).toBe(20)
  })

  it('refuses patches when the generator has none', () => {
    const { host, out } = makeHost(defineGenerator({ generateColumn() {} }))
    host.handle({ type: 'patchTerrain', id: 1, patch: {} })
    expect(answer(out, 1)).toEqual({ type: 'terrain', id: 1, ok: false, message: 'the generator does not support patches' })
  })
})

describe('SimHost terrain patches (generation workers)', () => {
  async function pooled(gen = patchable(), workers = 2) {
    const h = makeHost(gen, { terrain: { level: 20 }, genPorts: genPorts(workers, gen) })
    await waitFor(h.out, (m) => m.type === 'ready')
    return h
  }

  it('refuses patches until the initial generation is in', async () => {
    const gen = patchable()
    const { host, out } = makeHost(gen, { terrain: { level: 20 }, genPorts: genPorts(2, gen) })
    host.handle({ type: 'patchTerrain', id: 1, patch: { level: 25 } })
    expect(answer(out, 1)).toEqual({ type: 'terrain', id: 1, ok: false, message: 'the world is still generating' })
    await waitFor(out, (m) => m.type === 'ready')
  })

  it('patches the workers too, matching serial regeneration', async () => {
    const { host, out } = await pooled()
    host.handle({ type: 'patchTerrain', id: 1, patch: { level: 26 } })
    host.handle({ type: 'regenerate', id: 2, rect: WHOLE })
    await waitFor(out, (m) => m.type === 'regenerated')
    expect(groundAt(host.simulation!, 70, 40)).toBe(26)
    const serial = makeHost(patchable(), { terrain: { level: 20 } })
    serial.host.handle({ type: 'patchTerrain', id: 1, patch: { level: 26 } })
    serial.host.handle({ type: 'regenerate', id: 2, rect: WHOLE })
    expect(host.simulation!.hash()).toBe(serial.host.simulation!.hash())
  })

  it('reruns an in-flight regeneration with the patched document', async () => {
    const { host, out } = await pooled()
    host.handle({ type: 'regenerate', id: 2, rect: WHOLE })
    host.handle({ type: 'patchTerrain', id: 3, patch: { level: 33 } })
    await waitFor(out, (m) => m.type === 'regenerated')
    expect(out.filter((m) => m.type === 'regenerated')).toHaveLength(1)
    expect(groundAt(host.simulation!, 50, 50)).toBe(33)
  })

  it('is fatal when a worker refuses a patch the sim accepted', async () => {
    const { host, out } = await pooled(patchable((call) => call > 1), 1) // call 1: the sim; call 2: the worker
    host.handle({ type: 'patchTerrain', id: 1, patch: { level: 30 } })
    expect(answer(out, 1)).toEqual({ type: 'terrain', id: 1, ok: true })
    await waitFor(out, (m) => m.type === 'fatal')
    expect(out.at(-1)).toEqual({ type: 'fatal', message: 'Error: a generation worker refused a patch the sim accepted: Error: diverged' })
  })
})

describe('GenHost patches', () => {
  const configure = { type: 'configure', epoch: 1, doc: { level: 3 }, size: [64, 64, 64], seed: 5, blocks: TEST_BLOCKS } as const

  it('applies a patch and answers later jobs under its epoch', () => {
    const out: FromGen[] = []
    const host = new GenHost((m) => out.push(m), patchable())
    host.handle(configure)
    host.handle({ type: 'patch', epoch: 2, patch: { level: 4 } })
    host.handle({ type: 'job', id: 1, cx: 0, cz: 0 })
    const m = out[0]!
    expect(m.type === 'column' && [m.epoch, m.data[3 << 10], m.data[4 << 10]]).toEqual([2, ID.stone, 0])
  })

  it('reports a refused patch as fatal', () => {
    const out: FromGen[] = []
    const host = new GenHost((m) => out.push(m), patchable())
    host.handle(configure)
    host.handle({ type: 'patch', epoch: 2, patch: { level: 'x' } })
    expect(out).toEqual([{ type: 'fatal', epoch: 2, message: 'Error: level must be a number' }])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/engine -- patch`
Expected: FAIL: the sim ignores `patchTerrain`, so `answer(out, 1)` is `undefined` (Vitest does not typecheck, so the unknown message type does not stop the run).

- [ ] **Step 3: Add the generator hook and the messages**

In `packages/engine/src/sim/generator.ts`, inside `interface GeneratorModule`, after `configure?`, add:

```ts
  /**
   * Applies an incremental change to the configured document (`engine.terrain.patch`). Throw to refuse
   * it; a refused patch must leave the generator as it was.
   */
  patch?(patch: unknown): void
```

In `packages/engine/src/protocol.ts`:
- In `ToSim`, after the `setTerrain` member, add:

```ts
  /** Applies an incremental change to the generator's document everywhere (patch); answered by 'terrain'. */
  | { type: 'patchTerrain'; id: number; patch: unknown }
```

- Replace `ToGen` and `FromGen` with:

```ts
/** Sim worker → generation worker (over a MessagePort). Jobs answer with the configuration in force. */
export type ToGen =
  | { type: 'configure'; epoch: number; doc: unknown; size: WorldSize; seed: number; blocks: BlockDef[] }
  /** An incremental change to the configuration; starts a new epoch. */
  | { type: 'patch'; epoch: number; patch: unknown }
  | { type: 'job'; id: number; cx: number; cz: number }

/** Generation worker → sim worker. `epoch` is the configuration the column was generated with. */
export type FromGen =
  | { type: 'column'; id: number; epoch: number; cx: number; cz: number; data: Uint16Array }
  | { type: 'error'; id: number; epoch: number; message: string }
  /** The worker refused a patch: its configuration no longer matches the sim's. */
  | { type: 'fatal'; epoch: number; message: string }
```

- [ ] **Step 4: Patch in the generation worker**

In `packages/engine/src/gen/genHost.ts`, in `handle`, after the `if (m.type === 'configure') { … return }` block, add:

```ts
    if (m.type === 'patch') {
      this.epoch = m.epoch
      if (this.error !== null) return // jobs keep answering with the configuration error
      try {
        if (!this.gen.patch) throw new Error('the generator does not support patches')
        this.gen.patch(m.patch)
      } catch (e) {
        this.post({ type: 'fatal', epoch: m.epoch, message: message(e) }, [])
      }
      return
    }
```

- [ ] **Step 5: Patch through the pool**

In `packages/engine/src/sim/genPool.ts`:
- After `private epoch = 0`, add:

```ts
  /** Called when a worker refuses a patch of the current epoch. */
  onFatal: ((message: string) => void) | null = null
```

- After the `configure` method, add:

```ts
  /** Sends an incremental change to every worker. Columns generated before it are ignored from now on. */
  patch(patch: unknown): void {
    this.epoch++
    for (const p of this.ports) p?.postMessage({ type: 'patch', epoch: this.epoch, patch })
  }
```

- At the top of `onMessage`, add:

```ts
    if (m.type === 'fatal') {
      if (m.epoch === this.epoch) this.onFatal?.(m.message)
      return
    }
```

- [ ] **Step 6: Patch in the sim host**

In `packages/engine/src/sim/simHost.ts`:
- After `private active: RegenRequest | null = null`, add:

```ts
  /** Set once the initial generation is in: a patch before that would invalidate its columns. */
  private ready = false
```

- In `handle`'s `'init'` case, right after `this.pool = new GenPool(msg.genPorts as PortLike[])`, add:

```ts
            this.pool.onFatal = (message) => this.fail(new Error(`a generation worker refused a patch the sim accepted: ${message}`))
```

- In the same case, just before the serial `this.post({ type: 'ready', … })`, add `this.ready = true`. In `generateInPool`'s `onDone`, just before its `this.post({ type: 'ready', … })`, add `this.ready = true`.
- In the `switch`, after the `'setTerrain'` case, add:

```ts
      case 'patchTerrain':
        this.patchTerrain(msg.id, msg.patch)
        return
```

- In `setTerrain`, replace the trailing block

```ts
    const active = this.active
    if (active) {
      // Columns in flight were generated from the old document: drop them and run the request again.
      pool.cancel()
      this.active = null
      this.regenQueue.unshift(active)
      this.nextRegen()
    }
```

with `this.restartActive()`, and add these methods after `setTerrain`:

```ts
  private patchTerrain(id: number, patch: unknown): void {
    if (!this.sim) return
    const gen = this.modules.generator
    if (!gen.patch) { this.post({ type: 'terrain', id, ok: false, message: 'the generator does not support patches' }); return }
    if (!this.ready) { this.post({ type: 'terrain', id, ok: false, message: 'the world is still generating' }); return }
    try {
      gen.patch(patch)
    } catch (e) {
      this.post({ type: 'terrain', id, ok: false, message: errorMessage(e) })
      return
    }
    this.post({ type: 'terrain', id, ok: true })
    if (!this.pool) return
    this.pool.patch(patch)
    this.restartActive()
  }

  /** Columns in flight were generated from an older configuration: drop them and run the request again. */
  private restartActive(): void {
    const pool = this.pool, active = this.active
    if (!pool || !active) return
    pool.cancel()
    this.active = null
    this.regenQueue.unshift(active)
    this.nextRegen()
  }
```

- [ ] **Step 7: Expose it on the engine**

In `packages/engine/src/engine.ts`, in the `terrain` member of the `Engine` interface, after `setDocument`, add:

```ts
    /** Applies an incremental change to the generator's document (the generator's patch). Rejects with EngineError 'terrain' if it refuses it; the world changes only on regenerate(). */
    patch(patch: unknown): Promise<void>
```

In the returned object's `terrain`, after `setDocument: …,`, add:

```ts
      patch: (patch) => terrainRequest<void>((id) => ({ type: 'patchTerrain', id, patch })),
```

- [ ] **Step 8: Run the tests**

Run: `npm test -w @elovox/engine`
Expected: PASS (the new `patch` file and every existing file, including `regenerate`, `genPool`, `genHost`, `simHostGen`).

Run: `npm run typecheck -w @elovox/engine`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): terrain.patch applies incremental document changes on the sim and every generation worker"
```

---

### Task 4: Terrain patches and the generator's `patch`

**Files:**
- Create: `packages/terrain/src/layers/patch.ts`
- Modify: `packages/terrain/src/generator.ts`, `packages/terrain/src/index.ts`
- Test: `packages/terrain/test/patch.test.ts`

**Interfaces:**
- Consumes: `GeneratorModule.patch` (Task 3), `LayerLimits`, keys and constants (Task 1), `CompiledTerrain` layers with `set` (Task 1).
- Produces (exported from `@elovox/terrain`):
  - `interface TerrainPatch { height?: { x; z; values: Int16Array | null }[]; biome?: { x; z; values: Uint8Array | null }[]; density?: { x; y; z; values: Int8Array | null }[] }`.
  - `diffLayers(a: TerrainLayers, b: TerrainLayers): TerrainPatch`.
  - `checkPatch(p: unknown, limits: LayerLimits): string[]`.
  - `applyPatch(t: CompiledTerrain, p: TerrainPatch): void`.
  - `createTerrainGenerator().patch(p)` — throws `'the terrain generator has no document to patch'` before configure, or `'invalid terrain patch:\n  - <errors>'`.

- [ ] **Step 1: Write the failing tests**

Create `packages/terrain/test/patch.test.ts`:

```ts
import { defineBlock } from '@elovox/engine/src/blocks/registry.ts'
import { Simulation } from '@elovox/engine/src/sim/simulation.ts'
import { createWorldBuffers } from '@elovox/engine/src/world/buffers.ts'
import { describe, expect, it } from 'vitest'
import type { TerrainDoc, TerrainLayers } from '../src/doc/types.ts'
import { validateTerrainDoc } from '../src/doc/validate.ts'
import { createTerrainGenerator } from '../src/generator.ts'
import { checkPatch, diffLayers } from '../src/layers/patch.ts'
import { BIOME_VALUES, BRICK_VALUES, HEIGHT_VALUES } from '../src/layers/tiles.ts'
import { minimalDoc } from './fixtures.ts'

const BLOCKS = ['stone', 'dirt', 'grass', 'sand', 'water', 'log', 'leaves', 'pine_leaves', 'rock'].map((name) =>
  defineBlock(name === 'water' ? { name, liquid: true, solid: false } : { name }))
const limits = { sizeX: 64, sizeZ: 64, height: 64, biomeCount: 2 }

function plainDoc(): TerrainDoc {
  const r = validateTerrainDoc(minimalDoc(), { worldHeight: 64 })
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.doc
}
function paint(): TerrainLayers {
  const density = new Int8Array(BRICK_VALUES)
  density[4 + 4 * 8 + 1 * 64] = -60
  return {
    height: { tiles: [{ x: 0, z: 0, values: new Int16Array(HEIGHT_VALUES).fill(40) }] },
    biome: { tiles: [{ x: 0, z: 0, values: new Uint8Array(BIOME_VALUES).fill(2) }] },
    density: { bricks: [{ x: 1, y: 1, z: 1, values: density }] },
  }
}
/** The world hash after configure(first) and, if given, patch(diffLayers(first.layers, then.layers)). */
function worldHash(first: TerrainDoc, then?: TerrainDoc): number {
  const gen = createTerrainGenerator()
  const s = new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks: BLOCKS, seed: 9 })
  s.configure(gen, first)
  if (then) gen.patch!(diffLayers(first.layers, then.layers))
  s.generate(gen)
  return s.hash()
}

describe('diffLayers', () => {
  it('lists the tiles b does not share with a, and removals for tiles only a has', () => {
    const p = paint()
    const kept = p.height!.tiles[0]!
    const changed = { x: 0, z: 0, values: new Uint8Array(BIOME_VALUES).fill(1) }
    const b: TerrainLayers = { height: p.height, biome: { tiles: [changed] } }
    expect(diffLayers(p, b)).toEqual({ biome: [{ x: 0, z: 0, values: changed.values }], density: [{ x: 1, y: 1, z: 1, values: null }] })
    expect(diffLayers(p, p)).toEqual({})
    expect(diffLayers({}, { height: { tiles: [kept] } })).toEqual({ height: [{ x: 0, z: 0, values: kept.values }] })
  })
})

describe('checkPatch', () => {
  it('reports keys outside the world, wrong arrays and biome values past the count', () => {
    expect(checkPatch({
      height: [{ x: 1, z: 0, values: null }, { x: 0, z: 0, values: new Int8Array(4) }],
      biome: [{ x: 0, z: 0, values: new Uint8Array(BIOME_VALUES).fill(3) }],
      density: [{ x: 0, y: 4, z: 0, values: null }],
      water: [],
    }, limits)).toEqual([
      'patch.water: unknown layer (known: height, biome, density)',
      'patch.height[0].x: must be <= 0',
      'patch.height[1].values: must be null or an Int16Array of 4096 values',
      'patch.biome[0].values: value 3 at cell (0, 0) exceeds the 2 biomes',
      'patch.density[0].y: must be <= 3',
    ])
    expect(checkPatch('x', limits)).toEqual(['patch: must be an object'])
    expect(checkPatch({}, limits)).toEqual([])
  })
})

describe('terrain generator patch', () => {
  it('configure then patch generates the same world as configure with the painted document', () => {
    const plain = plainDoc()
    const painted = { ...plain, layers: paint() }
    expect(worldHash(plain, painted)).toBe(worldHash(painted))
    expect(worldHash(painted)).not.toBe(worldHash(plain)) // the paint matters
  })

  it('a patch that removes the paint gives the plain world back', () => {
    const plain = plainDoc()
    expect(worldHash({ ...plain, layers: paint() }, plain)).toBe(worldHash(plain))
  })

  it('refuses an invalid patch and keeps generating the configured document', () => {
    const plain = plainDoc()
    const gen = createTerrainGenerator()
    const s = new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks: BLOCKS, seed: 9 })
    s.configure(gen, plain)
    expect(() => gen.patch!({ biome: [{ x: 0, z: 0, values: new Uint8Array(BIOME_VALUES).fill(9) }] }))
      .toThrow('invalid terrain patch:\n  - patch.biome[0].values: value 9 at cell (0, 0) exceeds the 2 biomes')
    s.generate(gen)
    expect(s.hash()).toBe(worldHash(plain))
  })

  it('refuses a patch before any document', () => {
    expect(() => createTerrainGenerator().patch!({})).toThrow('the terrain generator has no document to patch')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/terrain -- patch`
Expected: FAIL (cannot resolve `../src/layers/patch.ts`).

- [ ] **Step 3: Write the patch module**

Create `packages/terrain/src/layers/patch.ts`:

```ts
import { Check } from '../doc/check.ts'
import type { TerrainLayers } from '../doc/types.ts'
import type { CompiledTerrain } from '../pipeline/compile.ts'
import { BIOME_TILE, BIOME_VALUES, BRICK_SPAN, BRICK_VALUES, HEIGHT_VALUES, TILE, brickKey, tileKey, type LayerLimits, type LayerValues } from './tiles.ts'

/** Tiles to replace in the configured document's layers; a null `values` removes the tile. Sent by engine.terrain.patch. */
export interface TerrainPatch {
  height?: { x: number; z: number; values: Int16Array | null }[]
  biome?: { x: number; z: number; values: Uint8Array | null }[]
  density?: { x: number; y: number; z: number; values: Int8Array | null }[]
}

/** The tiles of `b` that `a` does not share (by object identity), plus removals for the tiles only `a` has. */
export function diffLayers(a: TerrainLayers, b: TerrainLayers): TerrainPatch {
  const out: TerrainPatch = {}
  const height = diff(a.height?.tiles, b.height?.tiles, (t) => tileKey(t.x, t.z))
  if (height.length > 0) out.height = height.map(([t, values]) => ({ x: t.x, z: t.z, values }))
  const biome = diff(a.biome?.tiles, b.biome?.tiles, (t) => tileKey(t.x, t.z))
  if (biome.length > 0) out.biome = biome.map(([t, values]) => ({ x: t.x, z: t.z, values }))
  const density = diff(a.density?.bricks, b.density?.bricks, (t) => brickKey(t.x, t.y, t.z))
  if (density.length > 0) out.density = density.map(([t, values]) => ({ x: t.x, y: t.y, z: t.z, values }))
  return out
}

function diff<T extends { values: unknown }>(a: readonly T[] = [], b: readonly T[] = [], key: (t: T) => number): [T, T['values'] | null][] {
  const before = new Map(a.map((t) => [key(t), t]))
  const kept = new Set<number>()
  const out: [T, T['values'] | null][] = []
  for (const t of b) {
    const k = key(t)
    kept.add(k)
    if (before.get(k) !== t) out.push([t, t.values])
  }
  for (const [k, t] of before) if (!kept.has(k)) out.push([t, null])
  return out
}

const NAMES = { height: 'an Int16Array', biome: 'a Uint8Array', density: 'an Int8Array' } as const

/** Errors in a patch for a world with these limits, each as "path: message". */
export function checkPatch(p: unknown, o: LayerLimits): string[] {
  const c = new Check()
  if (!c.obj('patch', p)) return c.errors
  for (const k of Object.keys(p)) {
    if (k !== 'height' && k !== 'biome' && k !== 'density') c.fail(`patch.${k}`, 'unknown layer (known: height, biome, density)')
  }
  const tx = Math.ceil(o.sizeX / TILE), tz = Math.ceil(o.sizeZ / TILE)
  entries(c, 'height', p.height, [tx, tz], Int16Array, HEIGHT_VALUES)
  const biome = entries(c, 'biome', p.biome, [tx, tz], Uint8Array, BIOME_VALUES)
  biome.forEach(([i, values]) => {
    const at = values.findIndex((v) => v > o.biomeCount)
    if (at >= 0) c.fail(`patch.biome[${i}].values`, `value ${values[at]} at cell (${at % BIOME_TILE}, ${Math.floor(at / BIOME_TILE)}) exceeds the ${o.biomeCount} biomes`)
  })
  entries(c, 'density', p.density, [Math.ceil(o.sizeX / BRICK_SPAN), Math.ceil(o.height / BRICK_SPAN), Math.ceil(o.sizeZ / BRICK_SPAN)], Int8Array, BRICK_VALUES)
  return c.errors
}

/** Checks one layer's entries; returns the index and values of each entry with valid values. */
function entries(c: Check, layer: keyof typeof NAMES, v: unknown, limits: number[], Ctor: new (n: number) => LayerValues, n: number): [number, LayerValues][] {
  const path = `patch.${layer}`
  const out: [number, LayerValues][] = []
  if (!c.arr(path, v, 0, true)) return out
  const axes = limits.length === 3 ? (['x', 'y', 'z'] as const) : (['x', 'z'] as const)
  v.forEach((e, i) => {
    const p = `${path}[${i}]`
    if (!c.obj(p, e)) return
    axes.forEach((a, j) => c.num(`${p}.${a}`, e[a], { int: true, min: 0, max: limits[j]! - 1 }))
    if (e.values === null) return
    if (e.values instanceof Ctor && e.values.length === n) out.push([i, e.values])
    else c.fail(`${p}.values`, `must be null or ${NAMES[layer]} of ${n} values`)
  })
  return out
}

/** Replaces tiles in the compiled layers. The patch must have passed checkPatch. */
export function applyPatch(t: CompiledTerrain, p: TerrainPatch): void {
  for (const e of p.height ?? []) t.heightLayer.set(e.x, e.z, e.values)
  for (const e of p.biome ?? []) t.biomeLayer.set(e.x, e.z, e.values)
  for (const e of p.density ?? []) t.densityLayer.set(e.x, e.y, e.z, e.values)
}
```

- [ ] **Step 4: Give the generator its `patch`**

Replace the body of `createTerrainGenerator` in `packages/terrain/src/generator.ts` with:

```ts
  const ops = o.ops ?? builtinOps
  let terrain: CompiledTerrain | null = null
  let limits: LayerLimits | null = null
  return {
    configure(doc: unknown, info: GeneratorInfo) {
      const r = validateTerrainDoc(doc, { ops, worldHeight: info.size[1] })
      if (!r.ok) throw new TerrainDocError(r.errors)
      const [sx, sy, sz] = info.size
      if (r.doc.size[0] !== sx || r.doc.size[1] !== sz) {
        throw new Error(`terrain document size [${r.doc.size.join(', ')}] does not match the world's x, z [${sx}, ${sz}]`)
      }
      // Compile before replacing: a document that fails here leaves the previous one in force.
      terrain = compileTerrain(r.doc, { seed: info.seed, height: sy, id: (name) => info.id(name), ops })
      limits = { sizeX: sx, sizeZ: sz, height: sy, biomeCount: r.doc.biomes.length }
    },
    patch(p: unknown) {
      if (!terrain || !limits) throw new Error('the terrain generator has no document to patch')
      const errors = checkPatch(p, limits)
      if (errors.length > 0) throw new Error(`invalid terrain patch:\n  - ${errors.join('\n  - ')}`)
      applyPatch(terrain, p as TerrainPatch)
    },
    generateColumn(ctx, cx, cz) {
      if (!terrain) throw new Error('the terrain generator has no document: pass `terrain` to createEngine')
      generateRegion(terrain, cx * 32, cz * 32, 32, 32, ctx.column)
    },
  }
```

and add the imports:

```ts
import { applyPatch, checkPatch, type TerrainPatch } from './layers/patch.ts'
import type { LayerLimits } from './layers/tiles.ts'
```

Also update the doc comment above `createTerrainGenerator` to end with: `` `patch` applies layer patches (engine.terrain.patch, TerrainPatch). ``

- [ ] **Step 5: Export**

In `packages/terrain/src/index.ts`, add:

```ts
export { applyPatch, checkPatch, diffLayers, type TerrainPatch } from './layers/patch.ts'
```

- [ ] **Step 6: Run the tests**

Run: `npm test -w @elovox/terrain`
Expected: PASS.

Run: `npm run typecheck -w @elovox/terrain`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/terrain
git commit -m "feat(terrain): layer patches (diffLayers, checkPatch, applyPatch) and the generator's patch"
```

---

### Task 5: Editor core reads and writes layers

**Files:**
- Modify: `packages/terrain-editor/test/fixtures.ts`, `packages/terrain-editor/src/core/docio.ts`, `packages/terrain-editor/src/core/area.ts`, `packages/terrain-editor/src/core/session.ts`, `packages/terrain-editor/src/index.ts`
- Test: `packages/terrain-editor/test/docio.test.ts`, `packages/terrain-editor/test/area.test.ts`, `packages/terrain-editor/test/session.test.ts`

**Interfaces:**
- Consumes: `toTerrainJSON`, `TILE`, `BIOME_CELL`, `BIOME_TILE`, `BRICK_SAMPLES`, `BRICK_SPACING`, `tileKey`, `brickKey`, `HEIGHT_VALUES`, `BIOME_VALUES`, `BRICK_VALUES`, `TerrainLayers`, `Rect` (Task 1, `@elovox/terrain`).
- Produces:
  - `onlyLayersDiffer(a: TerrainDoc, b: TerrainDoc): boolean` and `changedLayerRect(a: TerrainLayers, b: TerrainLayers): Rect | null` in `core/area.ts` (exported from the package).
  - `diffArea` covers layer changes by their changed samples and never returns `'all'` for a layer change.
  - `EditorSession` accepts a layers-only change without validating it.
  - `serializeTerrain` writes layers as base64 tiles.
  - Test fixtures: `deepFreeze` skips typed arrays; `flatDoc(): TerrainDoc` (256², flat ground at 30, no ops).

- [ ] **Step 1: Update the fixtures**

In `packages/terrain-editor/test/fixtures.ts`, replace `deepFreeze` with:

```ts
/** Freezes a value deeply, so a test fails if code under test mutates it. Typed arrays cannot be frozen and are skipped. */
export function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !ArrayBuffer.isView(v) && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}
```

and add after `doc()`:

```ts
/** A flat 256 × 256 document (ground at 30, no ops), so brush tests can predict every height. */
export function flatDoc(): TerrainDoc {
  const r = validateTerrainDoc({ ...rawDoc(), base: { height: 30, amplitude: 0, noise: { scale: 64 } }, ops: [] }, { worldHeight: HEIGHT })
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.doc
}
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/terrain-editor/test/docio.test.ts` (add `HEIGHT_VALUES` to an `@elovox/terrain` import, and `HEIGHT, SIZE, doc` to the fixtures import if they are not there yet):

```ts
describe('serializeTerrain with layers', () => {
  it('writes painted layers as base64 tiles that read back as the same document', () => {
    const values = Int16Array.from({ length: HEIGHT_VALUES }, (_, i) => (i % 7) - 3)
    const d = { ...doc(), layers: { height: { tiles: [{ x: 1, z: 2, values }] } } }
    const r = parseTerrainText(serializeTerrain(d), { size: SIZE, worldHeight: HEIGHT })
    expect(r.ok && r.doc).toEqual(d)
  })

  it('writes "layers": {} when nothing is painted', () => {
    expect(serializeTerrain(doc())).toContain('"layers": {}')
  })
})
```

Append to `packages/terrain-editor/test/area.test.ts` (add `import { BIOME_VALUES, BRICK_VALUES, HEIGHT_VALUES, type HeightTile, type TerrainDoc } from '@elovox/terrain'`):

```ts
describe('diffArea: layers', () => {
  const withHeight = (d: TerrainDoc, tiles: HeightTile[]): TerrainDoc => ({ ...d, layers: { ...d.layers, height: { tiles } } })
  // Column (100, 50) is index (100 - 64) + 50 * 64 of tile (1, 0).
  function tile(): HeightTile {
    const values = new Int16Array(HEIGHT_VALUES)
    values[100 - 64 + 50 * 64] = 16
    return { x: 1, z: 0, values }
  }
  // (100, 50) padded by AREA_PAD (8): 92..109 × 42..59, rounded out to chunk columns.
  const area = { x0: 64, z0: 32, x1: 128, z1: 64 }

  it('covers the changed columns, padded and rounded, never the whole world', () => {
    const d = doc()
    expect(diffArea(d, withHeight(d, [tile()]), o)).toEqual(area)
  })

  it('covers a removed tile', () => {
    const d = doc()
    expect(diffArea(withHeight(d, [tile()]), d, o)).toEqual(area)
  })

  it('skips tiles both documents share, and finds nothing between equal copies', () => {
    const d = doc()
    const t = tile()
    const a = withHeight(d, [t])
    expect(diffArea(a, { ...a, layers: { height: { tiles: [t] } } }, o)).toBeNull()
    expect(diffArea(a, withHeight(d, [{ ...t, values: t.values.slice() }]), o)).toBeNull()
  })

  it('covers a biome cell as its 4 × 4 columns', () => {
    const d = doc()
    const values = new Uint8Array(BIOME_VALUES)
    values[5 + 2 * 16] = 1 // cell (5, 2): columns 20..23 × 8..11
    expect(diffArea(d, { ...d, layers: { biome: { tiles: [{ x: 0, z: 0, values }] } } }, o)).toEqual({ x0: 0, z0: 0, x1: 32, z1: 32 })
  })

  it('reaches two blocks around a changed density sample', () => {
    const d = doc()
    const values = new Int8Array(BRICK_VALUES)
    values[0] = 8 // sample (0, 0, 0) of brick (6, 1, 3) = block (96, 16, 48): 94..98 × 46..50
    expect(diffArea(d, { ...d, layers: { density: { bricks: [{ x: 6, y: 1, z: 3, values }] } } }, o)).toEqual({ x0: 64, z0: 32, x1: 128, z1: 64 })
  })
})
```

Append to `packages/terrain-editor/test/session.test.ts` (add `import { HEIGHT_VALUES } from '@elovox/terrain'`):

```ts
describe('EditorSession layers', () => {
  it('records a layers-only gesture as one step with the area it changed', () => {
    const { s, changes } = session()
    const values = new Int16Array(HEIGHT_VALUES)
    values[0] = 16 // column (0, 0)
    const painted = { ...s.doc, layers: { height: { tiles: [{ x: 0, z: 0, values }] } } }
    s.begin('raise')
    expect(s.update(() => painted)).toEqual({ ok: true })
    s.commit()
    expect(s.doc).toBe(painted)
    expect(changes.at(-1)).toMatchObject({ cause: 'commit', area: { x0: 0, z0: 0, x1: 32, z1: 32 } })
    s.undo()
    expect(s.doc.layers).toEqual({})
  })

  it('trusts a layers-only change without validating it (brushes clamp what they write)', () => {
    const { s } = session()
    const outside = { ...s.doc, layers: { height: { tiles: [{ x: 99, z: 0, values: new Int16Array(HEIGHT_VALUES).fill(1) }] } } }
    expect(s.apply('paint', () => outside)).toEqual({ ok: true })
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w @elovox/terrain-editor -- docio area session`
Expected: FAIL: the serialized layers hold typed arrays as plain objects; `diffArea` returns `'all'` for layer changes; the out-of-range tile is refused.

- [ ] **Step 4: Serialize through `toTerrainJSON`**

In `packages/terrain-editor/src/core/docio.ts`, add `toTerrainJSON` to the `@elovox/terrain` import and replace the body of `serializeTerrain` with:

```ts
  return `${JSON.stringify(toTerrainJSON(doc), null, 2)}\n`
```

- [ ] **Step 5: Layer-aware areas**

In `packages/terrain-editor/src/core/area.ts`:
- Replace the import line with:

```ts
import {
  BIOME_CELL, BIOME_TILE, BRICK_SAMPLES, BRICK_SPACING, FEATURE_REACH, TILE, brickKey, opBounds, tileKey,
  type OpDef, type OpRegistry, type Rect, type TerrainDoc, type TerrainLayers, type Vec2,
} from '@elovox/terrain'
```

- Replace `const GLOBAL_FIELDS = ['size', 'seaLevel', 'blocks', 'base', 'biomes', 'biomeRule', 'layers'] as const` with:

```ts
const GLOBAL_FIELDS = ['size', 'seaLevel', 'blocks', 'base', 'biomes', 'biomeRule'] as const
```

- In `diffArea`, replace `let out: Area = null` with:

```ts
  const layers = prev.layers === next.layers ? null : changedLayerRect(prev.layers, next.layers)
  let out: Area = layers ? toArea(layers, next.size) : null
```

and change the first sentence of its doc comment to: `The area whose voxels can differ between two valid documents: every layer value that changed, every op added, removed or changed (where it was and where it is) and every op whose order among the others changed.`

- Append:

```ts
/** Whether two documents differ in nothing but their layers (every other field is the same object). */
export function onlyLayersDiffer(a: TerrainDoc, b: TerrainDoc): boolean {
  const keys = Object.keys(a) as (keyof TerrainDoc)[]
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((k) => k === 'layers' || a[k] === b[k])
}

/** A closed rectangle that grows to cover what it is given. */
class Bounds {
  rect: Rect | null = null
  add(x0: number, z0: number, x1: number, z1: number): void {
    const r = this.rect
    this.rect = r
      ? { x0: Math.min(r.x0, x0), z0: Math.min(r.z0, z0), x1: Math.max(r.x1, x1), z1: Math.max(r.z1, z1) }
      : { x0, z0, x1, z1 }
  }
}

/**
 * The columns whose layer values differ between two documents, as a closed rectangle in blocks, or
 * null. Tiles both documents share are skipped without reading them. A changed density sample reaches
 * BRICK_SPACING blocks around it (trilinear interpolation).
 */
export function changedLayerRect(a: TerrainLayers, b: TerrainLayers): Rect | null {
  const out = new Bounds()
  changed(a.height?.tiles, b.height?.tiles, (t) => tileKey(t.x, t.z), (t, i) => {
    const x = t.x * TILE + (i % TILE), z = t.z * TILE + Math.floor(i / TILE)
    out.add(x, z, x, z)
  })
  changed(a.biome?.tiles, b.biome?.tiles, (t) => tileKey(t.x, t.z), (t, i) => {
    const x = t.x * TILE + (i % BIOME_TILE) * BIOME_CELL, z = t.z * TILE + Math.floor(i / BIOME_TILE) * BIOME_CELL
    out.add(x, z, x + BIOME_CELL - 1, z + BIOME_CELL - 1)
  })
  changed(a.density?.bricks, b.density?.bricks, (t) => brickKey(t.x, t.y, t.z), (t, i) => {
    const x = (t.x * BRICK_SAMPLES + (i % BRICK_SAMPLES)) * BRICK_SPACING
    const z = (t.z * BRICK_SAMPLES + (Math.floor(i / BRICK_SAMPLES) % BRICK_SAMPLES)) * BRICK_SPACING
    out.add(x - BRICK_SPACING, z - BRICK_SPACING, x + BRICK_SPACING, z + BRICK_SPACING)
  })
  return out.rect
}

/** Calls `visit` for every value index that differs between two tile lists; a missing tile reads as zeros. */
function changed<T extends { values: ArrayLike<number> }>(a: readonly T[] = [], b: readonly T[] = [], key: (t: T) => number, visit: (t: T, i: number) => void): void {
  const before = new Map(a.map((t) => [key(t), t]))
  const seen = new Set<number>()
  for (const tb of b) {
    const k = key(tb)
    seen.add(k)
    const ta = before.get(k)
    if (ta === tb) continue
    for (let i = 0; i < tb.values.length; i++) if ((ta ? ta.values[i]! : 0) !== tb.values[i]) visit(tb, i)
  }
  for (const [k, ta] of before) {
    if (seen.has(k)) continue
    for (let i = 0; i < ta.values.length; i++) if (ta.values[i] !== 0) visit(ta, i)
  }
}
```

- [ ] **Step 6: Trust layers-only changes in the session**

In `packages/terrain-editor/src/core/session.ts`:
- Change `import { diffArea, type Area } from './area.ts'` to `import { diffArea, onlyLayersDiffer, type Area } from './area.ts'`.
- In `attempt`, after `if (doc === this.current) return { ok: true, doc }`, add:

```ts
    // Brushes clamp every value they write, so a document that differs only in its layers is valid by
    // construction; validating it would cost time proportional to everything painted.
    if (onlyLayersDiffer(doc, this.current)) return { ok: true, doc }
```

- [ ] **Step 7: Export**

In `packages/terrain-editor/src/index.ts`, change the area export to:

```ts
export { AREA_PAD, changedLayerRect, diffArea, onlyLayersDiffer, toArea, unionArea, type Area, type AreaOptions, type AreaRect } from './core/area.ts'
```

- [ ] **Step 8: Run the tests**

Run: `npm test -w @elovox/terrain-editor`
Expected: PASS.

Run: `npm run typecheck -w @elovox/terrain-editor`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/terrain-editor
git commit -m "feat(terrain-editor): layer-aware dirty areas, trusted layer edits, layers saved as tiles"
```

---

### Task 6: Preview patches layer changes

**Files:**
- Modify: `packages/terrain-editor/src/core/preview.ts`
- Test: `packages/terrain-editor/test/preview.test.ts`

**Interfaces:**
- Consumes: `diffLayers`, `TerrainPatch` (Task 4), `onlyLayersDiffer` (Task 5), `engine.terrain.patch` (Task 3; `engine.terrain` keeps fitting `TerrainTarget`).
- Produces: `TerrainTarget.patch(patch: unknown): Promise<void>`. The scheduler sends `patch(diffLayers(sent.layers, doc.layers))` when only the layers changed, else `setDocument(doc)`.

- [ ] **Step 1: Write the failing tests**

In `packages/terrain-editor/test/preview.test.ts`:
- Change the `Call` type and `fake` to:

```ts
type Call = ['set', TerrainDoc] | ['patch', TerrainPatch] | ['regen', AreaRect]

function fake() {
  const calls: Call[] = []
  const waiting: { resolve: () => void; reject: (e: Error) => void }[] = []
  /** Errors the next patch calls reject with, in order. */
  const failPatch: Error[] = []
  const target: TerrainTarget = {
    setDocument(d) { calls.push(['set', d as TerrainDoc]); return Promise.resolve() },
    patch(p) {
      calls.push(['patch', p as TerrainPatch])
      const e = failPatch.shift()
      return e ? Promise.reject(e) : Promise.resolve()
    },
    regenerate(rect) {
      calls.push(['regen', rect])
      return new Promise((res, rej) => waiting.push({ resolve: () => res({ ms: 5, chunks: 3 }), reject: rej }))
    },
  }
  return { target, calls, waiting, failPatch }
}
```

- Change the `@elovox/terrain` import to `import { HEIGHT_VALUES, type TerrainDoc, type TerrainPatch } from '@elovox/terrain'`.
- Append:

```ts
describe('PreviewScheduler with layers', () => {
  const tile = (x = 0, v = 16) => ({ x, z: 0, values: new Int16Array(HEIGHT_VALUES).fill(v) })

  it('patches the changed tiles when only the layers changed', async () => {
    const { p, start, calls, waiting } = setup()
    const t = tile()
    const d1 = { ...start, layers: { height: { tiles: [t] } } }
    p.onChange(ev(d1, A, 'gesture'))
    await tick()
    expect(calls).toEqual([['patch', { height: [{ x: 0, z: 0, values: t.values }] }], ['regen', A]])
    waiting[0]!.resolve()
    await p.idle()
  })

  it('sends the whole document, layers included, when anything else changed too', async () => {
    const { p, start, calls, waiting } = setup()
    const d1 = setParam('hill', 'amplitude', 3)({ ...start, layers: { height: { tiles: [tile()] } } })
    p.onChange(ev(d1, A, 'edit'))
    await tick()
    expect(calls).toEqual([['set', d1], ['regen', A]])
    expect(d1.layers.height).toBeDefined()
    waiting[0]!.resolve()
    await p.idle()
  })

  it('retries a refused patch with the next change, from what the engine really has', async () => {
    const { p, start, calls, waiting, failPatch } = setup()
    failPatch.push(new Error('invalid terrain patch'))
    const t1 = tile(0), t2 = tile(1, 8)
    p.onChange(ev({ ...start, layers: { height: { tiles: [t1] } } }, A, 'gesture'))
    await p.idle()
    expect(p.status).toMatchObject({ state: 'error', message: 'invalid terrain patch' })
    p.onChange(ev({ ...start, layers: { height: { tiles: [t1, t2] } } }, B, 'gesture'))
    await tick()
    expect(calls.slice(-2)).toEqual([
      ['patch', { height: [{ x: 0, z: 0, values: t1.values }, { x: 1, z: 0, values: t2.values }] }],
      ['regen', { x0: 0, z0: 0, x1: 96, z1: 96 }],
    ])
    waiting[0]!.resolve()
    await p.idle()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/terrain-editor -- preview`
Expected: FAIL: the scheduler calls `setDocument` where the tests expect `patch`.

- [ ] **Step 3: Patch in the scheduler**

In `packages/terrain-editor/src/core/preview.ts`:
- Replace the imports with:

```ts
import { diffLayers, type TerrainDoc, type Vec2 } from '@elovox/terrain'
import { onlyLayersDiffer, unionArea, type Area, type AreaRect } from './area.ts'
import type { ChangeEvent } from './session.ts'
```

- In `interface TerrainTarget`, after `setDocument`, add:

```ts
  /** Applies a layer patch (a TerrainPatch) to the document the engine has. */
  patch(patch: unknown): Promise<void>
```

- In `loop`, replace

```ts
        if (doc !== this.sent) {
          await this.target.setDocument(doc)
          this.sent = doc
        }
```

with

```ts
        if (doc !== this.sent) {
          // A brush stroke changes only the layers: send the changed tiles, not the whole document.
          if (onlyLayersDiffer(doc, this.sent)) await this.target.patch(diffLayers(this.sent.layers, doc.layers))
          else await this.target.setDocument(doc)
          this.sent = doc
        }
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w @elovox/terrain-editor`
Expected: PASS.

Run: `npm run typecheck -w @elovox/terrain-editor`
Expected: no errors (`engine.terrain` has `patch` since Task 3, so `new PreviewScheduler(engine.terrain, …)` in `ui/editor.ts` still typechecks).

- [ ] **Step 5: Commit**

```bash
git add packages/terrain-editor
git commit -m "feat(terrain-editor): the preview patches layer changes instead of resending the document"
```

---

### Task 7: Brush foundations: weights, dab spacing, tile writers, sampler

**Files:**
- Create: `packages/terrain-editor/src/core/brush.ts`, `packages/terrain-editor/src/core/layerWriter.ts`, `packages/terrain-editor/src/core/sampler.ts`
- Modify: `packages/terrain-editor/src/index.ts`
- Test: `packages/terrain-editor/test/brush.test.ts`, `packages/terrain-editor/test/layerWriter.test.ts`, `packages/terrain-editor/test/sampler.test.ts`

**Interfaces:**
- Consumes: `smoothstep01`, `compileTerrain`, `sampleHeights`, `sampleDensity`, `withLayers`, `SampleGrid`, `tileKey`, `brickKey`, `BRICK_SAMPLES`, the layer tile types (`@elovox/terrain`); `onlyLayersDiffer` (Task 5).
- Produces:
  - `brush.ts`: `interface BrushSettings { radius; strength; falloff }`, `interface Point3 { x; y; z }`, `RADIUS_MIN = 2`, `RADIUS_MAX = 64`, `clampSettings(s): BrushSettings`, `brushWeight(d, s): number`, `dabSpacing(radius): number`, `class DabSpacer { constructor(spacing); to(p: Point3): Point3[] }`.
  - `layerWriter.ts`: `class TileWriter<V extends Int16Array | Uint8Array> { constructor(tiles | undefined, side, make); get(i, j); set(i, j, v); result(); changed }`, `class BrickWriter { constructor(bricks | undefined); get(sx, sy, sz); set(sx, sy, sz, v); result(); changed }`, `interface LayerLists`, `replaceLayer(layers, lists): TerrainLayers`.
  - `sampler.ts`: `class TerrainSampler { constructor({ seed, height, ops? }); readonly height; heights(doc, x0, z0, w, d): Float64Array; density(doc, g: SampleGrid): Float32Array }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/terrain-editor/test/brush.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DabSpacer, brushWeight, clampSettings, dabSpacing, type Point3 } from '../src/core/brush.ts'

describe('brushWeight', () => {
  it('is the strength inside the core, fades to 0 at the radius, and is 0 past it', () => {
    const hard = { radius: 10, strength: 0.8, falloff: 0 }
    expect(brushWeight(0, hard)).toBe(0.8)
    expect(brushWeight(10, hard)).toBe(0.8)
    expect(brushWeight(10.01, hard)).toBe(0)
    const soft = { radius: 10, strength: 1, falloff: 1 }
    expect(brushWeight(0, soft)).toBe(1)
    expect(brushWeight(5, soft)).toBeCloseTo(0.5)
    expect(brushWeight(10, soft)).toBe(0)
    const half = { radius: 10, strength: 1, falloff: 0.5 }
    expect(brushWeight(4, half)).toBe(1)
    expect(brushWeight(7.5, half)).toBeCloseTo(0.5)
  })
})

describe('clampSettings', () => {
  it('keeps every field in range', () => {
    expect(clampSettings({ radius: 999, strength: -1, falloff: 3 })).toEqual({ radius: 64, strength: 0, falloff: 1 })
    expect(clampSettings({ radius: 0.5, strength: 0.4, falloff: 0.2 })).toEqual({ radius: 2, strength: 0.4, falloff: 0.2 })
  })
})

describe('DabSpacer', () => {
  const xs = (ps: Point3[]) => ps.map((p) => Math.round(p.x * 1000) / 1000)

  it('dabs at the first point, then every `spacing` blocks', () => {
    const s = new DabSpacer(2)
    expect(xs(s.to({ x: 0, y: 0, z: 0 }))).toEqual([0])
    expect(xs(s.to({ x: 10, y: 0, z: 0 }))).toEqual([2, 4, 6, 8, 10])
  })

  it('does not depend on how the drag is split into pointer events', () => {
    const one = new DabSpacer(2), many = new DabSpacer(2)
    const a = [...one.to({ x: 0, y: 0, z: 0 }), ...one.to({ x: 9, y: 0, z: 0 })]
    const b: Point3[] = []
    for (let i = 0; i <= 18; i++) b.push(...many.to({ x: i / 2, y: 0, z: 0 }))
    expect(xs(b)).toEqual(xs(a))
  })

  it('spaces dabs in 3D', () => {
    const s = new DabSpacer(5)
    s.to({ x: 0, y: 0, z: 0 })
    expect(s.to({ x: 3, y: 4, z: 0 })).toEqual([{ x: 3, y: 4, z: 0 }])
  })

  it('spaces dabs a quarter radius apart, at least one block', () => {
    expect(dabSpacing(16)).toBe(4)
    expect(dabSpacing(2)).toBe(1)
  })
})
```

Create `packages/terrain-editor/test/layerWriter.test.ts`:

```ts
import { BRICK_VALUES, HEIGHT_VALUES, TILE } from '@elovox/terrain'
import { describe, expect, it } from 'vitest'
import { BrickWriter, TileWriter, replaceLayer } from '../src/core/layerWriter.ts'

const i16 = (n: number) => new Int16Array(n)

describe('TileWriter', () => {
  it('reads 0 where there is no tile, copies a tile on its first write and shares the rest', () => {
    const a = { x: 0, z: 0, values: i16(HEIGHT_VALUES) }
    a.values[5] = 3
    const b = { x: 2, z: 1, values: i16(HEIGHT_VALUES).fill(1) }
    const w = new TileWriter([a, b], TILE, i16)
    expect(w.get(5, 0)).toBe(3)
    expect(w.get(64, 0)).toBe(0)
    w.set(6, 0, 9)
    w.set(7, 0, 10) // reuses the copy
    const out = w.result()!
    expect(out[0]!.values[6]).toBe(9)
    expect(out[0]!.values[7]).toBe(10)
    expect(out[0]!.values[5]).toBe(3)
    expect(a.values[6]).toBe(0) // the input is untouched
    expect(out[1]).toBe(b)
    expect(w.changed).toBe(true)
  })

  it('creates tiles in order and drops tiles left all zero', () => {
    const a = { x: 0, z: 0, values: i16(HEIGHT_VALUES) }
    a.values[0] = 4
    const w = new TileWriter([a], TILE, i16)
    w.set(130, 70, 2) // tile (2, 1)
    w.set(70, 0, 1) // tile (1, 0)
    w.set(0, 0, 0) // tile (0, 0) is now all zero
    expect(w.result()!.map((t) => [t.x, t.z])).toEqual([[1, 0], [2, 1]])
    const empty = new TileWriter([a], TILE, i16)
    empty.set(0, 0, 0)
    expect(empty.result()).toBeUndefined()
  })

  it('writing 0 where there is no tile creates nothing', () => {
    const w = new TileWriter(undefined, TILE, i16)
    w.set(3, 3, 0)
    expect(w.changed).toBe(false)
    expect(w.result()).toBeUndefined()
  })
})

describe('BrickWriter', () => {
  it('reads and writes samples by global sample coordinates, sorted by y, z, x', () => {
    const w = new BrickWriter(undefined)
    w.set(9, 0, 0, 5) // brick (1, 0, 0), local (1, 0, 0)
    w.set(0, 8, 0, -3) // brick (0, 1, 0)
    w.set(0, 0, 9, 7) // brick (0, 0, 1)
    expect(w.get(9, 0, 0)).toBe(5)
    expect(w.result()!.map((b) => [b.x, b.y, b.z])).toEqual([[1, 0, 0], [0, 0, 1], [0, 1, 0]])
    expect(w.result()![0]!.values[1]).toBe(5)
    expect(w.result()![0]!.values.length).toBe(BRICK_VALUES)
  })
})

describe('replaceLayer', () => {
  it('replaces or removes one layer and keeps the others', () => {
    const height = { tiles: [{ x: 0, z: 0, values: i16(HEIGHT_VALUES).fill(1) }] }
    const density = { bricks: [] }
    expect(replaceLayer({ height, density }, { height: undefined })).toEqual({ density })
    const tiles = [{ x: 1, z: 1, values: i16(HEIGHT_VALUES).fill(2) }]
    expect(replaceLayer({ height }, { height: tiles })).toEqual({ height: { tiles } })
  })
})
```

Create `packages/terrain-editor/test/sampler.test.ts`:

```ts
import { BRICK_VALUES, HEIGHT_VALUES, compileTerrain, sampleHeights } from '@elovox/terrain'
import { describe, expect, it } from 'vitest'
import { setParam } from '../src/core/edits.ts'
import { TerrainSampler } from '../src/core/sampler.ts'
import { HEIGHT, doc, flatDoc } from './fixtures.ts'

const o = { seed: 7, height: HEIGHT }

describe('TerrainSampler', () => {
  it('reads heights before the layer through the generation code', () => {
    const d = doc()
    const t = compileTerrain(d, { seed: 7, height: HEIGHT, id: () => 0 })
    expect(new TerrainSampler(o).heights(d, 60, 60, 8, 8)).toEqual(sampleHeights(t, 60, 60, 8, 8))
  })

  it('follows op changes, and layer changes do not move the heights', () => {
    const s = new TerrainSampler(o)
    const d = doc()
    const h0 = s.heights(d, 60, 60, 4, 4)
    const painted = { ...d, layers: { height: { tiles: [{ x: 0, z: 0, values: new Int16Array(HEIGHT_VALUES).fill(160) }] } } }
    expect(s.heights(painted, 60, 60, 4, 4)).toEqual(h0)
    expect(s.heights(setParam('hill', 'amplitude', 30)(d), 60, 60, 4, 4)).not.toEqual(h0)
  })

  it('reads density with the document\'s own layers', () => {
    const s = new TerrainSampler(o)
    const d = flatDoc()
    const g = { x0: 100, y0: 60, z0: 100, nx: 1, ny: 1, nz: 1, step: 2 }
    expect(s.density(d, g)[0]).toBe(-4) // air 30 blocks above the ground, clamped
    const values = new Int8Array(BRICK_VALUES)
    values[2 + 2 * 8 + 6 * 64] = 80 // sample (50, 30, 50) of brick (6, 3, 6) = block (100, 60, 100): +10 blocks
    expect(s.density({ ...d, layers: { density: { bricks: [{ x: 6, y: 3, z: 6, values }] } } }, g)[0]).toBe(6)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/terrain-editor -- brush layerWriter sampler`
Expected: FAIL (the three modules do not exist).

- [ ] **Step 3: Write `brush.ts`**

Create `packages/terrain-editor/src/core/brush.ts`:

```ts
import { smoothstep01 } from '@elovox/terrain'

/** Radius in blocks; strength and falloff in [0, 1]. Falloff is the fraction of the radius over which the weight fades to zero. */
export interface BrushSettings { radius: number; strength: number; falloff: number }
export interface Point3 { x: number; y: number; z: number }

export const RADIUS_MIN = 2
export const RADIUS_MAX = 64

/** The settings with every field clamped into its range. */
export function clampSettings(s: BrushSettings): BrushSettings {
  const c = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  return { radius: c(s.radius, RADIUS_MIN, RADIUS_MAX), strength: c(s.strength, 0, 1), falloff: c(s.falloff, 0, 1) }
}

/** The weight at distance `d` from the centre: the strength inside the core, a smoothstep down to 0 at the radius, 0 past it. */
export function brushWeight(d: number, s: BrushSettings): number {
  if (d > s.radius) return 0
  const core = s.radius * (1 - s.falloff)
  if (d <= core) return s.strength
  return s.strength * smoothstep01((s.radius - d) / (s.radius - core))
}

/** Blocks between dabs for a brush radius. */
export function dabSpacing(radius: number): number { return Math.max(1, radius * 0.25) }

/** Places dabs every `spacing` blocks along a stroke, whatever the pointer events in between. */
export class DabSpacer {
  private readonly spacing: number
  private last: Point3 | null = null
  /** Distance walked since the last dab. */
  private walked = 0

  constructor(spacing: number) { this.spacing = spacing }

  /** The dabs from the previous point to `p`. The first call dabs at `p`. */
  to(p: Point3): Point3[] {
    const a = this.last
    this.last = p
    if (!a) return [p]
    const dx = p.x - a.x, dy = p.y - a.y, dz = p.z - a.z
    const len = Math.hypot(dx, dy, dz)
    const out: Point3[] = []
    let t = this.spacing - this.walked
    while (t <= len) {
      const f = t / len
      out.push({ x: a.x + dx * f, y: a.y + dy * f, z: a.z + dz * f })
      t += this.spacing
    }
    this.walked = len - (t - this.spacing)
    return out
  }
}
```

- [ ] **Step 4: Write `layerWriter.ts`**

Create `packages/terrain-editor/src/core/layerWriter.ts`:

```ts
import { BRICK_SAMPLES, brickKey, tileKey, type BiomeTile, type DensityBrick, type HeightTile, type TerrainLayers } from '@elovox/terrain'

interface Tile<V> { x: number; z: number; values: V }

const anyNonZero = (v: ArrayLike<number>) => { for (let i = 0; i < v.length; i++) if (v[i] !== 0) return true; return false }

/**
 * Copy-on-write access to one 2D layer for one edit, in sample coordinates (columns for height, cells
 * for biome). The first write to a tile copies it (or creates it zeroed); later writes reuse the copy.
 * Tiles never written stay shared with the input, and the input is never mutated.
 */
export class TileWriter<V extends Int16Array | Uint8Array> {
  private readonly tiles = new Map<number, Tile<V>>()
  private readonly own = new Set<number>()
  private readonly side: number
  private readonly make: (n: number) => V

  constructor(tiles: readonly Tile<V>[] | undefined, side: number, make: (n: number) => V) {
    this.side = side
    this.make = make
    for (const t of tiles ?? []) this.tiles.set(tileKey(t.x, t.z), t)
  }

  /** Whether any tile was written. */
  get changed(): boolean { return this.own.size > 0 }

  get(i: number, j: number): number {
    const s = this.side
    const t = this.tiles.get(tileKey(Math.floor(i / s), Math.floor(j / s)))
    return t ? t.values[(i % s) + (j % s) * s]! : 0
  }

  set(i: number, j: number, v: number): void {
    const s = this.side
    const x = Math.floor(i / s), z = Math.floor(j / s), k = tileKey(x, z)
    let t = this.tiles.get(k)
    if (!t || !this.own.has(k)) {
      if (!t && v === 0) return
      const values = this.make(s * s)
      if (t) values.set(t.values)
      t = { x, z, values }
      this.tiles.set(k, t)
      this.own.add(k)
    }
    t.values[(i % s) + (j % s) * s] = v
  }

  /** The new tile list: sorted by z then x, all-zero tiles dropped; undefined when empty. */
  result(): Tile<V>[] | undefined {
    const out = [...this.tiles.values()].filter((t) => anyNonZero(t.values))
    out.sort((a, b) => a.z - b.z || a.x - b.x)
    return out.length > 0 ? out : undefined
  }
}

/** Copy-on-write access to the density bricks for one edit, by global sample coordinates. */
export class BrickWriter {
  private readonly bricks = new Map<number, DensityBrick>()
  private readonly own = new Set<number>()

  constructor(bricks: readonly DensityBrick[] | undefined) {
    for (const b of bricks ?? []) this.bricks.set(brickKey(b.x, b.y, b.z), b)
  }

  get changed(): boolean { return this.own.size > 0 }

  get(sx: number, sy: number, sz: number): number {
    const S = BRICK_SAMPLES
    const b = this.bricks.get(brickKey(Math.floor(sx / S), Math.floor(sy / S), Math.floor(sz / S)))
    return b ? b.values[(sx % S) + (sz % S) * S + (sy % S) * S * S]! : 0
  }

  set(sx: number, sy: number, sz: number, v: number): void {
    const S = BRICK_SAMPLES
    const x = Math.floor(sx / S), y = Math.floor(sy / S), z = Math.floor(sz / S), k = brickKey(x, y, z)
    let b = this.bricks.get(k)
    if (!b || !this.own.has(k)) {
      if (!b && v === 0) return
      const values = new Int8Array(S * S * S)
      if (b) values.set(b.values)
      b = { x, y, z, values }
      this.bricks.set(k, b)
      this.own.add(k)
    }
    b.values[(sx % S) + (sz % S) * S + (sy % S) * S * S] = v
  }

  /** The new brick list: sorted by y, z, x, all-zero bricks dropped; undefined when empty. */
  result(): DensityBrick[] | undefined {
    const out = [...this.bricks.values()].filter((b) => anyNonZero(b.values))
    out.sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)
    return out.length > 0 ? out : undefined
  }
}

/** New lists for some layers; a layer given as undefined is removed. */
export interface LayerLists { height?: HeightTile[] | undefined; biome?: BiomeTile[] | undefined; density?: DensityBrick[] | undefined }

/** `layers` with the given layers replaced. */
export function replaceLayer(layers: TerrainLayers, lists: LayerLists): TerrainLayers {
  const out: TerrainLayers = { ...layers }
  if ('height' in lists) { if (lists.height) out.height = { tiles: lists.height }; else delete out.height }
  if ('biome' in lists) { if (lists.biome) out.biome = { tiles: lists.biome }; else delete out.biome }
  if ('density' in lists) { if (lists.density) out.density = { bricks: lists.density }; else delete out.density }
  return out
}
```

- [ ] **Step 5: Write `sampler.ts`**

Create `packages/terrain-editor/src/core/sampler.ts`:

```ts
import {
  compileTerrain, sampleDensity, sampleHeights, withLayers,
  type CompiledTerrain, type OpRegistry, type SampleGrid, type TerrainDoc,
} from '@elovox/terrain'
import { onlyLayersDiffer } from './area.ts'

export interface SamplerOptions {
  /** The engine's seed: base heights depend on it. */
  seed: number
  /** World height. */
  height: number
  ops?: OpRegistry
}

/**
 * Reads the terrain the brushes paint over straight from the document, through the generation code:
 * the world lags a step behind during a stroke. Compiles again only when something other than the
 * layers changed.
 */
export class TerrainSampler {
  readonly height: number
  private readonly o: SamplerOptions
  private compiled: CompiledTerrain | null = null
  private source: TerrainDoc | null = null

  constructor(o: SamplerOptions) {
    this.o = o
    this.height = o.height
  }

  /** Height before the height layer for columns [x0, x0 + w) × [z0, z0 + d); index (x - x0) + (z - z0) * w. */
  heights(doc: TerrainDoc, x0: number, z0: number, w: number, d: number): Float64Array {
    return sampleHeights(this.terrain(doc), x0, z0, w, d)
  }

  /** The total density (what the pipeline thresholds) on a grid, with the document's layers. */
  density(doc: TerrainDoc, g: SampleGrid): Float32Array {
    return sampleDensity(withLayers(this.terrain(doc), doc.layers), g)
  }

  private terrain(doc: TerrainDoc): CompiledTerrain {
    if (!this.compiled || !this.source || !onlyLayersDiffer(doc, this.source)) {
      // Block ids do not matter for heights and densities.
      this.compiled = compileTerrain(doc, { seed: this.o.seed, height: this.o.height, id: () => 0, ops: this.o.ops })
    }
    this.source = doc
    return this.compiled
  }
}
```

- [ ] **Step 6: Export**

In `packages/terrain-editor/src/index.ts`, add:

```ts
export { DabSpacer, RADIUS_MAX, RADIUS_MIN, brushWeight, clampSettings, dabSpacing, type BrushSettings, type Point3 } from './core/brush.ts'
export { BrickWriter, TileWriter, replaceLayer, type LayerLists } from './core/layerWriter.ts'
export { TerrainSampler, type SamplerOptions } from './core/sampler.ts'
```

- [ ] **Step 7: Run the tests**

Run: `npm test -w @elovox/terrain-editor`
Expected: PASS.

Run: `npm run typecheck -w @elovox/terrain-editor`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/terrain-editor
git commit -m "feat(terrain-editor): brush weights, dab spacing, copy-on-write tile writers and a terrain sampler"
```

---

### Task 8: Height and biome brushes

**Files:**
- Create: `packages/terrain-editor/src/core/heightBrush.ts`, `packages/terrain-editor/src/core/biomeBrush.ts`
- Modify: `packages/terrain-editor/src/index.ts`
- Test: `packages/terrain-editor/test/heightBrush.test.ts`, `packages/terrain-editor/test/biomeBrush.test.ts`

**Interfaces:**
- Consumes: `brushWeight`, `BrushSettings`, `TileWriter`, `replaceLayer`, `TerrainSampler` (Task 7); `TILE`, `HEIGHT_SCALE`, `BIOME_CELL`, `BIOME_TILE` (`@elovox/terrain`).
- Produces:
  - `type HeightTool = 'raise' | 'smooth' | 'flatten'`, `HEIGHT_TOOLS`, `interface HeightDab { tool; x; z; settings; invert?; target? }`, `heightDab(doc, sampler, dab): TerrainLayers`, `heightAt(doc, sampler, x, z): number`.
  - `interface BiomeDab { x; z; radius; value }`, `biomeDab(doc, dab): TerrainLayers`.
  - Both dab functions return `doc.layers` itself when nothing changes.

- [ ] **Step 1: Write the failing tests**

Create `packages/terrain-editor/test/heightBrush.test.ts`:

```ts
import { HEIGHT_VALUES, TILE, type HeightTile, type TerrainDoc, type TerrainLayers } from '@elovox/terrain'
import { describe, expect, it } from 'vitest'
import { heightAt, heightDab } from '../src/core/heightBrush.ts'
import { TileWriter } from '../src/core/layerWriter.ts'
import { TerrainSampler } from '../src/core/sampler.ts'
import { HEIGHT, flatDoc } from './fixtures.ts'

const sampler = () => new TerrainSampler({ seed: 1, height: HEIGHT })
const value = (l: TerrainLayers, x: number, z: number) => new TileWriter(l.height?.tiles, TILE, (n) => new Int16Array(n)).get(x, z)
const hard = (radius: number, strength = 1) => ({ radius, strength, falloff: 0 })

/** Flat ground with a 10-block spike at column (100, 100). */
function spiked(): TerrainDoc {
  const values = new Int16Array(HEIGHT_VALUES)
  values[(100 - 64) + (100 - 64) * 64] = 160
  return { ...flatDoc(), layers: { height: { tiles: [{ x: 1, z: 1, values }] } } }
}

describe('heightDab', () => {
  it('raises every column within the radius by the weight, in 1/16 block', () => {
    const l = heightDab(flatDoc(), sampler(), { tool: 'raise', x: 128.5, z: 128.5, settings: hard(4) })
    expect(value(l, 128, 128)).toBe(16)
    expect(value(l, 132, 128)).toBe(16)
    expect(value(l, 133, 128)).toBe(0)
  })

  it('lowers when inverted, and fades with the falloff', () => {
    expect(value(heightDab(flatDoc(), sampler(), { tool: 'raise', x: 128.5, z: 128.5, settings: hard(4), invert: true }), 128, 128)).toBe(-16)
    const soft = heightDab(flatDoc(), sampler(), { tool: 'raise', x: 128.5, z: 128.5, settings: { radius: 8, strength: 1, falloff: 1 } })
    expect(value(soft, 132, 128)).toBe(8)
  })

  it('smooths toward the mean of the 3 × 3 neighbours', () => {
    // H = 40 at the spike, 30 around: the mean is 280 / 9; 160 + 16 · (280 / 9 − 40) ≈ 17.8 → 18.
    const l = heightDab(spiked(), sampler(), { tool: 'smooth', x: 100.5, z: 100.5, settings: hard(0.5) })
    expect(value(l, 100, 100)).toBe(18)
  })

  it('flattens toward the target and drops a tile left all zero', () => {
    const l = heightDab(spiked(), sampler(), { tool: 'flatten', x: 100.5, z: 100.5, settings: hard(0.5), target: 30 })
    expect(l.height).toBeUndefined()
  })

  it('clamps to the Int16 range and returns the same layers when nothing changes', () => {
    const values = new Int16Array(HEIGHT_VALUES)
    values[10 + 10 * 64] = 32767
    const d = { ...flatDoc(), layers: { height: { tiles: [{ x: 0, z: 0, values }] } } }
    expect(heightDab(d, sampler(), { tool: 'raise', x: 10.5, z: 10.5, settings: hard(0.5) })).toBe(d.layers)
  })

  it('shares untouched tiles and never mutates its input', () => {
    const a: HeightTile = { x: 0, z: 0, values: new Int16Array(HEIGHT_VALUES).fill(1) }
    const b: HeightTile = { x: 3, z: 3, values: new Int16Array(HEIGHT_VALUES).fill(2) }
    const d = { ...flatDoc(), layers: { height: { tiles: [a, b] } } }
    const l = heightDab(d, sampler(), { tool: 'raise', x: 10.5, z: 10.5, settings: hard(3) })
    expect(l.height!.tiles[1]).toBe(b)
    expect(l.height!.tiles[0]).not.toBe(a)
    expect(a.values[10 + 10 * 64]).toBe(1)
  })

  it('paints only inside the world at its edge, and ignores a dab outside it', () => {
    const l = heightDab(flatDoc(), sampler(), { tool: 'raise', x: 2, z: 2, settings: hard(8) })
    expect(value(l, 0, 0)).toBe(16)
    expect(l.height!.tiles.every((t) => t.x >= 0 && t.z >= 0)).toBe(true)
    const d = flatDoc()
    expect(heightDab(d, sampler(), { tool: 'raise', x: -50, z: -50, settings: hard(8) })).toBe(d.layers)
  })
})

describe('heightAt', () => {
  it('is the ground before the layer plus the layer', () => {
    expect(heightAt(spiked(), sampler(), 100.7, 100.2)).toBe(40)
    expect(heightAt(spiked(), sampler(), 5, 5)).toBe(30)
  })
})
```

Create `packages/terrain-editor/test/biomeBrush.test.ts`:

```ts
import { BIOME_TILE, type TerrainLayers } from '@elovox/terrain'
import { describe, expect, it } from 'vitest'
import { biomeDab } from '../src/core/biomeBrush.ts'
import { TileWriter } from '../src/core/layerWriter.ts'
import { flatDoc } from './fixtures.ts'

const cell = (l: TerrainLayers, cx: number, cz: number) => new TileWriter(l.biome?.tiles, BIOME_TILE, (n) => new Uint8Array(n)).get(cx, cz)

describe('biomeDab', () => {
  it('paints every cell whose centre lies within the radius', () => {
    // Centre (130, 130), radius 4: cell (32, 32) has its centre there; (31, 32) and (33, 32) are 4 away.
    const l = biomeDab(flatDoc(), { x: 130, z: 130, radius: 4, value: 2 })
    for (const [cx, cz] of [[31, 32], [32, 32], [33, 32], [32, 31], [32, 33]] as const) expect(cell(l, cx, cz)).toBe(2)
    expect(cell(l, 31, 31)).toBe(0)
    expect(cell(l, 34, 32)).toBe(0)
  })

  it('erases back to unpainted and drops the empty tile', () => {
    const painted = { ...flatDoc(), layers: biomeDab(flatDoc(), { x: 130, z: 130, radius: 4, value: 2 }) }
    expect(biomeDab(painted, { x: 130, z: 130, radius: 6, value: 0 }).biome).toBeUndefined()
  })

  it('stays inside the world and returns the same layers when nothing changes', () => {
    const l = biomeDab(flatDoc(), { x: 255, z: 255, radius: 8, value: 1 })
    expect(cell(l, 63, 63)).toBe(1)
    const d = { ...flatDoc(), layers: l }
    expect(biomeDab(d, { x: 255, z: 255, radius: 8, value: 1 })).toBe(d.layers)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/terrain-editor -- heightBrush biomeBrush`
Expected: FAIL (the modules do not exist).

- [ ] **Step 3: Write the height brush**

Create `packages/terrain-editor/src/core/heightBrush.ts`:

```ts
import { HEIGHT_SCALE, TILE, type TerrainDoc, type TerrainLayers } from '@elovox/terrain'
import { brushWeight, type BrushSettings } from './brush.ts'
import { TileWriter, replaceLayer } from './layerWriter.ts'
import type { TerrainSampler } from './sampler.ts'

export type HeightTool = 'raise' | 'smooth' | 'flatten'
export const HEIGHT_TOOLS: readonly HeightTool[] = ['raise', 'smooth', 'flatten']

const MIN = -32768, MAX = 32767

export interface HeightDab {
  tool: HeightTool
  /** Brush centre in blocks. */
  x: number
  z: number
  settings: BrushSettings
  /** raise: lower instead. */
  invert?: boolean
  /** flatten: the height to level to (heightAt where the stroke began). */
  target?: number
}

const writer = (doc: TerrainDoc) => new TileWriter(doc.layers.height?.tiles, TILE, (n) => new Int16Array(n))

/** The ground height of the column under (x, z): before the height layer, plus the layer. */
export function heightAt(doc: TerrainDoc, sampler: TerrainSampler, x: number, z: number): number {
  const ix = Math.min(doc.size[0] - 1, Math.max(0, Math.floor(x)))
  const iz = Math.min(doc.size[1] - 1, Math.max(0, Math.floor(z)))
  return sampler.heights(doc, ix, iz, 1, 1)[0]! + writer(doc).get(ix, iz) / HEIGHT_SCALE
}

/** One dab of the height brush: the new layers, sharing every untouched tile; `doc.layers` itself if nothing changed. */
export function heightDab(doc: TerrainDoc, sampler: TerrainSampler, dab: HeightDab): TerrainLayers {
  const [sx, sz] = doc.size
  const r = dab.settings.radius
  const x0 = Math.max(0, Math.floor(dab.x - r)), x1 = Math.min(sx - 1, Math.floor(dab.x + r))
  const z0 = Math.max(0, Math.floor(dab.z - r)), z1 = Math.min(sz - 1, Math.floor(dab.z + r))
  if (x0 > x1 || z0 > z1) return doc.layers
  // One column of margin: smoothing reads each column's neighbours.
  const px0 = Math.max(0, x0 - 1), pz0 = Math.max(0, z0 - 1), px1 = Math.min(sx - 1, x1 + 1), pz1 = Math.min(sz - 1, z1 + 1)
  const pw = px1 - px0 + 1
  const tiles = writer(doc)
  const ground = sampler.heights(doc, px0, pz0, pw, pz1 - pz0 + 1)
  const H = (x: number, z: number) => ground[(x - px0) + (z - pz0) * pw]! + tiles.get(x, z) / HEIGHT_SCALE
  const writes: number[] = [] // x, z, value; applied after every read, so smoothing reads the old heights
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    const w = brushWeight(Math.hypot(x + 0.5 - dab.x, z + 0.5 - dab.z), dab.settings)
    if (w <= 0) continue
    const h = H(x, z)
    let delta: number
    if (dab.tool === 'raise') delta = dab.invert ? -w : w
    else if (dab.tool === 'flatten') delta = w * ((dab.target ?? h) - h)
    else {
      let sum = 0, n = 0
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, nz = z + dz
        if (nx < px0 || nx > px1 || nz < pz0 || nz > pz1) continue
        sum += H(nx, nz)
        n++
      }
      delta = w * (sum / n - h)
    }
    const old = tiles.get(x, z)
    const v = Math.min(MAX, Math.max(MIN, Math.round(old + delta * HEIGHT_SCALE)))
    if (v !== old) writes.push(x, z, v)
  }
  for (let i = 0; i < writes.length; i += 3) tiles.set(writes[i]!, writes[i + 1]!, writes[i + 2]!)
  return tiles.changed ? replaceLayer(doc.layers, { height: tiles.result() }) : doc.layers
}
```

- [ ] **Step 4: Write the biome brush**

Create `packages/terrain-editor/src/core/biomeBrush.ts`:

```ts
import { BIOME_CELL, BIOME_TILE, type TerrainDoc, type TerrainLayers } from '@elovox/terrain'
import { TileWriter, replaceLayer } from './layerWriter.ts'

export interface BiomeDab {
  /** Brush centre in blocks. */
  x: number
  z: number
  radius: number
  /** 0 erases; k paints biomes[k - 1]. */
  value: number
}

/** One dab of the biome brush: every 4 × 4 cell whose centre lies within the radius takes `value`. */
export function biomeDab(doc: TerrainDoc, dab: BiomeDab): TerrainLayers {
  const cellsX = Math.ceil(doc.size[0] / BIOME_CELL), cellsZ = Math.ceil(doc.size[1] / BIOME_CELL)
  const r = dab.radius
  const c0 = Math.max(0, Math.floor((dab.x - r) / BIOME_CELL)), c1 = Math.min(cellsX - 1, Math.floor((dab.x + r) / BIOME_CELL))
  const k0 = Math.max(0, Math.floor((dab.z - r) / BIOME_CELL)), k1 = Math.min(cellsZ - 1, Math.floor((dab.z + r) / BIOME_CELL))
  if (c0 > c1 || k0 > k1) return doc.layers
  const tiles = new TileWriter(doc.layers.biome?.tiles, BIOME_TILE, (n) => new Uint8Array(n))
  const half = BIOME_CELL / 2
  for (let cz = k0; cz <= k1; cz++) for (let cx = c0; cx <= c1; cx++) {
    if (Math.hypot(cx * BIOME_CELL + half - dab.x, cz * BIOME_CELL + half - dab.z) > r) continue
    if (tiles.get(cx, cz) !== dab.value) tiles.set(cx, cz, dab.value)
  }
  return tiles.changed ? replaceLayer(doc.layers, { biome: tiles.result() }) : doc.layers
}
```

- [ ] **Step 5: Export**

In `packages/terrain-editor/src/index.ts`, add:

```ts
export { HEIGHT_TOOLS, heightAt, heightDab, type HeightDab, type HeightTool } from './core/heightBrush.ts'
export { biomeDab, type BiomeDab } from './core/biomeBrush.ts'
```

- [ ] **Step 6: Run the tests**

Run: `npm test -w @elovox/terrain-editor`
Expected: PASS.

Run: `npm run typecheck -w @elovox/terrain-editor`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/terrain-editor
git commit -m "feat(terrain-editor): height (raise, smooth, flatten) and biome (paint, erase) brushes"
```

---

### Task 9: Density brush, and brushes always yield a valid document

**Files:**
- Create: `packages/terrain-editor/src/core/densityBrush.ts`
- Modify: `packages/terrain-editor/src/index.ts`
- Test: `packages/terrain-editor/test/densityBrush.test.ts`

**Interfaces:**
- Consumes: `brushWeight`, `BrushSettings`, `BrickWriter`, `replaceLayer`, `TerrainSampler` (`.height`, `.density`) (Task 7); `heightDab`, `biomeDab` (Task 8, in the property test); `BRICK_SAMPLES`, `BRICK_SPACING`, `BRICK_SPAN`, `DENSITY_SCALE` (`@elovox/terrain`).
- Produces: `type DensityTool = 'add' | 'smooth'`, `DENSITY_TOOLS`, `interface DensityDab { tool; x; y; z; settings; invert? }`, `densityDab(doc, sampler, dab): TerrainLayers` (returns `doc.layers` itself when nothing changes).

- [ ] **Step 1: Write the failing tests**

Create `packages/terrain-editor/test/densityBrush.test.ts`:

```ts
import { BRICK_VALUES, validateTerrainDoc, type TerrainDoc, type TerrainLayers } from '@elovox/terrain'
import { describe, expect, it } from 'vitest'
import { biomeDab } from '../src/core/biomeBrush.ts'
import { densityDab } from '../src/core/densityBrush.ts'
import { heightDab } from '../src/core/heightBrush.ts'
import { BrickWriter } from '../src/core/layerWriter.ts'
import { TerrainSampler } from '../src/core/sampler.ts'
import { HEIGHT, SIZE, doc, flatDoc } from './fixtures.ts'

const sampler = () => new TerrainSampler({ seed: 1, height: HEIGHT })
const sample = (l: TerrainLayers, sx: number, sy: number, sz: number) => new BrickWriter(l.density?.bricks).get(sx, sy, sz)
const hard = (radius: number) => ({ radius, strength: 1, falloff: 0 })

/** Flat ground at 30 with one density sample: (50, 30, 50) = block (100, 60, 100). */
function withSample(v: number): TerrainDoc {
  const values = new Int8Array(BRICK_VALUES)
  values[2 + 2 * 8 + 6 * 64] = v
  return { ...flatDoc(), layers: { density: { bricks: [{ x: 6, y: 3, z: 6, values }] } } }
}

describe('densityDab', () => {
  it('adds 2 blocks × weight to the samples within the radius', () => {
    const l = densityDab(flatDoc(), sampler(), { tool: 'add', x: 100, y: 60, z: 100, settings: hard(1) })
    expect(sample(l, 50, 30, 50)).toBe(16)
    expect(sample(l, 51, 30, 50)).toBe(0)
  })

  it('carves when inverted and clamps to the Int8 range', () => {
    const l = densityDab(withSample(-120), sampler(), { tool: 'add', x: 100, y: 60, z: 100, settings: hard(1), invert: true })
    expect(sample(l, 50, 30, 50)).toBe(-128)
  })

  it('removes a brick that ends up all zero', () => {
    const d = flatDoc()
    const s = sampler()
    const added = { ...d, layers: densityDab(d, s, { tool: 'add', x: 100, y: 60, z: 100, settings: hard(1) }) }
    expect(densityDab(added, s, { tool: 'add', x: 100, y: 60, z: 100, settings: hard(1), invert: true }).density).toBeUndefined()
  })

  it('smooths toward the mean of the 3 × 3 × 3 total density', () => {
    // Air around (density −4); the sample itself is −4 + 10 = 6. Mean (6 − 26 · 4) / 27; 80 + 8 · (mean − 6) ≈ 2.96 → 3.
    const l = densityDab(withSample(80), sampler(), { tool: 'smooth', x: 100, y: 60, z: 100, settings: hard(1) })
    expect(sample(l, 50, 30, 50)).toBe(3)
  })

  it('paints only inside the world, and ignores a dab outside it', () => {
    const l = densityDab(flatDoc(), sampler(), { tool: 'add', x: 0, y: 0, z: 0, settings: hard(6) })
    expect(sample(l, 0, 0, 0)).toBe(16)
    expect(l.density!.bricks.every((b) => b.x >= 0 && b.y >= 0 && b.z >= 0)).toBe(true)
    const d = flatDoc()
    expect(densityDab(d, sampler(), { tool: 'add', x: -100, y: 60, z: -100, settings: hard(4) })).toBe(d.layers)
  })
})

describe('brushes keep the document valid', () => {
  it('any seeded sequence of dabs yields a normalized document validateTerrainDoc accepts', () => {
    let seed = 12345
    const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296
    const s = sampler()
    let d = doc()
    for (let step = 0; step < 150; step++) {
      const settings = { radius: 1 + rand() * 30, strength: rand(), falloff: rand() }
      const x = -20 + rand() * (SIZE[0] + 40), z = -20 + rand() * (SIZE[1] + 40), y = -10 + rand() * (HEIGHT + 20)
      const invert = rand() < 0.5
      let layers: TerrainLayers
      switch (Math.floor(rand() * 6)) {
        case 0: layers = heightDab(d, s, { tool: 'raise', x, z, settings, invert }); break
        case 1: layers = heightDab(d, s, { tool: 'smooth', x, z, settings }); break
        case 2: layers = heightDab(d, s, { tool: 'flatten', x, z, settings, target: rand() * 200 - 50 }); break
        case 3: layers = biomeDab(d, { x, z, radius: settings.radius, value: Math.floor(rand() * (d.biomes.length + 1)) }); break
        case 4: layers = densityDab(d, s, { tool: 'add', x, y, z, settings, invert }); break
        default: layers = densityDab(d, s, { tool: 'smooth', x, y, z, settings })
      }
      d = { ...d, layers }
    }
    const r = validateTerrainDoc(d, { worldHeight: HEIGHT })
    expect(r.ok ? [] : r.errors).toEqual([])
    expect(r.ok && r.doc.layers).toEqual(d.layers) // already sorted, with no all-zero tile
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/terrain-editor -- densityBrush`
Expected: FAIL (`../src/core/densityBrush.ts` does not exist).

- [ ] **Step 3: Write the density brush**

Create `packages/terrain-editor/src/core/densityBrush.ts`:

```ts
import { BRICK_SAMPLES, BRICK_SPACING, BRICK_SPAN, DENSITY_SCALE, type TerrainDoc, type TerrainLayers } from '@elovox/terrain'
import { brushWeight, type BrushSettings } from './brush.ts'
import { BrickWriter, replaceLayer } from './layerWriter.ts'
import type { TerrainSampler } from './sampler.ts'

export type DensityTool = 'add' | 'smooth'
export const DENSITY_TOOLS: readonly DensityTool[] = ['add', 'smooth']

export interface DensityDab {
  tool: DensityTool
  /** Sphere centre in blocks. */
  x: number
  y: number
  z: number
  settings: BrushSettings
  /** add: carve instead. */
  invert?: boolean
}

/** One dab of the density brush over the 2-block sample grid; `doc.layers` itself if nothing changed. */
export function densityDab(doc: TerrainDoc, sampler: TerrainSampler, dab: DensityDab): TerrainLayers {
  const S = BRICK_SPACING
  const last = (blocks: number) => Math.ceil(blocks / BRICK_SPAN) * BRICK_SAMPLES - 1
  const r = dab.settings.radius
  const lo = (c: number) => Math.max(0, Math.ceil((c - r) / S))
  const x0 = lo(dab.x), x1 = Math.min(last(doc.size[0]), Math.floor((dab.x + r) / S))
  const y0 = lo(dab.y), y1 = Math.min(last(sampler.height), Math.floor((dab.y + r) / S))
  const z0 = lo(dab.z), z1 = Math.min(last(doc.size[1]), Math.floor((dab.z + r) / S))
  if (x0 > x1 || y0 > y1 || z0 > z1) return doc.layers
  const bricks = new BrickWriter(doc.layers.density?.bricks)
  // Smoothing reads the total density with one sample of margin on every side.
  const nx = x1 - x0 + 3, ny = y1 - y0 + 3, nz = z1 - z0 + 3
  const D = dab.tool === 'smooth'
    ? sampler.density(doc, { x0: (x0 - 1) * S, y0: (y0 - 1) * S, z0: (z0 - 1) * S, nx, ny, nz, step: S })
    : null
  const at = (i: number, j: number, k: number) => D![(i - x0 + 1) + (k - z0 + 1) * nx + (j - y0 + 1) * nx * nz]!
  const writes: number[] = [] // sx, sy, sz, value
  for (let j = y0; j <= y1; j++) for (let k = z0; k <= z1; k++) for (let i = x0; i <= x1; i++) {
    const w = brushWeight(Math.hypot(i * S - dab.x, j * S - dab.y, k * S - dab.z), dab.settings)
    if (w <= 0) continue
    let delta: number // blocks
    if (dab.tool === 'add') delta = (dab.invert ? -1 : 1) * w * S
    else {
      let sum = 0
      for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) sum += at(i + di, j + dj, k + dk)
      delta = w * (sum / 27 - at(i, j, k))
    }
    const old = bricks.get(i, j, k)
    const v = Math.min(127, Math.max(-128, Math.round(old + delta * DENSITY_SCALE)))
    if (v !== old) writes.push(i, j, k, v)
  }
  for (let n = 0; n < writes.length; n += 4) bricks.set(writes[n]!, writes[n + 1]!, writes[n + 2]!, writes[n + 3]!)
  return bricks.changed ? replaceLayer(doc.layers, { density: bricks.result() }) : doc.layers
}
```

- [ ] **Step 4: Export**

In `packages/terrain-editor/src/index.ts`, add:

```ts
export { DENSITY_TOOLS, densityDab, type DensityDab, type DensityTool } from './core/densityBrush.ts'
```

- [ ] **Step 5: Run the tests**

Run: `npm test -w @elovox/terrain-editor`
Expected: PASS (the property test runs 150 dabs; it should take well under 10 s).

Run: `npm run typecheck -w @elovox/terrain-editor`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/terrain-editor
git commit -m "feat(terrain-editor): density brush (add, carve, smooth); a property test keeps brushed documents valid"
```

---

### Task 10: Brush controller, keys, and pointer wiring

**Files:**
- Create: `packages/terrain-editor/src/core/brushes.ts`
- Modify: `packages/terrain-editor/src/ui/keys.ts`, `packages/terrain-editor/src/ui/editor.ts`, `packages/terrain-editor/src/index.ts`, `apps/sandbox/src/main.ts`
- Test: `packages/terrain-editor/test/brushes.test.ts`, `packages/terrain-editor/test/keys.test.ts`

**Interfaces:**
- Consumes: `EditorSession` (`begin`, `update`, `commit`, `cancel`, `inGesture`, `doc`), `TerrainSampler`, `DabSpacer`, `dabSpacing`, `clampSettings`, `BrushSettings`, `Point3` (Task 7); `heightDab`, `heightAt`, `HeightTool`, `biomeDab` (Task 8); `densityDab`, `DensityTool` (Task 9).
- Produces:
  - `core/brushes.ts`: `type EditorMode = 'ops' | 'height' | 'biome' | 'density'`, `type BrushMode`, `type BiomeTool = 'paint' | 'erase'`, `EDITOR_MODES`, `BRUSH_TOOLS`, `interface ToolState<T> { tool: T; settings: BrushSettings }`, and `class BrushController` with `mode`, `stroking`, `current: ToolState<string> | null`, `biome`, `onChange(fn): () => void`, `setMode(m): boolean`, `setTool(t)`, `setSettings(partial)`, `setBiome(k)`, `begin(p, invert)`, `move(p, invert)`, `end()`, `cancel()`, `strokeThrough(points, invert?)`.
  - `keys.ts`: actions `'mode-ops' | 'mode-height' | 'mode-biome' | 'mode-density' | 'radius-down' | 'radius-up'` (keys 1–4, `[`, `]`).
  - `TerrainEditorOptions.seed: number` (required); `TerrainEditor.brushes: BrushController`.
  - Editor: in a brush mode the left button paints (pointer capture), op outlines and handles hide, Ctrl inverts, Shift locks the density depth; Esc cancels a stroke (outside one it returns to Ops); Ctrl+Z during a stroke cancels it.

- [ ] **Step 1: Write the failing tests**

Create `packages/terrain-editor/test/brushes.test.ts`:

```ts
import { BIOME_TILE, HEIGHT_VALUES, TILE, type TerrainDoc } from '@elovox/terrain'
import { describe, expect, it } from 'vitest'
import { BrushController } from '../src/core/brushes.ts'
import type { Point3 } from '../src/core/brush.ts'
import { TileWriter } from '../src/core/layerWriter.ts'
import { TerrainSampler } from '../src/core/sampler.ts'
import { EditorSession } from '../src/core/session.ts'
import { HEIGHT, flatDoc } from './fixtures.ts'

function setup(d: TerrainDoc = flatDoc()) {
  const session = new EditorSession(d, { worldHeight: HEIGHT })
  const b = new BrushController(session, new TerrainSampler({ seed: 1, height: HEIGHT }))
  return { session, b }
}
/** Nine points from (x0, z) to (x1, z). */
const line = (z: number, x0: number, x1: number, y = 0): Point3[] => Array.from({ length: 9 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / 8, y, z }))
const height = (d: TerrainDoc, x: number, z: number) => new TileWriter(d.layers.height?.tiles, TILE, (n) => new Int16Array(n)).get(x, z)

describe('BrushController', () => {
  it('does nothing in ops mode', () => {
    const { session, b } = setup()
    b.strokeThrough(line(100.5, 100.5, 140.5))
    expect(session.canUndo).toBe(false)
    expect(b.current).toBeNull()
  })

  it('raises the ground along a stroke as one undo step', () => {
    const { session, b } = setup()
    b.setMode('height')
    b.setSettings({ radius: 4, strength: 1, falloff: 0 })
    b.strokeThrough(line(100.5, 100.5, 140.5))
    expect(height(session.doc, 120, 100)).toBeGreaterThan(0)
    expect(b.stroking).toBe(false)
    session.undo()
    expect(session.doc.layers).toEqual({})
    expect(session.canUndo).toBe(false)
  })

  it('flattens toward the height where the stroke began', () => {
    const raised = { ...flatDoc(), layers: { height: { tiles: [{ x: 1, z: 1, values: new Int16Array(HEIGHT_VALUES).fill(32) }] } } } // +2 over 64..127
    const { session, b } = setup(raised)
    b.setMode('height')
    b.setTool('flatten')
    b.setSettings({ radius: 4, strength: 1, falloff: 0 })
    b.strokeThrough(line(90.5, 30.5, 90.5)) // starts on plain ground (30)
    expect(height(session.doc, 90, 90)).toBe(0)
    expect(height(session.doc, 120, 120)).toBe(32)
  })

  it('paints the chosen biome, and erase clears it', () => {
    const { session, b } = setup()
    b.setMode('biome')
    b.setBiome(2)
    b.setSettings({ radius: 8 })
    b.strokeThrough(line(130, 120, 140))
    expect(new TileWriter(session.doc.layers.biome?.tiles, BIOME_TILE, (n) => new Uint8Array(n)).get(32, 32)).toBe(2)
    b.setTool('erase')
    b.strokeThrough(line(130, 110, 150))
    expect(session.doc.layers.biome).toBeUndefined()
  })

  it('carves density when inverted', () => {
    const { session, b } = setup()
    b.setMode('density')
    b.setSettings({ radius: 3, strength: 1, falloff: 0 })
    b.strokeThrough([{ x: 100, y: 28, z: 100 }, { x: 106, y: 28, z: 100 }], true)
    expect(session.doc.layers.density!.bricks.some((br) => br.values.some((v) => v < 0))).toBe(true)
  })

  it('does not change mode during a stroke', () => {
    const { b } = setup()
    b.setMode('height')
    b.begin({ x: 100, y: 0, z: 100 }, false)
    expect(b.setMode('biome')).toBe(false)
    expect(b.mode).toBe('height')
    b.end()
    expect(b.setMode('biome')).toBe(true)
  })

  it('a Ctrl+Z mid-stroke cancels the stroke; later moves do nothing and do not throw', () => {
    const { session, b } = setup()
    const before = session.doc
    b.setMode('height')
    b.begin({ x: 100, y: 0, z: 100 }, false)
    b.move({ x: 110, y: 0, z: 100 }, false)
    expect(session.doc).not.toBe(before)
    session.undo() // during a gesture this cancels it
    expect(session.doc).toBe(before)
    expect(() => b.move({ x: 120, y: 0, z: 100 }, false)).not.toThrow()
    b.end()
    expect(session.doc).toBe(before)
    expect(session.canUndo).toBe(false)
    expect(b.stroking).toBe(false)
  })

  it('clamps settings, ignores unknown tools, keeps the biome in range and reports changes', () => {
    const { b } = setup()
    let changes = 0
    b.onChange(() => changes++)
    b.setMode('density')
    b.setSettings({ radius: 999, strength: -1 })
    expect(b.current!.settings).toMatchObject({ radius: 64, strength: 0 })
    b.setTool('raise')
    expect(b.current!.tool).toBe('add')
    b.setBiome(9)
    expect(b.biome).toBe(2) // the fixture has 2 biomes
    expect(changes).toBe(3)
  })
})
```

In `packages/terrain-editor/test/keys.test.ts`, add inside `describe('actionFor', …)`:

```ts
  it('maps the mode and radius keys, but not with a modifier or while typing', () => {
    expect(['1', '2', '3', '4'].map((k) => actionFor(key(k), false))).toEqual(['mode-ops', 'mode-height', 'mode-biome', 'mode-density'])
    expect(actionFor(key('['), false)).toBe('radius-down')
    expect(actionFor(key(']'), false)).toBe('radius-up')
    expect(actionFor(key('2', { ctrlKey: true }), false)).toBeNull()
    expect(actionFor(key('2'), true)).toBeNull()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/terrain-editor -- brushes keys`
Expected: FAIL (`../src/core/brushes.ts` does not exist; the new keys map to null).

- [ ] **Step 3: Write the controller**

Create `packages/terrain-editor/src/core/brushes.ts`:

```ts
import type { TerrainDoc, TerrainLayers } from '@elovox/terrain'
import { biomeDab } from './biomeBrush.ts'
import { DabSpacer, clampSettings, dabSpacing, type BrushSettings, type Point3 } from './brush.ts'
import { densityDab, type DensityTool } from './densityBrush.ts'
import { heightAt, heightDab, type HeightTool } from './heightBrush.ts'
import type { TerrainSampler } from './sampler.ts'
import type { EditorSession } from './session.ts'

export type EditorMode = 'ops' | 'height' | 'biome' | 'density'
export type BrushMode = Exclude<EditorMode, 'ops'>
export type BiomeTool = 'paint' | 'erase'
export const EDITOR_MODES: readonly EditorMode[] = ['ops', 'height', 'biome', 'density']
export const BRUSH_TOOLS: { readonly height: readonly HeightTool[]; readonly biome: readonly BiomeTool[]; readonly density: readonly DensityTool[] } = {
  height: ['raise', 'smooth', 'flatten'],
  biome: ['paint', 'erase'],
  density: ['add', 'smooth'],
}

export interface ToolState<T extends string> { tool: T; settings: BrushSettings }
interface Tools { height: ToolState<HeightTool>; biome: ToolState<BiomeTool>; density: ToolState<DensityTool> }

function defaultTools(): Tools {
  return {
    height: { tool: 'raise', settings: { radius: 12, strength: 0.5, falloff: 0.6 } },
    biome: { tool: 'paint', settings: { radius: 12, strength: 1, falloff: 0 } },
    density: { tool: 'add', settings: { radius: 6, strength: 0.5, falloff: 0.5 } },
  }
}

/**
 * The brush tools: the mode, each brush's tool and settings, and strokes. A stroke is one session
 * gesture (one undo step); each move places dabs along the way and updates the document once.
 */
export class BrushController {
  private readonly session: EditorSession
  private readonly sampler: TerrainSampler
  private readonly tools: Tools = defaultTools()
  private modeValue: EditorMode = 'ops'
  private biomeValue = 1
  private stroke: { spacer: DabSpacer; target: number } | null = null
  private readonly changeFns = new Set<() => void>()

  constructor(session: EditorSession, sampler: TerrainSampler) {
    this.session = session
    this.sampler = sampler
  }

  get mode(): EditorMode { return this.modeValue }
  get stroking(): boolean { return this.stroke !== null }
  /** The current brush's tool and settings; null in ops mode. */
  get current(): ToolState<string> | null { return this.modeValue === 'ops' ? null : this.tools[this.modeValue] }
  /** The biome `paint` writes: k paints biomes[k - 1]. */
  get biome(): number { return this.biomeValue }

  /** Called when the mode, a tool, a setting or the biome changes. */
  onChange(fn: () => void): () => void {
    this.changeFns.add(fn)
    return () => { this.changeFns.delete(fn) }
  }

  /** Switches mode; refused (false) during a stroke. */
  setMode(m: EditorMode): boolean {
    if (this.stroke) return false
    if (m !== this.modeValue) { this.modeValue = m; this.emit() }
    return true
  }

  /** Picks a tool of the current brush; unknown tools are ignored. */
  setTool(tool: string): void {
    const m = this.modeValue
    if (m === 'ops' || !(BRUSH_TOOLS[m] as readonly string[]).includes(tool)) return
    ;(this.tools[m] as ToolState<string>).tool = tool
    this.emit()
  }

  setSettings(s: Partial<BrushSettings>): void {
    const m = this.modeValue
    if (m === 'ops') return
    const t = this.tools[m]
    t.settings = clampSettings({ ...t.settings, ...s })
    this.emit()
  }

  setBiome(k: number): void {
    this.biomeValue = Math.max(1, Math.min(this.session.doc.biomes.length, Math.round(k)))
    this.emit()
  }

  /** Starts a stroke at `p` (and dabs there). Does nothing in ops mode or while another gesture is open. */
  begin(p: Point3, invert: boolean): void {
    if (this.modeValue === 'ops' || this.stroke || this.session.inGesture) return
    const t = this.tools[this.modeValue]
    this.session.begin(`${this.modeValue} ${t.tool}`)
    const target = this.modeValue === 'height' ? heightAt(this.session.doc, this.sampler, p.x, p.z) : 0
    this.stroke = { spacer: new DabSpacer(dabSpacing(t.settings.radius)), target }
    this.move(p, invert)
  }

  /** Continues the stroke to `p`. */
  move(p: Point3, invert: boolean): void {
    const s = this.stroke
    if (!s) return
    if (!this.session.inGesture) { this.stroke = null; return } // Esc or Ctrl+Z cancelled the gesture
    let doc = this.session.doc
    for (const q of s.spacer.to(p)) {
      const layers = this.dab(doc, q, invert, s.target)
      if (layers !== doc.layers) doc = { ...doc, layers }
    }
    if (doc !== this.session.doc) this.session.update(() => doc)
  }

  /** Ends the stroke: one undo step. */
  end(): void {
    if (!this.stroke) return
    this.stroke = null
    if (this.session.inGesture) this.session.commit()
  }

  /** Abandons the stroke: the document returns to where it began. */
  cancel(): void {
    if (!this.stroke) return
    this.stroke = null
    if (this.session.inGesture) this.session.cancel()
  }

  /** A whole stroke through `points` (tests, the e2e and scripts). */
  strokeThrough(points: readonly Point3[], invert = false): void {
    const [first, ...rest] = points
    if (!first) return
    this.begin(first, invert)
    for (const p of rest) this.move(p, invert)
    this.end()
  }

  private dab(doc: TerrainDoc, q: Point3, invert: boolean, target: number): TerrainLayers {
    switch (this.modeValue) {
      case 'height': {
        const t = this.tools.height
        return heightDab(doc, this.sampler, { tool: t.tool, x: q.x, z: q.z, settings: t.settings, invert, target })
      }
      case 'biome': {
        const t = this.tools.biome
        return biomeDab(doc, { x: q.x, z: q.z, radius: t.settings.radius, value: t.tool === 'erase' ? 0 : Math.min(this.biomeValue, doc.biomes.length) })
      }
      case 'density': {
        const t = this.tools.density
        return densityDab(doc, this.sampler, { tool: t.tool, x: q.x, y: q.y, z: q.z, settings: t.settings, invert })
      }
      default:
        return doc.layers
    }
  }

  private emit(): void { for (const fn of this.changeFns) fn() }
}
```

- [ ] **Step 4: Add the keys**

In `packages/terrain-editor/src/ui/keys.ts`:
- Replace the `Action` type with:

```ts
export type Action =
  | 'undo' | 'redo' | 'delete' | 'duplicate' | 'toggle' | 'cancel' | 'save'
  | 'mode-ops' | 'mode-height' | 'mode-biome' | 'mode-density' | 'radius-down' | 'radius-up'
```

- Replace the last two lines of `actionFor` (`if (k === 'h') return 'toggle'` and `return null`) with:

```ts
  if (k === 'h') return 'toggle'
  if (k === '1') return 'mode-ops'
  if (k === '2') return 'mode-height'
  if (k === '3') return 'mode-biome'
  if (k === '4') return 'mode-density'
  if (k === '[') return 'radius-down'
  if (k === ']') return 'radius-up'
  return null
```

- [ ] **Step 5: Wire the controller into the editor**

In `packages/terrain-editor/src/ui/editor.ts`:

1. Add imports:

```ts
import type { Point3 } from '../core/brush.ts'
import { BrushController, type EditorMode } from '../core/brushes.ts'
import { TerrainSampler } from '../core/sampler.ts'
```

2. In `interface TerrainEditorOptions`, after `doc`, add:

```ts
  /** The engine's seed: the brushes recompute base heights with it. */
  seed: number
```

3. In `interface TerrainEditor`, after `readonly preview: PreviewScheduler`, add `readonly brushes: BrushController`.

4. Right after `const session = new EditorSession(…)`, add:

```ts
  const brushes = new BrushController(session, new TerrainSampler({ seed: o.seed, height, ops: registry }))
```

5. In `flushOverlay`, replace the `overlay.draw(…)` call with:

```ts
    const ops = brushes.mode === 'ops' ? session.doc.ops : [] // brushes hide the op outlines and handles
    overlay.draw(ops.map((def) => ({ def, impl: registry.get(def.type)!, selected: def.id === session.selected, failed: def.id === failedId })), showAll && brushes.mode === 'ops')
```

6. After the `offGenerated` line, add:

```ts
  const offBrushes = brushes.onChange(() => { invalidate() })

  function setMode(m: EditorMode): void {
    if (brushes.stroking) return
    finishGesture()
    brushes.setMode(m)
  }
```

7. After `let click: ScreenPoint | null = null`, add:

```ts
  let brushPointer: number | null = null
  /** Camera distance of the stroke's first aim point: Shift keeps the density sphere there. */
  let lockDistance: number | null = null

  /**
   * Where the brush aims: just above the voxel under the pointer (height, biome), that voxel's centre
   * (density), or with `lock` during a density stroke the point at the stroke's first distance along the ray.
   */
  function aimPoint(e: { clientX: number; clientY: number }, lock: boolean): Point3 | null {
    if (brushes.mode === 'density' && lock && lockDistance !== null) {
      const ray = rayAt(camera, viewport(), local(e))
      return { x: ray.origin.x + ray.dir.x * lockDistance, y: ray.origin.y + ray.dir.y * lockDistance, z: ray.origin.z + ray.dir.z * lockDistance }
    }
    const hit = engine.pickScreen(e.clientX, e.clientY)
    if (!hit) return null
    const [x, y, z] = hit.pos
    return brushes.mode === 'density' ? { x: x + 0.5, y: y + 0.5, z: z + 0.5 } : { x: x + 0.5, y: y + 1, z: z + 0.5 }
  }

  function releaseBrush(): void {
    if (brushPointer !== null && canvas.hasPointerCapture(brushPointer)) canvas.releasePointerCapture(brushPointer)
    brushPointer = null
    lockDistance = null
  }
```

8. In `onDown`, right after `flushOverlay()`, add:

```ts
    if (brushes.mode !== 'ops') {
      const aim = aimPoint(e, false)
      if (!aim) return
      lockDistance = new Vector3().setFromMatrixPosition(camera.matrixWorld).distanceTo(new Vector3(aim.x, aim.y, aim.z))
      brushes.begin(aim, e.ctrlKey)
      brushPointer = e.pointerId
      canvas.setPointerCapture(e.pointerId)
      e.preventDefault()
      return
    }
```

9. At the top of `onMove`, add:

```ts
    if (brushPointer === e.pointerId) {
      const aim = aimPoint(e, e.shiftKey)
      if (aim) brushes.move(aim, e.ctrlKey)
      return
    }
```

10. At the top of `onUp`, add:

```ts
    if (brushPointer === e.pointerId) {
      releaseBrush()
      brushes.end()
      return
    }
```

11. Replace `onLost` with:

```ts
  const onLost = (e: PointerEvent) => {
    if (brushPointer === e.pointerId) { brushPointer = null; lockDistance = null; brushes.end() }
    if (drag && e.pointerId === drag.pointerId) finishGesture()
  }
```

12. In `onKey`'s `switch`, replace the `'cancel'`, `'undo'` and `'redo'` cases with:

```ts
      case 'cancel': {
        const busy = brushes.stroking || session.inGesture || drag !== null
        endDrag(); releaseBrush(); brushes.cancel(); session.cancel()
        if (!busy) setMode('ops') // Esc outside a stroke leaves the brushes
        break
      }
      case 'undo':
        e.preventDefault(); endDrag()
        if (brushes.stroking) { releaseBrush(); brushes.cancel() } else session.undo()
        break
      case 'redo':
        e.preventDefault(); endDrag()
        if (brushes.stroking) { releaseBrush(); brushes.cancel() } else session.redo()
        break
      case 'mode-ops': setMode('ops'); break
      case 'mode-height': setMode('height'); break
      case 'mode-biome': setMode('biome'); break
      case 'mode-density': setMode('density'); break
      case 'radius-down': case 'radius-up': {
        const c = brushes.current
        if (c) brushes.setSettings({ radius: c.settings.radius * (action === 'radius-up' ? 1.25 : 0.8) })
        break
      }
```

13. In the returned object, after `preview,`, add `brushes,`.

14. In `dispose()`, after `endDrag()`, add `releaseBrush(); brushes.cancel()`, and after `offChange(); offSelect(); offGenerated()` add `offBrushes()`.

- [ ] **Step 6: Export and pass the seed from the sandbox**

In `packages/terrain-editor/src/index.ts`, add:

```ts
export { BRUSH_TOOLS, BrushController, EDITOR_MODES, type BiomeTool, type BrushMode, type EditorMode, type ToolState } from './core/brushes.ts'
```

In `apps/sandbox/src/main.ts`:
- After `const n = worldSide(params.get('size'))`, add `const seed = Number(params.get('seed') ?? 1234)`.
- In `createEngine({ … })`, replace `seed: Number(params.get('seed') ?? 1234),` with `seed,`.
- In `createTerrainEditor(engine, { doc: terrainDoc, fileName: … })`, add `seed,` after `doc: terrainDoc,`.

- [ ] **Step 7: Run the tests and typecheck**

Run: `npm test -w @elovox/terrain-editor`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors in any workspace.

- [ ] **Step 8: Commit**

```bash
git add packages/terrain-editor apps/sandbox/src/main.ts
git commit -m "feat(terrain-editor): brush controller with strokes as undo steps, mode keys, and pointer painting"
```

---

### Task 11: Mode tabs and the brush panel

**Files:**
- Create: `packages/terrain-editor/src/ui/brushes/colors.ts`, `packages/terrain-editor/src/ui/panels/modes.ts`, `packages/terrain-editor/src/ui/panels/brushPanel.ts`
- Modify: `packages/terrain-editor/src/ui/editor.ts`
- Test: `packages/terrain-editor/test/colors.test.ts`

**Interfaces:**
- Consumes: `BrushController`, `EDITOR_MODES`, `BRUSH_TOOLS`, `BrushMode`, `EditorMode` (Task 10); `RADIUS_MIN`, `RADIUS_MAX`, `BrushSettings` (Task 7); `h`, `PANEL_STYLE` (`ui/panels/dom.ts`).
- Produces:
  - `colors.ts`: `biomeColor(k): number` (k 1-based, cycles 8 colours), `cssColor(c): string`, `heightColor(blocks): number` (white at 0, blue down, red up, full at ±8 blocks).
  - `createModeTabs(parent, select)` → `{ el, render(mode) }` with buttons `#editor-mode-ops|height|biome|density`.
  - `createBrushPanel(parent, actions)` → `{ el, render(state) }` with `#editor-brush`, tool buttons `#brush-tool-<tool>`, sliders `#brush-radius|strength|falloff` (+ `-box`), `#brush-biome`.
  - The inspector hides in brush modes and the brush panel takes its place.

- [ ] **Step 1: Write the failing colour test**

Create `packages/terrain-editor/test/colors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { biomeColor, cssColor, heightColor } from '../src/ui/brushes/colors.ts'

describe('brush colours', () => {
  it('gives each biome a swatch, cycling after eight', () => {
    expect(biomeColor(1)).not.toBe(biomeColor(2))
    expect(biomeColor(9)).toBe(biomeColor(1))
    expect(cssColor(0x0a0b0c)).toBe('#0a0b0c')
  })

  it('tints the height delta from white to blue (down) or red (up), full at 8 blocks', () => {
    expect(heightColor(0)).toBe(0xffffff)
    expect(heightColor(8)).toBe(0xe64632)
    expect(heightColor(-20)).toBe(0x286ee6)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @elovox/terrain-editor -- colors`
Expected: FAIL (the module does not exist).

- [ ] **Step 3: Write the colours**

Create `packages/terrain-editor/src/ui/brushes/colors.ts`:

```ts
/** Swatch colours for biome values (1-based), cycling. */
const BIOME_COLORS = [0x5cb85c, 0xe8c468, 0x9c7b5b, 0x8fc1e3, 0xe57fa7, 0xf0a04b, 0x9b86d1, 0x4fb3a6]

export function biomeColor(k: number): number { return BIOME_COLORS[(Math.max(1, k) - 1) % BIOME_COLORS.length]! }

export function cssColor(c: number): string { return `#${c.toString(16).padStart(6, '0')}` }

/** The tint of a height delta: white at 0, blue down, red up, full at ±8 blocks. */
export function heightColor(blocks: number): number {
  const t = Math.min(1, Math.abs(blocks) / 8)
  const fade = (c: number) => Math.round(255 + (c - 255) * t)
  const [r, g, b] = blocks < 0 ? [fade(40), fade(110), fade(230)] : [fade(230), fade(70), fade(50)]
  return (r << 16) | (g << 8) | b
}
```

- [ ] **Step 4: Write the mode tabs**

Create `packages/terrain-editor/src/ui/panels/modes.ts`:

```ts
import { EDITOR_MODES, type EditorMode } from '../../core/brushes.ts'
import { h } from './dom.ts'

const LABELS: Record<EditorMode, string> = { ops: 'Ops', height: 'Height', biome: 'Biome', density: 'Density' }

/** The editor's mode tabs: Ops and the three brushes (keys 1–4). */
export function createModeTabs(parent: HTMLElement, select: (m: EditorMode) => void): { el: HTMLElement; render(mode: EditorMode): void } {
  const buttons = EDITOR_MODES.map((m, i) => {
    const b = h('button', { id: `editor-mode-${m}`, textContent: LABELS[m], title: `${LABELS[m]} (${i + 1})` })
    b.addEventListener('click', () => select(m))
    return b
  })
  const el = h('div', { id: 'editor-modes', style: { display: 'flex', gap: '4px' } }, ...buttons)
  parent.append(el)
  return {
    el,
    render(mode) {
      EDITOR_MODES.forEach((m, i) => {
        const b = buttons[i]!
        const on = m === mode
        b.style.fontWeight = on ? '700' : '400'
        b.style.background = on ? '#ffd27a' : ''
        b.setAttribute('aria-pressed', String(on))
      })
    },
  }
}
```

- [ ] **Step 5: Write the brush panel**

Create `packages/terrain-editor/src/ui/panels/brushPanel.ts`:

```ts
import { RADIUS_MAX, RADIUS_MIN, type BrushSettings } from '../../core/brush.ts'
import { BRUSH_TOOLS, type BrushMode } from '../../core/brushes.ts'
import { biomeColor, cssColor } from '../brushes/colors.ts'
import { PANEL_STYLE, h } from './dom.ts'

export interface BrushPanelState { mode: BrushMode; tool: string; settings: BrushSettings; biomes: readonly string[]; biome: number }
export interface BrushPanelActions { tool(tool: string): void; settings(s: Partial<BrushSettings>): void; biome(k: number): void }

const TITLES: Record<BrushMode, string> = { height: 'Height brush', biome: 'Biome brush', density: 'Density brush' }
const HINTS: Record<BrushMode, string> = {
  height: 'LMB paint · Ctrl lowers · [ ] radius',
  biome: 'LMB paint · [ ] radius',
  density: 'LMB paint · Ctrl carves · Shift keeps the depth · [ ] radius',
}

/** A labelled slider plus number box; set() updates both without firing their events. */
function numberRow(key: string, label: string, min: number, max: number, step: number, input: (v: number) => void) {
  const range = h('input', { type: 'range', id: `brush-${key}`, min: String(min), max: String(max), step: String(step), style: { flex: '1', minWidth: '0' } })
  const box = h('input', { type: 'number', id: `brush-${key}-box`, min: String(min), max: String(max), step: String(step), style: { width: '64px' } })
  range.addEventListener('input', () => input(Number(range.value)))
  box.addEventListener('change', () => {
    const v = Number(box.value)
    if (box.value.trim() !== '' && Number.isFinite(v)) input(v)
  })
  const el = h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
    h('span', { textContent: label, style: { width: '70px', flex: 'none' } }), range, box)
  return {
    el,
    set(v: number) {
      range.value = String(v)
      if (document.activeElement !== box) box.value = String(Math.round(v * 100) / 100)
    },
  }
}

/** The brush settings, shown instead of the inspector in a brush mode. */
export function createBrushPanel(parent: HTMLElement, actions: BrushPanelActions): { el: HTMLElement; render(s: BrushPanelState): void } {
  const title = h('div', { style: { fontWeight: '600' } })
  const tools = h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } })
  const radius = numberRow('radius', 'radius', RADIUS_MIN, RADIUS_MAX, 1, (v) => actions.settings({ radius: v }))
  const strength = numberRow('strength', 'strength', 0, 1, 0.05, (v) => actions.settings({ strength: v }))
  const falloff = numberRow('falloff', 'falloff', 0, 1, 0.05, (v) => actions.settings({ falloff: v }))
  const biome = h('select', { id: 'brush-biome', style: { flex: '1', minWidth: '0' } })
  biome.addEventListener('change', () => actions.biome(Number(biome.value)))
  const biomeRow = h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
    h('span', { textContent: 'biome', style: { width: '70px', flex: 'none' } }), biome)
  const hint = h('div', { style: { opacity: '0.7' } })
  const el = h('div', { id: 'editor-brush', style: { ...PANEL_STYLE, display: 'none' } }, title, tools, radius.el, strength.el, falloff.el, biomeRow, hint)
  parent.append(el)

  let built = '' // the mode and biome names the buttons and options were built for
  return {
    el,
    render(s) {
      const key = `${s.mode}#${s.biomes.join('|')}`
      if (key !== built) {
        built = key
        title.textContent = TITLES[s.mode]
        hint.textContent = HINTS[s.mode]
        tools.replaceChildren(...BRUSH_TOOLS[s.mode].map((t) => {
          const b = h('button', { id: `brush-tool-${t}`, textContent: t })
          b.addEventListener('click', () => actions.tool(t))
          return b
        }))
        biome.replaceChildren(...s.biomes.map((name, i) => h('option', { value: String(i + 1), textContent: `● ${name}`, style: { color: cssColor(biomeColor(i + 1)) } })))
        const isBiome = s.mode === 'biome'
        strength.el.style.display = isBiome ? 'none' : 'flex'
        falloff.el.style.display = isBiome ? 'none' : 'flex'
        biomeRow.style.display = isBiome ? 'flex' : 'none'
      }
      for (const b of Array.from(tools.children) as HTMLElement[]) {
        const on = b.id === `brush-tool-${s.tool}`
        b.style.fontWeight = on ? '700' : '400'
        b.style.background = on ? '#ffd27a' : ''
      }
      radius.set(s.settings.radius)
      strength.set(s.settings.strength)
      falloff.set(s.settings.falloff)
      biome.value = String(s.biome)
    },
  }
}
```

- [ ] **Step 6: Mount them in the editor**

In `packages/terrain-editor/src/ui/editor.ts`:
- Add imports:

```ts
import type { BrushMode } from '../core/brushes.ts'
import { createBrushPanel } from './panels/brushPanel.ts'
import { createModeTabs } from './panels/modes.ts'
```

(`EditorMode` is already imported from `../core/brushes.ts` since Task 10; merge the two imports into one line.)

- `setMode` is a function declaration (hoisted), so it can be passed before its definition. Right after the `const inspector = createInspector(…)` statement, add:

```ts
  const tabs = createModeTabs(toolbar.el, setMode)
  const brushPanel = createBrushPanel(right, {
    tool: (t) => brushes.setTool(t),
    settings: (s) => brushes.setSettings(s),
    biome: (k) => brushes.setBiome(k),
  })

  function renderBrushes(): void {
    tabs.render(brushes.mode)
    const c = brushes.current
    inspector.el.style.display = c ? 'none' : 'grid' // both panels lay out as grids (PANEL_STYLE)
    brushPanel.el.style.display = c ? 'grid' : 'none'
    if (c) brushPanel.render({ mode: brushes.mode as BrushMode, tool: c.tool, settings: c.settings, biomes: session.doc.biomes.map((b) => b.name), biome: brushes.biome })
  }
```

- Change `const offBrushes = brushes.onChange(() => { invalidate() })` to `const offBrushes = brushes.onChange(() => { invalidate(); renderBrushes() })`.
- In the `session.on('change', …)` handler, add `renderBrushes()` after `invalidate()`.
- Change the final `renderToolbar(); renderList(); renderInspector()` line (before `return {`) to `renderToolbar(); renderList(); renderInspector(); renderBrushes()`.

- [ ] **Step 7: Run the tests and typecheck**

Run: `npm test -w @elovox/terrain-editor`
Expected: PASS.

Run: `npm run typecheck -w @elovox/terrain-editor`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/terrain-editor
git commit -m "feat(terrain-editor): mode tabs and the brush panel"
```

---

### Task 12: Brush cursors

**Files:**
- Create: `packages/terrain-editor/src/ui/brushes/cursor.ts`
- Modify: `packages/terrain-editor/src/ui/editor.ts`
- Test: `packages/terrain-editor/test/cursor.test.ts`

**Interfaces:**
- Consumes: `LIFT` (`ui/handles/overlay.ts`), `groundSampler` result `ground(x, z)`, `BIOME_CELL` (`@elovox/terrain`), `aimPoint`, `brushPointer` and `brushes` in `editor.ts` (Task 10).
- Produces: `class BrushCursor { group; lines: Vector3[][]; circle(x, z, radius, inner | null); cells(x, z, radius, cell); sphere(x, y, z, radius, locked); hide(); dispose() }`. In a brush mode the cursor follows the pointer every move, hides when the ray misses or the pointer leaves the canvas, and redraws after a regeneration and on setting changes.

- [ ] **Step 1: Write the failing test**

Create `packages/terrain-editor/test/cursor.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BrushCursor } from '../src/ui/brushes/cursor.ts'
import { LIFT } from '../src/ui/handles/overlay.ts'

describe('BrushCursor', () => {
  it('drapes a closed circle on the ground, plus an inner ring inside it', () => {
    const c = new BrushCursor(() => 30)
    c.circle(100, 100, 8, 4)
    expect(c.lines).toHaveLength(2)
    const [ring] = c.lines
    expect(ring).toHaveLength(65) // the last point repeats the first: WebGPU has no LineLoop
    for (const p of ring!) {
      expect(p.y).toBe(30 + LIFT)
      expect(Math.hypot(p.x - 100, p.z - 100)).toBeCloseTo(8)
    }
    c.circle(100, 100, 8, 8)
    expect(c.lines).toHaveLength(1)
    c.circle(100, 100, 8, null)
    expect(c.lines).toHaveLength(1)
  })

  it('outlines the biome cells whose centres lie within the radius', () => {
    const c = new BrushCursor(() => 30)
    c.cells(130, 130, 4, 4) // cells (31..33, 32), (32, 31), (32, 33)
    expect(c.lines).toHaveLength(1)
    expect(c.lines[0]).toHaveLength(5 * 8)
  })

  it('draws a sphere as three great circles', () => {
    const c = new BrushCursor(() => 0)
    c.sphere(10, 20, 30, 5, false)
    expect(c.lines).toHaveLength(3)
    for (const line of c.lines) for (const p of line) expect(Math.hypot(p.x - 10, p.y - 20, p.z - 30)).toBeCloseTo(5)
  })

  it('hides', () => {
    const c = new BrushCursor(() => 0)
    c.sphere(0, 0, 0, 5, true)
    c.hide()
    expect(c.lines).toEqual([])
    expect(c.group.children).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @elovox/terrain-editor -- cursor`
Expected: FAIL (the module does not exist).

- [ ] **Step 3: Write the cursor**

Create `packages/terrain-editor/src/ui/brushes/cursor.ts`:

```ts
import { BufferGeometry, Group, Line, LineBasicNodeMaterial, LineSegments, Vector3 } from 'three/webgpu'
import { LIFT } from '../handles/overlay.ts'

const SEGMENTS = 64
const COLOR = { ring: 0xffffff, inner: 0xffb020, cells: 0xffffff, sphere: 0x8cc8ff, locked: 0xffb020 }

/** The brush cursor, drawn over the terrain without depth test. Each draw replaces the previous one. */
export class BrushCursor {
  readonly group = new Group()
  /** What the last draw drew: each line's points (vertex pairs for the cell outlines). */
  lines: Vector3[][] = []
  private readonly ground: (x: number, z: number) => number
  private readonly materials = new Map<number, LineBasicNodeMaterial>()
  private readonly geometries: BufferGeometry[] = []

  constructor(ground: (x: number, z: number) => number) {
    this.ground = ground
    this.group.name = 'terrain-editor-brush-cursor'
  }

  /** A circle draped on the terrain, and an inner ring where the falloff begins (when it lies inside the circle). */
  circle(x: number, z: number, radius: number, inner: number | null): void {
    this.clear()
    this.line(this.draped(x, z, radius), COLOR.ring, false)
    if (inner !== null && inner > 0 && inner < radius) this.line(this.draped(x, z, inner), COLOR.inner, false)
  }

  /** The outlines of the cells (of `cell` blocks) whose centres lie within the radius. */
  cells(x: number, z: number, radius: number, cell: number): void {
    this.clear()
    const pts: Vector3[] = []
    const c0 = Math.floor((x - radius) / cell), c1 = Math.floor((x + radius) / cell)
    const k0 = Math.floor((z - radius) / cell), k1 = Math.floor((z + radius) / cell)
    for (let cz = k0; cz <= k1; cz++) for (let cx = c0; cx <= c1; cx++) {
      const mx = cx * cell + cell / 2, mz = cz * cell + cell / 2
      if (Math.hypot(mx - x, mz - z) > radius) continue
      const y = this.ground(mx, mz) + LIFT
      const a = new Vector3(cx * cell, y, cz * cell), b = new Vector3((cx + 1) * cell, y, cz * cell)
      const c = new Vector3((cx + 1) * cell, y, (cz + 1) * cell), d = new Vector3(cx * cell, y, (cz + 1) * cell)
      pts.push(a, b, b, c, c, d, d, a)
    }
    if (pts.length > 0) this.line(pts, COLOR.cells, true)
  }

  /** Three great circles of a sphere; `locked` tints them (Shift keeps the depth). */
  sphere(x: number, y: number, z: number, radius: number, locked: boolean): void {
    this.clear()
    const color = locked ? COLOR.locked : COLOR.sphere
    for (const plane of ['xz', 'xy', 'zy'] as const) {
      const pts: Vector3[] = []
      for (let i = 0; i <= SEGMENTS; i++) {
        const a = (i / SEGMENTS) * Math.PI * 2
        const u = Math.cos(a) * radius, v = Math.sin(a) * radius
        pts.push(plane === 'xz' ? new Vector3(x + u, y, z + v) : plane === 'xy' ? new Vector3(x + u, y + v, z) : new Vector3(x, y + v, z + u))
      }
      this.line(pts, color, false)
    }
  }

  hide(): void { this.clear() }

  dispose(): void {
    this.clear()
    for (const m of this.materials.values()) m.dispose()
    this.materials.clear()
    this.group.removeFromParent()
  }

  /** A closed circle on the ground; the last point repeats the first (the WebGPU renderer has no LineLoop). */
  private draped(x: number, z: number, r: number): Vector3[] {
    const pts: Vector3[] = []
    for (let i = 0; i <= SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r
      pts.push(new Vector3(px, this.ground(px, pz) + LIFT, pz))
    }
    return pts
  }

  private line(pts: Vector3[], color: number, segments: boolean): void {
    const g = new BufferGeometry().setFromPoints(pts)
    this.geometries.push(g)
    const obj = segments ? new LineSegments(g, this.material(color)) : new Line(g, this.material(color))
    obj.renderOrder = 1002
    this.group.add(obj)
    this.lines.push(pts)
  }

  private material(color: number): LineBasicNodeMaterial {
    let m = this.materials.get(color)
    if (!m) {
      m = new LineBasicNodeMaterial({ color, transparent: true, opacity: 0.9, depthTest: false })
      this.materials.set(color, m)
    }
    return m
  }

  private clear(): void {
    this.group.clear()
    for (const g of this.geometries) g.dispose()
    this.geometries.length = 0
    this.lines = []
  }
}
```

- [ ] **Step 4: Follow the pointer in the editor**

In `packages/terrain-editor/src/ui/editor.ts`:
- Add imports: `import { BrushCursor } from './brushes/cursor.ts'` and add `BIOME_CELL` to the `@elovox/terrain` import.
- After `engine.scene.add(overlay.group)`, add:

```ts
  const cursor = new BrushCursor(ground)
  engine.scene.add(cursor.group)
  /** The last aim point under the pointer, and whether it was the Shift-locked one. */
  let lastAim: { aim: Point3; locked: boolean } | null = null

  function drawCursor(): void {
    const c = brushes.current
    if (!c || !lastAim) { cursor.hide(); return }
    const { aim, locked } = lastAim
    const r = c.settings.radius
    if (brushes.mode === 'density') cursor.sphere(aim.x, aim.y, aim.z, r, locked)
    else if (brushes.mode === 'biome') cursor.cells(aim.x, aim.z, r, BIOME_CELL)
    else cursor.circle(aim.x, aim.z, r, c.settings.falloff > 0 ? r * (1 - c.settings.falloff) : null)
  }
```

- Change `const offBrushes = brushes.onChange(() => { invalidate(); renderBrushes() })` to `const offBrushes = brushes.onChange(() => { invalidate(); renderBrushes(); drawCursor() })`.
- After `const offGenerated = engine.on('generated', invalidate) …`, add `const offCursorGenerated = engine.on('generated', drawCursor) // the ground under the cursor moved`.
- At the top of `onMove`, replace the brush branch added in Task 10 (`if (brushPointer === e.pointerId) { … return }`) with:

```ts
    if (brushes.mode !== 'ops') {
      const locked = brushPointer === e.pointerId && e.shiftKey && brushes.mode === 'density'
      const aim = aimPoint(e, locked)
      lastAim = aim ? { aim, locked } : null
      drawCursor()
      if (brushPointer === e.pointerId && aim) brushes.move(aim, e.ctrlKey)
      return
    }
```

- After `canvas.addEventListener('lostpointercapture', onLost)`, add:

```ts
  const onLeave = () => { if (brushPointer === null) { lastAim = null; cursor.hide() } } // the pointer went over a panel or off the canvas
  canvas.addEventListener('pointerleave', onLeave)
```

- In `dispose()`, add `offCursorGenerated()` next to `offGenerated()`, `canvas.removeEventListener('pointerleave', onLeave)` next to the other listener removals, and `cursor.dispose()` next to `overlay.dispose()`.

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test -w @elovox/terrain-editor`
Expected: PASS.

Run: `npm run typecheck -w @elovox/terrain-editor`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/terrain-editor
git commit -m "feat(terrain-editor): brush cursors: a draped circle, biome cells, and a density sphere"
```

---

### Task 13: Layer overlay and the "show layers" toggle

**Files:**
- Create: `packages/terrain-editor/src/ui/brushes/layerOverlay.ts`
- Modify: `packages/terrain-editor/src/ui/panels/toolbar.ts`, `packages/terrain-editor/src/ui/editor.ts`
- Test: `packages/terrain-editor/test/layerOverlay.test.ts`

**Interfaces:**
- Consumes: `biomeColor`, `heightColor` (Task 11), `LIFT`, `TILE`, `BIOME_CELL`, `BIOME_TILE`, `HEIGHT_SCALE`, `TerrainLayers` (`@elovox/terrain`).
- Produces: `MAX_QUADS = 65536`; `class LayerOverlay { group; count; draw(layers, mode: 'height' | 'biome' | null); quad(i): { x; y; z; color }; dispose() }`; `ToolbarState.showLayers`, `ToolbarActions.showLayers(on)`, checkbox `#editor-showlayers`. The overlay shows only while the toggle is on and the mode is Height or Biome, and is rebuilt (at most once per frame) when the layers, the mode, the toggle or the ground change.

- [ ] **Step 1: Write the failing test**

Create `packages/terrain-editor/test/layerOverlay.test.ts`:

```ts
import { BIOME_VALUES, HEIGHT_VALUES, type TerrainLayers } from '@elovox/terrain'
import { Color } from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { biomeColor, heightColor } from '../src/ui/brushes/colors.ts'
import { LayerOverlay } from '../src/ui/brushes/layerOverlay.ts'
import { LIFT } from '../src/ui/handles/overlay.ts'

/** A colour after the mesh's round trip: sRGB hex → linear floats stored as Float32 → hex. */
function hex(c: number): number {
  const col = new Color().setHex(c)
  const f = Float32Array.of(col.r, col.g, col.b)
  return new Color(f[0], f[1], f[2]).getHex()
}

describe('LayerOverlay', () => {
  const biome = new Uint8Array(BIOME_VALUES)
  biome[0] = 1 // cell (16, 0) of tile (1, 0): centre (66, 2)
  biome[3 + 2 * 16] = 2 // cell (19, 2): centre (78, 10)
  biome[15 + 15 * 16] = 2
  const height = new Int16Array(HEIGHT_VALUES)
  height[5 + 6 * 64] = -64 // column (5, 6): the 4 × 4 block (1, 1), centre (6, 6), −4 blocks
  const layers: TerrainLayers = {
    biome: { tiles: [{ x: 1, z: 0, values: biome }] },
    height: { tiles: [{ x: 0, z: 0, values: height }] },
  }

  it('draws one quad per painted biome cell, on the ground, in its biome colour', () => {
    const o = new LayerOverlay(() => 30)
    o.draw(layers, 'biome')
    expect(o.count).toBe(3)
    const q = o.quad(0)
    expect(q).toMatchObject({ x: 66, z: 2, color: hex(biomeColor(1)) })
    expect(q.y).toBeCloseTo(30 + LIFT / 2, 4) // instance matrices are Float32
    expect(o.quad(1)).toMatchObject({ x: 78, z: 10, color: hex(biomeColor(2)) })
  })

  it('draws one quad per 4 × 4 columns holding a height delta, tinted by its largest value', () => {
    const o = new LayerOverlay(() => 30)
    o.draw(layers, 'height')
    expect(o.count).toBe(1)
    expect(o.quad(0)).toMatchObject({ x: 6, z: 6, color: hex(heightColor(-4)) })
  })

  it('clears for no mode, and each draw replaces the last', () => {
    const o = new LayerOverlay(() => 30)
    o.draw(layers, 'biome')
    o.draw(layers, null)
    expect(o.count).toBe(0)
    expect(o.group.children).toHaveLength(0)
    o.draw({}, 'height')
    expect(o.count).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @elovox/terrain-editor -- layerOverlay`
Expected: FAIL (the module does not exist).

- [ ] **Step 3: Write the overlay**

Create `packages/terrain-editor/src/ui/brushes/layerOverlay.ts`:

```ts
import { BIOME_CELL, BIOME_TILE, HEIGHT_SCALE, TILE, type TerrainLayers } from '@elovox/terrain'
import { Color, Group, InstancedMesh, Matrix4, MeshBasicNodeMaterial, PlaneGeometry } from 'three/webgpu'
import { LIFT } from '../handles/overlay.ts'
import { biomeColor, heightColor } from './colors.ts'

/** At most this many quads (a fully painted 1024² world has 65 536 biome cells). */
export const MAX_QUADS = 65536
/** Blocks per quad side: a biome cell, or 4 × 4 columns of the height layer. */
const QUAD = 4

/** Tints painted layers on the terrain: one flat quad per biome cell, or per 4 × 4 columns holding a height delta. */
export class LayerOverlay {
  readonly group = new Group()
  private readonly ground: (x: number, z: number) => number
  private readonly geometry = new PlaneGeometry(QUAD, QUAD).rotateX(-Math.PI / 2)
  private readonly material = new MeshBasicNodeMaterial({ transparent: true, opacity: 0.4, depthTest: false, depthWrite: false })
  private mesh: InstancedMesh | null = null

  constructor(ground: (x: number, z: number) => number) {
    this.ground = ground
    this.group.name = 'terrain-editor-layer-overlay'
  }

  get count(): number { return this.mesh?.count ?? 0 }

  draw(layers: TerrainLayers, mode: 'height' | 'biome' | null): void {
    this.clear()
    const quads: number[] = [] // centre x, centre z, colour
    if (mode === 'biome') {
      for (const t of layers.biome?.tiles ?? []) for (let i = 0; i < t.values.length; i++) {
        const v = t.values[i]!
        if (v === 0) continue
        quads.push(t.x * TILE + (i % BIOME_TILE) * BIOME_CELL + BIOME_CELL / 2, t.z * TILE + Math.floor(i / BIOME_TILE) * BIOME_CELL + BIOME_CELL / 2, biomeColor(v))
      }
    } else if (mode === 'height') {
      const blocks = TILE / QUAD
      for (const t of layers.height?.tiles ?? []) for (let bz = 0; bz < blocks; bz++) for (let bx = 0; bx < blocks; bx++) {
        let v = 0
        for (let dz = 0; dz < QUAD; dz++) for (let dx = 0; dx < QUAD; dx++) {
          const s = t.values[bx * QUAD + dx + (bz * QUAD + dz) * TILE]!
          if (Math.abs(s) > Math.abs(v)) v = s
        }
        if (v !== 0) quads.push(t.x * TILE + bx * QUAD + QUAD / 2, t.z * TILE + bz * QUAD + QUAD / 2, heightColor(v / HEIGHT_SCALE))
      }
    }
    const n = Math.min(MAX_QUADS, quads.length / 3)
    if (n === 0) return
    const mesh = new InstancedMesh(this.geometry, this.material, n)
    mesh.renderOrder = 999
    mesh.frustumCulled = false
    const m = new Matrix4(), c = new Color()
    for (let i = 0; i < n; i++) {
      const x = quads[i * 3]!, z = quads[i * 3 + 1]!
      mesh.setMatrixAt(i, m.makeTranslation(x, this.ground(x, z) + LIFT / 2, z))
      mesh.setColorAt(i, c.setHex(quads[i * 3 + 2]!))
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    this.group.add(mesh)
    this.mesh = mesh
  }

  /** Where quad `i` stands and its colour (for tests and debugging). */
  quad(i: number): { x: number; y: number; z: number; color: number } {
    const mesh = this.mesh
    if (!mesh || i >= mesh.count) throw new RangeError(`no quad ${i}`)
    const m = new Matrix4(), c = new Color()
    mesh.getMatrixAt(i, m)
    mesh.getColorAt(i, c)
    return { x: m.elements[12]!, y: m.elements[13]!, z: m.elements[14]!, color: c.getHex() }
  }

  dispose(): void {
    this.clear()
    this.geometry.dispose()
    this.material.dispose()
    this.group.removeFromParent()
  }

  private clear(): void {
    if (!this.mesh) return
    this.group.remove(this.mesh)
    this.mesh.dispose()
    this.mesh = null
  }
}
```

- [ ] **Step 4: Add the toggle to the toolbar**

In `packages/terrain-editor/src/ui/panels/toolbar.ts`:
- Add `showLayers: boolean` to `ToolbarState` and `showLayers(on: boolean): void` to `ToolbarActions`.
- After the `all` checkbox and its listener, add:

```ts
  const layers = h('input', { type: 'checkbox', id: 'editor-showlayers' })
  layers.addEventListener('change', () => actions.showLayers(layers.checked))
```

- Replace `h('label', {}, all, ' show all ops'))` (the last child of `el`) with:

```ts
    h('label', {}, all, ' show all ops'),
    h('label', {}, layers, ' show layers'))
```

- In `render`, add `layers.checked = s.showLayers`.

- [ ] **Step 5: Draw it from the editor**

In `packages/terrain-editor/src/ui/editor.ts`:
- Add `import { LayerOverlay } from './brushes/layerOverlay.ts'`.
- After `let showAll = false`, add `let showLayers = false`.
- After the cursor setup (Task 12), add:

```ts
  const layerOverlay = new LayerOverlay(ground)
  engine.scene.add(layerOverlay.group)
  let layersDirty = true
  const invalidateLayers = () => { layersDirty = true }
  const flushLayers = () => {
    if (!layersDirty) return
    layersDirty = false
    const mode = brushes.mode === 'height' || brushes.mode === 'biome' ? brushes.mode : null
    layerOverlay.draw(session.doc.layers, showLayers ? mode : null)
  }
```

- In `createToolbar(left, { … })`, add the action `showLayers: (on) => { showLayers = on; invalidateLayers(); renderToolbar() },`.
- In `renderToolbar`, add `showLayers` to the state object passed to `toolbar.render`.
- In `frame`, after `flushOverlay()`, add `flushLayers()`.
- Add `invalidateLayers()` to: the `session.on('change', …)` handler, the `brushes.onChange` handler, and a new `const offLayersGenerated = engine.on('generated', invalidateLayers)` after `offCursorGenerated`.
- In `dispose()`, add `offLayersGenerated()` and `layerOverlay.dispose()`.

- [ ] **Step 6: Run the tests and typecheck**

Run: `npm test -w @elovox/terrain-editor`
Expected: PASS (including the existing `keys` test's `statusText` cases; the toolbar's state type gained a field only).

Run: `npm run typecheck -w @elovox/terrain-editor`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/terrain-editor
git commit -m "feat(terrain-editor): show-layers overlay tinting painted biome cells and the height delta"
```

---

### Task 14: Sandbox hint, brush e2e, and the latency bench

**Files:**
- Modify: `apps/sandbox/src/main.ts`, `apps/sandbox/e2e/smoke.spec.ts`
- Create: `apps/sandbox/e2e/brush-bench.spec.ts`

**Interfaces:**
- Consumes: `TerrainEditor.brushes` (`setMode`, `setTool`, `setSettings`, `setBiome`, `begin`, `move`, `end`, `strokeThrough`), `TerrainEditor.preview` (`idle()`, `status`), `TerrainEditor.session` (`doc`, `canUndo`, `apply`), the DOM ids `#editor-mode-height`, `#editor-mode-biome`, `#editor-brush`, `#editor-status` (Tasks 10–13).
- Produces: an e2e that paints with the real pointer and through the API and undoes back to the original world; a bench (`BENCH=1`) printing the median, p90 and max of request → visible mesh per update for a radius-16 stroke, before and after 512² is painted.

- [ ] **Step 1: Update the hint**

In `apps/sandbox/src/main.ts`, replace the `EDIT_HINT` constant with:

```ts
const EDIT_HINT = '1–4 mode · Ops: LMB select, drag handles/outline, Shift-drag height, Alt-click remove vertex, Del, Ctrl+D, H · ' +
  'Brushes: LMB paint, Ctrl invert, Shift keep depth, [ ] radius · Ctrl+Z/Y · RMB rotate'
```

- [ ] **Step 2: Write the brush e2e**

Append to `apps/sandbox/e2e/smoke.spec.ts`:

```ts
test('terrain editor brushes paint height and biome live, and undo back to the original world', async ({ page }) => {
  const errors = watchErrors(page)
  await boot(page, '/?scene=terrain&size=256&edit')
  const idle = () => page.evaluate(() => (window as W).__elovox!.editor!.preview.idle())
  /** Top solid y on a coarse grid: changes wherever the terrain changes. */
  const heights = () => page.evaluate(() => {
    const e = (window as W).__elovox!.engine
    const out: number[] = []
    for (let z = 4; z < 256; z += 8) for (let x = 4; x < 256; x += 8) {
      let y = 127
      while (y > 0 && e.world.get(x, y, z) === 0) y--
      out.push(y)
    }
    return out
  })
  const original = await heights()

  await page.locator('#editor-mode-height').click()
  await expect(page.locator('#editor-brush')).toBeVisible()
  // A real pointer stroke across the middle of the canvas.
  const box = (await page.locator('canvas').boundingBox())!
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  await page.mouse.move(cx - 60, cy)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) await page.mouse.move(cx - 60 + i * 10, cy)
  await page.mouse.up()
  await page.waitForFunction(() => (window as W).__elovox!.editor!.session.canUndo)
  await idle()

  // A strong stroke through the API, back and forth along z = 128.
  await page.evaluate(() => {
    const b = (window as W).__elovox!.editor!.brushes
    b.setTool('raise')
    b.setSettings({ radius: 16, strength: 1, falloff: 0 })
    const pts: { x: number; y: number; z: number }[] = []
    for (let pass = 0; pass < 4; pass++) for (let x = 100; x <= 156; x += 4) pts.push({ x: pass % 2 ? 256 - x : x, y: 0, z: 128 })
    b.strokeThrough(pts)
  })
  await idle()
  expect(await heights()).not.toEqual(original)

  await page.locator('#editor-mode-biome').click()
  await page.evaluate(() => {
    const b = (window as W).__elovox!.editor!.brushes
    b.setBiome(2)
    b.setSettings({ radius: 12 })
    b.strokeThrough([{ x: 60, y: 0, z: 60 }, { x: 90, y: 0, z: 60 }])
  })
  await idle()
  expect(await page.evaluate(() => (window as W).__elovox!.editor!.session.doc.layers.biome !== undefined)).toBe(true)

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z') // biome, API stroke, pointer stroke
  await idle()
  expect(await page.evaluate(() => (window as W).__elovox!.editor!.session.doc.layers)).toEqual({})
  expect(await heights()).toEqual(original)
  await expect(page.locator('#editor-status')).not.toContainText('error')
  expect(errors).toEqual([])
})
```

- [ ] **Step 3: Write the bench**

Create `apps/sandbox/e2e/brush-bench.spec.ts`:

```ts
import { test } from '@playwright/test'
import type { Engine } from '@elovox/engine'
import type { TerrainEditor } from '@elovox/terrain-editor'

type W = Window & { __elovox?: { engine: Engine; editor: TerrainEditor | null; ready: boolean } }

test.skip(!process.env.BENCH, 'set BENCH=1 to run the brush benchmark')

test('brush stroke: request → visible mesh per update, radius 16, before and after painting 512²', async ({ page }) => {
  test.setTimeout(600_000)
  await page.goto('/?scene=terrain&edit') // the 1024² showcase
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 180_000 })

  /** 20 moves of a radius-16 raise stroke; each waits until its update is visible. */
  const stroke = () => page.evaluate(async () => {
    const ed = (window as W).__elovox!.editor!
    const b = ed.brushes
    b.setMode('height')
    b.setTool('raise')
    b.setSettings({ radius: 16, strength: 0.3, falloff: 0.5 })
    const settled = async (prev: unknown) => {
      for (;;) {
        await new Promise((r) => requestAnimationFrame(r))
        const s = ed.preview.status
        if (s.state === 'idle' && s.last && s.last !== prev && s.last.meshFrames !== undefined) return s.last
      }
    }
    const first = ed.preview.status
    let prev: unknown = first.state === 'idle' ? first.last : null
    const out: number[] = []
    b.begin({ x: 400, y: 0, z: 500 }, false)
    for (let i = 1; i <= 20; i++) {
      b.move({ x: 400 + i * 8, y: 0, z: 500 }, false)
      const last = await settled(prev)
      prev = last
      out.push(last.wallMs)
    }
    b.end()
    await ed.preview.idle()
    return out
  })
  const summary = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b)
    return { median: Math.round(s[Math.floor(s.length / 2)]!), p90: Math.round(s[Math.floor(s.length * 0.9)]!), max: Math.round(s.at(-1)!) }
  }

  const fresh = await stroke()
  await page.evaluate(async () => {
    const ed = (window as W).__elovox!.editor!
    const tiles: { x: number; z: number; values: Int16Array }[] = []
    for (let z = 4; z < 12; z++) for (let x = 4; x < 12; x++) tiles.push({ x, z, values: new Int16Array(4096).fill(16) })
    ed.session.apply('prepaint 512²', (d) => ({ ...d, layers: { ...d.layers, height: { tiles } } }))
    await ed.preview.idle()
  })
  const painted = await stroke()
  console.log(`brush bench (ms, request → visible mesh): fresh ${JSON.stringify(summary(fresh))}, after 512² painted ${JSON.stringify(summary(painted))}`)
})
```

- [ ] **Step 4: Run every suite, the e2e, and the bench**

Run: `npm test`
Expected: PASS in every workspace.

Run: `npm run typecheck`
Expected: no errors.

In `apps/sandbox`, start the dev server in another terminal with `npx vite --port 5174`, then run:

Run: `E2E_PORT=5174 npm run e2e`
Expected: every test passes, including `terrain editor brushes paint height and biome live…`; the bench is skipped.

Run: `BENCH=1 E2E_PORT=5174 npm run e2e -- brush-bench`
Expected: it prints `brush bench (ms, request → visible mesh): fresh {…}, after 512² painted {…}`. Record both summaries in this plan under Task 15 (headless Chromium numbers are a guide; the budget is judged on the user's laptop).

- [ ] **Step 5: Commit**

```bash
git add apps/sandbox
git commit -m "test(sandbox): brush e2e and the brush latency bench; editor hint lists the brush keys"
```

---

### Task 15: Checkpoints with the user

**Files:**
- Modify: `docs/superpowers/plans/2026-10-03-terrain-brushes.md` (record results)

**Interfaces:**
- Consumes: everything above, running in `?scene=terrain&edit` on the user's laptop.
- Produces: the user's approval of the tools (checkpoint 1) and the performance numbers (checkpoint 2), recorded below; any tuning of default strengths, falloffs or radii in `defaultTools()` (`core/brushes.ts`).

- [ ] **Step 1: Checkpoint 1 — tools**

Ask the user to open `http://localhost:5174/?scene=terrain&edit` (dev server: `npx vite --port 5174` in `apps/sandbox`) and try, on the showcase:
- Height: raise and lower (Ctrl), smooth, flatten; the circle cursor and the falloff ring; `[` `]`.
- Biome: paint each biome and erase; the cell cursor; "show layers".
- Density: add, carve (Ctrl), smooth; Shift to keep the depth while carving a tunnel.
- Undo/redo of strokes, Esc mid-stroke, switching modes with 1–4, Save and reopen.

Apply the default values or curves they ask for in `defaultTools()` and commit each change (`feat(terrain-editor): tune brush defaults`).

- [ ] **Step 2: Checkpoint 2 — performance**

Ask the user to run `BENCH=1 E2E_PORT=5174 npm run e2e -- brush-bench` in `apps/sandbox` (headed, if they prefer: add `--headed`), or to paint by hand with the status line visible, and report request → visible mesh for a radius-16 stroke before and after a large painted area. The budget is **≤ 150 ms**. If it is missed, profile before changing anything (the 2c notes list the candidates: the per-update `regenerate` round trip, the mesh drain, the relight).

- [ ] **Step 3: Record the results**

Add a "Checkpoint results" section at the end of this plan with the date, the user's verdict on each checkpoint, the bench summaries (headless and laptop), and any follow-ups. Commit:

```bash
git add docs/superpowers/plans/2026-10-03-terrain-brushes.md
git commit -m "docs(plan): terrain brushes checkpoint results"
```
