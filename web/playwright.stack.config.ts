import { defineConfig, devices } from '@playwright/test';

// Runs against an already running compose stack (see containers/accept.ps1); credentials come from the environment only.
export default defineConfig({
  testDir: './stack-e2e',
  outputDir: './test-results-stack',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env['STACK_URL'] ?? 'http://127.0.0.1:6610',
    trace: 'retain-on-failure',
  },
});
