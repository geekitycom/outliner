import { defineConfig, devices } from '@playwright/test'

// Serves this package's directory so fixtures can reach /dist, /node_modules,
// and the fixture HTML. Builds first so dist/ is fresh.
//
// sirv runs with --dev: its default mode pre-walks the served tree with
// totalist, which follows symlinks and has no cycle detection — fine under a
// flat npm node_modules, but it would recurse through pnpm's whole .pnpm store.
// --dev resolves each request against the filesystem instead.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4180',
  },
  webServer: {
    command: 'pnpm run build && pnpm exec sirv . --dev --port 4180 --quiet',
    url: 'http://localhost:4180/e2e/fixtures/demo.html',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
