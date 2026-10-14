// Interleaved A/B of the living benchmark between two checkouts of this repo (each with its own npm install).
// Run: node apps/sandbox/bench/livingAb.node.mjs --a=<candidate dir> --b=<baseline dir> [--pairs=5] [--assert=0.15]
// Pairs alternate AB, BA, AB, ... so drift does not favour one side. Per phase: each side's p50s, and the median over
// pairs of (a - b). --assert=ms exits 1 when a phase's median delta is above it.
import { execFileSync } from 'node:child_process'

const arg = (name, fallback) => { const a = process.argv.find(s => s.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : fallback }
const A = arg('a', '.'), B = arg('b'), PAIRS = Number(arg('pairs', '5')), LIMIT = arg('assert')
if (!B) throw new Error('--b=<baseline checkout> is required')
const run = dir => {
  const out = execFileSync(process.execPath, ['--experimental-strip-types', 'apps/sandbox/bench/living.node.ts'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 24 })
  return JSON.parse(out.slice(out.indexOf('{'))).results
}
const runs = { a: [], b: [] }
for (let i = 0; i < PAIRS; i++) for (const side of i % 2 ? ['b', 'a'] : ['a', 'b']) {
  console.error(`${new Date().toISOString().slice(11, 19)} pair ${i + 1} ${side}`)
  runs[side].push(run(side === 'a' ? A : B))
}
const median = xs => { const s = [...xs].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const report = {}, failures = []
for (const p of Object.keys(runs.a[0])) {
  const a = runs.a.map(r => r[p].p50), b = runs.b.map(r => r[p].p50), delta = +median(a.map((x, i) => x - b[i])).toFixed(3)
  report[p] = { a, b, medianA: median(a), medianB: median(b), medianDelta: delta }
  if (LIMIT !== undefined && delta > Number(LIMIT)) failures.push(`${p}: median delta ${delta} ms > ${LIMIT}`)
}
console.log(JSON.stringify({ node: process.version, a: A, b: B, pairs: PAIRS, report }, null, 2))
for (const f of failures) console.error(`FAIL ${f}`)
if (failures.length) process.exit(1)
