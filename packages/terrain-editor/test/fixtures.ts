import { validateTerrainDoc, type TerrainDoc } from '@elovox/terrain'

export const SIZE: [number, number] = [256, 256]
export const HEIGHT = 128

/** A 256 × 256 document with one op of each shape kind and a volume op. */
export function rawDoc(): Record<string, unknown> {
  return {
    format: 'elovox-terrain', version: 1, size: [...SIZE], seaLevel: 10,
    base: { height: 30, amplitude: 4, noise: { scale: 64 } },
    biomes: [
      { name: 'plain', surface: [{ block: 'grass' }, { block: 'dirt', depth: [1, 3] }] },
      { name: 'mesa', surface: [{ block: 'sand' }] },
    ],
    biomeRule: { default: 'plain' },
    ops: [
      { id: 'hill', type: 'hills', shape: { kind: 'circle', center: [64, 64], radius: 20, falloff: 8 }, params: { amplitude: 10 } },
      { id: 'ridge', type: 'mountain', shape: { kind: 'path', width: 24, points: [{ x: 150, z: 40 }, { x: 200, z: 90 }] }, params: { height: 30 } },
      { id: 'pond', type: 'lake', shape: { kind: 'polygon', points: [[100, 180], [140, 180], [140, 220], [100, 220]] }, params: { level: 28 } },
      { id: 'rock', type: 'blob', shape: { kind: 'circle', center: [200, 200], radius: 6 }, params: { y: 40, height: 5 } },
    ],
  }
}

export function doc(): TerrainDoc {
  const r = validateTerrainDoc(rawDoc(), { worldHeight: HEIGHT })
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.doc
}

/** A flat 256 × 256 document (ground at 30, no ops), so brush tests can predict every height. */
export function flatDoc(): TerrainDoc {
  const r = validateTerrainDoc({ ...rawDoc(), base: { height: 30, amplitude: 0, noise: { scale: 64 } }, ops: [] }, { worldHeight: HEIGHT })
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.doc
}

/** Freezes a value deeply, so a test fails if code under test mutates it. Typed arrays cannot be frozen and are skipped. */
export function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !ArrayBuffer.isView(v) && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}
