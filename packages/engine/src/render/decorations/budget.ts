export interface DecorationChunk { ci: number; dist: number; count: number }

/** Distance from a chunk's centre to its farthest column, so a chunk is kept while any of it is within the radius. */
export const CHUNK_REACH = 28

/** The chunks to draw: within reach of `radius`, nearest first, until `maxInstances` would be exceeded. */
export function selectVisible(chunks: readonly DecorationChunk[], radius: number, maxInstances: number): Set<number> {
  const sorted = chunks.filter((c) => c.dist <= radius + CHUNK_REACH).sort((a, b) => a.dist - b.dist)
  const out = new Set<number>()
  let total = 0
  for (const c of sorted) {
    if (total + c.count > maxInstances) break
    total += c.count
    out.add(c.ci)
  }
  return out
}
