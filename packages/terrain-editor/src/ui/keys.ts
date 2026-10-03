export type Action = 'undo' | 'redo' | 'delete' | 'duplicate' | 'toggle' | 'cancel' | 'save'

export interface KeyLike { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }

/** The editor action for a key press. While a text field has focus (`typing`) only save and cancel apply. */
export function actionFor(e: KeyLike, typing: boolean): Action | null {
  const mod = e.ctrlKey || e.metaKey
  const k = e.key.toLowerCase()
  if (mod && k === 's') return 'save'
  if (k === 'escape') return 'cancel'
  if (typing) return null
  if (mod && k === 'z') return e.shiftKey ? 'redo' : 'undo'
  if (mod && k === 'y') return 'redo'
  if (mod && k === 'd') return 'duplicate'
  if (mod || e.altKey) return null
  if (k === 'delete' || k === 'backspace') return 'delete'
  if (k === 'h') return 'toggle'
  return null
}

const NOT_TEXT = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'color'])

/** Whether keys belong to a form field rather than the editor. */
export function isTyping(el: { tagName: string; type?: string; isContentEditable?: boolean } | null): boolean {
  if (!el) return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  return el.tagName === 'INPUT' && !NOT_TEXT.has(el.type ?? 'text')
}
