export type PackArray = Int32Array | Uint32Array | Int16Array | Uint16Array | Uint8Array
/** One save section: JSON for small structured state, typed arrays for bulk state. */
export interface Packed { json: unknown; arrays: Record<string, PackArray> }

const MAGIC = 0x4b505645 // 'EVPK' little endian
const TYPES = { Int32Array, Uint32Array, Int16Array, Uint16Array, Uint8Array } as const
type TypeName = keyof typeof TYPES
interface ArrayMeta { name: string; type: TypeName; length: number; offset: number }

const align4 = (n: number) => (n + 3) & ~3

/** [magic u32][header length u32][header JSON][pad to 4][arrays, each 4-aligned]. Array offsets count from the data start (after the pad). */
export function pack(p: Packed): Uint8Array {
  const metas: ArrayMeta[] = []
  let data = 0
  for (const [name, a] of Object.entries(p.arrays)) {
    metas.push({ name, type: a.constructor.name as TypeName, length: a.length, offset: data })
    data = align4(data + a.byteLength)
  }
  const header = new TextEncoder().encode(JSON.stringify({ json: p.json, arrays: metas }))
  const base = align4(8 + header.length)
  const out = new Uint8Array(base + data)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, MAGIC, true)
  dv.setUint32(4, header.length, true)
  out.set(header, 8)
  for (const m of metas) {
    const a = p.arrays[m.name]!
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), base + m.offset)
  }
  return out
}

export function unpack(bytes: Uint8Array): Packed {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 8 || dv.getUint32(0, true) !== MAGIC) throw new Error('not a packed section')
  const len = dv.getUint32(4, true)
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len))) as { json: unknown; arrays: ArrayMeta[] }
  const base = align4(8 + len)
  const arrays: Record<string, PackArray> = {}
  for (const m of head.arrays) {
    const T = TYPES[m.type]
    if (!T) throw new Error(`packed section: unknown array type ${m.type}`)
    // Copy into a fresh buffer: aligned, and the caller may keep or transfer it.
    const copy = bytes.slice(base + m.offset, base + m.offset + m.length * T.BYTES_PER_ELEMENT)
    arrays[m.name] = new T(copy.buffer, 0, m.length)
  }
  return { json: head.json, arrays }
}
