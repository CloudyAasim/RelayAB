/**
 * scripts/ui-screenshots.cjs
 *
 * Capture every screen at desktop and phone widths, so a UI change can be
 * looked at instead of inferred from markup.
 *
 * Two passes:
 *   - **pages** — each route, as the role that may open it;
 *   - **scenes** — the sub-surfaces inside those pages: the assistant's settings
 *     drawer and thread list, the create dialogs, the row action menus. These
 *     are where "a second label saying the same thing" hides, because no route
 *     points at them.
 *
 * Usage (with the app already running):
 *
 *   pnpm ui:shots -- --base http://localhost:3100 --admin-user admin --admin-pass …
 *
 * It logs in through the real login API, seeds a handful of rows (one provider
 * of each kind, one account key) so edit dialogs and non-empty tables can be
 * shot, then writes `<out>/<name>-<width>.png` plus `problems.txt` with the page
 * errors, failed requests and horizontal overflows it saw.
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

/** Whole pages, and who may open them. */
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

/** Sub-surfaces: drawers, dialogs and menus opened from a page. */
const SCENES = [
  ["assistant-settings", "/dashboard/assistant", "user", clickSelector('button[title="助手设置"]')],
  ["assistant-settings-2", "/dashboard/assistant", "user", openAssistantSettings(700)],
  ["assistant-settings-3", "/dashboard/assistant", "user", openAssistantSettings(1500)],
  ["assistant-settings-4", "/dashboard/assistant", "user", openAssistantSettings(2400)],
  ["assistant-history", "/dashboard/assistant", "user", clickButton(/历史对话/)],
  ["dashboard-create-key", "/dashboard", "user", clickButton(/新建接口密钥/)],
  ["dashboard-key-menu", "/dashboard", "user", clickButton(/^操作$/)],
  ["admin-create-user", "/admin/users", "admin", clickButton(/新建用户/)],
  ["admin-user-menu", "/admin/users", "admin", clickButton(/^操作$/)],
  ["admin-create-provider", "/admin/providers", "admin", clickButton(/添加上游提供商/)],
  ["admin-create-media", "/admin/media-providers", "admin", clickButton(/新增供应商/)],
  ["admin-create-search", "/admin/search", "admin", clickButton(/新增搜索提供商/)],
  ["admin-create-key", "/admin/keys", "admin", clickButton(/新建接口密钥/)],
  ["admin-key-menu", "/admin/keys", "admin", clickButton(/^操作$/)],
  ["admin-allocation", "/admin/users", "admin", clickButton(/配置额度/)],
  ["admin-provider-edit", "/admin/providers", "admin", clickTitle("编辑")],
  ["admin-media-edit", "/admin/media-providers", "admin", clickTitle("编辑")],
  ["admin-model-expand", "/admin/model-notes", "admin", clickButton(/^▸/)],
  ["admin-key-rename", "/admin/keys", "admin", openMenuThen(/^操作$/, /重命名/)],
  ["user-key-edit", "/dashboard", "user", openMenuThen(/^操作$/, /编辑/)],
];

const VIEWPORTS = [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
];

function clickButton(name) {
  return async (page) => {
    await page.getByRole("button", { name }).first().click();
  };
}

function clickSelector(selector) {
  return async (page) => {
    await page.locator(selector).first().click();
  };
}

/** A row action button that names itself with a title attribute. */
function clickTitle(title) {
  return async (page) => {
    await page.locator(`button[title="${title}"]`).first().click();
  };
}

/** Open a row's ⋯ menu, then one of its items. */
function openMenuThen(menuName, itemName) {
  return async (page) => {
    await page.getByRole("button", { name: menuName }).first().click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: itemName }).first().click();
  };
}
/** The assistant's settings sheet, scrolled to a section. */
function openAssistantSettings(scrollTop) {
  return async (page) => {
    await page.locator('button[title="助手设置"]').first().click();
    await page.waitForTimeout(1500);
    await page.evaluate((top) => {
      const dialog = document.querySelector('[role="dialog"]');
      const scroller = dialog?.querySelector(".overflow-y-auto") ?? dialog;
      if (scroller) scroller.scrollTop = top;
    }, scrollTop);
  };
}

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

/** Rows worth having on screen: one provider per kind, and one account key. */
async function seed(contexts, problems) {
  /**
   * Idempotent by name.
   *
   * Every run used to POST another "UI 审计提供商", so the model-notes page grew
   * one duplicate row group per screenshot pass and the shots stopped looking
   * like a deployment. Existing rows are reused instead.
   */
  const exists = async (request, listUrl, name) => {
    const response = await request.get(`${BASE}${listUrl}`);
    if (!response.ok()) return false;
    const body = await response.json().catch(() => null);
    const providers = body?.data?.providers ?? body?.data ?? [];
    return Array.isArray(providers) && providers.some((entry) => entry?.name === name);
  };
  const post = async (request, url, data, label) => {
    const response = await request.post(`${BASE}${url}`, { data });
    const body = await response.json().catch(() => null);
    if (![200, 201, 409].includes(response.status()) || body?.ok === false) {
      problems.push(
        `seed ${label}: HTTP ${response.status()} ${JSON.stringify(body?.error ?? body).slice(0, 240)}`,
      );
    }
  };

  if (!(await exists(contexts.admin.request, "/api/admin/providers", "UI 审计提供商"))) {
    await post(contexts.admin.request, "/api/admin/providers", {
      name: "UI 审计提供商",
      kind: "openai",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-ui-audit",
      modelMapping: { "ui-model": "ui-model" },
      enabled: true,
    }, "text provider");
  }
  if (!(await exists(contexts.admin.request, "/api/admin/media-providers", "UI 审计媒体"))) {
    await post(contexts.admin.request, "/api/admin/media-providers", {
      name: "UI 审计媒体",
      baseUrl: "https://api.example.com",
      apiKey: "sk-ui-audit",
      mode: "advanced",
      models: { "ui-image": { upstreamId: "ui-image", pricePerItem: 1, enabled: true } },
      specs: [],
    }, "media provider");
  }
  if (!(await exists(contexts.admin.request, "/api/admin/search-providers", "UI 审计搜索"))) {
    await post(contexts.admin.request, "/api/admin/search-providers", {
      name: "UI 审计搜索",
      kind: "searxng",
      baseUrl: "http://127.0.0.1:9",
      apiKey: "",
      creditsPerCall: 1,
      enabled: true,
    }, "search provider");
  }
  const keys = await contexts.user.request.get(`${BASE}/api/user/keys`);
  const keyList = keys.ok() ? (await keys.json().catch(() => null))?.data?.keys ?? [] : [];
  if (!keyList.some((key) => key?.label === "UI 审计密钥")) {
    await post(contexts.user.request, "/api/user/keys", { label: "UI 审计密钥" }, "account key");
  }
}

async function shoot(page, file, problems, name) {
  const consoleErrors = [];
  const failed = [];
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  page.on("requestfailed", (request) =>
    failed.push(`${request.url()} ${request.failure()?.errorText ?? ""}`),
  );
  await page.waitForTimeout(600);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  await page.screenshot({ path: file, fullPage: true });
  if (overflow > 1) problems.push(`${name}: horizontal overflow ${overflow}px`);
  for (const error of consoleErrors) problems.push(`${name}: page error ${error.slice(0, 200)}`);
  for (const request of failed.slice(0, 5)) {
    problems.push(`${name}: request failed ${request.slice(0, 200)}`);
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const problems = [];
  let shots = 0;

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

  // Accounts and rows first: the create dialogs and edit menus only exist once
  // there is something to act on.
  const seedContexts = {
    admin: await makeContext({ width: 1440, height: 900 }, "admin"),
    user: await makeContext({ width: 1440, height: 900 }, null),
  };
  const created = await seedContexts.admin.request.post(`${BASE}/api/admin/users`, {
    data: { username: USER_USER, password: USER_PASS, role: "user" },
  });
  if (![200, 201, 409].includes(created.status())) {
    problems.push(`seed user: HTTP ${created.status()} ${(await created.text()).slice(0, 200)}`);
  }
  await login(seedContexts.user, USER_USER, USER_PASS);
  await seed(seedContexts, problems);
  await seedContexts.admin.close();
  await seedContexts.user.close();

  for (const [widthName, viewport] of VIEWPORTS) {
    const contexts = {};
    for (const auth of [null, "admin", "user"]) {
      contexts[auth ?? "public"] = await makeContext(viewport, auth);
    }

    for (const [name, route, auth] of ROUTES) {
      if (ONLY && !name.includes(ONLY)) continue;
      const page = await contexts[auth ?? "public"].newPage();
      try {
        const response = await page.goto(`${BASE}${route}`, { waitUntil: "networkidle", timeout: 30000 });
        if ((response?.status() ?? 0) >= 400) {
          problems.push(`${name}/${widthName}: HTTP ${response.status()} at ${route}`);
        }
        await shoot(page, path.join(OUT, `${name}-${widthName}.png`), problems, `${name}/${widthName}`);
        shots++;
      } catch (error) {
        problems.push(`${name}/${widthName}: ${String(error).slice(0, 300)}`);
      } finally {
        await page.close();
      }
    }

    for (const [name, route, auth, open] of SCENES) {
      if (ONLY && !name.includes(ONLY)) continue;
      const page = await contexts[auth].newPage();
      try {
        await page.goto(`${BASE}${route}`, { waitUntil: "networkidle", timeout: 30000 });
        await open(page);
        await shoot(page, path.join(OUT, `${name}-${widthName}.png`), problems, `${name}/${widthName}`);
        shots++;
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
  console.log(`shots: ${shots} → ${OUT}`);
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
