/** Ticks a sleeping unit waits at most before it looks again by itself. */
export const SLEEP_TICKS = 16

interface Entry { since: number; owner: number; tile: number; deadline: number }

/**
 * Units waiting in a queue behind another unit, asleep until that unit's cells change (`wakeOwner`), the world changes in
 * their tile (`wakeTile`), a deadline passes (`expire`) or something else wakes them. A sleeper costs nothing in the
 * executor; it keeps its body held. Decides future behaviour, so it is hashed; a save does not keep it.
 */
export class Sleepers {
  private readonly entries = new Map<number, Entry>()
  private readonly byOwner = new Map<number, Set<number>>()
  private readonly byTile = new Map<number, Set<number>>()
  get size(): number { return this.entries.size }
  sleep(id: number, now: number, owner: number, tile: number, deadline: number): void {
    this.wake(id)
    this.entries.set(id, { since: now, owner, tile, deadline })
    add(this.byOwner, owner, id); add(this.byTile, tile, id)
  }
  asleep(id: number): boolean { return this.entries.has(id) }
  /** Asleep since an earlier tick: the executor skips it this tick. The tick it falls asleep it still runs its second pass. */
  dozing(id: number, now: number): boolean { const e = this.entries.get(id); return e !== undefined && e.since < now }
  wake(id: number): void {
    const e = this.entries.get(id)
    if (!e) return
    this.entries.delete(id); remove(this.byOwner, e.owner, id); remove(this.byTile, e.tile, id)
  }
  wakeOwner(owner: number): void { const ids = this.byOwner.get(owner); if (ids) for (const id of [...ids]) this.wake(id) }
  wakeTile(tile: number): void { const ids = this.byTile.get(tile); if (ids) for (const id of [...ids]) this.wake(id) }
  wakeAll(): void { this.entries.clear(); this.byOwner.clear(); this.byTile.clear() }
  /** Wakes every sleeper whose deadline is now or past. */
  expire(now: number): void { for (const [id, e] of this.entries) if (e.deadline <= now) this.wake(id) }
  mixState(mix: (n: number) => void): void {
    mix(this.entries.size)
    for (const [id, e] of [...this.entries].sort((a, b) => a[0] - b[0])) { mix(id); mix(e.since); mix(e.owner); mix(e.tile); mix(e.deadline) }
  }
}
function add(map: Map<number, Set<number>>, key: number, id: number): void { let s = map.get(key); if (!s) { s = new Set(); map.set(key, s) }; s.add(id) }
function remove(map: Map<number, Set<number>>, key: number, id: number): void { const s = map.get(key); if (!s) return; s.delete(id); if (!s.size) map.delete(key) }
