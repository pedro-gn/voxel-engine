import { bench, describe } from 'vitest'
import { Mesher } from '../src/mesh/mesher.ts'
import { meshTables, surfaceSnap } from './surface.ts'

// Tracks relative regressions only; the absolute 3 ms gate is `bench:node` (Vitest's runtime adds ~4x overhead).
describe('mesher', () => {
  const tables = meshTables()
  const mesher = new Mesher()
  const snap = surfaceSnap()
  bench('typical surface chunk', () => { mesher.mesh(snap, tables) }, { time: 2000 })
})
