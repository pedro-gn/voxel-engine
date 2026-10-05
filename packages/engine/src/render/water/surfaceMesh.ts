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
/** Gravity (blocks/s², one block a metre) of the Froude number speed / √(g · depth) white water is measured by. */
export const GRAVITY = 9.8
/** Depths are counted as at least this (blocks) in the Froude number: thinner films are not faster for it. */
export const FROUDE_MIN_DEPTH = 1 / 8
/**
 * A surface whitens past this Froude number, one level (of 15) per unit: well past the hydraulic-jump range, so a steep
 * steady stream (the flood river: Fr 3–6) stays clear and only its shallow fast lips (Fr ~11) get a light edge.
 */
export const WHITE_FROUDE = 7.5
/** A sheet running onto dry ground (a bore) whitens past this Froude number, 3 levels per unit: a breaking jump's start. */
export const BORE_FROUDE = 1.7

/** speed (blocks/s) / √(GRAVITY × depth (blocks, at least FROUDE_MIN_DEPTH)). */
export function froude(speed: number, depth: number): number {
  return speed / Math.sqrt(GRAVITY * Math.max(depth, FROUDE_MIN_DEPTH))
}

/** White water (0–15) of a surface at Froude number fr. */
export function surfaceWhite(fr: number): number {
  return fr > WHITE_FROUDE ? Math.min(15, Math.round(fr - WHITE_FROUDE)) : 0
}

/** White water (0–15) of a front running onto dry ground at Froude number fr. */
export function boreWhite(fr: number): number {
  return fr > BORE_FROUDE ? Math.min(15, Math.round((fr - BORE_FROUDE) * 3)) : 0
}

/** Corner offsets, in the order (−x,−z) (+x,−z) (+x,+z) (−x,+z). */
export const CORNER_X: readonly number[] = [-1, 1, 1, -1]
export const CORNER_Z: readonly number[] = [-1, -1, 1, 1]
/** Curtain directions 0 +x, 1 −x, 2 +z, 3 −z: the neighbour's offset. */
export const DIR_X: readonly number[] = [1, -1, 0, 0]
export const DIR_Z: readonly number[] = [0, 0, 1, -1]
/**
 * Per direction and end (A, B): the offset (x, z) to the column beside the curtain's column on that end's side. A curtain
 * there through the same side shares that end (layArc runs once for both: no seam between them).
 */
export const END_X: readonly (readonly [number, number])[] = [[0, 0], [0, 0], [1, -1], [-1, 1]]
export const END_Z: readonly (readonly [number, number])[] = [[-1, 1], [1, -1], [0, 0], [0, 0]]
/** Per direction, the upper column's corners at the edge's ends A and B… */
export const CURTAIN_TOP: readonly (readonly [number, number])[] = [[1, 2], [3, 0], [2, 3], [0, 1]]
/** …and the lower neighbour's corners at the same ends. */
export const CURTAIN_BOTTOM: readonly (readonly [number, number])[] = [[0, 3], [2, 1], [1, 0], [3, 2]]

/**
 * Waterfall curtains are ballistic arcs. A curtain's end leaves its edge level at the exit speed v = exitSpeed(flux) and
 * falls under ARC_GRAVITY: it would come down `drop` blocks at v · √(2 drop / g) in front of its wall (layArc finds where
 * over the ground ahead). The exit speed compresses the flow (its square root), calibrated on the flood scene's measured
 * curtains (flux in 1/SUB block per step at 20 steps per second; reach over flat ground):
 *
 * | flow                         | flux | drop (blocks) | reach (blocks) |
 * |------------------------------|------|---------------|----------------|
 * | a trickle                    |    8 |             4 |           0.22 |
 * | one removed dam block        |  110 |            15 |           1.61 |
 * | the 10-wide breach           |  210 |            14 |           2.14 |
 * | a dam column (the most seen) |  480 |            12 |           3.00 |
 *
 * so a small flow trickles close to its wall, a big one arcs out, and ARC_REACH is only a guard.
 */
export const ARC_GRAVITY = 20
/** The farthest (blocks) a curtain lands from its wall: a guard, so the arc never reaches into geometry farther away. */
export const ARC_REACH = 3
/** The least distance (blocks) a curtain hangs in front of its wall's plane below its top, even with no flow. */
export const ARC_GAP = 1 / 16
/** Segments of a curtain's strip, evenly spaced in fall time. */
export const ARC_SEGMENTS = 8
/** Columns a curtain may cross or land on along its side: its neighbour (0), then up to ARC_REACH + ARC_GAP more. */
export const ARC_COLUMNS = 1 + Math.floor(ARC_REACH + ARC_GAP)
/** The discharge (blocks² per second through a one-block edge) that leaves at 1 block/s (see exitSpeed). */
const EXIT_DISCHARGE = 5

/**
 * Exit speed (blocks/s) of the water pouring over an edge that moves `flux` (1/SUB block per step through its one-block
 * width) at `stepHz` steps per second: √(q / EXIT_DISCHARGE) with q = flux · stepHz / SUB the discharge, i.e. 0.125 · √flux
 * at 20 steps per second (see ARC_GRAVITY for the calibration). The upper column's depth is no help: the outflow limiter
 * drains a brink column every step, so flux / depth sits at one column per step whatever the flow.
 */
export function exitSpeed(flux: number, stepHz: number): number {
  return Math.sqrt((Math.max(0, flux) * stepHz) / SUB / EXIT_DISCHARGE)
}

/**
 * Lays one end of a curtain, at exit speed v from height `top`, over the columns along its side: `levels[i]` the level
 * (blocks) of column i past the edge (0 the neighbour; Infinity outside the world), `near[i]`, `far[i]` that column's
 * height at the end's line on its sides nearer to and farther from the wall. Writes out[0] the reach (the end lands at
 * u = ARC_GAP + reach in front of the wall's plane) and out[1] the foot: the landing column's height there, mixed from
 * near to far.
 * - The free arc lands in the first column whose level it comes down to before that column's far face. A column standing
 *   at or above the arc where it enters (a wall, a bank, the world's border) stops it at the far side of the one before.
 * - The arc as drawn (arcPoint, from `top` down to the landing's foot) is then checked at each face it crosses: it must
 *   clear the levels on both sides (the landing column's down to its foot). Where it does not, it lands at the far side of
 *   the column before that face instead, and is checked again. So no drawn point lies below the column under it.
 */
export function layArc(v: number, top: number, levels: ArrayLike<number>, near: ArrayLike<number>, far: ArrayLike<number>, out: Float64Array): void {
  let r = 0
  if (v > 0) {
    r = ARC_REACH
    for (let i = 0; i < ARC_COLUMNS; i++) {
      const l = levels[i]!
      if (l >= top) { r = i - 2 * ARC_GAP; break }
      const d = v * Math.sqrt((2 * (top - l)) / ARC_GRAVITY) // where the free arc comes down to l
      if (d < i - ARC_GAP) { r = i - 2 * ARC_GAP; break } // already below l at the column's near face: it is in the way
      if (d < i + 1 - ARC_GAP) { r = d; break }
    }
    r = Math.max(0, Math.min(ARC_REACH, r))
  }
  for (;;) {
    const u = ARC_GAP + r, k = Math.min(ARC_COLUMNS - 1, Math.floor(u)), f = u - k
    const foot = near[k]! + (far[k]! - near[k]!) * f
    out[0] = r
    out[1] = foot
    let bad = 0
    for (let m = 1; m <= k && bad === 0; m++) {
      const s = (m - ARC_GAP) / r, y = top - (top - foot) * s * s
      if (y < Math.max(levels[m - 1]!, m < k ? levels[m]! : Math.min(levels[m]!, foot))) bad = m
    }
    if (bad === 0) return
    r = bad - 2 * ARC_GAP
  }
}

/**
 * The point at fall fraction s (0–1, in time) of a curtain from `top` to `foot` (blocks) with reach r, into out[o] (distance
 * in front of the wall's plane) and out[o + 1] (height): u = r · s (+ ARC_GAP below the top), y = top − (top − foot) · s².
 * A ballistic arc, parted evenly in time: it leaves the edge level and lands at u = ARC_GAP + r on the foot. The curtain
 * vertex shader (waterVertex.ts) lays its strip by the same formula.
 */
export function arcPoint(top: number, foot: number, r: number, s: number, out: Float64Array, o: number): void {
  out[o] = r * s + ARC_GAP * Math.min(1, s * ARC_SEGMENTS)
  out[o + 1] = top - (top - foot) * s * s
}

/**
 * A curtain has a body: behind the arc (the front face) lies a back face, `thick` blocks nearer the wall at the same height
 * (backPoint), and at the curtain's free ends the two are joined by side faces. The thickness grows with the exit speed (so
 * with the square root of the flux): about 0.1 block for a trickle, 0.37 for one removed dam block, BODY_MAX from a flux of
 * about 200. The back face is clamped to ARC_GAP · min(1, 8 s) in front of the wall's plane (the arc's own gap), so the body
 * starts at the edge and never reaches the wall it pours from; a fall with no reach has no body to speak of.
 */
export const BODY_PER_SPEED = 0.28
export const BODY_MIN = 0.04
export const BODY_MAX = 0.5
/** While falling, a free end of a curtain widens sideways by flare · s (s the fall fraction), at most FLARE_MAX at the foot. */
export const FLARE_MAX = 0.5
/** The splash at a curtain's foot spans ± min(SPLASH_MAX, SPLASH_PER_SPEED · the end's exit speed) blocks along the fall… */
export const SPLASH_MAX = 0.75
export const SPLASH_PER_SPEED = 0.56
/** …and lies this far (blocks) above the water it lands on. */
export const SPLASH_LIFT = 0.02
/** Candidate thicknesses are tried this far inside the limits that bound them (the ground tests are exact). */
const BODY_EPS = 1e-7

/** The thickness (blocks) of a curtain thrown at exit speed v: 0 with no flow. */
export function bodyThickness(v: number): number {
  return v > 0 ? Math.min(BODY_MAX, Math.max(BODY_MIN, BODY_PER_SPEED * v)) : 0
}

/** The splash's half extent (blocks) at a curtain's foot for an exit speed (blocks/s) of its end. */
export function splashHalf(speed: number): number {
  return Math.min(SPLASH_MAX, SPLASH_PER_SPEED * Math.max(0, speed))
}

/** The flare is full when the arc clears the ground beside its end by this much (blocks), and fades out to none at 0. */
export const FLARE_FADE = 0.5
/** An end's flare is stored in one float: round(open × 255) + amount (blocks, below 1): see flareCode. */
export const FLARE_OPEN_STEPS = 255

/**
 * The stored flare of a curtain end in a step: `open` (0–1) is how far the end is a free one, with a side face, and `amount`
 * (0 ≤ amount < 1, blocks) how far it widens sideways at the foot. An end shared with the curtain beside it is open 0 (an
 * amount of 0 at rest), a free one open 1; the two mix independently while a curtain moves from one to the other, so
 * neither jumps (SurfaceView carry).
 */
export function flareCode(open: number, amount: number): number {
  return Math.round(Math.min(1, Math.max(0, open)) * FLARE_OPEN_STEPS) + Math.min(0.999, Math.max(0, amount))
}
/** The openness (0–1) of a stored flare. */
export function flareOpen(code: number): number { return Math.floor(code) / FLARE_OPEN_STEPS }
/** The widening (blocks) of a stored flare. */
export function flareAmount(code: number): number { return code - Math.floor(code) }

/** The splash ± half extent, in 1/SPLASH_UNITS (it stores in 4 bits)… */
export const SPLASH_UNITS = 16
/** …and the water surface's slope along the fall in 1/SLOPE_UNITS block per block (a signed 4 bits). */
export const SLOPE_UNITS = 8
/**
 * An end's splash in one byte: its half extent (blocks) and the slope of the water it lands on along the fall (blocks per
 * block, how much higher the landing column's far side is than its near side), so the splash lies on that surface.
 */
export function splashCode(half: number, slope: number): number {
  const h = Math.min(SPLASH_UNITS - 1, Math.round(Math.max(0, half) * SPLASH_UNITS))
  const s = Math.min(7, Math.max(-8, Math.round(slope * SLOPE_UNITS)))
  return h + 16 * (s & 15)
}
export function splashHalfOf(code: number): number { return (code & 15) / SPLASH_UNITS }
export function splashSlopeOf(code: number): number { const s = code >> 4; return (s >= 8 ? s - 16 : s) / SLOPE_UNITS }
/** A curtain's info.w: its flux (below 256: every effect of it has saturated by then) and its ends' splash bytes. */
export function packFlux(flux: number, codeA: number, codeB: number): number {
  return Math.min(255, Math.max(0, Math.round(flux))) + 256 * (codeA + 256 * codeB)
}
export function fluxOf(packed: number): number { return packed % 256 }
export function splashOf(packed: number, end: number): number { return Math.floor(packed / (end === 0 ? 256 : 65536)) % 256 }

/**
 * The point at fall fraction s of the back face of a curtain from `top` to `foot` with reach r and thickness `thick`: the arc
 * (arcPoint) moved `thick` toward the wall, but never nearer to the wall's plane than the arc's own ARC_GAP, into out[o]
 * (distance in front of the plane) and out[o + 1] (height). The curtain vertex shader lays its back face by the same formula.
 */
export function backPoint(top: number, foot: number, r: number, thick: number, s: number, out: Float64Array, o: number): void {
  arcPoint(top, foot, r, s, out, o)
  out[o] = Math.max(out[o]! - thick, ARC_GAP * Math.min(1, s * ARC_SEGMENTS))
}

/**
 * How far (blocks) the back face of a curtain (backPoint, thickness `thick`; 0 is the arc itself) clears the ground `bed[i]`
 * (blocks) of the columns it is over (0 the column past the wall's plane), from `top` down to `foot` with reach r: the least
 * height it has over any of them, negative where it lies under one. The back face descends as it goes out, so its lowest
 * point over a column is where it leaves it, and over the last the foot.
 */
export function bodyMargin(bed: ArrayLike<number>, top: number, foot: number, r: number, thick: number): number {
  const end = Math.max(ARC_GAP + r - thick, ARC_GAP), last = Math.min(bed.length - 1, Math.floor(end)), drop = top - foot
  let margin = foot - bed[last]!
  for (let m = 1; m <= last; m++) {
    const s = (m + thick - ARC_GAP) / r // where the back face crosses the face between columns m − 1 and m
    margin = Math.min(margin, top - drop * s * s - bed[m - 1]!)
  }
  return margin
}

/**
 * How far (blocks) a free end's arc and body clear the ground `flank[i]` of the row beside it, for its flare: like bodyMargin,
 * but only ground above the foot is an obstacle (a dry or shallow flank, level with the foot, is not), and the landing point
 * counts as clear by its distance to the face of the next column whose ground is above the foot, so the flare fades out
 * before the landing steps onto higher ground instead of flipping off.
 */
export function flareMargin(flank: ArrayLike<number>, top: number, foot: number, r: number, thick: number): number {
  const end = Math.max(ARC_GAP + r - thick, ARC_GAP), last = Math.min(flank.length - 1, Math.floor(end)), drop = top - foot
  let margin = flank[last]! > foot ? foot - flank[last]! : Infinity
  for (let m = 1; m <= last; m++) {
    const s = (m + thick - ARC_GAP) / r
    margin = Math.min(margin, top - drop * s * s - flank[m - 1]!)
  }
  const u = ARC_GAP + r, k = Math.min(flank.length - 1, Math.floor(u))
  if (k + 1 < flank.length && flank[k + 1]! > foot) margin = Math.min(margin, k + 1 - u)
  return margin
}

/** Whether the back face lies on or above the ground of every column it is over (bodyMargin is not negative). */
export function bodyClears(bed: ArrayLike<number>, top: number, foot: number, r: number, thick: number): boolean {
  return bodyMargin(bed, top, foot, r, thick) >= 0
}

/**
 * The thickness of a curtain end's body: the largest not above `want` for which its back face clears the ground `bed` (see
 * bodyClears). The front arc clears it (layArc), so 0 always does. The limits that bound a thickness are the foot's column
 * changing and the back face reaching a column's far face; the candidates are those, just inside, and `want`.
 */
export function layBody(want: number, top: number, foot: number, r: number, bed: ArrayLike<number>): number {
  if (want <= 0) return 0
  if (bodyClears(bed, top, foot, r, want)) return want
  const end = ARC_GAP + r, drop = top - foot, candidates: number[] = []
  for (let m = 0; m <= bed.length; m++) {
    candidates.push(end - m - BODY_EPS, end - m + BODY_EPS)
    const b = m > 0 ? bed[m - 1]! : Infinity
    if (r > 0 && drop > 0 && b < top) candidates.push(r * Math.sqrt(Math.min(1, (top - b) / drop)) - m + ARC_GAP - BODY_EPS)
  }
  candidates.sort((a, b) => b - a)
  for (const t of candidates) if (t > 0 && t < want && bodyClears(bed, top, foot, r, t)) return t
  return 0
}

/** The level (1/SUB block) a published value stands for: a wet column's surface, a dry one's ground. */
export function level(v: number): number { return v >= 0 ? v : ~v }

/** Whether a column (published value v, floor `floor`) is drawn: wet and at least SHOW_MIN deep. */
export function shows(v: number, floor: number): boolean { return v >= 0 && v - floor * SUB >= SHOW_MIN }

/** The effective value of a column outside the world: never drawn, and its "ground" lies above everything. */
export const OUTSIDE = -0x80000000

/**
 * A column's effective value for corners and curtains: its surface S (≥ 0) when drawn, ~level (< 0) when not. Unlike the
 * published value, a wet column too shallow to draw counts as ground, at its surface.
 */
export function effective(v: number, floor: number): number { return shows(v, floor) ? v : v >= 0 ? ~v : v }

const vVal = new Float64Array(4)
const vKind = new Int8Array(4) // 0 outside the world, 1 not drawn (its ground counts), 2 drawn (its surface counts)
const vGroup = new Int8Array(4)

/** Whether two of a vertex's columns join: two drawn surfaces within JOIN, or a drawn surface and a ground below it within JOIN. */
function joins(a: number, b: number): boolean {
  const ka = vKind[a]!, kb = vKind[b]!, va = vVal[a]!, vb = vVal[b]!
  if (ka === 2 && kb === 2) return Math.abs(va - vb) <= JOIN
  if (ka === 2 && kb === 1) return vb < va && va - vb <= JOIN
  if (ka === 1 && kb === 2) return va < vb && vb - va <= JOIN
  return false
}

/**
 * Heights (blocks) at one vertex for the four columns around it, given their effective values (`effective`, or OUTSIDE)
 * e0 (−x,−z) e1 (+x,−z) e2 (−x,+z) e3 (+x,+z), into out[o + q] for column q; columns outside are left alone (plan design
 * notes: Rendering). The columns are grouped by single linkage, where:
 * - two drawn columns join when their surfaces lie within JOIN;
 * - a drawn column joins the ground of an undrawn one that lies below it within JOIN (a film's edge thins to the ground).
 * Each drawn column gets its group's average, so every column of a group (in particular two neighbours whose surfaces lie
 * within JOIN) shares the vertex. Higher ground (walls) and drops beyond JOIN stay apart; curtains hang there. A column that
 * is not drawn gets its ground minus SINK.
 * Returns whether the vertex is smooth: four drawn columns within JOIN of each other, so no curtain hangs between them.
 */
export function vertexShares(e0: number, e1: number, e2: number, e3: number, out: Float32Array, o: number): boolean {
  if (e0 >= 0 && e1 >= 0 && e2 >= 0 && e3 >= 0) { // the common case, inside a lake or a river
    const lo01 = e0 < e1 ? e0 : e1, hi01 = e0 < e1 ? e1 : e0, lo23 = e2 < e3 ? e2 : e3, hi23 = e2 < e3 ? e3 : e2
    if ((hi01 > hi23 ? hi01 : hi23) - (lo01 < lo23 ? lo01 : lo23) <= JOIN) {
      const h = (e0 + e1 + e2 + e3) * (1 / (4 * SUB)) // a power of two: exact
      out[o] = h; out[o + 1] = h; out[o + 2] = h; out[o + 3] = h
      return true
    }
  }
  vVal[0] = e0; vVal[1] = e1; vVal[2] = e2; vVal[3] = e3
  let drawn = 0
  for (let q = 0; q < 4; q++) {
    const w = vVal[q]!
    if (w === OUTSIDE) { vKind[q] = 0; continue }
    if (w >= 0) { vKind[q] = 2; drawn++; continue }
    vKind[q] = 1
    vVal[q] = ~w
    out[o + q] = ~w / SUB - SINK
  }
  if (drawn === 0) return false
  for (let q = 0; q < 4; q++) vGroup[q] = q
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
    const ga = vGroup[a]!, gb = vGroup[b]!
    if (ga !== gb && joins(a, b)) for (let q = 0; q < 4; q++) if (vGroup[q] === gb) vGroup[q] = ga
  }
  for (let q = 0; q < 4; q++) {
    if (vKind[q] !== 2) continue
    let gs = 0, n = 0
    for (let m = 0; m < 4; m++) if (vKind[m] !== 0 && vGroup[m] === vGroup[q]) { gs += vVal[m]!; n++ }
    out[o + q] = gs / n / SUB
  }
  return false
}

/** Effective value of column (x, z) of `s`, or OUTSIDE. */
function at(s: Int32Array, floor: Int16Array, sx: number, sz: number, x: number, z: number): number {
  if (x < 0 || z < 0 || x >= sx || z >= sz) return OUTSIDE
  const j = x + z * sx
  return effective(s[j]!, floor[j]!)
}

/** vertexShares at vertex (vx, vz) of the published surfaces `s`: out[o + q] for column (vx − 1 + (q & 1), vz − 1 + (q >> 1)). */
export function vertexHeights(s: Int32Array, floor: Int16Array, sx: number, sz: number, vx: number, vz: number, out: Float32Array, o: number): boolean {
  return vertexShares(
    at(s, floor, sx, sz, vx - 1, vz - 1), at(s, floor, sx, sz, vx, vz - 1),
    at(s, floor, sx, sz, vx - 1, vz), at(s, floor, sx, sz, vx, vz), out, o,
  )
}

const vertex = new Float32Array(4)

/**
 * Corner heights (blocks) of column (x, z) of the published surfaces `s`, into out[o..o+3], in the order (−x,−z) (+x,−z)
 * (+x,+z) (−x,+z): its share of each of its four vertices (vertexHeights). Returns whether the column is drawn.
 */
export function cornerHeights(s: Int32Array, floor: Int16Array, sx: number, sz: number, x: number, z: number, out: Float32Array, o: number): boolean {
  const c = x + z * sx, v = s[c]!
  if (!shows(v, floor[c]!)) {
    const g = level(v) / SUB - SINK
    out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = g
    return false
  }
  vertexHeights(s, floor, sx, sz, x, z, vertex, 0); out[o] = vertex[3]!
  vertexHeights(s, floor, sx, sz, x + 1, z, vertex, 0); out[o + 1] = vertex[2]!
  vertexHeights(s, floor, sx, sz, x + 1, z + 1, vertex, 0); out[o + 2] = vertex[0]!
  vertexHeights(s, floor, sx, sz, x, z + 1, vertex, 0); out[o + 3] = vertex[1]!
  return true
}

/** Whether edge c → j (j beside c) needs a curtain in `s`: c is drawn and stands more than JOIN above j's level. */
export function curtainAt(s: Int32Array, floor: Int16Array, c: number, j: number): boolean {
  return shows(s[c]!, floor[c]!) && s[c]! - level(s[j]!) > JOIN
}

/** tan(22.5°): the octant borders around the axes. */
const TAN_8 = Math.tan(Math.PI / 8)
/** The 16 moving flows, (x, z) per direction (0 = +x, counter-clockwise from +x toward +z by 45°) × gentle (1) / steep (2.5). */
const FLOWS = new Float64Array(32)
for (let dir = 0; dir < 8; dir++) for (let s = 0; s < 2; s++) {
  const k = s === 0 ? 1 : 2.5, o = (dir * 2 + s) * 2
  FLOWS[o] = Math.cos((dir * Math.PI) / 4) * k
  FLOWS[o + 1] = Math.sin((dir * Math.PI) / 4) * k
}

/** Ripple flow for a column velocity (blocks per second) into out[o], out[o + 1]: 8 directions × still / 1 / 2.5. Returns the speed. */
export function quantizeFlow(vx: number, vz: number, out: Float32Array, o: number): number {
  const speed = Math.sqrt(vx * vx + vz * vz)
  if (speed < FLOW_STILL) { out[o] = 0; out[o + 1] = 0; return speed }
  const ax = Math.abs(vx), az = Math.abs(vz)
  const dir = az <= ax * TAN_8 ? (vx > 0 ? 0 : 4)
    : ax <= az * TAN_8 ? (vz > 0 ? 2 : 6)
    : vx > 0 ? (vz > 0 ? 1 : 7) : (vz > 0 ? 3 : 5)
  const f = (dir * 2 + (speed < FLOW_STEEP ? 0 : 1)) * 2
  out[o] = FLOWS[f]!
  out[o + 1] = FLOWS[f + 1]!
  return speed
}
