import { test, expect } from "@playwright/test";

/** E7: Versus route + Créer nav highlight in AppHeader. */
test.describe("compare header nav", () => {
  test("Versus and Créer links show active state", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    await page.goto("/compare");
    const header = page.getByTestId("app-header");
    await expect(header).toBeVisible({ timeout: 20_000 });

    const versusLink = header.getByRole("link", { name: "Versus" });
    await expect(versusLink).toHaveClass(/bg-slate-900/);

    await page.goto("/?mode=create");
    await expect(header.getByRole("link", { name: "Créer" })).toHaveClass(
      /bg-slate-900/
    );
    await expect(
      header.getByRole("link", { name: /Banc d.essai/i })
    ).toHaveCount(0);

    expect(errors, `pageerrors: ${errors.join("; ")}`).toEqual([]);
  });
});
