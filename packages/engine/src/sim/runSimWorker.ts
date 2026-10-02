import type { ToSim } from '../protocol.ts'
import { SimHost, type SimModules } from './simHost.ts'

interface WorkerScope {
  postMessage(message: unknown): void
  onmessage: ((e: MessageEvent<ToSim>) => void) | null
}

/** Call this from your game's `sim.worker.ts`. */
export function runSimWorker(modules: SimModules): void {
  const scope = globalThis as unknown as WorkerScope
  const host = new SimHost((m) => scope.postMessage(m), modules)
  scope.onmessage = (e) => host.handle(e.data)
}

export type { SimModules } from './simHost.ts'
export { defineRules } from './rules.ts'
export { defineGenerator } from './generator.ts'
export { testGenerator } from './testGenerator.ts'
