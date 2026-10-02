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
  return { ...out, ...HAND_PAINTED }
}

/** Hand-painted tiles (512 px, in public/textures) that replace the painter's versions. */
const HAND_PAINTED: Record<string, string> = {
  grass_top: '/textures/grass_top.png',
  grass_side: '/textures/grass_side.png',
  stone: '/textures/stone.png',
}
