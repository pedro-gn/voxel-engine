export const TILE = 64

export function checkerTile(size = TILE): Uint8Array {
  const px = new Uint8Array(size * size * 4)
  const cell = Math.max(1, size >> 3)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const on = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 0
    px.set(on ? [255, 0, 255, 255] : [0, 0, 0, 255], (y * size + x) * 4)
  }
  return px
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
