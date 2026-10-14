# Sub-project 7: Game hooks — review

Spec: `docs/superpowers/specs/2026-10-14-game-hooks-design.md` · Plan: `docs/superpowers/plans/2026-10-14-game-hooks.md` ·
Ledger (every ruling, per task): `docs/superpowers/plans/2026-10-14-game-hooks.progress.md` · Branch `feat/game-hooks`.

## What was built, per spec section

- **§2 Game systems.** `SystemRunner` (`sim/systems.ts`) inside `Simulation`: `init` before the first tick (or `restore`
  from a save), `tick` once per unpaused tick right after the worker units, in list order, then `publish`; `name:` commands
  routed to their system and acked (a throw refuses only that command); each system has its own `Pcg32` (seeded from the
  world seed and its name, saved, mixed into `Simulation.hash()`); `SystemContext` with world reads, a conditional
  `edit` (the work-order commit's checks, extracted as `Simulation.editIf`), `emit` and `units`. Exceptions in `init`,
  `restore`, `tick`, `publish` are fatal (`system <name> <phase>: <message>`, reported through `fatal`). Publications
  travel in the tick message and arrive as `engine.on('system', { name, tick, payload })`. Exports:
  `@elovox/engine/sim-worker` (`defineSystem`, types) and `@elovox/engine` (`checkSystemSections`, types).
- **§2 Controlled units.** `WorkerSystem.spawnControlled / despawnControlled / goTo / work / stop`: never auto-assigned,
  refused by main-thread unit commands, one intent at a time; unit events `arrived`, `dug` (no stock, no pile), `built`
  (no stock), `failed { reason }`, `fell { height }`, `died { cause: 'void' }`. Dig/build intents are one-cell internal
  orders (negative id, as engineering actions); a lost task (fall, lease lapse, incapacitation, any block) fails the
  intent. Intents are saved (optional `controlled`/`intent`/`fallFrom` in the v1 workers section) and re-issued on load.
- **§2 Save.** Each system is section `system:<name>` with its own version; a missing, unknown or other-version system
  section is refused by the sim at boot (fatal) and can be checked by the game first with `checkSystemSections`.
- **§3 Void world.** `configure()` returning `{ void: true }`: water resting on y 0 (top or lowest lower segment, not a
  pressurized body) is drained into the sea account each step; falling blocks and fragments that pass the bottom are
  removed (`CollapseTick.removed`); the bottom is no support for units, navigation, regions, builds or collapse; units
  that fall out die (`unitDied` event, `died` unit event); `ready` carries `void`, `engine.voidWorld`; waterfall curtains
  fade out over their last 16 blocks; removed fragments vanish.
- **§4 Layer cut.** `engine.view.cut(y | null)`, `engine.view.cutY`: chunks wholly above are hidden (per-chunk meshes,
  region batches' draw list, decorations); the crossed chunk layer is remeshed with everything above `y` read as air
  (`applyCut`), its cut tops flagged (`CUT_BIT`, word A bit 30) and shaded ×0.72 (`CUT_SHADE`), decorations kept only
  where the cell was open before the cut; cut jobs go first (`PRIORITY.CUT`) and stale cut results are dropped and
  re-queued; water, falling blocks and fragments above the plane are discarded (`maskNode`); picking and the orbit
  camera's ground ignore what the cut hides. The sandbox hides its units above the cut (units are drawn by the game).
- **§5 Management camera.** `OrbitCamera.reset()` (home yaw/pitch, the short way round, target and zoom kept) and
  `EngineOptions.camera` (home view and pitch/distance limits).
- **§6 Time of day.** `engine.atmosphere.setTimeOfDay(t)` over `DAY_KEYFRAMES` (night, dawn, morning, noon, afternoon,
  sunset, dusk; replaceable with `defineDay`), `timeOfDay`; a preset set later takes over again. The light never comes
  from below 12° (tight shadow box at a low sun) and the shadow fades out between 12° and 3°.
- **§7 Testing.** Node: `systems`, `systemsSave`, `simHostSystems`, `controlledUnits`, `voidWorld`, `voidUnits`,
  `layerCut` and additions to `rng`, `savePackage`, `simHost`, `fragments`, `vertexFormat`, `greedy`, `meshJob`,
  `chunkMeshes`, `chunkBatches`, `decorationMeshes`, `orbitCamera`, `atmosphere`, `shadowFit`; sandbox `test/sky.test.ts`
  (the sky scene headless). e2e `e2e/sky.spec.ts` (void world, wander system, no water below, cut 40 + picking,
  night/dawn/noon screenshots, camera reset) and `e2e/cut-bench.spec.ts` (skips without `BENCH_CUT=1`).
- Sandbox: `?scene=sky` — a 256 × 96 × 256 void world with one floating island, a stream falling off the east edge, an
  overhanging shelf on the west, and the `wander` game system (3 controlled units walking, digging and building back);
  PageUp/PageDown move the cut, End clears it, Home resets the camera, a time-of-day slider.

## Deviations

From the plan (D1–D9, as planned): D1 system state is JSON; D2 the sim refuses system-section mismatches at boot and the
game can pre-check with `checkSystemSections`; D3 a `goTo` keeps retrying on `traffic`, every other block reason (and any
block of a dig/build) fails the intent; D4 `fell` is sent on landing with the height; D5 controlled units ignore tools
and stock; D6 systems do not tick while physics is paused; D7 water above the cut plane is discarded (a lake cut through
shows its bed); D8 the workers section stays v1 (new fields optional); D9 `cut(y)`: `y` is the highest visible layer.

Added during execution:

- **D10** `GameSystem.command` takes `CustomCommand` (fields readable without a cast); `CustomCommand` is exported.
- **D11** Decorations are a separate renderer, not hidden with their chunk: `DecorationMeshes` leaves chunks the cut hides
  out of its selection.
- **D12** Units are drawn by the game: the engine exposes `view.cutY` and the sandbox hides its units above the cut.

Every smaller ruling (test-world sizes, `fallFrom` saved for a unit falling at save time, `CutPlane.covered` 0/1/2,
`reset()` from the current yaw, conditional hash mixing, `maskNode` instead of `Discard`, …) is in the ledger with its
cost if wrong.

## Verification (2026-10-14, this machine, not a quiet-machine run)

- `npm run typecheck`: 0 errors (all workspaces).
- `npm test`: engine 117 files, 1245 passed + 2 expected-fail; other workspaces 174, 200 and 139 (sandbox) passed.
- e2e (`E2E_PORT=5197 E2E_CHANNEL=msedge npm run e2e -- --workers=1`): 47 passed, 17 skipped (benchmarks and checkpoint
  shots behind their env flags, `cut-bench` included), 0 failed, 3.7 min. Note: through the root script npm swallows
  `--workers=1` ("Unknown cli config"), so Playwright ran with its default 6 workers; nothing failed under that load.
  `e2e/sky.spec.ts` alone: passed (13 s).
- After the fix pass: `npm run typecheck` 0; `npm test` engine 117 files, 1255 passed + 2 expected-fail, other
  workspaces 174, 200 and 139 passed; e2e run from `apps/sandbox` with `npx playwright test --workers=1` (one worker,
  as intended): 47 passed, 17 skipped, 0 failed, 7.3 min.

## Pending for the user

- **BENCH_CUT** (quiet machine, twice, keep the worse): `BENCH_CUT=1 E2E_PORT=5197 E2E_CHANNEL=msedge npm run e2e --
  --workers=1 e2e/cut-bench.spec.ts` (add `BENCH_ASSERT=1` to assert p95 ≤ 150 ms). Not run: the user may be gaming.
- **Mesher gate** `npm run bench:node -w @elovox/engine` (3 ms/chunk) after the cut branch in the greedy inner loop. Not run.
- **User checkpoints** on `?scene=sky`: waterfall fades into the void with nothing pooling below; cut steps read as cut
  (darker tops), water/units above vanish, picking ignores hidden blocks; night dark but playable, dawn/sunset colours,
  low-sun shadows stable; Home camera reset; wander units walk, dig and build without hanging. Tuning knobs:
  `DAY_KEYFRAMES`, `CUT_SHADE`, `VOID_FADE_BLOCKS`.

## Findings of the independent review and the fix pass

1. (blocking, fixed) A save taken before the first tick lost the systems' init forever (init ran at the first step, a
   restore marks systems started, and `ready` came first). SimHost now runs `systems.start()` right after generating a
   new world, before `ready` (serial and pooled paths; not on a restore); an init throw stays fatal at boot.
2. (fixed) A simulation without systems silently accepted a save with `system:*` sections; it now refuses them with
   the same message as an unknown system section.
3. (documented) `void` comes from `configure()`, which runs only when a terrain document is given; a later
   `setDocument` that changes `void` changes the sim's physics but not `engine.voidWorld` or the waterfall fade (set at
   boot). Documented on `GeneratorConfig.void`; decide it at boot.
4. (fixed) The layer cut re-marked a stale result's chunk a second time, and `cut(y)` with the current `y` remeshed a
   whole layer: the stale result is now just dropped (`LayerCut.accepts`; the chunk is already queued again by the
   `cut()` that made it stale — argued in the ledger) and an unchanged cut remeshes nothing.
5. (tested) Review Focus 1 and 5: a controlled dig behind a unit that will not move, and a lapsed claim, both end with
   `failed { traffic }` and no intent; the stale-cut-result drop/requeue is unit-tested over a real `MeshQueue`.
6. (fixed) `view().intent` returned the internal object; it is a copy now.
7. (fixed) `fallFrom` was hashed for every controlled unit but saved only mid-fall; it is hashed only while falling.
8. (open, cosmetic) A fragment that falls out of a void world can vanish a few blocks early: the renderer interpolates
   one tick behind and removes it when the sim reports it gone.
9. (documented) The unit API throws for unknown, gone or uncontrolled ids (and out-of-bounds positions); inside `init`,
   `restore`, `tick` or `publish` that is fatal. Documented on `SystemUnits`.
10. (open) The deferred minors below.

## Open items and risks

- Deferred minors: `workDig`/`workBuild` without `ids` set `available = true` on controlled units (assignment still skips
  them; only the view's flag is wrong); `SystemRunner.restore` unpacks each section twice; a walk whose goal is taken
  by a settled unit is retargeted nearby, so `arrived` can come up to 4 blocks from the asked pose; the sky scene's HUD
  hint lists block-editing keys a units scene ignores.
- Fragments falling out of a void world can vanish a few blocks early (finding 8).
- `engine.voidWorld` and the waterfall fade follow the boot document only (finding 3).
- `threeCull` (the internal pixel-diff reference mode) ignores the cut.
- The `voidFloor` and `cutTop` uniforms are module-level (shared by engines in one page, like `waterAlpha`).
- A full lower segment that belongs to a pressurized body is not drained at the bottom of a void column (left to the
  body's regrouping); the overhang test stays dry, but a sealed tank opened at the bottom has not been tried.
- Night look (checkpoint 3, 2026-10-14): the user found the first night far too dark and asked for a soft, clearly
  visible, less saturated night with a lighter surface. Night/twilight keys now: ambient 0.72 neutral grey-blue, moon
  0.8 `#d6deef`, exposure 1.15/1.1, saturation 0.6/0.7. Accepted "for now": the game's art is still being made and the
  keyframes will be retuned with it.

## User checkpoints (2026-10-14, `?scene=sky`)

- Waterfall into the void: good. Cut steps, Home camera reset, wander units: good. Night: retuned (see above).
- Found at checkpoint 1: on the stream's one-block terraces the upper water looks like it ends one column before the
  step. Probe (headless sim, 3,000 ticks): the simulation has water up to the brink, depth falling 108 → 32 /256 along
  each 8-block terrace, so the brink column is wet (≥ SHOW_MIN 16) but drawn dry. The surface layout code
  (`surfaceView.ts`, `surfaceMesh.ts`) is untouched by this branch, so this is a pre-existing 3c water-render issue at
  shallow brinks, tracked separately.
