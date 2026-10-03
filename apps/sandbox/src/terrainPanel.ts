import type { Engine } from '@elovox/engine'

/** Side of the square the "regenerate" button rebuilds around the orbit target (the spec's editor budget case). */
const REGEN_SIDE = 128

/** Terrain scene panel, bottom right: generation times and a regenerate-around-view button. */
export function createTerrainPanel(engine: Engine): () => void {
  const el = document.createElement('div')
  el.id = 'terrain-panel'
  Object.assign(el.style, {
    position: 'fixed', right: '12px', bottom: '12px', padding: '10px 12px', borderRadius: '8px', display: 'grid', gap: '6px',
    background: 'rgba(255, 255, 255, 0.82)', color: '#1b1f24', font: '12px/1.4 ui-monospace, Menlo, Consolas, monospace', zIndex: '5',
  })
  const info = document.createElement('div')
  info.id = 'terrain-info'
  const { ms, columns } = engine.terrain.initial
  info.textContent = `generated ${columns} columns in ${ms.toFixed(0)} ms`
  const button = document.createElement('button')
  button.id = 'terrain-regen'
  button.textContent = `regenerate ${REGEN_SIDE}² around view`
  const last = document.createElement('div')
  last.id = 'terrain-last'
  button.addEventListener('click', async () => {
    const [sx, , sz] = engine.layout.size
    const t = engine.controls.current.target
    const x0 = Math.max(0, Math.min(sx - REGEN_SIDE, Math.round(t[0] - REGEN_SIDE / 2)))
    const z0 = Math.max(0, Math.min(sz - REGEN_SIDE, Math.round(t[2] - REGEN_SIDE / 2)))
    button.disabled = true
    const start = performance.now()
    try {
      const r = await engine.terrain.regenerate({ x0, z0, x1: x0 + REGEN_SIDE, z1: z0 + REGEN_SIDE })
      // Visible = the regenerated chunks are meshed; poll the mesh queue until it drains.
      while (engine.stats().meshQueue + engine.stats().meshInFlight > 0) await new Promise((res) => requestAnimationFrame(res))
      last.textContent = `regen: ${r.ms.toFixed(0)} ms in sim, ${(performance.now() - start).toFixed(0)} ms to mesh, ${r.chunks} chunks`
    } catch (e) {
      last.textContent = `regen failed: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      button.disabled = false
    }
  })
  el.append(info, button, last)
  document.body.append(el)
  return () => el.remove()
}
