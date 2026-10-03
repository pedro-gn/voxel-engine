import { perlin2, perlin3 } from './gradient.ts'

export interface Octaves {
  octaves: number
  /** Frequency multiplier per octave. */
  lacunarity: number
  /** Amplitude multiplier per octave. */
  gain: number
}

/** Each octave gets its own seed so octaves never line up. */
const OCTAVE_SEED = 1013

/** Fractal Brownian motion in [-1, 1]. */
export function fbm2(seed: number, x: number, z: number, o: Octaves): number {
  let sum = 0, amp = 1, freq = 1, norm = 0
  for (let i = 0; i < o.octaves; i++) {
    sum += amp * perlin2(seed + i * OCTAVE_SEED, x * freq, z * freq)
    norm += amp
    amp *= o.gain
    freq *= o.lacunarity
  }
  return sum / norm
}

/** Sharp crests where the noise crosses zero, in [0, 1]. Good for mountain ridges. */
export function ridged2(seed: number, x: number, z: number, o: Octaves): number {
  let sum = 0, amp = 1, freq = 1, norm = 0
  for (let i = 0; i < o.octaves; i++) {
    const r = 1 - Math.abs(perlin2(seed + i * OCTAVE_SEED, x * freq, z * freq))
    sum += amp * r * r
    norm += amp
    amp *= o.gain
    freq *= o.lacunarity
  }
  return sum / norm
}

/** Rounded bumps (|noise| folded), in [-1, 1]. */
export function billow2(seed: number, x: number, z: number, o: Octaves): number {
  let sum = 0, amp = 1, freq = 1, norm = 0
  for (let i = 0; i < o.octaves; i++) {
    sum += amp * (Math.abs(perlin2(seed + i * OCTAVE_SEED, x * freq, z * freq)) * 2 - 1)
    norm += amp
    amp *= o.gain
    freq *= o.lacunarity
  }
  return sum / norm
}

export function fbm3(seed: number, x: number, y: number, z: number, o: Octaves): number {
  let sum = 0, amp = 1, freq = 1, norm = 0
  for (let i = 0; i < o.octaves; i++) {
    sum += amp * perlin3(seed + i * OCTAVE_SEED, x * freq, y * freq, z * freq)
    norm += amp
    amp *= o.gain
    freq *= o.lacunarity
  }
  return sum / norm
}

export function ridged3(seed: number, x: number, y: number, z: number, o: Octaves): number {
  let sum = 0, amp = 1, freq = 1, norm = 0
  for (let i = 0; i < o.octaves; i++) {
    const r = 1 - Math.abs(perlin3(seed + i * OCTAVE_SEED, x * freq, y * freq, z * freq))
    sum += amp * r * r
    norm += amp
    amp *= o.gain
    freq *= o.lacunarity
  }
  return sum / norm
}

export function billow3(seed: number, x: number, y: number, z: number, o: Octaves): number {
  let sum = 0, amp = 1, freq = 1, norm = 0
  for (let i = 0; i < o.octaves; i++) {
    sum += amp * (Math.abs(perlin3(seed + i * OCTAVE_SEED, x * freq, y * freq, z * freq)) * 2 - 1)
    norm += amp
    amp *= o.gain
    freq *= o.lacunarity
  }
  return sum / norm
}
