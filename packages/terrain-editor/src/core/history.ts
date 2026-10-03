import type { TerrainDoc } from '@elovox/terrain'

/** One undoable change: the documents before and after it. */
export interface Step { readonly label: string; readonly before: TerrainDoc; readonly after: TerrainDoc }

export class History {
  private readonly limit: number
  private readonly done: Step[] = []
  private readonly undone: Step[] = []

  constructor(limit = 200) { this.limit = limit }

  get canUndo(): boolean { return this.done.length > 0 }
  get canRedo(): boolean { return this.undone.length > 0 }

  push(step: Step): void {
    this.done.push(step)
    if (this.done.length > this.limit) this.done.shift()
    this.undone.length = 0
  }

  undo(): Step | null {
    const s = this.done.pop()
    if (!s) return null
    this.undone.push(s)
    return s
  }

  redo(): Step | null {
    const s = this.undone.pop()
    if (!s) return null
    this.done.push(s)
    return s
  }

  clear(): void {
    this.done.length = 0
    this.undone.length = 0
  }
}
