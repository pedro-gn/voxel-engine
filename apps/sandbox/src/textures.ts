import { paintTiles } from './paint/index.ts'

/** The painter's tiles as PNG data URLs, the format createEngine's `textures` option takes. */
export function paintTextures(): Record<string, string> {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext('2d')!
  const out: Record<string, string> = {}
  for (const [name, px] of Object.entries(paintTiles())) {
    ctx.putImageData(new ImageData(new Uint8ClampedArray(px), 64, 64), 0, 0)
    out[name] = canvas.toDataURL('image/png')
  }
  return out
}
