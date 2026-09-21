# 部署到 Vercel 完整指南

> 假设你已经：
> - Fork/clone 了 RelayAB 项目到你的 GitHub。
> - 注册了 Vercel 账号（https://vercel.com）。

---

## 1. 一键部署

### 1.1 导入项目
1. 登录 Vercel Dashboard。
2. **Add New → Project → Import** 你 fork 的 GitHub 仓库。
3. Framework Preset 自动识别为 **Next.js**。
4. **不要立刻点 Deploy**，先按 §2 的步骤安装 Upstash 集成。

### 1.2 必填环境变量

**只需 3 个变量即可启动：**

| 名称 | 来源 | 备注 |
|---|---|---|
| `RELAY_AUTH` | 手动：`openssl rand -hex 32` | 主密码，同时承担管理员登录密码 + 会话密钥派生种子 |
| `UPSTASH_REDIS_REST_URL` | Vercel Marketplace 自动注入 | Upstash REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Vercel Marketplace 自动注入 | Upstash REST Token |

**自动派生**（无需手动设置）：
- `SESSION_PASSWORD` — 从 `RELAY_AUTH` 派生（HMAC-SHA256）
- `RELAY_MASTER_KEY_HEX` — 默认从 `RELAY_AUTH` 派生（可显式覆盖以独立轮换）

**可选**：
- `OPENAI_KEYS` — 逗号分隔的多 key，首次启动自动创建 OpenAI Provider（多 key 启用 rotation）
- `ANTHROPIC_KEYS` — 同上，Anthropic Provider
- `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` — 覆盖默认端点（Azure / 自建代理）
- `RELAY_ADMIN_USERNAME` — 管理员用户名（默认 `admin`）
- `VERCEL_PROTECTION_BYPASS` — 部署保护 bypass secret
- `EMULATE_VERCEL_LOCAL` — `"1"` 启用嵌入式 Vercel mock（**仅本地开发**）
- `AI_GATEWAY_API_KEY` — 通过 Vercel AI Gateway 路由所有上游流量
- `RELAY_MASTER_KEY_HEX` — 显式主密钥（**独立于 RELAY_AUTH 轮换时设置**）

### 1.3 部署
点 **Deploy**。Vercel 会跑 `pnpm install && pnpm build`，然后发布到 `*.vercel.app`。

---

## 2. Upstash for Redis（Vercel Marketplace 集成）⭐ 推荐

> 这是 Vercel 官方提供的 Marketplace 集成：
> - 一键安装，自动创建 Upstash 数据库。
> - 凭证自动注入到项目的环境变量。
> - Region 自动选离 Vercel 部署最近的位置。
> - 与 Vercel 项目统一管理，无需单独维护账号。
>
> 我们使用 `@upstash/redis` SDK 直接调用 REST API，**与独立 Upstash 数据库完全兼容**。

### 2.1 安装步骤

1. 进入 Vercel 项目 → **Storage** 标签页。
2. 点击 **Create Database** → 找到 **Marketplace** 一节下的 **Upstash**。
   > 直接在 Vercel Dashboard 搜索 "Upstash" 也能找到。
3. 选择 **Upstash for Redis**。
4. 配置：
   - **Plan**：Free（够用，30k 请求/天，256 MB 存储）
   - **Region**：默认即可，Vercel 会选最近的 Region
   - **Name**：可改，默认 `relayab-redis`
5. 点 **Create**，同意 Marketplace 条款。
6. Vercel 自动：
   - 创建一个 Upstash 数据库
   - 把以下环境变量绑定到 **所有环境**（Production / Preview / Development）：
     - `UPSTASH_REDIS_REST_URL`
     - `UPSTASH_REDIS_REST_TOKEN`
   - （可选）某些情况下还会有 `KV_REST_API_URL` / `KV_REST_API_TOKEN`（Vercel KV 命名约定，**我们不用**）

### 2.2 验证集成生效

部署完成后，在 Vercel Dashboard → Project → **Settings → Environment Variables** 确认：
- `UPSTASH_REDIS_REST_URL` 存在
- `UPSTASH_REDIS_REST_TOKEN` 存在

在 Functions 日志里看启动是否成功：
```
[relayab] redis: connected to https://xxx.upstash.io
```

### 2.3 为什么不用 Vercel KV？

Vercel KV 在 2024 年已被 **Upstash for Redis** 取代（Vercel 把存储后端统一交给 Upstash）。两者底层 API 完全相同，但 Marketplace 集成更稳定。我们直接用 `@upstash/redis` SDK，不依赖任何 Vercel 私有包。

### 2.4 备份策略

- 免费版：每日自动备份，保留 1 天。
- 在 Upstash Console（点 Marketplace 卡片右上 "Open in Upstash"）可手动触发 Export。
- 建议每周手动 Export 一次。

### 2.5 如果不想用 Marketplace 集成

也可以注册独立 Upstash 账号（https://upstash.com）并手动创建数据库，把 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN` 填到 Vercel 环境变量。**对代码零影响**——SDK 调用方式完全一致。

---

## 3. 首次启动与引导

引导是**惰性**的：部署完成后，第一个真正碰到应用的请求（提交登录、访问任何需要
读取 session 的页面/接口、或用 Key 调代理接口）会触发一次 bootstrap；
之后再也不会重复执行（每个实例一次，失败会在下个请求重试）。

访问 `https://your-app.vercel.app/login` 时你会看到：

- **管理员账号已自动创建**
  - 用户名：`admin`（或自定义的 `RELAY_ADMIN_USERNAME`）
  - 密码：你的 `RELAY_AUTH` 值

- **Upstream Provider 已自动创建**（如果设置了 `OPENAI_KEYS` / `ANTHROPIC_KEYS`）
  - 多个 key 会创建多个 provider 实体（启用 rotation）
  - 默认 model mapping 覆盖 gpt-4o / gpt-4o-mini / claude-3-5-sonnet 等常见模型

- **如果没有设置 Upstream Key**，登录后在 `/admin/providers` 手动添加

**首次登录后建议立即**：
1. 在 `/admin/users` 给自己改密码（或重置一个新密码）
2. 在 `/admin/users` 创建普通用户
3. 在 `/admin/keys` 为每个用户创建 API Key（明文仅显示一次！）
4. 在 `/admin/providers` 确认/添加 Upstream Provider
5. 把客户 Key 分发给用户

### 本地无环境变量时手动创建 admin

如果不想用 `RELAY_AUTH` 派生密码，可以用脚本：

```bash
pnpm bootstrap-admin --username admin --password <your-password>
```

此脚本会创建 admin 账号并立即返回。## 4. 配置 Vercel AI Gateway（可选）

如果你希望所有上游流量都走 Vercel AI Gateway（而不是直接调 OpenAI/Anthropic）：

1. 在 Vercel Dashboard → **AI Gateway → API Keys** 创建 Key。
2. 把 Key 填到 `AI_GATEWAY_API_KEY`。
3. 上游 Provider 的 baseUrl 改为 `https://ai-gateway.vercel.sh/v1`。
4. 上游 Provider 的 `kind` 仍为 `"openai"` 或 `"anthropic"`（Gateway 是 OpenAI/Anthropic 兼容协议）。

这样：
- Vercel AI Gateway 提供内置额度/速率限制（可与 RelayAB 双层防护叠加）。

---

## 5. 真实上游 API Key 接入

### 5.1 添加 Provider
1. 登录 RelayAB → **/admin/providers → New Provider**。
2. 填：
   - Name：`OpenAI Production`
   - Kind：`openai`
   - API Key：`sk-...`（从 OpenAI Dashboard 取）
   - Model Mapping：`{ "gpt-4o-mini": "gpt-4o-mini-2024-07-18", "gpt-4o": "gpt-4o-2024-08-06" }`
3. Save。

明文 Key **不会持久化**——RelayAB 用 `RELAY_MASTER_KEY_HEX` 即时加密后存入 Redis。

### 5.2 模型映射策略
- 客户端请求的 `model` 字段视为「逻辑名」。
- 管理员在 model mapping 里写「逻辑名 → 上游真实模型名」。
- 若映射未命中：v1 直接把客户端的 `model` 原样转发（适合 Provider 自己就是命名权威的场景）。

---

## 6. 嵌入式 Vercel API Mock（开发模式）

在本地开发时，`src/app/api/_emu/vercel/[...path]/route.ts` 会被启用：
- 当 `EMULATE_VERCEL_LOCAL === "1"` 且 `NODE_ENV !== "production"`。
- 所有 `https://api.vercel.com/*` 的 SDK 调用会被重定向到 `http://localhost:3000/api/_emu/vercel/*`。
- 这样本地无需任何外部服务即可完整测试。

**生产环境必须关闭**（默认关闭），否则用户会打到 mock 数据。

---

## 7. 部署保护绕过

### 7.1 何时需要
当 Vercel 项目开启了 **Deployment Protection**（Settings → Deployment Protection → Enabled）：
- 所有访问（包括 API）会被 Vercel 弹出 SSO 登录。
- 客户端 SDK 无法正常调用。

### 7.2 生成 bypass secret
1. Vercel Dashboard → 你的项目 → **Settings → Deployment Protection**。
2. 找到 **Protection Bypass** 一节 → 输入一个易记的 secret → **Add**。
3. 复制生成的 **Bypass Secret**（一次性显示，建议存到密码管理器）。

### 7.3 在 RelayAB 中使用

#### 场景 A：客户端 SDK 调用
让用户在自己的 OpenAI 客户端配置里加一个 header：
```typescript
import OpenAI from "openai";
const client = new OpenAI({
  apiKey: "sk-relay-xxx",
  baseURL: "https://your-app.vercel.app/v1",
  defaultHeaders: {
    "x-vercel-protection-bypass": "<your-bypass-secret>",
  },
});
```

#### 场景 B：服务端内部调用
`src/middleware.ts` 自动注入：
```typescript
if (process.env.VERCEL_PROTECTION_BYPASS) {
  headers.set("x-vercel-protection-bypass", process.env.VERCEL_PROTECTION_BYPASS);
}
```

### 7.4 安全建议
- Bypass secret 等价于「可绕过 Vercel 认证」，泄漏后任何人可访问。
- 仅在你的 `sk-relay-xxx` API Key 也被验证后，请求才能真正进入 RelayAB → 双层防护。
- 不要把 bypass secret 提交到 Git。

---

## 8. 冒烟测试清单（部署后请逐项打勾）

### 8.1 基础
- [ ] 访问 `https://your-app.vercel.app/healthz` 返回 `{"ok":true,...}`。
- [ ] 访问 `/login` 页面正常渲染。
- [ ] 用引导 admin 账号登录成功。
- [ ] 登录后跳转到 `/admin`。

### 8.2 管理
- [ ] 在 `/admin/users` 新建一个测试用户。
- [ ] 给该用户新建一把 Key（设置 `quotaType=credits`，`quotaLimit=100000`，即 100 积分）。
- [ ] 复制明文 Key（仅显示一次）。
- [ ] 在 `/admin/keys` 看到 Key 列表。
- [ ] 禁用该 Key，再启用，确认状态正确切换。

### 8.3 Provider
- [ ] 在 `/admin/providers` 添加一个真实 OpenAI Provider（用您自己的 OpenAI key）。
- [ ] 添加一个 Anthropic Provider。

### 8.4 代理调用
- [ ] 用 `curl` 调用 `/v1/chat/completions`，传 `Authorization: Bearer sk-relay-xxx`：
  ```bash
  curl -X POST https://your-app.vercel.app/v1/chat/completions \
    -H "Authorization: Bearer sk-relay-xxx" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"say hi"}]}'
  ```
- [ ] 响应里包含 `usage.total_tokens`。
- [ ] 再次访问 `/admin/usage`，确认 `creditsUsed` 增加（按 0.001 积分精度累计）。

### 8.5 用户面板
- [ ] 用测试用户账号登录（不是 admin）。
- [ ] 进入 `/dashboard`，能看到自己名下的 Key。
- [ ] 查看 Key 用量明细。

### 8.6 安全
- [ ] 直接访问 `/api/admin/users`（无 cookie）→ 401。
- [ ] 用一个 disabled 的 Key 调 `/v1/chat/completions` → 403 key_disabled。
- [ ] 用一个过期的 Key 调 → 403 key_expired。
- [ ] 用一个额度耗尽的 Key 调 → 403 `quota_exceeded_credits`。
- [ ] 在 Upstash Console 搜 `relay:user:*`，确认 `passwordHash` 是 bcrypt 散列。
- [ ] 在 Upstash Console 搜 `relay:provider:*`，确认 `encryptedApiKey` 是 base64 密文。

---

## 9. 故障排查

### 9.1 部署后 500 错误
- 检查 Vercel 函数日志：`Dashboard → Deployments → 点进 → Functions`。
- 最常见：环境变量缺失（确认 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` 已被 Marketplace 自动注入）。

### 9.2 Marketplace 集成未生效
- Vercel Dashboard → Project → **Storage** → 确认 Upstash 数据库卡片显示 **Connected**。
- 如果显示 **Not Connected**：点进卡片 → **Connect to Project**。

### 9.3 调用返回 `model_not_mapped`
- 检查 `/admin/providers`，确认 model mapping 包含请求的 model。
- 检查 Provider 是 enabled。

### 9.4 调用超时
- Vercel Hobby 版函数最长 10 秒（流式可延长到 30 秒）。
- Pro 版最长 60 秒。
- 极长流式响应可能截断 → 考虑分块（v2）。

### 9.5 Upstash 连接错误
- 在 Upstash Console（点 Marketplace 卡片 "Open in Upstash"）的 **Connect** 标签下，用 cURL 验证凭证可用。
- 检查 Region 是否离 Vercel region 很远。

### 9.6 嵌入式 mock 出现在生产
- 确认 `EMULATE_VERCEL_LOCAL` 未设置或为 `"0"`。
- `src/app/api/_emu/[...path]/route.ts` 顶部有 production guard。

---

## 10. 升级 / 维护

### 10.1 升级依赖
```bash
pnpm update --latest
```
然后本地跑全套测试 + 在 preview deployment 验证。

### 10.2 主密钥轮换（重要）
1. 生成新主密钥：`openssl rand -hex 32`。
2. 启动本地脚本 `pnpm tsx scripts/rotate-master-key.ts`（v1.1 提供）。
3. 用新主密钥重新加密所有 `relay:provider:*` 的 `encryptedApiKey`。
4. 更新 Vercel 环境变量 `RELAY_MASTER_KEY_HEX`。
5. 重新部署。

### 10.3 数据导出 / 导入
```bash
# 导出（本地）
pnpm tsx scripts/export-data.ts > relay-snapshot.json

# 导入（生产）
pnpm tsx scripts/import-data.ts relay-snapshot.json
```
