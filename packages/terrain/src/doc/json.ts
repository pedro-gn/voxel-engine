import { layersToJSON } from '../layers/tiles.ts'
import type { TerrainDoc, TerrainLayersJSON } from './types.ts'

/** The document as a .terrain.json file stores it (layers as base64 tiles). JSON.stringify it to save. */
export function toTerrainJSON(doc: TerrainDoc): Omit<TerrainDoc, 'layers'> & { layers: TerrainLayersJSON } {
  return { ...doc, layers: layersToJSON(doc.layers) }
}
