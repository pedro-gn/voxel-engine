import { base64ToBytes, bytesToBase64 } from '../doc/base64.ts'
import type { Check } from '../doc/check.ts'
import type { TerrainLayers, TerrainLayersJSON } from '../doc/types.ts'

/** Columns per side of a height or biome tile. */
export const TILE = 64
/** Columns per side of a biome cell. */
export const BIOME_CELL = 4
/** Biome cells per side of a tile. */
export const BIOME_TILE = TILE / BIOME_CELL
/** Height layer units per block. */
export const HEIGHT_SCALE = 16
/** Samples per brick side; samples are BRICK_SPACING blocks apart, so a brick spans BRICK_SPAN blocks. */
export const BRICK_SAMPLES = 8
export const BRICK_SPACING = 2
export const BRICK_SPAN = BRICK_SAMPLES * BRICK_SPACING
/** Density layer units per block. */
export const DENSITY_SCALE = 8

export const HEIGHT_VALUES = TILE * TILE
export const BIOME_VALUES = BIOME_TILE * BIOME_TILE
export const BRICK_VALUES = BRICK_SAMPLES ** 3

export type LayerValues = Int16Array | Uint8Array | Int8Array
type Kind = 'i16' | 'u8' | 'i8'

/** What layers are checked against. */
export interface LayerLimits {
  /** World size in blocks. */
  sizeX: number
  sizeZ: number
  height: number
  biomeCount: number
}

/** Key of a tile (x, z < 65536). */
export function tileKey(x: number, z: number): number { return x + z * 65536 }
/** Key of a brick (each coordinate in 0..1023). */
export function brickKey(x: number, y: number, z: number): number { return x + y * 1024 + z * 1048576 }

/** The values as little-endian base64. */
export function encodeValues(values: LayerValues): string {
  if (!(values instanceof Int16Array)) return bytesToBase64(new Uint8Array(values.buffer, values.byteOffset, values.length))
  const bytes = new Uint8Array(values.length * 2)
  const dv = new DataView(bytes.buffer)
  for (let i = 0; i < values.length; i++) dv.setInt16(i * 2, values[i]!, true)
  return bytesToBase64(bytes)
}

/** Decodes `n` values. Throws a RangeError when the data holds another count, and an Error on bad base64. */
export function decodeValues(kind: Kind, data: string, n: number): LayerValues {
  const bytes = base64ToBytes(data)
  const width = kind === 'i16' ? 2 : 1
  if (bytes.length !== n * width) throw new RangeError(`holds ${bytes.length / width} values, expected ${n}`)
  if (kind === 'u8') return bytes
  if (kind === 'i8') return new Int8Array(bytes.buffer, bytes.byteOffset, n)
  const out = new Int16Array(n)
  const dv = new DataView(bytes.buffer, bytes.byteOffset)
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true)
  return out
}

/** The layers as the file stores them. */
export function layersToJSON(l: TerrainLayers): TerrainLayersJSON {
  const out: TerrainLayersJSON = {}
  if (l.height) out.height = { tiles: l.height.tiles.map((t) => ({ x: t.x, z: t.z, data: encodeValues(t.values) })) }
  if (l.biome) out.biome = { tiles: l.biome.tiles.map((t) => ({ x: t.x, z: t.z, data: encodeValues(t.values) })) }
  if (l.density) out.density = { bricks: l.density.bricks.map((b) => ({ x: b.x, y: b.y, z: b.z, data: encodeValues(b.values) })) }
  return out
}

const CTORS: Record<Kind, new (n: number) => LayerValues> = { i16: Int16Array, u8: Uint8Array, i8: Int8Array }
const NAMES: Record<Kind, string> = { i16: 'an Int16Array', u8: 'a Uint8Array', i8: 'an Int8Array' }

interface Entry { x: number; y: number; z: number; values: LayerValues; path: string }

/**
 * Validates layers given either as the file stores them (base64 `data`) or decoded (`values`), and
 * returns them decoded: sorted, all-zero tiles dropped, empty lists removed. Errors go to `c`.
 */
export function checkLayers(c: Check, path: string, v: unknown, o: LayerLimits): TerrainLayers {
  const out: TerrainLayers = {}
  if (!c.obj(path, v, true)) return out
  for (const k of Object.keys(v)) {
    if (k !== 'height' && k !== 'biome' && k !== 'density') c.fail(`${path}.${k}`, 'unknown layer (known: height, biome, density)')
  }
  const tx = Math.ceil(o.sizeX / TILE), tz = Math.ceil(o.sizeZ / TILE)
  const height = checkList(c, `${path}.height`, v.height, 'tiles', 'i16', HEIGHT_VALUES, [tx, tz])
  if (height) out.height = { tiles: height.map((e) => ({ x: e.x, z: e.z, values: e.values as Int16Array })) }
  const biome = checkList(c, `${path}.biome`, v.biome, 'tiles', 'u8', BIOME_VALUES, [tx, tz])
  if (biome) {
    const before = c.errors.length
    for (const e of biome) {
      const i = e.values.findIndex((b) => b > o.biomeCount)
      if (i >= 0) c.fail(e.path, `value ${e.values[i]} at cell (${i % BIOME_TILE}, ${Math.floor(i / BIOME_TILE)}) exceeds the ${o.biomeCount} biomes`)
    }
    if (c.errors.length === before) out.biome = { tiles: biome.map((e) => ({ x: e.x, z: e.z, values: e.values as Uint8Array })) }
  }
  const bricks = [Math.ceil(o.sizeX / BRICK_SPAN), Math.ceil(o.height / BRICK_SPAN), Math.ceil(o.sizeZ / BRICK_SPAN)]
  const density = checkList(c, `${path}.density`, v.density, 'bricks', 'i8', BRICK_VALUES, bricks)
  if (density) out.density = { bricks: density.map((e) => ({ x: e.x, y: e.y, z: e.z, values: e.values as Int8Array })) }
  return out
}

/** One layer's list; null when absent, invalid, or empty once all-zero tiles are dropped. */
function checkList(c: Check, path: string, v: unknown, listKey: 'tiles' | 'bricks', kind: Kind, n: number, limits: number[]): Entry[] | null {
  if (!c.obj(path, v, true)) return null
  const brick = listKey === 'bricks'
  if ('type' in v || 'width' in v) {
    c.fail(path, `is a full raster (the old format); layers are now sparse: { ${listKey}: [{ x, ${brick ? 'y, ' : ''}z, data }] }`)
    return null
  }
  const list = v[listKey]
  if (!c.arr(`${path}.${listKey}`, list)) return null
  const axes = brick ? (['x', 'y', 'z'] as const) : (['x', 'z'] as const)
  const before = c.errors.length
  const seen = new Set<number>()
  const out: Entry[] = []
  list.forEach((t, i) => {
    const p = `${path}.${listKey}[${i}]`
    if (!c.obj(p, t)) return
    let ok = true
    axes.forEach((a, j) => { if (!c.num(`${p}.${a}`, t[a], { int: true, min: 0, max: limits[j]! - 1 })) ok = false })
    const values = valuesOf(c, p, t, kind, n)
    if (!ok || !values) return
    const x = t.x as number, z = t.z as number, y = brick ? (t.y as number) : 0
    const key = brick ? brickKey(x, y, z) : tileKey(x, z)
    if (seen.has(key)) { c.fail(p, `duplicate ${brick ? 'brick' : 'tile'} (${brick ? `${x}, ${y}, ${z}` : `${x}, ${z}`})`); return }
    seen.add(key)
    if (values.some((s) => s !== 0)) out.push({ x, y, z, values, path: p })
  })
  if (c.errors.length > before || out.length === 0) return null
  out.sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)
  return out
}

function valuesOf(c: Check, p: string, t: Record<string, unknown>, kind: Kind, n: number): LayerValues | null {
  if (t.values !== undefined) {
    if (t.values instanceof CTORS[kind] && t.values.length === n) return t.values
    c.fail(`${p}.values`, `must be ${NAMES[kind]} of ${n} values`)
    return null
  }
  if (typeof t.data !== 'string') { c.fail(`${p}.data`, t.data === undefined ? 'is required' : 'must be a base64 string'); return null }
  try {
    return decodeValues(kind, t.data, n)
  } catch (e) {
    c.fail(`${p}.data`, e instanceof RangeError ? e.message : 'must be a base64 string')
    return null
  }
}
