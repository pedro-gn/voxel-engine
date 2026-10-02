import { defineConfig } from '@playwright/test'

// E2E_PORT overrides the dev-server port (default 5173), e.g. to avoid reusing a stale server.
const port = Number(process.env.E2E_PORT ?? 5173)

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  use: { baseURL: `http://localhost:${port}`, headless: true },
  webServer: { command: `npm run dev -- --port ${port} --strictPort`, url: `http://localhost:${port}`, reuseExistingServer: true, timeout: 60_000 },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu'] } } }],
})
