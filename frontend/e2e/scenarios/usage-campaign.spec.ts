/**
 * Scenario campaign — screenshots under docs/audit/scenarios/<ID>/screenshots/
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../docs/audit/scenarios");

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

async function shot(page: Page, scenarioId: string, name: string) {
  const dir = path.join(ROOT, scenarioId, "screenshots");
  ensureDir(dir);
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

function writeProbe(scenarioId: string, data: Record<string, unknown>) {
  const dir = path.join(ROOT, scenarioId);
  ensureDir(dir);
  fs.writeFileSync(
    path.join(dir, "probe.json"),
    JSON.stringify({ ...data, at: new Date().toISOString() }, null, 2)
  );
}

function writeBugs(scenarioId: string, bugs: string[]) {
  const dir = path.join(ROOT, scenarioId);
  ensureDir(dir);
  const body =
    bugs.length === 0
      ? "# Bugs\n\nnone\n"
      : `# Bugs\n\n${bugs.map((b, i) => `${i + 1}. ${b}`).join("\n")}\n`;
  fs.writeFileSync(path.join(dir, "BUGS.md"), body);
}

/**
 * S1 — IdeWorkspace retired: mode=ide → create.
 * Substitute: driver library seeds (create/driver path) with finite a_max.
 */
test.describe("S1 drivers seed (ide redirect + library)", () => {
  test("mode=ide redirects; seed drivers expose finite a_max in library", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    const bugs: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    // 1) Assert IdeWorkspace is not mounted — redirect to create
    await page.goto("/?mode=ide", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/mode=create/, { timeout: 20_000 });
    await expect(page.getByTestId("ide-workspace")).toHaveCount(0);
    await expect(page.getByText("Adresse / GPS").first()).toBeVisible({
      timeout: 60_000,
    });
    await shot(page, "S1-drivers", "00-ide-redirect-create");

    // 2) Create-path substitute: Conducteur studio library seeds
    await page.goto("/?mode=driver", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("driver-studio")).toBeVisible({
      timeout: 20_000,
    });
    await page.getByTestId("driver-studio-library-tab").click();
    await expect(page.getByTestId("driver-library-panel")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole("button", { name: /^Seeds$/i }).click();
    await shot(page, "S1-drivers", "01-library-seeds");

    const rows = page.locator('[data-testid^="driver-lib-row-seed-"]');
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);

    const results: Array<Record<string, unknown>> = [];
    for (let i = 0; i < n; i++) {
      const row = rows.nth(i);
      const tid = (await row.getAttribute("data-testid")) || `idx-${i}`;
      const id = tid.replace("driver-lib-row-", "");
      const label = (await row.innerText()).replace(/\s+/g, " ").trim();
      const aMatch = label.match(/a=([0-9.]+)/);
      const aMaxVal = aMatch?.[1] ?? null;
      const num = aMaxVal != null ? Number(aMaxVal) : NaN;
      const ok = Number.isFinite(num) && num > 0;
      if (!ok) {
        bugs.push(
          `Driver ${id} (${label}): a_max invalid (${aMaxVal ?? "missing"})`
        );
      }
      if (/NaN|undefined/i.test(label)) {
        bugs.push(`Driver ${id}: library meta corrupted "${label}"`);
      }
      results.push({ id, label, a_max: aMaxVal, ok });
    }

    if (errors.length) {
      bugs.push(`pageerrors: ${errors.join(" | ")}`);
    }

    writeProbe("S1-drivers", {
      redirected: true,
      modeAfter: "create",
      ideWorkspaceMounted: false,
      substitute: "driver-library-panel seeds",
      n,
      results,
      errors,
      bugs,
    });
    writeBugs("S1-drivers", bugs);
    expect(bugs).toEqual([]);
  });
});

test.describe("S2 create shell", () => {
  test("create mode shows sidebar and steps", async ({ page }) => {
    test.setTimeout(90_000);
    const bugs: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto("/?mode=create", { waitUntil: "domcontentloaded" });
    // Wait for shell content (dynamic import of CycleGenShell)
    await expect(page.getByText("Adresse / GPS").first()).toBeVisible({
      timeout: 60_000,
    });
    await shot(page, "S2-create", "00-loaded");
    const body = await page.locator("body").innerText();
    if (/Ouverture du créateur/i.test(body)) {
      bugs.push("Create shell stuck on dynamic import loading");
    }
    if (!/Trajet|Contraintes|Conducteur|Cycle/i.test(body)) {
      bugs.push("Create shell: wizard steps Trajet/Contraintes/Conducteur/Cycle missing");
    }
    await shot(page, "S2-create", "01-body");
    if (errors.length) bugs.push(`pageerrors: ${errors.join(" | ")}`);
    writeProbe("S2-create", { bodySnippet: body.slice(0, 800), errors, bugs });
    writeBugs("S2-create", bugs);
    expect(errors).toEqual([]);
    expect(bugs).toEqual([]);
  });
});

test.describe("S3 navigation hub", () => {
  test("home links to Conducteur Versus Create", async ({ page }) => {
    const bugs: string[] = [];
    await page.goto("/");
    await shot(page, "S3-nav", "00-home");
    await page.getByRole("link", { name: /Conducteur/i }).first().click();
    await expect(page).toHaveURL(/mode=driver/);
    await shot(page, "S3-nav", "01-driver");
    await page.getByRole("link", { name: /Versus/i }).first().click();
    await expect(page).toHaveURL(/compare|Versus|versus/i);
    await shot(page, "S3-nav", "02-versus");
    await page.getByRole("link", { name: /Créer|Creer/i }).first().click();
    await expect(page).toHaveURL(/mode=create/);
    await shot(page, "S3-nav", "03-create");
    writeProbe("S3-nav", { bugs });
    writeBugs("S3-nav", bugs);
  });
});

test.describe("S4 driver studio", () => {
  test("opens conductor studio from home link path", async ({ page }) => {
    const bugs: string[] = [];
    await page.goto("/?mode=driver");
    await expect(page.getByTestId("driver-studio")).toBeVisible({
      timeout: 20_000,
    });
    if (!(await page.getByTestId("driver-studio-step-traces").isVisible())) {
      bugs.push("Driver studio step Traces not visible");
    }
    await shot(page, "S4-fingerprint", "00-open");
    writeProbe("S4-fingerprint", { bugs, mode: "driver" });
    writeBugs("S4-fingerprint", bugs);
    expect(bugs).toEqual([]);
  });
});

/**
 * S5–S8 were IdeWorkspace-only (fit drawer, vehicle/roadlaw explorer,
 * rebuild/update gates, driverId sync race). StudioHome no longer mounts
 * IdeWorkspace — mode=ide redirects to create. Keep ONE skip with reason.
 * Original bodies preserved below for when IDE remounts.
 */
test.describe.skip("S5–S8 IdeWorkspace-only (retired)", () => {
  // Reason: StudioHome redirects /?mode=ide → /?mode=create + CycleGenShell;
  // ide-workspace / fit-job-drawer / asset explorer testids are not mounted.
  // Re-enable when IdeWorkspace is wired again (refonte workspace).

  test("S5 opens Fit RS drawer", async ({ page }) => {
    const bugs: string[] = [];
    await page.goto("/?mode=ide");
    await expect(page.getByTestId("ide-workspace")).toBeVisible({
      timeout: 20_000,
    });
    await page.getByTestId("ide-open-fit").click();
    const drawer = page.getByTestId("fit-job-drawer");
    if (!(await drawer.isVisible())) {
      bugs.push("Fit RS drawer did not open");
    }
    await shot(page, "S5-fit", "00-open");
    writeProbe("S5-fit", { bugs });
    writeBugs("S5-fit", bugs);
    expect(bugs).toEqual([]);
  });

  test("S6 select vehicle and road law", async ({ page }) => {
    const bugs: string[] = [];
    await page.goto("/?mode=ide");
    await expect(page.getByTestId("ide-workspace")).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole("button", { name: /Véhicules/i }).click();
    const vRow = page.locator('[data-testid^="ide-asset-row-vehicle-"]').first();
    if (await vRow.count()) {
      await vRow.click();
      const vi = page.getByTestId("vehicle-inspector");
      if (!(await vi.isVisible())) {
        bugs.push("Vehicle inspector not visible after vehicle click");
      }
      await shot(page, "S6-vehicle-law", "00-vehicle");
    } else {
      bugs.push("No vehicle rows in explorer");
    }

    await page.getByRole("button", { name: /Lois de route/i }).click();
    const lawRow = page
      .locator('[data-testid^="ide-asset-row-roadLaw-"]')
      .first();
    if (await lawRow.count()) {
      await lawRow.click();
      const li = page.getByTestId("roadlaw-inspector");
      if (!(await li.isVisible())) {
        bugs.push("RoadLaw inspector not visible after law click");
      }
      await shot(page, "S6-vehicle-law", "01-law");
    } else {
      bugs.push("No roadLaw rows in explorer");
    }

    writeProbe("S6-vehicle-law", { bugs });
    writeBugs("S6-vehicle-law", bugs);
    expect(bugs).toEqual([]);
  });

  test("S7 rebuild and update disabled without corridor", async ({ page }) => {
    const bugs: string[] = [];
    await page.goto("/?mode=ide");
    await expect(page.getByTestId("ide-workspace")).toBeVisible({
      timeout: 20_000,
    });
    const rebuild = page.getByTestId("ide-rebuild-corridor");
    const update = page.getByTestId("ide-update-dynamics");
    const rb = await rebuild.getAttribute("data-enabled");
    const up = await update.getAttribute("data-enabled");
    await shot(page, "S7-gates", "00-gates");
    if (rb === "true" && up === "true") {
      bugs.push(
        "INFO: Rebuild+Update both enabled (session/trip hydrate?) — verify intentional"
      );
    }
    writeProbe("S7-gates", { rebuildEnabled: rb, updateEnabled: up, bugs });
    writeBugs("S7-gates", bugs.filter((b) => !b.startsWith("INFO:")));
  });

  test("S8 explorer pick must set config.driverId before dynamics", async ({
    page,
  }) => {
    const bugs: string[] = [];
    await page.goto("/?mode=ide");
    await expect(page.getByTestId("ide-workspace")).toBeVisible({
      timeout: 20_000,
    });

    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      const store = w.__CG_WORKSPACE__ ?? null;
      if (store?.getState?.()?.setGeometry) {
        store.getState().setGeometry({
          corridor: {
            S: [0, 100, 200],
            speed_limit: [50, 50, 50],
            grade: [0, 0, 0],
            curvature: [0, 0, 0],
            geometry: [
              { lat: 45, lon: 6 },
              { lat: 45.001, lon: 6.001 },
              { lat: 45.002, lon: 6.002 },
            ],
          },
          corridorId: "e2e-fake",
          routePoints: [
            { lat: 45, lon: 6 },
            { lat: 45.002, lon: 6.002 },
          ],
        });
      } else {
        w.__CG_S8_NO_STORE__ = true;
      }
    });

    const noStore = await page.evaluate(
      () =>
        !!(window as unknown as { __CG_S8_NO_STORE__?: boolean }).__CG_S8_NO_STORE__
    );

    const rows = page.locator('[data-testid^="ide-asset-row-driver-"]');
    const n = await rows.count();
    expect(n).toBeGreaterThan(1);

    const firstId = (
      (await rows.nth(0).getAttribute("data-testid")) || ""
    ).replace("ide-asset-row-driver-", "");
    const secondId = (
      (await rows.nth(1).getAttribute("data-testid")) || ""
    ).replace("ide-asset-row-driver-", "");

    await rows.nth(0).click();
    await expect(page.getByTestId("ide-selection-state")).toContainText(
      `driver=${firstId}`
    );

    await rows.nth(1).click();
    const immediate = await page.evaluate(async () => {
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r))
      );
      const el = document.querySelector('[data-testid="ide-selection-state"]');
      return el?.textContent ?? "";
    });

    await shot(page, "S8-driverId-race", "00-after-second-click");

    if (!immediate.includes(`driver=${secondId}`)) {
      bugs.push(
        `BUG-SC-001: after explorer click on ${secondId}, config.driverId not synced within 2 rAF → "${immediate}" (AssetExplorer.pick omits driverId; dynamics may use previous driver)`
      );
    }
    if (noStore) {
      bugs.push(
        "INFO: __CG_WORKSPACE__ not exposed — race with scheduleUpdateDynamics not instrumented; source review still applies"
      );
    }

    writeProbe("S8-driverId-race", {
      firstId,
      secondId,
      immediate,
      noStore,
      bugs,
    });
    writeBugs(
      "S8-driverId-race",
      bugs.filter((b) => !b.startsWith("INFO:"))
    );
  });
});
