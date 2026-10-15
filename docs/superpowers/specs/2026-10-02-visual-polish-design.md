# Elovox — Sub-project 2a: Visual Polish — Design

Date: 2026-10-02
Status: Approved; implemented on feat/visual-polish
Builds on: `2026-10-01-voxel-core-design.md` (sub-project 1, merged on `main`)

## 1. Context

Sub-project 2 of the original decomposition ("Terrain & visual polish") is split in two:

- **2a — Visual polish (this spec):** lighting, shadows, sky, fog, post-processing,
  water shader, grass/flower decorations, painted textures, and the visual fixes left
  over from sub-project 1.
- **2b — Terrain toolkit (own spec, later):** noise library (3D density for arches and
  caves, domain warp, ridged noise), relief composition, voxel tree/rock placement, and
  a showcase map mixing several reliefs. The toolkit must make any relief possible.

2a comes first. The look is where the risk is (shadow and grass cost on a laptop), and
a small hand-built diorama is enough to tune it.

### Visual target

The user supplied six reference images. The style is **stylized, like the references,
but in voxels**:

- **Primary reference (voxel diorama):** textured cubes with hand-painted tiles:
  blue-grey irregular stone bricks, dark red-brown dirt, sand in stacked rounded plates.
  Dense 3D grass tufts **hang over block edges**, small flowers are scattered, and the
  turquoise water has rippled streaks and a **white foam line along the shore**. Shadows
  are soft and AO is light. The background is a neutral light grey.
- **Mood references (stylized open world):** a saturated blue gradient sky with painted
  clouds and a warm sun. Atmospheric fog turns the distance blue. There is tall grass
  swaying in the wind, flower patches, trees with clumped canopies and large grey rocks.
  Shadows are bluish, not black. One image is a pink sunset, so the sky and light
  palette must be configurable.
- **Texture technique reference:** hand-painted texturing with baked light, edge
  highlights and darkened cavities.

### Decisions made in brainstorming

| Topic | Decision |
|---|---|
| Textures | Improved procedural painter in the sandbox (content, not engine); 64 × 64 tiles |
| Grass/flowers | Per-voxel instanced tufts extracted by the mesh worker, wind in the vertex shader |
| Beyond the world edge | Both, as presets: `diorama` (cut-out model, neutral backdrop) and `open` (sky + fog) |
| Time of day | Static, preset-driven lighting with smooth transitions; the API is ready for a day/night cycle later |
| Lighting architecture | three.js lighting (lit node material + `DirectionalLight` shadows) so game meshes share sun, shadows and fog |

### Assumptions

- Trees and rocks are **voxels** (log + cutout leaves, stone blocks), not 3D meshes.
- Water flow and levels stay in sub-project 3. This spec covers only how water looks.
- Characters and props are game content; the engine only has to light and shadow them.

## 2. Scope and success criteria

### In scope

1. **Atmosphere:** preset model, interpolation and three built-in presets (`diorama`,
   `open`, `sunset`).
2. **Lighting and shadows:** lit chunk materials, a sun `DirectionalLight` with one
   view-fitted shadow map, and a `HemisphereLight`.
3. **Sky:** a gradient dome with procedural painted clouds, or a flat gradient backdrop.
4. **Fog and post-processing:** height/distance fog, colour grading and tone mapping.
5. **Water:** ripples, shore foam, depth colour and sun specular.
6. **Decorations:** instanced grass tufts and flowers with wind, distance fade and edge
   overhang.
7. **Textures:** a hand-painted-style procedural painter and the sub-project 1 visual
   fixes.
8. **Test scenes:** a hand-built diorama and the existing 1024² world, with HUD preset
   buttons and per-effect toggles.

### Out of scope

- The terrain toolkit (2b).
- The day/night cycle (only the API is prepared).
- Water dynamics and per-liquid styles such as lava (3).
- Shadow cascades and first person (4).
- Bloom, SSAO, outlines and refraction. Any of these can be added later if a visual
  review asks for them.

### Success criteria

- The sandbox diorama reads like the primary reference: painted textures, grass hanging
  over edges, flowers, water with shore foam, and soft sun shadows. The user approves it
  at the visual checkpoints (§11).
- 60 fps at the 3/4 view in the 1024² world with every effect on, within the budgets of
  §9.
- WebGPU and WebGL2 give an equivalent image with a clean console.
- All sub-project 1 tests still pass, and a local edit still shows within 2 frames,
  decorations included.

### New engine modules

```
packages/engine/src/render/
  atmosphere.ts      preset model, validation, interpolation (pure, Node-tested)
  lighting.ts        sun + hemisphere lights, shadow-camera fitting (fitting is pure)
  voxelLighting.ts   VoxelLightingModel (TSL)
  sky.ts             scene.backgroundNode + scene.fogNode
  post.ts            RenderPipeline: grading + tone mapping
  water.ts           liquid-layer material
  decorations/
    extract.ts       instance extraction (pure, runs in the mesh worker)
    meshes.ts        tuft and flower geometry
    material.ts      decoration material (wind, colour, fade)
    decorationMeshes.ts   per-chunk instanced draws (main thread)
```

`materials.ts` moves to the lit material and the custom lighting model.

## 3. Atmosphere

### API

```ts
engine.atmosphere.set('sunset', { duration: 2 })    // preset by name, 2 s transition
engine.atmosphere.set({ fog: { far: 300 } })         // partial override, immediate
engine.atmosphere.current                            // resolved values (read-only)
engine.atmosphere.define('night', { ... })           // game-defined preset
```

- `set` with a name starts a transition from the **current resolved values** to the
  preset. A new `set` during a transition starts from wherever the transition is.
- A partial object is merged over the current target. With no `duration` it applies
  immediately.
- `define` registers a full preset. A partial definition is merged over `open`.
- The atmosphere advances once per rendered frame using the frame's `dt`.

### Model

```ts
interface Atmosphere {
  sun:     { azimuth: number; elevation: number; color: Color; intensity: number }  // degrees
  ambient: { sky: Color; ground: Color; intensity: number }
  sky: {
    dome: number                    // 0 = flat backdrop gradient, 1 = full sky dome
    zenith: Color; horizon: Color
    sunGlow: number                 // halo strength around the sun direction
    clouds: { coverage: number; scale: number; speed: number; light: Color; shade: Color }
  }
  fog:     { color: Color; followHorizon: number; near: number; far: number; heightFalloff: number }
  shadow:  { strength: number; tint: Color }
  grade:   { exposure: number; saturation: number; contrast: number; highlights: Color; shadows: Color }
}
```

- The sun is given as **angles, not a vector**. A future day/night cycle only has to
  animate `elevation` (and `azimuth`).
- **Every field is a number or a colour**, so interpolation is total and nothing jumps in
  the middle of a transition. `fog.followHorizon` (0–1) blends between `fog.color` and
  the sky horizon colour instead of being a boolean.
- Interpolation runs colours in linear space, numbers by lerp, and `azimuth` along the
  shortest arc. The transition uses smoothstep easing.
- **Validation:** an unknown preset name throws. A non-finite number rejects the whole
  `set` call and keeps the current state. Numbers with a natural range (`dome`,
  `coverage`, `followHorizon`, `strength`) are clamped to 0–1, and `elevation` to
  −90…90.

### Built-in presets

| Preset | Character |
|---|---|
| `diorama` | `dome` 0 with a light blue-grey backdrop, minimal fog, sun high from the side, soft bluish shadows; the world edge is meant to be seen |
| `open` | full dome, saturated blue zenith, pale horizon, clouds at medium coverage, fog that turns the distance blue, warm noon sun |
| `sunset` | low warm sun, pink/orange horizon and fog, long shadows; proves the palette is configurable |

Exact values are tuned at the visual checkpoints and live in `atmosphere.ts`.

## 4. Lighting and shadows

### Lights

- `lighting.ts` owns a `DirectionalLight` (the sun) and a `HemisphereLight` (ambient),
  both added to `engine.scene` and driven from `atmosphere.current` every frame.
- Game meshes using ordinary three.js lit materials get the same sun, ambient, shadows
  and fog without any engine-specific code.

### Chunk materials

The chunk materials move from `MeshBasicNodeMaterial` with hand-computed light to a lit
node material that uses a custom **`VoxelLightingModel`** in TSL. The packed vertex
format is unchanged.

- **Direct (sun):** Lambert with a light wrap for a soft, stylized terminator, times the
  shadow-map term, times a **sky-light gate** (a smooth curve of `skyLight / 15`). Caves
  outside the shadow map's range therefore stay dark.
- **Indirect:** hemisphere colour (by normal) × sky-light curve × voxel AO curve.
- **Block light:** a warm emissive term, `albedo × blockLightCurve × torchColor`.
- **Shadow colour:** the shadowed part of the direct term is replaced by
  `atmosphere.shadow.tint` scaled by `shadow.strength`, rather than going to black. This
  gives the bluish shadows of the references.

### Shadow map

- One shadow map, 2048² by default (`quality.shadowMapSize`, so a game can use 4096²).
- An orthographic shadow camera is refitted every frame to the visible area at the 3/4
  view. The fit is the light-space bounding box of the camera frustum, clipped to the
  world's y range and to a maximum shadow distance.
- **Texel snapping:** the shadow camera's light-space origin is snapped to whole shadow
  texels, so shadows don't shimmer while the camera pans. This also holds for a moving
  sun later. The fitting and snapping are pure functions in `lighting.ts`.
- Soft PCF filtering.
- **Casters:** opaque and cutout chunk meshes, plus game meshes with `castShadow`.
  **Receivers:** chunks, decorations, water and game meshes. Decorations do not cast
  shadows (budget).
- Chunk meshes still opt out of three.js raycasting (sub-project 1 ruling C12). The
  shadow pass doesn't depend on that.

### Spike (plan Task 1)

Before anything else is built on it, verify on **both WebGPU and WebGL2**:

1. The shadow depth pass uses the material's `positionNode` with the aliased packed
   `uvec2` attribute, so shadows line up with the terrain.
2. A custom `LightingModel` with these terms compiles and renders on both backends.
3. `viewportDepthTexture` can be read from a transparent material (needed by water, §6).

If (1) or (2) fails, fall back to the "own lighting" approach: keep `MeshBasicNodeMaterial`
and add an engine-owned sun depth pass sampled in TSL. That fallback would require
re-approval, because game meshes would then not share shadows. If (3) fails on WebGL2,
water on that backend loses foam and depth colour (§10) and nothing else changes.

## 5. Sky, fog and post-processing

### Sky (`sky.ts`)

- Built as `scene.backgroundNode` in TSL. It needs no geometry, works on both backends
  and is always behind everything.
- **Gradient:** horizon to zenith by view direction, plus a sun disc and halo
  (`sunGlow`) in the sun's direction.
- **Clouds:** a 2D fBm field on a plane at a fixed altitude, hit by the view ray. They use
  stylized two-tone shading (`clouds.light` / `clouds.shade`) with soft edges, drift
  slowly with time and fade out near the horizon.
- With `dome` < 1 the result blends towards a vertical **screen-space** gradient.
  `diorama` (`dome` 0) is just that gradient: neutral, with no sun disc or clouds.

### Fog

- Built as `scene.fogNode`, so it is applied **inside every material**: chunks,
  decorations, transparent water and game meshes. A post-process fog would take the
  depth behind transparent water and fog the water wrongly.
- **Formula:** an exponential distance term between `near` and `far`, times a height
  falloff (`heightFalloff`): valleys get hazier and peaks stay clear.
- **Colour:** a mix of `fog.color` and the sky horizon colour (`followHorizon`), warmed
  towards the sun colour in the sun's direction (aerial perspective).

### Post-processing (`post.ts`)

- A three.js `RenderPipeline`: a scene pass with MSAA (`quality.msaa`), then grading,
  then tone mapping.
- **Grading** in TSL: exposure, saturation, contrast, and highlight/shadow tints.
- **Tone mapping:** AgX or Neutral. The pick is made at the first visual checkpoint,
  choosing whichever keeps greens vivid without clipping, and recorded in the plan.
- Water reads opaque depth through `viewportDepthTexture` inside its own material, so
  the pipeline needs no MRT.

## 6. Water

### Liquid render layer

- Liquids get their own render layer, `liquid`. Until now they shared `translucent` with
  glass. The registry's default layer for `liquid: true` becomes `liquid`, and the
  `translucent` layer keeps glass and other blended blocks.
- A chunk now has at most **4 meshes** (opaque, cutout, translucent, liquid).
- Liquid meshing is unchanged: top faces lowered by level, corner heights averaged,
  side faces filling height gaps. The packed vertex format is unchanged.
- Liquid chunk meshes are sorted back to front like translucent ones and drawn after
  them.

### Material (`water.ts`)

- **Ripples:** two layers of procedural TSL noise scroll in different directions over
  world xz and perturb the normal. This gives the streaky ripple pattern of the primary
  reference with no texture asset.
- **Depth colour:** compares the opaque depth (`viewportDepthTexture`) with the
  fragment depth. Shallow water is turquoise and more transparent; deep water is blue
  and more opaque.
- **Foam:** where that depth difference is small (shore, rocks, characters' legs) there
  is a white band with a noise-broken edge and a slight animation. It works against any
  object, not just voxels.
- **Light:** sun specular (direction and colour from the atmosphere), a fresnel term
  towards the sky horizon colour, received shadows and fog.
- **Side faces** (falls, the diorama's cut edge): the same material, with ripples
  scrolling downwards to read as flowing water.
- **No refraction** in 2a.

### Parameters

`engine.water = { shallow, deep, depthScale, foamWidth, waveScale, waveSpeed }` applies to
every `liquid` block. Per-liquid styles come with sub-project 3.

## 7. Decorations

### Definition

Decorations are plain data, defined like blocks and passed to `createEngine`:

```ts
defineDecoration({
  name: 'meadow',
  grass:   { blades: 20, height: [0.25, 0.55], base: '#4f8a2e', tip: '#a9d65a', overhang: 0.2 },
  flowers: { chance: 0.06, patchScale: 12, colors: ['#e94b4b', '#f5d142', '#ffffff', '#f08ac0', '#6f8cf0'] },
})
defineBlock({ name: 'grass', /* ... */, decoration: 'meadow' })
```

- A block's `decoration` (the sub-project 1 hint) names one definition. A name with no
  definition is a registry error at engine creation.
- `grass` and `flowers` are both optional, so a game can define, for example, short
  diorama grass or the tall grass of the mood references.

### Extraction (mesh worker, same job as the geometry)

`decorations/extract.ts` runs inside the mesh job on the same seqlock snapshot and the
same ghost overrides as the mesher. For every voxel whose block has a decoration and
whose voxel above is air, it emits **one instance packed in 8 bytes**:

```
u32 #1: lx (5b) | ly (5b) | lz (5b) | edge mask (4b) | sky light (4b) | block light (4b) | reserved (5b)
u32 #2: decoration id (8b) | reserved (24b)
```

- **Edge mask:** one bit per horizontal neighbour (±x, ±z) whose voxel at the same
  height is not opaque, so this voxel has an exposed side face there (a drop, a hole or
  a water edge). Blades near those edges lean outwards and hang over.
  Neighbours across chunk borders come from the 1-voxel border the job already reads.
- The per-instance random seed is a hash of the world position, computed in the shader,
  so it takes no space.
- The result carries the instance buffer as a transferable. A chunk's decorations
  therefore change in **the same frame as its geometry**: digging removes a tuft and
  placing grass grows one, ghosts included.

### Drawing (`decorationMeshes.ts`, `material.ts`)

- One instanced draw per chunk per kind (grass, flowers), only for chunks within the
  decoration radius.
- **Tuft:** about 20 tapered blades of 2–3 triangles, as opaque double-sided geometry
  with no alpha, scattered over the voxel top. Blades near exposed edges lean out past
  the edge by up to `overhang`.
- **Wind:** a world-space noise displacement with gusts, weighted by blade height².
- **Colour:** base-to-tip gradient, a normal bent upwards (soft stylized grass shading),
  received shadow, sky light and fog.
- **Flowers:** a stem plus crossed petal quads. The colour is picked from the palette by
  hash, and placement is clustered into **patches** by low-frequency noise
  (`patchScale`), with `chance` as the density inside a patch.
- **Distance:** density drops with distance and blades **shrink to zero** as they reach
  the radius (default 96 blocks, `quality.decorationRadius`), so nothing pops. Beyond
  it, the painted top tile carries the look.
- A configurable ceiling caps the number of visible instances. The HUD shows decoration
  instances and draws.
- Decorations don't collide and raycasts ignore them.

**Soft grass (2026-10-15, for the colony's art kit).** Optional `grass` fields for fuller,
softer tufts; each default keeps the look above exactly:

| Field | Default | Range | Effect |
|---|---|---|---|
| `width` | 1 | (0, 4] | Blade width multiplier (roots 0.05–0.09 wide at 1). |
| `jitter` | 0.3 | [0, 1] | Brightness variation between tufts (× 1 − j/2 … 1 + j/2). |
| `blunt` | 0 | [0, 1] | 0 pointed; 1 the mid section widens × 1.5 and rises 0.15: rounder blades. |
| `rootShade` | 0.45 | [0, 1] | Occlusion at the root (× 1 − rootShade, fading to 1 at the tip). Lower it so tufts melt into the top tile. |
| `clump` | 1 | [0, 1] | How much the low-frequency patch noise thins (to 30 % of the blades) and shortens tufts; 0 keeps every tuft full and even. |
| `turn` | 0 | [0, 1] | A random rotation per tuft about its cell centre (fraction of a full turn), drawn in to stay in the cell; breaks the grain that dense, even grass shows from afar (the default keeps the 8 mirrored layouts). |
| `coverage` | none | `{ scale > 0, threshold ∈ [0, 1], soft ∈ (0, 0.5] }`, defaults 24, 0.35, 0.1 | Bare patches: a world-space noise (one cell every `scale` blocks) below `threshold` leaves a top without grass; across ± `soft` the tufts thin and shorten. |

The shader reads them from three uniform arrays beside `params`: `shape` (width, jitter,
blunt, rootShade), `cover` (1 / scale, threshold, soft, clump) and `extra` (turn); `grassStyle()` in `defs.ts`
packs them. Flowers are not affected by `coverage`.

## 8. Textures and sub-project 1 visual fixes

### Procedural painter (`apps/sandbox/src/paint/`)

It is sandbox content, not engine code.

- It draws on a raw RGBA `Uint8ClampedArray` instead of a canvas, so it is testable in
  Node. The sandbox converts the result to a PNG data URL.
- Tiles are 64 × 64 and **seamless**: every shape is drawn with wrap-around, because
  greedy quads repeat a tile across merged faces.
- Layers, after the texture technique reference:
  1. base colour with 2–3 low-frequency tone variations;
  2. the material pattern;
  3. darkened cavities between shapes;
  4. an edge highlight on the lit side of each shape;
  5. light baked lighting (the top of each shape slightly brighter);
  6. a small hue jitter.
- Materials, after the primary reference:

| Tile | Look |
|---|---|
| `stone` | irregular blue-grey stone bricks |
| `dirt` | dark red-brown with pebbles |
| `grass_top` | bright green with painted leaf strokes |
| `grass_side` | dirt with an irregular dripping green fringe |
| `sand` | warm tan rounded stacked plates |
| `log_side` / `log_top` | bark strokes / rings |
| `planks` | boards with grain |
| `leaves` | cutout clumps with lighter edges |
| `rock` | large smooth grey boulder surface |
| `glass`, `torch`, `water` | functional, lightly painted |

A `rock` block is added to the sandbox block list.

### Fixes

- **Mirrored UVs on +X and −Z faces:** negate `u` on those faces, in the shader's UV
  projection. Asymmetric tiles then read the right way round.
- **Dark mip fringes on cutout tiles:** when a tile is loaded, the colour of opaque
  texels bleeds into neighbouring transparent texels (dilation) before upload, so
  averaged mip levels stop pulling in black. This is a pure function in
  `textureArray.ts`'s loading path.
- **Carry-forward C11:** confirm on both backends that `DataArrayTexture` mipmaps and
  anisotropy take effect, at the first visual checkpoint.

### Test scenes (sandbox)

- **`?scene=diorama`:** a hand-written generator for a 128 × 64 × 128 world, inspired by
  the primary reference. It has two terraces with a lake on the upper one (sand and
  stone banks), an arch, a lower meadow with a pond, stone-brick cliffs, sand mounds, a
  few voxel trees and rocks. It uses the `diorama` preset.
- **`?scene=world`** (default): the existing 1024² test world with the `open` preset,
  for performance.
- Each scene has its own sim worker entry, because the generator runs in the sim
  worker.
- **HUD:** preset buttons (`diorama`, `open`, `sunset`) and toggles per effect (shadows,
  decorations, water material, post, fog), to measure the cost of each.

## 9. Performance

### Budgets

At the 3/4 view in the 1024² world, with every effect on:

| Item | Target |
|---|---|
| Whole frame | ≤ 16.7 ms (60 fps) on a mid-range laptop |
| Shadow pass | ≤ 2.5 ms GPU |
| Decorations | ≤ 3 ms GPU |
| Water | ≤ 1 ms GPU |
| Sky + grading | ≤ 1.5 ms GPU |
| Mesh job including decoration extraction | still < 3 ms; the `bench:node` gate measures both |

- The HUD shows GPU time when WebGPU exposes `timestamp-query` (three.js supports it).
  Otherwise each effect's cost is measured by toggling it.
- As in sub-project 1, measurements run on the user's desktop, and the report says it
  is not a mid-range laptop.

### Quality

`engine.quality = { shadowMapSize, decorationRadius, decorationMaxInstances, msaa }`
lets a game lower the cost on a weak machine without touching presets. Changes apply
on the next frame. A shadow map size change recreates the shadow map.

### HUD stats

`EngineStats` gains `decorationInstances`, `decorationDraws`, `shadowDraws` and, when
available, `gpuMs`.

## 10. Error handling

| Situation | Behaviour |
|---|---|
| Shadow pass or depth texture unsupported on the backend | That effect is disabled with **one** warning; rendering continues (water without foam/depth colour) |
| Block names a decoration that isn't defined | Registry error at engine creation, same pattern as other block validation |
| `atmosphere.set` with an unknown preset name | Throws |
| `atmosphere.set` / `define` with a non-finite number | Rejected; current state kept |
| `quality` with a non-positive or non-finite value | Rejected; current value kept |

## 11. Testing

### Node (Vitest)

- `atmosphere.ts`: interpolation (colours in linear space, shortest-arc azimuth, easing),
  partial merge, transitions starting mid-transition, validation and clamping.
- `lighting.ts`: shadow camera fit contains the view frustum footprint; texel snapping
  makes a sub-texel camera move leave the shadow origin unchanged.
- `decorations/extract.ts`: emits only where the voxel above is air; edge mask (set where the same-height neighbour is non-opaque) at chunk
  borders read from the neighbour border; ghost overrides add and remove instances;
  packing round-trips.
- Mesher: liquid faces go to the `liquid` layer and glass stays in `translucent`; the
  registry default layer for liquids is `liquid`.
- UV fix: the +X/−Z projection flips `u`.
- Alpha dilation: transparent texels next to opaque ones take their colour; texels far
  from any opaque one are untouched; alpha is never changed.
- Registry: undefined decoration name is an error.
- Painter: the same seed gives the same pixels; every tile is seamless (column 0
  continues column 63, row 0 continues row 63).
- `bench:node`: the mesh job with decorations stays under 3 ms per chunk.

### Browser

- Spike (Task 1) verified with Playwright on WebGPU and WebGL2 (§4).
- The e2e smoke test covers both scenes and a preset switch, with no console errors, on
  both backends.

### Visual checkpoints with the user

1. After lighting, shadows, sky and fog (tone-mapping choice, C11).
2. After water and grass.
3. Final, with the painted textures.
