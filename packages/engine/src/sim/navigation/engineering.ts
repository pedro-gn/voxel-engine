import type { Layout } from '../../world/layout.ts'
import type { Vec3 } from '../commands.ts'
export type RouteAction = { kind: 'walk' | 'dig' | 'build'; pos: Vec3; voxel: number }
interface Edit { p: number; value: number }
interface State { p: number; stock: number; slots: number; edits: readonly Edit[]; g: number; h: number; parent: number; edge: RouteAction[] }
export interface EngineeringPort {
  layout: Layout
  get(x: number, y: number, z: number): number
  solid(voxel: number): boolean
  digTicks(pos: Vec3, voxel: number): number
  buildTicks: number
  capacityRemaining: number
  drop(voxel: number): number
  safe(pos: Vec3): boolean
  /** False for cells the planner must neither dig nor fill (e.g. designated build cells). */
  editable?(pos: Vec3): boolean
}
/** Bounded planar engineering. Inventory and edit overlay belong to the search state, never the world. */
export class EngineeringSearch {
  status: 'pending' | 'found' | 'unreachable' | 'limited' | 'cancelled' = 'pending'
  actions: RouteAction[] = []
  cost = 0
  missingMaterial = false
  private editLimit = false
  private spatialLimit = false
  private readonly port: EngineeringPort
  private readonly goal: number
  private readonly buildBlock: number
  private readonly origin: Vec3
  private states: State[] = []
  private heap: number[] = []
  private best = new Map<string, number>()
  private current = -1
  private direction = 0
  private reconstruct = -1
  private edgeCursor = -1
  private phase: 'search' | 'path' | 'reverse' = 'search'
  private reverseCursor = 0
  constructor(port: EngineeringPort, origin: Vec3, goal: Vec3, stock: number, buildBlock: number) {
    this.port = port; this.origin = origin; this.goal = port.layout.voxelIndex(...goal); this.buildBlock = buildBlock
    if (origin[1] !== goal[1] || Math.abs(origin[0] - goal[0]) > 8 || Math.abs(origin[2] - goal[2]) > 8) { this.status = 'limited'; return }
    this.push({ p: port.layout.voxelIndex(...origin), stock, slots: port.capacityRemaining, edits: [], g: 0, h: this.h(origin), parent: -1, edge: [] })
  }
  cancel(): void { this.status = 'cancelled' }
  private h(pos: Vec3): number { const g = this.port.layout.voxelCoords(this.goal); return (Math.abs(pos[0] - g[0]) + Math.abs(pos[2] - g[2])) * 4 }
  private key(s: State): string { return `${s.p}/${s.stock}/${s.slots}/${s.edits.map(e => `${e.p}:${e.value}`).join(',')}` }
  private less(a: number, b: number): boolean { const x = this.states[a]!, y = this.states[b]!; return x.g + x.h < y.g + y.h || x.g + x.h === y.g + y.h && (x.h < y.h || x.h === y.h && a < b) }
  private push(s: State): void {
    const key = this.key(s), old = this.best.get(key)
    if (old !== undefined && this.states[old]!.g <= s.g) return
    if (this.states.length >= 2048) { this.status = 'limited'; return }
    const id = this.states.length; this.states.push(s); this.best.set(key, id)
    let i = this.heap.length; this.heap.push(id)
    while (i) { const p = (i - 1) >> 1; if (!this.less(id, this.heap[p]!)) break; this.heap[i] = this.heap[p]!; i = p }; this.heap[i] = id
  }
  private pop(): number {
    const id = this.heap[0]!, last = this.heap.pop()!
    if (this.heap.length) {
      let i = 0
      while (i * 2 + 1 < this.heap.length) { let c = i * 2 + 1; if (c + 1 < this.heap.length && this.less(this.heap[c + 1]!, this.heap[c]!)) c++; if (!this.less(this.heap[c]!, last)) break; this.heap[i] = this.heap[c]!; i = c }; this.heap[i] = last
    }
    return id
  }
  step(cap: number): number {
    let used = 0
    while (used < cap && this.status === 'pending') {
      used++
      if (this.phase === 'reverse') {
        if (this.reverseCursor < this.actions.length / 2 - .5) { const i = this.reverseCursor++, j = this.actions.length - 1 - i, a = this.actions[i]!; this.actions[i] = this.actions[j]!; this.actions[j] = a }
        else this.status = 'found'
      } else if (this.phase === 'path') {
        if (this.reconstruct < 0) { this.phase = 'reverse'; continue }
        const s = this.states[this.reconstruct]!
        if (this.edgeCursor < 0) this.edgeCursor = s.edge.length - 1
        if (this.edgeCursor >= 0) this.actions.push(s.edge[this.edgeCursor--]!)
        if (this.edgeCursor < 0) this.reconstruct = s.parent
      } else if (this.current < 0) {
        if (!this.heap.length) { this.status = this.editLimit || this.spatialLimit ? 'limited' : 'unreachable'; continue }
        const id = this.pop(), s = this.states[id]!
        if (this.best.get(this.key(s)) !== id) continue
        if (s.p === this.goal) { this.reconstruct = id; this.phase = 'path'; this.cost = s.g; continue }
        this.current = id; this.direction = 0
      } else {
        const s = this.states[this.current]!, [x, y, z] = this.port.layout.voxelCoords(s.p), [dx, dz] = [[1, 0], [-1, 0], [0, 1], [0, -1]][this.direction++]!
        const pos: Vec3 = [x + dx!, y, z + dz!]
        if (this.direction === 4) { const parent = this.current; this.current = -1; this.expand(s, pos, parent) } else this.expand(s, pos, this.current)
      }
    }
    return used
  }
  private expand(s: State, pos: Vec3, parent: number): void {
    const L = this.port.layout, [x, y, z] = pos
    if (!L.inBounds(x, y + 1, z) || y < 1 || !this.port.safe(pos)) return
    const outside = Math.abs(x - this.origin[0]) > 8 || Math.abs(z - this.origin[2]) > 8
    const edits = [...s.edits], edge: RouteAction[] = []
    let g = s.g, stock = s.stock, slots = s.slots
    const get = (p: Vec3) => edits.find(e => e.p === L.voxelIndex(...p))?.value ?? this.port.get(...p)
    for (const p of [[x, y, z], [x, y + 1, z]] as const) {
      const v = get(p)
      if (!this.port.solid(v)) continue
      const ticks = this.port.digTicks(p, v); if (!ticks || this.port.editable?.(p) === false) return
      if (edits.length >= 8) { this.editLimit = true; return }
      const drop = this.port.drop(v); if (drop && slots > 0) { slots--; if (drop === this.buildBlock) stock++ }
      edits.push({ p: L.voxelIndex(...p), value: 0 }); edge.push({ kind: 'dig', pos: p, voxel: 0 }); g += ticks
    }
    const floor: Vec3 = [x, y - 1, z]
    if (!this.port.solid(get(floor))) {
      if (!this.buildBlock) return
      if (this.port.editable?.(floor) === false) return
      if (!stock) { this.missingMaterial = true; return }
      if (edits.length >= 8) { this.editLimit = true; return }
      let attached = false
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (this.port.solid(get([x + dx!, y - 1, z + dz!]))) attached = true
      if (!attached) return
      stock--; slots++; edits.push({ p: L.voxelIndex(...floor), value: this.buildBlock }); edge.push({ kind: 'build', pos: floor, voxel: this.buildBlock }); g += this.port.buildTicks
    }
    if (outside) { this.spatialLimit = true; return }
    edge.push({ kind: 'walk', pos, voxel: 0 }); edits.sort((a, b) => a.p - b.p)
    this.push({ p: L.voxelIndex(...pos), stock, slots, edits, g: g + 4, h: this.h(pos), parent, edge })
  }
  mixState(mix: (n: number) => void): void {
    const actions = (values: readonly RouteAction[]) => { mix(values.length); for (const a of values) { mix(a.kind === 'dig' ? 1 : a.kind === 'build' ? 2 : 3); mix(a.voxel); for (const p of a.pos) mix(p) } }
    mix(['pending', 'found', 'unreachable', 'limited', 'cancelled'].indexOf(this.status)); mix(this.missingMaterial ? 1 : 0); mix(this.editLimit ? 1 : 0); mix(this.spatialLimit ? 1 : 0); mix(this.cost)
    for (const p of this.origin) mix(p); actions(this.actions)
    mix(this.goal); mix(this.buildBlock); mix(this.current); mix(this.direction); mix(this.reconstruct); mix(this.edgeCursor); mix(this.reverseCursor); mix(['search', 'path', 'reverse'].indexOf(this.phase)); mix(this.states.length)
    for (const s of this.states) { mix(s.p); mix(s.stock); mix(s.slots); mix(s.g); mix(s.h); mix(s.parent); mix(s.edits.length); for (const e of s.edits) { mix(e.p); mix(e.value) }; actions(s.edge) }
    mix(this.heap.length); for (const id of this.heap) mix(id)
    mix(this.best.size); for (const [key, id] of this.best) { mix(key.length); for (const c of key) mix(c.charCodeAt(0)); mix(id) }
  }
}
