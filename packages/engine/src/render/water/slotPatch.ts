import { RANKS } from '../../sim/water/constants.ts'
import { LINK_WALL } from '../../sim/water/links.ts'
import { SUB } from '../../world/waterBuffers.ts'
import { DIR_X, DIR_Z, OUTSIDE, effective, level } from './surfaceMesh.ts'

/** What patch reads: every slot's published water (rank 0: the dense view's) and the links between slots. */
export interface SlotSource {
  readonly sx: number
  readonly sz: number
  /** Encoded surface of slot (c, r) at the previous step (cur false) or the current one. */
  value(c: number, r: number, cur: boolean): number
  floor(c: number, r: number): number
  ceil(c: number, r: number): number
  link(c: number, r: number, dir: number): number
}

/**
 * The last resolve(): the neighbour slot (column, rank; both −1 for ground, a wall or outside), its effective value and its
 * floor (blocks; 0 when there is no slot: only a drawn slot's floor counts, see vertexShares).
 */
export const hit = { c: -1, r: -1, e: 0, f: 0 }

/** The neighbour of slot (x, z, r) through side dir (0 +x, 1 −x, 2 +z, 3 −z), through its link, into `hit`. */
export function resolve(src: SlotSource, x: number, z: number, r: number, dir: number, cur: boolean): void {
  const nx = x + DIR_X[dir]!, nz = z + DIR_Z[dir]!
  if (nx < 0 || nz < 0 || nx >= src.sx || nz >= src.sz) { hit.c = -1; hit.r = -1; hit.e = OUTSIDE; hit.f = 0; return }
  const c = x + z * src.sx, l = src.link(c, r, dir)
  if (l < RANKS) {
    const nc = nx + nz * src.sx
    const f = src.floor(nc, l)
    hit.c = nc; hit.r = l; hit.e = effective(src.value(nc, l, cur), f); hit.f = f
    return
  }
  hit.c = -1; hit.r = -1; hit.f = 0
  hit.e = l === LINK_WALL ? ~(src.ceil(c, r) * SUB) : ~((l & 0x7fff) * SUB)
}

/**
 * A diagonal: from side slot a through side dir da, else from side slot b through db, else the higher ground of the two sides.
 * Its floor is left in hit.f (0 for ground).
 */
function diagonal(src: SlotSource, ac: number, ar: number, da: number, bc: number, br: number, db: number, ea: number, eb: number, cur: boolean): number {
  if (ac >= 0) { resolve(src, ac % src.sx, Math.floor(ac / src.sx), ar, da, cur); return hit.e }
  if (bc >= 0) { resolve(src, bc % src.sx, Math.floor(bc / src.sx), br, db, cur); return hit.e }
  hit.f = 0
  if (ea === OUTSIDE || eb === OUTSIDE) return OUTSIDE
  return ~Math.max(level(ea), level(eb))
}

/**
 * The effective values (surfaceMesh.effective, or OUTSIDE) of the 3 × 3 around slot (x, z, r), index (dz + 1) × 3 + dx + 1,
 * each neighbour through the links (plan design notes: The main thread). With every link the default this is the 3 × 3 of
 * the dense columns, exactly as 3c's refresh reads it. With `f`, the same cells' floors (blocks; 0 where no slot lies) into f:
 * a slot's floor is the same in both steps.
 */
export function patch(src: SlotSource, x: number, z: number, r: number, cur: boolean, e: Int32Array, f?: Int16Array): void {
  const c = x + z * src.sx, fc = src.floor(c, r)
  e[4] = effective(src.value(c, r, cur), fc)
  resolve(src, x, z, r, 0, cur); e[5] = hit.e; const ec = hit.c, er = hit.r, fe = hit.f
  resolve(src, x, z, r, 1, cur); e[3] = hit.e; const wc = hit.c, wr = hit.r, fw = hit.f
  resolve(src, x, z, r, 2, cur); e[7] = hit.e; const sc = hit.c, sr = hit.r, fs = hit.f
  resolve(src, x, z, r, 3, cur); e[1] = hit.e; const nc = hit.c, nr = hit.r, fn = hit.f
  e[8] = diagonal(src, ec, er, 2, sc, sr, 0, e[5]!, e[7]!, cur); const f8 = hit.f
  e[2] = diagonal(src, ec, er, 3, nc, nr, 0, e[5]!, e[1]!, cur); const f2 = hit.f
  e[6] = diagonal(src, wc, wr, 2, sc, sr, 1, e[3]!, e[7]!, cur); const f6 = hit.f
  e[0] = diagonal(src, wc, wr, 3, nc, nr, 1, e[3]!, e[1]!, cur)
  if (!f) return
  f[0] = hit.f; f[1] = fn; f[2] = f2; f[3] = fw; f[4] = fc; f[5] = fe; f[6] = f6; f[7] = fs; f[8] = f8
}
