import { defineConfig, devices } from "@playwright/test";

/** Playwright against deployed GitHub Pages (no local Next server). */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/pages-live.spec.ts",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 120_000,
  use: {
    baseURL:
      process.env.PLAYWRIGHT_BASE_URL?.replace(/\/$/, "") ||
      "https://fredericatlan.github.io/CycleGen",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
