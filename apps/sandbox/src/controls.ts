import type { Effects, Engine } from '@elovox/engine'

const EFFECTS: (keyof Effects)[] = ['shadows', 'decorations', 'water', 'post', 'fog']

/** Preset buttons and per-effect toggles, top right. `collapsed` starts them folded under a summary. */
export function createControls(engine: Engine, o: { collapsed?: boolean } = {}): () => void {
  const el = document.createElement('div')
  el.id = 'controls'
  Object.assign(el.style, {
    position: 'fixed', top: '12px', right: '12px', padding: '10px 12px', borderRadius: '8px', display: 'grid', gap: '6px',
    background: 'rgba(255, 255, 255, 0.82)', color: '#1b1f24', font: '12px/1.4 ui-monospace, Menlo, Consolas, monospace', zIndex: '5',
  })
  const presets = document.createElement('div')
  presets.style.display = 'flex'
  presets.style.gap = '4px'
  for (const name of engine.atmosphere.presetNames()) {
    const b = document.createElement('button')
    b.id = `preset-${name}`
    b.textContent = name
    b.addEventListener('click', () => engine.atmosphere.set(name, { duration: 1.5 }))
    presets.append(b)
  }
  el.append(presets)
  for (const fx of EFFECTS) {
    const label = document.createElement('label')
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.id = `fx-${fx}`
    box.checked = engine.effects[fx]
    box.addEventListener('change', () => { engine.effects = { [fx]: box.checked } })
    label.append(box, ` ${fx}`)
    el.append(label)
  }
  // View distance in blocks (Quality.viewDistance); empty is Infinity.
  const view = document.createElement('label')
  const input = document.createElement('input')
  input.id = 'view-distance'
  input.type = 'number'; input.min = '64'; input.max = '4096'; input.step = '32'; input.placeholder = '∞'
  input.style.width = '6em'
  const shown = () => Number.isFinite(engine.quality.viewDistance) ? String(engine.quality.viewDistance) : ''
  input.value = shown()
  // An R set elsewhere (?view=, the engine API) shows here too, except while the field is being edited.
  engine.on('frame', () => { if (document.activeElement !== input && input.value !== shown()) input.value = shown() })
  input.addEventListener('change', () => {
    const v = input.value.trim() === '' ? Infinity : Number(input.value)
    try { engine.quality = { viewDistance: v } } catch { input.value = shown() }
  })
  view.append('view ', input)
  el.append(view)
  if (o.collapsed) {
    const details = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = 'atmosphere & effects'
    summary.style.cursor = 'pointer'
    details.append(summary, ...[...el.childNodes])
    details.style.display = 'grid'
    details.style.gap = '6px'
    el.append(details)
  }
  document.body.append(el)
  return () => el.remove()
}
