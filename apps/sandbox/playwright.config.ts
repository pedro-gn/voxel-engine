import { defineConfig } from '@playwright/test'

// E2E_PORT overrides the dev-server port (default 5173), e.g. to avoid reusing a stale server.
const port = Number(process.env.E2E_PORT ?? 5173)
// Use an installed hardware-accelerated browser for local GPU checks; CI keeps bundled Chromium.
const channel = process.env.E2E_CHANNEL
// Bench the production bundle after `npm run build`, retaining the isolation headers from vite.config.ts.
const preview = process.env.E2E_PREVIEW === '1'

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  use: { baseURL: `http://localhost:${port}`, headless: true },
  webServer: { command: `npm run ${preview ? 'preview' : 'dev'} -- --port ${port} --strictPort`, url: `http://localhost:${port}`, reuseExistingServer: true, timeout: 60_000 },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', ...(channel ? { channel } : {}), launchOptions: { args: ['--enable-unsafe-webgpu'] } } }],
})
