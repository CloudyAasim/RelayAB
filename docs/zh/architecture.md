# RelayAB — 架构与设计文档

> 一个自托管的 AI API 网关（API 中转站），用于将上游 AI 服务的 API Key
> 安全、可控地分享给少数用户，并实现精细的权限和用量管理。

---

## 1. 目标与非目标

### 1.1 目标
- 部署在一台自己的 Debian 服务器上，**没有平台月费、没有请求数上限**。
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
   ┌────────┐  Bearer sk-xxx    │           自托管 Debian 服务器        │
   │ Client │ ────────────────► │  ┌────────────────────────────────┐ │
   └────────┘                   │  │  nginx :443  (TLS · 关闭缓冲)   │ │
                                │  └────────────────────────────────┘ │
                                │  ┌────────────────────────────────┐ │
                                │  │  Next.js 15 App Router          │ │
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
                                │  │  │   └─ 上游路由            │ │ │
                                │  │  └──────────────────────────┘ │ │
                                │  └────────────────────────────────┘ │
                                │                  │                  │
                                │                  ▼                  │
                                │  ┌────────────────────────────────┐ │
                                │  │  relayab.db (SQLite)            │ │
                                │  │  users / api_keys / providers  │ │
                                │  │  usage_logs / settings / meta  │ │
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
| 部署方式 | 自己的 Debian 服务器（systemd + nginx） | 零平台月费、无请求数上限；nginx 必须关缓冲以保住 SSE 流式 |
| 框架 | Next.js 15 App Router | Server Actions / Route Handlers 同源；SSR 友好 |
| 数据存储 | **本机 SQLite 文件**（Node 24 内置 `node:sqlite`）；托管环境可切 Upstash REST | 自托管零外部依赖：没有服务要装、没有端口、没有密码，备份就是复制文件；唯一约束与外键改由数据库保证 |
| 认证 | iron-session + bcryptjs | 轻量、Edge 兼容、无外部依赖；bcryptjs 纯 JS |
| 上游 Key 加密 | AES-256-GCM，主密钥从 env | 标准做法；与 TokenPlan 思路一致 |
| AI 代理 | 自写代理层（`src/lib/proxy/*`） | 直接控制 SSE 分帧、协议转换与 baseURL；不依赖第三方 SDK |
| UI | Tailwind CSS + 自写组件 | 体积小、可控；不引入 shadcn 减少认知负担 |
| 测试 | Vitest + Playwright | Vitest 与 Vite/Turbopack 集成好；Playwright 覆盖登录与响应式回归 |

### 2.2 界面渲染与响应速度

登录后的应用外壳（侧边栏 + 顶栏）由**分段 layout**（`(admin)/admin/layout.tsx`、
`(user)/dashboard/layout.tsx`）渲染，**页面只负责内容列**。这不是风格选择，
而是 App Router 的核心行为决定的：

- **layout 在子路由之间保持挂载，page 的整棵子树会被替换。** 早期版本让每个页面
  自己渲染外壳，结果是每次点击侧边栏都会把侧边栏、顶栏以及它们内部的
  `matchMedia` 监听、cookie 读取、折叠动画全部销毁重建。用 Chromium 实测：切换
  `/admin` → `/admin/users` 时 `aside` / `header` 的 DOM 节点引用都变了。
  移到 layout 后同一测量显示节点引用保持不变，只有内容列被替换。
- **骨架屏只应替换内容列。** 外壳在 page 里时，segment 的 `loading.tsx` 会把整屏
  （含导航）换成骨架；实测慢速服务端下会先出现**整屏空白且没有任何加载提示**，
  这正是“像断网了”的来源。外壳移到 layout 后，骨架出现在 `<main>` 内，导航保持
  可见。
- **导航反馈**：App Router 不派发路由变化事件，`NavigationLoadingBar` 因此改为
  自己侦测（同源链接点击 + `popstate`，路径变化即结束），侧边栏链接用
  `useLinkStatus` 在点击处显示 spinner。
- **客户端路由缓存**：`experimental.staleTimes.dynamic = 30`，否则动态页面每次
  切换都会重新请求 serverless 函数；写操作走 Server Action / `router.refresh()`，
  不受该窗口影响。
- **数据访问**：SQLite 走进程内调用，没有网络往返；读多行记录用一条 `IN (…)` 查询，
  `usage_logs` 上按 `(api_key_id, created_at)` 等维度建了索引来支撑聚合。同一请求内
  重复读取当前用户由 React `cache()` 去重。

---

## 3. 数据模型

详细定义见 [`data-model.md`](./data-model.md)。概要：

| 表 | 用途 | 主键 |
|---|---|---|
| `users` | 用户档案 + 角色 + 密码散列 + **积分池** (`quota_type`/`quota_limit`/`quota_used`) + 模型白名单。`username` 带 UNIQUE | `id` |
| `api_keys` | 客户 Key 凭证（散列 / 启用 / 过期 / 模型收窄）。**不含额度字段**。`key_hash` 带 UNIQUE，外键指向 `users(id)` | `id` |
| `providers` | 上游 Provider 配置 + 加密的 API Key | `id` |
| `media_providers` | 媒体供应商配置 + 声明式 spec 数组 | `id` |
| `usage_logs` | 单次请求日志（只增） | `id` (ULID) |
| `usage_totals` | 每把 Key 的滚动累计值，代理路径每次调用都读 | `api_key_id` |
| `settings` | 键值袋（当前只有 `publicUrl`） | `key` |
| `meta` | 记录一次性 bootstrap 是否已跑过 | `key` |

Session 由 iron-session 放在 cookie 里，**不落库**。

> **表与实体的边界**：每张表与一个 Zod schema 一一对应，列名是实体字段名的
> `snake_case`，每行读出后都再走一遍同一个 schema。布尔存 `INTEGER` 0/1，
> `allowed_models` / `model_mapping` / `headers` / `specs` 等存 JSON 文本，
> 时间戳存 ISO 字符串。明细见 [data-model.md 存储约定](data-model.md#存储约定)。

---

## 4. API 路由设计

详细定义见 [`api-routes.md`](./api-routes.md)。概要：

### 4.1 公开代理接口（用 API Key 鉴权）

| 路径 | 方法 | 用途 |
|---|---|---|
| `/v1/chat/completions` | POST | OpenAI Chat Completions 兼容 |
| `/v1/responses` | POST | OpenAI Responses 兼容，含 Chat / Anthropic 自动转换 —— 见 §7.3 |
| `/v1/models` | GET | OpenAI 兼容（返回允许的模型） |
| `/v1/messages` | POST | Anthropic Messages，走 OpenAI 面向路径 |
| `/anthropic/v1/messages` | POST | Anthropic 兼容 |
| `/healthz` | GET | 健康检查（无需鉴权） |

> 媒体端点（`/v1/images/*`、`/v1/videos/generations`、`/v1/audio/*`）见
> [api-routes.md §2.6](./api-routes.md#26-媒体端点图片--视频--语音--音乐)。

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
| `/api/admin/usage` | GET | 全站用量统计（`range` / `userId` / `byUser`·`byKey`·`byModel` 明细） |
| `/api/user/usage` | GET | 当前账号用量统计（`range` / `byKey`·`byModel` 明细） |
| `/api/admin/media-providers` | GET / POST | 媒体供应商与声明式适配 spec 的增删改查 |
| `/v1/images/*`、`/v1/videos/*`、`/v1/audio/*` | POST | 媒体生成（图片/图生图/视频/语音/音乐），由适配协议驱动 |

---

### 4.3 媒体适配协议

媒体能力不走聊天协议面，而是**声明式 spec + 通用引擎**：

```
供应商行（`media_providers` 表）= baseUrl + 密钥 + models + specs[]
引擎（src/lib/media/engine.ts）解释 spec：构造上游请求 → 解析响应 → 错误映射 → 异步轮询
```

厂商差异（端点、字段名、鉴权、尺寸表达、同步/异步、错误码、结果编码）全部落在 spec 里，
所以**新增或调整供应商是改后台 JSON，而不是改代码**。协议与原语见
[模型适配协议/README.md](../模型适配协议/README.md)。

> **注：** 媒体适配协议只有中文版 ——
> [`docs/模型适配协议/README.md`](../模型适配协议/README.md)。

协议只有**一个版本**（`specVersion: 1`），没有分支版本。一个供应商里可以放多份
`capability` 相同的 spec（厂商同时提供 v1 / v2 两套接口时），靠 spec 的 `models`
字段按模型分流；两份都不写 `models` 会在保存时报错，不允许「第一份永远生效、
其余变死代码」这种静默情况。

与聊天 provider 是两套独立实体：请求形状、参数、计费单位都不同（媒体按「件」计费）。

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
- 校验：客户端传 `Authorization: Bearer <key>` → 服务端 `sha256` → 查 `api_keys.key_hash`
  （自带 UNIQUE 索引）→ 命中则拉取完整记录。

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
5. UPDATE users SET quota_used = quota_used + <delta>   ← 记在账号上
6. UPDATE api_keys SET last_used_at = <now>              ← 只是时间戳
7. INSERT INTO usage_logs 写用量日志（保留逐请求明细）
8. UPDATE usage_totals 累加该 Key 的滚动汇总（代理路径每次调用都读它）
```

### 6.6 并发安全
- `quota_used` 的累加走 `SET x = x + ?`（SQL 表达式在事务内原子求值），多个并发请求
  不会丢更新；这些更新包在 `withTransaction()`（`BEGIN IMMEDIATE`）里。
- 归属校验（用户名唯一）由 `users.username` 上的 `UNIQUE` 约束保证，冷启动的
  "并发建 admin" 竞态则由 bootstrap 的 `BEGIN IMMEDIATE` 事务 + `meta` 表主键冲突
  拦下，见 [data-model.md §1](./data-model.md#1-用户user) 与 §6。
- 或在流开始前预扣（悲观），流结束后多退少补。

---

## 7. 上游 Provider 与模型映射

### 7.1 Provider 配置结构
```ts
{
  id: "01J7R5K8W6Z8X8X8X8X8X8X8X8",
  name: "MiniMax 生产",
  kind: "openai" | "anthropic" | "custom-openai" | "azure",
  baseUrl: "https://api.minimax.cn/v1",
  encryptedApiKey: "base64(iv|ct|tag)",
  modelMapping: {
    "MiniMax-M3": "MiniMax-M3",   // 客户端模型 → 上游真实模型
  },
  modelConfigs: { /* 可选的上下文长度 / 输出上限 / 计费参数 */ },
  headers: { /* 可选的附加请求头 */ },
  upstreamFormat: "responses" | "chat" | "anthropic",
  enabled: true,
  priority: 1,                    // 数字小的优先被选中
}
```

### 7.2 三个字段的分工

配置一条 Provider 时，起决定作用的是下面三个字段。它们职责不同，不要互相替代：

| 字段 | 作用 |
|---|---|
| `kind` | **协议家族**。`anthropic` 表示这条 Provider 说的是 Anthropic Messages 协议 |
| `baseUrl` | **上游根地址**。代理在其后拼接端点路径（`/chat/completions`、`/responses`、`/v1/messages`） |
| `upstreamFormat` | **上游原生协议**。决定请求打到哪个路径、以及是否需要先做协议转换 |

### 7.3 端点 → 上游路径

| 客户端请求 | 上游路径 | Provider 选择规则 |
|---|---|---|
| `POST /v1/chat/completions` | `<baseUrl>/chat/completions` | 排除 Anthropic 协议的 Provider，其余按 `priority` 升序取第一个 |
| `POST /v1/responses` | `<baseUrl>/responses` | 同上。若命中的 Provider 是 `chat` / `anthropic` 协议，先做请求转换，再调用它的对应端点，最后把响应转回 Responses 结构 |
| `POST /anthropic/v1/messages` | `<baseUrl>/v1/messages` | 优先 `upstreamFormat === "anthropic"`，其次 `kind === "anthropic"`，再其次 `kind === "custom-openai"` |

两个实现细节：

- 请求体格式决定目标路径。Chat 代理发出的永远是 Chat 请求体，所以它必须打 `/chat/completions`；不能因为 Provider 标了别的格式就改路径，否则会把 Chat 请求体发到 Responses 端点（历史上出过这个 400 回归）。
- `kind === "anthropic"` 的 Provider 若 `upstreamFormat` 仍是默认的 `responses`，运行时由 `effectiveUpstreamFormat()` 按 Anthropic 协议处理，避免被 `/v1/chat/completions` 误用。

### 7.4 模型映射规范

`modelMapping` 的左列是**客户端可见模型名**，右列是**转发给上游的真实模型名**。它只是一张别名表。

- **推荐恒等映射**（两列相同），例如 `MiniMax-M3` → `MiniMax-M3`。仓库里的 Provider 模板全部使用恒等映射。
- 只有当上游模型 ID 与客户端期望的名字不同，或客户端把模型名硬编码、改不了时，才用别名。
- **不要用虚构名称**。把 `claude-sonnet-4-6` 指向 `MiniMax-M3` 这类写法有三个实际代价：
  1. 该名字会原样出现在 `GET /v1/models` 里，对所有用户可见；
  2. 用量日志记录的是客户端名，排查"实际调了哪个模型"时会混乱；
  3. 对使用者构成误导。
- 如果客户端支持覆盖模型名（例如 Claude Code 的 `ANTHROPIC_MODEL`），应优先改客户端配置，而不是在网关里造假名字。

### 7.5 新增一条 Anthropic Provider

要让 `/anthropic/v1/messages` 能工作，需要一条 Anthropic 协议的 Provider：

1. 模板选 **Anthropic** —— 这会把 `kind` 设为 `anthropic`，`upstreamFormat` 自动设为 `anthropic`，并预填 Claude 模型与 `anthropic-version` 请求头。
2. 把 **API 请求地址** 改成上游的 Anthropic 基址。例如 MiniMax 是 `https://api.minimax.cn/anthropic`（注意与它的 OpenAI 基址 `https://api.minimax.cn/v1` 不是同一个）。
3. **模型映射** 填真实模型名。
4. 这条 Provider 不会被 `/v1/chat/completions` 选中；它与 OpenAI 那条互不干扰。

也可以不用 Anthropic 模板，改用手动方式：任意 OpenAI 系模板 + 把 **上游格式** 改成 `Anthropic Messages`。效果等价，只是 `kind` 会是 `openai`，语义上不如直接选 Anthropic 模板清晰。

三个端点的基址必须配对，这是最常见的配置错误：

| 端点 | `baseUrl` 必须是 |
|---|---|
| `/v1/chat/completions`、`/v1/responses` | 上游的 OpenAI 兼容基址（如 `https://api.minimax.cn/v1`） |
| `/anthropic/v1/messages` | 上游的 Anthropic 兼容基址（如 `https://api.minimax.cn/anthropic`） |

---

## 8. 本地开发与测试闭环

### 8.1 测试金字塔

| 层级 | 工具 | 覆盖 |
|---|---|---|
| 单元 | Vitest | 加密、散列、额度计算、积分标准、过期判断 |
| 集成 | Vitest + Next.js test handler | 路由 + 真实 SQLite（`RELAY_DB_PATH=":memory:"`，无需任何服务） |
| E2E | Playwright | 登录、建 Key、看用量、调 OpenAI 兼容接口 |

### 8.2 CI / 本地一键脚本

```bash
pnpm install
pnpm test:unit          # 纯函数，秒级
pnpm test:integration   # 集成，数据库是进程内 :memory:，零外部依赖
pnpm test:e2e           # 需要 Next dev server
```

---

## 9. 部署

### 9.1 服务器配置
- Node.js 24 + pnpm 10（`corepack enable` 即可）—— `node:sqlite` 是内置模块，
  版本不够会直接报模块找不到
- 一个可写的数据库目录（建议 `/var/lib/relayab`，属主 `relayab`）——**没有数据库
  服务要装，没有端口要开**
- systemd 常驻，`WorkingDirectory` 指向仓库根
- nginx 反代 + Let's Encrypt 证书，**必须关闭响应缓冲**（否则 SSE 失效）

现成配置在 [`deploy/`](../../deploy/README.md)：
`relayab.service` / `nginx.conf` / `env.production.example`。

### 9.2 环境变量
见 [`deploy/env.production.example`](../../deploy/env.production.example)。
必填只有 `RELAY_AUTH`；生产建议显式设 `RELAY_DB_PATH`（放在发布目录之外）、
`RELAY_BUILD_ID` 与 `RELAY_PUBLIC_URL`。

### 9.3 首次启动
- 第一次有请求命中应用时（登录页提交登录、页面读取 session、或代理接口校验 Key），
  会惰性执行一次 bootstrap：数据库为空 → 用 `RELAY_AUTH` 作密码创建
  `RELAY_ADMIN_USERNAME`（默认 `admin`）管理员；设置了 `OPENAI_KEYS` /
  `ANTHROPIC_KEYS` → 自动创建对应 Provider。
- 触发点：`ensureBootstrapped()`（`src/lib/db/bootstrap.ts`），每个实例只跑一次，
  失败会记录日志并在下一个请求重试。
- **首次登录后立即修改密码**。

详细步骤见 [`deploy/README.md`](../../deploy/README.md) 与
[`deployment.md`](./deployment.md)。

---

## 10. 目录结构（最终）

```
RelayAB/
├── docs/
│   ├── architecture.md         (本文件)
│   ├── data-model.md
│   ├── api-routes.md
│   ├── testing.md
│   └── deployment.md
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
│   │       ├── v1/chat/completions/route.ts
│   │       ├── v1/models/route.ts
│   │       └── anthropic/v1/messages/route.ts
│   ├── lib/
│   │   ├── auth/         (session.ts, password.ts)
│   │   ├── crypto/       (secrets.ts, hashing.ts)
│   │   ├── db/           (sqlite.ts, users.ts, keys.ts, providers.ts, usage.ts)
│   │   ├── proxy/        (openai.ts, anthropic.ts, stream.ts)
│   │   ├── quota/        (credits.ts, rates.ts, calculator.ts)
│   │   └── config.ts
│   ├── components/       (UI 组件)
│   └── middleware.ts     (路径归一化 / CORS / 用量视图 cookie)
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
| 主密钥泄漏 | 攻击者可解密所有上游 Key | 主密钥仅放 `.env.production`（`chmod 600`）；不写入日志；定期轮换脚本 |
| 数据库文件误删 / 磁盘损坏 | 所有用户/Key/用量流水丢失 | `RELAY_DB_PATH` 放在发布目录之外；加日备 cron（`sqlite3 … ".backup …"` 或停服复制）；`chmod 600` |
| nginx 响应缓冲 | 流式长请求被卡住后一次性吐出 | 站点配置关闭 `proxy_buffering` 并加 `X-Accel-Buffering no` |
| 单机故障 | 服务与数据库同时不可用 | 应用与 `.db` 文件在同一台机器上，需自行规划备份与故障恢复 |
| 速率限制 | 共享上游 Key 易触发 OpenAI/Anthropic 限流 | 额度引擎天然限速；v2 加 per-Provider 速率 |

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
