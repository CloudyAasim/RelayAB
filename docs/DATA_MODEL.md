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
| `quotaType` | `"credits" \| "tokens"` | 账号积分池的计量单位 |
| `quotaLimit` | int | 账号积分池总量（credits 时以 0.001 积分整数存储）。`0` = 未分配，所有调用都会被拒绝 |
| `quotaUsed` | int | 账号已消耗量，单位同 `quotaLimit` |
| `maxActiveKeys` | int | 允许同时启用的 Key 数上限（0 = 无上限） |
| `allowedModels` | string[] | 该账号可访问的模型白名单（空 = 全部） |

> **积分属于账号，不属于 Key。** 这是整个网关最核心的建模决策：
>
> ```
> 管理员给 Alice 分配 1000 积分
>   Alice 建了 key A / key B / key C
>   通过 A、B、C 的任何一次调用都从同一个 1000 里扣
>   1000 用完 → 三把 Key 一起失效
> ```
>
> 如果积分挂在 Key 上，用户多建一把 Key 就等于凭空多拿一份额度——那不是
> 「给 Alice 1000 积分」的意思。因此 `ApiKey` 上**没有**任何 quota 字段。
>
> `allowedModels` 同样属于账号；Key 只能在此基础上**收窄**（见下文 §2），
> 不可能放宽。管理员在 `/admin/users` 配置这三项，用户无法自行修改。

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
  "disabled": "0",
  "quotaType": "credits",
  "quotaLimit": "500000",
  "quotaUsed": "13500",
  "maxActiveKeys": 0,
  "allowedModels": ["gpt-4o-mini"]
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
| `label` | string | 用户/管理员给这把 Key 起的名字 |
| `keyHash` | string | sha256(明文 key)，**不存明文** |
| `keyPrefix` | string | 明文前 12 字符 + `...` + 后 4 字符，仅展示 |
| `expiresAt` | ISO string \| null | 过期时间 |
| `enabled` | 0 \| 1 | 启用标志 |
| `allowedModels` | string[] (CSV) | 这把 Key **额外**允许的模型。与账号白名单取**交集**——只能收窄，不能放宽（空 = 不额外限制，仍受账号白名单约束） |
| `createdAt` | ISO string | |
| `lastUsedAt` | ISO string \| null | |

> Key 是**凭证**，不是钱包。它只携带身份（谁在调用）与轻量策略
> （启用 / 过期 / 可选的模型收窄），额度池在所属账号上。
> 因此这里**没有** `quotaType` / `quotaLimit` / `quotaUsed` 三个字段。

**示例**：
```json
{
  "id": "01J7R5K8W6Y8X8X8X8X8X8X8X8",
  "userId": "01J7R5K8W6X8X8X8X8X8X8X8X8",
  "label": "Alice 的 Macbook",
  "keyHash": "a3f2c9...",
  "keyPrefix": "sk-relay-X3K...m2pQ",
  "expiresAt": "2026-12-31T23:59:59.000Z",
  "enabled": "1",
  "allowedModels": "gpt-4o-mini,gpt-4o,claude-3-5-sonnet",
  "createdAt": "2026-09-21T08:00:00.000Z",
  "lastUsedAt": null
}
```

**校验逻辑**（`lib/auth/apikey.ts` 的 `checkKeyStatus`）：

```ts
// 顺序即优先级；user 是 key 的所属账号，必需。
function checkKeyStatus({ key, user, requestedModel }): ValidationResult {
  // 1. 凭证本身
  if (!key.enabled) return { ok: false, reason: "key_disabled" };
  if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now())
    return { ok: false, reason: "key_expired" };

  // 2. 账号状态与额度池 —— 注意读的是 user，不是 key
  if (user.disabled) return { ok: false, reason: "user_disabled" };
  if (user.quotaUsed >= user.quotaLimit) {
    return {
      ok: false,
      reason: user.quotaType === "tokens"
        ? "quota_exceeded_tokens"
        : "quota_exceeded_credits",
    };
  }

  // 3. 模型权限 = 账号白名单 ∩ Key 白名单（任一为空则该层不额外限制）
  const ownerAllows = user.allowedModels.length === 0
    || user.allowedModels.includes(requestedModel);
  const keyAllows = key.allowedModels.length === 0
    || key.allowedModels.includes(requestedModel);
  if (!ownerAllows || !keyAllows) return { ok: false, reason: "model_not_allowed" };

  return { ok: true, reason: "ok" };
}
```

> 第 2 步是「多建 Key 不会多拿额度」的落点：无论请求由哪把 Key 承载，
> 读的都是同一个 `user.quotaUsed / user.quotaLimit`。
> `quotaLimit === 0`（未分配）会被判定为超额，即新账号默认无法调用，
> 而不是被当成「不限额」。

---

## 3. 上游 Provider（Provider）

**键**：`relay:provider:{providerId}` — Hash

**字段**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string (ULID) | 主键 |
| `name` | string | 管理员可见名称 |
| `kind` | `"openai" \| "anthropic" \| "custom-openai" \| "azure"` | 协议家族。`anthropic` = 该 Provider 说 Anthropic Messages 协议 |
| `baseUrl` | string \| null | 上游根地址，代理在其后拼接端点路径 |
| `encryptedApiKey` | string (base64) | AES-256-GCM 加密的上游 Key |
| `modelMapping` | JSON string | 客户端模型 → 上游真实模型。推荐恒等映射 |
| `modelConfigs` | JSON string | 可选的每模型上下文长度 / 输出上限 / 计费参数 |
| `headers` | JSON string | 可选的附加请求头（如 Azure 的 `api-version`） |
| `upstreamFormat` | `"responses" \| "chat" \| "anthropic"` | 上游原生协议，默认 `responses`。决定请求路径与是否需要协议转换 |
| `enabled` | 0 \| 1 | |
| `priority` | number | 路由优先级（数字小优先） |
| `createdAt` | ISO string | |
| `updatedAt` | ISO string | |

**示例**：
```json
{
  "id": "01J7R5K8W6Z8X8X8X8X8X8X8X8",
  "name": "MiniMax 主力",
  "kind": "openai",
  "baseUrl": "https://api.minimax.cn/v1",
  "encryptedApiKey": "AbCdEf123...==",
  "modelMapping": "{\"MiniMax-M3\":\"MiniMax-M3\"}",
  "upstreamFormat": "responses",
  "enabled": "1",
  "priority": "1",
  "createdAt": "2026-09-21T08:00:00.000Z"
}
```

> **模型映射请用恒等映射。** `modelMapping` 的左列会原样出现在 `GET /v1/models` 并被写进用量日志。
> 把 `claude-sonnet-4-6` 这类名字指向非 Anthropic 的上游模型会造成误导，除非客户端硬编码了模型名且无法覆盖。
> 端点与 `baseUrl` 的配对规则见 [ARCHITECTURE.md §7.3](ARCHITECTURE.md#73-端点--上游路径)。

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
