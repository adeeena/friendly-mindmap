import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './cloud-e2e',
  outputDir: './test-results-cloud',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: 'list',
  globalTeardown: './cloud-e2e/teardown.ts',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4312',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node cloud-e2e\\server.cjs',
    url: 'http://127.0.0.1:4312',
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
