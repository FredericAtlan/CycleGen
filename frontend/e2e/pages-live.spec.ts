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

    // Wait for dynamic CycleGenShell (sidebar address fields)
    await expect(
      page.getByText(/ouverture du créateur/i)
    ).toHaveCount(0, { timeout: 30_000 });
    const dep = page.getByPlaceholder(/adresse ou gps/i).first();
    const arr = page.getByPlaceholder(/adresse ou gps/i).nth(1);
    await expect(dep).toBeVisible({ timeout: 30_000 });
    await expect(arr).toBeVisible();

    await dep.fill("Tour Eiffel, Paris");
    await arr.fill("Notre-Dame de Paris");

    const locate = page.getByRole("button", { name: /^localiser$/i });
    await expect(locate.first()).toBeEnabled({ timeout: 10_000 });
    await locate.first().click();
    await expect(page.getByText(/^localisé$/i).first()).toBeVisible({
      timeout: 45_000,
    });
    await locate.nth(1).click();
    await expect(page.getByText(/^localisé$/i)).toHaveCount(2, {
      timeout: 45_000,
    });

    const calc = page.getByRole("button", {
      name: /calculer l[’']itinéraire/i,
    });
    await expect(calc).toBeVisible({ timeout: 15_000 });
    await calc.click();

    // Real route result (not just the demo banner mentioning Photon/OSRM)
    await expect
      .poll(
        async () => {
          const body = await page.locator("body").innerText();
          return /\d+([.,]\d+)?\s*km/i.test(body);
        },
        { timeout: 90_000 }
      )
      .toBeTruthy();

    await page.getByRole("button", { name: /déplier/i }).click().catch(() => {});
    const consoleText = await page.locator("footer, [aria-label='Console API']").innerText();
    expect(
      /photon|osrm|géocod|itinéraire/i.test(consoleText),
      `console after route: ${consoleText.slice(0, 400)}`
    ).toBeTruthy();

    expect(errors, `pageerrors: ${errors.join("; ")}`).toEqual([]);
  });
});
