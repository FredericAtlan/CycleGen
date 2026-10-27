import { test, expect } from "@playwright/test";

/**
 * Live GitHub Pages smoke (no local webServer).
 *
 *   PLAYWRIGHT_BASE_URL=https://fredericatlan.github.io/CycleGen \
 *     npx playwright test e2e/pages-live.spec.ts --config=playwright.pages-live.config.ts
 */
const LIVE =
  process.env.PLAYWRIGHT_BASE_URL?.replace(/\/$/, "") ||
  "https://fredericatlan.github.io/CycleGen";

test.describe("GitHub Pages live demo", () => {
  test("home loads without missing-page / 404", async ({ page }) => {
    const errors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    const res = await page.goto(`${LIVE}/`, { waitUntil: "networkidle" });
    expect(res?.ok(), `HTTP ${res?.status()}`).toBeTruthy();

    await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("CycleGen").first()).toBeVisible();

    // Soft / hard 404 regressions seen on Pages + basePath
    await expect(page.getByRole("heading", { name: /page introuvable/i })).toHaveCount(
      0
    );
    await expect(page.getByText(/missing.?page/i)).toHaveCount(0);
    await expect(
      page.getByTestId("studio-home-title").or(
        page.getByRole("heading", { name: /^CycleGen$/ })
      )
    ).toBeVisible({ timeout: 15_000 });

    expect(errors, `pageerrors: ${errors.join("; ")}`).toEqual([]);
  });

  test("GPS A→B demo mode (Photon + OSRM) is active", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    await page.goto(`${LIVE}/`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 20_000 });

    // Console footer should advertise client OSRM demo (not localhost / hors ligne)
    const consoleBtn = page.getByRole("button", { name: /console/i }).first();
    await expect(consoleBtn).toBeVisible();
    const consoleLabel = (await consoleBtn.innerText()).toLowerCase();
    expect(
      consoleLabel.includes("démo osrm") || consoleLabel.includes("demo osrm"),
      `console label unexpected: ${consoleLabel}`
    ).toBeTruthy();
    expect(consoleLabel.includes("localhost")).toBeFalsy();

    // Trajet GPS entry must be available
    const porte1 = page.getByRole("link", { name: /trajet gps/i });
    await expect(porte1).toBeVisible({ timeout: 10_000 });
    await porte1.click();

    await expect(page).toHaveURL(/mode=create/);
    await expect(page.getByTestId("pages-demo-api-banner")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/Photon \+ OSRM/i)).toBeVisible();

    // Fill A/B and trigger route analyze (client OSRM)
    const dep = page.getByLabel(/départ|departure|origine/i).or(
      page.getByPlaceholder(/adresse|départ|paris/i)
    ).first();
    const arr = page.getByLabel(/arriv|destination/i).or(
      page.getByPlaceholder(/arriv|destination/i)
    ).first();

    // Fallback: sidebar text inputs near known labels
    const inputs = page.locator('input[type="text"], input:not([type])');
    const count = await inputs.count();
    expect(count, "expected address inputs in create mode").toBeGreaterThan(0);

    // Prefer labeled fields when present
    if (await dep.count()) {
      await dep.fill("Tour Eiffel, Paris");
    } else {
      await inputs.nth(0).fill("Tour Eiffel, Paris");
    }
    if (await arr.count()) {
      await arr.fill("Notre-Dame, Paris");
    } else if (count > 1) {
      await inputs.nth(1).fill("Notre-Dame, Paris");
    }

    const analyze = page.getByRole("button", {
      name: /analyser|itinéraire|générer le corridor|calculer|construire/i,
    });
    if (await analyze.count()) {
      await analyze.first().click();
    } else {
      // Geocode buttons then analyze
      const geo = page.getByRole("button", { name: /géocod/i });
      if (await geo.count()) {
        await geo.first().click();
        if ((await geo.count()) > 1) await geo.nth(1).click();
      }
    }

    // Expect either map polyline activity or console hop to Photon/OSRM
    await page.getByRole("button", { name: /déplier|console/i }).first().click().catch(() => {});
    await expect
      .poll(async () => {
        const body = await page.locator("body").innerText();
        return /photon|osrm|itinéraire|km|géocod/i.test(body);
      }, { timeout: 60_000 })
      .toBeTruthy();

    expect(errors, `pageerrors: ${errors.join("; ")}`).toEqual([]);
  });
});
