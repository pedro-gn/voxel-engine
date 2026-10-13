interface Waiter<R> { resolve(r: R): void; reject(e: unknown): void }
interface Queued<A, R> { key: string; args: A; waiters: Waiter<R>[] }

/**
 * Runs one job at a time. A request made while one runs waits in line; a later request for a key already waiting joins it
 * (its latest arguments win) and every caller gets that run's result. Two keys never fold: a save to slot "b" is never
 * answered by a save to another slot.
 */
export class SaveQueue<A, R> {
  private running = false
  private readonly line: Queued<A, R>[] = []
  private readonly run: (a: A) => Promise<R>
  constructor(run: (a: A) => Promise<R>) { this.run = run }

  request(key: string, args: A): Promise<R> {
    if (!this.running) return this.start(args)
    return new Promise<R>((resolve, reject) => {
      let q = this.line.find(x => x.key === key)
      if (q) q.args = args
      else { q = { key, args, waiters: [] }; this.line.push(q) }
      q.waiters.push({ resolve, reject })
    })
  }

  private start(args: A): Promise<R> {
    this.running = true
    const p = this.run(args)
    const after = () => {
      this.running = false
      const q = this.line.shift()
      if (q) this.start(q.args).then(r => { for (const w of q.waiters) w.resolve(r) }, e => { for (const w of q.waiters) w.reject(e) })
    }
    p.then(after, after)
    return p
  }
}
