import type { Engine } from '@elovox/engine'
import type { WanderStats } from './scenes/sky.ts'

/** The island's highest layer, where PageDown starts the cut. */
const CUT_START = 60

/**
 * The sky scene's controls (game hooks demo): PageUp/PageDown move the layer cut, End clears it, Home resets the camera;
 * a time-of-day slider; the wander system's publication.
 */
export function createSkyPanel(engine: Engine): { readonly stats: WanderStats | null; dispose(): void } {
  let stats: WanderStats | null = null
  const box = document.createElement('div')
  box.setAttribute('aria-label', 'Sky island controls')
  Object.assign(box.style, {
    position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: '12px', padding: '10px 12px', borderRadius: '8px', zIndex: '6',
    background: 'rgba(255, 255, 255, 0.86)', color: '#1b1f24', font: '12px/1.5 ui-monospace, Menlo, Consolas, monospace', minWidth: '260px',
  })
  const label = document.createElement('label'); label.textContent = 'time of day '
  const slider = document.createElement('input')
  Object.assign(slider, { type: 'range', min: '0', max: '0.999', step: '0.001', value: '0.4' })
  slider.setAttribute('aria-label', 'Time of day')
  label.append(slider)
  const info = document.createElement('div'); info.style.whiteSpace = 'pre'
  box.append(label, info)
  document.body.append(box)
  const render = () => {
    const t = engine.atmosphere.timeOfDay
    const clock = t === null ? 'preset' : `${String(Math.floor(t * 24)).padStart(2, '0')}:${String(Math.floor((t * 24 % 1) * 60)).padStart(2, '0')}`
    info.textContent = [
      `time ${clock}   cut ${engine.view.cutY ?? 'off'}`,
      stats ? `wander: ${stats.units} units · dug ${stats.dug} · built ${stats.built} · died ${stats.died}` : 'wander: …',
      'PgUp/PgDn cut · End clear · Home camera',
    ].join('\n')
  }
  const setTime = () => { engine.atmosphere.setTimeOfDay(Number(slider.value)); render() }
  slider.addEventListener('input', setTime)
  setTime()
  const off = engine.on('system', (p) => { if (p.name === 'wander') stats = p.payload as WanderStats })
  const timer = setInterval(render, 250)
  const key = (e: KeyboardEvent) => {
    const top = engine.layout.size[1] - 1, cut = engine.view.cutY
    if (e.key === 'PageDown') engine.view.cut(Math.max(0, (cut ?? CUT_START + 1) - 1))
    else if (e.key === 'PageUp') engine.view.cut(cut === null || cut >= top ? null : cut + 1)
    else if (e.key === 'End') engine.view.cut(null)
    else if (e.key === 'Home') engine.controls.reset()
    else return
    e.preventDefault(); render()
  }
  window.addEventListener('keydown', key)
  return { get stats() { return stats }, dispose() { off(); clearInterval(timer); window.removeEventListener('keydown', key); box.remove() } }
}
