import type { PreviewStatus } from '../../core/preview.ts'
import { PANEL_STYLE, h } from './dom.ts'

export interface ToolbarState { fileName: string; dirty: boolean; canUndo: boolean; canRedo: boolean; status: PreviewStatus; showAll: boolean; showLayers: boolean }
export interface ToolbarActions { open(): void; save(): void; saveAs(): void; undo(): void; redo(): void; showAll(on: boolean): void; showLayers(on: boolean): void }

export function statusText(s: PreviewStatus): string {
  switch (s.state) {
    case 'busy': return 'updating…'
    case 'error': return `error: ${s.message}`
    case 'idle':
      if (!s.last) return 'ready'
      return `regen ${s.last.ms.toFixed(0)} ms · ${s.last.chunks} chunks · ${s.last.wallMs.toFixed(0)} ms to mesh` +
        (s.last.meshFrames === undefined ? '' : ` (meshing ${s.last.meshFrames} frames, ${(s.last.meshMs ?? 0).toFixed(0)} ms)`)
  }
}

export function createToolbar(parent: HTMLElement, actions: ToolbarActions): { el: HTMLElement; render(s: ToolbarState): void } {
  const button = (id: string, text: string, title: string, fn: () => void) => {
    const b = h('button', { id, textContent: text, title })
    b.addEventListener('click', fn)
    return b
  }
  const undo = button('editor-undo', 'Undo', 'Undo (Ctrl+Z)', actions.undo)
  const redo = button('editor-redo', 'Redo', 'Redo (Ctrl+Shift+Z)', actions.redo)
  const file = h('div', { id: 'editor-file', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } })
  const status = h('div', { id: 'editor-status', style: { whiteSpace: 'pre-wrap' } })
  const all = h('input', { type: 'checkbox', id: 'editor-showall' })
  all.addEventListener('change', () => actions.showAll(all.checked))
  const layers = h('input', { type: 'checkbox', id: 'editor-showlayers' })
  layers.addEventListener('change', () => actions.showLayers(layers.checked))
  const el = h('div', { id: 'editor-toolbar', style: PANEL_STYLE },
    h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
      button('editor-open', 'Open', 'Open a .terrain.json file', actions.open),
      button('editor-save', 'Save', 'Save (Ctrl+S)', actions.save),
      button('editor-saveas', 'Save as', 'Save to a new file', actions.saveAs),
      undo, redo),
    file, status,
    h('label', {}, all, ' show all ops'),
    h('label', {}, layers, ' show layers'))
  parent.append(el)
  return {
    el,
    render(s) {
      file.textContent = `${s.dirty ? '● ' : ''}${s.fileName}`
      file.title = s.dirty ? 'unsaved changes' : 'saved'
      undo.disabled = !s.canUndo
      redo.disabled = !s.canRedo
      status.textContent = statusText(s.status)
      status.style.color = s.status.state === 'error' ? '#c62828' : 'inherit'
      all.checked = s.showAll
      layers.checked = s.showLayers
    },
  }
}
