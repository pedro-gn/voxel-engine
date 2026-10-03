import { BlockRegistry } from '../blocks/registry.ts'
import type { FromGen, ToGen } from '../protocol.ts'
import { makeColumnContext, type GeneratorModule } from '../sim/generator.ts'

/** The logic of a generation worker: holds one configuration and turns column jobs into voxel buffers. */
export class GenHost {
  private readonly post: (m: FromGen, transfer: Transferable[]) => void
  private readonly gen: GeneratorModule
  private epoch = -1
  private error: string | null = 'not configured'
  private seed = 0
  private height = 0
  private registry: BlockRegistry | null = null

  constructor(post: (m: FromGen, transfer: Transferable[]) => void, gen: GeneratorModule) {
    this.post = post
    this.gen = gen
  }

  handle(m: ToGen): void {
    if (m.type === 'configure') {
      this.epoch = m.epoch
      this.error = null
      try {
        const registry = new BlockRegistry(m.blocks)
        this.registry = registry
        this.seed = m.seed
        this.height = m.size[1]
        if (m.doc !== undefined) this.gen.configure?.(m.doc, { size: m.size, seed: m.seed, id: (name) => registry.id(name) })
      } catch (e) {
        this.error = message(e)
      }
      return
    }
    if (m.type === 'patch') {
      this.epoch = m.epoch
      if (this.error !== null) return // jobs keep answering with the configuration error
      try {
        if (!this.gen.patch) throw new Error('the generator does not support patches')
        this.gen.patch(m.patch)
      } catch (e) {
        this.post({ type: 'fatal', epoch: m.epoch, message: message(e) }, [])
      }
      return
    }
    if (this.error !== null) {
      this.post({ type: 'error', id: m.id, epoch: this.epoch, message: this.error }, [])
      return
    }
    const registry = this.registry!
    const column = new Uint16Array(32 * 32 * this.height)
    try {
      this.gen.generateColumn(makeColumnContext(this.seed, this.height, (name) => registry.id(name), column), m.cx, m.cz)
    } catch (e) {
      this.post({ type: 'error', id: m.id, epoch: this.epoch, message: message(e) }, [])
      return
    }
    this.post({ type: 'column', id: m.id, epoch: this.epoch, cx: m.cx, cz: m.cz, data: column }, [column.buffer])
  }
}

function message(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}
