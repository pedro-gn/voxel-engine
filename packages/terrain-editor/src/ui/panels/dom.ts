type Props<K extends keyof HTMLElementTagNameMap> =
  Omit<Partial<HTMLElementTagNameMap[K]>, 'style' | 'dataset'> & { style?: Partial<CSSStyleDeclaration>; dataset?: Record<string, string> }

/** Creates an element with properties, inline style, data attributes and children. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props<K>, ...children: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  const { style, dataset, ...rest } = props ?? {}
  Object.assign(el, rest)
  if (style) Object.assign(el.style, style)
  if (dataset) Object.assign(el.dataset, dataset)
  for (const c of children) if (c !== null && c !== false && c !== undefined) el.append(c)
  return el
}

/** The look of every editor panel (matches the sandbox panels). */
export const PANEL_STYLE: Partial<CSSStyleDeclaration> = {
  padding: '10px 12px', borderRadius: '8px', display: 'grid', gap: '6px',
  background: 'rgba(255, 255, 255, 0.88)', color: '#1b1f24', font: '12px/1.4 ui-monospace, Menlo, Consolas, monospace',
}
