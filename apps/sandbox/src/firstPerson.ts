import { AIR, type Engine } from '@elovox/engine'

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

export interface FirstPersonUi {
  toggle(): void
  /** Digs / places along the crosshair; false when nothing was submitted (no hit, refused, or not allowed here). */
  dig(): boolean
  place(): boolean
  dispose(): void
}

const GATED = ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'contextmenu'] as const

/**
 * C toggles first person (pointer lock), shows a crosshair and hint, and routes canvas pointer events to
 * first person only: a capture-phase window listener stops them before the orbit, dig/highlight and units
 * handlers. `edits`: dig/place from the crosshair (off in the units scenes).
 */
export function createFirstPerson(engine: Engine, canvas: HTMLCanvasElement, o: { edits: boolean; voxel: () => number }): FirstPersonUi {
  const fp = engine.firstPerson
  const active = () => engine.cameraMode === 'firstPerson'
  const locked = () => document.pointerLockElement === canvas
  const lock = () => { void Promise.resolve(canvas.requestPointerLock()).catch(() => {}) }
  const centreHit = () => engine.raycast(fp.eye(), fp.forward(), REACH)

  const crosshair = document.createElement('div')
  crosshair.id = 'crosshair'
  Object.assign(crosshair.style, {
    position: 'fixed', left: '50%', top: '50%', width: '16px', height: '16px', transform: 'translate(-50%, -50%)',
    background: 'linear-gradient(#fff, #fff) center / 2px 16px no-repeat, linear-gradient(#fff, #fff) center / 16px 2px no-repeat',
    mixBlendMode: 'difference', pointerEvents: 'none', zIndex: '6', display: 'none',
  })
  const hint = document.createElement('div')
  hint.id = 'fp-hint'
  Object.assign(hint.style, {
    position: 'fixed', left: '50%', bottom: '12px', transform: 'translateX(-50%)', padding: '6px 10px', borderRadius: '6px',
    background: 'rgba(255, 255, 255, 0.82)', color: '#1b1f24', font: '12px/1.4 ui-monospace, Menlo, Consolas, monospace',
    whiteSpace: 'pre', textAlign: 'center', pointerEvents: 'none', zIndex: '6', display: 'none',
  })
  const HINT = `C orbit · WASD walk · Shift sprint · Space jump/swim${o.edits ? ' · LMB dig · RMB place' : ''} · Esc free mouse`
  const render = () => {
    const on = active()
    crosshair.style.display = on ? 'block' : 'none'
    hint.style.display = on ? 'block' : 'none'
    hint.textContent = on && !locked() ? `click to look
${HINT}` : HINT
  }
  document.body.append(crosshair, hint)

  const dig = () => {
    if (!active() || !o.edits) return false
    const hit = centreHit()
    if (!hit) return false
    engine.submit({ type: 'setBlock', pos: hit.pos, voxel: AIR })
    return true
  }
  const place = () => {
    if (!active() || !o.edits) return false
    const p = placementTarget(centreHit(), (x, y, z) => engine.layout.inBounds(x, y, z), (x, y, z) => fp.cellOverlapsBody(x, y, z))
    if (!p) return false
    engine.submit({ type: 'setBlock', pos: p, voxel: o.voxel() })
    return true
  }
  const toggle = () => {
    if (active()) {
      if (locked()) document.exitPointerLock()
      engine.setCameraMode('orbit')
      engine.setHighlight(null)
    } else {
      engine.setCameraMode('firstPerson')
      lock()
    }
    render()
  }
  const gate = (e: Event) => {
    if (!active() || e.target !== canvas) return
    e.stopPropagation()
    if (e.type === 'wheel' || e.type === 'contextmenu') { e.preventDefault(); return }
    if (e.type !== 'pointerdown') return
    if (!locked()) { lock(); return } // the click that takes the mouse back never digs
    const button = (e as PointerEvent).button
    if (button === 0) dig()
    else if (button === 2) place()
  }
  const key = (e: KeyboardEvent) => { if (isModeKey(e, document.activeElement as FocusLike | null)) toggle() }
  const offFrame = engine.on('frame', () => { if (active() && o.edits) engine.setHighlight(centreHit()?.pos ?? null) })
  for (const t of GATED) window.addEventListener(t, gate, { capture: true, passive: false })
  window.addEventListener('keydown', key)
  document.addEventListener('pointerlockchange', render)
  render()
  return {
    toggle, dig, place,
    dispose() {
      offFrame()
      for (const t of GATED) window.removeEventListener(t, gate, { capture: true })
      window.removeEventListener('keydown', key)
      document.removeEventListener('pointerlockchange', render)
      crosshair.remove(); hint.remove()
    },
  }
}
