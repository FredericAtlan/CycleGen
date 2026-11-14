import { defineConfig, devices } from "@playwright/test";

/**
 * CycleGen frontend E2E (Layer D).
 *
 * Prerequisites:
 * - Frontend: `npm run dev` (or let webServer start it) on http://127.0.0.1:3000
 * - Backend API: run separately on 8000 (Docker) or 8001 (local uvicorn).
 *   Smoke/shell tests do not call geocode/route; API is optional for those specs.
 *
 *   PLAYWRIGHT=1 ./scripts/test_nonreg.sh
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  /* Optional: start Next.js if nothing is listening. API must still be started by you. */
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3000",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
