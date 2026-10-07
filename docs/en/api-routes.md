# API Route Reference

> Paths are relative to the deployment root domain (e.g. `https://relay.example.com`).
>
> **Two envelopes, split by surface. Do not mix them up.**
> - The **OpenAI-compatible surface** (`/v1/*`) uses OpenAI's own shapes: a failure is
>   `{ "error": { "message", "type", "code" } }`, and a success is an OpenAI object
>   (`{"object":"list","data":[…]}`, etc.). The `type` field is what lets a client
>   written against the OpenAI contract branch on `error.type`; given only `code` it
>   reads `undefined` and cannot tell one failure from another.
> - The **session surface** (`/api/*`) keeps this project's own shapes:
>   `{ ok: true, data: ... }` and `{ ok: false, error: { code, message } }`.
>
> `code` is unchanged on both surfaces — nothing was renamed, so a client already
> branching on it keeps working. `type` is additional information.

---

## 1. Public Proxy Endpoints

> Implementation note: these client-visible paths (`/v1/*`) are handled directly by Next.js Route Handlers.
> Two path prefixes are supported:
> - `/v1/*` (recommended, use this directly)
> - `/api/v1/*` (kept for backwards compatibility)

### 1.1 `POST /v1/chat/completions`

**Purpose**: OpenAI Chat Completions compatible endpoint.

**Request headers**:
```
Authorization: Bearer sk-relay-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
Content-Type: application/json
```

**Request body** (OpenAI standard):
```json
{
  "model": "gpt-4o-mini",
  "messages": [{"role": "user", "content": "Hi"}],
  "temperature": 0.7,
  "stream": false
}
```

**Response (non-streaming)**:
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

**Upstream behaviour**:
this endpoint always sends a request body in **Chat Completions format**, so it forwards
to a fixed upstream path, `<provider.baseUrl>/chat/completions`. A provider's
`upstreamFormat` does not change this path (that would send a Chat body to the
Responses endpoint). Providers with `upstreamFormat = "anthropic"` are excluded
from this endpoint.

**Error body** (applies to every `/v1/*` endpoint, including all the public proxy
ones below):
```json
{ "error": { "message": "积分 balance exhausted for this account",
             "type": "insufficient_quota",
             "code": "quota_exceeded_credits" } }
```
`type` is derived from the HTTP status rather than registered per code, so it cannot
drift away from the status. There is one exception, and it is why this is not pure
arithmetic: an exhausted pool is a 429, but it is not rate limiting and must not read
as such. A client that backs off and retries a 429 will retry forever against a pool
that is not coming back, so that case is `insufficient_quota`.

**Error codes**:

| HTTP | type | code | Meaning |
| --- | --- | --- | --- |
| 401 | `authentication_error` | `unauthorized` | Missing or invalid Bearer token |
| 403 | `permission_error` | `key_disabled` | The key is disabled |
| 403 | `permission_error` | `key_force_disabled` | The key was disabled by an admin; the user cannot re-enable it |
| 403 | `permission_error` | `key_expired` | The key has expired |
| 403 | `permission_error` | `model_not_allowed` | This key is not allowed to use this model |
| 400 | `invalid_request_error` | `model_not_mapped` | No provider supports this client model |
| 400 | `invalid_request_error` | `missing_model` | The request body has no `model` field |
| **429** | **`insufficient_quota`** | `quota_exceeded_credits` | The account's credit pool is exhausted |
| **429** | **`insufficient_quota`** | `quota_exceeded_tokens` | The account's token quota is exhausted (`quotaType: "tokens"`) |
| 502 | `server_error` | `upstream_error` | The upstream call failed |
| 500 | `server_error` | `internal_error` | System error |

> An exhausted pool is a **429, not a 403**. A 403 reads as "you are not allowed to",
> which is a different problem with a different remedy — a client handed one will never
> think to top up.

**Balance headers**: every `/v1/*` response carries the calling account's quota state.
```
x-ratelimit-limit: 500000          # the pool's size (0 = never granted, not "balance 0")
x-ratelimit-remaining: 487655      # remaining, floored at 0 — an overspent pool reads 0, never negative
x-ratelimit-unit: credits          # the unit; reads "tokens" when quotaType is tokens
```
They answer "how much is left **after the call you just made**", read at response time
so they cannot go stale. To ask "how much do I have" **before** making a call, use
`GET /v1/credits` below — the header only exists once you have made a request.

There is one pool, so there is one pair of numbers. OpenAI spells the unit into the
header name (`-requests` / `-tokens`) because it enforces two independent limits at
once; copying that here would pay for a problem this deployment does not have, and a
client would still have to know which header to look at, so `x-ratelimit-unit` says it
plainly instead.

---

### 1.1.1 `GET /v1/credits`

**Purpose**: read the calling account's quota pool.

**Auth**: `Authorization: Bearer sk-relay-…` — the same key as every other `/v1/*`
endpoint. **Any valid key may ask.** The pool belongs to the account, not to the key, so
there is no "which kind of key may read the balance" question to answer (MiniMax has to
distinguish a Subscription Key from a pay-as-you-go key; it costs us nothing).

**Response**:
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

| Field | Meaning |
| --- | --- |
| `is_available` | **Whether there is anything left to spend** — directly actionable |
| `unit` | `credits` or `tokens`; an account can be metered in tokens, and a bare figure does not say which |
| `scale` | Stored units per `unit`, so a client formats correctly without hardcoding it |
| `limit` | The pool's size; `0` means **never granted**, not a balance of zero |
| `used` | Consumed so far |
| `remaining` | Remaining, floored at 0 — an overspent pool reads 0, never negative |

**Design notes**:

- **`is_available` is the reason this endpoint exists.** Without it a client has to
  threshold `remaining` itself and reason about a unit it has to know — handing back an
  answer the server already has. DeepSeek's `GET /user/balance` returns the same field
  for the same reason.
- **An exhausted pool is not a reason to refuse.** This endpoint skips the quota check
  (`skipQuotaCheck`): asking the balance spends nothing, so an empty pool must not lock
  the caller out — otherwise the endpoint is unreachable in the one state it exists to
  report. The other checks still apply: a disabled or expired key reads nothing either.
- **No `reset_time`.** MiniMax's quota endpoint carries reset times because its quota is
  a 5-hour rolling window plus a weekly one. This deployment's pool is a single
  allocation with no window, so there is no reset time to report; a field that is always
  null would be ceremony.
- **Not an array.** DeepSeek returns `balance_infos` as an array because it holds CNY and
  USD. There is one pool here, and the two `quotaType` values are two ways of metering
  that same pool, not two balances.
- **The figures are a snapshot.** A concurrent request can spend from the same pool
  between two reads. That is inherent to asking about a shared account, not something
  this endpoint could arrange away.

#### Extractor template for tools like CCSwitch

CCSwitch describes "where to ask and how to read the answer" as a small template.
Three things differ from the DeepSeek one, and copying it verbatim reads nothing:

```js
({
  request: {
    url: "{{baseUrl}}/v1/credits",
    method: "GET",
    headers: { "Authorization": "Bearer {{apiKey}}" }
  },
  extractor: function(response) {
    var scale = typeof response.scale === "number" ? response.scale : 1000;
    var has = typeof response.remaining === "number";
    return {
      isValid: has,
      remaining: has ? response.remaining / scale : null,
      unit: response.unit || "credits"
    };
  }
})
```

- **`isValid` means "was a balance read", not "is there money left".** An exhausted
  pool is still a valid read whose `remaining` is 0; reporting it as invalid sends
  people to check their key when the fix is a top-up. The DeepSeek template's
  `is_available || true` is always true, so it never reports anything — it is not a
  check.
- **`remaining` is an integer count of 0.001-credit units.** The template above
  divides by `scale` and returns a figure a person can read; if the tool compares or
  accumulates it and wants the raw integer, drop the division — but whichever you pick
  has to agree with `unit`.
- **Do not put `/v1` in `baseUrl`.** The convention is base = host root, version
  carried by the path; if the tool's `baseUrl` is already `…/v1`, change this to
  `{{baseUrl}}/credits`, or it becomes `/v1/v1/credits`.

---

### 1.2 `POST /v1/responses`

**Purpose**: OpenAI Responses API compatible endpoint.

**Request headers**:
```
Authorization: Bearer sk-relay-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
Content-Type: application/json
```

**Request body** (OpenAI standard):
```json
{
  "model": "gpt-4o-mini",
  "input": "Hello, how are you?",
  "stream": false
}
```

Or use the array form:
```json
{
  "model": "gpt-4o-mini",
  "input": [
    {"type": "input_text", "content": "Hello"}
  ],
  "stream": false
}
```

**Response**:
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

**Upstream behaviour and protocol conversion**:
- Provider with `upstreamFormat = "responses"` → forwarded as-is to `<baseUrl>/responses`.
- Provider with `upstreamFormat = "chat"` → converted to a Chat request body and sent to
  `<baseUrl>/chat/completions`, then the Chat response is converted back into the
  Responses structure above.
- Provider with `upstreamFormat = "anthropic"` (or `kind = "anthropic"`) → converted to
  an Anthropic Messages request and sent to `<baseUrl>/v1/messages`, then converted back
  into the Responses structure.

**Usage field compatibility**: different upstreams name their usage fields differently.
Chat Completions uses `prompt_tokens` / `completion_tokens`; Responses and Anthropic use
`input_tokens` / `output_tokens`. The relay understands both and records them
internally as `promptTokens` / `completionTokens`.

---

### 1.3 `GET /v1/models`

**Purpose**: returns the list of models this API key can reach.

**Response**:
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

**Purpose**: Anthropic Messages compatible endpoint.

**Request headers** (both authentication methods are supported):
```
x-api-key: sk-relay-xxx            # used by the Anthropic SDK / Claude Code
# or
Authorization: Bearer sk-relay-xxx # OpenAI-style clients

anthropic-version: 2023-06-01
Content-Type: application/json
```

**Request body** (Anthropic standard):
```json
{
  "model": "claude-3-5-sonnet-20241022",
  "max_tokens": 1024,
  "messages": [{"role": "user", "content": "Hi"}]
}
```

**Response**: the standard Anthropic Messages response format.

**Provider selection**: this endpoint only picks providers speaking the Anthropic
protocol, trying them in the order
`upstreamFormat === "anthropic"` → `kind === "anthropic"` → `kind === "custom-openai"`,
and within each tier it takes the first one by ascending `priority`. The request is
forwarded to `<baseUrl>/v1/messages`.

> Note that `baseUrl` must be the upstream's **Anthropic** base URL. For example,
> MiniMax's OpenAI base URL is `https://api.minimaxi.com/v1` while its Anthropic base URL is
> `https://api.minimaxi.com/anthropic` — the two cannot be mixed. See
> [architecture.md §7.5](architecture.md#75-adding-an-anthropic-provider) for the
> configuration steps.

---

### 1.5 `GET /healthz`

**Purpose**: health check, no authentication required.

**Response**:
```json
{ "ok": true, "data": { "status": "ok", "version": "0.1.0" } }
```

---

## 2. Admin API (session authentication)

> Every `/api/admin/*` route requires `session.userId` to be present and
> `session.role === "admin"`. Unauthorized requests get 401 / 403.

### 2.1 Authentication

#### `POST /api/auth/login`
**Request body**:
```json
{ "username": "alice", "password": "secret" }
```
**Response**:
```json
{ "ok": true, "data": { "user": { "id": "...", "username": "alice", "role": "user" } } }
```
Sets the `relay_session` cookie.

#### `POST /api/auth/logout`
Clears the cookie.

#### `GET /api/auth/me`
**Response**:
```json
{ "ok": true, "data": { "user": { "id": "...", "username": "alice", "role": "user" } } }
```

---

### 2.2 User Management

#### `GET /api/admin/users`
Query parameters: `?limit=50&cursor=xxx`

> **There is no `q` search parameter.** The route's own JSDoc header still advertises
> `?q=`, but the handler only reads `limit` and `cursor` — a `q` is silently ignored.
> Filtering is done client-side in the admin panel.

**Response**:
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
**Request body**:
```json
{ "username": "bob", "password": "optional-supplied-value", "role": "user", "displayName": "Bob" }
```

> ⚠️ **Omit `password` entirely — do not send the string `"generate"`.**
> Auto-generation triggers only when the field is **absent** (`password === undefined`).
> Any string you do send is used **verbatim as the password**, so sending
> `"generate"` would set every such user's password to the literal word `generate`.

When `password` is omitted, a random password is generated and returned once:

**Response**:
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
Body: `{ displayName?, role?, quotaType?, quotaLimit?, quotaUsed?, maxActiveKeys?, allowedModels? }`

> **There is no `disabled` field on a user.** Disabling a user does not exist; the
> admin panel offers Reset Password / Edit Display Name / Delete only. What you can
> do instead is set `quotaLimit: 0` to cut a user off, or delete them.

#### `POST /api/admin/users/[id]/reset-password`
Generates a new random password and returns it once.

#### `DELETE /api/admin/users/[id]`
Cascading delete of every key and log belonging to that user.

---

### 2.3 Key Management

#### `GET /api/admin/keys?userId=xxx`
Query parameters: `?userId=` (optional, omit to skip filtering) and `enabledOnly=true`
(returns only enabled keys).

> The parameters are `userId` and `enabledOnly` — **not** `enabled` and **not**
> `expired`. Neither of those is read, so passing them silently returns every key.

**Response**:
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

> **Key state**:
> - `enabled: true` — active
> - `enabled: false` — disabled (the user can re-enable it themselves)
> - `forceDisabled: true` — force-disabled (an admin action; the user cannot re-enable it)

#### `POST /api/admin/keys`
**Request body**:
```json
{
  "userId": "01J...",
  "label": "Macbook"
}
```

> A key is enabled by default after creation. The key's quota (credits / token allowance)
> is allocated by the admin to the user; the key itself stores no quota information.

**Response**:
```json
{
  "ok": true,
  "data": {
    "key": { /* the same object as in GET */ },
    "plainKey": "sk-relay-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
  }
}
```

#### `PATCH /api/admin/keys/[id]`
Updates `label` / `expiresAt` / `allowedModels` / `enabled`.

#### `POST /api/admin/keys/[id]/toggle`
```json
{ "enabled": true }
```
Or to force-disable:
```json
{ "enabled": false, "forceDisabled": true }
```

#### `DELETE /api/admin/keys/[id]`

---

### 2.4 Provider Management

#### `GET /api/admin/providers`
#### `POST /api/admin/providers`
```json
{
  "name": "OpenAI primary",
  "kind": "openai",
  "baseUrl": null,
  "apiKey": "sk-...",
  "modelMapping": {"gpt-4o-mini": "gpt-4o-mini-2024-07-18"},
  "enabled": true,
  "priority": 1
}
```
**Response**: `{ "ok": true, "data": { "provider": { … } } }` — the provider object
**without** the apiKey in plaintext. (`GET /api/admin/providers` returns
`data.providers`, an array, in the same envelope.)

#### `PATCH /api/admin/providers/[id]`
#### `DELETE /api/admin/providers/[id]`

---

### 2.5 Usage Statistics

#### `GET /api/admin/usage`
Query parameters:
- `range=today|7d|30d|90d|all|custom` (default `all`)
- `from` / `to`: local dates `YYYY-MM-DD` for `range=custom` (both ends inclusive)
- `userId`: restrict to a single account
- `tzOffset`: timezone offset in minutes, default `480` (GMT+8)

Admins can view site-wide usage; the totals for `range=all` come from each key's
cumulative counters, so they stay accurate even when an individual key's logs are
truncated (cap of 1000 entries).

**Response**:
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

> `totals` / `breakdown` are v1 compatibility fields; the admin panel's **Usage** page uses
> `summary` / `series` / `by*`.
> `truncatedKeys > 0` means some keys have hit the per-key log cap, so the range breakdown
> may underestimate; `bucket` in `series` is `YYYY-MM-DD` when `grain=day` and
> `YYYY-MM-DDTHH` when `grain=hour`.
>
> Performance: the range breakdown only reads each key's logs down to the range's lower
> bound (logs are stored newest-first), and the computed result is retained in the Next data
> cache for roughly 30 seconds, so quickly switching ranges or refreshing hits the cache.
> In other words, the data this endpoint returns can lag by up to about 30 seconds.

#### `GET /api/user/usage`
Same parameters (`range` / `from` / `to` / `tzOffset`), scoped to all keys of the currently
logged-in account. The response fields are `range` / `summary` / `series` / `byKey` /
`byModel` / `byProvider` / `truncatedKeys` (no `byUser`).

Matching UI: `/dashboard/usage` for users, `/admin/usage` for admins (with drill-down by
`userId`).

### 2.6 Media Endpoints (image / video / speech / music)

OpenAI-shaped media endpoints, driven by a **declarative adapter protocol** (see
[模型适配协议/README.md)](../模型适配协议/README.md)). Authentication is the same as for
`/v1/*` (Bearer `sk-relay-…`).

> **Note:** the media adapter protocol is maintained in Chinese only —
> [`docs/模型适配协议/README.md`)](../模型适配协议/README.md).

| Endpoint | Body | Notes |
| --- | --- | --- |
| `POST /v1/images/generations` | JSON `{model,prompt,n,size,response_format,seed?}` | Text-to-image, returns `{created,data:[{url}|{b64_json}]}` |
| `POST /v1/images/edits` | multipart `image[,mask],prompt,model[,n,size]` | Image-to-image; uploaded images are converted to data URLs and handed to the spec |
| `POST /v1/videos/generations` | JSON `{model,prompt[,n,size]}` | Async upstreams are submitted to and polled inside the engine; the client only receives one response |
| `POST /v1/audio/music` | JSON `{model,prompt[,n]}` | Music generation |
| `POST /v1/audio/speech` | JSON `{model,input,voice?,speed?}` | TTS, **returns the audio bytes verbatim** (the ≤25MB input limit applies to transcriptions) |
| `POST /v1/audio/transcriptions` | multipart `file,model[,language,prompt]` | STT, returns `{text,id?}` |

Admin endpoints (admin only):

| Endpoint | Notes |
| --- | --- |
| `GET/POST /api/admin/media-providers` | List / create media providers (including the spec, validated on save) |
| `GET/PATCH/DELETE /api/admin/media-providers/[id]` | View / update (including replacing the spec) / delete |

Billing: `models[client model name].pricePerItem × successful item count` (`pricePerItem`
is **how many whole credits each item costs**, stored internally in units of 0.001
credits). Failures and content-safety rejections are not billed; media always deducts
credits. Usage rows record `images` and `capability`.

Model discovery: media models only appear in `GET /v1/models` (with `relay` metadata),
and **never** appear in `GET /anthropic/v1/models`.

### 2.7 Route aliases

`next.config.ts` rewrites the public surface onto the internal `/api` tree, so
each of these is reachable under **two** paths:

| Public path | Internal path |
| --- | --- |
| `/v1/*` | `/api/v1/*` |
| `/anthropic/*` | `/api/anthropic/*` |

Everything under `/api/admin/*`, `/api/user/*` and `/api/auth/*` is reachable only
at its `/api/...` path.

### 2.8 Additional routes not covered above

| Route | Purpose |
| --- | --- |
| `GET /api/config` | Public runtime configuration for the welcome page and docs page |
| `POST /api/auth/change-password` | Self-service password change (current + new twice) |
| `GET /api/admin/settings` | Instance-wide settings |
| `POST /api/admin/providers/probe` | Probe an upstream endpoint before saving a provider |
| `GET /api/admin/providers/[id]/models` | Fetch the model list an upstream offers |
| `POST /api/admin/providers/[id]/test` | Test connectivity to a saved provider |
| `GET /api/admin/users/[id]/delete-form` | Confirmation form before deleting a user |
| `GET /api/user/keys` · `GET/PATCH/DELETE /api/user/keys/[id]` | The user's own key management |
| `GET /api/user/profile` | The signed-in user's own profile |

---

## 3. Middleware Behaviour

### 3.1 `middleware.ts`

> **The middleware does not authenticate anything.** An earlier version of this
> document claimed it checked the session cookie and redirected to `/login`; it
> never has. Every admin route does its own session check inside the handler
> (`requireAdmin` / `requireUser` in `src/lib/auth/session.ts`) and answers
> `403 forbidden` — not a 302 — when the session is missing. The middleware only
> handles cross-cutting request concerns:

1. **Path normalisation** — collapses a duplicated `/v1/` prefix, which is what
   OnlyOffice's OpenAI template produces when a base URL already ends in `/v1`
   (`/v1/v1/models` → `/v1/models`).
2. **CORS** — answers preflight `OPTIONS` requests and stamps CORS headers on the
   public `/v1/*` and `/anthropic/*` surface, so browser-hosted clients can read
   responses.
3. **`Cache-Control: no-store`** on `/api/auth*`, `/api/admin*` and `/api/user*`
   responses, as defence in depth (the handlers read cookies too).
4. **Usage-view cookie** — remembers the last-used range/scope/metric on the usage
   screens and replays it when the URL carries no view parameters.
5. **Unknown `/docs` slugs** — redirected to the docs index.

Public and static assets return early.

### 3.2 Error Handling
Any uncaught exception → 500 `{ ok: false, error: { code: "internal_error" } }`.

> This applies to the **session surface** only. An uncaught exception on `/v1/*` is
> also a 500, but the body is
> `{ "error": { "message", "type": "server_error", "code": "internal_error" } }`.

---

## 4. Client Configuration Examples

### OpenAI SDK Configuration
```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'sk-relay-xxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  baseURL: 'https://your-domain.com/v1'
});
```

### Anthropic SDK Configuration
```javascript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: 'sk-relay-xxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  // The SDK requests `${baseURL}/v1/messages`, so this only goes up to /anthropic
  baseURL: 'https://your-domain.com/anthropic'
});
```

### Where Model Names Come From

The model names a client can use are the **left-hand column** of the `modelMapping`
configured by the admin on a provider. `GET /v1/models` shows the full list — just copy
from it.

These names are only aliases and do not indicate the upstream vendor. Prefer the real
upstream model name (for example `minimax-M3`) over writing something like
`claude-sonnet-4-6` just to get a particular client running — these names are exposed to
all users and end up in usage logs. If the client lets you pick the model (such as Claude
Code's `ANTHROPIC_MODEL`), change the client instead.

### Responses API Configuration (Codex, etc.)

```toml
model_provider = "custom"
model = "minimax-M3"
wire_api = "responses"

[model_providers.custom]
name = "custom"
wire_api = "responses"
base_url = "https://your-domain.com/v1"
experimental_bearer_token = "sk-relay-xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```
