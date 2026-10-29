import { describe, expect, it } from 'vitest'
import {
  ROOF_NORMALS, ROOF_OVERHANG, ROOF_REACH, roofFaces, roofForm, roofKindOf, roofState, type RoofForm, type RoofKind,
} from '../src/blocks/roofs.ts'
import { turnShapeState, type Facing } from '../src/blocks/shapes.ts'

/** A neighbour lookup over a map of `"x,y,z"` → roof state, seen from cell (cx, cy, cz). */
function lookup(cells: Map<string, number>, cx: number, cy: number, cz: number) {
  return (dx: number, dy: number, dz: number) => cells.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? -1
}
const formAt = (cells: Map<string, number>, key: string): RoofForm => {
  const [x, y, z] = key.split(',').map(Number) as [number, number, number]
  return roofForm(cells.get(key)!, lookup(cells, x, y, z))
}

/** The facing of a ring cell that looks into a square ring's centre: rows face ±z, columns ±x, corners take their row's. */
const inward = (lx: number, lz: number, n: number): Facing => (lz === 0 ? 1 : lz === n - 1 ? 3 : lx === 0 ? 0 : 2)

describe('roof shape', () => {
  it('roofState round-trips and turns', () => {
    expect(roofKindOf(roofState('ridge', 1))).toBe('ridge')
    expect(roofKindOf(roofState('slope', 3))).toBe('slope')
    expect(roofKindOf(roofState('apex'))).toBe('apex')
    expect(turnShapeState('roof', roofState('slope', 0), 1)).toBe(roofState('slope', 1))
    expect(turnShapeState('roof', roofState('ridge', 3), 2)).toBe(roofState('ridge', 1))
    expect(turnShapeState('roof', roofState('apex'), 3)).toBe(roofState('apex'))
  })

  it('forms come from neighbours by shape', () => {
    const ring = new Map<string, number>()
    for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) if (x !== 1 || z !== 1) ring.set(`${x},0,${z}`, roofState('slope', inward(x, z, 3)))
    for (const k of ['0,0,0', '2,0,0', '0,0,2', '2,0,2']) expect(formAt(ring, k).corner).toBe('outer')
    for (const k of ['1,0,0', '0,0,1', '2,0,1', '1,0,2']) expect(formAt(ring, k).corner).toBe('straight')
    // The lookup knows states only (a thatch slope beside a tile slope reads the same): the corner forms as before.
    expect(formAt(ring, '0,0,0')).toEqual({ corner: 'outer', side: 0, eave: true, trimLeft: false, trimRight: false, endLeft: false, endRight: false })
    // A ridge on the high side is not a slope: no corner.
    const withRidge = new Map(ring)
    withRidge.set('0,0,1', roofState('ridge', 0))
    expect(formAt(withRidge, '0,0,0').corner).toBe('straight')
    // An L: a row facing +z running to −x, a column facing +x running to −z, meeting at (0, 0).
    const l = new Map<string, number>([['0,0,0', roofState('slope', 1)]])
    for (let i = 1; i < 3; i++) { l.set(`${-i},0,0`, roofState('slope', 1)); l.set(`0,0,${-i}`, roofState('slope', 0)) }
    const inner = [...l.keys()].filter((k) => formAt(l, k).corner === 'inner')
    expect(inner).toEqual(['0,0,0'])
    expect(formAt(l, '0,0,0').side).toBe(0)
  })

  it('eave only at the roof\'s foot', () => {
    // A gable section facing +z: eave row, upper row, ridge.
    const g = new Map<string, number>([['0,0,0', roofState('slope', 1)], ['0,1,1', roofState('slope', 1)], ['0,1,2', roofState('ridge', 1)]])
    expect(formAt(g, '0,0,0')).toMatchObject({ corner: 'straight', eave: true, trimLeft: true, trimRight: true })
    expect(formAt(g, '0,1,1')).toMatchObject({ corner: 'straight', eave: false })
    expect(formAt(g, '0,1,2')).toMatchObject({ eave: false, trimLeft: true, trimRight: true })
    // A roof on the slope's left (+x for a +z facing) takes that trim away.
    g.set('1,0,0', roofState('slope', 1))
    expect(formAt(g, '0,0,0')).toMatchObject({ trimLeft: false, trimRight: true })
    // A hip corner carries no trim.
    const ring = new Map<string, number>()
    for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) if (x !== 1 || z !== 1) ring.set(`${x},0,${z}`, roofState('slope', inward(x, z, 3)))
    expect(formAt(ring, '2,0,2')).toMatchObject({ corner: 'outer', trimLeft: false, trimRight: false })
  })

  it('faces stay within the overhang and normals fit the table', () => {
    expect(ROOF_OVERHANG).toBe(6)
    expect(ROOF_NORMALS.length).toBeLessThanOrEqual(32)
    expect(ROOF_REACH).toBeLessThanOrEqual(1)
    const lo = -16 * ROOF_REACH, hi = 16 + 16 * ROOF_REACH
    const forms: RoofForm[] = []
    for (const corner of ['straight', 'outer', 'inner'] as const) for (const side of [0, 1, 2, 3] as const) {
      for (const eave of [false, true]) for (const trimLeft of [false, true]) for (const trimRight of [false, true]) {
        for (const endLeft of [false, true]) for (const endRight of [false, true]) forms.push({ corner, side, eave, trimLeft, trimRight, endLeft, endRight })
      }
    }
    const seen = new Set<readonly unknown[]>(), bad: string[] = []
    for (const kind of ['slope', 'ridge', 'apex'] as RoofKind[]) for (const f of [0, 1, 2, 3] as const) for (const form of forms) {
      const list = roofFaces(roofState(kind, f), form)
      if (seen.has(list)) continue
      seen.add(list)
      for (const face of list) {
        const where = `${kind} ${f} ${JSON.stringify(form)} ${JSON.stringify(face.pts)}`
        if (face.pts.length !== 3 && face.pts.length !== 4) bad.push(`corners: ${where}`)
        if (face.normal >= ROOF_NORMALS.length) bad.push(`normal: ${where}`)
        for (const [x, y, z] of face.pts) {
          if ([x, z].some((c) => c < -ROOF_OVERHANG || c > 16 + ROOF_OVERHANG) || y < lo || y > hi) bad.push(`range: ${where}`)
        }
        // Counter-clockwise seen from the normal's side: the polygon's own (Newell) normal agrees with the table's.
        const n = [0, 0, 0]
        face.pts.forEach((p, i) => {
          const q = face.pts[(i + 1) % face.pts.length]!
          n[0]! += (p[1] - q[1]) * (p[2] + q[2]); n[1]! += (p[2] - q[2]) * (p[0] + q[0]); n[2]! += (p[0] - q[0]) * (p[1] + q[1])
        })
        const len = Math.hypot(n[0]!, n[1]!, n[2]!), t = ROOF_NORMALS[face.normal]?.n ?? [0, 0, 0]
        if ((n[0]! * t[0] + n[1]! * t[1] + n[2]! * t[2]) / len < 0.999) bad.push(`winding: ${where}`)
      }
    }
    expect(bad).toEqual([])
    expect(seen.size).toBeGreaterThan(40)
  })
})

describe('roofs in the public API', () => {
  it('exports the roof helpers from both entries', { timeout: 30_000 }, async () => {
    const client = await import('@elovox/engine')
    const sim = await import('@elovox/engine/sim-worker')
    for (const entry of [client, sim] as Record<string, unknown>[]) {
      for (const name of ['roofState', 'roofKindOf']) expect(typeof entry[name]).toBe('function')
    }
    expect((sim as unknown as { roofKindOf(s: number): string }).roofKindOf((sim as unknown as { roofState(k: string, f: number): number }).roofState('ridge', 1))).toBe('ridge')
    type Exported = [import('@elovox/engine').RoofKind, import('@elovox/engine/sim-worker').RoofKind]
    const sample: Exported = ['apex', 'slope']
    expect(sample).toHaveLength(2)
  })
})
