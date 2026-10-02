export interface LayerMesh { vertices: Uint32Array; indices: Uint32Array }

const PATTERNS = [
  [0, 1, 2, 0, 2, 3], // diagonal 0–2, normal winding
  [0, 2, 1, 0, 3, 2], // diagonal 0–2, reversed
  [1, 2, 3, 1, 3, 0], // diagonal 1–3, normal
  [1, 3, 2, 1, 0, 3], // diagonal 1–3, reversed
] as const

export class QuadBuilder {
  private v: Uint32Array
  private idx: Uint32Array
  private quads = 0

  constructor(initialQuads = 256) {
    this.v = new Uint32Array(initialQuads * 8)
    this.idx = new Uint32Array(initialQuads * 6)
  }

  get quadCount(): number { return this.quads }

  push(a: ArrayLike<number>, b: ArrayLike<number>, flip: boolean, reverse: boolean): void {
    if ((this.quads + 1) * 8 > this.v.length) this.grow()
    const vo = this.quads * 8
    const base = this.quads * 4
    for (let k = 0; k < 4; k++) {
      this.v[vo + k * 2] = a[k]!
      this.v[vo + k * 2 + 1] = b[k]!
    }
    const p = PATTERNS[(flip ? 2 : 0) + (reverse ? 1 : 0)]!
    const io = this.quads * 6
    for (let k = 0; k < 6; k++) this.idx[io + k] = base + p[k]!
    this.quads++
  }

  build(): LayerMesh | null {
    if (this.quads === 0) return null
    return { vertices: this.v.slice(0, this.quads * 8), indices: this.idx.slice(0, this.quads * 6) }
  }

  reset(): void { this.quads = 0 }

  private grow(): void {
    const v = new Uint32Array(this.v.length * 2)
    v.set(this.v)
    this.v = v
    const idx = new Uint32Array(this.idx.length * 2)
    idx.set(this.idx)
    this.idx = idx
  }
}
