# Elovox — Sub-project 7: Game hooks — Design

Status: approved in brainstorming on 2026-10-14 (sections approved in chat). First engine sub-project driven by a game:
a colony sim built on Elovox in its own private repository, with this repository as a git submodule. The game's own
design lives there; this spec covers only what the engine must offer it.

## 1. Context

The game is a colony management sim on floating sky islands: the player designates work, colonists (engine worker
units) do it physically, and colony rules (needs, jobs, logistics) decide who does what. Its first sub-project is a
thin vertical slice: one generated island, four colonists with hunger, thirst and rest, a tree-cutting order, a
day/night clock at 1× and save/continue.

What the engine offers a game today (mapped on 2026-10-14, main 2728583):

- **Sim-side hooks are block rules and a generator.** `runSimWorker({ rules, generator })`; `RulesModule` has
  per-block callbacks (scheduled, neighbour, random tick) and custom command handlers `(ctx, cmd)` with a
  `RuleContext` (world get/set, schedule, random, emit). There is no per-tick hook and no game state of its own.
- **Worker units decide for themselves.** `WorkerSystem` (`sim/workers/workers.ts`) owns units, work orders, task
  expansion and assignment: any idle unit takes any order unless the order lists `ids`. Units dig into their own stock
  and leave loose piles (`drops` in `WorkerTick`). The main thread drives them by `WorkerCommand`s and reads
  `engine.on('workers')`, one tick late at best (the sandbox's `livingScript` does this).
- **Saves are per-section.** `Simulation.snapshot()` packs named sections (`scheduler`, `water`, `gravity`,
  `collapse`, `workers`) with versions in `SECTION_VERSIONS`; an incompatible section refuses the save (ADR 0004).
- **The world has a floor.** The bottom of the volume is fixed support (CONTEXT: *Fixed support*); water pools on
  it; with no sea level, springs are unbounded and nothing leaves the world.
- **No layer view.** Nothing hides the world above a height.
- **`OrbitCamera`** has target, yaw, pitch and distance with smoothing and pan clamped to the world; no reset.
- **`AtmosphereController`** switches between named presets with a timed transition; no continuous time of day.
  Shadow fit at low sun is an open follow-up from 2a.

| Topic | Decision |
|---|---|
| Where game logic runs | **In the sim worker, as game systems** called every tick after the units step. Rejected: driving the engine from the main thread (one-tick round trips, saves of world and game state taken at different moments, main-thread cost) and a separate game worker (same problems, more plumbing) |
| Unit control | **Controlled units**: a game-owned unit is never auto-assigned; the game tells it where to go and what to dig or build |
| Resources | **Owned by the game.** A controlled unit's dig yields an event, not engine stock or a pile |
| Save | **Each system is a save section** taken in the same tick as the world |
| Floating islands | **Void world**: the bottom of the volume is a sink for water, falling blocks and units |
| Layer view | **`engine.view.cut(y)`**: remesh the chunks the cut crosses as if everything above were air |
| Time of day | **`engine.atmosphere.setTimeOfDay(t)`** over keyframes, driven by the game each frame |

## 2. Game systems

### API

```ts
// game's sim.worker.ts
runSimWorker({ rules, generator, systems: [colony] })

export interface GameSystem<State = unknown, Pub = unknown> {
  /** Unique; also the save section name (prefixed `system:`) and the command prefix (`name:`). */
  name: string
  /** Section version; a save with another version is refused like an engine section. */
  version: number
  /** A new world, after generation and before the first tick. */
  init?(ctx: SystemContext): void
  /** Loading a save: called instead of init with the state snapshot() returned. */
  restore?(ctx: SystemContext, state: State): void
  /** Once per tick, after the units step. */
  tick(ctx: SystemContext): void
  /** A command whose type starts with `name:`; throw an Error to refuse it (the ack carries the message). */
  command?(ctx: SystemContext, cmd: Command): void
  /** Structured-cloneable state for the save. */
  snapshot(): State
  /** Optional payload posted to the main thread with this tick; undefined posts nothing. */
  publish?(ctx: SystemContext): Pub | undefined
}
export function defineSystem<S, P>(s: GameSystem<S, P>): GameSystem<S, P>
```

Main thread: commands go through `engine.submit({ type: 'colony:cutTrees', … })` and are acked like any command;
publications arrive as `engine.on('system', ({ name, tick, payload }) => …)`. The engine never interprets payloads.

### Tick order

commands (including system commands) → rules → gravity → water → collapse → units → **systems, in list order** →
publication.

A system sees this tick's unit results (arrivals, digs, failures). What it asks of units takes effect in the next
tick's unit step. A system never sees a world half-way through a step.

### SystemContext

- `tick`, `random()` (a Pcg32 per system, seeded from the world seed and the system name, saved with the system).
- **World reads**: `get`, `isSolid`, `isLiquid`, `falls`, `skyLight`, `blockLight`, `waterDepth(x, y, z)`, `layout`.
- **Conditional writes**: `edit(pos, expected, value)` with the same checks and hooks as a work-order commit (no
  overlap with units, falling bodies or fragments); returns false when refused.
- **Units** (`ctx.units`):
  - `spawn(pos, { controlled })` → id; `despawn(id)`.
  - `goTo(id, pos)`, `dig(id, pos)`, `build(id, pos, voxel)`, `stop(id)`: one intent per controlled unit; a new one
    replaces the old. Digging and building use the unit's work pose search and route actions as today.
  - `view(id)`: pose, state, current intent and block reason.
  - `events`: this tick's unit events: `arrived`, `dug { pos, voxel }`, `built { pos }`, `failed { reason }`,
    `fell`, `died { cause: 'void' }`. Other causes (crushed by a falling block, drowned) are a later sub-project.
- `emit(type, payload)` as in rules (engine `event`).

### Controlled units

- The assignment loop skips them; order expansion never hands them tasks.
- They keep everything else of a worker unit: navigation, reservations, wading, sleeping, safety checks (fleeing rising
  water, falling).
- A controlled unit's dig removes the voxel and emits `dug`; it adds nothing to the unit's stock and leaves no pile.
  Building takes no stock either: the game decided the material is there.
- Uncontrolled units behave exactly as today, so the sandbox scenes and benches are untouched.

### Save and errors

- `snapshot()` is called in the same tick as the world snapshot; the state is packed as section `system:<name>` with
  the system's version. `openSave` refuses a save whose system sections are missing, unknown or of another version,
  with the same error shape as engine sections.
- An exception thrown by a system's `init`, `restore`, `tick` or `publish` is fatal to the simulation and reported
  through `fatal` like a rule error. A throw in `command` only refuses that command.

### Out of scope

Systems in several workers, hot reload, a configurable order between systems, a typed command schema (systems validate
their own commands).

## 3. Void world

- A generator's `configure()` may return `{ void: true }`. Without it, nothing changes.
- **Water**: water that reaches the bottom layer of the volume leaves the world and is credited to the sea account,
  which then only acts as a sink (springs keep running as they do with no sea level).
- **Falling blocks and structural fragments** that reach the bottom of the volume are removed instead of landing.
- **Units** below the bottom of the volume die (`died { cause: 'void' }` for controlled units; an engine event for
  others).
- **Navigation** treats the void floor as no support.
- **Render**: a waterfall curtain over a cliff fades out over its last blocks instead of splashing on a floor.

## 4. Layer cut

`engine.view.cut(y: number | null)`; `null` shows everything.

- Chunks entirely above `y` are hidden.
- Chunks the cut crosses are remeshed with every voxel above `y` read as air, so the cut top shows solid faces, not
  holes. Faces created only by the cut are shaded a little darker, so a cut reads differently from the ground.
- Water, decorations, units, falling bodies and fragments above `y` are hidden.
- Simulation, light and collision are untouched; raycasts (picking) ignore what the cut hides.
- The cut's chunks go to the front of the mesh queue. **Target: one cut step drawn in ≤ 150 ms** on the laptop on a
  256² island (about 64 chunks).

## 5. Management camera

`OrbitCamera` gains `reset()` (back to the default yaw and pitch, keeping the target) and options for the pitch and
distance limits. Key bindings stay with the game.

## 6. Time of day

`engine.atmosphere.setTimeOfDay(t)`, `t` in [0, 1): interpolates a keyframe set (night, dawn, morning, noon, sunset,
dusk) for sun azimuth and elevation, light colour and intensity, sky and fog. The game calls it every frame from its
clock. The default keyframes give enough ambient and moon light to play at night. Shadow fit is fixed for a low sun.
Presets keep working; `setTimeOfDay` takes over until a preset is set again.

## 7. Testing

- **Game systems** (Node, `@elovox/engine/testing`), with an example system that steers a controlled unit:
  - tick order (sees this tick's unit events; its intents act next tick);
  - a `name:` command acked, a refused one acked with the error;
  - unit events: arrived, dug (no stock, no pile), failed with reason, died;
  - controlled units are never auto-assigned while uncontrolled ones still are;
  - save/load round trip with a system section; a missing or other-version section refused;
  - a throwing tick is fatal.
- **Void world**: water over an edge drains and the account balances; a falling block and a fragment leave the world; a
  unit stepping off dies; a world without `void` behaves as before (existing suites).
- **Layer cut and time of day**: e2e screenshots (cut through terrain with water; night, dawn, noon); a cut-step
  benchmark against the 150 ms target.
- All existing suites and e2e stay green.

## 8. Order

Game systems first (the riskiest piece and the one the game's slice needs to start), then void world, layer cut,
camera and time of day, which are independent of each other.
