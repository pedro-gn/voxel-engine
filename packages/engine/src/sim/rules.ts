import type { Command } from './commands.ts'

export interface RuleContext {
  readonly tick: number
  get(x: number, y: number, z: number): number
  set(x: number, y: number, z: number, voxel: number): void
  schedule(x: number, y: number, z: number, delayTicks: number): void
  random(): number
  emit(type: string, payload?: unknown): void
  id(name: string): number
  isAir(voxel: number): boolean
  state(voxel: number): number
  withState(voxel: number, state: number): number
  /** Registry flags of a voxel's block. */
  isSolid(voxel: number): boolean
  isLiquid(voxel: number): boolean
  isOpaque(voxel: number): boolean
  falls(voxel: number): boolean
  /** Light at a voxel, 0–15 (15 outside the world). */
  skyLight(x: number, y: number, z: number): number
  blockLight(x: number, y: number, z: number): number
  /** A liquid's level 0–7 (a spring reads 7); −1 for any other voxel. */
  level(voxel: number): number
}

export type BlockCallback = (ctx: RuleContext, x: number, y: number, z: number, voxel: number) => void

export interface BlockRules {
  onScheduledTick?: BlockCallback
  onNeighborChanged?: BlockCallback
  onRandomTick?: BlockCallback
}

export type CommandHandler = (ctx: RuleContext, cmd: Command) => void

export interface RulesModule {
  blocks?: Record<string, BlockRules>
  commands?: Record<string, CommandHandler>
}

export function defineRules(rules: RulesModule): RulesModule {
  return rules
}
