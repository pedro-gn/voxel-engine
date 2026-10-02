/**
 * Faces whose projected u runs against the viewer's right unless negated (FACE order: +X −X +Y −Y +Z −Z).
 * Without the flip, asymmetric tiles read mirrored on +X and −Z faces. The chunk shader is built from this table.
 */
export const FLIP_U: readonly boolean[] = [true, false, false, false, false, true]

/** The (u, v) the chunk shader computes for a local position on face f. RepeatWrapping makes negative u fine. */
export function faceUV(f: number, x: number, y: number, z: number): [number, number] {
  const axis = f >> 1
  const [u, v] = axis === 0 ? [z, y] : axis === 1 ? [x, z] : [x, y]
  return [FLIP_U[f] ? -u : u, v]
}
