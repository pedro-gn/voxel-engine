import { hashId, tileFbm, tileNoise, worley } from './noise.ts'
import { SIZE, createLayer, disc, hex, mixRgb, paint, scaleRgb, vary, wrap, type Layer, type RGB, type Rand } from './raster.ts'
import type { ShadeOptions } from './shade.ts'

interface Courses { rows: readonly number[]; minW: number; maxW: number; gap: number; round: number; mortar: RGB; mortarH: number; lift?: number }

/** Rows of bricks/plates (row heights sum to SIZE) with random widths and a random shift per row; everything wraps. */
function courses(l: Layer, r: Rand, c: Courses, colour: (r: Rand) => RGB): void {
  let y0 = 0
  for (const rh of c.rows) {
    const widths: number[] = []
    let sum = 0
    while (sum < SIZE) {
      let w = Math.round(c.minW + r() * (c.maxW - c.minW))
      if (SIZE - sum - w < c.minW) w = SIZE - sum
      widths.push(w)
      sum += w
    }
    let x0 = Math.floor(r() * SIZE)
    for (const w of widths) {
      const col = colour(r), tilt = (r() - 0.5) * 0.3, lift = c.lift ? (r() - 0.5) * c.lift : 0
      for (let yy = 0; yy < rh; yy++) for (let xx = 0; xx < w; xx++) {
        const i = wrap(x0 + xx, y0 + yy)
        const e = Math.min(xx + 0.5, w - xx - 0.5, yy + 0.5, rh - yy - 0.5)
        if (e < c.gap) { paint(l, i, c.mortar, c.mortarH); continue }
        const s = Math.min(1, (e - c.gap) / c.round)
        paint(l, i, col, 0.45 + 0.4 * s * s * (3 - 2 * s) + tilt * (xx / w - 0.5) + lift)
      }
      x0 += w
    }
    y0 += rh
  }
}

/** Fine surface grain on height and colour. */
function roughen(l: Layer, seed: number, amount: number): void {
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y), n = tileNoise(seed, x, y, 16) - 0.5
    l.height[i]! += n * amount
    for (let c = 0; c < 3; c++) l.color[i * 3 + c]! *= 1 + n * amount * 0.8
  }
}

export function stone(r: Rand): Layer {
  const base = hex('#7f8a9c')
  const l = createLayer(base)
  courses(l, r, { rows: [21, 22, 21], minW: 18, maxW: 40, gap: 1.6, round: 6, mortar: hex('#4b5260'), mortarH: 0.1, lift: 0.12 }, (r) => vary(base, r, 0.14))
  roughen(l, 11, 0.08)
  return l
}

export function dirt(r: Rand): Layer {
  const l = createLayer(hex('#6b3f2a'), 0.4)
  const pebbles = [hex('#8a5a3c'), hex('#5a3424'), hex('#7a6250')]
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y), n = tileFbm(21, x, y, 8, 3)
    paint(l, i, scaleRgb(hex('#6b3f2a'), 0.85 + n * 0.3), 0.3 + n * 0.3)
    const c = worley(22, x, y, 8)
    if (c.d < 0.32 && hashId(c.id) < 0.35) paint(l, i, vary(pebbles[c.id % 3]!, r, 0.03), 0.55 + 0.4 * (1 - c.d / 0.32))
  }
  return l
}

export function grassTop(r: Rand): Layer {
  const base = hex('#5fa03a')
  const l = createLayer(base, 0.45)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const n = tileFbm(31, x, y, 8, 3)
    paint(l, wrap(x, y), scaleRgb(base, 0.85 + n * 0.3), 0.4 + n * 0.15)
  }
  const greens = ['#7cc04a', '#4f8a2e', '#8fd157', '#6aae3f'].map(hex)
  for (let s = 0; s < 260; s++) {
    const x0 = r() * SIZE, y0 = r() * SIZE, ang = r() * Math.PI * 2, len = 4 + r() * 5, w = 1.2 + r() * 0.6
    const col = vary(greens[Math.floor(r() * greens.length)]!, r, 0.06)
    for (let t = 0; t <= 1; t += 0.12) {
      disc(x0 + Math.cos(ang) * len * t, y0 + Math.sin(ang) * len * t, w * (1 - t * 0.7), (i, d) => paint(l, i, col, 0.55 + 0.35 * (1 - t) - 0.1 * d))
    }
  }
  return l
}

export function grassSide(r: Rand): Layer {
  const l = dirt(r)
  const green = hex('#5fa03a'), dark = hex('#3f7a2a')
  const drips = Array.from({ length: 9 }, () => ({ x: r() * SIZE, w: 2 + r() * 3, len: 4 + r() * 9 }))
  for (let x = 0; x < SIZE; x++) {
    const base = 9 + tileNoise(41, x, 0, 8, 1) * 6
    let depth = base
    for (const d of drips) {
      const dx = Math.min(Math.abs(x + 0.5 - d.x), SIZE - Math.abs(x + 0.5 - d.x))
      if (dx < d.w) depth = Math.max(depth, base + d.len * Math.sqrt(1 - (dx / d.w) ** 2))
    }
    for (let y = 0; y < depth; y++) {
      const t = y / depth
      paint(l, wrap(x, y), mixRgb(green, dark, t * 0.5), 0.7 - 0.2 * t)
    }
  }
  return l
}

export function sand(_r: Rand): Layer {
  const base = hex('#d8b77a')
  const l = createLayer(base)
  const tones = [hex('#e3c78f'), hex('#c9a566'), hex('#d2b073')]
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y), n = tileFbm(51, x, y, 4, 3)
    paint(l, i, scaleRgb(base, 0.9 + n * 0.2), 0.4 + n * 0.2)
    const c = worley(52, x, y, 8)
    if (c.d < 0.36 && hashId(c.id) < 0.4) paint(l, i, scaleRgb(tones[c.id % tones.length]!, 0.9 + n * 0.2), 0.55 + 0.35 * (1 - c.d / 0.36))
    const g = (tileNoise(53, x, y, 16) - 0.5) * 0.08
    for (let k = 0; k < 3; k++) l.color[i * 3 + k]! *= 1 + g
  }
  return l
}

export function logSide(_r: Rand): Layer {
  const l = createLayer(hex('#6e4b2a'))
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const n = tileNoise(61, x, y, 16, 2), n2 = tileNoise(62, x, y, 32, 4)
    const groove = n < 0.32
    paint(l, wrap(x, y), groove ? hex('#4a3019') : scaleRgb(hex('#6e4b2a'), 0.85 + 0.3 * n2), groove ? 0.1 : 0.35 + 0.5 * n + 0.15 * n2)
  }
  return l
}

export function logTop(_r: Rand): Layer {
  const l = createLayer(hex('#c49a63'))
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y)
    const d = Math.hypot(x + 0.5 - 32, y + 0.5 - 32)
    const wob = tileNoise(71, x, y, 8) * 1.5
    if (d > 28) { paint(l, i, scaleRgb(hex('#5a3c21'), 0.9 + 0.2 * wob), 0.5 + 0.15 * wob); continue }
    const ring = ((d + wob) / 4.5) % 1
    paint(l, i, ring < 0.22 ? hex('#9a6f40') : scaleRgb(hex('#c49a63'), 0.95 + 0.1 * wob), ring < 0.22 ? 0.35 : 0.6)
  }
  return l
}

export function planks(r: Rand): Layer {
  const base = hex('#b48a55')
  const l = createLayer(base)
  courses(l, r, { rows: [16, 16, 16, 16], minW: 30, maxW: 34, gap: 0.8, round: 1.5, mortar: hex('#5e4026'), mortarH: 0.05 }, (r) => vary(base, r, 0.08))
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y), g = tileNoise(111, x, y, 2, 32)
    l.height[i]! += (g - 0.5) * 0.2
    for (let c = 0; c < 3; c++) l.color[i * 3 + c]! *= 0.9 + g * 0.2
  }
  return l
}

export function leaves(_r: Rand): Layer {
  const l = createLayer(hex('#4f8f35'), 0.3)
  const greens = ['#5fa040', '#3f7a2a', '#6bb04a', '#4f8f35'].map(hex)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y), c = worley(81, x, y, 8)
    if (c.d < 0.42) {
      const k = 1 - c.d / 0.42
      paint(l, i, scaleRgb(greens[c.id % greens.length]!, 0.85 + 0.25 * k), 0.4 + 0.5 * k, 1)
    } else if (tileNoise(82, x, y, 8) < 0.5) {
      paint(l, i, hex('#2f5a20'), 0.05, 0)
    } else {
      paint(l, i, hex('#2f5a20'), 0.15, 1)
    }
  }
  return l
}

export function rock(_r: Rand): Layer {
  const l = createLayer(hex('#8e939c'))
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const n = tileFbm(91, x, y, 4, 4), c = worley(92, x, y, 4)
    const crack = c.d2 - c.d < 0.06
    paint(l, wrap(x, y), mixRgb(hex('#7f8796'), hex('#a3a8b0'), n), 0.35 + 0.45 * n - (crack ? 0.3 : 0))
  }
  return l
}

export function snow(_r: Rand): Layer {
  const base = hex('#eef3f8')
  const l = createLayer(base, 0.5)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y), n = tileFbm(121, x, y, 4, 3), c = worley(122, x, y, 6)
    const drift = c.d < 0.4 ? (1 - c.d / 0.4) * 0.15 : 0
    paint(l, i, mixRgb(hex('#c9d6e6'), base, 0.55 + 0.45 * n), 0.4 + 0.3 * n + drift)
  }
  return l
}

export function gravel(r: Rand): Layer {
  const l = createLayer(hex('#6f6a64'), 0.3)
  const stones = ['#8c867e', '#7a746d', '#9b958c', '#66615b'].map(hex)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y), c = worley(131, x, y, 10)
    if (c.d < 0.38) paint(l, i, vary(stones[c.id % stones.length]!, r, 0.04), 0.45 + 0.5 * (1 - c.d / 0.38))
    else paint(l, i, hex('#4f4b46'), 0.15)
  }
  return l
}

/** Horizontal strata, 8 px per band; tones cycle through `tones`. Shared by both sandstones. */
function strata(seed: number, tones: readonly string[], line: string): Layer {
  const cols = tones.map(hex)
  const l = createLayer(cols[0]!)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y), band = Math.floor(y / 8), n = tileFbm(seed, x, y, 8, 3)
    const edge = y % 8 === 0 && tileNoise(seed + 1, x, band, 8, 8) < 0.7
    if (edge) { paint(l, i, hex(line), 0.25); continue }
    paint(l, i, scaleRgb(cols[band % cols.length]!, 0.9 + 0.2 * n), 0.45 + 0.25 * n)
  }
  return l
}

export function sandstone(_r: Rand): Layer {
  return strata(141, ['#d9b98a', '#cfa977', '#e2c597', '#c9a06c'], '#a8835a')
}

export function sandstoneRed(_r: Rand): Layer {
  return strata(151, ['#b8603f', '#a85536', '#c47050', '#9c4b2f'], '#7a3a24')
}

export function pineLeaves(_r: Rand): Layer {
  const l = createLayer(hex('#2f5e3a'), 0.3)
  const greens = ['#356b41', '#2a5534', '#3f7a4a', '#2f5e3a'].map(hex)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y), c = worley(161, x, y, 12)
    if (c.d < 0.45) {
      const k = 1 - c.d / 0.45
      paint(l, i, scaleRgb(greens[c.id % greens.length]!, 0.85 + 0.25 * k), 0.4 + 0.5 * k, 1)
    } else if (tileNoise(162, x, y, 8) < 0.45) {
      paint(l, i, hex('#1d3a24'), 0.05, 0)
    } else {
      paint(l, i, hex('#1d3a24'), 0.15, 1)
    }
  }
  return l
}

export function glass(_r: Rand): Layer {
  const l = createLayer(hex('#d7ecff'), 0.5, 0.22)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = wrap(x, y)
    if (x < 3 || x > 60 || y < 3 || y > 60) paint(l, i, hex('#ffffff'), 0.7, 0.85)
    else if (Math.abs(x - y - 10) < 2) paint(l, i, hex('#ffffff'), 0.5, 0.4)
  }
  return l
}

export function torch(_r: Rand): Layer {
  const l = createLayer(hex('#000000'), 0, 0)
  for (let y = 26; y < SIZE; y++) for (let x = 29; x <= 34; x++) paint(l, wrap(x, y), hex('#6e4b2a'), 0.6, 1)
  disc(32, 18, 7, (i, d) => paint(l, i, mixRgb(hex('#fff3a0'), hex('#ffb02e'), d), 0.8 - 0.3 * d, 1))
  return l
}

export function water(_r: Rand): Layer {
  const l = createLayer(hex('#3f9fd0'), 0.5, 0.8)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (tileNoise(101, x, y, 4, 16) > 0.62) paint(l, wrap(x, y), hex('#8fd3f0'), 0.6, 0.8)
  }
  return l
}

export const TILES: readonly (readonly [string, (r: Rand) => Layer, ShadeOptions])[] = [
  ['stone', stone, {}],
  ['dirt', dirt, {}],
  ['grass_top', grassTop, { highlight: 0.35 }],
  ['grass_side', grassSide, {}],
  ['sand', sand, {}],
  ['log_side', logSide, {}],
  ['log_top', logTop, {}],
  ['planks', planks, {}],
  ['leaves', leaves, {}],
  ['rock', rock, { highlight: 0.4 }],
  ['glass', glass, { cavity: 0, highlight: 0, baked: 0 }],
  ['torch', torch, { cavity: 0, baked: 0.1 }],
  ['water', water, { cavity: 0, highlight: 0.15 }],
  ['snow', snow, { highlight: 0.3 }],
  ['gravel', gravel, {}],
  ['sandstone', sandstone, {}],
  ['sandstone_red', sandstoneRed, {}],
  ['pine_leaves', pineLeaves, {}],
]
