import { test, expect } from "@playwright/test";
import path from "node:path";

const FIX = path.join(
  __dirname,
  "../../docs/audit/bugfix/E6-fp-drawer/fixtures"
);

const mockOk = (name: string) => ({
  source_sha256: `sha-${name}`,
  filename: name,
  n_points: 100,
  fingerprint: { a_max: 2.1 },
  physics: {
    a_max: 2.1,
    b_comf: 2.0,
    speed_factor: 1.0,
    T: 1.2,
    T_h: 0.8,
    s0: 2.0,
    jerk_max: 1.5,
    jerk_brake_max: 2.0,
    pedal_tau_s: 0,
    vdes_tau_s: 0,
    descent_hold_gain: 0,
    base_profile: "Normal",
  },
  pedal_defaults: {
    pedal_tau_s: 0,
    vdes_tau_s: 0,
    descent_hold_gain: 0,
  },
});

test.describe("E6 driver studio traces", () => {
  test("partial batch then identify step", async ({ page }) => {
    let call = 0;
    await page.route("**/api/cg/api/drivers/fingerprint", async (route) => {
      call += 1;
      if (call === 2) {
        await route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ detail: "bad file" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockOk(`file-${call}.csv`)),
      });
    });

    await page.goto("/?mode=driver");
    await expect(page.getByTestId("driver-studio")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("driver-studio-step-traces")).toBeVisible();

    const input = page.getByTestId("driver-studio-file-input");
    await input.setInputFiles([
      path.join(FIX, "a.csv"),
      path.join(FIX, "b.csv"),
      path.join(FIX, "c.csv"),
    ]);

    // After successful analyzes, studio advances to identify with last ok file
    await expect(page.getByTestId("driver-studio-step-identify")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("driver-studio-save")).toBeVisible();
  });
});
