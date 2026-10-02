# Elovox Visual Polish (Sub-project 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Elovox the look of the user's references. That means lit and shadowed voxel terrain, a sky with painted clouds, atmospheric fog, colour grading, stylized water with shore foam, instanced grass and flowers that sway and hang over block edges, and hand-painted-style procedural textures. Everything runs at 60 fps at the 3/4 view.

**Architecture:**
- Chunk materials move from hand-computed light (`MeshBasicNodeMaterial`) to a three.js lit node material with a custom `VoxelLightingModel`. A `DirectionalLight` sun with one view-fitted, texel-snapped shadow map and a `HemisphereLight` light terrain and game meshes alike.
- An `AtmosphereController` holds every look parameter as numbers and colours and interpolates between presets. A new `Visuals` module owns the lights, sky (`scene.backgroundNode`), fog (`scene.fogNode`), the post pipeline (`RenderPipeline`), the water material, decorations, quality and effect toggles. `engine.ts` delegates rendering to it.
- The mesh worker also extracts per-voxel decoration instances (grass tufts, flowers). Grass and flowers are drawn as per-chunk instanced geometry.

**Tech Stack:** TypeScript, three.js 0.186.1 (`three/webgpu` + TSL), Vite, Vitest, Playwright, Node 24, npm workspaces. Same as sub-project 1.

**Spec:** `docs/superpowers/specs/2026-10-02-visual-polish-design.md`. Read it before starting any task. The sub-project 1 spec (`docs/superpowers/specs/2026-10-01-voxel-core-design.md`) and plan (`docs/superpowers/plans/2026-10-01-voxel-core.md`) describe the code this plan builds on.

## Global Constraints

- three.js is pinned at **0.186.1**. Engine render code imports `three/webgpu` and `three/tsl` only.
- **Pure modules must not import three.js**, so Node tests can load them. That covers `atmosphere.ts`, `shadowFit.ts`, `faceUv.ts`, `settings.ts`, `decorations/defs.ts`, `decorations/extract.ts`, `decorations/budget.ts`, `decorations/shapes.ts` and the tile/dilation code.
- All relative imports use explicit `.ts` extensions. `tsconfig` sets `allowImportingTsExtensions`, `erasableSyntaxOnly` and `verbatimModuleSyntax`. That means no `enum`, no `namespace`, no constructor parameter properties, and `import type` for type-only imports.
- Deterministic code (`sim/`, `world/`, generators, rules) keeps the sub-project 1 rules: no `Math.random`, `Date`, `Math.sin/cos/exp`, and no floats in world state. **Decoration extraction runs in the mesh worker and must be deterministic too**: integer hashing (`hash32`) and `valueNoise2` only.
- Atmosphere colours are given as `'#rrggbb'` sRGB strings and stored as linear-space `[r, g, b]` tuples. Light intensities in presets are in "albedo units" (1 = full albedo at normal incidence). `SunLights` multiplies them by π for three.js.
- Tiles are 64 × 64 RGBA. The world size stays a tuple of multiples of 32.
- Performance gates:
  - `npm run bench:node -w @elovox/engine` stays under 3 ms per chunk, with decoration extraction included.
  - The §9 GPU budgets in the spec are measured in Task 16.
- Every task ends with `npm test` and `npm run typecheck` both passing.
- Commits use conventional messages (`feat:`, `fix:`, `test:`, `docs:`, `chore:`). **No `Co-Authored-By` trailer**: the project's `.claude/settings.json` doesn't set `attribution.commit`, and the user's global rules forbid the trailer in that case.
- Work happens on branch `feat/visual-polish` (it already exists and holds the spec commit).

## Deviations from the spec (decided while planning)

These are deliberate. Each one fills a gap or fixes something that would not work as the spec wrote it.

1. **Rejected settings throw.** `atmosphere.set/define`, `quality`, `effects` and `water` throw a `RangeError` or `TypeError` that names the bad field, and the current state is left unchanged. The spec says "rejected"; a throw is the observable form of that.
2. **`engine.effects`** (`{ shadows, decorations, water, post, fog }`) is added. The spec's HUD toggles need an engine API to drive.
3. **Flower colour index** goes in instance word 2, bits 8–10, which the spec lists as reserved. The worker picks it, so the shader needs no palette hashing.
4. **Caps:** at most 16 decoration definitions (per-decoration parameters live in uniform arrays), 24 blades per tuft and 8 flower colours per decoration.
5. **`EngineStats.shadowCasters`** (the number of chunk meshes that cast shadows) replaces `shadowDraws`. three.js doesn't report draw calls per pass.
6. **Shadows fade out over the last 15 % of the shadow distance**, so the edge of the shadow map is never a hard line. The shadow distance is `clamp(3 × orbit distance, 96, 700)` blocks.
7. **GPU timing is opt-in** (`createEngine({ gpuTiming: true })`, which the sandbox sets from `?gpu`). On backends without timestamp queries three.js would otherwise log a warning.
8. **Water specular and fresnel are added as emissive light**, so the specular glint isn't shadowed. The water's diffuse term is lit and shadowed normally.
9. **Decoration validation lives in a `DecorationRegistry`** built on the main thread, not in `BlockRegistry`. The sim worker builds a `BlockRegistry` without decorations, so validating there would reject every decorated block.
10. **`layer: 'liquid'` requires `liquid: true`.** Anything else is a registry error.
11. **The e2e test covers WebGL2 headless.** Headless Chromium has no WebGPU, as sub-project 1 found. The controller checks WebGPU in headed Playwright at each checkpoint.
12. **The sandbox gets its own Vitest setup** (for the painter and the diorama generator), and the root `npm test` runs every workspace.
13. **`engine.water`, `engine.quality` and `engine.effects` are accessor properties.** The getter returns the resolved values; the setter takes a partial object and merges it.

## Review Focus

These are failure modes the spec implies but no feature test naturally exercises. Each line names the task whose tests pin it.

1. **Digging next to grass at a chunk border.** The remaining grass block's tuft must start hanging over the new hole. Its edge bit comes from the neighbour chunk's border voxel in the padded snapshot. Pinned in Task 11 (edge mask read from padding).
2. **Placing a block on top of grass.** The tuft must vanish in the same frame as the geometry, while the edit is still a ghost. Pinned in Task 11 (`MeshJobRunner` with an override above a grass voxel).
3. **Preset spam.** Calling `atmosphere.set` again mid-transition must continue from the current mixed state, never jump. Pinned in Task 2.
4. **A sun straight overhead or below the horizon.** Shadow fitting must not produce NaN when the sun direction is parallel to world up. The sun must switch off (no light, no shadow) at elevation ≤ 0. Pinned in Task 3 (`fitShadow` with a vertical sun) and Task 2 (`sunVisibility`).
5. **Grass at the world edge** (the diorama's cut sides). Out-of-world neighbours read as air, so edge voxels must get their overhang bits. Pinned in Task 11.

---

## File Structure

```
packages/engine/src/
  render/
    atmosphere.ts            Atmosphere model, presets, validation, interpolation, controller (pure)
    shadowFit.ts             frustum corners, shadow-camera fit + texel snapping, shadow distance (pure)
    faceUv.ts                per-face UV projection table shared with the shader (pure)
    settings.ts              Quality, Effects, WaterParams: defaults, merge/validate, backend support (pure)
    chunkVertex.ts           TSL decode of the packed chunk vertex (shared by chunk + water materials)
    voxelLighting.ts         VoxelLightingModel, VoxelNodeMaterial, light uniforms, voxelLit() helper
    materials.ts             chunk materials (opaque, cutout, translucent) on VoxelNodeMaterial   [rewritten]
    lighting.ts              SunLights: DirectionalLight + HemisphereLight driven by the atmosphere
    sky.ts                   Sky: scene.backgroundNode (gradient, sun, clouds) + scene.fogNode
    post.ts                  PostPipeline: RenderPipeline, grading, tone mapping, MSAA
    water.ts                 liquid-layer material (ripples, depth colour, foam, specular)
    visuals.ts               Visuals: owns everything above plus chunk + decoration meshes
    chunkMeshes.ts           4 layers, shadow flags, swappable liquid material                  [modified]
    tiles.ts                 + dilateAlpha()                                                     [modified]
    textureArray.ts          dilates tiles before packing                                        [modified]
    decorations/
      defs.ts                defineDecoration, DecorationRegistry, DecorationTables (pure)
      extract.ts             instance packing, InstanceBuilder, extractDecorations (pure, worker)
      budget.ts              selectVisible(): radius + instance ceiling (pure)
      shapes.ts              tuft/flower vertex arrays (pure)
      material.ts            grass and flower materials (TSL)
      decorationMeshes.ts    per-chunk instanced meshes
  blocks/registry.ts         + 'liquid' layer                                                    [modified]
  mesh/tables.ts             + deco tables                                                       [modified]
  mesh/liquid.ts             liquid faces to their own builder                                   [modified]
  mesh/mesher.ts             + liquid layer, decoration extraction, chunk origin                 [modified]
  mesh/meshJob.ts            passes the chunk origin; EMPTY gains new fields                     [modified]
  mesh/mesh.worker.ts        transfers the new buffers                                           [modified]
  engine.ts                  delegates rendering to Visuals; new API surface                     [modified]
  index.ts                   new exports                                                         [modified]
packages/engine/test/        atmosphere, shadowFit, faceUv, settings, decorations*, tiles, liquid, registry, meshJob tests
packages/engine/bench/       surface fixture gains decorations                                   [modified]
apps/sandbox/
  vitest.config.ts           sandbox unit tests (painter, diorama)
  src/scenes/diorama.ts      hand-built diorama generator (pure column function)
  src/diorama.worker.ts      sim worker for the diorama scene
  src/controls.ts            preset buttons + effect toggles
  src/paint/                 raster.ts, noise.ts, shade.ts, materials.ts, index.ts (procedural painter)
  src/textures.ts            painter output → PNG data URLs                                      [rewritten]
  src/blocks.ts, main.ts, hud.ts                                                                 [modified]
  test/                      painter.test.ts, diorama.test.ts
  e2e/smoke.spec.ts          both scenes, preset switch, WebGL                                   [modified]
```

## Task Overview

| # | Task | Ends with |
|---|---|---|
| 1 | Spike: verify three.js 0.186.1 capabilities on both backends | recorded results (throwaway code) |
| 2 | Atmosphere model and controller | Node tests |
| 3 | Shadow fitting math | Node tests |
| 4 | Voxel lighting model and lit chunk materials (+ UV fix) | Node tests + browser check |
| 5 | Settings, sun lights, shadows and the `Visuals` module | Node tests + browser check |
| 6 | Sky and fog | browser check |
| 7 | Post-processing | browser check |
| 8 | Sandbox scenes, diorama and HUD controls | Node tests + **Checkpoint 1** |
| 9 | Liquid render layer | Node tests |
| 10 | Water material | browser check |
| 11 | Decoration definitions and extraction | Node tests + bench |
| 12 | Decoration rendering | Node tests + **Checkpoint 2** |
| 13 | Alpha dilation and texture checks | Node tests |
| 14 | Procedural painter core | Node tests |
| 15 | Painted tiles | Node tests + browser check |
| 16 | GPU timing, stats, e2e and performance | e2e + measurements + **Checkpoint 3** |

At a checkpoint the controller stops and asks the user for a visual review before continuing.

---

### Task 1: Spike — verify three.js 0.186.1 capabilities on both backends

This task is a **throwaway spike**. It writes a standalone page, the controller checks it in a real browser on both backends, and the findings go into this plan. The spike code is **not committed**.

**Files:**
- Create (temporary, deleted in Step 4): `apps/sandbox/spike.html`, `apps/sandbox/src/spike.ts`
- Modify: `docs/superpowers/plans/2026-10-02-visual-polish.md` (append the "Spike results" section)

**Interfaces:**
- Consumes: `BlockRegistry`, `defineBlock` (`blocks/registry.ts`), `Mesher` (`mesh/mesher.ts`), `meshTablesFrom` (`mesh/tables.ts`), `checkerTile` (`render/tiles.ts`), `createSnapshot`, `padIndex` (`world/reader.ts`).
- Produces: the "Spike results" section, which later tasks read. It records P1–P7 below, the shadow bias that worked, and every workaround used.

**Questions to answer (P1–P7):**
- P1: The shadow depth pass uses the material's `positionNode` with the aliased packed `uvec2` attribute, so terrain casts shadows that line up with the geometry.
- P2: A custom `LightingModel` subclass plugged into a `MeshLambertNodeMaterial` subclass compiles and lights correctly. A `normalNode` built from the packed normal works, and `receivedShadowNode` tints shadows.
- P3: `viewportDepthTexture()` can be read from a transparent material and gives a usable thickness (foam band where water meets terrain).
- P4: An `InstancedBufferGeometry` with an integer `InstancedBufferAttribute` read as `attribute('inst', 'uvec2')` places instances correctly.
- P5: `PCFShadowMap` with `shadow.radius` gives soft shadow edges.
- P6: `RenderPipeline` + `pass()` with a grading node, `scene.fogNode`, `scene.backgroundNode` (`normalWorldGeometry`), and renderer tone mapping work together.
- P7: The direction of `screenUV.y` (does 0 mean the top of the screen?) on both backends.

- [ ] **Step 1: Write the spike page**

`apps/sandbox/spike.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>spike</title>
    <link rel="icon" href="data:," />
    <style>html, body { margin: 0; height: 100%; overflow: hidden; } canvas { display: block; width: 100%; height: 100%; }</style>
  </head>
  <body>
    <canvas id="view"></canvas>
    <script type="module" src="/src/spike.ts"></script>
  </body>
</html>
```

`apps/sandbox/src/spike.ts`:
```ts
// @ts-nocheck — throwaway spike for plan Task 1; deleted after the results are recorded.
import * as THREE from 'three/webgpu'
import {
  BRDF_Lambert, Fn, attribute, cameraFar, cameraNear, color, diffuseColor, float, fog, mix, normalView, normalWorldGeometry,
  pass, perspectiveDepthToViewZ, positionLocal, positionView, positionWorld, rangeFogFactor, screenUV, select, smoothstep,
  texture, transformNormalToView, uint, vec2, vec3, vec4, viewportDepthTexture,
} from 'three/tsl'
import { BlockRegistry, defineBlock } from '@elovox/engine/src/blocks/registry.ts'
import { Mesher } from '@elovox/engine/src/mesh/mesher.ts'
import { meshTablesFrom } from '@elovox/engine/src/mesh/tables.ts'
import { checkerTile } from '@elovox/engine/src/render/tiles.ts'
import { createSnapshot, padIndex } from '@elovox/engine/src/world/reader.ts'

const q = new URLSearchParams(location.search)
const canvas = document.querySelector('#view')
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: q.has('webgl') })
await renderer.init()
renderer.setSize(innerWidth, innerHeight, false)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap
renderer.toneMapping = THREE.AgXToneMapping
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 500)
camera.position.set(52, 34, 56)
camera.lookAt(16, 3, 16)

// ---- terrain: steps, a pillar (shadow caster), a pool (water/foam) ----
const reg = new BlockRegistry([defineBlock({ name: 'stone' })])
const snap = createSnapshot()
snap.light.fill(15)
for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) {
  let h = 4 + (((x >> 3) + (z >> 3)) % 3)
  if (x >= 18 && x < 26 && z >= 18 && z < 26) h = 2
  if (x >= 8 && x < 10 && z >= 8 && z < 10) h = 14
  for (let y = 0; y < h; y++) snap.voxels[padIndex(x + 1, y + 1, z + 1)] = 1
}
const data = new Mesher().mesh(snap, meshTablesFrom(reg, new Uint16Array(reg.count * 6).fill(1)))
const tex = new THREE.DataArrayTexture(new Uint8Array([...checkerTile(64), ...checkerTile(64)]), 64, 64, 2)
tex.wrapS = tex.wrapT = THREE.RepeatWrapping
tex.needsUpdate = true

// ---- P2: custom lighting model ----
class SpikeModel extends THREE.LightingModel {
  direct({ lightDirection, lightColor, reflectedLight }) {
    const ndl = normalView.dot(lightDirection).add(0.25).div(1.25).clamp()
    reflectedLight.directDiffuse.addAssign(ndl.mul(lightColor).mul(BRDF_Lambert({ diffuseColor: diffuseColor.rgb })))
  }
  indirect(builder) {
    const { ambientOcclusion, irradiance, reflectedLight } = builder.context
    reflectedLight.indirectDiffuse.addAssign(irradiance.mul(BRDF_Lambert({ diffuseColor })))
    reflectedLight.indirectDiffuse.mulAssign(ambientOcclusion)
  }
}
class SpikeMaterial extends THREE.MeshLambertNodeMaterial {
  setupLightingModel() { return new SpikeModel() }
}

// ---- P1: packed position in the shadow pass ----
const m = new SpikeMaterial()
const packed = attribute('packed', 'uvec2')
const a = packed.x
const local = vec3(a.bitAnd(uint(63)).toFloat(), a.shiftRight(uint(6)).bitAnd(uint(63)).toFloat(), a.shiftRight(uint(12)).bitAnd(uint(63)).toFloat())
const nIdx = a.shiftRight(uint(18)).bitAnd(uint(7))
const n = select(nIdx.equal(uint(0)), vec3(1, 0, 0), select(nIdx.equal(uint(1)), vec3(-1, 0, 0),
  select(nIdx.equal(uint(2)), vec3(0, 1, 0), select(nIdx.equal(uint(3)), vec3(0, -1, 0),
    select(nIdx.equal(uint(4)), vec3(0, 0, 1), vec3(0, 0, -1))))))
const axis = nIdx.shiftRight(uint(1))
const uv = select(axis.equal(uint(0)), vec2(local.z, local.y), select(axis.equal(uint(1)), vec2(local.x, local.z), vec2(local.x, local.y)))
m.positionNode = local.sub(16)
m.normalNode = transformNormalToView(n)
m.receivedShadowPositionNode = positionWorld.add(n.mul(0.05))
m.receivedShadowNode = Fn(([s]) => mix(color(0x5b6b99), vec3(1), s))
m.colorNode = texture(tex, uv).depth(1)
m.aoNode = float(1)
const geo = new THREE.BufferGeometry()
const attr = new THREE.BufferAttribute(data.opaque.vertices, 2)
attr.gpuType = THREE.IntType
geo.setAttribute('packed', attr)
geo.setAttribute('position', attr)
geo.setIndex(new THREE.BufferAttribute(data.opaque.indices, 1))
geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 28)
const terrain = new THREE.Mesh(geo, m)
terrain.position.set(16, 16, 16)
terrain.castShadow = terrain.receiveShadow = true
scene.add(terrain)

// ---- a game mesh: casts on terrain, receives from the pillar ----
const ball = new THREE.Mesh(new THREE.SphereGeometry(2, 32, 16), new THREE.MeshStandardNodeMaterial({ color: 0xe0b040 }))
ball.position.set(20, 9, 12)
ball.castShadow = ball.receiveShadow = true
scene.add(ball)

// ---- lights (P5) ----
const sun = new THREE.DirectionalLight(0xfff1d6, Math.PI * 1.2)
sun.position.set(44, 60, 24)
sun.target.position.set(16, 0, 16)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
sun.shadow.radius = Number(q.get('radius') ?? 2.5)
sun.shadow.bias = Number(q.get('bias') ?? -0.0004)
Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 160 })
sun.shadow.camera.updateProjectionMatrix()
scene.add(sun, sun.target, new THREE.HemisphereLight(0xa8c8ff, 0x6b5a45, Math.PI * 0.6))

// ---- P3: water plane reading scene depth ----
const wm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture(), cameraNear, cameraFar)
const thickness = positionView.z.sub(sceneZ)
const foam = float(1).sub(smoothstep(0, 0.6, thickness))
wm.colorNode = vec4(mix(color(0x2a8fc0), vec3(1), foam), mix(float(0.7), float(1), foam))
const water = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), wm)
water.rotation.x = -Math.PI / 2
water.position.set(22, 3.6, 22)
scene.add(water)

// ---- P4: integer instanced attribute ----
const box = new THREE.BoxGeometry(0.4, 0.4, 0.4)
const ig = new THREE.InstancedBufferGeometry()
ig.index = box.index
ig.setAttribute('position', box.getAttribute('position'))
ig.setAttribute('normal', box.getAttribute('normal'))
const inst = new Uint32Array(64 * 2)
for (let i = 0; i < 64; i++) { inst[i * 2] = (2 + (i % 8) * 3) | ((2 + Math.floor(i / 8) * 3) << 8); inst[i * 2 + 1] = i }
const ia = new THREE.InstancedBufferAttribute(inst, 2)
ia.gpuType = THREE.IntType
ig.setAttribute('inst', ia)
ig.instanceCount = 64
const im = new THREE.MeshLambertNodeMaterial({ color: 0xd04040 })
const ip = attribute('inst', 'uvec2')
im.positionNode = positionLocal.add(vec3(ip.x.bitAnd(uint(255)).toFloat(), 12, ip.x.shiftRight(uint(8)).bitAnd(uint(255)).toFloat()))
const boxes = new THREE.Mesh(ig, im)
boxes.frustumCulled = false
scene.add(boxes)

// ---- P6/P7: background, fog, post ----
scene.backgroundNode = q.has('flat')
  ? mix(color(0x0000ff), color(0xff0000), screenUV.y) // P7: red where screenUV.y = 1, blue where 0
  : mix(color(0xbcd9f2), color(0x2f6fd6), normalWorldGeometry.y.max(0))
scene.fogNode = fog(color(0xbcd9f2), rangeFogFactor(40, 140))
const post = new THREE.RenderPipeline(renderer)
const sp = pass(scene, camera)
const luma = sp.rgb.dot(vec3(0.2126, 0.7152, 0.0722))
post.outputNode = vec4(mix(vec3(luma), sp.rgb, 1.25), 1)

renderer.setAnimationLoop(() => { if (q.has('nopost')) renderer.render(scene, camera); else post.render() })
document.title = `spike: ${renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl'}`
```

- [ ] **Step 2: Controller checks the spike in both backends**

Run `npm run dev` from the repository root. Use Playwright (headed Chromium with `--enable-unsafe-webgpu`) to open each of these:
- `http://localhost:5173/spike.html`
- `http://localhost:5173/spike.html?webgl`
- `http://localhost:5173/spike.html?flat`
- `http://localhost:5173/spike.html?webgl&flat`
- `http://localhost:5173/spike.html?nopost`

For each one, take a screenshot and read the console. Check:
- **P1:** The pillar casts a shadow on the steps, away from the sun (the sun is at +x, +z, high), starting at its base. There is no shadow acne (striped self-shadowing) on lit faces and no peter-panning gap at the base. If acne shows, retry with `?bias=-0.001`. If shadows are missing or offset from the geometry, P1 fails.
- **P2:** Faces are lit by direction. Side faces facing away from the sun get only hemisphere light. Shadowed areas are blue-grey, not black. The console has no shader compile errors.
- The ball casts a shadow on the terrain, and the pillar's shadow falls on the ball when they overlap.
- **P3:** The water plane shows a white band where it meets the pool walls and a blue centre.
- **P4:** 64 red cubes float in an 8 × 8 grid at y = 12 with 3-block spacing.
- **P5:** Shadow edges are soft. Compare `?radius=1` with the default `2.5`.
- **P6:** The sky shows a gradient, distant steps fade towards the fog colour, colours look saturated with post on, and `?nopost` renders too.
- **P7:** With `?flat`, record whether red (`screenUV.y = 1`) is at the top or the bottom, for each backend.
- No console errors. Record any warnings verbatim. A "Vertex attribute normal not found" warning is expected only if `normalNode` doesn't suppress the geometry normal read; if it appears, record it.

- [ ] **Step 3: Record the results in this plan**

Append a section at the end of `docs/superpowers/plans/2026-10-02-visual-polish.md`:

```markdown
## Spike results (Task 1)

| Check | WebGPU | WebGL2 | Notes |
|---|---|---|---|
| P1 shadow pass uses packed positionNode | pass/fail | pass/fail | bias used: … |
| P2 custom LightingModel + normalNode + receivedShadowNode | | | |
| P3 viewportDepthTexture in a transparent material | | | |
| P4 integer InstancedBufferAttribute (uvec2) | | | |
| P5 PCF radius soft shadows | | | |
| P6 RenderPipeline + fogNode + backgroundNode + tone mapping | | | |
| P7 screenUV.y = 1 is at the … | top/bottom | top/bottom | |

Warnings seen: …
Workarounds adopted (later tasks must apply them): …
```

**Decision rules (stop and ask the user if a rule says so):**
- P1 or P2 fails on either backend: **stop**. Report to the user that the spec's fallback (own lighting with an engine-owned sun depth pass) is needed. It requires re-approval (spec §4).
- P3 fails on one backend: continue. In Task 5, set `SUPPORT[<backend>].waterDepth = false` in `settings.ts`.
- P4 fails on WebGL2: stop and report. Decorations would need a float-attribute fallback.
- A "normal not found" warning: Task 4 must give chunk geometry a `normal` attribute alias. Record it as a workaround.
- P7 tells Task 6 whether to use `screenUV.y` or `screenUV.y.oneMinus()` for "up".

- [ ] **Step 4: Delete the spike and commit the results**

```bash
rm apps/sandbox/spike.html apps/sandbox/src/spike.ts
git add docs/superpowers/plans/2026-10-02-visual-polish.md
git commit -m "docs(plan): record Task 1 spike results"
```

---
### Task 2: Atmosphere model and controller

**Files:**
- Create: `packages/engine/src/render/atmosphere.ts`
- Test: `packages/engine/test/atmosphere.test.ts`

**Interfaces:**
- Produces (all three-free):
  - `type Rgb = readonly [number, number, number]`: linear RGB, 0–1 per channel.
  - `interface Atmosphere`: the spec §3 model, with every colour stored as `Rgb`.
  - `type AtmosphereInput`: a deep-partial `Atmosphere` whose colours are `'#rrggbb'` strings.
  - `hexToLinear(hex: string, path?: string): Rgb`
  - `resolveAtmosphere(base: Atmosphere, input: AtmosphereInput): Atmosphere`: validates, clamps and merges.
  - `lerpAtmosphere(a: Atmosphere, b: Atmosphere, t: number): Atmosphere`
  - `lerpAngle(a: number, b: number, t: number): number`: degrees, shortest arc, result in [0, 360).
  - `sunDirection(azimuth: number, elevation: number): [number, number, number]`: unit vector **towards** the sun. Azimuth 0 points to +x and 90 to +z; elevation 90 is straight up.
  - `sunVisibility(elevation: number): number`: 0 at or below the horizon, ramping to 1 at 4°.
  - `PRESETS: Readonly<Record<'open' | 'diorama' | 'sunset', Atmosphere>>`
  - `class AtmosphereController` with:
    - `constructor(initial = 'open')`
    - `current: Atmosphere` (getter)
    - `presetNames(): string[]`
    - `set(target: string | AtmosphereInput, options?: { duration?: number }): void`
    - `define(name: string, input: AtmosphereInput): void`
    - `update(dt: number): boolean`: true when `current` changed since the previous call.

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/atmosphere.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import {
  AtmosphereController, PRESETS, hexToLinear, lerpAngle, lerpAtmosphere, resolveAtmosphere, sunDirection, sunVisibility,
} from '../src/render/atmosphere.ts'

describe('colours', () => {
  it('converts sRGB hex to linear', () => {
    expect(hexToLinear('#ffffff')).toEqual([1, 1, 1])
    expect(hexToLinear('#000000')).toEqual([0, 0, 0])
    expect(hexToLinear('#808080')[0]).toBeCloseTo(0.2159, 3)
  })
  it('rejects malformed colours with the field path', () => {
    expect(() => hexToLinear('red', 'atmosphere.fog.color')).toThrow(/atmosphere\.fog\.color/)
    expect(() => hexToLinear('#12345')).toThrow(RangeError)
  })
})

describe('angles and the sun', () => {
  it('interpolates azimuth along the shortest arc', () => {
    expect(lerpAngle(350, 10, 0.5)).toBeCloseTo(0)
    expect(lerpAngle(10, 350, 0.5)).toBeCloseTo(0)
    expect(lerpAngle(90, 180, 0.5)).toBeCloseTo(135)
    expect(lerpAngle(350, 10, 0.25)).toBeCloseTo(355)
  })
  it('points the sun direction by azimuth and elevation', () => {
    const [x, y, z] = sunDirection(0, 0)
    expect([x, y, z].map((v) => +v.toFixed(6))).toEqual([1, 0, 0])
    expect(sunDirection(90, 0)[2]).toBeCloseTo(1)
    expect(sunDirection(0, 90)[1]).toBeCloseTo(1)
    const d = sunDirection(135, 50)
    expect(Math.hypot(...d)).toBeCloseTo(1)
  })
  it('turns the sun off at or below the horizon', () => {
    expect(sunVisibility(-10)).toBe(0)
    expect(sunVisibility(0)).toBe(0)
    expect(sunVisibility(2)).toBeCloseTo(0.5)
    expect(sunVisibility(30)).toBe(1)
  })
})

describe('resolveAtmosphere', () => {
  it('merges a partial input over a base', () => {
    const r = resolveAtmosphere(PRESETS.open, { fog: { far: 300 } })
    expect(r.fog.far).toBe(300)
    expect(r.fog.near).toBe(PRESETS.open.fog.near)
    expect(r.sun).toEqual(PRESETS.open.sun)
  })
  it('clamps ranged fields', () => {
    const r = resolveAtmosphere(PRESETS.open, { sky: { dome: 2, clouds: { coverage: -1 } }, sun: { elevation: 120 }, shadow: { strength: 3 } })
    expect(r.sky.dome).toBe(1)
    expect(r.sky.clouds.coverage).toBe(0)
    expect(r.sun.elevation).toBe(90)
    expect(r.shadow.strength).toBe(1)
  })
  it('normalises azimuth and keeps fog far beyond near', () => {
    const r = resolveAtmosphere(PRESETS.open, { sun: { azimuth: -90 }, fog: { near: 500, far: 100 } })
    expect(r.sun.azimuth).toBe(270)
    expect(r.fog.far).toBe(501)
  })
  it('rejects non-finite numbers, bad colours and unknown fields', () => {
    expect(() => resolveAtmosphere(PRESETS.open, { fog: { near: Number.NaN } })).toThrow(/atmosphere\.fog\.near/)
    expect(() => resolveAtmosphere(PRESETS.open, { sun: { intensity: Infinity } })).toThrow(RangeError)
    expect(() => resolveAtmosphere(PRESETS.open, { ambient: { sky: '#zzzzzz' } })).toThrow(/atmosphere\.ambient\.sky/)
    expect(() => resolveAtmosphere(PRESETS.open, { fog: { thickness: 2 } } as never)).toThrow(/unknown atmosphere field "atmosphere\.fog\.thickness"/)
  })
  it('ignores undefined fields', () => {
    expect(resolveAtmosphere(PRESETS.open, { fog: { near: undefined } })).toEqual(PRESETS.open)
  })
})

describe('lerpAtmosphere', () => {
  it('returns the ends at t = 0 and t = 1 and mixes in between', () => {
    expect(lerpAtmosphere(PRESETS.open, PRESETS.sunset, 0)).toEqual(PRESETS.open)
    expect(lerpAtmosphere(PRESETS.open, PRESETS.sunset, 1)).toEqual(PRESETS.sunset)
    const mid = lerpAtmosphere(PRESETS.open, PRESETS.sunset, 0.5)
    expect(mid.sun.elevation).toBeCloseTo((PRESETS.open.sun.elevation + PRESETS.sunset.sun.elevation) / 2)
    expect(mid.fog.color[0]).toBeCloseTo((PRESETS.open.fog.color[0] + PRESETS.sunset.fog.color[0]) / 2)
  })
})

describe('presets', () => {
  it('ships open, diorama and sunset with the diorama on a flat backdrop', () => {
    expect(Object.keys(PRESETS).sort()).toEqual(['diorama', 'open', 'sunset'])
    expect(PRESETS.diorama.sky.dome).toBe(0)
    expect(PRESETS.open.sky.dome).toBe(1)
    expect(PRESETS.sunset.sun.elevation).toBeLessThan(PRESETS.open.sun.elevation)
  })
})

describe('AtmosphereController', () => {
  it('starts on open and reports the first change once', () => {
    const c = new AtmosphereController()
    expect(c.current).toEqual(PRESETS.open)
    expect(c.update(0.016)).toBe(true)
    expect(c.update(0.016)).toBe(false)
  })
  it('applies a preset immediately without a duration', () => {
    const c = new AtmosphereController()
    c.set('sunset')
    expect(c.current).toEqual(PRESETS.sunset)
  })
  it('transitions over the duration with smoothstep easing', () => {
    const c = new AtmosphereController()
    c.update(0)
    c.set('sunset', { duration: 2 })
    const e0 = PRESETS.open.sun.elevation, e1 = PRESETS.sunset.sun.elevation
    expect(c.update(0.5)).toBe(true)
    expect(c.current.sun.elevation).toBeCloseTo(e0 + (e1 - e0) * 0.15625) // smoothstep(0.25)
    c.update(0.5)
    expect(c.current.sun.elevation).toBeCloseTo((e0 + e1) / 2)
    c.update(5)
    expect(c.current).toEqual(PRESETS.sunset)
    expect(c.update(0.1)).toBe(false)
  })
  it('starts a new transition from the current mixed state, never jumping', () => {
    const c = new AtmosphereController()
    c.set('sunset', { duration: 2 })
    c.update(1)
    const mid = c.current.sun.elevation
    c.set('open', { duration: 2 })
    c.update(1e-6)
    expect(c.current.sun.elevation).toBeCloseTo(mid, 3)
  })
  it('merges a partial set over the target, immediately and during a transition', () => {
    const c = new AtmosphereController()
    c.set({ fog: { far: 300 } })
    expect(c.current.fog.far).toBe(300)
    c.set('sunset', { duration: 2 })
    c.set({ fog: { far: 250 } })
    c.update(10)
    expect(c.current.fog.far).toBe(250)
    expect(c.current.sun.elevation).toBe(PRESETS.sunset.sun.elevation)
  })
  it('throws on unknown presets and bad input, leaving the state unchanged', () => {
    const c = new AtmosphereController()
    const before = c.current
    expect(() => c.set('noon')).toThrow(/unknown atmosphere preset "noon"/)
    expect(() => c.set({ fog: { near: Number.NaN } })).toThrow(RangeError)
    expect(() => c.set('sunset', { duration: -1 })).toThrow(/duration/)
    expect(c.current).toBe(before)
  })
  it('defines game presets over open', () => {
    const c = new AtmosphereController()
    c.define('night', { sun: { elevation: -10 }, ambient: { intensity: 0.15 } })
    expect(c.presetNames()).toContain('night')
    c.set('night')
    expect(c.current.sun.elevation).toBe(-10)
    expect(c.current.fog).toEqual(PRESETS.open.fog)
    expect(() => c.define('', {})).toThrow(/name/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/engine -- atmosphere`
Expected: FAIL with "Failed to load url ../src/render/atmosphere.ts" (the module does not exist yet).

- [ ] **Step 3: Implement the module**

`packages/engine/src/render/atmosphere.ts`:
```ts
/** Linear-space RGB, 0–1 per channel. */
export type Rgb = readonly [number, number, number]

/** Every look parameter of the scene. Colours are linear RGB; angles are degrees. */
export interface Atmosphere {
  sun: { azimuth: number; elevation: number; color: Rgb; intensity: number }
  ambient: { sky: Rgb; ground: Rgb; intensity: number }
  sky: {
    dome: number
    zenith: Rgb
    horizon: Rgb
    sunGlow: number
    clouds: { coverage: number; scale: number; speed: number; light: Rgb; shade: Rgb }
  }
  fog: { color: Rgb; followHorizon: number; near: number; far: number; heightFalloff: number }
  shadow: { strength: number; tint: Rgb }
  grade: { exposure: number; saturation: number; contrast: number; highlights: Rgb; shadows: Rgb }
}

type InputOf<T> = { [K in keyof T]?: T[K] extends Rgb ? string : T[K] extends number ? number : InputOf<T[K]> }
/** A deep-partial Atmosphere; colours are '#rrggbb' sRGB strings. */
export type AtmosphereInput = InputOf<Atmosphere>

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function hexToLinear(hex: string, path = 'colour'): Rgb {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new RangeError(`${path} must be a "#rrggbb" colour, got ${JSON.stringify(hex)}`)
  }
  const n = Number.parseInt(hex.slice(1), 16)
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)]
}

/** [min, max] per numeric field path; fields not listed only need to be finite. */
const RANGES: Readonly<Record<string, readonly [number, number]>> = {
  'atmosphere.sun.elevation': [-90, 90],
  'atmosphere.sun.intensity': [0, Infinity],
  'atmosphere.ambient.intensity': [0, Infinity],
  'atmosphere.sky.dome': [0, 1],
  'atmosphere.sky.sunGlow': [0, Infinity],
  'atmosphere.sky.clouds.coverage': [0, 1],
  'atmosphere.sky.clouds.scale': [1, Infinity],
  'atmosphere.fog.followHorizon': [0, 1],
  'atmosphere.fog.near': [0, Infinity],
  'atmosphere.fog.far': [0, Infinity],
  'atmosphere.fog.heightFalloff': [0, Infinity],
  'atmosphere.shadow.strength': [0, 1],
  'atmosphere.grade.exposure': [0, Infinity],
  'atmosphere.grade.saturation': [0, Infinity],
  'atmosphere.grade.contrast': [0, Infinity],
}

function mergeNode(base: unknown, input: unknown, path: string): unknown {
  if (Array.isArray(base)) return hexToLinear(input as string, path)
  if (typeof base === 'number') {
    if (typeof input !== 'number' || !Number.isFinite(input)) throw new RangeError(`${path} must be a finite number, got ${String(input)}`)
    if (path === 'atmosphere.sun.azimuth') return ((input % 360) + 360) % 360
    const r = RANGES[path]
    return r ? Math.min(r[1], Math.max(r[0], input)) : input
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${path} must be an object`)
  const b = base as Record<string, unknown>, i = input as Record<string, unknown>
  for (const k of Object.keys(i)) if (!(k in b)) throw new RangeError(`unknown atmosphere field "${path}.${k}"`)
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(b)) out[k] = i[k] === undefined ? b[k] : mergeNode(b[k], i[k], `${path}.${k}`)
  return out
}

/** Validates, clamps and merges `input` over `base`. Throws (naming the field) on bad input; never mutates. */
export function resolveAtmosphere(base: Atmosphere, input: AtmosphereInput): Atmosphere {
  const out = mergeNode(base, input, 'atmosphere') as Atmosphere
  // Unchanged sub-objects are shared with `base`, so copy before fixing up.
  if (out.fog.far < out.fog.near + 1) out.fog = { ...out.fog, far: out.fog.near + 1 }
  return out
}

export function lerpAngle(a: number, b: number, t: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180
  return (((a + d * t) % 360) + 360) % 360
}

function lerpNode(a: unknown, b: unknown, t: number, key: string): unknown {
  if (Array.isArray(a)) return (a as number[]).map((v, i) => v + ((b as number[])[i]! - v) * t)
  if (typeof a === 'number') return key === 'azimuth' ? lerpAngle(a, b as number, t) : a + ((b as number) - a) * t
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(a as object)) out[k] = lerpNode((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], t, k)
  return out
}

export function lerpAtmosphere(a: Atmosphere, b: Atmosphere, t: number): Atmosphere {
  if (t <= 0) return a
  if (t >= 1) return b
  return lerpNode(a, b, t, '') as Atmosphere
}

const RAD = Math.PI / 180

/** Unit vector towards the sun. Azimuth 0 → +x, 90 → +z; elevation 90 → straight up. */
export function sunDirection(azimuth: number, elevation: number): [number, number, number] {
  const az = azimuth * RAD, el = elevation * RAD
  return [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)]
}

/** 0 at or below the horizon, ramping to 1 at 4° of elevation. */
export function sunVisibility(elevation: number): number {
  return Math.min(1, Math.max(0, elevation / 4))
}

const BLACK: Rgb = [0, 0, 0]
const TEMPLATE: Atmosphere = {
  sun: { azimuth: 0, elevation: 45, color: BLACK, intensity: 1 },
  ambient: { sky: BLACK, ground: BLACK, intensity: 1 },
  sky: { dome: 1, zenith: BLACK, horizon: BLACK, sunGlow: 0, clouds: { coverage: 0, scale: 400, speed: 0, light: BLACK, shade: BLACK } },
  fog: { color: BLACK, followHorizon: 0, near: 0, far: 1, heightFalloff: 0 },
  shadow: { strength: 1, tint: BLACK },
  grade: { exposure: 1, saturation: 1, contrast: 1, highlights: BLACK, shadows: BLACK },
}

// Values are first guesses, tuned at the visual checkpoints (spec §3).
const OPEN = resolveAtmosphere(TEMPLATE, {
  sun: { azimuth: 135, elevation: 50, color: '#fff1d6', intensity: 1.6 },
  ambient: { sky: '#a8c8ff', ground: '#6b5a45', intensity: 0.7 },
  sky: {
    dome: 1, zenith: '#2f6fd6', horizon: '#bcd9f2', sunGlow: 0.6,
    clouds: { coverage: 0.45, scale: 420, speed: 4, light: '#ffffff', shade: '#b7c6dc' },
  },
  fog: { color: '#bcd9f2', followHorizon: 1, near: 140, far: 900, heightFalloff: 0.012 },
  shadow: { strength: 0.85, tint: '#5b6b99' },
  grade: { exposure: 1, saturation: 1.12, contrast: 1.05, highlights: '#fff6e8', shadows: '#e8eeff' },
})

export const PRESETS: Readonly<Record<'open' | 'diorama' | 'sunset', Atmosphere>> = Object.freeze({
  open: OPEN,
  diorama: resolveAtmosphere(OPEN, {
    sun: { azimuth: 215, elevation: 55, intensity: 1.5 },
    sky: { dome: 0, zenith: '#cfd8e0', horizon: '#e6ebef' },
    fog: { followHorizon: 0, color: '#e6ebef', near: 700, far: 2400 },
    shadow: { strength: 0.75 },
  }),
  sunset: resolveAtmosphere(OPEN, {
    sun: { azimuth: 250, elevation: 9, color: '#ffb27a', intensity: 1.3 },
    ambient: { sky: '#d9a6c8', ground: '#5a4050', intensity: 0.6 },
    sky: { zenith: '#6a5aa8', horizon: '#ff9fb0', sunGlow: 1.2, clouds: { light: '#ffd1b0', shade: '#a9779a' } },
    fog: { color: '#f2a5a8', near: 90, far: 650 },
    shadow: { tint: '#6a4f7a' },
    grade: { highlights: '#ffe2c8', shadows: '#e6dcff' },
  }),
})

const ease = (t: number) => t * t * (3 - 2 * t)

/** Holds the scene's atmosphere and its preset transitions. Advanced once per rendered frame. */
export class AtmosphereController {
  private readonly presets = new Map<string, Atmosphere>(Object.entries(PRESETS))
  private from: Atmosphere
  private to: Atmosphere
  private now: Atmosphere
  private elapsed = 0
  private duration = 0
  private changed = true

  constructor(initial = 'open') {
    const p = this.preset(initial)
    this.from = p
    this.to = p
    this.now = p
  }

  /** Resolved values. Treat as read-only. */
  get current(): Atmosphere { return this.now }

  presetNames(): string[] { return [...this.presets.keys()] }

  set(target: string | AtmosphereInput, options: { duration?: number } = {}): void {
    const duration = options.duration ?? 0
    if (!Number.isFinite(duration) || duration < 0) throw new RangeError(`duration must be a finite number ≥ 0, got ${duration}`)
    if (typeof target === 'string') {
      const next = this.preset(target)
      if (duration === 0) {
        this.from = next; this.to = next; this.now = next; this.duration = 0; this.elapsed = 0
      } else {
        this.from = this.now; this.to = next; this.duration = duration; this.elapsed = 0
      }
    } else if (duration === 0) {
      const to = resolveAtmosphere(this.to, target)
      const from = resolveAtmosphere(this.from, target)
      this.to = to
      this.from = from
      this.now = this.duration > 0 ? lerpAtmosphere(from, to, ease(this.elapsed / this.duration)) : to
    } else {
      const to = resolveAtmosphere(this.to, target)
      this.from = this.now; this.to = to; this.duration = duration; this.elapsed = 0
    }
    this.changed = true
  }

  define(name: string, input: AtmosphereInput): void {
    if (typeof name !== 'string' || name.length === 0) throw new RangeError('atmosphere preset name must be a non-empty string')
    this.presets.set(name, resolveAtmosphere(OPEN, input))
  }

  update(dt: number): boolean {
    if (this.duration > 0 && Number.isFinite(dt) && dt > 0) {
      this.elapsed = Math.min(this.duration, this.elapsed + dt)
      if (this.elapsed >= this.duration) {
        this.now = this.to; this.from = this.to; this.duration = 0; this.elapsed = 0
      } else {
        this.now = lerpAtmosphere(this.from, this.to, ease(this.elapsed / this.duration))
      }
      this.changed = true
    }
    const c = this.changed
    this.changed = false
    return c
  }

  private preset(name: string): Atmosphere {
    const p = this.presets.get(name)
    if (!p) throw new RangeError(`unknown atmosphere preset "${name}" (known: ${[...this.presets.keys()].join(', ')})`)
    return p
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @elovox/engine -- atmosphere`
Expected: PASS (all `atmosphere.test.ts` tests).

Then run `npm test` and `npm run typecheck`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/render/atmosphere.ts packages/engine/test/atmosphere.test.ts
git commit -m "feat(engine): atmosphere model, presets and transitions"
```

---

### Task 3: Shadow fitting math

**Files:**
- Create: `packages/engine/src/render/shadowFit.ts`
- Test: `packages/engine/test/shadowFit.test.ts`

**Interfaces:**
- Produces (three-free):
  - `type V3 = readonly [number, number, number]`
  - `frustumCorners(position: V3, forward: V3, up: V3, fovYDeg: number, aspect: number, near: number, far: number): V3[]`: 8 corners, the 4 near ones first.
  - `interface ShadowFit { position: V3; target: V3; up: V3; halfSize: number; near: number; far: number; texel: number }`
  - `fitShadow(corners: readonly V3[], sunDir: V3, mapSize: number, minY: number, maxY: number): ShadowFit`. `sunDir` points towards the sun. The light looks along `−sunDir`. `position`/`target` place a three.js `DirectionalLight` (its shadow camera looks from `position` at `target` with world-up `[0,1,0]`). The ortho box is `±halfSize`, from `near` to `far`.
  - `shadowDistance(orbitDistance: number): number`: `clamp(3 × d, 96, 700)`.
  - `HALF_STEP = 8`: `halfSize` is always a multiple of this.

How the fit works:
- Light basis: `f = normalize(−sunDir)`, `r = normalize(f × [0,1,0])` (or `f × [0,0,1]` if the sun is vertical), `u = r × f`. With world-up `[0,1,0]`, three.js `lookAt` produces this same basis, so the snapping survives the light's own camera setup.
- The `r`/`u` extent comes from the corners, clamped to `[minY, maxY]`. The `f` extent also includes every corner lifted to `maxY`, so tall casters between the sun and the view are inside.
- `halfSize = ceil((max extent / 2 + 2) / 8) × 8`, `texel = 2 × halfSize / mapSize`. The centre's `r`/`u` coordinates are rounded to whole texels.

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/shadowFit.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { HALF_STEP, fitShadow, frustumCorners, shadowDistance, type V3 } from '../src/render/shadowFit.ts'

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const norm = (a: V3): V3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l] }
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

const SUN = norm([0.45, 0.8, 0.35])
function viewCorners(shift = 0): V3[] {
  return frustumCorners([100 + shift, 80, 100], norm([-0.5, -0.6, -0.6]), [0, 1, 0], 50, 16 / 9, 0.1, 210)
}

describe('frustumCorners', () => {
  it('returns 4 near then 4 far corners at the right depths', () => {
    const pos: V3 = [0, 0, 0], fwd: V3 = [0, 0, -1]
    const c = frustumCorners(pos, fwd, [0, 1, 0], 90, 1, 1, 10)
    expect(c).toHaveLength(8)
    for (let i = 0; i < 4; i++) expect(dot(sub(c[i]!, pos), fwd)).toBeCloseTo(1)
    for (let i = 4; i < 8; i++) expect(dot(sub(c[i]!, pos), fwd)).toBeCloseTo(10)
    expect(Math.abs(c[4]![1])).toBeCloseTo(10) // tan(45°) × 10
  })
})

describe('fitShadow', () => {
  const basis = () => {
    const f = norm([-SUN[0], -SUN[1], -SUN[2]])
    const r = norm(cross(f, [0, 1, 0]))
    return { f, r, u: cross(r, f) }
  }

  it('contains every view corner in the ortho box', () => {
    const corners = viewCorners()
    const s = fitShadow(corners, SUN, 2048, 0, 128)
    const { f, r, u } = basis()
    const cr = dot(s.position, r), cu = dot(s.position, u), cf = dot(s.position, f)
    for (const c0 of corners) {
      const c: V3 = [c0[0], Math.min(128, Math.max(0, c0[1])), c0[2]]
      expect(Math.abs(dot(c, r) - cr)).toBeLessThanOrEqual(s.halfSize)
      expect(Math.abs(dot(c, u) - cu)).toBeLessThanOrEqual(s.halfSize)
      expect(dot(c, f) - cf).toBeGreaterThanOrEqual(s.near)
      expect(dot(c, f) - cf).toBeLessThanOrEqual(s.far)
    }
  })

  it('reaches up to the world top towards the sun', () => {
    const corners = viewCorners()
    const s = fitShadow(corners, SUN, 2048, 0, 128)
    const { f } = basis()
    const cf = dot(s.position, f)
    for (const c of corners) expect(dot([c[0], 128, c[2]], f) - cf).toBeGreaterThanOrEqual(0)
  })

  it('snaps the centre to whole texels and quantises the size', () => {
    const s = fitShadow(viewCorners(), SUN, 2048, 0, 128)
    const { r, u } = basis()
    expect(s.halfSize % HALF_STEP).toBe(0)
    expect(s.texel).toBeCloseTo((2 * s.halfSize) / 2048)
    for (const axis of [r, u]) {
      const k = dot(s.position, axis) / s.texel
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6)
    }
  })

  it('moves only in whole texels when the camera moves a fraction of one', () => {
    const a = fitShadow(viewCorners(0), SUN, 2048, 0, 128)
    const b = fitShadow(viewCorners(a.texel * 0.3), SUN, 2048, 0, 128)
    const { r, u } = basis()
    expect(b.halfSize).toBe(a.halfSize)
    for (const axis of [r, u]) {
      const k = (dot(b.position, axis) - dot(a.position, axis)) / a.texel
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6)
    }
  })

  it('handles a sun straight overhead without NaN', () => {
    const s = fitShadow(viewCorners(), [0, 1, 0], 2048, 0, 128)
    for (const v of [...s.position, ...s.target, ...s.up, s.halfSize, s.near, s.far]) expect(Number.isFinite(v)).toBe(true)
  })
})

describe('shadowDistance', () => {
  it('scales with the orbit distance inside [96, 700]', () => {
    expect(shadowDistance(10)).toBe(96)
    expect(shadowDistance(70)).toBe(210)
    expect(shadowDistance(400)).toBe(700)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/engine -- shadowFit`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the module**

`packages/engine/src/render/shadowFit.ts`:
```ts
export type V3 = readonly [number, number, number]

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const add = (...vs: V3[]): V3 => vs.reduce<V3>((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0])
function norm(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2])
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]
}

/** halfSize is quantised to this many blocks, so it doesn't change (and re-blur) on every small camera move. */
export const HALF_STEP = 8
const PAD = 2

export function frustumCorners(position: V3, forward: V3, up: V3, fovYDeg: number, aspect: number, near: number, far: number): V3[] {
  const f = norm(forward)
  const r = norm(cross(f, up))
  const u = cross(r, f)
  const tan = Math.tan((fovYDeg * Math.PI) / 360)
  const out: V3[] = []
  for (const d of [near, far]) {
    const hh = d * tan, hw = hh * aspect
    const c = add(position, scale(f, d))
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) out.push(add(c, scale(r, sx * hw), scale(u, sy * hh)))
  }
  return out
}

export interface ShadowFit { position: V3; target: V3; up: V3; halfSize: number; near: number; far: number; texel: number }

export function fitShadow(corners: readonly V3[], sunDir: V3, mapSize: number, minY: number, maxY: number): ShadowFit {
  const f = norm([-sunDir[0], -sunDir[1], -sunDir[2]])
  let r = cross(f, [0, 1, 0])
  if (Math.hypot(r[0], r[1], r[2]) < 1e-4) r = cross(f, [0, 0, 1])
  r = norm(r)
  const u = cross(r, f)
  let r0 = Infinity, r1 = -Infinity, u0 = Infinity, u1 = -Infinity, f0 = Infinity, f1 = -Infinity
  for (const c of corners) {
    const p: V3 = [c[0], Math.min(maxY, Math.max(minY, c[1])), c[2]]
    const pr = dot(p, r), pu = dot(p, u), pf = dot(p, f)
    r0 = Math.min(r0, pr); r1 = Math.max(r1, pr)
    u0 = Math.min(u0, pu); u1 = Math.max(u1, pu)
    f0 = Math.min(f0, pf, dot([c[0], maxY, c[2]], f)); f1 = Math.max(f1, pf)
  }
  const halfSize = Math.ceil((Math.max(r1 - r0, u1 - u0) / 2 + PAD) / HALF_STEP) * HALF_STEP
  const texel = (2 * halfSize) / mapSize
  const cr = Math.round((r0 + r1) / 2 / texel) * texel
  const cu = Math.round((u0 + u1) / 2 / texel) * texel
  const back = f0 - PAD
  const position = add(scale(r, cr), scale(u, cu), scale(f, back))
  return { position, target: add(position, f), up: u, halfSize, near: 0, far: f1 + PAD - back, texel }
}

/** How far from the camera shadows reach, from the orbit camera's distance to its target. */
export function shadowDistance(orbitDistance: number): number {
  return Math.min(700, Math.max(96, 3 * orbitDistance))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @elovox/engine -- shadowFit`
Expected: PASS.

Then run `npm test` and `npm run typecheck`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/render/shadowFit.ts packages/engine/test/shadowFit.test.ts
git commit -m "feat(engine): texel-snapped shadow camera fitting"
```

---
### Task 4: Voxel lighting model and lit chunk materials (+ UV fix)

**Files:**
- Create: `packages/engine/src/render/faceUv.ts`, `packages/engine/src/render/chunkVertex.ts`, `packages/engine/src/render/voxelLighting.ts`
- Rewrite: `packages/engine/src/render/materials.ts`
- Modify: `packages/engine/src/engine.ts:135-139` (create light uniforms, pass them to the materials, add temporary lights)
- Test: `packages/engine/test/faceUv.test.ts`

**Interfaces:**
- Consumes: `AO_CURVE` (`mesh/ao.ts`), `FACE`, `FACE_NORMALS` (`mesh/vertexFormat.ts`), and the Task 1 spike results (workarounds).
- Produces:
  - `faceUv.ts` (pure):
    - `FLIP_U: readonly boolean[]`, indexed by face (`FACE` order). It is true for +X and −Z.
    - `faceUV(f: number, x: number, y: number, z: number): [number, number]`
  - `chunkVertex.ts`: `chunkVertex()` returns TSL nodes `{ position, normal, uv, layer, sky, blk, ao }`. `position` is mesh-local (chunk centre at 0). `normal` is the face normal (local = world, because chunk meshes only translate). `sky`, `blk` and `ao` are 0–1 floats. `type ChunkVertex = ReturnType<typeof chunkVertex>`.
  - `voxelLighting.ts`:
    - `class VoxelLightingModel extends THREE.LightingModel`
    - `class VoxelNodeMaterial extends THREE.MeshLambertNodeMaterial`, with `constructor(sky)`.
    - `interface LightUniforms { shadowColor; torchColor; shadowFar }` (TSL uniform nodes) and `createLightUniforms(): LightUniforms`.
    - `voxelLit(m: VoxelNodeMaterial, s: { normal; sky; blk; ao; albedo }, lights: LightUniforms): void` sets `normalNode`, `receivedShadowPositionNode`, `receivedShadowNode`, `aoNode` and `emissiveNode`. Tasks 10 and 12 reuse it.
  - `materials.ts`:
    - `interface ChunkMaterials { opaque: VoxelNodeMaterial; cutout: VoxelNodeMaterial; translucent: VoxelNodeMaterial }`
    - `createChunkMaterials(tex: THREE.DataArrayTexture, lights: LightUniforms): ChunkMaterials`. The old `lighting` field goes away; nothing reads it.

**Light terms** (spec §4):
- **Direct:** `wrap(N·L) × lightColor × sunGate(sky) × albedo/π`, with `wrap(x) = clamp((x + 0.25) / 1.25)` and `sunGate = smoothstep(0.35, 0.95, sky)`. three.js applies the shadow to `lightColor` before `direct()` is called.
- **Shadow tint:** `receivedShadowNode` maps the shadow factor `s` to `mix(shadowColor, 1, max(s, fade))`. `fade` is `smoothstep(0.85 × shadowFar, shadowFar, view distance)` (Deviation 6).
- **Indirect:** hemisphere irradiance × `aoNode`, with `aoNode = aoCurve × max(sky^1.6, 0.05)`.
- **Block light:** `emissive = albedo × torchColor × 1.4 × blk^1.8`.

- [ ] **Step 1: Write the failing test for the UV table**

`packages/engine/test/faceUv.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { FLIP_U, faceUV } from '../src/render/faceUv.ts'
import { FACE, FACE_NORMALS } from '../src/mesh/vertexFormat.ts'

const cross = (a: readonly number[], b: readonly number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!]

describe('faceUV', () => {
  it('flips u on +X and −Z only', () => {
    expect(FLIP_U).toEqual([true, false, false, false, false, true])
  })
  it.each([FACE.PX, FACE.NX, FACE.PZ, FACE.NZ])('runs u along the viewer\'s right and v up on side face %i', (f) => {
    const n = FACE_NORMALS[f]!
    const right = cross([-n[0], -n[1], -n[2]], [0, 1, 0]) // looking at the face from outside, head up
    const p = [3, 4, 5]
    const [u0, v0] = faceUV(f, p[0]!, p[1]!, p[2]!)
    const [u1] = faceUV(f, p[0]! + right[0]! * 0.5, p[1]!, p[2]! + right[2]! * 0.5)
    const [, v1] = faceUV(f, p[0]!, p[1]! + 0.5, p[2]!)
    expect(u1).toBeGreaterThan(u0)
    expect(v1).toBeGreaterThan(v0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @elovox/engine -- faceUv`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `faceUv.ts`**

`packages/engine/src/render/faceUv.ts`:
```ts
/**
 * Faces whose projected u runs against the viewer's right unless negated (FACE order: +X −X +Y −Y +Z −Z).
 * Without the flip, asymmetric tiles read mirrored on +X and −Z faces. The chunk shader is built from this table.
 */
export const FLIP_U: readonly boolean[] = [true, false, false, false, false, true]

/** The (u, v) the chunk shader computes for a local position on face f. RepeatWrapping makes negative u fine. */
export function faceUV(f: number, x: number, y: number, z: number): [number, number] {
  const axis = f >> 1
  const [u, v] = axis === 0 ? [z, y] : axis === 1 ? [x, z] : [x, y]
  return [FLIP_U[f] ? -u : u, v]
}
```

Run: `npm test -w @elovox/engine -- faceUv`
Expected: PASS.

- [ ] **Step 4: Implement `chunkVertex.ts`**

`packages/engine/src/render/chunkVertex.ts`:
```ts
import { attribute, bool, float, select, uint, varying, vec2, vec3 } from 'three/tsl'
import { AO_CURVE } from '../mesh/ao.ts'
import { FLIP_U } from './faceUv.ts'

/** TSL nodes decoded from the packed 8-byte chunk vertex (sub-project 1 format; spec §5 of the core spec). */
export function chunkVertex() {
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
  const normal = select(nIdx.equal(uint(0)), vec3(1, 0, 0),
    select(nIdx.equal(uint(1)), vec3(-1, 0, 0),
      select(nIdx.equal(uint(2)), vec3(0, 1, 0),
        select(nIdx.equal(uint(3)), vec3(0, -1, 0),
          select(nIdx.equal(uint(4)), vec3(0, 0, 1), vec3(0, 0, -1))))))
  const axis = nIdx.shiftRight(uint(1))
  const uvRaw = select(axis.equal(uint(0)), vec2(local.z, local.y), select(axis.equal(uint(1)), vec2(local.x, local.z), vec2(local.x, local.y)))
  const flip = FLIP_U.reduce((acc, on, f) => (on ? acc.or(nIdx.equal(uint(f))) : acc), bool(false))
  const uv = vec2(select(flip, uvRaw.x.negate(), uvRaw.x), uvRaw.y)
  const aoF = select(ao.equal(uint(0)), float(AO_CURVE[0]!),
    select(ao.equal(uint(1)), float(AO_CURVE[1]!), select(ao.equal(uint(2)), float(AO_CURVE[2]!), float(AO_CURVE[3]!))))

  return {
    position: local.sub(16),
    normal: varying(normal),
    uv: varying(uv),
    layer: varying(layer),
    sky: varying(sky),
    blk: varying(blk),
    ao: varying(aoF),
  }
}

export type ChunkVertex = ReturnType<typeof chunkVertex>
```

- [ ] **Step 5: Implement `voxelLighting.ts`**

`packages/engine/src/render/voxelLighting.ts`:
```ts
import * as THREE from 'three/webgpu'
import { BRDF_Lambert, Fn, diffuseColor, float, max, mix, normalView, positionView, positionWorld, smoothstep, transformNormalToView, uniform, vec3 } from 'three/tsl'

/** Loose TSL node type: three's typings model nodes as one generic object type. */
type N = ReturnType<typeof float>

const WRAP = 0.25
export const AMBIENT_FLOOR = 0.05
/** World-space offset along the face normal for shadow lookups; replaces three's normalBias (chunk geometry has no normal attribute). */
const SHADOW_NORMAL_OFFSET = 0.06

/** Lambert with a soft wrap, the sun gated by sky light, and hemisphere ambient scaled by aoNode (sky light × voxel AO). */
export class VoxelLightingModel extends THREE.LightingModel {
  readonly sky: N
  constructor(sky: N) {
    super()
    this.sky = sky
  }
  direct({ lightDirection, lightColor, reflectedLight }: { lightDirection: N; lightColor: N; reflectedLight: { directDiffuse: N } }): void {
    const ndl = normalView.dot(lightDirection).add(WRAP).div(1 + WRAP).clamp()
    const gate = smoothstep(0.35, 0.95, this.sky)
    reflectedLight.directDiffuse.addAssign(ndl.mul(gate).mul(lightColor).mul(BRDF_Lambert({ diffuseColor: diffuseColor.rgb })))
  }
  indirect(builder: THREE.NodeBuilder): void {
    const { ambientOcclusion, irradiance, reflectedLight } = builder.context as unknown as {
      ambientOcclusion: N; irradiance: N; reflectedLight: { indirectDiffuse: N }
    }
    reflectedLight.indirectDiffuse.addAssign(irradiance.mul(BRDF_Lambert({ diffuseColor })))
    reflectedLight.indirectDiffuse.mulAssign(ambientOcclusion)
  }
}

export class VoxelNodeMaterial extends THREE.MeshLambertNodeMaterial {
  readonly sky: N
  constructor(sky: N) {
    super()
    this.sky = sky
  }
  setupLightingModel(): VoxelLightingModel {
    return new VoxelLightingModel(this.sky)
  }
}

export interface LightUniforms {
  /** Direct-light multiplier inside full shadow: mix(white, atmosphere.shadow.tint, strength). */
  shadowColor: ReturnType<typeof uniform<THREE.Color>>
  torchColor: ReturnType<typeof uniform<THREE.Color>>
  /** Distance from the camera at which shadows have faded out (Deviation 6). */
  shadowFar: ReturnType<typeof uniform<number>>
}

export function createLightUniforms(): LightUniforms {
  return {
    shadowColor: uniform(new THREE.Color(1, 1, 1)),
    torchColor: uniform(new THREE.Color(1, 0.72, 0.42)),
    shadowFar: uniform(210),
  }
}

export interface VoxelSurface { normal: N; sky: N; blk: N; ao: N; albedo: N }

/** Wires the voxel light terms into a material. `normal` is in world space. */
export function voxelLit(m: VoxelNodeMaterial, s: VoxelSurface, lights: LightUniforms): void {
  m.normalNode = transformNormalToView(s.normal)
  m.receivedShadowPositionNode = positionWorld.add(s.normal.mul(SHADOW_NORMAL_OFFSET))
  m.receivedShadowNode = Fn(([shadow]: [N]) => {
    const fade = smoothstep(lights.shadowFar.mul(0.85), lights.shadowFar, positionView.length())
    return mix(lights.shadowColor, vec3(1), max(shadow, fade))
  })
  m.aoNode = s.ao.mul(max(s.sky.pow(1.6), AMBIENT_FLOOR))
  m.emissiveNode = s.albedo.mul(lights.torchColor).mul(s.blk.pow(1.8).mul(1.4))
}
```

If `tsc` rejects a TSL typing here, add the narrowest cast that compiles (`as unknown as N`) rather than loosening the module. Don't change the node graph.

- [ ] **Step 6: Rewrite `materials.ts`**

`packages/engine/src/render/materials.ts`:
```ts
import * as THREE from 'three/webgpu'
import { texture, vec4 } from 'three/tsl'
import { chunkVertex } from './chunkVertex.ts'
import { VoxelNodeMaterial, voxelLit, type LightUniforms } from './voxelLighting.ts'

export interface ChunkMaterials {
  opaque: VoxelNodeMaterial
  cutout: VoxelNodeMaterial
  translucent: VoxelNodeMaterial
}

export function createChunkMaterials(tex: THREE.DataArrayTexture, lights: LightUniforms): ChunkMaterials {
  function build(mode: 'opaque' | 'cutout' | 'translucent'): VoxelNodeMaterial {
    const v = chunkVertex()
    const m = new VoxelNodeMaterial(v.sky)
    m.positionNode = v.position
    const albedo = texture(tex, v.uv).depth(v.layer.add(0.5).toInt())
    voxelLit(m, { normal: v.normal, sky: v.sky, blk: v.blk, ao: v.ao, albedo: albedo.rgb }, lights)
    if (mode === 'opaque') {
      m.colorNode = vec4(albedo.rgb, 1)
    } else if (mode === 'cutout') {
      m.colorNode = albedo
      m.alphaTest = 0.5
      m.side = THREE.DoubleSide
    } else {
      m.colorNode = vec4(albedo.rgb, albedo.a.mul(0.85))
      m.transparent = true
      m.depthWrite = false
    }
    return m
  }
  return { opaque: build('opaque'), cutout: build('cutout'), translucent: build('translucent') }
}
```

If the Task 1 spike recorded a "normal not found" workaround, apply it now in `chunkMeshes.ts` `geometryOf()`, next to the existing `position` alias, with a comment naming three 0.186.1.

- [ ] **Step 7: Wire the engine to the new materials, with temporary lights**

In `packages/engine/src/engine.ts`, add `import { createLightUniforms } from './render/voxelLighting.ts'` and replace the `chunkMeshes` line:
```ts
  const lightUniforms = createLightUniforms()
  const chunkMeshes = new ChunkMeshes(layout, createChunkMaterials(tex.texture, lightUniforms))
  scene.add(chunkMeshes.group)
  // Temporary until Task 5's Visuals: plain lights so the lit chunk materials aren't black.
  const tmpSun = new THREE.DirectionalLight(0xfff1d6, Math.PI * 1.6)
  tmpSun.position.set(0.45, 0.8, 0.35)
  scene.add(tmpSun, new THREE.HemisphereLight(0xa8c8ff, 0x6b5a45, Math.PI * 0.7))
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npm test` and `npm run typecheck`
Expected: all pass.

- [ ] **Step 9: Browser check (controller)**

Run `npm run dev`. Open `http://localhost:5173/?size=256` and `http://localhost:5173/?size=256&webgl` in headed Playwright. Expected on both backends:
- Terrain is lit by face direction: tops bright, sun-facing sides lighter than the far sides. Nothing is black.
- On grass blocks dug into a hole, the green `grass_side` fringe is at the top of **all four** side faces. Planks placed with RMB show boards running the same way on every side.
- A torch placed in a dug pit (cover it with stone) lights its surroundings warmly.
- No console errors, and no new warnings compared to `main`.

- [ ] **Step 10: Commit**

```bash
git add packages/engine/src/render/faceUv.ts packages/engine/src/render/chunkVertex.ts packages/engine/src/render/voxelLighting.ts packages/engine/src/render/materials.ts packages/engine/src/engine.ts packages/engine/test/faceUv.test.ts
git commit -m "feat(engine): lit voxel materials with a custom lighting model; fix mirrored +X/-Z UVs"
```
(Add `packages/engine/src/render/chunkMeshes.ts` if Step 6 applied a spike workaround.)

---

### Task 5: Settings, sun lights, shadows and the `Visuals` module

**Files:**
- Create: `packages/engine/src/render/settings.ts`, `packages/engine/src/render/lighting.ts`, `packages/engine/src/render/visuals.ts`
- Modify: `packages/engine/src/render/chunkMeshes.ts` (shadow flags, `shadowCasterCount`)
- Modify: `packages/engine/src/engine.ts` (delegate rendering to `Visuals`; new API: `atmosphere`, `quality`, `effects`; `shadowCasters` stat; remove Task 4's temporary lights)
- Modify: `packages/engine/src/index.ts` (exports)
- Test: `packages/engine/test/settings.test.ts`

**Interfaces:**
- Consumes:
  - `AtmosphereController`, `Atmosphere`, `Rgb`, `sunDirection`, `sunVisibility` (Task 2)
  - `fitShadow`, `frustumCorners`, `shadowDistance`, `V3` (Task 3)
  - `createChunkMaterials`, `createLightUniforms`, `LightUniforms` (Task 4)
  - `ChunkMeshes` (sub-project 1)
- Produces:
  - `settings.ts` (pure):
    - `type Backend = 'webgpu' | 'webgl'`
    - `interface Quality { shadowMapSize; decorationRadius; decorationMaxInstances; msaa }`, `DEFAULT_QUALITY`, `mergeQuality(cur, input: Partial<Quality>): Quality`
    - `interface Effects { shadows; decorations; water; post; fog: boolean }`, `DEFAULT_EFFECTS`, `mergeEffects(cur, input: Partial<Effects>): Effects`
    - `interface Support { shadows: boolean; waterDepth: boolean }`, `SUPPORT: Record<Backend, Support>`
    - `resolveEffects(requested: Effects, support: Support): { effects: Effects; waterDepth: boolean; warnings: string[] }`
  - `lighting.ts`:
    - `setLinear(c: THREE.Color, rgb: Rgb): THREE.Color`
    - `class SunLights` with `constructor(scene, mapSize)`, `apply(a: Atmosphere)`, `fit(camera, far, minY, maxY, mapSize)`, `setMapSize(n)`, `setEnabled(on)`, `dispose()`, and fields `sun`, `hemi`.
  - `visuals.ts`:
    - `interface VisualsOptions { renderer; scene; camera; backend: Backend; texture: THREE.DataArrayTexture; layout: Layout; viewDistance: () => number }`
    - `class Visuals` with:
      - `atmosphere: AtmosphereController`, `chunks: ChunkMeshes`
      - `getQuality()`, `setQuality(input)`, `getEffects()`, `setEffects(input)`
      - `applyMesh(ci, data: ChunkMeshData)`, `frame(dt)`, `stats(): { shadowCasters: number }`, `dispose()`
  - `chunkMeshes.ts`: `shadowCasterCount: number` getter. Opaque and cutout meshes get `castShadow = true`; every chunk mesh gets `receiveShadow = true`.
  - `Engine`:
    - `readonly atmosphere: AtmosphereController`
    - `get quality(): Quality; set quality(v: Partial<Quality>)`
    - `get effects(): Effects; set effects(v: Partial<Effects>)`
    - `EngineStats.shadowCasters: number`

- [ ] **Step 1: Write the failing settings tests**

`packages/engine/test/settings.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_EFFECTS, DEFAULT_QUALITY, mergeEffects, mergeQuality, resolveEffects } from '../src/render/settings.ts'

describe('quality', () => {
  it('has the spec defaults', () => {
    expect(DEFAULT_QUALITY).toEqual({ shadowMapSize: 2048, decorationRadius: 96, decorationMaxInstances: 400_000, msaa: 4 })
  })
  it('merges a partial update', () => {
    expect(mergeQuality(DEFAULT_QUALITY, { shadowMapSize: 4096 })).toEqual({ ...DEFAULT_QUALITY, shadowMapSize: 4096 })
    expect(mergeQuality(DEFAULT_QUALITY, { msaa: 0, decorationRadius: undefined })).toEqual({ ...DEFAULT_QUALITY, msaa: 0 })
  })
  it('rejects bad values with the field name and keeps the input untouched', () => {
    expect(() => mergeQuality(DEFAULT_QUALITY, { shadowMapSize: 1000 })).toThrow(/quality\.shadowMapSize/)
    expect(() => mergeQuality(DEFAULT_QUALITY, { shadowMapSize: 16384 })).toThrow(RangeError)
    expect(() => mergeQuality(DEFAULT_QUALITY, { decorationRadius: 0 })).toThrow(/quality\.decorationRadius/)
    expect(() => mergeQuality(DEFAULT_QUALITY, { decorationRadius: Number.NaN })).toThrow(RangeError)
    expect(() => mergeQuality(DEFAULT_QUALITY, { decorationMaxInstances: 1.5 })).toThrow(/decorationMaxInstances/)
    expect(() => mergeQuality(DEFAULT_QUALITY, { msaa: 2 })).toThrow(/quality\.msaa/)
    expect(() => mergeQuality(DEFAULT_QUALITY, { lod: 1 } as never)).toThrow(/unknown quality field "lod"/)
    expect(DEFAULT_QUALITY.shadowMapSize).toBe(2048)
  })
})

describe('effects', () => {
  it('defaults everything on and merges booleans', () => {
    expect(DEFAULT_EFFECTS).toEqual({ shadows: true, decorations: true, water: true, post: true, fog: true })
    expect(mergeEffects(DEFAULT_EFFECTS, { fog: false })).toEqual({ ...DEFAULT_EFFECTS, fog: false })
  })
  it('rejects non-booleans and unknown keys', () => {
    expect(() => mergeEffects(DEFAULT_EFFECTS, { fog: 0 as never })).toThrow(/effects\.fog/)
    expect(() => mergeEffects(DEFAULT_EFFECTS, { bloom: true } as never)).toThrow(/unknown effects field "bloom"/)
  })
  it('turns off what the backend cannot do, with one warning each', () => {
    const r = resolveEffects(DEFAULT_EFFECTS, { shadows: false, waterDepth: false })
    expect(r.effects.shadows).toBe(false)
    expect(r.waterDepth).toBe(false)
    expect(r.warnings).toHaveLength(2)
    expect(r.warnings.join(' ')).toMatch(/shadows/)
    expect(r.warnings.join(' ')).toMatch(/water/)
  })
  it('passes requests through on a capable backend', () => {
    const r = resolveEffects({ ...DEFAULT_EFFECTS, shadows: false }, { shadows: true, waterDepth: true })
    expect(r).toEqual({ effects: { ...DEFAULT_EFFECTS, shadows: false }, waterDepth: true, warnings: [] })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/engine -- settings`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `settings.ts`**

`packages/engine/src/render/settings.ts`:
```ts
export type Backend = 'webgpu' | 'webgl'

export interface Quality {
  /** Sun shadow map resolution: a power of two in [256, 8192]. */
  shadowMapSize: number
  /** Blocks from the camera beyond which grass and flowers have shrunk away. */
  decorationRadius: number
  /** Ceiling on visible decoration instances; the nearest chunks win. */
  decorationMaxInstances: number
  /** Post-pipeline MSAA samples: 0 (off) or 4. */
  msaa: number
}
export const DEFAULT_QUALITY: Quality = Object.freeze({ shadowMapSize: 2048, decorationRadius: 96, decorationMaxInstances: 400_000, msaa: 4 })

export interface Effects { shadows: boolean; decorations: boolean; water: boolean; post: boolean; fog: boolean }
export const DEFAULT_EFFECTS: Effects = Object.freeze({ shadows: true, decorations: true, water: true, post: true, fog: true })

export interface Support { shadows: boolean; waterDepth: boolean }
/** What each backend can do, from the Task 1 spike (see "Spike results" in the plan). */
export const SUPPORT: Readonly<Record<Backend, Support>> = Object.freeze({
  webgpu: { shadows: true, waterDepth: true },
  webgl: { shadows: true, waterDepth: true },
})

function checked<T extends object>(name: string, cur: T, input: Partial<T>): Partial<T> {
  if (input === null || typeof input !== 'object') throw new TypeError(`${name} must be an object`)
  const out: Partial<T> = {}
  for (const k of Object.keys(input) as (keyof T & string)[]) {
    if (!(k in cur)) throw new RangeError(`unknown ${name} field "${k}"`)
    if (input[k] !== undefined) out[k] = input[k]
  }
  return out
}

const isPow2 = (n: number) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0

export function mergeQuality(cur: Quality, input: Partial<Quality>): Quality {
  const q = { ...cur, ...checked('quality', cur, input) }
  if (!isPow2(q.shadowMapSize) || q.shadowMapSize < 256 || q.shadowMapSize > 8192) {
    throw new RangeError(`quality.shadowMapSize must be a power of two in [256, 8192], got ${q.shadowMapSize}`)
  }
  if (!Number.isFinite(q.decorationRadius) || q.decorationRadius <= 0 || q.decorationRadius > 512) {
    throw new RangeError(`quality.decorationRadius must be in (0, 512], got ${q.decorationRadius}`)
  }
  if (!Number.isInteger(q.decorationMaxInstances) || q.decorationMaxInstances < 0) {
    throw new RangeError(`quality.decorationMaxInstances must be a non-negative integer, got ${q.decorationMaxInstances}`)
  }
  if (q.msaa !== 0 && q.msaa !== 4) throw new RangeError(`quality.msaa must be 0 or 4, got ${q.msaa}`)
  return Object.freeze(q)
}

export function mergeEffects(cur: Effects, input: Partial<Effects>): Effects {
  const patch = checked('effects', cur, input)
  for (const [k, v] of Object.entries(patch)) if (typeof v !== 'boolean') throw new TypeError(`effects.${k} must be a boolean, got ${String(v)}`)
  return Object.freeze({ ...cur, ...patch })
}

export function resolveEffects(requested: Effects, support: Support): { effects: Effects; waterDepth: boolean; warnings: string[] } {
  const warnings: string[] = []
  let effects = requested
  if (requested.shadows && !support.shadows) {
    effects = { ...effects, shadows: false }
    warnings.push('shadows are not supported on this backend; they are disabled')
  }
  if (!support.waterDepth) warnings.push('water depth effects (shore foam, depth colour) are not supported on this backend; water renders without them')
  return { effects, waterDepth: support.waterDepth, warnings }
}
```

Apply the Task 1 spike results to `SUPPORT` (P3 failing on a backend → `waterDepth: false` there).

Run: `npm test -w @elovox/engine -- settings`
Expected: PASS.

- [ ] **Step 4: Implement `lighting.ts`**

`packages/engine/src/render/lighting.ts`:
```ts
import * as THREE from 'three/webgpu'
import { sunDirection, sunVisibility, type Atmosphere, type Rgb } from './atmosphere.ts'
import { fitShadow, frustumCorners, type V3 } from './shadowFit.ts'

/** three's lookAt degenerates for a vertical light direction. */
const MAX_ELEVATION = 89.5
const forward = new THREE.Vector3()

export function setLinear(c: THREE.Color, rgb: Rgb): THREE.Color {
  return c.setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace)
}

/** The sun (DirectionalLight with one view-fitted shadow map) and the hemisphere ambient, driven by the atmosphere. */
export class SunLights {
  readonly sun = new THREE.DirectionalLight()
  readonly hemi = new THREE.HemisphereLight()
  private readonly scene: THREE.Scene
  private dir: V3 = [0, 1, 0]
  private visible = 1
  private enabled = true

  constructor(scene: THREE.Scene, mapSize: number) {
    this.scene = scene
    const s = this.sun.shadow
    s.mapSize.set(mapSize, mapSize)
    s.radius = 2.5 // soft PCF (Task 1, P5)
    s.bias = -0.0004 // Task 1, P1: replace with the bias recorded in "Spike results"
    s.normalBias = 0 // the materials offset along their own normal instead (voxelLighting.ts)
    scene.add(this.sun, this.sun.target, this.hemi)
  }

  apply(a: Atmosphere): void {
    this.dir = sunDirection(a.sun.azimuth, Math.min(MAX_ELEVATION, a.sun.elevation))
    this.visible = sunVisibility(a.sun.elevation)
    setLinear(this.sun.color, a.sun.color)
    this.sun.intensity = a.sun.intensity * this.visible * Math.PI
    setLinear(this.hemi.color, a.ambient.sky)
    setLinear(this.hemi.groundColor, a.ambient.ground)
    this.hemi.intensity = a.ambient.intensity * Math.PI
    this.sun.castShadow = this.enabled && this.visible > 0
  }

  /** Refits the shadow camera to the view (call every frame shadows are on). */
  fit(camera: THREE.PerspectiveCamera, far: number, minY: number, maxY: number, mapSize: number): void {
    camera.getWorldDirection(forward)
    const p = camera.position
    const corners = frustumCorners([p.x, p.y, p.z], [forward.x, forward.y, forward.z], [0, 1, 0], camera.fov, camera.aspect, camera.near, Math.min(far, camera.far))
    const f = fitShadow(corners, this.dir, mapSize, minY, maxY)
    this.sun.position.set(f.position[0], f.position[1], f.position[2])
    this.sun.target.position.set(f.target[0], f.target[1], f.target[2])
    this.sun.updateMatrixWorld()
    this.sun.target.updateMatrixWorld()
    const c = this.sun.shadow.camera
    c.left = -f.halfSize
    c.right = f.halfSize
    c.top = f.halfSize
    c.bottom = -f.halfSize
    c.near = Math.max(0.5, f.near)
    c.far = f.far
    c.updateProjectionMatrix()
  }

  setMapSize(n: number): void {
    const s = this.sun.shadow
    if (s.mapSize.x === n) return
    s.mapSize.set(n, n)
    s.map?.dispose()
    s.map = null
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.sun.castShadow = on && this.visible > 0
  }

  dispose(): void {
    this.scene.remove(this.sun, this.sun.target, this.hemi)
    this.sun.shadow.dispose()
    this.sun.dispose()
    this.hemi.dispose()
  }
}
```

- [ ] **Step 5: Give chunk meshes their shadow flags**

In `packages/engine/src/render/chunkMeshes.ts`, in `apply()`, after `mesh.raycast = () => {}`:
```ts
      mesh.castShadow = name === 'opaque' || name === 'cutout'
      mesh.receiveShadow = true
```
and add to the class:
```ts
  /** Chunk meshes that render into the sun's shadow map. */
  get shadowCasterCount(): number {
    let n = 0
    for (const m of this.group.children) if ((m as THREE.Mesh).castShadow) n++
    return n
  }
```

- [ ] **Step 6: Implement `visuals.ts`**

`packages/engine/src/render/visuals.ts`:
```ts
import * as THREE from 'three/webgpu'
import type { ChunkMeshData } from '../mesh/mesher.ts'
import type { Layout } from '../world/layout.ts'
import { AtmosphereController, type Atmosphere } from './atmosphere.ts'
import { ChunkMeshes } from './chunkMeshes.ts'
import { SunLights } from './lighting.ts'
import { createChunkMaterials } from './materials.ts'
import {
  DEFAULT_EFFECTS, DEFAULT_QUALITY, SUPPORT, mergeEffects, mergeQuality, resolveEffects,
  type Backend, type Effects, type Quality,
} from './settings.ts'
import { shadowDistance } from './shadowFit.ts'
import { createLightUniforms, type LightUniforms } from './voxelLighting.ts'

export interface VisualsOptions {
  renderer: THREE.WebGPURenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  backend: Backend
  texture: THREE.DataArrayTexture
  layout: Layout
  /** The orbit camera's distance to its target; sets how far shadows reach. */
  viewDistance: () => number
}

/** Everything about how the world looks: lights, shadows, materials, and (in later tasks) sky, post, water, decorations. */
export class Visuals {
  readonly atmosphere = new AtmosphereController()
  readonly chunks: ChunkMeshes
  private readonly o: VisualsOptions
  private readonly lights: LightUniforms
  private readonly sun: SunLights
  private quality: Quality = DEFAULT_QUALITY
  private requested: Effects = DEFAULT_EFFECTS
  private effects: Effects
  private readonly warned = new Set<string>()

  constructor(o: VisualsOptions) {
    this.o = o
    o.renderer.shadowMap.enabled = true
    o.renderer.shadowMap.type = THREE.PCFShadowMap
    this.lights = createLightUniforms()
    this.chunks = new ChunkMeshes(o.layout, createChunkMaterials(o.texture, this.lights))
    o.scene.add(this.chunks.group)
    this.sun = new SunLights(o.scene, this.quality.shadowMapSize)
    this.effects = this.resolve(this.requested)
  }

  getQuality(): Quality { return this.quality }
  setQuality(input: Partial<Quality>): void {
    this.quality = mergeQuality(this.quality, input)
    this.sun.setMapSize(this.quality.shadowMapSize)
  }

  getEffects(): Effects { return this.effects }
  setEffects(input: Partial<Effects>): void {
    this.requested = mergeEffects(this.requested, input)
    this.effects = this.resolve(this.requested)
  }

  applyMesh(ci: number, data: ChunkMeshData): void {
    this.chunks.apply(ci, data)
  }

  frame(dt: number): void {
    if (this.atmosphere.update(dt)) this.applyAtmosphere(this.atmosphere.current)
    const far = shadowDistance(this.o.viewDistance())
    this.lights.shadowFar.value = far
    if (this.effects.shadows) this.sun.fit(this.o.camera, far, 0, this.o.layout.size[1], this.quality.shadowMapSize)
    this.o.renderer.render(this.o.scene, this.o.camera)
  }

  stats(): { shadowCasters: number } {
    return { shadowCasters: this.effects.shadows ? this.chunks.shadowCasterCount : 0 }
  }

  dispose(): void {
    this.o.scene.remove(this.chunks.group)
    this.chunks.dispose()
    this.sun.dispose()
  }

  private applyAtmosphere(a: Atmosphere): void {
    this.sun.apply(a)
    const t = a.shadow.tint, k = a.shadow.strength
    this.lights.shadowColor.value.setRGB(1 + (t[0] - 1) * k, 1 + (t[1] - 1) * k, 1 + (t[2] - 1) * k, THREE.LinearSRGBColorSpace)
  }

  private resolve(requested: Effects): Effects {
    const r = resolveEffects(requested, SUPPORT[this.o.backend])
    for (const w of r.warnings) {
      if (this.warned.has(w)) continue
      this.warned.add(w)
      console.warn(`[elovox] ${w}`)
    }
    this.sun.setEnabled(r.effects.shadows)
    return r.effects
  }
}
```

- [ ] **Step 7: Delegate rendering from the engine**

In `packages/engine/src/engine.ts`:

1. Replace the imports of `ChunkMeshes`, `createChunkMaterials` and `createLightUniforms` with:
```ts
import type { AtmosphereController } from './render/atmosphere.ts'
import type { Effects, Quality } from './render/settings.ts'
import { Visuals } from './render/visuals.ts'
```
2. Add to `EngineStats`: `shadowCasters: number`.
3. Add to `interface Engine`:
```ts
  readonly atmosphere: AtmosphereController
  get quality(): Quality
  set quality(value: Partial<Quality>)
  get effects(): Effects
  set effects(value: Partial<Effects>)
```
4. Replace the Task 4 block (light uniforms, `chunkMeshes`, the temporary lights) with code placed **after** `controls` is created, because `viewDistance` reads it:
```ts
  const visuals = new Visuals({
    renderer, scene, camera, backend, texture: tex.texture, layout,
    viewDistance: () => controls.current.distance,
  })
```
   Move the `highlight` creation below this block if needed; it doesn't depend on the chunk meshes.
5. In `upload()`: `if (queue.accept(r.chunk, r.version)) visuals.applyMesh(r.chunk, r.data)`.
6. In the animation loop, replace `renderer.render(scene, camera)` with `visuals.frame(dt)`.
7. In `dispose()`, replace `scene.remove(chunkMeshes.group, highlight)` and `chunkMeshes.dispose()` with:
```ts
    scene.remove(highlight)
    visuals.dispose()
```
8. In the returned object, add:
```ts
    atmosphere: visuals.atmosphere,
    get quality() { return visuals.getQuality() },
    set quality(value: Partial<Quality>) { visuals.setQuality(value) },
    get effects() { return visuals.getEffects() },
    set effects(value: Partial<Effects>) { visuals.setEffects(value) },
```
   In `stats()`, use `meshes: visuals.chunks.meshCount` and add `shadowCasters: visuals.stats().shadowCasters`.

In `packages/engine/src/index.ts` add:
```ts
export { AtmosphereController, PRESETS, type Atmosphere, type AtmosphereInput, type Rgb } from './render/atmosphere.ts'
export type { Effects, Quality } from './render/settings.ts'
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npm test` and `npm run typecheck`
Expected: all pass.

- [ ] **Step 9: Browser check (controller)**

Open `http://localhost:5173/?size=256` and `?size=256&webgl` in headed Playwright. Expected on both backends:
- Hills cast soft shadows onto the terrain. Shadowed ground is blue-grey, not black.
- Pan with WASD and zoom: shadows stay put on the terrain without shimmering. Zoomed far out, shadows fade out with distance instead of ending in a hard line.
- From the console:
  - `__elovox.engine.atmosphere.set('sunset', { duration: 2 })` swings the light to a low warm sun with long shadows over 2 s.
  - `__elovox.engine.effects = { shadows: false }` removes shadows, and `{ shadows: true }` brings them back.
  - `__elovox.engine.quality = { shadowMapSize: 512 }` makes shadow edges visibly coarser. If it doesn't, three 0.186.1 isn't picking up the new map size. In that case, replace `SunLights.setMapSize`'s body with disposing the old shadow (`this.sun.shadow.dispose()`) and assigning `this.sun.shadow = new THREE.DirectionalLightShadow()` configured like the constructor's, then re-check.
- `__elovox.engine.stats().shadowCasters` is greater than 0.
- No console errors.

- [ ] **Step 10: Commit**

```bash
git add packages/engine/src/render/settings.ts packages/engine/src/render/lighting.ts packages/engine/src/render/visuals.ts packages/engine/src/render/chunkMeshes.ts packages/engine/src/engine.ts packages/engine/src/index.ts packages/engine/test/settings.test.ts
git commit -m "feat(engine): sun and hemisphere lights with view-fitted shadows, Visuals module, quality and effects API"
```

---
### Task 6: Sky and fog

**Files:**
- Create: `packages/engine/src/render/sky.ts`
- Modify: `packages/engine/src/render/visuals.ts` (create the sky, attach it, follow `effects.fog`)
- Modify: `packages/engine/src/engine.ts:123` (drop `scene.background = new THREE.Color(...)`; the sky owns the background)

**Interfaces:**
- Consumes: `Atmosphere`, `sunDirection` (Task 2), `setLinear` (Task 5), and P6/P7 from the spike results.
- Produces: `class Sky` with:
  - `backgroundNode` and `fogNode` (TSL nodes)
  - `apply(a: Atmosphere): void`
  - `attach(scene: THREE.Scene, fogOn: boolean): void`
  - `detach(scene: THREE.Scene): void`

**Shading** (spec §5):
- **Gradient:** `mix(horizon, zenith, max(dir.y, 0)^0.55)`. `dir` comes from `normalWorldGeometry` (the background sphere's normal; spike P6).
- **Sun:** a halo `sunColor × (dir·sun)^48 × sunGlow`, plus a disc `smoothstep(0.9995, 0.9999, dir·sun) × 3`.
- **Clouds:** the view ray hits the plane `y = 300`. That point plus wind (`time × speed` along +x), divided by `scale`, samples a 4-octave fBm `n`. `density = smoothstep(1 − coverage, 1 − coverage + 0.12, n)`, faded out below `dir.y` 0.2. Shading is two-tone: a second sample shifted towards the sun gives `lit = smoothstep(−0.02, 0.06, n − n₂)`, so cloud colour = `mix(shade, light, lit)`.
- **Flat backdrop:** `mix(horizon, zenith, screenUp)`, where `screenUp` is 1 at the top of the screen (spike P7). The output is `mix(flat, dome, sky.dome)`.
- **Fog factor:** `(1 − e^(−4d²)) × e^(−heightFalloff × y)`, with `d = max(0, (dist − near) / (far − near))`.
- **Fog colour:** `mix(fog.color, horizon, followHorizon)`, warmed by `sunColor × 1.4` with weight `0.5 × max(view·sun, 0)^6`.

- [ ] **Step 1: Implement `sky.ts`**

`packages/engine/src/render/sky.ts`:
```ts
import * as THREE from 'three/webgpu'
import {
  cameraPosition, dot, float, fog, mix, mx_fractal_noise_float, normalWorldGeometry, positionView, positionWorld,
  screenUV, smoothstep, time, uniform, vec2, vec3,
} from 'three/tsl'
import { sunDirection, type Atmosphere } from './atmosphere.ts'
import { setLinear } from './lighting.ts'

const CLOUD_ALTITUDE = 300

/** Sky dome / flat backdrop (scene.backgroundNode) and atmospheric fog (scene.fogNode), both driven by the atmosphere. */
export class Sky {
  private readonly u = {
    zenith: uniform(new THREE.Color()),
    horizon: uniform(new THREE.Color()),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
    sunColor: uniform(new THREE.Color()),
    sunGlow: uniform(0),
    dome: uniform(1),
    coverage: uniform(0.4),
    cloudScale: uniform(400),
    cloudSpeed: uniform(4),
    cloudLight: uniform(new THREE.Color()),
    cloudShade: uniform(new THREE.Color()),
    fogColor: uniform(new THREE.Color()),
    fogFollow: uniform(1),
    fogNear: uniform(100),
    fogFar: uniform(800),
    fogHeight: uniform(0.01),
  }
  readonly backgroundNode
  readonly fogNode

  constructor() {
    const u = this.u
    const dir = normalWorldGeometry.normalize()
    const gradient = mix(u.horizon, u.zenith, dir.y.max(0).pow(0.55))
    const sd = dot(dir, u.sunDir).max(0)
    const glow = u.sunColor.mul(sd.pow(48).mul(u.sunGlow).add(smoothstep(0.9995, 0.9999, sd).mul(3)))
    const t = float(CLOUD_ALTITUDE).sub(cameraPosition.y).div(dir.y.max(0.03))
    const p = cameraPosition.xz.add(dir.xz.mul(t)).add(vec2(time.mul(u.cloudSpeed), 0)).div(u.cloudScale)
    const n = mx_fractal_noise_float(vec3(p, 0), 4, 2, 0.5).mul(0.5).add(0.5)
    const n2 = mx_fractal_noise_float(vec3(p.add(u.sunDir.xz.mul(0.06)), 0), 4, 2, 0.5).mul(0.5).add(0.5)
    const edge = float(1).sub(u.coverage)
    const density = smoothstep(edge, edge.add(0.12), n).mul(smoothstep(0.03, 0.2, dir.y))
    const cloud = mix(u.cloudShade, u.cloudLight, smoothstep(-0.02, 0.06, n.sub(n2)))
    const dome = mix(gradient.add(glow), cloud, density)
    // Spike P7: use screenUV.y if it is 1 at the top of the screen on both backends, else screenUV.y.oneMinus().
    const screenUp = screenUV.y.oneMinus()
    const flat = mix(u.horizon, u.zenith, screenUp)
    this.backgroundNode = mix(flat, dome, u.dome)

    const dist = positionView.length()
    const d = dist.sub(u.fogNear).div(u.fogFar.sub(u.fogNear)).max(0)
    const factor = float(1).sub(d.mul(d).mul(-4).exp()).mul(positionWorld.y.mul(u.fogHeight).negate().exp()).clamp(0, 1)
    const view = positionWorld.sub(cameraPosition).normalize()
    const base = mix(u.fogColor, u.horizon, u.fogFollow)
    const warm = mix(base, base.mul(u.sunColor).mul(1.4), dot(view, u.sunDir).max(0).pow(6).mul(0.5))
    this.fogNode = fog(warm, factor)
  }

  apply(a: Atmosphere): void {
    const u = this.u
    setLinear(u.zenith.value, a.sky.zenith)
    setLinear(u.horizon.value, a.sky.horizon)
    const [x, y, z] = sunDirection(a.sun.azimuth, a.sun.elevation)
    u.sunDir.value.set(x, y, z)
    setLinear(u.sunColor.value, a.sun.color)
    u.sunGlow.value = a.sky.sunGlow
    u.dome.value = a.sky.dome
    u.coverage.value = a.sky.clouds.coverage
    u.cloudScale.value = a.sky.clouds.scale
    u.cloudSpeed.value = a.sky.clouds.speed
    setLinear(u.cloudLight.value, a.sky.clouds.light)
    setLinear(u.cloudShade.value, a.sky.clouds.shade)
    setLinear(u.fogColor.value, a.fog.color)
    u.fogFollow.value = a.fog.followHorizon
    u.fogNear.value = a.fog.near
    u.fogFar.value = a.fog.far
    u.fogHeight.value = a.fog.heightFalloff
  }

  attach(scene: THREE.Scene, fogOn: boolean): void {
    scene.background = null
    scene.backgroundNode = this.backgroundNode
    scene.fogNode = fogOn ? this.fogNode : null
  }

  detach(scene: THREE.Scene): void {
    scene.backgroundNode = null
    scene.fogNode = null
  }
}
```

Set `screenUp` from spike result P7 before continuing.

- [ ] **Step 2: Wire the sky into `Visuals`**

In `packages/engine/src/render/visuals.ts`:
- Import `Sky` and add a field `private readonly sky = new Sky()`.
- In the constructor, after `this.effects = this.resolve(...)`: `this.sky.attach(o.scene, this.effects.fog)`.
- In `setEffects`, after resolving: `this.sky.attach(this.o.scene, this.effects.fog)`.
- In `applyAtmosphere`: `this.sky.apply(a)`.
- In `dispose`: `this.sky.detach(this.o.scene)`.

In `packages/engine/src/engine.ts`, delete `scene.background = new THREE.Color(0xdfe3e6)`.

- [ ] **Step 3: Run tests and typecheck**

Run: `npm test` and `npm run typecheck`
Expected: all pass.

- [ ] **Step 4: Browser check (controller)**

Open `http://localhost:5173/?size=1024` (WebGPU) and `?size=256&webgl`. Expected:
- `open` (the default): a blue gradient sky that is paler at the horizon, white clouds with soft shaded undersides that drift slowly, and a sun glow towards the sun's azimuth.
- Distant terrain fades into the pale horizon colour (blue haze). Valleys look hazier than ridges.
- `__elovox.engine.atmosphere.set('diorama')`: the background becomes a flat light blue-grey gradient (lighter at the bottom), with no clouds, sun disc or visible fog.
- `__elovox.engine.atmosphere.set('sunset', { duration: 2 })`: the sky turns pink/orange and the fog warms.
- `__elovox.engine.effects = { fog: false }` removes the haze; `{ fog: true }` restores it.
- No console errors.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/render/sky.ts packages/engine/src/render/visuals.ts packages/engine/src/engine.ts
git commit -m "feat(engine): procedural sky with painted clouds and atmospheric height fog"
```

---

### Task 7: Post-processing

**Files:**
- Create: `packages/engine/src/render/post.ts`
- Modify: `packages/engine/src/render/visuals.ts` (tone mapping, pipeline, `effects.post`, `quality.msaa`)

**Interfaces:**
- Consumes: `Atmosphere` (Task 2), `setLinear` (Task 5).
- Produces:
  - `TONE_MAPPING` (`THREE.AgXToneMapping`, revisited at Checkpoint 1)
  - `class PostPipeline` with `constructor(renderer, scene, camera, samples: number)`, `apply(a: Atmosphere)`, `setSamples(n: number)`, `render()`, `dispose()`.

**Grading** (linear space, before tone mapping):
- `c = scene × exposure`
- `luma = c · (0.2126, 0.7152, 0.0722)`
- `sat = mix(luma, c, saturation)`
- `con = max(0, (sat − 0.18) × contrast + 0.18)`
- `out = con × mix(shadows, highlights, smoothstep(0.05, 0.8, luma))`

The `RenderPipeline` output then applies the renderer's tone mapping and output colour space. When `effects.post` is off, `renderer.render()` applies the same tone mapping without grading.

- [ ] **Step 1: Implement `post.ts`**

`packages/engine/src/render/post.ts`:
```ts
import * as THREE from 'three/webgpu'
import { dot, mix, pass, smoothstep, uniform, vec3, vec4 } from 'three/tsl'
import type { Atmosphere } from './atmosphere.ts'
import { setLinear } from './lighting.ts'

/** Tone mapping operator: AgX or Neutral, whichever keeps greens vivid without clipping (picked at Checkpoint 1). */
export const TONE_MAPPING = THREE.AgXToneMapping

/** Scene pass (with MSAA) → colour grading; the pipeline output then applies the renderer's tone mapping. */
export class PostPipeline {
  private readonly renderer: THREE.WebGPURenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.Camera
  private samples: number
  private pipeline: THREE.RenderPipeline
  private readonly u = {
    exposure: uniform(1),
    saturation: uniform(1),
    contrast: uniform(1),
    highlights: uniform(new THREE.Color(1, 1, 1)),
    shadows: uniform(new THREE.Color(1, 1, 1)),
  }

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, samples: number) {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera
    this.samples = samples
    this.pipeline = this.build()
  }

  apply(a: Atmosphere): void {
    this.u.exposure.value = a.grade.exposure
    this.u.saturation.value = a.grade.saturation
    this.u.contrast.value = a.grade.contrast
    setLinear(this.u.highlights.value, a.grade.highlights)
    setLinear(this.u.shadows.value, a.grade.shadows)
  }

  setSamples(n: number): void {
    if (n === this.samples) return
    this.samples = n
    this.pipeline.dispose()
    this.pipeline = this.build()
  }

  render(): void { this.pipeline.render() }

  dispose(): void { this.pipeline.dispose() }

  private build(): THREE.RenderPipeline {
    const p = new THREE.RenderPipeline(this.renderer)
    const scenePass = pass(this.scene, this.camera, { samples: this.samples })
    const u = this.u
    const c = scenePass.rgb.mul(u.exposure)
    const luma = dot(c, vec3(0.2126, 0.7152, 0.0722))
    const sat = mix(vec3(luma), c, u.saturation)
    const con = sat.sub(0.18).mul(u.contrast).add(0.18).max(0)
    const tint = mix(u.shadows, u.highlights, smoothstep(0.05, 0.8, luma))
    p.outputNode = vec4(con.mul(tint), 1)
    return p
  }
}
```

- [ ] **Step 2: Wire the pipeline into `Visuals`**

In `packages/engine/src/render/visuals.ts`:
- Import `PostPipeline` and `TONE_MAPPING`, and add a field `private readonly post: PostPipeline`.
- In the constructor, before creating the sky: `o.renderer.toneMapping = TONE_MAPPING` and `this.post = new PostPipeline(o.renderer, o.scene, o.camera, this.quality.msaa)`.
- In `setQuality`, after merging: `this.post.setSamples(this.quality.msaa)`.
- In `applyAtmosphere`: `this.post.apply(a)`.
- In `frame`, replace `this.o.renderer.render(this.o.scene, this.o.camera)` with:
```ts
    if (this.effects.post) this.post.render()
    else this.o.renderer.render(this.o.scene, this.o.camera)
```
- In `dispose`: `this.post.dispose()`.

- [ ] **Step 3: Run tests and typecheck**

Run: `npm test` and `npm run typecheck`
Expected: all pass.

- [ ] **Step 4: Browser check (controller)**

Open `?size=1024` (WebGPU) and `?size=256&webgl`. Expected:
- Colours are richer than before the task (compare against `__elovox.engine.effects = { post: false }`), and highlights roll off instead of clipping to white.
- Edges are antialiased with post on. `__elovox.engine.quality = { msaa: 0 }` shows jagged edges; `{ msaa: 4 }` restores the antialiasing.
- No console errors.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/render/post.ts packages/engine/src/render/visuals.ts
git commit -m "feat(engine): post pipeline with colour grading, tone mapping and MSAA"
```

---

### Task 8: Sandbox scenes, diorama and HUD controls (Checkpoint 1)

**Files:**
- Create: `apps/sandbox/vitest.config.ts`, `apps/sandbox/src/scenes/diorama.ts`, `apps/sandbox/src/diorama.worker.ts`, `apps/sandbox/src/controls.ts`, `apps/sandbox/test/diorama.test.ts`
- Modify: `apps/sandbox/package.json` (test script, vitest), `apps/sandbox/tsconfig.json` (include `test`, `vitest.config.ts`), `package.json` (root `test` runs every workspace)
- Modify: `apps/sandbox/src/main.ts` (`?scene=`), `apps/sandbox/src/blocks.ts` (`rock`), `apps/sandbox/src/textures.ts` (temporary `rock` tile), `apps/sandbox/src/hud.ts` (scene name)

**Interfaces:**
- Consumes:
  - `defineGenerator`, `runSimWorker` (`@elovox/engine/sim-worker`)
  - `packVoxel` (`@elovox/engine/src/world/voxel.ts`)
  - `fbm2` (`@elovox/engine/src/sim/generator.ts`, tests only)
  - `engine.atmosphere`, `engine.effects`, `engine.controls` (Task 5)
- Produces:
  - `scenes/diorama.ts`:
    - `type DioramaBlock = 'stone' | 'dirt' | 'grass' | 'sand' | 'water' | 'log' | 'leaves' | 'rock'`
    - `DIORAMA_SIZE = [128, 64, 128]`, `LOW = 22`, `HIGH = 42`
    - `dioramaColumn(x, z, noise: (x: number, z: number) => number): (DioramaBlock | null)[]`: 64 entries, index = y.
    - `dioramaGenerator`
  - `controls.ts`: `createControls(engine: Engine): () => void`. It renders buttons `#preset-<name>` and checkboxes `#fx-<effect>`.

The diorama follows the primary reference:
- The upper terrace is at y 42 behind a wavy cliff line (z ≈ 58). It holds a lake (sand bed, sand shore), an islet, and an arch on the back rim.
- The lower meadow is at y 22. It holds a pond, bare stepped stone ruins on the left, two sand mounds and rocks.
- There are three voxel trees. Under grass the dirt is 5 deep on the upper terrace and 3 deep on the lower one, with stone below.

- [ ] **Step 1: Set up Vitest in the sandbox**

`apps/sandbox/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node' } })
```

In `apps/sandbox/package.json`, add `"test": "vitest run"` to `scripts` and `"vitest": "4.1.11"` to `devDependencies`. In `apps/sandbox/tsconfig.json`, set `"include": ["src", "test", "e2e", "vite.config.ts", "vitest.config.ts", "playwright.config.ts"]`. In the root `package.json`, set `"test": "npm run test --workspaces --if-present"`. Then run `npm install` from the root, so the lockfile picks up the new devDependency.

- [ ] **Step 2: Write the failing diorama tests**

`apps/sandbox/test/diorama.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { fbm2 } from '@elovox/engine/src/sim/generator.ts'
import { DIORAMA_SIZE, HIGH, LOW, dioramaColumn } from '../src/scenes/diorama.ts'

const noise = (x: number, z: number) => fbm2(1234, x, z, 3)
const topOf = (col: (string | null)[]) => { for (let y = col.length - 1; y >= 0; y--) if (col[y] !== null) return y; return -1 }

describe('dioramaColumn', () => {
  it('fills a full-height column with stone at the bottom', () => {
    const col = dioramaColumn(50, 20, noise)
    expect(col).toHaveLength(DIORAMA_SIZE[1])
    expect(col[0]).toBe('stone')
  })
  it('puts a grass meadow with dirt under it on the lower terrace', () => {
    const col = dioramaColumn(50, 20, noise)
    const y = topOf(col)
    expect(col[y]).toBe('grass')
    expect(col[y - 1]).toBe('dirt')
    expect(Math.abs(y - LOW)).toBeLessThanOrEqual(1)
  })
  it('holds a lake on the upper terrace and a pond on the lower one', () => {
    const lake = dioramaColumn(64, 92, noise)
    expect(lake[topOf(lake)]).toBe('water')
    expect(lake.filter((b) => b === 'water').length).toBe(5)
    expect(topOf(lake)).toBeLessThan(HIGH)
    const pond = dioramaColumn(70, 28, noise)
    expect(pond.filter((b) => b === 'water').length).toBe(3)
  })
  it('grows a tree with a trunk and a leaf canopy around it', () => {
    expect(dioramaColumn(18, 84, noise)).toContain('log')
    expect(dioramaColumn(19, 84, noise)).toContain('leaves')
  })
  it('cuts an arch: air under solid ground on the back rim', () => {
    const col = dioramaColumn(46, 120, noise)
    const hole = col.findIndex((b, y) => b === null && y < topOf(col))
    expect(hole).toBeGreaterThan(0)
  })
  it('is deterministic', () => {
    expect(dioramaColumn(33, 77, noise)).toEqual(dioramaColumn(33, 77, noise))
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w @elovox/sandbox`
Expected: FAIL (`../src/scenes/diorama.ts` not found).

- [ ] **Step 4: Implement the diorama generator**

`apps/sandbox/src/scenes/diorama.ts`:
```ts
import { defineGenerator } from '@elovox/engine/sim-worker'
import { packVoxel } from '@elovox/engine/src/world/voxel.ts'

export type DioramaBlock = 'stone' | 'dirt' | 'grass' | 'sand' | 'water' | 'log' | 'leaves' | 'rock'
export const DIORAMA_SIZE = [128, 64, 128] as const
export const LOW = 22
export const HIGH = 42

type Noise = (x: number, z: number) => number // [0, 1)

const TREES = [{ x: 18, z: 84, base: HIGH + 1 }, { x: 112, z: 70, base: HIGH + 1 }, { x: 44, z: 40, base: LOW + 1 }]
const ROCKS = [{ x: 56, y: LOW + 1, z: 12, r: 2.6 }, { x: 116, y: HIGH + 1, z: 104, r: 3.2 }, { x: 86, y: LOW + 1, z: 50, r: 2.2 }]
const MOUNDS = [{ x: 100, z: 16, r: 9, h: 6 }, { x: 98, z: 46, r: 7, h: 8 }]

/** < 1 inside a noisy-edged ellipse. */
function ellipse(x: number, z: number, cx: number, cz: number, rx: number, rz: number, noise: Noise): number {
  return Math.hypot((x - cx) / rx, (z - cz) / rz) * (0.92 + noise(x / 8 + 11, z / 8) * 0.16)
}

/** The diorama's blocks for one column, bottom to top (index = y). Pure: the same (x, z, noise) gives the same column. */
export function dioramaColumn(x: number, z: number, noise: Noise): (DioramaBlock | null)[] {
  const col: (DioramaBlock | null)[] = new Array<DioramaBlock | null>(DIORAMA_SIZE[1]).fill(null)
  const upper = z >= 58 + Math.round((noise(x / 11, 3.7) - 0.5) * 10)
  let top = (upper ? HIGH : LOW) + Math.round((noise(x / 13, z / 13) - 0.5) * 2)
  let surface: DioramaBlock = 'grass'
  let water = 0

  if (!upper && x < 34 && z < 52) {
    const n = noise(x / 6 + 40, z / 6)
    if (n > 0.5) { top = LOW + 1 + Math.floor((n - 0.5) * 22); surface = 'stone' }
  }
  if (upper) {
    const lake = ellipse(x, z, 64, 92, 38, 21, noise)
    if (lake < 1) { water = 5; top = HIGH - 6; surface = 'sand' } else if (lake < 1.15) { top = HIGH - 1; surface = 'sand' }
    if (Math.hypot(x - 90, z - 98) < 4.5) { water = 0; top = HIGH - 1; surface = 'grass' }
  } else {
    const pond = ellipse(x, z, 70, 28, 15, 9, noise)
    if (pond < 1) { water = 3; top = LOW - 4; surface = 'sand' } else if (pond < 1.18 && surface === 'grass') surface = 'sand'
  }

  const dirtDepth = upper ? 5 : 3
  for (let y = 0; y <= top; y++) {
    if (y === top) col[y] = surface
    else if (surface === 'grass' && y > top - dirtDepth) col[y] = 'dirt'
    else if (surface === 'sand' && y === top - 1) col[y] = 'sand'
    else col[y] = 'stone'
  }
  for (let y = top + 1; y <= top + water; y++) col[y] = 'water'

  if (upper && z >= 116 && x >= 36 && x <= 56) {
    const base = HIGH - 9
    for (let y = base; y <= HIGH; y++) {
      const ax = (x - 46) / 9, ay = (y - base) / 7
      if (ax * ax + ay * ay < 1) col[y] = null
    }
  }
  if (!upper) {
    for (const m of MOUNDS) {
      const d = Math.hypot(x - m.x, z - m.z) / m.r
      if (d >= 1) continue
      const h = Math.floor(m.h * (1 - d * d))
      for (let y = top + 1; y <= top + h; y++) col[y] = 'sand'
    }
  }
  for (const r of ROCKS) {
    for (let y = 0; y < col.length; y++) {
      if ((x - r.x) ** 2 + ((y - r.y) * 1.3) ** 2 + (z - r.z) ** 2 < r.r * r.r) col[y] = 'rock'
    }
  }
  for (const t of TREES) {
    if (x === t.x && z === t.z) for (let y = top + 1; y <= t.base + 4; y++) col[y] = 'log'
    const cy = t.base + 5
    for (let y = cy - 3; y <= cy + 3; y++) {
      if (col[y] === null && Math.hypot(x - t.x, (y - cy) * 1.2, z - t.z) < 3.2) col[y] = 'leaves'
    }
  }
  return col
}

export const dioramaGenerator = defineGenerator({
  generateColumn(ctx, cx, cz) {
    const ids: Record<DioramaBlock, number> = {
      stone: ctx.id('stone'), dirt: ctx.id('dirt'), grass: ctx.id('grass'), sand: ctx.id('sand'),
      water: packVoxel(ctx.id('water'), 7), log: ctx.id('log'), leaves: ctx.id('leaves'), rock: ctx.id('rock'),
    }
    const noise: Noise = (x, z) => ctx.fbm2(x, z, 3)
    for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
      const col = dioramaColumn(cx * 32 + lx, cz * 32 + lz, noise)
      for (let y = 0; y < col.length; y++) {
        const b = col[y]
        if (b) ctx.set(lx, y, lz, ids[b])
      }
    }
  },
})
```

`apps/sandbox/src/diorama.worker.ts`:
```ts
import { runSimWorker } from '@elovox/engine/sim-worker'
import rules from './rules.ts'
import { dioramaGenerator } from './scenes/diorama.ts'

runSimWorker({ rules, generator: dioramaGenerator })
```

Run: `npm test -w @elovox/sandbox`
Expected: PASS. If a test fails because noise moves a feature (the cliff line, a jittered top), fix the generator so the spec'd feature is there. Don't weaken the test.

- [ ] **Step 5: Add the rock block and a temporary rock tile**

In `apps/sandbox/src/blocks.ts`, append `defineBlock({ name: 'rock', textures: 'rock' })`.

In `apps/sandbox/src/textures.ts`, add to the returned map (Task 15 replaces it):
```ts
    rock: tile(13, (c, r) => speckle(c, r, '#8a8f99', ['#7b808a', '#9aa0aa', '#6f7580'], 90, 9)),
```

- [ ] **Step 6: Write the HUD controls**

`apps/sandbox/src/controls.ts`:
```ts
import type { Effects, Engine } from '@elovox/engine'

const EFFECTS: (keyof Effects)[] = ['shadows', 'decorations', 'water', 'post', 'fog']

/** Preset buttons and per-effect toggles, top right. */
export function createControls(engine: Engine): () => void {
  const el = document.createElement('div')
  el.id = 'controls'
  Object.assign(el.style, {
    position: 'fixed', top: '12px', right: '12px', padding: '10px 12px', borderRadius: '8px', display: 'grid', gap: '6px',
    background: 'rgba(255, 255, 255, 0.82)', color: '#1b1f24', font: '12px/1.4 ui-monospace, Menlo, Consolas, monospace', zIndex: '5',
  })
  const presets = document.createElement('div')
  presets.style.display = 'flex'
  presets.style.gap = '4px'
  for (const name of engine.atmosphere.presetNames()) {
    const b = document.createElement('button')
    b.id = `preset-${name}`
    b.textContent = name
    b.addEventListener('click', () => engine.atmosphere.set(name, { duration: 1.5 }))
    presets.append(b)
  }
  el.append(presets)
  for (const fx of EFFECTS) {
    const label = document.createElement('label')
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.id = `fx-${fx}`
    box.checked = engine.effects[fx]
    box.addEventListener('change', () => { engine.effects = { [fx]: box.checked } })
    label.append(box, ` ${fx}`)
    el.append(label)
  }
  document.body.append(el)
  return () => el.remove()
}
```

- [ ] **Step 7: Scene selection in `main.ts`**

In `apps/sandbox/src/main.ts`:
- Add `import { createControls } from './controls.ts'` and `import { DIORAMA_SIZE } from './scenes/diorama.ts'`.
- After `const params = ...`: `const sceneName = params.get('scene') === 'diorama' ? 'diorama' : 'world'`.
- Replace the `size` and `simWorker` options:
```ts
  size: sceneName === 'diorama' ? [...DIORAMA_SIZE] : [n, 128, n],
  simWorker: sceneName === 'diorama'
    ? () => new Worker(new URL('./diorama.worker.ts', import.meta.url), { type: 'module' })
    : () => new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' }),
```
- After `createEngine` resolves:
```ts
engine.atmosphere.set(sceneName === 'diorama' ? 'diorama' : 'open')
if (sceneName === 'diorama') {
  for (const s of [engine.controls.goal, engine.controls.current]) {
    s.target[0] = 64; s.target[1] = 30; s.target[2] = 64
    s.distance = 150
    s.pitch = 0.7
  }
}
createControls(engine)
```
- Make the hotbar `['stone', 'dirt', 'grass', 'sand', 'planks', 'log', 'leaves', 'rock', 'torch', 'glass']` and map key `0` to the 10th entry: `const k = e.key === '0' ? 10 : Number(e.key)`.

In `apps/sandbox/src/hud.ts`, change `createHud(engine, getSelected)` to `createHud(engine, getSelected, sceneName: string)` and prefix the first line with `` `[${sceneName}] ` ``. Update the call in `main.ts`.

- [ ] **Step 8: Run tests and typecheck**

Run: `npm test` (both workspaces now) and `npm run typecheck`
Expected: all pass.

- [ ] **Step 9: Browser check and Checkpoint 1 (controller)**

Open `http://localhost:5173/?scene=diorama` and `?scene=diorama&webgl`, then `?size=1024` and `?size=256&webgl`. Expected:
- The diorama shows two terraces, a lake on the upper one, a pond below, the stone ruins, sand mounds, an arch on the back rim, trees and rocks, all lit and shadowed, against the light `diorama` backdrop. Water still uses the old translucent tile (Task 10 adds the water material).
- The preset buttons transition smoothly. Unticking each effect removes it and ticking restores it (`decorations` and `water` do nothing yet).
- **Tone mapping:** compare `THREE.AgXToneMapping` against `THREE.NeutralToneMapping` by editing `TONE_MAPPING` in `post.ts` and reloading. Keep the one whose greens stay vivid without clipping, and record the choice in "Spike results".
- **C11:** at a grazing angle across a large flat area, distant textures are smooth (mipmapped) and not shimmering, and `__elovox.engine.renderer.getMaxAnisotropy()` is greater than 1 on both backends. Record the result.
- No console errors.

**Checkpoint 1:** save screenshots of the diorama (`diorama` preset) and the 1024 world (`open` and `sunset`) on WebGPU. Ask the user for a visual review of light, shadow, sky, fog and grading. Commit any tuning the user asks for (preset values in `atmosphere.ts`, light curves in `voxelLighting.ts`) as `tune(engine): …` commits before Task 9.

- [ ] **Step 10: Commit**

```bash
git add apps/sandbox package.json package-lock.json
git commit -m "feat(sandbox): diorama scene, scene switch, preset and effect controls, sandbox unit tests"
```

---
### Task 9: Liquid render layer

**Files:**
- Modify: `packages/engine/src/blocks/registry.ts` (`'liquid'` layer, default for liquids, validation)
- Modify: `packages/engine/src/mesh/liquid.ts` (liquid faces go to their own builder)
- Modify: `packages/engine/src/mesh/mesher.ts` (`liquid` layer in `ChunkMeshData`)
- Modify: `packages/engine/src/mesh/meshJob.ts` (`EMPTY`), `packages/engine/src/mesh/mesh.worker.ts` (transfer the liquid buffers)
- Modify: `packages/engine/src/render/materials.ts` (a `liquid` material), `packages/engine/src/render/chunkMeshes.ts` (4 layers, `renderOrder`, `setLayerMaterial`)
- Test: `packages/engine/test/registry.test.ts`, `packages/engine/test/liquid.test.ts`, `packages/engine/test/meshJob.test.ts`

**Interfaces:**
- Produces:
  - `RenderLayer = 'opaque' | 'cutout' | 'translucent' | 'liquid'` and `LAYER.LIQUID = 4`.
  - `meshTranslucent(s, t, translucent: QuadBuilder, liquid: QuadBuilder): void`. Faces of `LAYER.LIQUID` blocks go to `liquid`; faces of `LAYER.TRANSLUCENT` blocks go to `translucent`. Liquid heights still apply to any `liquid: true` block.
  - `ChunkMeshData` gains `liquid: LayerMesh | null`.
  - `ChunkMaterials` gains `liquid: VoxelNodeMaterial` (the translucent tile material, until Task 10's water).
  - `ChunkMeshes.setLayerMaterial(layer: 'liquid', material: THREE.Material): void`. Liquid meshes get `renderOrder = 1`, so they draw after glass.

- [ ] **Step 1: Update the tests first**

In `packages/engine/test/registry.test.ts`, change the liquid layer expectation and add a validation test:
```ts
    expect(r.layer[ID.water]).toBe(LAYER.LIQUID) // liquids default to the liquid layer
```
```ts
  it('only allows the liquid layer on liquid blocks', () => {
    expect(() => new BlockRegistry([defineBlock({ name: 'goo', layer: 'liquid' })])).toThrow(/block "goo": layer "liquid" needs liquid: true/)
    const r = new BlockRegistry([defineBlock({ name: 'syrup', liquid: true, layer: 'translucent' })])
    expect(r.layer[r.id('syrup')]).toBe(LAYER.TRANSLUCENT)
  })
```

Replace `packages/engine/test/liquid.test.ts` with:
```ts
import { describe, expect, it } from 'vitest'
import { liquidHeight, meshTranslucent } from '../src/mesh/liquid.ts'
import { Mesher, meshChunk } from '../src/mesh/mesher.ts'
import { QuadBuilder } from '../src/mesh/quadBuilder.ts'
import { FACE, unpackA } from '../src/mesh/vertexFormat.ts'
import type { ChunkSnapshot } from '../src/world/reader.ts'
import { packVoxel } from '../src/world/voxel.ts'
import { ID } from './helpers.ts'
import { assertOutwardWinding, countByNormal, emptySnap, meshTables, put } from './meshHelpers.ts'

const tables = meshTables()
const water = (level: number) => packVoxel(ID.water, level)
function both(s: ChunkSnapshot) {
  const t = new QuadBuilder(), l = new QuadBuilder()
  meshTranslucent(s, tables, t, l)
  return { translucent: t, liquid: l }
}
/** Liquid-layer output (water). */
function mesh(s: ChunkSnapshot) {
  const { liquid } = both(s)
  return { m: liquid.build(), n: liquid.quadCount }
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
  it('meshes a lone full cell as 6 faces with a lowered top, in the liquid layer only', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, water(7))
    const { translucent } = both(s)
    const { m, n } = mesh(s)
    expect(n).toBe(6)
    expect(translucent.quadCount).toBe(0)
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
    let checked = 0
    for (let i = 0; i < m!.vertices.length; i += 2) {
      const a = unpackA(m!.vertices[i]!)
      if (a.normal === FACE.PX && a.y === 5) {
        expect(a.drop).toBe(0)
        checked++
      }
    }
    expect(checked).toBe(4)
  })
  it('averages shared corners between neighbouring cells', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, water(7))
    put(s, 5, 4, 4, water(3))
    expect(mesh(s).n).toBe(10)
    expect(topDrops(s)).toContain(5) // (8/9 + 4/9) / 2 → drop round(16/3) = 5
  })
  it('culls water faces against opaque blocks', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, water(7))
    put(s, 5, 4, 4, ID.stone)
    expect(mesh(s).n).toBe(5)
  })
  it('meshes glass per face in the translucent layer and culls between glass blocks', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, ID.glass)
    put(s, 5, 4, 4, ID.glass)
    const { translucent, liquid } = both(s)
    expect(translucent.quadCount).toBe(10)
    expect(liquid.quadCount).toBe(0)
    assertOutwardWinding(translucent.build())
  })
})

describe('Mesher', () => {
  it('fills all four layers and reuses its buffers', () => {
    const s = emptySnap()
    put(s, 1, 1, 1, ID.stone)
    put(s, 3, 1, 1, ID.torch)
    put(s, 5, 1, 1, water(7))
    put(s, 7, 1, 1, ID.glass)
    const mesher = new Mesher()
    const a = mesher.mesh(s, tables)
    expect(a.opaque).not.toBeNull()
    expect(a.cutout).not.toBeNull()
    expect(a.translucent).not.toBeNull()
    expect(a.liquid).not.toBeNull()
    const b = mesher.mesh(emptySnap(), tables)
    expect(b).toEqual({ opaque: null, cutout: null, translucent: null, liquid: null })
  })
  it('meshChunk matches Mesher output', () => {
    const s = emptySnap()
    put(s, 1, 1, 1, ID.stone)
    put(s, 2, 1, 1, ID.stone)
    put(s, 5, 1, 1, water(7))
    expect(meshChunk(s, tables)).toEqual(new Mesher().mesh(s, tables))
  })
})
```

In `packages/engine/test/meshJob.test.ts`, change the trivial-chunk expectation to `data: { opaque: null, cutout: null, translucent: null, liquid: null }`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/engine -- registry liquid meshJob`
Expected: FAIL. `LAYER.LIQUID` is undefined, `meshTranslucent` puts water into the translucent builder, and `liquid` is missing from `ChunkMeshData`.

- [ ] **Step 3: Implement the layer**

`packages/engine/src/blocks/registry.ts`:
```ts
export type RenderLayer = 'opaque' | 'cutout' | 'translucent' | 'liquid'
export const LAYER = { NONE: 0, OPAQUE: 1, CUTOUT: 2, TRANSLUCENT: 3, LIQUID: 4 } as const
```
```ts
const LAYER_CODE: Record<RenderLayer, number> = { opaque: LAYER.OPAQUE, cutout: LAYER.CUTOUT, translucent: LAYER.TRANSLUCENT, liquid: LAYER.LIQUID }
```
In the constructor, replace the `layer` line with:
```ts
      const layer: RenderLayer = d.layer ?? (liquid ? 'liquid' : 'opaque')
      if (layer === 'liquid' && !liquid) throw new Error(`block "${d.name}": layer "liquid" needs liquid: true`)
```

`packages/engine/src/mesh/liquid.ts`: change the signature and routing of `meshTranslucent`:
```ts
export function meshTranslucent(s: ChunkSnapshot, t: MeshTables, translucent: QuadBuilder, liquidOut: QuadBuilder): void {
  const p = [0, 0, 0]
  for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
    const pi = padIndex(x + 1, y + 1, z + 1)
    const id = voxelId(s.voxels[pi]!)
    const layer = t.layer[id]
    if (layer !== LAYER.TRANSLUCENT && layer !== LAYER.LIQUID) continue
    const out = layer === LAYER.LIQUID ? liquidOut : translucent
```
Keep the rest of the loop body unchanged, except that the final `out.push(qa, qb, false, REVERSE[f]!)` now pushes to the local `out`.

`packages/engine/src/mesh/mesher.ts`:
```ts
export interface ChunkMeshData {
  opaque: LayerMesh | null
  cutout: LayerMesh | null
  translucent: LayerMesh | null
  liquid: LayerMesh | null
}
```
Add `private readonly liquid = new QuadBuilder(512)`, reset it in `mesh()`, call `meshTranslucent(snap, tables, this.translucent, this.liquid)`, and return `liquid: this.liquid.build()`.

`packages/engine/src/mesh/meshJob.ts`: `const EMPTY: ChunkMeshData = { opaque: null, cutout: null, translucent: null, liquid: null }`.

`packages/engine/src/mesh/mesh.worker.ts`: `for (const m of [d.opaque, d.cutout, d.translucent, d.liquid])`.

`packages/engine/src/render/materials.ts`: add `liquid: VoxelNodeMaterial` to `ChunkMaterials` and `liquid: build('translucent')` to the returned object.

`packages/engine/src/render/chunkMeshes.ts`:
- `const LAYERS = ['opaque', 'cutout', 'translucent', 'liquid'] as const`
- `slots = [null, null, null, null]`
- Change `materials` to a mutable record: `private readonly materials: Record<(typeof LAYERS)[number], THREE.Material>`. In the constructor: `this.materials = { ...materials }`.
- When a mesh is created: `if (name === 'liquid') mesh.renderOrder = 1`.
- Add:
```ts
  /** Swaps the material of every mesh in one layer (water on/off). */
  setLayerMaterial(layer: 'liquid', material: THREE.Material): void {
    this.materials[layer] = material
    for (const slots of this.meshes.values()) {
      const m = slots[LAYERS.indexOf(layer)]
      if (m) m.material = material
    }
  }
```
- In `dispose()`, dispose the original `ChunkMaterials` passed to the constructor (keep a reference to them as `private readonly owned: ChunkMaterials`), not whatever is currently swapped in.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test` and `npm run typecheck`
Expected: all pass, including the bench fixture compile (`npm run bench:node -w @elovox/engine` still under 3 ms).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/blocks/registry.ts packages/engine/src/mesh packages/engine/src/render/materials.ts packages/engine/src/render/chunkMeshes.ts packages/engine/test/registry.test.ts packages/engine/test/liquid.test.ts packages/engine/test/meshJob.test.ts
git commit -m "feat(engine): separate liquid render layer"
```

---

### Task 10: Water material

**Files:**
- Create: `packages/engine/src/render/water.ts`
- Modify: `packages/engine/src/render/settings.ts` (water params), `packages/engine/src/render/visuals.ts` (water material, `effects.water`, `setWater`)
- Modify: `packages/engine/src/engine.ts` (`engine.water` accessor), `packages/engine/src/index.ts` (`WaterInput`, `WaterParams` types)
- Test: `packages/engine/test/settings.test.ts` (water cases)

**Interfaces:**
- Consumes: `chunkVertex` (Task 4), `VoxelNodeMaterial`, `voxelLit`, `LightUniforms` (Task 4), `hexToLinear`, `sunDirection`, `Atmosphere` (Task 2), `setLinear` (Task 5), `resolveEffects(...).waterDepth` (Task 5), `ChunkMeshes.setLayerMaterial` (Task 9).
- Produces:
  - `settings.ts`:
    - `interface WaterParams { shallow: Rgb; deep: Rgb; depthScale: number; foamWidth: number; waveScale: number; waveSpeed: number }`
    - `type WaterInput` (the same fields, optional, colours as `'#rrggbb'`)
    - `DEFAULT_WATER`, `mergeWater(cur: WaterParams, input: WaterInput): WaterParams`
  - `water.ts`: `class WaterMaterial` with:
    - `material: VoxelNodeMaterial`
    - `constructor(lights: LightUniforms, depthEffects: boolean)`
    - `setParams(p: WaterParams)`, `applyAtmosphere(a: Atmosphere)`, `dispose()`
  - `Engine`: `get water(): WaterParams; set water(v: WaterInput)`.

**Shading** (spec §6):
- **Ripples (top faces):** height `h(p) = n(p·waveScale + t·speed·(1, 0.6)) + 0.5 × n(p·waveScale·2.3 − t·speed·(0.7, 0))`, with `n = mx_noise_float` over world xz. The normal comes from forward differences (ε = 0.08) at strength 0.15.
- **Side faces:** keep the face normal, and add brightness streaks scrolling down (`y + 3·t·speed`).
- **Depth:** `thickness = max(0, fragViewZ − sceneViewZ)`, from `viewportDepthTexture`. `depthT = 1 − e^(−thickness/depthScale)`. Colour is `mix(shallow, deep, depthT)` and alpha is `mix(0.6, 0.92, depthT)`.
- **Foam:** `1 − smoothstep(0, foamWidth × (0.6 + 0.8·noise), thickness)`, mixing towards white with alpha up to 1.
- **Without depth effects:** thickness is a constant 2 and there is no foam.
- **Emissive (Deviation 8):** `sunColor × 2.5 × (N·H)^160 × sunGate(sky) + horizon × 0.35 × (1 − N·V)^4`.

- [ ] **Step 1: Write the failing water settings tests**

Append to `packages/engine/test/settings.test.ts`:
```ts
import { DEFAULT_WATER, mergeWater } from '../src/render/settings.ts'
import { hexToLinear } from '../src/render/atmosphere.ts'

describe('water params', () => {
  it('has turquoise-to-blue defaults', () => {
    expect(DEFAULT_WATER.shallow).toEqual(hexToLinear('#5fd0d6'))
    expect(DEFAULT_WATER.deep).toEqual(hexToLinear('#1f6fae'))
  })
  it('merges colours and numbers', () => {
    const w = mergeWater(DEFAULT_WATER, { shallow: '#ffffff', foamWidth: 0.5 })
    expect(w.shallow).toEqual([1, 1, 1])
    expect(w.foamWidth).toBe(0.5)
    expect(w.deep).toEqual(DEFAULT_WATER.deep)
  })
  it('rejects bad values with the field name', () => {
    expect(() => mergeWater(DEFAULT_WATER, { deep: 'blue' })).toThrow(/water\.deep/)
    expect(() => mergeWater(DEFAULT_WATER, { depthScale: 0 })).toThrow(/water\.depthScale/)
    expect(() => mergeWater(DEFAULT_WATER, { foamWidth: -1 })).toThrow(/water\.foamWidth/)
    expect(() => mergeWater(DEFAULT_WATER, { waveSpeed: Number.NaN })).toThrow(/water\.waveSpeed/)
    expect(() => mergeWater(DEFAULT_WATER, { colour: '#fff' } as never)).toThrow(/unknown water field "colour"/)
  })
})
```
(Merge the new imports into the file's existing import lines.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/engine -- settings`
Expected: FAIL (`DEFAULT_WATER` is not exported).

- [ ] **Step 3: Implement the water params**

Append to `packages/engine/src/render/settings.ts`:
```ts
import { hexToLinear, type Rgb } from './atmosphere.ts'

export interface WaterParams { shallow: Rgb; deep: Rgb; depthScale: number; foamWidth: number; waveScale: number; waveSpeed: number }
export interface WaterInput { shallow?: string; deep?: string; depthScale?: number; foamWidth?: number; waveScale?: number; waveSpeed?: number }

export const DEFAULT_WATER: WaterParams = Object.freeze({
  shallow: hexToLinear('#5fd0d6'), deep: hexToLinear('#1f6fae'), depthScale: 3, foamWidth: 0.35, waveScale: 0.35, waveSpeed: 0.6,
})

export function mergeWater(cur: WaterParams, input: WaterInput): WaterParams {
  const patch = checked('water', cur as unknown as Required<WaterInput>, input)
  const out: WaterParams = { ...cur }
  if (patch.shallow !== undefined) out.shallow = hexToLinear(patch.shallow, 'water.shallow')
  if (patch.deep !== undefined) out.deep = hexToLinear(patch.deep, 'water.deep')
  const num = (k: 'depthScale' | 'foamWidth' | 'waveScale' | 'waveSpeed', ok: (v: number) => boolean, rule: string) => {
    const v = patch[k]
    if (v === undefined) return
    if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) throw new RangeError(`water.${k} must be ${rule}, got ${String(v)}`)
    out[k] = v
  }
  num('depthScale', (v) => v > 0, 'a finite number > 0')
  num('foamWidth', (v) => v >= 0, 'a finite number ≥ 0')
  num('waveScale', (v) => v > 0, 'a finite number > 0')
  num('waveSpeed', () => true, 'a finite number')
  return Object.freeze(out)
}
```
(Move the `import` to the top of the file with the others.)

Run: `npm test -w @elovox/engine -- settings`
Expected: PASS.

- [ ] **Step 4: Implement `water.ts`**

`packages/engine/src/render/water.ts`:
```ts
import * as THREE from 'three/webgpu'
import {
  cameraFar, cameraNear, cameraPosition, dot, float, mix, mx_noise_float, normalize, perspectiveDepthToViewZ,
  positionView, positionWorld, select, smoothstep, time, uniform, vec2, vec3, vec4, viewportDepthTexture,
} from 'three/tsl'
import { sunDirection, type Atmosphere } from './atmosphere.ts'
import { chunkVertex } from './chunkVertex.ts'
import { setLinear } from './lighting.ts'
import type { WaterParams } from './settings.ts'
import { VoxelNodeMaterial, voxelLit, type LightUniforms } from './voxelLighting.ts'

type N = ReturnType<typeof float>
const EPS = 0.08
const RIPPLE = 0.15

/** The liquid layer's material: ripples, depth colour, shore foam, sun glint and sky fresnel. */
export class WaterMaterial {
  readonly material: VoxelNodeMaterial
  private readonly u = {
    shallow: uniform(new THREE.Color()),
    deep: uniform(new THREE.Color()),
    depthScale: uniform(3),
    foamWidth: uniform(0.35),
    waveScale: uniform(0.35),
    waveSpeed: uniform(0.6),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
    sunColor: uniform(new THREE.Color()),
    horizon: uniform(new THREE.Color()),
  }

  constructor(lights: LightUniforms, depthEffects: boolean) {
    const u = this.u
    const v = chunkVertex()
    const m = new VoxelNodeMaterial(v.sky)
    m.positionNode = v.position
    m.transparent = true
    m.depthWrite = false
    const wp = positionWorld
    const isTop = v.normal.y.greaterThan(0.5)
    const speed = time.mul(u.waveSpeed)
    const h = (p: N) => mx_noise_float(vec3(p.mul(u.waveScale).add(vec2(speed, speed.mul(0.6))), time.mul(0.25)))
      .add(mx_noise_float(vec3(p.mul(u.waveScale.mul(2.3)).sub(vec2(speed.mul(0.7), 0)), time.mul(0.4))).mul(0.5))
    const h0 = h(wp.xz), hx = h(wp.xz.add(vec2(EPS, 0))), hz = h(wp.xz.add(vec2(0, EPS)))
    const ripple = normalize(vec3(h0.sub(hx).mul(RIPPLE / EPS), 1, h0.sub(hz).mul(RIPPLE / EPS)))
    const n = select(isTop, ripple, v.normal)

    const thickness = depthEffects
      ? positionView.z.sub(perspectiveDepthToViewZ(viewportDepthTexture(), cameraNear, cameraFar)).max(0)
      : float(2)
    const depthT = float(1).sub(thickness.div(u.depthScale).negate().exp())
    const foamNoise = mx_noise_float(vec3(wp.xz.mul(1.6), time.mul(0.5))).mul(0.5).add(0.5)
    const foam = depthEffects ? float(1).sub(smoothstep(0, u.foamWidth.mul(foamNoise.mul(0.8).add(0.6)), thickness)) : float(0)
    const streak = select(isTop, float(0), mx_noise_float(vec3(wp.x.add(wp.z).mul(0.9), wp.y.mul(0.6).add(speed.mul(3)), 0)).mul(0.12))
    const albedo = mix(mix(u.shallow, u.deep, depthT).add(streak), vec3(1), foam)
    m.colorNode = vec4(albedo, mix(mix(float(0.6), float(0.92), depthT), float(1), foam))
    voxelLit(m, { normal: n, sky: v.sky, blk: v.blk, ao: float(1), albedo }, lights)

    const view = cameraPosition.sub(wp).normalize()
    const half = normalize(view.add(u.sunDir))
    const spec = dot(n, half).max(0).pow(160).mul(2.5).mul(smoothstep(0.35, 0.95, v.sky))
    const fresnel = float(1).sub(dot(n, view).max(0)).pow(4).mul(0.35)
    m.emissiveNode = (m.emissiveNode as N).add(u.sunColor.mul(spec)).add(u.horizon.mul(fresnel))
    this.material = m
  }

  setParams(p: WaterParams): void {
    setLinear(this.u.shallow.value, p.shallow)
    setLinear(this.u.deep.value, p.deep)
    this.u.depthScale.value = p.depthScale
    this.u.foamWidth.value = p.foamWidth
    this.u.waveScale.value = p.waveScale
    this.u.waveSpeed.value = p.waveSpeed
  }

  applyAtmosphere(a: Atmosphere): void {
    const [x, y, z] = sunDirection(a.sun.azimuth, a.sun.elevation)
    this.u.sunDir.value.set(x, y, z)
    setLinear(this.u.sunColor.value, a.sun.color)
    setLinear(this.u.horizon.value, a.sky.horizon)
  }

  dispose(): void { this.material.dispose() }
}
```

- [ ] **Step 5: Wire water into `Visuals` and the engine**

In `packages/engine/src/render/visuals.ts`:
- Add fields `private readonly water: WaterMaterial` and `private waterParams: WaterParams = DEFAULT_WATER`.
- In the constructor, after `this.effects = this.resolve(this.requested)`:
```ts
    this.water = new WaterMaterial(this.lights, resolveEffects(this.requested, SUPPORT[o.backend]).waterDepth)
    this.water.setParams(this.waterParams)
    this.syncWater()
```
- Add:
```ts
  getWater(): WaterParams { return this.waterParams }
  setWater(input: WaterInput): void {
    this.waterParams = mergeWater(this.waterParams, input)
    this.water.setParams(this.waterParams)
  }
  private syncWater(): void {
    this.chunks.setLayerMaterial('liquid', this.effects.water ? this.water.material : this.chunks.baseMaterial('liquid'))
  }
```
  Add `baseMaterial(layer)` to `ChunkMeshes` (returns the constructor-given material for that layer).
- In `setEffects`, after resolving: `this.syncWater()`.
- In `applyAtmosphere`: `this.water.applyAtmosphere(a)`.
- In `dispose`: `this.water.dispose()`.

In `packages/engine/src/engine.ts`, add to `interface Engine`:
```ts
  get water(): WaterParams
  set water(value: WaterInput)
```
and to the returned object:
```ts
    get water() { return visuals.getWater() },
    set water(value: WaterInput) { visuals.setWater(value) },
```
In `index.ts`: `export type { Effects, Quality, WaterInput, WaterParams } from './render/settings.ts'`.

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test` and `npm run typecheck`
Expected: all pass.

- [ ] **Step 7: Browser check (controller)**

Open `?scene=diorama` (WebGPU) and `?scene=diorama&webgl`. Expected:
- The lake and pond are turquoise in the shallows and bluer in the deep middle, with animated rippled streaks.
- A white, slightly irregular foam line follows every shore and the islet, and appears around a block placed in the water.
- A sun glint shows when looking towards the sun. The lake's cut side at the world edge shows streaks running downwards.
- Shadows from trees and the cliff fall on the water.
- `#fx-water` off shows the old tile water; on shows the shader water.
- `__elovox.engine.water = { shallow: '#ff0000' }` turns the shallows red.
- No console errors. If spike P3 failed on a backend, that backend logs one warning and shows water without foam.

- [ ] **Step 8: Commit**

```bash
git add packages/engine/src/render/water.ts packages/engine/src/render/settings.ts packages/engine/src/render/visuals.ts packages/engine/src/render/chunkMeshes.ts packages/engine/src/engine.ts packages/engine/src/index.ts packages/engine/test/settings.test.ts
git commit -m "feat(engine): stylized water with ripples, depth colour, shore foam and sun glint"
```

---
### Task 11: Decoration definitions and extraction

**Files:**
- Create: `packages/engine/src/render/decorations/defs.ts`, `packages/engine/src/render/decorations/extract.ts`
- Modify: `packages/engine/src/mesh/tables.ts` (`deco` tables), `packages/engine/src/mesh/mesher.ts` (extraction, chunk origin, `grass`/`flowers` fields), `packages/engine/src/mesh/meshJob.ts` (origin, `EMPTY`), `packages/engine/src/mesh/mesh.worker.ts` (transfers)
- Modify: `packages/engine/src/engine.ts` (`decorations` option, `DecorationRegistry`), `packages/engine/src/index.ts` (exports)
- Modify: `packages/engine/test/meshFixtures.ts` (`decoratedMeshTables`), `packages/engine/bench/surface.ts` (bench uses decorated tables)
- Modify: `apps/sandbox/src/blocks.ts` (`DECORATIONS`, grass → `'meadow'`), `apps/sandbox/src/main.ts` (pass `decorations`)
- Test: `packages/engine/test/decorations.test.ts`, `packages/engine/test/liquid.test.ts` and `packages/engine/test/meshJob.test.ts` (new `ChunkMeshData` fields)

**Interfaces:**
- Consumes: `BlockRegistry` (`blocks/registry.ts`), `hexToLinear`, `Rgb` (Task 2), `hash32` (`sim/rng.ts`), `valueNoise2` (`sim/generator.ts`), `padIndex`, `PAD`, `ChunkSnapshot` (`world/reader.ts`), `MeshTables` (`mesh/tables.ts`).
- Produces:
  - `defs.ts` (pure):
    - `MAX_DECORATIONS = 16`, `MAX_BLADES = 24`, `MAX_FLOWER_COLORS = 8`
    - `interface DecorationDef { name; grass?: GrassDef; flowers?: FlowerDef }`, `defineDecoration(def)`
    - `ResolvedDecoration { name; grass: ResolvedGrass | null; flowers: ResolvedFlowers | null }`
    - `interface DecorationTables { byBlock: Uint8Array; grass: Uint8Array; flowerChance: Float32Array; patchScale: Float32Array; flowerColors: Uint8Array }`. `byBlock[id]` is 0 for no decoration, or `k + 1` for decoration `k`.
    - `emptyDecorationTables(blockCount): DecorationTables`
    - `class DecorationRegistry` with `constructor(defs, blocks: BlockRegistry)`, `defs`, `tables`, `id(name)`.
  - `extract.ts` (pure, runs in the mesh worker):
    - `EDGE = { PX: 1, NX: 2, PZ: 4, NZ: 8 }`
    - `packInstance(lx, ly, lz, edge, sky, blk): number`, `unpackInstance(a)`
    - `class InstanceBuilder` with `push(a, b)`, `count`, `build(): Uint32Array | null`, `reset()`
    - `flowerChanceAt(chance, patchScale, wx, wz): number`
    - `extractDecorations(s, t: MeshTables, ox, oy, oz, grass: InstanceBuilder, flowers: InstanceBuilder): void`
  - `MeshTables.deco: DecorationTables`, and `meshTablesFrom(registry, faceLayers, deco = emptyDecorationTables(registry.count))`.
  - `ChunkMeshData` gains `grass: Uint32Array | null` and `flowers: Uint32Array | null`. Each holds 2 words per instance.
  - `Mesher.mesh(snap, tables, ox = 0, oy = 0, oz = 0)` and `meshChunk(snap, tables, ox?, oy?, oz?)`.
  - `EngineOptions.decorations?: DecorationDef[]`.

**Instance format** (spec §7, Deviation 3):
```
word 1: lx (5b) | ly (5b) | lz (5b) | edge (4b) | sky (4b) | block (4b) | reserved (5b)
word 2: decoration index (8b) | flower colour index (3b, flowers only) | reserved (21b)
```
- An instance is emitted for a voxel whose block has a decoration and whose voxel **above is air**.
- An edge bit is set when the horizontal neighbour at the **same height is not opaque**. Out-of-world neighbours read as air.
- Light comes from the voxel above.
- A flower is placed when `hash32(FLOWER_SEED, wx, wy, wz) / 2³² < flowerChanceAt(...)`. Its colour is `hash32(FLOWER_SEED + 1, wx, wy, wz) % colours`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/engine/test/meshFixtures.ts`:
```ts
import { BlockRegistry } from '../src/blocks/registry.ts'
import { DecorationRegistry, defineDecoration } from '../src/render/decorations/defs.ts'
import { TEST_BLOCKS } from './helpers.ts'

export const MEADOW = defineDecoration({ name: 'meadow', grass: {}, flowers: { chance: 1, patchScale: 12 } })

/** Test registry with grass decorated by MEADOW (same block ids as testRegistry()). */
export function decoratedMeshTables(decorations = [MEADOW]): MeshTables {
  const reg = new BlockRegistry(TEST_BLOCKS.map((b) => (b.name === 'grass' ? { ...b, decoration: decorations[0]!.name } : b)))
  const deco = new DecorationRegistry(decorations, reg)
  return meshTablesFrom(reg, reg.faceLayers(new Map(reg.textureNames().map((n, i) => [n, i + 1]))), deco.tables)
}
```

`packages/engine/test/decorations.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { BlockRegistry, defineBlock } from '../src/blocks/registry.ts'
import { MeshJobRunner } from '../src/mesh/meshJob.ts'
import { hexToLinear } from '../src/render/atmosphere.ts'
import { DecorationRegistry, MAX_DECORATIONS, defineDecoration } from '../src/render/decorations/defs.ts'
import { EDGE, InstanceBuilder, extractDecorations, flowerChanceAt, packInstance, unpackInstance } from '../src/render/decorations/extract.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ChunkStore } from '../src/world/chunkStore.ts'
import { packLight } from '../src/world/voxel.ts'
import { padIndex, type ChunkSnapshot } from '../src/world/reader.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'
import { MEADOW, decoratedMeshTables } from './meshFixtures.ts'
import { emptySnap, put } from './meshHelpers.ts'

function run(s: ChunkSnapshot, tables = decoratedMeshTables(), origin: [number, number, number] = [0, 0, 0]) {
  const g = new InstanceBuilder(), f = new InstanceBuilder()
  extractDecorations(s, tables, origin[0], origin[1], origin[2], g, f)
  return { grass: g.build(), flowers: f.build() }
}
const instances = (a: Uint32Array | null) => {
  const out: ReturnType<typeof unpackInstance>[] = []
  if (a) for (let i = 0; i < a.length; i += 2) out.push(unpackInstance(a[i]!))
  return out
}

describe('DecorationRegistry', () => {
  const blocks = () => new BlockRegistry([defineBlock({ name: 'grass', decoration: 'meadow' }), defineBlock({ name: 'stone' })])
  it('resolves defaults and maps blocks to decorations', () => {
    const r = new DecorationRegistry([defineDecoration({ name: 'meadow', grass: {} })], blocks())
    expect(r.defs[0]!.grass).toEqual({ blades: 16, height: [0.25, 0.55], base: hexToLinear('#4f8a2e'), tip: hexToLinear('#a9d65a'), overhang: 0.2 })
    expect(r.defs[0]!.flowers).toBeNull()
    expect([...r.tables.byBlock]).toEqual([0, 1, 0])
    expect([...r.tables.grass]).toEqual([1])
    expect(r.id('meadow')).toBe(0)
  })
  it('rejects a block naming an undefined decoration', () => {
    expect(() => new DecorationRegistry([], blocks())).toThrow(/block "grass" names decoration "meadow", which is not defined/)
  })
  it('validates definitions', () => {
    const b = new BlockRegistry([defineBlock({ name: 'stone' })])
    const bad = (d: object) => () => new DecorationRegistry([{ name: 'x', ...d }], b)
    expect(bad({ grass: { blades: 0 } })).toThrow(/blades/)
    expect(bad({ grass: { blades: 25 } })).toThrow(/blades/)
    expect(bad({ grass: { height: [0.6, 0.3] } })).toThrow(/height/)
    expect(bad({ grass: { base: 'green' } })).toThrow(/base/)
    expect(bad({ grass: { overhang: 0.9 } })).toThrow(/overhang/)
    expect(bad({ flowers: { chance: 2 } })).toThrow(/chance/)
    expect(bad({ flowers: { colors: [] } })).toThrow(/colors/)
    expect(bad({ flowers: { colors: new Array(9).fill('#ffffff') } })).toThrow(/colors/)
    expect(() => new DecorationRegistry([{ name: 'a' }, { name: 'a' }], b)).toThrow(/duplicate decoration "a"/)
    expect(() => new DecorationRegistry(Array.from({ length: MAX_DECORATIONS + 1 }, (_, i) => ({ name: `d${i}` })), b)).toThrow(/too many decorations/)
  })
})

describe('instance packing', () => {
  it('round-trips every field', () => {
    expect(unpackInstance(packInstance(31, 17, 5, 9, 15, 3))).toEqual({ lx: 31, ly: 17, lz: 5, edge: 9, sky: 15, blk: 3 })
  })
})

describe('extractDecorations', () => {
  it('emits one grass instance per decorated top with air above, lit by the voxel above', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, ID.grass)
    s.light[padIndex(5, 6, 5)] = packLight(12, 3)
    put(s, 8, 4, 4, ID.grass)
    put(s, 8, 5, 4, ID.stone) // covered: no tuft
    put(s, 12, 4, 4, ID.dirt) // not decorated
    const g = instances(run(s).grass)
    expect(g).toHaveLength(1)
    expect(g[0]).toMatchObject({ lx: 4, ly: 4, lz: 4, sky: 12, blk: 3 })
  })
  it('sets edge bits where the same-height neighbour is not opaque', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, ID.grass)
    put(s, 5, 4, 4, ID.stone) // +x covered
    put(s, 4, 4, 5, ID.grass) // +z covered by another grass block
    put(s, 3, 4, 4, ID.glass) // −x: glass is not opaque → edge
    const g = instances(run(s).grass).find((i) => i.lx === 4 && i.lz === 4)!
    expect(g.edge).toBe(EDGE.NX | EDGE.NZ)
  })
  it('reads edge neighbours across the chunk border from the padding (Review Focus 1)', () => {
    const s = emptySnap()
    put(s, 31, 4, 10, ID.grass)
    expect(instances(run(s).grass)[0]!.edge & EDGE.PX).toBe(EDGE.PX) // padding x = 32 is air
    put(s, 32, 4, 10, ID.stone)
    expect(instances(run(s).grass)[0]!.edge & EDGE.PX).toBe(0)
  })
  it('hangs over the world edge: out-of-world neighbours are air (Review Focus 5)', () => {
    const s = emptySnap() // the padding of a world-edge chunk holds air
    put(s, 0, 4, 0, ID.grass)
    put(s, 1, 4, 0, ID.stone)
    put(s, 0, 4, 1, ID.stone)
    expect(instances(run(s).grass)[0]!.edge).toBe(EDGE.NX | EDGE.NZ)
  })
  it('places flowers deterministically inside patches only', () => {
    const s = emptySnap()
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) put(s, x, 4, z, ID.grass)
    const a = run(s, decoratedMeshTables(), [64, 0, 96])
    const b = run(s, decoratedMeshTables(), [64, 0, 96])
    expect(a).toEqual(b)
    const f = instances(a.flowers)
    expect(f.length).toBeGreaterThan(0)
    expect(f.length).toBeLessThan(32 * 32)
    for (const i of f) expect(flowerChanceAt(1, 12, 64 + i.lx, 96 + i.lz)).toBeGreaterThan(0)
    for (let k = 1; k < a.flowers!.length; k += 2) {
      expect(a.flowers![k]! & 255).toBe(0) // decoration index
      expect(a.flowers![k]! >>> 8).toBeLessThan(5) // colour index < MEADOW's 5 default colours
    }
  })
  it('emits no grass for a flowers-only decoration', () => {
    const tables = decoratedMeshTables([defineDecoration({ name: 'blooms', flowers: { chance: 1 } })])
    const s = emptySnap()
    for (let x = 0; x < 32; x++) put(s, x, 4, 0, ID.grass)
    expect(run(s, tables).grass).toBeNull()
  })
})

describe('MeshJobRunner decorations (Review Focus 2)', () => {
  it('drops a tuft as soon as a ghost block covers it', () => {
    const reg = new BlockRegistry(TEST_BLOCKS.map((b) => (b.name === 'grass' ? { ...b, decoration: 'meadow' } : b)))
    const buffers = createWorldBuffers([64, 64, 64])
    const runner = new MeshJobRunner(buffers, decoratedMeshTables())
    const store = new ChunkStore({ buffers, opaque: reg.opaque, onNewPage: (i, p) => runner.addPage(i, p) })
    store.setVoxel(3, 3, 3, ID.grass)
    store.commit()
    const before = runner.run({ id: 1, chunk: 0 })
    const after = runner.run({ id: 2, chunk: 0, overrides: [[3, 4, 3, ID.stone]] })
    if (before.type !== 'result' || after.type !== 'result') throw new Error('expected results')
    expect(before.data.grass).not.toBeNull()
    expect(after.data.grass).toBeNull()
  })
})
```

Also update the two empty-result expectations to include the new fields:
- `liquid.test.ts`: `expect(b).toEqual({ opaque: null, cutout: null, translucent: null, liquid: null, grass: null, flowers: null })`
- `meshJob.test.ts`: `data: { opaque: null, cutout: null, translucent: null, liquid: null, grass: null, flowers: null }`

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/engine -- decorations liquid meshJob`
Expected: FAIL (modules not found; `grass`/`flowers` missing).

The flower test relies on the 32 × 32 area at origin (64, 96) being partly inside a flower patch and partly outside one. If, once implemented, that area turns out to be entirely inside or entirely outside a patch, move the origin to one that is mixed. Say so in the task report; the assertions themselves stay as written.

- [ ] **Step 3: Implement `defs.ts`**

`packages/engine/src/render/decorations/defs.ts`:
```ts
import type { BlockRegistry } from '../../blocks/registry.ts'
import { hexToLinear, type Rgb } from '../atmosphere.ts'

export const MAX_DECORATIONS = 16
export const MAX_BLADES = 24
export const MAX_FLOWER_COLORS = 8

export interface GrassDef { blades?: number; height?: readonly [number, number]; base?: string; tip?: string; overhang?: number }
export interface FlowerDef { chance?: number; patchScale?: number; colors?: readonly string[] }
export interface DecorationDef { name: string; grass?: GrassDef; flowers?: FlowerDef }

export function defineDecoration(def: DecorationDef): DecorationDef {
  return def
}

export interface ResolvedGrass { blades: number; height: readonly [number, number]; base: Rgb; tip: Rgb; overhang: number }
export interface ResolvedFlowers { chance: number; patchScale: number; colors: readonly Rgb[] }
export interface ResolvedDecoration { name: string; grass: ResolvedGrass | null; flowers: ResolvedFlowers | null }

/** Plain typed arrays, posted to mesh workers in MeshTables. byBlock: 0 = none, k = decoration k − 1. */
export interface DecorationTables {
  byBlock: Uint8Array
  grass: Uint8Array
  flowerChance: Float32Array
  patchScale: Float32Array
  flowerColors: Uint8Array
}

export function emptyDecorationTables(blockCount: number): DecorationTables {
  return { byBlock: new Uint8Array(blockCount), grass: new Uint8Array(0), flowerChance: new Float32Array(0), patchScale: new Float32Array(0), flowerColors: new Uint8Array(0) }
}

const DEFAULT_FLOWER_COLORS = ['#e94b4b', '#f5d142', '#ffffff', '#f08ac0', '#6f8cf0']

function num(path: string, v: number | undefined, fallback: number, ok: (v: number) => boolean, rule: string): number {
  const x = v ?? fallback
  if (typeof x !== 'number' || !Number.isFinite(x) || !ok(x)) throw new RangeError(`${path} must be ${rule}, got ${String(x)}`)
  return x
}

function resolve(d: DecorationDef): ResolvedDecoration {
  const p = `decoration "${d.name}"`
  let grass: ResolvedGrass | null = null
  if (d.grass) {
    const g = d.grass
    const blades = num(`${p} grass.blades`, g.blades, 16, (v) => Number.isInteger(v) && v >= 1 && v <= MAX_BLADES, `an integer in [1, ${MAX_BLADES}]`)
    const [lo, hi] = g.height ?? [0.25, 0.55]
    if (!(Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0.05 && lo <= hi && hi <= 2)) {
      throw new RangeError(`${p} grass.height must be [min, max] with 0.05 ≤ min ≤ max ≤ 2, got [${lo}, ${hi}]`)
    }
    grass = {
      blades,
      height: [lo, hi],
      base: hexToLinear(g.base ?? '#4f8a2e', `${p} grass.base`),
      tip: hexToLinear(g.tip ?? '#a9d65a', `${p} grass.tip`),
      overhang: num(`${p} grass.overhang`, g.overhang, 0.2, (v) => v >= 0 && v <= 0.5, 'in [0, 0.5]'),
    }
  }
  let flowers: ResolvedFlowers | null = null
  if (d.flowers) {
    const f = d.flowers
    const colors = f.colors ?? DEFAULT_FLOWER_COLORS
    if (!Array.isArray(colors) || colors.length < 1 || colors.length > MAX_FLOWER_COLORS) {
      throw new RangeError(`${p} flowers.colors must list 1–${MAX_FLOWER_COLORS} colours`)
    }
    flowers = {
      chance: num(`${p} flowers.chance`, f.chance, 0.05, (v) => v >= 0 && v <= 1, 'in [0, 1]'),
      patchScale: num(`${p} flowers.patchScale`, f.patchScale, 12, (v) => v > 0, 'a finite number > 0'),
      colors: colors.map((c, i) => hexToLinear(c, `${p} flowers.colors[${i}]`)),
    }
  }
  return { name: d.name, grass, flowers }
}

/** Main-thread registry of decorations; validates the blocks' `decoration` names (Deviation 9). */
export class DecorationRegistry {
  readonly defs: readonly ResolvedDecoration[]
  readonly tables: DecorationTables
  private readonly ids = new Map<string, number>()

  constructor(defs: readonly DecorationDef[], blocks: BlockRegistry) {
    if (defs.length > MAX_DECORATIONS) throw new RangeError(`too many decorations: ${defs.length} > ${MAX_DECORATIONS}`)
    this.defs = defs.map((d, i) => {
      if (typeof d.name !== 'string' || d.name.length === 0) throw new RangeError('decoration name must be a non-empty string')
      if (this.ids.has(d.name)) throw new Error(`duplicate decoration "${d.name}"`)
      this.ids.set(d.name, i)
      return resolve(d)
    })
    const byBlock = new Uint8Array(blocks.count)
    blocks.defs.forEach((b, id) => {
      if (b.decoration === undefined) return
      const k = this.ids.get(b.decoration)
      if (k === undefined) throw new Error(`block "${b.name}" names decoration "${b.decoration}", which is not defined`)
      byBlock[id] = k + 1
    })
    this.tables = {
      byBlock,
      grass: Uint8Array.from(this.defs, (d) => (d.grass ? 1 : 0)),
      flowerChance: Float32Array.from(this.defs, (d) => d.flowers?.chance ?? 0),
      patchScale: Float32Array.from(this.defs, (d) => d.flowers?.patchScale ?? 1),
      flowerColors: Uint8Array.from(this.defs, (d) => d.flowers?.colors.length ?? 0),
    }
  }

  id(name: string): number {
    const k = this.ids.get(name)
    if (k === undefined) throw new Error(`unknown decoration "${name}"`)
    return k
  }
}
```

- [ ] **Step 4: Implement `extract.ts`**

`packages/engine/src/render/decorations/extract.ts`:
```ts
import type { MeshTables } from '../../mesh/tables.ts'
import { valueNoise2 } from '../../sim/generator.ts'
import { hash32 } from '../../sim/rng.ts'
import { PAD, padIndex, type ChunkSnapshot } from '../../world/reader.ts'
import { AIR, voxelId } from '../../world/voxel.ts'

export const EDGE = { PX: 1, NX: 2, PZ: 4, NZ: 8 } as const
const FLOWER_SEED = 0x6f1e7
const PATCH_SEED = 0x2a7c1
const UP = PAD * PAD
const SIDES: readonly (readonly [number, number])[] = [[1, EDGE.PX], [-1, EDGE.NX], [PAD, EDGE.PZ], [-PAD, EDGE.NZ]]

export function packInstance(lx: number, ly: number, lz: number, edge: number, sky: number, blk: number): number {
  return (lx | (ly << 5) | (lz << 10) | (edge << 15) | (sky << 19) | (blk << 23)) >>> 0
}
export function unpackInstance(a: number) {
  return { lx: a & 31, ly: (a >>> 5) & 31, lz: (a >>> 10) & 31, edge: (a >>> 15) & 15, sky: (a >>> 19) & 15, blk: (a >>> 23) & 15 }
}

/** Growable buffer of 2-word instances. */
export class InstanceBuilder {
  private data: Uint32Array
  private n = 0
  constructor(initial = 256) { this.data = new Uint32Array(initial * 2) }
  get count(): number { return this.n }
  push(a: number, b: number): void {
    if ((this.n + 1) * 2 > this.data.length) {
      const d = new Uint32Array(this.data.length * 2)
      d.set(this.data)
      this.data = d
    }
    this.data[this.n * 2] = a
    this.data[this.n * 2 + 1] = b
    this.n++
  }
  build(): Uint32Array | null { return this.n === 0 ? null : this.data.slice(0, this.n * 2) }
  reset(): void { this.n = 0 }
}

/** Flower probability for a world column: `chance` inside a patch, ramping to 0 outside it. Deterministic. */
export function flowerChanceAt(chance: number, patchScale: number, wx: number, wz: number): number {
  const patch = valueNoise2(PATCH_SEED, wx / patchScale, wz / patchScale)
  return chance * Math.min(1, Math.max(0, (patch - 0.45) / 0.25))
}

/** Appends decoration instances for one snapshot. (ox, oy, oz) is the chunk's world origin. */
export function extractDecorations(
  s: ChunkSnapshot, t: MeshTables, ox: number, oy: number, oz: number, grass: InstanceBuilder, flowers: InstanceBuilder,
): void {
  const d = t.deco
  for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
    const pi = padIndex(x + 1, y + 1, z + 1)
    const k = d.byBlock[voxelId(s.voxels[pi]!)]!
    if (k === 0) continue
    if (voxelId(s.voxels[pi + UP]!) !== AIR) continue
    let edge = 0
    for (const [off, bit] of SIDES) if (!t.opaque[voxelId(s.voxels[pi + off]!)]) edge |= bit
    const l = s.light[pi + UP]!
    const a = packInstance(x, y, z, edge, l & 15, l >> 4)
    const di = k - 1
    if (d.grass[di]) grass.push(a, di)
    const colors = d.flowerColors[di]!
    if (colors === 0) continue
    const wx = ox + x, wy = oy + y, wz = oz + z
    const p = flowerChanceAt(d.flowerChance[di]!, d.patchScale[di]!, wx, wz)
    if (p > 0 && hash32(FLOWER_SEED, wx, wy, wz) / 4294967296 < p) {
      flowers.push(a, di | ((hash32(FLOWER_SEED + 1, wx, wy, wz) % colors) << 8))
    }
  }
}
```

- [ ] **Step 5: Plumb tables, mesher, job and worker**

`packages/engine/src/mesh/tables.ts`:
```ts
import type { BlockRegistry } from '../blocks/registry.ts'
import { emptyDecorationTables, type DecorationTables } from '../render/decorations/defs.ts'

/** Plain typed arrays, so they can be posted to mesh workers. */
export interface MeshTables {
  opaque: Uint8Array
  layer: Uint8Array
  liquid: Uint8Array
  faceLayers: Uint16Array
  deco: DecorationTables
}

export function meshTablesFrom(registry: BlockRegistry, faceLayers: Uint16Array, deco: DecorationTables = emptyDecorationTables(registry.count)): MeshTables {
  return { opaque: registry.opaque, layer: registry.layer, liquid: registry.liquid, faceLayers, deco }
}
```

`packages/engine/src/mesh/mesher.ts`: add `grass: Uint32Array | null` and `flowers: Uint32Array | null` to `ChunkMeshData`. Add builders `private readonly grass = new InstanceBuilder(1024)` and `private readonly flowers = new InstanceBuilder(64)`. Change the signature to `mesh(snap: ChunkSnapshot, tables: MeshTables, ox = 0, oy = 0, oz = 0): ChunkMeshData`. In the body, reset both builders, call `extractDecorations(snap, tables, ox, oy, oz, this.grass, this.flowers)` after the face meshing, and return `grass: this.grass.build(), flowers: this.flowers.build()`. Change `meshChunk` to `meshChunk(snap, tables, ox = 0, oy = 0, oz = 0)`, forwarding the origin.

`packages/engine/src/mesh/meshJob.ts`:
- `EMPTY` gains `liquid: null, grass: null, flowers: null` (`liquid` was already added in Task 9).
- In `run()`, replace the final mesh call with:
```ts
    const [cx, cy, cz] = this.reader.layout.chunkCoords(chunk)
    return { type: 'result', id, chunk, version, data: this.mesher.mesh(this.snap, this.tables, cx * 32, cy * 32, cz * 32) }
```

`packages/engine/src/mesh/mesh.worker.ts`, in `transferables()`:
```ts
  for (const m of [d.opaque, d.cutout, d.translucent, d.liquid]) if (m) out.push(m.vertices.buffer, m.indices.buffer)
  for (const a of [d.grass, d.flowers]) if (a) out.push(a.buffer)
```

`packages/engine/bench/surface.ts`: replace `export { meshTables } from '../test/meshFixtures.ts'` with `export { decoratedMeshTables as meshTables } from '../test/meshFixtures.ts'`, so both benchmarks include extraction.

- [ ] **Step 6: Engine option and sandbox decorations**

`packages/engine/src/engine.ts`:
- Import `DecorationRegistry` and `type DecorationDef` from `./render/decorations/defs.ts`.
- Add `decorations?: DecorationDef[]` to `EngineOptions`.
- After `const registry = ...`: `const decorations = new DecorationRegistry(o.decorations ?? [], registry)`.
- `const tables = meshTablesFrom(registry, registry.faceLayers(tex.layerOf), decorations.tables)`.

`packages/engine/src/index.ts`:
```ts
export { DecorationRegistry, defineDecoration, type DecorationDef, type FlowerDef, type GrassDef } from './render/decorations/defs.ts'
```

`apps/sandbox/src/blocks.ts`: change grass to `decoration: 'meadow'` and add:
```ts
import { defineBlock, defineDecoration } from '@elovox/engine'

export const DECORATIONS = [
  defineDecoration({
    name: 'meadow',
    grass: { blades: 20, height: [0.25, 0.55], base: '#4f8a2e', tip: '#a9d65a', overhang: 0.2 },
    flowers: { chance: 0.06, patchScale: 12, colors: ['#e94b4b', '#f5d142', '#ffffff', '#f08ac0', '#6f8cf0'] },
  }),
]
```
`apps/sandbox/src/main.ts`: import `DECORATIONS` and pass `decorations: DECORATIONS` to `createEngine`.

- [ ] **Step 7: Run tests, typecheck and the bench gate**

Run: `npm test`, `npm run typecheck` and `npm run bench:node -w @elovox/engine`
Expected: all tests pass, typecheck is clean, and the bench prints a mean under 3 ms per chunk (now including decoration extraction). If it exceeds 3 ms, profile `extractDecorations`: the flower path calls `hash32` only for decorated tops, and nothing else allocates.

- [ ] **Step 8: Commit**

```bash
git add packages/engine/src packages/engine/test packages/engine/bench apps/sandbox/src/blocks.ts apps/sandbox/src/main.ts
git commit -m "feat(engine): decoration definitions and per-voxel instance extraction in the mesh worker"
```

---

### Task 12: Decoration rendering (Checkpoint 2)

**Files:**
- Create: `packages/engine/src/render/decorations/shapes.ts`, `packages/engine/src/render/decorations/budget.ts`, `packages/engine/src/render/decorations/material.ts`, `packages/engine/src/render/decorations/decorationMeshes.ts`
- Modify: `packages/engine/src/render/visuals.ts` (decorations, culling, `effects.decorations`, stats), `packages/engine/src/engine.ts` (pass the `DecorationRegistry`; stats)
- Test: `packages/engine/test/decorationShapes.test.ts`, `packages/engine/test/decorationBudget.test.ts`

**Interfaces:**
- Consumes: `DecorationRegistry`, `MAX_BLADES`, `MAX_DECORATIONS`, `MAX_FLOWER_COLORS` (Task 11), the instance format (Task 11), `VoxelNodeMaterial`, `voxelLit`, `LightUniforms` (Task 4), `Quality` (Task 5).
- Produces:
  - `shapes.ts` (pure):
    - `interface DecorationArrays { position: Float32Array; info: Float32Array; index: Uint16Array }`
    - `tuftArrays()`: `MAX_BLADES` blades, 5 vertices and 3 triangles each. `position` is (root-relative x + root x, height fraction 0–1, …). `info` is (blade index, height jitter 0–1, root x, root z).
    - `flowerArrays()`: a stem quad plus 2 crossed petal quads, 12 vertices and 18 indices. `info.x` is 0 for stem and 1 for petal; `info.y` is the height fraction.
  - `budget.ts` (pure): `interface DecorationChunk { ci: number; dist: number; count: number }`, `CHUNK_REACH = 28`, and `selectVisible(chunks, radius, maxInstances): Set<number>`.
  - `material.ts`: `createDecorationMaterials(reg: DecorationRegistry, lights: LightUniforms)` returns `{ grass: VoxelNodeMaterial; flowers: VoxelNodeMaterial; radius }`, where `radius` is a uniform node.
  - `decorationMeshes.ts`: `class DecorationMeshes` with `group`, `constructor(layout, materials)`, `apply(ci, grass, flowers)`, `remove(ci)`, `cull(camera: THREE.Vector3, radius, maxInstances): { instances: number; draws: number }`, `dispose()`.
  - `VisualsOptions.decorations: DecorationRegistry`; `Visuals.stats()` adds `decorationInstances` and `decorationDraws`.
  - `EngineStats` gains `decorationInstances: number` and `decorationDraws: number`.

**Vertex behaviour** (spec §7):
- The mesh sits at the chunk origin. `cell = (lx, ly + 1, lz)` is the top of the decorated voxel, and the world cell comes from `modelWorldMatrix`.
- A per-voxel hash picks one of 8 symmetries (swap / mirror the roots), so tufts vary while their roots stay inside the cell.
- **Fade:** `1 − smoothstep(0.6·radius, radius, distance(camera.xz, cell.xz))`, multiplied into height and scale.
- **Grass height:** `mix(hMin, hMax, jitter) × fade`. Blades with index ≥ `blades` collapse to a point.
- **Overhang:** for each exposed edge (bits ±x, ±z), roots within 0.45 of that edge lean out by `overhang × 1.6 × t²` and droop by `0.5 × overhang × t²`.
- **Wind:** `0.18 × noise(world.xz × 0.07 + 0.5·t, 0.15·t) + 0.04 × sin(2.1·t + 2π·hash)`, weighted by `t²`.
- **Colour:** `mix(base, tip, t^1.2) × (0.85 + 0.3·hash)`. The AO term is `mix(0.55, 1, t)`, the normal is world up, and the material is double-sided.

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/decorationShapes.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MAX_BLADES } from '../src/render/decorations/defs.ts'
import { flowerArrays, tuftArrays } from '../src/render/decorations/shapes.ts'

describe('tuftArrays', () => {
  const t = tuftArrays()
  it('builds MAX_BLADES blades of 5 vertices and 3 triangles', () => {
    expect(t.position.length).toBe(MAX_BLADES * 5 * 3)
    expect(t.info.length).toBe(MAX_BLADES * 5 * 4)
    expect(t.index.length).toBe(MAX_BLADES * 9)
    expect(Math.max(...t.index)).toBe(MAX_BLADES * 5 - 1)
  })
  it('roots every blade inside the cell and spans height 0–1', () => {
    for (let v = 0; v < MAX_BLADES * 5; v++) {
      const y = t.position[v * 3 + 1]!
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(1)
      const [b, j, rx, rz] = [t.info[v * 4]!, t.info[v * 4 + 1]!, t.info[v * 4 + 2]!, t.info[v * 4 + 3]!]
      expect(Number.isInteger(b) && b >= 0 && b < MAX_BLADES).toBe(true)
      expect(j).toBeGreaterThanOrEqual(0)
      expect(j).toBeLessThan(1)
      for (const r of [rx, rz]) { expect(r).toBeGreaterThanOrEqual(0.08); expect(r).toBeLessThanOrEqual(0.92) }
    }
  })
  it('is deterministic', () => expect(tuftArrays()).toEqual(t))
})

describe('flowerArrays', () => {
  it('builds a stem and two crossed petal quads', () => {
    const f = flowerArrays()
    expect(f.position.length).toBe(12 * 3)
    expect(f.index.length).toBe(18)
    const parts = new Set<number>()
    for (let v = 0; v < 12; v++) parts.add(f.info[v * 4]!)
    expect([...parts].sort()).toEqual([0, 1])
  })
})
```

`packages/engine/test/decorationBudget.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { CHUNK_REACH, selectVisible } from '../src/render/decorations/budget.ts'

describe('selectVisible', () => {
  const chunks = [
    { ci: 1, dist: 10, count: 100 },
    { ci: 2, dist: 50, count: 100 },
    { ci: 3, dist: 96 + CHUNK_REACH + 1, count: 1 },
    { ci: 4, dist: 30, count: 100 },
  ]
  it('takes every chunk within reach of the radius', () => {
    expect(selectVisible(chunks, 96, 1e9)).toEqual(new Set([1, 2, 4]))
  })
  it('fills the instance ceiling nearest first', () => {
    expect(selectVisible(chunks, 96, 250)).toEqual(new Set([1, 4]))
    expect(selectVisible(chunks, 96, 0)).toEqual(new Set())
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/engine -- decorationShapes decorationBudget`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `shapes.ts` and `budget.ts`**

`packages/engine/src/render/decorations/shapes.ts`:
```ts
import { MAX_BLADES } from './defs.ts'

export interface DecorationArrays { position: Float32Array; info: Float32Array; index: Uint16Array }

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296
}

/** MAX_BLADES tapered blades rooted in the unit cell; position.y is the 0–1 height fraction (scaled in the shader). */
export function tuftArrays(): DecorationArrays {
  const r = lcg(0x7f4a7c15)
  const position = new Float32Array(MAX_BLADES * 5 * 3)
  const info = new Float32Array(MAX_BLADES * 5 * 4)
  const index = new Uint16Array(MAX_BLADES * 9)
  for (let b = 0; b < MAX_BLADES; b++) {
    const rx = 0.08 + r() * 0.84, rz = 0.08 + r() * 0.84
    const yaw = r() * Math.PI, w = 0.05 + r() * 0.04, jitter = r()
    const dx = Math.cos(yaw), dz = Math.sin(yaw)
    const shape: readonly (readonly [number, number])[] = [[-w, 0], [w, 0], [-w * 0.6, 0.5], [w * 0.6, 0.5], [0, 1]]
    shape.forEach(([s, t], k) => {
      const v = b * 5 + k
      position.set([rx + s * dx, t, rz + s * dz], v * 3)
      info.set([b, jitter, rx, rz], v * 4)
    })
    const o = b * 5
    index.set([o, o + 1, o + 2, o + 1, o + 3, o + 2, o + 2, o + 3, o + 4], b * 9)
  }
  return { position, info, index }
}

/** A thin stem and two crossed petal quads around (0, 0); sizes in blocks. info.x: 0 stem, 1 petal; info.y: height fraction. */
export function flowerArrays(): DecorationArrays {
  const H = 0.42, P = 0.11, S = 0.015
  const verts: [number, number, number, number, number][] = [
    [-S, 0, 0, 0, 0], [S, 0, 0, 0, 0], [S, H, 0, 0, 1], [-S, H, 0, 0, 1],
    [-P, H - 0.02, -P, 1, 1], [P, H - 0.02, P, 1, 1], [P, H + 0.04, P, 1, 1], [-P, H + 0.04, -P, 1, 1],
    [-P, H - 0.02, P, 1, 1], [P, H - 0.02, -P, 1, 1], [P, H + 0.04, -P, 1, 1], [-P, H + 0.04, P, 1, 1],
  ]
  const position = new Float32Array(12 * 3)
  const info = new Float32Array(12 * 4)
  verts.forEach(([x, y, z, part, t], v) => { position.set([x, y, z], v * 3); info.set([part, t, 0, 0], v * 4) })
  const index = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11])
  return { position, info, index }
}
```

`packages/engine/src/render/decorations/budget.ts`:
```ts
export interface DecorationChunk { ci: number; dist: number; count: number }

/** Distance from a chunk's centre to its farthest column, so a chunk is kept while any of it is within the radius. */
export const CHUNK_REACH = 28

/** The chunks to draw: within reach of `radius`, nearest first, until `maxInstances` would be exceeded. */
export function selectVisible(chunks: readonly DecorationChunk[], radius: number, maxInstances: number): Set<number> {
  const sorted = chunks.filter((c) => c.dist <= radius + CHUNK_REACH).sort((a, b) => a.dist - b.dist)
  const out = new Set<number>()
  let total = 0
  for (const c of sorted) {
    if (total + c.count > maxInstances) break
    total += c.count
    out.add(c.ci)
  }
  return out
}
```

Run: `npm test -w @elovox/engine -- decorationShapes decorationBudget`
Expected: PASS.

- [ ] **Step 4: Implement `material.ts`**

`packages/engine/src/render/decorations/material.ts`:
```ts
import * as THREE from 'three/webgpu'
import {
  attribute, cameraPosition, float, floor, fract, hash, mix, modelWorldMatrix, mx_noise_float, select, sin, smoothstep,
  time, uint, uniform, uniformArray, varying, vec2, vec3, vec4,
} from 'three/tsl'
import type { LightUniforms } from '../voxelLighting.ts'
import { VoxelNodeMaterial, voxelLit } from '../voxelLighting.ts'
import { MAX_DECORATIONS, MAX_FLOWER_COLORS, type DecorationRegistry } from './defs.ts'

type N = ReturnType<typeof float>

function instance() {
  const inst = attribute('inst', 'uvec2')
  const a = inst.x, b = inst.y
  const cell = vec3(a.bitAnd(uint(31)).toFloat(), a.shiftRight(uint(5)).bitAnd(uint(31)).toFloat().add(1), a.shiftRight(uint(10)).bitAnd(uint(31)).toFloat())
  const world = modelWorldMatrix.mul(vec4(cell, 1)).xyz
  return {
    cell, world,
    edge: a.shiftRight(uint(15)).bitAnd(uint(15)),
    sky: varying(a.shiftRight(uint(19)).bitAnd(uint(15)).toFloat().div(15)),
    blk: varying(a.shiftRight(uint(23)).bitAnd(uint(15)).toFloat().div(15)),
    deco: b.bitAnd(uint(255)).toInt(),
    color: b.shiftRight(uint(8)).bitAnd(uint(7)).toInt(),
    rnd: hash(world.x.mul(73.1).add(world.z.mul(19.7)).add(world.y.mul(7.3))),
  }
}

const v4 = (c: readonly number[], w = 1) => new THREE.Vector4(c[0], c[1], c[2], w)

export function createDecorationMaterials(reg: DecorationRegistry, lights: LightUniforms) {
  const radius = uniform(96)
  const pad = <T>(xs: T[], n: number, fill: T) => [...xs, ...new Array<T>(Math.max(0, n - xs.length)).fill(fill)]
  const params = uniformArray(pad(reg.defs.map((d) => new THREE.Vector4(d.grass?.blades ?? 0, d.grass?.height[0] ?? 0, d.grass?.height[1] ?? 0, d.grass?.overhang ?? 0)), MAX_DECORATIONS, new THREE.Vector4()), 'vec4')
  const bases = uniformArray(pad(reg.defs.map((d) => v4(d.grass?.base ?? [0, 0, 0])), MAX_DECORATIONS, new THREE.Vector4()), 'vec4')
  const tips = uniformArray(pad(reg.defs.map((d) => v4(d.grass?.tip ?? [0, 0, 0])), MAX_DECORATIONS, new THREE.Vector4()), 'vec4')
  const petals = uniformArray(reg.defs.flatMap((d) => pad((d.flowers?.colors ?? []).map((c) => v4(c)), MAX_FLOWER_COLORS, new THREE.Vector4()))
    .concat(new Array(Math.max(0, (MAX_DECORATIONS - reg.defs.length) * MAX_FLOWER_COLORS)).fill(new THREE.Vector4())), 'vec4')
  const fadeAt = (world: N) => float(1).sub(smoothstep(radius.mul(0.6), radius, world.xz.add(0.5).sub(cameraPosition.xz).length()))
  const wind = (world: N, rnd: N) => mx_noise_float(vec3(world.xz.mul(0.07).add(time.mul(0.5)), time.mul(0.15))).mul(0.18)
    .add(sin(time.mul(2.1).add(rnd.mul(6.283))).mul(0.04))

  // ---- grass ----
  const gi = instance()
  const pos = attribute('position', 'vec3'), info = attribute('info', 'vec4')
  const P = params.element(gi.deco)
  const k = floor(gi.rnd.mul(8))
  const swap = k.mod(2).greaterThan(0.5), mirX = floor(k.div(2)).mod(2).greaterThan(0.5), mirZ = k.greaterThanEqual(4)
  const sx = select(swap, info.w, info.z), sz = select(swap, info.z, info.w)
  const rx = select(mirX, float(1).sub(sx), sx), rz = select(mirZ, float(1).sub(sz), sz)
  const t = pos.y
  const fade = fadeAt(gi.world)
  const height = mix(P.y, P.z, info.y).mul(fade).mul(gi.rnd.mul(0.3).add(0.85))
  const bit = (m: number) => select(gi.edge.bitAnd(uint(m)).notEqual(uint(0)), float(1), float(0))
  const leanX = bit(1).mul(smoothstep(0.55, 1, rx)).sub(bit(2).mul(smoothstep(0.55, 1, float(1).sub(rx))))
  const leanZ = bit(4).mul(smoothstep(0.55, 1, rz)).sub(bit(8).mul(smoothstep(0.55, 1, float(1).sub(rz))))
  const t2 = t.mul(t)
  const over = P.w.mul(fade)
  const sway = wind(gi.world, gi.rnd)
  const local = vec3(
    rx.add(pos.x.sub(info.z)).add(leanX.mul(over).mul(1.6).add(sway).mul(t2)),
    t.mul(height).sub(vec2(leanX, leanZ).length().mul(over).mul(0.5).mul(t2)),
    rz.add(pos.z.sub(info.w)).add(leanZ.mul(over).mul(1.6).add(sway.mul(0.6)).mul(t2)),
  )
  const grass = new VoxelNodeMaterial(gi.sky)
  grass.positionNode = select(info.x.lessThan(P.x), gi.cell.add(local), gi.cell.add(vec3(0.5, 0, 0.5)))
  const vt = varying(t), vr = varying(gi.rnd)
  const gAlbedo = mix(bases.element(gi.deco).xyz, tips.element(gi.deco).xyz, vt.pow(1.2)).mul(vr.mul(0.3).add(0.85))
  grass.colorNode = vec4(gAlbedo, 1)
  grass.side = THREE.DoubleSide
  voxelLit(grass, { normal: vec3(0, 1, 0), sky: gi.sky, blk: gi.blk, ao: mix(float(0.55), float(1), vt), albedo: gAlbedo }, lights)

  // ---- flowers ----
  const fi = instance()
  const fpos = attribute('position', 'vec3'), finfo = attribute('info', 'vec4')
  const ffade = fadeAt(fi.world)
  const scale = ffade.mul(fi.rnd.mul(0.4).add(0.8))
  const ft = finfo.y
  const fsway = wind(fi.world, fi.rnd).mul(ft.mul(ft))
  const ox = fi.rnd.mul(0.6).add(0.2), oz = fract(fi.rnd.mul(13.7)).mul(0.6).add(0.2)
  const flowers = new VoxelNodeMaterial(fi.sky)
  flowers.positionNode = fi.cell.add(vec3(ox.add(fpos.x.mul(scale)).add(fsway), fpos.y.mul(scale), oz.add(fpos.z.mul(scale)).add(fsway.mul(0.6))))
  const petal = petals.element(fi.deco.mul(MAX_FLOWER_COLORS).add(fi.color)).xyz
  const fAlbedo = select(varying(finfo.x).lessThan(0.5), vec3(0.16, 0.36, 0.09), petal)
  flowers.colorNode = vec4(fAlbedo, 1)
  flowers.side = THREE.DoubleSide
  voxelLit(flowers, { normal: vec3(0, 1, 0), sky: fi.sky, blk: fi.blk, ao: float(1), albedo: fAlbedo }, lights)

  return { grass, flowers, radius }
}
```

- [ ] **Step 5: Implement `decorationMeshes.ts`**

`packages/engine/src/render/decorations/decorationMeshes.ts`:
```ts
import * as THREE from 'three/webgpu'
import type { Layout } from '../../world/layout.ts'
import { selectVisible, type DecorationChunk } from './budget.ts'
import { flowerArrays, tuftArrays, type DecorationArrays } from './shapes.ts'

const SPHERE_R = 16 * Math.sqrt(3) + 2.5

function baseGeometry(a: DecorationArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(a.position, 3))
  g.setAttribute('info', new THREE.BufferAttribute(a.info, 4))
  g.setIndex(new THREE.BufferAttribute(a.index, 1))
  return g
}

interface Entry { grass: THREE.Mesh | null; flowers: THREE.Mesh | null; count: number; centre: THREE.Vector3 }

/** Per-chunk instanced grass and flowers, culled by distance and an instance ceiling. */
export class DecorationMeshes {
  readonly group = new THREE.Group()
  private readonly layout: Layout
  private readonly materials: { grass: THREE.Material; flowers: THREE.Material }
  private readonly tuft = baseGeometry(tuftArrays())
  private readonly flower = baseGeometry(flowerArrays())
  private readonly entries = new Map<number, Entry>()

  constructor(layout: Layout, materials: { grass: THREE.Material; flowers: THREE.Material }) {
    this.layout = layout
    this.materials = materials
    this.group.name = 'elovox-decorations'
  }

  apply(ci: number, grass: Uint32Array | null, flowers: Uint32Array | null): void {
    this.remove(ci)
    if (!grass && !flowers) return
    const [cx, cy, cz] = this.layout.chunkCoords(ci)
    const e: Entry = {
      grass: grass ? this.mesh(grass, this.tuft, this.materials.grass, cx, cy, cz) : null,
      flowers: flowers ? this.mesh(flowers, this.flower, this.materials.flowers, cx, cy, cz) : null,
      count: (grass?.length ?? 0) / 2 + (flowers?.length ?? 0) / 2,
      centre: new THREE.Vector3(cx * 32 + 16, cy * 32 + 16, cz * 32 + 16),
    }
    this.entries.set(ci, e)
  }

  remove(ci: number): void {
    const e = this.entries.get(ci)
    if (!e) return
    for (const m of [e.grass, e.flowers]) {
      if (!m) continue
      this.group.remove(m)
      // Disposing releases the shared base attributes too; three re-uploads them (a few KB) on next use.
      m.geometry.dispose()
    }
    this.entries.delete(ci)
  }

  cull(camera: THREE.Vector3, radius: number, maxInstances: number): { instances: number; draws: number } {
    const list: DecorationChunk[] = []
    for (const [ci, e] of this.entries) list.push({ ci, dist: e.centre.distanceTo(camera), count: e.count })
    const show = selectVisible(list, radius, maxInstances)
    let instances = 0, draws = 0
    for (const [ci, e] of this.entries) {
      const on = show.has(ci)
      for (const m of [e.grass, e.flowers]) if (m) { m.visible = on; if (on) draws++ }
      if (on) instances += e.count
    }
    return { instances, draws }
  }

  dispose(): void {
    for (const ci of [...this.entries.keys()]) this.remove(ci)
    this.tuft.dispose()
    this.flower.dispose()
    this.materials.grass.dispose()
    this.materials.flowers.dispose()
  }

  private mesh(data: Uint32Array, base: THREE.BufferGeometry, material: THREE.Material, cx: number, cy: number, cz: number): THREE.Mesh {
    const g = new THREE.InstancedBufferGeometry()
    g.index = base.index
    g.setAttribute('position', base.getAttribute('position'))
    g.setAttribute('info', base.getAttribute('info'))
    const inst = new THREE.InstancedBufferAttribute(data, 2)
    inst.gpuType = THREE.IntType // read as uvec2 in the shader (spike P4)
    g.setAttribute('inst', inst)
    g.instanceCount = data.length / 2
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(16, 16, 16), SPHERE_R)
    const m = new THREE.Mesh(g, material)
    m.position.set(cx * 32, cy * 32, cz * 32)
    m.matrixAutoUpdate = false
    m.updateMatrix()
    m.raycast = () => {}
    m.castShadow = false
    m.receiveShadow = true
    m.name = `deco-${cx}-${cy}-${cz}`
    this.group.add(m)
    return m
  }
}
```

- [ ] **Step 6: Wire decorations into `Visuals` and the engine**

In `packages/engine/src/render/visuals.ts`:
- Add `decorations: DecorationRegistry` to `VisualsOptions`.
- Add fields `private readonly deco: DecorationMeshes`, `private readonly decoRadius` (the uniform), and `private decoStats = { instances: 0, draws: 0 }`.
- In the constructor:
```ts
    const dm = createDecorationMaterials(o.decorations, this.lights)
    this.decoRadius = dm.radius
    this.deco = new DecorationMeshes(o.layout, dm)
    o.scene.add(this.deco.group)
```
- In `applyMesh`, add `this.deco.apply(ci, data.grass, data.flowers)`.
- In `frame`, before rendering:
```ts
    this.deco.group.visible = this.effects.decorations
    this.decoRadius.value = this.quality.decorationRadius
    this.decoStats = this.effects.decorations
      ? this.deco.cull(this.o.camera.position, this.quality.decorationRadius, this.quality.decorationMaxInstances)
      : { instances: 0, draws: 0 }
```
- `stats()` returns `{ shadowCasters, decorationInstances: this.decoStats.instances, decorationDraws: this.decoStats.draws }`.
- In `dispose`: `this.o.scene.remove(this.deco.group); this.deco.dispose()`.

In `packages/engine/src/engine.ts`, pass `decorations` (the `DecorationRegistry` from Task 11) into `new Visuals({...})`. Add `decorationInstances` and `decorationDraws` to `EngineStats` and fill them from `visuals.stats()`.

In `apps/sandbox/src/hud.ts`, add a line: `` `decorations ${s.decorationInstances} instances   ${s.decorationDraws} draws   shadow casters ${s.shadowCasters}` ``.

- [ ] **Step 7: Run tests and typecheck**

Run: `npm test` and `npm run typecheck`
Expected: all pass.

- [ ] **Step 8: Browser check and Checkpoint 2 (controller)**

Open `?scene=diorama`, `?scene=diorama&webgl` and `?size=1024`. Expected:
- Grass tops carry dense tufts that sway in the wind. At the terrace and cliff edges and around holes, blades lean out and hang over the edge, as in the primary reference.
- Flowers appear in patches in the colours of the palette.
- Shadows fall on the grass.
- Dig a grass block's neighbour: the remaining block's tuft starts hanging into the hole in the same frame as the geometry update. Place a block on grass: its tuft disappears at once.
- Zooming out, grass shrinks smoothly to nothing by about 96 blocks with no popping. The HUD shows instance and draw counts. `__elovox.engine.quality = { decorationRadius: 48 }` shrinks the grassy area.
- `#fx-decorations` toggles them.
- No console errors.

**Checkpoint 2:** save screenshots of the diorama (close-up of a terrace edge with water and foam, plus a wide view) on WebGPU. Ask the user for a visual review of water and grass. Commit the requested tuning as `tune(engine): …` before Task 13.

- [ ] **Step 9: Commit**

```bash
git add packages/engine/src/render/decorations packages/engine/src/render/visuals.ts packages/engine/src/engine.ts packages/engine/test/decorationShapes.test.ts packages/engine/test/decorationBudget.test.ts apps/sandbox/src/hud.ts
git commit -m "feat(engine): instanced grass and flowers with wind, edge overhang and distance fade"
```

---
### Task 13: Alpha dilation and texture checks

**Files:**
- Modify: `packages/engine/src/render/tiles.ts` (`dilateAlpha`), `packages/engine/src/render/textureArray.ts` (dilate every loaded tile)
- Test: `packages/engine/test/tiles.test.ts`

**Interfaces:**
- Produces: `dilateAlpha(px: Uint8Array, size = TILE, passes = 4): Uint8Array`. It returns a copy. Each pass gives every transparent texel (alpha < 128) that has an opaque or already-filled 8-neighbour the average colour of those neighbours. Alpha is never changed, and the tile wraps at its edges.

- [ ] **Step 1: Write the failing tests**

Append to `packages/engine/test/tiles.test.ts`:
```ts
import { dilateAlpha } from '../src/render/tiles.ts'

describe('dilateAlpha', () => {
  const S = 16
  const at = (x: number, y: number) => (y * S + x) * 4
  function tile(): Uint8Array {
    const px = new Uint8Array(S * S * 4) // transparent black
    px.set([200, 40, 20, 255], at(1, 1)) // one opaque red texel
    return px
  }
  it('bleeds opaque colour into neighbouring transparent texels without touching alpha', () => {
    const out = dilateAlpha(tile(), S, 1)
    expect([...out.subarray(at(2, 2), at(2, 2) + 4)]).toEqual([200, 40, 20, 0])
    expect([...out.subarray(at(0, 0), at(0, 0) + 4)]).toEqual([200, 40, 20, 0])
    expect([...out.subarray(at(3, 3), at(3, 3) + 4)]).toEqual([0, 0, 0, 0]) // two texels away after one pass
  })
  it('wraps around the tile edges', () => {
    const out = dilateAlpha(tile(), S, 2)
    expect([...out.subarray(at(S - 1, S - 1), at(S - 1, S - 1) + 3)]).toEqual([200, 40, 20])
  })
  it('stops after `passes` texels and never changes alpha', () => {
    const src = tile()
    const out = dilateAlpha(src, S, 4)
    expect([...out.subarray(at(9, 9), at(9, 9) + 4)]).toEqual([0, 0, 0, 0])
    for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(src[i])
  })
  it('leaves fully opaque tiles unchanged', () => {
    const px = new Uint8Array(S * S * 4).fill(255)
    expect(dilateAlpha(px, S)).toEqual(px)
  })
})
```
(Merge the import into the existing import from `../src/render/tiles.ts`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/engine -- tiles`
Expected: FAIL (`dilateAlpha` is not exported).

- [ ] **Step 3: Implement**

Append to `packages/engine/src/render/tiles.ts`:
```ts
/**
 * Bleeds the colour of opaque texels into neighbouring transparent ones, `passes` texels deep, so GPU-averaged
 * mip levels of cutout tiles don't pull in the black of transparent texels (dark fringes). Alpha is untouched.
 */
export function dilateAlpha(px: Uint8Array, size = TILE, passes = 4): Uint8Array {
  const out = px.slice()
  let filled = new Uint8Array(size * size)
  for (let i = 0; i < size * size; i++) filled[i] = out[i * 4 + 3]! >= 128 ? 1 : 0
  for (let p = 0; p < passes; p++) {
    const src = out.slice()
    const next = filled.slice()
    let changed = false
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x
      if (filled[i]) continue
      let r = 0, g = 0, b = 0, n = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        const j = ((y + dy + size) % size) * size + ((x + dx + size) % size)
        if (!filled[j]) continue
        r += src[j * 4]!; g += src[j * 4 + 1]!; b += src[j * 4 + 2]!; n++
      }
      if (n === 0) continue
      out[i * 4] = Math.round(r / n); out[i * 4 + 1] = Math.round(g / n); out[i * 4 + 2] = Math.round(b / n)
      next[i] = 1
      changed = true
    }
    filled = next
    if (!changed) break
  }
  return out
}
```

In `packages/engine/src/render/textureArray.ts`, import `dilateAlpha` and dilate after loading:
```ts
    await Promise.all(names.map(async (n) => {
      const px = textures[n] ? await loadTilePixels(textures[n]!) : null
      return [n, px ? dilateAlpha(px) : null] as const
    })),
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test` and `npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Browser check (controller)**

Open `?scene=diorama` (WebGPU) and `?scene=diorama&webgl`. Zoom out so the tree canopies are small on screen. The leaf edges should show no dark outline, compared against a screenshot taken before this task. Re-confirm C11 (mipmaps and anisotropy) if Checkpoint 1 left it open.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/render/tiles.ts packages/engine/src/render/textureArray.ts packages/engine/test/tiles.test.ts
git commit -m "fix(engine): dilate cutout tile colours so mipmaps don't fringe dark"
```

---

### Task 14: Procedural painter core

**Files:**
- Create: `apps/sandbox/src/paint/raster.ts`, `apps/sandbox/src/paint/noise.ts`, `apps/sandbox/src/paint/shade.ts`
- Test: `apps/sandbox/test/paintCore.test.ts`

**Interfaces:**
- Produces (all pure, no DOM):
  - `raster.ts`:
    - `SIZE = 64`, `N = SIZE²`, `type RGB = readonly [number, number, number]` (sRGB 0–1), `type Rand = () => number`
    - `rng(seed): Rand`, `wrap(x, y): number` (index on the torus), `hex(h): RGB`, `vary(c, r, amount): RGB`, `mixRgb(a, b, t): RGB`, `scaleRgb(c, k): RGB`
    - `interface Layer { height: Float32Array; color: Float32Array; alpha: Float32Array }`, `createLayer(base, height = 0.5, alpha = 1): Layer`
    - `paint(l, i, c, h?, a?): void`
    - `disc(cx, cy, r, fn: (i, d) => void): void` (wrapped; `d` = distance / r)
  - `noise.ts`:
    - `tileNoise(seed, x, y, px, py = px): number`, periodic over `SIZE` on both axes, in [0, 1)
    - `tileFbm(seed, x, y, period, octaves): number`
    - `worley(seed, x, y, cells): { d: number; d2: number; id: number }`, periodic, with distances in cell units
    - `hashId(id): number` in [0, 1)
  - `shade.ts`: `interface ShadeOptions { cavity?; highlight?; baked?; jitter?; seed? }` and `shade(l: Layer, o?: ShadeOptions): Uint8ClampedArray` (RGBA bytes).

**How shading works** (spec §8 layers 3–6):
- `cav = clamp01((blur₂(h) − h) × 5)` darkens by `1 − cavity·cav`.
- `edge = clamp((∂h/∂x + ∂h/∂y) × 2.8, −1, 1)`, using wrapped central differences, scales by `1 + highlight·edge`. The light comes from the top left, so slopes facing up and left brighten.
- The baked light term is `1 + baked·(h − 0.5)`.
- Jitter `j = (tileNoise(seed, x, y, 4) − 0.5) × jitter` shifts the channels by `(1 + j, 1 + 0.6j, 1 − 0.4j)`.
- Defaults: `cavity 0.45, highlight 0.5, baked 0.3, jitter 0.05`.

- [ ] **Step 1: Write the failing tests**

`apps/sandbox/test/paintCore.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { hashId, tileFbm, tileNoise, worley } from '../src/paint/noise.ts'
import { N, SIZE, createLayer, disc, hex, paint, rng, wrap } from '../src/paint/raster.ts'
import { shade } from '../src/paint/shade.ts'

describe('raster', () => {
  it('wraps coordinates onto the 64×64 torus', () => {
    expect(wrap(-1, 0)).toBe(SIZE - 1)
    expect(wrap(64, 64)).toBe(0)
    expect(wrap(3, -1)).toBe((SIZE - 1) * SIZE + 3)
  })
  it('stamps discs across the edges', () => {
    const hit = new Set<number>()
    disc(0, 0, 2, (i) => hit.add(i))
    expect(hit.has(wrap(-1, -1))).toBe(true)
    expect(hit.has(wrap(0, 0))).toBe(true)
  })
  it('seeds a repeatable generator', () => {
    const a = rng(5), b = rng(5)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })
})

describe('tileable noise', () => {
  const r = rng(9)
  it('repeats every SIZE pixels on both axes and stays in [0, 1)', () => {
    for (let k = 0; k < 50; k++) {
      const x = r() * SIZE, y = r() * SIZE
      const v = tileNoise(3, x, y, 8)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      expect(tileNoise(3, x + SIZE, y, 8)).toBeCloseTo(v, 9)
      expect(tileNoise(3, x, y - SIZE, 8, 4)).toBeCloseTo(tileNoise(3, x, y, 8, 4), 9)
      expect(tileFbm(4, x + SIZE, y + SIZE, 4, 3)).toBeCloseTo(tileFbm(4, x, y, 4, 3), 9)
      expect(worley(5, x + SIZE, y, 8).d).toBeCloseTo(worley(5, x, y, 8).d, 9)
    }
  })
  it('orders worley distances and hashes ids into [0, 1)', () => {
    const c = worley(5, 10.5, 20.5, 8)
    expect(c.d).toBeLessThanOrEqual(c.d2)
    expect(hashId(c.id)).toBeGreaterThanOrEqual(0)
    expect(hashId(c.id)).toBeLessThan(1)
  })
})

describe('shade', () => {
  it('keeps a flat layer close to its base colour and copies alpha', () => {
    const l = createLayer(hex('#808080'), 0.5, 0.5)
    const px = shade(l)
    expect(px.length).toBe(N * 4)
    for (let i = 0; i < N; i++) {
      expect(Math.abs(px[i * 4]! - 128)).toBeLessThanOrEqual(5)
      expect(px[i * 4 + 3]).toBe(128)
    }
  })
  it('lights slopes that face the top-left and darkens the far side', () => {
    const l = createLayer(hex('#808080'))
    disc(32, 32, 10, (i, d) => paint(l, i, hex('#808080'), 0.5 + 0.4 * (1 - d * d)))
    const px = shade(l, { jitter: 0 })
    expect(px[wrap(26, 26) * 4]!).toBeGreaterThan(px[wrap(38, 38) * 4]!)
  })
  it('darkens cavities', () => {
    const l = createLayer(hex('#808080'), 0.8)
    for (let y = 0; y < SIZE; y++) paint(l, wrap(32, y), hex('#808080'), 0.1)
    const px = shade(l, { highlight: 0, jitter: 0 })
    expect(px[wrap(32, 10) * 4]!).toBeLessThan(px[wrap(10, 10) * 4]! - 20)
  })
  it('is deterministic', () => {
    const l = createLayer(hex('#6699cc'))
    expect(shade(l, { seed: 3 })).toEqual(shade(l, { seed: 3 }))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/sandbox -- paintCore`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `raster.ts`, `noise.ts` and `shade.ts`**

`apps/sandbox/src/paint/raster.ts`:
```ts
export const SIZE = 64
export const N = SIZE * SIZE
/** sRGB, 0–1 per channel. */
export type RGB = readonly [number, number, number]
export type Rand = () => number

export function rng(seed: number): Rand {
  let s = seed >>> 0 || 1
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296
}

/** Pixel index on the 64×64 torus: everything the painter draws wraps, so every tile is seamless. */
export function wrap(x: number, y: number): number {
  const xi = ((Math.floor(x) % SIZE) + SIZE) % SIZE
  const yi = ((Math.floor(y) % SIZE) + SIZE) % SIZE
  return yi * SIZE + xi
}

export function hex(h: string): RGB {
  const n = Number.parseInt(h.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
export function scaleRgb(c: RGB, k: number): RGB { return [c[0] * k, c[1] * k, c[2] * k] }
export function mixRgb(a: RGB, b: RGB, t: number): RGB { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] }
export function vary(c: RGB, r: Rand, amount: number): RGB { return scaleRgb(c, 1 + (r() - 0.5) * 2 * amount) }

/** A tile being painted: height drives the shading pass; colour is sRGB 0–1; alpha 0–1. */
export interface Layer { height: Float32Array; color: Float32Array; alpha: Float32Array }

export function createLayer(base: RGB, height = 0.5, alpha = 1): Layer {
  const l: Layer = { height: new Float32Array(N).fill(height), color: new Float32Array(N * 3), alpha: new Float32Array(N).fill(alpha) }
  for (let i = 0; i < N; i++) l.color.set(base, i * 3)
  return l
}

export function paint(l: Layer, i: number, c: RGB, h?: number, a?: number): void {
  l.color[i * 3] = c[0]; l.color[i * 3 + 1] = c[1]; l.color[i * 3 + 2] = c[2]
  if (h !== undefined) l.height[i] = h
  if (a !== undefined) l.alpha[i] = a
}

/** Calls fn for every pixel whose centre lies in the wrapped disc; d is distance / r (0 at the centre, 1 at the rim). */
export function disc(cx: number, cy: number, r: number, fn: (i: number, d: number) => void): void {
  for (let py = Math.floor(cy - r); py <= Math.ceil(cy + r); py++) for (let px = Math.floor(cx - r); px <= Math.ceil(cx + r); px++) {
    const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy) / r
    if (d <= 1) fn(wrap(px, py), d)
  }
}
```

`apps/sandbox/src/paint/noise.ts`:
```ts
import { SIZE } from './raster.ts'

function hash2(seed: number, i: number, j: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(j + 0x1b873593, 0x27d4eb2f)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}
const smooth = (t: number) => t * t * (3 - 2 * t)
const mod = (a: number, n: number) => ((a % n) + n) % n

/** [0, 1) for any integer id. */
export function hashId(id: number): number { return hash2(0x51ed27, id, 0) }

/** Value noise on a px × py lattice spanning the tile, so it repeats every SIZE pixels on both axes. [0, 1). */
export function tileNoise(seed: number, x: number, y: number, px: number, py = px): number {
  const fx = (x / SIZE) * px, fy = (y / SIZE) * py
  const ix = Math.floor(fx), iy = Math.floor(fy)
  const tx = smooth(fx - ix), ty = smooth(fy - iy)
  const L = (i: number, j: number) => hash2(seed, mod(i, px), mod(j, py))
  const top = L(ix, iy) + (L(ix + 1, iy) - L(ix, iy)) * tx
  const bottom = L(ix, iy + 1) + (L(ix + 1, iy + 1) - L(ix, iy + 1)) * tx
  return top + (bottom - top) * ty
}

export function tileFbm(seed: number, x: number, y: number, period: number, octaves: number): number {
  let sum = 0, amp = 0.5, norm = 0, p = period
  for (let o = 0; o < octaves; o++) {
    sum += amp * tileNoise(seed + o * 101, x, y, p)
    norm += amp
    amp *= 0.5
    p *= 2
  }
  return Math.min(sum / norm, 0.999999)
}

/** Wrapped Worley noise on a cells × cells grid (cells must divide SIZE): nearest and second-nearest distances in cell units. */
export function worley(seed: number, x: number, y: number, cells: number): { d: number; d2: number; id: number } {
  const cs = SIZE / cells
  const fx = mod(x, SIZE) / cs, fy = mod(y, SIZE) / cs
  const ix = Math.floor(fx), iy = Math.floor(fy)
  let d = Infinity, d2 = Infinity, id = 0
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    const cx = ix + ox, cy = iy + oy
    const wx = mod(cx, cells), wy = mod(cy, cells)
    const dist = Math.hypot(cx + hash2(seed, wx, wy) - fx, cy + hash2(seed + 1, wx, wy) - fy)
    if (dist < d) { d2 = d; d = dist; id = wy * cells + wx } else if (dist < d2) d2 = dist
  }
  return { d, d2, id }
}
```

`apps/sandbox/src/paint/shade.ts`:
```ts
import { tileNoise } from './noise.ts'
import { N, SIZE, wrap, type Layer } from './raster.ts'

export interface ShadeOptions { cavity?: number; highlight?: number; baked?: number; jitter?: number; seed?: number }

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

function boxBlur(h: Float32Array, r: number): Float32Array {
  const tmp = new Float32Array(N), out = new Float32Array(N), n = 2 * r + 1
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    let s = 0
    for (let k = -r; k <= r; k++) s += h[wrap(x + k, y)]!
    tmp[y * SIZE + x] = s / n
  }
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    let s = 0
    for (let k = -r; k <= r; k++) s += tmp[wrap(x, y + k)]!
    out[y * SIZE + x] = s / n
  }
  return out
}

/** Hand-painted look from a height field: darkened cavities, lit edges (light from the top left), baked light, hue jitter. */
export function shade(l: Layer, o: ShadeOptions = {}): Uint8ClampedArray {
  const cavity = o.cavity ?? 0.45, highlight = o.highlight ?? 0.5, baked = o.baked ?? 0.3, jitter = o.jitter ?? 0.05, seed = o.seed ?? 1
  const h = l.height
  const blur = boxBlur(h, 2)
  const out = new Uint8ClampedArray(N * 4)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = y * SIZE + x
    const cav = clamp01((blur[i]! - h[i]!) * 5)
    const gx = h[wrap(x + 1, y)]! - h[wrap(x - 1, y)]!
    const gy = h[wrap(x, y + 1)]! - h[wrap(x, y - 1)]!
    const edge = Math.min(1, Math.max(-1, (gx + gy) * 2.8))
    const k = (1 - cavity * cav) * (1 + highlight * edge) * (1 + baked * (h[i]! - 0.5))
    const j = jitter === 0 ? 0 : (tileNoise(seed, x, y, 4) - 0.5) * jitter
    out[i * 4] = Math.round(255 * clamp01(l.color[i * 3]! * k * (1 + j)))
    out[i * 4 + 1] = Math.round(255 * clamp01(l.color[i * 3 + 1]! * k * (1 + 0.6 * j)))
    out[i * 4 + 2] = Math.round(255 * clamp01(l.color[i * 3 + 2]! * k * (1 - 0.4 * j)))
    out[i * 4 + 3] = Math.round(255 * clamp01(l.alpha[i]!))
  }
  return out
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -w @elovox/sandbox` and `npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/sandbox/src/paint apps/sandbox/test/paintCore.test.ts
git commit -m "feat(sandbox): tileable procedural painter core (raster, noise, hand-painted shading)"
```

---

### Task 15: Painted tiles

**Files:**
- Create: `apps/sandbox/src/paint/materials.ts`, `apps/sandbox/src/paint/index.ts`
- Rewrite: `apps/sandbox/src/textures.ts`
- Test: `apps/sandbox/test/painter.test.ts`

**Interfaces:**
- Consumes: everything from Task 14.
- Produces:
  - `materials.ts`: one painter `(r: Rand) => Layer` per tile, plus `TILES: readonly (readonly [name: string, paint: (r: Rand) => Layer, shade: ShadeOptions])[]`.
  - `index.ts`:
    - `paintTiles(): Record<string, Uint8ClampedArray>` (seeded, deterministic)
    - `SEAMLESS_X: readonly string[]` and `SEAMLESS_Y: readonly string[]`, the tiles that must tile horizontally and vertically.
  - `textures.ts`: `paintTextures(): Record<string, string>` (PNG data URLs; same signature as before).

The tile list matches the spec §8 table:
- `stone`, `dirt`, `grass_top`, `grass_side`, `sand`, `log_side`, `log_top`, `planks`, `leaves`, `rock`, `glass`, `torch`, `water`.
- `grass_side` (its fringe is at the top) and `log_side` (bark stripes run vertically, but stay continuous) tile horizontally; `grass_side` is the only one that doesn't tile vertically.
- `log_top` (concentric rings) and `torch` (a single sprite) don't need to tile.

- [ ] **Step 1: Write the failing tests**

`apps/sandbox/test/painter.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { SEAMLESS_X, SEAMLESS_Y, paintTiles } from '../src/paint/index.ts'
import { SIZE } from '../src/paint/raster.ts'

const tiles = paintTiles()
const NAMES = ['stone', 'dirt', 'grass_top', 'grass_side', 'sand', 'log_side', 'log_top', 'planks', 'leaves', 'rock', 'glass', 'torch', 'water']

function pairDiffs(px: Uint8ClampedArray, axis: 'x' | 'y'): number[] {
  const at = (x: number, y: number, c: number) => px[(y * SIZE + x) * 4 + c]!
  const out: number[] = []
  for (let k = 0; k < SIZE; k++) {
    const k2 = (k + 1) % SIZE
    let s = 0
    for (let m = 0; m < SIZE; m++) for (let c = 0; c < 3; c++) {
      s += axis === 'x' ? Math.abs(at(k, m, c) - at(k2, m, c)) : Math.abs(at(m, k, c) - at(m, k2, c))
    }
    out.push(s / (SIZE * 3))
  }
  return out // out[SIZE - 1] is the seam pair (63 → 0)
}
function seamOk(px: Uint8ClampedArray, axis: 'x' | 'y'): boolean {
  const d = pairDiffs(px, axis)
  const seam = d[SIZE - 1]!
  const interior = d.slice(0, SIZE - 1).sort((a, b) => a - b)
  return seam <= 1.5 * interior[Math.floor(interior.length * 0.9)]! + 1
}

describe('paintTiles', () => {
  it('paints every tile the sandbox blocks use, as 64×64 RGBA', () => {
    expect(Object.keys(tiles).sort()).toEqual([...NAMES].sort())
    for (const n of NAMES) expect(tiles[n]!.length).toBe(SIZE * SIZE * 4)
  })
  it('is deterministic', () => {
    expect(paintTiles()).toEqual(tiles)
  })
  it.each(SEAMLESS_X)('%s tiles horizontally', (n) => expect(seamOk(tiles[n]!, 'x')).toBe(true))
  it.each(SEAMLESS_Y)('%s tiles vertically', (n) => expect(seamOk(tiles[n]!, 'y')).toBe(true))
  it('keeps solid tiles opaque and gives leaves holes', () => {
    for (const n of ['stone', 'dirt', 'grass_top', 'grass_side', 'sand', 'log_side', 'log_top', 'planks', 'rock']) {
      const px = tiles[n]!
      for (let i = 3; i < px.length; i += 4) expect(px[i]).toBe(255)
    }
    const leaves = tiles.leaves!
    let holes = 0
    for (let i = 3; i < leaves.length; i += 4) if (leaves[i] === 0) holes++
    expect(holes).toBeGreaterThan(SIZE * SIZE * 0.05)
    expect(holes).toBeLessThan(SIZE * SIZE * 0.5)
  })
  it('puts the green fringe at the top of grass_side', () => {
    const px = tiles.grass_side!
    const g = (y: number) => { let s = 0; for (let x = 0; x < SIZE; x++) s += px[(y * SIZE + x) * 4 + 1]! - px[(y * SIZE + x) * 4]!; return s / SIZE }
    expect(g(2)).toBeGreaterThan(20) // green dominates red at the top
    expect(g(60)).toBeLessThan(0) // dirt (red-brown) at the bottom
  })
})
```

A failing seam test means a drawing op isn't wrapping. Fix the op; don't loosen the threshold.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @elovox/sandbox -- painter`
Expected: FAIL (`../src/paint/index.ts` not found).

- [ ] **Step 3: Implement the tile painters**

`apps/sandbox/src/paint/materials.ts`:
```ts
import { hashId, tileFbm, tileNoise, worley } from './noise.ts'
import { SIZE, createLayer, disc, hex, mixRgb, paint, scaleRgb, vary, wrap, type Layer, type RGB, type Rand } from './raster.ts'
import type { ShadeOptions } from './shade.ts'

interface Courses { rows: readonly number[]; minW: number; maxW: number; gap: number; round: number; mortar: RGB; mortarH: number }

/** Rows of bricks/plates (row heights sum to SIZE) with random widths and a random shift per row; everything wraps. */
function courses(l: Layer, r: Rand, c: Courses, colour: (r: Rand) => RGB): void {
  let y0 = 0
  for (const rh of c.rows) {
    const widths: number[] = []
    let sum = 0
    while (sum < SIZE) {
      let w = Math.round(c.minW + r() * (c.maxW - c.minW))
      if (SIZE - sum - w < c.minW) w = SIZE - sum
      widths.push(w)
      sum += w
    }
    let x0 = Math.floor(r() * SIZE)
    for (const w of widths) {
      const col = colour(r), tilt = (r() - 0.5) * 0.3
      for (let yy = 0; yy < rh; yy++) for (let xx = 0; xx < w; xx++) {
        const i = wrap(x0 + xx, y0 + yy)
        const e = Math.min(xx + 0.5, w - xx - 0.5, yy + 0.5, rh - yy - 0.5)
        if (e < c.gap) { paint(l, i, c.mortar, c.mortarH); continue }
        const s = Math.min(1, (e - c.gap) / c.round)
        paint(l, i, col, 0.45 + 0.4 * s * s * (3 - 2 * s) + tilt * (xx / w - 0.5))
      }
      x0 += w
    }
    y0 += rh
  }
}

/** Fine surface grain on height and colour. */
function roughen(l: Layer, seed: number, amount: number): void {
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y), n = tileNoise(seed, x, y, 16) - 0.5
    l.height[i]! += n * amount
    for (let c = 0; c < 3; c++) l.color[i * 3 + c]! *= 1 + n * amount * 0.8
  }
}

export function stone(r: Rand): Layer {
  const base = hex('#7f8a9c')
  const l = createLayer(base)
  courses(l, r, { rows: [14, 18, 15, 17], minW: 14, maxW: 28, gap: 1.4, round: 4, mortar: hex('#4b5260'), mortarH: 0.1 }, (r) => vary(base, r, 0.1))
  roughen(l, 11, 0.08)
  return l
}

export function dirt(r: Rand): Layer {
  const l = createLayer(hex('#6b3f2a'), 0.4)
  const pebbles = [hex('#8a5a3c'), hex('#5a3424'), hex('#7a6250')]
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y), n = tileFbm(21, x, y, 8, 3)
    paint(l, i, scaleRgb(hex('#6b3f2a'), 0.85 + n * 0.3), 0.3 + n * 0.3)
    const c = worley(22, x, y, 8)
    if (c.d < 0.32 && hashId(c.id) < 0.35) paint(l, i, vary(pebbles[c.id % 3]!, r, 0.03), 0.55 + 0.4 * (1 - c.d / 0.32))
  }
  return l
}

export function grassTop(r: Rand): Layer {
  const base = hex('#5fa03a')
  const l = createLayer(base, 0.45)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const n = tileFbm(31, x, y, 8, 3)
    paint(l, wrap(x, y), scaleRgb(base, 0.85 + n * 0.3), 0.4 + n * 0.15)
  }
  const greens = ['#7cc04a', '#4f8a2e', '#8fd157', '#6aae3f'].map(hex)
  for (let s = 0; s < 260; s++) {
    const x0 = r() * SIZE, y0 = r() * SIZE, ang = r() * Math.PI * 2, len = 4 + r() * 5, w = 1.2 + r() * 0.6
    const col = vary(greens[Math.floor(r() * greens.length)]!, r, 0.06)
    for (let t = 0; t <= 1; t += 0.12) {
      disc(x0 + Math.cos(ang) * len * t, y0 + Math.sin(ang) * len * t, w * (1 - t * 0.7), (i, d) => paint(l, i, col, 0.55 + 0.35 * (1 - t) - 0.1 * d))
    }
  }
  return l
}

export function grassSide(r: Rand): Layer {
  const l = dirt(r)
  const green = hex('#5fa03a'), dark = hex('#3f7a2a')
  const drips = Array.from({ length: 9 }, () => ({ x: r() * SIZE, w: 2 + r() * 3, len: 4 + r() * 9 }))
  for (let x = 0; x < SIZE; x++) {
    const base = 9 + tileNoise(41, x, 0, 8, 1) * 6
    let depth = base
    for (const d of drips) {
      const dx = Math.min(Math.abs(x + 0.5 - d.x), SIZE - Math.abs(x + 0.5 - d.x))
      if (dx < d.w) depth = Math.max(depth, base + d.len * Math.sqrt(1 - (dx / d.w) ** 2))
    }
    for (let y = 0; y < depth; y++) {
      const t = y / depth
      paint(l, wrap(x, y), mixRgb(green, dark, t * 0.5), 0.7 - 0.2 * t)
    }
  }
  return l
}

export function sand(r: Rand): Layer {
  const base = hex('#d8b77a')
  const l = createLayer(base)
  courses(l, r, { rows: [11, 10, 12, 9, 12, 10], minW: 14, maxW: 24, gap: 1, round: 3.5, mortar: hex('#a8854f'), mortarH: 0.15 }, (r) => vary(base, r, 0.08))
  roughen(l, 51, 0.06)
  return l
}

export function logSide(_r: Rand): Layer {
  const l = createLayer(hex('#6e4b2a'))
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const n = tileNoise(61, x, y, 16, 2), n2 = tileNoise(62, x, y, 32, 4)
    const groove = n < 0.32
    paint(l, wrap(x, y), groove ? hex('#4a3019') : scaleRgb(hex('#6e4b2a'), 0.85 + 0.3 * n2), groove ? 0.1 : 0.35 + 0.5 * n + 0.15 * n2)
  }
  return l
}

export function logTop(_r: Rand): Layer {
  const l = createLayer(hex('#c49a63'))
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y)
    const d = Math.hypot(x + 0.5 - 32, y + 0.5 - 32)
    const wob = tileNoise(71, x, y, 8) * 1.5
    if (d > 28) { paint(l, i, scaleRgb(hex('#5a3c21'), 0.9 + 0.2 * wob), 0.5 + 0.15 * wob); continue }
    const ring = ((d + wob) / 4.5) % 1
    paint(l, i, ring < 0.22 ? hex('#9a6f40') : scaleRgb(hex('#c49a63'), 0.95 + 0.1 * wob), ring < 0.22 ? 0.35 : 0.6)
  }
  return l
}

export function planks(r: Rand): Layer {
  const base = hex('#b48a55')
  const l = createLayer(base)
  courses(l, r, { rows: [16, 16, 16, 16], minW: 30, maxW: 34, gap: 0.8, round: 1.5, mortar: hex('#5e4026'), mortarH: 0.05 }, (r) => vary(base, r, 0.08))
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y), g = tileNoise(111, x, y, 2, 32)
    l.height[i]! += (g - 0.5) * 0.2
    for (let c = 0; c < 3; c++) l.color[i * 3 + c]! *= 0.9 + g * 0.2
  }
  return l
}

export function leaves(_r: Rand): Layer {
  const l = createLayer(hex('#4f8f35'), 0.3)
  const greens = ['#5fa040', '#3f7a2a', '#6bb04a', '#4f8f35'].map(hex)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y), c = worley(81, x, y, 8)
    if (c.d < 0.42) {
      const k = 1 - c.d / 0.42
      paint(l, i, scaleRgb(greens[c.id % greens.length]!, 0.85 + 0.25 * k), 0.4 + 0.5 * k, 1)
    } else if (tileNoise(82, x, y, 8) < 0.5) {
      paint(l, i, hex('#2f5a20'), 0.05, 0)
    } else {
      paint(l, i, hex('#2f5a20'), 0.15, 1)
    }
  }
  return l
}

export function rock(_r: Rand): Layer {
  const l = createLayer(hex('#8e939c'))
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const n = tileFbm(91, x, y, 4, 4), c = worley(92, x, y, 4)
    const crack = c.d2 - c.d < 0.06
    paint(l, wrap(x, y), mixRgb(hex('#7f8796'), hex('#a3a8b0'), n), 0.35 + 0.45 * n - (crack ? 0.3 : 0))
  }
  return l
}

export function glass(_r: Rand): Layer {
  const l = createLayer(hex('#d7ecff'), 0.5, 0.22)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y)
    if (x < 3 || x > 60 || y < 3 || y > 60) paint(l, i, hex('#ffffff'), 0.7, 0.85)
    else if (Math.abs(x - y - 10) < 2) paint(l, i, hex('#ffffff'), 0.5, 0.4)
  }
  return l
}

export function torch(_r: Rand): Layer {
  const l = createLayer(hex('#000000'), 0, 0)
  for (let y = 26; y < SIZE; y++) for (let x = 29; x <= 34; x++) paint(l, wrap(x, y), hex('#6e4b2a'), 0.6, 1)
  disc(32, 18, 7, (i, d) => paint(l, i, mixRgb(hex('#fff3a0'), hex('#ffb02e'), d), 0.8 - 0.3 * d, 1))
  return l
}

export function water(_r: Rand): Layer {
  const l = createLayer(hex('#3f9fd0'), 0.5, 0.8)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (tileNoise(101, x, y, 4, 16) > 0.62) paint(l, wrap(x, y), hex('#8fd3f0'), 0.6, 0.8)
  }
  return l
}

export const TILES: readonly (readonly [string, (r: Rand) => Layer, ShadeOptions])[] = [
  ['stone', stone, {}],
  ['dirt', dirt, {}],
  ['grass_top', grassTop, { highlight: 0.35 }],
  ['grass_side', grassSide, {}],
  ['sand', sand, {}],
  ['log_side', logSide, {}],
  ['log_top', logTop, {}],
  ['planks', planks, {}],
  ['leaves', leaves, {}],
  ['rock', rock, { highlight: 0.4 }],
  ['glass', glass, { cavity: 0, highlight: 0, baked: 0 }],
  ['torch', torch, { cavity: 0, baked: 0.1 }],
  ['water', water, { cavity: 0, highlight: 0.15 }],
]
```

`apps/sandbox/src/paint/index.ts`:
```ts
import { TILES } from './materials.ts'
import { rng } from './raster.ts'
import { shade } from './shade.ts'

/** Tiles greedy meshing may repeat side by side, so they must tile on that axis. */
export const SEAMLESS_X: readonly string[] = ['stone', 'dirt', 'grass_top', 'grass_side', 'sand', 'log_side', 'planks', 'leaves', 'rock', 'glass', 'water']
export const SEAMLESS_Y: readonly string[] = ['stone', 'dirt', 'grass_top', 'sand', 'log_side', 'planks', 'leaves', 'rock', 'glass', 'water']

/** Every sandbox tile as 64×64 RGBA bytes. Deterministic. */
export function paintTiles(): Record<string, Uint8ClampedArray> {
  const out: Record<string, Uint8ClampedArray> = {}
  TILES.forEach(([name, paintTile, opts], k) => { out[name] = shade(paintTile(rng(1000 + k)), { seed: 500 + k, ...opts }) })
  return out
}
```

`apps/sandbox/src/textures.ts` (replaces the whole file):
```ts
import { paintTiles } from './paint/index.ts'

/** The painter's tiles as PNG data URLs, the format createEngine's `textures` option takes. */
export function paintTextures(): Record<string, string> {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext('2d')!
  const out: Record<string, string> = {}
  for (const [name, px] of Object.entries(paintTiles())) {
    ctx.putImageData(new ImageData(new Uint8ClampedArray(px), 64, 64), 0, 0)
    out[name] = canvas.toDataURL('image/png')
  }
  return out
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test` and `npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Browser check (controller)**

Open `?scene=diorama` on both backends. Expected:
- Stone cliffs show irregular blue-grey bricks with dark mortar and lit top-left edges. Dirt bands are dark red-brown with pebbles. Sand mounds show stacked rounded plates. Grass sides drip green over the dirt.
- No visible seams where merged faces repeat a tile across a large wall.
- No console errors.

- [ ] **Step 6: Commit**

```bash
git add apps/sandbox/src/paint apps/sandbox/src/textures.ts apps/sandbox/test/painter.test.ts
git commit -m "feat(sandbox): hand-painted-style procedural tiles"
```

---

### Task 16: GPU timing, stats, e2e and performance (Checkpoint 3)

**Files:**
- Modify: `packages/engine/src/engine.ts` (`gpuTiming` option, `gpuMs` stat)
- Modify: `apps/sandbox/src/main.ts` (`?gpu`), `apps/sandbox/src/hud.ts` (GPU time)
- Rewrite: `apps/sandbox/e2e/smoke.spec.ts`
- Modify: `docs/superpowers/plans/2026-10-02-visual-polish.md` (append "Performance results")

**Interfaces:**
- Produces: `EngineOptions.gpuTiming?: boolean` (default false, Deviation 7) and `EngineStats.gpuMs: number | null` (null when not tracked or not supported).

- [ ] **Step 1: GPU timing**

In `packages/engine/src/engine.ts`:
- Add `gpuTiming?: boolean` to `EngineOptions` and `gpuMs: number | null` to `EngineStats`.
- Create the renderer with `new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: o.forceWebGL ?? false, trackTimestamp: o.gpuTiming ?? false })`.
- Add `let gpuMs: number | null = null, gpuFrames = 0` beside the other frame counters. In the animation loop, after `visuals.frame(dt)`:
```ts
    if (o.gpuTiming && ++gpuFrames % 30 === 0) {
      renderer.resolveTimestampsAsync('render').then((ms) => { if (typeof ms === 'number') gpuMs = ms }).catch(() => {})
    }
```
- In `stats()`: `gpuMs`.

In `apps/sandbox/src/main.ts`, pass `gpuTiming: params.has('gpu')`. In `hud.ts`, append `` `   gpu ${s.gpuMs === null ? '—' : s.gpuMs.toFixed(2) + ' ms'}` `` to the first line.

- [ ] **Step 2: Rewrite the e2e test**

`apps/sandbox/e2e/smoke.spec.ts`:
```ts
import { expect, test, type Page } from '@playwright/test'
import type { Engine } from '@elovox/engine'

type W = Window & { __elovox?: { engine: Engine; ready: boolean } }

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}
async function boot(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 90_000 })
}

test('sandbox boots isolated, renders, and round-trips an edit', async ({ page }) => {
  const errors = watchErrors(page)
  await boot(page, '/?size=128')
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
  const r = await page.evaluate(async () => {
    type A = { seq: number; ok: boolean }
    const e = (window as W).__elovox!.engine
    const ack = (seq: number) => new Promise<A>((res) => { const off = e.on('ack', (a) => { if (a.seq === seq) { off(); res(a) } }) })
    const stone = e.blocks.id('stone')
    const s1 = e.submit({ type: 'setBlock', pos: [10, 120, 10], voxel: stone })
    const ghost = e.world.get(10, 120, 10)
    const a1 = await ack(s1)
    const placed = e.world.get(10, 120, 10)
    const a2 = await ack(e.submit({ type: 'setBlock', pos: [10, 120, 10], voxel: 0 }))
    const bad = await ack(e.submit({ type: 'setBlock', pos: [10, 128, 10], voxel: stone }))
    return { stone, ghost, a1: a1.ok, placed, a2: a2.ok, removed: e.world.get(10, 120, 10), bad: bad.ok }
  })
  expect(r).toEqual({ stone: r.stone, ghost: r.stone, a1: true, placed: r.stone, a2: true, removed: 0, bad: false })
  await expect(page.locator('#hud')).toContainText('fps')
  const shot = await page.locator('canvas').screenshot()
  expect(shot.byteLength).toBeGreaterThan(10_000) // a blank canvas compresses to far less
  expect(errors).toEqual([])
})

for (const scene of ['world', 'diorama'] as const) {
  test(`${scene} scene renders on WebGL2 and switches presets and effects from the HUD`, async ({ page }) => {
    const errors = watchErrors(page)
    await boot(page, scene === 'world' ? '/?size=128&webgl' : '/?scene=diorama&webgl')
    expect(await page.evaluate(() => (window as W).__elovox!.engine.stats().backend)).toBe('webgl')
    await page.locator('#preset-sunset').click()
    await page.waitForFunction(() => (window as W).__elovox!.engine.atmosphere.current.sun.elevation < 15, null, { timeout: 10_000 })
    await page.locator('#fx-shadows').uncheck()
    expect(await page.evaluate(() => (window as W).__elovox!.engine.effects.shadows)).toBe(false)
    await page.locator('#fx-shadows').check()
    const shot = await page.locator('canvas').screenshot()
    expect(shot.byteLength).toBeGreaterThan(10_000)
    expect(errors).toEqual([])
  })
}
```

Run: `npm run e2e`
Expected: 3 passed.

- [ ] **Step 3: Performance measurement (controller)**

Run `npm run dev`. In headed Chromium (WebGPU), open `http://localhost:5173/?size=1024&gpu`. Wait for the mesh queue to reach 0, then hold the default 3/4 view for 10 s. Record from the HUD:
- fps, frame ms, GPU ms, draws, shadow casters, decoration instances and draws.
- The GPU ms with each effect turned off on its own (shadows, decorations, water, post, fog). The difference from the all-on value is that effect's cost.
- The same at the maximum zoom-out (distance 400) and in `?scene=diorama&gpu`.
- `npm run bench:node -w @elovox/engine`.

Compare against the spec §9 budgets. Append to this plan:
```markdown
## Performance results (Task 16)

Machine: … (the user's desktop, not a mid-range laptop)

| View | fps | frame ms | GPU ms | draws | deco instances | shadow casters |
|---|---|---|---|---|---|---|
| world 1024, 3/4 default | | | | | | |
| world 1024, zoomed out | | | | | | |
| diorama | | | | | | |

| Effect | GPU ms cost | Budget | OK? |
|---|---|---|---|
| shadows | | 2.5 | |
| decorations | | 3 | |
| water | | 1 | |
| post (sky + grading) | | 1.5 | |

bench:node: … ms/chunk (limit 3 ms)
```
If an effect is over budget, **don't change the defaults silently**. Report the numbers to the user with the options (`quality` defaults, effect parameters) at Checkpoint 3.

- [ ] **Step 4: Checkpoint 3 (controller)**

Save final screenshots: the diorama (`diorama` preset), the 1024 world in `open` and `sunset`, a close-up of a terrace edge with grass, water and foam, all on WebGPU, plus one WebGL2 diorama shot. Present them with the performance table to the user for the final visual review. Commit any requested tuning as `tune(...)` commits.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/engine.ts apps/sandbox/src/main.ts apps/sandbox/src/hud.ts apps/sandbox/e2e/smoke.spec.ts docs/superpowers/plans/2026-10-02-visual-polish.md
git commit -m "test: e2e for both scenes and presets; opt-in GPU timing; record performance results"
```

---

## Spec coverage map

| Spec section | Tasks |
|---|---|
| §3 Atmosphere (API, model, presets, validation) | 2, 5 (engine API), 8 (HUD) |
| §4 Lighting, shadow map, spike | 1, 3, 4, 5 |
| §5 Sky, fog, post | 6, 7 |
| §6 Water (liquid layer, material, params) | 9, 10 |
| §7 Decorations (definition, extraction, drawing, distance) | 11, 12 |
| §8 Painter, SP1 fixes (UV, mip fringe, C11), test scenes | 4 (UV), 8 (scenes, C11), 13, 14, 15 |
| §9 Performance (budgets, quality, stats) | 5, 11 (bench), 12, 16 |
| §10 Error handling | 2, 5, 10, 11 |
| §11 Testing and checkpoints | every task; checkpoints in 8, 12, 16 |

## Spike results (Task 1)

Checked 2026-10-02 in headed Chromium (Playwright, `--enable-unsafe-webgpu`), three 0.186.1.

| Check | WebGPU | WebGL2 | Notes |
|---|---|---|---|
| P1 shadow pass uses packed positionNode | pass | pass | step edges shadow the lower steps, aligned with the geometry; no acne or peter-panning at bias −0.0004 (kept) |
| P2 custom LightingModel + normalNode + receivedShadowNode | pass | pass | directional shading correct; shadows take the blue-grey tint |
| P3 viewportDepthTexture in a transparent material | pass | pass | white foam line where the water plane meets the pool walls |
| P4 integer InstancedBufferAttribute (uvec2) | pass | pass | 64 cubes in the 8 × 8 grid at y = 12 |
| P5 PCF radius soft shadows | pass | pass | radius 2.5 gives soft edges (kept) |
| P6 RenderPipeline + fogNode + backgroundNode + tone mapping | pass | pass | `?nopost` direct render also fine |
| P7 screenUV.y = 1 is at the … | bottom | bottom | "up" = `screenUV.y.oneMinus()` (the plan's default in sky.ts) |

Warnings seen: none (console clean on every variant; no "normal not found" warning).

Workarounds adopted (later tasks must apply them):
- None for three.js itself. `SUPPORT` stays all-true.
- Lesson: a value derived from an integer attribute (`packed`, `inst`) and read in the fragment stage must go through an explicit `varying()`. Otherwise it is flat-interpolated (constant per triangle). The spike's un-varyinged `uv` rendered flat; `chunkVertex()` already wraps uv/layer/sky/blk/ao/normal. The water and decoration materials must keep doing the same for any float they read in the fragment shader.
