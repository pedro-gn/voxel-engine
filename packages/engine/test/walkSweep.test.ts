import { expect, it } from 'vitest'
import { walkSweep, type WalkPose } from '../src/sim/workers/walkSweep.ts'
import { Layout } from '../src/world/layout.ts'
import { Pcg32 } from '../src/sim/rng.ts'

/** The sweep as first written: every short rectangle into one set, in order. */
function reference(layout: Layout, start: WalkPose, end: WalkPose): number[] {
  const dx = end[0] - start[0], dz = end[2] - start[2]
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dz)) / 32)), cells = new Set<number>()
  let ax = start[0], az = start[2]
  for (let i = 1; i <= steps; i++) {
    const bx = start[0] + Math.trunc(dx * i / steps), bz = start[2] + Math.trunc(dz * i / steps)
    for (let y = start[1] >> 8; y <= (start[1] + 511) >> 8; y++)
      for (let z = (Math.min(az, bz) - 96) >> 8; z <= (Math.max(az, bz) + 95) >> 8; z++)
        for (let x = (Math.min(ax, bx) - 96) >> 8; x <= (Math.max(ax, bx) + 95) >> 8; x++) {
          if (!layout.inBounds(x, y, z)) return [-1]
          cells.add(layout.voxelIndex(x, y, z))
        }
    ax = bx; az = bz
  }
  return [...cells]
}

it('sweeps the same cells in the same order as a set of every short rectangle', () => {
  const layout = new Layout([64, 32, 64]), rng = new Pcg32(7)
  const pose = (): WalkPose => [rng.nextInt(64 * 256), (4 + rng.nextInt(20)) * 256, rng.nextInt(64 * 256)]
  for (let i = 0; i < 2000; i++) {
    const a = pose(), far = rng.nextInt(4) === 0, b: WalkPose = far ? pose() : [a[0] + rng.nextInt(1025) - 512, a[1], a[2] + rng.nextInt(1025) - 512]
    expect(walkSweep(layout, a, b), `${a} -> ${b}`).toEqual(reference(layout, a, b))
  }
})
