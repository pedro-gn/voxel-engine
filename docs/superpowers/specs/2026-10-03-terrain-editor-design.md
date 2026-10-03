# Elovox — Sub-project 2c: Terrain Editor (pieces) — Design

Date: 2026-10-03
Status: Draft, awaiting user review
Builds on: `2026-10-02-terrain-toolkit-design.md` (sub-project 2b), whose `TerrainDoc` this editor edits

## 1. Context

Sub-project 2b delivered `@elovox/terrain`: a serializable terrain document (`TerrainDoc`)
with ordered ops (pieces), raster and brick layers, a generation pipeline, parallel
generation and partial regeneration (`engine.terrain.setDocument` and
`engine.terrain.regenerate(rect)`). It had no editing UI. The 2b spec assigned the editor
to 2c: place and tune ops, sculpt and paint layers, live preview, undo, and save.

### Decisions made in brainstorming

| Topic | Decision |
|---|---|
| Who uses it | A dev tool now (the user authors maps for the game). The design must not block turning it into a player-facing feature later |
| Scope split | **2c: pieces** (ops). **2d: brushes** (height, biome and 3D density layers) on the same foundation |
| Saving | Open and save local files with the File System Access API, writing back to the same file; download as the fallback |
| Preview | Live: the world updates **while dragging**, not only on release. The regeneration speed fix is part of 2c |
| Where shapes are edited | In the 3D view, with handles draped on the terrain |
| Panel technology | Plain DOM, like the sandbox today; the op inspector is generated from a per-op param schema |
| Code location | A new package with a headless core and a separate UI layer, mounted by the sandbox |

### What 2b left that 2c inherits

- **Regeneration misses its budget.** Regenerating 128² takes 92 ms in the sim but 713 ms
  until the mesh queue drains, because 217 chunks are remeshed where the area holds 64.
  `Simulation.replaceColumns` rewrites every chunk of every column, including unchanged
  ones, and marks the full 3 × 3 ring of chunk columns at every height.
- **Ops ignore fields silently.** Only `hills`, `flatten` and `biome` read
  `shape.falloff`; the other nine ignore it. Unknown `params` keys are accepted.
  An editor that shows a falloff handle that does nothing would mislead.

### Assumptions

- The showcase has no raster or brick layers, so the whole document is small (22 ops).
  `setDocument` with the full document is cheap in 2c. An incremental update path for
  rasters belongs to 2d, where brushes create them.
- One editor, one user, one browser tab. No collaboration.
- The world's size is fixed at boot. Opening a document of another size is an error.

## 2. Scope and success criteria

### In scope

1. A new package `@elovox/terrain-editor` with `core/` (headless) and `ui/` (DOM and three.js).
2. `@elovox/terrain`: a param schema per op type, schema-driven validation, `paramsOf`,
   and `opBounds`.
3. Engine: regeneration writes and remeshes only the chunks that changed.
4. Sandbox: the editor scene `?scene=terrain&edit`.

### Out of scope

- Brushes and layer editing (2d).
- Editing `biomes`, `biomeRule` and `blocks` (tables of rules; edited by hand in the JSON).
- Multi-selection, changing an op's shape kind after creation, collaboration.
- A heightfield proxy preview for very large ops (a follow-up if live drag of large ops feels slow).

### Success criteria

1. Every built-in op type can be created, selected, reshaped, tuned, reordered, toggled,
   duplicated and deleted from the editor. The user approves this at checkpoint 1 (§11).
2. Dragging a `hills` op of radius 48 in the showcase updates the world live:
   **≤ 150 ms** from request to visible mesh per update, on the user's laptop.
3. The 2b case, regenerating 128² around the view, takes **≤ 300 ms** request to visible mesh.
4. Undo and redo restore the world exactly: the voxels after undo equal those before the edit.
5. Saving and reopening a document gives the same world.
6. Every existing test still passes, and the golden column hashes of the showcase do not change.

## 3. Architecture

### Package layout

```
packages/terrain-editor/src/
  core/                 pure: no DOM, no three.js; tested in Node
    state.ts            EditorState: doc (an immutable TerrainDoc), selection, version, saved version
    commands.ts         edit commands (§4)
    history.ts          undo / redo; one gesture = one step
    dirty.ts            the area a command dirties
    preview.ts          the preview scheduler (§6)
  ui/                   DOM and three.js
    editor.ts           createTerrainEditor(engine, options) → { open(doc, handle?), dispose() }
    panels/             toolbar, op list, schema-driven inspector
    handles/            3D handles per shape kind; drag planes; picking
    io.ts               open and save (File System Access, fallback)
  index.ts
```

- `core` depends only on `@elovox/terrain` (types, validation, schemas, `opBounds`).
- `ui` depends on `core`, the `Engine` interface and three.js.
- The engine stays unaware of the editor. Its only change is the regeneration fix (§7).

### Data flow

```
gesture ──▶ command ──▶ EditorState (new doc, version + 1) ──▶ history
                                        │
                                        └──▶ preview: accumulate dirty rect ──▶ setDocument(doc) + regenerate(rect)
```

The document is immutable. Each command returns a new `TerrainDoc` that shares every
unchanged part with the old one. History stores `{ label, before, after }` pairs of documents.

### Sandbox integration

- `?scene=terrain&edit` mounts the editor over the showcase (`&size=256` uses the e2e document).
- In that scene, the block break and place clicks are off, and the 2b terrain panel is
  replaced by the editor's toolbar status.
- The sandbox effects and atmosphere controls stay available but start collapsed.
- `vite.config.ts` excludes `**/*.terrain.json` from the dev server's watcher. Otherwise
  saving over the imported showcase file would reload the page and lose the undo history.
  After a hand edit of the JSON, reload the page manually.

## 4. Editing model

### Invariant

`EditorState.doc` is always valid. A command builds the candidate document and runs
`validateTerrainDoc`. If it is invalid, the command is refused, the state does not
change, and the inspector shows each error next to its field (`ops[3].params.height:
must be ≥ 0`). The world never receives an invalid document.

### Selection

At most one op is selected, by `id`. Clicking a row in the op list or an op's outline
or handle in the 3D view selects it. Clicking the terrain away from any handle clears
the selection.

### Commands

| Command | Gesture |
|---|---|
| `addOp(type, kind)` | The "+" menu, by type, with a kind submenu when the type accepts several shapes. The op is created on the terrain under the screen centre with the schema's default params and a default shape: a circle of radius 48, a 2-point path 96 blocks long, or a 96-block square polygon. Volume paths get `y` = ground height + 8 per point. The id is `${type}-${n}`, unique in the document |
| `duplicateOp(id)` | Ctrl+D. The copy is offset by 16 blocks in x and inserted after the original |
| `removeOp(id)` | Delete |
| `setEnabled(id, on)` | The row's checkbox; H toggles the selected op |
| `reorderOp(id, delta)` | ↑ and ↓ in the row. Order matters: height ops blend in document order |
| `setParam(id, key, value)` | Inspector fields |
| `setBlend(id, mode)` | Inspector (height ops) |
| `setShape(id, shape)` | Handles and inspector: centre, radius, width, falloff, inset |
| `moveVertex`, `insertVertex`, `removeVertex` | Path and polygon handles; the vertex table in the inspector |
| `setDocField('seaLevel' \| 'base', value)` | The inspector when nothing is selected |

### Gestures and undo

- A drag or a slider is **one** history step. `begin()` snapshots the document, each
  `update(doc)` feeds the preview, and `commit()` records `{ label, before, after }`.
- Esc during a gesture cancels it and returns to `before`.
- Ctrl+Z undoes and Ctrl+Shift+Z (or Ctrl+Y) redoes. Both swap the document and dirty the
  same area as the original step.
- The history keeps the last 200 steps.

### Dirty area

- An op edit dirties `opBounds(before) ∪ opBounds(after)`, rounded out to chunk columns.
  Adding or removing dirties the op's bounds. Reorder, enable and blend changes dirty
  the op's own bounds.
- `seaLevel` and `base` dirty the whole world. They regenerate only when the gesture
  commits, never live (a full regeneration takes about 1.6 s).

### Unsaved changes

The toolbar shows a marker while the current version differs from the saved one, and
`beforeunload` asks for confirmation.

## 5. Handles and panels

### Handles (three.js objects in `engine.scene`)

- **Draped outlines.** A shape is sampled every ~2 blocks, and each sample's `y` is the
  top solid voxel of its column, read from `engine.world`. The selected op's outlines are
  re-draped after each regeneration completes. They draw with `depthTest: false` and
  reduced opacity, so they stay visible behind hills.
- **Drag planes.** A handle drags on a horizontal plane at the handle's height when the
  gesture began, not on the terrain. Otherwise, dragging a mountain raises the ground
  under the cursor and the handle jumps.
- **By kind:**
  - `circle`: a centre handle (move), a rim handle (radius), and a dashed falloff ring
    with its own handle.
  - `path`: one handle per vertex, a "+" handle at each segment midpoint (insert), and
    Alt+click to remove a vertex (at least 2 remain). A handle perpendicular to the first
    vertex sets the global width.
  - `polygon`: vertices, midpoint "+" handles, and Alt+click to remove (at least 3 remain).
    The `inset` shows as a dashed inner line.
- **Falloff** handles and rings appear only for op types whose schema says they use
  `falloff` (§8).
- **Heights.** Volume path points carry `y`, and `blob` has `params.y`. A vertical stem
  shows each `y`. Shift+drag moves a point in `y`, on a vertical plane facing the camera.
- **Per-vertex values** (`width` and `y`) are also editable in a table in the inspector.
- **Other ops.** With "show all" on, every unselected op shows a thin faded outline.
  Clicking it selects the op.

### Camera conflict

The editor listens for `pointerdown` on `window` in the capture phase. When the ray hits a
handle, the editor consumes the event, so the orbit camera never sees it. No engine
change is needed.

### Panels (plain DOM)

- **Toolbar (top left):** Open, Save, Save as, Undo, Redo, the unsaved marker, the preview
  status (`regen 84 ms · 12 chunks`, "updating…", or the last error), and "show all".
- **Op list (left):** the ops in document order. Each row shows the type, the id, an
  enabled checkbox, and ↑ ↓ buttons. A row whose op failed during generation is marked.
  The "+" menu sits at the top of the list.
- **Inspector (right):** generated from the selected op's schema.
  - `number`: a slider plus a numeric box, with min, max and step from the schema.
  - `enum`: a select (profiles and volume modes are enums).
  - `bool`: a checkbox.
  - `noise`: a collapsible group (type, scale, octaves and the rest of `NoiseDef`).
  - `biome`: a select of `doc.biomes` names.
  - Then the blend mode, the shape fields (radius, width, falloff, inset), and the
    vertex table.
  - Dragging a slider is a gesture: one undo step, live preview.
  - With nothing selected, the inspector shows `seaLevel` and `base`.

## 6. Live preview

### Scheduler (`core/preview.ts`)

- It holds `pendingRect` (an accumulated union) and `latestDoc`.
- Loop: when nothing is in flight and something is pending, it takes `(doc, rect)` and
  clears the pending state. If the document changed since the last send, it calls
  `setDocument(doc)`. Then it calls `regenerate(rect)` and loops.
- **Back-pressure sets the rate.** At 100 ms per regeneration there are about 10 updates
  per second; at 400 ms, fewer. Updates always use the latest document, and no
  intermediate state is queued.
- **The union is required.** If an op crosses 200 blocks during one regeneration, every
  area it passed over must be restored.
- The next regeneration starts as soon as `regenerate` resolves, without waiting for
  meshing. `MeshQueue` already deduplicates by chunk and meshes nearest-first, so
  re-marked chunks do not pile up.
- The status reports request to empty mesh queue, like the 2b panel.
- The scheduler takes an interface with `setDocument` and `regenerate`, so tests use a
  fake engine with controllable promises.

### Errors

| Situation | Behaviour |
|---|---|
| `regenerate` rejects (an op throws during generation) | The area stays untouched (the 2b behaviour). The status shows the error and the op's `id`, and the op's row is marked. The document stays editable, and the next edit retries |
| `setDocument` rejects | Should not happen, since the document is already valid. The preview pauses and the status shows the message |
| A generation worker dies | Fatal, as in 2b |

## 7. Engine: regenerate only what changed

`Simulation.replaceColumns` changes as follows:

1. For each chunk of a new column, compare the new voxels with the chunk's current
   contents. If they are identical, skip the write and do not mark the chunk.
2. For each changed chunk, find which of its six border slabs (one voxel thick) changed.
   Mark the neighbour at offset `d` (face, edge or corner) **only if every slab along
   `d`'s non-zero axes changed**. This is a correct superset: a changed edge voxel lies in
   both slabs, so the AO of the diagonal neighbours stays right.
3. `relightRegion` stays as it is. It already opens (and so remeshes) only chunks whose
   light actually changes.

If this does not bring the drag case to ≤ 150 ms, the next step is to profile the mesher,
as the 2b note says, before changing anything else.

## 8. Param schemas in `@elovox/terrain`

```ts
type ParamSpec =
  | { type: 'number'; default: number; min?: number; max?: number | ((ctx: ValidateContext) => number); gt?: number; int?: boolean; step?: number }
  | { type: 'enum'; values: readonly string[]; default: string }
  | { type: 'noise'; default: NoiseDef }
  | { type: 'bool'; default: boolean }
  | { type: 'biome' }   // required; a name from doc.biomes

interface OpImplBase {
  // ...existing fields
  readonly params: Readonly<Record<string, ParamSpec>>
  /** True if the op reads shape.falloff. */
  readonly falloff: boolean
}
```

- **Schema-driven validation.** A generic checker walks the schema. An unknown param key
  is an error, and so is `shape.falloff > 0` on an op whose `falloff` is false. Both fix
  the 2b follow-up. An op's own `validate` keeps only cross-field rules (for example,
  `plateau` requires `top > base`).
- **Range bounds that depend on the world** (a `y` up to the world height) give `max` as a
  function of `ValidateContext`, e.g. `max: (ctx) => ctx.height - 1`. Schemas are code,
  not data, so a function is fine; the inspector resolves it with the open world's height.
- **`paramsOf(def)`** returns the params with every schema default filled in. Each op's
  `compile` reads its values through it, so defaults live in one place.
- **The refactor must not change output.** The golden hashes of the showcase columns
  prove that the twelve ops still generate the same terrain.
- **`opBounds(def, ctx)`** compiles the op and returns its bounds (the xz part of a
  volume op's box). Bounds therefore come from the same code that generates.
- Params whose shape the schema above does not cover are found and handled case by case
  in the plan.

## 9. Open and save (`ui/io.ts`)

- **Open:** `showOpenFilePicker` with a `*.terrain.json` filter, parse, validate.
  - Invalid: show the error list and do not load.
  - `size` differs from the world: an error that names both sizes and suggests
    reloading with `?size=`.
  - Valid: `setDocument`, regenerate the whole world with a progress status, and clear
    the history.
- **Save:** write to the open file handle (`createWritable`). Without a handle (the
  showcase bundled with the scene), Save acts as Save as (`showSaveFilePicker`).
- **Format:** the normalized document (every default filled in) as JSON with two-space
  indentation. The showcase file gets a larger diff the first time it is saved and is
  stable after that.
- **Fallback** when the browser lacks the API: open with `<input type=file>`, save by download.

## 10. Testing

| Area | Tests |
|---|---|
| `core` commands | Each command on valid and invalid input; refused commands leave the state unchanged |
| `core` history | A gesture is one step; Esc cancels; undo and redo swap documents and dirty areas; the 200-step limit |
| `core` dirty | Union of before and after bounds, rounded to chunk columns; whole world for `seaLevel` and `base` |
| `core` preview | With a fake engine: coalescing, one request in flight, the latest document wins, union of pending areas, error handling |
| `terrain` schema | Unknown param, falloff on an op that ignores it, ranges; existing validation tests still pass |
| `terrain` output | Golden column hashes unchanged; `opBounds` equals the compiled bounds |
| `engine` regeneration | An identical chunk is neither written nor marked; neighbours are marked by changed slabs; world and light after regeneration equal a full generation (the 2b test) |
| `ui/io` | Open and save with fake file handles; invalid and wrong-size documents |
| E2E | `?scene=terrain&size=256&edit` boots with a clean console; add a `hills` op from the UI, drag its centre, the regeneration completes, Ctrl+Z restores the sampled voxels |

## 11. Checkpoints with the user

1. **Handles and panels:** on the showcase, every op type can be created and edited.
2. **Live drag:** how dragging feels, plus the performance numbers of §2 measured on the
   user's laptop.

## 12. Follow-ups this spec does not address

- A heightfield proxy preview while dragging very large ops.
- An incremental document update (op patches and raster deltas) instead of `setDocument`
  with the full document. 2d needs it for brushes.
- Editing biomes, biome rules and block names.
