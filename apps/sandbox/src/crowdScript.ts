import type { Engine } from '@elovox/engine'
import { submitAll } from './livingScript.ts'
import { PADS, bottleneckCommands, massMove, padClearCommands, scatterMoves, spawnCrowd, workOrders } from './scenes/crowd.ts'

export type Crowd = {
  readonly units: number
  spawn(): Promise<void>; allEast(): Promise<void>; scatter(): Promise<void>; bottleneck(): Promise<void>; work(): Promise<void>
  /** Live unit ids, from the newest workers publication. */
  ids(): number[]
}

/** The crowd scene's events, the same ones the scale benchmark (bench/crowd.node.ts) drives. */
export function createCrowd(engine: Engine, units: number): Crowd {
  const stone = engine.blocks.id('stone'), planks = engine.blocks.id('planks')
  const ids = () => { const p = engine.workers?.poses ?? new Int32Array(0), out: number[] = []; for (let i = 0; i < p.length; i += 9) out.push(p[i]!); return out }
  let scatters = 0
  return {
    units, ids,
    async spawn() {
      const before = engine.workers?.stats.units ?? 0
      await submitAll(engine, [...padClearCommands(), ...spawnCrowd(units, ['west', 'north'], [{ block: planks, count: 64 }, { block: stone, count: 64 }])])
      // Moves name ids, so wait until a publication lists the new units.
      await new Promise<void>(resolve => { const off = engine.on('workers', t => { if (t.stats.units >= before + units) { off(); resolve() } }) })
    },
    async allEast() { await submitAll(engine, [massMove(ids(), 'east')]) },
    async scatter() { await submitAll(engine, scatterMoves(ids(), 7 + scatters++)) },
    /** The wall with its two gates, then half the units to the east pad and half to the west pad. */
    async bottleneck() {
      await submitAll(engine, bottleneckCommands(stone))
      const all = ids(), half = all.length >> 1
      await submitAll(engine, [massMove(all.slice(0, half), 'east'), massMove(all.slice(half), 'west')])
    },
    async work() { await submitAll(engine, workOrders(stone, planks)) },
  }
}

/** Looks down at the whole map, the five pads in view. */
export function crowdCamera(engine: Engine): void {
  const [x, , z] = PADS.centre.min
  for (const s of [engine.controls.goal, engine.controls.current]) {
    s.target[0] = x + 32; s.target[1] = PADS.centre.y; s.target[2] = z + 32; s.distance = 900; s.pitch = 1.0; s.yaw = 0.7
  }
  engine.controls.apply(engine.camera)
}

/** Buttons for the crowd events; Spawn and Bottleneck run once. */
export function createCrowdBar(crowd: Crowd): void {
  const bar = document.createElement('div'); bar.setAttribute('aria-label', 'Multidão')
  Object.assign(bar.style, { position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '8px', zIndex: '10' })
  const actions: [string, () => unknown, boolean][] = [
    [`Gerar ${crowd.units.toLocaleString('pt-BR')}`, () => crowd.spawn(), true], ['Todos → leste', () => crowd.allEast(), false],
    ['Espalhar', () => crowd.scatter(), false], ['Gargalo', () => crowd.bottleneck(), true], ['Ordens de obra', () => crowd.work(), false],
  ]
  for (const [label, action, once] of actions) {
    const button = document.createElement('button'); button.textContent = label
    Object.assign(button.style, { padding: '10px 14px', border: '1px solid #bcc7b9', borderRadius: '6px', background: '#f6f8f1', color: '#233027', cursor: 'pointer' })
    button.addEventListener('click', () => { void action(); if (once) button.disabled = true }); bar.append(button)
  }
  document.body.append(bar)
}
