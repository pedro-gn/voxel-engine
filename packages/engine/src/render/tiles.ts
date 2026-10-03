export const TILE = 64

/** Validates the `tileSize` engine option: a power of two in [16, 1024]. Returns it unchanged. */
export function checkTileSize(n: number): number {
  if (!Number.isInteger(n) || n < 16 || n > 1024 || (n & (n - 1)) !== 0) {
    throw new RangeError(`tileSize must be a power of two in [16, 1024], got ${n}`)
  }
  return n
}

export function checkerTile(size = TILE): Uint8Array {
  const px = new Uint8Array(size * size * 4)
  const cell = Math.max(1, size >> 3)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const on = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 0
    px.set(on ? [255, 0, 255, 255] : [0, 0, 0, 255], (y * size + x) * 4)
  }
  return px
}

/**
 * Bleeds the colour of opaque texels into neighbouring transparent ones, `passes` texels deep, so GPU-averaged
 * mip levels of cutout tiles don't pull in the black of transparent texels (dark fringes). Alpha is untouched.
 */
export function dilateAlpha(px: Uint8Array, size = TILE, passes = 4): Uint8Array {
  const out = px.slice()
  let filled = new Uint8Array(size * size)
  for (let i = 0; i < size * size; i++) filled[i] = out[i * 4 + 3]! >= 128 ? 1 : 0
  for (let p = 0; p < passes; p++) {
    const src = out.slice()
    const next = filled.slice()
    let changed = false
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x
      if (filled[i]) continue
      let r = 0, g = 0, b = 0, n = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        const j = ((y + dy + size) % size) * size + ((x + dx + size) % size)
        if (!filled[j]) continue
        r += src[j * 4]!; g += src[j * 4 + 1]!; b += src[j * 4 + 2]!; n++
      }
      if (n === 0) continue
      out[i * 4] = Math.round(r / n); out[i * 4 + 1] = Math.round(g / n); out[i * 4 + 2] = Math.round(b / n)
      next[i] = 1
      changed = true
    }
    filled = next
    if (!changed) break
  }
  return out
}

export interface PackedTiles { data: Uint8Array; layers: number; layerOf: Map<string, number>; missing: string[] }

export function packTiles(names: readonly string[], pixels: (name: string) => Uint8Array | null, size = TILE): PackedTiles {
  const bytes = size * size * 4
  const present: [string, Uint8Array][] = []
  const missing: string[] = []
  for (const n of names) {
    const px = pixels(n)
    if (!px) { missing.push(n); continue }
    if (px.length !== bytes) throw new Error(`texture "${n}": expected ${bytes} bytes, got ${px.length}`)
    present.push([n, px])
  }
  const layers = present.length + 1
  const data = new Uint8Array(layers * bytes)
  data.set(checkerTile(size), 0)
  const layerOf = new Map<string, number>()
  const row = size * 4
  present.forEach(([n, px], i) => {
    const base = (i + 1) * bytes
    for (let y = 0; y < size; y++) data.set(px.subarray(y * row, (y + 1) * row), base + (size - 1 - y) * row)
    layerOf.set(n, i + 1)
  })
  return { data, layers, layerOf, missing }
}
