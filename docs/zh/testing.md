# 测试策略与规范

> 测试金字塔：**单元 → 集成 → 冒烟（端到端）**。
> 每个模块产出代码 + 至少一个对应的测试文件。

```bash
pnpm test          # 单元 + 集成（无网络依赖）
pnpm smoke         # 端到端冒烟：真实 next dev + 内存 Redis + mock 上游
pnpm type-check && pnpm build
```

---

## 1. 单元测试（Vitest）

### 1.1 覆盖范围

目前共有 **66 个单元测试文件**。下表是**代表性样本**，并非穷举清单——运行
`ls tests/unit/` 可查看完整列表。

| 模块 | 代表性文件 |
|---|---|
| 配置 / 派生密钥 | `tests/unit/config.test.ts`、`config-public-url.test.ts` |
| `crypto/secrets`（AES-256-GCM） | `tests/unit/crypto-secrets.test.ts` |
| `crypto/hashing`（sha256 / 前缀） | `tests/unit/crypto-hashing.test.ts` |
| `crypto/password`（bcrypt，含同步版本） | `tests/unit/crypto-password.test.ts` |
| session（iron-session 选项） | `tests/unit/auth-session.test.ts` |
| Bearer 解析 + Key 校验 | `tests/unit/auth-apikey.test.ts` |
| 错误词汇表 | `tests/unit/api-errors.test.ts` |
| SQLite 内存库（:memory:）连接与建表 | `tests/unit/db-types.test.ts`、`bootstrap.test.ts` |
| 类型 / schema | `tests/unit/db-types.test.ts` |
| 内置 bootstrap 流程 | `tests/unit/bootstrap.test.ts` |
| 配额 | `tests/unit/quota-rates.test.ts`、`quota-calculator.test.ts`、`credit-pool.test.ts` |
| 积分 | `tests/unit/credits.test.ts` |
| **并发** | `tests/unit/concurrency.test.ts` |
| **登录限流** | `tests/unit/login-throttle.test.ts` |
| **安全加固** | `tests/unit/security-hardening.test.ts` |
| `proxy/openai` | `tests/unit/proxy-openai.test.ts`、`proxy-openai-stream.test.ts` |
| `proxy/anthropic` | `tests/unit/proxy-anthropic.test.ts`、`proxy-anthropic-stream.test.ts`、`proxy-anthropic-thinking.test.ts` |
| **流式边界情况** | `tests/unit/proxy-stream-disconnect.test.ts`、`proxy-strip-stream-options.test.ts`、`stream-stopgap.test.ts` |
| **Responses 协议转换** | `tests/unit/proxy-responses-conversion.test.ts` |
| **媒体引擎** | `tests/unit/media-engine.test.ts`、`media-engine-hardening.test.ts`、`media-engine-iterator.test.ts`、`media-fetch.test.ts` |
| **媒体协议 + 判官** | `tests/unit/media-spec-v2.test.ts`、`media-spec-check.test.ts`、`spec-check-standalone.test.ts` |
| **协议文档** | `tests/unit/media-protocol-doc.test.ts`、`docs-spec-check-page.test.ts` |
| **Middleware** | `tests/unit/middleware-cors.test.ts`、`middleware-v1-clean.test.ts` |
| **i18n** | `tests/unit/i18n.test.ts`、`i18n-dict.test.ts`、`i18n-dict-hygiene.test.ts`、`i18n-usage.test.ts` |
| **时区处理** | `tests/unit/timezone.test.ts` |
| **用量上报** | `tests/unit/usage-load.test.ts`、`usage-recent.test.ts`、`usage-report.test.ts`、`usage-totals.test.ts`、`usage-view-prefs.test.ts` |
| **UI 不变量** | `tests/unit/ui-invariants.test.ts`、`ui-primitives.test.ts`、`nav-*.test.ts`、`card-padding.test.ts` |
| **License / 路由面** | `tests/unit/license-completeness.test.ts`、`public-path-routes.test.ts` |

### 1.2 工具
- 纯函数，无副作用，无需 mock。
- 用 `vitest` 内置断言 + `@vitest/expect`。

### 1.3 运行
```bash
pnpm test:unit
```

---

## 2. 集成测试（Vitest + Next.js Route Handler）

### 2.1 测试环境
- 进程内直接跑仓库层与代理层，不启动 HTTP server。
- 数据库：`RELAY_DB_PATH=`:memory:` `（见 `tests/setup.ts`），每个测试文件一份独立内存库，无需任何外部服务。
- 上游 AI：代理层把 HTTP transport 抽象成 `fetchImpl`，测试注入假的 fetch，无需网络。

### 2.2 覆盖范围

目前共有 **16 个集成测试文件**，进程内驱动真实的 Route Handler：

| 测试文件 | 覆盖内容 |
|---|---|
| `tests/integration/repos.test.ts` | users / keys / providers / usage 仓库：CRUD、索引、分页、配额累加、`bootstrapAdminIfNeeded` 幂等 |
| `tests/integration/models-route.test.ts` | `GET /v1/models` 与 `/anthropic/v1/models` |
| `tests/integration/responses-surface.test.ts` | OpenAI Responses 接口面 |
| `tests/integration/anthropic-surface.test.ts` | Anthropic Messages 接口面 |
| `tests/integration/streaming-routes.test.ts` | 经由 Route Handler 的 SSE 流式传输 |
| `tests/integration/media-images.test.ts` | 图像生成与编辑，按项计费 |
| `tests/integration/media-audio-video.test.ts` | 视频轮询、语音字节、multipart 转录 |
| `tests/integration/media-catalog-capability.test.ts` | 目录为每个模型标注服务它的 spec |
| `tests/integration/user-self-service.test.ts` | 用户面板管理自己的 Key |
| `tests/integration/provider-faces.test.ts` | 一个 Provider 的两个协议面 |
| `tests/integration/admin-provider-patch.test.ts`、`admin-rename-patch.test.ts` | 管理端 Provider 更新 |
| `tests/integration/admin-user-form-routes.test.ts` | 管理端用户表单路由 |
| `tests/integration/bootstrap-race.test.ts`、`create-user-race.test.ts`、`bootstrap-no-throw.test.ts` | 并发 bootstrap 与用户创建 |

> 路由级（HTTP）行为由 `pnpm smoke` 覆盖——见第 3 节。Cookie 鉴权依赖
> `next/headers`，只有真实请求上下文才能完整验证，因此在 HTTP 层测而不是 import
> Route Handler。

### 2.3 用例模板

```typescript
// tests/integration/repos.test.ts（节选）
import { beforeEach, expect, it } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { __resetConfigForTest } from "@/lib/config";
import { createApiKey, getApiKeyById } from "@/lib/db/keys";

// 丢掉缓存的连接；下一次访问会用 RELAY_DB_PATH（:memory:）重开一个干净的库
beforeEach(() => {
  __resetDbForTest();
  __resetConfigForTest();
});

it("creating a key returns the plaintext once and stores only the hash", async () => {
  const { key, plainKey } = await createApiKey({
    userId: "u1",
    label: "demo",
    quotaType: "credits",
    quotaLimit: 500_000, // 0.001 积分单位 → 500 积分
  });
  expect(plainKey.startsWith("sk-relay-")).toBe(true);
  expect(await getApiKeyById(key.id)).not.toHaveProperty("plainKey");
});
```

### 2.4 运行
```bash
pnpm test:integration
```

---

## 3. 冒烟测试（真实 HTTP 端到端）

`scripts/smoke-local.sh` 会启动真实的 `next dev`，配一个**临时 SQLite 文件库**
（`RELAY_DB_PATH` 指向脚本自建的临时路径，跑完删除）和一个本地 **mock OpenAI
上游**，然后按真实请求链路逐项断言：

| 检查 | 断言 |
|---|---|
| `GET /healthz` | `{"ok":true,...}` |
| 空库首次登录 | 自动创建 admin 并可登录（bootstrap 生效） |
| 错误密码 | 401 |
| `/api/auth/me` | session 跨路由可用 |
| 无 cookie 访问 `/api/admin/users` | 403 |
| `POST /api/admin/keys` | 返回明文 `sk-relay-...`（仅此一次） |
| `POST /v1/chat/completions` | 转发成功，返回上游响应 |
| mock 上游收到 | 解密后的 Provider Key + 映射后的模型名 |
| `/api/admin/usage` | 用量 +1 次请求，`creditsUsed` = 1（0.001 积分精度） |
| Key 额度 | `quotaUsed` 增加 1（0.001 积分单位） |
| 未知 Key / 未映射模型 | 401 / `model_not_mapped` |

### 3.1 运行
```bash
pnpm smoke                      # 默认端口 3211 / 上游 8891
SMOKE_PORT=3300 pnpm smoke      # 自定义端口
```

### 3.2 说明

- 完全离线，不需要 Upstash / OpenAI 账号。
- 浏览器级 Playwright 用例**确实存在**——`tests/e2e/login.spec.ts`，由
  `playwright.config.ts`（`testDir: "./tests/e2e"`）接入，可用 `pnpm test:e2e`
  （`playwright test`）运行。本文档早期版本称它们「尚未实现」、称 `test:e2e` 是占位
  脚本；这两点曾经属实，但现已不成立。浏览器测试需要运行中的 dev server，因此
  被排除在 `pnpm test` 之外；无需浏览器做流程级验证请用 `pnpm smoke`。

---

## 4. 覆盖率目标

| 类别 | 目标 |
|---|---|
| 单元 + 集成 | 业务逻辑 ≥ 80%，密码/加密模块 ≥ 95% |
| E2E | 关键流程 100%（登录、建 Key、调用代理） |

---

## 5. 调试技巧

### 5.1 看一下库里现在有什么
```bash
# 库就是一个 SQLite 文件；RELAY_DB_PATH 不设则默认 ./data/relayab.db
DB="${RELAY_DB_PATH:-./data/relayab.db}"
sqlite3 "$DB" ".tables"
sqlite3 "$DB" "SELECT id, username, role FROM users;"
sqlite3 "$DB" "SELECT name, base_url, enabled FROM providers;"
```

测试跑完留下的库可以直接删：`RELAY_DB_PATH=:memory:` 的话更是退出即消失。
应用运行中不要用 `sqlite3` 写库，只读查询是安全的。

### 5.2 复现加密 round-trip
```typescript
import { encryptSecret, decryptSecret } from "@/lib/crypto/secrets";
const ct = encryptSecret("sk-upstream-xxx");
const pt = decryptSecret(ct);
console.assert(pt === "sk-upstream-xxx");
```

---

## 6. CI 建议（v1 跳过，本地手跑）

> ⚠️ **本仓库没有 CI。** 没有 `.github/` 目录，也没有 workflow 文件。下面这段是
> 一个 workflow *建议* 会运行的内容——它不是真实存在的文件，也没有任何东西会自动
> 运行它。

```yaml
# 建议，仓库中并不存在
- run: pnpm test:unit
- run: pnpm test:integration
- run: pnpm test:e2e
```
