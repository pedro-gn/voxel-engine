import type { Layout } from '../../world/layout.ts'

export type WalkPose = readonly [number, number, number]

/** Seen-marks for walkSweep's dedupe: a cell was added in this call when its mark equals the call's stamp. */
let marks = new Uint32Array(1024), stamp = 0

/** Conservative Q8 sweep for a .75 x 2 block body on a level floor. Cells come in first-touched order. */
export function walkSweep(layout: Layout, start: WalkPose, end: WalkPose): number[] {
  const dx = end[0] - start[0], dz = end[2] - start[2]
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dz)) / 32)), cells: number[] = []
  const [sx, sy, sz] = layout.size, plane = sx * sz, y0 = start[1] >> 8, y1 = (start[1] + 511) >> 8
  if (y0 < 0 || y1 >= sy) return [-1]
  // Every rectangle lies in the sweep's bounding box; marks index cells of that box.
  const bx0 = (Math.min(start[0], end[0]) - 96) >> 8, bz0 = (Math.min(start[2], end[2]) - 96) >> 8
  const bw = ((Math.max(start[0], end[0]) + 95) >> 8) - bx0 + 1, bd = ((Math.max(start[2], end[2]) + 95) >> 8) - bz0 + 1
  const box = bw * bd * (y1 - y0 + 1)
  if (box > marks.length) marks = new Uint32Array(Math.max(box, marks.length * 2))
  if (++stamp === 0xffffffff) { marks.fill(0); stamp = 1 }
  let ax = start[0], az = start[2]
  for (let i = 1; i <= steps; i++) {
    const bx = start[0] + Math.trunc(dx * i / steps), bz = start[2] + Math.trunc(dz * i / steps)
    // Each short rectangle contains the complete swept body, including grazing corners.
    const z0 = (Math.min(az, bz) - 96) >> 8, z1 = (Math.max(az, bz) + 95) >> 8, x0 = (Math.min(ax, bx) - 96) >> 8, x1 = (Math.max(ax, bx) + 95) >> 8
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          if (x < 0 || z < 0 || x >= sx || z >= sz) return [-1]
          const m = ((y - y0) * bd + z - bz0) * bw + x - bx0
          if (marks[m] === stamp) continue
          marks[m] = stamp; cells.push(x + z * sx + y * plane)
        }
    ax = bx; az = bz
  }
  return cells
}
