import { defineConfig, devices } from '@playwright/test'

// Serves the project root so fixtures can reach /dist, /node_modules, and the
// fixture HTML. Builds first so dist/ is fresh.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: 'http://localhost:4180',
  },
  webServer: {
    command: 'npm run build && npx sirv . --port 4180 --quiet',
    url: 'http://localhost:4180/e2e/fixtures/demo.html',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
