import * as THREE from 'three/webgpu'
import { TILE, packTiles, dilateAlpha } from './tiles.ts'

export async function loadTilePixels(url: string, size = TILE): Promise<Uint8Array | null> {
  try {
    const blob = await (await fetch(url)).blob()
    const bmp = await createImageBitmap(blob, { resizeWidth: size, resizeHeight: size, resizeQuality: 'high' })
    const canvas = new OffscreenCanvas(size, size)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    bmp.close()
    return new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer)
  } catch (err) {
    console.warn(`[elovox] could not load texture ${url}:`, err)
    return null
  }
}

/** Every source image is resized to `size` × `size` (so tiles of any resolution can be mixed). */
export async function buildTextureArray(textures: Record<string, string>, names: string[], size = TILE) {
  const loaded = new Map<string, Uint8Array | null>(
    await Promise.all(names.map(async (n) => {
      const px = textures[n] ? await loadTilePixels(textures[n]!, size) : null
      return [n, px ? dilateAlpha(px, size) : null] as const
    })),
  )
  const packed = packTiles(names, (n) => loaded.get(n) ?? null, size)
  for (const n of packed.missing) console.warn(`[elovox] missing texture "${n}" — using the checker layer`)
  const texture = new THREE.DataArrayTexture(packed.data, size, size, packed.layers)
  texture.format = THREE.RGBAFormat
  texture.type = THREE.UnsignedByteType
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 8
  texture.needsUpdate = true
  return { texture, layerOf: packed.layerOf, missing: packed.missing }
}
