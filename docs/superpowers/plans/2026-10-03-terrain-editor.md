# Terrain Editor (pieces) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An in-engine editor that creates, reshapes, tunes, reorders, toggles and deletes the ops of a `TerrainDoc`, previews every change live while dragging, undoes and redoes, and opens and saves `.terrain.json` files.

**Architecture:** `@elovox/terrain` gains a param schema per op type (validation, defaults and the inspector all read it) and `opBounds`. The engine's `replaceColumns` writes and remeshes only the chunks whose voxels or light actually changed. A new package `@elovox/terrain-editor` holds a headless `core/` (document edits, session with undo, dirty areas, preview scheduler, document I/O; tested in Node) and a `ui/` layer (DOM panels generated from the schema, three.js handles draped on the terrain, file access). The sandbox mounts it at `?scene=terrain&edit`.

**Tech Stack:** TypeScript 7 (strict, ESM, `.ts` imports), Vitest 4.1.11 (Node environment), three.js 0.186.1 via `three/webgpu`, Vite 8, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-03-terrain-editor-design.md`

## Global Constraints

- TypeScript config is `tsconfig.base.json`: `strict`, `verbatimModuleSyntax` (type-only imports use `import type`), `erasableSyntaxOnly` (**no** enums, **no** constructor parameter properties, **no** namespaces), `allowImportingTsExtensions` (relative imports end in `.ts`).
- three.js is imported **only** from `'three/webgpu'` (the engine and sandbox do this; a second import path bundles a second copy of three). It loads fine in Node tests.
- No new runtime dependencies. The editor package depends on `@elovox/engine`, `@elovox/terrain` and `three` (`0.186.1`), all already in the repo.
- Code, comments, docs and commit messages are in English. Commit messages follow the repo style (`feat(terrain): …`, `fix(engine): …`, `test(…)`, `docs(…)`). Do **not** add a `Co-Authored-By` trailer (the user's global rule; the project sets no `attribution.commit`).
- Dev server: an old Vite may still serve stale code on :5173. Run the e2e with `E2E_PORT=5174 npm run e2e` and the dev server with `npx vite --port 5174` in `apps/sandbox`.
- The rtk shell hook rewrites `grep`: patterns with `\|` fail. Use separate greps or the Grep tool.
- Performance targets (spec §2): dragging a `hills` op of radius 48 in the showcase updates in **≤ 150 ms** request → visible mesh; regenerating 128² around the view takes **≤ 300 ms**. Both are measured by the user at the checkpoints, not by tests.
- The golden column hashes of the showcase (`apps/sandbox/test/terrainDocs.test.ts`) must not change.

## Review Focus

1. **A drag ray that misses its plane** (cursor above the horizon, camera looking along the plane) — expected: the handle keeps its last valid position, no exception. Pinned in Task 12 (`hitHorizontal` returns null for a parallel or backwards ray) and used by Task 15's drag code.
2. **An edit that would make the document invalid mid-gesture** (radius dragged to 0, a third polygon vertex removed, a slider past a bound) — expected: refused, the document keeps its last valid state, the error shows. Pinned in Task 8 (`update` with an invalid edit) and Task 11 (`dragHandle` clamps radius ≥ 1, width ≥ 1).
3. **Ctrl+Z while dragging** — expected: the gesture is cancelled; the step before it is not undone and history is not corrupted. Pinned in Task 8.
4. **Opening a bad file** (not JSON, invalid, wrong size, picker cancelled) — expected: an error or nothing, and the open document is untouched. Pinned in Task 10.
5. **A regeneration that fails while edits keep coming** — expected: the failed area stays queued and is retried with the next edit, so the world catches up once the op is fixed. Pinned in Task 9.

## Deviations from the spec, decided while planning

- **Camera conflict (spec §5):** the orbit camera only reacts to the middle and right buttons (`orbitCamera.ts:83`), so the editor owns the left button with a plain `pointerdown` listener on the canvas. No capture-phase interception is needed.
- **Outlines (spec §5):** a polygon's `inset` line and the falloff ring of a path or polygon are not drawn (an inward polygon offset is not worth its complexity in a dev tool); the inspector shows both values. Circles do get their falloff ring. A path is drawn as its centre line plus its two side lines.
- **Dragging the outline of the selected op moves the whole op** (any kind). The spec only named a centre handle for circles; without this, polygons and paths could not be moved.
- **`setDocument` failures (spec §6):** like regeneration failures, they show in the status and the next edit retries. There is no separate "paused" state.

## File Structure

### `packages/terrain` (modified)

| File | Responsibility |
|---|---|
| `src/ops/schema.ts` (new) | `ParamSpec`/`ParamSchema` types, `checkParams`, `paramsOf`, `resolveBound`, `WORLD_TOP`, `BELOW_TOP` |
| `src/ops/registry.ts` | `OpImplBase` gains `params` and `falloff`; `defineTerrainOp` builds `validate` from the schema |
| `src/ops/{hills,mountain,plateau,flatten,biome,valley,river,lake,volume}.ts` | Each op declares its schema and reads values through `paramsOf` |
| `src/ops/common.ts` | Deleted (its helpers are replaced by the schema) |
| `src/ops/bounds.ts` (new) | `opBounds(def, doc, o)` |
| `src/index.ts` | Exports the schema API, `opBounds`, `FEATURE_REACH` |
| `test/schema.test.ts`, `test/builtinSchemas.test.ts`, `test/bounds.test.ts` (new) | |
| `test/validate.test.ts`, `test/generator.test.ts`, `test/pipeline.test.ts` | Custom test ops move to the new `defineTerrainOp` shape |

### `packages/engine` (modified)

| File | Responsibility |
|---|---|
| `src/sim/chunkDiff.ts` (new) | `diffMask` (what differs, on which border slabs) and `forNeighbours` |
| `src/world/chunkStore.ts` | `readVoxels`, `readLight`, `lightSnapshot` |
| `src/sim/simulation.ts` | `replaceColumns` writes only changed chunks and returns only the chunks to remesh |
| `test/chunkDiff.test.ts`, `test/replaceColumns.test.ts` (new); `test/chunkStore.test.ts`, `test/regenerate.test.ts` | |

### `packages/terrain-editor` (new)

| File | Responsibility |
|---|---|
| `src/core/edits.ts` | Pure document edits (`Edit = (doc) => doc`) |
| `src/core/newOp.ts` | Ids and default ops for the "+" menu |
| `src/core/area.ts` | `Area`, `toArea`, `unionArea`, `diffArea` |
| `src/core/history.ts` | Undo/redo stack |
| `src/core/session.ts` | `EditorSession`: the valid document, selection, gestures, undo, saved state, events |
| `src/core/preview.ts` | `PreviewScheduler`: one regeneration in flight, latest document, union of areas |
| `src/core/docio.ts` | Parse and serialize `.terrain.json` text |
| `src/ui/files.ts` | File System Access open/save with an `<input>`/download fallback |
| `src/ui/handles/geometry.ts` | Outlines, handles and drag math per shape (pure) |
| `src/ui/handles/pick.ts` | Screen projection, picking and drag planes (pure three math) |
| `src/ui/handles/overlay.ts` | three.js lines and handle markers draped on the terrain |
| `src/ui/panels/fields.ts` | Inspector field model from the schema (pure) |
| `src/ui/panels/dom.ts`, `toolbar.ts`, `opList.ts`, `inspector.ts` | DOM panels |
| `src/ui/keys.ts` | Keyboard shortcuts (pure mapping) |
| `src/ui/editor.ts` | `createTerrainEditor(engine, options)`: wires everything |
| `src/index.ts` | Public exports |

### `apps/sandbox` (modified)

| File | Responsibility |
|---|---|
| `src/main.ts` | `?scene=terrain&edit` mounts the editor; block clicks off while editing |
| `src/hud.ts`, `src/controls.ts` | HUD corner and hint; collapsible controls |
| `src/terrainPanel.ts` | The regenerate button toggles a real 128² change (an unchanged regeneration now remeshes nothing) |
| `vite.config.ts` | The dev server ignores `**/*.terrain.json` |
| `e2e/smoke.spec.ts` | Unchanged-regeneration assertion; editor e2e |
| `package.json` | Depends on `@elovox/terrain-editor` |

---

## Part A — `@elovox/terrain`: param schemas and bounds

### Task 1: The param schema module

**Files:**
- Create: `packages/terrain/src/ops/schema.ts`
- Test: `packages/terrain/test/schema.test.ts`

**Interfaces:**
- Consumes: `Check`, `checkNoise` (`src/doc/check.ts`), `OpDef` (`src/doc/types.ts`), `NoiseDef` (`src/noise/def.ts`), `ValidateContext` (type, `src/ops/registry.ts`: `{ biomes: readonly string[]; height: number }`).
- Produces:
  - `type Bound = number | ((ctx: ValidateContext) => number)`
  - `interface NumberParam { type: 'number'; required?: boolean; default?: number; min?: number; max?: Bound; gt?: number; int?: boolean; step?: number; range?: readonly [number, number]; anchor?: 'ground' }`
  - `interface EnumParam { type: 'enum'; values: readonly string[]; default: string }`, `NoiseParam { type: 'noise'; default: NoiseDef }`, `BoolParam { type: 'bool'; default: boolean }`, `BiomeParam { type: 'biome' }`
  - `type ParamSpec`, `type ParamSchema = Readonly<Record<string, ParamSpec>>`, `type ParamValues<S>`
  - `WORLD_TOP: Bound` (`ctx.height`), `BELOW_TOP: Bound` (`ctx.height - 1`)
  - `resolveBound(b: Bound | undefined, ctx: ValidateContext): number | undefined`
  - `checkParams(c: Check, path: string, def: OpDef, schema: ParamSchema, ctx: ValidateContext): void`
  - `paramsOf<S extends ParamSchema>(def: OpDef, schema: S): ParamValues<S>`

- [ ] **Step 1: Write the failing test**

`packages/terrain/test/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Check } from '../src/doc/check.ts'
import type { OpDef } from '../src/doc/types.ts'
import { BELOW_TOP, WORLD_TOP, checkParams, paramsOf, resolveBound, type ParamSchema } from '../src/ops/schema.ts'

const SCHEMA = {
  size: { type: 'number', required: true, default: 4, min: 0, max: WORLD_TOP },
  level: { type: 'number', default: 2, int: true, gt: 0, max: BELOW_TOP },
  thick: { type: 'number', gt: 0 },
  shape: { type: 'enum', values: ['round', 'box'], default: 'round' },
  noise: { type: 'noise', default: { scale: 32 } },
  solid: { type: 'bool', default: true },
  biome: { type: 'biome' },
} as const satisfies ParamSchema

const ctx = { biomes: ['plain', 'mesa'], height: 64 }
const def = (params: Record<string, unknown>): OpDef =>
  ({ id: 'a', type: 't', enabled: true, shape: { kind: 'circle', center: [0, 0], radius: 1 }, params })
function errors(params: Record<string, unknown>, schema: ParamSchema = SCHEMA): string[] {
  const c = new Check()
  checkParams(c, 'ops[0]', def(params), schema, ctx)
  return c.errors
}

describe('checkParams', () => {
  it('accepts valid params and missing optional ones', () => {
    expect(errors({ size: 3, biome: 'mesa' })).toEqual([])
  })

  it('reports each bad param with its path, in schema order', () => {
    expect(errors({ size: 65, level: 1.5, thick: 0, shape: 'blob', noise: { scale: 0 }, solid: 'yes', biome: 'swamp' })).toEqual([
      'ops[0].params.size: must be <= 64',
      'ops[0].params.level: must be an integer',
      'ops[0].params.thick: must be > 0',
      'ops[0].params.shape: must be one of round, box',
      'ops[0].params.noise.scale: must be > 0',
      'ops[0].params.solid: must be true or false',
      'ops[0].params.biome: must be one of plain, mesa',
    ])
  })

  it('requires required numbers and biome params', () => {
    expect(errors({})).toEqual(['ops[0].params.size: is required', 'ops[0].params.biome: is required'])
  })

  it('rejects unknown params first, naming the known ones', () => {
    expect(errors({ size: 1, biome: 'plain', sise: 2 })).toEqual([
      'ops[0].params.sise: unknown param (known: size, level, thick, shape, noise, solid, biome)',
    ])
  })

  it('says when an op takes no params at all', () => {
    expect(errors({ x: 1 }, {})).toEqual(['ops[0].params.x: unknown param (this op takes none)'])
  })

  it('does not mistake inherited object keys for params', () => {
    expect(errors({ size: 1, biome: 'plain', toString: 2 })).toEqual([
      'ops[0].params.toString: unknown param (known: size, level, thick, shape, noise, solid, biome)',
    ])
  })
})

describe('paramsOf', () => {
  it('fills defaults and leaves a param without one undefined', () => {
    expect(paramsOf(def({ size: 3, biome: 'mesa' }), SCHEMA)).toEqual({
      size: 3, level: 2, thick: undefined, shape: 'round', noise: { scale: 32 }, solid: true, biome: 'mesa',
    })
  })

  it('keeps given values, falsy ones included', () => {
    expect(paramsOf(def({ size: 0, solid: false, biome: 'plain' }), SCHEMA)).toMatchObject({ size: 0, solid: false })
  })

  it('is typed from the schema', () => {
    const p = paramsOf(def({ size: 3, biome: 'mesa' }), SCHEMA)
    const size: number = p.size
    const thick: number | undefined = p.thick
    const shape: 'round' | 'box' = p.shape
    expect([size, thick, shape]).toEqual([3, undefined, 'round'])
  })
})

describe('resolveBound', () => {
  it('resolves world-relative bounds and passes numbers through', () => {
    expect(resolveBound(WORLD_TOP, ctx)).toBe(64)
    expect(resolveBound(BELOW_TOP, ctx)).toBe(63)
    expect(resolveBound(5, ctx)).toBe(5)
    expect(resolveBound(undefined, ctx)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @elovox/terrain -- schema`
Expected: FAIL — `Cannot find module '../src/ops/schema.ts'` (or "Failed to load url").

- [ ] **Step 3: Write the implementation**

`packages/terrain/src/ops/schema.ts`:

```ts
import { Check, checkNoise } from '../doc/check.ts'
import type { OpDef } from '../doc/types.ts'
import type { NoiseDef } from '../noise/def.ts'
import type { ValidateContext } from './registry.ts'

/** A numeric bound, fixed or relative to the world (schemas are code, so a function is fine). */
export type Bound = number | ((ctx: ValidateContext) => number)

/** The world height: an absolute y may reach it. */
export const WORLD_TOP: Bound = (ctx) => ctx.height
/** One below the world height: the highest water or river level. */
export const BELOW_TOP: Bound = (ctx) => ctx.height - 1

export interface NumberParam {
  type: 'number'
  /** A missing value is an error. Otherwise a missing value reads as `default`. */
  required?: boolean
  /** The value of a missing optional param, and the value a new op starts with. Without it, a missing optional param reads as undefined. */
  default?: number
  min?: number
  max?: Bound
  gt?: number
  int?: boolean
  /** Inspector step. Default: 1 for int and anchored params, else 0.1. */
  step?: number
  /** Inspector slider range where min/max leave it open. */
  range?: readonly [number, number]
  /** An absolute y: a new op sets it to the ground height under the op plus `default`. Anchored params are required. */
  anchor?: 'ground'
}
export interface EnumParam { type: 'enum'; values: readonly string[]; default: string }
export interface NoiseParam { type: 'noise'; default: NoiseDef }
export interface BoolParam { type: 'bool'; default: boolean }
/** A required biome name from the document's `biomes`. */
export interface BiomeParam { type: 'biome' }
export type ParamSpec = NumberParam | EnumParam | NoiseParam | BoolParam | BiomeParam
export type ParamSchema = Readonly<Record<string, ParamSpec>>

type ValueOf<P> =
  P extends { type: 'number' } ? (P extends { default: number } ? number : P extends { required: true } ? number : number | undefined)
  : P extends { type: 'enum'; values: readonly (infer V)[] } ? V
  : P extends { type: 'noise' } ? NoiseDef
  : P extends { type: 'bool' } ? boolean
  : P extends { type: 'biome' } ? string
  : never

/** The params of an op whose schema is S, with every default filled in. */
export type ParamValues<S extends ParamSchema> = { -readonly [K in keyof S]: ValueOf<S[K]> }

export function resolveBound(b: Bound | undefined, ctx: ValidateContext): number | undefined {
  return typeof b === 'function' ? b(ctx) : b
}

/** Validates `def.params` against `schema`: unknown keys first, then every param in schema order. */
export function checkParams(c: Check, path: string, def: OpDef, schema: ParamSchema, ctx: ValidateContext): void {
  const known = Object.keys(schema)
  for (const key of Object.keys(def.params)) {
    if (Object.hasOwn(schema, key)) continue
    c.fail(`${path}.params.${key}`, known.length > 0 ? `unknown param (known: ${known.join(', ')})` : 'unknown param (this op takes none)')
  }
  for (const [key, spec] of Object.entries(schema)) {
    const p = `${path}.params.${key}`
    const v = def.params[key]
    switch (spec.type) {
      case 'number':
        c.num(p, v, { min: spec.min, max: resolveBound(spec.max, ctx), gt: spec.gt, int: spec.int, optional: !spec.required })
        break
      case 'enum': c.str(p, v, spec.values, true); break
      case 'noise': checkNoise(c, p, v, true); break
      case 'bool': c.bool(p, v, true); break
      case 'biome': c.str(p, v, ctx.biomes); break
    }
  }
}

/** `def.params` (already validated) with every missing param set to its schema default. */
export function paramsOf<S extends ParamSchema>(def: OpDef, schema: S): ParamValues<S> {
  const out: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(schema)) {
    const v = def.params[key]
    out[key] = v !== undefined ? v : 'default' in spec ? spec.default : undefined
  }
  return out as ParamValues<S>
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @elovox/terrain -- schema`
Expected: PASS (10 tests).

Run: `npm run typecheck -w @elovox/terrain`
Expected: no errors (the `is typed from the schema` test also checks the mapped types).

- [ ] **Step 5: Commit**

```bash
git add packages/terrain/src/ops/schema.ts packages/terrain/test/schema.test.ts
git commit -m "feat(terrain): param schema types, schema validation and paramsOf"
```

### Task 2: Every op declares its schema

`defineTerrainOp` now takes `params` (the schema), `falloff` (does the op read `shape.falloff`) and an optional `check` for rules the schema cannot express. It builds `validate` from them: falloff rule, then `check`, then `checkParams`. Every op reads its values through `paramsOf`. The output must not change: the showcase golden hashes are the gate.

**Files:**
- Modify: `packages/terrain/src/ops/registry.ts`
- Modify: `packages/terrain/src/ops/hills.ts`, `mountain.ts`, `plateau.ts`, `flatten.ts`, `biome.ts`, `valley.ts`, `river.ts`, `lake.ts`, `volume.ts`
- Delete: `packages/terrain/src/ops/common.ts`
- Modify: `packages/terrain/src/index.ts`
- Modify tests: `packages/terrain/test/validate.test.ts`, `test/generator.test.ts`, `test/pipeline.test.ts`
- Create test: `packages/terrain/test/builtinSchemas.test.ts`

**Interfaces:**
- Consumes: Task 1's `ParamSchema`, `checkParams`, `paramsOf`, `WORLD_TOP`, `BELOW_TOP`.
- Produces:
  - `OpImplBase` fields: `params: ParamSchema`, `falloff: boolean`, `validate(c, path, def, ctx)` (unchanged signature).
  - `type HeightOpSpec = Omit<HeightOpImpl, 'validate'> & { check?(c: Check, path: string, def: OpDef, ctx: ValidateContext): void }`, `VolumeOpSpec` likewise.
  - `defineTerrainOp(spec: HeightOpSpec): HeightOpImpl`, `defineTerrainOp(spec: VolumeOpSpec): VolumeOpImpl`.
  - Falloff error text: `` `${path}.shape.falloff: ${type} does not use a falloff` `` (only when `falloff > 0`).
  - Index exports: `checkParams, paramsOf, resolveBound, WORLD_TOP, BELOW_TOP`, types `Bound, NumberParam, EnumParam, NoiseParam, BoolParam, BiomeParam, ParamSpec, ParamSchema, ParamValues, HeightOpSpec, VolumeOpSpec`.

- [ ] **Step 1: Write the failing tests**

`packages/terrain/test/builtinSchemas.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { validateTerrainDoc } from '../src/doc/validate.ts'
import { BUILTIN_OPS } from '../src/ops/builtin.ts'
import { minimalDoc } from './fixtures.ts'

describe('built-in op schemas', () => {
  it.each(BUILTIN_OPS.map((o) => [o.type, o] as const))('%s: required numbers have a default, anchored ones are required', (_type, impl) => {
    for (const [key, spec] of Object.entries(impl.params)) {
      if (spec.type !== 'number') continue
      if (spec.required) expect(spec.default, key).toBeTypeOf('number')
      if (spec.anchor) expect(spec.required, key).toBe(true)
    }
  })

  it('only hills, flatten and biome use a falloff', () => {
    expect(BUILTIN_OPS.filter((o) => o.falloff).map((o) => o.type).sort()).toEqual(['biome', 'flatten', 'hills'])
  })

  it('rejects a falloff on an op that ignores it, and unknown params', () => {
    const circle = (falloff: number) => ({ kind: 'circle', center: [10, 10], radius: 5, falloff })
    const doc = {
      ...minimalDoc(),
      ops: [
        { id: 'm', type: 'mountain', shape: circle(4), params: { height: 10 } },
        { id: 'z', type: 'mountain', shape: circle(0), params: { height: 10 } },
        { id: 'h', type: 'hills', shape: circle(4), params: { amplitude: 3, amplitdue: 4 } },
      ],
    }
    const r = validateTerrainDoc(doc)
    expect(r.ok ? [] : r.errors).toEqual([
      'ops[0].shape.falloff: mountain does not use a falloff',
      'ops[2].params.amplitdue: unknown param (known: amplitude, offset, noise)',
    ])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @elovox/terrain -- builtinSchemas`
Expected: FAIL — `impl.params` is undefined (`Object.entries` throws "Cannot convert undefined or null to object"), and the falloff test gets `[]`.

- [ ] **Step 3: Update the registry**

In `packages/terrain/src/ops/registry.ts`, replace the imports and everything from `interface OpImplBase {` through the end of `defineTerrainOp` with:

```ts
import type { Check } from '../doc/check.ts'
import type { BlendMode, OpDef, ShapeKind } from '../doc/types.ts'
import type { Box, Rect } from '../geom.ts'
import { checkParams, type ParamSchema } from './schema.ts'
```

```ts
interface OpImplBase {
  readonly type: string
  /** Shape kinds this op accepts. */
  readonly shapes: readonly ShapeKind[]
  /** Requires y on every path point (volume ops along paths). */
  readonly needY?: boolean
  /** The op's params. Validation, defaults (paramsOf) and the editor's inspector all read it. */
  readonly params: ParamSchema
  /** True if the op reads `shape.falloff`; a falloff > 0 on any other op is an error. */
  readonly falloff: boolean
  /** Validates the falloff and `def.params` (shape and common fields are already valid). Built by defineTerrainOp. */
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

type Spec<T extends OpImpl> = Omit<T, 'validate'> & {
  /** Rules the schema cannot express (an arch takes exactly 2 points). Runs before the params are checked. */
  check?(c: Check, path: string, def: OpDef, ctx: ValidateContext): void
}
export type HeightOpSpec = Spec<HeightOpImpl>
export type VolumeOpSpec = Spec<VolumeOpImpl>

/** Builds an op from its spec; `validate` comes from `falloff`, `check` and `params`. Register it with `builtinOps.with(myOp)`. */
export function defineTerrainOp(spec: HeightOpSpec): HeightOpImpl
export function defineTerrainOp(spec: VolumeOpSpec): VolumeOpImpl
export function defineTerrainOp(spec: HeightOpSpec | VolumeOpSpec): OpImpl {
  const { check, ...impl } = spec
  return {
    ...impl,
    validate(c, path, def, ctx) {
      const f = def.shape.falloff
      if (!impl.falloff && f !== undefined && f > 0) c.fail(`${path}.shape.falloff`, `${impl.type} does not use a falloff`)
      check?.(c, path, def, ctx)
      checkParams(c, path, def, impl.params, ctx)
    },
  } as OpImpl
}
```

Leave `Cell`, `ValidateContext`, `CompileContext`, `HeightOp`, `VolumeOp` and `OpRegistry` as they are.

- [ ] **Step 4: Rewrite the height ops**

`packages/terrain/src/ops/hills.ts`:

```ts
import { expandRect } from '../geom.ts'
import { makeNoise2 } from '../noise/def.ts'
import { blend } from '../shapes/blend.ts'
import { compileShape, newSample, weight } from '../shapes/shape.ts'
import { defineTerrainOp } from './registry.ts'
import { paramsOf, type ParamSchema } from './schema.ts'

const PARAMS = {
  amplitude: { type: 'number', required: true, default: 12, min: 0, range: [0, 64] },
  offset: { type: 'number', default: 0, range: [-32, 32] },
  noise: { type: 'noise', default: { scale: 64 } },
} as const satisfies ParamSchema

/**
 * Procedural fill inside an area: value = offset + amplitude * noise (noise in [0, 1]).
 * Default blend 'add' (bumps on top of the ground); with 'min' and a low offset it lowers an area
 * into a sea floor; with 'set' it replaces the ground.
 */
export const hills = defineTerrainOp({
  type: 'hills', kind: 'height', defaultBlend: 'add', shapes: ['circle', 'polygon', 'path'], falloff: true, params: PARAMS,
  compile(def, ctx) {
    const shape = compileShape(def.shape)
    const p = paramsOf(def, PARAMS)
    const noise = makeNoise2(p.noise, ctx.seed)
    const mode = def.blend ?? 'add'
    const s = newSample()
    return {
      id: def.id,
      bounds: expandRect(shape.bounds, shape.falloff),
      apply(x, z, cell) {
        shape.sample(x, z, s)
        const w = weight(s, shape.falloff)
        if (w > 0) cell.h = blend(mode, cell.h, p.offset + p.amplitude * noise(x, z), w)
      },
    }
  },
})
```

`packages/terrain/src/ops/mountain.ts`:

```ts
import { makeNoise2 } from '../noise/def.ts'
import { blend } from '../shapes/blend.ts'
import { PROFILES, profile } from '../shapes/profile.ts'
import { compileShape, newSample } from '../shapes/shape.ts'
import { defineTerrainOp } from './registry.ts'
import { paramsOf, type ParamSchema } from './schema.ts'

const PARAMS = {
  height: { type: 'number', required: true, default: 40, min: 0, range: [0, 100] },
  roughness: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.05 },
  profile: { type: 'enum', values: PROFILES, default: 'smooth' },
  noise: { type: 'noise', default: { type: 'ridged', scale: 96, octaves: 5 } },
} as const satisfies ParamSchema

/**
 * A peak (circle) or a range (path): value = height * profile(edge) * (1 - roughness + roughness * noise).
 * The default noise is ridged, which gives sharp crests. Default blend 'add'.
 */
export const mountain = defineTerrainOp({
  type: 'mountain', kind: 'height', defaultBlend: 'add', shapes: ['circle', 'path'], falloff: false, params: PARAMS,
  compile(def, ctx) {
    const shape = compileShape(def.shape)
    const p = paramsOf(def, PARAMS)
    const noise = makeNoise2(p.noise, ctx.seed)
    const mode = def.blend ?? 'add'
    const s = newSample()
    return {
      id: def.id,
      bounds: shape.bounds,
      apply(x, z, cell) {
        shape.sample(x, z, s)
        if (s.edge >= 1) return
        const v = p.height * profile(p.profile, s.edge) * (1 - p.roughness + p.roughness * noise(x, z))
        cell.h = blend(mode, cell.h, v, 1)
      },
    }
  },
})
```

`packages/terrain/src/ops/plateau.ts` (keep `terrace` exactly as it is; the tests import it):

```ts
import { clamp, expandRect } from '../geom.ts'
import { makeNoise2 } from '../noise/def.ts'
import { blend } from '../shapes/blend.ts'
import { smoothstep01 } from '../shapes/profile.ts'
import { compileShape, newSample } from '../shapes/shape.ts'
import { defineTerrainOp } from './registry.ts'
import { WORLD_TOP, paramsOf, type ParamSchema } from './schema.ts'

/** 0 → 1 rise; with k terraces, flat treads joined by steep smooth risers. */
export function terrace(t: number, k: number): number {
  if (k <= 0) return smoothstep01(t)
  const x = t * k
  const i = Math.floor(x)
  return Math.min(1, (i + smoothstep01((x - i - 0.65) / 0.35)) / k)
}

const PARAMS = {
  top: { type: 'number', required: true, default: 24, min: 0, max: WORLD_TOP, anchor: 'ground' },
  base: { type: 'number', required: true, default: 0, min: 0, max: WORLD_TOP, anchor: 'ground' },
  wall: { type: 'number', default: 6, gt: 0, range: [1, 32] },
  terraces: { type: 'number', default: 0, int: true, min: 0, max: 16 },
  jitter: { type: 'number', default: 0, min: 0, range: [0, 16] },
  noise: { type: 'noise', default: { scale: 24, octaves: 3 } },
} as const satisfies ParamSchema

/**
 * A mesa: rises from `base` at the shape's edge to `top` over `wall` blocks inward, optionally in
 * `terraces` steps. `jitter` (blocks) roughens the wall line with noise. Default blend 'max', so the
 * wall's foot merges with higher ground.
 */
export const plateau = defineTerrainOp({
  type: 'plateau', kind: 'height', defaultBlend: 'max', shapes: ['circle', 'polygon'], falloff: false, params: PARAMS,
  compile(def, ctx) {
    const shape = compileShape(def.shape)
    const p = paramsOf(def, PARAMS)
    const noise = makeNoise2(p.noise, ctx.seed)
    const mode = def.blend ?? 'max'
    const s = newSample()
    return {
      id: def.id,
      bounds: expandRect(shape.bounds, p.jitter),
      apply(x, z, cell) {
        shape.sample(x, z, s)
        const inward = -s.dist + (p.jitter > 0 ? p.jitter * (noise(x, z) * 2 - 1) : 0)
        if (inward <= 0) return
        const v = p.base + (p.top - p.base) * terrace(clamp(inward / p.wall, 0, 1), p.terraces)
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
import { defineTerrainOp } from './registry.ts'
import { WORLD_TOP, paramsOf, type ParamSchema } from './schema.ts'

const PARAMS = {
  y: { type: 'number', required: true, default: 0, min: 0, max: WORLD_TOP, anchor: 'ground' },
} as const satisfies ParamSchema

/** A flat site at height `y`, blended into the surroundings over the shape's falloff. Default blend 'set'. */
export const flatten = defineTerrainOp({
  type: 'flatten', kind: 'height', defaultBlend: 'set', shapes: ['circle', 'polygon', 'path'], falloff: true, params: PARAMS,
  compile(def) {
    const shape = compileShape(def.shape)
    const { y } = paramsOf(def, PARAMS)
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
import { makeNoise2 } from '../noise/def.ts'
import { compileShape, newSample, weight } from '../shapes/shape.ts'
import { defineTerrainOp } from './registry.ts'
import { paramsOf, type ParamSchema } from './schema.ts'

const PARAMS = {
  biome: { type: 'biome' },
  jitter: { type: 'number', default: 0, min: 0, range: [0, 32] },
  noise: { type: 'noise', default: { scale: 48, octaves: 3 } },
} as const satisfies ParamSchema

/**
 * Paints a biome over an area (where the falloff weight is at least 0.5). `jitter` (blocks) moves the
 * border in and out with noise so it does not follow the shape's straight edges. Changes no height.
 */
export const biome = defineTerrainOp({
  type: 'biome', kind: 'height', defaultBlend: 'set', shapes: ['circle', 'polygon', 'path'], falloff: true, params: PARAMS,
  compile(def, ctx) {
    const shape = compileShape(def.shape)
    const p = paramsOf(def, PARAMS)
    const index = ctx.biomeIndex(p.biome)
    const noise = makeNoise2(p.noise, ctx.seed)
    const s = newSample()
    return {
      id: def.id,
      bounds: expandRect(shape.bounds, shape.falloff + p.jitter),
      apply(x, z, cell) {
        shape.sample(x, z, s)
        if (p.jitter > 0) s.dist += p.jitter * (noise(x, z) * 2 - 1)
        if (weight(s, shape.falloff) >= 0.5) cell.biome = index
      },
    }
  },
})
```

`packages/terrain/src/ops/valley.ts`:

```ts
import { makeNoise2 } from '../noise/def.ts'
import { blend } from '../shapes/blend.ts'
import { PROFILES, profile } from '../shapes/profile.ts'
import { compileShape, newSample } from '../shapes/shape.ts'
import { defineTerrainOp } from './registry.ts'
import { paramsOf, type ParamSchema } from './schema.ts'

const PARAMS = {
  depth: { type: 'number', required: true, default: 12, min: 0, range: [0, 64] },
  noiseAmount: { type: 'number', default: 0, min: 0, range: [0, 16] },
  profile: { type: 'enum', values: PROFILES, default: 'round' },
  noise: { type: 'noise', default: { scale: 32, octaves: 3 } },
} as const satisfies ParamSchema

/**
 * Cuts a valley (profile 'round' = U, 'linear' = V) or a canyon (profile 'box') along a path or in
 * an area: value = profile(edge) * (depth + noiseAmount * (2 * noise - 1)). Default blend 'carve'.
 */
export const valley = defineTerrainOp({
  type: 'valley', kind: 'height', defaultBlend: 'carve', shapes: ['path', 'circle', 'polygon'], falloff: false, params: PARAMS,
  compile(def, ctx) {
    const shape = compileShape(def.shape)
    const p = paramsOf(def, PARAMS)
    const noise = makeNoise2(p.noise, ctx.seed)
    const mode = def.blend ?? 'carve'
    const s = newSample()
    return {
      id: def.id,
      bounds: shape.bounds,
      apply(x, z, cell) {
        shape.sample(x, z, s)
        if (s.edge >= 1) return
        const v = profile(p.profile, s.edge) * (p.depth + (p.noiseAmount > 0 ? p.noiseAmount * (noise(x, z) * 2 - 1) : 0))
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
import { defineTerrainOp } from './registry.ts'
import { BELOW_TOP, paramsOf, type ParamSchema } from './schema.ts'

const PARAMS = {
  start: { type: 'number', required: true, default: 0, min: 1, max: BELOW_TOP, anchor: 'ground' },
  end: { type: 'number', required: true, default: -6, min: 1, max: BELOW_TOP, anchor: 'ground' },
  depth: { type: 'number', default: 3, min: 0, range: [0, 12] },
  bank: { type: 'number', default: 16, min: 0, range: [0, 64] },
  bankSlope: { type: 'number', default: 0.5, gt: 0, step: 0.05, range: [0.05, 2] },
} as const satisfies ParamSchema

/**
 * A river along a path. The water level goes from `start` (first point) to `end` (last point) in
 * whole-block steps. Inside the path's width the bed is a U `depth` blocks below the water; outside,
 * banks climb at `bankSlope` per block and fade back into the ground over the outer half of `bank`,
 * so the river cuts a valley through high ground without leaving a step. Default blend 'min'.
 */
export const river = defineTerrainOp({
  type: 'river', kind: 'height', defaultBlend: 'min', shapes: ['path'], falloff: false, params: PARAMS,
  compile(def) {
    const shape = compileShape(def.shape)
    const { start, end, depth, bank, bankSlope: slope } = paramsOf(def, PARAMS)
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
          : level + (d - hw) * slope
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
import { defineTerrainOp } from './registry.ts'
import { BELOW_TOP, paramsOf, type ParamSchema } from './schema.ts'

const PARAMS = {
  level: { type: 'number', required: true, default: 0, min: 1, max: BELOW_TOP, anchor: 'ground' },
  depth: { type: 'number', default: 6, min: 1, range: [1, 32] },
  shore: { type: 'number', default: 16, min: 0, range: [0, 64] },
  shoreSlope: { type: 'number', default: 0.4, gt: 0, step: 0.05, range: [0.05, 2] },
} as const satisfies ParamSchema

/**
 * A lake: a basin under water `level`. The floor drops half a block per block inward, down to
 * `depth` below the water; the shore rises at `shoreSlope` per block outside the shape and fades back
 * into the ground over the outer half of `shore`. Default blend 'min'.
 */
export const lake = defineTerrainOp({
  type: 'lake', kind: 'height', defaultBlend: 'min', shapes: ['circle', 'polygon'], falloff: false, params: PARAMS,
  compile(def) {
    const shape = compileShape(def.shape)
    const p = paramsOf(def, PARAMS)
    const level = Math.floor(p.level)
    const { depth, shore, shoreSlope: slope } = p
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
          : level + s.dist * slope
        const fade = s.dist <= shore * 0.5 ? 1 : smoothstep01((shore - s.dist) / (shore * 0.5))
        cell.h = blend(mode, cell.h, target, fade)
        if (s.dist <= 0 && level > cell.water) cell.water = level
        if (level > cell.wet) cell.wet = level
      },
    }
  },
})
```

- [ ] **Step 5: Rewrite the volume ops**

`packages/terrain/src/ops/volume.ts` (keep `tube.ts` as it is):

```ts
import type { OpDef, PathPoint, ShapeDef } from '../doc/types.ts'
import type { Box } from '../geom.ts'
import { makeNoise3, type NoiseDef } from '../noise/def.ts'
import { defineTerrainOp, type CompileContext, type VolumeOp } from './registry.ts'
import { WORLD_TOP, paramsOf, type ParamSchema } from './schema.ts'
import { archCurve, compileTube, type TubePoint } from './tube.ts'

type PathShape = Extract<ShapeDef, { kind: 'path' }>

function tubePoints(shape: PathShape, height: (width: number) => number): TubePoint[] {
  return shape.points.map((p: PathPoint) => {
    const w = p.width ?? shape.width
    return { x: p.x, y: p.y ?? 0, z: p.z, hw: w / 2, hh: height(w) / 2 }
  })
}

/** Params every volume op shares; the defaults differ per op. */
function common<M extends 'add' | 'carve'>(wobble: number, mode: M) {
  return {
    wobble: { type: 'number', default: wobble, min: 0, step: 0.5, range: [0, 8] },
    noise: { type: 'noise', default: { scale: 12, octaves: 2 } },
    mode: { type: 'enum', values: ['add', 'carve'], default: mode },
  } as const satisfies ParamSchema
}

interface Common { wobble: number; noise: NoiseDef; mode: 'add' | 'carve' }

/**
 * Wraps a tube or blob field with noise wobble into a VolumeOp. `reach` scales the bounds padding per
 * axis for fields whose gradient is below 1 block per block (a flattened blob).
 */
function volumeOp(id: string, ctx: CompileContext, bounds: Box, field: (x: number, y: number, z: number) => number, c: Common, reach = { xz: 1, y: 1 }): VolumeOp {
  const padXZ = c.wobble * reach.xz, padY = c.wobble * reach.y
  const noise = makeNoise3(c.noise, ctx.seed)
  const wobble = c.wobble
  return {
    id, mode: c.mode,
    bounds: { x0: bounds.x0 - padXZ, x1: bounds.x1 + padXZ, y0: bounds.y0 - padY, y1: bounds.y1 + padY, z0: bounds.z0 - padXZ, z1: bounds.z1 + padXZ },
    density: wobble > 0 ? (x, y, z) => field(x, y, z) + wobble * (noise(x, y, z) * 2 - 1) : field,
  }
}

const ARCH = {
  rise: { type: 'number', required: true, default: 12, min: 0, range: [0, 64] },
  height: { type: 'number', gt: 0, range: [1, 32] },
  ...common(1.5, 'add'),
} as const satisfies ParamSchema

/** A stone arch: a tube along a Bézier from the first path point to the second, lifted by `rise`. Default mode 'add'. */
export const arch = defineTerrainOp({
  type: 'arch', kind: 'volume', shapes: ['path'], needY: true, falloff: false, params: ARCH,
  check(c, path, def: OpDef) {
    if ((def.shape as PathShape).points.length !== 2) c.fail(`${path}.shape.points`, 'an arch takes exactly 2 points')
  },
  compile(def, ctx) {
    const p = paramsOf(def, ARCH)
    const thick = p.height ?? 0
    const [p0, p2] = tubePoints(def.shape as PathShape, (w) => thick || w)
    const tube = compileTube(archCurve(p0!, p2!, p.rise, 24), 0)
    return volumeOp(def.id, ctx, tube.bounds, tube.field, p)
  },
})

const CAVE = {
  height: { type: 'number', gt: 0, range: [1, 32] },
  ...common(2, 'carve'),
} as const satisfies ParamSchema

/** A cave tunnel along a 3D path; start the path above ground for a visible entrance. Default mode 'carve'. */
export const cave = defineTerrainOp({
  type: 'cave', kind: 'volume', shapes: ['path'], needY: true, falloff: false, params: CAVE,
  compile(def, ctx) {
    const p = paramsOf(def, CAVE)
    const height = p.height ?? 0
    const tube = compileTube(tubePoints(def.shape as PathShape, (w) => height || w), 0)
    return volumeOp(def.id, ctx, tube.bounds, tube.field, p)
  },
})

const OVERHANG = {
  height: { type: 'number', gt: 0, range: [1, 32] },
  ...common(1, 'carve'),
} as const satisfies ParamSchema

/**
 * A flat horizontal slot along a wall, at the path's y: carving it under a cliff leaves an
 * overhanging lip; with mode 'add' it builds a ledge. `height` defaults to a third of the width.
 */
export const overhang = defineTerrainOp({
  type: 'overhang', kind: 'volume', shapes: ['path'], needY: true, falloff: false, params: OVERHANG,
  compile(def, ctx) {
    const p = paramsOf(def, OVERHANG)
    const height = p.height ?? 0
    const tube = compileTube(tubePoints(def.shape as PathShape, (w) => height || w / 3), 0)
    return volumeOp(def.id, ctx, tube.bounds, tube.field, p)
  },
})

const BLOB = {
  y: { type: 'number', required: true, default: 16, min: 0, max: WORLD_TOP, anchor: 'ground' },
  height: { type: 'number', required: true, default: 8, gt: 0, range: [1, 48] },
  ...common(2, 'add'),
} as const satisfies ParamSchema

/**
 * A noisy ellipsoid centred on the circle at height `y`: horizontal radius = the circle's radius,
 * vertical radius = `height`. Floating islands, spires, boulders (mode 'add') or pits (mode 'carve').
 */
export const blob = defineTerrainOp({
  type: 'blob', kind: 'volume', shapes: ['circle'], falloff: false, params: BLOB,
  compile(def, ctx) {
    const shape = def.shape as Extract<ShapeDef, { kind: 'circle' }>
    const [cx, cz] = shape.center
    const p = paramsOf(def, BLOB)
    const r = shape.radius, cy = p.y, hy = p.height
    const k = Math.min(r, hy)
    const field = (x: number, y: number, z: number) => {
      const q = Math.sqrt(((x - cx) / r) ** 2 + ((y - cy) / hy) ** 2 + ((z - cz) / r) ** 2)
      return (1 - q) * k
    }
    return volumeOp(def.id, ctx, { x0: cx - r, x1: cx + r, y0: cy - hy, y1: cy + hy, z0: cz - r, z1: cz + r }, field, p, { xz: r / k, y: hy / k })
  },
})
```

Then delete `packages/terrain/src/ops/common.ts` and check that nothing imports it:

```bash
git rm packages/terrain/src/ops/common.ts
grep -rn "ops/common" packages apps
grep -rn "from './common.ts'" packages/terrain/src
```

Expected: no output from either grep.

- [ ] **Step 6: Export the schema API**

In `packages/terrain/src/index.ts`, replace the `OpRegistry` export block with:

```ts
export {
  OpRegistry, defineTerrainOp,
  type Cell, type CompileContext, type HeightOp, type HeightOpImpl, type HeightOpSpec, type OpImpl, type ValidateContext,
  type VolumeOp, type VolumeOpImpl, type VolumeOpSpec,
} from './ops/registry.ts'
export {
  BELOW_TOP, WORLD_TOP, checkParams, paramsOf, resolveBound,
  type BiomeParam, type BoolParam, type Bound, type EnumParam, type NoiseParam, type NumberParam, type ParamSchema, type ParamSpec, type ParamValues,
} from './ops/schema.ts'
```

Also add `ShapeKind` to the `doc/types.ts` type export list and export the constants the editor needs:

```ts
export type {
  BaseDef, BiomeDef, BiomeRule, BiomeRuleEntry, BlendMode, BlockNames, BrickRef, BrickSetRef, OpDef, PathPoint,
  RasterRef, ShapeDef, ShapeKind, SurfaceRule, TerrainDoc, TerrainLayers, TreeKind, Vec2,
} from './doc/types.ts'
export { BLEND_MODES } from './doc/types.ts'
export { NOISE_TYPES } from './noise/def.ts'
export { FEATURE_REACH } from './features/place.ts'
export type { Rect } from './geom.ts'
```

- [ ] **Step 7: Move the custom test ops to the new shape**

`packages/terrain/test/validate.test.ts`, replace the `bump` definition:

```ts
/** A custom op, which also proves custom ops plug into validation. */
const bump = defineTerrainOp({
  type: 'bump', kind: 'height', defaultBlend: 'add', shapes: ['circle'], falloff: false,
  params: { height: { type: 'number', required: true, default: 0, min: 0 } },
  compile(def) { return { id: def.id, bounds: { x0: 0, z0: 0, x1: 0, z1: 0 }, apply() {} } },
})
```

`packages/terrain/test/generator.test.ts`, in `accepts custom ops`, replace `validate() {},` with `falloff: false, params: {},`.

`packages/terrain/test/pipeline.test.ts`, in `names the op when it throws`, replace `validate() {},` with `falloff: false, params: {},`.

- [ ] **Step 8: Run every terrain and sandbox test**

Run: `npm test -w @elovox/terrain`
Expected: PASS, every existing test plus `schema` and `builtinSchemas`.

Run: `npm run typecheck -w @elovox/terrain`
Expected: no errors.

Run: `npm test -w @elovox/sandbox`
Expected: PASS, including `showcase columns match their golden hashes`. If a hash differs, a default in a schema does not match the old fallback in `compile`: compare that op's old `param(def, 'x', fallback)` calls (in `git show HEAD:packages/terrain/src/ops/<op>.ts`) with its schema, fix the schema, and rerun.

- [ ] **Step 9: Commit**

```bash
git add packages/terrain
git commit -m "feat(terrain): ops declare param schemas; unknown params and unused falloffs are errors"
```

### Task 3: `opBounds`

**Files:**
- Create: `packages/terrain/src/ops/bounds.ts`
- Modify: `packages/terrain/src/index.ts`
- Test: `packages/terrain/test/bounds.test.ts`

**Interfaces:**
- Consumes: `builtinOps`, `OpRegistry`, `CompileContext`, `Rect` (`src/geom.ts`).
- Produces: `opBounds(def: OpDef, doc: TerrainDoc, o?: { ops?: OpRegistry; height?: number }): Rect` — the closed xz rectangle the op can change, computed by compiling the op (a volume op's box loses its y). Throws `unknown op type "x"` for an unregistered type. Disabled ops still have bounds.

- [ ] **Step 1: Write the failing test**

`packages/terrain/test/bounds.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { OpDef, TerrainDoc } from '../src/doc/types.ts'
import { validateTerrainDoc } from '../src/doc/validate.ts'
import { opBounds } from '../src/ops/bounds.ts'
import { minimalDoc } from './fixtures.ts'

function doc(): TerrainDoc {
  const r = validateTerrainDoc(minimalDoc())
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.doc
}
const op = (o: Omit<OpDef, 'enabled'> & { enabled?: boolean }): OpDef => ({ enabled: true, ...o })

describe('opBounds', () => {
  it('is the compiled bounds of a height op, falloff included', () => {
    const def = op({ id: 'h', type: 'hills', shape: { kind: 'circle', center: [100, 100], radius: 20, falloff: 10 }, params: { amplitude: 4 } })
    expect(opBounds(def, doc())).toEqual({ x0: 70, z0: 70, x1: 130, z1: 130 })
  })

  it('includes reach the shape does not show, like river banks', () => {
    const def = op({ id: 'r', type: 'river', shape: { kind: 'path', width: 10, points: [{ x: 0, z: 50 }, { x: 100, z: 50 }] }, params: { start: 20, end: 12 } })
    expect(opBounds(def, doc())).toEqual({ x0: -21, z0: 29, x1: 121, z1: 71 })
  })

  it('drops the y of a volume op', () => {
    const def = op({ id: 'b', type: 'blob', shape: { kind: 'circle', center: [50, 60], radius: 10 }, params: { y: 30, height: 5, wobble: 0 } })
    expect(opBounds(def, doc())).toEqual({ x0: 40, z0: 50, x1: 60, z1: 70 })
  })

  it('works for a biome op and a disabled op', () => {
    const def = op({ id: 'p', type: 'biome', enabled: false, shape: { kind: 'circle', center: [10, 10], radius: 5 }, params: { biome: 'beach' } })
    expect(opBounds(def, doc())).toEqual({ x0: 5, z0: 5, x1: 15, z1: 15 })
  })

  it('throws for an unknown op type', () => {
    expect(() => opBounds(op({ id: 'v', type: 'volcano', shape: { kind: 'circle', center: [0, 0], radius: 1 }, params: {} }), doc())).toThrow('unknown op type "volcano"')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @elovox/terrain -- bounds`
Expected: FAIL — cannot find `../src/ops/bounds.ts`.

- [ ] **Step 3: Write the implementation**

`packages/terrain/src/ops/bounds.ts`:

```ts
import type { OpDef, TerrainDoc } from '../doc/types.ts'
import type { Rect } from '../geom.ts'
import { builtinOps } from './builtin.ts'
import type { CompileContext, OpRegistry } from './registry.ts'

/**
 * The closed xz rectangle an op can change, in blocks. It comes from compiling the op, the same step
 * that generates, so it cannot drift from what the op does. A volume op's box loses its y.
 */
export function opBounds(def: OpDef, doc: TerrainDoc, o: { ops?: OpRegistry; height?: number } = {}): Rect {
  const impl = (o.ops ?? builtinOps).get(def.type)
  if (!impl) throw new Error(`unknown op type "${def.type}"`)
  const names = doc.biomes.map((b) => b.name)
  const ctx: CompileContext = {
    seed: 0, height: o.height ?? 128, seaLevel: doc.seaLevel,
    biomeIndex: (name) => Math.max(0, names.indexOf(name)),
  }
  const b = impl.compile(def, ctx).bounds
  return { x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1 }
}
```

In `packages/terrain/src/index.ts` add:

```ts
export { opBounds } from './ops/bounds.ts'
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w @elovox/terrain -- bounds`
Expected: PASS (5 tests).

Run: `npm run typecheck -w @elovox/terrain`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/terrain/src/ops/bounds.ts packages/terrain/src/index.ts packages/terrain/test/bounds.test.ts
git commit -m "feat(terrain): opBounds, the area an op can change"
```

---

## Part B — Engine: regenerate only what changed

### Task 4: Chunk diffs and store reads

**Files:**
- Create: `packages/engine/src/sim/chunkDiff.ts`
- Modify: `packages/engine/src/world/chunkStore.ts`
- Test: `packages/engine/test/chunkDiff.test.ts`, `packages/engine/test/chunkStore.test.ts`

**Interfaces:**
- Produces:
  - `CHANGED = 1, NEG_X = 2, POS_X = 4, NEG_Y = 8, POS_Y = 16, NEG_Z = 32, POS_Z = 64`
  - `diffMask(a: ArrayLike<number>, b: ArrayLike<number>): number` — 0 if the two 32³ chunk arrays (index `lx + lz * 32 + ly * 1024`) are equal, else `CHANGED` plus the bit of every border slab that holds a difference.
  - `forNeighbours(mask: number, visit: (dx: number, dy: number, dz: number) => void): void` — visits every offset in {-1, 0, 1}³ \ {0} whose non-zero axes all have their slab bit set.
  - `ChunkStore.readVoxels(ci: number, scratch: Uint16Array): Uint16Array`, `ChunkStore.readLight(ci: number, scratch: Uint8Array): Uint8Array` — the slot's array, or `scratch` filled for a uniform chunk. Read only.
  - `ChunkStore.lightSnapshot(ci: number): Uint8Array | number` — a copy of a slot chunk's light, or the implied light value of a uniform chunk.

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/chunkDiff.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CHANGED, NEG_X, NEG_Y, NEG_Z, POS_X, POS_Y, POS_Z, diffMask, forNeighbours } from '../src/sim/chunkDiff.ts'
import { CHUNK_VOLUME, Layout } from '../src/world/layout.ts'

const at = (lx: number, ly: number, lz: number) => Layout.localIndex(lx, ly, lz)
function changed(...points: [number, number, number][]): Uint16Array {
  const a = new Uint16Array(CHUNK_VOLUME)
  for (const [x, y, z] of points) a[at(x, y, z)] = 1
  return a
}
function neighbours(mask: number): string[] {
  const out: string[] = []
  forNeighbours(mask, (dx, dy, dz) => out.push(`${dx},${dy},${dz}`))
  return out.sort()
}
const blank = new Uint16Array(CHUNK_VOLUME)

describe('diffMask', () => {
  it('is 0 for equal chunks', () => {
    expect(diffMask(blank, new Uint16Array(CHUNK_VOLUME))).toBe(0)
  })

  it('flags an interior change without border slabs', () => {
    expect(diffMask(blank, changed([16, 16, 16]))).toBe(CHANGED)
  })

  it('flags every border slab a difference lies on', () => {
    expect(diffMask(blank, changed([0, 5, 31]))).toBe(CHANGED | NEG_X | POS_Z)
    expect(diffMask(blank, changed([31, 31, 31]))).toBe(CHANGED | POS_X | POS_Y | POS_Z)
    expect(diffMask(blank, changed([5, 0, 5], [5, 31, 5]))).toBe(CHANGED | NEG_Y | POS_Y)
  })

  it('compares light arrays too', () => {
    const a = new Uint8Array(CHUNK_VOLUME), b = new Uint8Array(CHUNK_VOLUME)
    b[at(31, 4, 4)] = 15
    expect(diffMask(a, b)).toBe(CHANGED | POS_X)
  })
})

describe('forNeighbours', () => {
  it('visits nothing for no change or an interior change', () => {
    expect(neighbours(0)).toEqual([])
    expect(neighbours(CHANGED)).toEqual([])
  })

  it('visits the face, edge and corner neighbours whose facing slabs all changed', () => {
    expect(neighbours(CHANGED | NEG_X | POS_Z)).toEqual(['-1,0,0', '-1,0,1', '0,0,1'])
    expect(neighbours(CHANGED | POS_X | POS_Y | POS_Z)).toEqual(['0,0,1', '0,1,0', '0,1,1', '1,0,0', '1,0,1', '1,1,0', '1,1,1'])
  })

  it('visits all 26 neighbours when every slab changed', () => {
    expect(neighbours(CHANGED | NEG_X | POS_X | NEG_Y | POS_Y | NEG_Z | POS_Z)).toHaveLength(26)
  })
})
```

Append to `packages/engine/test/chunkStore.test.ts`, inside `describe('ChunkStore', …)`:

```ts
  it('reads a uniform chunk into the scratch array and a slot chunk from its slot', () => {
    const { store } = makeStore([64, 64, 64])
    const vox = new Uint16Array(32768), light = new Uint8Array(32768)
    expect(store.readVoxels(0, vox)).toBe(vox)
    expect(vox.every((v) => v === AIR)).toBe(true)
    expect(store.readLight(0, light).every((l) => l === FULL_SKY)).toBe(true)
    expect(store.lightSnapshot(0)).toBe(FULL_SKY)
    store.setVoxel(1, 1, 1, ID.stone)
    store.commit()
    const slotVox = store.readVoxels(0, vox)
    expect(slotVox).not.toBe(vox)
    expect(slotVox[1 + (1 << 5) + (1 << 10)]).toBe(ID.stone)
    const snap = store.lightSnapshot(0)
    expect(snap).toBeInstanceOf(Uint8Array)
    expect(snap).not.toBe(store.readLight(0, light)) // a copy, not the live slot
  })

  it('gives the implied light of an opaque uniform chunk', () => {
    const { store } = makeStore([64, 64, 64])
    store.writeChunkDense(0, new Uint16Array(32768).fill(ID.stone))
    store.commit()
    expect(store.lightSnapshot(0)).toBe(0)
    expect(store.readLight(0, new Uint8Array(32768)).every((l) => l === 0)).toBe(true)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/engine -- chunkDiff chunkStore`
Expected: FAIL — `chunkDiff.ts` not found; `store.readVoxels is not a function`.

- [ ] **Step 3: Write the implementation**

`packages/engine/src/sim/chunkDiff.ts`:

```ts
import { CHUNK_VOLUME } from '../world/layout.ts'

/** diffMask bits: something differs, then the six one-voxel border slabs of the chunk. */
export const CHANGED = 1
export const NEG_X = 2
export const POS_X = 4
export const NEG_Y = 8
export const POS_Y = 16
export const NEG_Z = 32
export const POS_Z = 64
const ALL = 127

/**
 * Compares two chunk arrays (voxels or light, index lx + lz * 32 + ly * 1024): 0 if equal, else
 * CHANGED plus the bit of every border slab holding a difference.
 */
export function diffMask(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0
  for (let i = 0; i < CHUNK_VOLUME; i++) {
    if (a[i] === b[i]) continue
    const lx = i & 31, lz = (i >> 5) & 31, ly = i >> 10
    m |= CHANGED
    if (lx === 0) m |= NEG_X
    else if (lx === 31) m |= POS_X
    if (ly === 0) m |= NEG_Y
    else if (ly === 31) m |= POS_Y
    if (lz === 0) m |= NEG_Z
    else if (lz === 31) m |= POS_Z
    if (m === ALL) return m
  }
  return m
}

/**
 * A neighbour's mesh reads a one-voxel apron of this chunk. Visits every neighbour offset whose
 * apron can hold a change: each non-zero axis of the offset must have its border slab flagged. A
 * changed edge voxel lies on both slabs, so this is a superset of the neighbours that need a remesh.
 */
export function forNeighbours(mask: number, visit: (dx: number, dy: number, dz: number) => void): void {
  if (!(mask & CHANGED)) return
  for (let dy = -1; dy <= 1; dy++) {
    if ((dy === -1 && !(mask & NEG_Y)) || (dy === 1 && !(mask & POS_Y))) continue
    for (let dz = -1; dz <= 1; dz++) {
      if ((dz === -1 && !(mask & NEG_Z)) || (dz === 1 && !(mask & POS_Z))) continue
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx === -1 && !(mask & NEG_X)) || (dx === 1 && !(mask & POS_X))) continue
        if (dx !== 0 || dy !== 0 || dz !== 0) visit(dx, dy, dz)
      }
    }
  }
}
```

In `packages/engine/src/world/chunkStore.ts`, add after `slotOf`:

```ts
  /** Chunk ci's voxels: its slot's array, or `scratch` filled with the uniform value. Do not write to it. */
  readVoxels(ci: number, scratch: Uint16Array): Uint16Array {
    const e = this.table[ci]!
    if (e >= 0) return this.views.voxels(e)
    scratch.fill(decodeUniform(e))
    return scratch
  }

  /** Chunk ci's light: its slot's array, or `scratch` filled with a uniform chunk's implied light. Do not write to it. */
  readLight(ci: number, scratch: Uint8Array): Uint8Array {
    const e = this.table[ci]!
    if (e >= 0) return this.views.light(e)
    scratch.fill(impliedLight(decodeUniform(e), this.opaque))
    return scratch
  }

  /** A copy of a slot chunk's light, or the single light value of a uniform chunk. */
  lightSnapshot(ci: number): Uint8Array | number {
    const e = this.table[ci]!
    return e >= 0 ? this.views.light(e).slice() : impliedLight(decodeUniform(e), this.opaque)
  }
```

(`decodeUniform` and `impliedLight` are already imported at the top of the file.)

- [ ] **Step 4: Run the tests**

Run: `npm test -w @elovox/engine -- chunkDiff chunkStore`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sim/chunkDiff.ts packages/engine/src/world/chunkStore.ts packages/engine/test/chunkDiff.test.ts packages/engine/test/chunkStore.test.ts
git commit -m "feat(engine): chunk diff masks and read-only chunk access"
```

### Task 5: `replaceColumns` writes and remeshes only what changed

Today `replaceColumns` rewrites every chunk of every column, relights the whole rectangle, and marks the full 3 × 3 ring at every height, plus the 26-neighbour marks the relight adds for each chunk it opens. The new flow:

1. Diff each new chunk against the world; collect only the changed ones. If none changed, return `[]` (identical voxels give identical light).
2. Snapshot the light of every chunk the relight can reach: the changed columns' bounding box plus `RELIGHT_MARGIN`, all heights. Above `regenLightDiffLimit` chunks (a whole-world regeneration), skip the snapshot and remesh every chunk the relight opened.
3. Write the changed chunks, relight that bounding box, commit.
4. Diff the light against the snapshot. Remesh every chunk whose voxels or light changed, plus the neighbours `forNeighbours` names.

**Files:**
- Modify: `packages/engine/src/sim/simulation.ts`
- Test: `packages/engine/test/replaceColumns.test.ts` (new), `packages/engine/test/regenerate.test.ts`

**Interfaces:**
- Consumes: Task 4's `diffMask`, `forNeighbours`, `readVoxels`, `readLight`, `lightSnapshot`; `RELIGHT_MARGIN` (`light.ts`).
- Produces: `SimulationOptions.regenLightDiffLimit?: number` (default 1024 chunks). `replaceColumns` keeps its signature and returns the sorted chunk indices to remesh.

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/replaceColumns.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { defineGenerator, type GeneratorModule } from '../src/sim/generator.ts'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

const SIZE = [128, 64, 96] as const // 4 × 3 chunk columns, 2 chunks high

/** Flat stone; a column listed in `raised` ("cx,cz") gets its own height. */
function ground(level: number, raised: Record<string, number> = {}): GeneratorModule {
  return defineGenerator({
    generateColumn(ctx, cx, cz) {
      const l = raised[`${cx},${cz}`] ?? level
      for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) for (let y = 0; y < l; y++) ctx.set(lx, y, lz, ID.stone)
    },
  })
}

/** Ground at 20 with a stone roof over x 40..69 and a torch under it; variant b moves both and digs a pit. */
function scene(variant: 'a' | 'b'): GeneratorModule {
  return defineGenerator({
    generateColumn(ctx, cx, cz) {
      for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
        const x = cx * 32 + lx, z = cz * 32 + lz
        const floor = variant === 'b' && x > 44 && x < 52 && z > 8 && z < 20 ? 12 : 20
        for (let y = 0; y < floor; y++) ctx.set(lx, y, lz, ID.stone)
        const roof = variant === 'a' ? x >= 40 && x < 70 : x >= 34 && x < 50 && z < 40
        if (roof && z < 50) ctx.set(lx, 30, lz, ID.stone)
        if (variant === 'a' && x === 50 && z === 10) ctx.set(lx, 21, lz, ID.torch)
        if (variant === 'b' && x === 40 && z === 20) ctx.set(lx, 21, lz, ID.torch)
      }
    },
  })
}

/** Column (1, 0) from b, the rest from a. */
const mixed = defineGenerator({
  generateColumn(ctx, cx, cz) { (cx === 1 && cz === 0 ? scene('b') : scene('a')).generateColumn(ctx, cx, cz) },
})

function world(gen: GeneratorModule, regenLightDiffLimit?: number): Simulation {
  const sim = new Simulation({ buffers: createWorldBuffers([...SIZE]), blocks: TEST_BLOCKS, seed: 1, regenLightDiffLimit })
  sim.generate(gen)
  return sim
}
function column(sim: Simulation, gen: GeneratorModule, cx: number, cz: number) {
  const data = new Uint16Array(32 * 32 * SIZE[1])
  sim.generateColumnData(gen, cx, cz, data)
  return { cx, cz, data }
}
function differences(a: Simulation, b: Simulation): number {
  let n = 0
  for (let y = 0; y < SIZE[1]; y++) for (let z = 0; z < SIZE[2]; z++) for (let x = 0; x < SIZE[0]; x++) {
    if (a.store.getVoxel(x, y, z) !== b.store.getVoxel(x, y, z) || a.store.getLight(x, y, z) !== b.store.getLight(x, y, z)) n++
  }
  return n
}
/** Every chunk whose voxels or light differ between two worlds. */
function changedChunks(a: Simulation, b: Simulation): number[] {
  const out = new Set<number>()
  for (let y = 0; y < SIZE[1]; y++) for (let z = 0; z < SIZE[2]; z++) for (let x = 0; x < SIZE[0]; x++) {
    if (a.store.getVoxel(x, y, z) !== b.store.getVoxel(x, y, z) || a.store.getLight(x, y, z) !== b.store.getLight(x, y, z)) out.add(a.layout.chunkOf(x, y, z))
  }
  return [...out]
}

describe('Simulation.replaceColumns', () => {
  it('writes nothing and remeshes nothing when the columns are unchanged', () => {
    const gen = ground(20)
    const sim = world(gen)
    const versions = Array.from(sim.store.versions)
    expect(sim.replaceColumns([column(sim, gen, 1, 0), column(sim, gen, 2, 1)])).toEqual([])
    expect(Array.from(sim.store.versions)).toEqual(versions)
  })

  it('remeshes the changed chunk and only the neighbours that see its changed borders', () => {
    const sim = world(ground(20))
    const dirty = sim.replaceColumns([column(sim, ground(20, { '1,0': 30 }), 1, 0)])
    const L = sim.layout
    // Ground 20 → 30 stays inside chunk row cy 0 and reaches its ±x and ±z borders (z = 0 is the world edge).
    const expected = [[1, 0], [0, 0], [2, 0], [0, 1], [1, 1], [2, 1]].map(([cx, cz]) => L.chunkIndex(cx!, 0, cz!))
    expect(dirty).toEqual(expected.sort((a, b) => a - b))
  })

  it('leaves the same voxels and light as generating the changed world from scratch', () => {
    const sim = world(scene('a'))
    sim.replaceColumns([column(sim, scene('b'), 1, 0)])
    expect(differences(sim, world(mixed))).toBe(0)
  })

  it('remeshes every chunk whose voxels or light changed, even outside the replaced columns', () => {
    const before = world(scene('a'))
    const sim = world(scene('a'))
    const dirty = sim.replaceColumns([column(sim, scene('b'), 1, 0)])
    const changed = changedChunks(before, sim)
    expect(changed.some((ci) => sim.layout.chunkCoords(ci)[0] === 0)).toBe(true) // torch light crossed into column 0
    for (const ci of changed) expect(dirty).toContain(ci)
  })

  it('falls back to every relit chunk above the light diff limit, with the same world', () => {
    const sim = world(scene('a'), 0)
    const dirty = sim.replaceColumns([column(sim, scene('b'), 1, 0)])
    expect(differences(sim, world(mixed))).toBe(0)
    for (const ci of changedChunks(world(scene('a')), sim)) expect(dirty).toContain(ci)
  })
})
```

In `packages/engine/test/regenerate.test.ts`, replace the test `marks the one-chunk ring around the replaced columns dirty` with:

```ts
  it('marks the changed chunks and the neighbours that see their borders dirty, nothing else', () => {
    const { host, out } = makeHost(levelGenerator(), { terrain: { level: 20 } })
    host.handle({ type: 'setTerrain', id: 1, doc: { level: 30 } })
    host.handle({ type: 'regenerate', id: 2, rect: { x0: 32, z0: 0, x1: 64, z1: 32 } })
    const r = answer(out, 'regenerated', 2)
    if (!r || r.type !== 'regenerated' || !r.ok) throw new Error('regeneration failed')
    const L = host.simulation!.layout
    // Ground 20 → 30 in column (1, 0) stays inside chunk row cy 0; the row above does not change.
    const expected = [[1, 0], [0, 0], [2, 0], [0, 1], [1, 1], [2, 1]].map(([cx, cz]) => L.chunkIndex(cx!, 0, cz!))
    expect(r.dirtyChunks).toEqual(expected.sort((a, b) => a - b))
  })

  it('reports no dirty chunks when the area did not change', () => {
    const { host, out } = makeHost(levelGenerator(), { terrain: { level: 20 } })
    host.handle({ type: 'regenerate', id: 1, rect: { x0: 0, z0: 0, x1: 96, z1: 64 } })
    expect(answer(out, 'regenerated', 1)).toMatchObject({ ok: true, dirtyChunks: [] })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/engine -- replaceColumns regenerate`
Expected: FAIL — the unchanged case returns a non-empty list and bumps versions; the dirty set includes cy 1 chunks and the 26-neighbour marks; `regenLightDiffLimit` is not a known option (typecheck) but runs.

- [ ] **Step 3: Write the implementation**

In `packages/engine/src/sim/simulation.ts`:

Change the imports:

```ts
import type { WorldBuffers } from '../world/buffers.ts'
import { ChunkStore, WorldFullError } from '../world/chunkStore.ts'
import { CHUNK_VOLUME, type Layout } from '../world/layout.ts'
```

```ts
import { diffMask, forNeighbours } from './chunkDiff.ts'
import { makeColumnContext, type GeneratorModule } from './generator.ts'
import { LightEngine, RELIGHT_MARGIN } from './light.ts'
```

Add to `SimulationOptions`:

```ts
  /** replaceColumns diffs light only over at most this many chunks; above it (a whole-world regeneration) it remeshes every relit chunk. Default 1024. */
  regenLightDiffLimit?: number
```

Add a private field next to `private readonly workCap: number`, and set it in the constructor (`constructor(o: SimulationOptions)`) right after `this.workCap = o.workCap ?? 50_000`:

```ts
  private readonly regenLightDiffLimit: number
```

```ts
    this.regenLightDiffLimit = o.regenLightDiffLimit ?? 1024
```

Replace `replaceColumns` with:

```ts
  /**
   * Swaps in freshly generated columns between ticks. Only chunks whose voxels differ are written;
   * light is recomputed around them, and the result lists only the chunks whose voxels or light
   * changed plus the neighbours that see a changed border (see forNeighbours). Unchanged columns
   * cost a compare and nothing else.
   */
  replaceColumns(cols: readonly { cx: number; cz: number; data: Uint16Array }[]): number[] {
    const L = this.layout, store = this.store
    // 1. Find the changed chunks. Nothing is written yet: the light snapshot needs the old world.
    const vox = new Uint16Array(CHUNK_VOLUME)
    const writes: { ci: number; data: Uint16Array }[] = []
    const masks = new Map<number, number>()
    let cx0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cz1 = -Infinity
    for (const c of cols) {
      if (c.data.length !== CHUNK_VOLUME * L.cy) throw new RangeError(`column has ${c.data.length} voxels, expected ${CHUNK_VOLUME * L.cy}`)
      for (let cy = 0; cy < L.cy; cy++) {
        const ci = L.chunkIndex(c.cx, cy, c.cz)
        const data = c.data.subarray(cy * CHUNK_VOLUME, (cy + 1) * CHUNK_VOLUME)
        const m = diffMask(store.readVoxels(ci, vox), data)
        if (m === 0) continue
        masks.set(ci, m)
        writes.push({ ci, data })
        cx0 = Math.min(cx0, c.cx); cz0 = Math.min(cz0, c.cz); cx1 = Math.max(cx1, c.cx); cz1 = Math.max(cz1, c.cz)
      }
    }
    if (writes.length === 0) return [] // identical voxels give identical light
    // 2. Light before, wherever the relight can reach.
    const x0 = cx0 * 32, z0 = cz0 * 32, x1 = cx1 * 32 + 32, z1 = cz1 * 32 + 32
    const reach: number[] = []
    const rx0 = Math.max(0, x0 - RELIGHT_MARGIN) >> 5, rz0 = Math.max(0, z0 - RELIGHT_MARGIN) >> 5
    const rx1 = (Math.min(L.size[0], x1 + RELIGHT_MARGIN) - 1) >> 5, rz1 = (Math.min(L.size[2], z1 + RELIGHT_MARGIN) - 1) >> 5
    for (let cy = 0; cy < L.cy; cy++) for (let cz = rz0; cz <= rz1; cz++) for (let cx = rx0; cx <= rx1; cx++) reach.push(L.chunkIndex(cx, cy, cz))
    const before = reach.length <= this.regenLightDiffLimit ? new Map(reach.map((ci) => [ci, store.lightSnapshot(ci)])) : null
    // 3. Write, relight, commit. commit() closes every written or relit chunk; its list over-marks and is only the fallback.
    for (const w of writes) store.writeChunkDense(w.ci, w.data)
    this.light.relightRegion(x0, z0, x1, z1)
    const relit = store.commit()
    // 4. What changed, and who sees it.
    const out = new Set<number>(before ? [] : relit)
    if (before) {
      const now = new Uint8Array(CHUNK_VOLUME), was = new Uint8Array(CHUNK_VOLUME)
      for (const [ci, old] of before) {
        const m = diffMask(typeof old === 'number' ? was.fill(old) : old, store.readLight(ci, now))
        if (m !== 0) masks.set(ci, (masks.get(ci) ?? 0) | m)
      }
    }
    for (const [ci, m] of masks) {
      out.add(ci)
      const [cx, cy, cz] = L.chunkCoords(ci)
      forNeighbours(m, (dx, dy, dz) => {
        if (L.chunkInBounds(cx + dx, cy + dy, cz + dz)) out.add(L.chunkIndex(cx + dx, cy + dy, cz + dz))
      })
    }
    return [...out].sort((a, b) => a - b)
  }
```

- [ ] **Step 4: Run the engine suite**

Run: `npm test -w @elovox/engine`
Expected: PASS, every test (279 before this plan, plus the new ones).

Run: `npm run typecheck -w @elovox/engine`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sim/simulation.ts packages/engine/test/replaceColumns.test.ts packages/engine/test/regenerate.test.ts
git commit -m "fix(engine): regeneration writes and remeshes only chunks that changed"
```

---

## Part C — `@elovox/terrain-editor` core (headless, tested in Node)

### Task 6: Package scaffold, document edits and new ops

**Files:**
- Create: `packages/terrain-editor/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`
- Create: `packages/terrain-editor/src/core/edits.ts`, `src/core/newOp.ts`
- Test: `packages/terrain-editor/test/fixtures.ts`, `test/edits.test.ts`, `test/newOp.test.ts`

**Interfaces:**
- Consumes: from `@elovox/terrain`: types `TerrainDoc, OpDef, ShapeDef, ShapeKind, PathPoint, Vec2, BaseDef, BlendMode, OpImpl, ParamSchema`; `resolveBound`, `validateTerrainDoc`, `BUILTIN_OPS`.
- Produces (`core/edits.ts`):
  - `type Edit = (doc: TerrainDoc) => TerrainDoc` — returns a new document sharing every unchanged part; never mutates.
  - `addOp(op: OpDef, index?: number): Edit`, `removeOp(id: string): Edit`, `replaceOp(id: string, op: OpDef): Edit`, `setEnabled(id: string, enabled: boolean): Edit`, `reorderOp(id: string, delta: number): Edit`, `setParam(id: string, key: string, value: unknown): Edit` (`undefined` deletes the key), `setBlend(id: string, blend: BlendMode | undefined): Edit`, `setShape(id: string, shape: ShapeDef): Edit`, `moveVertex(id: string, index: number, point: Vec2 | PathPoint): Edit`, `insertVertex(id: string, index: number, point: Vec2 | PathPoint): Edit`, `removeVertex(id: string, index: number): Edit`, `setSeaLevel(level: number): Edit`, `setBase(base: BaseDef): Edit`. An unknown id throws `no op "<id>"`; vertex edits on a circle throw `a circle has no vertices`.
- Produces (`core/newOp.ts`):
  - `NEW_RADIUS = 48`, `NEW_HALF = 48` (half the side of a new square, half the length of a new path), `NEW_WIDTH = 12`
  - `nextOpId(doc: TerrainDoc, type: string): string` — the smallest free `${type}-${n}`, n ≥ 1.
  - `newParams(schema: ParamSchema, doc: TerrainDoc, ground: number, height: number): Record<string, unknown>`
  - `newShape(kind: ShapeKind, at: Vec2, needY: boolean, ground: number): ShapeDef`
  - `interface NewOpPlace { at: Vec2; ground: number; height: number }`
  - `newOp(impl: OpImpl, kind: ShapeKind, doc: TerrainDoc, place: NewOpPlace): OpDef`

- [ ] **Step 1: Create the package**

`packages/terrain-editor/package.json`:

```json
{
  "name": "@elovox/terrain-editor",
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
    "typecheck": "tsc --noEmit -p ."
  },
  "dependencies": {
    "@elovox/engine": "0.1.0",
    "@elovox/terrain": "0.1.0",
    "three": "0.186.1"
  },
  "devDependencies": {
    "@types/node": "^26.6.4",
    "@types/three": "^0.186.0",
    "typescript": "^7.0.2",
    "vitest": "4.1.11"
  }
}
```

`packages/terrain-editor/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test"]
}
```

`packages/terrain-editor/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
})
```

`packages/terrain-editor/src/index.ts` (later tasks add to it):

```ts
export * from './core/edits.ts'
export { NEW_HALF, NEW_RADIUS, NEW_WIDTH, newOp, newParams, newShape, nextOpId, type NewOpPlace } from './core/newOp.ts'
```

Link the workspace:

```bash
npm install
```

Expected: `node_modules/@elovox/terrain-editor` is a link to `packages/terrain-editor`.

- [ ] **Step 2: Write the test fixtures and failing tests**

`packages/terrain-editor/test/fixtures.ts`:

```ts
import { validateTerrainDoc, type TerrainDoc } from '@elovox/terrain'

export const SIZE: [number, number] = [256, 256]
export const HEIGHT = 128

/** A 256 × 256 document with one op of each shape kind and a volume op. */
export function rawDoc(): Record<string, unknown> {
  return {
    format: 'elovox-terrain', version: 1, size: [...SIZE], seaLevel: 10,
    base: { height: 30, amplitude: 4, noise: { scale: 64 } },
    biomes: [
      { name: 'plain', surface: [{ block: 'grass' }, { block: 'dirt', depth: [1, 3] }] },
      { name: 'mesa', surface: [{ block: 'sand' }] },
    ],
    biomeRule: { default: 'plain' },
    ops: [
      { id: 'hill', type: 'hills', shape: { kind: 'circle', center: [64, 64], radius: 20, falloff: 8 }, params: { amplitude: 10 } },
      { id: 'ridge', type: 'mountain', shape: { kind: 'path', width: 24, points: [{ x: 150, z: 40 }, { x: 200, z: 90 }] }, params: { height: 30 } },
      { id: 'pond', type: 'lake', shape: { kind: 'polygon', points: [[100, 180], [140, 180], [140, 220], [100, 220]] }, params: { level: 28 } },
      { id: 'rock', type: 'blob', shape: { kind: 'circle', center: [200, 200], radius: 6 }, params: { y: 40, height: 5 } },
    ],
  }
}

export function doc(): TerrainDoc {
  const r = validateTerrainDoc(rawDoc(), { worldHeight: HEIGHT })
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.doc
}

/** Freezes a value deeply, so a test fails if code under test mutates it. */
export function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}
```

`packages/terrain-editor/test/edits.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { OpDef } from '@elovox/terrain'
import {
  addOp, insertVertex, moveVertex, removeOp, removeVertex, reorderOp, replaceOp, setBase, setBlend, setEnabled, setParam, setSeaLevel, setShape,
} from '../src/core/edits.ts'
import { deepFreeze, doc } from './fixtures.ts'

const frozen = () => deepFreeze(doc())
const ids = (d: { ops: OpDef[] }) => d.ops.map((o) => o.id)
const extra: OpDef = { id: 'flat', type: 'flatten', enabled: true, shape: { kind: 'circle', center: [30, 30], radius: 8 }, params: { y: 30 } }

describe('document edits', () => {
  it('add an op at the end or at an index, sharing the other ops', () => {
    const d = frozen()
    const a = addOp(extra)(d)
    expect(ids(a)).toEqual(['hill', 'ridge', 'pond', 'rock', 'flat'])
    expect(a.ops[0]).toBe(d.ops[0])
    expect(ids(addOp(extra, 1)(d))).toEqual(['hill', 'flat', 'ridge', 'pond', 'rock'])
  })

  it('remove and replace an op; an unknown id throws', () => {
    const d = frozen()
    expect(ids(removeOp('ridge')(d))).toEqual(['hill', 'pond', 'rock'])
    const r = replaceOp('pond', { ...extra, id: 'pond' })(d)
    expect(r.ops[2]!.type).toBe('flatten')
    expect(r.ops[1]).toBe(d.ops[1])
    expect(() => removeOp('nope')(d)).toThrow('no op "nope"')
  })

  it('toggle enabled', () => {
    expect(setEnabled('hill', false)(frozen()).ops[0]!.enabled).toBe(false)
  })

  it('reorder by a delta, clamped to the list, and return the same document when nothing moves', () => {
    const d = frozen()
    expect(ids(reorderOp('ridge', 1)(d))).toEqual(['hill', 'pond', 'ridge', 'rock'])
    expect(ids(reorderOp('ridge', -5)(d))).toEqual(['ridge', 'hill', 'pond', 'rock'])
    expect(reorderOp('hill', -1)(d)).toBe(d)
  })

  it('set and delete a param', () => {
    const d = frozen()
    expect(setParam('hill', 'offset', 3)(d).ops[0]!.params).toEqual({ amplitude: 10, offset: 3 })
    expect(setParam('hill', 'amplitude', undefined)(d).ops[0]!.params).toEqual({})
  })

  it('set and clear the blend', () => {
    const d = frozen()
    const a = setBlend('hill', 'max')(d)
    expect(a.ops[0]!.blend).toBe('max')
    expect('blend' in setBlend('hill', undefined)(a).ops[0]!).toBe(false)
  })

  it('replace a shape', () => {
    const shape = { kind: 'circle' as const, center: [10, 10] as [number, number], radius: 3 }
    expect(setShape('hill', shape)(frozen()).ops[0]!.shape).toEqual(shape)
  })

  it('move, insert and remove vertices of polygons and paths', () => {
    const d = frozen()
    const moved = moveVertex('pond', 0, [90, 170])(d)
    expect(moved.ops[2]!.shape).toMatchObject({ points: [[90, 170], [140, 180], [140, 220], [100, 220]] })
    const inserted = insertVertex('ridge', 1, { x: 170, z: 70 })(d)
    expect(inserted.ops[1]!.shape).toMatchObject({ points: [{ x: 150, z: 40 }, { x: 170, z: 70 }, { x: 200, z: 90 }] })
    expect(removeVertex('pond', 3)(d).ops[2]!.shape).toMatchObject({ points: [[100, 180], [140, 180], [140, 220]] })
    expect(() => moveVertex('hill', 0, [1, 1])(d)).toThrow('a circle has no vertices')
  })

  it('set the sea level and the base fill', () => {
    const d = frozen()
    expect(setSeaLevel(14)(d).seaLevel).toBe(14)
    const base = { ...d.base, amplitude: 9 }
    const b = setBase(base)(d)
    expect(b.base).toBe(base)
    expect(b.ops).toBe(d.ops)
  })
})
```

`packages/terrain-editor/test/newOp.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BUILTIN_OPS, builtinOps, validateTerrainDoc, type OpImpl } from '@elovox/terrain'
import { addOp } from '../src/core/edits.ts'
import { newOp, newParams, newShape, nextOpId } from '../src/core/newOp.ts'
import { HEIGHT, doc } from './fixtures.ts'

const impl = (type: string): OpImpl => builtinOps.get(type)!

describe('nextOpId', () => {
  it('takes the smallest free number', () => {
    const d = doc()
    expect(nextOpId(d, 'hills')).toBe('hills-1')
    const one = addOp(newOp(impl('hills'), 'circle', d, { at: [50, 50], ground: 30, height: HEIGHT }))(d)
    expect(nextOpId(one, 'hills')).toBe('hills-2')
  })
})

describe('newParams', () => {
  it('sets required params from their defaults, anchored heights from the ground, the first biome', () => {
    const d = doc()
    expect(newParams(impl('hills').params, d, 30, HEIGHT)).toEqual({ amplitude: 12 })
    expect(newParams(impl('plateau').params, d, 30, HEIGHT)).toEqual({ top: 54, base: 30 })
    expect(newParams(impl('river').params, d, 30, HEIGHT)).toEqual({ start: 30, end: 24 })
    expect(newParams(impl('biome').params, d, 30, HEIGHT)).toEqual({ biome: 'plain' })
  })

  it('clamps anchored heights into their bounds', () => {
    expect(newParams(impl('river').params, doc(), 3, HEIGHT)).toEqual({ start: 3, end: 1 })
    expect(newParams(impl('plateau').params, doc(), 120, HEIGHT)).toEqual({ top: 128, base: 120 })
  })
})

describe('newShape', () => {
  it('makes a circle, a square and a straight path around the point', () => {
    expect(newShape('circle', [100, 80], false, 30)).toEqual({ kind: 'circle', center: [100, 80], radius: 48 })
    expect(newShape('polygon', [100, 80], false, 30)).toEqual({ kind: 'polygon', points: [[52, 32], [148, 32], [148, 128], [52, 128]] })
    expect(newShape('path', [100, 80], false, 30)).toEqual({ kind: 'path', width: 12, points: [{ x: 52, z: 80 }, { x: 148, z: 80 }] })
    expect(newShape('path', [100, 80], true, 30)).toEqual({ kind: 'path', width: 12, points: [{ x: 52, z: 80, y: 30 }, { x: 148, z: 80, y: 30 }] })
  })
})

describe('newOp', () => {
  const cases = BUILTIN_OPS.flatMap((o) => o.shapes.map((kind) => [o.type, kind] as const))
  it.each(cases)('a new %s (%s) is a valid op', (type, kind) => {
    const d = doc()
    const op = newOp(impl(type), kind, d, { at: [128, 128], ground: 30, height: HEIGHT })
    expect(op).toMatchObject({ id: `${type}-1`, type, enabled: true })
    const r = validateTerrainDoc(addOp(op)(d), { worldHeight: HEIGHT })
    expect(r.ok ? [] : r.errors).toEqual([])
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w @elovox/terrain-editor`
Expected: FAIL — `../src/core/edits.ts` and `../src/core/newOp.ts` not found.

- [ ] **Step 4: Write the implementation**

`packages/terrain-editor/src/core/edits.ts`:

```ts
import type { BaseDef, BlendMode, OpDef, PathPoint, ShapeDef, TerrainDoc, Vec2 } from '@elovox/terrain'

/** A change to a document: returns a new document that shares every unchanged part. Never mutates its input. */
export type Edit = (doc: TerrainDoc) => TerrainDoc

function indexOf(doc: TerrainDoc, id: string): number {
  const i = doc.ops.findIndex((o) => o.id === id)
  if (i < 0) throw new Error(`no op "${id}"`)
  return i
}

function mapOp(id: string, f: (op: OpDef) => OpDef): Edit {
  return (doc) => {
    const i = indexOf(doc, id)
    const ops = doc.ops.slice()
    ops[i] = f(doc.ops[i]!)
    return { ...doc, ops }
  }
}

function withPoints(shape: ShapeDef, f: (points: (Vec2 | PathPoint)[]) => void): ShapeDef {
  if (shape.kind === 'circle') throw new Error('a circle has no vertices')
  const points: (Vec2 | PathPoint)[] = shape.points.slice()
  f(points)
  return { ...shape, points } as ShapeDef
}

export function addOp(op: OpDef, index?: number): Edit {
  return (doc) => {
    const ops = doc.ops.slice()
    ops.splice(index ?? ops.length, 0, op)
    return { ...doc, ops }
  }
}

export function removeOp(id: string): Edit {
  return (doc) => {
    const i = indexOf(doc, id)
    return { ...doc, ops: doc.ops.filter((_, j) => j !== i) }
  }
}

export function replaceOp(id: string, op: OpDef): Edit {
  return mapOp(id, () => op)
}

export function setEnabled(id: string, enabled: boolean): Edit {
  return mapOp(id, (op) => ({ ...op, enabled }))
}

/** Moves an op `delta` places (negative = earlier), clamped to the list. */
export function reorderOp(id: string, delta: number): Edit {
  return (doc) => {
    const i = indexOf(doc, id)
    const j = Math.max(0, Math.min(doc.ops.length - 1, i + delta))
    if (j === i) return doc
    const ops = doc.ops.slice()
    const [op] = ops.splice(i, 1)
    ops.splice(j, 0, op!)
    return { ...doc, ops }
  }
}

/** Sets params[key]; `undefined` removes it (the param falls back to its default). */
export function setParam(id: string, key: string, value: unknown): Edit {
  return mapOp(id, (op) => {
    const params = { ...op.params }
    if (value === undefined) delete params[key]
    else params[key] = value
    return { ...op, params }
  })
}

/** Sets the blend; `undefined` removes it (the op type's default blend applies). */
export function setBlend(id: string, blend: BlendMode | undefined): Edit {
  return mapOp(id, (op) => {
    const { blend: _old, ...rest } = op
    return blend === undefined ? rest : { ...rest, blend }
  })
}

export function setShape(id: string, shape: ShapeDef): Edit {
  return mapOp(id, (op) => ({ ...op, shape }))
}

export function moveVertex(id: string, index: number, point: Vec2 | PathPoint): Edit {
  return mapOp(id, (op) => ({ ...op, shape: withPoints(op.shape, (p) => { p[index] = point }) }))
}

export function insertVertex(id: string, index: number, point: Vec2 | PathPoint): Edit {
  return mapOp(id, (op) => ({ ...op, shape: withPoints(op.shape, (p) => { p.splice(index, 0, point) }) }))
}

export function removeVertex(id: string, index: number): Edit {
  return mapOp(id, (op) => ({ ...op, shape: withPoints(op.shape, (p) => { p.splice(index, 1) }) }))
}

export function setSeaLevel(level: number): Edit {
  return (doc) => ({ ...doc, seaLevel: level })
}

export function setBase(base: BaseDef): Edit {
  return (doc) => ({ ...doc, base })
}
```

`packages/terrain-editor/src/core/newOp.ts`:

```ts
import { resolveBound, type OpDef, type OpImpl, type ParamSchema, type ShapeDef, type ShapeKind, type TerrainDoc, type Vec2 } from '@elovox/terrain'

/** Radius of a new circle. */
export const NEW_RADIUS = 48
/** Half the side of a new square, and half the length of a new path. */
export const NEW_HALF = 48
/** Width of a new path. */
export const NEW_WIDTH = 12

/** The smallest `${type}-${n}` (n ≥ 1) that no op in the document uses. */
export function nextOpId(doc: TerrainDoc, type: string): string {
  for (let n = 1; ; n++) {
    const id = `${type}-${n}`
    if (!doc.ops.some((o) => o.id === id)) return id
  }
}

/**
 * The params a new op starts with: every required number at its default (an anchored one relative to
 * `ground`, rounded and clamped into its bounds) and the document's first biome for a biome param.
 * Optional params are left out, so they follow their defaults.
 */
export function newParams(schema: ParamSchema, doc: TerrainDoc, ground: number, height: number): Record<string, unknown> {
  const ctx = { biomes: doc.biomes.map((b) => b.name), height }
  const out: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(schema)) {
    if (spec.type === 'biome') { out[key] = ctx.biomes[0]; continue }
    if (spec.type !== 'number' || !spec.required) continue
    let v = (spec.default ?? 0) + (spec.anchor === 'ground' ? Math.round(ground) : 0)
    if (spec.min !== undefined) v = Math.max(spec.min, v)
    const max = resolveBound(spec.max, ctx)
    if (max !== undefined) v = Math.min(max, v)
    out[key] = spec.int ? Math.round(v) : v
  }
  return out
}

/** A new shape centred on `at`: a circle, a square, or a straight path along x (with y = ground where needed). */
export function newShape(kind: ShapeKind, at: Vec2, needY: boolean, ground: number): ShapeDef {
  const x = Math.round(at[0]), z = Math.round(at[1])
  switch (kind) {
    case 'circle': return { kind, center: [x, z], radius: NEW_RADIUS }
    case 'polygon': return { kind, points: [[x - NEW_HALF, z - NEW_HALF], [x + NEW_HALF, z - NEW_HALF], [x + NEW_HALF, z + NEW_HALF], [x - NEW_HALF, z + NEW_HALF]] }
    case 'path': {
      const y = Math.round(ground)
      const point = (px: number) => (needY ? { x: px, z, y } : { x: px, z })
      return { kind, width: NEW_WIDTH, points: [point(x - NEW_HALF), point(x + NEW_HALF)] }
    }
  }
}

export interface NewOpPlace {
  /** Where the op goes (x, z). */
  at: Vec2
  /** Ground height there. */
  ground: number
  /** World height. */
  height: number
}

/** A valid new op of `impl`'s type and the given shape kind, ready for addOp. */
export function newOp(impl: OpImpl, kind: ShapeKind, doc: TerrainDoc, place: NewOpPlace): OpDef {
  return {
    id: nextOpId(doc, impl.type),
    type: impl.type,
    enabled: true,
    shape: newShape(kind, place.at, impl.needY ?? false, place.ground),
    params: newParams(impl.params, doc, place.ground, place.height),
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -w @elovox/terrain-editor`
Expected: PASS — edits (9), newOp (4 + one per op type and shape kind).

Run: `npm run typecheck -w @elovox/terrain-editor`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/terrain-editor package-lock.json
git commit -m "feat(terrain-editor): package scaffold, document edits and new ops"
```

### Task 7: Dirty areas

**Files:**
- Create: `packages/terrain-editor/src/core/area.ts`
- Modify: `packages/terrain-editor/src/index.ts`
- Test: `packages/terrain-editor/test/area.test.ts`

**Interfaces:**
- Consumes: `opBounds`, `FEATURE_REACH`, `type Rect`, `type OpRegistry`, `type TerrainDoc`, `type Vec2` from `@elovox/terrain`.
- Produces:
  - `interface AreaRect { x0: number; z0: number; x1: number; z1: number }` — half-open integer rectangle (`x0 <= x < x1`), the shape of the engine's `TerrainRect`.
  - `type Area = AreaRect | 'all' | null`
  - `AREA_PAD = FEATURE_REACH + 1`
  - `toArea(r: Rect, size: Vec2): AreaRect | null`
  - `unionArea(a: Area, b: Area): Area`
  - `interface AreaOptions { ops?: OpRegistry; height: number }`
  - `diffArea(prev: TerrainDoc, next: TerrainDoc, o: AreaOptions): Area`

- [ ] **Step 1: Write the failing test**

`packages/terrain-editor/test/area.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { diffArea, toArea, unionArea } from '../src/core/area.ts'
import { addOp, removeOp, reorderOp, setBase, setParam, setSeaLevel, setShape } from '../src/core/edits.ts'
import { HEIGHT, SIZE, doc } from './fixtures.ts'

const o = { height: HEIGHT }

describe('toArea', () => {
  it('pads by what a column reads from its neighbours and rounds out to chunk columns', () => {
    expect(toArea({ x0: 44, z0: 44, x1: 84, z1: 84 }, SIZE)).toEqual({ x0: 32, z0: 32, x1: 96, z1: 96 })
  })

  it('clips to the world and is null fully outside it', () => {
    expect(toArea({ x0: -50, z0: 240, x1: 10, z1: 300 }, SIZE)).toEqual({ x0: 0, z0: 224, x1: 32, z1: 256 })
    expect(toArea({ x0: -100, z0: 0, x1: -20, z1: 10 }, SIZE)).toBeNull()
  })
})

describe('unionArea', () => {
  it('combines rectangles, absorbs null and is swallowed by all', () => {
    const a = { x0: 0, z0: 0, x1: 32, z1: 32 }, b = { x0: 64, z0: 32, x1: 96, z1: 64 }
    expect(unionArea(a, b)).toEqual({ x0: 0, z0: 0, x1: 96, z1: 64 })
    expect(unionArea(null, a)).toBe(a)
    expect(unionArea(a, null)).toBe(a)
    expect(unionArea(a, 'all')).toBe('all')
    expect(unionArea(null, null)).toBeNull()
  })
})

describe('diffArea', () => {
  // hill: circle (64, 64) r 20 falloff 8 → bounds 36..92 → padded and rounded: 0..128.
  const hillArea = { x0: 0, z0: 0, x1: 128, z1: 128 }

  it('is null for the same or an equal document', () => {
    const d = doc()
    expect(diffArea(d, d, o)).toBeNull()
    expect(diffArea(d, doc(), o)).toBeNull()
  })

  it('covers a changed op', () => {
    const d = doc()
    expect(diffArea(d, setParam('hill', 'amplitude', 3)(d), o)).toEqual(hillArea)
  })

  it('covers where a moved op was and where it is', () => {
    const d = doc()
    const moved = setShape('hill', { kind: 'circle', center: [200, 64], radius: 20, falloff: 8 })(d)
    expect(diffArea(d, moved, o)).toEqual({ x0: 0, z0: 0, x1: 256, z1: 128 })
  })

  it('covers an added or removed op', () => {
    const d = doc()
    const flat = { id: 'f', type: 'flatten', enabled: true, shape: { kind: 'circle' as const, center: [16, 240] as [number, number], radius: 4 }, params: { y: 30 } }
    expect(diffArea(d, addOp(flat)(d), o)).toEqual({ x0: 0, z0: 224, x1: 32, z1: 256 })
    expect(diffArea(d, removeOp('hill')(d), o)).toEqual(hillArea)
  })

  it('covers both ops of a swap', () => {
    const d = doc()
    // ridge: path (150,40)-(200,90) w 24 → 138..212 × 28..102 → 128..224 × 0..128; pond: lake 100..140 × 180..220 + shore 16 → 84..156 × 164..236 → 64..192 × 128..256.
    expect(diffArea(d, reorderOp('ridge', 1)(d), o)).toEqual({ x0: 64, z0: 0, x1: 224, z1: 256 })
  })

  it('is the whole world for a change outside the ops', () => {
    const d = doc()
    expect(diffArea(d, setSeaLevel(12)(d), o)).toBe('all')
    expect(diffArea(d, setBase({ ...d.base, height: 40 })(d), o)).toBe('all')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @elovox/terrain-editor -- area`
Expected: FAIL — `../src/core/area.ts` not found.

- [ ] **Step 3: Write the implementation**

`packages/terrain-editor/src/core/area.ts`:

```ts
import { FEATURE_REACH, opBounds, type OpDef, type OpRegistry, type Rect, type TerrainDoc, type Vec2 } from '@elovox/terrain'

/** A half-open integer rectangle (x0 <= x < x1, z0 <= z < z1): the engine's TerrainRect. */
export interface AreaRect { x0: number; z0: number; x1: number; z1: number }
/** Where the world must be regenerated: a rectangle, everything, or nothing. */
export type Area = AreaRect | 'all' | null

/** A column reads one neighbour column for its slope and FEATURE_REACH blocks for trees and rocks. */
export const AREA_PAD = FEATURE_REACH + 1

/** A closed rectangle in blocks, padded by AREA_PAD, rounded out to chunk columns and clipped to the world; null if outside it. */
export function toArea(r: Rect, size: Vec2): AreaRect | null {
  const x0 = Math.max(0, Math.floor((r.x0 - AREA_PAD) / 32) * 32)
  const z0 = Math.max(0, Math.floor((r.z0 - AREA_PAD) / 32) * 32)
  const x1 = Math.min(size[0], Math.ceil((r.x1 + 1 + AREA_PAD) / 32) * 32)
  const z1 = Math.min(size[1], Math.ceil((r.z1 + 1 + AREA_PAD) / 32) * 32)
  return x0 < x1 && z0 < z1 ? { x0, z0, x1, z1 } : null
}

export function unionArea(a: Area, b: Area): Area {
  if (a === 'all' || b === 'all') return 'all'
  if (a === null) return b
  if (b === null) return a
  return { x0: Math.min(a.x0, b.x0), z0: Math.min(a.z0, b.z0), x1: Math.max(a.x1, b.x1), z1: Math.max(a.z1, b.z1) }
}

export interface AreaOptions { ops?: OpRegistry; height: number }

/** Document fields that apply everywhere: a change to any of them dirties the whole world. */
const GLOBAL_FIELDS = ['size', 'seaLevel', 'blocks', 'base', 'biomes', 'biomeRule', 'layers'] as const

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

/**
 * The area whose voxels can differ between two valid documents: every op added, removed or changed
 * (where it was and where it is) and every op whose order among the others changed. An op only
 * changes columns inside its bounds, so inserting or removing one leaves the rest alone.
 */
export function diffArea(prev: TerrainDoc, next: TerrainDoc, o: AreaOptions): Area {
  if (prev === next) return null
  for (const k of GLOBAL_FIELDS) if (!same(prev[k], next[k])) return 'all'
  const area = (def: OpDef, doc: TerrainDoc) => toArea(opBounds(def, doc, o), next.size)
  const before = new Map(prev.ops.map((op) => [op.id, op]))
  const after = new Map(next.ops.map((op) => [op.id, op]))
  let out: Area = null
  for (const [id, op] of before) {
    const now = after.get(id)
    if (now && same(op, now)) continue
    out = unionArea(out, area(op, prev))
    if (now) out = unionArea(out, area(now, next))
  }
  for (const [id, op] of after) if (!before.has(id)) out = unionArea(out, area(op, next))
  const common = (ops: readonly OpDef[]) => ops.filter((op) => before.has(op.id) && after.has(op.id)).map((op) => op.id)
  const a = common(prev.ops), b = common(next.ops)
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    out = unionArea(out, area(before.get(a[i]!)!, prev))
    out = unionArea(out, area(after.get(b[i]!)!, next))
  }
  return out
}
```

Add to `packages/terrain-editor/src/index.ts`:

```ts
export { AREA_PAD, diffArea, toArea, unionArea, type Area, type AreaOptions, type AreaRect } from './core/area.ts'
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w @elovox/terrain-editor -- area`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/terrain-editor/src/core/area.ts packages/terrain-editor/src/index.ts packages/terrain-editor/test/area.test.ts
git commit -m "feat(terrain-editor): dirty areas between two documents"
```

### Task 8: History and the editor session

**Files:**
- Create: `packages/terrain-editor/src/core/history.ts`, `src/core/session.ts`
- Modify: `packages/terrain-editor/src/index.ts`
- Test: `packages/terrain-editor/test/history.test.ts`, `test/session.test.ts`

**Interfaces:**
- Consumes: `Edit` (Task 6), `Area`, `diffArea` (Task 7), `validateTerrainDoc`, `OpRegistry`, `TerrainDoc`.
- Produces (`core/history.ts`):
  - `interface Step { readonly label: string; readonly before: TerrainDoc; readonly after: TerrainDoc }`
  - `class History { constructor(limit?: number /* 200 */); push(step: Step): void; undo(): Step | null; redo(): Step | null; clear(): void; readonly canUndo: boolean; readonly canRedo: boolean }`
- Produces (`core/session.ts`):
  - `type Cause = 'edit' | 'gesture' | 'commit' | 'cancel' | 'undo' | 'redo' | 'open'`
  - `interface ChangeEvent { doc: TerrainDoc; prev: TerrainDoc; area: Area; cause: Cause }`
  - `type EditResult = { ok: true } | { ok: false; errors: string[] }`
  - `interface SessionOptions { worldHeight: number; ops?: OpRegistry; historyLimit?: number }`
  - `class EditorSession` with: `constructor(doc: TerrainDoc, o: SessionOptions)`; getters `doc`, `selected: string | null`, `dirty: boolean`, `canUndo`, `canRedo`, `inGesture`; `on('change', fn: (e: ChangeEvent) => void): () => void`; `on('select', fn: (id: string | null) => void): () => void`; `select(id: string | null): void`; `apply(label: string, edit: Edit): EditResult`; `begin(label: string): void`; `update(edit: Edit): EditResult`; `commit(): void`; `cancel(): void`; `undo(): boolean`; `redo(): boolean`; `open(doc: TerrainDoc): void`; `markSaved(): void`.
  - Rules: the document is always valid (a refused edit changes nothing). During a gesture, `update(edit)` applies `edit` to the gesture's **start** document, so drags pass absolute values. `apply` and `begin` throw `a gesture is in progress` during a gesture. `undo`/`redo` during a gesture cancel it and do nothing else. `commit` emits a `change` with `cause: 'commit'` and the area between start and end. `dirty` compares the current document to the last saved one by identity. Removing the selected op clears the selection. `open` replaces the document, clears history and selection, marks it saved and emits area `'all'`.

- [ ] **Step 1: Write the failing tests**

`packages/terrain-editor/test/history.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { History, type Step } from '../src/core/history.ts'
import { doc } from './fixtures.ts'

const step = (label: string): Step => ({ label, before: doc(), after: doc() })

describe('History', () => {
  it('undoes and redoes in order', () => {
    const h = new History()
    const a = step('a'), b = step('b')
    h.push(a); h.push(b)
    expect(h.undo()).toBe(b)
    expect(h.undo()).toBe(a)
    expect(h.undo()).toBeNull()
    expect(h.redo()).toBe(a)
    expect(h.canUndo && h.canRedo).toBe(true)
  })

  it('drops the redo branch on a new step', () => {
    const h = new History()
    h.push(step('a')); h.undo(); h.push(step('b'))
    expect(h.canRedo).toBe(false)
  })

  it('keeps at most `limit` steps', () => {
    const h = new History(2)
    h.push(step('a')); h.push(step('b')); h.push(step('c'))
    expect([h.undo()?.label, h.undo()?.label, h.undo()]).toEqual(['c', 'b', null])
  })

  it('clears', () => {
    const h = new History()
    h.push(step('a')); h.clear()
    expect(h.canUndo || h.canRedo).toBe(false)
  })
})
```

`packages/terrain-editor/test/session.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { removeOp, setParam, setSeaLevel, setShape } from '../src/core/edits.ts'
import { EditorSession, type ChangeEvent } from '../src/core/session.ts'
import { HEIGHT, doc } from './fixtures.ts'

function session() {
  const s = new EditorSession(doc(), { worldHeight: HEIGHT })
  const changes: ChangeEvent[] = []
  const selects: (string | null)[] = []
  s.on('change', (e) => changes.push(e))
  s.on('select', (id) => selects.push(id))
  return { s, changes, selects }
}
const circle = (x: number, r = 20) => ({ kind: 'circle' as const, center: [x, 64] as [number, number], radius: r, falloff: 8 })

describe('EditorSession edits', () => {
  it('applies a valid edit as one undo step and reports its area', () => {
    const { s, changes } = session()
    expect(s.apply('amplitude', setParam('hill', 'amplitude', 3))).toEqual({ ok: true })
    expect(s.doc.ops[0]!.params.amplitude).toBe(3)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ cause: 'edit', area: { x0: 0, z0: 0, x1: 128, z1: 128 } })
    expect(s.dirty && s.canUndo).toBe(true)
  })

  it('refuses an invalid edit and changes nothing', () => {
    const { s, changes } = session()
    const before = s.doc
    const r = s.apply('amplitude', setParam('hill', 'amplitude', -1))
    expect(r).toEqual({ ok: false, errors: ['ops[0].params.amplitude: must be >= 0'] })
    expect(s.doc).toBe(before)
    expect(changes).toHaveLength(0)
    expect(s.canUndo).toBe(false)
  })

  it('undoes and redoes back to the saved document', () => {
    const { s, changes } = session()
    const start = s.doc
    s.apply('amplitude', setParam('hill', 'amplitude', 3))
    expect(s.undo()).toBe(true)
    expect(s.doc).toBe(start)
    expect(s.dirty).toBe(false)
    expect(s.redo()).toBe(true)
    expect(s.doc.ops[0]!.params.amplitude).toBe(3)
    expect(changes.map((c) => c.cause)).toEqual(['edit', 'undo', 'redo'])
    expect(s.undo() && s.undo()).toBe(false)
  })

  it('reports the whole world for a sea level change', () => {
    const { s, changes } = session()
    s.apply('sea level', setSeaLevel(12))
    expect(changes[0]!.area).toBe('all')
  })
})

describe('EditorSession gestures', () => {
  it('applies each update to the start document and records one step on commit', () => {
    const { s, changes } = session()
    const start = s.doc
    s.begin('move hill')
    s.update(setShape('hill', circle(70)))
    s.update(setShape('hill', circle(80)))
    expect(s.doc.ops[0]!.shape).toEqual(circle(80))
    s.commit()
    expect(changes.map((c) => c.cause)).toEqual(['gesture', 'gesture', 'commit'])
    expect(changes[2]!.prev).toBe(start)
    s.undo()
    expect(s.doc).toBe(start)
    expect(s.canUndo).toBe(false)
  })

  it('keeps the last valid document when an update is invalid', () => {
    const { s } = session()
    s.begin('radius')
    s.update(setShape('hill', circle(64, 10)))
    const r = s.update(setShape('hill', circle(64, 0)))
    expect(r.ok).toBe(false)
    expect(s.doc.ops[0]!.shape).toEqual(circle(64, 10))
    s.commit()
    expect(s.doc.ops[0]!.shape).toEqual(circle(64, 10))
  })

  it('cancels back to the start document without a history step', () => {
    const { s, changes } = session()
    const start = s.doc
    s.begin('move hill')
    s.update(setShape('hill', circle(80)))
    s.cancel()
    expect(s.doc).toBe(start)
    expect(s.canUndo).toBe(false)
    expect(changes.map((c) => c.cause)).toEqual(['gesture', 'cancel'])
  })

  it('records nothing for a gesture that changed nothing', () => {
    const { s, changes } = session()
    s.begin('noop')
    s.commit()
    expect(s.canUndo).toBe(false)
    expect(changes).toHaveLength(0)
  })

  it('treats undo during a gesture as cancel, leaving earlier steps alone', () => {
    const { s } = session()
    s.apply('amplitude', setParam('hill', 'amplitude', 3))
    const afterEdit = s.doc
    s.begin('move hill')
    s.update(setShape('hill', circle(80)))
    expect(s.undo()).toBe(true)
    expect(s.doc).toBe(afterEdit)
    expect(s.inGesture).toBe(false)
    expect(s.canUndo).toBe(true)
  })

  it('refuses apply and begin during a gesture', () => {
    const { s } = session()
    s.begin('a')
    expect(() => s.apply('b', setSeaLevel(3))).toThrow('a gesture is in progress')
    expect(() => s.begin('c')).toThrow('a gesture is in progress')
  })
})

describe('EditorSession selection, open and save', () => {
  it('selects known ops only and clears the selection when the op goes away', () => {
    const { s, selects } = session()
    s.select('ridge')
    s.select('nope')
    s.select('pond')
    s.apply('remove', removeOp('pond'))
    expect(s.selected).toBeNull()
    expect(selects).toEqual(['ridge', null, 'pond', null])
  })

  it('opens a document: no history, nothing selected, saved, whole world', () => {
    const { s, changes } = session()
    s.apply('amplitude', setParam('hill', 'amplitude', 3))
    s.select('hill')
    const other = doc()
    s.open(other)
    expect(s.doc).toBe(other)
    expect(s.canUndo || s.dirty).toBe(false)
    expect(s.selected).toBeNull()
    expect(changes.at(-1)).toMatchObject({ cause: 'open', area: 'all' })
  })

  it('marks the current document saved', () => {
    const { s } = session()
    s.apply('amplitude', setParam('hill', 'amplitude', 3))
    s.markSaved()
    expect(s.dirty).toBe(false)
    s.undo()
    expect(s.dirty).toBe(true)
  })

  it('keeps edited documents normalized', () => {
    const { s } = session()
    s.apply('amplitude', setParam('hill', 'amplitude', 3))
    s.apply('offset', setParam('hill', 'offset', undefined))
    expect(JSON.parse(JSON.stringify(s.doc))).toEqual(s.doc)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/terrain-editor -- history session`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementation**

`packages/terrain-editor/src/core/history.ts`:

```ts
import type { TerrainDoc } from '@elovox/terrain'

/** One undoable change: the documents before and after it. */
export interface Step { readonly label: string; readonly before: TerrainDoc; readonly after: TerrainDoc }

export class History {
  private readonly limit: number
  private readonly done: Step[] = []
  private readonly undone: Step[] = []

  constructor(limit = 200) { this.limit = limit }

  get canUndo(): boolean { return this.done.length > 0 }
  get canRedo(): boolean { return this.undone.length > 0 }

  push(step: Step): void {
    this.done.push(step)
    if (this.done.length > this.limit) this.done.shift()
    this.undone.length = 0
  }

  undo(): Step | null {
    const s = this.done.pop()
    if (!s) return null
    this.undone.push(s)
    return s
  }

  redo(): Step | null {
    const s = this.undone.pop()
    if (!s) return null
    this.done.push(s)
    return s
  }

  clear(): void {
    this.done.length = 0
    this.undone.length = 0
  }
}
```

`packages/terrain-editor/src/core/session.ts`:

```ts
import { validateTerrainDoc, type OpRegistry, type TerrainDoc } from '@elovox/terrain'
import { diffArea, type Area } from './area.ts'
import type { Edit } from './edits.ts'
import { History } from './history.ts'

export type Cause = 'edit' | 'gesture' | 'commit' | 'cancel' | 'undo' | 'redo' | 'open'

/** The document changed (or, for 'commit', a gesture ended). `area` is what the world must regenerate. */
export interface ChangeEvent { doc: TerrainDoc; prev: TerrainDoc; area: Area; cause: Cause }

export type EditResult = { ok: true } | { ok: false; errors: string[] }

export interface SessionOptions {
  worldHeight: number
  ops?: OpRegistry
  historyLimit?: number
}

const OK: EditResult = { ok: true }

/**
 * The document being edited. It is always valid: an edit that would make it invalid is refused and
 * changes nothing. Edits go through apply (one undo step) or a gesture (begin, any number of update,
 * then commit or cancel; one undo step).
 */
export class EditorSession {
  private readonly o: SessionOptions
  private readonly history: History
  private current: TerrainDoc
  private saved: TerrainDoc
  private sel: string | null = null
  private gesture: { label: string; start: TerrainDoc } | null = null
  private readonly changeFns = new Set<(e: ChangeEvent) => void>()
  private readonly selectFns = new Set<(id: string | null) => void>()

  constructor(doc: TerrainDoc, o: SessionOptions) {
    this.o = o
    this.history = new History(o.historyLimit)
    this.current = doc
    this.saved = doc
  }

  get doc(): TerrainDoc { return this.current }
  get selected(): string | null { return this.sel }
  /** The document differs from the last one saved or opened. */
  get dirty(): boolean { return this.current !== this.saved }
  get canUndo(): boolean { return this.history.canUndo }
  get canRedo(): boolean { return this.history.canRedo }
  get inGesture(): boolean { return this.gesture !== null }

  on(type: 'change', fn: (e: ChangeEvent) => void): () => void
  on(type: 'select', fn: (id: string | null) => void): () => void
  on(type: 'change' | 'select', fn: ((e: ChangeEvent) => void) | ((id: string | null) => void)): () => void {
    const set = (type === 'change' ? this.changeFns : this.selectFns) as Set<typeof fn>
    set.add(fn)
    return () => { set.delete(fn) }
  }

  /** Selects an op by id; an id the document does not have selects nothing. */
  select(id: string | null): void {
    const next = id !== null && this.current.ops.some((o) => o.id === id) ? id : null
    if (next === this.sel) return
    this.sel = next
    for (const fn of this.selectFns) fn(next)
  }

  /** Applies one edit as one undo step. */
  apply(label: string, edit: Edit): EditResult {
    if (this.gesture) throw new Error('a gesture is in progress')
    const r = this.attempt(edit(this.current))
    if (!r.ok) return r
    if (r.doc === this.current) return OK
    this.history.push({ label, before: this.current, after: r.doc })
    this.set(r.doc, 'edit')
    return OK
  }

  /** Starts a gesture (a drag, a slider): its updates become one undo step. */
  begin(label: string): void {
    if (this.gesture) throw new Error('a gesture is in progress')
    this.gesture = { label, start: this.current }
  }

  /** Replaces the gesture's result with `edit` applied to the document the gesture started from. */
  update(edit: Edit): EditResult {
    const g = this.gesture
    if (!g) throw new Error('no gesture in progress')
    const r = this.attempt(edit(g.start))
    if (!r.ok) return r
    if (r.doc !== this.current) this.set(r.doc, 'gesture')
    return OK
  }

  commit(): void {
    const g = this.gesture
    if (!g) return
    this.gesture = null
    if (this.current === g.start) return
    this.history.push({ label: g.label, before: g.start, after: this.current })
    this.emit({ doc: this.current, prev: g.start, area: this.area(g.start, this.current), cause: 'commit' })
  }

  cancel(): void {
    const g = this.gesture
    if (!g) return
    this.gesture = null
    if (this.current !== g.start) this.set(g.start, 'cancel')
  }

  /** Undoes the last step; during a gesture, cancels the gesture instead. */
  undo(): boolean {
    if (this.gesture) { this.cancel(); return true }
    const s = this.history.undo()
    if (!s) return false
    this.set(s.before, 'undo')
    return true
  }

  /** Redoes the last undone step; during a gesture, cancels the gesture instead. */
  redo(): boolean {
    if (this.gesture) { this.cancel(); return true }
    const s = this.history.redo()
    if (!s) return false
    this.set(s.after, 'redo')
    return true
  }

  /** Replaces the document (a file was opened): no history, nothing selected, saved. */
  open(doc: TerrainDoc): void {
    this.gesture = null
    this.history.clear()
    const prev = this.current
    this.current = doc
    this.saved = doc
    this.select(null)
    this.emit({ doc, prev, area: 'all', cause: 'open' })
  }

  markSaved(): void { this.saved = this.current }

  private attempt(doc: TerrainDoc): { ok: true; doc: TerrainDoc } | { ok: false; errors: string[] } {
    if (doc === this.current) return { ok: true, doc }
    const r = validateTerrainDoc(doc, { ops: this.o.ops, worldHeight: this.o.worldHeight })
    // Keep the candidate, not r.doc: validation rebuilds every op, and the candidate shares the unchanged ones.
    return r.ok ? { ok: true, doc } : r
  }

  private set(doc: TerrainDoc, cause: Cause): void {
    const prev = this.current
    this.current = doc
    if (this.sel !== null && !doc.ops.some((o) => o.id === this.sel)) this.select(null)
    this.emit({ doc, prev, area: this.area(prev, doc), cause })
  }

  private area(prev: TerrainDoc, next: TerrainDoc): Area {
    return diffArea(prev, next, { ops: this.o.ops, height: this.o.worldHeight })
  }

  private emit(e: ChangeEvent): void {
    for (const fn of this.changeFns) fn(e)
  }
}
```

Add to `packages/terrain-editor/src/index.ts`:

```ts
export { History, type Step } from './core/history.ts'
export { EditorSession, type Cause, type ChangeEvent, type EditResult, type SessionOptions } from './core/session.ts'
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w @elovox/terrain-editor`
Expected: PASS (all core tests so far).

Run: `npm run typecheck -w @elovox/terrain-editor`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/terrain-editor/src/core/history.ts packages/terrain-editor/src/core/session.ts packages/terrain-editor/src/index.ts packages/terrain-editor/test/history.test.ts packages/terrain-editor/test/session.test.ts
git commit -m "feat(terrain-editor): editor session with gestures, undo and selection"
```

### Task 9: The preview scheduler

**Files:**
- Create: `packages/terrain-editor/src/core/preview.ts`
- Modify: `packages/terrain-editor/src/index.ts`
- Test: `packages/terrain-editor/test/preview.test.ts`

**Interfaces:**
- Consumes: `Area`, `AreaRect`, `unionArea` (Task 7), `ChangeEvent` (Task 8).
- Produces:
  - `interface TerrainTarget { setDocument(doc: unknown): Promise<void>; regenerate(rect: AreaRect): Promise<{ ms: number; chunks: number }> }` — `engine.terrain` fits it.
  - `type PreviewStatus = { state: 'idle'; last: { ms: number; chunks: number; wallMs: number } | null } | { state: 'busy' } | { state: 'error'; message: string; opId: string | null }`
  - `interface PreviewOptions { size: Vec2; onStatus?(s: PreviewStatus): void; settle?(): Promise<void>; now?(): number }`
  - `class PreviewScheduler { constructor(target: TerrainTarget, initial: TerrainDoc, o: PreviewOptions); readonly status: PreviewStatus; onChange(e: ChangeEvent): void; push(doc: TerrainDoc, area: Area): void; idle(): Promise<void> }`
  - Rules: at most one regeneration in flight; edits that arrive meanwhile merge into one pending area and the latest document; `setDocument` only when the document differs from the one the engine has; a whole-world change during a gesture waits for its commit, and is dropped on cancel; a commit of an op gesture sends nothing (it was previewed live); a failed area is retried with the next regeneration; `opId` comes from the engine's `op "<id>" failed …` message; after the last regeneration, `settle()` (the mesh queue draining) ends the busy state and gives `wallMs`.

- [ ] **Step 1: Write the failing test**

`packages/terrain-editor/test/preview.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { TerrainDoc } from '@elovox/terrain'
import type { AreaRect } from '../src/core/area.ts'
import { setParam, setSeaLevel } from '../src/core/edits.ts'
import { PreviewScheduler, type PreviewStatus, type TerrainTarget } from '../src/core/preview.ts'
import type { ChangeEvent } from '../src/core/session.ts'
import { SIZE, doc } from './fixtures.ts'

type Call = ['set', TerrainDoc] | ['regen', AreaRect]

function fake() {
  const calls: Call[] = []
  const waiting: { resolve: () => void; reject: (e: Error) => void }[] = []
  const target: TerrainTarget = {
    setDocument(d) { calls.push(['set', d as TerrainDoc]); return Promise.resolve() },
    regenerate(rect) {
      calls.push(['regen', rect])
      return new Promise((res, rej) => waiting.push({ resolve: () => res({ ms: 5, chunks: 3 }), reject: rej }))
    },
  }
  return { target, calls, waiting }
}
const tick = () => new Promise((r) => setTimeout(r, 0))
const A: AreaRect = { x0: 0, z0: 0, x1: 32, z1: 32 }
const B: AreaRect = { x0: 64, z0: 64, x1: 96, z1: 96 }
const C: AreaRect = { x0: 128, z0: 0, x1: 160, z1: 32 }
const ev = (d: TerrainDoc, area: ChangeEvent['area'], cause: ChangeEvent['cause']): ChangeEvent => ({ doc: d, prev: d, area, cause })

function setup(settle?: () => Promise<void>) {
  const f = fake()
  const statuses: PreviewStatus[] = []
  const start = doc()
  const p = new PreviewScheduler(f.target, start, { size: SIZE, settle, onStatus: (s) => statuses.push(s), now: () => 0 })
  return { ...f, p, start, statuses }
}

describe('PreviewScheduler', () => {
  it('sends the new document, then regenerates the area', async () => {
    const { p, start, calls, waiting } = setup()
    const d1 = setParam('hill', 'amplitude', 3)(start)
    p.onChange(ev(d1, A, 'edit'))
    await tick()
    expect(calls).toEqual([['set', d1], ['regen', A]])
    waiting[0]!.resolve()
    await p.idle()
    expect(p.status).toEqual({ state: 'idle', last: { ms: 5, chunks: 3, wallMs: 0 } })
  })

  it('keeps one regeneration in flight and merges what arrives meanwhile, latest document first', async () => {
    const { p, start, calls, waiting } = setup()
    const d1 = setParam('hill', 'amplitude', 3)(start), d2 = setParam('hill', 'amplitude', 4)(start), d3 = setParam('hill', 'amplitude', 5)(start)
    p.onChange(ev(d1, A, 'gesture'))
    p.onChange(ev(d2, B, 'gesture'))
    p.onChange(ev(d3, C, 'gesture'))
    await tick()
    expect(calls).toHaveLength(2)
    waiting[0]!.resolve()
    await tick()
    expect(calls.slice(2)).toEqual([['set', d3], ['regen', { x0: 64, z0: 0, x1: 160, z1: 96 }]])
    waiting[1]!.resolve()
    await p.idle()
  })

  it('skips setDocument when the engine already has the document', async () => {
    const { p, start, calls, waiting } = setup()
    p.push(start, A)
    await tick()
    expect(calls).toEqual([['regen', A]])
    waiting[0]!.resolve()
    await p.idle()
  })

  it('ignores changes without an area and op-gesture commits', async () => {
    const { p, start, calls } = setup()
    p.onChange(ev(start, null, 'edit'))
    p.onChange(ev(setParam('hill', 'amplitude', 3)(start), A, 'commit'))
    await tick()
    expect(calls).toEqual([])
  })

  it('holds a whole-world gesture until it is committed', async () => {
    const { p, start, calls, waiting } = setup()
    const d1 = setSeaLevel(12)(start), d2 = setSeaLevel(13)(start)
    p.onChange(ev(d1, 'all', 'gesture'))
    p.onChange(ev(d2, 'all', 'gesture'))
    await tick()
    expect(calls).toEqual([])
    p.onChange(ev(d2, 'all', 'commit'))
    await tick()
    expect(calls).toEqual([['set', d2], ['regen', { x0: 0, z0: 0, x1: SIZE[0], z1: SIZE[1] }]])
    waiting[0]!.resolve()
    await p.idle()
  })

  it('drops a cancelled whole-world gesture', async () => {
    const { p, start, calls } = setup()
    p.onChange(ev(setSeaLevel(12)(start), 'all', 'gesture'))
    p.onChange(ev(start, 'all', 'cancel'))
    await tick()
    expect(calls).toEqual([])
  })

  it('reports a failing op and retries its area with the next edit', async () => {
    const { p, start, calls, waiting, statuses } = setup()
    p.push(setParam('hill', 'amplitude', 3)(start), A)
    await tick()
    waiting[0]!.reject(new Error('op "hill" failed at columns x 0..32, z 0..32: boom'))
    await p.idle()
    expect(p.status).toEqual({ state: 'error', message: 'op "hill" failed at columns x 0..32, z 0..32: boom', opId: 'hill' })
    p.push(setParam('hill', 'amplitude', 4)(start), B)
    await tick()
    expect(calls.at(-1)).toEqual(['regen', { x0: 0, z0: 0, x1: 96, z1: 96 }])
    waiting[1]!.resolve()
    await p.idle()
    expect(statuses.at(-1)!.state).toBe('idle')
  })

  it('stays busy until the meshes settle, then reports the wall time', async () => {
    let settled!: () => void
    const { p, start, waiting } = setup(() => new Promise<void>((r) => { settled = r }))
    p.push(setParam('hill', 'amplitude', 3)(start), A)
    await tick()
    waiting[0]!.resolve()
    await p.idle()
    expect(p.status.state).toBe('busy')
    settled()
    await tick()
    expect(p.status.state).toBe('idle')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @elovox/terrain-editor -- preview`
Expected: FAIL — `../src/core/preview.ts` not found.

- [ ] **Step 3: Write the implementation**

`packages/terrain-editor/src/core/preview.ts`:

```ts
import type { TerrainDoc, Vec2 } from '@elovox/terrain'
import { unionArea, type Area, type AreaRect } from './area.ts'
import type { ChangeEvent } from './session.ts'

/** What the preview drives; `engine.terrain` fits it. */
export interface TerrainTarget {
  setDocument(doc: unknown): Promise<void>
  regenerate(rect: AreaRect): Promise<{ ms: number; chunks: number }>
}

export type PreviewStatus =
  | { state: 'idle'; last: { ms: number; chunks: number; wallMs: number } | null }
  | { state: 'busy' }
  | { state: 'error'; message: string; opId: string | null }

export interface PreviewOptions {
  /** World x and z. */
  size: Vec2
  onStatus?(s: PreviewStatus): void
  /** Resolves when the regenerated chunks are visible (the mesh queue drained). Default: at once. */
  settle?(): Promise<void>
  now?(): number
}

/**
 * Keeps the world in step with the session. One regeneration runs at a time; changes that arrive
 * meanwhile merge into one pending area and the latest document, so the world always catches up to
 * the newest state without replaying the ones in between.
 */
export class PreviewScheduler {
  private readonly target: TerrainTarget
  private readonly o: PreviewOptions
  /** The document the engine has. */
  private sent: TerrainDoc
  private latest: TerrainDoc
  private pending: Area = null
  /** Areas whose regeneration failed: retried with the next one. */
  private failed: Area = null
  /** A whole-world change waits for its gesture to end. */
  private deferred = false
  private running: Promise<void> | null = null
  private generation = 0
  private current: PreviewStatus = { state: 'idle', last: null }

  constructor(target: TerrainTarget, initial: TerrainDoc, o: PreviewOptions) {
    this.target = target
    this.o = o
    this.sent = initial
    this.latest = initial
  }

  get status(): PreviewStatus { return this.current }

  /** Feeds a session change. */
  onChange(e: ChangeEvent): void {
    if (e.cause === 'gesture' && e.area === 'all') {
      this.deferred = true // a full regeneration takes seconds: wait for the release
      this.latest = e.doc
      return
    }
    if (e.cause === 'commit' || e.cause === 'cancel') {
      const deferred = this.deferred
      this.deferred = false
      if (e.cause === 'commit' && !deferred) return // an op gesture was previewed while it ran
      if (e.cause === 'cancel' && deferred) { this.latest = e.doc; return } // the world never left the start
    }
    this.push(e.doc, e.area)
  }

  /** Brings `area` of the world up to `doc`. */
  push(doc: TerrainDoc, area: Area): void {
    this.latest = doc
    if (area === null) return
    this.pending = unionArea(this.pending, area)
    this.kick()
  }

  /** Resolves once nothing is pending or running. */
  idle(): Promise<void> {
    return this.running ? this.running.then(() => this.idle()) : Promise.resolve()
  }

  private kick(): void {
    if (this.running || this.pending === null) return
    this.running = this.loop().finally(() => {
      this.running = null
      this.kick() // something may have arrived between the loop's last check and here
    })
  }

  private async loop(): Promise<void> {
    while (this.pending !== null) {
      const area = unionArea(this.pending, this.failed)
      const doc = this.latest
      this.pending = null
      this.failed = null
      const gen = ++this.generation
      const t0 = this.now()
      this.setStatus({ state: 'busy' })
      try {
        if (doc !== this.sent) {
          await this.target.setDocument(doc)
          this.sent = doc
        }
        const r = await this.target.regenerate(this.rectOf(area))
        if (this.pending === null) void this.settle(gen, r, t0)
      } catch (e) {
        this.failed = unionArea(this.failed, area)
        const message = e instanceof Error ? e.message : String(e)
        this.setStatus({ state: 'error', message, opId: /op "([^"]+)"/.exec(message)?.[1] ?? null })
      }
    }
  }

  private async settle(gen: number, r: { ms: number; chunks: number }, t0: number): Promise<void> {
    await this.o.settle?.()
    if (gen !== this.generation || this.current.state === 'error') return // a newer regeneration owns the status
    this.setStatus({ state: 'idle', last: { ms: r.ms, chunks: r.chunks, wallMs: this.now() - t0 } })
  }

  private rectOf(area: Exclude<Area, null>): AreaRect {
    return area === 'all' ? { x0: 0, z0: 0, x1: this.o.size[0], z1: this.o.size[1] } : area
  }

  private now(): number { return this.o.now ? this.o.now() : performance.now() }

  private setStatus(s: PreviewStatus): void {
    this.current = s
    this.o.onStatus?.(s)
  }
}
```

Add to `packages/terrain-editor/src/index.ts`:

```ts
export { PreviewScheduler, type PreviewOptions, type PreviewStatus, type TerrainTarget } from './core/preview.ts'
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w @elovox/terrain-editor -- preview`
Expected: PASS (8 tests).

Note on the "settle" test: `idle()` resolves when the loop ends, which is before `settle()` resolves; the status must still be `busy` at that point. If `settle` is undefined, `await undefined` resolves on the next microtask, so the "sends the new document" test sees `idle` after `await p.idle()` (the `.finally` hop runs after it).

- [ ] **Step 5: Commit**

```bash
git add packages/terrain-editor/src/core/preview.ts packages/terrain-editor/src/index.ts packages/terrain-editor/test/preview.test.ts
git commit -m "feat(terrain-editor): preview scheduler with coalescing and retry"
```

### Task 10: Opening and saving documents

**Files:**
- Create: `packages/terrain-editor/src/core/docio.ts`, `src/ui/files.ts`
- Modify: `packages/terrain-editor/src/index.ts`
- Test: `packages/terrain-editor/test/docio.test.ts`, `test/files.test.ts`

**Interfaces:**
- Produces (`core/docio.ts`):
  - `type ParseResult = { ok: true; doc: TerrainDoc } | { ok: false; errors: string[] }`
  - `parseTerrainText(text: string, o: { size: Vec2; worldHeight: number; ops?: OpRegistry }): ParseResult` — errors: `not JSON: <message>`; validation errors with paths; `size: the document is AxB but the world is CxD`.
  - `serializeTerrain(doc: TerrainDoc): string` — two-space JSON plus a final newline.
- Produces (`ui/files.ts`):
  - `interface FileHandle { readonly name: string; getFile(): Promise<{ text(): Promise<string> }>; createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }> }`
  - `interface FileHost { showOpenFilePicker?(o?: unknown): Promise<FileHandle[]>; showSaveFilePicker?(o?: unknown): Promise<FileHandle> }`
  - `interface OpenedFile { name: string; text: string; handle: FileHandle | null }`
  - `interface FileFallback { pick(): Promise<OpenedFile | null>; download(name: string, text: string): void }`
  - `class TerrainFiles { constructor(host: FileHost, fallback: FileFallback); readonly native: boolean; open(): Promise<OpenedFile | null>; save(text: string, handle: FileHandle | null, suggestedName: string): Promise<{ handle: FileHandle | null; name: string } | null> }` — `null` means the user cancelled.
  - `browserFallback(doc: Document): FileFallback` — `<input type=file>` and an `<a download>`.

- [ ] **Step 1: Write the failing tests**

`packages/terrain-editor/test/docio.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseTerrainText, serializeTerrain } from '../src/core/docio.ts'
import { HEIGHT, SIZE, doc, rawDoc } from './fixtures.ts'

const o = { size: SIZE, worldHeight: HEIGHT }

describe('parseTerrainText', () => {
  it('reads a valid document', () => {
    const r = parseTerrainText(JSON.stringify(rawDoc()), o)
    expect(r.ok && r.doc.ops.map((op) => op.id)).toEqual(['hill', 'ridge', 'pond', 'rock'])
  })

  it('rejects text that is not JSON', () => {
    const r = parseTerrainText('{ nope', o)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.errors[0]).toMatch(/^not JSON: /)
  })

  it('returns validation errors with their paths', () => {
    expect(parseTerrainText(JSON.stringify({ ...rawDoc(), seaLevel: -1 }), o)).toEqual({ ok: false, errors: ['seaLevel: must be >= 0'] })
  })

  it('rejects a document of another size', () => {
    expect(parseTerrainText(JSON.stringify({ ...rawDoc(), size: [512, 512] }), o)).toEqual({
      ok: false, errors: ['size: the document is 512 × 512 but the world is 256 × 256'],
    })
  })
})

describe('serializeTerrain', () => {
  it('writes two-space JSON with a final newline that reads back equal', () => {
    const d = doc()
    const text = serializeTerrain(d)
    expect(text.endsWith('}\n')).toBe(true)
    expect(text.split('\n')[1]).toBe('  "format": "elovox-terrain",')
    const r = parseTerrainText(text, o)
    expect(r.ok && r.doc).toEqual(d)
  })
})
```

`packages/terrain-editor/test/files.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { TerrainFiles, type FileFallback, type FileHandle, type FileHost, type OpenedFile } from '../src/ui/files.ts'

function handle(name: string, text = '') {
  const written: string[] = []
  const h: FileHandle = {
    name,
    getFile: async () => ({ text: async () => text }),
    createWritable: async () => ({ write: async (d: string) => { written.push(d) }, close: async () => {} }),
  }
  return { h, written }
}
const abort = () => Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })
function fallback(picked: OpenedFile | null = null) {
  const downloads: [string, string][] = []
  const f: FileFallback = { pick: async () => picked, download: (n, t) => { downloads.push([n, t]) } }
  return { f, downloads }
}

describe('TerrainFiles with the File System Access API', () => {
  it('opens a file and keeps its handle', async () => {
    const { h } = handle('map.terrain.json', '{"a":1}')
    const files = new TerrainFiles({ showOpenFilePicker: async () => [h], showSaveFilePicker: async () => h }, fallback().f)
    expect(files.native).toBe(true)
    expect(await files.open()).toEqual({ name: 'map.terrain.json', text: '{"a":1}', handle: h })
  })

  it('returns null when the user cancels a picker', async () => {
    const host: FileHost = { showOpenFilePicker: async () => { throw abort() }, showSaveFilePicker: async () => { throw abort() } }
    const files = new TerrainFiles(host, fallback().f)
    expect(await files.open()).toBeNull()
    expect(await files.save('x', null, 'a.terrain.json')).toBeNull()
  })

  it('writes to the open handle without asking', async () => {
    const { h, written } = handle('map.terrain.json')
    let asked = false
    const files = new TerrainFiles({ showOpenFilePicker: async () => [h], showSaveFilePicker: async () => { asked = true; return h } }, fallback().f)
    expect(await files.save('text', h, 'ignored.json')).toEqual({ handle: h, name: 'map.terrain.json' })
    expect(written).toEqual(['text'])
    expect(asked).toBe(false)
  })

  it('asks where to save when there is no handle (Save as)', async () => {
    const { h, written } = handle('new.terrain.json')
    const files = new TerrainFiles({ showOpenFilePicker: async () => [h], showSaveFilePicker: async () => h }, fallback().f)
    expect(await files.save('text', null, 'showcase.terrain.json')).toEqual({ handle: h, name: 'new.terrain.json' })
    expect(written).toEqual(['text'])
  })

  it('passes other picker errors on', async () => {
    const files = new TerrainFiles({ showOpenFilePicker: async () => { throw new Error('denied') } }, fallback().f)
    await expect(files.open()).rejects.toThrow('denied')
  })
})

describe('TerrainFiles without the API', () => {
  it('opens through the fallback picker and saves by download', async () => {
    const picked = { name: 'a.json', text: '{}', handle: null }
    const { f, downloads } = fallback(picked)
    const files = new TerrainFiles({}, f)
    expect(files.native).toBe(false)
    expect(await files.open()).toBe(picked)
    expect(await files.save('text', null, 'showcase.terrain.json')).toEqual({ handle: null, name: 'showcase.terrain.json' })
    expect(downloads).toEqual([['showcase.terrain.json', 'text']])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/terrain-editor -- docio files`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementation**

`packages/terrain-editor/src/core/docio.ts`:

```ts
import { validateTerrainDoc, type OpRegistry, type TerrainDoc, type Vec2 } from '@elovox/terrain'

export type ParseResult = { ok: true; doc: TerrainDoc } | { ok: false; errors: string[] }

/** Reads `.terrain.json` text into a valid document for a world of `size` (x, z). */
export function parseTerrainText(text: string, o: { size: Vec2; worldHeight: number; ops?: OpRegistry }): ParseResult {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    return { ok: false, errors: [`not JSON: ${e instanceof Error ? e.message : String(e)}`] }
  }
  const r = validateTerrainDoc(json, { ops: o.ops, worldHeight: o.worldHeight })
  if (!r.ok) return r
  const [dx, dz] = r.doc.size
  if (dx !== o.size[0] || dz !== o.size[1]) {
    return { ok: false, errors: [`size: the document is ${dx} × ${dz} but the world is ${o.size[0]} × ${o.size[1]}`] }
  }
  return r
}

/** The document as `.terrain.json` text: two-space JSON and a final newline. */
export function serializeTerrain(doc: TerrainDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}
```

`packages/terrain-editor/src/ui/files.ts`:

```ts
/** The part of a FileSystemFileHandle the editor uses. */
export interface FileHandle {
  readonly name: string
  getFile(): Promise<{ text(): Promise<string> }>
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>
}

/** The File System Access pickers; `window` in Chrome and Edge. Missing methods mean no API. */
export interface FileHost {
  showOpenFilePicker?(o?: unknown): Promise<FileHandle[]>
  showSaveFilePicker?(o?: unknown): Promise<FileHandle>
}

export interface OpenedFile { name: string; text: string; handle: FileHandle | null }

/** Opening and saving where the API is missing: a file input and a download. */
export interface FileFallback {
  pick(): Promise<OpenedFile | null>
  download(name: string, text: string): void
}

const TYPES = [{ description: 'Elovox terrain', accept: { 'application/json': ['.json'] } }]

const isAbort = (e: unknown) => typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError'

export class TerrainFiles {
  private readonly host: FileHost
  private readonly fallback: FileFallback

  constructor(host: FileHost, fallback: FileFallback) {
    this.host = host
    this.fallback = fallback
  }

  /** The browser can write back to the file it opened. */
  get native(): boolean { return typeof this.host.showOpenFilePicker === 'function' && typeof this.host.showSaveFilePicker === 'function' }

  /** Asks for a file; null if the user cancelled. */
  async open(): Promise<OpenedFile | null> {
    if (!this.host.showOpenFilePicker) return this.fallback.pick()
    try {
      const [h] = await this.host.showOpenFilePicker({ types: TYPES, multiple: false })
      if (!h) return null
      const file = await h.getFile()
      return { name: h.name, text: await file.text(), handle: h }
    } catch (e) {
      if (isAbort(e)) return null
      throw e
    }
  }

  /** Writes to `handle`, or asks where to save when there is none (Save as). Null if the user cancelled. */
  async save(text: string, handle: FileHandle | null, suggestedName: string): Promise<{ handle: FileHandle | null; name: string } | null> {
    if (!this.host.showSaveFilePicker) {
      this.fallback.download(suggestedName, text)
      return { handle: null, name: suggestedName }
    }
    let h = handle
    if (!h) {
      try {
        h = await this.host.showSaveFilePicker({ types: TYPES, suggestedName })
      } catch (e) {
        if (isAbort(e)) return null
        throw e
      }
    }
    const w = await h.createWritable()
    await w.write(text)
    await w.close()
    return { handle: h, name: h.name }
  }
}

/** Fallback for browsers without the API: a hidden file input to open and a link click to download. */
export function browserFallback(doc: Document): FileFallback {
  return {
    pick: () => new Promise((resolve) => {
      const input = doc.createElement('input')
      input.type = 'file'
      input.accept = '.json,application/json'
      input.addEventListener('change', async () => {
        const file = input.files?.[0]
        resolve(file ? { name: file.name, text: await file.text(), handle: null } : null)
      })
      input.addEventListener('cancel', () => resolve(null))
      input.click()
    }),
    download(name, text) {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
      const a = doc.createElement('a')
      a.href = url
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
    },
  }
}
```

Add to `packages/terrain-editor/src/index.ts`:

```ts
export { parseTerrainText, serializeTerrain, type ParseResult } from './core/docio.ts'
export { TerrainFiles, browserFallback, type FileFallback, type FileHandle, type FileHost, type OpenedFile } from './ui/files.ts'
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w @elovox/terrain-editor -- docio files`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/terrain-editor/src/core/docio.ts packages/terrain-editor/src/ui/files.ts packages/terrain-editor/src/index.ts packages/terrain-editor/test/docio.test.ts packages/terrain-editor/test/files.test.ts
git commit -m "feat(terrain-editor): open and save terrain documents"
```

---

## Part D — `@elovox/terrain-editor` UI

### Task 11: Handle and outline geometry

Pure functions: which outlines and handles an op shows, and what dragging a handle does to the op. Values snap to whole blocks.

**Files:**
- Create: `packages/terrain-editor/src/ui/handles/geometry.ts`
- Test: `packages/terrain-editor/test/geometry.test.ts`

**Interfaces:**
- Consumes: types `OpDef, OpImpl, PathPoint, ShapeDef, Vec2` from `@elovox/terrain`.
- Produces:
  - `type HandleKind = 'center' | 'radius' | 'falloff' | 'vertex' | 'insert' | 'width'`
  - `interface Handle { kind: HandleKind; index: number; x: number; z: number; y?: number }` — `index`: a vertex's index, or the index an inserted point gets; `y`: the absolute height the handle carries (Shift+drag moves it).
  - `interface Outline { points: Vec2[]; closed: boolean; faint: boolean }`
  - `interface DragPoint { x: number; z: number; y?: number }`
  - `heightKey(impl: OpImpl): string | null` — `'y'` when the op has an anchored number param `y` (blob, flatten).
  - `handlesOf(def: OpDef, impl: OpImpl): Handle[]`
  - `outlinesOf(def: OpDef): Outline[]`
  - `resample(points: readonly Vec2[], closed: boolean, step: number): Vec2[]`
  - `translateShape(s: ShapeDef, dx: number, dz: number): ShapeDef`
  - `dragHandle(def: OpDef, impl: OpImpl, h: Handle | 'body', grab: DragPoint, to: DragPoint): OpDef` — `grab` is where the drag started on its plane, `to` where it is now. With `to.y` set, a centre handle moves `params[heightKey]` and a path vertex moves its `y`.

- [ ] **Step 1: Write the failing test**

`packages/terrain-editor/test/geometry.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { builtinOps, type OpDef, type OpImpl } from '@elovox/terrain'
import { dragHandle, handlesOf, heightKey, outlinesOf, resample, translateShape } from '../src/ui/handles/geometry.ts'

const impl = (type: string): OpImpl => builtinOps.get(type)!
const hill: OpDef = { id: 'h', type: 'hills', enabled: true, shape: { kind: 'circle', center: [100, 100], radius: 20, falloff: 10 }, params: { amplitude: 5 } }
const peak: OpDef = { id: 'm', type: 'mountain', enabled: true, shape: { kind: 'circle', center: [100, 100], radius: 20 }, params: { height: 30 } }
const rock: OpDef = { id: 'b', type: 'blob', enabled: true, shape: { kind: 'circle', center: [50, 50], radius: 6 }, params: { y: 40, height: 5 } }
const pond: OpDef = { id: 'p', type: 'lake', enabled: true, shape: { kind: 'polygon', points: [[0, 0], [40, 0], [40, 40]] }, params: { level: 20 } }
const tunnel: OpDef = { id: 'c', type: 'cave', enabled: true, shape: { kind: 'path', width: 8, points: [{ x: 0, z: 0, y: 30 }, { x: 40, z: 0, y: 20 }] }, params: {} }
const ridge: OpDef = { id: 'r', type: 'mountain', enabled: true, shape: { kind: 'path', width: 20, points: [{ x: 0, z: 0 }, { x: 0, z: 40 }] }, params: { height: 30 } }

describe('heightKey', () => {
  it('is y for ops with an anchored y param', () => {
    expect(heightKey(impl('blob'))).toBe('y')
    expect(heightKey(impl('flatten'))).toBe('y')
    expect(heightKey(impl('hills'))).toBeNull()
  })
})

describe('handlesOf', () => {
  it('gives a circle a centre, a rim handle and, for falloff ops, a falloff handle at 45°', () => {
    const hs = handlesOf(hill, impl('hills'))
    expect(hs.map((h) => h.kind)).toEqual(['center', 'radius', 'falloff'])
    expect(hs[1]).toMatchObject({ x: 120, z: 100 })
    expect(hs[2]!.x).toBeCloseTo(100 + 30 * Math.SQRT1_2)
    expect(handlesOf(peak, impl('mountain')).map((h) => h.kind)).toEqual(['center', 'radius'])
  })

  it('puts the height on the centre of a blob', () => {
    expect(handlesOf(rock, impl('blob'))[0]).toEqual({ kind: 'center', index: 0, x: 50, z: 50, y: 40 })
  })

  it('gives a polygon its vertices and an insert handle on every edge, the closing one included', () => {
    const hs = handlesOf(pond, impl('lake'))
    expect(hs.filter((h) => h.kind === 'vertex')).toHaveLength(3)
    expect(hs.filter((h) => h.kind === 'insert').map((h) => [h.index, h.x, h.z])).toEqual([[1, 20, 0], [2, 40, 20], [3, 20, 20]])
  })

  it('gives a path its vertices (with y for volume ops), midpoint inserts and a width handle', () => {
    const hs = handlesOf(tunnel, impl('cave'))
    expect(hs.filter((h) => h.kind === 'vertex').map((h) => h.y)).toEqual([30, 20])
    expect(hs.find((h) => h.kind === 'insert')).toMatchObject({ index: 1, x: 20, z: 0 })
    expect(hs.find((h) => h.kind === 'width')).toMatchObject({ x: 0, z: 4 })
  })
})

describe('outlinesOf', () => {
  it('draws a circle ring and a faint falloff ring', () => {
    const o = outlinesOf(hill)
    expect(o.map((l) => [l.closed, l.faint])).toEqual([[true, false], [true, true]])
    const r = Math.hypot(o[0]!.points[5]![0] - 100, o[0]!.points[5]![1] - 100)
    expect(r).toBeCloseTo(20)
  })

  it('draws a path centre line and two faint side lines per segment', () => {
    const o = outlinesOf(ridge)
    expect(o).toHaveLength(3)
    expect(o[1]!.points).toEqual([[-10, 0], [-10, 40]])
    expect(o[2]!.points).toEqual([[10, 0], [10, 40]])
  })
})

describe('resample', () => {
  it('keeps points at most `step` apart, ending on the last point of an open line', () => {
    expect(resample([[0, 0], [5, 0]], false, 2)).toEqual([[0, 0], [5 / 3, 0], [10 / 3, 0], [5, 0]])
  })

  it('closes a loop without repeating the first point', () => {
    expect(resample([[0, 0], [2, 0], [2, 2]], true, 2)).toHaveLength(4)
  })
})

describe('dragHandle', () => {
  const at = (x: number, z: number, y?: number) => (y === undefined ? { x, z } : { x, z, y })

  it('moves a circle centre, snapped to blocks', () => {
    expect(dragHandle(hill, impl('hills'), handlesOf(hill, impl('hills'))[0]!, at(100, 100), at(130.4, 90.6)).shape).toMatchObject({ center: [130, 91] })
  })

  it('moves a blob up with a height drag, and ignores a height drag on ops without one', () => {
    const c = handlesOf(rock, impl('blob'))[0]!
    expect(dragHandle(rock, impl('blob'), c, at(50, 50, 40), at(50, 50, 52.6)).params.y).toBe(53)
    expect(dragHandle(peak, impl('mountain'), handlesOf(peak, impl('mountain'))[0]!, at(100, 100), at(100, 100, 50))).toBe(peak)
  })

  it('sets the radius and the falloff from the distance to the centre, never below their minimum', () => {
    const [, rim, fall] = handlesOf(hill, impl('hills'))
    expect(dragHandle(hill, impl('hills'), rim!, at(120, 100), at(135, 100)).shape).toMatchObject({ radius: 35 })
    expect(dragHandle(hill, impl('hills'), rim!, at(120, 100), at(100.2, 100)).shape).toMatchObject({ radius: 1 })
    expect(dragHandle(hill, impl('hills'), fall!, at(0, 0), at(140, 100)).shape).toMatchObject({ falloff: 20 })
    expect(dragHandle(hill, impl('hills'), fall!, at(0, 0), at(105, 100)).shape).toMatchObject({ falloff: 0 })
  })

  it('moves polygon and path vertices; a height drag moves a path point in y', () => {
    expect(dragHandle(pond, impl('lake'), { kind: 'vertex', index: 1, x: 40, z: 0 }, at(40, 0), at(50, 5)).shape).toMatchObject({ points: [[0, 0], [50, 5], [40, 40]] })
    const moved = dragHandle(tunnel, impl('cave'), { kind: 'vertex', index: 0, x: 0, z: 0, y: 30 }, at(0, 0, 30), at(0, 0, 12.2))
    expect(moved.shape).toMatchObject({ points: [{ x: 0, z: 0, y: 12 }, { x: 40, z: 0, y: 20 }] })
  })

  it('inserts a vertex where the insert handle is dragged, with an interpolated y on volume paths', () => {
    expect(dragHandle(pond, impl('lake'), { kind: 'insert', index: 3, x: 20, z: 20 }, at(20, 20), at(10, 30)).shape).toMatchObject({ points: [[0, 0], [40, 0], [40, 40], [10, 30]] })
    expect(dragHandle(tunnel, impl('cave'), { kind: 'insert', index: 1, x: 20, z: 0 }, at(20, 0), at(20, 6)).shape).toMatchObject({
      points: [{ x: 0, z: 0, y: 30 }, { x: 20, z: 6, y: 25 }, { x: 40, z: 0, y: 20 }],
    })
  })

  it('sets a path width from twice the distance to the first point, at least 1', () => {
    const w = handlesOf(ridge, impl('mountain')).find((h) => h.kind === 'width')!
    expect(dragHandle(ridge, impl('mountain'), w, at(10, 0), at(15, 0)).shape).toMatchObject({ width: 30 })
    expect(dragHandle(ridge, impl('mountain'), w, at(10, 0), at(0.1, 0)).shape).toMatchObject({ width: 1 })
  })

  it('moves the whole op by the drag distance', () => {
    expect(dragHandle(pond, impl('lake'), 'body', at(10, 10), at(15.4, 7)).shape).toEqual({ kind: 'polygon', points: [[5, -3], [45, -3], [45, 37]] })
    expect(translateShape(ridge.shape, 1, 2)).toMatchObject({ points: [{ x: 1, z: 2 }, { x: 1, z: 42 }] })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @elovox/terrain-editor -- geometry`
Expected: FAIL — `../src/ui/handles/geometry.ts` not found.

- [ ] **Step 3: Write the implementation**

`packages/terrain-editor/src/ui/handles/geometry.ts`:

```ts
import type { OpDef, OpImpl, PathPoint, ShapeDef, Vec2 } from '@elovox/terrain'

export type HandleKind = 'center' | 'radius' | 'falloff' | 'vertex' | 'insert' | 'width'

export interface Handle {
  kind: HandleKind
  /** vertex: the point's index; insert: the index the new point gets; 0 otherwise. */
  index: number
  x: number
  z: number
  /** The absolute height this handle carries (Shift+drag moves it), if any. */
  y?: number
}

export interface Outline { points: Vec2[]; closed: boolean; faint: boolean }

/** A point on a drag plane: x and z, plus y on a vertical (height) drag. */
export interface DragPoint { x: number; z: number; y?: number }

/** Blocks between the samples of a circle outline. */
const RING_STEP = 2

/** The param a circle's centre handle moves in y: an anchored number param named y (blob, flatten). */
export function heightKey(impl: OpImpl): string | null {
  const s = impl.params.y
  return s !== undefined && s.type === 'number' && s.anchor === 'ground' ? 'y' : null
}

/** The unit normal of a → b, to its left. `0 - …` avoids -0, which toEqual tells apart from 0. */
function normal(a: { x: number; z: number }, b: { x: number; z: number }): Vec2 {
  const dx = b.x - a.x, dz = b.z - a.z
  const l = Math.hypot(dx, dz) || 1
  return [0 - dz / l, 0 + dx / l]
}

function ring(c: Vec2, r: number): Vec2[] {
  const n = Math.max(24, Math.ceil((2 * Math.PI * r) / RING_STEP))
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2
    return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)] as Vec2
  })
}

export function handlesOf(def: OpDef, impl: OpImpl): Handle[] {
  const s = def.shape
  switch (s.kind) {
    case 'circle': {
      const [cx, cz] = s.center
      const key = heightKey(impl)
      const y = key === null ? undefined : def.params[key]
      const out: Handle[] = [
        { kind: 'center', index: 0, x: cx, z: cz, ...(typeof y === 'number' ? { y } : {}) },
        { kind: 'radius', index: 0, x: cx + s.radius, z: cz },
      ]
      if (impl.falloff) {
        const r = s.radius + (s.falloff ?? 0)
        out.push({ kind: 'falloff', index: 0, x: cx + r * Math.SQRT1_2, z: cz + r * Math.SQRT1_2 })
      }
      return out
    }
    case 'polygon': {
      const n = s.points.length
      const out: Handle[] = s.points.map(([x, z], i) => ({ kind: 'vertex', index: i, x, z }))
      for (let i = 0; i < n; i++) {
        const a = s.points[i]!, b = s.points[(i + 1) % n]!
        out.push({ kind: 'insert', index: i + 1, x: (a[0] + b[0]) / 2, z: (a[1] + b[1]) / 2 })
      }
      return out
    }
    case 'path': {
      const pts = s.points
      const out: Handle[] = pts.map((p, i) => ({ kind: 'vertex', index: i, x: p.x, z: p.z, ...(impl.needY && p.y !== undefined ? { y: p.y } : {}) }))
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!, b = pts[i]!
        out.push({ kind: 'insert', index: i, x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 })
      }
      const [nx, nz] = normal(pts[0]!, pts[1]!)
      out.push({ kind: 'width', index: 0, x: pts[0]!.x + (nx * s.width) / 2, z: pts[0]!.z + (nz * s.width) / 2 })
      return out
    }
  }
}

/** Outlines in x/z: a circle's ring (and falloff ring), a polygon, or a path's centre line and side lines. */
export function outlinesOf(def: OpDef): Outline[] {
  const s = def.shape
  switch (s.kind) {
    case 'circle': {
      const out: Outline[] = [{ points: ring(s.center, s.radius), closed: true, faint: false }]
      const f = s.falloff ?? 0
      if (f > 0) out.push({ points: ring(s.center, s.radius + f), closed: true, faint: true })
      return out
    }
    case 'polygon':
      return [{ points: s.points.map(([x, z]) => [x, z] as Vec2), closed: true, faint: false }]
    case 'path': {
      const out: Outline[] = [{ points: s.points.map((p) => [p.x, p.z] as Vec2), closed: false, faint: false }]
      for (let i = 1; i < s.points.length; i++) {
        const a = s.points[i - 1]!, b = s.points[i]!
        const [nx, nz] = normal(a, b)
        const ha = (a.width ?? s.width) / 2, hb = (b.width ?? s.width) / 2
        for (const side of [1, -1]) {
          out.push({ points: [[a.x + nx * ha * side, a.z + nz * ha * side], [b.x + nx * hb * side, b.z + nz * hb * side]], closed: false, faint: true })
        }
      }
      return out
    }
  }
}

/** Points along a polyline no more than `step` apart (to drape it on the terrain). A closed loop does not repeat its first point. */
export function resample(points: readonly Vec2[], closed: boolean, step: number): Vec2[] {
  const out: Vec2[] = []
  const n = points.length
  const segments = closed ? n : n - 1
  for (let i = 0; i < segments; i++) {
    const a = points[i]!, b = points[(i + 1) % n]!
    const k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step))
    for (let j = 0; j < k; j++) out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k])
  }
  if (!closed && n > 0) out.push([points[n - 1]![0], points[n - 1]![1]])
  return out
}

export function translateShape(s: ShapeDef, dx: number, dz: number): ShapeDef {
  switch (s.kind) {
    case 'circle': return { ...s, center: [s.center[0] + dx, s.center[1] + dz] }
    case 'polygon': return { ...s, points: s.points.map(([x, z]) => [x + dx, z + dz] as Vec2) }
    case 'path': return { ...s, points: s.points.map((p) => ({ ...p, x: p.x + dx, z: p.z + dz })) }
  }
}

/** The op after dragging handle `h` (or the whole op, 'body') from `grab` to `to`. Values snap to whole blocks. */
export function dragHandle(def: OpDef, impl: OpImpl, h: Handle | 'body', grab: DragPoint, to: DragPoint): OpDef {
  const s = def.shape
  const r = Math.round
  if (h === 'body') return { ...def, shape: translateShape(s, r(to.x - grab.x), r(to.z - grab.z)) }
  switch (h.kind) {
    case 'center': {
      if (s.kind !== 'circle') return def
      if (to.y !== undefined) {
        const key = heightKey(impl)
        return key === null ? def : { ...def, params: { ...def.params, [key]: r(to.y) } }
      }
      return { ...def, shape: { ...s, center: [r(to.x), r(to.z)] } }
    }
    case 'radius': {
      if (s.kind !== 'circle') return def
      return { ...def, shape: { ...s, radius: Math.max(1, r(Math.hypot(to.x - s.center[0], to.z - s.center[1]))) } }
    }
    case 'falloff': {
      if (s.kind !== 'circle') return def
      return { ...def, shape: { ...s, falloff: Math.max(0, r(Math.hypot(to.x - s.center[0], to.z - s.center[1]) - s.radius)) } }
    }
    case 'vertex': {
      if (s.kind === 'polygon') {
        const points = s.points.slice()
        points[h.index] = [r(to.x), r(to.z)]
        return { ...def, shape: { ...s, points } }
      }
      if (s.kind === 'path') {
        const points = s.points.slice()
        const p = points[h.index]!
        points[h.index] = to.y !== undefined ? { ...p, y: r(to.y) } : { ...p, x: r(to.x), z: r(to.z) }
        return { ...def, shape: { ...s, points } }
      }
      return def
    }
    case 'insert': {
      if (s.kind === 'polygon') {
        const points = s.points.slice()
        points.splice(h.index, 0, [r(to.x), r(to.z)])
        return { ...def, shape: { ...s, points } }
      }
      if (s.kind === 'path') {
        const points = s.points.slice()
        const a = points[h.index - 1]!, b = points[h.index]!
        const p: PathPoint = { x: r(to.x), z: r(to.z) }
        if (a.y !== undefined && b.y !== undefined) p.y = r((a.y + b.y) / 2)
        points.splice(h.index, 0, p)
        return { ...def, shape: { ...s, points } }
      }
      return def
    }
    case 'width': {
      if (s.kind !== 'path') return def
      const p0 = s.points[0]!
      return { ...def, shape: { ...s, width: Math.max(1, r(2 * Math.hypot(to.x - p0.x, to.z - p0.z))) } }
    }
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -w @elovox/terrain-editor -- geometry`
Expected: PASS (17 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/terrain-editor/src/ui/handles/geometry.ts packages/terrain-editor/test/geometry.test.ts
git commit -m "feat(terrain-editor): handle and outline geometry with drag math"
```

### Task 12: Picking and drag planes

**Files:**
- Create: `packages/terrain-editor/src/ui/handles/pick.ts`
- Test: `packages/terrain-editor/test/pick.test.ts`

**Interfaces:**
- Consumes: `Vector3`, `type Camera` from `'three/webgpu'`.
- Produces:
  - `interface ScreenPoint { x: number; y: number }` — canvas-relative CSS pixels.
  - `interface Viewport { width: number; height: number }`
  - `interface WorldRay { origin: Vector3; dir: Vector3 }`
  - `toScreen(p: { x: number; y: number; z: number }, camera: Camera, vp: Viewport): ScreenPoint | null` — null behind the camera.
  - `rayAt(camera: Camera, vp: Viewport, at: ScreenPoint): WorldRay`
  - `hitHorizontal(ray: WorldRay, y: number): { x: number; z: number } | null` — null if parallel or behind.
  - `hitVertical(ray: WorldRay, through: { x: number; z: number }, normal: { x: number; z: number }): number | null` — the y where the ray meets the vertical plane through `through` with horizontal normal `normal`; null if parallel or behind.
  - `nearest<T>(items: readonly T[], screen: (t: T) => ScreenPoint | null, at: ScreenPoint, radius: number): T | null`
  - `distanceToPolyline(at: ScreenPoint, points: readonly (ScreenPoint | null)[], closed: boolean): number` — `Infinity` if no segment is visible.

- [ ] **Step 1: Write the failing test**

`packages/terrain-editor/test/pick.test.ts`:

```ts
import { PerspectiveCamera } from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { distanceToPolyline, hitHorizontal, hitVertical, nearest, rayAt, toScreen } from '../src/ui/handles/pick.ts'

/** Looks from (0, 100, 100) at the origin; a 200 × 200 viewport. */
function camera(): PerspectiveCamera {
  const c = new PerspectiveCamera(60, 1, 0.1, 1000)
  c.position.set(0, 100, 100)
  c.lookAt(0, 0, 0)
  c.updateMatrixWorld()
  return c
}
const vp = { width: 200, height: 200 }

describe('toScreen', () => {
  it('projects the looked-at point to the centre and hides points behind the camera', () => {
    const s = toScreen({ x: 0, y: 0, z: 0 }, camera(), vp)!
    expect(s.x).toBeCloseTo(100)
    expect(s.y).toBeCloseTo(100)
    expect(toScreen({ x: 0, y: 200, z: 200 }, camera(), vp)).toBeNull()
  })

  it('puts a point to the right of the target right of centre', () => {
    expect(toScreen({ x: 10, y: 0, z: 0 }, camera(), vp)!.x).toBeGreaterThan(100)
  })
})

describe('rays and planes', () => {
  it('casts the centre ray onto the ground at the target', () => {
    const hit = hitHorizontal(rayAt(camera(), vp, { x: 100, y: 100 }), 0)!
    expect(hit.x).toBeCloseTo(0)
    expect(hit.z).toBeCloseTo(0)
  })

  it('round-trips a ground point through the screen', () => {
    const c = camera()
    const s = toScreen({ x: 12, y: 5, z: -7 }, c, vp)!
    const hit = hitHorizontal(rayAt(c, vp, s), 5)!
    expect(hit.x).toBeCloseTo(12)
    expect(hit.z).toBeCloseTo(-7)
  })

  it('misses a plane the ray is parallel to or points away from', () => {
    const c = camera()
    const ray = rayAt(c, vp, { x: 100, y: 100 })
    expect(hitHorizontal(ray, 150)).toBeNull() // above the camera, the ray goes down
    expect(hitHorizontal({ origin: ray.origin, dir: ray.dir.clone().setY(0) }, 0)).toBeNull()
  })

  it('reads a height on a vertical plane facing the camera', () => {
    const ray = rayAt(camera(), vp, { x: 100, y: 100 })
    expect(hitVertical(ray, { x: 0, z: 0 }, { x: 0, z: -1 })).toBeCloseTo(0)
    expect(hitVertical(ray, { x: 0, z: 0 }, { x: 1, z: 0 })).toBeNull() // plane parallel to the ray
  })
})

describe('nearest and distanceToPolyline', () => {
  it('picks the closest item within the radius', () => {
    const items = [{ id: 'a', p: { x: 10, y: 10 } }, { id: 'b', p: { x: 14, y: 10 } }, { id: 'c', p: null }]
    expect(nearest(items, (i) => i.p, { x: 13, y: 10 }, 5)?.id).toBe('b')
    expect(nearest(items, (i) => i.p, { x: 50, y: 50 }, 5)).toBeNull()
  })

  it('measures the distance to the nearest visible segment', () => {
    expect(distanceToPolyline({ x: 5, y: 3 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }], false)).toBeCloseTo(3)
    expect(distanceToPolyline({ x: 0, y: 5 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], true)).toBeCloseTo(Math.SQRT1_2 * 5)
    expect(distanceToPolyline({ x: 0, y: 0 }, [{ x: 0, y: 0 }, null], false)).toBe(Infinity)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @elovox/terrain-editor -- pick`
Expected: FAIL — `../src/ui/handles/pick.ts` not found.

- [ ] **Step 3: Write the implementation**

`packages/terrain-editor/src/ui/handles/pick.ts`:

```ts
import { Vector3, type Camera } from 'three/webgpu'

/** Canvas-relative CSS pixels. */
export interface ScreenPoint { x: number; y: number }
export interface Viewport { width: number; height: number }
export interface WorldRay { origin: Vector3; dir: Vector3 }

/** Where a world point appears on the canvas; null if it is behind the camera. */
export function toScreen(p: { x: number; y: number; z: number }, camera: Camera, vp: Viewport): ScreenPoint | null {
  const v = new Vector3(p.x, p.y, p.z).applyMatrix4(camera.matrixWorldInverse)
  if (v.z >= 0) return null // the camera looks down -z in view space
  v.applyMatrix4(camera.projectionMatrix)
  return { x: ((v.x + 1) / 2) * vp.width, y: ((1 - v.y) / 2) * vp.height }
}

/** The ray from the camera through a canvas point. */
export function rayAt(camera: Camera, vp: Viewport, at: ScreenPoint): WorldRay {
  const origin = new Vector3().setFromMatrixPosition(camera.matrixWorld)
  const p = new Vector3((at.x / vp.width) * 2 - 1, 1 - (at.y / vp.height) * 2, 0.5).unproject(camera)
  return { origin, dir: p.sub(origin).normalize() }
}

/** Where the ray meets the plane y = `y`; null if it runs parallel or the plane is behind it. */
export function hitHorizontal(ray: WorldRay, y: number): { x: number; z: number } | null {
  if (Math.abs(ray.dir.y) < 1e-6) return null
  const t = (y - ray.origin.y) / ray.dir.y
  if (t <= 0) return null
  return { x: ray.origin.x + ray.dir.x * t, z: ray.origin.z + ray.dir.z * t }
}

/**
 * The height where the ray meets the vertical plane through `through` whose horizontal normal is
 * `normal` (the camera's forward direction at the start of the drag); null if parallel or behind.
 */
export function hitVertical(ray: WorldRay, through: { x: number; z: number }, normal: { x: number; z: number }): number | null {
  const denom = ray.dir.x * normal.x + ray.dir.z * normal.z
  if (Math.abs(denom) < 1e-6) return null
  const t = ((through.x - ray.origin.x) * normal.x + (through.z - ray.origin.z) * normal.z) / denom
  if (t <= 0) return null
  return ray.origin.y + ray.dir.y * t
}

/** The item whose screen point is closest to `at`, within `radius` pixels. */
export function nearest<T>(items: readonly T[], screen: (t: T) => ScreenPoint | null, at: ScreenPoint, radius: number): T | null {
  let best: T | null = null
  let bestD = radius
  for (const item of items) {
    const s = screen(item)
    if (!s) continue
    const d = Math.hypot(s.x - at.x, s.y - at.y)
    if (d <= bestD) { best = item; bestD = d }
  }
  return best
}

function segmentDistance(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const ex = b.x - a.x, ey = b.y - a.y
  const len2 = ex * ex + ey * ey
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2)) : 0
  return Math.hypot(p.x - (a.x + ex * t), p.y - (a.y + ey * t))
}

/** Pixels from `at` to the nearest segment whose two ends are on screen; Infinity if there is none. */
export function distanceToPolyline(at: ScreenPoint, points: readonly (ScreenPoint | null)[], closed: boolean): number {
  let best = Infinity
  const n = points.length
  const segments = closed ? n : n - 1
  for (let i = 0; i < segments; i++) {
    const a = points[i], b = points[(i + 1) % n]
    if (a && b) best = Math.min(best, segmentDistance(at, a, b))
  }
  return best
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -w @elovox/terrain-editor -- pick`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/terrain-editor/src/ui/handles/pick.ts packages/terrain-editor/test/pick.test.ts
git commit -m "feat(terrain-editor): screen picking and drag planes"
```

### Task 13: The overlay (outlines and handles in the scene)

**Files:**
- Create: `packages/terrain-editor/src/ui/handles/overlay.ts`
- Test: `packages/terrain-editor/test/overlay.test.ts`

**Interfaces:**
- Consumes: Task 11's `handlesOf`, `outlinesOf`, `resample`, `Handle`; `voxelId` from `@elovox/engine`; three classes from `'three/webgpu'`.
- Produces:
  - `LIFT = 0.6` (blocks above the ground the overlay floats)
  - `groundSampler(get: (x: number, y: number, z: number) => number, skip: ReadonlySet<number>, height: number, size: Vec2): (x: number, z: number) => number` — the y just above the top voxel of the column, skipping block ids in `skip` (logs and leaves); 0 for an empty column; x/z are floored and clamped into the world.
  - `interface DrawOp { def: OpDef; impl: OpImpl; selected: boolean; failed: boolean }`
  - `interface PlacedHandle { handle: Handle; pos: Vector3 }`, `interface PlacedOutline { id: string; points: Vector3[]; closed: boolean }`
  - `class Overlay { readonly group: Group; handles: PlacedHandle[]; outlines: PlacedOutline[]; constructor(ground: (x: number, z: number) => number); draw(ops: readonly DrawOp[], showAll: boolean): void; scaleMarkers(camera: PerspectiveCamera, viewportHeight: number, px?: number): void; dispose(): void }` — draws the selected op with handles, failed ops in red, and the others faintly when `showAll`. Faint outlines (falloff ring, path sides) are not pickable, so they are not in `outlines`.

- [ ] **Step 1: Write the failing test**

`packages/terrain-editor/test/overlay.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { builtinOps, type OpDef } from '@elovox/terrain'
import { LIFT, Overlay, groundSampler, type DrawOp } from '../src/ui/handles/overlay.ts'

const hill: OpDef = { id: 'h', type: 'hills', enabled: true, shape: { kind: 'circle', center: [100, 100], radius: 20, falloff: 10 }, params: { amplitude: 5 } }
const rock: OpDef = { id: 'b', type: 'blob', enabled: true, shape: { kind: 'circle', center: [50, 50], radius: 6 }, params: { y: 40, height: 5 } }
const op = (def: OpDef, selected = false, failed = false): DrawOp => ({ def, impl: builtinOps.get(def.type)!, selected, failed })

describe('groundSampler', () => {
  // Stone up to y 19, a leaf at y 25 over x 3: the leaf is skipped.
  const get = (x: number, y: number) => (y < 20 ? 1 : x === 3 && y === 25 ? 7 : 0)
  const ground = groundSampler(get, new Set([7]), 64, [16, 16])

  it('is the y above the top voxel, skipping tree blocks', () => {
    expect(ground(2, 2)).toBe(20)
    expect(ground(3.7, 2)).toBe(20)
  })

  it('clamps coordinates into the world', () => {
    expect(ground(-5, 99)).toBe(20)
  })

  it('is 0 for an empty column', () => {
    expect(groundSampler(() => 0, new Set(), 64, [16, 16])(1, 1)).toBe(0)
  })
})

describe('Overlay', () => {
  it('draws the selected op with its handles on the ground', () => {
    const o = new Overlay(() => 30)
    o.draw([op(hill, true), op(rock)], false)
    expect(o.handles.map((h) => h.handle.kind)).toEqual(['center', 'radius', 'falloff'])
    expect(o.handles[0]!.pos.toArray()).toEqual([100, 30 + LIFT, 100])
    expect(o.outlines.map((l) => l.id)).toEqual(['h']) // the falloff ring is faint, not pickable
    expect(o.group.children.length).toBe(2 + 3) // ring, falloff ring, three markers
    o.dispose()
  })

  it('places a height handle at its own y', () => {
    const o = new Overlay(() => 30)
    o.draw([op(rock, true)], false)
    expect(o.handles[0]!.pos.y).toBe(40 + LIFT)
    o.dispose()
  })

  it('shows unselected ops only with showAll, and failed ops always', () => {
    const o = new Overlay(() => 30)
    o.draw([op(hill), op(rock, false, true)], false)
    expect(o.outlines.map((l) => l.id)).toEqual(['b'])
    o.draw([op(hill), op(rock)], true)
    expect(o.outlines.map((l) => l.id)).toEqual(['h', 'b'])
    expect(o.handles).toEqual([])
    o.dispose()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @elovox/terrain-editor -- overlay`
Expected: FAIL — `../src/ui/handles/overlay.ts` not found.

- [ ] **Step 3: Write the implementation**

`packages/terrain-editor/src/ui/handles/overlay.ts`:

```ts
import { voxelId } from '@elovox/engine'
import type { OpDef, OpImpl, Vec2 } from '@elovox/terrain'
import {
  BoxGeometry, BufferGeometry, Group, Line, LineBasicNodeMaterial, LineLoop, Mesh, MeshBasicNodeMaterial, Vector3,
  type PerspectiveCamera,
} from 'three/webgpu'
import { handlesOf, outlinesOf, resample, type Handle } from './geometry.ts'

/** Blocks the overlay floats above the ground, so lines do not sink into it. */
export const LIFT = 0.6
/** Blocks between draped outline samples. */
const STEP = 2
const COLOR = { selected: 0xffb020, other: 0xffffff, failed: 0xff4040, handle: 0xffffff, insert: 0x8cc8ff, stem: 0xffb020 }

/** Ground height lookup: the y just above the column's top voxel, skipping tree blocks; 0 for an empty column. */
export function groundSampler(get: (x: number, y: number, z: number) => number, skip: ReadonlySet<number>, height: number, size: Vec2): (x: number, z: number) => number {
  return (x, z) => {
    const ix = Math.min(size[0] - 1, Math.max(0, Math.floor(x)))
    const iz = Math.min(size[1] - 1, Math.max(0, Math.floor(z)))
    for (let y = height - 1; y >= 0; y--) {
      const v = get(ix, y, iz)
      if (v !== 0 && !skip.has(voxelId(v))) return y + 1
    }
    return 0
  }
}

export interface DrawOp { def: OpDef; impl: OpImpl; selected: boolean; failed: boolean }
export interface PlacedHandle { handle: Handle; pos: Vector3 }
export interface PlacedOutline { id: string; points: Vector3[]; closed: boolean }

/** The editor's lines and handle markers, drawn over the terrain (no depth test). */
export class Overlay {
  readonly group = new Group()
  handles: PlacedHandle[] = []
  outlines: PlacedOutline[] = []
  private readonly ground: (x: number, z: number) => number
  private readonly lineMaterials = new Map<string, LineBasicNodeMaterial>()
  private readonly markerGeometry = new BoxGeometry(1, 1, 1)
  private readonly handleMaterial = new MeshBasicNodeMaterial({ color: COLOR.handle, depthTest: false, transparent: true })
  private readonly insertMaterial = new MeshBasicNodeMaterial({ color: COLOR.insert, depthTest: false, transparent: true, opacity: 0.8 })
  private readonly markers: Mesh[] = []
  private readonly geometries: BufferGeometry[] = []

  constructor(ground: (x: number, z: number) => number) {
    this.ground = ground
    this.group.name = 'terrain-editor-overlay'
  }

  draw(ops: readonly DrawOp[], showAll: boolean): void {
    this.clear()
    for (const op of ops) {
      if (!op.selected && !op.failed && !showAll) continue
      const color = op.failed ? COLOR.failed : op.selected ? COLOR.selected : COLOR.other
      for (const o of outlinesOf(op.def)) {
        const points = resample(o.points, o.closed, STEP).map(([x, z]) => new Vector3(x, this.ground(x, z) + LIFT, z))
        const opacity = (op.selected || op.failed ? 1 : 0.45) * (o.faint ? 0.5 : 1)
        this.addLine(points, o.closed, color, opacity)
        if (!o.faint) this.outlines.push({ id: op.def.id, points, closed: o.closed })
      }
      if (!op.selected) continue
      for (const h of handlesOf(op.def, op.impl)) {
        const ground = this.ground(h.x, h.z)
        const pos = new Vector3(h.x, (h.y ?? ground) + LIFT, h.z)
        const m = new Mesh(this.markerGeometry, h.kind === 'insert' ? this.insertMaterial : this.handleMaterial)
        m.position.copy(pos)
        m.renderOrder = 1001
        this.group.add(m)
        this.markers.push(m)
        if (h.y !== undefined) this.addLine([new Vector3(h.x, ground + LIFT, h.z), pos], false, COLOR.stem, 0.8)
        this.handles.push({ handle: h, pos })
      }
    }
  }

  /** Scales the handle markers to about `px` pixels at their distance from the camera. */
  scaleMarkers(camera: PerspectiveCamera, viewportHeight: number, px = 9): void {
    const k = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, viewportHeight)
    for (const m of this.markers) m.scale.setScalar(Math.max(0.2, camera.position.distanceTo(m.position) * k * px))
  }

  dispose(): void {
    this.clear()
    for (const m of this.lineMaterials.values()) m.dispose()
    this.lineMaterials.clear()
    this.markerGeometry.dispose()
    this.handleMaterial.dispose()
    this.insertMaterial.dispose()
    this.group.removeFromParent()
  }

  private addLine(points: Vector3[], closed: boolean, color: number, opacity: number): void {
    const geometry = new BufferGeometry().setFromPoints(points)
    this.geometries.push(geometry)
    const line = closed ? new LineLoop(geometry, this.lineMaterial(color, opacity)) : new Line(geometry, this.lineMaterial(color, opacity))
    line.renderOrder = 1000
    this.group.add(line)
  }

  private lineMaterial(color: number, opacity: number): LineBasicNodeMaterial {
    const key = `${color}:${opacity}`
    let m = this.lineMaterials.get(key)
    if (!m) {
      m = new LineBasicNodeMaterial({ color, transparent: true, opacity, depthTest: false })
      this.lineMaterials.set(key, m)
    }
    return m
  }

  private clear(): void {
    this.group.clear()
    for (const g of this.geometries) g.dispose()
    this.geometries.length = 0
    this.markers.length = 0
    this.handles = []
    this.outlines = []
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -w @elovox/terrain-editor -- overlay`
Expected: PASS (6 tests).

Run: `npm run typecheck -w @elovox/terrain-editor`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/terrain-editor/src/ui/handles/overlay.ts packages/terrain-editor/test/overlay.test.ts
git commit -m "feat(terrain-editor): overlay of draped outlines and handle markers"
```

### Task 14: The inspector field model

Pure: what the inspector shows for an op or for the document, and the edit each field makes. The DOM layer (Task 15) only renders these.

**Files:**
- Create: `packages/terrain-editor/src/ui/panels/fields.ts`
- Test: `packages/terrain-editor/test/fields.test.ts`

**Interfaces:**
- Consumes: Task 6 edits (`setParam`, `setBlend`, `setShape`, `moveVertex`, `setSeaLevel`, `setBase`, `Edit`); from `@elovox/terrain`: `BLEND_MODES`, `NOISE_TYPES`, `resolveBound`, types `BlendMode, NoiseDef, NumberParam, OpDef, OpImpl, PathPoint, ShapeDef, TerrainDoc, Vec2`.
- Produces:
  - `interface NumberField { kind: 'number'; path: string; label: string; value: number | undefined; placeholder: number | undefined; min: number; max: number; step: number; optional: boolean; edit(v: number | undefined): Edit }`
  - `interface SelectField { kind: 'select'; path; label; value: string; options: readonly { value: string; label: string }[]; edit(v: string): Edit }`
  - `interface BoolField { kind: 'bool'; path; label; value: boolean; edit(v: boolean): Edit }`
  - `interface GroupField { kind: 'group'; path; label; fields: Field[] }`
  - `type Field = NumberField | SelectField | BoolField | GroupField`
  - `opFields(def: OpDef, impl: OpImpl, doc: TerrainDoc, height: number): Field[]` — blend (height ops), shape fields, params in schema order, then a `points` group for polygons and paths. Paths are relative to the op (`params.amplitude`, `shape.radius`, `shape.points[2].y`), matching validation error paths after `ops[i].`.
  - `docFields(doc: TerrainDoc, height: number): Field[]` — `seaLevel` and a `base` group.
  - `walkFields(fields: Field[], visit: (f: Field) => void): void`

- [ ] **Step 1: Write the failing test**

`packages/terrain-editor/test/fields.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { builtinOps, type OpDef } from '@elovox/terrain'
import { docFields, opFields, walkFields, type Field, type GroupField, type NumberField, type SelectField } from '../src/ui/panels/fields.ts'
import { HEIGHT, doc } from './fixtures.ts'

const byPath = (fields: Field[]) => {
  const m = new Map<string, Field>()
  walkFields(fields, (f) => m.set(f.path, f))
  return m
}
const fieldsOf = (id: string) => {
  const d = doc()
  const def = d.ops.find((o) => o.id === id)!
  return { d, def, fields: byPath(opFields(def, builtinOps.get(def.type)!, d, HEIGHT)) }
}

describe('opFields', () => {
  it('lists blend, shape, params and points in order', () => {
    const d = doc()
    const def = d.ops.find((o) => o.id === 'pond')!
    expect(opFields(def, builtinOps.get('lake')!, d, HEIGHT).map((f) => f.path)).toEqual([
      'blend', 'shape.inset', 'params.level', 'params.depth', 'params.shore', 'params.shoreSlope', 'shape.points',
    ])
  })

  it('gives volume ops no blend and falloff only to falloff ops', () => {
    expect(fieldsOf('rock').fields.has('blend')).toBe(false)
    expect(fieldsOf('hill').fields.has('shape.falloff')).toBe(true)
    expect(fieldsOf('ridge').fields.has('shape.falloff')).toBe(false)
  })

  it('describes number params from the schema', () => {
    const amp = fieldsOf('hill').fields.get('params.amplitude') as NumberField
    expect(amp).toMatchObject({ value: 10, placeholder: 12, min: 0, max: 64, step: 0.1, optional: false })
    const offset = fieldsOf('hill').fields.get('params.offset') as NumberField
    expect(offset).toMatchObject({ value: undefined, placeholder: 0, optional: true })
    const level = fieldsOf('pond').fields.get('params.level') as NumberField
    expect(level).toMatchObject({ min: 1, max: 127, step: 1 })
  })

  it('makes edits that set and clear params', () => {
    const { d, fields } = fieldsOf('hill')
    expect((fields.get('params.offset') as NumberField).edit(4)(d).ops[0]!.params).toEqual({ amplitude: 10, offset: 4 })
    expect((fields.get('params.amplitude') as NumberField).edit(undefined)(d).ops[0]!.params).toEqual({})
  })

  it('offers the blend modes with the default first', () => {
    const { d, fields } = fieldsOf('hill')
    const blend = fields.get('blend') as SelectField
    expect(blend.value).toBe('')
    expect(blend.options.map((o) => o.value)).toEqual(['', 'add', 'carve', 'max', 'min', 'set'])
    expect(blend.options[0]!.label).toBe('default (add)')
    expect(blend.edit('max')(d).ops[0]!.blend).toBe('max')
  })

  it('edits the shape: radius, falloff (cleared when emptied) and centre', () => {
    const { d, fields } = fieldsOf('hill')
    expect((fields.get('shape.radius') as NumberField).edit(30)(d).ops[0]!.shape).toMatchObject({ radius: 30 })
    expect('falloff' in (fields.get('shape.falloff') as NumberField).edit(undefined)(d).ops[0]!.shape).toBe(false)
    expect((fields.get('shape.center[0]') as NumberField).edit(77)(d).ops[0]!.shape).toMatchObject({ center: [77, 64] })
  })

  it('lists path points with x, z and optional y and width', () => {
    const { d, fields } = fieldsOf('ridge')
    const p1 = fields.get('shape.points[1]') as GroupField
    expect(p1.fields.map((f) => f.path)).toEqual(['shape.points[1].x', 'shape.points[1].z', 'shape.points[1].y', 'shape.points[1].width'])
    const y = fields.get('shape.points[1].y') as NumberField
    expect(y).toMatchObject({ value: undefined, optional: true })
    expect(y.edit(12)(d).ops[1]!.shape).toMatchObject({ points: [{ x: 150, z: 40 }, { x: 200, z: 90, y: 12 }] })
    const withY = y.edit(12)(d)
    const cleared = (opFields(withY.ops[1]!, builtinOps.get('mountain')!, withY, HEIGHT).at(-1) as GroupField).fields[1] as GroupField
    expect((cleared.fields[2] as NumberField).edit(undefined)(withY).ops[1]!.shape).toMatchObject({ points: [{ x: 150, z: 40 }, { x: 200, z: 90 }] })
  })

  it('lists polygon points as x and z', () => {
    const { d, fields } = fieldsOf('pond')
    expect((fields.get('shape.points[0][1]') as NumberField).edit(170)(d).ops[2]!.shape).toMatchObject({ points: [[100, 170], [140, 180], [140, 220], [100, 220]] })
  })

  it('edits a noise param as a group, with warp as a toggle', () => {
    const { d, fields } = fieldsOf('hill')
    const noise = fields.get('params.noise') as GroupField
    expect(noise.fields.map((f) => f.path)).toEqual([
      'params.noise.type', 'params.noise.scale', 'params.noise.octaves', 'params.noise.lacunarity', 'params.noise.gain', 'params.noise.seed', 'params.noise.warp',
    ])
    const scale = fields.get('params.noise.scale') as NumberField
    expect(scale.value).toBe(64) // the schema default
    expect(scale.edit(80)(d).ops[0]!.params.noise).toEqual({ scale: 80 })
    const warp = fields.get('params.noise.warp') as Field & { kind: 'bool' }
    expect(warp.edit(true)(d).ops[0]!.params.noise).toEqual({ scale: 64, warp: { scale: 64, amount: 16 } })
  })

  it('offers the document biomes for a biome param', () => {
    const d = doc()
    const def: OpDef = { id: 'b', type: 'biome', enabled: true, shape: { kind: 'circle', center: [10, 10], radius: 5 }, params: { biome: 'mesa' } }
    const f = byPath(opFields(def, builtinOps.get('biome')!, d, HEIGHT)).get('params.biome') as SelectField
    expect(f.value).toBe('mesa')
    expect(f.options.map((o) => o.value)).toEqual(['plain', 'mesa'])
  })
})

describe('docFields', () => {
  it('edits the sea level and the base fill', () => {
    const d = doc()
    const f = byPath(docFields(d, HEIGHT))
    expect((f.get('seaLevel') as NumberField)).toMatchObject({ value: 10, min: 0, max: 127, step: 1 })
    expect((f.get('seaLevel') as NumberField).edit(12)(d).seaLevel).toBe(12)
    expect((f.get('base.amplitude') as NumberField).edit(6)(d).base).toEqual({ height: 30, amplitude: 6, noise: { scale: 64 } })
    expect((f.get('base.noise.octaves') as NumberField).edit(3)(d).base.noise).toEqual({ scale: 64, octaves: 3 })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @elovox/terrain-editor -- fields`
Expected: FAIL — `../src/ui/panels/fields.ts` not found.

- [ ] **Step 3: Write the implementation**

`packages/terrain-editor/src/ui/panels/fields.ts`:

```ts
import {
  BLEND_MODES, NOISE_TYPES, resolveBound,
  type BlendMode, type NoiseDef, type NumberParam, type OpDef, type OpImpl, type PathPoint, type ShapeDef, type TerrainDoc, type Vec2,
} from '@elovox/terrain'
import { moveVertex, setBase, setBlend, setParam, setSeaLevel, setShape, type Edit } from '../../core/edits.ts'

interface FieldBase { path: string; label: string }
export interface NumberField extends FieldBase {
  kind: 'number'
  value: number | undefined
  /** What an empty value means (the default), shown greyed out. */
  placeholder: number | undefined
  min: number
  max: number
  step: number
  /** May be emptied (edit(undefined) clears it). */
  optional: boolean
  edit(v: number | undefined): Edit
}
export interface SelectField extends FieldBase { kind: 'select'; value: string; options: readonly { value: string; label: string }[]; edit(v: string): Edit }
export interface BoolField extends FieldBase { kind: 'bool'; value: boolean; edit(v: boolean): Edit }
export interface GroupField extends FieldBase { kind: 'group'; fields: Field[] }
export type Field = NumberField | SelectField | BoolField | GroupField

/** Calls `visit` on every field, groups first, then their children. */
export function walkFields(fields: Field[], visit: (f: Field) => void): void {
  for (const f of fields) {
    visit(f)
    if (f.kind === 'group') walkFields(f.fields, visit)
  }
}

interface NumOpts { min: number; max: number; step: number; optional?: boolean; placeholder?: number }
function num(path: string, label: string, value: number | undefined, o: NumOpts, edit: (v: number | undefined) => Edit): NumberField {
  return { kind: 'number', path, label, value, placeholder: o.placeholder, min: o.min, max: o.max, step: o.step, optional: o.optional ?? false, edit }
}

/** A copy of `o` with `key` set, or removed when `v` is undefined. */
function withKey<T extends object>(o: T, key: string, v: unknown): T {
  const out = { ...o } as Record<string, unknown>
  if (v === undefined) delete out[key]
  else out[key] = v
  return out as T
}

function paramNumber(path: string, label: string, value: number | undefined, spec: NumberParam, ctx: { biomes: readonly string[]; height: number }, edit: (v: number | undefined) => Edit): NumberField {
  const min = spec.range?.[0] ?? spec.min ?? spec.gt ?? 0
  const max = spec.range?.[1] ?? resolveBound(spec.max, ctx) ?? Math.max(min + 1, 100)
  const step = spec.step ?? (spec.int || spec.anchor ? 1 : 0.1)
  return num(path, label, value, { min, max, step, optional: !spec.required, placeholder: spec.default }, edit)
}

/** The fields of a NoiseDef, with warp as an on/off toggle plus its two numbers. */
function noiseGroup(path: string, label: string, n: NoiseDef, edit: (n: NoiseDef) => Edit): GroupField {
  const set = (key: string) => (v: unknown) => edit(withKey(n, key, v))
  const fields: Field[] = [
    { kind: 'select', path: `${path}.type`, label: 'type', value: n.type ?? 'fbm', options: NOISE_TYPES.map((t) => ({ value: t, label: t })), edit: (v) => edit(withKey(n, 'type', v === 'fbm' ? undefined : v)) },
    num(`${path}.scale`, 'scale', n.scale, { min: 1, max: 512, step: 1 }, (v) => edit({ ...n, scale: v ?? n.scale })),
    num(`${path}.octaves`, 'octaves', n.octaves, { min: 1, max: 8, step: 1, optional: true, placeholder: 4 }, set('octaves')),
    num(`${path}.lacunarity`, 'lacunarity', n.lacunarity, { min: 1, max: 4, step: 0.1, optional: true, placeholder: 2 }, set('lacunarity')),
    num(`${path}.gain`, 'gain', n.gain, { min: 0.05, max: 1, step: 0.05, optional: true, placeholder: 0.5 }, set('gain')),
    num(`${path}.seed`, 'seed', n.seed, { min: -1000, max: 1000, step: 1, optional: true, placeholder: 0 }, set('seed')),
    { kind: 'bool', path: `${path}.warp`, label: 'warp', value: n.warp !== undefined, edit: (on) => edit(withKey(n, 'warp', on ? n.warp ?? { scale: 64, amount: 16 } : undefined)) },
  ]
  if (n.warp) {
    const w = n.warp
    fields.push(
      num(`${path}.warp.scale`, 'warp scale', w.scale, { min: 1, max: 512, step: 1 }, (v) => edit({ ...n, warp: { ...w, scale: v ?? w.scale } })),
      num(`${path}.warp.amount`, 'warp amount', w.amount, { min: 0, max: 128, step: 1 }, (v) => edit({ ...n, warp: { ...w, amount: v ?? w.amount } })),
    )
  }
  return { kind: 'group', path, label, fields }
}

function shapeFields(def: OpDef, impl: OpImpl, doc: TerrainDoc): Field[] {
  const s = def.shape, id = def.id
  const set = (shape: ShapeDef) => setShape(id, shape)
  const out: Field[] = []
  if (s.kind === 'circle') {
    const [cx, cz] = s.center
    out.push(
      num('shape.center[0]', 'x', cx, { min: 0, max: doc.size[0], step: 1 }, (v) => set({ ...s, center: [v ?? cx, cz] })),
      num('shape.center[1]', 'z', cz, { min: 0, max: doc.size[1], step: 1 }, (v) => set({ ...s, center: [cx, v ?? cz] })),
      num('shape.radius', 'radius', s.radius, { min: 1, max: 256, step: 1 }, (v) => set({ ...s, radius: v ?? s.radius })),
    )
  } else if (s.kind === 'polygon') {
    out.push(num('shape.inset', 'inset', s.inset, { min: 1, max: 64, step: 1, optional: true, placeholder: 16 }, (v) => set(withKey(s, 'inset', v))))
  } else {
    out.push(num('shape.width', 'width', s.width, { min: 1, max: 128, step: 1 }, (v) => set({ ...s, width: v ?? s.width })))
  }
  if (impl.falloff) out.push(num('shape.falloff', 'falloff', s.falloff, { min: 0, max: 128, step: 1, optional: true, placeholder: 0 }, (v) => set(withKey(s, 'falloff', v))))
  return out
}

function pointsGroup(def: OpDef, impl: OpImpl, doc: TerrainDoc, height: number): GroupField {
  const s = def.shape as Exclude<ShapeDef, { kind: 'circle' }>
  const id = def.id
  const fields: Field[] = s.points.map((p, i) => {
    const path = `shape.points[${i}]`
    if (s.kind === 'polygon') {
      const [x, z] = p as Vec2
      return {
        kind: 'group', path, label: `#${i}`, fields: [
          num(`${path}[0]`, 'x', x, { min: 0, max: doc.size[0], step: 1 }, (v) => moveVertex(id, i, [v ?? x, z])),
          num(`${path}[1]`, 'z', z, { min: 0, max: doc.size[1], step: 1 }, (v) => moveVertex(id, i, [x, v ?? z])),
        ],
      }
    }
    const q = p as PathPoint
    const set = (key: keyof PathPoint) => (v: number | undefined) => moveVertex(id, i, withKey(q, key, v))
    return {
      kind: 'group', path, label: `#${i}`, fields: [
        num(`${path}.x`, 'x', q.x, { min: 0, max: doc.size[0], step: 1 }, (v) => moveVertex(id, i, { ...q, x: v ?? q.x })),
        num(`${path}.z`, 'z', q.z, { min: 0, max: doc.size[1], step: 1 }, (v) => moveVertex(id, i, { ...q, z: v ?? q.z })),
        num(`${path}.y`, 'y', q.y, { min: 0, max: height, step: 1, optional: !impl.needY }, set('y')),
        num(`${path}.width`, 'width', q.width, { min: 1, max: 128, step: 1, optional: true, placeholder: (s as Extract<ShapeDef, { kind: 'path' }>).width }, set('width')),
      ],
    }
  })
  return { kind: 'group', path: 'shape.points', label: 'points', fields }
}

/** The inspector for one op. */
export function opFields(def: OpDef, impl: OpImpl, doc: TerrainDoc, height: number): Field[] {
  const id = def.id
  const out: Field[] = []
  if (impl.kind === 'height') {
    out.push({
      kind: 'select', path: 'blend', label: 'blend', value: def.blend ?? '',
      options: [{ value: '', label: `default (${impl.defaultBlend})` }, ...BLEND_MODES.map((m) => ({ value: m, label: m }))],
      edit: (v) => setBlend(id, v === '' ? undefined : (v as BlendMode)),
    })
  }
  out.push(...shapeFields(def, impl, doc))
  const ctx = { biomes: doc.biomes.map((b) => b.name), height }
  for (const [key, spec] of Object.entries(impl.params)) {
    const path = `params.${key}`
    const value = def.params[key]
    const set = (v: unknown) => setParam(id, key, v)
    switch (spec.type) {
      case 'number': out.push(paramNumber(path, key, value as number | undefined, spec, ctx, set)); break
      case 'enum': out.push({ kind: 'select', path, label: key, value: (value as string | undefined) ?? spec.default, options: spec.values.map((v) => ({ value: v, label: v })), edit: set }); break
      case 'bool': out.push({ kind: 'bool', path, label: key, value: (value as boolean | undefined) ?? spec.default, edit: set }); break
      case 'biome': out.push({ kind: 'select', path, label: key, value: String(value ?? ''), options: ctx.biomes.map((b) => ({ value: b, label: b })), edit: set }); break
      case 'noise': out.push(noiseGroup(path, key, (value as NoiseDef | undefined) ?? spec.default, set)); break
    }
  }
  if (def.shape.kind !== 'circle') out.push(pointsGroup(def, impl, doc, height))
  return out
}

/** The inspector with nothing selected: fields that apply to the whole world. */
export function docFields(doc: TerrainDoc, height: number): Field[] {
  const b = doc.base
  return [
    num('seaLevel', 'sea level', doc.seaLevel, { min: 0, max: height - 1, step: 1 }, (v) => setSeaLevel(v ?? doc.seaLevel)),
    {
      kind: 'group', path: 'base', label: 'base fill', fields: [
        num('base.height', 'height', b.height, { min: 0, max: height, step: 1 }, (v) => setBase({ ...b, height: v ?? b.height })),
        num('base.amplitude', 'amplitude', b.amplitude, { min: 0, max: 64, step: 0.5 }, (v) => setBase({ ...b, amplitude: v ?? b.amplitude })),
        noiseGroup('base.noise', 'noise', b.noise, (n) => setBase({ ...b, noise: n })),
      ],
    },
  ]
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -w @elovox/terrain-editor -- fields`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/terrain-editor/src/ui/panels/fields.ts packages/terrain-editor/test/fields.test.ts
git commit -m "feat(terrain-editor): inspector field model from the param schema"
```

### Task 15: DOM panels and keyboard shortcuts

The toolbar, the op list and the inspector, in plain DOM like the sandbox panels. The inspector rebuilds only when the set of fields changes; otherwise it updates values in place, so a slider being dragged is never destroyed under the pointer, and its handlers always read the latest field (whose edit closure matches the current document).

**Files:**
- Create: `packages/terrain-editor/src/ui/panels/dom.ts`, `toolbar.ts`, `opList.ts`, `inspector.ts`
- Create: `packages/terrain-editor/src/ui/keys.ts`
- Test: `packages/terrain-editor/test/keys.test.ts`

**Interfaces:**
- Consumes: Task 14 fields; `PreviewStatus` (Task 9); `Edit`; `OpRegistry`, `ShapeKind`, `TerrainDoc`.
- Produces:
  - `dom.ts`: `h(tag, props?, ...children)`, `PANEL_STYLE`.
  - `toolbar.ts`: `interface ToolbarState { fileName: string; dirty: boolean; canUndo: boolean; canRedo: boolean; status: PreviewStatus; showAll: boolean }`, `interface ToolbarActions { open(): void; save(): void; saveAs(): void; undo(): void; redo(): void; showAll(on: boolean): void }`, `statusText(s: PreviewStatus): string`, `createToolbar(parent: HTMLElement, actions: ToolbarActions): { el: HTMLElement; render(s: ToolbarState): void }`. Element ids: `editor-toolbar`, `editor-open`, `editor-save`, `editor-saveas`, `editor-undo`, `editor-redo`, `editor-file`, `editor-status`, `editor-showall`.
  - `opList.ts`: `interface OpListActions { select(id: string): void; toggle(id: string, on: boolean): void; move(id: string, delta: number): void; add(type: string, kind: ShapeKind): void }`, `createOpList(parent: HTMLElement, registry: OpRegistry, actions: OpListActions): { el: HTMLElement; render(doc: TerrainDoc, selected: string | null, failed: string | null): void }`. Ids: `editor-oplist`, `editor-add` (a `<select>` whose option values are `"type:kind"`), rows `[data-op="<id>"]`.
  - `inspector.ts`: `interface InspectorActions { run(label: string, edit: Edit): void; live(label: string, edit: Edit): void; endLive(): void }`, `createInspector(parent: HTMLElement, actions: InspectorActions): { el: HTMLElement; render(title: string, fields: Field[], errorPrefix: string): void; setErrors(errors: string[]): void }`. Id: `editor-inspector`. `errorPrefix` is stripped from error paths (`ops[3].` for the selected op, `''` for the document).
  - `keys.ts`: `type Action = 'undo' | 'redo' | 'delete' | 'duplicate' | 'toggle' | 'cancel' | 'save'`, `interface KeyLike { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }`, `actionFor(e: KeyLike, typing: boolean): Action | null`, `isTyping(el: { tagName: string; type?: string; isContentEditable?: boolean } | null): boolean`.

- [ ] **Step 1: Write the failing test**

`packages/terrain-editor/test/keys.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { actionFor, isTyping } from '../src/ui/keys.ts'
import { statusText } from '../src/ui/panels/toolbar.ts'

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods })

describe('actionFor', () => {
  it('maps the editor shortcuts', () => {
    expect(actionFor(key('z', { ctrlKey: true }), false)).toBe('undo')
    expect(actionFor(key('Z', { ctrlKey: true, shiftKey: true }), false)).toBe('redo')
    expect(actionFor(key('y', { ctrlKey: true }), false)).toBe('redo')
    expect(actionFor(key('z', { metaKey: true }), false)).toBe('undo')
    expect(actionFor(key('d', { ctrlKey: true }), false)).toBe('duplicate')
    expect(actionFor(key('Delete'), false)).toBe('delete')
    expect(actionFor(key('Backspace'), false)).toBe('delete')
    expect(actionFor(key('h'), false)).toBe('toggle')
    expect(actionFor(key('Escape'), false)).toBe('cancel')
    expect(actionFor(key('s', { ctrlKey: true }), false)).toBe('save')
    expect(actionFor(key('w'), false)).toBeNull()
  })

  it('leaves keys to a focused text field, except save and cancel', () => {
    expect(actionFor(key('Delete'), true)).toBeNull()
    expect(actionFor(key('z', { ctrlKey: true }), true)).toBeNull()
    expect(actionFor(key('s', { ctrlKey: true }), true)).toBe('save')
    expect(actionFor(key('Escape'), true)).toBe('cancel')
  })
})

describe('isTyping', () => {
  it('is true for text inputs, selects and text areas, false for sliders, checkboxes and nothing', () => {
    expect(isTyping({ tagName: 'INPUT', type: 'number' })).toBe(true)
    expect(isTyping({ tagName: 'SELECT' })).toBe(true)
    expect(isTyping({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTyping({ tagName: 'INPUT', type: 'range' })).toBe(false)
    expect(isTyping({ tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(isTyping({ tagName: 'CANVAS' })).toBe(false)
    expect(isTyping(null)).toBe(false)
  })
})

describe('statusText', () => {
  it('describes each preview state', () => {
    expect(statusText({ state: 'idle', last: null })).toBe('ready')
    expect(statusText({ state: 'idle', last: { ms: 84.4, chunks: 12, wallMs: 131.6 } })).toBe('regen 84 ms · 12 chunks · 132 ms to mesh')
    expect(statusText({ state: 'busy' })).toBe('updating…')
    expect(statusText({ state: 'error', message: 'op "x" failed: boom', opId: 'x' })).toBe('error: op "x" failed: boom')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @elovox/terrain-editor -- keys`
Expected: FAIL — `../src/ui/keys.ts` not found.

- [ ] **Step 3: Write the implementation**

`packages/terrain-editor/src/ui/keys.ts`:

```ts
export type Action = 'undo' | 'redo' | 'delete' | 'duplicate' | 'toggle' | 'cancel' | 'save'

export interface KeyLike { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }

/** The editor action for a key press. While a text field has focus (`typing`) only save and cancel apply. */
export function actionFor(e: KeyLike, typing: boolean): Action | null {
  const mod = e.ctrlKey || e.metaKey
  const k = e.key.toLowerCase()
  if (mod && k === 's') return 'save'
  if (k === 'escape') return 'cancel'
  if (typing) return null
  if (mod && k === 'z') return e.shiftKey ? 'redo' : 'undo'
  if (mod && k === 'y') return 'redo'
  if (mod && k === 'd') return 'duplicate'
  if (mod || e.altKey) return null
  if (k === 'delete' || k === 'backspace') return 'delete'
  if (k === 'h') return 'toggle'
  return null
}

const NOT_TEXT = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'color'])

/** Whether keys belong to a form field rather than the editor. */
export function isTyping(el: { tagName: string; type?: string; isContentEditable?: boolean } | null): boolean {
  if (!el) return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  return el.tagName === 'INPUT' && !NOT_TEXT.has(el.type ?? 'text')
}
```

`packages/terrain-editor/src/ui/panels/dom.ts`:

```ts
type Props<K extends keyof HTMLElementTagNameMap> =
  Omit<Partial<HTMLElementTagNameMap[K]>, 'style' | 'dataset'> & { style?: Partial<CSSStyleDeclaration>; dataset?: Record<string, string> }

/** Creates an element with properties, inline style, data attributes and children. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {}, ...children: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  const { style, dataset, ...rest } = props
  Object.assign(el, rest)
  if (style) Object.assign(el.style, style)
  if (dataset) Object.assign(el.dataset, dataset)
  for (const c of children) if (c !== null && c !== false && c !== undefined) el.append(c)
  return el
}

/** The look of every editor panel (matches the sandbox panels). */
export const PANEL_STYLE: Partial<CSSStyleDeclaration> = {
  padding: '10px 12px', borderRadius: '8px', display: 'grid', gap: '6px',
  background: 'rgba(255, 255, 255, 0.88)', color: '#1b1f24', font: '12px/1.4 ui-monospace, Menlo, Consolas, monospace',
}
```

`packages/terrain-editor/src/ui/panels/toolbar.ts`:

```ts
import type { PreviewStatus } from '../../core/preview.ts'
import { PANEL_STYLE, h } from './dom.ts'

export interface ToolbarState { fileName: string; dirty: boolean; canUndo: boolean; canRedo: boolean; status: PreviewStatus; showAll: boolean }
export interface ToolbarActions { open(): void; save(): void; saveAs(): void; undo(): void; redo(): void; showAll(on: boolean): void }

export function statusText(s: PreviewStatus): string {
  switch (s.state) {
    case 'busy': return 'updating…'
    case 'error': return `error: ${s.message}`
    case 'idle':
      return s.last ? `regen ${s.last.ms.toFixed(0)} ms · ${s.last.chunks} chunks · ${s.last.wallMs.toFixed(0)} ms to mesh` : 'ready'
  }
}

export function createToolbar(parent: HTMLElement, actions: ToolbarActions): { el: HTMLElement; render(s: ToolbarState): void } {
  const button = (id: string, text: string, title: string, fn: () => void) => {
    const b = h('button', { id, textContent: text, title })
    b.addEventListener('click', fn)
    return b
  }
  const undo = button('editor-undo', 'Undo', 'Undo (Ctrl+Z)', actions.undo)
  const redo = button('editor-redo', 'Redo', 'Redo (Ctrl+Shift+Z)', actions.redo)
  const file = h('div', { id: 'editor-file', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } })
  const status = h('div', { id: 'editor-status', style: { whiteSpace: 'pre-wrap' } })
  const all = h('input', { type: 'checkbox', id: 'editor-showall' })
  all.addEventListener('change', () => actions.showAll(all.checked))
  const el = h('div', { id: 'editor-toolbar', style: PANEL_STYLE },
    h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
      button('editor-open', 'Open', 'Open a .terrain.json file', actions.open),
      button('editor-save', 'Save', 'Save (Ctrl+S)', actions.save),
      button('editor-saveas', 'Save as', 'Save to a new file', actions.saveAs),
      undo, redo),
    file, status,
    h('label', {}, all, ' show all ops'))
  parent.append(el)
  return {
    el,
    render(s) {
      file.textContent = `${s.dirty ? '● ' : ''}${s.fileName}`
      file.title = s.dirty ? 'unsaved changes' : 'saved'
      undo.disabled = !s.canUndo
      redo.disabled = !s.canRedo
      status.textContent = statusText(s.status)
      status.style.color = s.status.state === 'error' ? '#c62828' : 'inherit'
      all.checked = s.showAll
    },
  }
}
```

`packages/terrain-editor/src/ui/panels/opList.ts`:

```ts
import type { OpRegistry, ShapeKind, TerrainDoc } from '@elovox/terrain'
import { PANEL_STYLE, h } from './dom.ts'

export interface OpListActions {
  select(id: string): void
  toggle(id: string, on: boolean): void
  move(id: string, delta: number): void
  add(type: string, kind: ShapeKind): void
}

export function createOpList(parent: HTMLElement, registry: OpRegistry, actions: OpListActions): { el: HTMLElement; render(doc: TerrainDoc, selected: string | null, failed: string | null): void } {
  const add = h('select', { id: 'editor-add', title: 'Add an op at the centre of the view' },
    h('option', { value: '', textContent: '+ add op…' }),
    ...registry.types().flatMap((type) => registry.get(type)!.shapes.map((kind) => h('option', { value: `${type}:${kind}`, textContent: `${type} (${kind})` }))))
  add.addEventListener('change', () => {
    const [type, kind] = add.value.split(':')
    add.value = ''
    if (type && kind) actions.add(type, kind as ShapeKind)
  })
  const list = h('div', { id: 'editor-ops', style: { display: 'grid', gap: '2px', maxHeight: '50vh', overflowY: 'auto' } })
  const el = h('div', { id: 'editor-oplist', style: PANEL_STYLE }, add, list)
  parent.append(el)

  const small = (text: string, title: string, disabled: boolean, fn: () => void) => {
    const b = h('button', { textContent: text, title, disabled, style: { padding: '0 4px' } })
    b.addEventListener('click', (e) => { e.stopPropagation(); fn() })
    return b
  }

  return {
    el,
    render(doc, selected, failed) {
      list.replaceChildren(...doc.ops.map((op, i) => {
        const box = h('input', { type: 'checkbox', checked: op.enabled, title: 'enabled (H)' })
        box.addEventListener('click', (e) => e.stopPropagation())
        box.addEventListener('change', () => actions.toggle(op.id, box.checked))
        const row = h('div', {
          dataset: { op: op.id },
          style: {
            display: 'flex', gap: '6px', alignItems: 'center', padding: '2px 4px', borderRadius: '4px', cursor: 'pointer',
            background: op.id === selected ? 'rgba(255, 176, 32, 0.35)' : 'transparent',
            color: op.id === failed ? '#c62828' : 'inherit', opacity: op.enabled ? '1' : '0.55',
          },
        },
        box,
        h('span', { textContent: op.id, style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }),
        h('span', { textContent: op.type, style: { opacity: '0.6' } }),
        small('↑', 'earlier', i === 0, () => actions.move(op.id, -1)),
        small('↓', 'later', i === doc.ops.length - 1, () => actions.move(op.id, 1)))
        row.addEventListener('click', () => actions.select(op.id))
        return row
      }))
    },
  }
}
```

`packages/terrain-editor/src/ui/panels/inspector.ts`:

```ts
import type { Edit } from '../../core/edits.ts'
import { PANEL_STYLE, h } from './dom.ts'
import { walkFields, type BoolField, type Field, type NumberField, type SelectField } from './fields.ts'

export interface InspectorActions {
  /** One undoable edit (a typed number, a select). */
  run(label: string, edit: Edit): void
  /** One step of a live gesture (a slider being dragged); endLive() ends it. */
  live(label: string, edit: Edit): void
  endLive(): void
}

const ERROR_COLOR = '#c62828'

function structureOf(fields: Field[]): string {
  return fields.map((f) => (f.kind === 'group' ? `${f.path}{${structureOf(f.fields)}}` : `${f.kind}:${f.path}`)).join('|')
}

export function createInspector(parent: HTMLElement, actions: InspectorActions): {
  el: HTMLElement
  render(title: string, fields: Field[], errorPrefix: string): void
  setErrors(errors: string[]): void
} {
  const title = h('div', { style: { fontWeight: '600' } })
  const top = h('div', { style: { color: ERROR_COLOR, whiteSpace: 'pre-wrap' } })
  const body = h('div', { style: { display: 'grid', gap: '4px' } })
  const el = h('div', { id: 'editor-inspector', style: { ...PANEL_STYLE, overflowY: 'auto', maxHeight: 'calc(100vh - 80px)' } }, title, top, body)
  parent.append(el)

  let structure = ''
  let prefix = ''
  let errors: string[] = []
  const current = new Map<string, Field>() // the latest field for each path; handlers read it at event time
  const sync = new Map<string, (f: Field) => void>()
  const slots = new Map<string, HTMLElement>()
  const latest = <F extends Field>(path: string) => current.get(path) as F

  function label(text: string) {
    return h('span', { textContent: text, style: { width: '86px', flex: 'none', overflow: 'hidden', textOverflow: 'ellipsis' } })
  }

  function build(f: Field): HTMLElement {
    const slot = h('div', { style: { color: ERROR_COLOR, whiteSpace: 'pre-wrap' } })
    slots.set(f.path, slot)
    const row = (...children: Node[]) => h('div', {}, h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, ...children), slot)
    switch (f.kind) {
      case 'group':
        return h('details', { open: f.path !== 'shape.points' && !f.path.startsWith('shape.points[') },
          h('summary', { textContent: f.label, style: { cursor: 'pointer' } }),
          h('div', { style: { display: 'grid', gap: '4px', paddingLeft: '10px' } }, ...f.fields.map(build)),
          slot)
      case 'number': {
        const range = h('input', { type: 'range', min: String(f.min), max: String(f.max), step: String(f.step), style: { flex: '1', minWidth: '0' } })
        const box = h('input', { type: 'number', step: String(f.step), style: { width: '64px' } })
        const set = (g: NumberField) => {
          range.value = String(g.value ?? g.placeholder ?? g.min)
          if (document.activeElement !== box) box.value = g.value === undefined ? '' : String(g.value)
          box.placeholder = g.placeholder === undefined ? '' : String(g.placeholder)
        }
        set(f)
        sync.set(f.path, (g) => set(g as NumberField))
        range.addEventListener('input', () => { const g = latest<NumberField>(f.path); actions.live(g.label, g.edit(Number(range.value))) })
        range.addEventListener('change', () => actions.endLive())
        box.addEventListener('change', () => {
          const g = latest<NumberField>(f.path)
          const raw = box.value.trim()
          if (raw === '' && !g.optional) { set(g); return }
          const v = raw === '' ? undefined : Number(raw)
          if (v !== undefined && !Number.isFinite(v)) { set(g); return }
          actions.run(g.label, g.edit(v))
        })
        return row(label(f.label), range, box)
      }
      case 'select': {
        const sel = h('select', { style: { flex: '1', minWidth: '0' } }, ...f.options.map((o) => h('option', { value: o.value, textContent: o.label })))
        const set = (g: SelectField) => { sel.value = g.value }
        set(f)
        sync.set(f.path, (g) => set(g as SelectField))
        sel.addEventListener('change', () => { const g = latest<SelectField>(f.path); actions.run(g.label, g.edit(sel.value)) })
        return row(label(f.label), sel)
      }
      case 'bool': {
        const box = h('input', { type: 'checkbox' })
        const set = (g: BoolField) => { box.checked = g.value }
        set(f)
        sync.set(f.path, (g) => set(g as BoolField))
        box.addEventListener('change', () => { const g = latest<BoolField>(f.path); actions.run(g.label, g.edit(box.checked)) })
        return row(label(f.label), box)
      }
    }
  }

  /** Shows each error under the deepest field its path falls in; the rest at the top. */
  function showErrors(): void {
    for (const s of slots.values()) s.textContent = ''
    const unmatched: string[] = []
    for (const e of errors) {
      const cut = e.indexOf(': ')
      const path = cut < 0 ? e : e.slice(0, cut)
      const message = cut < 0 ? '' : e.slice(cut + 2)
      const local = prefix !== '' && path.startsWith(prefix) ? path.slice(prefix.length) : path
      let best: string | null = null
      for (const p of slots.keys()) {
        const inside = local === p || local.startsWith(`${p}.`) || local.startsWith(`${p}[`)
        if (inside && (best === null || p.length > best.length)) best = p
      }
      if (best === null) unmatched.push(e)
      else slots.get(best)!.textContent += `${message}\n`
    }
    top.textContent = unmatched.join('\n')
  }

  return {
    el,
    render(t, fields, errorPrefix) {
      title.textContent = t
      prefix = errorPrefix
      current.clear()
      walkFields(fields, (f) => current.set(f.path, f))
      const s = `${t}#${structureOf(fields)}`
      if (s === structure) {
        walkFields(fields, (f) => sync.get(f.path)?.(f))
      } else {
        structure = s
        sync.clear()
        slots.clear()
        body.replaceChildren(...fields.map(build))
      }
      showErrors()
    },
    setErrors(e) {
      errors = e
      showErrors()
    },
  }
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npm test -w @elovox/terrain-editor -- keys`
Expected: PASS (5 tests).

Run: `npm run typecheck -w @elovox/terrain-editor`
Expected: no errors. (The panels are exercised by the e2e test in Task 17.)

- [ ] **Step 5: Commit**

```bash
git add packages/terrain-editor/src/ui/keys.ts packages/terrain-editor/src/ui/panels packages/terrain-editor/test/keys.test.ts
git commit -m "feat(terrain-editor): toolbar, op list, inspector and keyboard shortcuts"
```

### Task 16: `createTerrainEditor` — wiring it together

**Files:**
- Create: `packages/terrain-editor/src/ui/editor.ts`
- Modify: `packages/terrain-editor/src/index.ts`

**Interfaces:**
- Consumes: everything above; from `@elovox/engine`: `type Engine`; from `@elovox/terrain`: `builtinOps`, `validateTerrainDoc`, `TerrainDocError`, types `OpDef, OpRegistry, ShapeKind, TerrainDoc, Vec2`; from `'three/webgpu'`: `Vector3`.
- Produces:
  - `interface TerrainEditorOptions { doc: unknown; fileName: string; ops?: OpRegistry; root?: HTMLElement }` — `doc` is the document the engine was created with (raw JSON is fine).
  - `interface TerrainEditor { readonly session: EditorSession; readonly preview: PreviewScheduler; handleScreen(kind: HandleKind, index?: number): { x: number; y: number } | null; dispose(): void }` — `handleScreen` gives client coordinates of a handle of the selected op (for e2e and tooling).
  - `createTerrainEditor(engine: Engine, o: TerrainEditorOptions): TerrainEditor` — throws `TerrainDocError` if `doc` is invalid.
  - Behaviour: left button on the canvas — on a handle of the selected op starts a handle drag (Shift on a handle with a height: height drag; Alt on a vertex: remove it); on the selected op's outline drags the whole op; with "show all" on, on another op's outline selects it; a click elsewhere (moved < 4 px) clears the selection. Esc cancels a drag. The "+" menu adds an op at the terrain point under the canvas centre (or the camera target). Ctrl+D duplicates the selected op 16 blocks along +x, after it.

- [ ] **Step 1: Write the implementation**

`packages/terrain-editor/src/ui/editor.ts`:

```ts
import type { Engine } from '@elovox/engine'
import { TerrainDocError, builtinOps, validateTerrainDoc, type OpDef, type OpRegistry, type ShapeKind, type TerrainDoc, type Vec2 } from '@elovox/terrain'
import { Vector3 } from 'three/webgpu'
import { parseTerrainText, serializeTerrain } from '../core/docio.ts'
import { addOp, removeOp, removeVertex, reorderOp, replaceOp, setEnabled, type Edit } from '../core/edits.ts'
import { newOp, nextOpId } from '../core/newOp.ts'
import { PreviewScheduler } from '../core/preview.ts'
import { EditorSession, type EditResult } from '../core/session.ts'
import { TerrainFiles, browserFallback, type FileHandle, type FileHost } from './files.ts'
import { dragHandle, translateShape, type DragPoint, type Handle, type HandleKind } from './handles/geometry.ts'
import { LIFT, Overlay, groundSampler } from './handles/overlay.ts'
import { distanceToPolyline, hitHorizontal, hitVertical, nearest, rayAt, toScreen, type ScreenPoint } from './handles/pick.ts'
import { actionFor, isTyping } from './keys.ts'
import { h } from './panels/dom.ts'
import { docFields, opFields } from './panels/fields.ts'
import { createInspector } from './panels/inspector.ts'
import { createOpList } from './panels/opList.ts'
import { createToolbar } from './panels/toolbar.ts'

export interface TerrainEditorOptions {
  /** The document the engine was created with (raw JSON or a validated document). */
  doc: unknown
  /** The name "Save" suggests when the document did not come from a file. */
  fileName: string
  ops?: OpRegistry
  /** Where the panels go. Default document.body. */
  root?: HTMLElement
}

export interface TerrainEditor {
  readonly session: EditorSession
  readonly preview: PreviewScheduler
  /** Client coordinates of a handle of the selected op; null if there is none or it is off screen. */
  handleScreen(kind: HandleKind, index?: number): { x: number; y: number } | null
  dispose(): void
}

/** Pixels within which a pointer grabs a handle, and an outline. */
const HANDLE_PX = 10
const OUTLINE_PX = 6
/** A click that moves less than this clears the selection. */
const CLICK_PX = 4
/** Blocks a duplicate is moved along +x. */
const DUPLICATE_OFFSET = 16
const MESH_SETTLE_TIMEOUT_MS = 10_000

interface Drag {
  handle: Handle | 'body'
  start: OpDef
  grab: DragPoint
  mode: 'xz' | 'y'
  /** Height of the horizontal drag plane. */
  planeY: number
  /** Horizontal normal of the vertical (height) drag plane: the camera's forward direction at the start. */
  normal: { x: number; z: number }
  /** Where the dragged handle stands (x, z). */
  anchor: { x: number; z: number }
  pointerId: number
}

/** Resolves once the mesh queue drained (the regenerated chunks are visible), or after a timeout. */
function waitForMeshes(engine: Engine): Promise<void> {
  const start = performance.now()
  return new Promise((resolve) => {
    const check = () => {
      const s = engine.stats()
      if (s.meshQueue + s.meshInFlight === 0 || performance.now() - start > MESH_SETTLE_TIMEOUT_MS) resolve()
      else requestAnimationFrame(check)
    }
    check()
  })
}

/** Block ids the outline draping looks through: tree trunks and leaves. */
function treeIds(engine: Engine, doc: TerrainDoc): Set<number> {
  const out = new Set<number>()
  for (const name of [doc.blocks.log, doc.blocks.leaves, doc.blocks.pineLeaves]) {
    try { out.add(engine.blocks.id(name)) } catch { /* not registered: nothing to skip */ }
  }
  return out
}

export function createTerrainEditor(engine: Engine, o: TerrainEditorOptions): TerrainEditor {
  const registry = o.ops ?? builtinOps
  const height = engine.layout.size[1]
  const size: Vec2 = [engine.layout.size[0], engine.layout.size[2]]
  const parsed = validateTerrainDoc(o.doc, { ops: registry, worldHeight: height })
  if (!parsed.ok) throw new TerrainDocError(parsed.errors)
  const camera = engine.camera
  const canvas = engine.renderer.domElement
  const root = o.root ?? document.body

  const session = new EditorSession(parsed.doc, { worldHeight: height, ops: registry })
  let failedId: string | null = null
  const preview = new PreviewScheduler(engine.terrain, parsed.doc, {
    size,
    settle: () => waitForMeshes(engine),
    onStatus: (s) => {
      failedId = s.state === 'error' ? s.opId : s.state === 'idle' ? null : failedId
      renderToolbar()
      renderList()
      invalidate()
    },
  })
  const files = new TerrainFiles(window as unknown as FileHost, browserFallback(document))
  let fileHandle: FileHandle | null = null
  let fileName = o.fileName
  let showAll = false

  const ground = groundSampler(engine.world.get, treeIds(engine, parsed.doc), height, size)
  const overlay = new Overlay(ground)
  engine.scene.add(overlay.group)

  // ---- panels
  const left = h('div', { style: { position: 'fixed', top: '12px', left: '12px', width: '300px', display: 'grid', gap: '8px', zIndex: '6', maxHeight: 'calc(100vh - 24px)', alignContent: 'start' } })
  const right = h('div', { style: { position: 'fixed', top: '52px', right: '12px', width: '310px', zIndex: '6' } })
  root.append(left, right)

  const report = (r: EditResult): boolean => {
    inspector.setErrors(r.ok ? [] : r.errors)
    return r.ok
  }
  const run = (label: string, edit: Edit): boolean => {
    if (session.inGesture) session.commit()
    return report(session.apply(label, edit))
  }
  const selectedDef = (): OpDef | null => session.doc.ops.find((op) => op.id === session.selected) ?? null

  const toolbar = createToolbar(left, {
    open: () => void open(),
    save: () => void save(false),
    saveAs: () => void save(true),
    undo: () => { endDrag(); session.undo() },
    redo: () => { endDrag(); session.redo() },
    showAll: (on) => { showAll = on; invalidate(); renderToolbar() },
  })
  const list = createOpList(left, registry, {
    select: (id) => session.select(id),
    toggle: (id, on) => run(on ? 'enable' : 'disable', setEnabled(id, on)),
    move: (id, delta) => run('reorder', reorderOp(id, delta)),
    add,
  })
  const inspector = createInspector(right, {
    run,
    live: (label, edit) => {
      if (!session.inGesture) session.begin(label)
      report(session.update(edit))
    },
    endLive: () => { if (session.inGesture) session.commit() },
  })

  function renderToolbar(): void {
    toolbar.render({ fileName, dirty: session.dirty, canUndo: session.canUndo, canRedo: session.canRedo, status: preview.status, showAll })
  }
  function renderList(): void {
    list.render(session.doc, session.selected, failedId)
  }
  function renderInspector(): void {
    const def = selectedDef()
    if (!def) {
      inspector.render('document', docFields(session.doc, height), '')
      return
    }
    const index = session.doc.ops.indexOf(def)
    inspector.render(`${def.id} · ${def.type}`, opFields(def, registry.get(def.type)!, session.doc, height), `ops[${index}].`)
  }

  // ---- overlay, redrawn at most once per frame
  let overlayDirty = true
  const invalidate = () => { overlayDirty = true }
  const flushOverlay = () => {
    if (!overlayDirty) return
    overlayDirty = false
    overlay.draw(session.doc.ops.map((def) => ({ def, impl: registry.get(def.type)!, selected: def.id === session.selected, failed: def.id === failedId })), showAll)
  }
  let raf = 0
  const frame = () => {
    flushOverlay()
    overlay.scaleMarkers(camera, canvas.clientHeight)
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)

  const offChange = session.on('change', (e) => {
    preview.onChange(e)
    renderToolbar(); renderList(); renderInspector(); invalidate()
  })
  const offSelect = session.on('select', () => {
    inspector.setErrors([])
    renderList(); renderInspector(); invalidate()
  })
  const offGenerated = engine.on('generated', invalidate) // the ground under the outlines changed

  // ---- pointer
  const viewport = () => ({ width: canvas.clientWidth, height: canvas.clientHeight })
  const local = (e: { clientX: number; clientY: number }): ScreenPoint => {
    const r = canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const screenOf = (p: Vector3) => toScreen(p, camera, viewport())
  let drag: Drag | null = null
  let click: ScreenPoint | null = null

  function startDrag(e: PointerEvent, def: OpDef, handle: Handle | 'body', pos: Vector3, mode: 'xz' | 'y', at: ScreenPoint): void {
    const forward = new Vector3()
    camera.getWorldDirection(forward)
    const grab: DragPoint = mode === 'y'
      ? { x: pos.x, z: pos.z, y: pos.y - LIFT }
      : hitHorizontal(rayAt(camera, viewport(), at), pos.y) ?? { x: pos.x, z: pos.z }
    drag = { handle, start: def, grab, mode, planeY: pos.y, normal: { x: forward.x, z: forward.z }, anchor: { x: pos.x, z: pos.z }, pointerId: e.pointerId }
    session.begin(handle === 'body' ? `move ${def.id}` : `${handle.kind} ${def.id}`)
    canvas.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  function endDrag(): void {
    if (!drag) return
    if (canvas.hasPointerCapture(drag.pointerId)) canvas.releasePointerCapture(drag.pointerId)
    drag = null
  }

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    flushOverlay()
    const at = local(e)
    const def = selectedDef()
    if (def) {
      const hit = nearest(overlay.handles, (p) => screenOf(p.pos), at, HANDLE_PX)
      if (hit) {
        if (e.altKey) {
          if (hit.handle.kind === 'vertex') run('remove vertex', removeVertex(def.id, hit.handle.index))
          return
        }
        startDrag(e, def, hit.handle, hit.pos, e.shiftKey && hit.handle.y !== undefined ? 'y' : 'xz', at)
        return
      }
      let best: { d: number; pos: Vector3 } | null = null
      for (const line of overlay.outlines) {
        if (line.id !== def.id) continue
        const pts = line.points.map(screenOf)
        if (distanceToPolyline(at, pts, line.closed) > OUTLINE_PX) continue
        const near = nearest(line.points, screenOf, at, Infinity)
        if (near) { const s = screenOf(near)!; const d = Math.hypot(s.x - at.x, s.y - at.y); if (!best || d < best.d) best = { d, pos: near } }
      }
      if (best) { startDrag(e, def, 'body', best.pos, 'xz', at); return }
    }
    if (showAll) {
      let pick: { id: string; d: number } | null = null
      for (const line of overlay.outlines) {
        const d = distanceToPolyline(at, line.points.map(screenOf), line.closed)
        if (d <= OUTLINE_PX && (!pick || d < pick.d)) pick = { id: line.id, d }
      }
      if (pick) { session.select(pick.id); return }
    }
    click = at
  }

  const onMove = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return
    const ray = rayAt(camera, viewport(), local(e))
    let to: DragPoint | null
    if (drag.mode === 'y') {
      const y = hitVertical(ray, drag.anchor, drag.normal)
      to = y === null ? null : { x: drag.anchor.x, z: drag.anchor.z, y: y - LIFT }
    } else {
      to = hitHorizontal(ray, drag.planeY)
    }
    if (!to) return // the ray missed the drag plane: keep the last position
    const next = dragHandle(drag.start, registry.get(drag.start.type)!, drag.handle, drag.grab, to)
    report(session.update(replaceOp(drag.start.id, next)))
  }

  const onUp = (e: PointerEvent) => {
    if (drag && e.pointerId === drag.pointerId) {
      endDrag()
      session.commit()
      return
    }
    if (e.button === 0 && click) {
      const at = local(e)
      if (Math.hypot(at.x - click.x, at.y - click.y) < CLICK_PX) session.select(null)
      click = null
    }
  }

  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('lostpointercapture', () => { if (drag) { endDrag(); session.commit() } })

  // ---- keyboard
  const onKey = (e: KeyboardEvent) => {
    const action = actionFor(e, isTyping(document.activeElement))
    if (!action) return
    switch (action) {
      case 'save': e.preventDefault(); void save(false); break
      case 'cancel': endDrag(); session.cancel(); break
      case 'undo': e.preventDefault(); endDrag(); session.undo(); break
      case 'redo': e.preventDefault(); endDrag(); session.redo(); break
      case 'delete': if (session.selected) run(`delete ${session.selected}`, removeOp(session.selected)); break
      case 'duplicate': e.preventDefault(); duplicate(); break
      case 'toggle': { const d = selectedDef(); if (d) run(d.enabled ? 'disable' : 'enable', setEnabled(d.id, !d.enabled)); break }
    }
  }
  window.addEventListener('keydown', onKey)
  const onUnload = (e: BeforeUnloadEvent) => {
    if (!session.dirty) return
    e.preventDefault()
    e.returnValue = ''
  }
  window.addEventListener('beforeunload', onUnload)

  // ---- commands
  function add(type: string, kind: ShapeKind): void {
    const impl = registry.get(type)
    if (!impl) return
    const r = canvas.getBoundingClientRect()
    const hit = engine.pickScreen(r.left + r.width / 2, r.top + r.height / 2)
    const t = engine.controls.current.target
    const at: Vec2 = hit ? [hit.pos[0], hit.pos[2]] : [t[0], t[2]]
    const op = newOp(impl, kind, session.doc, { at, ground: ground(at[0], at[1]), height })
    if (run(`add ${op.id}`, addOp(op))) session.select(op.id)
  }

  function duplicate(): void {
    const def = selectedDef()
    if (!def) return
    const copy: OpDef = { ...def, id: nextOpId(session.doc, def.type), shape: translateShape(def.shape, DUPLICATE_OFFSET, 0) }
    if (run(`duplicate ${def.id}`, addOp(copy, session.doc.ops.indexOf(def) + 1))) session.select(copy.id)
  }

  async function open(): Promise<void> {
    if (session.dirty && !window.confirm('Discard the unsaved changes?')) return
    try {
      const f = await files.open()
      if (!f) return
      const r = parseTerrainText(f.text, { size, worldHeight: height, ops: registry })
      if (!r.ok) { inspector.setErrors(r.errors.map((err) => `${f.name}: ${err}`)); return }
      endDrag()
      session.open(r.doc)
      fileHandle = f.handle
      fileName = f.name
      renderToolbar()
    } catch (err) {
      inspector.setErrors([`open failed: ${err instanceof Error ? err.message : String(err)}`])
    }
  }

  async function save(as: boolean): Promise<void> {
    if (session.inGesture) session.commit()
    try {
      const r = await files.save(serializeTerrain(session.doc), as ? null : fileHandle, fileName)
      if (!r) return
      fileHandle = r.handle
      fileName = r.name
      session.markSaved()
      renderToolbar()
    } catch (err) {
      inspector.setErrors([`save failed: ${err instanceof Error ? err.message : String(err)}`])
    }
  }

  renderToolbar(); renderList(); renderInspector()

  return {
    session,
    preview,
    handleScreen(kind, index = 0) {
      flushOverlay()
      const p = overlay.handles.find((x) => x.handle.kind === kind && x.handle.index === index)
      const s = p ? screenOf(p.pos) : null
      if (!s) return null
      const r = canvas.getBoundingClientRect()
      return { x: r.left + s.x, y: r.top + s.y }
    },
    dispose() {
      cancelAnimationFrame(raf)
      offChange(); offSelect(); offGenerated()
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('beforeunload', onUnload)
      overlay.dispose()
      left.remove()
      right.remove()
    },
  }
}
```

Add to `packages/terrain-editor/src/index.ts`:

```ts
export { createTerrainEditor, type TerrainEditor, type TerrainEditorOptions } from './ui/editor.ts'
export type { Handle, HandleKind } from './ui/handles/geometry.ts'
```

- [ ] **Step 2: Typecheck and run the package suite**

Run: `npm run typecheck -w @elovox/terrain-editor`
Expected: no errors. If `engine.renderer.domElement` is typed as `HTMLCanvasElement`, nothing to do; if the engine's `Engine.on` has no `'generated'` key, check `EngineEvents` in `packages/engine/src/engine.ts` (it has `generated: { ms; columns }`).

Run: `npm test -w @elovox/terrain-editor`
Expected: PASS (every test from Tasks 6–15).

- [ ] **Step 3: Commit**

```bash
git add packages/terrain-editor/src/ui/editor.ts packages/terrain-editor/src/index.ts
git commit -m "feat(terrain-editor): createTerrainEditor wires session, preview, overlay and panels"
```

---

## Part E — Sandbox integration

### Task 17: The editor scene, the regeneration benchmark toggle and the e2e tests

**Files:**
- Modify: `apps/sandbox/package.json`, `apps/sandbox/vite.config.ts`
- Modify: `apps/sandbox/src/main.ts`, `src/hud.ts`, `src/controls.ts`, `src/terrainPanel.ts`
- Modify: `apps/sandbox/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: `createTerrainEditor`, `TerrainEditor` (Task 16).
- Produces: `?scene=terrain&edit` (with `&size=256` for the e2e document); `window.__elovox.editor` (`TerrainEditor | null`); `createHud(engine, getSelected, sceneName, o?: { corner?: 'top' | 'bottom'; hint?: string })`; `createControls(engine, o?: { collapsed?: boolean })`; `createTerrainPanel(engine, doc: { ops: unknown[] })`.

- [ ] **Step 1: Depend on the editor and stop Vite from reloading on save**

In `apps/sandbox/package.json`, add to `dependencies`:

```json
    "@elovox/terrain-editor": "0.1.0",
```

Run: `npm install`
Expected: the sandbox resolves `@elovox/terrain-editor` from the workspace.

`apps/sandbox/vite.config.ts`, replace the `server` line:

```ts
  // Saving a document from the editor writes src/terrain/*.terrain.json; a reload would lose the undo history.
  server: { headers: isolation, port: 5173, strictPort: true, watch: { ignored: ['**/*.terrain.json'] } },
```

- [ ] **Step 2: HUD corner and hint; collapsible controls**

`apps/sandbox/src/hud.ts`, change the signature and the style/last line:

```ts
export function createHud(engine: Engine, getSelected: () => string, sceneName: string, o: { corner?: 'top' | 'bottom'; hint?: string } = {}): () => void {
  const el = document.createElement('div')
  el.id = 'hud'
  Object.assign(el.style, {
    position: 'fixed', left: '12px', padding: '10px 12px', borderRadius: '8px',
    background: 'rgba(255, 255, 255, 0.82)', color: '#1b1f24', font: '12px/1.45 ui-monospace, Menlo, Consolas, monospace',
    whiteSpace: 'pre', pointerEvents: 'none', zIndex: '5',
  }, o.corner === 'bottom' ? { bottom: '12px' } : { top: '12px' })
```

and replace the last line of the `textContent` array with:

```ts
      o.hint ?? `block [${getSelected()}]   1–0 select · LMB dig · RMB place · WASD/edges pan · RMB-drag rotate · wheel zoom · V bean walk`,
```

`apps/sandbox/src/controls.ts`, change the signature and wrap the content in a `<details>` when collapsed:

```ts
/** Preset buttons and per-effect toggles, top right. `collapsed` starts them folded under a summary. */
export function createControls(engine: Engine, o: { collapsed?: boolean } = {}): () => void {
```

After the loop that appends the effect checkboxes, and before `document.body.append(el)`, add:

```ts
  if (o.collapsed) {
    const details = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = 'atmosphere & effects'
    summary.style.cursor = 'pointer'
    details.append(summary, ...el.childNodes)
    details.style.display = 'grid'
    details.style.gap = '6px'
    el.append(details)
  }
```

(`...el.childNodes` moves the children: spread a static copy first if the linter objects — `[...el.childNodes]`.)

- [ ] **Step 3: Make the terrain panel's regeneration a real change**

An unchanged regeneration now remeshes nothing, so the 2b button would measure nothing. It now toggles a 6-block, 128² bump at the view (a `hills` polygon), which changes every chunk column under it — the spec's 300 ms budget case.

Replace `apps/sandbox/src/terrainPanel.ts` with:

```ts
import type { Engine } from '@elovox/engine'

/** Side of the square the benchmark bump covers (the spec's regeneration budget case). */
const REGEN_SIDE = 128
/** Give up waiting for the mesh queue to drain after this long. */
const MESH_DRAIN_TIMEOUT_MS = 10_000

/**
 * Terrain scene panel, bottom right: generation times and a button that toggles a 6-block bump over
 * 128² around the view, then reports how long the regeneration took to reach the screen.
 */
export function createTerrainPanel(engine: Engine, doc: { ops: unknown[] }): () => void {
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
  button.textContent = `toggle a ${REGEN_SIDE}² bump around view`
  const last = document.createElement('div')
  last.id = 'terrain-last'
  /** Where the bump is while it is on. */
  let bump: { x0: number; z0: number } | null = null
  button.addEventListener('click', async () => {
    const [sx, , sz] = engine.layout.size
    const t = engine.controls.current.target
    const at = bump ?? {
      x0: Math.max(0, Math.min(sx - REGEN_SIDE, Math.round(t[0] - REGEN_SIDE / 2))),
      z0: Math.max(0, Math.min(sz - REGEN_SIDE, Math.round(t[2] - REGEN_SIDE / 2))),
    }
    const rect = { x0: at.x0, z0: at.z0, x1: at.x0 + REGEN_SIDE, z1: at.z0 + REGEN_SIDE }
    const op = {
      id: 'regen-benchmark-bump', type: 'hills', enabled: true,
      shape: { kind: 'polygon', points: [[rect.x0, rect.z0], [rect.x1 - 1, rect.z0], [rect.x1 - 1, rect.z1 - 1], [rect.x0, rect.z1 - 1]] },
      params: { amplitude: 0, offset: 6 },
    }
    button.disabled = true
    const start = performance.now()
    try {
      await engine.terrain.setDocument(bump ? doc : { ...doc, ops: [...doc.ops, op] })
      const r = await engine.terrain.regenerate(rect)
      bump = bump ? null : at
      // Visible = the regenerated chunks are meshed; poll the mesh queue until it drains.
      const drainStart = performance.now()
      const busy = () => engine.stats().meshQueue + engine.stats().meshInFlight > 0
      while (busy() && performance.now() - drainStart < MESH_DRAIN_TIMEOUT_MS) await new Promise((res) => requestAnimationFrame(res))
      last.textContent = busy()
        ? `regen: ${r.ms.toFixed(0)} ms in sim, mesh still queued after ${MESH_DRAIN_TIMEOUT_MS / 1000} s`
        : `regen: ${r.ms.toFixed(0)} ms in sim, ${(performance.now() - start).toFixed(0)} ms to mesh, ${r.chunks} chunks`
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

- [ ] **Step 4: Mount the editor in `main.ts`**

In `apps/sandbox/src/main.ts`:

Add the import:

```ts
import { createTerrainEditor } from '@elovox/terrain-editor'
```

After `const sceneName = …`, add:

```ts
/** `?scene=terrain&edit` opens the terrain editor on the scene's document. */
const editing = sceneName === 'terrain' && params.has('edit')
const EDIT_HINT = 'LMB select · drag handles/outline · Shift-drag height · Alt-click remove vertex · Ctrl+Z/Y · Del · Ctrl+D · H · RMB rotate'
```

Replace the terrain block and the `createControls(engine)` line:

```ts
if (sceneName === 'terrain') {
  for (const s of [engine.controls.goal, engine.controls.current]) {
    s.target[0] = size[0] / 2; s.target[1] = 50; s.target[2] = size[2] / 2
    s.distance = Math.min(400, size[0] * 0.6)
    s.pitch = 0.75
  }
  if (!editing) createTerrainPanel(engine, terrainDoc!)
}
createControls(engine, { collapsed: editing })
const editor = editing
  ? createTerrainEditor(engine, { doc: terrainDoc, fileName: n <= 256 ? 'e2e.terrain.json' : 'showcase.terrain.json' })
  : null
```

Replace the `createHud(…)` line:

```ts
createHud(engine, () => HOTBAR[selected]!, editing ? 'terrain · edit' : sceneName, editing ? { corner: 'bottom', hint: EDIT_HINT } : {})
```

At the start of both canvas listeners, skip block editing while the editor owns the left button:

```ts
canvas.addEventListener('pointermove', (e) => {
  if (editing) return
  engine.setHighlight(engine.pickScreen(e.clientX, e.clientY)?.pos ?? null)
})
canvas.addEventListener('pointerup', (e) => {
  if (editing) return
  const hit = engine.pickScreen(e.clientX, e.clientY)
```

(the rest of the `pointerup` handler is unchanged), and expose the editor:

```ts
Object.assign(window, { __elovox: { engine, bean, editor, ready: true } })
```

Run: `npm run typecheck -w @elovox/sandbox`
Expected: no errors.

- [ ] **Step 5: Update the e2e tests**

In `apps/sandbox/e2e/smoke.spec.ts`:

Extend the window type at the top:

```ts
import type { TerrainEditor } from '@elovox/terrain-editor'
```

```ts
type W = Window & { __elovox?: { engine: Engine; bean: Character; editor: TerrainEditor | null; ready: boolean } }
```

In `terrain scene generates on workers and regenerates an area`, replace `expect(r.chunks).toBeGreaterThan(0)` with:

```ts
  expect(r.chunks).toBe(0) // same document: nothing changed, so nothing is remeshed
```

Append the editor test:

```ts
test('terrain editor adds an op, drags it live, and undoes back to the original world', async ({ page }) => {
  const errors = watchErrors(page)
  await boot(page, '/?scene=terrain&size=256&edit')
  await expect(page.locator('#editor-toolbar')).toBeVisible()
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
  const opCount = await page.evaluate(() => (window as W).__elovox!.editor!.session.doc.ops.length)

  await page.selectOption('#editor-add', 'hills:circle')
  await page.waitForFunction(() => (window as W).__elovox!.editor!.session.selected === 'hills-1')
  await idle()
  const added = await heights()
  expect(added).not.toEqual(original)

  const c = await page.evaluate(() => (window as W).__elovox!.editor!.handleScreen('center'))
  expect(c).not.toBeNull()
  const centreBefore = await page.evaluate(() => (window as W).__elovox!.editor!.session.doc.ops.at(-1)!.shape)
  await page.mouse.move(c!.x, c!.y)
  await page.mouse.down()
  for (let i = 1; i <= 6; i++) await page.mouse.move(c!.x + i * 12, c!.y)
  await page.mouse.up()
  await idle()
  const centreAfter = await page.evaluate(() => (window as W).__elovox!.editor!.session.doc.ops.at(-1)!.shape)
  expect(centreAfter).not.toEqual(centreBefore)
  expect(await heights()).not.toEqual(added)

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Control+z') // the drag
  await page.keyboard.press('Control+z') // the add
  expect(await page.evaluate(() => (window as W).__elovox!.editor!.session.doc.ops.length)).toBe(opCount)
  await idle()
  expect(await heights()).toEqual(original)
  await expect(page.locator('#editor-status')).not.toContainText('error')
  expect(errors).toEqual([])
})
```

- [ ] **Step 6: Run every suite and the e2e**

Run: `npm test`
Expected: PASS in every workspace (engine, terrain, terrain-editor, sandbox — golden hashes unchanged).

Run: `npm run typecheck`
Expected: no errors in any workspace.

Run (from `apps/sandbox`): `E2E_PORT=5174 npm run e2e`
Expected: every test passes, including `terrain editor adds an op, drags it live, and undoes back to the original world`. If the drag test fails because `handleScreen('center')` is off the canvas, print `c` and the canvas size: the op is added at the canvas centre, so its centre handle must project near the middle.

- [ ] **Step 7: Commit**

```bash
git add apps/sandbox package-lock.json
git commit -m "feat(sandbox): terrain editor scene, regeneration benchmark toggle and editor e2e"
```

### Task 18: Checkpoints with the user and results

No code: the user drives the editor and measures on their laptop. Start the dev server for them and record what they report.

- [ ] **Step 1: Start the dev server**

Run (from `apps/sandbox`, in the background): `npx vite --port 5174`
Tell the user to open `http://localhost:5174/?scene=terrain&edit` (the 1024² showcase) and, for the benchmark, `http://localhost:5174/?scene=terrain` (no `edit`).

- [ ] **Step 2: Checkpoint 1 — handles and panels**

Ask the user to create, select, reshape, tune, reorder, toggle, duplicate and delete an op of every built-in type, to undo and redo, and to save over `apps/sandbox/src/terrain/showcase.terrain.json` (Save as) and reopen it. Record what they approve or want changed. Fix requested changes as follow-up commits before step 3.

- [ ] **Step 3: Checkpoint 2 — live drag and performance**

Ask the user to:
1. Add a `hills` circle (radius 48) in the showcase and drag it around: report the toolbar status numbers (`regen … ms · … chunks · … ms to mesh`) and how the drag feels. Budget: **≤ 150 ms to mesh** per update.
2. In `?scene=terrain`, click "toggle a 128² bump around view" twice: report the two `regen:` lines. Budget: **≤ 300 ms to mesh**.

If the drag misses its budget, the next step is to profile the mesher (spec §7), not to change code blindly; record the numbers and ask the user whether to continue now or leave it as a follow-up.

- [ ] **Step 4: Record the results**

Append to this plan:

```markdown
## Results

Measured by the user on their laptop (real GPU), <date>, at `?scene=terrain&edit` and `?scene=terrain`.

- Checkpoint 1 (handles and panels): <approved / changes>.
- Live drag of a hills r=48: <ms> to mesh, <chunks> chunks (budget ≤ 150 ms) — <met / missed>.
- 128² bump toggle: <ms> in sim, <ms> to mesh, <chunks> chunks (budget ≤ 300 ms) — <met / missed>.
```

```bash
git add docs/superpowers/plans/2026-10-03-terrain-editor.md
git commit -m "docs(plan): terrain editor checkpoints and performance results"
```

