import { pack, unpack } from '../persist/pack.ts'
import type { Layout } from '../world/layout.ts'
import type { Command, Vec3 } from './commands.ts'
import { Pcg32, hash32 } from './rng.ts'
import type { UnitEvent, WorkerView } from './workers/types.ts'
import { WorldFullError } from '../world/chunkStore.ts'

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
  /** Water above the bottom of cell (x, y, z), in 1/256 block (0 when dry). */
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
