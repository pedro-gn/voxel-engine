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

export type Living = {
  setup(): Promise<void>; startWork(): Promise<void>; breach(): Promise<void>; collapse(): Promise<void>; moveGroup(): Promise<void>
  camera(name: keyof typeof CAMERAS): void
  readonly started: boolean
}

export function createLiving(engine: Engine): Living {
  const b = engine.blocks
  const ids: Ids = { water: packVoxel(b.id('water'), 7), stone: b.id('stone'), planks: b.id('planks'), beam: b.id('structural_planks'), glass: b.id('structural_glass'), dirt: b.id('dirt') }
  let started = false, breached = false, collapsed = false, groupAtRest = false
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
      // Dig the quarry, fill it back, dig again: the crews stay busy for as long as the scene runs.
      let cycling = false
      engine.on('workers', tick => {
        if (cycling) return
        const next = quarryCycle(tick.orders, SITES.work, ids)
        if (next.length) { cycling = true; void submitAll(engine, next).finally(() => { cycling = false }) }
      })
    },
    async breach() { if (breached) return; breached = true; await submitAll(engine, breachCommands(SITES.reservoir)) },
    async collapse() { if (collapsed) return; collapsed = true; await submitAll(engine, collapseCommands(SITES.tower)) },
    async moveGroup() { groupAtRest = !groupAtRest; await submitAll(engine, moveGroupCommands(groupAtRest ? SITES.rest : SITES.work)) },
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

/** Buttons for the same events the benchmark drives. */
export function createLivingBar(living: Living): void {
  const bar = document.createElement('div'); bar.setAttribute('aria-label', 'Mundo vivo')
  Object.assign(bar.style, { position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '8px', zIndex: '10' })
  const actions: [string, () => unknown, boolean][] = [
    ['Começar obras', () => living.startWork(), true], ['Mover grupo', () => living.moveGroup(), false],
    ['Romper represa', () => living.breach(), true], ['Desabar torre', () => living.collapse(), true],
    ['Câmera padrão', () => living.camera('default'), false], ['Câmera afastada', () => living.camera('far'), false],
  ]
  for (const [label, action, once] of actions) {
    const button = document.createElement('button'); button.textContent = label
    Object.assign(button.style, { padding: '10px 14px', border: '1px solid #bcc7b9', borderRadius: '6px', background: '#f6f8f1', color: '#233027', cursor: 'pointer' })
    button.addEventListener('click', () => { void action(); if (once) button.disabled = true }); bar.append(button)
  }
  document.body.append(bar)
}
