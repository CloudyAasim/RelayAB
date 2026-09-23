/**
 * E2E tests for the login page across viewports.
 *
 * The page should:
 *   - Fit in the viewport (no vertical scrolling)
 *   - Center the form horizontally
 *   - Show the brand, form, and footer link
 */
import { test, expect } from "@playwright/test";

const VIEWPORTS = [
  { name: "mobile-s", width: 375, height: 667 },
  { name: "mobile-m", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "desktop", width: 1440, height: 900 },
];

for (const vp of VIEWPORTS) {
  test(`login page fits viewport @ ${vp.name} (${vp.width}x${vp.height})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/login");

    // Body should not be scrollable vertically.
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const clientHeight = await page.evaluate(() => document.documentElement.clientHeight);
    expect(scrollHeight).toBeLessThanOrEqual(clientHeight + 1);

    // Body width should also fit (no horizontal scroll either).
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    // Required elements visible.
    await expect(page.getByRole("heading", { name: "RelayAB" })).toBeVisible();
    await expect(page.getByLabel(/用户名|username/i)).toBeVisible();
    await expect(page.getByLabel(/密码|password/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /登录|sign in/i })).toBeVisible();
  });
}

test("login page: theme toggle is accessible", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/login");
  // The theme toggle button should be visible.
  const themeButton = page.locator('button[aria-label*="theme" i], button[aria-label*="主题" i]');
  await expect(themeButton.first()).toBeVisible();
});

test("login page: back to home link is accessible", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/login");
  const backLink = page.getByRole("link", { name: /返回|back/i });
  await expect(backLink.first()).toBeVisible();
});
