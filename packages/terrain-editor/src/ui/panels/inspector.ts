import type { Edit } from '../../core/edits.ts'
import { PANEL_STYLE, h } from './dom.ts'
import { walkFields, type BoolField, type Field, type NumberField, type SelectField } from './fields.ts'

export interface InspectorActions {
  /** One undoable edit (a typed number, a select). */
  run(label: string, edit: Edit): void
  /** One step of a live gesture (a slider being dragged); endLive() ends it. */
  live(label: string, edit: Edit): void
  endLive(): void
}

const ERROR_COLOR = '#c62828'

function structureOf(fields: Field[]): string {
  return fields.map((f) => (f.kind === 'group' ? `${f.path}{${structureOf(f.fields)}}` : `${f.kind}:${f.path}`)).join('|')
}

export function createInspector(parent: HTMLElement, actions: InspectorActions): {
  el: HTMLElement
  render(title: string, fields: Field[], errorPrefix: string): void
  setErrors(errors: string[]): void
} {
  const title = h('div', { style: { fontWeight: '600' } })
  const top = h('div', { style: { color: ERROR_COLOR, whiteSpace: 'pre-wrap' } })
  const body = h('div', { style: { display: 'grid', gap: '4px' } })
  const el = h('div', { id: 'editor-inspector', style: { ...PANEL_STYLE, overflowY: 'auto', maxHeight: 'calc(100vh - 80px)' } }, title, top, body)
  parent.append(el)

  let structure = ''
  let prefix = ''
  let errors: string[] = []
  const current = new Map<string, Field>() // the latest field for each path; handlers read it at event time
  const sync = new Map<string, (f: Field) => void>()
  const slots = new Map<string, HTMLElement>()
  const latest = <F extends Field>(path: string) => current.get(path) as F

  function label(text: string) {
    return h('span', { textContent: text, style: { width: '86px', flex: 'none', overflow: 'hidden', textOverflow: 'ellipsis' } })
  }

  function build(f: Field): HTMLElement {
    const slot = h('div', { style: { color: ERROR_COLOR, whiteSpace: 'pre-wrap' } })
    slots.set(f.path, slot)
    const row = (...children: Node[]) => h('div', {}, h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, ...children), slot)
    switch (f.kind) {
      case 'group':
        return h('details', { open: f.path !== 'shape.points' && !f.path.startsWith('shape.points[') },
          h('summary', { textContent: f.label, style: { cursor: 'pointer' } }),
          h('div', { style: { display: 'grid', gap: '4px', paddingLeft: '10px' } }, ...f.fields.map(build)),
          slot)
      case 'number': {
        const range = h('input', { type: 'range', min: String(f.min), max: String(f.max), step: String(f.step), style: { flex: '1', minWidth: '0' } })
        const box = h('input', { type: 'number', step: String(f.step), style: { width: '64px' } })
        const set = (g: NumberField) => {
          range.value = String(g.value ?? g.placeholder ?? g.min)
          if (document.activeElement !== box) box.value = g.value === undefined ? '' : String(g.value)
          box.placeholder = g.placeholder === undefined ? '' : String(g.placeholder)
        }
        set(f)
        sync.set(f.path, (g) => set(g as NumberField))
        range.addEventListener('input', () => { const g = latest<NumberField>(f.path); actions.live(g.label, g.edit(Number(range.value))) })
        // Chrome fires no change when a slider is released at its starting value
        range.addEventListener('change', () => actions.endLive())
        range.addEventListener('pointerup', () => actions.endLive())
        range.addEventListener('keyup', () => actions.endLive())
        box.addEventListener('change', () => {
          const g = latest<NumberField>(f.path)
          const raw = box.value.trim()
          if (raw === '' && !g.optional) { set(g); return }
          const v = raw === '' ? undefined : Number(raw)
          if (v !== undefined && !Number.isFinite(v)) { set(g); return }
          actions.run(g.label, g.edit(v))
        })
        return row(label(f.label), range, box)
      }
      case 'select': {
        const sel = h('select', { style: { flex: '1', minWidth: '0' } }, ...f.options.map((o) => h('option', { value: o.value, textContent: o.label })))
        const set = (g: SelectField) => { sel.value = g.value }
        set(f)
        sync.set(f.path, (g) => set(g as SelectField))
        sel.addEventListener('change', () => { const g = latest<SelectField>(f.path); actions.run(g.label, g.edit(sel.value)) })
        return row(label(f.label), sel)
      }
      case 'bool': {
        const box = h('input', { type: 'checkbox' })
        const set = (g: BoolField) => { box.checked = g.value }
        set(f)
        sync.set(f.path, (g) => set(g as BoolField))
        box.addEventListener('change', () => { const g = latest<BoolField>(f.path); actions.run(g.label, g.edit(box.checked)) })
        return row(label(f.label), box)
      }
    }
  }

  /** Shows each error under the deepest field its path falls in; the rest at the top. */
  function showErrors(): void {
    for (const s of slots.values()) s.textContent = ''
    const unmatched: string[] = []
    for (const e of errors) {
      const cut = e.indexOf(': ')
      const path = cut < 0 ? e : e.slice(0, cut)
      const message = cut < 0 ? '' : e.slice(cut + 2)
      const local = prefix !== '' && path.startsWith(prefix) ? path.slice(prefix.length) : path
      let best: string | null = null
      for (const p of slots.keys()) {
        const inside = local === p || local.startsWith(`${p}.`) || local.startsWith(`${p}[`)
        if (inside && (best === null || p.length > best.length)) best = p
      }
      if (best === null) unmatched.push(e)
      else slots.get(best)!.textContent += `${message}\n`
    }
    top.textContent = unmatched.join('\n')
  }

  return {
    el,
    render(t, fields, errorPrefix) {
      title.textContent = t
      prefix = errorPrefix
      current.clear()
      walkFields(fields, (f) => current.set(f.path, f))
      const s = `${t}#${structureOf(fields)}`
      if (s === structure) {
        walkFields(fields, (f) => sync.get(f.path)?.(f))
      } else {
        structure = s
        sync.clear()
        slots.clear()
        body.replaceChildren(...fields.map(build))
      }
      showErrors()
    },
    setErrors(e) {
      errors = e
      showErrors()
    },
  }
}
