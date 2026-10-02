/** Closed axis-aligned rectangle in world x/z: x0 <= x <= x1, z0 <= z <= z1. */
export interface Rect { x0: number; z0: number; x1: number; z1: number }
/** Closed box: a Rect plus y0 <= y <= y1. */
export interface Box extends Rect { y0: number; y1: number }

export function expandRect(r: Rect, by: number): Rect {
  return { x0: r.x0 - by, z0: r.z0 - by, x1: r.x1 + by, z1: r.z1 + by }
}

export function inRect(r: Rect, x: number, z: number): boolean {
  return x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1
}

/** Whether r overlaps the closed rectangle [x0, x1] × [z0, z1]. */
export function overlaps(r: Rect, x0: number, z0: number, x1: number, z1: number): boolean {
  return r.x0 <= x1 && r.x1 >= x0 && r.z0 <= z1 && r.z1 >= z0
}

export function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v }
