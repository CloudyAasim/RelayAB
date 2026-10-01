# 数据模型

> 所有数据持久化在一个 **SQLite 数据库文件**里，由 Node 24 内置的 `node:sqlite` 驱动
> （无 npm 依赖）。**不需要任何数据库服务**：没有 Redis/Valkey、没有端口、没有密码。
> 备份就是复制文件。
>
> 库文件位置由 `RELAY_DB_PATH` 决定；不设则默认 `./data/relayab.db`。
> 托管环境仍可改设 `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` 走 Upstash REST，
> 但那是一次显式的备选部署，不是默认路径。
>
> 实体类型定义在 [`src/lib/db/types.ts`](../src/lib/db/types.ts)，建表语句在
> [`src/lib/db/sqlite.ts`](../src/lib/db/sqlite.ts)，本文档为概要。

---

## 存储约定

下面每张表的列类型都由这四条推出，先读一遍再往下看：

- **表与实体一一对应**，列名是实体字段名的 `snake_case`。每行读出后都会再走一遍同一个
  Zod schema（`rowToUser()` 等），所以字段表里写的是**实体字段名**，旁边标出实际列名。
  一次 `parse` 取代了 Redis 版本需要的整套手写 `hashTo*` 反序列化。
- **布尔存 `INTEGER` 0/1。** `node:sqlite` 没有布尔绑定，`toDbBool` / `fromDbBool`
  显式转换，不会让一个"真值数字"漏进实体。
- **结构化值存 JSON 文本**：`allowed_models`、`model_mapping`、`model_configs`、
  `headers`、`models`、`specs`。SQLite 没有 map 类型，而这几个字段都是整体读、整体写，
  从不按内部元素做查询。
- **时间戳存 ISO 字符串**（`TEXT`），不是 epoch 整数。保持文本，全应用既有的比较与
  排序逻辑因此一行都不用改。

建表语句在每次打开连接时执行，每条都是 `IF NOT EXISTS`——所以它同时就是迁移机制。

---

## 1. 用户（User）

**表**：`users` —— 一行一个用户。`username` 带 `UNIQUE` 约束。
登录名反查原本是一条 `relay:user:by-username:*` 索引键，现在是数据库层的唯一约束：
并发插入同名用户时由 SQLite 判定，应用层不再需要自己做判重。

**字段**：

| 实体字段 | 列 | 存储类型 | 说明 |
|---|---|---|---|
| `id` | `id` | TEXT (PK) | 主键，ULID |
| `username` | `username` | TEXT NOT NULL **UNIQUE** | 登录名，3-32 字符 |
| `passwordHash` | `password_hash` | TEXT NOT NULL | bcryptjs 散列，work factor 12 |
| `role` | `role` | TEXT NOT NULL | `"admin" \| "user"`，admin 可访问 `/admin/*` |
| `displayName` | `display_name` | TEXT NOT NULL | 展示用 |
| `timezone` | `timezone` | TEXT NULL | 每用户展示时区，可选。缺省 = 采用默认值（`shanghai`）。仅支持 `"utc"` 与 `"shanghai"` |
| `createdAt` | `created_at` | TEXT NOT NULL | ISO 字符串 |
| `updatedAt` | `updated_at` | TEXT NOT NULL | ISO 字符串 |
| `lastLoginAt` | `last_login_at` | TEXT NULL | ISO 字符串或 NULL |
| `quotaType` | `quota_type` | TEXT NOT NULL | `"credits" \| "tokens"`，账号积分池的计量单位 |
| `quotaLimit` | `quota_limit` | INTEGER NOT NULL | 账号积分池总量（credits 时以 0.001 积分整数存储）。`0` = 未分配，所有调用都会被拒绝 |
| `quotaUsed` | `quota_used` | INTEGER NOT NULL DEFAULT 0 | 账号已消耗量，单位同 `quotaLimit` |
| `maxActiveKeys` | `max_active_keys` | INTEGER NOT NULL | 允许同时启用的 Key 数上限（0 = 无上限） |
| `allowedModels` | `allowed_models` | TEXT NOT NULL DEFAULT `'[]'` | 可访问的模型白名单，JSON 数组文本（空 = 全部） |

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
> 「给 Alice 1000 积分」的意思。因此 `api_keys` 上**没有**任何 quota 字段。
>
> `allowedModels` 同样属于账号；Key 只能在此基础上**收窄**（见下文 §2），
> 不可能放宽。管理员在 `/admin/users` 配置这三项，用户无法自行修改。

**一行长什么样**：
```json
{
  "id": "01J7R5K8W6X8X8X8X8X8X8X8X8",
  "username": "alice",
  "password_hash": "$2a$12$...",
  "role": "user",
  "display_name": "Alice",
  "timezone": null,
  "created_at": "2026-09-21T08:00:00.000Z",
  "updated_at": "2026-09-21T08:00:00.000Z",
  "last_login_at": null,
  "quota_type": "credits",
  "quota_limit": 500000,
  "quota_used": 13500,
  "max_active_keys": 0,
  "allowed_models": "[\"gpt-4o-mini\"]"
}
```

---

## 2. 客户 API Key（ApiKey）

**表**：`api_keys` —— 一行一把 Key。

Redis 版本需要同时维护三个结构：记录 HASH、`hash:{sha256}` → id 反查 STRING、
以及 `by-user:{id}` SET。于是每次增删都要 `MULTI` 再走一条"回卷二级索引"的路径，
两步之间任何中断都会留下一条查不到记录的 Key，或一个指向空处的悬空索引。现在三条
不变式分别由**列、外键和索引**表达：一次写入就是一条语句，没有第二个结构会漂移。

| 不变式 | 由谁保证 |
|---|---|
| 同一把明文 Key 不会存在两次 | `key_hash` 上的 `UNIQUE` |
| Key 不会指向不存在的用户 | `user_id` 外键指向 `users(id)`，`ON DELETE CASCADE` |
| 按用户列 Key 是 O(log n) | 索引 `idx_api_keys_user` |

**字段**：

| 实体字段 | 列 | 存储类型 | 说明 |
|---|---|---|---|
| `id` | `id` | TEXT (PK) | 主键，ULID |
| `userId` | `user_id` | TEXT NOT NULL，FK → `users(id)` ON DELETE CASCADE | 所属用户 |
| `label` | `label` | TEXT NOT NULL | 用户/管理员给这把 Key 起的名字 |
| `keyHash` | `key_hash` | TEXT NOT NULL **UNIQUE** | sha256(明文 key)，**不存明文**。Bearer 校验就是查这一列 |
| `keyPrefix` | `key_prefix` | TEXT NOT NULL | 明文前 12 字符 + `...` + 后 4 字符，仅展示 |
| `expiresAt` | `expires_at` | TEXT NULL | 过期时间，ISO 字符串或 NULL |
| `enabled` | `enabled` | INTEGER NOT NULL | 启用标志，0/1 |
| `forceDisabled` | `force_disabled` | INTEGER NOT NULL DEFAULT 0 | 由管理员设置。一旦设置，用户**不能**自行重新启用该 Key；API 会返回 `key_force_disabled` |
| `allowedModels` | `allowed_models` | TEXT NOT NULL DEFAULT `'[]'` | 这把 Key **额外**允许的模型，JSON 数组文本。与账号白名单取**交集**——只能收窄，不能放宽（空 = 不额外限制，仍受账号白名单约束） |
| `createdAt` | `created_at` | TEXT NOT NULL | ISO 字符串 |
| `lastUsedAt` | `last_used_at` | TEXT NULL | ISO 字符串或 NULL |

> Key 是**凭证**，不是钱包。它只携带身份（谁在调用）与轻量策略
> （启用 / 过期 / 可选的模型收窄），额度池在所属账号上。
> 因此这里**没有** `quotaType` / `quotaLimit` / `quotaUsed` 三列。

**一行长什么样**：
```json
{
  "id": "01J7R5K8W6Y8X8X8X8X8X8X8X8",
  "user_id": "01J7R5K8W6X8X8X8X8X8X8X8X8",
  "label": "Alice 的 Macbook",
  "key_hash": "a3f2c9...",
  "key_prefix": "sk-relay-X3K...m2pQ",
  "expires_at": "2026-12-31T23:59:59.000Z",
  "force_disabled": 0,
  "enabled": 1,
  "allowed_models": "[\"gpt-4o-mini\",\"gpt-4o\"]",
  "created_at": "2026-09-21T08:00:00.000Z",
  "last_used_at": null
}
```

**校验逻辑**（`lib/auth/apikey.ts` 的 `checkKeyStatus`）：

```ts
// 顺序即优先级；user 是 key 的所属账号，必需。
function checkKeyStatus({ key, user, requestedModel }): KeyValidationResult {
  // 1. 先看管理员强制禁用 —— 被强禁的 key 绝不服务流量，哪怕 enabled 仍为真
  if (key.forceDisabled) return { ok: false, reason: "key_force_disabled" };

  // 2. 凭证本身
  if (!key.enabled) return { ok: false, reason: "key_disabled" };
  if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now())
    return { ok: false, reason: "key_expired" };

  // 3. 账号的积分/Token 额度池 —— 注意读的是 user，不是 key。
  //    没有账号级禁用：用户无法被停用，因此不存在 `user_disabled` 这个原因。
  //    真正能拦住调用的是把 quotaLimit 设为 0。
  if (user.quotaUsed >= user.quotaLimit) {
    return {
      ok: false,
      reason: user.quotaType === "tokens"
        ? "quota_exceeded_tokens"
        : "quota_exceeded_credits",
    };
  }

  // 4. 模型权限 = 账号白名单 ∩ Key 白名单（任一为空则该层不额外限制）
  const ownerAllows = user.allowedModels.length === 0
    || user.allowedModels.includes(requestedModel);
  const keyAllows = key.allowedModels.length === 0
    || key.allowedModels.includes(requestedModel);
  if (!ownerAllows || !keyAllows) return { ok: false, reason: "model_not_allowed" };

  return { ok: true, reason: "ok" };
}
```

> 第 3 步是「多建 Key 不会多拿额度」的落点：无论请求由哪把 Key 承载，
> 读的都是同一个 `user.quotaUsed / user.quotaLimit`。
> `quotaLimit === 0`（未分配）会被判定为超额，即新账号默认无法调用，
> 而不是被当成「不限额」。

---

## 3. 上游 Provider（Provider）

**表**：`providers` —— 一行一个上游。多个 Provider 靠 `priority` 排序参与路由与轮换。

**字段**：

| 实体字段 | 列 | 存储类型 | 说明 |
|---|---|---|---|
| `id` | `id` | TEXT (PK) | 主键，ULID |
| `name` | `name` | TEXT NOT NULL | 管理员可见名称 |
| `kind` | `kind` | TEXT NOT NULL | 协议家族。`anthropic` = 该 Provider 说 Anthropic Messages 协议 |
| `baseUrl` | `base_url` | TEXT NULL | 上游根地址，代理在其后拼接端点路径 |
| `encryptedApiKey` | `encrypted_api_key` | TEXT NOT NULL | AES-256-GCM 加密的上游 Key（base64） |
| `modelMapping` | `model_mapping` | TEXT NOT NULL DEFAULT `'{}'` | 客户端模型 → 上游真实模型，JSON 对象文本。推荐恒等映射 |
| `modelConfigs` | `model_configs` | TEXT NOT NULL DEFAULT `'{}'` | 可选的每模型配置，JSON 对象文本 —— 见 §3.1 |
| `headers` | `headers` | TEXT NOT NULL DEFAULT `'{}'` | 可选的附加请求头（如 Azure 的 `api-version`），JSON 对象文本 |
| `upstreamFormat` | `upstream_format` | TEXT NOT NULL DEFAULT `'responses'` | `"responses" \| "chat" \| "anthropic"`，上游原生协议。**遗留只读值**：它描述 OpenAI 侧的格式；一个 Provider 实际对外提供哪些协议面由下面两个 `*Enabled` 标志决定 |
| `openaiEnabled` | `openai_enabled` | INTEGER NOT NULL DEFAULT 1 | 该 Provider 是否服务 OpenAI 侧端点（`/v1/chat/completions`、`/v1/responses`） |
| `anthropicEnabled` | `anthropic_enabled` | INTEGER NOT NULL DEFAULT 0 | 该 Provider 是否**同时**提供 Anthropic Messages 协议面（`/anthropic/v1/messages`、`/v1/messages`） |
| `anthropicBaseUrl` | `anthropic_base_url` | TEXT NULL | Anthropic 协议面的 base URL。`NULL` = 由 `base_url` 推导（会去掉一个结尾的 `/v1`）。当厂商的 Anthropic 端点是子路径时需显式设置，如 `https://api.deepseek.com/anthropic` |
| `enabled` | `enabled` | INTEGER NOT NULL | 0/1 |
| `priority` | `priority` | INTEGER NOT NULL DEFAULT 0 | 路由优先级（数字小优先） |
| `createdAt` | `created_at` | TEXT NOT NULL | ISO 字符串 |
| `updatedAt` | `updated_at` | TEXT NOT NULL | ISO 字符串 |

> #### ⚠️ 一个 Provider 行同时承载**两个协议面**
>
> 两个协议面**共用** API Key、`modelMapping` 与 `modelConfigs`——对同一个厂商这些
> 都是一样的。因此为同一厂商配置两次（每个协议一次）**已无必要**；区别通常只在于
> 协议本身，以及 base URL。本表早先的版本描述的是一套单协议面模型，由 `kind` 与
> `upstreamFormat` 决定一切；那是遗留形态。
>
> | 字段 | 决定 |
> | --- | --- |
> | `openaiEnabled` | OpenAI 侧端点是否使用该 Provider |
> | `anthropicEnabled` | Anthropic Messages 协议面是否使用该 Provider |
> | `anthropicBaseUrl` | Anthropic 侧的 base URL（为 `NULL` 时由 `baseUrl` 推导） |
> | `upstreamFormat` | OpenAI 侧的原生格式 —— `responses`（原生）或 `chat` |
>
> 协议面在路由中如何协作见
> [architecture.md §7](architecture.md#7-上游-provider-与模型映射)。

### 3.1 ModelConfig

`model_configs` 把客户端模型名映射到一个 `ModelConfig`（JSON 对象文本）：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `upstreamId` | string | — | 上游模型 ID |
| `clientId` | string | — | 面向客户端的别名 |
| `displayName` | string | — | 可选展示名 |
| `contextLength` | positive int | `128000` | 上下文窗口（输入 token 数） |
| `maxOutputTokens` | positive int | `8192` | 最大输出 token 数 |
| `inputCost` | number ≥ 0 | `0` | 每 1M 输入 token 的积分 |
| `outputCost` | number ≥ 0 | `0` | 每 1M 输出 token 的积分 |
| `enabled` | boolean | `true` | 是否提供该模型 |

> `contextLength`、`maxOutputTokens` 与 `enabled` 目前**仅作记录**——
> 既不会与请求做校验，也不会用于截断输出。

**一行长什么样**：
```json
{
  "id": "01J7R5K8W6Z8X8X8X8X8X8X8X8",
  "name": "MiniMax 主力",
  "kind": "openai",
  "base_url": "https://api.minimaxi.com/v1",
  "encrypted_api_key": "AbCdEf123...==",
  "model_mapping": "{\"MiniMax-M3\":\"MiniMax-M3\"}",
  "model_configs": "{}",
  "headers": "{}",
  "upstream_format": "responses",
  "openai_enabled": 1,
  "anthropic_enabled": 0,
  "anthropic_base_url": null,
  "enabled": 1,
  "priority": 1,
  "created_at": "2026-09-21T08:00:00.000Z",
  "updated_at": "2026-09-21T08:00:00.000Z"
}
```

> **模型映射请用恒等映射。** `model_mapping` 的左列会原样出现在 `GET /v1/models`
> 并被写进用量日志。把 `claude-sonnet-4-6` 这类名字指向非 Anthropic 的上游模型会造成
> 误导，除非客户端硬编码了模型名且无法覆盖。
> 端点与 `base_url` 的配对规则见 [architecture.md §7.3](architecture.md#73-端点--上游路径)。

### 3.2 媒体供应商（MediaProvider）

**表**：`media_providers` —— 图片 / 视频 / 语音 / 音乐供应商。与 `providers` 平行但独立：
它没有 OpenAI/Anthropic 双协议面，取而代之的是一份声明式 spec 数组。

| 实体字段 | 列 | 存储类型 | 说明 |
|---|---|---|---|
| `id` | `id` | TEXT (PK) | 主键 |
| `name` | `name` | TEXT NOT NULL | 管理员可见名称 |
| `baseUrl` | `base_url` | TEXT NOT NULL | spec 里每个 `transport.path` 都相对于它解析 |
| `encryptedApiKey` | `encrypted_api_key` | TEXT NOT NULL | AES-256-GCM 加密的上游 Key |
| `enabled` | `enabled` | INTEGER NOT NULL | 0/1 |
| `priority` | `priority` | INTEGER NOT NULL DEFAULT 0 | 路由优先级（数字小优先） |
| `models` | `models` | TEXT NOT NULL DEFAULT `'{}'` | 客户端模型名 → `MediaModelConfig`（含 `pricePerItem`），JSON 对象文本 |
| `specs` | `specs` | TEXT NOT NULL DEFAULT `'[]'` | `MediaSpec[]`，JSON 数组文本 —— 协议格式见 [模型适配协议/README.md](../模型适配协议/README.md) |
| `createdAt` | `created_at` | TEXT NOT NULL | ISO 字符串 |
| `updatedAt` | `updated_at` | TEXT NOT NULL | ISO 字符串 |

> `models[客户端模型名].pricePerItem` 的单位是**整数积分**；写入时按 0.001 积分单位存储，
> `computeMediaCredits` 负责 ×1000 换算，**不要预乘**。

---

## 4. 用量日志（UsageLog）

**表**：`usage_logs` —— 一行一次请求。只追加，不更新。

| 实体字段 | 列 | 存储类型 | 说明 |
|---|---|---|---|
| `id` | `id` | TEXT (PK) | ULID |
| `apiKeyId` | `api_key_id` | TEXT NOT NULL | 冗余便于按 Key 聚合 |
| `userId` | `user_id` | TEXT NOT NULL | 冗余便于反查 |
| `providerId` | `provider_id` | TEXT NOT NULL | 实际处理这次请求的 Provider |
| `model` | `model` | TEXT NOT NULL | 客户端请求的模型 |
| `upstreamModel` | `upstream_model` | TEXT NOT NULL | 实际发到上游的模型 |
| `promptTokens` | `prompt_tokens` | INTEGER NOT NULL DEFAULT 0 | |
| `completionTokens` | `completion_tokens` | INTEGER NOT NULL DEFAULT 0 | |
| `totalTokens` | `total_tokens` | INTEGER NOT NULL DEFAULT 0 | |
| `creditsUsed` | `credits_used` | INTEGER NOT NULL DEFAULT 0 | 本次请求消耗的 **积分**，以 0.001 积分为整数单位（`CREDIT_SCALE = 1000`） |
| `images` | `images` | INTEGER NULL | **仅媒体。** 请求产出的条目数——按条目计费的基础。聊天调用为 `NULL` |
| `capability` | `capability` | TEXT NULL | **仅媒体。** 由哪个能力处理：`image.generate`、`video.generate`、`audio.tts`、`audio.stt`、`music.generate` |
| `status` | `status` | TEXT NOT NULL | `"success" \| "error"` |
| `errorMessage` | `error_message` | TEXT NULL | |
| `billingMode` | `billing_mode` | TEXT NULL | 扣费来自上游上报的用量，还是来自估算 |
| `createdAt` | `created_at` | TEXT NOT NULL | ISO 字符串 |

> `images` 与 `capability` 在实体上是可选的：聊天请求不写这两列，列值为 `NULL`，
> 读回时保持 `undefined` 而不是变成 0。

**索引**（这三条都是为聚合查询准备的）：

| 索引 | 支撑的查询 |
|---|---|
| `idx_usage_logs_key (api_key_id, created_at)` | 某把 Key 的用量明细与时间范围 |
| `idx_usage_logs_user (user_id, created_at)` | 某账号的用量明细与时间范围 |
| `idx_usage_logs_created (created_at)` | 全局时间范围扫描 |

**保留策略**：**每把 Key 最多 1000 条**（`MAX_LOGS_PER_KEY`）。超出的旧行在写入时
删掉——一条 `DELETE ... WHERE id NOT IN (SELECT ... ORDER BY created_at DESC LIMIT ?)`，
`id` 用来在同一毫秒内多条记录之间定序。
**没有基于天数的保留策略**，也没有定时清理任务：用量流水是只增的账目，不会按时间过期。

---

### 4.1 用量汇总（UsageTotals）

**表**：`usage_totals` —— 每把 Key 一行的滚动累计值，主键就是 `api_key_id`。

| 列 | 存储类型 | 说明 |
|---|---|---|
| `api_key_id` | TEXT (PK) | 对应 `api_keys.id` |
| `prompt_tokens` | INTEGER NOT NULL DEFAULT 0 | 累计输入 token |
| `completion_tokens` | INTEGER NOT NULL DEFAULT 0 | 累计输出 token |
| `total_tokens` | INTEGER NOT NULL DEFAULT 0 | 累计总 token |
| `credits_used` | INTEGER NOT NULL DEFAULT 0 | 累计消耗积分（0.001 积分单位） |
| `images` | INTEGER NOT NULL DEFAULT 0 | 累计媒体条目数 |
| `requests` | INTEGER NOT NULL DEFAULT 0 | 累计请求数 |

> 为什么不直接对 `usage_logs` 做 `SUM`：代理路径**每次调用**都要读这份累计值。
> 单表主键定位加原子自增，比每次扫全表求和便宜得多——Redis 版本靠 `HINCRBY`
> 达到同样目的，现在由一条 `UPDATE ... SET x = x + ?` 承担。

---

## 5. Session

由 **iron-session** 8 自动管理，cookie 名 `relay_session`，**不落库**。

载荷：
```json
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

> 载荷里的 `iat` / `exp` 是 epoch 秒数，这是 iron-session 的格式，与库里时间戳
> 存 ISO 字符串的约定互不影响。

---

## 6. 辅助表与索引总表

### 6.1 辅助表

| 表 | 形状 | 用途 |
|---|---|---|
| `settings` | `key` TEXT PK, `value` TEXT NOT NULL | 小型键值袋（当前只有 `publicUrl`）。做成表而不是一个大 blob，新增一项设置不必改结构 |
| `meta` | `key` TEXT PK, `value` TEXT NOT NULL | 记录一次性 bootstrap 是否已跑过。Redis 版本用 `SETNX` 抢占这个槽位，这里"违反主键的 INSERT"就是同一个把戏的 SQL 写法，在事务内无竞态 |
| `schema_version` | `version` INTEGER PK | 当前固定为 `1`。目前还没有已发布的 SQLite 结构，这张表是为**第一次真正需要迁移**时准备的簿记 |

`meta` 当前只有一行：`key = 'initialized'`。

### 6.2 索引与约束总表

| 名称 | 表.列 | 类型 | 作用 |
|---|---|---|---|
| `users.username` | `users` | UNIQUE | 登录名判重 |
| `api_keys.key_hash` | `api_keys` | UNIQUE | 同一把明文 Key 不会存在两次；Bearer 校验的查找路径 |
| `api_keys.user_id` | `api_keys` | FK → `users(id)` ON DELETE CASCADE | 删用户连带删 Key；不留孤儿 |
| `idx_api_keys_user` | `api_keys(user_id)` | INDEX | 按用户列 Key |
| `idx_usage_logs_key` | `usage_logs(api_key_id, created_at)` | INDEX | 按 Key 的用量明细 |
| `idx_usage_logs_user` | `usage_logs(user_id, created_at)` | INDEX | 按账号的用量明细 |
| `idx_usage_logs_created` | `usage_logs(created_at)` | INDEX | 全局时间范围扫描 |

> 其余表的主键即索引（`users.id`、`api_keys.id`、`providers.id`、
> `media_providers.id`、`usage_logs.id`、`usage_totals.api_key_id`、
> `settings.key`、`meta.key`）。
>
> `usage_logs.api_key_id` / `user_id` **没有**外键：流水是账目，删用户或删 Key 时
> 刻意保留历史行。

---

## 8. 未来扩展（v2）

以下是设想，**尚未实现**；括号里是它们在这套结构里最自然的落点。

- 按月聚合的用量（一张 `usage_monthly (yyyymm, api_key_id, credits_used)` 汇总表）
- 滑动窗口限速（`ratelimit` 表 + 时间窗口索引）
- 按 Provider 反查用过的 Key（审计用途；`usage_logs.provider_id` 已有索引支撑，
  大概率不需要额外结构）
