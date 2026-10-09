// Interleaved A/B of prebuilt sandbox bundles on the view bench (spec 4b §6). One preview server per slot, on port 5181.
//
// Build each bundle with its commit recorded: `npx vite build --outDir <dir> --emptyOutDir`, then write the commit's SHA to
// <dir>/ab-sha.txt (or give "sha" in the variant). Then:
//   VIEW_AB_VARIANTS='{"main":{"dist":"C:/…/ab/main","query":""},"cull":{"dist":"C:/…/ab/cull","query":""}}'
//   VIEW_AB_ORDER=mccmmc   (first letters of the variant names)   VIEW_AB_SCENES=world,terrain
//   VIEW_AB_OUT=…/ab.json  node apps/sandbox/bench/viewAB.mjs
// Extra env (VIEW_WINDOW_MS, VIEW_PROBES, VIEW_PROFILE) passes through to the bench.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sandbox = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(sandbox, '../..')
const vite = join(root, 'node_modules/vite/bin/vite.js')
const playwright = join(root, 'node_modules/@playwright/test/cli.js')
const variants = JSON.parse(process.env.VIEW_AB_VARIANTS ?? '{}')
const order = (process.env.VIEW_AB_ORDER ?? 'ABBAAB').split('')
const scenes = (process.env.VIEW_AB_SCENES ?? 'world,terrain').split(',')
const outPath = resolve(process.env.VIEW_AB_OUT ?? join(sandbox, 'test-results/view-ab.json'))
const byLetter = Object.fromEntries(Object.keys(variants).map(n => [n[0], n]))
if (Object.keys(byLetter).length !== Object.keys(variants).length) throw new Error('variant names must start with distinct letters')

// Every A/B names the commit each bundle was built from.
for (const [name, v] of Object.entries(variants)) {
  const file = join(v.dist, 'ab-sha.txt')
  v.sha ??= existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined
  if (!v.sha) throw new Error(`variant ${name}: no "sha" and no ${file}`)
}

async function waitFor(url, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(url)).ok) return } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`no server at ${url}`)
}

const runs = []
mkdirSync(dirname(outPath), { recursive: true })
for (const letter of order) {
  const name = byLetter[letter]
  if (!name) throw new Error(`order letter ${letter} names no variant`)
  const v = variants[name]
  const server = spawn(process.execPath, [vite, 'preview', '--outDir', v.dist, '--port', '5181', '--strictPort'], { cwd: sandbox, stdio: 'ignore' })
  try {
    await waitFor('http://localhost:5181/', 30_000)
    for (const scene of scenes) {
      const out = join(dirname(outPath), `ab-${runs.length}-${name}-${scene}.json`)
      const query = `scene=${scene}&size=1024&gpu${v.query ? `&${v.query}` : ''}`
      const r = spawnSync(process.execPath, [playwright, 'test', 'e2e/view-bench.spec.ts', '--workers=1', '--headed'], {
        cwd: sandbox, stdio: 'inherit',
        env: { ...process.env, BENCH_VIEW: '1', VIEW_QUERY: query, VIEW_BENCH_OUT: out, E2E_PORT: '5181', E2E_PREVIEW: '1', E2E_CHANNEL: 'msedge' },
      })
      if (r.status !== 0) throw new Error(`bench failed: ${name} ${scene}`)
      runs.push({ variant: name, sha: v.sha, scene, ...JSON.parse(readFileSync(out, 'utf8')) })
    }
  } finally {
    server.kill()
  }
}

// Per variant, scene and pose: the worst fps p5, the median of the CPU medians, the max GPU ms.
const summary = {}
for (const r of runs) for (const [pose, p] of Object.entries(r.poses)) {
  if (!p || typeof p.fpsP5 !== 'number') continue
  const s = summary[`${r.variant} ${r.scene} ${pose}`] ??= { fpsP5: Infinity, cpu: [], gpuMs: 0 }
  s.fpsP5 = Math.min(s.fpsP5, p.fpsP5)
  s.cpu.push(p.cpuMedian)
  s.gpuMs = Math.max(s.gpuMs, p.gpuMs ?? 0)
}
for (const s of Object.values(summary)) {
  const c = s.cpu.sort((a, b) => a - b)
  s.cpuMedian = c[Math.floor(c.length / 2)]
  delete s.cpu
}
writeFileSync(outPath, JSON.stringify({ date: new Date().toISOString(), order: order.join(''), variants, runs, summary }, null, 2))
console.log(JSON.stringify(summary, null, 2))
