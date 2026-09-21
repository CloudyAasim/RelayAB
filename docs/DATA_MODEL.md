# 数据模型

> 所有数据持久化在 **Upstash Redis**（通过 REST API，无连接池）。
> 推荐通过 **Vercel Marketplace → Upstash for Redis** 集成自动注入 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`；也支持独立 Upstash 数据库。
> 键统一前缀 `relay:`，便于将来按库 prefix 切分。
> 类型定义在 [`src/lib/db/types.ts`](../src/lib/db/types.ts)，本文档为概要。

---

## 1. 用户（User）

**键**：
- `relay:user:{userId}` — Hash
- `relay:user:by-username:{username}` — String（userId 反查）

**字段**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string (ULID) | 主键 |
| `username` | string (unique) | 登录名，3-32 字符 |
| `passwordHash` | string (bcrypt) | bcryptjs 散列，work factor 12 |
| `role` | `"admin" \| "user"` | 管理员可访问 `/admin/*` |
| `displayName` | string | 展示用 |
| `createdAt` | ISO string | |
| `updatedAt` | ISO string | |
| `lastLoginAt` | ISO string \| null | |
| `disabled` | 0 \| 1 | 软删除标志 |

**示例**：
```json
{
  "id": "01J7R5K8W6X8X8X8X8X8X8X8X8",
  "username": "alice",
  "passwordHash": "$2a$12$...",
  "role": "user",
  "displayName": "Alice",
  "createdAt": "2026-09-21T08:00:00.000Z",
  "updatedAt": "2026-09-21T08:00:00.000Z",
  "lastLoginAt": null,
  "disabled": "0"
}
```

---

## 2. 客户 API Key（ApiKey）

**键**：
- `relay:apikey:{keyId}` — Hash
- `relay:apikey:hash:{sha256(key)}` — String（keyId，用于 Bearer 校验反查）
- `relay:apikey:by-user:{userId}` — Set（keyId 列表）
- `relay:apikey:active:{userId}` — Set（仅 enabled + not expired 的 keyId，用于快速列表查询）

**字段**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string (ULID) | 主键 |
| `userId` | string | 所属用户 |
| `label` | string | 管理员备注 |
| `keyHash` | string | sha256(明文 key)，**不存明文** |
| `keyPrefix` | string | 明文前 12 字符 + `...` + 后 4 字符，仅展示 |
| `quotaType` | `"credits" \| "tokens"` | 配额类型 |
| `quotaLimit` | number | 总额度。`credits` → **积分**，以 0.001 积分为整数单位存储（`500000` = 500 积分）；`tokens` → token 数 |
| `quotaUsed` | number | 已用，单位与 `quotaLimit` 相同（每次成功请求按实际消耗累加，精度 0.001 积分） |
| `expiresAt` | ISO string \| null | 过期时间 |
| `enabled` | 0 \| 1 | 启用标志 |
| `allowedModels` | string[] (CSV) | 允许的模型列表（空 = 全部） |
| `createdAt` | ISO string | |
| `lastUsedAt` | ISO string \| null | |

**示例**：
```json
{
  "id": "01J7R5K8W6Y8X8X8X8X8X8X8X8",
  "userId": "01J7R5K8W6X8X8X8X8X8X8X8X8",
  "label": "Alice 的 Macbook",
  "keyHash": "a3f2c9...",
  "keyPrefix": "sk-relay-X3K...m2pQ",
  "quotaType": "credits",
  "quotaLimit": "500000",
  "quotaUsed": "1234",
  "expiresAt": "2026-12-31T23:59:59.000Z",
  "enabled": "1",
  "allowedModels": "gpt-4o-mini,gpt-4o,claude-3-5-sonnet",
  "createdAt": "2026-09-21T08:00:00.000Z",
  "lastUsedAt": null
}
```

**校验逻辑**（在路由入口）：
```ts
function validateApiKey(key: ApiKey): ValidationResult {
  if (key.disabled === "1") return { ok: false, reason: "key_disabled" };
  if (key.expiresAt && Date.parse(key.expiresAt) < Date.now()) return { ok: false, reason: "key_expired" };
  if (key.quotaType === "credits" && Number(key.quotaUsed) >= Number(key.quotaLimit)) return { ok: false, reason: "quota_exceeded_credits" };
  if (key.quotaType === "tokens" && Number(key.quotaUsed) >= Number(key.quotaLimit)) return { ok: false, reason: "quota_exceeded_tokens" };
  return { ok: true };
}
```

---

## 3. 上游 Provider（Provider）

**键**：`relay:provider:{providerId}` — Hash

**字段**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string (ULID) | 主键 |
| `name` | string | 管理员可见名称 |
| `kind` | `"openai" \| "anthropic" \| "custom-openai"` | 协议类型 |
| `baseUrl` | string \| null | 自定义端点（custom-openai 必填） |
| `encryptedApiKey` | string (base64) | AES-256-GCM 加密的上游 Key |
| `modelMapping` | JSON string | 客户端模型 → 上游模型映射 |
| `enabled` | 0 \| 1 | |
| `priority` | number | 路由优先级（数字小优先） |
| `createdAt` | ISO string | |

**示例**：
```json
{
  "id": "01J7R5K8W6Z8X8X8X8X8X8X8X8",
  "name": "OpenAI 主力",
  "kind": "openai",
  "baseUrl": null,
  "encryptedApiKey": "AbCdEf123...==",
  "modelMapping": "{\"gpt-4o-mini\":\"gpt-4o-mini-2024-07-18\"}",
  "enabled": "1",
  "priority": "1",
  "createdAt": "2026-09-21T08:00:00.000Z"
}
```

---

## 4. 用量日志（UsageLog）

**键**：`relay:log:{apikeyId}:{ulid}` — Hash，`relay:log:by-apikey:{apikeyId}` — List（最近 N 条）

**字段**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string (ULID) | |
| `apikeyId` | string | |
| `userId` | string | 冗余便于反查 |
| `providerId` | string | |
| `model` | string | 客户端请求的模型 |
| `upstreamModel` | string | 实际发到上游的模型 |
| `promptTokens` | number | |
| `completionTokens` | number | |
| `totalTokens` | number | |
| `creditsUsed` | number | 本次请求消耗的 **积分**，以 0.001 积分为整数单位 |
| `status` | `"success" \| "error"` | |
| `errorMessage` | string \| null | |
| `createdAt` | ISO string | |

**保留期**：默认保留 30 天，通过 `LPUSH` + `LTRIM` 控制长度（每 Key 最多 1000 条）。

---

## 5. Session

由 **iron-session** 8 自动管理，cookie 名 `relay_session`。

载荷：
{
  "userId": "01J...",
  "username": "alice",
  "role": "user",
  "iat": 1695273600,
  "exp": 1695360000
}
```

加密算法：AES-256-GCM（iron-session 内置）。
密钥：由 `RELAY_AUTH` 派生（HMAC-SHA256，64 hex chars），不支持单独覆盖——
换 `RELAY_AUTH` 即等于让所有现有 session 失效。

---

## 6. 辅助键

| 键 | 类型 | 用途 |
|---|---|---|
| `relay:meta:initialized` | "1" | 标记是否已 bootstrap admin |
| `relay:counter:userId` | String (INCR) | 单调递增 userId 计数器（备用，主键 ULID 不需要） |

---

## 8. 未来扩展（v2）

- `relay:usage:monthly:{yyyymm}` — Hash（apikeyId → creditsUsed），用于按月聚合。
- `relay:ratelimit:{apikeyId}:{window}` — 滑动窗口限速。
- `relay:apikey:by-provider:{providerId}` — 反查 Provider 使用了哪些 Key（审计）。
