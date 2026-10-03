import { describe, expect, it } from 'vitest'
import { biomeColor, cssColor, heightColor } from '../src/ui/brushes/colors.ts'

describe('brush colours', () => {
  it('gives each biome a swatch, cycling after eight', () => {
    expect(biomeColor(1)).not.toBe(biomeColor(2))
    expect(biomeColor(9)).toBe(biomeColor(1))
    expect(cssColor(0x0a0b0c)).toBe('#0a0b0c')
  })

  it('tints the height delta from white to blue (down) or red (up), full at 8 blocks', () => {
    expect(heightColor(0)).toBe(0xffffff)
    expect(heightColor(8)).toBe(0xe64632)
    expect(heightColor(-20)).toBe(0x286ee6)
  })
})
