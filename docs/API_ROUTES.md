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
  "model": "gpt-4o-mini",
  "output": [
    {"type": "message", "id": "msg_xxx", "content": [{"type": "output_text", "text": "..."}]}
  ],
  "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
}
```

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

**响应**：标准 Anthropic Messages 响应格式。

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
      {"key": "user:01J...", "promptTokens": 100, "completionTokens": 50, "totalTokens": 150, "creditsUsed": 5000}
    ]
  }
}
```

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
  baseURL: 'https://your-domain.com/anthropic/v1'
});
```
