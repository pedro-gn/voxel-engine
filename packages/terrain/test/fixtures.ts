/** A small valid document as plain JSON-like data. Tests copy it and change one thing. */
export function minimalDoc(): Record<string, unknown> {
  return {
    format: 'elovox-terrain',
    version: 1,
    size: [64, 64],
    seaLevel: 10,
    base: { height: 20, amplitude: 0, noise: { scale: 32 } },
    biomes: [
      { name: 'plain', surface: [{ block: 'grass' }, { block: 'dirt', depth: [1, 3] }] },
      { name: 'beach', surface: [{ block: 'sand', depth: [0, 2] }] },
    ],
    biomeRule: { default: 'plain' },
    ops: [],
  }
}

/** Block ids used by pipeline tests (any stable mapping works; ids must be < 4096). */
export const IDS: Record<string, number> = {
  stone: 1, dirt: 2, grass: 3, sand: 4, water: 5, log: 6, leaves: 7, pine_leaves: 8, rock: 9, snow: 10, gravel: 11,
  sandstone: 12, sandstone_red: 13, spring: 14,
}

export function idOf(name: string): number {
  const id = IDS[name]
  if (id === undefined) throw new Error(`unknown block "${name}"`)
  return id
}
