# Game Hooks (SP7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a game what it needs from the engine to build a colony sim on floating islands: game systems that run inside the sim tick with controlled units and their own save sections, a void world, a layer cut view, a resettable management camera and a continuous time of day.

**Architecture:** A `SystemRunner` inside `Simulation` calls each game system once per tick right after the worker units step, routes `name:` commands to it, packs its state as save section `system:<name>` and collects its publications into the tick message. `WorkerSystem` gains *controlled units*: never auto-assigned, driven by one intent at a time (`goTo`, `dig`, `build`), reporting unit events; their digs add no stock and leave no pile. A generator may declare a void world, making the bottom of the volume a sink for water, falling blocks, fragments and units. The layer cut remeshes the one chunk layer the cut crosses with everything above read as air, hides the chunks above and discards water and moving bodies above the cut plane.

**Tech Stack:** TypeScript, three.js r186 (WebGPU, TSL), vitest 4, Playwright, npm workspaces (`@elovox/engine`, `@elovox/sandbox`).

**Spec:** `docs/superpowers/specs/2026-10-14-game-hooks-design.md`

## Planning findings and deviations from the spec

Mapped on 2026-10-14 (main 2728583):

- Rule and command-handler exceptions are logged, not fatal; only what escapes `Simulation.step()` reaches `SimHost.fail()`. Systems therefore run inside `step()`'s `try` and their errors are rethrown, wrapped with the system's name.
- `Pcg32` keeps its state private; it needs `state()`/`setState()` for a system's generator to be saved.
- The work-order commit (`WorkerSystem.beforePhysics`) is the only path that digs or builds from a work pose; engineering actions already build one-cell internal orders with id `-u.id`. Controlled work intents reuse that pattern.
- Nothing emits an event when a unit starts or stops falling; a unit at `y === 0` is supported (`hasSupport`, `fall`, `NavigationSystem.stand`, `regions.ts vacant`, `attached`, collapse support search, gravity landing). Each needs the void flag.
- `GeneratorConfig` is consumed only in `Simulation.configure` (`simulation.ts:201-205`); `SimHost` calls it only when a terrain document is given.
- A fragment is removed from the renderer only after a landing (`fragmentTrack.ts`); a falling block disappears by itself once it leaves `falling`.
- The mesher's merge key leaves bits 28–30 free and vertex word A leaves bits 30–31 free (`vertexFormat.ts:6-9`).
- `OrbitOptions` already has `minPitch`, `maxPitch`, `minDistance`, `maxDistance`; `EngineOptions` cannot pass them.

Deviations (record each in the final review doc):

- **D1 System state is JSON.** `snapshot()` returns a JSON-serializable value (the save packs it with `pack({ json })`), not any structured-cloneable value: no `Map`, `Set` or typed arrays.
- **D2 Where a version mismatch is caught.** `openSave` runs before the game's systems are known, so it cannot refuse them. The sim refuses at boot (fatal, same message lines as `checkManifest`), and the game can check before booting with the new `checkSystemSections(manifest, systems)`.
- **D3 Failures of a `goTo` intent ignore `traffic`.** A walking controlled unit keeps the engine's retry on `traffic` (as move orders do today); every other block reason, and any block of a `dig`/`build` intent, ends the intent with `failed`.
- **D4 `fell` is sent on landing**, with the height fallen in blocks.
- **D5 Controlled units ignore tools and stock** when they dig or build: the game owns resources.
- **D6 Systems do not tick while physics is paused** (as units).
- **D7 Cut and water.** Water above the cut plane is discarded in its fragment shader; a lake cut through shows its bed, not a water cap.
- **D8 Worker section stays v1.** New unit fields (`controlled`, `intent`) are optional; older saves load.
- **D9 `engine.view.cut(y)`: `y` is the highest visible layer.** Voxels with `y > cut` read as air in the cut layer; the cut plane is at world height `cut + 1`.

## Global Constraints

- Determinism: a system's `random()` is a `Pcg32` seeded from the world seed and the system name and saved with it; systems run in list order; the runner's generator states are mixed into `Simulation.hash()`.
- Faithful, not bit-identical (ADR 0004): routes and searches of controlled units are rebuilt after a load; their intents are saved and re-issued.
- Uncontrolled units, scenes without systems and worlds without `void` behave exactly as before: every existing suite stays green unchanged.
- Cut target: one cut step drawn in ≤ 150 ms on the laptop on a 256² world (BENCH_CUT, quiet machine).
- Quiet-machine rule for every benchmark: no games or heavy apps running (check `Get-Process`); ask the user when unsure; worse of two runs.
- TSL: never use `select()` with shared nodes (three r186 bug, see memory `tsl-select-branch-bug`); use `mix`/`step` or `Discard(cond)`.
- Regressions: `npm run typecheck`, `npm test`, e2e `E2E_PORT=5197 E2E_CHANNEL=msedge npm run e2e -- --workers=1` green. Load-sensitive timeouts (`waterColumns` conservation, `densityBrush`, `surfaceView incremental`) can fail in the parallel suite; re-run alone before treating as real.
- Commits: no `Co-Authored-By` trailer (no `attribution.commit` in `.claude/settings.json`). Branch: rename this branch to `feat/game-hooks` before Task 1 (`git branch -m feat/game-hooks`).
- Repo artifacts in English.

## Review Focus

1. A controlled unit whose dig or build loses its task to a lease timeout, a fall or incapacitation must get `failed` and end the intent — never stay idle holding an intent. (Task 5, test "a dig intent that loses its task fails instead of hanging".)
2. Main-thread unit commands that name a controlled unit are refused, and an order without `ids` never gives a controlled unit a task. (Task 4, tests "refuses unitMove on a controlled unit" and "never assigns a controlled unit".)
3. A save taken while a controlled unit walks to dig, loaded, resumes the dig or fails with an event — no silent idle. (Task 5, test "a dig intent survives a save".)
4. Water spilled next to an island's overhang drains into the void and does not pile up under it; the conservation check stays quiet. (Task 6, test "water beside an overhang drains, none collects underneath".)
5. Moving the cut several steps faster than meshes return leaves every chunk meshed for the final cut, nothing hidden that should show. (Task 10, test "stale cut results are dropped and re-queued".)

---

### Task 1: The system runner in the simulation

**Files:**
- Create: `packages/engine/src/sim/systems.ts`
- Modify: `packages/engine/src/sim/rng.ts` (state get/set)
- Modify: `packages/engine/src/sim/commands.ts:28` (`validateCommand` takes a `{ has(type) }`)
- Modify: `packages/engine/src/sim/simulation.ts` (options, constructor, `step`, `applyCommand`, `editIf`, `hash`)
- Modify: `packages/engine/src/sim/workers/types.ts` (`Intent`, `UnitEvent`)
- Modify: `packages/engine/src/sim/workers/workers.ts` (`takeUnitEvents` stub; filled in Task 4)
- Test: `packages/engine/test/systems.test.ts`, `packages/engine/test/rng.test.ts`

**Interfaces:**
- Produces:
  - `export interface GameSystem<State = unknown, Pub = unknown> { name: string; version: number; init?(ctx: SystemContext): void; restore?(ctx: SystemContext, state: State): void; tick(ctx: SystemContext): void; command?(ctx: SystemContext, cmd: Command): void; snapshot(): State; publish?(ctx: SystemContext): Pub | undefined }`
  - `export function defineSystem<S, P>(s: GameSystem<S, P>): GameSystem<S, P>`
  - `export interface SystemContext { readonly tick: number; readonly layout: Layout; random(): number; id(name: string): number; get(x, y, z): number; isSolid(v): boolean; isLiquid(v): boolean; falls(v): boolean; skyLight(x, y, z): number; blockLight(x, y, z): number; waterDepth(x, y, z): number; edit(pos: Vec3, expected: number, value: number): boolean; emit(type: string, payload?: unknown): void; readonly units: SystemUnits }`
  - `export interface SystemUnits { readonly events: readonly UnitEvent[]; spawn(pos: Vec3): number; despawn(id: number): void; goTo(id: number, pos: Vec3): void; dig(id: number, pos: Vec3): void; build(id: number, pos: Vec3, voxel: number): void; stop(id: number): void; view(id: number): WorkerView | undefined }`
  - `export interface SystemPublication { name: string; payload: unknown }`
  - `export class SystemRunner` (internal), `TickResult.systems?: SystemPublication[]`
  - `SimulationOptions.systems?: readonly GameSystem[]`
  - `Pcg32.state(): [number, number]`, `Pcg32.setState(s: readonly [number, number]): void`
  - In `workers/types.ts`: `export type Intent = { kind: 'goTo'; pos: Vec3 } | { kind: 'dig'; pos: Vec3 } | { kind: 'build'; pos: Vec3; voxel: number }` and `export type UnitEvent = { unit: number; type: 'arrived' } | { unit: number; type: 'dug'; pos: Vec3; voxel: number } | { unit: number; type: 'built'; pos: Vec3; voxel: number } | { unit: number; type: 'failed'; reason: WorkBlockReason } | { unit: number; type: 'fell'; height: number } | { unit: number; type: 'died'; cause: 'void' }`
  - `WorkerSystem.takeUnitEvents(): UnitEvent[]`

- [ ] **Step 1: Rename the branch**

```bash
git branch -m feat/game-hooks
```

- [ ] **Step 2: Failing test for the generator state**

Append to `packages/engine/test/rng.test.ts`:

```ts
it('saves and restores its state', () => {
  const a = new Pcg32(42)
  a.nextU32(); a.nextU32()
  const s = a.state()
  const b = new Pcg32(7)
  b.setState(s)
  for (let i = 0; i < 5; i++) expect(b.nextU32()).toBe(a.nextU32())
})
```

Run: `npx vitest run test/rng.test.ts` (from `packages/engine`). Expected: FAIL, `a.state is not a function`.

- [ ] **Step 3: Implement**

In `src/sim/rng.ts`, inside `Pcg32`:

```ts
  /** The 64-bit state as [hi, lo], for a save. */
  state(): [number, number] { return [this.hi, this.lo] }
  setState(s: readonly [number, number]): void { this.hi = s[0] >>> 0; this.lo = s[1] >>> 0 }
```

Run the test again. Expected: PASS.

- [ ] **Step 4: Unit event types and the stub**

In `src/sim/workers/types.ts`, after `WorkBlockReason`:

```ts
/** What a game system asked one controlled unit to do (one at a time; a new intent replaces the old). */
export type Intent = { kind: 'goTo'; pos: Vec3 } | { kind: 'dig'; pos: Vec3 } | { kind: 'build'; pos: Vec3; voxel: number }
/** What happened to a controlled unit this tick (game systems read these after the units step). */
export type UnitEvent =
  | { unit: number; type: 'arrived' }
  | { unit: number; type: 'dug'; pos: Vec3; voxel: number }
  | { unit: number; type: 'built'; pos: Vec3; voxel: number }
  | { unit: number; type: 'failed'; reason: WorkBlockReason }
  | { unit: number; type: 'fell'; height: number }
  | { unit: number; type: 'died'; cause: 'void' }
```

In `WorkerSystem` (`workers.ts`), next to the other private fields, and a public method:

```ts
  private readonly unitEvents: UnitEvent[] = []
  /** This tick's events of controlled units; clears them. */
  takeUnitEvents(): UnitEvent[] { return this.unitEvents.splice(0) }
```

- [ ] **Step 5: Failing tests for the runner**

Create `packages/engine/test/systems.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import { defineSystem, type GameSystem, type SystemContext } from '../src/sim/systems.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'

const blocks = [{ name: 'stone' }, { name: 'dirt' }]
const floor = { generateColumn(ctx: { set(x: number, y: number, z: number, v: number): void }) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) ctx.set(x, y, z, 1) } }

function make(systems: GameSystem[], workers = true) {
  const sim = new Simulation({ buffers: createWorldBuffers([32, 32, 32]), blocks, seed: 3, randomTicksPerChunk: 0, log: () => {}, systems, ...(workers && { workers: { materials: { stone: { digTicks: 2, buildTicks: 2 } } } }) })
  sim.generate(floor)
  return sim
}
let seq = 0
function submit(sim: Simulation, cmd: { type: string; [k: string]: unknown }) { sim.submit(0, ++seq, cmd); return sim.step() }

describe('game systems', () => {
  it('inits once before the first tick, then ticks every step', () => {
    const calls: string[] = []
    const sim = make([defineSystem({ name: 'a', version: 1, init: c => calls.push(`init ${c.tick}`), tick: c => calls.push(`tick ${c.tick}`), snapshot: () => null })])
    sim.step(); sim.step()
    expect(calls).toEqual(['init 0', 'tick 0', 'tick 1'])
  })

  it('runs in list order and publishes into the tick result', () => {
    const order: string[] = []
    const sys = (name: string): GameSystem => ({ name, version: 1, tick: () => order.push(name), snapshot: () => null, publish: c => ({ at: c.tick }) })
    const sim = make([sys('b'), sys('a')])
    const r = sim.step()
    expect(order).toEqual(['b', 'a'])
    expect(r.systems).toEqual([{ name: 'b', payload: { at: 0 } }, { name: 'a', payload: { at: 0 } }])
  })

  it('omits undefined publications and the field when nothing is published', () => {
    const sim = make([{ name: 'a', version: 1, tick: () => {}, snapshot: () => null, publish: () => undefined }])
    expect(sim.step().systems).toBeUndefined()
  })

  it('routes name: commands to their system and acks them', () => {
    const got: unknown[] = []
    const sim = make([{ name: 'colony', version: 1, tick: () => {}, snapshot: () => null, command: (_c, cmd) => { got.push(cmd); if (cmd.bad) throw new Error('no') } }])
    let r = submit(sim, { type: 'colony:hello', n: 1 })
    expect(r.acks[0]).toMatchObject({ ok: true })
    expect(got).toEqual([{ type: 'colony:hello', n: 1 }])
    r = submit(sim, { type: 'colony:hello', bad: true })
    expect(r.acks[0]).toMatchObject({ ok: false, error: 'no' })
    r = submit(sim, { type: 'other:hello' })
    expect(r.acks[0]).toMatchObject({ ok: false, error: 'unknown command type "other:hello"' })
  })

  it('refuses commands for a system without a command handler', () => {
    const sim = make([{ name: 'a', version: 1, tick: () => {}, snapshot: () => null }])
    expect(submit(sim, { type: 'a:x' }).acks[0]).toMatchObject({ ok: false, error: 'system a takes no commands' })
  })

  it('makes a throwing tick fatal, naming the system', () => {
    const sim = make([{ name: 'boom', version: 1, tick: () => { throw new Error('bad state') }, snapshot: () => null }])
    expect(() => sim.step()).toThrow('system boom tick: bad state')
  })

  it('validates names and refuses duplicates', () => {
    const s = (name: string): GameSystem => ({ name, version: 1, tick: () => {}, snapshot: () => null })
    expect(() => make([s('Bad Name')])).toThrow('invalid system name "Bad Name"')
    expect(() => make([s('a'), s('a')])).toThrow('duplicate system "a"')
    expect(() => make([{ ...s('a'), version: 0 }])).toThrow('system a: version must be an integer ≥ 1')
  })

  it('gives each system its own deterministic generator', () => {
    const draws = (seedName: string) => {
      const out: number[] = []
      const sim = make([{ name: seedName, version: 1, tick: c => { out.push(c.random()) }, snapshot: () => null }])
      sim.step(); sim.step()
      return out
    }
    expect(draws('a')).toEqual(draws('a'))
    expect(draws('a')).not.toEqual(draws('b'))
  })

  it('reads the world and edits it conditionally', () => {
    let ctx!: SystemContext
    const sim = make([{ name: 'a', version: 1, tick: c => { ctx = c }, snapshot: () => null }])
    sim.step()
    const stone = ctx.id('stone')
    expect(ctx.get(1, 3, 1)).toBe(stone)
    expect(ctx.isSolid(stone)).toBe(true)
    expect(ctx.edit([1, 3, 1], 0, ctx.id('dirt'))).toBe(false) // expected voxel differs
    expect(ctx.edit([1, 3, 1], stone, ctx.id('dirt'))).toBe(true)
    sim.step()
    expect(ctx.get(1, 3, 1)).toBe(ctx.id('dirt'))
  })

  it('does not tick while physics is paused', () => {
    let ticks = 0
    const sim = make([{ name: 'a', version: 1, tick: () => { ticks++ }, snapshot: () => null }])
    sim.setPaused(true); sim.step(); sim.step()
    sim.setPaused(false); sim.step()
    expect(ticks).toBe(1)
  })

  it('units are unavailable without workers', () => {
    let error = ''
    const sim = make([{ name: 'a', version: 1, tick: c => { try { c.units.spawn([1, 4, 1]) } catch (e) { error = (e as Error).message } }, snapshot: () => null }], false)
    sim.step()
    expect(error).toBe('this simulation runs without worker units')
  })
})
```

Run: `npx vitest run test/systems.test.ts`. Expected: FAIL, cannot resolve `../src/sim/systems.ts`.

- [ ] **Step 6: Implement `systems.ts`**

Create `packages/engine/src/sim/systems.ts`:

```ts
import { pack, unpack } from '../persist/pack.ts'
import type { Layout } from '../world/layout.ts'
import type { Command, Vec3 } from './commands.ts'
import { Pcg32, hash32 } from './rng.ts'
import type { UnitEvent, WorkerView } from './workers/types.ts'
import { WorldFullError } from '../world/chunkStore.ts' // use the module simulation.ts imports WorldFullError from

/** A controlled unit's API inside a system tick. */
export interface SystemUnits {
  /** This tick's events of controlled units. */
  readonly events: readonly UnitEvent[]
  /** A new controlled unit; throws if the pose is not safe or the unit limit is reached. */
  spawn(pos: Vec3): number
  despawn(id: number): void
  goTo(id: number, pos: Vec3): void
  dig(id: number, pos: Vec3): void
  build(id: number, pos: Vec3, voxel: number): void
  stop(id: number): void
  view(id: number): WorkerView | undefined
}

/** What a system sees and may do during its calls. Valid only inside the call that received it. */
export interface SystemContext {
  readonly tick: number
  readonly layout: Layout
  /** This system's own deterministic generator, in [0, 1). */
  random(): number
  id(name: string): number
  get(x: number, y: number, z: number): number
  isSolid(voxel: number): boolean
  isLiquid(voxel: number): boolean
  falls(voxel: number): boolean
  skyLight(x: number, y: number, z: number): number
  blockLight(x: number, y: number, z: number): number
  /** Water in the cell, 1/256 block (0 when dry). */
  waterDepth(x: number, y: number, z: number): number
  /** Writes `value` if the voxel is still `expected` and nothing (unit, falling body, fragment) is in the way. */
  edit(pos: Vec3, expected: number, value: number): boolean
  /** An engine `event` for the main thread. */
  emit(type: string, payload?: unknown): void
  readonly units: SystemUnits
}

export interface GameSystem<State = unknown, Pub = unknown> {
  /** Lower-case letters, digits and dashes; also the command prefix (`name:`) and the save section (`system:name`). */
  name: string
  /** ≥ 1; a save whose section has another version is refused. */
  version: number
  /** A new world: after generation, before the first tick. */
  init?(ctx: SystemContext): void
  /** Loading a save, instead of init. */
  restore?(ctx: SystemContext, state: State): void
  /** Once per tick, after the units step (not while physics is paused). */
  tick(ctx: SystemContext): void
  /** A command whose type starts with `name:`; throw an Error to refuse it. */
  command?(ctx: SystemContext, cmd: Command): void
  /** JSON-serializable state for the save (plan deviation D1). */
  snapshot(): State
  /** Posted to the main thread with this tick; undefined posts nothing. */
  publish?(ctx: SystemContext): Pub | undefined
}

export function defineSystem<S, P>(s: GameSystem<S, P>): GameSystem<S, P> { return s }

export interface SystemPublication { name: string; payload: unknown }
export type SystemSection = `system:${string}`
export const SYSTEM_SECTION = 'system:'

const NAME = /^[a-z][a-z0-9-]{0,31}$/

function nameHash(name: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193)
  return h >>> 0
}

interface Entry { sys: GameSystem; rng: Pcg32; ctx: SystemContext }
interface SavedSystem { version: number; rng: [number, number]; state: unknown }

/** Runs the game systems of one Simulation (spec §2). */
export class SystemRunner {
  private readonly entries: Entry[]
  private started = false
  /** The events handed to this tick's systems. */
  events: readonly UnitEvent[] = []

  constructor(systems: readonly GameSystem[], seed: number, reserved: { has(type: string): boolean } & Iterable<string>, makeContext: (rng: Pcg32, runner: SystemRunner) => SystemContext) {
    const seen = new Set<string>()
    this.entries = systems.map(sys => {
      if (typeof sys.name !== 'string' || !NAME.test(sys.name)) throw new Error(`invalid system name "${String(sys.name)}"`)
      if (seen.has(sys.name)) throw new Error(`duplicate system "${sys.name}"`)
      if (!Number.isInteger(sys.version) || sys.version < 1) throw new Error(`system ${sys.name}: version must be an integer ≥ 1`)
      for (const t of reserved) if (t.startsWith(`${sys.name}:`)) throw new Error(`command ${t} collides with system ${sys.name}`)
      seen.add(sys.name)
      const rng = new Pcg32(hash32(seed, nameHash(sys.name)))
      return { sys, rng, ctx: makeContext(rng, this) }
    })
  }

  owns(type: string): boolean { return this.entry(type) !== undefined }

  /** init() for a new world; nothing after restore(). Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    for (const e of this.entries) if (e.sys.init) call(e, 'init', () => e.sys.init!(e.ctx))
  }

  tick(events: readonly UnitEvent[]): SystemPublication[] {
    this.events = events
    for (const e of this.entries) call(e, 'tick', () => e.sys.tick(e.ctx))
    const out: SystemPublication[] = []
    for (const e of this.entries) {
      if (!e.sys.publish) continue
      const payload = call(e, 'publish', () => e.sys.publish!(e.ctx))
      if (payload !== undefined) out.push({ name: e.sys.name, payload })
    }
    this.events = []
    return out
  }

  /** Throws to refuse (the ack carries the message); never fatal. */
  command(cmd: Command): void {
    const e = this.entry(cmd.type)!
    if (!e.sys.command) throw new Error(`system ${e.sys.name} takes no commands`)
    e.sys.command(e.ctx, cmd)
  }

  snapshot(): { name: SystemSection; version: number; bytes: Uint8Array }[] {
    return this.entries.map(e => {
      const json: SavedSystem = { version: e.sys.version, rng: e.rng.state(), state: call(e, 'snapshot', () => e.sys.snapshot()) }
      return { name: `${SYSTEM_SECTION}${e.sys.name}` as SystemSection, version: e.sys.version, bytes: pack({ json, arrays: {} }) }
    })
  }

  /** Throws (fatal at boot) when a section is missing, unknown or of another version. Plan deviation D2. */
  restore(sections: Partial<Record<string, Uint8Array>>): void {
    const bad: string[] = []
    const saved = new Map<string, SavedSystem>()
    for (const [name, bytes] of Object.entries(sections)) {
      if (!name.startsWith(SYSTEM_SECTION) || !bytes) continue
      saved.set(name.slice(SYSTEM_SECTION.length), unpack(bytes).json as SavedSystem)
    }
    for (const e of this.entries) {
      const s = saved.get(e.sys.name)
      if (!s) bad.push(`section system:${e.sys.name} is missing`)
      else if (s.version !== e.sys.version) bad.push(`section system:${e.sys.name} v${s.version}, game expects v${e.sys.version}`)
      saved.delete(e.sys.name)
    }
    for (const name of saved.keys()) bad.push(`section system:${name} is unknown to this game`)
    if (bad.length) throw new Error(`the save cannot be loaded by this game:\n${bad.join('\n')}`)
    this.started = true
    for (const e of this.entries) {
      const s = sections[`${SYSTEM_SECTION}${e.sys.name}`]!
      const json = unpack(s).json as SavedSystem
      e.rng.setState(json.rng)
      if (e.sys.restore) call(e, 'restore', () => e.sys.restore!(e.ctx, json.state))
    }
  }

  mixState(mix: (n: number) => void): void {
    for (const e of this.entries) { const [hi, lo] = e.rng.state(); mix(hi); mix(lo) }
  }

  private entry(type: string): Entry | undefined {
    const i = type.indexOf(':')
    if (i <= 0) return undefined
    const name = type.slice(0, i)
    return this.entries.find(e => e.sys.name === name)
  }
}

function call<T>(e: Entry, phase: string, fn: () => T): T {
  try { return fn() } catch (err) {
    if (err instanceof WorldFullError) throw err
    throw new Error(`system ${e.sys.name} ${phase}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
```

Fix the `WorldFullError` import path to the module `simulation.ts` imports it from.

- [ ] **Step 7: Wire the runner into `Simulation`**

In `src/sim/commands.ts:28`, change the last parameter type to `customTypes: { has(type: string): boolean }` (a `Set` still fits). Update `NO_CUSTOM_COMMANDS` users only if they no longer type-check.

In `src/sim/simulation.ts`:

1. `SimulationOptions` (L28–47): add `systems?: readonly GameSystem[]`.
2. `TickResult` (L49–62): add `systems?: SystemPublication[]`.
3. Fields: `readonly systems: SystemRunner | null` and `private readonly commandTypes: { has(type: string): boolean }`.
4. Extract the worker port's `edit` body (L159–165) into a private method and make the port call it:

```ts
  /** A conditional world write: refused when the voxel changed or a unit, falling body or fragment is in the way. */
  private editIf(pos: Vec3, expected: number, value: number, commit?: () => void): boolean {
    if (this.store.getVoxel(...pos) !== expected || this.collapse.overlaps(...pos) || this.registry.solid[voxelId(value)] && (this.workers?.overlaps(...pos) || this.gravity.occupies(...pos))) return false
    this.store.prepareChunks([this.layout.chunkOf(...pos)])
    // Neighbours whose mesh the edit changes move their version too, so the view's barrier waits for their new mesh.
    this.store.touchChunks(this.layout.chunksAround(...pos))
    this.applySet(...pos, value, true, commit); return true
  }
```

   and in the worker port: `edit: (pos, expected, value, commit) => sim.editIf(pos, expected, value, commit),`.
5. At the end of the constructor, after `this.ctx = this.makeContext()`:

```ts
    this.systems = o.systems?.length ? new SystemRunner(o.systems, o.seed, this.customTypes, (rng, runner) => this.makeSystemContext(rng, runner)) : null
    const custom = this.customTypes, systems = this.systems
    this.commandTypes = { has: (t) => custom.has(t) || (systems?.owns(t) ?? false) }
```

6. In `step()`: right after `this.rng.reseed(...)` add `this.systems?.start()`; pass `this.commandTypes` instead of `this.customTypes` to `validateCommand`; after `if (!this.isPaused) this.workers?.afterPhysics()` add:

```ts
      if (!this.isPaused && this.systems) publications = this.systems.tick(this.workers?.takeUnitEvents() ?? [])
```

   with `let publications: SystemPublication[] = []` declared next to `acks`, and in the return value `...(publications.length > 0 && { systems: publications })`.
7. First line of `applyCommand`: `if (this.systems?.owns(cmd.type)) { this.systems.command(cmd); return }`.
8. In `hash()`, after `this.workers?.mixState(mix)`: `this.systems?.mixState(mix)`.
9. Add:

```ts
  private makeSystemContext(rng: Pcg32, runner: SystemRunner): SystemContext {
    const sim = this
    const noUnits = () => { throw new Error('this simulation runs without worker units') }
    const units: SystemUnits = sim.workers ? {
      get events() { return runner.events },
      spawn: (pos) => sim.workers!.spawnControlled(pos),
      despawn: (id) => sim.workers!.despawnControlled(id),
      goTo: (id, pos) => sim.workers!.goTo(id, pos),
      dig: (id, pos) => sim.workers!.work(id, 'dig', pos),
      build: (id, pos, voxel) => sim.workers!.work(id, 'build', pos, voxel),
      stop: (id) => sim.workers!.stop(id),
      view: (id) => sim.workers!.view(id),
    } : { events: [], spawn: noUnits, despawn: noUnits, goTo: noUnits, dig: noUnits, build: noUnits, stop: noUnits, view: noUnits }
    return {
      get tick() { return sim.tick },
      layout: sim.layout,
      random: () => rng.next(),
      id: (name) => sim.registry.id(name),
      get: (x, y, z) => sim.store.getVoxel(x, y, z),
      isSolid: (v) => sim.registry.solid[voxelId(v)] === 1,
      isLiquid: (v) => sim.registry.liquid[voxelId(v)] === 1,
      falls: (v) => sim.registry.falls[voxelId(v)] === 1,
      skyLight: (x, y, z) => skyLight(sim.store.getLight(x, y, z)),
      blockLight: (x, y, z) => blockLight(sim.store.getLight(x, y, z)),
      waterDepth: (x, y, z) => sim.water.depthAt(x, y, z),
      edit: (pos, expected, value) => {
        if (!sim.layout.inBounds(...pos)) throw new RangeError(`edit outside the world: [${pos.join(', ')}]`)
        return sim.editIf(pos, expected, value)
      },
      emit: (type, payload) => { sim.events.push(payload === undefined ? { tick: sim.tick, type } : { tick: sim.tick, type, payload }) },
      units,
    }
  }
```

   `spawnControlled`, `despawnControlled`, `goTo`, `work`, `stop` do not exist yet: add them to `WorkerSystem` now as methods that `throw new Error('not implemented')` so the build type-checks; Tasks 4–5 implement them.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run test/systems.test.ts test/rng.test.ts test/simulation.test.ts test/commands.test.ts` and `npm run typecheck -w @elovox/engine`. Expected: PASS, typecheck 0.

- [ ] **Step 9: Commit**

```bash
git add packages/engine/src/sim packages/engine/test/systems.test.ts packages/engine/test/rng.test.ts
git commit -m "feat(sim): game systems tick after the units, take name: commands and publish per tick"
```

---

### Task 2: System save sections

**Files:**
- Modify: `packages/engine/src/sim/snapshot.ts` (section name types)
- Modify: `packages/engine/src/sim/simulation.ts` (`snapshot`, `restore`)
- Modify: `packages/engine/src/persist/package.ts` (`SectionInput`, `LoadedSave`, `writeSave` version)
- Modify: `packages/engine/src/persist/manifest.ts` (`Manifest.sections` name type, `checkManifest`, new `checkSystemSections`)
- Modify: `packages/engine/src/engine.ts` (section types only, if needed)
- Test: `packages/engine/test/systemsSave.test.ts`, `packages/engine/test/savePackage.test.ts`

**Interfaces:**
- Consumes: `SystemRunner.snapshot()`, `SystemRunner.restore()`, `SystemSection` (Task 1).
- Produces:
  - `SimSnapshot.sections: { name: SectionName | SystemSection; version?: number; bytes: Uint8Array }[]`
  - `SimRestore.sections: Partial<Record<SectionName | SystemSection, Uint8Array>>`
  - `export function checkSystemSections(m: Manifest, systems: readonly { name: string; version: number }[]): string[]` (from `persist/manifest.ts`)

- [ ] **Step 1: Failing tests**

Create `packages/engine/test/systemsSave.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import type { SimRestore, SimSnapshot } from '../src/sim/snapshot.ts'
import { defineSystem, type GameSystem } from '../src/sim/systems.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'

const blocks = [{ name: 'stone' }]
const floor = { generateColumn(ctx: { set(x: number, y: number, z: number, v: number): void }) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) ctx.set(x, 0, z, 1) } }

type Count = { n: number; draws: number[] }
const counter = (version = 1): GameSystem<Count> => {
  let st: Count = { n: 0, draws: [] }
  return defineSystem<Count, never>({
    name: 'counter', version,
    init() { st = { n: 0, draws: [] } },
    restore(_c, s) { st = { n: s.n, draws: [...s.draws] } },
    tick(c) { st.n++; st.draws.push(c.random()) },
    snapshot: () => ({ n: st.n, draws: [...st.draws] }),
  })
}

function sim(systems: GameSystem[]) {
  const s = new Simulation({ buffers: createWorldBuffers([32, 32, 32]), blocks, seed: 9, randomTicksPerChunk: 0, log: () => {}, systems })
  return s
}
function toRestore(s: SimSnapshot): SimRestore {
  return { tick: s.tick, paused: s.paused, regions: s.regions, sections: Object.fromEntries(s.sections.map(x => [x.name, x.bytes])) }
}

describe('system save sections', () => {
  it('saves the state and the generator; a loaded run continues identically', () => {
    const a = sim([counter()]); a.generate(floor)
    for (let i = 0; i < 5; i++) a.step()
    const snap = a.snapshot(null)
    expect(snap.sections.find(s => s.name === 'system:counter')).toMatchObject({ version: 1 })
    const b = sim([counter()]); b.restore(toRestore(snap))
    const c = sim([counter()]); c.restore(toRestore(snap))
    for (let i = 0; i < 5; i++) { a.step(); b.step(); c.step() }
    expect(b.hash()).toBe(a.hash())
    expect(b.snapshot(null).sections.find(s => s.name === 'system:counter')!.bytes).toEqual(a.snapshot(null).sections.find(s => s.name === 'system:counter')!.bytes)
  })

  it('does not call init after a restore', () => {
    let inits = 0
    const sys: GameSystem = { name: 'x', version: 1, init: () => { inits++ }, tick: () => {}, snapshot: () => 1 }
    const a = sim([sys]); a.generate(floor); a.step()
    const b = sim([sys]); b.restore(toRestore(a.snapshot(null))); b.step()
    expect(inits).toBe(1)
  })

  it('refuses a save with a missing, unknown or other-version system section', () => {
    const a = sim([counter(1)]); a.generate(floor); a.step()
    const snap = toRestore(a.snapshot(null))
    expect(() => sim([counter(2)]).restore(snap)).toThrow('section system:counter v1, game expects v2')
    expect(() => sim([]).restore(snap)).not.toThrow() // no runner: system sections are ignored by a sim without systems
    const other: GameSystem = { name: 'other', version: 1, tick: () => {}, snapshot: () => null }
    expect(() => sim([other]).restore(snap)).toThrow(/section system:other is missing\nsection system:counter is unknown to this game/)
  })
})
```

Add to `packages/engine/test/savePackage.test.ts` (inside its top-level `describe`; reuse its existing manifest/store helpers):

```ts
it('stamps a system section with its own version and checkManifest leaves it to the game', async () => {
  // build a manifest as the other tests do, with an extra section { name: 'system:colony', version: 3, bytes }
  // expect(manifest.sections.find(s => s.name === 'system:colony')!.version).toBe(3)
  // expect(checkManifest(manifest)).toEqual([])
  // expect(checkSystemSections(manifest, [{ name: 'colony', version: 3 }])).toEqual([])
  // expect(checkSystemSections(manifest, [{ name: 'colony', version: 4 }])).toEqual(['section system:colony v3, game expects v4'])
  // expect(checkSystemSections(manifest, [])).toEqual(['section system:colony is unknown to this game'])
})
```

Write that test with the file's own `writeSave(new MemoryStore(), ...)` call pattern (L73–85 show it); the comments above are the exact assertions.

Run: `npx vitest run test/systemsSave.test.ts test/savePackage.test.ts`. Expected: FAIL (system sections are not in the snapshot; `checkSystemSections` missing).

- [ ] **Step 2: Implement**

`src/sim/snapshot.ts`:

```ts
import type { SystemSection } from './systems.ts'
export interface SimSnapshot {
  // …unchanged fields…
  /** Engine sections carry their version in SECTION_VERSIONS; system sections carry their own. */
  sections: { name: SectionName | SystemSection; version?: number; bytes: Uint8Array }[]
}
export interface SimRestore {
  // …unchanged fields…
  sections: Partial<Record<SectionName | SystemSection, Uint8Array>>
}
```

`Simulation.snapshot()`: type the array as `SimSnapshot['sections']` and append `...(this.systems?.snapshot() ?? [])`.

`Simulation.restore()`: after the workers section, `this.systems?.restore(s.sections)`.

`persist/package.ts`: `SectionInput { name: SectionName | 'app' | SystemSection; version?: number; bytes: Uint8Array }`; in `writeSave`: `version: s.version ?? SECTION_VERSIONS[s.name as SectionName | 'app']`; `LoadedSave.sections: Partial<Record<SectionName | 'app' | SystemSection, Uint8Array>>`.

`persist/manifest.ts`: `Manifest.sections` name type `SectionName | 'app' | SystemSection`; in `checkManifest`'s loop, first line `if (s.name.startsWith(SYSTEM_SECTION)) continue // the game checks these (checkSystemSections)`; and:

```ts
/** A game's check of its own system sections before booting a save (plan deviation D2). Empty when they match. */
export function checkSystemSections(m: Manifest, systems: readonly { name: string; version: number }[]): string[] {
  const saved = new Map(m.sections.filter(s => s.name.startsWith(SYSTEM_SECTION)).map(s => [s.name.slice(SYSTEM_SECTION.length), s.version]))
  const out: string[] = []
  for (const s of systems) {
    const v = saved.get(s.name)
    if (v === undefined) out.push(`section system:${s.name} is missing`)
    else if (v !== s.version) out.push(`section system:${s.name} v${v}, game expects v${s.version}`)
    saved.delete(s.name)
  }
  for (const name of saved.keys()) out.push(`section system:${name} is unknown to this game`)
  return out
}
```

`engine.ts`: `saveOnce` already spreads `snap.sections`; the `app` section stays as is. Fix only what typecheck reports.

- [ ] **Step 3: Run**

Run: `npx vitest run test/systemsSave.test.ts test/savePackage.test.ts test/persistRoundTrip.test.ts test/simSnapshot.test.ts` and typecheck. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A packages/engine
git commit -m "feat(persist): game systems save as system:<name> sections with their own version"
```

---

### Task 3: Worker and main-thread plumbing

**Files:**
- Modify: `packages/engine/src/sim/simHost.ts` (`SimModules.systems`, pass to `Simulation`)
- Modify: `packages/engine/src/sim/runSimWorker.ts` (exports)
- Modify: `packages/engine/src/protocol.ts` (tick message `systems?`)
- Modify: `packages/engine/src/engine.ts` (`EngineEvents.system`, emit)
- Modify: `packages/engine/src/index.ts` (exports)
- Test: `packages/engine/test/simHostSystems.test.ts`

**Interfaces:**
- Consumes: `GameSystem`, `SystemPublication`, `TickResult.systems` (Task 1); `checkSystemSections` (Task 2).
- Produces:
  - `SimModules { rules?: RulesModule; generator: GeneratorModule; systems?: readonly GameSystem[] }`
  - `EngineEvents.system: { name: string; tick: number; payload: unknown }`
  - `@elovox/engine/sim-worker` exports `defineSystem` and the types `GameSystem`, `SystemContext`, `SystemUnits`, `UnitEvent`, `Intent`
  - `@elovox/engine` exports `checkSystemSections` and the types `GameSystem`, `SystemContext`, `SystemPublication`, `UnitEvent`, `Intent`

- [ ] **Step 1: Failing test**

Create `packages/engine/test/simHostSystems.test.ts`, modelled on `test/simHost.test.ts`'s `setup()` (L10–16: `new SimHost(m => out.push(m), modules, manualClock)`, `init`, `start`, `clock.t = 50; host.pump()`):

```ts
import { describe, expect, it } from 'vitest'
import type { FromSim } from '../src/protocol.ts'
import { SimHost } from '../src/sim/simHost.ts'
import { defineSystem } from '../src/sim/systems.ts'
// reuse the init message and manual clock the way test/simHost.test.ts builds them

describe('SimHost with systems', () => {
  it('posts publications with the tick and acks system commands', () => {
    const out: FromSim[] = []
    let last = ''
    const sys = defineSystem({ name: 'echo', version: 1, tick() {}, snapshot: () => null,
      command(_c, cmd) { last = String(cmd.text) }, publish: () => last || undefined })
    // const host = new SimHost(m => out.push(m), { generator: empty, systems: [sys] }, clock); init; start
    // host.handle({ type: 'submit', clientId: 0, seq: 1, cmd: { type: 'echo:say', text: 'hi' } }); clock.t = 50; host.pump()
    const ticks = out.filter((m): m is Extract<FromSim, { type: 'tick' }> => m.type === 'tick')
    const last = ticks.at(-1)!
    expect(last.acks).toContainEqual({ clientId: 0, seq: 1, ok: true })
    expect(last.systems).toEqual([{ name: 'echo', payload: 'hi' }])
  })

  it('a throwing system tick posts fatal', () => {
    // same setup with { name: 'boom', version: 1, tick() { throw new Error('x') }, snapshot: () => null }
    // expect(out.find(m => m.type === 'fatal')).toMatchObject({ message: expect.stringContaining('system boom tick: x') })
  })
})
```

Fill in the setup lines (commented) with the exact helper code of `test/simHost.test.ts`; the assertions stay as written.

Run: `npx vitest run test/simHostSystems.test.ts`. Expected: FAIL (`systems` not passed through; `last.systems` undefined).

- [ ] **Step 2: Implement**

- `simHost.ts:12`: `export interface SimModules { rules?: RulesModule; generator: GeneratorModule; systems?: readonly GameSystem[] }`; in `init` (L86–137) pass `systems: this.modules.systems` to `new Simulation({...})`.
- `protocol.ts:62` (the `tick` variant of `FromSim`): add `systems?: SystemPublication[]`. `runTick` spreads `...r`, so it travels without further change.
- `engine.ts`: `EngineEvents` gains `/** A game system's publication (spec §2). */ system: { name: string; tick: number; payload: unknown }`; in the tick handler (L573–588), after the `event` loop and before `events.emit('tick', …)`:

```ts
        if (m.systems) for (const p of m.systems) events.emit('system', { name: p.name, tick: m.tick, payload: p.payload })
```

- `runSimWorker.ts`: `export { defineSystem } from './systems.ts'` and `export type { GameSystem, SystemContext, SystemUnits } from './systems.ts'`, `export type { Intent, UnitEvent } from './workers/types.ts'`.
- `index.ts`: `export { checkSystemSections } from './persist/manifest.ts'` (next to `SaveError`), `export type { GameSystem, SystemContext, SystemPublication, SystemUnits } from './sim/systems.ts'`, and add `Intent, UnitEvent` to the existing `./sim/workers/types.ts` export line.

- [ ] **Step 3: Run**

Run: `npx vitest run test/simHostSystems.test.ts test/simHost.test.ts`, typecheck. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A packages/engine
git commit -m "feat(engine): systems through runSimWorker, system publications as engine 'system' events"
```

---

### Task 4: Controlled units: spawn, goTo, stop, events

**Files:**
- Modify: `packages/engine/src/sim/workers/workers.ts`
- Modify: `packages/engine/src/sim/workers/types.ts` (`WorkerView.controlled?`, `WorkerView.intent?`)
- Modify: `packages/engine/src/sim/workers/snapshot.ts` (`UnitSnapshot.controlled?`, `UnitSnapshot.intent?`)
- Test: `packages/engine/test/controlledUnits.test.ts`

**Interfaces:**
- Consumes: `Intent`, `UnitEvent`, `takeUnitEvents` (Task 1); the context's `units` (Task 1).
- Produces (public on `WorkerSystem`): `spawnControlled(pos: Vec3): number`, `despawnControlled(id: number): void`, `goTo(id: number, pos: Vec3): void`, `stop(id: number): void`; private `failIntent(u: Unit, reason: WorkBlockReason): void`, `unitEvent(e: UnitEvent): void`, `controlledUnit(id: number): Unit`, `spawnUnit(...)`, `removeUnit(u: Unit)`.

- [ ] **Step 1: Failing tests**

Create `packages/engine/test/controlledUnits.test.ts`. It drives units through a test system that records events and runs a script per tick:

```ts
import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import type { GameSystem, SystemContext } from '../src/sim/systems.ts'
import type { UnitEvent } from '../src/sim/workers/types.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'

const blocks = [{ name: 'stone' }, { name: 'planks' }]
type Script = (c: SystemContext) => void
export function harness(extra?: (ctx: { set(x: number, y: number, z: number, v: number): void }) => void) {
  const events: UnitEvent[] = []
  let script: Script | null = null
  let ctx!: SystemContext
  const sys: GameSystem = { name: 'test', version: 1, snapshot: () => null, tick: c => { ctx = c; events.push(...c.units.events); const s = script; script = null; s?.(c) } }
  const sim = new Simulation({ buffers: createWorldBuffers([32, 32, 32]), blocks, seed: 1, randomTicksPerChunk: 0, log: () => {}, systems: [sys],
    workers: { materials: { stone: { digTicks: 4, buildTicks: 3 }, planks: { digTicks: 2, buildTicks: 3 } } } })
  sim.generate({ generateColumn(g) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) g.set(x, y, z, 1); extra?.(g) } })
  sim.step()
  /** Runs `s` inside the next system tick and returns what it returned. */
  const run = <T>(s: (c: SystemContext) => T): T => { let out!: T; script = c => { out = s(c) }; sim.step(); return out }
  const until = (pred: () => boolean, cap = 600) => { for (let i = 0; i < cap && !pred(); i++) sim.step(); expect(pred()).toBe(true) }
  return { sim, events, run, until, get ctx() { return ctx } }
}
let seq = 0

describe('controlled units', () => {
  it('spawns, walks to a goal and reports arrived', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.goTo(id, [12, 4, 9]))
    h.until(() => h.events.some(e => e.unit === id && e.type === 'arrived'))
    const v = h.ctx.units.view(id)!
    expect([v.x256 >> 8, v.y256 >> 8, v.z256 >> 8]).toEqual([12, 4, 9])
    expect(v.controlled).toBe(true)
    expect(v.intent).toBeNull()
  })

  it('never assigns a controlled unit to a work order', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.sim.submit(0, ++seq, { type: 'workDig', min: [6, 3, 5], max: [6, 3, 5] }); h.sim.step()
    for (let i = 0; i < 100; i++) h.sim.step()
    expect(h.sim.workers!.view(id)!.order).toBe(0)
    expect(h.sim.store.getVoxel(6, 3, 5)).not.toBe(0)
  })

  it('refuses unitMove on a controlled unit', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.sim.submit(0, ++seq, { type: 'unitMove', ids: [id], pos: [9, 4, 9] })
    expect(h.sim.step().acks[0]).toMatchObject({ ok: false, error: `unit ${id} is controlled by a game system` })
  })

  it('fails a goTo to a pose that cannot be stood on', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.goTo(id, [9, 2, 9])) // inside the stone
    h.until(() => h.events.some(e => e.unit === id && e.type === 'failed'))
    expect(h.events.find(e => e.type === 'failed')).toEqual({ unit: id, type: 'failed', reason: 'no-access' })
  })

  it('fails a goTo with no way there', () => {
    const h = harness((g) => { for (let x = 0; x < 32; x++) for (let y = 4; y < 8; y++) g.set(x, y, 16, 1) }) // a wall across the world
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.goTo(id, [5, 4, 25]))
    h.until(() => h.events.some(e => e.unit === id && e.type === 'failed'))
    expect(h.ctx.units.view(id)!.intent).toBeNull()
  })

  it('stop() ends the intent quietly', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.goTo(id, [25, 4, 25]))
    h.sim.step(); h.sim.step()
    h.run(c => c.units.stop(id))
    for (let i = 0; i < 200; i++) h.sim.step()
    expect(h.events.filter(e => e.unit === id)).toEqual([])
    expect(h.ctx.units.view(id)!.state).toBe('idle')
  })

  it('reports fell with the height when its floor is removed', () => {
    const h = harness((g) => { for (let y = 4; y < 8; y++) g.set(20, y, 20, 1) }) // a pillar
    const id = h.run(c => c.units.spawn([20, 8, 20]))
    h.sim.submit(0, ++seq, { type: 'fillRegion', min: [20, 4, 20], max: [20, 7, 20], voxel: 0 }); h.sim.step()
    h.until(() => h.events.some(e => e.unit === id && e.type === 'fell'))
    expect(h.events.find(e => e.type === 'fell')).toEqual({ unit: id, type: 'fell', height: 4 })
  })

  it('despawn removes the unit', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.despawn(id))
    expect(h.ctx.units.view(id)).toBeUndefined()
  })

  it('throws for unknown or uncontrolled units', () => {
    const h = harness()
    h.sim.submit(0, ++seq, { type: 'unitSpawn', pos: [3, 4, 3] }); h.sim.step()
    const plain = [...h.sim.workers!.units.keys()][0]!
    expect(() => h.run(c => c.units.goTo(plain, [5, 4, 5]))).toThrow(`system test tick: unit ${plain} is not controlled`)
  })

  it('a goTo survives a save', () => {
    // as test/systemsSave.test.ts: snapshot after 3 ticks of walking, restore into a fresh harness sim, step until arrived
  })
})
```

Write the last test with the `toRestore` helper from `test/systemsSave.test.ts` (move that helper to `test/persistHelpers.ts` as `toRestoreAll` if you want to share it) and a restored `Simulation` built with the same options; assert an `arrived` event for the same id after the load.

Run: `npx vitest run test/controlledUnits.test.ts`. Expected: FAIL (`not implemented`).

- [ ] **Step 2: Implement in `workers.ts`**

1. `Unit` (L52–97): add `controlled: boolean; intent: Intent | null; fallFrom: number`; `newUnit` (L416) sets `controlled: false, intent: null, fallFrom: 0`.
2. Extract the body of the `unitSpawn` case (L478–495) into `private spawnUnit(pos: Vec3, tools: string[], stock: Map<number, number>, controlled: boolean): Unit` (it does the pose, limit, capacity and reserve checks and emits `unitSpawned`); the command case validates tools/stock and calls it with `controlled = false`.
3. Extract the `unitDespawn` per-unit body (L581) into `private removeUnit(u: Unit): void`.
4. Add:

```ts
  private unitEvent(e: UnitEvent): void { this.unitEvents.push(e) }
  private controlledUnit(id: number): Unit {
    const u = Number.isInteger(id) ? this.units.get(id) : undefined
    if (!u) throw new Error(`unknown unit ${String(id)}`)
    if (!u.controlled) throw new Error(`unit ${id} is not controlled`)
    return u
  }
  /** Ends a controlled unit's intent with a `failed` event (plan deviation D3). */
  private failIntent(u: Unit, reason: WorkBlockReason): void {
    this.unitEvent({ unit: u.id, type: 'failed', reason })
    u.intent = null
    if (u.goal !== null) { u.goal = null; this.goalsVersion++ }
    if (!u.motion && u.state !== 'falling' && u.state !== 'incapacitated') u.state = 'idle'
    this.dirty.add(u.id)
  }
  spawnControlled(pos: Vec3): number {
    this.checkPos(pos)
    const u = this.spawnUnit(pos, [], new Map(), true)
    return u.id
  }
  despawnControlled(id: number): void { this.removeUnit(this.controlledUnit(id)); this.revision++ }
  goTo(id: number, pos: Vec3): void {
    this.checkPos(pos)
    const u = this.controlledUnit(id)
    this.sleepers.wake(u.id)
    this.clearOrder(u)
    u.intent = { kind: 'goTo', pos: [pos[0], pos[1], pos[2]] }
    if (u.state === 'incapacitated') { this.failIntent(u, 'unsafe'); return }
    if (!this.safePose(pos)) { this.failIntent(u, 'no-access'); return }
    u.goal = this.port.layout.voxelIndex(...pos); this.goalsVersion++
    u.allowDig = false; u.buildBlock = 0; u.state = u.motion ? 'walking' : 'planning'; u.retry = 0; u.revision = -1
    this.revision++; this.dirty.add(u.id)
  }
  stop(id: number): void {
    const u = this.controlledUnit(id)
    this.sleepers.wake(u.id)
    this.clearOrder(u); u.intent = null; this.revision++
  }
```

   `spawnUnit` sets `u.controlled = controlled` and, for a controlled unit, `u.available = false`.
5. `ids()` (L402–406): inside the map, after the unknown check: `if (u.controlled) throw new Error(\`unit ${id} is controlled by a game system\`)`.
6. `assign()` (L823): `const assignable = (u: Unit) => !u.controlled && u.available && …`.
7. Arrival (L1202): after `this.port.emit('unitArrived', …)`, add `if (u.controlled) { this.unitEvent({ unit: u.id, type: 'arrived' }); u.intent = null }`.
8. End of `block()` (L662–674): `if (u.controlled && u.intent && (u.intent.kind !== 'goTo' || reason !== 'traffic')) this.failIntent(u, reason)`.
9. `fall()` (L1028–1045): first line `const wasFalling = u.state === 'falling'; if (!wasFalling) u.fallFrom = u.y`; after the task is dropped: `if (u.controlled && u.intent && u.intent.kind !== 'goTo') this.failIntent(u, 'unsafe')` (failIntent leaves the state `falling`); just before `const cells = this.body(…)`: `if (u.controlled && u.state !== 'falling') this.unitEvent({ unit: u.id, type: 'fell', height: (u.fallFrom - u.y) / 256 })`.
10. `incapacitate()` (L1023): first line `if (u.controlled && u.intent) this.failIntent(u, 'unsafe')`.
11. `snapshot()` unit map: add `...(u.controlled && { controlled: true }), ...(u.intent && { intent: u.intent })`; `restore()`: `u.controlled = s.controlled === true; u.intent = s.intent ?? null; if (u.controlled) u.available = false`.
12. `view()` (L1928): add `...(u.controlled && { controlled: true, intent: u.intent })`. In `types.ts` `WorkerView`: `controlled?: boolean; intent?: Intent | null`. In `snapshot.ts` `UnitSnapshot`: `controlled?: boolean; intent?: Intent`.
13. `mixState`: per unit `mix(u.controlled ? 1 : 0)`; when `u.intent`: `mix(['goTo', 'dig', 'build'].indexOf(u.intent.kind) + 1); mix(u.intent.pos[0]); mix(u.intent.pos[1]); mix(u.intent.pos[2])`.

`dig`/`build` (`work`) stays `throw new Error('not implemented')` until Task 5.

- [ ] **Step 3: Run**

Run: `npx vitest run test/controlledUnits.test.ts test/workers.test.ts test/workersRoutes.test.ts test/workersSnapshot.test.ts test/workersSleep.test.ts`, typecheck. Expected: PASS (existing worker suites unchanged).

- [ ] **Step 4: Commit**

```bash
git add -A packages/engine
git commit -m "feat(workers): controlled units owned by game systems (spawn, goTo, stop, unit events)"
```

---

### Task 5: Controlled work intents (dig, build)

**Files:**
- Modify: `packages/engine/src/sim/workers/workers.ts` (`work`, `startIntent`, commit path, restore)
- Test: `packages/engine/test/controlledUnits.test.ts` (extend)

**Interfaces:**
- Consumes: Task 4's controlled units, `failIntent`, `unitEvent`.
- Produces: `WorkerSystem.work(id: number, kind: 'dig' | 'build', pos: Vec3, voxel?: number): void`; private `startIntent(u: Unit): void`.

- [ ] **Step 1: Failing tests**

Append to the `describe` in `test/controlledUnits.test.ts`:

```ts
  it('digs from a work pose, reports dug and keeps nothing', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.dig(id, [10, 3, 10]))
    h.until(() => h.events.some(e => e.unit === id && e.type === 'dug'))
    expect(h.events.find(e => e.type === 'dug')).toEqual({ unit: id, type: 'dug', pos: [10, 3, 10], voxel: 1 })
    expect(h.sim.store.getVoxel(10, 3, 10)).toBe(0)
    expect(h.sim.workers!.view(id)!.stock).toEqual([])
    expect(h.sim.workers!.viewDrops()).toEqual([])
    expect(h.ctx.units.view(id)!.intent).toBeNull()
  })

  it('builds without stock and reports built', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.build(id, [10, 4, 10], 2))
    h.until(() => h.events.some(e => e.unit === id && e.type === 'built'))
    expect(h.sim.store.getVoxel(10, 4, 10)).toBe(2)
  })

  it('fails a dig on air and a build into stone', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.dig(id, [10, 6, 10]))
    h.sim.step()
    expect(h.events.at(-1)).toEqual({ unit: id, type: 'failed', reason: 'target-changed' })
    h.run(c => c.units.build(id, [10, 3, 10], 2))
    h.sim.step()
    expect(h.events.at(-1)).toEqual({ unit: id, type: 'failed', reason: 'target-changed' })
  })

  it('fails when the target changes before the commit', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.dig(id, [12, 3, 12]))
    h.sim.submit(0, ++seq, { type: 'setBlock', pos: [12, 3, 12], voxel: 2 }); h.sim.step()
    h.until(() => h.events.some(e => e.unit === id && e.type === 'failed'))
    expect(h.sim.store.getVoxel(12, 3, 12)).toBe(2)
  })

  it('a dig intent that loses its task fails instead of hanging', () => {
    const h = harness((g) => { for (let y = 4; y < 8; y++) g.set(20, y, 20, 1) })
    const id = h.run(c => c.units.spawn([20, 8, 20]))
    h.run(c => c.units.dig(id, [25, 3, 25]))
    h.sim.submit(0, ++seq, { type: 'fillRegion', min: [20, 4, 20], max: [20, 7, 20], voxel: 0 }); h.sim.step() // it falls
    h.until(() => h.events.some(e => e.unit === id && e.type === 'failed'))
    expect(h.events.find(e => e.type === 'failed')).toEqual({ unit: id, type: 'failed', reason: 'unsafe' })
    expect(h.ctx.units.view(id)!.intent).toBeNull()
  })

  it('a dig intent survives a save', () => {
    // walk 3 ticks toward the dig, snapshot, restore into a fresh harness-built sim, step until dug or failed,
    // expect a 'dug' event for the same unit and the voxel to be air
  })

  it('rejects a non-buildable voxel as a programming error', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    expect(() => h.run(c => c.units.build(id, [10, 4, 10], 0))).toThrow('voxel is not buildable')
  })
```

Write the save test with the same restore helper as Task 4.

Run: `npx vitest run test/controlledUnits.test.ts`. Expected: the new tests FAIL (`not implemented`).

- [ ] **Step 2: Implement**

In `workers.ts`:

```ts
  work(id: number, kind: 'dig' | 'build', pos: Vec3, voxel = 0): void {
    this.checkPos(pos)
    const u = this.controlledUnit(id)
    if (kind === 'build' && (!integer(voxel, 1, 0xffff) || voxelId(voxel) >= this.port.registry.count || !this.build[voxelId(voxel)])) throw new Error('voxel is not buildable')
    this.sleepers.wake(u.id)
    this.clearOrder(u)
    u.intent = kind === 'dig' ? { kind, pos: [pos[0], pos[1], pos[2]] } : { kind, pos: [pos[0], pos[1], pos[2]], voxel }
    this.startIntent(u); this.revision++
  }
  /** Turns a dig/build intent into a one-cell internal order claimed by the unit (as engineering actions do). */
  private startIntent(u: Unit): void {
    const i = u.intent
    if (!i || i.kind === 'goTo') return
    if (u.state === 'incapacitated' || u.state === 'falling') { this.failIntent(u, 'unsafe'); return }
    const p = this.port.layout.voxelIndex(...i.pos), v = this.port.get(...i.pos), id = voxelId(v), build = i.kind === 'build'
    if (build ? this.port.registry.solid[id] === 1 : id === AIR) { this.failIntent(u, 'target-changed'); return }
    if (!build && !this.dig[id]) { this.failIntent(u, 'missing-tool'); return }
    if (build && !this.attached(i.pos)) { this.failIntent(u, 'no-access'); return }
    if (this.targets.has(p)) { this.failIntent(u, 'traffic'); return }
    const order: Order = { id: -u.id, kind: i.kind, min: i.pos, max: i.pos, voxel: build ? i.voxel : 0, total: 1, done: 0, pending: 1, cursor: 1, cancelled: false, ids: new Set([u.id]), priority: 128, parked: [], parkedRevision: -1, ringPending: null, rings: 0, floor: 0, ring: 0, progress: 0, stalled: false, idleSince: this.time, noCrewSince: -1 }
    const t: Task = { order, i: 0, p, pos: i.pos, expected: v, claim: u.id, added: this.time, failures: new Map() }
    const goals = this.workGoals(u, t)
    if (!goals.length) { this.failIntent(u, this.workGoals(u, t, true).length ? 'traffic' : 'no-access'); return }
    this.targets.add(p); u.task = t; u.workPoses = goals; u.progressAt = this.time
    this.plan(u, goals); u.state = 'planning'; this.dirty.add(u.id)
  }
```

(Import `AIR` if `workers.ts` does not already.) Check that `finish()` → `removeTask()` deletes `targets` for a negative order id the way engineering tasks need; if it does not, delete `this.targets.delete(t.p)` in `finish()` for `t.order.id < 0`.

`beforePhysics()` (L680–705), per controlled unit:

- `if (this.satisfied(t)) { this.finish(u); if (u.controlled && u.intent && u.intent.kind !== 'goTo') this.failIntent(u, 'target-changed'); continue }`
- material check: `if (build && !u.controlled && !(u.stock.get(material) ?? 0))`
- tool check: `if (!build && (!this.dig[id] || !u.controlled && this.tools[id] && !u.tools.has(this.tools[id]!)))`
- the `edit` callback becomes:

```ts
      const ok = this.port.edit(t.pos, v, build ? t.order.voxel : 0, () => {
        if (u.controlled) {
          this.unitEvent(build ? { unit: u.id, type: 'built', pos: t.pos, voxel: t.order.voxel } : { unit: u.id, type: 'dug', pos: t.pos, voxel: v })
          u.intent = null
        } else if (build) u.stock.set(material, u.stock.get(material)! - 1)
        else if (drop) { /* unchanged stock-or-pile code */ }
        this.barriers.push({ unit: u.id, pos: t.pos }); this.finish(u); this.mutations++
      })
```

`restore()`: at its end, `for (const u of this.units.values()) if (u.controlled && u.intent && u.intent.kind !== 'goTo') this.startIntent(u)`.

- [ ] **Step 3: Run**

Run: `npx vitest run test/controlledUnits.test.ts test/workers.test.ts test/workersSnapshot.test.ts test/determinism.test.ts`, typecheck. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A packages/engine
git commit -m "feat(workers): controlled dig and build intents report dug/built and keep no stock or piles"
```

---

### Task 6: Void world physics (water, falling blocks, fragments)

**Files:**
- Modify: `packages/engine/src/sim/generator.ts:13-16` (`GeneratorConfig.void`)
- Modify: `packages/engine/src/sim/simulation.ts:201-205` (`configure`), new `get voidWorld()`
- Modify: `packages/engine/src/sim/water/columns.ts` (`drainFloor`, drain in `step`), `packages/engine/src/sim/water/waterSystem.ts` (flag)
- Modify: `packages/engine/src/sim/gravity.ts` (removal below the floor)
- Modify: `packages/engine/src/sim/collapse.ts` (support, removal, `removed` in the publication)
- Test: `packages/engine/test/voidWorld.test.ts`

**Interfaces:**
- Produces: `GeneratorConfig.void?: boolean`; `Simulation.voidWorld: boolean`; `WaterColumns.drainFloor: boolean`; `GravitySystem.voidFloor: boolean`; `CollapseSystem.voidFloor: boolean`; `CollapseTick.removed?: number[]` (fragment ids removed below the world).

- [ ] **Step 1: Failing tests**

Create `packages/engine/test/voidWorld.test.ts`. Use `test/waterHelpers.ts` blocks (`WATER_BLOCKS`, `B`, `w(level)`, `spring(flow)`) and its `settle`; build the sim with `waterSim`'s options plus a generator whose `configure` returns `{ void: true }`:

```ts
import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { B, WATER_BLOCKS, spring } from './waterHelpers.ts'

type Fill = (x: number, y: number, z: number) => number
function voidSim(fill: Fill, opts: { void?: boolean; collapse?: boolean } = {}) {
  const logs: string[] = []
  const sim = new Simulation({ buffers: createWorldBuffers([64, 48, 64]), blocks: WATER_BLOCKS, seed: 2, randomTicksPerChunk: 0, water: { debug: true }, log: m => logs.push(m), ...(opts.collapse && { collapse: {} }) })
  const gen = { configure: () => (opts.void === false ? undefined : { void: true }), generateColumn(ctx: { set(x: number, y: number, z: number, v: number): void }, cx: number, cz: number) {
    for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) for (let y = 0; y < 48; y++) { const v = fill(cx * 32 + lx, y, cz * 32 + lz); if (v) ctx.set(lx, y, lz, v) } } }
  sim.configure(gen, null)
  sim.generate(gen)
  return { sim, logs }
}
/** A stone slab 20 ≤ x,z < 44 at y 20..23, with a spring on top in its middle. */
const island: Fill = (x, y, z) => x >= 20 && x < 44 && z >= 20 && z < 44 ? (y >= 20 && y < 24 ? B.stone : y === 24 && x === 32 && z === 32 ? spring(3) : 0) : 0

describe('void world', () => {
  it('water running off the island leaves the world; the account balances', () => {
    const { sim, logs } = voidSim(island)
    for (let i = 0; i < 2000; i++) sim.step()
    let below = 0
    for (let z = 0; z < 64; z++) for (let x = 0; x < 64; x++) for (let y = 0; y < 20; y++) if (sim.water.depthAt(x, y, z) > 0) below++
    expect(below).toBe(0)
    expect(logs.filter(l => l.includes('expected'))).toEqual([])
    expect(sim.water.total()).toBe(sim.water.expected)
  })

  it('without void, the same water pools on the floor (unchanged)', () => {
    const { sim } = voidSim(island, { void: false })
    for (let i = 0; i < 2000; i++) sim.step()
    let pooled = 0
    for (let z = 0; z < 64; z++) for (let x = 0; x < 64; x++) if (sim.water.depthAt(x, 0, z) > 0) pooled++
    expect(pooled).toBeGreaterThan(0)
  })

  it('water beside an overhang drains, none collects underneath', () => {
    // island plus an overhang: stone at y 30..31 over 10 ≤ x < 20 (a roof with open air below down to y 0)
    const roof: Fill = (x, y, z) => island(x, y, z) || (x >= 10 && x < 20 && z >= 20 && z < 44 && (y === 30 || y === 31) ? B.stone : 0)
    const { sim, logs } = voidSim(roof)
    for (let i = 0; i < 3000; i++) sim.step()
    let under = 0
    for (let z = 20; z < 44; z++) for (let x = 10; x < 20; x++) for (let y = 0; y < 30; y++) under += sim.water.depthAt(x, y, z)
    expect(under).toBe(0)
    expect(logs).toEqual([])
  })

  it('a falling block that reaches the bottom is removed', () => {
    const { sim } = voidSim((x, y, z) => x === 5 && z === 5 && y === 10 ? B.sand : 0)
    sim.step() // the block starts falling
    let landed = 0
    for (let i = 0; i < 400; i++) landed += sim.step().landed.length
    expect(landed).toBe(0)
    for (let y = 0; y < 48; y++) expect(sim.store.getVoxel(5, y, 5)).toBe(0)
    expect(sim.gravity.count).toBe(0)
  })

  it('a fragment cut loose leaves the world and is published as removed', () => {
    // collapsible beam row resting only on the floor of the world at x 5..7, y 0, z 5: in a void world the floor
    // is not support, so it falls out; collect r.collapse?.removed across steps and expect its fragment id once
  })

  it('the world floor is no support for collapse in a void world', () => {
    // a single collapsible block at y 0 with nothing else: void → it becomes a fragment and is removed; non-void → it stays
  })
})
```

Write the two collapse tests with `test/collapse.test.ts`'s `setup()`/`fill`/`settle` pattern (`collapses: true` block, `collapse: {}` option), asserting as the comments say.

Run: `npx vitest run test/voidWorld.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement**

- `generator.ts`: `GeneratorConfig { seaLevel?: number; /** The bottom of the volume is open: water, falling blocks, fragments and units leave the world there (spec §3). */ void?: boolean }`.
- `simulation.ts` `configure()`: after the sea level, `this.setVoid(r !== undefined && typeof r === 'object' && r.void === true)` with:

```ts
  private isVoid = false
  /** True when the generator declared a void world (spec §3). */
  get voidWorld(): boolean { return this.isVoid }
  private setVoid(v: boolean): void {
    this.isVoid = v
    this.water.cols.drainFloor = v
    this.gravity.voidFloor = v
    this.collapse.voidFloor = v
    this.workers?.setVoid(v) // Task 7; add `setVoid(v: boolean): void {}` to WorkerSystem now
  }
```

   Mix `this.isVoid ? 1 : 0` into `hash()`.
- `columns.ts`: field `drainFloor = false`; in `step()`, replace `const credit = sea ? this.pinAll(sea, seaSurface) : 0` with:

```ts
    let credit = sea ? this.pinAll(sea, seaSurface) : 0
    if (this.drainFloor) credit += this.drainAll(U)
```

   and:

```ts
  /** Void world: water resting on the bottom of the volume leaves it (credited to the sea account, which only sinks). */
  private drainAll(U: UnderSegments | null): number {
    const floor = this.floor, depth = this.depth, sx = this.sx, tx = this.tiles.tx
    let credit = 0
    const drain = (c: number) => {
      if (floor[c] === 0 && depth[c]! > 0) { credit += depth[c]!; depth[c] = 0 }
      // Only a column's lowest lower segment (U.first[c]; the chain runs bottom-up through U.next) can rest on y 0.
      const i = U ? U.first[c]! : -1
      if (i >= 0 && U!.floor[i] === 0 && U!.body[i]! < 0 && (U!.depth[i]! > 0 || U!.excess[i]! > 0)) {
        credit += U!.depth[i]! + U!.excess[i]!; U!.depth[i] = 0; U!.excess[i] = 0
      }
    }
    for (let k = 0; k < this.list.length; k++) {
      const t = this.list.data[k]!
      const x0 = (t % tx) * TILE, z0 = Math.floor(t / tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let c = x0 + z * sx, e = c + TILE; c < e; c++) drain(c)
    }
    for (let k = 0; k < this.ring.length; k++) drain(this.ring.data[k]!)
    return credit
  }
```

   A lowest segment that belongs to a pressurized body (`U.body[i] >= 0`) is left alone: a full segment cannot rest at the bottom of an open void column. If the overhang test shows water collecting in such a segment, drop its body for regrouping the way `onWrite` does (`bodies.ts`) and drain it on the next step.
- `gravity.ts` `advance` (L88–118): give the class `voidFloor = false`; in the grid scan `if (k < 0) { if (this.voidFloor) { gone = true; break } land = 0; break }` and `if (land < 0 && target < 0) { if (this.voidFloor) gone = true; else land = 0 }`, declaring `let gone = false` per body; when `gone`, `continue` before pushing to `keep` (no write, no landing). A body whose `y256` is already below 0 is also `gone`.
- `collapse.ts`: `voidFloor = false`; support search (L232) `if (y === 0 && !this.voidFloor) { job.phase = 'supported'; break }`; in `advance()` (L409–442) the run scan `if (y < 0) { if (!this.voidFloor) grid = Math.max(grid, -r.y * 256); break }`; after computing the new offset, if `this.voidFloor` and every run's top (`r.y + r.height - 1`, use the run fields) plus the offset in blocks is below 0, unindex the fragment, leave it out of `keep` and push its id to `this.removed`. `CollapseTick` gains `removed?: number[]`; `publication()` includes `removed` when non-empty (and is not `undefined` when only removals happened); clear `removed` after publishing.

- [ ] **Step 3: Run**

Run: `npx vitest run test/voidWorld.test.ts test/gravity.test.ts test/collapse.test.ts test/waterWorld.test.ts test/waterCycle.test.ts test/waterColumns.test.ts`. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A packages/engine
git commit -m "feat(sim): void worlds: water, falling blocks and fragments leave through the bottom"
```

---

### Task 7: Void world units and navigation

**Files:**
- Modify: `packages/engine/src/sim/workers/workers.ts` (`setVoid`, `hasSupport`, `attached`, `fall`, `kill`)
- Modify: `packages/engine/src/sim/navigation/navigation.ts:192-206` (`voidFloor`, `stand`, `regionStand`)
- Modify: `packages/engine/src/sim/navigation/regions.ts:136-150` (`vacant`)
- Test: `packages/engine/test/voidUnits.test.ts`

**Interfaces:**
- Consumes: `Simulation.setVoid` calling `workers.setVoid(v)` (Task 6); controlled-unit events (Task 4).
- Produces: `WorkerSystem.setVoid(v: boolean): void`; `NavigationSystem.voidFloor: boolean`; engine `event` `unitDied { id, cause: 'void' }` for every unit; unit event `died { cause: 'void' }` for controlled units.

- [ ] **Step 1: Failing tests**

Create `packages/engine/test/voidUnits.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import type { GameSystem, SystemContext } from '../src/sim/systems.ts'
import type { UnitEvent } from '../src/sim/workers/types.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'

/** A 16 × 16 stone island at y 10..11 in the middle of a 64² void world. */
function make(isVoid = true) {
  const events: UnitEvent[] = []
  let script: ((c: SystemContext) => void) | null = null
  const sys: GameSystem = { name: 't', version: 1, snapshot: () => null, tick: c => { events.push(...c.units.events); const s = script; script = null; s?.(c) } }
  const sim = new Simulation({ buffers: createWorldBuffers([64, 32, 64]), blocks: [{ name: 'stone' }], seed: 4, randomTicksPerChunk: 0, log: () => {}, systems: [sys], workers: { materials: { stone: { digTicks: 2 } } } })
  const gen = { configure: () => (isVoid ? { void: true } : undefined), generateColumn(ctx: { set(x: number, y: number, z: number, v: number): void }, cx: number, cz: number) {
    for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) { const x = cx * 32 + lx, z = cz * 32 + lz; if (x >= 24 && x < 40 && z >= 24 && z < 40) { ctx.set(lx, 10, lz, 1); ctx.set(lx, 11, lz, 1) } } } }
  sim.configure(gen, null); sim.generate(gen); sim.step()
  const run = <T>(s: (c: SystemContext) => T): T => { let out!: T; script = c => { out = s(c) }; sim.step(); return out }
  return { sim, events, run }
}

describe('void world units', () => {
  it('a unit whose island is dug away falls out of the world and dies', () => {
    const h = make()
    const id = h.run(c => c.units.spawn([30, 12, 30]))
    const r = (() => { h.sim.submit(0, 1, { type: 'fillRegion', min: [24, 10, 24], max: [39, 11, 39], voxel: 0 }); return h.sim.step() })()
    expect(r.acks[0]?.ok).toBe(true)
    let died: unknown[] = []
    for (let i = 0; i < 200; i++) died = died.concat(h.sim.step().events.filter(e => e.type === 'unitDied'))
    expect(died).toEqual([expect.objectContaining({ type: 'unitDied', payload: { id, cause: 'void' } })])
    expect(h.events).toContainEqual({ unit: id, type: 'died', cause: 'void' })
    expect(h.sim.workers!.units.has(id)).toBe(false)
  })

  it('the bottom of the world is not ground to stand on, walk on or build against', () => {
    const h = make()
    expect(h.sim.workers!.nav.stand(5, 0, 5)).toBe(false)
    expect(make(false).sim.workers!.nav.stand(5, 0, 5)).toBe(true)
  })

  it('a route never leads off the island', () => {
    const h = make()
    const id = h.run(c => c.units.spawn([25, 12, 25]))
    h.run(c => c.units.goTo(id, [5, 0, 5]))
    for (let i = 0; i < 50; i++) h.sim.step()
    expect(h.events).toContainEqual({ unit: id, type: 'failed', reason: 'no-access' })
    expect(h.sim.workers!.units.has(id)).toBe(true)
  })
})
```

Run: `npx vitest run test/voidUnits.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement**

- `navigation.ts`: `voidFloor = false` field; `stand`: `(y === 0 ? !this.voidFloor : this.port.registry.solid[voxelId(this.port.get(x, y - 1, z))] === 1)`; the same change in `regionStand` (L201–206).
- `regions.ts` `vacant()` (L147): `if (y === 0 && !this.nav.voidFloor) return false` (use whatever reference to the navigation system or flag the class already holds; pass the flag in if it holds none).
- `workers.ts`:

```ts
  private voidFloor = false
  setVoid(v: boolean): void {
    if (this.voidFloor === v) return
    this.voidFloor = v; this.nav.voidFloor = v
    this.invalidateAll()
  }
  /** A unit that fell below the world (void worlds): removed, with an engine event and, if controlled, a unit event. */
  private kill(u: Unit, cause: 'void'): void {
    if (u.controlled) this.unitEvent({ unit: u.id, type: 'died', cause })
    this.port.emit('unitDied', { id: u.id, cause })
    this.removeUnit(u); this.revision++
  }
```

  `hasSupport` (L327): `if (u.y === 0) return !this.voidFloor`. `attached` (L708): `if (y === 0) return !this.voidFloor`. `fall()`: `const target = this.voidFloor ? u.y - u.vy : Math.max(0, u.y - u.vy)`; in the scan `let floor = yy < 0 && !this.voidFloor`, and guard `this.port.get` for `yy < 0` (treat as air); after the scan `if (this.voidFloor && u.y < 0) { this.kill(u, 'void'); return }`; the `if (u.y === 0)` landing line only when `!this.voidFloor`.

- [ ] **Step 3: Run**

Run: `npx vitest run test/voidUnits.test.ts test/navigation.test.ts test/regions.test.ts test/workers.test.ts test/workersRoutes.test.ts`. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A packages/engine
git commit -m "feat(workers): in a void world the bottom is no support and units that fall out die"
```

---

### Task 8: Void world render (waterfall fade, fragment removal)

**Files:**
- Modify: `packages/engine/src/protocol.ts` (`ready` message `void`), `packages/engine/src/sim/simHost.ts` (post it)
- Modify: `packages/engine/src/engine.ts` (`Engine.voidWorld`, pass to visuals on `ready`)
- Modify: `packages/engine/src/render/water.ts`, `packages/engine/src/render/water/waterVertex.ts:114-209` (curtain fade uniform)
- Modify: `packages/engine/src/render/fragmentTrack.ts` (drop removed fragments)
- Test: `packages/engine/test/fragments.test.ts` or the existing fragment-track test file (extend), `packages/engine/test/simHost.test.ts` (extend)

**Interfaces:**
- Consumes: `Simulation.voidWorld` (Task 6), `CollapseTick.removed` (Task 6).
- Produces: `ready` message `{ …, void: boolean }`; `Engine.voidWorld: boolean`; `VOID_FADE_BLOCKS = 16` in `waterVertex.ts`; water materials' uniform `voidFloor` (0 or 1).

- [ ] **Step 1: Failing tests**

In `test/simHost.test.ts`, add: a host whose generator's `configure` returns `{ void: true }` and an init with `terrain: {}` posts `ready` with `void: true`; one without, `void: false`.

In the fragment-track tests (find the file that covers `FragmentTrack`: `grep -l FragmentTrack test/*.ts`), add: a fragment born then listed in `removed` is no longer drawn after the next `update`, without any landing.

Run them. Expected: FAIL.

- [ ] **Step 2: Implement**

- `simHost.ts`: every `post({ type: 'ready', … })` adds `void: this.sim!.voidWorld`; `protocol.ts` `ready` variant gains `void: boolean`.
- `engine.ts`: on `ready`, `voidWorld = m.void; visuals.water.setVoidFloor(m.void)`; the `Engine` interface gains `/** True when the generator declared a void world. */ readonly voidWorld: boolean` (getter in the `api` object).
- `water.ts`: a shared `uniform(0)` named `voidFloor`, passed into `curtainVertex`; `setVoidFloor(v)` sets it to 0/1 (add the method to the water renderer object `visuals.water` exposes).
- `waterVertex.ts` `curtainVertex()`: with `y` the curtain vertex's world height (L180, the curtain meshes sit at world y 0), multiply the body alpha:

```ts
export const VOID_FADE_BLOCKS = 16
// …
const voidFade = mix(float(1), smoothstep(float(0), float(VOID_FADE_BLOCKS), y), voidFloor)
// alpha: varying(mix(fade, splash, isSplash).mul(voidFade))
```

  No `select()` (Global Constraints).
- `fragmentTrack.ts`: in `update`, for each id in `collapse.removed ?? []`, remove the fragment exactly as a landed one is removed, without staging a chunk barrier.

- [ ] **Step 3: Run**

Run: the two test files, `npx vitest run test/surfaceView.test.ts` (unchanged), typecheck. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A packages/engine
git commit -m "feat(render): void worlds: waterfalls fade out near the bottom, removed fragments vanish"
```

---

### Task 9: Layer cut meshing

**Files:**
- Modify: `packages/engine/src/protocol.ts:74-84` (`job.cut?`, `result.cut?`)
- Modify: `packages/engine/src/mesh/meshJob.ts` (no trivial fast path under a cut, `applyCut`)
- Modify: `packages/engine/src/mesh/mesher.ts:26-40` (optional `plane`)
- Modify: `packages/engine/src/mesh/greedy.ts:58-106` (cut flag in the merge key and vertex)
- Modify: `packages/engine/src/mesh/vertexFormat.ts` (`CUT_BIT`)
- Modify: `packages/engine/src/render/decorations/extract.ts:48-73` (no tufts on covered cut cells)
- Modify: `packages/engine/src/render/chunkVertex.ts:38-86`, `packages/engine/src/render/materials.ts:14-39` (darken cut faces)
- Test: `packages/engine/test/meshJob.test.ts`, `packages/engine/test/greedy.test.ts`, `packages/engine/test/vertexFormat.test.ts`

**Interfaces:**
- Produces:
  - `ToMesh` job `{ type: 'job'; id; chunk; overrides?; cut?: number }` (world y of the highest visible layer; set only for chunks the cut crosses); `FromMesh` result echoes `cut?: number`.
  - `export interface CutPlane { py: number; covered: Uint8Array }` in `mesh/meshJob.ts` (`py` padded y of the cut layer, `covered[px + pz * PAD]` = 1 where the original voxel above was opaque).
  - `Mesher.mesh(snap, tables, ox, oy, oz, plane?: CutPlane)`
  - `CUT_BIT = 1 << 30` (word A), `CUT_SHADE = 0.72`

- [ ] **Step 1: Failing tests**

`test/vertexFormat.test.ts`: `CUT_BIT` does not overlap any other field of word A (pack a vertex with every field at its maximum, OR in `CUT_BIT`, decode every field unchanged).

`test/greedy.test.ts` (uses its `mesh(s)` helper; build the snapshot as its other tests do): for a solid 3 × 3 × 3 block in a chunk and a plane `{ py: <padded y of the block's middle layer>, covered: all 1 over the block }` after applying the cut, the mesh has top faces at the middle layer and every one of them carries `CUT_BIT`; with `covered` 0 over one column, that column's top face has no `CUT_BIT`; with no plane, no face has it.

`test/meshJob.test.ts` (uses `setup()`): a uniform-stone chunk surrounded by uniform stone returns `EMPTY` without a cut and a non-empty opaque layer with `cut` at its middle y; the result echoes `cut`; voxels above the cut produce no faces; a grass top at the cut layer under open sky keeps its decorations while a covered one gets none.

Run: `npx vitest run test/vertexFormat.test.ts test/greedy.test.ts test/meshJob.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement**

- `vertexFormat.ts`: `/** Word A bit 30: a top face created by the layer cut (spec §4). */ export const CUT_BIT = 1 << 30`.
- `meshJob.ts`:

```ts
export interface CutPlane { py: number; covered: Uint8Array }
/** Reads every voxel above world y `cut` as air (lit by the sky) and records which cut-layer cells were covered. */
export function applyCut(s: ChunkSnapshot, oy: number, cut: number): CutPlane {
  const py = cut - oy + 1 // padded y of the cut layer
  const covered = new Uint8Array(PAD * PAD)
  for (let pz = 0; pz < PAD; pz++) for (let px = 0; px < PAD; px++) {
    const above = py + 1 < PAD ? s.voxels[padIndex(px, py + 1, pz)]! : AIR
    covered[px + pz * PAD] = above !== AIR ? 1 : 0 // refine to the opaque table in run(), which has it
    for (let y = Math.max(py + 1, 0); y < PAD; y++) { const i = padIndex(px, y, pz); s.voxels[i] = AIR; s.light[i] = FULL_SKY }
  }
  return { py, covered }
}
```

  Use the real `padIndex` argument order from `world/reader.ts:8` and the `FULL_SKY` light constant `reader.ts` uses for rows above the world; mark `covered` from `tables.opaque[voxelId(v)]` rather than "not air" (move the opacity test into `run()` or pass `tables.opaque` to `applyCut`). In `run(job)`: skip the trivial fast path when `job.cut !== undefined`; after `applyOverrides`, `const plane = job.cut !== undefined ? applyCut(snap, cy * 32, job.cut) : undefined`; pass `plane` to `mesher.mesh` and to decoration extraction; add `cut: job.cut` to the result when defined.
- `mesher.ts`: thread `plane` to `meshOpaqueAndCutout` and `extractDecorations`.
- `greedy.ts`: when emitting a +y face (`UP`) at padded y `plane.py` whose `covered` cell is 1, set `cut = 1`: OR `cut << 28` into the merge key (L83) so cut and uncut faces never merge, and OR `CUT_BIT` into word A of its vertices.
- `extract.ts`: skip a cell at `plane.py` whose `covered` is 1.
- `chunkVertex.ts`: decode `const cut = float(a.shiftRight(30).bitAnd(1))` (match the file's TSL idiom), return it as a varying; `materials.ts`: `albedo.rgb.mul(mix(float(1), float(CUT_SHADE), cut))` for opaque and cutout.

- [ ] **Step 3: Run**

Run the three test files, `npm run bench:node -w @elovox/engine` (mesher gate 3 ms/chunk unchanged), typecheck. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A packages/engine
git commit -m "feat(mesh): layer cut: the cut layer meshes as if the world above were air, cut faces flagged"
```

---

### Task 10: Layer cut in the engine

**Files:**
- Create: `packages/engine/src/render/layerCut.ts`
- Modify: `packages/engine/src/engine.ts` (`view` API, dispatch, upload, raycast, orbit `heightAt`)
- Modify: `packages/engine/src/render/meshQueue.ts` (`PRIORITY.CUT`)
- Modify: `packages/engine/src/render/chunkMeshes.ts:81-91`, `packages/engine/src/render/chunkBatches.ts` (hide chunks above the cut)
- Modify: `packages/engine/src/render/water.ts`, `packages/engine/src/render/falling.ts`, `packages/engine/src/render/fragments.ts` (discard above the cut plane)
- Test: `packages/engine/test/layerCut.test.ts`, `packages/engine/test/chunkMeshes.test.ts`, `packages/engine/test/chunkBatches.test.ts`

**Interfaces:**
- Consumes: `job.cut`/`result.cut` (Task 9).
- Produces:
  - `export class LayerCut { constructor(layout: Layout); readonly y: number | null; set(y: number | null): number[] /* chunks to remesh */; hides(ci: number): boolean; crosses(ci: number): boolean; expected(ci: number): number | undefined /* the cut a chunk's mesh must have */ ; readonly top: number /* world y of the cut plane, Infinity when off */ }`
  - `Engine.view: { readonly cutY: number | null; cut(y: number | null): void }`
  - `PRIORITY.CUT = 0`
  - a shared TSL uniform `cutTop` (render/layerCut.ts) used by water, falling and fragment materials

- [ ] **Step 1: Failing tests**

Create `packages/engine/test/layerCut.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { LayerCut } from '../src/render/layerCut.ts'
import { Layout } from '../src/world/layout.ts'

const L = new Layout([64, 96, 64]) // 2 × 3 × 2 chunks
const ci = (cx: number, cy: number, cz: number) => L.chunkIndex(cx, cy, cz) // use the Layout's real chunk-index helper

describe('LayerCut', () => {
  it('hides chunks above the cut and crosses the cut layer', () => {
    const c = new LayerCut(L)
    const remesh = c.set(40)
    expect(c.hides(ci(0, 2, 0))).toBe(true)
    expect(c.crosses(ci(0, 1, 0))).toBe(true)
    expect(c.hides(ci(0, 1, 0))).toBe(false)
    expect(c.crosses(ci(0, 0, 0))).toBe(false)
    expect(remesh.sort()).toEqual([ci(0, 1, 0), ci(1, 1, 0), ci(0, 1, 1), ci(1, 1, 1)].sort())
    expect(c.top).toBe(41)
  })

  it('moving the cut to another layer remeshes both layers; null restores everything', () => {
    const c = new LayerCut(L)
    c.set(40)
    expect(c.set(70).length).toBe(8)
    expect(c.set(null).length).toBe(4)
    expect(c.hides(ci(0, 2, 0))).toBe(false)
    expect(c.top).toBe(Infinity)
  })

  it('stale cut results are dropped and re-queued', () => {
    const c = new LayerCut(L)
    c.set(40)
    expect(c.expected(ci(0, 1, 0))).toBe(40)
    c.set(41)
    expect(c.expected(ci(0, 1, 0))).toBe(41) // a result meshed with cut 40 no longer matches
    expect(c.expected(ci(0, 0, 0))).toBeUndefined()
  })

  it('rejects heights outside the world', () => {
    const c = new LayerCut(L)
    expect(() => c.set(-1)).toThrow(RangeError)
    expect(() => c.set(96)).toThrow(RangeError)
    expect(() => c.set(1.5)).toThrow(RangeError)
  })
})
```

In `test/chunkMeshes.test.ts` and `test/chunkBatches.test.ts`, add: a chunk hidden by the cut is not visible after `beginFrame` (meshes) and not in the draw list (batches), and becomes visible again when the cut is cleared, also with an infinite view distance.

Run them. Expected: FAIL.

- [ ] **Step 2: Implement `layerCut.ts`**

```ts
import { uniform } from 'three/tsl'
import type { Layout } from '../world/layout.ts'

/** World y of the cut plane for shaders; a large number when there is no cut. */
export const cutTop = uniform(1e9)

/** The layer cut (spec §4, plan deviation D9): the highest visible layer, the chunks it hides and the layer it crosses. */
export class LayerCut {
  private cut: number | null = null
  constructor(private readonly layout: Layout) {}
  get y(): number | null { return this.cut }
  get top(): number { return this.cut === null ? Infinity : this.cut + 1 }
  /** Sets the cut; returns the chunks whose mesh must be rebuilt (the old and the new crossed layers). */
  set(y: number | null): number[] {
    if (y !== null && (!Number.isInteger(y) || y < 0 || y >= this.layout.size[1])) throw new RangeError(`cut must be an integer layer in [0, ${this.layout.size[1] - 1}] or null, got ${y}`)
    const before = this.cut === null ? -1 : this.cut >> 5, after = y === null ? -1 : y >> 5
    this.cut = y
    cutTop.value = y === null ? 1e9 : y + 1
    const layers = new Set([before, after].filter(l => l >= 0))
    const out: number[] = []
    for (const cy of layers) for (let cz = 0; cz < this.layout.cz; cz++) for (let cx = 0; cx < this.layout.cx; cx++) out.push(this.layout.chunkIndex(cx, cy, cz))
    return out
  }
  hides(ci: number): boolean { return this.cut !== null && this.layout.chunkCoords(ci)[1] * 32 > this.cut }
  crosses(ci: number): boolean { return this.cut !== null && this.layout.chunkCoords(ci)[1] === this.cut >> 5 }
  expected(ci: number): number | undefined { return this.crosses(ci) ? this.cut! : undefined }
}
```

Use the `Layout` method names that exist (`chunkIndex`/`chunkCoords` or equivalents; check `world/layout.ts`); if `cx`/`cz` are named differently, adapt.

- [ ] **Step 3: Wire the engine**

- `meshQueue.ts`: `PRIORITY = { GHOST: 0, CUT: 0, DIRTY: 1, INITIAL: 2 }`.
- `engine.ts`:
  - `const layerCut = new LayerCut(layout)`;
  - `dispatch()` (L648–659): add `cut: layerCut.expected(ci)` to the job when defined;
  - `onMeshMessage`/`upload()`: drop a result whose `cut` differs from `layerCut.expected(chunk)` (both undefined is a match) and `markDirty(chunk, PRIORITY.CUT)` it again;
  - `api.view = { get cutY() { return layerCut.y }, cut(y) { for (const ci of layerCut.set(y)) markDirty(ci, PRIORITY.CUT); visuals.setCut(layerCut) } }`;
  - raycast and `pickScreen` (L753–754, 868–873): the `get` they pass returns `AIR` for `y > layerCut.y` when a cut is set;
  - the orbit camera's `heightAt` (L378): start the column scan at `min(top, layerCut.y)`.
- `chunkMeshes.ts` `beginFrame`: `m.visible = this.inRange(ci) && !this.cut?.hides(ci)`; do not return early on an infinite range while a cut is set. `chunkBatches.ts`: skip instances whose chunk the cut hides in `cull()` (same place as the range test). Give both a `setCut(cut: LayerCut)` called from `visuals.setCut`.
- Discard above the cut plane (`Discard(positionWorld.y.greaterThan(cutTop.add(0.01)))` in the fragment node) for the water materials in `water.ts` (voxel, surface, curtain, plainSurface, plainCurtain), the falling-block material (`falling.ts`) and the fragment materials (`fragments.ts`). Decorations need nothing: hidden chunks hide theirs and the cut layer is re-extracted (Task 9).

- [ ] **Step 4: Run**

Run: `npx vitest run test/layerCut.test.ts test/chunkMeshes.test.ts test/chunkBatches.test.ts test/meshQueue.test.ts test/raycast.test.ts`, typecheck. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/engine
git commit -m "feat(engine): engine.view.cut(y) hides the world above a layer without touching the simulation"
```

---

### Task 11: Management camera

**Files:**
- Modify: `packages/engine/src/interact/orbitCamera.ts`
- Modify: `packages/engine/src/engine.ts` (`EngineOptions.camera`, construction at L378)
- Test: `packages/engine/test/orbitCamera.test.ts`

**Interfaces:**
- Produces: `OrbitOptions.yaw?`, `pitch?`, `distance?` (the home view; defaults 0.7, 0.85, 70); `OrbitCamera.reset(): void`; `EngineOptions.camera?: { yaw?: number; pitch?: number; distance?: number; minPitch?: number; maxPitch?: number; minDistance?: number; maxDistance?: number }`.

- [ ] **Step 1: Failing tests**

Append to `test/orbitCamera.test.ts` (use its construction helper):

```ts
it('reset() returns to the home yaw and pitch, keeps the target and distance, takes the short way round', () => {
  const cam = new OrbitCamera({ worldSize: [256, 100, 256], yaw: 0.5, pitch: 0.9 })
  cam.goal.target = [40, 0, 60]
  cam.rotate(2 * Math.PI * 3 + 1, -0.3) // three turns and a bit
  cam.zoom(500)
  const d = cam.goal.distance
  cam.reset()
  expect(cam.goal.pitch).toBeCloseTo(0.9)
  expect(Math.abs(cam.goal.yaw - cam.current.yaw)).toBeLessThanOrEqual(Math.PI) // never spins several turns back
  expect(((cam.goal.yaw - 0.5) / (2 * Math.PI)) % 1).toBeCloseTo(0)
  expect(cam.goal.target).toEqual([40, 0, 60])
  expect(cam.goal.distance).toBe(d)
})

it('takes pitch and distance limits from its options', () => {
  const cam = new OrbitCamera({ worldSize: [256, 100, 256], minPitch: 0.6, maxPitch: 1.1, minDistance: 20, maxDistance: 150 })
  cam.rotate(0, 5); expect(cam.goal.pitch).toBe(1.1)
  cam.zoom(1e6); expect(cam.goal.distance).toBe(150)
})
```

(If `rotate`'s arguments are scaled, adjust the amounts so they exceed the limits; the assertions stay.) Run: `npx vitest run test/orbitCamera.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement**

In `OrbitOptions` add `yaw?`, `pitch?`, `distance?`; keep the resolved home `{ yaw, pitch }` in a private field and start `goal` with `{ target: [sx / 2, 0, sz / 2], yaw, pitch, distance }`. Add:

```ts
  /** Back to the home yaw and pitch, keeping the target and the zoom; turns the short way round. */
  reset(): void {
    const turn = 2 * Math.PI
    const k = Math.round((this.goal.yaw - this.home.yaw) / turn)
    this.goal.yaw = this.home.yaw + k * turn
    this.goal.pitch = clamp(this.home.pitch, this.o.minPitch, this.o.maxPitch)
  }
```

`EngineOptions.camera` is spread into the `OrbitCamera` options at `engine.ts:378`.

- [ ] **Step 3: Run and commit**

Run: `npx vitest run test/orbitCamera.test.ts test/firstPerson.test.ts`, typecheck. Expected: PASS.

```bash
git add -A packages/engine
git commit -m "feat(camera): OrbitCamera.reset() and camera limits through EngineOptions"
```

---

### Task 12: Time of day

**Files:**
- Modify: `packages/engine/src/render/atmosphere.ts` (`DayKey`, `DAY_KEYFRAMES`, `setTimeOfDay`, `defineDay`, `timeOfDay`)
- Modify: `packages/engine/src/render/lighting.ts:32-85` (low-sun light direction and shadow fade)
- Modify: `packages/engine/src/index.ts` (exports)
- Test: `packages/engine/test/atmosphere.test.ts`, `packages/engine/test/shadowFit.test.ts`

**Interfaces:**
- Produces: `export interface DayKey { t: number; atmosphere: AtmosphereInput }`; `export const DAY_KEYFRAMES: readonly DayKey[]`; `AtmosphereController.setTimeOfDay(t: number): void`, `.defineDay(keys: readonly DayKey[]): void`, `.timeOfDay: number | null`; `MIN_SHADOW_ELEVATION = 12`, `SHADOW_FADE_FROM = 3` (degrees) in `lighting.ts`.

- [ ] **Step 1: Failing tests**

Append to `test/atmosphere.test.ts`:

```ts
describe('time of day', () => {
  it('interpolates the keyframes and wraps around midnight', () => {
    const a = new AtmosphereController()
    a.setTimeOfDay(0.5)
    expect(a.current.sun.elevation).toBeGreaterThan(45) // noon
    expect(a.update(0)).toBe(true)
    a.setTimeOfDay(0.99); const late = a.current.sun.azimuth
    a.setTimeOfDay(0.01); const early = a.current.sun.azimuth
    expect(Math.abs(((early - late + 540) % 360) - 180)).toBeLessThan(15) // no jump across midnight
    expect(a.timeOfDay).toBeCloseTo(0.01)
  })

  it('is dark but playable at night and bright at noon', () => {
    const a = new AtmosphereController()
    a.setTimeOfDay(0); const night = a.current
    a.setTimeOfDay(0.5); const noon = a.current
    expect(night.ambient.intensity).toBeGreaterThan(0.15)
    expect(night.ambient.intensity).toBeLessThan(noon.ambient.intensity)
    expect(night.sun.intensity).toBeLessThan(noon.sun.intensity)
  })

  it('a preset takes over again', () => {
    const a = new AtmosphereController()
    a.setTimeOfDay(0.3)
    a.set('sunset')
    expect(a.timeOfDay).toBeNull()
    expect(a.current).toEqual(PRESETS.sunset)
  })

  it('rejects bad times and bad keyframes', () => {
    const a = new AtmosphereController()
    expect(() => a.setTimeOfDay(1)).toThrow(RangeError)
    expect(() => a.setTimeOfDay(Number.NaN)).toThrow(RangeError)
    expect(() => a.defineDay([])).toThrow(RangeError)
    expect(() => a.defineDay([{ t: 0.5, atmosphere: {} }, { t: 0.2, atmosphere: {} }])).toThrow('keyframes must be sorted by t in [0, 1)')
  })
})
```

Append to `test/shadowFit.test.ts`: `SunLights` (or the function that computes the light direction from the atmosphere) uses elevation `max(e, MIN_SHADOW_ELEVATION)` for its direction, so the fitted shadow box at 4° equals the one at 12°; the shadow strength factor is 0 at ≤ 3°, 1 at ≥ 12°. Write it against the function you factor out in Step 2 (`shadowElevation(e)` and `shadowFade(e)`, pure).

Run: `npx vitest run test/atmosphere.test.ts test/shadowFit.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement**

In `atmosphere.ts`:

```ts
export interface DayKey { t: number; atmosphere: AtmosphereInput }

/** The default day (first guesses, tuned at the checkpoints): t 0 is midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset. The night "sun" is the moon. */
export const DAY_KEYFRAMES: readonly DayKey[] = deepFreeze([
  { t: 0.0, atmosphere: { sun: { azimuth: 0, elevation: 40, color: '#9fb4ff', intensity: 0.25 }, ambient: { sky: '#3a4a7a', ground: '#1e1a24', intensity: 0.3 }, sky: { zenith: '#0b1530', horizon: '#26345e', sunGlow: 0.05, clouds: { light: '#4a5680', shade: '#20263f' } }, fog: { color: '#1d2747' }, shadow: { strength: 0.5, tint: '#1a2140' }, grade: { exposure: 0.9 } } },
  { t: 0.2, atmosphere: { sun: { azimuth: 60, elevation: -8, color: '#9fb4ff', intensity: 0.2 }, ambient: { sky: '#4a5590', ground: '#2a2230', intensity: 0.32 }, sky: { zenith: '#1a2550', horizon: '#6a5a8a', sunGlow: 0.1 }, fog: { color: '#4a4a74' } } },
  { t: 0.25, atmosphere: { sun: { azimuth: 90, elevation: 2, color: '#ffb27a', intensity: 1.1 }, ambient: { sky: '#d9a6c8', ground: '#5a4050', intensity: 0.5 }, sky: { zenith: '#5a6ab0', horizon: '#ffa98a', sunGlow: 1.2 }, fog: { color: '#f2b0a0' } } },
  { t: 0.32, atmosphere: { sun: { azimuth: 110, elevation: 30, color: '#fff1d6', intensity: 1.5 }, ambient: { sky: '#a8c8ff', ground: '#6b5a45', intensity: 0.65 } } },
  { t: 0.5, atmosphere: { sun: { azimuth: 180, elevation: 62, color: '#fff6e8', intensity: 1.7 }, ambient: { sky: '#a8c8ff', ground: '#6b5a45', intensity: 0.75 }, sky: { zenith: '#2f6fd6', horizon: '#bcd9f2', sunGlow: 0.6 }, fog: { color: '#bcd9f2' } } },
  { t: 0.68, atmosphere: { sun: { azimuth: 250, elevation: 30, color: '#fff1d6', intensity: 1.5 }, ambient: { intensity: 0.65 } } },
  { t: 0.75, atmosphere: { sun: { azimuth: 270, elevation: 2, color: '#ffb27a', intensity: 1.2 }, ambient: { sky: '#d9a6c8', ground: '#5a4050', intensity: 0.5 }, sky: { zenith: '#6a5aa8', horizon: '#ff9fb0', sunGlow: 1.2 }, fog: { color: '#f2a5a8' } } },
  { t: 0.8, atmosphere: { sun: { azimuth: 300, elevation: -8, color: '#9fb4ff', intensity: 0.2 }, ambient: { sky: '#4a5590', ground: '#2a2230', intensity: 0.32 }, sky: { zenith: '#1a2550', horizon: '#5a4a7a', sunGlow: 0.1 }, fog: { color: '#3a3a64' } } },
])
```

Each keyframe is resolved over `OPEN` once (`resolveAtmosphere(OPEN, k.atmosphere)`) when the day is defined. In `AtmosphereController`: fields `private day: { t: number; a: Atmosphere }[]` (resolved `DAY_KEYFRAMES` by default) and `private tod: number | null = null`;

```ts
  get timeOfDay(): number | null { return this.tod }
  defineDay(keys: readonly DayKey[]): void {
    if (!keys.length || keys.some((k, i) => !(k.t >= 0 && k.t < 1) || (i > 0 && k.t <= keys[i - 1]!.t))) throw new RangeError('keyframes must be sorted by t in [0, 1)')
    this.day = keys.map(k => ({ t: k.t, a: resolveAtmosphere(OPEN, k.atmosphere) }))
  }
  /** Sets the look from the day's keyframes (t in [0, 1)); a preset set later takes over again. */
  setTimeOfDay(t: number): void {
    if (!(t >= 0 && t < 1)) throw new RangeError(`time of day must be in [0, 1), got ${t}`)
    const d = this.day, n = d.length
    let i = n - 1
    while (i > 0 && d[i]!.t > t) i--
    if (d[0]!.t > t) i = n - 1
    const a = d[i]!, b = d[(i + 1) % n]!
    const span = ((b.t - a.t + 1) % 1) || 1
    const f = ((t - a.t + 1) % 1) / span
    this.now = lerpAtmosphere(a.a, b.a, f); this.from = this.now; this.to = this.now; this.duration = 0; this.elapsed = 0
    this.tod = t; this.changed = true
  }
```

and `set()` starts with `this.tod = null`. (`lerpAtmosphere` already interpolates azimuth with `lerpAngle`.)

In `lighting.ts`, factor out and use:

```ts
export const MIN_SHADOW_ELEVATION = 12
export const SHADOW_FADE_FROM = 3
/** The elevation the directional light (and its shadow box) uses: never below 12°, so low suns keep a tight shadow fit. */
export function shadowElevation(e: number): number { return Math.max(e, MIN_SHADOW_ELEVATION) }
/** Shadow strength factor: 0 at ≤ 3°, 1 at ≥ 12° of real elevation. */
export function shadowFade(e: number): number { const t = Math.min(1, Math.max(0, (e - SHADOW_FADE_FROM) / (MIN_SHADOW_ELEVATION - SHADOW_FADE_FROM))); return t * t * (3 - 2 * t) }
```

`SunLights.apply` places the light with `sunDirection(azimuth, shadowElevation(elevation))` (the sky keeps the real elevation for the sun disc) and multiplies the shadow strength by `shadowFade(elevation)`; `fit` uses the same placed direction.

`index.ts`: export `DAY_KEYFRAMES` and `type DayKey` next to `AtmosphereController`.

- [ ] **Step 3: Run and commit**

Run: `npx vitest run test/atmosphere.test.ts test/shadowFit.test.ts test/sky.test.ts`, typecheck. Expected: PASS.

```bash
git add -A packages/engine
git commit -m "feat(render): continuous time of day from keyframes; low suns keep a tight, fading shadow"
```

---

### Task 13: Sandbox sky scene, e2e and the cut benchmark

**Files:**
- Create: `apps/sandbox/src/scenes/sky.ts` (void generator: one floating island with a spring, a cliff and an overhang; a `wander` demo system)
- Create: `apps/sandbox/src/sky.worker.ts`
- Modify: `apps/sandbox/src/scene.ts` (`sky`), `apps/sandbox/src/main.ts` (boot it: keys PageUp/PageDown move the cut, End clears it, Home resets the camera, a time-of-day slider in the HUD, `engine.on('system')` shows the demo's publication)
- Create: `apps/sandbox/e2e/sky.spec.ts`, `apps/sandbox/e2e/cut-bench.spec.ts`

**Interfaces:**
- Consumes: everything above through the public API only (`@elovox/engine`, `@elovox/engine/sim-worker`).
- Produces: `?scene=sky`; the `wander` system (3 controlled units; each walks to a random reachable point on the island, sometimes digs the block under a random point and builds it back; publishes `{ units: number, dug: number, built: number, died: number }` every 20 ticks).

- [ ] **Step 1: The scene**

`scenes/sky.ts` exports `skyGenerator` (`defineGenerator`, `configure: () => ({ void: true })`, a 256² world 100 high; an island of radius ~70 around the centre with a noisy top at y ~50–60, a tapered underside down to y ~20, a spring near the middle whose stream runs off one edge, an overhang on the other side) and `wander` (`defineSystem`, `name: 'wander'`, `version: 1`, state `{ ids: number[], dug: number, built: number, died: number, pending: { id: number; pos: [number, number, number] }[] }`, using only `ctx.units` and `ctx.random()`). `sky.worker.ts`: `runSimWorker({ generator: skyGenerator, systems: [wander] })`. Wire `?scene=sky` in `scene.ts`/`main.ts` like the other scenes, passing `terrain: {}` so `configure` runs, with workers enabled.

- [ ] **Step 2: e2e**

`e2e/sky.spec.ts` (pattern: `e2e/water-render.spec.ts` for screenshots, `window.__elovox.engine`):

1. boot `?scene=sky`; wait for `ready` and `meshQueue === 0`; expect `engine.voidWorld === true`;
2. wait for a `system` event named `wander` with `units === 3`; after 60 s of sim time expect no `fatal` and `dug ≥ 1`;
3. after 2,000 ticks expect no water below the island's underside (`engine.stats()` cannot tell; read the sim through a `window.__elovox` hook the sandbox exposes for e2e, as other specs do, or check the water surface layer count near y 0 is 0);
4. screenshots: surface; `engine.view.cut(40)` then mesh settled; `engine.atmosphere.setTimeOfDay(t)` for `t = 0, 0.26, 0.5` — attach each;
5. `engine.raycast` straight down from above the island with the cut at 40 hits `y ≤ 40`;
6. `engine.controls.reset()` returns `goal.yaw` to the home value modulo 2π.

`e2e/cut-bench.spec.ts`, skipped unless `BENCH_CUT=1`: on `?scene=sky`, settle, then for 12 steps move the cut down one layer starting at the island top and measure from `cut()` to `meshQueue === 0 && meshInFlight === 0` plus one rendered frame; print `{"cutStepMs":{"p50":…,"p95":…,"max":…}}`; with `BENCH_ASSERT=1` assert p95 ≤ 150. Run it twice and keep the worse.

- [ ] **Step 3: Run**

Run: `E2E_PORT=5197 E2E_CHANNEL=msedge npm run e2e -- --workers=1 e2e/sky.spec.ts`. Expected: PASS. Then (quiet machine only, ask the user first) `BENCH_CUT=1 E2E_PORT=5197 E2E_CHANNEL=msedge npm run e2e -- --workers=1 e2e/cut-bench.spec.ts` twice; record the numbers.

- [ ] **Step 4: Commit**

```bash
git add apps/sandbox
git commit -m "feat(sandbox): ?scene=sky floating island with a game-system demo, layer cut and time of day"
```

---

### Task 14: Docs, full verification and user checkpoints

**Files:**
- Modify: `CONTEXT.md` (terms; *Fixed support* note)
- Create: `docs/adr/0005-game-logic-runs-in-the-sim-worker.md`
- Create: `docs/superpowers/reviews/2026-10-14-game-hooks.md`

- [ ] **Step 1: CONTEXT terms**

Add, in the file's style:

- **Game system**: A game's own simulation code, run by the engine once per tick after the worker units step, with its own commands (`name:`), save section (`system:name`) and per-tick publication. _Avoid_: plugin, mod, script.
- **Controlled unit**: A worker unit owned by a game system: never given work by the engine, driven by one intent at a time, reporting what happened to it. Its digs keep nothing. _Avoid_: player unit, NPC.
- **Void world**: A world whose bottom is open: water, falling blocks, fragments and units that reach it leave the world. _Avoid_: sky world, no-floor mode.
- **Layer cut**: The highest visible layer: everything above it is hidden and the cut layer's tops are drawn as solid, darker faces; the simulation is untouched. _Avoid_: slice, clipping, x-ray.

Amend *Fixed support*: "…or the finite world floor (not in a void world)".

- [ ] **Step 2: ADR 0005**

Short ADR: context (a game needs per-tick logic that moves units and owns state), decision (game systems inside the sim worker, controlled units, resources owned by the game, system save sections), rejected alternatives (main-thread driver: one-tick round trips and save sections taken at different moments; separate worker: same plus plumbing), consequences (the engine never interprets a system's state; a system's exception is fatal; game saves need `checkSystemSections`).

- [ ] **Step 3: Full verification**

Run, from the repo root: `npm run typecheck`, `npm test`, `E2E_PORT=5197 E2E_CHANNEL=msedge npm run e2e -- --workers=1`. Expected: all green (re-run known load-sensitive timeouts alone).

- [ ] **Step 4: Review doc**

`docs/superpowers/reviews/2026-10-14-game-hooks.md`: what was built per spec section, deviations D1–D9, BENCH_CUT numbers, open items.

- [ ] **Step 5: User checkpoints** (with the user, on `?scene=sky`)

1. The waterfall falls off the edge and fades into the void; nothing pools below.
2. The cut: stepping down through the island, the cut tops read as cut (darker), water and units above vanish, picking ignores hidden blocks.
3. Time of day: night is dark but playable, dawn and sunset colours, shadows at low sun do not swim or pixelate.
4. Camera reset (Home) feels right.
5. The wander units walk, dig and build without hanging.

Record the results in the review doc; tune keyframes or `CUT_SHADE`/`VOID_FADE_BLOCKS` as asked.

- [ ] **Step 6: Commit**

```bash
git add CONTEXT.md docs
git commit -m "docs(game-hooks): terms, ADR 0005, review and checkpoint results"
```

Then use superpowers:finishing-a-development-branch; merging and pushing are the user's call.
