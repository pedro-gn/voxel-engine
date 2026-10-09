// Interleaved A/B of the living Node bench (bench/living.node.ts) along a chain of commits, in one scratch checkout: each
// run checks out the commit its order digit names, so every adjacent pair of the chain is an A/B item.
// Run: node apps/sandbox/bench/nodeChain.node.mjs <checkout> <order, e.g. 012343210> <out.json> <sha0> <sha1> …
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir, order, out, ...shas] = process.argv.slice(2)
if (!dir || !order || !out || shas.length < 2) throw new Error('usage: nodeChain.node.mjs <checkout> <order> <out.json> <sha0> <sha1> …')
const runs = []
for (const d of order) {
  const sha = shas[Number(d)]
  if (!sha) throw new Error(`order digit ${d} names no sha`)
  execFileSync('git', ['-C', dir, 'checkout', '--quiet', '--detach', sha])
  const stdout = execFileSync(process.execPath, ['--experimental-strip-types', join(dir, 'apps/sandbox/bench/living.node.ts')], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 26 })
  const { results } = JSON.parse(stdout.slice(stdout.indexOf('{')))
  runs.push({ bundle: Number(d), sha, results })
  console.log(d, sha, Object.entries(results).map(([p, r]) => `${p} ${r.p50}/${r.p95}`).join('  '))
}
writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), node: process.version, dir, order, shas, runs }, null, 2))
