import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './production-e2e',
  outputDir: './test-results-production',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4311',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node production-e2e\\server.mjs',
    url: 'http://127.0.0.1:4311',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
