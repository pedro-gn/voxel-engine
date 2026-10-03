/** Swatch colours for biome values (1-based), cycling. */
const BIOME_COLORS = [0x5cb85c, 0xe8c468, 0x9c7b5b, 0x8fc1e3, 0xe57fa7, 0xf0a04b, 0x9b86d1, 0x4fb3a6]

export function biomeColor(k: number): number { return BIOME_COLORS[(Math.max(1, k) - 1) % BIOME_COLORS.length]! }

export function cssColor(c: number): string { return `#${c.toString(16).padStart(6, '0')}` }

/** The tint of a height delta: white at 0, blue down, red up, full at ±8 blocks. */
export function heightColor(blocks: number): number {
  const t = Math.min(1, Math.abs(blocks) / 8)
  const fade = (c: number) => Math.round(255 + (c - 255) * t)
  const [r, g, b] = blocks < 0 ? [fade(40), fade(110), fade(230)] : [fade(230), fade(70), fade(50)]
  return (r << 16) | (g << 8) | b
}
