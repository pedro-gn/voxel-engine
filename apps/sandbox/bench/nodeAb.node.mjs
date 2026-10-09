// Interleaved A/B of the living Node bench (bench/living.node.ts) between two checkouts, in the order given (e.g. ABBA).
// Run: node apps/sandbox/bench/nodeAb.node.mjs <checkout A> <checkout B> ABBA <out.json>
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [a, b, order = 'ABBA', out = 'node-ab.json'] = process.argv.slice(2)
if (!a || !b) throw new Error('usage: nodeAb.node.mjs <checkout A> <checkout B> [order] [out.json]')
const runs = []
for (const build of order) {
  const dir = build === 'A' ? a : b
  const stdout = execFileSync(process.execPath, ['--experimental-strip-types', join(dir, 'apps/sandbox/bench/living.node.ts')], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 26 })
  const { results } = JSON.parse(stdout.slice(stdout.indexOf('{')))
  runs.push({ build, results })
  console.log(build, Object.entries(results).map(([p, r]) => `${p} ${r.p50}/${r.p95}`).join('  '))
}
writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), node: process.version, a, b, order, runs }, null, 2))
