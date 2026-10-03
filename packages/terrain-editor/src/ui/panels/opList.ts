import type { OpRegistry, ShapeKind, TerrainDoc } from '@elovox/terrain'
import { PANEL_STYLE, h } from './dom.ts'

export interface OpListActions {
  select(id: string): void
  toggle(id: string, on: boolean): void
  move(id: string, delta: number): void
  add(type: string, kind: ShapeKind): void
}

export function createOpList(parent: HTMLElement, registry: OpRegistry, actions: OpListActions): { el: HTMLElement; render(doc: TerrainDoc, selected: string | null, failed: string | null): void } {
  const add = h('select', { id: 'editor-add', title: 'Add an op at the centre of the view' },
    h('option', { value: '', textContent: '+ add op…' }),
    ...registry.types().flatMap((type) => registry.get(type)!.shapes.map((kind) => h('option', { value: `${type}:${kind}`, textContent: `${type} (${kind})` }))))
  add.addEventListener('change', () => {
    const [type, kind] = add.value.split(':')
    add.value = ''
    if (type && kind) actions.add(type, kind as ShapeKind)
  })
  const list = h('div', { id: 'editor-ops', style: { display: 'grid', gap: '2px', maxHeight: '50vh', overflowY: 'auto' } })
  const el = h('div', { id: 'editor-oplist', style: PANEL_STYLE }, add, list)
  parent.append(el)

  const small = (text: string, title: string, disabled: boolean, fn: () => void) => {
    const b = h('button', { textContent: text, title, disabled, style: { padding: '0 4px' } })
    b.addEventListener('click', (e) => { e.stopPropagation(); fn() })
    return b
  }

  return {
    el,
    render(doc, selected, failed) {
      list.replaceChildren(...doc.ops.map((op, i) => {
        const box = h('input', { type: 'checkbox', checked: op.enabled, title: 'enabled (H)' })
        // Selecting re-renders the list; doing it on click would detach the box before its change fires.
        box.addEventListener('click', (e) => e.stopPropagation())
        box.addEventListener('change', () => { actions.toggle(op.id, box.checked); actions.select(op.id) })
        const row = h('div', {
          dataset: { op: op.id },
          style: {
            display: 'flex', gap: '6px', alignItems: 'center', padding: '2px 4px', borderRadius: '4px', cursor: 'pointer',
            background: op.id === selected ? 'rgba(255, 176, 32, 0.35)' : 'transparent',
            color: op.id === failed ? '#c62828' : 'inherit', opacity: op.enabled ? '1' : '0.55',
          },
        },
        box,
        h('span', { textContent: op.id, style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }),
        h('span', { textContent: op.type, style: { opacity: '0.6' } }),
        small('↑', 'earlier', i === 0, () => actions.move(op.id, -1)),
        small('↓', 'later', i === doc.ops.length - 1, () => actions.move(op.id, 1)))
        row.addEventListener('click', () => actions.select(op.id))
        return row
      }))
    },
  }
}
