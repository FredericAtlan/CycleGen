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
    page.on("pageerror", (err) => errors.push(String(err)));

    const res = await page.goto(`${LIVE}/`, { waitUntil: "networkidle" });
    expect(res?.ok(), `HTTP ${res?.status()}`).toBeTruthy();

    await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("CycleGen").first()).toBeVisible();

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

  test("GPS A→B works (hosted API or Photon+OSRM demo)", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    await page.goto(`${LIVE}/`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 20_000 });

    // Console: OSRM-only demo *or* hosted API (Render) — never localhost / hors ligne
    const consoleBtn = page.getByRole("button", { name: /console/i }).first();
    await expect(consoleBtn).toBeVisible();
    const consoleLabel = (await consoleBtn.innerText()).toLowerCase();
    const okConsole =
      consoleLabel.includes("démo osrm") ||
      consoleLabel.includes("demo osrm") ||
      consoleLabel.includes("onrender.com") ||
      /https?:\/\/\S+/.test(consoleLabel);
    expect(okConsole, `console label unexpected: ${consoleLabel}`).toBeTruthy();
    expect(consoleLabel.includes("localhost")).toBeFalsy();
    expect(consoleLabel.includes("hors ligne")).toBeFalsy();

    const porte1 = page.getByRole("link", { name: /trajet gps/i });
    await expect(porte1).toBeVisible({ timeout: 10_000 });
    await porte1.click();

    await expect(page).toHaveURL(/mode=create/);

    // OSRM-only Pages show the demo banner; API-backed Pages do not.
    const demoBanner = page.getByTestId("pages-demo-api-banner");
    const osrmOnly = (await demoBanner.count()) > 0;
    if (osrmOnly) {
      await expect(demoBanner).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/Photon \+ OSRM/i)).toBeVisible();
    }

    await expect(page.getByText(/ouverture du créateur/i)).toHaveCount(0, {
      timeout: 30_000,
    });
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
      timeout: 90_000,
    });
    await locate.nth(1).click();
    await expect(page.getByText(/^localisé$/i)).toHaveCount(2, {
      timeout: 90_000,
    });

    const calc = page.getByRole("button", {
      name: /calculer l[’']itinéraire/i,
    });
    await expect(calc).toBeVisible({ timeout: 15_000 });
    await calc.click();

    await expect
      .poll(
        async () => {
          const body = await page.locator("body").innerText();
          return /\d+([.,]\d+)?\s*km/i.test(body);
        },
        { timeout: 120_000 }
      )
      .toBeTruthy();

    await page.getByRole("button", { name: /déplier/i }).click().catch(() => {});
    const consoleText = await page
      .locator("footer, [aria-label='Console API']")
      .innerText();
    expect(
      /photon|osrm|géocod|itinéraire|route|here|mapbox/i.test(consoleText),
      `console after route: ${consoleText.slice(0, 400)}`
    ).toBeTruthy();

    expect(errors, `pageerrors: ${errors.join("; ")}`).toEqual([]);
  });

  test("seed vehicles are C-Space, Grossglockner, BCB only", async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        /* ignore */
      }
    });

    await page.goto(`${LIVE}/`, { waitUntil: "networkidle", timeout: 90_000 });
    await page
      .getByTestId("alpine-demo-library")
      .getByRole("button", { name: /Grossglockner/i })
      .click();
    await expect(page).toHaveURL(/mode=create/, { timeout: 60_000 });
    // Pack restore lands on step 4 with vehicle summary visible
    await expect(
      page.getByText(/Véhicule \(étape Conducteur\)\s*:\s*Grossglockner/i)
    ).toBeVisible({ timeout: 90_000 });

    // Stepper accessible name is "3 Conducteur" (number + label)
    const conducteur = page
      .getByTestId("studio-stepper")
      .getByRole("button", { name: /Conducteur/i });
    await expect(conducteur).toBeVisible({ timeout: 15_000 });
    await conducteur.click();
    if (await page.getByRole("dialog").isVisible().catch(() => false)) {
      await page.getByRole("button", { name: /Fermer/i }).click().catch(() => {});
    }

    await expect
      .poll(
        async () => {
          const selects = page.locator("select");
          for (let i = 0; i < (await selects.count()); i++) {
            const texts = await selects.nth(i).locator("option").allTextContents();
            if (
              texts.some((t) => /C-Space/i.test(t)) &&
              texts.some((t) => /BCB/i.test(t))
            ) {
              return texts.filter((o) => !/^—/.test(o.trim()));
            }
          }
          return null;
        },
        { timeout: 30_000 }
      )
      .toEqual([
        "C-Space · C-Space",
        "Grossglockner · Grossglockner",
        "BCB · BCB",
      ]);
  });
});
