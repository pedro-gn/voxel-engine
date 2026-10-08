// Prints the 25 functions with the most self time in a .cpuprofile (Chrome DevTools or node --cpu-prof).
// Run: node apps/sandbox/bench/topSelf.node.mjs test-results/living-dam.cpuprofile
import { readFileSync } from 'node:fs'

const profile = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const dt = new Map(profile.nodes.map(n => [n.id, 0]))
for (let i = 0; i < profile.samples.length; i++) dt.set(profile.samples[i], dt.get(profile.samples[i]) + (profile.timeDeltas[i] ?? 0))
const total = [...dt.values()].reduce((a, b) => a + b, 0)
const byFn = new Map()
for (const n of profile.nodes) {
  const f = n.callFrame, key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`
  byFn.set(key, (byFn.get(key) ?? 0) + dt.get(n.id))
}
for (const [key, us] of [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${(us / 1000).toFixed(1).padStart(9)} ms ${(100 * us / total).toFixed(1).padStart(5)}%  ${key}`)
