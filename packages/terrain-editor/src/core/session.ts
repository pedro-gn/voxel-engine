import { validateTerrainDoc, type OpRegistry, type TerrainDoc } from '@elovox/terrain'
import { diffArea, type Area } from './area.ts'
import type { Edit } from './edits.ts'
import { History } from './history.ts'

export type Cause = 'edit' | 'gesture' | 'commit' | 'cancel' | 'undo' | 'redo' | 'open'

/** The document changed (or, for 'commit', a gesture ended). `area` is what the world must regenerate. */
export interface ChangeEvent { doc: TerrainDoc; prev: TerrainDoc; area: Area; cause: Cause }

export type EditResult = { ok: true } | { ok: false; errors: string[] }

export interface SessionOptions {
  worldHeight: number
  ops?: OpRegistry
  historyLimit?: number
}

const OK: EditResult = { ok: true }

/**
 * The document being edited. It is always valid: an edit that would make it invalid is refused and
 * changes nothing. Edits go through apply (one undo step) or a gesture (begin, any number of update,
 * then commit or cancel; one undo step).
 */
export class EditorSession {
  private readonly o: SessionOptions
  private readonly history: History
  private current: TerrainDoc
  private saved: TerrainDoc
  private sel: string | null = null
  private gesture: { label: string; start: TerrainDoc } | null = null
  private readonly changeFns = new Set<(e: ChangeEvent) => void>()
  private readonly selectFns = new Set<(id: string | null) => void>()

  constructor(doc: TerrainDoc, o: SessionOptions) {
    this.o = o
    this.history = new History(o.historyLimit)
    this.current = doc
    this.saved = doc
  }

  get doc(): TerrainDoc { return this.current }
  get selected(): string | null { return this.sel }
  /** The document differs from the last one saved or opened. */
  get dirty(): boolean { return this.current !== this.saved }
  get canUndo(): boolean { return this.history.canUndo }
  get canRedo(): boolean { return this.history.canRedo }
  get inGesture(): boolean { return this.gesture !== null }

  on(type: 'change', fn: (e: ChangeEvent) => void): () => void
  on(type: 'select', fn: (id: string | null) => void): () => void
  on(type: 'change' | 'select', fn: ((e: ChangeEvent) => void) | ((id: string | null) => void)): () => void {
    const set = (type === 'change' ? this.changeFns : this.selectFns) as Set<typeof fn>
    set.add(fn)
    return () => { set.delete(fn) }
  }

  /** Selects an op by id; an id the document does not have selects nothing. */
  select(id: string | null): void {
    const next = id !== null && this.current.ops.some((o) => o.id === id) ? id : null
    if (next === this.sel) return
    this.sel = next
    for (const fn of this.selectFns) fn(next)
  }

  /** Applies one edit as one undo step. */
  apply(label: string, edit: Edit): EditResult {
    if (this.gesture) throw new Error('a gesture is in progress')
    const r = this.attempt(edit(this.current))
    if (!r.ok) return r
    if (r.doc === this.current) return OK
    this.history.push({ label, before: this.current, after: r.doc })
    this.set(r.doc, 'edit')
    return OK
  }

  /** Starts a gesture (a drag, a slider): its updates become one undo step. */
  begin(label: string): void {
    if (this.gesture) throw new Error('a gesture is in progress')
    this.gesture = { label, start: this.current }
  }

  /** Replaces the gesture's result with `edit` applied to the document the gesture started from. */
  update(edit: Edit): EditResult {
    const g = this.gesture
    if (!g) throw new Error('no gesture in progress')
    const r = this.attempt(edit(g.start))
    if (!r.ok) return r
    if (r.doc !== this.current) this.set(r.doc, 'gesture')
    return OK
  }

  commit(): void {
    const g = this.gesture
    if (!g) return
    this.gesture = null
    if (this.current === g.start) return
    this.history.push({ label: g.label, before: g.start, after: this.current })
    this.emit({ doc: this.current, prev: g.start, area: this.area(g.start, this.current), cause: 'commit' })
  }

  cancel(): void {
    const g = this.gesture
    if (!g) return
    this.gesture = null
    if (this.current !== g.start) this.set(g.start, 'cancel')
  }

  /** Undoes the last step; during a gesture, cancels the gesture instead. */
  undo(): boolean {
    if (this.gesture) { this.cancel(); return true }
    const s = this.history.undo()
    if (!s) return false
    this.set(s.before, 'undo')
    return true
  }

  /** Redoes the last undone step; during a gesture, cancels the gesture instead. */
  redo(): boolean {
    if (this.gesture) { this.cancel(); return true }
    const s = this.history.redo()
    if (!s) return false
    this.set(s.after, 'redo')
    return true
  }

  /** Replaces the document (a file was opened): no history, nothing selected, saved. */
  open(doc: TerrainDoc): void {
    this.gesture = null
    this.history.clear()
    const prev = this.current
    this.current = doc
    this.saved = doc
    this.select(null)
    this.emit({ doc, prev, area: 'all', cause: 'open' })
  }

  markSaved(): void { this.saved = this.current }

  private attempt(doc: TerrainDoc): { ok: true; doc: TerrainDoc } | { ok: false; errors: string[] } {
    if (doc === this.current) return { ok: true, doc }
    const r = validateTerrainDoc(doc, { ops: this.o.ops, worldHeight: this.o.worldHeight })
    // Keep the candidate, not r.doc: validation rebuilds every op, and the candidate shares the unchanged ones.
    return r.ok ? { ok: true, doc } : r
  }

  private set(doc: TerrainDoc, cause: Cause): void {
    const prev = this.current
    this.current = doc
    if (this.sel !== null && !doc.ops.some((o) => o.id === this.sel)) this.select(null)
    this.emit({ doc, prev, area: this.area(prev, doc), cause })
  }

  private area(prev: TerrainDoc, next: TerrainDoc): Area {
    return diffArea(prev, next, { ops: this.o.ops, height: this.o.worldHeight })
  }

  private emit(e: ChangeEvent): void {
    for (const fn of this.changeFns) fn(e)
  }
}
