import type { OpDef, PathPoint, ShapeDef } from '../doc/types.ts'
import type { Box } from '../geom.ts'
import { checkParamMode, checkParamNoise, checkParamNum, noise3Of, param, paramStr } from './common.ts'
import { defineTerrainOp, type CompileContext, type VolumeOp } from './registry.ts'
import { archCurve, compileTube, type TubePoint } from './tube.ts'

type PathShape = Extract<ShapeDef, { kind: 'path' }>

function tubePoints(shape: PathShape, height: (width: number) => number): TubePoint[] {
  return shape.points.map((p: PathPoint) => {
    const w = p.width ?? shape.width
    return { x: p.x, y: p.y ?? 0, z: p.z, hw: w / 2, hh: height(w) / 2 }
  })
}

/**
 * Wraps a tube or blob field with noise wobble into a VolumeOp. `reach` scales the bounds padding per
 * axis for fields whose gradient is below 1 block per block (a flattened blob).
 */
function volumeOp(def: OpDef, ctx: CompileContext, bounds: Box, field: (x: number, y: number, z: number) => number, defaultMode: 'add' | 'carve', defaultWobble: number, reach = { xz: 1, y: 1 }): VolumeOp {
  const wobble = param(def, 'wobble', defaultWobble)
  const padXZ = wobble * reach.xz, padY = wobble * reach.y
  const noise = noise3Of(def, 'noise', { scale: 12, octaves: 2 }, ctx.seed)
  const mode = paramStr(def, 'mode', defaultMode)
  return {
    id: def.id, mode,
    bounds: { x0: bounds.x0 - padXZ, x1: bounds.x1 + padXZ, y0: bounds.y0 - padY, y1: bounds.y1 + padY, z0: bounds.z0 - padXZ, z1: bounds.z1 + padXZ },
    density: wobble > 0 ? (x, y, z) => field(x, y, z) + wobble * (noise(x, y, z) * 2 - 1) : field,
  }
}

function checkCommon(c: Parameters<typeof checkParamNum>[0], path: string, def: OpDef): void {
  checkParamNum(c, path, def, 'wobble', { min: 0, optional: true })
  checkParamNoise(c, path, def)
  checkParamMode(c, path, def)
}

/** A stone arch: a tube along a Bézier from the first path point to the second, lifted by `rise`. Default mode 'add'. */
export const arch = defineTerrainOp({
  type: 'arch', kind: 'volume', shapes: ['path'], needY: true,
  validate(c, path, def) {
    if ((def.shape as PathShape).points.length !== 2) c.fail(`${path}.shape.points`, 'an arch takes exactly 2 points')
    checkParamNum(c, path, def, 'rise', { min: 0 })
    checkParamNum(c, path, def, 'height', { gt: 0, optional: true })
    checkCommon(c, path, def)
  },
  compile(def, ctx) {
    const thick = param(def, 'height', 0)
    const [p0, p2] = tubePoints(def.shape as PathShape, (w) => thick || w)
    const tube = compileTube(archCurve(p0!, p2!, param(def, 'rise', 0), 24), 0)
    return volumeOp(def, ctx, tube.bounds, tube.field, 'add', 1.5)
  },
})

/** A cave tunnel along a 3D path; start the path above ground for a visible entrance. Default mode 'carve'. */
export const cave = defineTerrainOp({
  type: 'cave', kind: 'volume', shapes: ['path'], needY: true,
  validate(c, path, def) {
    checkParamNum(c, path, def, 'height', { gt: 0, optional: true })
    checkCommon(c, path, def)
  },
  compile(def, ctx) {
    const height = param(def, 'height', 0)
    const tube = compileTube(tubePoints(def.shape as PathShape, (w) => height || w), 0)
    return volumeOp(def, ctx, tube.bounds, tube.field, 'carve', 2)
  },
})

/**
 * A flat horizontal slot along a wall, at the path's y: carving it under a cliff leaves an
 * overhanging lip; with mode 'add' it builds a ledge. `height` defaults to a third of the width.
 */
export const overhang = defineTerrainOp({
  type: 'overhang', kind: 'volume', shapes: ['path'], needY: true,
  validate(c, path, def) {
    checkParamNum(c, path, def, 'height', { gt: 0, optional: true })
    checkCommon(c, path, def)
  },
  compile(def, ctx) {
    const height = param(def, 'height', 0)
    const tube = compileTube(tubePoints(def.shape as PathShape, (w) => height || w / 3), 0)
    return volumeOp(def, ctx, tube.bounds, tube.field, 'carve', 1)
  },
})

/**
 * A noisy ellipsoid centred on the circle at height `y`: horizontal radius = the circle's radius,
 * vertical radius = `height`. Floating islands, spires, boulders (mode 'add') or pits (mode 'carve').
 */
export const blob = defineTerrainOp({
  type: 'blob', kind: 'volume', shapes: ['circle'],
  validate(c, path, def, ctx) {
    checkParamNum(c, path, def, 'y', { min: 0, max: ctx.height })
    checkParamNum(c, path, def, 'height', { gt: 0 })
    checkCommon(c, path, def)
  },
  compile(def, ctx) {
    const shape = def.shape as Extract<ShapeDef, { kind: 'circle' }>
    const [cx, cz] = shape.center
    const r = shape.radius, cy = param(def, 'y', 0), hy = param(def, 'height', 1)
    const k = Math.min(r, hy)
    const field = (x: number, y: number, z: number) => {
      const q = Math.sqrt(((x - cx) / r) ** 2 + ((y - cy) / hy) ** 2 + ((z - cz) / r) ** 2)
      return (1 - q) * k
    }
    return volumeOp(def, ctx, { x0: cx - r, x1: cx + r, y0: cy - hy, y1: cy + hy, z0: cz - r, z1: cz + r }, field, 'add', 2, { xz: r / k, y: hy / k })
  },
})
