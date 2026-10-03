import type { Engine } from '@elovox/engine'

/** Side of the square the benchmark bump covers (the spec's regeneration budget case). */
const REGEN_SIDE = 128
/** Give up waiting for the mesh queue to drain after this long. */
const MESH_DRAIN_TIMEOUT_MS = 10_000

/**
 * Terrain scene panel, bottom right: generation times and a button that toggles a 6-block bump over
 * 128² around the view, then reports how long the regeneration took to reach the screen.
 */
export function createTerrainPanel(engine: Engine, doc: { ops: unknown[] }): () => void {
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
  button.textContent = `toggle a ${REGEN_SIDE}² bump around view`
  const last = document.createElement('div')
  last.id = 'terrain-last'
  /** Where the bump is while it is on. */
  let bump: { x0: number; z0: number } | null = null
  button.addEventListener('click', async () => {
    const [sx, , sz] = engine.layout.size
    const t = engine.controls.current.target
    const at = bump ?? {
      x0: Math.max(0, Math.min(sx - REGEN_SIDE, Math.round(t[0] - REGEN_SIDE / 2))),
      z0: Math.max(0, Math.min(sz - REGEN_SIDE, Math.round(t[2] - REGEN_SIDE / 2))),
    }
    const rect = { x0: at.x0, z0: at.z0, x1: at.x0 + REGEN_SIDE, z1: at.z0 + REGEN_SIDE }
    const op = {
      id: 'regen-benchmark-bump', type: 'hills', enabled: true,
      shape: { kind: 'polygon', points: [[rect.x0, rect.z0], [rect.x1 - 1, rect.z0], [rect.x1 - 1, rect.z1 - 1], [rect.x0, rect.z1 - 1]] },
      params: { amplitude: 0, offset: 6 },
    }
    button.disabled = true
    const start = performance.now()
    try {
      await engine.terrain.setDocument(bump ? doc : { ...doc, ops: [...doc.ops, op] })
      const r = await engine.terrain.regenerate(rect)
      bump = bump ? null : at
      // Visible = the regenerated chunks are meshed; poll the mesh queue until it drains.
      const drainStart = performance.now()
      const busy = () => engine.stats().meshQueue + engine.stats().meshInFlight > 0
      while (busy() && performance.now() - drainStart < MESH_DRAIN_TIMEOUT_MS) await new Promise((res) => requestAnimationFrame(res))
      last.textContent = busy()
        ? `regen: ${r.ms.toFixed(0)} ms in sim, mesh still queued after ${MESH_DRAIN_TIMEOUT_MS / 1000} s`
        : `regen: ${r.ms.toFixed(0)} ms in sim, ${(performance.now() - start).toFixed(0)} ms to mesh, ${r.chunks} chunks`
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
