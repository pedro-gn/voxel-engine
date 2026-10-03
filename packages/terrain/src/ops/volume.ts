import type { OpDef, PathPoint, ShapeDef } from '../doc/types.ts'
import type { Box } from '../geom.ts'
import { makeNoise3, type NoiseDef } from '../noise/def.ts'
import { defineTerrainOp, type CompileContext, type VolumeOp } from './registry.ts'
import { WORLD_TOP, paramsOf, type ParamSchema } from './schema.ts'
import { archCurve, compileTube, type TubePoint } from './tube.ts'

type PathShape = Extract<ShapeDef, { kind: 'path' }>

function tubePoints(shape: PathShape, height: (width: number) => number): TubePoint[] {
  return shape.points.map((p: PathPoint) => {
    const w = p.width ?? shape.width
    return { x: p.x, y: p.y ?? 0, z: p.z, hw: w / 2, hh: height(w) / 2 }
  })
}

/** Params every volume op shares; the defaults differ per op. */
function common<M extends 'add' | 'carve'>(wobble: number, mode: M) {
  return {
    wobble: { type: 'number', default: wobble, min: 0, step: 0.5, range: [0, 8] },
    noise: { type: 'noise', default: { scale: 12, octaves: 2 } },
    mode: { type: 'enum', values: ['add', 'carve'], default: mode },
  } as const satisfies ParamSchema
}

interface Common { wobble: number; noise: NoiseDef; mode: 'add' | 'carve' }

/**
 * Wraps a tube or blob field with noise wobble into a VolumeOp. `reach` scales the bounds padding per
 * axis for fields whose gradient is below 1 block per block (a flattened blob).
 */
function volumeOp(id: string, ctx: CompileContext, bounds: Box, field: (x: number, y: number, z: number) => number, c: Common, reach = { xz: 1, y: 1 }): VolumeOp {
  const padXZ = c.wobble * reach.xz, padY = c.wobble * reach.y
  const noise = makeNoise3(c.noise, ctx.seed)
  const wobble = c.wobble
  return {
    id, mode: c.mode,
    bounds: { x0: bounds.x0 - padXZ, x1: bounds.x1 + padXZ, y0: bounds.y0 - padY, y1: bounds.y1 + padY, z0: bounds.z0 - padXZ, z1: bounds.z1 + padXZ },
    density: wobble > 0 ? (x, y, z) => field(x, y, z) + wobble * (noise(x, y, z) * 2 - 1) : field,
  }
}

const ARCH = {
  rise: { type: 'number', required: true, default: 12, min: 0, range: [0, 64] },
  height: { type: 'number', gt: 0, range: [1, 32] },
  ...common(1.5, 'add'),
} as const satisfies ParamSchema

/** A stone arch: a tube along a Bézier from the first path point to the second, lifted by `rise`. Default mode 'add'. */
export const arch = defineTerrainOp({
  type: 'arch', kind: 'volume', shapes: ['path'], needY: true, falloff: false, params: ARCH,
  check(c, path, def: OpDef) {
    if ((def.shape as PathShape).points.length !== 2) c.fail(`${path}.shape.points`, 'an arch takes exactly 2 points')
  },
  compile(def, ctx) {
    const p = paramsOf(def, ARCH)
    const thick = p.height ?? 0
    const [p0, p2] = tubePoints(def.shape as PathShape, (w) => thick || w)
    const tube = compileTube(archCurve(p0!, p2!, p.rise, 24), 0)
    return volumeOp(def.id, ctx, tube.bounds, tube.field, p)
  },
})

const CAVE = {
  height: { type: 'number', gt: 0, range: [1, 32] },
  ...common(2, 'carve'),
} as const satisfies ParamSchema

/** A cave tunnel along a 3D path; start the path above ground for a visible entrance. Default mode 'carve'. */
export const cave = defineTerrainOp({
  type: 'cave', kind: 'volume', shapes: ['path'], needY: true, falloff: false, params: CAVE,
  compile(def, ctx) {
    const p = paramsOf(def, CAVE)
    const height = p.height ?? 0
    const tube = compileTube(tubePoints(def.shape as PathShape, (w) => height || w), 0)
    return volumeOp(def.id, ctx, tube.bounds, tube.field, p)
  },
})

const OVERHANG = {
  height: { type: 'number', gt: 0, range: [1, 32] },
  ...common(1, 'carve'),
} as const satisfies ParamSchema

/**
 * A flat horizontal slot along a wall, at the path's y: carving it under a cliff leaves an
 * overhanging lip; with mode 'add' it builds a ledge. `height` defaults to a third of the width.
 */
export const overhang = defineTerrainOp({
  type: 'overhang', kind: 'volume', shapes: ['path'], needY: true, falloff: false, params: OVERHANG,
  compile(def, ctx) {
    const p = paramsOf(def, OVERHANG)
    const height = p.height ?? 0
    const tube = compileTube(tubePoints(def.shape as PathShape, (w) => height || w / 3), 0)
    return volumeOp(def.id, ctx, tube.bounds, tube.field, p)
  },
})

const BLOB = {
  y: { type: 'number', required: true, default: 16, min: 0, max: WORLD_TOP, anchor: 'ground' },
  height: { type: 'number', required: true, default: 8, gt: 0, range: [1, 48] },
  ...common(2, 'add'),
} as const satisfies ParamSchema

/**
 * A noisy ellipsoid centred on the circle at height `y`: horizontal radius = the circle's radius,
 * vertical radius = `height`. Floating islands, spires, boulders (mode 'add') or pits (mode 'carve').
 */
export const blob = defineTerrainOp({
  type: 'blob', kind: 'volume', shapes: ['circle'], falloff: false, params: BLOB,
  compile(def, ctx) {
    const shape = def.shape as Extract<ShapeDef, { kind: 'circle' }>
    const [cx, cz] = shape.center
    const p = paramsOf(def, BLOB)
    const r = shape.radius, cy = p.y, hy = p.height
    const k = Math.min(r, hy)
    const field = (x: number, y: number, z: number) => {
      const q = Math.sqrt(((x - cx) / r) ** 2 + ((y - cy) / hy) ** 2 + ((z - cz) / r) ** 2)
      return (1 - q) * k
    }
    return volumeOp(def.id, ctx, { x0: cx - r, x1: cx + r, y0: cy - hy, y1: cy + hy, z0: cz - r, z1: cz + r }, field, p, { xz: r / k, y: hy / k })
  },
})
