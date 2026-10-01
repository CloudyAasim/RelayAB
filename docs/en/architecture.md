# RelayAB — Architecture and Design

> A self-hosted AI API gateway (API relay) for sharing upstream AI service API keys
> with a small number of users in a safe, controllable way, with fine-grained
> permission and usage management.

---

## 1. Goals and Non-Goals

### 1.1 Goals
- Deploys to a Debian server you control — **no platform fee, no request ceiling**.
- Manage a small number (single digits) of users and multiple API keys per user.
- Per-key configuration: quota cap, expiry time, enabled state, model restrictions.
- Provide proxy endpoints compatible with OpenAI Chat Completions and Anthropic Messages.
- Deduct quota in real time, record usage, provide queryable logs.
- User passwords and upstream API keys are stored encrypted / one-way hashed, so a database leak cannot be reversed.

### 1.2 Non-Goals (not in v1)
- Multi-tenant SaaS (single instance only).
- A complex payment and invoicing system.
- A/B testing of a model marketplace.
- Public self-service registration (only admins create users).

---

## 2. Top-Level Architecture

```
                                 ┌──────────────────────────────────────┐
    ┌────────┐  Bearer sk-xxx    │        self-hosted Debian server     │
    │ Client │ ────────────────► │  ┌────────────────────────────────┐ │
    └────────┘                   │  │  nginx :443  (TLS, no buffer)   │ │
                                 │  └────────────────────────────────┘ │
                                 │  ┌────────────────────────────────┐ │
                                 │  │  Next.js 15 App Router          │ │
                                 │  │                                │ │
                                 │  │  /v1/chat/completions           │ │
                                 │  │  /anthropic/v1/messages         │ │
                                 │  │  /api/admin/*                   │ │
                                 │  │  /api/auth/*                    │ │
                                 │  │  /dashboard, /admin/*           │ │
                                 │  │                                │ │
                                 │  │  ┌──────────────────────────┐ │ │
                                 │  │  │    RelayAB core library   │ │ │
                                 │  │  │   ├─ auth (iron-session)  │ │ │
                                 │  │  │   ├─ encryption (AES-GCM) │ │ │
                                 │  │  │   ├─ quota engine         │ │ │
                                 │  │  │   └─ upstream routing     │ │ │
                                 │  │  └──────────────────────────┘ │ │
                                 │  └────────────────────────────────┘ │
                                 │                  │                  │
                                 │                  ▼                  │
                                 │  ┌────────────────────────────────┐ │
                                 │  │  relayab.db (SQLite)            │ │
                                 │  │  users / api_keys / providers  │ │
                                 │  │  usage_logs / settings / meta  │ │
                                 │  └────────────────────────────────┘ │
                                 │                  │                  │
                                 │                  ▼                  │
                                 │  ┌────────────────────────────────┐ │
                                 │  │  Upstream AI Provider          │ │
                                 │  │  OpenAI / Anthropic / MiniMax  │ │
                                 │  └────────────────────────────────┘ │
                                 └──────────────────────────────────────┘
```

### 2.1 Key Design Decisions

| Topic | Decision | Rationale |
|---|---|---|
| Deployment | Own Debian server (systemd + nginx) | No platform fee, no request ceiling; nginx must disable buffering or SSE streaming breaks |
| Framework | Next.js 15 App Router | Server Actions / Route Handlers from one source; SSR-friendly |
| Data store | **A local SQLite file** (Node 24's built-in `node:sqlite`); hosted environments can switch to Upstash REST | Zero external dependency when self-hosting: nothing to install, no port, no password, and backup is copying the file; unique constraints and foreign keys are now the database's job |
| Authentication | iron-session + bcryptjs | Lightweight, Edge-compatible, no external dependency; bcryptjs is pure JS |
| Upstream key encryption | AES-256-GCM, master key from env | Standard practice; consistent with the TokenPlan approach |
| AI proxy | Hand-written proxy layer (`src/lib/proxy/*`) | Direct control of SSE framing, protocol conversion, and baseURL; no third-party SDK |
| UI | Tailwind CSS + hand-written components | Small and controllable; skipping shadcn reduces the learning curve |
| Testing | Vitest + Playwright | Vitest integrates well with Vite/Turbopack; Playwright covers login and responsive regressions |

### 2.2 Interface Rendering and Response Speed

The post-login app shell (sidebar + top bar) is rendered by **segmented layouts**
(`(admin)/admin/layout.tsx`, `(user)/dashboard/layout.tsx`); **pages own only the
content column**. This is not a stylistic choice — it is dictated by core App
Router behaviour:

- **A layout stays mounted across child routes; a page's entire subtree is replaced.** An early version had every page render the shell itself, so every sidebar click destroyed and rebuilt the sidebar, the top bar, and the `matchMedia` listeners, cookie reads, and collapse animations inside them. Measured in Chromium: when switching `/admin` → `/admin/users`, the DOM node references for `aside` / `header` both changed. After moving the shell into a layout, the same measurement shows the node references staying identical and only the content column being replaced.
- **The skeleton screen should replace only the content column.** When the shell lived in the page, the segment's `loading.tsx` swapped the entire screen (navigation included) for a skeleton. In testing against a slow server, the result was a **blank full screen with no loading indicator at all** first — that is exactly where the "it feels like the network dropped" impression came from. After moving the shell into a layout, the skeleton renders inside `<main>` and the navigation stays visible.
- **Navigation feedback**: the App Router dispatches no route-change event, so `NavigationLoadingBar` now detects changes itself (same-origin link clicks + `popstate`, ending as soon as the path changes), and sidebar links use `useLinkStatus` to show a spinner at the click point.
- **Client-side route cache**: `experimental.staleTimes.dynamic = 30`, otherwise every navigation on a dynamic page re-requests the serverless function; writes go through a Server Action / `router.refresh()` and are not affected by that window.
- **Data access**: SQLite is an in-process call with no network round trip, so multi-row reads use a single `IN (…)` query and `usage_logs` carries indexes on `(api_key_id, created_at)` and friends to support aggregation. Repeated reads of the current user within one request are deduplicated by React `cache()`.

---

## 3. Data Model

See [`data-model.md`](./data-model.md) for the full definition. Summary:

| Table | Purpose | Primary key |
|---|---|---|
| `users` | User profile + role + password hash + **credit pool** (`quota_type`/`quota_limit`/`quota_used`) + model allowlist. `username` is UNIQUE | `id` |
| `api_keys` | Customer key credential (hash / enabled / expiry / narrowed models). **No quota fields**. `key_hash` is UNIQUE, with a foreign key onto `users(id)` | `id` |
| `providers` | Upstream provider configuration + encrypted API key | `id` |
| `media_providers` | Media provider configuration + declarative spec array | `id` |
| `usage_logs` | Per-request log (append-only) | `id` (ULID) |
| `usage_totals` | Running totals per key, read on every proxied call | `api_key_id` |
| `settings` | Key/value bag (currently just `publicUrl`) | `key` |
| `meta` | Records whether the one-time bootstrap has run | `key` |

Sessions live in an iron-session cookie, **not in the database**.

> **The table/entity boundary**: each table maps one-to-one onto a Zod schema,
> column names are the entity field names in `snake_case`, and every row is run
> back through that same schema on read. Booleans are `INTEGER` 0/1,
> `allowed_models` / `model_mapping` / `headers` / `specs` are stored as JSON
> text, and timestamps are ISO strings. See
> [data-model.md storage conventions](data-model.md#storage-conventions).

---

## 4. API Route Design

See [`api-routes.md`](./api-routes.md) for the full definition. Summary:

### 4.1 Public Proxy Endpoints (authenticated with an API key)

| Path | Method | Purpose |
|---|---|---|
| `/v1/chat/completions` | POST | OpenAI Chat Completions compatible |
| `/v1/responses` | POST | OpenAI Responses compatible, including automatic Chat / Anthropic conversion — see §7.3 |
| `/v1/models` | GET | OpenAI-compatible (returns the permitted models) |
| `/v1/messages` | POST | Anthropic Messages, on the OpenAI-facing path |
| `/anthropic/v1/messages` | POST | Anthropic-compatible |
| `/healthz` | GET | Health check (no authentication) |

> Media endpoints (`/v1/images/*`, `/v1/videos/generations`, `/v1/audio/*`) are
> documented in [api-routes.md §2.6](api-routes.md#26-media-endpoints-image--video--speech--music).

### 4.2 Admin APIs (authenticated with a session)

| Path | Method | Purpose |
|---|---|---|
| `/api/auth/login` | POST | Log in with username/password |
| `/api/auth/logout` | POST | Log out |
| `/api/auth/change-password` | POST | Self-service password change (old password + new password twice) |
| `/api/config` | GET | Public runtime info (public URL, OpenAI/Anthropic-compatible endpoints) |
| `/api/user/keys` | GET / POST | Regular user lists / creates their own keys (quota inherited from the allocation) |
| `/api/user/keys/[id]` | PATCH / DELETE | Regular user renames / enables-disables / deletes their own keys |
| `/api/admin/users` | GET / POST | User list / create (including per-user quota allocation) |
| `/api/admin/users/[id]` | GET / PATCH / DELETE | User detail / edit / delete |
| `/api/admin/users/[id]/reset-password` | POST | Reset password |
| `/api/admin/keys` | GET / POST | Key list / create |
| `/api/admin/keys/[id]` | GET / PATCH / DELETE | Key detail / edit / delete |
| `/api/admin/keys/[id]/toggle` | POST | Enable / disable |
| `/api/admin/providers` | GET / POST | Provider list / create |
| `/api/admin/providers/[id]` | GET / PATCH / DELETE | Provider management |
| `/api/admin/usage` | GET | Site-wide usage statistics (`range` / `userId` / `byUser`·`byKey`·`byModel` breakdown) |
| `/api/user/usage` | GET | Current account's usage statistics (`range` / `byKey`·`byModel` breakdown) |
| `/api/admin/media-providers` | GET / POST | CRUD for media providers and their declarative adapter specs |
| `/v1/images/*`, `/v1/videos/*`, `/v1/audio/*` | POST | Media generation (image / image-to-image / video / speech / music), driven by the adapter protocol |

---

### 4.3 Media Adapter Protocol

Media capabilities do not go through the chat protocol surface. Instead they use a
**declarative spec + a generic engine**:

```
Provider row (`media_providers` table) = baseUrl + key + models + specs[]
Engine (src/lib/media/engine.ts) interprets the spec: build upstream request → parse response → map errors → async polling
```

Vendor differences (endpoints, field names, authentication, how sizes are expressed,
sync vs. async, error codes, result encoding) all live inside the spec, so
**adding or adjusting a provider means editing JSON in the admin panel, not editing
code**. See the protocol and its primitives in
[模型适配协议/README.md)](../模型适配协议/README.md).

> **Note:** the media adapter protocol is maintained in Chinese only —
> [`docs/模型适配协议/README.md`)](../模型适配协议/README.md).

The protocol has **exactly one version** (`specVersion: 1`), with no variant
versions. A single provider may hold multiple specs with the same `capability`
(for when a vendor ships both a v1 and a v2 interface); they are routed per model
via each spec's `models` field. Leaving `models` unset on two specs is a save-time
error — the "first spec always wins, the rest become dead code" silent outcome is
not allowed.

This is a separate entity from a chat provider: the request shape, parameters, and
billing unit are all different (media is billed per item).

## 5. Encryption and Security

### 5.1 User Passwords
- Algorithm: **bcryptjs**, work factor = 12 (tunable).
- Storage: only the hash is stored; **plaintext is never stored**.
- Verification: `bcrypt.compare(password, hash)`.
- Reset: the admin generates a new random password in the panel and shows it once.

### 5.2 Customer API Keys (keys created in the user panel)
- Format: `sk-relay-` + 32 base62 bytes (~43 characters total).
- Storage:
  - `keyHash = sha256(key)` (used for the reverse lookup during Bearer verification).
  - `keyPrefix = key.slice(0, 12)` + `...` + `key.slice(-4)` (list display only).
  - **The plaintext is returned exactly once, at creation**, and is unreadable afterwards.
- Verification: the client sends `Authorization: Bearer <key>` → the server `sha256`s it → looks up `api_keys.key_hash` (which carries a UNIQUE index) → on a hit, the full record is loaded.

### 5.3 Upstream Provider API Keys (the most important security point)
- Algorithm: **AES-256-GCM**.
- Master key: the environment variable `RELAY_MASTER_KEY_HEX` (64 hex chars = 32 bytes).
- A random 12-byte IV is generated per write, with a 16-byte auth tag appended.
- Only `iv || ciphertext || authTag` is stored in the database (base64-encoded).
- **Library wrapper**: `src/lib/crypto/secrets.ts`
  ```ts
  encryptSecret(plaintext): string   // returns base64(iv|ct|tag)
  decryptSecret(blob): string      // takes base64, returns plaintext (used only when calling the upstream)
  ```
- Losing the master key = every upstream key is permanently unusable → it must be backed up.

### 5.4 Session Cookie
- Library: **iron-session 8**.
- Storage: HttpOnly + Secure + SameSite=Lax cookie, roughly 1 KB after encryption.
- No JWT (the server can invalidate it proactively).

---

## 6. Quota and Usage Engine

### 6.1 The Credit Pool Lives on the Account

This is the most important data-structure decision in the project; every other
design is derived from it:

```
The admin grants Alice 1000 credits, allowlist [gpt-4o-mini]
  Alice creates key A / key B / key C
  Any call through A, B, or C deducts from the same 1000
  1000 exhausted → all three keys stop working together
```

- The quota fields (`quotaType` / `quotaLimit` / `quotaUsed`) live on the **User**.
- **There are no quota fields on ApiKey at all.** A key is a credential: identity + enabled/expiry + optional model narrowing.

Rationale: if the quota hung off the key, a user could create one more key and
receive free extra quota out of thin air. That is neither the literal meaning of
"give Alice 1000 credits", nor something an admin can predict — the number an
admin sees when granting access must be exactly the ceiling the user can consume.

### 6.2 Metering
- Account-level `quotaType`:
  - `credits`: accumulates in **credits**, with a precision of 0.001 credits (stored as an integer),
    so a single very cheap request is not rounded up to 1 credit.
  - `tokens`: accumulates by total_tokens.
- `quotaLimit === 0` means **not yet allocated**; all calls are rejected (rather than meaning "unlimited").
- After each request completes, `usage.prompt_tokens` / `usage.completion_tokens` are taken from the upstream response and converted into consumption using the credit rates in [`quota/rates.ts`](../../src/lib/quota/rates.ts).

### 6.3 Model Permission = Account Allowlist ∩ Key Allowlist

- The account's `allowedModels` is the outer boundary; a key's `allowedModels` can only narrow within it.
- An empty array on either side means that layer imposes no additional restriction.
- So a user can create a "cheap-models-only" key themselves without an admin re-authorizing the whole account; but no key can break through the account's own limits.

### 6.4 Credit Rates (`rates.ts`)
- Data structure: `Record<modelId, { inputPerMillion: number, outputPerMillion: number }>`
  (integers, in units of credits / 1 million tokens).
- Built-in defaults are seeded on first startup and can be overridden by an admin via `applyRateOverride()`.
- Unknown models fall back to `DEFAULT_RATE`.

### 6.5 Deduction Flow (pseudocode)
```
1. Verify: key enabled and not expired → account not disabled → account quotaUsed < quotaLimit
        → the requested model passes both the account and key allowlists
2. Forward to the upstream (streaming)
3. Aggregate the token count once the stream ends
4. Compute the credits consumed by this call
5. UPDATE users SET quota_used = quota_used + <delta>   ← recorded on the account
6. UPDATE api_keys SET last_used_at = <now>              ← just a timestamp
7. INSERT INTO usage_logs (per-request detail is kept)
8. UPDATE usage_totals to advance that key's running totals (the proxy path reads it on every call)
```

### 6.6 Concurrency Safety
- `quota_used` is accumulated with `SET x = x + ?` (the SQL expression is evaluated
  atomically inside the transaction), so concurrent requests cannot lose updates.
  Those updates are wrapped in `withTransaction()` (`BEGIN IMMEDIATE`).
- Ownership verification (username uniqueness) is guaranteed by the `UNIQUE`
  constraint on `users.username`; the cold-start "two concurrent admins" race is
  caught by the bootstrap's `BEGIN IMMEDIATE` transaction plus the `meta` primary
  key conflict — see [data-model.md §1](data-model.md#1-user) and §6.
- Alternatively, pre-deduct pessimistically before the stream starts, then settle the difference when the stream ends.

---

## 7. Upstream Providers and Model Mapping

### 7.1 Provider Configuration Shape
```ts
{
  id: "01J7R5K8W6Z8X8X8X8X8X8X8X8",
  name: "MiniMax production",
  kind: "openai" | "anthropic" | "custom-openai" | "azure",
  baseUrl: "https://api.minimax.cn/v1",
  encryptedApiKey: "base64(iv|ct|tag)",
  modelMapping: {
    "MiniMax-M3": "MiniMax-M3",   // client model → real upstream model
  },
  modelConfigs: { /* optional context length / output cap / billing parameters */ },
  headers: { /* optional extra request headers */ },
  upstreamFormat: "responses" | "chat" | "anthropic",
  enabled: true,
  priority: 1,                    // lower numbers are picked first
}
```

### 7.2 What the Three Fields Each Do

When configuring a provider, three fields decide the outcome. Their responsibilities
differ and must not substitute for one another:

| Field | Role |
|---|---|
| `kind` | **Protocol family**. `anthropic` means this provider speaks the Anthropic Messages protocol |
| `baseUrl` | **Upstream root address**. The proxy appends the endpoint path to it (`/chat/completions`, `/responses`, `/v1/messages`) |
| `upstreamFormat` | **Upstream native protocol**. Decides which path the request hits and whether a protocol conversion must happen first |

### 7.3 Endpoint → Upstream Path

| Client request | Upstream path | Provider selection rule |
|---|---|---|
| `POST /v1/chat/completions` | `<baseUrl>/chat/completions` | Exclude Anthropic-protocol providers; otherwise take the first by ascending `priority` |
| `POST /v1/responses` | `<baseUrl>/responses` | Same as above. If the matched provider uses the `chat` / `anthropic` protocol, convert the request first, then call its corresponding endpoint, and finally convert the response back into the Responses shape |
| `POST /anthropic/v1/messages` | `<baseUrl>/v1/messages` | Prefer `upstreamFormat === "anthropic"`, then `kind === "anthropic"`, then `kind === "custom-openai"` |

Two implementation details:

- The request body format determines the target path. The chat proxy always emits a chat request body, so it must hit `/chat/completions`; the path must not be changed just because a provider is tagged with a different format, or a chat request body would be sent to the Responses endpoint (this caused a 400 regression historically).
- For a provider with `kind === "anthropic"` whose `upstreamFormat` is still the default `responses`, `effectiveUpstreamFormat()` handles it at runtime as the Anthropic protocol, so it is not misused by `/v1/chat/completions`.

### 7.4 Model Mapping Conventions

The left column of `modelMapping` is the **client-visible model name**; the right
column is the **real model name forwarded to the upstream**. It is only an alias
table.

- **Identity mapping is recommended** (identical columns), e.g. `MiniMax-M3` → `MiniMax-M3`. Every provider template in the repo uses identity mapping.
- Use an alias only when the upstream model ID differs from what clients expect, or when a client hardcodes the model name and cannot be changed.
- **Do not invent names.** Writing something like pointing `claude-sonnet-4-6` at `MiniMax-M3` has three real costs:
  1. That name shows up verbatim in `GET /v1/models` and is visible to every user;
  2. The usage log records the client-side name, which makes "which model was actually called" confusing to debug;
  3. It misleads whoever uses the service.
- If the client supports overriding the model name (e.g. Claude Code's `ANTHROPIC_MODEL`), change the client configuration instead of faking a name inside the gateway.

### 7.5 Adding an Anthropic Provider

To make `/anthropic/v1/messages` work you need a provider that speaks the Anthropic
protocol:

1. Pick the **Anthropic** template — this sets `kind` to `anthropic`, sets `upstreamFormat` to `anthropic` automatically, and prefills the Claude models and the `anthropic-version` header.
2. Change **API request URL** to the upstream's Anthropic base URL. For MiniMax that is `https://api.minimax.cn/anthropic` (note that it is not the same as its OpenAI base URL `https://api.minimax.cn/v1`).
3. Fill in **Model Mapping** with the real model names.
4. This provider will not be selected by `/v1/chat/completions`; it does not interfere with the OpenAI one.

You can also skip the Anthropic template and configure it manually: any OpenAI-family
template with **Upstream Format** changed to `Anthropic Messages`. The result is
equivalent, except that `kind` becomes `openai`, which is semantically less clear
than picking the Anthropic template directly.

The base URLs of the three endpoints must be paired correctly — this is the most
common configuration mistake:

| Endpoint | `baseUrl` must be |
|---|---|
| `/v1/chat/completions`, `/v1/responses` | The upstream's OpenAI-compatible base URL (e.g. `https://api.minimax.cn/v1`) |
| `/anthropic/v1/messages` | The upstream's Anthropic-compatible base URL (e.g. `https://api.minimax.cn/anthropic`) |

---

## 8. Local Development and the Testing Loop

### 8.1 Testing Pyramid

| Level | Tool | Coverage |
|---|---|---|
| Unit | Vitest | Encryption, hashing, quota calculation, credit rates, expiry checks |
| Integration | Vitest + Next.js test handler | Routes + real SQLite (`RELAY_DB_PATH=":memory:"`, no service required) |
| E2E | Playwright | Login, creating a key, viewing usage, calling the OpenAI-compatible endpoint |

### 8.2 CI / Local One-Command Scripts

```bash
pnpm install
pnpm test:unit          # pure functions, seconds
pnpm test:integration   # integration, in-process :memory: database, zero external dependencies
pnpm test:e2e           # needs the Next dev server
```

---

## 9. Deployment

### 9.1 Server Setup
- Node.js 24 + pnpm 10 (`corepack enable` is enough) — `node:sqlite` is built in,
  so an older Node fails immediately with "module not found"
- One writable database directory (e.g. `/var/lib/relayab`, owned by `relayab`) —
  **no database service to install and no port to open**
- systemd service, with `WorkingDirectory` pinned to the repository root
- nginx reverse proxy + Let's Encrypt, **with response buffering disabled** (otherwise SSE breaks)

Ready-made configs live in [`deploy/`](../../deploy/README.md):
`relayab.service` / `nginx.conf` / `env.production.example`.

### 9.2 Environment Variables
See [`deploy/env.production.example`](../../deploy/env.production.example).
`RELAY_AUTH` is the only required one; in production set `RELAY_DB_PATH` explicitly
(outside the release directory), plus `RELAY_BUILD_ID` and `RELAY_PUBLIC_URL`.

### 9.3 First Startup
- The first time a request hits the app (submitting the login form, reading the session on a page, or a proxy endpoint verifying a key), a bootstrap runs once, lazily: if the database is empty → create the `RELAY_ADMIN_USERNAME` (default `admin`) admin using `RELAY_AUTH` as the password; if `OPENAI_KEYS` / `ANTHROPIC_KEYS` are set → create the corresponding providers automatically.
- Trigger point: `ensureBootstrapped()` (`src/lib/db/bootstrap.ts`), run once per instance; on failure it logs the error and retries on the next request.
- **Change the password immediately after the first login.**

See [`deployment.md`](./deployment.md) for the detailed steps.

---

## 10. Directory Structure (final)

```
RelayAB/
├── docs/
│   ├── architecture.md         (this file)
│   ├── data-model.md
│   ├── api-routes.md
│   ├── testing.md
│   └── deployment.md
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── globals.css
│   │   ├── page.tsx
│   │   ├── (auth)/login/page.tsx
│   │   ├── (user)/dashboard/page.tsx
│   │   ├── (admin)/admin/...
│   │   └── api/
│   │       ├── auth/{login,logout}/route.ts
│   │       ├── admin/...
│   │       ├── v1/chat/completions/route.ts
│   │       ├── v1/models/route.ts
│   │       └── anthropic/v1/messages/route.ts
│   ├── lib/
│   │   ├── auth/         (session.ts, password.ts)
│   │   ├── crypto/       (secrets.ts, hashing.ts)
│   │   ├── db/           (sqlite.ts, users.ts, keys.ts, providers.ts, usage.ts)
│   │   ├── proxy/        (openai.ts, anthropic.ts, stream.ts)
│   │   ├── quota/        (credits.ts, rates.ts, calculator.ts)
│   │   └── config.ts
│   ├── components/       (UI components)
│   └── middleware.ts     (path normalisation / CORS / usage-view cookie)
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── scripts/
│   ├── bootstrap-admin.ts
│   └── rotate-master-key.ts
├── package.json
├── tsconfig.json
├── next.config.ts
├── tailwind.config.ts
├── postcss.config.mjs
├── vitest.config.ts
├── playwright.config.ts
├── .env.example
└── README.md
```

---

## 11. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Master key leak | An attacker can decrypt every upstream key | Keep the master key only in `.env.production` (`chmod 600`); never log it; rotate with a script periodically |
| Accidental deletion / disk loss of the database file | All users/keys/usage logs lost | Keep `RELAY_DB_PATH` outside the release directory; add a daily backup cron (`sqlite3 … ".backup …"` or copy with the service stopped); `chmod 600` |
| nginx response buffering | Long streaming requests hang, then dump at once | Disable `proxy_buffering` in the site config and send `X-Accel-Buffering no` |
| Single-machine failure | App and database go down together | The app and the `.db` file share one host; plan backups and recovery yourself |
| Rate limits | A shared upstream key easily triggers OpenAI/Anthropic throttling | The quota engine throttles inherently; v2 adds a per-provider rate |

---

## 12. Interface Internationalization (i18n)

Two locales are supported, `zh-CN` (default) and `en`; the scope is **interface
copy** and it does not affect API responses.

```
src/lib/i18n/dict.ts            pure module: dictionary + translate/parseLocale + LOCALE_COOKIE
src/lib/i18n/server.ts          server only: reads cookie / Accept-Language, exports getT()
src/components/i18n/I18nProvider.tsx   client Provider (three contexts: locale / setLocale / t)
src/components/i18n/LocaleSwitcher.tsx footer language dropdown
```

Design points:

- **The dictionary is a pure module.** `dict.ts` does not import `next/headers`, so client components can safely read constants such as `LOCALE_COOKIE` and `LOCALE_LABELS` from it. Conversely, `I18nProvider` (`"use client"`) **must never** import `server.ts` — that would pull `next/headers` into the browser bundle and `next build` would fail outright. This boundary is guarded by `tests/unit/i18n-usage.test.ts`.
- **Server-rendered copy** uses `await getT()` (Server Component); **client-interactive copy** uses `useT()` (Client Component). Both read the same dictionary and land in the same `relayab_locale` cookie.
- **Fallback chain**: current locale → `en` → the key itself. The last level exists so that an untranslated key is visible to the naked eye during development instead of silently rendering as blank.
- **The context is split into three** (locale / setLocale / t): a component that only uses `setLocale` does not re-render on a copy change, and `t` is cached per language as a stable reference.
- Placeholders are lightweight ICU-style `{name}`, used like: `t("dashboard.quota.credits", { used: 5, limit: 100 })`.
- New copy **must be added to both dictionaries at the same time** (`tests/unit/i18n.test.ts` checks that the keys line up), and you must not hardcode visible text in JSX or post-process the result of `t()` with `.replace()` — such "derived copy" is guaranteed to break in the other language.
