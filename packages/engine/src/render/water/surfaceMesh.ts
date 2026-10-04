import { SUB } from '../../world/waterBuffers.ts'

/** Neighbours whose surfaces lie within this of each other share corners; a larger drop gets a curtain (spec §5: ~1 block). */
export const JOIN = SUB
/** Columns shallower than this (1/16 block, the mirror's threshold) are not drawn: thinner films would z-fight the ground. */
export const SHOW_MIN = 16
/** A column that is not drawn has its corners this far (blocks) under its ground, so a drying column sinks out of sight. */
export const SINK = 0.02
/** Below this speed (blocks per second) the ripples stand still… */
export const FLOW_STILL = 0.15
/** …below this they drift gently (1), above it steeply (2.5): 3a's two flow speeds. */
export const FLOW_STEEP = 1.5
/** Corner offsets, in the order (−x,−z) (+x,−z) (+x,+z) (−x,+z). */
export const CORNER_X: readonly number[] = [-1, 1, 1, -1]
export const CORNER_Z: readonly number[] = [-1, -1, 1, 1]
/** Curtain directions 0 +x, 1 −x, 2 +z, 3 −z: the neighbour's offset. */
export const DIR_X: readonly number[] = [1, -1, 0, 0]
export const DIR_Z: readonly number[] = [0, 0, 1, -1]
/** Per direction, the upper column's corners at the edge's ends A and B… */
export const CURTAIN_TOP: readonly (readonly [number, number])[] = [[1, 2], [3, 0], [2, 3], [0, 1]]
/** …and the lower neighbour's corners at the same ends. */
export const CURTAIN_BOTTOM: readonly (readonly [number, number])[] = [[0, 3], [2, 1], [1, 0], [3, 2]]

/** The level (1/SUB block) a published value stands for: a wet column's surface, a dry one's ground. */
export function level(v: number): number { return v >= 0 ? v : ~v }

/** Whether a column (published value v, floor `floor`) is drawn: wet and at least SHOW_MIN deep. */
export function shows(v: number, floor: number): boolean { return v >= 0 && v - floor * SUB >= SHOW_MIN }

/**
 * Corner heights (blocks) of column (x, z) of the published surfaces `s`, into out[o..o+3] (plan design notes: Rendering).
 * A drawn column's corner averages its surface with:
 * - the neighbours around that corner that are drawn within JOIN of it;
 * - the ground of neighbours that are not drawn but lie below it within JOIN (a film's edge thins to the ground).
 * Higher ground (walls) and drops beyond JOIN are left out. A column that is not drawn gets its ground minus SINK.
 * Returns whether the column is drawn.
 */
export function cornerHeights(s: Int32Array, floor: Int16Array, sx: number, sz: number, x: number, z: number, out: Float32Array, o: number): boolean {
  const c = x + z * sx, v = s[c]!
  if (!shows(v, floor[c]!)) {
    const g = level(v) / SUB - SINK
    out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = g
    return false
  }
  for (let k = 0; k < 4; k++) {
    const nx = x + CORNER_X[k]!, nz = z + CORNER_Z[k]!
    let sum = v, n = 1
    for (let m = 0; m < 3; m++) {
      const jx = m === 1 ? x : nx, jz = m === 0 ? z : nz
      if (jx < 0 || jz < 0 || jx >= sx || jz >= sz) continue
      const j = jx + jz * sx, w = s[j]!
      if (shows(w, floor[j]!)) {
        if (Math.abs(w - v) <= JOIN) { sum += w; n++ }
      } else {
        const g = level(w)
        if (g < v && v - g <= JOIN) { sum += g; n++ }
      }
    }
    out[o + k] = sum / n / SUB
  }
  return true
}

/** Whether edge c → j (j beside c) needs a curtain in `s`: c is drawn and stands more than JOIN above j's level. */
export function curtainAt(s: Int32Array, floor: Int16Array, c: number, j: number): boolean {
  return shows(s[c]!, floor[c]!) && s[c]! - level(s[j]!) > JOIN
}

/** Ripple flow for a column velocity (blocks per second) into out[o], out[o + 1]: 8 directions × still / 1 / 2.5. Returns the speed. */
export function quantizeFlow(vx: number, vz: number, out: Float32Array, o: number): number {
  const speed = Math.hypot(vx, vz)
  if (speed < FLOW_STILL) { out[o] = 0; out[o + 1] = 0; return speed }
  const dir = ((Math.round(Math.atan2(vz, vx) / (Math.PI / 4)) % 8) + 8) % 8
  const k = speed < FLOW_STEEP ? 1 : 2.5
  out[o] = Math.cos((dir * Math.PI) / 4) * k
  out[o + 1] = Math.sin((dir * Math.PI) / 4) * k
  return speed
}
