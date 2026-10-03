import type { TerrainLayers } from '../doc/types.ts'
import { compileLayers } from '../layers/layers.ts'
import { fillCells, fillHeights } from './cells.ts'
import type { CompiledTerrain } from './compile.ts'
import { VolumeField } from './volume.ts'

/** Ground height before the height layer (base and height ops) for columns [x0, x0 + w) × [z0, z0 + d); index (x - x0) + (z - z0) * w. */
export function sampleHeights(t: CompiledTerrain, x0: number, z0: number, w: number, d: number): Float64Array {
  return fillHeights(t, x0, z0, w, d).h
}

/** A lattice of points: (x0 + i·step, y0 + j·step, z0 + k·step) for i < nx, j < ny, k < nz. */
export interface SampleGrid { x0: number; y0: number; z0: number; nx: number; ny: number; nz: number; step: number }

/**
 * The density the pipeline thresholds (solid where > 0) at each grid point: the height field and volume
 * ops clamped to ±DENSITY_CLAMP, plus the density layer. Index i + k·nx + j·nx·nz. A y outside the
 * world reads the nearest y inside it.
 */
export function sampleDensity(t: CompiledTerrain, g: SampleGrid): Float32Array {
  const w = (g.nx - 1) * g.step + 1, d = (g.nz - 1) * g.step + 1
  const cells = fillCells(t, g.x0, g.z0, w, d)
  const field = new VolumeField(t, g.x0, g.z0, w, d)
  const col = new Float64Array(t.height)
  const out = new Float32Array(g.nx * g.ny * g.nz)
  for (let k = 0; k < g.nz; k++) for (let i = 0; i < g.nx; i++) {
    const lx = i * g.step, lz = k * g.step
    field.densities(g.x0 + lx, g.z0 + lz, cells.top[lx + lz * w]!, col)
    for (let j = 0; j < g.ny; j++) {
      const y = Math.min(t.height - 1, Math.max(0, g.y0 + j * g.step))
      out[i + k * g.nx + j * g.nx * g.nz] = col[y]!
    }
  }
  return out
}

/** The terrain with other layers. Brushes sample documents that differ from the compiled one only in their layers. */
export function withLayers(t: CompiledTerrain, layers: TerrainLayers): CompiledTerrain {
  return { ...t, ...compileLayers(layers) }
}
