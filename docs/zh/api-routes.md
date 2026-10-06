# API 路由详细规范

> 路径相对于部署根域名（如 `https://relay.example.com`）。
>
> **两套信封，按面划分，不要混用：**
> - **OpenAI 兼容面**（`/v1/*`）用 OpenAI 自己的形状：失败是
>   `{ "error": { "message", "type", "code" } }`，成功是 OpenAI 的对象
>   （`{"object":"list","data":[...]}` 等）。带 `type` 是为了让按 OpenAI 约定
>   写客户端的代码能按 `error.type` 分支——只给 `code` 的话它读到的是
>   `undefined`。
> - **Session 面**（`/api/*`）用本项目自己的形状：
>   `{ ok: true, data: ... }` 或 `{ ok: false, error: { code, message } }`。
>
> `code` 在两面里都保持原样，没有被重命名——已经在按 `code` 判断的客户端
> 不会因为这次改动而失效，`type` 是新增信息。

---

## 1. 公开代理接口

> 实现说明：这些客户端可见路径（`/v1/*`）由 Next.js Route Handlers 直接处理。
> 支持两种路径格式：
> - `/v1/*` （推荐，直接访问）
> - `/api/v1/*` （兼容旧版）

### 1.1 `POST /v1/chat/completions`

**用途**：OpenAI Chat Completions 兼容端点。

**请求头**：
```
Authorization: Bearer sk-relay-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
Content-Type: application/json
```

**请求体**（OpenAI 标准）：
```json
{
  "model": "gpt-4o-mini",
  "messages": [{"role": "user", "content": "Hi"}],
  "temperature": 0.7,
  "stream": false
}
```

**响应（非流式）**：
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1695273600,
  "model": "gpt-4o-mini",
  "choices": [{"index": 0, "message": {"role": "assistant", "content": "..."}, "finish_reason": "stop"}],
  "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
}
```

**上游行为**：
本端点发出的**永远是 Chat Completions 格式**的请求体，因此固定转发到上游的
`<provider.baseUrl>/chat/completions`。Provider 的 `upstreamFormat` 不会改变这个路径
（否则会把 Chat 请求体发到 Responses 端点）。`upstreamFormat = "anthropic"` 的
Provider 会被本端点排除。

**错误响应体**（`/v1/*` 全部适用，含下面所有公开代理端点）：
```json
{ "error": { "message": "积分 balance exhausted for this account",
             "type": "insufficient_quota",
             "code": "quota_exceeded_credits" } }
```
`type` 由 HTTP 状态码推导，不是逐个 code 登记的——这样它不可能和状态码走偏。
唯一的例外是配额耗尽：它是 429，但类型是 `insufficient_quota` 而不是
`rate_limit_error`。客户端若对 429 做退避重试，面对一个不会自己恢复的额度池
就会永远重试下去，所以这两件事必须区分开。

**错误码**：
| HTTP | type | code | 含义 |
|---|---|---|---|
| 401 | `authentication_error` | `unauthorized` | 缺少/无效 Bearer |
| 403 | `permission_error` | `key_disabled` | Key 已禁用 |
| 403 | `permission_error` | `key_force_disabled` | 该 Key 已被管理员强制停用，用户无法自行重新启用 |
| 403 | `permission_error` | `key_expired` | Key 已过期 |
| 403 | `permission_error` | `model_not_allowed` | 该 Key 不允许此模型 |
| 400 | `invalid_request_error` | `model_not_mapped` | 没有任何 Provider 支持此客户端模型 |
| 400 | `invalid_request_error` | `missing_model` | 请求体缺少 `model` 字段 |
| **429** | **`insufficient_quota`** | `quota_exceeded_credits` | 积分不足 |
| **429** | **`insufficient_quota`** | `quota_exceeded_tokens` | 账号的 token 配额已用尽（`quotaType: "tokens"`） |
| 502 | `server_error` | `upstream_error` | 上游调用失败 |
| 500 | `server_error` | `internal_error` | 系统错误 |

> 配额耗尽用的是 **429 而不是 403**：403 读作「你无权这样做」，那是一个不同的问题、
> 不同的补救方式——客户端拿到 403 永远不会想到去充值。

**余额响应头**：`/v1/*` 的每个响应都附带调用方账号的额度状态。
```
x-ratelimit-limit: 500000          # 额度池上限（0 = 尚未分配，不是「余额为 0」）
x-ratelimit-remaining: 487655      # 剩余，下限为 0（超支读作 0，不出现负数）
x-ratelimit-unit: credits          # 单位；quotaType 为 tokens 时这里就是 tokens
```
它回答的是「**刚才那次调用之后**还剩多少」，数字在响应时刻读取，所以不会陈旧。
要在调用**之前**问「我还有多少」，用下面的 `GET /v1/credits`——响应头只有先发起
一次调用才会存在。

只有一个池，所以只有一对数字。OpenAI 把单位写进头名（`-requests` / `-tokens`），
那是因为它同时限制请求数和 token 数；这里照抄会是为一个不存在的问题付费，客户端
仍然得先知道该看哪个头，所以直接用 `x-ratelimit-unit` 说明。

---

### 1.1.1 `GET /v1/credits`

**用途**：查询调用方账号的额度池。

**鉴权**：`Authorization: Bearer sk-relay-…`，与其它 `/v1/*` 端点同一把密钥。
**任何一把有效密钥都能查**——额度池属于账号而不是密钥，所以不存在「哪一种密钥
可以查余额」这个问题（MiniMax 需要显式区分 Subscription Key 与按量计费 Key）。

**响应**：
```json
{
  "object": "credit_balance",
  "is_available": true,
  "unit": "credits",
  "scale": 1000,
  "limit": 500000,
  "used": 12345,
  "remaining": 487655
}
```

| 字段 | 含义 |
|---|---|
| `is_available` | **是否还有可花的**——直接可用于判断要不要发这次请求 |
| `unit` | `credits` 或 `tokens`；账号可以按 token 计量，只给数字无从判断 |
| `scale` | 多少个存储单位等于一个 `unit`，客户端据此换算，不必硬编码 |
| `limit` | 额度池上限；`0` 表示**尚未分配**，不是「余额为 0」 |
| `used` | 已消耗 |
| `remaining` | 剩余，下限为 0（超支读作 0，不出现负数） |

**几点设计取舍**：

- **`is_available` 才是这个端点存在的理由。** 没有它，客户端要自己拿 `remaining`
  去比一个阈值、再自己判断单位——那正是「把已经算好的答案推回给调用方拼」。
  DeepSeek 的 `GET /user/balance` 出于同样原因返回这个字段。
- **额度不足不构成拒绝的理由。** 这个端点会跳过配额检查（`skipQuotaCheck`）：
  问余额不花钱，所以一个用完的池不该把人挡在门外——否则它恰恰在唯一有用的那个
  状态下无法回答。其他检查照常生效：已禁用或已过期的密钥一样读不到。
- **没有 `reset_time`。** MiniMax 的配额端点带重置时间，因为它的是 5 小时滚动 +
  周窗口。本项目的池是一次性分配、没有窗口，因此没有可报的重置时间；加一个
  恒为 null 的字段只是仪式。
- **不是数组。** DeepSeek 返回 `balance_infos` 数组是因为它有 CNY 和 USD 两种
  币种。本项目只有一个池，`quotaType` 的两个取值是同一个池的两种计量方式，不是
  两种余额。
- **数值是瞬时快照。** 并发请求可以在两次读之间花掉同一个池——这是「问一个共享
  账户」固有的，不是这个端点能安排掉的。

---

### 1.2 `POST /v1/responses`

**用途**：OpenAI Responses API 兼容端点。

**请求头**：
```
Authorization: Bearer sk-relay-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
Content-Type: application/json
```

**请求体**（OpenAI 标准）：
```json
{
  "model": "gpt-4o-mini",
  "input": "Hello, how are you?",
  "stream": false
}
```

或使用数组格式：
```json
{
  "model": "gpt-4o-mini",
  "input": [
    {"type": "input_text", "content": "Hello"}
  ],
  "stream": false
}
```

**响应**：
```json
{
  "id": "resp_xxx",
  "object": "response",
  "status": "completed",
  "model": "gpt-4o-mini",
  "output": [
    {
      "id": "msg_xxx",
      "type": "message",
      "status": "completed",
      "role": "assistant",
      "content": [{"type": "output_text", "text": "...", "annotations": []}]
    }
  ],
  "output_text": "...",
  "usage": {"input_tokens": 10, "output_tokens": 20, "total_tokens": 30}
}
```

**上游行为与协议转换**：
- Provider 为 `upstreamFormat = "responses"` → 原样转发到 `<baseUrl>/responses`。
- Provider 为 `upstreamFormat = "chat"` → 先转成 Chat 请求体调用 `<baseUrl>/chat/completions`，
  再把 Chat 响应转回上面的 Responses 结构。
- Provider 为 `upstreamFormat = "anthropic"`（或 `kind = "anthropic"`）→ 转成
  Anthropic Messages 请求调用 `<baseUrl>/v1/messages`，再转回 Responses 结构。

**用量字段兼容**：不同上游对 usage 的命名不同。Chat Completions 用
`prompt_tokens` / `completion_tokens`，Responses 与 Anthropic 用
`input_tokens` / `output_tokens`。代理两种都会识别，内部统一记录为
`promptTokens` / `completionTokens`。

---

### 1.3 `GET /v1/models`

**用途**：返回该 API Key 可访问的模型列表。

**响应**：
```json
{
  "object": "list",
  "data": [
    {"id": "gpt-4o-mini", "object": "model", "created": 1695273600, "owned_by": "relay-ab"},
    {"id": "claude-3-5-sonnet", "object": "model", "created": 1695273600, "owned_by": "relay-ab"}
  ]
}
```

---

### 1.4 `POST /anthropic/v1/messages`

**用途**：Anthropic Messages 兼容端点。

**请求头**（两种鉴权方式都支持）：
```
x-api-key: sk-relay-xxx            # Anthropic SDK / Claude Code 使用这个
# 或
Authorization: Bearer sk-relay-xxx # OpenAI 风格客户端

anthropic-version: 2023-06-01
Content-Type: application/json
```

**请求体**（Anthropic 标准）：
```json
{
  "model": "claude-3-5-sonnet-20241022",
  "max_tokens": 1024,
  "messages": [{"role": "user", "content": "Hi"}]
}
```

**响应**：标准 Anthropic Messages 响应格式。

**Provider 选择**：本端点只挑 Anthropic 协议的 Provider，顺序为
`upstreamFormat === "anthropic"` → `kind === "anthropic"` → `kind === "custom-openai"`，
同一档内按 `priority` 升序取第一个，请求转发到 `<baseUrl>/v1/messages`。

> 注意 `baseUrl` 要填上游的 **Anthropic** 基址。比如 MiniMax 的 OpenAI 基址是
> `https://api.minimaxi.com/v1`，而 Anthropic 基址是 `https://api.minimaxi.com/anthropic`，
> 两者不能混用。配置步骤见 [architecture.md §7.5](architecture.md#75-新增一条-anthropic-provider)。

---

### 1.5 `GET /healthz`

**用途**：健康检查，无需鉴权。

**响应**：
```json
{ "ok": true, "data": { "status": "ok", "version": "0.1.0" } }
```

---

## 2. 管理 API（Session 鉴权）

> 所有 `/api/admin/*` 路由都需 `session.userId` 存在且 `session.role === "admin"`。
> 未授权返回 401 / 403。

### 2.1 认证

#### `POST /api/auth/login`
**请求体**：
```json
{ "username": "alice", "password": "secret" }
```
**响应**：
```json
{ "ok": true, "data": { "user": { "id": "...", "username": "alice", "role": "user" } } }
```
设置 cookie `relay_session`。

#### `POST /api/auth/logout`
清除 cookie。

#### `GET /api/auth/me`
**响应**：
```json
{ "ok": true, "data": { "user": { "id": "...", "username": "alice", "role": "user" } } }
```

---

### 2.2 用户管理

#### `GET /api/admin/users`
查询参数：`?limit=50&cursor=xxx`

> **不存在 `q` 搜索参数。** 该路由自身的 JSDoc 头仍然写着 `?q=`，但处理函数只读取
> `limit` 和 `cursor` —— 传入 `q` 会被静默忽略。筛选在管理后台前端完成。

**响应**：
```json
{
  "ok": true,
  "data": {
    "users": [
      {"id": "01J...", "username": "alice", "role": "user", "displayName": "Alice", "createdAt": "..."}
    ],
    "nextCursor": null
  }
}
```

#### `POST /api/admin/users`
**请求体**：
```json
{ "username": "bob", "password": "optional-supplied-value", "role": "user", "displayName": "Bob" }
```

> ⚠️ **完全省略 `password` —— 不要传字符串 `"generate"`。**
> 只有字段**缺失**（`password === undefined`）时才会触发自动生成。
> 你传的任何字符串都会被**原样当作密码**，所以传 `"generate"` 会把这类用户的
> 密码都设成字面量 `generate`。

省略 `password` 时，会生成一个随机密码并在响应中返回一次：

**响应**：
```json
{
  "ok": true,
  "data": {
    "user": {"id": "...", "username": "bob", "role": "user"},
    "generatedPassword": "Ab12-cd34-EF56-gh78"
  }
}
```

#### `PATCH /api/admin/users/[id]`
请求体：`{ displayName?, role?, quotaType?, quotaLimit?, quotaUsed?, maxActiveKeys?, allowedModels? }`

> **用户没有 `disabled` 字段。** 不存在「停用用户」这个功能；管理后台只提供
> 重置密码 / 编辑显示名 / 删除。若想切断某用户，可以改为设置 `quotaLimit: 0`，
> 或者直接删除该用户。

#### `POST /api/admin/users/[id]/reset-password`
生成新随机密码，返回一次。

#### `DELETE /api/admin/users/[id]`
级联删除该用户所有 Key 与日志。

---

### 2.3 Key 管理

#### `GET /api/admin/keys?userId=xxx`
查询参数：`?userId=`（可选，省略则不筛选）和 `enabledOnly=true`（只返回启用的 Key）。

> 参数是 `userId` 和 `enabledOnly` —— **不是** `enabled`，也**不是** `expired`。
> 这两个都不会被读取，传入它们会静默返回所有 Key。

**响应**：
```json
{
  "ok": true,
  "data": {
    "keys": [
      {
        "id": "01J...",
        "userId": "01J...",
        "label": "Alice's Macbook",
        "keyPrefix": "sk-relay-X3K...m2pQ",
        "expiresAt": "2026-12-31T23:59:59.000Z",
        "enabled": true,
        "forceDisabled": false,
        "allowedModels": ["gpt-4o-mini"],
        "createdAt": "...",
        "lastUsedAt": null
      }
    ]
  }
}
```

> **Key 状态说明**：
> - `enabled: true` - 启用状态
> - `enabled: false` - 停用状态（用户可自行启用）
> - `forceDisabled: true` - 强制停用（管理员操作，用户无法自行启用）

#### `POST /api/admin/keys`
**请求体**：
```json
{
  "userId": "01J...",
  "label": "Macbook"
}
```

> Key 创建后默认启用。Key 的额度（积分/配额）由管理员分配给用户，Key 本身不存储额度信息。

**响应**：
```json
{
  "ok": true,
  "data": {
    "key": { /* 同 GET 中的对象 */ },
    "plainKey": "sk-relay-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
  }
}
```

#### `PATCH /api/admin/keys/[id]`
更新 `label` / `expiresAt` / `allowedModels` / `enabled`。

#### `POST /api/admin/keys/[id]/toggle`
```json
{ "enabled": true }
```
或强制停用：
```json
{ "enabled": false, "forceDisabled": true }
```

#### `DELETE /api/admin/keys/[id]`

---

### 2.4 Provider 管理

#### `GET /api/admin/providers`
#### `POST /api/admin/providers`
```json
{
  "name": "OpenAI 主力",
  "kind": "openai",
  "baseUrl": null,
  "apiKey": "sk-...",
  "modelMapping": {"gpt-4o-mini": "gpt-4o-mini-2024-07-18"},
  "enabled": true,
  "priority": 1
}
```
**响应**：`{ "ok": true, "data": { "provider": { … } } }` —— Provider 对象
**不含** apiKey 明文。（`GET /api/admin/providers` 在同一外层结构里返回
`data.providers` 数组。）

#### `PATCH /api/admin/providers/[id]`
#### `DELETE /api/admin/providers/[id]`

---

### 2.5 用量统计

#### `GET /api/admin/usage`
查询参数：
- `range=today|7d|30d|90d|all|custom`（默认 `all`）
- `from` / `to`：`range=custom` 时的本地日期 `YYYY-MM-DD`（含首含尾）
- `userId`：只看某个账号
- `tzOffset`：时区偏移分钟数，默认 `480`（GMT+8）

管理员可查看全站用量；`range=all` 的总量来自每个密钥的累计计数器，
即使单密钥日志被截断（上限 1000 条）也保持准确。

**响应**：
```json
{
  "ok": true,
  "data": {
    "range": {"key": "7d", "from": "2026-09-20T16:00:00.000Z", "to": "2026-09-27T16:00:00.000Z", "grain": "day"},
    "totals": {"requests": 1, "promptTokens": 1000, "completionTokens": 500, "totalTokens": 1500, "creditsUsed": 2000},
    "breakdown": [{"day": "2026-09-27", "promptTokens": 1000, "completionTokens": 500, "creditsUsed": 2000, "requests": 1}],
    "summary": {"requests": 1, "promptTokens": 1000, "completionTokens": 500, "totalTokens": 1500, "creditsUsed": 2000},
    "series": [{"bucket": "2026-09-27", "requests": 1, "promptTokens": 1000, "completionTokens": 500, "totalTokens": 1500, "creditsUsed": 2000}],
    "byKey": [{"id": "<keyId>", "requests": 1, "totalTokens": 1500, "creditsUsed": 2000}],
    "byModel": [{"id": "deepseek-flash", "requests": 1, "totalTokens": 1500, "creditsUsed": 2000}],
    "byUser": [{"id": "<userId>", "requests": 1, "totalTokens": 1500, "creditsUsed": 2000}],
    "byProvider": [{"id": "<providerId>", "requests": 1, "totalTokens": 1500, "creditsUsed": 2000}],
    "truncatedKeys": 0
  }
}
```

> `totals` / `breakdown` 是 v1 兼容字段；管理台「用量」页使用 `summary` / `series` / `by*`。
> `truncatedKeys > 0` 表示有密钥的日志已达到每密钥上限，区间明细可能低估；
> `series` 的 `bucket` 在 `grain=day` 时为 `YYYY-MM-DD`，`grain=hour` 时为 `YYYY-MM-DDTHH`。
>
> 性能：区间明细只会从每个密钥的日志里读到区间下界为止（日志按时间倒序），
> 计算结果在 Next 数据缓存中保留约 30 秒，所以快速切换区间/刷新会命中缓存。
> 也就是说接口数据最长可能有约 30 秒的延迟。

#### `GET /api/user/usage`
参数同上（`range` / `from` / `to` / `tzOffset`），范围限定为当前登录账号的所有密钥。
响应字段为 `range` / `summary` / `series` / `byKey` / `byModel` / `byProvider` / `truncatedKeys`
（不含 `byUser`）。

对应的界面：用户 `/dashboard/usage`，管理员 `/admin/usage`（可按 `userId` 下钻）。

### 2.6 媒体端点（图片 / 视频 / 语音 / 音乐）

面向 OpenAI 形状的媒体接口，由**声明式适配协议**驱动（详见
[模型适配协议/README.md](../模型适配协议/README.md)）。鉴权与 `/v1/*` 一致（Bearer `sk-relay-…`）。

> **注意：** 媒体适配协议只维护中文版 ——
> [`docs/模型适配协议/README.md`](../模型适配协议/README.md)。

| 端点 | Body | 说明 |
| --- | --- | --- |
| `POST /v1/images/generations` | JSON `{model,prompt,n,size,response_format,seed?}` | 文生图，返回 `{created,data:[{url}|{b64_json}]}` |
| `POST /v1/images/edits` | multipart `image[,mask],prompt,model[,n,size]` | 图生图；上传的图统一转成 data URL 交给 spec |
| `POST /v1/videos/generations` | JSON `{model,prompt[,n,size]}` | 异步供应商在引擎内提交+轮询，客户端只收一次响应 |
| `POST /v1/audio/music` | JSON `{model,prompt[,n]}` | 音乐生成 |
| `POST /v1/audio/speech` | JSON `{model,input,voice?,speed?}` | TTS，**原样返回音频字节**（≤25MB 输入限制在 transcriptions） |
| `POST /v1/audio/transcriptions` | multipart `file,model[,language,prompt]` | STT，返回 `{text,id?}` |

管理端点（仅管理员）：

| 端点 | 说明 |
| --- | --- |
| `GET/POST /api/admin/media-providers` | 列出 / 新建媒体供应商（含 spec，保存时校验） |
| `GET/PATCH/DELETE /api/admin/media-providers/[id]` | 查看 / 改（含替换 spec）/ 删除 |

计费：`models[客户端模型名].pricePerItem × 成功件数`（`pricePerItem` 是**每件多少整数积分**，内部按 0.001 积分单位存储），
失败或被内容安全拦截不计费；媒体一律扣积分。用量行记录 `images` 与 `capability`。

模型发现：媒体模型只出现在 `GET /v1/models`（带 `relay` 元数据），**不出现在**
`GET /anthropic/v1/models`。

### 2.7 路由别名

`next.config.ts` 会把公开路径 rewrite 到内部的 `/api` 树，因此以下路径各自都能
通过**两**条路径访问：

| 公开路径 | 内部路径 |
| --- | --- |
| `/v1/*` | `/api/v1/*` |
| `/anthropic/*` | `/api/anthropic/*` |

`/api/admin/*`、`/api/user/*` 和 `/api/auth/*` 下的所有内容只能通过其 `/api/...`
路径访问。

### 2.8 上文未覆盖的其他路由

| 路由 | 用途 |
| --- | --- |
| `GET /api/config` | 欢迎页与文档页使用的公开运行时配置 |
| `POST /api/auth/change-password` | 自助修改密码（当前密码 + 新密码两次） |
| `GET /api/admin/settings` | 实例级设置 |
| `POST /api/admin/providers/probe` | 在保存 Provider 前探测上游端点 |
| `GET /api/admin/providers/[id]/models` | 拉取上游提供的模型列表 |
| `POST /api/admin/providers/[id]/test` | 测试与已保存 Provider 的连通性 |
| `GET /api/admin/users/[id]/delete-form` | 删除用户前的确认表单 |
| `GET /api/user/keys` · `GET/PATCH/DELETE /api/user/keys/[id]` | 用户自己的 Key 管理 |
| `GET /api/user/profile` | 已登录用户的个人资料 |

---

## 3. 中间件行为

### 3.1 `middleware.ts`

> **中间件不做任何鉴权。** 本文档早先的版本声称它会检查 session cookie 并重定向到
> `/login`；它从未这样做过。每个管理路由都在处理函数内部自己做 session 检查
> （`src/lib/auth/session.ts` 里的 `requireAdmin` / `requireUser`），session 缺失时
> 返回 `403 forbidden` —— 而不是 302。中间件只处理跨领域的请求关注点：

1. **路径归一化** —— 折叠重复的 `/v1/` 前缀，这是 OnlyOffice 的 OpenAI 模板在
   base URL 已经以 `/v1` 结尾时产生的情况（`/v1/v1/models` → `/v1/models`）。
2. **CORS** —— 应答预检 `OPTIONS` 请求，并为公开的 `/v1/*` 与 `/anthropic/*`
   路径打上 CORS 响应头，使浏览器端客户端能读取响应。
3. **`Cache-Control: no-store`** —— 作用于 `/api/auth*`、`/api/admin*` 和
   `/api/user*` 的响应，作为纵深防御（处理函数本身也会读取 cookie）。
4. **用量视图 cookie** —— 记住用量页面上最近使用的 range/scope/metric，并在 URL
   不带视图参数时重放它。
5. **未知 `/docs` slug** —— 重定向到文档索引。

公开资源与静态资源会提前返回。

### 3.2 错误处理
所有未捕获异常 → 500 `{ ok: false, error: { code: "internal_error" } }`。

> 这一条只适用于 **Session 面**。`/v1/*` 上的未捕获异常同样是 500，但响应体是
> `{ "error": { "message", "type": "server_error", "code": "internal_error" } }`。

---

## 4. 客户端配置示例

### OpenAI SDK 配置
```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'sk-relay-xxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  baseURL: 'https://your-domain.com/v1'
});
```

### Anthropic SDK 配置
```javascript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: 'sk-relay-xxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  // SDK 会请求 `${baseURL}/v1/messages`，所以这里只写到 /anthropic
  baseURL: 'https://your-domain.com/anthropic'
});
```

### 模型名从哪来

客户端能用的模型名 = 管理员在 Provider 的 `modelMapping` 里配置的**左列**。
用 `GET /v1/models` 可以看到完整列表，直接照抄即可。

这些名字只是别名，不代表上游厂商。请优先使用上游的真实模型名
（例如 `MiniMax-M3`），不要为了让某个客户端跑起来而写成
`claude-sonnet-4-6` 之类——这些名字会暴露给所有用户，也会进用量日志。
如果客户端支持指定模型（如 Claude Code 的 `ANTHROPIC_MODEL`），改客户端即可。

### Responses API 配置（Codex 等）

```toml
model_provider = "custom"
model = "MiniMax-M3"
wire_api = "responses"

[model_providers.custom]
name = "custom"
wire_api = "responses"
base_url = "https://your-domain.com/v1"
experimental_bearer_token = "sk-relay-xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```
