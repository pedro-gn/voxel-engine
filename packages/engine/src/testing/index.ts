/**
 * `@elovox/engine/testing`: engine internals for headless tests and benches (Node, no three).
 * Not part of the public API; it changes with the engine, without notice.
 */
export { BlockRegistry, defineBlock } from '../blocks/registry.ts'
export { Layout } from '../world/layout.ts'
export { createWorldBuffers } from '../world/buffers.ts'
export { SUB } from '../world/waterBuffers.ts'
export { Simulation, type TickResult } from '../sim/simulation.ts'
export { fbm2 } from '../sim/generator.ts'
export { HEAD_EPS, MIN_FLOW } from '../sim/water/constants.ts'
export { SHOW_MIN } from '../render/water/surfaceMesh.ts'
export { GroupField } from '../sim/navigation/groupField.ts'
export { NavigationSystem } from '../sim/navigation/navigation.ts'
export { BUILD_WEIGHT, RegionBuild } from '../sim/navigation/regions.ts'
export { RouteSearch } from '../sim/navigation/routeSearch.ts'
export { HIER_MIN } from '../sim/workers/workers.ts'
export { WORKER_STATES } from '../sim/workers/types.ts'
