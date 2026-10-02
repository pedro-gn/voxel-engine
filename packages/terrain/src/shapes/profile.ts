/**
 * Cross-section profiles: map `edge` (0 at the centre or axis, 1 at the shape's edge) to a strength
 * in [0, 1]. Every profile is 0 for edge >= 1.
 *  - linear: a cone / V
 *  - round:  a dome / U (circular arc)
 *  - smooth: smoothstep, flat top and soft foot
 *  - flat:   full strength up to the edge
 *  - box:    full strength to 0.75, then a steep smooth wall
 */
export type Profile = 'linear' | 'round' | 'smooth' | 'flat' | 'box'
export const PROFILES: readonly Profile[] = ['linear', 'round', 'smooth', 'flat', 'box']

export function smoothstep01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t
  return c * c * (3 - 2 * c)
}

export function profile(p: Profile, edge: number): number {
  if (edge >= 1) return 0
  const e = edge < 0 ? 0 : edge
  switch (p) {
    case 'linear': return 1 - e
    case 'round': return Math.sqrt(1 - e * e)
    case 'smooth': return smoothstep01(1 - e)
    case 'flat': return 1
    case 'box': return e < 0.75 ? 1 : smoothstep01((1 - e) / 0.25)
  }
}
