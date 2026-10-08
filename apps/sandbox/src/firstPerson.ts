/** First-person dig/place reach, blocks (spec 4d §6). */
export const REACH = 5

export interface KeyLike { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean }
export interface FocusLike { tagName: string; type?: string; isContentEditable?: boolean }
const NOT_TEXT = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'color'])

/** A bare C press (no modifier, not a repeat) while focus is not in a text field. */
export function isModeKey(e: KeyLike, focus: FocusLike | null): boolean {
  if (e.code !== 'KeyC' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false
  if (!focus) return true
  if (focus.isContentEditable || focus.tagName === 'TEXTAREA' || focus.tagName === 'SELECT') return false
  return !(focus.tagName === 'INPUT' && !NOT_TEXT.has(focus.type ?? 'text'))
}

type V3 = readonly [number, number, number]
/** The cell a placement on `hit` fills, or null: no hit, a hit from inside, outside the world, or into the player. */
export function placementTarget(
  hit: { readonly pos: V3; readonly normal: V3 } | null,
  inBounds: (x: number, y: number, z: number) => boolean,
  overlapsBody: (x: number, y: number, z: number) => boolean,
): [number, number, number] | null {
  if (!hit) return null
  const [nx, ny, nz] = hit.normal
  if (nx === 0 && ny === 0 && nz === 0) return null
  const x = hit.pos[0] + nx, y = hit.pos[1] + ny, z = hit.pos[2] + nz
  if (!inBounds(x, y, z) || overlapsBody(x, y, z)) return null
  return [x, y, z]
}
