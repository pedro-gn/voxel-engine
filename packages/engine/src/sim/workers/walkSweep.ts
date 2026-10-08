import type { Layout } from '../../world/layout.ts'

export type WalkPose = readonly [number, number, number]

/** Conservative Q8 sweep for a .75 x 2 block body on a level floor. */
export function walkSweep(layout: Layout, start: WalkPose, end: WalkPose): number[] {
  const dx = end[0] - start[0], dz = end[2] - start[2]
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dz)) / 32)), cells = new Set<number>()
  let ax = start[0], az = start[2]
  for (let i = 1; i <= steps; i++) {
    const bx = start[0] + Math.trunc(dx * i / steps), bz = start[2] + Math.trunc(dz * i / steps)
    // Each short rectangle contains the complete swept body, including grazing corners.
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
