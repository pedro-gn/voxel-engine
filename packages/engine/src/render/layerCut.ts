import { positionWorld, uniform } from 'three/tsl'
import type { Layout } from '../world/layout.ts'

/** World y of the layer cut's plane for shaders (water, falling blocks, fragments); a large number when there is no cut. */
export const cutTop = uniform(1e9)
/** True below the cut plane: a NodeMaterial `maskNode` that discards what the cut hides (also from the shadow map). */
export const belowCut = () => positionWorld.y.lessThanEqual(cutTop.add(0.01))

/**
 * The layer cut (spec §4, plan deviation D9): `y` is the highest visible layer. Chunks wholly above it are hidden; the
 * chunk layer it crosses is meshed with everything above `y` read as air. The simulation never sees it.
 */
export class LayerCut {
  private cut: number | null = null
  private readonly layout: Layout
  constructor(layout: Layout) { this.layout = layout }
  get y(): number | null { return this.cut }
  /** World y of the cut plane (the top of the highest visible layer); Infinity when there is no cut. */
  get top(): number { return this.cut === null ? Infinity : this.cut + 1 }
  /** Sets the cut; returns the chunks whose mesh must be rebuilt (the old and the new crossed layers; none when unchanged). */
  set(y: number | null): number[] {
    if (y !== null && (!Number.isInteger(y) || y < 0 || y >= this.layout.size[1])) throw new RangeError(`cut must be an integer layer in [0, ${this.layout.size[1] - 1}] or null, got ${y}`)
    if (y === this.cut) return []
    const before = this.cut === null ? -1 : this.cut >> 5, after = y === null ? -1 : y >> 5
    this.cut = y
    cutTop.value = y === null ? 1e9 : y + 1
    const layers = new Set([before, after].filter(l => l >= 0))
    const out: number[] = []
    for (const cy of layers) for (let cz = 0; cz < this.layout.cz; cz++) for (let cx = 0; cx < this.layout.cx; cx++) out.push(this.layout.chunkIndex(cx, cy, cz))
    return out
  }
  /** Whether chunk `ci` lies wholly above the cut. */
  hides(ci: number): boolean { return this.cut !== null && this.layout.chunkCoords(ci)[1] * 32 > this.cut }
  /** Whether the cut crosses chunk `ci` (its layer is the cut's). */
  crosses(ci: number): boolean { return this.cut !== null && this.layout.chunkCoords(ci)[1] === this.cut >> 5 }
  /** The cut a mesh of chunk `ci` must have been made with (undefined: none). */
  expected(ci: number): number | undefined { return this.crosses(ci) ? this.cut! : undefined }
  /**
   * Whether a mesh result of chunk `ci` made with `cut` (the job's, echoed) may be shown. A refused one needs no requeue:
   * expected(ci) only changes in set(), which returns ci, and the engine marks every chunk set() returns, so ci is already
   * queued again (or marked behind its job in flight).
   */
  accepts(ci: number, cut: number | undefined): boolean { return cut === this.expected(ci) }
}
