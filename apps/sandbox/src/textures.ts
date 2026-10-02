type Paint = (ctx: CanvasRenderingContext2D, rand: () => number) => void

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296
}

function tile(seed: number, paint: Paint): string {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  paint(c.getContext('2d')!, lcg(seed))
  return c.toDataURL('image/png')
}

function speckle(ctx: CanvasRenderingContext2D, r: () => number, base: string, spots: string[], count: number, size: number): void {
  ctx.fillStyle = base
  ctx.fillRect(0, 0, 64, 64)
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = spots[Math.floor(r() * spots.length)]!
    const s = Math.max(1, Math.round(size * (0.5 + r())))
    ctx.fillRect(Math.floor(r() * 64), Math.floor(r() * 64), s, s)
  }
}

export function paintTextures(): Record<string, string> {
  return {
    stone: tile(1, (c, r) => speckle(c, r, '#8f959e', ['#7e848d', '#a5abb3', '#737981'], 140, 6)),
    dirt: tile(2, (c, r) => speckle(c, r, '#7a4f33', ['#6a432b', '#8b5d3d', '#5e3a25'], 160, 5)),
    grass_top: tile(3, (c, r) => speckle(c, r, '#6fae3f', ['#7fc04a', '#5f9b35', '#8ccf55'], 240, 4)),
    grass_side: tile(4, (c, r) => {
      speckle(c, r, '#7a4f33', ['#6a432b', '#8b5d3d'], 120, 5)
      c.fillStyle = '#6fae3f'
      for (let x = 0; x < 64; x += 4) c.fillRect(x, 0, 4, 12 + Math.floor(r() * 10))
    }),
    sand: tile(5, (c, r) => speckle(c, r, '#dcc98f', ['#cfba7c', '#e8d8a3', '#c9b06e'], 200, 3)),
    log_top: tile(6, (c) => {
      c.fillStyle = '#a07a4a'
      c.fillRect(0, 0, 64, 64)
      c.strokeStyle = '#7d5a33'
      c.lineWidth = 3
      for (let rr = 6; rr < 32; rr += 7) { c.beginPath(); c.arc(32, 32, rr, 0, Math.PI * 2); c.stroke() }
    }),
    log_side: tile(7, (c, r) => {
      c.fillStyle = '#6e4b2a'
      c.fillRect(0, 0, 64, 64)
      c.fillStyle = '#5a3c21'
      for (let x = 0; x < 64; x += 6) c.fillRect(x + Math.floor(r() * 3), 0, 2, 64)
    }),
    planks: tile(8, (c, r) => {
      for (let y = 0; y < 64; y += 16) {
        c.fillStyle = r() < 0.5 ? '#b48a55' : '#a87f4c'
        c.fillRect(0, y, 64, 15)
        c.fillStyle = '#7d5a33'
        c.fillRect(0, y + 15, 64, 1)
      }
    }),
    leaves: tile(9, (c, r) => {
      speckle(c, r, '#4f8f35', ['#5fa040', '#3f7a2a', '#6bb04a'], 220, 5)
      for (let i = 0; i < 60; i++) c.clearRect(Math.floor(r() * 64), Math.floor(r() * 64), 3, 3)
    }),
    glass: tile(10, (c) => {
      c.fillStyle = 'rgba(215, 236, 255, 0.22)'
      c.fillRect(0, 0, 64, 64)
      c.strokeStyle = 'rgba(255, 255, 255, 0.85)'
      c.lineWidth = 4
      c.strokeRect(2, 2, 60, 60)
    }),
    water: tile(11, (c, r) => {
      c.fillStyle = 'rgba(64, 140, 210, 0.78)'
      c.fillRect(0, 0, 64, 64)
      c.fillStyle = 'rgba(160, 210, 245, 0.55)'
      for (let i = 0; i < 18; i++) c.fillRect(Math.floor(r() * 56), Math.floor(r() * 64), 8, 2)
    }),
    rock: tile(13, (c, r) => speckle(c, r, '#8a8f99', ['#7b808a', '#9aa0aa', '#6f7580'], 90, 9)),
    torch: tile(12, (c) => {
      c.clearRect(0, 0, 64, 64)
      c.fillStyle = '#6e4b2a'
      c.fillRect(28, 26, 8, 38)
      c.fillStyle = '#ffb02e'
      c.fillRect(26, 12, 12, 14)
      c.fillStyle = '#fff3a0'
      c.fillRect(29, 15, 6, 8)
    }),
  }
}
