import type { Layout } from '../../world/layout.ts'

export type WalkPose = readonly [number, number, number]

/** Conservative Q8 sweep for a .75 x 2 block body on a level floor. */
export function walkSweep(layout: Layout, start: WalkPose, end: WalkPose): number[] {
  const dx = end[0] - start[0], dz = end[2] - start[2]
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dz)) / 32)), cells = new Set<number>()
  const y0 = start[1] >> 8, y1 = (start[1] + 511) >> 8
  let ax = start[0], az = start[2], px0 = 0, px1 = -1, pz0 = 0, pz1 = -1
  for (let i = 1; i <= steps; i++) {
    const bx = start[0] + Math.trunc(dx * i / steps), bz = start[2] + Math.trunc(dz * i / steps)
    // Each short rectangle contains the complete swept body, including grazing corners.
    const x0 = (Math.min(ax, bx) - 96) >> 8, x1 = (Math.max(ax, bx) + 95) >> 8, z0 = (Math.min(az, bz) - 96) >> 8, z1 = (Math.max(az, bz) + 95) >> 8
    ax = bx; az = bz
    // Consecutive rectangles mostly cover the same cells: one already added adds nothing, in the same order.
    if (x0 === px0 && x1 === px1 && z0 === pz0 && z1 === pz1) continue
    px0 = x0; px1 = x1; pz0 = z0; pz1 = z1
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          if (!layout.inBounds(x, y, z)) return [-1]
          cells.add(layout.voxelIndex(x, y, z))
        }
  }
  return [...cells]
}
