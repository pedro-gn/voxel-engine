/** Occlusion count for one vertex (0 = open, 3 = fully occluded). */
export function vertexAO(side1: boolean, side2: boolean, corner: boolean): number {
  if (side1 && side2) return 3
  return (side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner ? 1 : 0)
}

/**
 * True → split the quad along the c1–c3 diagonal.
 * Equivalent to the spec's "ao0 + ao2 < ao1 + ao3" written in brightness terms.
 */
export function flipDiagonal(o0: number, o1: number, o2: number, o3: number): boolean {
  return o0 + o2 > o1 + o3
}

/** Brightness multiplier by occlusion count, shared with the shader. */
export const AO_CURVE: readonly number[] = [1, 0.78, 0.62, 0.48]
