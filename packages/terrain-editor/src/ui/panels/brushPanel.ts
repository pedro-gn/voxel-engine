import { RADIUS_MAX, RADIUS_MIN, type BrushSettings } from '../../core/brush.ts'
import { BRUSH_TOOLS, type BrushMode } from '../../core/brushes.ts'
import { biomeColor, cssColor } from '../brushes/colors.ts'
import { PANEL_STYLE, h } from './dom.ts'

export interface BrushPanelState { mode: BrushMode; tool: string; settings: BrushSettings; biomes: readonly string[]; biome: number }
export interface BrushPanelActions { tool(tool: string): void; settings(s: Partial<BrushSettings>): void; biome(k: number): void }

const TITLES: Record<BrushMode, string> = { height: 'Height brush', biome: 'Biome brush', density: 'Density brush' }
const HINTS: Record<BrushMode, string> = {
  height: 'LMB paint · Ctrl lowers · [ ] radius',
  biome: 'LMB paint · [ ] radius',
  density: 'LMB paint · Ctrl carves · Shift keeps the depth · [ ] radius',
}

/** A labelled slider plus number box; set() updates both without firing their events. */
function numberRow(key: string, label: string, min: number, max: number, step: number, input: (v: number) => void) {
  const range = h('input', { type: 'range', id: `brush-${key}`, min: String(min), max: String(max), step: String(step), style: { flex: '1', minWidth: '0' } })
  const box = h('input', { type: 'number', id: `brush-${key}-box`, min: String(min), max: String(max), step: String(step), style: { width: '64px' } })
  range.addEventListener('input', () => input(Number(range.value)))
  box.addEventListener('change', () => {
    const v = Number(box.value)
    if (box.value.trim() !== '' && Number.isFinite(v)) input(v)
  })
  const el = h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
    h('span', { textContent: label, style: { width: '70px', flex: 'none' } }), range, box)
  return {
    el,
    set(v: number) {
      range.value = String(v)
      if (document.activeElement !== box) box.value = String(Math.round(v * 100) / 100)
    },
  }
}

/** The brush settings, shown instead of the inspector in a brush mode. */
export function createBrushPanel(parent: HTMLElement, actions: BrushPanelActions): { el: HTMLElement; render(s: BrushPanelState): void; setError(message: string): void } {
  const title = h('div', { style: { fontWeight: '600' } })
  const tools = h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } })
  const radius = numberRow('radius', 'radius', RADIUS_MIN, RADIUS_MAX, 1, (v) => actions.settings({ radius: v }))
  const strength = numberRow('strength', 'strength', 0, 1, 0.05, (v) => actions.settings({ strength: v }))
  const falloff = numberRow('falloff', 'falloff', 0, 1, 0.05, (v) => actions.settings({ falloff: v }))
  const biome = h('select', { id: 'brush-biome', style: { flex: '1', minWidth: '0' } })
  biome.addEventListener('change', () => actions.biome(Number(biome.value)))
  const biomeRow = h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
    h('span', { textContent: 'biome', style: { width: '70px', flex: 'none' } }), biome)
  const hint = h('div', { style: { opacity: '0.7' } })
  const error = h('div', { id: 'brush-error', style: { color: '#ff8080', display: 'none' } })
  const el = h('div', { id: 'editor-brush', style: { ...PANEL_STYLE, display: 'none' } }, title, tools, radius.el, strength.el, falloff.el, biomeRow, hint, error)
  parent.append(el)

  let built = '' // the mode and biome names the buttons and options were built for
  return {
    el,
    setError(message) {
      error.textContent = message
      error.style.display = message ? 'block' : 'none'
    },
    render(s) {
      const key = `${s.mode}#${s.biomes.join('|')}`
      if (key !== built) {
        built = key
        title.textContent = TITLES[s.mode]
        hint.textContent = HINTS[s.mode]
        tools.replaceChildren(...BRUSH_TOOLS[s.mode].map((t) => {
          const b = h('button', { id: `brush-tool-${t}`, textContent: t })
          b.addEventListener('click', () => actions.tool(t))
          return b
        }))
        biome.replaceChildren(...s.biomes.map((name, i) => h('option', { value: String(i + 1), textContent: `● ${name}`, style: { color: cssColor(biomeColor(i + 1)) } })))
        const isBiome = s.mode === 'biome'
        strength.el.style.display = isBiome ? 'none' : 'flex'
        falloff.el.style.display = isBiome ? 'none' : 'flex'
        biomeRow.style.display = isBiome ? 'flex' : 'none'
      }
      for (const b of Array.from(tools.children) as HTMLElement[]) {
        const on = b.id === `brush-tool-${s.tool}`
        b.style.fontWeight = on ? '700' : '400'
        b.style.background = on ? '#ffd27a' : ''
      }
      radius.set(s.settings.radius)
      strength.set(s.settings.strength)
      falloff.set(s.settings.falloff)
      biome.value = String(s.biome)
    },
  }
}
