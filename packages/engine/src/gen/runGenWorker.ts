import type { GenConnect, ToGen } from '../protocol.ts'
import type { GeneratorModule } from '../sim/generator.ts'
import { GenHost } from './genHost.ts'

interface WorkerScope { onmessage: ((e: MessageEvent<GenConnect>) => void) | null }

/** Call this from your game's `gen.worker.ts` with the same generator the sim worker uses. */
export function runGenWorker(modules: { generator: GeneratorModule }): void {
  const scope = globalThis as unknown as WorkerScope
  scope.onmessage = (e) => {
    if (e.data.type !== 'connect') return
    const port = e.data.port
    const host = new GenHost((m, transfer) => port.postMessage(m, transfer), modules.generator)
    port.onmessage = (ev: MessageEvent<ToGen>) => host.handle(ev.data)
  }
}

export { defineGenerator } from '../sim/generator.ts'
export type { GeneratorContext, GeneratorInfo, GeneratorModule } from '../sim/generator.ts'
