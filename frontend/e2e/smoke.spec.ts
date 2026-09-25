import { test, expect } from "@playwright/test";

/**
 * Smoke: home loads with CycleGen branding / studio entry; help opens; no crash.
 * Does not geocode or call external routing APIs.
 *
 * Prefer roles/names (stable a11y) with optional data-testid when HMR is fresh.
 */
test.describe("smoke", () => {
  test("home shows branding and studio", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    await page.goto("/");

    const header = page.getByTestId("app-header").or(page.getByRole("banner"));
    await expect(header).toBeVisible({ timeout: 15_000 });
    await expect(header.getByText("CycleGen")).toBeVisible();

    await expect(
      page.getByTestId("studio-home-title").or(
        page.getByRole("heading", { name: /^CycleGen/ })
      )
    ).toBeVisible();

    const help = page
      .getByTestId("help-button")
      .or(page.getByRole("button", { name: /ouvrir l’aide|aide/i }));
    if (await help.isVisible()) {
      await help.click();
      await expect(
        page.getByTestId("help-drawer").or(page.getByRole("dialog"))
      ).toBeVisible();
      await expect(page.getByText("Aide CycleGen")).toBeVisible();
    }

    expect(errors, `pageerrors: ${errors.join("; ")}`).toEqual([]);
  });
});
