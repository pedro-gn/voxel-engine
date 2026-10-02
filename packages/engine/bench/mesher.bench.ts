import { bench, describe } from 'vitest'
import { Mesher } from '../src/mesh/mesher.ts'
import { valueNoise2 } from '../src/sim/generator.ts'
import { padIndex } from '../src/world/reader.ts'
import { packLight } from '../src/world/voxel.ts'
import { ID } from '../test/helpers.ts'
import { emptySnap, meshTables } from '../test/meshHelpers.ts'

/** A rolling grass surface crossing the chunk, typical of the diorama terrain. */
function surfaceSnap() {
  const s = emptySnap()
  for (let pz = 0; pz < 34; pz++) for (let px = 0; px < 34; px++) {
    const h = 8 + Math.floor(valueNoise2(3, px / 9, pz / 9) * 16)
    for (let py = 0; py < 34; py++) {
      const i = padIndex(px, py, pz)
      if (py < h - 3) s.voxels[i] = ID.stone
      else if (py < h - 1) s.voxels[i] = ID.dirt
      else if (py === h - 1) s.voxels[i] = ID.grass
      if (py < h) s.light[i] = 0
      else s.light[i] = packLight(15, 0)
    }
  }
  return s
}

describe('mesher', () => {
  const tables = meshTables()
  const mesher = new Mesher()
  const snap = surfaceSnap()
  bench('typical surface chunk', () => { mesher.mesh(snap, tables) }, { time: 2000 })
})
