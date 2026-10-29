import type { ToSim } from '../protocol.ts'
import { SimHost, type SimModules } from './simHost.ts'

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<ToSim>) => void) | null
}

/** Call this from your game's `sim.worker.ts`. */
export function runSimWorker(modules: SimModules): void {
  const scope = globalThis as unknown as WorkerScope
  const host = new SimHost((m, t) => scope.postMessage(m, t ?? []), modules)
  scope.onmessage = (e) => host.handle(e.data)
}

export type { SimModules } from './simHost.ts'
export { defineRules } from './rules.ts'
export type { BlockCallback, BlockRules, CommandHandler, RuleContext, RulesModule } from './rules.ts'
export { defineGenerator } from './generator.ts'
export type { GeneratorConfig, GeneratorContext, GeneratorInfo, GeneratorModule } from './generator.ts'
export type { WaterOptions } from './water/waterSystem.ts'
export type { FallingBodyState, Landing } from './gravity.ts'
export { testGenerator } from './testGenerator.ts'
export { AIR, packVoxel, voxelId, voxelState, withState } from '../world/voxel.ts'
export { ladderState, postState, slabState, stairState, turnShapeState, type BlockShape, type Facing, type PostAxis } from '../blocks/shapes.ts'
export { roofKindOf, roofState, type RoofKind } from '../blocks/roofs.ts'
export { Pcg32 } from './rng.ts'
export { defineSystem } from './systems.ts'
export type { GameSystem, SystemContext, SystemUnits } from './systems.ts'
export type { Intent, UnitEvent } from './workers/types.ts'
