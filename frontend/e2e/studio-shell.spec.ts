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

    const nav = page.getByRole("navigation", { name: "Principal" });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("link", { name: /Créer/i })).toBeVisible();
    await expect(nav.getByRole("link", { name: /Versus/i })).toBeVisible();
    await expect(
      nav.getByRole("link", { name: /Bibliothèque/i })
    ).toBeVisible();

    const stepper = page.getByTestId("studio-stepper");
    await expect(stepper).toBeVisible();
    await expect(stepper.getByRole("button", { name: /Trajet/i })).toBeVisible();
    await expect(stepper.getByText("Conducteur")).toBeVisible();
    await expect(stepper.getByText("Cycle")).toBeVisible();
  });
});
