// Summarizes living-anatomy.spec.ts output: per phase, long frames (interval > 16.7 ms) and what the main thread did in them.
// Run: node apps/sandbox/bench/anatomy.node.mjs <anatomy.json>
// frame i's interval runs from frame event i-1 to i; its main-thread work = frameMs of frame i-1 (read at event i) + applies arriving in it.
import { readFileSync } from 'node:fs'
const data = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0 }
const f1 = v => v.toFixed(1)
for (const [phase, { frames, ticks, gpu }] of Object.entries(data)) {
  const rows = []
  let t = 0
  for (let i = 1; i < frames.length; i++) {
    const [a] = frames[i - 1], [b, cpuPrev] = frames[i]
    let apply = 0, n = 0
    while (t < ticks.length && ticks[t][0] <= a) t++
    for (let k = t; k < ticks.length && ticks[k][0] <= b; k++) { apply += ticks[k][1]; n++ }
    rows.push({ iv: b - a, cpu: cpuPrev, apply, n })
  }
  const long = rows.filter(r => r.iv > 16.7), short = rows.filter(r => r.iv <= 16.7)
  const withApply = rows.filter(r => r.n > 0), noApply = rows.filter(r => r.n === 0)
  const busyLong = long.map(r => r.cpu + r.apply)
  console.log(`${phase}: ${rows.length} frames, fps p5 ${f1(1000 / q(rows.map(r => r.iv), .95))}, median iv ${f1(q(rows.map(r => r.iv), .5))} ms; gpu samples ${gpu.map(f1).join(' ')}`)
  console.log(`  long ${long.length} (${f1(100 * long.length / rows.length)}%): with an apply ${long.filter(r => r.n > 0).length}; cpu med ${f1(q(long.map(r => r.cpu), .5))}, apply med ${f1(q(long.map(r => r.apply), .5))}, cpu+apply med ${f1(q(busyLong, .5))}; long with cpu+apply < 12 ms: ${long.filter(r => r.cpu + r.apply < 12).length}`)
  console.log(`  short: cpu med ${f1(q(short.map(r => r.cpu), .5))} p95 ${f1(q(short.map(r => r.cpu), .95))}`)
  console.log(`  frames with an apply: ${withApply.length}, long ${f1(100 * withApply.filter(r => r.iv > 16.7).length / Math.max(1, withApply.length))}%; without: ${noApply.length}, long ${f1(100 * noApply.filter(r => r.iv > 16.7).length / Math.max(1, noApply.length))}%`)
  console.log(`  ticks ${ticks.length}: apply p50/p95 ${f1(q(ticks.map(x => x[1]), .5))}/${f1(q(ticks.map(x => x[1]), .95))}, tick p95 ${f1(q(ticks.map(x => x[2]), .95))}`)
}
