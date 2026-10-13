import { packVoxel, type Command, type Engine } from '@elovox/engine'
import {
  CAMERAS, SITES, breachCommands, quarryCycle, clearCommands, collapseCommands, moveGroupCommands, reservoirCommands,
  spawnCommands, towerCommands, workCommands, workSiteCommands, type Ids,
} from './scenes/living.ts'

/** Submits commands in order; resolves when all are acked ok, rejects with the first refusal. */
export function submitAll(engine: Pick<Engine, 'submit' | 'on'>, commands: Command[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const pending = new Set<number>()
    const off = engine.on('ack', (a) => {
      if (!pending.has(a.seq)) return
      if (!a.ok) { off(); reject(new Error(a.error ?? `command ${a.seq} refused`)); return }
      pending.delete(a.seq)
      if (!pending.size) { off(); resolve() }
    })
    for (const c of commands) pending.add(engine.submit(c))
    if (!pending.size) { off(); resolve() }
  })
}

/** What a save keeps of the living scene's script (the world itself is in the engine's save). */
export interface LivingState { started: boolean; breached: boolean; collapsed: boolean; groupAtRest: boolean }

export type Living = {
  setup(): Promise<void>; startWork(): Promise<void>; breach(): Promise<void>; collapse(): Promise<void>; moveGroup(): Promise<void>
  camera(name: keyof typeof CAMERAS): void
  readonly started: boolean
  save(): LivingState
  /** After a load, instead of setup(): takes the flags and resumes the quarry cycle when work had started. */
  restore(s: LivingState): void
}

export function createLiving(engine: Engine): Living {
  const b = engine.blocks
  const ids: Ids = { water: packVoxel(b.id('water'), 7), stone: b.id('stone'), planks: b.id('planks'), beam: b.id('structural_planks'), glass: b.id('structural_glass'), dirt: b.id('dirt') }
  let started = false, breached = false, collapsed = false, groupAtRest = false
  // Dig the quarry, fill it back, dig again: the crews stay busy for as long as the scene runs.
  const startCycle = () => {
    let cycling = false
    engine.on('workers', tick => {
      if (cycling) return
      const next = quarryCycle(tick.orders, SITES.work, ids)
      if (next.length) { cycling = true; void submitAll(engine, next).finally(() => { cycling = false }) }
    })
  }
  return {
    get started() { return started },
    async setup() {
      await submitAll(engine, [
        ...Object.values(SITES).flatMap(clearCommands),
        ...reservoirCommands(SITES.reservoir, ids), ...towerCommands(SITES.tower, ids), ...workSiteCommands(SITES.work, ids),
      ])
      await submitAll(engine, spawnCommands(SITES.work, ids))
    },
    async startWork() {
      if (started) return
      started = true
      await submitAll(engine, [...workCommands(SITES.work, ids), ...moveGroupCommands(SITES.rest)])
      groupAtRest = true
      startCycle()
    },
    async breach() { if (breached) return; breached = true; await submitAll(engine, breachCommands(SITES.reservoir)) },
    async collapse() { if (collapsed) return; collapsed = true; await submitAll(engine, collapseCommands(SITES.tower)) },
    async moveGroup() { groupAtRest = !groupAtRest; await submitAll(engine, moveGroupCommands(groupAtRest ? SITES.rest : SITES.work)) },
    save: () => ({ started, breached, collapsed, groupAtRest }),
    restore(s) {
      started = s.started; breached = s.breached; collapsed = s.collapsed; groupAtRest = s.groupAtRest
      if (started) startCycle()
    },
    camera(name) {
      const c = CAMERAS[name]
      for (const s of [engine.controls.goal, engine.controls.current]) {
        s.target[0] = c.target[0]; s.target[1] = c.target[1]; s.target[2] = c.target[2]
        s.distance = c.distance; s.pitch = c.pitch; s.yaw = c.yaw
      }
      engine.controls.apply(engine.camera)
    },
  }
}

/** Buttons for the same events the benchmark drives; one-shot events already run (a loaded save) start disabled. */
export function createLivingBar(living: Living): void {
  const done = living.save()
  const bar = document.createElement('div'); bar.setAttribute('aria-label', 'Mundo vivo')
  Object.assign(bar.style, { position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '8px', zIndex: '10' })
  const actions: [string, () => unknown, boolean, boolean][] = [
    ['Começar obras', () => living.startWork(), true, done.started], ['Mover grupo', () => living.moveGroup(), false, false],
    ['Romper represa', () => living.breach(), true, done.breached], ['Desabar torre', () => living.collapse(), true, done.collapsed],
    ['Câmera padrão', () => living.camera('default'), false, false], ['Câmera afastada', () => living.camera('far'), false, false],
  ]
  for (const [label, action, once, used] of actions) {
    const button = document.createElement('button'); button.textContent = label; button.disabled = used
    Object.assign(button.style, { padding: '10px 14px', border: '1px solid #bcc7b9', borderRadius: '6px', background: '#f6f8f1', color: '#233027', cursor: 'pointer' })
    button.addEventListener('click', () => { void action(); if (once) button.disabled = true }); bar.append(button)
  }
  document.body.append(bar)
}
