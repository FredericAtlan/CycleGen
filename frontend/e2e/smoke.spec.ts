import { test, expect } from "@playwright/test";

/**
 * Smoke: home loads with CycleGen branding / studio entry; help opens; no crash.
 * Does not geocode or call external routing APIs.
 */
test.describe("smoke", () => {
  test("home shows branding and studio", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    await page.goto("/");
    await expect(page.getByTestId("app-header")).toBeVisible();
    await expect(page.getByTestId("app-brand")).toHaveText(/CycleGen/i);
    await expect(page.getByTestId("studio-home")).toBeVisible();
    await expect(page.getByTestId("studio-home-title")).toContainText(
      "CycleGen Studio"
    );

    const help = page.getByTestId("help-button");
    if (await help.isVisible()) {
      await help.click();
      await expect(page.getByTestId("help-drawer")).toBeVisible();
      await expect(page.getByText("Aide CycleGen")).toBeVisible();
    }

    expect(errors, `pageerrors: ${errors.join("; ")}`).toEqual([]);
  });
});
