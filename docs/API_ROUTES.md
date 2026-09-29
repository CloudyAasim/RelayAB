# API 路由详细规范

> 路径相对于部署根域名（如 `https://relay.example.com`）。
> 所有 JSON 响应均遵循 `{ ok: true, data: ... }` 或 `{ ok: false, error: { code, message } }` 格式。

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

**错误码**：
| HTTP | code | 含义 |
|---|---|---|
| 401 | `unauthorized` | 缺少/无效 Bearer |
| 403 | `key_disabled` | Key 已禁用 |
| 403 | `key_expired` | Key 已过期 |
| 403 | `quota_exceeded_credits` | 积分不足 |
| 403 | `model_not_allowed` | 该 Key 不允许此模型 |
| 400 | `model_not_mapped` | 没有任何 Provider 支持此客户端模型 |
| 502 | `upstream_error` | 上游调用失败 |
| 500 | `internal_error` | 系统错误 |

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
> `https://api.minimax.cn/v1`，而 Anthropic 基址是 `https://api.minimax.cn/anthropic`，
> 两者不能混用。配置步骤见 [ARCHITECTURE.md §7.5](ARCHITECTURE.md#75-新增一条-anthropic-provider)。

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
查询参数：`?q=搜索&limit=50&cursor=xxx`

**响应**：
```json
{
  "ok": true,
  "data": {
    "users": [
      {"id": "01J...", "username": "alice", "role": "user", "disabled": false, "createdAt": "..."}
    ],
    "nextCursor": null
  }
}
```

#### `POST /api/admin/users`
**请求体**：
```json
{ "username": "bob", "password": "generate-or-supplied", "role": "user", "displayName": "Bob" }
```
若 `password` 为字符串 `"generate"` 或未提供 → 自动生成 16 位随机密码并在响应中返回一次。

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
更新 `displayName` / `role` / `disabled` 等字段。

#### `POST /api/admin/users/[id]/toggle`
启用或停用用户。推荐使用此端点而不是 PATCH，可防止与其他字段编辑冲突。

**请求体**：
```json
{ "disabled": true }
```

**响应**：
```json
{ "ok": true, "data": { "user": { ... } } }
```

**错误码**：`self_disable` — 禁止管理员停用自己。

#### `POST /api/admin/users/[id]/reset-password`
生成新随机密码，返回一次。

#### `DELETE /api/admin/users/[id]`
级联删除该用户所有 Key 与日志（软删除用户，禁用但保留数据）。

---

### 2.3 Key 管理

#### `GET /api/admin/keys?userId=xxx`
查询参数：`?userId=`（可选，按不过滤），`enabled=true`，`expired=false`

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
**响应**：返回 Provider 对象（**不含** apiKey 明文）。

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
[模型适配协议/README.md](./模型适配协议/README.md)）。鉴权与 `/v1/*` 一致（Bearer `sk-relay-…`）。

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

计费：`models[客户端模型名].pricePerItem × successCount`（每件积分，0 = 免费），
失败或被内容安全拦截不计费；媒体一律扣积分。用量行记录 `images` 与 `capability`。

模型发现：媒体模型只出现在 `GET /v1/models`（带 `relay` 元数据），**不出现在**
`GET /anthropic/v1/models`。

---

## 3. 中间件行为

### 3.1 `middleware.ts`
对所有 `/v1/*`、`/anthropic/*`、`/api/admin/*` 路由：

1. **/api/admin/***：检查 session cookie，未登录 → 302 `/login`。
2. **/v1/**、**/anthropic/***：不强制 session（这些用 API Key）。

### 3.2 错误处理
所有未捕获异常 → 500 `{ ok: false, error: { code: "internal_error" } }`。

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
