import { test, expect } from "@playwright/test";

/**
 * Studio shell: create mode shows sidebar / trajet step chrome.
 * No network keys required (no geocode / route analyze).
 */
test.describe("studio shell", () => {
  test("create mode shows sidebar and steps", async ({ page }) => {
    await page.goto("/?mode=create");

    await expect(page.getByTestId("app-header")).toBeVisible();
    await expect(page.getByTestId("app-brand")).toHaveText(/CycleGen/i);

    // Sidebar + trajet accordion (step 1)
    await expect(page.getByTestId("studio-sidebar")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("studio-sidebar").getByText("Trajet")).toBeVisible();

    // Wizard steps in header (labels may be truncated on narrow viewports)
    await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Studio" })).toBeVisible();
  });
});
