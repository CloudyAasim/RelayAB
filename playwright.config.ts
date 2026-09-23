/**
 * Playwright e2e configuration.
 *
 * Tests visual regressions across multiple viewports:
 *   - 375px (iPhone SE)
 *   - 768px (iPad portrait)
 *   - 1024px (iPad landscape / small laptop)
 *   - 1440px (standard desktop)
 *   - 2560px (4K)
 *
 * Tests use `emulate-0.11.2` for offline backend emulation.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 30000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // Disable animations for stable visual snapshots.
    launchOptions: {
      args: ["--disable-blink-features=AutomationControlled"],
    },
  },
  projects: [
    { name: "mobile-s", use: { ...devices["iPhone SE"], viewport: { width: 375, height: 667 } } },
    { name: "mobile-m", use: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } } },
    { name: "tablet", use: { ...devices["iPad (gen 7)"], viewport: { width: 768, height: 1024 } } },
    { name: "laptop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "4k", use: { ...devices["Desktop Chrome"], viewport: { width: 2560, height: 1440 } } },
  ],
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: "pnpm start",
        port: 3000,
        timeout: 120000,
        reuseExistingServer: !process.env.CI,
      },
});
