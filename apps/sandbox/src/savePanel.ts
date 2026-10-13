import type { Engine, SaveResult, SlotInfo } from '@elovox/engine'
import type { Autosave } from './autosave.ts'

const MB = (n: number) => `${(n / 1048576).toFixed(1)} MB`
const BUTTON = { padding: '3px 8px', border: '1px solid #bcc7b9', borderRadius: '5px', background: '#f6f8f1', color: '#233027', cursor: 'pointer', font: 'inherit' }

/** Saves panel, toggled by P: save as, the slot list (load, delete), autosave on/off and storage use. Slot names are user text: textContent only. */
export function createSavePanel(engine: Engine, o: { save(slot: string): Promise<SaveResult>; autosave: Autosave; load(slot: string): void }): { toggle(): void; refresh(): Promise<void> } {
  const el = document.createElement('div')
  el.id = 'save-panel'
  el.setAttribute('aria-label', 'Saves')
  Object.assign(el.style, {
    position: 'fixed', top: '12px', right: '12px', width: '360px', maxHeight: '70vh', overflow: 'auto', padding: '10px 12px', borderRadius: '8px',
    background: 'rgba(255, 255, 255, 0.92)', color: '#1b1f24', font: '12px/1.45 ui-monospace, Menlo, Consolas, monospace', zIndex: '12', display: 'none',
  })
  const title = document.createElement('div'); title.textContent = 'Saves (P)'; title.style.fontWeight = 'bold'
  const storage = document.createElement('div'); storage.style.color = '#55606a'
  const form = document.createElement('div'); Object.assign(form.style, { display: 'flex', gap: '6px', margin: '8px 0' })
  const name = document.createElement('input'); name.placeholder = 'save name'; name.maxLength = 40
  Object.assign(name.style, { flex: '1', font: 'inherit', padding: '3px 6px' })
  const saveAs = document.createElement('button'); saveAs.textContent = 'Save as…'; Object.assign(saveAs.style, BUTTON)
  form.append(name, saveAs)
  const status = document.createElement('div'); status.style.minHeight = '1.45em'; status.style.whiteSpace = 'pre-wrap'
  const auto = document.createElement('label'); auto.style.display = 'block'; auto.style.margin = '6px 0'
  const autoBox = document.createElement('input'); autoBox.type = 'checkbox'; autoBox.checked = o.autosave.enabled
  auto.append(autoBox, document.createTextNode(' Autosave every 5 min'))
  autoBox.addEventListener('change', () => { o.autosave.enabled = autoBox.checked })
  const list = document.createElement('div')
  el.append(title, storage, form, status, auto, list)
  document.body.append(el)

  let slots: SlotInfo[] = []
  const say = (text: string) => { status.textContent = text }
  const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)

  async function refresh(): Promise<void> {
    try {
      const est = await engine.saves.estimate()
      storage.textContent = est ? `storage: ${MB(est.usage)} used of ${MB(est.quota)}` : 'storage: unknown'
      slots = (await engine.saves.list()).sort((a, b) => b.created.localeCompare(a.created))
    } catch (e) { say(errorText(e)); slots = [] }
    list.replaceChildren(...slots.map(row))
  }

  function row(s: SlotInfo): HTMLElement {
    const r = document.createElement('div')
    Object.assign(r.style, { display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 0', borderTop: '1px solid #e3e7e0' })
    const text = document.createElement('div'); text.style.flex = '1'
    const slotName = document.createElement('div'); slotName.textContent = s.slot; slotName.style.fontWeight = 'bold'
    const info = document.createElement('div'); info.style.color = '#55606a'
    info.textContent = `${String(s.meta.scene ?? '?')} · ${s.size[0]}×${s.size[2]} · ${new Date(s.created).toLocaleString()} · ${MB(s.bytes)}`
    text.append(slotName, info)
    const load = document.createElement('button'); load.textContent = 'Load'; Object.assign(load.style, BUTTON)
    load.addEventListener('click', () => o.load(s.slot))
    const del = document.createElement('button'); del.textContent = 'Delete'; Object.assign(del.style, BUTTON)
    del.addEventListener('click', async () => {
      if (!confirm(`Delete "${s.slot}"?`)) return
      try { await engine.saves.delete(s.slot); say(`Deleted "${s.slot}"`) } catch (e) { say(errorText(e)) }
      await refresh()
    })
    r.append(text, load, del)
    return r
  }

  saveAs.addEventListener('click', async () => {
    const slot = name.value.trim()
    if (!slot) { say('Type a name first'); return }
    if (slots.some(s => s.slot === slot) && !confirm(`Overwrite "${slot}"?`)) return
    saveAs.disabled = true; say(`Saving "${slot}"…`)
    try {
      const r = await o.save(slot)
      say(`Saved "${slot}" in ${r.totalMs.toFixed(0)} ms (sim stall ${r.simStallMs.toFixed(1)} ms, ${MB(r.bytes)})`)
    } catch (e) {
      say(`Save failed: ${errorText(e)}`)
    } finally { saveAs.disabled = false }
    await refresh()
  })

  const toggle = () => {
    const open = el.style.display === 'none'
    el.style.display = open ? 'block' : 'none'
    if (open) void refresh()
  }
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (e.key === 'p' || e.key === 'P') toggle()
  })
  return { toggle, refresh }
}
