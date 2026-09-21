# RelayAB — 架构与设计文档

> 一个自托管的 AI API 网关（API 中转站），用于将上游 AI 服务的 API Key
> 安全、可控地分享给少数用户，并实现精细的权限和用量管理。

---

## 1. 目标与非目标

### 1.1 目标
- 单一 Vercel 项目即可部署，不需要额外服务器。
- 管理少量（个位数）用户和每个用户的多把 API Key。
- 每把 Key 可配置：额度上限、过期时间、启用状态、模型限制。
- 提供兼容 OpenAI Chat Completions 与 Anthropic Messages 的代理接口。
- 实时扣减额度、记录用量、可查询日志。
- 用户密码、上游 API Key 均加密/单向散列后存储，泄漏数据库无法还原。

### 1.2 非目标（v1 不做）
- 多租户 SaaS 化（仅做单实例）。
- 复杂的支付与发票系统。
- 模型市场的 A/B 测试。
- 公开注册的注册流程（仅管理员创建用户）。

---

## 2. 顶层架构

```
                                ┌──────────────────────────────────────┐
   ┌────────┐  Bearer sk-xxx    │            Vercel 平台              │
   │ Client │ ────────────────► │  ┌────────────────────────────────┐ │
   └────────┘                   │  │  Next.js 15 App Router          │ │
                                │  │                                │ │
                                │  │  /v1/chat/completions           │ │
                                │  │  /anthropic/v1/messages         │ │
                                │  │  /api/admin/*                   │ │
                                │  │  /api/auth/*                    │ │
                                │  │  /dashboard, /admin/*           │ │
                                │  │                                │ │
                                │  │  ┌──────────────────────────┐ │ │
                                │  │  │   RelayAB 核心库         │ │ │
                                │  │  │   ├─ 认证 (iron-session) │ │ │
                                │  │  │   ├─ 加密 (AES-GCM)      │ │ │
                                │  │  │   ├─ 额度引擎            │ │ │
                                │  │  │   ├─ 上游路由            │ │ │
                                │  │  │   └─ Vercel REST 客户端  │ │ │
                                │  │  └──────────────────────────┘ │ │
                                │  └────────────────────────────────┘ │
                                │                  │                  │
                                │                  ▼                  │
                                │  ┌────────────────────────────────┐ │
                                │  │  Upstash Redis (KV + 持久化)   │ │
                                │  │  users / api_keys / providers  │ │
                                │  │  usage_logs / sessions         │ │
                                │  └────────────────────────────────┘ │
                                │                  │                  │
                                │                  ▼                  │
                                │  ┌────────────────────────────────┐ │
                                │  │  上游 AI Provider              │ │
                                │  │  OpenAI / Anthropic / MiniMax  │ │
                                │  └────────────────────────────────┘ │
                                └──────────────────────────────────────┘
```

### 2.1 关键设计决策

| 主题 | 决策 | 理由 |
|---|---|---|
| 部署平台 | Vercel 免费版 | 用户要求；Next.js 适配最好；无额外运维负担 |
| 框架 | Next.js 15 App Router | Server Actions / Route Handlers 同源；SSR 友好 |
| 数据存储 | **Vercel Marketplace → Upstash for Redis**（或独立 Upstash，API 完全一致） | 一键安装；Region 自动匹配；REST 访问，无连接池 |
| 认证 | iron-session + bcryptjs | 轻量、Edge 兼容、无外部依赖；bcryptjs 纯 JS |
| 上游 Key 加密 | AES-256-GCM，主密钥从 env | 标准做法；与 TokenPlan 思路一致 |
| Vercel API 调用 | `@vercel/sdk` | 官方 SDK 类型完整；切换 baseURL 一行实现本地 mock |
| 本地 mock | `@emulators/adapter-next` | 嵌入式零端口；测试无需独立进程 |
| AI 代理 | Vercel AI SDK (`ai`) + `@ai-sdk/openai` / `@ai-sdk/anthropic` | 支持流式、自定义 baseURL、模型映射 |
| UI | Tailwind CSS + 自写组件 | 体积小、可控；不引入 shadcn 减少认知负担 |
| 测试 | Vitest + Playwright | Vitest 与 Vite/Turbopack 集成好；Playwright 是 Vercel 推荐 E2E |

---

## 3. 数据模型

详细定义见 [`DATA_MODEL.md`](./DATA_MODEL.md)。概要：

| 表/键 | 用途 | 主键 |
|---|---|---|
| `user:{id}` | 用户档案 + 角色 + 密码散列 + **积分池** (`quotaType`/`quotaLimit`/`quotaUsed`) + 模型白名单 | `id` |
| `user:by-username:{username}` | 用户名 → id 反查 | `username` |
| `apikey:{id}` | 客户 Key 凭证（散列 / 启用 / 过期 / 模型收窄）。**不含额度字段** | `id` |
| `apikey:hash:{hash}` | API Key 哈希 → id（用于 Bearer 校验） | `sha256(key)` |
| `apikey:by-user:{userId}` | 用户的 Key 列表（Set） | `userId` |
| `provider:{id}` | 上游 Provider 配置 + 加密的 API Key | `id` |
| `usage:{apikeyId}:{yyyymm}` | 月度用量（tokens + creditsUsed） | `apikeyId + 月份` |
| `log:{apikeyId}:{ulid}` | 单次请求日志 | `ulid` |
| `session:{sid}` | iron-session 内部 | `sid` |

所有 Redis 键使用前缀 `relay:` 避免与其它业务冲突。

---

## 4. API 路由设计

详细定义见 [`API_ROUTES.md`](./API_ROUTES.md)。概要：

### 4.1 公开代理接口（用 API Key 鉴权）

| 路径 | 方法 | 用途 |
|---|---|---|
| `/v1/chat/completions` | POST | OpenAI 兼容 |
| `/v1/models` | GET | OpenAI 兼容（返回允许的模型） |
| `/anthropic/v1/messages` | POST | Anthropic 兼容 |
| `/healthz` | GET | 健康检查（无需鉴权） |

### 4.2 管理 API（用 Session 鉴权）

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/auth/login` | POST | 用户名/密码登录 |
| `/api/auth/logout` | POST | 登出 |
| `/api/auth/change-password` | POST | 用户自助修改密码（需原密码 + 两次新密码） |
| `/api/config` | GET | 公共运行时信息（公网 URL、OpenAI/Anthropic 兼容端点） |
| `/api/user/keys` | GET / POST | 普通用户列出 / 创建自己的 Key（额度继承自分配） |
| `/api/user/keys/[id]` | PATCH / DELETE | 普通用户改名 / 启用停用 / 删除自己的 Key |
| `/api/admin/users` | GET / POST | 用户列表 / 创建（含每用户额度分配） |
| `/api/admin/users/[id]` | GET / PATCH / DELETE | 用户详情 / 编辑 / 删除 |
| `/api/admin/users/[id]/reset-password` | POST | 重置密码 |
| `/api/admin/keys` | GET / POST | Key 列表 / 创建 |
| `/api/admin/keys/[id]` | GET / PATCH / DELETE | Key 详情 / 编辑 / 删除 |
| `/api/admin/keys/[id]/toggle` | POST | 启用/禁用 |
| `/api/admin/providers` | GET / POST | Provider 列表 / 创建 |
| `/api/admin/providers/[id]` | GET / PATCH / DELETE | Provider 管理 |
| `/api/admin/usage` | GET | 全局用量统计 |

### 4.3 嵌入式 Mock（仅开发环境）

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/_emu/vercel/[...path]` | ANY | 转发到 `@emulators/vercel` |

---

## 5. 加密与安全

### 5.1 用户密码
- 算法：**bcryptjs**，work factor = 12（可调）。
- 存储：仅保存散列，**永不存储明文**。
- 验证：`bcrypt.compare(password, hash)`。
- 重置：管理员在后台生成新随机密码并展示一次。

### 5.2 客户 API Key（用户面板创建的 Key）
- 格式：`sk-relay-` + 32 字节 base62（共 ~43 字符）。
- 存储：
  - `keyHash = sha256(key)`（用于 Bearer 校验反查）。
  - `keyPrefix = key.slice(0, 12)` + `...` + `key.slice(-4)`（仅用于列表展示）。
  - **明文仅在创建时返回一次**，之后不再可读。
- 校验：客户端传 `Authorization: Bearer <key>` → 服务端 `sha256` → 反查 Redis → 命中则拉取完整记录。

### 5.3 上游 Provider API Key（最重要的安全点）
- 算法：**AES-256-GCM**。
- 主密钥：环境变量 `RELAY_MASTER_KEY_HEX`（64 hex chars = 32 bytes）。
- 每次写入随机生成 12 字节 IV，附加 16 字节 auth tag。
- 数据库里只存 `iv || ciphertext || authTag`（base64 编码）。
- **库封装**：`src/lib/crypto/secrets.ts`
  ```ts
  encryptSecret(plaintext): string   // 返回 base64(iv|ct|tag)
  decryptSecret(blob): string      // 输入 base64，输出明文（仅在调用上游时使用）
  ```
- 主密钥丢失 = 所有上游 Key 永久不可用 → 必须备份。

### 5.4 Session Cookie
- 库：**iron-session 8**。
- 存储：HttpOnly + Secure + SameSite=Lax cookie，加密后约 1 KB。
- 不使用 JWT（服务端可主动失效）。

### 5.5 Vercel 部署保护
- 若项目设置 Deployment Protection，自动跳过需在请求中加：
  ```
  x-vercel-protection-bypass: <secret>
  ```
- RelayAB 自身 API 透传该 header（中间件层处理）。
- 详见 [`DEPLOYMENT.md`](./DEPLOYMENT.md#6-部署保护绕过)。

---

## 6. 额度与用量引擎

### 6.1 积分池挂在账号上

这是全项目最重要的数据结构决策，所有其他设计都从这里推导：

```
管理员给 Alice 分配 1000 积分，白名单 [gpt-4o-mini]
  Alice 建了 key A / key B / key C
  通过 A、B、C 的任何一次调用都从同一个 1000 扣
  1000 用完 → 三把 Key 一起失效
```

- 额度字段（`quotaType` / `quotaLimit` / `quotaUsed`）在 **User** 上。
- **ApiKey 上没有任何额度字段**。Key 是凭证：身份 + 启用/过期 + 可选的模型收窄。

理由：如果额度挂在 Key 上，用户多建一把 Key 就等于凭空多拿一份额度。
那既不是「给 Alice 1000 积分」的字面意思，也无法被管理员预测——
管理员授权时看到的数字，必须就是用户能消耗的上限。

### 6.2 计量方式
- 账号级 `quotaType`：
  - `credits`：按**积分**累计，精度 0.001 积分（整数存储），
    这样单次消耗极小的廉价请求不会被向上取整成 1 积分。
  - `tokens`：按 total_tokens 累计。
- `quotaLimit === 0` 表示**尚未分配**，所有调用被拒绝（而非「不限额」）。
- 每次请求结束后，从上游响应里取 `usage.prompt_tokens` / `usage.completion_tokens`，按 [`quota/rates.ts`](../../src/lib/quota/rates.ts) 中的积分标准换算成消耗量。

### 6.3 模型权限 = 账号白名单 ∩ Key 白名单

- 账号的 `allowedModels` 是外层边界；Key 的 `allowedModels` 只能在其内收窄。
- 任一侧为空数组表示该层不额外限制。
- 因此用户可以自己造一把「只能跑便宜模型」的 Key，而无需管理员重新授权整个账号；
  但无法用一把 Key 突破账号本身的限制。

### 6.4 积分标准（`rates.ts`）
- 数据结构：`Record<modelId, { inputPerMillion: number, outputPerMillion: number }>`
  （整数，单位积分 / 100 万 tokens）。
- 首次启动时内置默认值，可由管理员通过 `applyRateOverride()` 覆盖。
- 未知模型回退到 `DEFAULT_RATE`。

### 6.5 扣减流程（伪代码）
```
1. 校验：Key 启用且未过期 → 账号未停用 → 账号 quotaUsed < quotaLimit
        → 请求的模型同时通过账号与 Key 的白名单
2. 转发到上游（流式）
3. 流结束后聚合 token 数
4. 计算本次消耗的积分
5. HINCRBY relay:user:{userId} quotaUsed <delta>   ← 记在账号上
6. HSET  relay:apikey:{keyId} lastUsedAt <now>      ← 只是时间戳
7. 写入 relay:log:* 用量日志（保留逐请求明细）
```

### 6.6 并发安全
- `quotaUsed` 的累加走 `HINCRBY`，天然原子，多个并发请求不会丢更新。
- 归属校验（用户名唯一）走 `SET NX`，见 §5 的冷启动竞态说明。
- 或在流开始前预扣（悲观），流结束后多退少补。

---

## 7. 上游 Provider 与模型映射

### 7.1 Provider 配置结构
```ts
{
  id: "openai-prod",
  name: "OpenAI Production",
  kind: "openai" | "anthropic" | "custom-openai",
  baseUrl: "https://api.openai.com/v1",   // 自定义时必填
  encryptedApiKey: "base64(iv|ct|tag)",
  modelMapping: {
    "gpt-4o-mini": "gpt-4o-mini-2024-07-18",   // 客户端模型 → 上游真实模型
    "gpt-4o": "gpt-4o-2024-08-06"
  },
  enabled: true,
}
```

### 7.2 路由策略
- 客户端请求 `/v1/chat/completions`，body 中的 `model` 是「客户端可见模型」。
- 服务端查所有启用的 Provider，找一个 `modelMapping` 包含该客户端模型 `ProviderId` 的 Provider。
- 若多个匹配：v1 按「轮询」选一个；后续可加权重。
- 若都未匹配 → 400 `model_not_allowed`。

### 7.3 Anthropic 兼容
- `/anthropic/v1/messages` 收到 `model` 后，查 `Provider.kind === "anthropic"` 的 Provider。
- 用 `@ai-sdk/anthropic` 调用 `streamText`，返回 SSE 流。
- 响应里的 usage 换算成积分 + 扣额度（同 OpenAI 流程）。

---

## 8. 本地开发与测试闭环

### 8.1 嵌入式 Mock 策略（方案 C）

```
/api/_emu/vercel/*  →  @emulators/adapter-next 的 catch-all 路由
                         ↓
                       Hono 路由：/v10/projects, /v2/user, ...
```

- `next dev` 启动后，`@vercel/sdk` 的 `baseURL` 被环境变量覆盖为
  `http://localhost:3000/api/_emu/vercel`，所有 SDK 调用命中本地 mock。
- 生产构建（`NODE_ENV=production`）下，路由文件返回 404，SDK 默认回退到
  `https://api.vercel.com`。

### 8.2 测试金字塔

| 层级 | 工具 | 覆盖 |
|---|---|---|
| 单元 | Vitest | 加密、散列、额度计算、积分标准、过期判断 |
| 集成 | Vitest + Next.js test handler | 路由 + 真实 Redis（mock 或 testcontainers）+ 嵌入式 mock |
| E2E | Playwright | 登录、建 Key、看用量、调 OpenAI 兼容接口 |

### 8.3 CI / 本地一键脚本

```bash
pnpm install
pnpm test:unit          # 纯函数，秒级
pnpm test:integration   # 集成，需要本地 Redis（测试用 mock）
pnpm test:e2e           # 需要 Next dev server + 嵌入式 mock
```

---

## 9. 部署

### 9.1 Vercel 配置
- Framework Preset: Next.js
- Build Command: `pnpm build`
- Output: `.next`
- Install Command: `pnpm install`
- Region: `hnd1`（东京，亚洲用户友好）或 `iad1`（美国）
- Node Version: 22.x

### 9.2 环境变量（在 Vercel Dashboard 设置）
见 [`.env.example`](../../.env.example)。

### 9.3 首次启动
- 第一次有请求命中应用时（登录页提交登录、页面读取 session、或代理接口校验 Key），
  会惰性执行一次 bootstrap：数据库为空 → 用 `RELAY_AUTH` 作密码创建
  `RELAY_ADMIN_USERNAME`（默认 `admin`）管理员；设置了 `OPENAI_KEYS` /
  `ANTHROPIC_KEYS` → 自动创建对应 Provider。
- 触发点：`ensureBootstrapped()`（`src/lib/db/bootstrap.ts`），每个实例只跑一次，
  失败会记录日志并在下一个请求重试。
- **首次登录后立即修改密码**。

详细步骤见 [`DEPLOYMENT.md`](./DEPLOYMENT.md)。

---

## 10. 目录结构（最终）

```
RelayAB/
├── docs/
│   ├── ARCHITECTURE.md          (本文件)
│   ├── DATA_MODEL.md
│   ├── API_ROUTES.md
│   ├── TESTING.md
│   └── DEPLOYMENT.md
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── globals.css
│   │   ├── page.tsx
│   │   ├── (auth)/login/page.tsx
│   │   ├── (user)/dashboard/page.tsx
│   │   ├── (admin)/admin/...
│   │   └── api/
│   │       ├── auth/{login,logout}/route.ts
│   │       ├── admin/...
│   │       ├── _emu/[...path]/route.ts
│   │       ├── v1/chat/completions/route.ts
│   │       ├── v1/models/route.ts
│   │       └── anthropic/v1/messages/route.ts
│   ├── lib/
│   │   ├── auth/         (session.ts, password.ts)
│   │   ├── crypto/       (secrets.ts, hashing.ts)
│   │   ├── db/           (redis.ts, repositories)
│   │   ├── vercel/       (client.ts, api-keys.ts)
│   │   ├── proxy/        (openai.ts, anthropic.ts, stream.ts)
│   │   ├── quota/        (credits.ts, rates.ts, calculator.ts)
│   │   └── config.ts
│   ├── components/       (UI 组件)
│   └── middleware.ts     (auth + bypass header 注入)
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── scripts/
│   ├── bootstrap-admin.ts
│   └── rotate-master-key.ts
├── package.json
├── tsconfig.json
├── next.config.ts
├── tailwind.config.ts
├── postcss.config.mjs
├── vitest.config.ts
├── playwright.config.ts
├── .env.example
└── README.md
```

---

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 主密钥泄漏 | 攻击者可解密所有上游 Key | 主密钥仅放 Vercel 环境变量；不写入日志；定期轮换脚本 |
| Redis 误删 | 所有用户/Key 丢失 | 启用 Upstash 自动备份；定期 `db snapshot export` |
| Vercel Serverless 超时 | 流式长请求被截断 | 配置 `maxDuration: 60`（Pro）或拆 chunk（v2） |
| 速率限制 | 共享上游 Key 易触发 OpenAI/Anthropic 限流 | 额度引擎天然限速；v2 加 per-Provider 速率 |
| 嵌入式 mock 在生产泄漏 | mock 数据被外部访问 | 仅当 `NODE_ENV !== "production"` 时加载 |

---

## 12. 界面多语言（i18n）

支持 `zh-CN`（默认）与 `en` 两种语言，作用范围是**界面文案**，不影响 API 响应。

```
src/lib/i18n/dict.ts            纯模块：字典 + translate/parseLocale + LOCALE_COOKIE
src/lib/i18n/server.ts          仅服务端：读 cookie / Accept-Language，导出 getT()
src/components/i18n/I18nProvider.tsx   客户端 Provider（locale / setLocale / t 三个 context）
src/components/i18n/LocaleSwitcher.tsx 页脚语言下拉
```

设计要点：

- **字典是纯模块。** `dict.ts` 不 import `next/headers`，所以客户端组件可以安全地从它取
  `LOCALE_COOKIE`、`LOCALE_LABELS` 等常量。反过来，`I18nProvider`（`"use client"`）
  **绝不能** import `server.ts` —— 那会把 `next/headers` 拉进浏览器 bundle，
  `next build` 直接失败。这条边界由 `tests/unit/i18n-usage.test.ts` 守护。
- **服务端渲染的文案**用 `await getT()`（Server Component），**客户端交互的文案**用
  `useT()`（Client Component）。两者读同一个字典，落在同一个 `relayab_locale` cookie。
- **回退链**：当前语言 → `en` → key 本身。最后一级是为了让漏翻的 key 在开发时肉眼可见，
  而不是静默显示空白。
- **context 拆成三个**（locale / setLocale / t）：只用 `setLocale` 的组件不会因为文案变化
  而重渲染，`t` 也按语言缓存引用。
- 占位符是轻量 ICU 风格 `{name}`，用法：`t("dashboard.quota.credits", { used: 5, limit: 100 })`。
- 新增文案时**必须同时加到两个字典**（`tests/unit/i18n.test.ts` 会校验 key 对齐），
  并且不要在 JSX 里写死可见文本或对 `t()` 结果做 `.replace()` 二次加工 ——
  这类"派生文案"在另一种语言里必然失效。
