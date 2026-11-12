import { test, expect } from "@playwright/test";

/**
 * Banc d'essai (IdeWorkspace) retiré de StudioHome:
 * `/?mode=ide` → history.replaceState → `/?mode=create` + CycleGenShell.
 * Keep one skip documenting IdeWorkspace-only chrome until migration resumes.
 */
test.describe("ide mode redirect", () => {
  test("mode=ide redirects to create shell (no ide-workspace)", async ({
    page,
  }) => {
    await page.goto("/?mode=ide", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/mode=create/, { timeout: 20_000 });
    await expect(page.getByTestId("ide-workspace")).toHaveCount(0);
    await expect(page.getByText("Adresse / GPS").first()).toBeVisible({
      timeout: 60_000,
    });
  });
});

test.describe.skip("ide workspace chrome (retired)", () => {
  // IdeWorkspace still exists under src/components/ide/ but is not mounted.
  // StudioHome redirects mode=ide → mode=create (CycleGenShell).
  test("driver row select and rebuild/update gates", async ({ page }) => {
    await page.goto("/?mode=ide");
    await expect(page.getByTestId("ide-workspace")).toBeVisible();
  });
});
