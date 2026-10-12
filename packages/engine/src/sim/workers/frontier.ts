/** Ticks without progress per point of aging (5 s), and the most an order can gain by waiting. */
export const AGE_TICKS = 100, AGE_CAP = 64

/** An order's priority plus one point per AGE_TICKS since it last progressed, capped at AGE_CAP. */
export const effectivePriority = (priority: number, idleSince: number, now: number): number => priority + Math.min(AGE_CAP, Math.floor((now - idleSince) / AGE_TICKS))

/** Ticks without an eligible worker after which an order's frontier tasks may be parked. */
export const NO_CREW_TICKS = 100

/**
 * Frontier slots per order id: every order first gets min(min, open), then the rest goes in proportion to weight, never
 * beyond open (the cells it can hold in the frontier). Leftovers go by weight, ties to the lower id. When the floors
 * alone exceed the slots, they go to the heaviest orders first. The sum never exceeds slots.
 */
export function shares(orders: readonly { id: number; weight: number; open: number }[], slots: number, min = 8): Map<number, number> {
  const out = new Map<number, number>(), ranked = [...orders].sort((a, b) => b.weight - a.weight || a.id - b.id)
  let left = slots
  for (const o of ranked) { const n = Math.min(min, o.open, left); out.set(o.id, n); left -= n }
  // Water-filling: orders whose proportional extra would exceed their room take all of it, and the rest is shared again.
  let free = ranked.filter(o => o.open > out.get(o.id)!)
  for (let capped = true; capped && left > 0 && free.length;) {
    capped = false
    const even = free.every(o => o.weight === 0), weight = (o: { weight: number }) => even ? 1 : o.weight
    let total = 0
    for (const o of free) total += weight(o)
    for (const o of free) {
      const room = o.open - out.get(o.id)!
      if (left * weight(o) >= room * total) { out.set(o.id, o.open); capped = true }
    }
    if (capped) { left = slots - [...out.values()].reduce((a, b) => a + b, 0); free = free.filter(o => o.open > out.get(o.id)!); continue }
    let given = 0
    for (const o of free) { const n = Math.floor(left * weight(o) / total); out.set(o.id, out.get(o.id)! + n); given += n }
    left -= given
    for (const o of free) if (left > 0) { out.set(o.id, out.get(o.id)! + 1); left-- }
  }
  return out
}

/** The task to park first: unclaimed and parkable, lowest priority, then oldest, then lowest cell; -1 when none. */
export function parkChoice(tasks: readonly { i: number; priority: number; added: number; claimed: boolean; parkable: boolean }[]): number {
  let best = -1
  for (let k = 0; k < tasks.length; k++) {
    const t = tasks[k]!
    if (t.claimed || !t.parkable) continue
    const b = tasks[best]
    if (!b || t.priority < b.priority || t.priority === b.priority && (t.added < b.added || t.added === b.added && t.i < b.i)) best = k
  }
  return best
}
