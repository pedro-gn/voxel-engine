/**
 * `@elovox/engine/testing/render`: renderer internals for browser fixtures that draw without an engine.
 * Not part of the public API; it changes with the engine, without notice.
 */
export { BlockRegistry, defineBlock } from '../blocks/registry.ts'
export { Layout } from '../world/layout.ts'
export { createSnapshot, padIndex } from '../world/reader.ts'
export { meshTablesFrom } from '../mesh/tables.ts'
export { meshChunk } from '../mesh/mesher.ts'
export { ChunkMeshes } from '../render/chunkMeshes.ts'
export { createChunkMaterials } from '../render/materials.ts'
export { createLightUniforms } from '../render/voxelLighting.ts'
export { SunLights } from '../render/lighting.ts'
export { PRESETS, resolveAtmosphere } from '../render/atmosphere.ts'
