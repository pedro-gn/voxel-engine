/** Two touching pools and the faces where they touch: [cell of a, cell of b] (voxel indices). Ids are raw; resolve them. */
export interface Contact {
  readonly a: number
  readonly b: number
  readonly faces: [number, number][]
}

interface Entry extends Contact { readonly keys: Set<string> }

export class ContactTable {
  private readonly byKey = new Map<string, Entry>()

  get size(): number { return this.byKey.size }

  add(pa: number, ca: number, pb: number, cb: number): void {
    if (pa === pb) return
    const [a, b, fa, fb] = pa < pb ? [pa, pb, ca, cb] : [pb, pa, cb, ca]
    const k = `${a}:${b}`
    let e = this.byKey.get(k)
    if (!e) { e = { a, b, faces: [], keys: new Set() }; this.byKey.set(k, e) }
    const fk = `${fa}:${fb}`
    if (e.keys.has(fk)) return
    e.keys.add(fk)
    e.faces.push([fa, fb])
  }

  /** Contacts in insertion order (a snapshot: deleting while iterating is safe). */
  all(): Contact[] { return [...this.byKey.values()] }

  delete(c: Contact): void { this.byKey.delete(`${c.a}:${c.b}`) }

  clear(): void { this.byKey.clear() }

  mixState(mix: (v: number) => void): void {
    mix(this.byKey.size)
    for (const e of this.byKey.values()) { mix(e.a); mix(e.b); mix(e.faces.length) }
  }
}
