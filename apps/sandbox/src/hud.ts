import type { Engine } from '@elovox/engine'

export function createHud(engine: Engine, getSelected: () => string, sceneName: string, o: { corner?: 'top' | 'bottom'; hint?: string } = {}): () => void {
  const el = document.createElement('div')
  el.id = 'hud'
  Object.assign(el.style, {
    position: 'fixed', left: '12px', padding: '10px 12px', borderRadius: '8px',
    background: 'rgba(255, 255, 255, 0.82)', color: '#1b1f24', font: '12px/1.45 ui-monospace, Menlo, Consolas, monospace',
    whiteSpace: 'pre', pointerEvents: 'none', zIndex: '5',
  }, o.corner === 'bottom' ? { bottom: '12px' } : { top: '12px' })
  document.body.append(el)
  const render = () => {
    const s = engine.stats()
    el.textContent = [
      `[${sceneName}] fps ${s.fps.toFixed(0)}   frame ${s.frameMs.toFixed(1)} ms   [${s.backend}]   gpu ${s.gpuMs === null ? '—' : s.gpuMs.toFixed(2) + ' ms'}`,
      `tick ${s.tick}   ${s.tickMs.toFixed(2)} ms`,
      ...(s.workers ? [`units ${s.workers.units}   tasks ${s.workers.tasks}   searches ${s.workers.searches}   work ${s.workers.visited}   writes ${s.workers.mutations}   nav ${(s.workers.navBytes / 1048576).toFixed(2)} MiB`] : []),
      ...(sceneName === 'collapse' ? [`collapse checks ${s.collapseChecks}   fragments ${s.collapseFragments}   cells ${s.collapseCells}   visited ${s.collapseVisited}   writes ${s.collapseMutations}`] : []),
      `mesh queue ${s.meshQueue}   in flight ${s.meshInFlight}   failed ${s.failedChunks}`,
      `slots ${s.slotsUsed}   meshes ${s.meshes}   draws ${s.drawCalls}`,
      `decorations ${s.decorationInstances} instances   ${s.decorationDraws} draws   shadow casters ${s.shadowCasters}`,
      `physics  water tiles ${s.waterTiles}   columns ${s.waterColumns}   jobs ${s.regionJobs}   falling ${s.fallingBodies}   ${s.physicsBusy ? 'busy' : 'settled'}   water apply ${s.waterApplyMs.toFixed(2)} ms (p95 ${s.waterApplyP95.toFixed(2)}) · bodies ${s.waterBodies}${s.waterLayersHidden !== 0 ? ` · hidden ${s.waterLayersHidden}` : ''}`,
      o.hint ?? (sceneName === 'workers' ? 'LMB select · Shift add / area · RMB move · tools designate work · Escape clear' : `block [${getSelected()}]   1–0 select · LMB dig · RMB place · WASD/edges pan · RMB-drag rotate · wheel zoom · V bean walk`),
    ].join('\n')
  }
  render()
  const timer = setInterval(render, 250)
  return () => { clearInterval(timer); el.remove() }
}
