import { test, expect } from "@playwright/test";

/**
 * Studio shell: create mode shows sidebar / trajet step chrome.
 * No network keys required (no geocode / route analyze).
 */
test.describe("studio shell", () => {
  test("create mode shows sidebar and steps", async ({ page }) => {
    await page.goto("/?mode=create");

    await expect(
      page.getByTestId("app-header").or(page.getByRole("banner"))
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("banner").getByText("CycleGen")).toBeVisible();

    const sidebar = page.getByTestId("studio-sidebar").or(
      page.locator("aside").filter({ hasText: "Trajet" })
    );
    await expect(sidebar).toBeVisible({ timeout: 30_000 });
    await expect(sidebar.getByText("Trajet")).toBeVisible();

    await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Créer" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Versus" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Bibliothèque" })).toBeVisible();
  });
});
