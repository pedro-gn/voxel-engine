export type EngineErrorCode = 'not-isolated' | 'no-gpu' | 'fatal'

export class EngineError extends Error {
  readonly code: EngineErrorCode
  constructor(code: EngineErrorCode, message: string) {
    super(message)
    this.name = 'EngineError'
    this.code = code
  }
}

/** Covers the canvas with a readable message. Text only, so error details can't inject markup. */
export function showErrorScreen(canvas: HTMLCanvasElement, title: string, detail: string): HTMLElement {
  const host = canvas.parentElement ?? document.body
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
  const el = document.createElement('div')
  el.className = 'elovox-error'
  el.setAttribute('role', 'alert')
  Object.assign(el.style, {
    position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', padding: '24px', zIndex: '10',
    background: 'rgba(20, 22, 26, 0.85)', color: '#f3f4f6', font: '14px/1.5 system-ui, sans-serif',
  })
  const box = document.createElement('div')
  box.style.maxWidth = '560px'
  const h = document.createElement('h2')
  h.textContent = title
  h.style.margin = '0 0 8px'
  const p = document.createElement('p')
  p.textContent = detail
  p.style.margin = '0'
  box.append(h, p)
  el.append(box)
  host.append(el)
  return el
}
