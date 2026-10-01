<div align="center">

# RelayAB · Debian self-hosting branch

</div>

> **The goal of this branch (`server`): port RelayAB off Vercel Serverless and onto a
> Debian server.**
>
> What originally halted development was Vercel's flat $20/month Pro fee on top of the
> Hobby fair-use ceiling. Self-hosting removes both: SQLite + systemd + nginx, with
> **no platform fee and no request ceiling**.
>
> **Relationship to `main`:** the two are currently treated as **independent
> projects**. `main` is the original Vercel build (parked at v178), held for a
> later revival; this branch only carries the Debian self-hosting work, does not
> depend on `main`, and is not being merged into it. The server branch is still
> going through on-machine acceptance testing. Cloning this repository gets you
> the server branch by default.

---

# RelayAB

> A self-hosted AI API gateway (an API relay) for sharing upstream AI service API
> keys securely and under control, with fine-grained permission and usage
> management. Deploy it to your own Debian server (SQLite + systemd + nginx) —
> **no platform fee**.
>
> **Language / 语言: English (this page) · [中文](README.md)** — the switch lives only here; pages never send you into the other language on their own

## Deploy to a Debian server

The one-click Vercel path has been removed. RelayAB now runs on a machine you
control: no platform fee, no request ceiling.

**Full step-by-step runbook: [deploy/README.md](deploy/README.md)** (Chinese).

At a glance:

```bash
# 1. Database directory (SQLite needs no service — just a writable directory)
sudo useradd -r -m -d /opt/relayab -s /usr/sbin/nologin relayab
sudo mkdir -p /var/lib/relayab
sudo chown relayab:relayab /var/lib/relayab

# 2. Code and build
sudo -u relayab git clone <repo> /opt/relayab
cd /opt/relayab && corepack pnpm install --frozen-lockfile && corepack pnpm build

# 3. Environment
cp deploy/env.production.example .env.production   # RELAY_AUTH / RELAY_DB_PATH / RELAY_BUILD_ID
chmod 600 .env.production

# 4. Service
sudo cp deploy/relayab.service /etc/systemd/system/
sudo systemctl enable --now relayab

# 5. Reverse proxy and TLS
sudo cp deploy/nginx.conf /etc/nginx/sites-available/relayab
sudo ln -s /etc/nginx/sites-available/relayab /etc/nginx/sites-enabled/relayab
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.your-domain.com
```

`deploy/` ships ready-to-use copies of everything: the systemd unit, the nginx
site, and an env template. The database itself is nothing to install, start, or
give a password to.

### You never type the master secret by hand

The root `app.json` declares it as platform-generated:

```json
"RELAY_AUTH": { "generator": "secret" }
```

Dokku generates a 64-character cryptographically random hex string on first
deploy. So this secret is **never written down, never reaches your shell
history, never goes into GitHub Secrets, and never has to be copied
anywhere** — only Dokku knows it.

Going the native route instead, generate it once with `openssl rand -hex 32`
and put it in a `chmod 600` `.env.production`.

The full Dokku route is documented in [`deploy/dokku.md`](deploy/dokku.md).

### Three things that are easy to get wrong

1. **nginx must disable response buffering** (`proxy_buffering off` plus
   `X-Accel-Buffering no`), or SSE streaming degrades into "hang, then dump
   everything at once".
2. **systemd's `WorkingDirectory` must be the repository root.** Two admin pages
   read files out of the checkout at request time (`docs/模型适配协议/README.md`
   and `scripts/spec-check.ts`); deploying only `.next` leaves them reading
   "could not read".
3. **The database file must live outside the release directory**
   (`RELAY_DB_PATH` pointing at `/var/lib/relayab/relayab.db`), or `git pull` and a
   rebuild can touch it. The directory and the file must also be owned by
   `relayab`, otherwise the first query fails with `SQLITE_CANTOPEN` /
   `SQLITE_READONLY`.

### Verify

```bash
curl -s https://<your-domain>/healthz
```

Expected:

```json
{"ok":true,"data":{"status":"ok","storage":"sqlite","env":{"required":1,"configured":1},"revision":"v179"}}
```

`storage` tells you which store is live (`sqlite` = the local file, **the
default**), and `revision` comes from the `RELAY_BUILD_ID` you set — there is no
platform-injected commit SHA when self-hosting, so **without it you cannot tell
which build is actually running**.

### The database needs no service at all

Data lives in a single SQLite file managed by Node 24's built-in `node:sqlite` —
no Redis/Valkey, no port, no password, and none of the ways an in-memory store
can quietly drop records when it fills up. Backing up means copying the file.

The only required environment variable is `RELAY_AUTH` (the master secret). The
database path is optional: unset means `<cwd>/data/relayab.db`, and setting it
explicitly is recommended in production so the file sits outside the release
directory.

> The hosted Upstash REST transport and the local TCP transport were both
> removed as part of the storage migration. SQLite is the only path now.

For configuration detail (architecture, smoke-test checklist, troubleshooting,
master-key rotation) see [docs/en/deployment.md](docs/en/deployment.md).

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
  the database — **losing the master key means the data is permanently unusable**
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
| Data | SQLite (Node 24's built-in `node:sqlite`, one file, no external service) |
| Authentication | iron-session 8 + bcryptjs (work factor 12) |
| Encryption | AES-256-GCM (Node `crypto`) + bcryptjs |
| Upstream AI | hand-written protocol translation over `fetch` |
| Testing | Vitest + Playwright |
| Deployment | systemd + nginx (config shipped in `deploy/`) |
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

**Only one variable is required, and no database service is needed:**

```bash
# Required: the master password (also the admin login password)
RELAY_AUTH="<openssl rand -hex 32>"

# Optional: where the database file lives; defaults to ./data/relayab.db
RELAY_DB_PATH="./data/relayab.db"
```

SQLite is driven by Node 24's built-in `node:sqlite` — **no npm dependency and
nothing to install**. Just run `pnpm dev` with `RELAY_DB_PATH` unset and it
creates `data/relayab.db` inside the repo; set `RELAY_DB_PATH=":memory:"` to
start from scratch on every restart.

**Set the public URL explicitly.** The endpoint shown on `/dashboard/docs` and
the welcome page is resolved from database settings, then `RELAY_PUBLIC_URL`,
then the request's `x-forwarded-proto` / `x-forwarded-host` headers. The last
one works when you sit behind nginx, but it is an implicit dependency: the
moment the proxy stops forwarding, every page advertises
`http://127.0.0.1:3000`. Set `RELAY_PUBLIC_URL` to your domain once the proxy
is in place.

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

### 3. Start the development server

The SQLite file under the repo, `./data/relayab.db`, is the default — it runs
with no environment variables set at all:

```bash
pnpm dev          # → http://localhost:3000
```

For a clean slate on every restart add `RELAY_DB_PATH=":memory:"` (which is what
the test suite does).

### 4. The first admin is created automatically!

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
| `/v1/chat/completions`, `/v1/responses` | the upstream's OpenAI-compatible base URL, e.g. `https://api.minimaxi.com/v1` |
| `/anthropic/v1/messages` | the upstream's Anthropic-compatible base URL, e.g. `https://api.minimaxi.com/anthropic` |

**The two base URLs of the same upstream are not interchangeable.** To make all
three endpoints work, create two providers:

```
MiniMax            kind=openai     baseUrl=https://api.minimaxi.com/v1        upstream format=Responses (native)
MiniMaxAnthropic   kind=anthropic  baseUrl=https://api.minimaxi.com/anthropic upstream format=Anthropic Messages
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
pnpm smoke               # end-to-end smoke: real dev server + mock upstream (local SQLite)
pnpm type-check          # TypeScript compile check
pnpm build               # Next.js production build
```

## Project structure

```
RelayAB/
├── deploy/              self-hosting config (systemd / nginx / env template)
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
| [docs/en/data-model.md](docs/en/data-model.md) | Tables, column names, indexes + field definitions |
| [docs/en/api-routes.md](docs/en/api-routes.md) | Complete API route specification |
| [docs/en/testing.md](docs/en/testing.md) | The test pyramid + tooling |
| [docs/en/admin.md](docs/en/admin.md) | Administrator guide (users / keys / providers) |
| [docs/en/deployment.md](docs/en/deployment.md) | Self-hosted architecture + database choice + smoke-test checklist + troubleshooting |
| [deploy/README.md](deploy/README.md) | Debian step-by-step runbook (Chinese) |

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
   the database; the **master key is `RELAY_MASTER_KEY_HEX`** — losing it means
   permanent data loss
4. **Session cookie**: encrypted with iron-session (HttpOnly + Secure + SameSite=Lax)
5. **A database leak alone is not fatal**: with the `.db` but without the env
   var, upstream keys cannot be decrypted
6. **Still, lock the file down**: `chmod 600`, owned by `relayab`. It holds
   usernames, `sha256(key)` values, plaintext `keyPrefix` values, and the
   encrypted upstream keys.

## Production deployment

Step-by-step runbook: [deploy/README.md](deploy/README.md). Design and
configuration detail: [docs/en/deployment.md](docs/en/deployment.md). The
environment variables that matter most:

| Name | Source |
|---|---|
| `RELAY_AUTH` | `openssl rand -hex 32` (admin login password + key derivation seed) — **the only required one** |
| `RELAY_DB_PATH` | recommended: set it explicitly, e.g. `/var/lib/relayab/relayab.db`. Unset, it defaults to `./data/relayab.db` |
| `RELAY_BUILD_ID` | version or commit sha, surfaced as `revision` in `/healthz` |
| `RELAY_PUBLIC_URL` | recommended: `https://your-domain` |
| `NODE_ENV` | `production` |
| `RELAY_ADMIN_USERNAME` | optional, defaults to `admin` |
| `RELAY_DEFAULT_LOCALE` | optional, default UI language `zh-CN` or `en` |
| `RELAY_MASTER_KEY_HEX` | optional, derived from `RELAY_AUTH` by default |

`SESSION_PASSWORD` and (by default) `RELAY_MASTER_KEY_HEX` are both derived from
`RELAY_AUTH`; there is nothing to generate by hand.

Data lands in `<cwd>/data/relayab.db` by default. In production set
`RELAY_DB_PATH` explicitly to put it outside the release directory, so a
`git pull` or a rebuild can never touch it.
