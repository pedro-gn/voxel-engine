import type { Engine } from '@elovox/engine'

export function createHud(engine: Engine, getSelected: () => string, sceneName: string): () => void {
  const el = document.createElement('div')
  el.id = 'hud'
  Object.assign(el.style, {
    position: 'fixed', top: '12px', left: '12px', padding: '10px 12px', borderRadius: '8px',
    background: 'rgba(255, 255, 255, 0.82)', color: '#1b1f24', font: '12px/1.45 ui-monospace, Menlo, Consolas, monospace',
    whiteSpace: 'pre', pointerEvents: 'none', zIndex: '5',
  })
  document.body.append(el)
  const render = () => {
    const s = engine.stats()
    el.textContent = [
      `[${sceneName}] fps ${s.fps.toFixed(0)}   frame ${s.frameMs.toFixed(1)} ms   [${s.backend}]`,
      `tick ${s.tick}   ${s.tickMs.toFixed(2)} ms`,
      `mesh queue ${s.meshQueue}   in flight ${s.meshInFlight}   failed ${s.failedChunks}`,
      `slots ${s.slotsUsed}   meshes ${s.meshes}   draws ${s.drawCalls}`,
      `block [${getSelected()}]   1–9 select · LMB dig · RMB place · WASD/edges pan · RMB-drag rotate · wheel zoom`,
    ].join('\n')
  }
  render()
  const timer = setInterval(render, 250)
  return () => { clearInterval(timer); el.remove() }
}
