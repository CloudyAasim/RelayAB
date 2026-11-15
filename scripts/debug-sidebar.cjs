const { chromium } = require("@playwright/test");

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto("http://localhost:3100/login", { waitUntil: "networkidle" });
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "UiAudit-2026!");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 30000 }).catch(() => {});
  await page.goto("http://localhost:3100/dashboard", { waitUntil: "networkidle" });
  await page.context().addCookies([
    { name: "relayab_sidebar_pref", value: "collapsed", url: "http://localhost:3100" },
  ]);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  console.log("cookies:", await page.evaluate(() => document.cookie));
  console.log("state:", await page.getAttribute("aside", "data-state"));
  console.log("width:", await page.evaluate(() => document.querySelector("aside")?.getBoundingClientRect().width));
  await page.screenshot({ path: "artifacts/ui/debug-sidebar.png" });
  await browser.close();
})();
