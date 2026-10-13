import { describe, expect, it } from 'vitest'
import type { Engine } from '@elovox/engine'
import { createLiving } from '../src/livingScript.ts'
import { createCrowd } from '../src/crowdScript.ts'

/** Just what the scripts touch: block ids, commands (all acked ok) and the 'workers' event. */
function fakeEngine() {
  const listeners = new Map<string, Set<(e: unknown) => void>>()
  const submitted: unknown[] = []
  let seq = 0
  const engine = {
    blocks: { id: () => 1 },
    workers: null,
    submit(cmd: unknown) { submitted.push(cmd); const s = ++seq; queueMicrotask(() => listeners.get('ack')?.forEach(f => f({ seq: s, ok: true }))); return s },
    on(type: string, fn: (e: unknown) => void) { let set = listeners.get(type); if (!set) { set = new Set(); listeners.set(type, set) } set.add(fn); return () => set!.delete(fn) },
  }
  return { engine: engine as unknown as Engine, submitted, listeners }
}

describe('scene scripts in a save', () => {
  it('living: restore takes the flags and resumes the quarry cycle without building the scene again', () => {
    const { engine, submitted, listeners } = fakeEngine()
    const living = createLiving(engine)
    expect(living.save()).toEqual({ started: false, breached: false, collapsed: false, groupAtRest: false })
    living.restore({ started: true, breached: true, collapsed: false, groupAtRest: true })
    expect(living.save()).toEqual({ started: true, breached: true, collapsed: false, groupAtRest: true })
    expect(living.started).toBe(true)
    expect(submitted).toEqual([])
    expect(listeners.get('workers')?.size).toBe(1)
  })
  it('living: a restored breach and start do not run twice', async () => {
    const { engine, submitted } = fakeEngine()
    const living = createLiving(engine)
    living.restore({ started: true, breached: true, collapsed: true, groupAtRest: false })
    await living.breach(); await living.collapse(); await living.startWork()
    expect(submitted).toEqual([])
  })
  it('crowd: keeps how many scatters ran', () => {
    const { engine } = fakeEngine()
    const crowd = createCrowd(engine, 10)
    expect(crowd.save()).toEqual({ scatters: 0 })
    crowd.restore({ scatters: 3 })
    expect(crowd.save()).toEqual({ scatters: 3 })
  })
})
