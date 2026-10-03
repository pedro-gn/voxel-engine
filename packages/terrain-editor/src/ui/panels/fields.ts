import {
  BLEND_MODES, NOISE_TYPES, resolveBound,
  type BlendMode, type NoiseDef, type NumberParam, type OpDef, type OpImpl, type PathPoint, type ShapeDef, type TerrainDoc, type Vec2,
} from '@elovox/terrain'
import { moveVertex, setBase, setBlend, setParam, setSeaLevel, setShape, type Edit } from '../../core/edits.ts'

interface FieldBase { path: string; label: string }
export interface NumberField extends FieldBase {
  kind: 'number'
  value: number | undefined
  /** What an empty value means (the default), shown greyed out. */
  placeholder: number | undefined
  min: number
  max: number
  step: number
  /** May be emptied (edit(undefined) clears it). */
  optional: boolean
  edit(v: number | undefined): Edit
}
export interface SelectField extends FieldBase { kind: 'select'; value: string; options: readonly { value: string; label: string }[]; edit(v: string): Edit }
export interface BoolField extends FieldBase { kind: 'bool'; value: boolean; edit(v: boolean): Edit }
export interface GroupField extends FieldBase { kind: 'group'; fields: Field[] }
export type Field = NumberField | SelectField | BoolField | GroupField

/** Calls `visit` on every field, groups first, then their children. */
export function walkFields(fields: Field[], visit: (f: Field) => void): void {
  for (const f of fields) {
    visit(f)
    if (f.kind === 'group') walkFields(f.fields, visit)
  }
}

interface NumOpts { min: number; max: number; step: number; optional?: boolean; placeholder?: number }
function num(path: string, label: string, value: number | undefined, o: NumOpts, edit: (v: number | undefined) => Edit): NumberField {
  return { kind: 'number', path, label, value, placeholder: o.placeholder, min: o.min, max: o.max, step: o.step, optional: o.optional ?? false, edit }
}

/** A copy of `o` with `key` set, or removed when `v` is undefined. */
function withKey<T extends object>(o: T, key: string, v: unknown): T {
  const out = { ...o } as Record<string, unknown>
  if (v === undefined) delete out[key]
  else out[key] = v
  return out as T
}

function paramNumber(path: string, label: string, value: number | undefined, spec: NumberParam, ctx: { biomes: readonly string[]; height: number }, edit: (v: number | undefined) => Edit): NumberField {
  const min = spec.range?.[0] ?? spec.min ?? spec.gt ?? 0
  const max = spec.range?.[1] ?? resolveBound(spec.max, ctx) ?? Math.max(min + 1, 100)
  const step = spec.step ?? (spec.int || spec.anchor ? 1 : 0.1)
  return num(path, label, value, { min, max, step, optional: !spec.required, placeholder: spec.default }, edit)
}

/** The fields of a NoiseDef, with warp as an on/off toggle plus its two numbers. */
function noiseGroup(path: string, label: string, n: NoiseDef, edit: (n: NoiseDef) => Edit): GroupField {
  const set = (key: string) => (v: unknown) => edit(withKey(n, key, v))
  const fields: Field[] = [
    { kind: 'select', path: `${path}.type`, label: 'type', value: n.type ?? 'fbm', options: NOISE_TYPES.map((t) => ({ value: t, label: t })), edit: (v) => edit(withKey(n, 'type', v === 'fbm' ? undefined : v)) },
    num(`${path}.scale`, 'scale', n.scale, { min: 1, max: 512, step: 1 }, (v) => edit({ ...n, scale: v ?? n.scale })),
    num(`${path}.octaves`, 'octaves', n.octaves, { min: 1, max: 8, step: 1, optional: true, placeholder: 4 }, set('octaves')),
    num(`${path}.lacunarity`, 'lacunarity', n.lacunarity, { min: 1, max: 4, step: 0.1, optional: true, placeholder: 2 }, set('lacunarity')),
    num(`${path}.gain`, 'gain', n.gain, { min: 0.05, max: 1, step: 0.05, optional: true, placeholder: 0.5 }, set('gain')),
    num(`${path}.seed`, 'seed', n.seed, { min: -1000, max: 1000, step: 1, optional: true, placeholder: 0 }, set('seed')),
    { kind: 'bool', path: `${path}.warp`, label: 'warp', value: n.warp !== undefined, edit: (on) => edit(withKey(n, 'warp', on ? n.warp ?? { scale: 64, amount: 16 } : undefined)) },
  ]
  if (n.warp) {
    const w = n.warp
    fields.push(
      num(`${path}.warp.scale`, 'warp scale', w.scale, { min: 1, max: 512, step: 1 }, (v) => edit({ ...n, warp: { ...w, scale: v ?? w.scale } })),
      num(`${path}.warp.amount`, 'warp amount', w.amount, { min: 0, max: 128, step: 1 }, (v) => edit({ ...n, warp: { ...w, amount: v ?? w.amount } })),
    )
  }
  return { kind: 'group', path, label, fields }
}

function shapeFields(def: OpDef, impl: OpImpl, doc: TerrainDoc): Field[] {
  const s = def.shape, id = def.id
  const set = (shape: ShapeDef) => setShape(id, shape)
  const out: Field[] = []
  if (s.kind === 'circle') {
    const [cx, cz] = s.center
    out.push(
      num('shape.center[0]', 'x', cx, { min: 0, max: doc.size[0], step: 1 }, (v) => set({ ...s, center: [v ?? cx, cz] })),
      num('shape.center[1]', 'z', cz, { min: 0, max: doc.size[1], step: 1 }, (v) => set({ ...s, center: [cx, v ?? cz] })),
      num('shape.radius', 'radius', s.radius, { min: 1, max: 256, step: 1 }, (v) => set({ ...s, radius: v ?? s.radius })),
    )
  } else if (s.kind === 'polygon') {
    out.push(num('shape.inset', 'inset', s.inset, { min: 1, max: 64, step: 1, optional: true, placeholder: 16 }, (v) => set(withKey(s, 'inset', v))))
  } else {
    out.push(num('shape.width', 'width', s.width, { min: 1, max: 128, step: 1 }, (v) => set({ ...s, width: v ?? s.width })))
  }
  if (impl.falloff) out.push(num('shape.falloff', 'falloff', s.falloff, { min: 0, max: 128, step: 1, optional: true, placeholder: 0 }, (v) => set(withKey(s, 'falloff', v))))
  return out
}

function pointsGroup(def: OpDef, impl: OpImpl, doc: TerrainDoc, height: number): GroupField {
  const s = def.shape as Exclude<ShapeDef, { kind: 'circle' }>
  const id = def.id
  const fields: Field[] = s.points.map((p, i) => {
    const path = `shape.points[${i}]`
    if (s.kind === 'polygon') {
      const [x, z] = p as Vec2
      return {
        kind: 'group', path, label: `#${i}`, fields: [
          num(`${path}[0]`, 'x', x, { min: 0, max: doc.size[0], step: 1 }, (v) => moveVertex(id, i, [v ?? x, z])),
          num(`${path}[1]`, 'z', z, { min: 0, max: doc.size[1], step: 1 }, (v) => moveVertex(id, i, [x, v ?? z])),
        ],
      }
    }
    const q = p as PathPoint
    const set = (key: keyof PathPoint) => (v: number | undefined) => moveVertex(id, i, withKey(q, key, v))
    return {
      kind: 'group', path, label: `#${i}`, fields: [
        num(`${path}.x`, 'x', q.x, { min: 0, max: doc.size[0], step: 1 }, (v) => moveVertex(id, i, { ...q, x: v ?? q.x })),
        num(`${path}.z`, 'z', q.z, { min: 0, max: doc.size[1], step: 1 }, (v) => moveVertex(id, i, { ...q, z: v ?? q.z })),
        num(`${path}.y`, 'y', q.y, { min: 0, max: height, step: 1, optional: !impl.needY }, set('y')),
        num(`${path}.width`, 'width', q.width, { min: 1, max: 128, step: 1, optional: true, placeholder: (s as Extract<ShapeDef, { kind: 'path' }>).width }, set('width')),
      ],
    }
  })
  return { kind: 'group', path: 'shape.points', label: 'points', fields }
}

/** The inspector for one op. */
export function opFields(def: OpDef, impl: OpImpl, doc: TerrainDoc, height: number): Field[] {
  const id = def.id
  const out: Field[] = []
  if (impl.kind === 'height') {
    out.push({
      kind: 'select', path: 'blend', label: 'blend', value: def.blend ?? '',
      options: [{ value: '', label: `default (${impl.defaultBlend})` }, ...BLEND_MODES.map((m) => ({ value: m, label: m }))],
      edit: (v) => setBlend(id, v === '' ? undefined : (v as BlendMode)),
    })
  }
  out.push(...shapeFields(def, impl, doc))
  const ctx = { biomes: doc.biomes.map((b) => b.name), height }
  for (const [key, spec] of Object.entries(impl.params)) {
    const path = `params.${key}`
    const value = def.params[key]
    const set = (v: unknown) => setParam(id, key, v)
    switch (spec.type) {
      case 'number': out.push(paramNumber(path, key, value as number | undefined, spec, ctx, set)); break
      case 'enum': out.push({ kind: 'select', path, label: key, value: (value as string | undefined) ?? spec.default, options: spec.values.map((v) => ({ value: v, label: v })), edit: set }); break
      case 'bool': out.push({ kind: 'bool', path, label: key, value: (value as boolean | undefined) ?? spec.default, edit: set }); break
      case 'biome': out.push({ kind: 'select', path, label: key, value: String(value ?? ''), options: ctx.biomes.map((b) => ({ value: b, label: b })), edit: set }); break
      case 'noise': out.push(noiseGroup(path, key, (value as NoiseDef | undefined) ?? spec.default, set)); break
    }
  }
  if (def.shape.kind !== 'circle') out.push(pointsGroup(def, impl, doc, height))
  return out
}

/** The inspector with nothing selected: fields that apply to the whole world. */
export function docFields(doc: TerrainDoc, height: number): Field[] {
  const b = doc.base
  return [
    num('seaLevel', 'sea level', doc.seaLevel, { min: 0, max: height - 1, step: 1 }, (v) => setSeaLevel(v ?? doc.seaLevel)),
    {
      kind: 'group', path: 'base', label: 'base fill', fields: [
        num('base.height', 'height', b.height, { min: 0, max: height, step: 1 }, (v) => setBase({ ...b, height: v ?? b.height })),
        num('base.amplitude', 'amplitude', b.amplitude, { min: 0, max: 64, step: 0.5 }, (v) => setBase({ ...b, amplitude: v ?? b.amplitude })),
        noiseGroup('base.noise', 'noise', b.noise, (n) => setBase({ ...b, noise: n })),
      ],
    },
  ]
}
