import { validateTerrainDoc, type OpRegistry, type TerrainDoc, type Vec2 } from '@elovox/terrain'

export type ParseResult = { ok: true; doc: TerrainDoc } | { ok: false; errors: string[] }

/** Reads `.terrain.json` text into a valid document for a world of `size` (x, z). */
export function parseTerrainText(text: string, o: { size: Vec2; worldHeight: number; ops?: OpRegistry }): ParseResult {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    return { ok: false, errors: [`not JSON: ${e instanceof Error ? e.message : String(e)}`] }
  }
  const r = validateTerrainDoc(json, { ops: o.ops, worldHeight: o.worldHeight })
  if (!r.ok) return r
  const [dx, dz] = r.doc.size
  if (dx !== o.size[0] || dz !== o.size[1]) {
    return { ok: false, errors: [`size: the document is ${dx} × ${dz} but the world is ${o.size[0]} × ${o.size[1]}`] }
  }
  return r
}

/** The document as `.terrain.json` text: two-space JSON and a final newline. */
export function serializeTerrain(doc: TerrainDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}
