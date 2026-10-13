interface Waiter<R> { resolve(r: R): void; reject(e: unknown): void }

/**
 * Runs one job at a time. A request made while one runs joins the next run (the latest arguments win) and every caller
 * gets that run's result: an autosave that fires while the player saves is folded into one more save, never two at once.
 */
export class SaveQueue<A, R> {
  private running = false
  private next: { args: A; waiters: Waiter<R>[] } | null = null
  private readonly run: (a: A) => Promise<R>
  constructor(run: (a: A) => Promise<R>) { this.run = run }

  request(args: A): Promise<R> {
    if (!this.running) return this.start(args)
    return new Promise<R>((resolve, reject) => {
      if (this.next) this.next.args = args
      else this.next = { args, waiters: [] }
      this.next.waiters.push({ resolve, reject })
    })
  }

  private start(args: A): Promise<R> {
    this.running = true
    const p = this.run(args)
    const after = () => {
      this.running = false
      const n = this.next
      this.next = null
      if (n) this.start(n.args).then(r => { for (const w of n.waiters) w.resolve(r) }, e => { for (const w of n.waiters) w.reject(e) })
    }
    p.then(after, after)
    return p
  }
}
