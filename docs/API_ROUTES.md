# API 路由详细规范

> 路径相对于部署根域名（如 `https://relay.example.com`）。
> 所有 JSON 响应均遵循 `{ ok: true, data: ... }` 或 `{ ok: false, error: { code, message } }` 格式。

---

## 1. 公开代理接口

> 实现说明：这些客户端可见路径（`/v1/*`、`/anthropic/*`）由
> `next.config.ts` 的 `rewrites` 映射到 `src/app/api/v1/*`、
> `src/app/api/anthropic/*` 下的 Route Handler，因此对客户端而言路径与
> OpenAI / Anthropic 官方一致。

### 1.1 `POST /v1/chat/completions`

**用途**：OpenAI Chat Completions 兼容端点。

**请求头**：
```
Authorization: Bearer sk-relay-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
Content-Type: application/json
x-vercel-protection-bypass: <可选，仅部署保护开启时>
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
  "ok": true,
  "data": {
    "id": "chatcmpl-xxx",
    "object": "chat.completion",
    "created": 1695273600,
    "model": "gpt-4o-mini",
    "choices": [{"index": 0, "message": {"role": "assistant", "content": "..."}, "finish_reason": "stop"}],
    "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
  }
}
```

**响应（流式 SSE）**：
```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hi"}}]}
data: ...
data: [DONE]
```

**错误码**：
| HTTP | code | 含义 |
|---|---|---|
| 401 | `unauthorized` | 缺少/无效 Bearer |
| 403 | `key_disabled` | Key 已禁用 |
| 403 | `key_expired` | Key 已过期 |
| 403 | `quota_exceeded_credits` | 积分不足 |
| 403 | `quota_exceeded_tokens` | Token 额度耗尽 |
| 403 | `model_not_allowed` | 该 Key 不允许此模型 |
| 400 | `model_not_mapped` | 没有任何 Provider 支持此客户端模型 |
| 502 | `upstream_error` | 上游调用失败 |
| 500 | `internal_error` | 系统错误 |

---

### 1.2 `GET /v1/models`

**用途**：返回该 API Key 可访问的模型列表（OpenAI `/v1/models` 兼容）。

**响应**：
```json
{
  "ok": true,
  "data": {
    "object": "list",
    "data": [
      {"id": "gpt-4o-mini", "object": "model", "created": 1695273600, "owned_by": "openai"},
      {"id": "claude-3-5-sonnet", "object": "model", "created": 1695273600, "owned_by": "anthropic"}
    ]
  }
}
```

---

### 1.3 `POST /anthropic/v1/messages`

**用途**：Anthropic Messages 兼容端点。

**请求头**：
```
Authorization: Bearer sk-relay-xxx
Content-Type: application/json
anthropic-version: 2023-06-01
```

**请求体**（Anthropic 标准）：
```json
{
  "model": "claude-3-5-sonnet-20241022",
  "max_tokens": 1024,
  "messages": [{"role": "user", "content": "Hi"}]
}
```

**响应**：标准 Anthropic Messages 响应格式，**但外层包一层** RelayAB 包装：
```json
{
  "ok": true,
  "data": {
    "id": "msg_xxx",
    "type": "message",
    "role": "assistant",
    "content": [{"type": "text", "text": "..."}],
    "model": "claude-3-5-sonnet-20241022",
    "stop_reason": "end_turn",
    "usage": {"input_tokens": 10, "output_tokens": 20}
  }
}
```

**流式**：返回标准 Anthropic SSE（`event: message_start` 等）。

---

### 1.4 `GET /healthz`

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
    "generatedPassword": "Ab12-cd34-EF56-gh78"   // 仅创建时返回
  }
}
```

#### `PATCH /api/admin/users/[id]`
更新 `displayName` / `role` / `disabled`。

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
        "quotaType": "credits",
        "quotaLimit": 500000,
        "quotaUsed": 1234,
        "expiresAt": "2026-12-31T23:59:59.000Z",
        "enabled": true,
        "allowedModels": ["gpt-4o-mini"],
        "createdAt": "...",
        "lastUsedAt": null
      }
    ]
  }
}
```

#### `POST /api/admin/keys`
**请求体**：
```json
{
  "userId": "01J...",
  "label": "Macbook",
  "quotaType": "credits",
  "quotaLimit": 500000,
  "expiresAt": "2026-12-31T23:59:59.000Z",
  "allowedModels": ["gpt-4o-mini", "gpt-4o"]
}
```

> **积分单位**：`credits` 配额下，`quotaLimit` / `quotaUsed` 都是**积分**，
> 以 0.001 积分为整数单位存储（上例 `500000` = 500 积分）。
> 管理后台表单直接填写积分，由前端换算成存储单位。
**响应**：
```json
{
  "ok": true,
  "data": {
    "key": { /* 同 GET 中的对象，但包含明文 key，仅此一次 */ },
    "plainKey": "sk-relay-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
  }
}
```

#### `PATCH /api/admin/keys/[id]`
更新 `label` / `quotaLimit` / `expiresAt` / `allowedModels` / `enabled`。

#### `POST /api/admin/keys/[id]/toggle`
请求体：`{ "enabled": true }`，立即生效。

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
查询参数：`?from=2026-09-01&to=2026-09-30&groupBy=user|provider|model|day`

**响应**：
```json
{
  "ok": true,
  "data": {
    "totals": {
      "promptTokens": 12345,
      "completionTokens": 6789,
      "totalTokens": 19134,
      "creditsUsed": 234000
    },
    "breakdown": [
      {"key": "user:01J...", "promptTokens": 100, "completionTokens": 50, "totalTokens": 150, "creditsUsed": 5000},
      ...
    ]
  }
}
```

> `creditsUsed` 同样是积分，以 0.001 积分为单位：`234000` = 234 积分。

---

## 3. 嵌入式 Mock（仅 dev）

### 3.1 启用条件
- `process.env.EMULATE_VERCEL_LOCAL === "1"`
- `process.env.NODE_ENV !== "production"`

### 3.2 `ANY /api/_emu/vercel/[...path]`
透传到 `@emulators/vercel` 的 Hono 路由器。

**示例**：
```bash
# 创建项目
curl -X POST http://localhost:3000/api/_emu/vercel/v11/projects \
  -H "Authorization: Bearer test_token_admin" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app"}'

# 列出项目
curl http://localhost:3000/api/_emu/vercel/v10/projects \
  -H "Authorization: Bearer test_token_admin"
```

---

## 4. 中间件行为

### 4.1 `middleware.ts`
对所有 `/v1/*`、`/anthropic/*`、`/api/admin/*` 路由：

1. **保护绕过**：若 `x-vercel-protection-bypass` 缺失且 `VERCEL_PROTECTION_BYPASS` 已设置，
   自动注入该 header（便于服务端内部回环调用）。
2. **/api/admin/***：检查 session cookie，未登录 → 302 `/login`。
3. **/v1/**、**/anthropic/***：不强制 session（这些用 API Key）。

### 4.2 错误处理
所有未捕获异常 → 500 `{ ok: false, error: { code: "internal_error" } }`，并记录到 Sentry（可选，v1 跳过）。
