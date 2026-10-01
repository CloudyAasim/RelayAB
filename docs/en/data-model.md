# Data Model

> All data is persisted in a **Redis-protocol database**. Two transports are
> supported:
> - **A local Valkey / Redis** (the self-hosting default) — set `REDIS_URL`, and
>   ioredis connects over TCP
> - **Hosted Upstash** — set `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
>   and it is spoken to over REST
>
> Key structure and field definitions are identical across both, so switching
> backends requires no data migration. `REDIS_URL` takes precedence when present.
> All keys share the `relay:` prefix, so the databases can be split by prefix later if needed.
> The types are defined in [`src/lib/db/types.ts`](../../src/lib/db/types.ts); this document is a summary.

---

## 1. User

**Keys**:
- `relay:user:{userId}` — Hash
- `relay:user:by-username:{username}` — String (reverse lookup to userId)

**Fields**:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (ULID) | Primary key |
| `username` | string (unique) | Login name, 3–32 characters |
| `passwordHash` | string (bcrypt) | bcryptjs hash, work factor 12 |
| `role` | `"admin" \| "user"` | Admins can access `/admin/*` |
| `displayName` | string | Shown in the UI |
| `timezone` | `"utc" \| "shanghai"` | Per-user display timezone, optional. Absent = the default (`shanghai`). Only these two are supported |
| `createdAt` | ISO string | |
| `updatedAt` | ISO string | |
| `lastLoginAt` | ISO string \| null | |
| `disabled` | 0 \| 1 | Soft-delete flag |
| `quotaType` | `"credits" \| "tokens"` | Unit of the account's credits pool |
| `quotaLimit` | int | Size of the account's credits pool (for `credits`, stored as an integer in units of 0.001 credits). `0` = not allocated, every call is rejected |
| `quotaUsed` | int | Amount already consumed by the account, in the same unit as `quotaLimit` |
| `maxActiveKeys` | int | Upper bound on simultaneously enabled keys (0 = no limit) |
| `allowedModels` | string[] | Whitelist of models the account may access (empty = all) |

> **Credits belong to the account, not to the key.** This is the single most
> important modeling decision in the whole gateway:
>
> ```
> An admin gives Alice 1000 credits
>   Alice creates key A / key B / key C
>   Any call made through A, B or C deducts from the same 1000
>   Once the 1000 is gone → all three keys stop working
> ```
>
> If credits hung off the key, every extra key a user created would silently hand
> them another quota — which is not what "give Alice 1000 credits" means.
> `ApiKey` therefore carries **no** quota field at all.
>
> `allowedModels` belongs to the account as well; a key may only **narrow** it
> (see §2 below), never widen it. Admins configure all three on `/admin/users`;
> users cannot change them themselves.

**Example**:
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

## 2. Customer API Key (ApiKey)

**Keys**:
- `relay:apikey:{keyId}` — Hash
- `relay:apikey:hash:{sha256(key)}` — String (keyId, for the reverse lookup during Bearer authentication)
- `relay:apikey:by-user:{userId}` — Set (list of keyIds)
- `relay:apikey:active:{userId}` — Set (keyIds that are enabled and not expired, for fast list queries)

**Fields**:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (ULID) | Primary key |
| `userId` | string | Owning user |
| `label` | string | The name the user or an admin gave this key |
| `keyHash` | string | sha256(plaintext key), **plaintext is never stored** |
| `keyPrefix` | string | First 12 characters of the plaintext + `...` + last 4 characters, for display only |
| `expiresAt` | ISO string \| null | Expiry time |
| `enabled` | 0 \| 1 | Enabled flag |
| `forceDisabled` | 0 \| 1 | Set by an admin. Once set, the user **cannot** re-enable the key themselves; the API answers `key_force_disabled` |
| `allowedModels` | string[] (CSV) | Models this key **additionally** allows. Intersected with the account whitelist — it can only narrow, never widen (empty = no extra restriction, the account whitelist still applies) |
| `createdAt` | ISO string | |
| `lastUsedAt` | ISO string \| null | |

> A key is a **credential**, not a wallet. It carries only identity (who is
> calling) and light policy (enabled / expired / optional model narrowing); the
> quota pool lives on the owning account. That is why there are **no**
> `quotaType` / `quotaLimit` / `quotaUsed` fields here.

**Example**:
```json
{
  "id": "01J7R5K8W6Y8X8X8X8X8X8X8X8",
  "userId": "01J7R5K8W6X8X8X8X8X8X8X8X8",
  "label": "Alice's Macbook",
  "keyHash": "a3f2c9...",
  "keyPrefix": "sk-relay-X3K...m2pQ",
  "expiresAt": "2026-12-31T23:59:59.000Z",
  "enabled": "1",
  "allowedModels": "gpt-4o-mini,gpt-4o,claude-3-5-sonnet",
  "createdAt": "2026-09-21T08:00:00.000Z",
  "lastUsedAt": null
}
```

**Validation logic** (`checkKeyStatus` in `lib/auth/apikey.ts`):

```ts
// Order is priority; user is the owning account of the key and is required.
function checkKeyStatus({ key, user, requestedModel }): KeyValidationResult {
  // 1. Admin override first — a force-disabled key must never serve traffic,
  //    even when `enabled` is still true.
  if (key.forceDisabled) return { ok: false, reason: "key_force_disabled" };

  // 2. The credential itself
  if (!key.enabled) return { ok: false, reason: "key_disabled" };
  if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now())
    return { ok: false, reason: "key_expired" };

  // 3. Account credit/token pool — note this reads user, not key.
  //    There is no account-level disable: a user cannot be turned off, so there
  //    is no `user_disabled` reason. Setting quotaLimit to 0 is what stops calls.
  if (user.quotaUsed >= user.quotaLimit) {
    return {
      ok: false,
      reason: user.quotaType === "tokens"
        ? "quota_exceeded_tokens"
        : "quota_exceeded_credits",
    };
  }

  // 4. Model permission = account whitelist ∩ key whitelist (an empty list imposes no extra restriction at that layer)
  const ownerAllows = user.allowedModels.length === 0
    || user.allowedModels.includes(requestedModel);
  const keyAllows = key.allowedModels.length === 0
    || key.allowedModels.includes(requestedModel);
  if (!ownerAllows || !keyAllows) return { ok: false, reason: "model_not_allowed" };

  return { ok: true, reason: "ok" };
}
```

> Step 2 is where "creating more keys does not buy more quota" is actually
> enforced: whichever key carried the request, what is read is the same
> `user.quotaUsed / user.quotaLimit`.
> `quotaLimit === 0` (not allocated) is treated as exceeded, i.e. a brand-new
> account cannot call anything by default — it is not read as "unlimited".

---

## 3. Upstream Provider (Provider)

**Key**: `relay:provider:{providerId}` — Hash

**Fields**:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (ULID) | Primary key |
| `name` | string | Name shown to admins |
| `kind` | `"openai" \| "anthropic" \| "custom-openai" \| "azure"` | Protocol family. `anthropic` = this provider speaks the Anthropic Messages protocol |
| `baseUrl` | string \| null | Upstream root address; the proxy appends endpoint paths to it |
| `encryptedApiKey` | string (base64) | Upstream key encrypted with AES-256-GCM |
| `modelMapping` | JSON string | Client model → actual upstream model. An identity mapping is recommended |
| `modelConfigs` | JSON string | Optional per-model configuration — see §3.1 |
| `headers` | JSON string | Optional extra request headers (e.g. Azure's `api-version`) |
| `upstreamFormat` | `"responses" \| "chat" \| "anthropic"` | Native upstream protocol, default `responses`. **Legacy read-only value**: it describes the OpenAI-side format; which surfaces a provider actually serves is decided by the two `*Enabled` flags below |
| `openaiEnabled` | 0 \| 1 | Whether this provider serves the OpenAI-facing endpoints (`/v1/chat/completions`, `/v1/responses`). Default `true` |
| `anthropicEnabled` | 0 \| 1 | Whether this provider **also** serves the Anthropic Messages surface (`/anthropic/v1/messages`, `/v1/messages`). Default `false` |
| `anthropicBaseUrl` | string \| null | Base URL for the Anthropic face. `null` = derive it from `baseUrl` (one trailing `/v1` is stripped). Set it explicitly when the vendor's Anthropic endpoint is a sub-path, e.g. `https://api.deepseek.com/anthropic` |
| `enabled` | 0 \| 1 | |
| `priority` | number | Routing priority (lower number wins) |
| `createdAt` | ISO string | |
| `updatedAt` | ISO string | |

> #### ⚠️ A provider row carries **two protocol faces**
>
> The two faces **share** the API key, `modelMapping` and `modelConfigs` — those
> are identical for a given vendor. So configuring the same vendor twice (once per
> protocol) is **no longer necessary**; only the protocol and, usually, the base
> URL differ. Earlier versions of this table described a single-face model where
> `kind` and `upstreamFormat` decided everything; that is the legacy shape.
>
> | Field | Decides |
> | --- | --- |
> | `openaiEnabled` | whether the OpenAI-side endpoints use this provider |
> | `anthropicEnabled` | whether the Anthropic Messages surface uses this provider |
> | `anthropicBaseUrl` | the Anthropic-side base URL (derived from `baseUrl` when null) |
> | `upstreamFormat` | the OpenAI-side native format — `responses` (native) or `chat` |
>
> See [architecture.md §7](architecture.md#7-upstream-providers-and-model-mapping)
> for how the faces interact during routing.

### 3.1 ModelConfig

`modelConfigs` maps a client model name to a `ModelConfig`:

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `upstreamId` | string | — | The upstream model ID |
| `clientId` | string | — | The client-facing alias |
| `displayName` | string | — | Optional display name |
| `contextLength` | positive int | `128000` | Context window in input tokens |
| `maxOutputTokens` | positive int | `8192` | Maximum output tokens |
| `inputCost` | number ≥ 0 | `0` | Credits per 1M input tokens |
| `outputCost` | number ≥ 0 | `0` | Credits per 1M output tokens |
| `enabled` | boolean | `true` | Whether the model is offered |

> `contextLength`, `maxOutputTokens` and `enabled` are currently **recorded only** —
> they are neither validated against requests nor used to truncate output.

**Example**:
```json
{
  "id": "01J7R5K8W6Z8X8X8X8X8X8X8X8",
  "name": "MiniMax primary",
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

> **Use an identity mapping for model mapping.** The left-hand side of
> `modelMapping` appears verbatim in `GET /v1/models` and is written into the
> usage logs. Pointing a name like `claude-sonnet-4-6` at a non-Anthropic
> upstream model is misleading, unless the client hardcodes the model name and
> cannot override it.
> The pairing rules for endpoints and `baseUrl` are covered in
> [architecture.md §7.3](architecture.md#73-endpoint--upstream-path).

---

## 4. Usage Log (UsageLog)

**Keys**: `relay:log:{apiKeyId}:{ulid}` — Hash, `relay:log:by-apikey:{apiKeyId}` — List (most recent N entries)

> The schema field is `apiKeyId` (camelCase), while the Redis key segments are
> spelled `apikey`. Both spellings appear in the codebase, so grep for either.

**Fields**:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (ULID) | |
| `apiKeyId` | string | |
| `userId` | string | Redundant, kept for reverse lookups |
| `providerId` | string | |
| `model` | string | Model requested by the client |
| `upstreamModel` | string | Model actually sent upstream |
| `promptTokens` | number | |
| `completionTokens` | number | |
| `totalTokens` | number | |
| `creditsUsed` | number | **Credits** consumed by this request, in integer units of 0.001 credits (`CREDIT_SCALE = 1000`) |
| `images` | number | **Media only.** How many items the request produced — the basis for per-item billing |
| `capability` | string | **Media only.** Which capability served it: `image.generate`, `video.generate`, `audio.tts`, `audio.stt`, `music.generate` |
| `status` | `"success" \| "error"` | |
| `errorMessage` | string \| null | |
| `billingMode` | `"usage" \| "estimated"` | Whether the charge came from reported upstream usage or from an estimate |
| `createdAt` | ISO string | |

**Retention**: 30 days by default, with length controlled via `LPUSH` + `LTRIM`
(1000 entries per key at most).

---

## 5. Session

Automatically managed by **iron-session** 8, cookie name `relay_session`.

Payload:
```json
{
  "userId": "01J...",
  "username": "alice",
  "role": "user",
  "iat": 1695273600,
  "exp": 1695360000
}
```

Encryption: AES-256-GCM (built into iron-session).
Secret: derived from `RELAY_AUTH` (HMAC-SHA256, 64 hex chars); it cannot be
overridden separately — rotating `RELAY_AUTH` invalidates every existing
session at once.

---

## 6. Auxiliary Keys

| Key | Type | Purpose |
| --- | --- | --- |
| `relay:meta:initialized` | "1" | Marks whether the bootstrap admin has been created |
| `relay:counter:userId` | String (INCR) | Monotonically increasing userId counter (spare; the ULID primary key does not need it) |

---

## 8. Future Extensions (v2)

- `relay:usage:monthly:{yyyymm}` — Hash (apikeyId → creditsUsed), for monthly aggregation.
- `relay:ratelimit:{apikeyId}:{window}` — Sliding-window rate limiting.
- `relay:apikey:by-provider:{providerId}` — Reverse lookup of which keys a provider has used (audit).
