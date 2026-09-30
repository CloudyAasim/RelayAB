<div align="center">

# ⏸ Development Paused · A Long Pause, Not a Farewell

</div>

> **中文为原版声明，英文采用机器翻译，实际公告内容以中文版本为准，英文版本仅供参考。**
>
> **The Chinese text below is the original announcement. The English text is a
> machine translation, provided for reference only — in case of any discrepancy,
> the Chinese version prevails.**

## 中文（原版）

很遗憾，这个基于 Vercel 开发的开源项目，要停更很长、很长一段时间了。

开发过程中，额度消耗远超预期；而我本人并没有一份正式工作。我所在的地区，大家普遍挣得少，平时花得也少。Vercel 的 Pro 月费按美元全球统一收取，就我所知，并没有针对不同地区的价格折扣；从我们这边的收入来看，它就像是按挣得多的地方来定价。超出免费额度后的用量费用虽然会因地区而异，但对我这样连每月 20 美元都难以承担的人来说，并无实质帮助。每月 20 美元，实在过于昂贵。

所以，这个项目只能先搁置下来，停更很久、很久。这里并不是说它一定不再做了，也不是就此别过，只是眼下不得不按下暂停键，归期未定。感谢大家一直以来的关注和支持，后会有期。

**免责声明**：上面说“我的地区这边挣得少，平时花得也少”，只是对我个人情况和感受的描述，并不是一个绝对结论，也不代表这个地区的所有人都收入低、消费低，更不是说这里所有东西都便宜。请不要把它当成对整个地区的概括或刻板印象。

## English (machine translation, for reference only)

It is with regret that I have to say this Vercel-based open-source project will be paused for a long, long time.

During development, usage ran far beyond what I had expected. I do not have a full-time job. In my region, people generally earn little and spend little. Vercel's Pro plan, as far as I know, is billed at a flat $20 per month in USD, with no regional discount; against local incomes here, it feels priced for places where people earn much more. Usage fees beyond the free allowance may vary by region, but that is little comfort to someone who cannot afford the $20 base fee. Twenty dollars a month is simply too much for me.

So the project has to be set aside for a long, long time. This is not to say it will never be developed again, nor that this is a final goodbye. It only means I must press pause, with no date set for its return. Thank you all for your past interest and support. Until then—see you down the road.

**Disclaimer**: My statement that “people around here earn little and spend little” is only a description of my own situation and impressions. It is not an absolute conclusion, nor does it mean everyone in my region has low income or low spending, or that everything here is cheap. Please do not take it as a generalization or stereotype about the whole region.

---

# RelayAB

> A self-hosted AI API gateway (an API relay) for sharing upstream AI service API
> keys securely and under control, with fine-grained permission and usage
> management. One-click deploy to Vercel.
>
> **Language / 语言: English (this page) · [中文](README.md)** — the switch lives only here; pages never send you into the other language on their own

> ⚠️ **This project is paused and is no longer maintained** (see the notice at the
> top). You may still fork and deploy it yourself, but there will be no further
> fixes, updates, or support.

## One-click deploy to Vercel

Click the button below. On Vercel's "Add Environment Variables" step you only
fill in **one** variable — `RELAY_AUTH`. The two Upstash variables are **not**
filled in here; install them after deployment via the Vercel Marketplace. The
public URL is derived automatically from `VERCEL_URL`, so there is nothing to
fill in.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FCloudyAasim%2FRelayAB&env=RELAY_AUTH&envDescription=Master%20password%20%2B%20first%20admin%20login%20password&envLink=https%3A%2F%2Fgithub.com%2FCloudyAasim%2FRelayAB%23readme)

### Steps (what to click at each one)

1. **Click the button** → opens `vercel.com/new/clone`. Vercel first asks you to
   click "Continue with GitHub" to authorize (skipped if already signed in).
2. The **New Project** page appears. Scroll down to the "Add Environment
   Variables" section — there is **a single input, `RELAY_AUTH`**. Enter a
   **high-entropy string** (32+ bytes of random characters; you choose the value,
   it is the root secret). Click **Deploy**.
3. Wait for **Ready**, and note the `*.vercel.app` URL.
4. **Storage → Create Database → Upstash** → Free → Create.
5. **Deployments** → the newest entry at the top → **⋯** → **Redeploy** — this
   time the Upstash credentials take effect.

> ⚠️ **The variable names Vercel's Upstash Marketplace injects are
> `KV_REST_API_URL` / `KV_REST_API_TOKEN`** (a naming leftover from the Vercel KV
> era), not `UPSTASH_REDIS_REST_*`. RelayAB's code and `/healthz` accept both
> names — `UPSTASH_*` takes priority, `KV_*` is the fallback. So the deployment
> succeeds whichever set Vercel injects.

### Verify

```bash
curl -s https://<your-app>.vercel.app/healthz
```

Expected:

```json
{"ok":true,"data":{"status":"ok","env":{"required":3,"configured":3}}}
```

If `status` is `"degraded"`, `env.missing` in the response tells you what is
still unset:

- Only Upstash missing → you have not installed the Marketplace yet, go back to step 4
- `RELAY_AUTH` also missing → it was not filled in during the Deploy Button
  step; go back and fill it in

### If you already have this project in Vercel

The Deploy Button takes the "create new project" path; an **existing** project
will not pick up the form automatically. Two ways to handle it:

- **(Clean)** Vercel Dashboard → Settings → General → **Delete Project** → then
  click the Deploy Button and go through the new-project flow
- **(Practical)** Existing project → **Settings → Environment Variables** → add
  the 3 keys by hand (for the two Upstash ones any placeholder string will do
  initially; if the URL check complains, put `https://placeholder.upstash.io` in
  the URL field) → install the Upstash Marketplace integration → Redeploy

For more detail (bypassing deployment protection, self-hosted key rotation,
backup strategy) see [docs/en/deployment.md](docs/en/deployment.md).

## Features

- **Multi-user with roles** (admin / user); passwords stored as bcrypt hashes
  (**one-way, irreversible**)
- **Welcome page**: `/` is a public introduction page — it explains what the
  service is, gives a copyable endpoint URL, and offers one button into the
  console. Unauthenticated visitors are no longer bounced straight to the login page
- **Credits belong to the account** (controlled by the admin): the admin assigns
  a total credit amount and the set of accessible models; **all keys under that
  account share that one pool**, and once it is exhausted everything stops.
  Creating more keys does not grant more quota
- **Self-service for regular users**: create / rename / enable / disable / delete
  keys under `/dashboard` without involving the admin
- **Self-service password change**: at `/dashboard/settings` — enter the current
  password, then the new one twice
- **User-friendly docs page**: `/dashboard/docs` presents the public URL and
  OpenAI / Anthropic compatible examples as copyable code blocks
- **Multiple API keys per user**, each independently configurable:
  - expiry (absolute timestamp)
  - enabled / disabled (toggle at any time)
  - model narrowing (optional; can only narrow the account's allowlist, never widen it)
- **Customer key format** is OpenAI-compatible: `sk-relay-...`, sent as HTTP
  `Authorization: Bearer sk-relay-...`
- **Upstream provider keys** are encrypted with AES-256-GCM before being stored in
  Redis — **losing the master key means the data is permanently unusable**
- **Supported protocols**:
  - OpenAI Chat Completions (`/v1/chat/completions`)
  - OpenAI Responses API (`/v1/responses`, including automatic Chat / Anthropic conversion)
  - Anthropic Messages (`/anthropic/v1/messages`)
  - Model mapping (client model → real upstream model; an identity mapping is recommended)
- **Admin panel** + **user dashboard** + usage statistics
- **Multilingual UI**: Chinese (default) / English, one click to switch in the
  footer, preference stored in the `relayab_locale` cookie
- **Fully local development loop**: an embedded Vercel REST API emulator (no
  separate process, no network)

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 App Router + React 19 + TypeScript 5 |
| Data | Upstash for Redis (one-click install via Vercel Marketplace) |
| Authentication | iron-session 8 + bcryptjs (work factor 12) |
| Encryption | AES-256-GCM (Node `crypto`) + bcryptjs |
| Upstream AI | Vercel AI SDK (`ai` + `@ai-sdk/openai` + `@ai-sdk/anthropic`) |
| Vercel API | `@vercel/sdk` |
| Testing | Vitest + Playwright |
| Local mock | embedded `@emulators/adapter-next` |
| UI | Tailwind CSS 3 + hand-written components |

## Quick start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment variables

```bash
cp .env.example .env.local
```

**Only one is required; the other two are injected automatically on Vercel:**

```bash
# Required: the master password (also the admin login password)
RELAY_AUTH="<openssl rand -hex 32>"

# Injected automatically by the Marketplace on Vercel; set manually only when self-hosting
UPSTASH_REDIS_REST_URL="https://<your-db>.upstash.io"
UPSTASH_REDIS_REST_TOKEN="<your-token>"
```

**You do not configure the public URL.** The endpoint URL shown on
`/dashboard/docs` and on the welcome page is taken from `VERCEL_URL`
automatically, falling back to the Host header of the incoming request. Only set
`RELAY_PUBLIC_URL` explicitly for a custom domain or reverse-proxy setup (where
the address users should call differs from the one they actually reach).

**Optional: bootstrap an upstream provider automatically (takes effect on first run)**

```bash
# Comma-separated keys → creates an OpenAI provider automatically (key rotation enabled)
OPENAI_KEYS="sk-xxx,sk-yyy"
OPENAI_BASE_URL="https://api.openai.com/v1"   # override for Azure / a proxy

ANTHROPIC_KEYS="sk-ant-xxx"
ANTHROPIC_BASE_URL="https://api.anthropic.com"
```

Both `SESSION_PASSWORD` and `RELAY_MASTER_KEY_HEX` are derived from `RELAY_AUTH`
(HMAC-SHA256) — **there is nothing to generate by hand**.

### 3. Install Upstash (recommended)

Vercel Dashboard → project → **Storage** → **Create Database** → **Upstash**
automatically injects `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

### 4. Start the development server

```bash
pnpm dev          # → http://localhost:3000
```

### 5. The first admin is created automatically!

On first run, RelayAB automatically creates the `admin` user using `RELAY_AUTH`
as the password.

**To log in**:
- Visit `/login`
- Username: `admin` (or your custom `RELAY_ADMIN_USERNAME`)
- Password: your `RELAY_AUTH` value

After the first login you should change the password at `/admin/users`
immediately, or reset it to a new strong one.

## Upstream provider configuration

Add providers at `/admin/providers`. The three fields have distinct jobs — do
not let them substitute for one another:

| Field | What it does |
|---|---|
| **kind** | Protocol family (determined by the template). `anthropic` = this provider speaks the Anthropic Messages protocol |
| **API base URL** (`baseUrl`) | The upstream root URL; endpoint paths are appended after it |
| **Upstream format** (`upstreamFormat`) | The upstream's native protocol: `responses` / `chat` / `anthropic` |

`baseUrl` must be paired with the endpoint — this is the most common
configuration mistake:

| Endpoint | `baseUrl` must be |
|---|---|
| `/v1/chat/completions`, `/v1/responses` | the upstream's OpenAI-compatible base URL, e.g. `https://api.minimax.cn/v1` |
| `/anthropic/v1/messages` | the upstream's Anthropic-compatible base URL, e.g. `https://api.minimax.cn/anthropic` |

**The two base URLs of the same upstream are not interchangeable.** To make all
three endpoints work, create two providers:

```
MiniMax            kind=openai     baseUrl=https://api.minimax.cn/v1        upstream format=Responses (native)
MiniMaxAnthropic   kind=anthropic  baseUrl=https://api.minimax.cn/anthropic upstream format=Anthropic Messages
```

### How to write model mappings

**Use an identity mapping**: put the same name on both sides, e.g.
`MiniMax-M3` → `MiniMax-M3`.

The left-hand column appears verbatim in `GET /v1/models` and is written into
usage logs, so do not write `claude-sonnet-4-6` → `MiniMax-M3` just to please a
particular client — that is misleading to the people using it. If the client
lets you pick the model (for example `ANTHROPIC_MODEL` in Claude Code), change
the client configuration instead.

For the complete rules (including `upstreamFormat` and protocol conversion, and
the step-by-step Anthropic provider setup) see
[docs/en/architecture.md §7](docs/en/architecture.md#7-upstream-providers-and-model-mapping).

## Testing

```bash
pnpm test                # all unit + integration tests (no network required)
pnpm test:unit           # unit tests only
pnpm test:integration    # integration tests only
pnpm smoke               # end-to-end smoke: real dev server + in-memory Redis + mock upstream
pnpm type-check          # TypeScript compile check
pnpm build               # Next.js production build
```

## Project structure

```
RelayAB/
├── docs/                technical documentation
├── scripts/             operations scripts (bootstrap / reset / rotate)
├── src/
│   ├── app/             Next.js App Router pages and routes
│   │   ├── (auth)/login login page
│   │   ├── (user)/dashboard user dashboard
│   │   ├── (admin)/admin  admin panel
│   │   └── api/          backend API
│   ├── components/       UI components
│   └── lib/              core libraries
│       ├── auth/         authentication (session / api key)
│       ├── crypto/       encryption (secrets / hashing / password)
│       ├── db/           persistence (users / keys / providers / usage)
│       ├── proxy/        upstream proxy (openai / anthropic)
│       ├── quota/        quota (credits / rates / calculator)
│       ├── vercel/       Vercel SDK wrapper
│       └── config.ts     environment variables
├── tests/               unit / integration / e2e
└── configuration files
```

## Operations commands

```bash
pnpm bootstrap-admin --username <name> [--password <pw>]
pnpm reset-password --username <name>          # generate and print a new password
pnpm rotate-key                                # rotate the master key (needs OLD_/RELAY_MASTER_KEY_HEX)
pnpm list-usage [--user <name>] [--days N]     # usage summary
```

## Documentation

Start at **[docs/en/README.md](docs/en/README.md)** — the documentation index.

| Document | Contents |
|---|---|
| [docs/en/architecture.md](docs/en/architecture.md) | Full architecture + data model + design decisions |
| [docs/en/data-model.md](docs/en/data-model.md) | Redis key naming + field definitions |
| [docs/en/api-routes.md](docs/en/api-routes.md) | Complete API route specification |
| [docs/en/testing.md](docs/en/testing.md) | The test pyramid + tooling |
| [docs/en/admin.md](docs/en/admin.md) | Administrator guide (users / keys / providers) |
| [docs/en/deployment.md](docs/en/deployment.md) | Deploying to Vercel + bypassing deployment protection + the smoke-test checklist |

> **Note:** the media adapter protocol — the declarative JSON spec format for
> image / video / speech / music providers, along with its offline validator
> ("the judge") — is maintained in **Chinese only**:
> [`docs/模型适配协议/README.md`](docs/模型适配协议/README.md).

## Security notes

1. **User passwords**: one-way bcryptjs hash (work factor 12), **the plaintext
   cannot be recovered**
2. **Customer API keys**: only `sha256(plaintext)` is stored, with a prefix and
   suffix kept for display; **the plaintext is returned exactly once, at creation**
3. **Upstream provider keys**: encrypted with AES-256-GCM before being stored in
   Redis; the **master key is `RELAY_MASTER_KEY_HEX`** — losing it means
   permanent data loss
4. **Session cookie**: encrypted with iron-session (HttpOnly + Secure + SameSite=Lax)
5. **A database leak alone is not fatal**: with Redis but without the env var,
   upstream keys cannot be decrypted

## Full deployment to Vercel

See [docs/en/deployment.md](docs/en/deployment.md). The environment variables that
matter most:

| Name | Source |
|---|---|
| `RELAY_AUTH` | `openssl rand -hex 32` (admin login password + key derivation seed) |
| `UPSTASH_REDIS_REST_URL` | injected automatically by the Vercel Marketplace |
| `UPSTASH_REDIS_REST_TOKEN` | injected automatically by the Vercel Marketplace |
| `RELAY_ADMIN_USERNAME` | optional, defaults to `admin` |
