import { EDITOR_MODES, type EditorMode } from '../../core/brushes.ts'
import { h } from './dom.ts'

const LABELS: Record<EditorMode, string> = { ops: 'Ops', height: 'Height', biome: 'Biome', density: 'Density' }

/** The editor's mode tabs: Ops and the three brushes (keys 1–4). */
export function createModeTabs(parent: HTMLElement, select: (m: EditorMode) => void): { el: HTMLElement; render(mode: EditorMode): void } {
  const buttons = EDITOR_MODES.map((m, i) => {
    const b = h('button', { id: `editor-mode-${m}`, textContent: LABELS[m], title: `${LABELS[m]} (${i + 1})` })
    b.addEventListener('click', () => select(m))
    return b
  })
  const el = h('div', { id: 'editor-modes', style: { display: 'flex', gap: '4px' } }, ...buttons)
  parent.append(el)
  return {
    el,
    render(mode) {
      EDITOR_MODES.forEach((m, i) => {
        const b = buttons[i]!
        const on = m === mode
        b.style.fontWeight = on ? '700' : '400'
        b.style.background = on ? '#ffd27a' : ''
        b.setAttribute('aria-pressed', String(on))
      })
    },
  }
}
