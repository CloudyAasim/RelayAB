/**
 * scripts/ui-screenshots.cjs
 *
 * Capture every screen at desktop and phone widths, so a UI change can be
 * looked at instead of inferred from markup.
 *
 * This is the "look at it" half of the UI review: the source-level guards
 * (`tests/unit/ui-density.test.ts`) say a label is not duplicated, this says the
 * page still reads the way it was meant to when it is actually rendered.
 *
 * Usage (with the app already running):
 *
 *   pnpm ui:shots -- --base http://localhost:3100 --admin-user admin --admin-pass …
 *
 * It logs in through the real login form, optionally creates a non-admin
 * account through the admin API (so the user screens can be shot too), then
 * writes `<out>/<name>-<width>.png` plus `console.log`-style problems it saw
 * (page errors, failed requests, horizontal overflow).
 *
 * Chrome comes from `pnpm exec playwright install chromium`; nothing is
 * downloaded here.
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("@playwright/test");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const BASE = (arg("base", "http://localhost:3100")).replace(/\/+$/, "");
const OUT = path.resolve(arg("out", "artifacts/ui"));
const ADMIN_USER = arg("admin-user", "admin");
const ADMIN_PASS = arg("admin-pass", "UiAudit-2026!");
const USER_USER = arg("user-user", "uiuser");
const USER_PASS = arg("user-pass", "UiAudit-2026!");
const ONLY = arg("only", "");

/** What to look at, and as whom. */
const ROUTES = [
  ["public-home", "/", null],
  ["public-login", "/login", null],
  ["public-docs", "/docs", null],
  ["public-docs-basics", "/docs/basics", null],
  ["public-license", "/license", null],
  ["admin-overview", "/admin", "admin"],
  ["admin-users", "/admin/users", "admin"],
  ["admin-keys", "/admin/keys", "admin"],
  ["admin-providers", "/admin/providers", "admin"],
  ["admin-media-providers", "/admin/media-providers", "admin"],
  ["admin-search", "/admin/search", "admin"],
  ["admin-model-notes", "/admin/model-notes", "admin"],
  ["admin-settings", "/admin/settings", "admin"],
  ["admin-usage", "/admin/usage", "admin"],
  ["admin-docs", "/admin/docs", "admin"],
  ["admin-docs-provider", "/admin/docs/provider", "admin"],
  ["user-dashboard", "/dashboard", "user"],
  ["user-usage", "/dashboard/usage", "user"],
  ["user-models", "/dashboard/models", "user"],
  ["user-settings", "/dashboard/settings", "user"],
  ["user-docs", "/dashboard/docs", "user"],
  ["user-assistant", "/dashboard/assistant", "user"],
];

const VIEWPORTS = [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
];

/**
 * Sign in through the API, not the form.
 *
 * The form is a React component: filling it before hydration submits the native
 * form (`method="post"` to `/login`) and never reaches the handler. The API sets
 * the same session cookie, and the cookie is what the shots need.
 */
async function login(context, username, password) {
  const response = await context.request.post(`${BASE}/api/auth/login`, {
    data: { username, password },
  });
  if (!response.ok()) {
    throw new Error(
      `login ${username}: HTTP ${response.status()} ${(await response.text()).slice(0, 200)}`,
    );
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const problems = [];
  const shots = [];

  const makeContext = async (viewport, auth) => {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      locale: "zh-CN",
      colorScheme: "light",
    });
    if (auth === "admin") await login(context, ADMIN_USER, ADMIN_PASS);
    if (auth === "user") await login(context, USER_USER, USER_PASS);
    return context;
  };

  /** The admin API needs a session; create the account once, before shooting. */
  const adminContext = await makeContext({ width: 1440, height: 900 }, "admin");
  const created = await adminContext.request.post(`${BASE}/api/admin/users`, {
    data: { username: USER_USER, password: USER_PASS, role: "user" },
  });
  if (![200, 201, 409].includes(created.status())) {
    problems.push(`create user: HTTP ${created.status()} ${(await created.text()).slice(0, 200)}`);
  }
  await adminContext.close();

  for (const [widthName, viewport] of VIEWPORTS) {
    const contexts = {};
    for (const auth of [null, "admin", "user"]) {
      contexts[auth ?? "public"] = await makeContext(viewport, auth);
    }
    for (const [name, route, auth] of ROUTES) {
      if (ONLY && !name.includes(ONLY)) continue;
      const context = contexts[auth ?? "public"];
      const page = await context.newPage();
      const consoleErrors = [];
      const failed = [];
      page.on("pageerror", (error) => consoleErrors.push(String(error)));
      page.on("requestfailed", (request) => failed.push(`${request.url()} ${request.failure()?.errorText ?? ""}`));
      try {
        const response = await page.goto(`${BASE}${route}`, { waitUntil: "networkidle", timeout: 30000 });
        await page.waitForTimeout(250);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        const file = path.join(OUT, `${name}-${widthName}.png`);
        await page.screenshot({ path: file, fullPage: true });
        shots.push(file);
        if ((response?.status() ?? 0) >= 400) {
          problems.push(`${name}/${widthName}: HTTP ${response.status()} at ${route}`);
        }
        if (overflow > 1) problems.push(`${name}/${widthName}: horizontal overflow ${overflow}px`);
        for (const error of consoleErrors) problems.push(`${name}/${widthName}: page error ${error.slice(0, 200)}`);
        for (const request of failed.slice(0, 5)) problems.push(`${name}/${widthName}: request failed ${request.slice(0, 200)}`);
      } catch (error) {
        problems.push(`${name}/${widthName}: ${String(error).slice(0, 300)}`);
      } finally {
        await page.close();
      }
    }
    for (const context of Object.values(contexts)) await context.close();
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, "problems.txt"), problems.length ? problems.join("\n") + "\n" : "");
  console.log(`shots: ${shots.length} → ${OUT}`);
  if (problems.length) {
    console.log(`problems: ${problems.length} (see ${path.join(OUT, "problems.txt")})`);
    for (const problem of problems.slice(0, 20)) console.log("  " + problem);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
