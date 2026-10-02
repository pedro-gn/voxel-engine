import type { Effects, Engine } from '@elovox/engine'

const EFFECTS: (keyof Effects)[] = ['shadows', 'decorations', 'water', 'post', 'fog']

/** Preset buttons and per-effect toggles, top right. */
export function createControls(engine: Engine): () => void {
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
  document.body.append(el)
  return () => el.remove()
}
