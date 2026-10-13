/** Two slots in turn: an autosave that dies midway leaves the other one intact. */
export const AUTOSAVE_SLOTS = ['autosave-1', 'autosave-2'] as const

export interface AutosaveClock { setInterval(fn: () => void, ms: number): unknown; clearInterval(h: unknown): void }
export interface Autosave { enabled: boolean; readonly lastSlot: string | null; stop(): void }

const realClock: AutosaveClock = { setInterval: (f, ms) => setInterval(f, ms), clearInterval: h => clearInterval(h as ReturnType<typeof setInterval>) }

/**
 * Every `intervalMs` (default 5 minutes) saves to the autosave slot not written last. Skips a turn while `blocked()` (the
 * terrain editor is open), while the previous autosave still runs, or while disabled.
 */
export function startAutosave(save: (slot: string) => Promise<unknown>, o: { intervalMs?: number; blocked?: () => boolean; clock?: AutosaveClock; onResult?: (slot: string, r: unknown, err?: unknown) => void } = {}): Autosave {
  const clock = o.clock ?? realClock
  let running = false, turn = 0, lastSlot: string | null = null
  const handle = clock.setInterval(() => {
    if (!state.enabled || running || o.blocked?.()) return
    const slot = AUTOSAVE_SLOTS[turn++ % AUTOSAVE_SLOTS.length]!
    running = true
    save(slot).then(r => { lastSlot = slot; o.onResult?.(slot, r) }, e => o.onResult?.(slot, undefined, e)).finally(() => { running = false })
  }, o.intervalMs ?? 300_000)
  const state: Autosave = {
    enabled: true,
    get lastSlot() { return lastSlot },
    stop: () => clock.clearInterval(handle),
  }
  return state
}
