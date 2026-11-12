import { test, expect } from "@playwright/test";

test.describe("driver studio smoke", () => {
  test("mode=driver shows three-step studio", async ({ page }) => {
    await page.goto("/?mode=driver");
    await expect(page.getByTestId("driver-studio")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("Conducteur depuis traces")).toBeVisible();
    await expect(page.getByTestId("driver-studio-step-traces")).toBeVisible();
    await expect(page.getByText("1 · Traces")).toBeVisible();
    await expect(page.getByText("2 · Identifier")).toBeVisible();
    await expect(page.getByText("3 · Enregistré")).toBeVisible();
  });
});
