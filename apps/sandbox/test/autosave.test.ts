import { describe, expect, it } from 'vitest'
import { startAutosave } from '../src/autosave.ts'

function fakeClock() {
  let fn: (() => void) | null = null, ms = 0
  return { clock: { setInterval: (f: () => void, every: number) => { fn = f; ms = every; return 1 }, clearInterval: () => { fn = null } }, fire: () => fn?.(), interval: () => ms }
}
const flush = () => new Promise(r => setTimeout(r, 0))

describe('autosave', () => {
  it('runs every 5 minutes by default and rotates between the two slots', async () => {
    const { clock, fire, interval } = fakeClock(), slots: string[] = []
    startAutosave(async s => { slots.push(s) }, { clock })
    expect(interval()).toBe(300_000)
    fire(); await flush(); fire(); await flush(); fire(); await flush()
    expect(slots).toEqual(['autosave-1', 'autosave-2', 'autosave-1'])
  })
  it('skips while blocked, while a save runs, and when disabled', async () => {
    const { clock, fire } = fakeClock(), slots: string[] = []
    let blocked = true, release!: () => void
    const a = startAutosave(s => { slots.push(s); return new Promise<void>(r => { release = r }) }, { clock, blocked: () => blocked })
    fire(); expect(slots).toEqual([])
    blocked = false; fire(); fire()
    expect(slots).toEqual(['autosave-1'])
    release(); await flush()
    a.enabled = false; fire()
    expect(slots).toEqual(['autosave-1'])
  })
  it('a failed autosave does not stop the next one', async () => {
    const { clock, fire } = fakeClock(), results: string[] = []
    let n = 0
    startAutosave(async () => { if (n++ === 0) throw new Error('quota') }, { clock, onResult: (s, _r, e) => results.push(`${s}:${e ? 'fail' : 'ok'}`) })
    fire(); await flush(); fire(); await flush()
    expect(results).toEqual(['autosave-1:fail', 'autosave-2:ok'])
  })
  it('stop() ends the timer', () => {
    const { clock, fire } = fakeClock(), slots: string[] = []
    startAutosave(async s => { slots.push(s) }, { clock }).stop()
    fire()
    expect(slots).toEqual([])
  })
})
