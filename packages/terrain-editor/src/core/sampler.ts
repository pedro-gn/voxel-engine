import {
  compileTerrain, sampleDensity, sampleHeights, withLayers,
  type CompiledTerrain, type OpRegistry, type SampleGrid, type TerrainDoc,
} from '@elovox/terrain'
import { onlyLayersDiffer } from './area.ts'

export interface SamplerOptions {
  /** The engine's seed: base heights depend on it. */
  seed: number
  /** World height. */
  height: number
  ops?: OpRegistry
}

/**
 * Reads the terrain the brushes paint over straight from the document, through the generation code:
 * the world lags a step behind during a stroke. Compiles again only when something other than the
 * layers changed.
 */
export class TerrainSampler {
  readonly height: number
  private readonly o: SamplerOptions
  private compiled: CompiledTerrain | null = null
  private source: TerrainDoc | null = null

  constructor(o: SamplerOptions) {
    this.o = o
    this.height = o.height
  }

  /** Height before the height layer for columns [x0, x0 + w) × [z0, z0 + d); index (x - x0) + (z - z0) * w. */
  heights(doc: TerrainDoc, x0: number, z0: number, w: number, d: number): Float64Array {
    return sampleHeights(this.terrain(doc), x0, z0, w, d)
  }

  /** The total density (what the pipeline thresholds) on a grid, with the document's layers. */
  density(doc: TerrainDoc, g: SampleGrid): Float32Array {
    return sampleDensity(withLayers(this.terrain(doc), doc.layers), g)
  }

  private terrain(doc: TerrainDoc): CompiledTerrain {
    if (!this.compiled || !this.source || !onlyLayersDiffer(doc, this.source)) {
      // Block ids do not matter for heights and densities.
      this.compiled = compileTerrain(doc, { seed: this.o.seed, height: this.o.height, id: () => 0, ops: this.o.ops })
    }
    this.source = doc
    return this.compiled
  }
}
