/** The sim's tick length, the playback delay behind the newest tick (one tick plus a jitter margin) and the ticks kept. */
export const TICK_MS = 50, DELAY_MS = 75, HISTORY = 4
/** Pose stride of a worker publication: [id, x256, y256, z256, facing, state, order, progress, duration]. */
const STRIDE = 9

interface Publication { tick: number; poses: Int32Array; at: Map<number, number> }

/**
 * Plays unit poses back on sim time (tick × TICK_MS) instead of message arrival time, so drawn speed does not follow
 * message jitter and no tick is skipped. The clock offset is the lower envelope of `receivedAt - tick × TICK_MS`: an
 * earlier message pulls it down at once, a later one lifts it by at most 1 ms, so one late message does not stretch time.
 * A late sim holds units at the newest pose (nothing is extrapolated); when it comes back, the offset rises by how far
 * playback ran past that pose, so units resume from where they stood instead of stepping a tick per message.
 */
export class PoseTimeline {
  private readonly history: Publication[] = []
  private smoothed = Number.NaN

  /** The smoothed offset between wall clock and sim time (ms). */
  get offset(): number { return this.smoothed }

  /** Records a publication: its tick, poses (stride 9) and wall-clock receipt time. */
  push(tick: number, poses: Int32Array, receivedAt: number): void {
    const h = this.history, lag = receivedAt - tick * TICK_MS
    // A tick that goes back means the sim started over: so does the playback.
    if (h.length && tick <= h.at(-1)!.tick) h.length = 0
    if (!h.length) this.smoothed = lag
    else {
      const overrun = receivedAt - this.smoothed - DELAY_MS - h.at(-1)!.tick * TICK_MS
      this.smoothed = Math.min(lag, this.smoothed + Math.max(1, overrun))
    }
    const at = new Map<number, number>()
    for (let i = 0; i < poses.length; i += STRIDE) at.set(poses[i]!, i)
    h.push({ tick, poses, at })
    if (h.length > HISTORY) h.shift()
  }

  /**
   * Positions in blocks at wall-clock `now`, interpolated between the two ticks around now - offset - DELAY_MS; ids not
   * present in the newest tick are dropped. Facing comes from the later tick.
   */
  sample(now: number, out: Map<number, { x: number; y: number; z: number; facing: number }>): void {
    const h = this.history, newest = h.at(-1)
    if (!newest) { out.clear(); return }
    const tick = (now - this.smoothed - DELAY_MS) / TICK_MS
    let b = h.findIndex(p => p.tick >= tick), a = b - 1
    if (b < 0) a = b = h.length - 1
    else if (b === 0) a = 0
    const pa = h[a]!, pb = h[b]!, t = b === a ? 1 : (tick - pa.tick) / (pb.tick - pa.tick)
    for (const id of out.keys()) if (!newest.at.has(id)) out.delete(id)
    for (const id of newest.at.keys()) {
      let later = pb, j = pb.at.get(id)
      // A unit that appears after the later tick shows at its first pose.
      for (let k = b + 1; j === undefined; k++) { later = h[k]!; j = later.at.get(id) }
      const p = later.poses, i = later === pb ? pa.at.get(id) : undefined, q = i === undefined ? p : pa.poses, s = i ?? j
      const lerp = (k: number) => (q[s + k]! + (p[j + k]! - q[s + k]!) * t) / 256
      const x = lerp(1), y = lerp(2), z = lerp(3), o = out.get(id)
      if (o) { o.x = x; o.y = y; o.z = z; o.facing = p[j + 4]! } else out.set(id, { x, y, z, facing: p[j + 4]! })
    }
  }
}
