# Data Model

> All data is persisted in a single **SQLite database file**, driven by Node 24's
> built-in `node:sqlite` (no npm dependency). **No database service is required**:
> no Redis/Valkey, no port, no password. Backup is "copy the file".
>
> The location is given by `RELAY_DB_PATH`; unset, it defaults to
> `./data/relayab.db`. Earlier versions supported hosted Upstash and a
> self-hosted Redis; both transports were removed with the migration, so
> setting `UPSTASH_REDIS_REST_*` or `REDIS_URL` now has no effect.
>
> The entity types are defined in [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
> and the schema in [`src/lib/db/sqlite.ts`](../../src/lib/db/sqlite.ts);
> this document is a summary.

---

## Storage conventions

Every column type below follows from these four rules, so read them first:

- **Tables mirror entities one-to-one**, and column names are the entity field
  names in `snake_case`. Each row is run back through the same Zod schema after
  reading (`rowToUser()` and friends), so the field tables below name the
  **entity field** and give the actual column next to it. A single `parse` call
  replaces the hand-written `hashTo*` deserialisers the Redis version needed.
- **Booleans are stored as `INTEGER` 0/1.** `node:sqlite` has no boolean binding,
  so `toDbBool` / `fromDbBool` convert explicitly rather than letting a truthy
  number leak into the entity.
- **Structured values are stored as JSON text**: `allowed_models`,
  `model_mapping`, `model_configs`, `headers`, `models`, `specs`. SQLite has no
  map type, and these are read whole and written whole — never queried into.
- **Timestamps are ISO strings** (`TEXT`), not epoch integers. Keeping them as
  text means every existing comparison and sort in the app keeps working
  unchanged.

The schema is executed on every connection open and every statement is
`IF NOT EXISTS` — so it doubles as the migration mechanism.

---

## 1. User

**Table**: `users` — one row per user. `username` carries a `UNIQUE` constraint.
The login-name reverse lookup used to be a separate `relay:user:by-username:*`
index key; it is now a database-level unique constraint, so a concurrent insert
of the same username is decided by SQLite and the application no longer does its
own duplicate detection.

**Fields**:

| Entity field | Column | Stored as | Description |
|---|---|---|---|
| `id` | `id` | TEXT (PK) | Primary key, ULID |
| `username` | `username` | TEXT NOT NULL **UNIQUE** | Login name, 3–32 characters |
| `passwordHash` | `password_hash` | TEXT NOT NULL | bcryptjs hash, work factor 12 |
| `role` | `role` | TEXT NOT NULL | `"admin" \| "user"`; admins can access `/admin/*` |
| `displayName` | `display_name` | TEXT NOT NULL | Shown in the UI |
| `timezone` | `timezone` | TEXT NULL | Per-user display timezone, optional. Absent = the default (`shanghai`). Only `"utc"` and `"shanghai"` are supported |
| `createdAt` | `created_at` | TEXT NOT NULL | ISO string |
| `updatedAt` | `updated_at` | TEXT NOT NULL | ISO string |
| `lastLoginAt` | `last_login_at` | TEXT NULL | ISO string or NULL |
| `quotaType` | `quota_type` | TEXT NOT NULL | `"credits" \| "tokens"`; the unit of the account's credits pool |
| `quotaLimit` | `quota_limit` | INTEGER NOT NULL | Size of the account's credits pool (for `credits`, stored as an integer in units of 0.001 credits). `0` = not allocated, every call is rejected |
| `quotaUsed` | `quota_used` | INTEGER NOT NULL DEFAULT 0 | Amount already consumed by the account, in the same unit as `quotaLimit` |
| `maxActiveKeys` | `max_active_keys` | INTEGER NOT NULL | Upper bound on simultaneously enabled keys (0 = no limit) |
| `allowedModels` | `allowed_models` | TEXT NOT NULL DEFAULT `'[]'` | Whitelist of models the account may access, as a JSON array (empty = all) |

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
> `api_keys` therefore carries **no** quota column at all.
>
> `allowedModels` belongs to the account as well; a key may only **narrow** it
> (see §2 below), never widen it. Admins configure all three on `/admin/users`;
> users cannot change them themselves.

**What a row looks like**:
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

## 2. Customer API Key (ApiKey)

**Table**: `api_keys` — one row per key.

The Redis version had to keep three structures in step: the record HASH, the
`hash:{sha256}` → id lookup STRING, and the `by-user:{id}` SET. Every create and
delete therefore needed `MULTI` plus a path that unwound the secondary indexes,
and any interruption between the two left a key that existed but could not be
found, or a dangling index entry pointing at nothing. The three invariants are
now expressed as a **column, a foreign key and an index**: a write is one
statement and there is no second structure left to drift.

| Invariant | Guaranteed by |
|---|---|
| The same plaintext key never exists twice | `UNIQUE` on `key_hash` |
| A key never points at a user that does not exist | `user_id` foreign key onto `users(id)`, `ON DELETE CASCADE` |
| Listing a user's keys is O(log n) | index `idx_api_keys_user` |

**Fields**:

| Entity field | Column | Stored as | Description |
|---|---|---|---|
| `id` | `id` | TEXT (PK) | Primary key, ULID |
| `userId` | `user_id` | TEXT NOT NULL, FK → `users(id)` ON DELETE CASCADE | Owning user |
| `label` | `label` | TEXT NOT NULL | The name the user or an admin gave this key |
| `keyHash` | `key_hash` | TEXT NOT NULL **UNIQUE** | sha256(plaintext key), **plaintext is never stored**. This is the column Bearer authentication looks up |
| `keyPrefix` | `key_prefix` | TEXT NOT NULL | First 12 characters of the plaintext + `...` + last 4 characters, for display only |
| `expiresAt` | `expires_at` | TEXT NULL | Expiry time, ISO string or NULL |
| `enabled` | `enabled` | INTEGER NOT NULL | Enabled flag, 0/1 |
| `forceDisabled` | `force_disabled` | INTEGER NOT NULL DEFAULT 0 | Set by an admin. Once set, the user **cannot** re-enable the key themselves; the API answers `key_force_disabled` |
| `allowedModels` | `allowed_models` | TEXT NOT NULL DEFAULT `'[]'` | Models this key **additionally** allows, as a JSON array. Intersected with the account whitelist — it can only narrow, never widen (empty = no extra restriction, the account whitelist still applies) |
| `createdAt` | `created_at` | TEXT NOT NULL | ISO string |
| `lastUsedAt` | `last_used_at` | TEXT NULL | ISO string or NULL |

> A key is a **credential**, not a wallet. It carries only identity (who is
> calling) and light policy (enabled / expired / optional model narrowing); the
> quota pool lives on the owning account. That is why there are **no**
> `quotaType` / `quotaLimit` / `quotaUsed` columns here.

**What a row looks like**:
```json
{
  "id": "01J7R5K8W6Y8X8X8X8X8X8X8X8",
  "user_id": "01J7R5K8W6X8X8X8X8X8X8X8X8",
  "label": "Alice's Macbook",
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

> Step 3 is where "creating more keys does not buy more quota" is actually
> enforced: whichever key carried the request, what is read is the same
> `user.quotaUsed / user.quotaLimit`.
> `quotaLimit === 0` (not allocated) is treated as exceeded, i.e. a brand-new
> account cannot call anything by default — it is not read as "unlimited".

---

## 3. Upstream Provider (Provider)

**Table**: `providers` — one row per upstream. Multiple providers take part in
routing and rotation, ordered by `priority`.

**Fields**:

| Entity field | Column | Stored as | Description |
|---|---|---|---|
| `id` | `id` | TEXT (PK) | Primary key, ULID |
| `name` | `name` | TEXT NOT NULL | Name shown to admins |
| `kind` | `kind` | TEXT NOT NULL | Protocol family. `anthropic` = this provider speaks the Anthropic Messages protocol |
| `baseUrl` | `base_url` | TEXT NULL | Upstream root address; the proxy appends endpoint paths to it |
| `encryptedApiKey` | `encrypted_api_key` | TEXT NOT NULL | Upstream key encrypted with AES-256-GCM (base64) |
| `modelMapping` | `model_mapping` | TEXT NOT NULL DEFAULT `'{}'` | Client model → actual upstream model, as a JSON object. An identity mapping is recommended |
| `modelConfigs` | `model_configs` | TEXT NOT NULL DEFAULT `'{}'` | Optional per-model configuration, as a JSON object — see §3.1 |
| `headers` | `headers` | TEXT NOT NULL DEFAULT `'{}'` | Optional extra request headers (e.g. Azure's `api-version`), as a JSON object |
| `upstreamFormat` | `upstream_format` | TEXT NOT NULL DEFAULT `'responses'` | `"responses" \| "chat" \| "anthropic"`, the native upstream protocol. **Legacy read-only value**: it describes the OpenAI-side format; which surfaces a provider actually serves is decided by the two `*Enabled` flags below |
| `openaiEnabled` | `openai_enabled` | INTEGER NOT NULL DEFAULT 1 | Whether this provider serves the OpenAI-facing endpoints (`/v1/chat/completions`, `/v1/responses`) |
| `anthropicEnabled` | `anthropic_enabled` | INTEGER NOT NULL DEFAULT 0 | Whether this provider **also** serves the Anthropic Messages surface (`/anthropic/v1/messages`, `/v1/messages`) |
| `anthropicBaseUrl` | `anthropic_base_url` | TEXT NULL | Base URL for the Anthropic face. `NULL` = derive it from `base_url` (one trailing `/v1` is stripped). Set it explicitly when the vendor's Anthropic endpoint is a sub-path, e.g. `https://api.deepseek.com/anthropic` |
| `enabled` | `enabled` | INTEGER NOT NULL | 0/1 |
| `priority` | `priority` | INTEGER NOT NULL DEFAULT 0 | Routing priority (lower number wins) |
| `createdAt` | `created_at` | TEXT NOT NULL | ISO string |
| `updatedAt` | `updated_at` | TEXT NOT NULL | ISO string |

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
> | `anthropicBaseUrl` | the Anthropic-side base URL (derived from `base_url` when NULL) |
> | `upstreamFormat` | the OpenAI-side native format — `responses` (native) or `chat` |
>
> See [architecture.md §7](architecture.md#7-upstream-providers-and-model-mapping)
> for how the faces interact during routing.

### 3.1 ModelConfig

`model_configs` maps a client model name to a `ModelConfig` (JSON object text):

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

**What a row looks like**:
```json
{
  "id": "01J7R5K8W6Z8X8X8X8X8X8X8X8",
  "name": "MiniMax primary",
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

> **Use an identity mapping for model mapping.** The left-hand side of
> `model_mapping` appears verbatim in `GET /v1/models` and is written into the
> usage logs. Pointing a name like `claude-sonnet-4-6` at a non-Anthropic
> upstream model is misleading, unless the client hardcodes the model name and
> cannot override it.
> The pairing rules for endpoints and `base_url` are covered in
> [architecture.md §7.3](architecture.md#73-endpoint--upstream-path).

### 3.2 Media Provider (MediaProvider)

**Table**: `media_providers` — image / video / speech / music providers. Parallel
to `providers` but independent: it has no OpenAI/Anthropic dual faces, and
instead carries an array of declarative specs.

| Entity field | Column | Stored as | Description |
|---|---|---|---|
| `id` | `id` | TEXT (PK) | Primary key |
| `name` | `name` | TEXT NOT NULL | Name shown to admins |
| `baseUrl` | `base_url` | TEXT NOT NULL | Every `transport.path` in a spec is resolved against it |
| `encryptedApiKey` | `encrypted_api_key` | TEXT NOT NULL | Upstream key encrypted with AES-256-GCM |
| `enabled` | `enabled` | INTEGER NOT NULL | 0/1 |
| `priority` | `priority` | INTEGER NOT NULL DEFAULT 0 | Routing priority (lower number wins) |
| `models` | `models` | TEXT NOT NULL DEFAULT `'{}'` | Client model name → `MediaModelConfig` (which carries `pricePerItem`), as a JSON object |
| `specs` | `specs` | TEXT NOT NULL DEFAULT `'[]'` | `MediaSpec[]` as a JSON array — see [模型适配协议/README.md](../模型适配协议/README.md) |
| `createdAt` | `created_at` | TEXT NOT NULL | ISO string |
| `updatedAt` | `updated_at` | TEXT NOT NULL | ISO string |

> `models[clientModel].pricePerItem` is in **whole credits**; it is stored in
> units of 0.001 credits and `computeMediaCredits` does the ×1000 conversion, so
> **never pre-scale it**.

---

## 4. Usage Log (UsageLog)

**Table**: `usage_logs` — one row per request. Append-only; rows are never updated.

| Entity field | Column | Stored as | Description |
|---|---|---|---|
| `id` | `id` | TEXT (PK) | ULID |
| `apiKeyId` | `api_key_id` | TEXT NOT NULL | Redundant, kept for per-key aggregation |
| `userId` | `user_id` | TEXT NOT NULL | Redundant, kept for reverse lookups |
| `providerId` | `provider_id` | TEXT NOT NULL | The provider that actually served this request |
| `model` | `model` | TEXT NOT NULL | Model requested by the client |
| `upstreamModel` | `upstream_model` | TEXT NOT NULL | Model actually sent upstream |
| `promptTokens` | `prompt_tokens` | INTEGER NOT NULL DEFAULT 0 | |
| `completionTokens` | `completion_tokens` | INTEGER NOT NULL DEFAULT 0 | |
| `totalTokens` | `total_tokens` | INTEGER NOT NULL DEFAULT 0 | |
| `creditsUsed` | `credits_used` | INTEGER NOT NULL DEFAULT 0 | **Credits** consumed by this request, in integer units of 0.001 credits (`CREDIT_SCALE = 1000`) |
| `images` | `images` | INTEGER NULL | **Media only.** How many items the request produced — the basis for per-item billing. NULL for chat calls |
| `capability` | `capability` | TEXT NULL | **Media only.** Which capability served it: `image.generate`, `video.generate`, `audio.tts`, `audio.stt`, `music.generate` |
| `status` | `status` | TEXT NOT NULL | `"success" \| "error"` |
| `errorMessage` | `error_message` | TEXT NULL | |
| `billingMode` | `billing_mode` | TEXT NULL | Whether the charge came from reported upstream usage or from an estimate |
| `createdAt` | `created_at` | TEXT NOT NULL | ISO string |

> `images` and `capability` are optional on the entity: chat calls leave both
> columns NULL, and a NULL column stays `undefined` when read back rather than
> becoming 0.

**Indexes** (all three exist for aggregation queries):

| Index | Query it serves |
|---|---|
| `idx_usage_logs_key (api_key_id, created_at)` | Per-key usage detail and time ranges |
| `idx_usage_logs_user (user_id, created_at)` | Per-account usage detail and time ranges |
| `idx_usage_logs_created (created_at)` | Global time-range scans |

**Retention**: **at most 1000 rows per key** (`MAX_LOGS_PER_KEY`). Older rows are
deleted on write — a `DELETE ... WHERE id NOT IN (SELECT ... ORDER BY created_at
DESC LIMIT ?)`, where `id` breaks ties between rows written in the same
millisecond. **There is no day-based retention policy and no scheduled cleanup
job**: usage logs are accounting records and never expire by age.

---

### 4.1 Running Totals (UsageTotals)

**Table**: `usage_totals` — one row per key, with `api_key_id` as the primary key.

| Column | Stored as | Description |
|---|---|---|
| `api_key_id` | TEXT (PK) | References `api_keys.id` |
| `prompt_tokens` | INTEGER NOT NULL DEFAULT 0 | Cumulative input tokens |
| `completion_tokens` | INTEGER NOT NULL DEFAULT 0 | Cumulative output tokens |
| `total_tokens` | INTEGER NOT NULL DEFAULT 0 | Cumulative total tokens |
| `credits_used` | INTEGER NOT NULL DEFAULT 0 | Cumulative credits consumed (0.001-credit units) |
| `images` | INTEGER NOT NULL DEFAULT 0 | Cumulative media item count |
| `requests` | INTEGER NOT NULL DEFAULT 0 | Cumulative request count |

> Why not just `SUM` over `usage_logs`: the proxy path reads these totals on
> **every single call**. Locating one row by primary key and incrementing it
> atomically is far cheaper than scanning the whole log table per request — the
> Redis version relied on `HINCRBY` for the same reason, and a single
> `UPDATE ... SET x = x + ?` carries it now.

---

## 5. Session

Automatically managed by **iron-session** 8, cookie name `relay_session`,
**never stored in the database**.

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

> `iat` / `exp` are epoch seconds — that is iron-session's own format, and it is
> independent of the convention that database timestamps are ISO strings.

---

## 6. Auxiliary Tables and the Full Index List

### 6.1 Auxiliary tables

| Table | Shape | Purpose |
|---|---|---|
| `settings` | `key` TEXT PK, `value` TEXT NOT NULL | A small key/value bag (currently just `publicUrl`). A table rather than one settings blob, so adding a setting does not need a schema change |
| `meta` | `key` TEXT PK, `value` TEXT NOT NULL | Records whether the one-time bootstrap has run. The Redis version claimed this slot with `SETNX`; here an INSERT that violates the primary key is the same trick expressed in SQL, and it is race-free inside a transaction |
| `schema_version` | `version` INTEGER PK | Pinned to `1`. There is no released SQLite schema yet, so this is bookkeeping for the first change that will actually need it |

`meta` currently holds exactly one row: `key = 'initialized'`.

### 6.2 Indexes and constraints

| Name | Table.column | Kind | What it guarantees / serves |
|---|---|---|---|
| `users.username` | `users` | UNIQUE | Login-name uniqueness |
| `api_keys.key_hash` | `api_keys` | UNIQUE | The same plaintext key never exists twice; also the Bearer-auth lookup path |
| `api_keys.user_id` | `api_keys` | FK → `users(id)` ON DELETE CASCADE | Deleting a user deletes their keys; no orphans |
| `idx_api_keys_user` | `api_keys(user_id)` | INDEX | Listing a user's keys |
| `idx_usage_logs_key` | `usage_logs(api_key_id, created_at)` | INDEX | Per-key usage detail |
| `idx_usage_logs_user` | `usage_logs(user_id, created_at)` | INDEX | Per-account usage detail |
| `idx_usage_logs_created` | `usage_logs(created_at)` | INDEX | Global time-range scans |

> Primary keys are indexes themselves for every other table (`users.id`,
> `api_keys.id`, `providers.id`, `media_providers.id`, `usage_logs.id`,
> `usage_totals.api_key_id`, `settings.key`, `meta.key`).
>
> `usage_logs.api_key_id` / `user_id` deliberately have **no** foreign key: usage
> rows are accounting records, and history is intentionally preserved when a
> user or a key is deleted.

---

## 8. Future Extensions (v2)

These are ideas, **not implemented**; the parenthetical notes say where each
would sit most naturally in this structure.

- Monthly usage aggregation (a `usage_monthly (yyyymm, api_key_id, credits_used)` rollup table)
- Sliding-window rate limiting (a `ratelimit` table plus a time-window index)
- Reverse lookup of which keys a provider has used (audit use; `usage_logs.provider_id` is already indexed, so this probably needs no extra structure)
