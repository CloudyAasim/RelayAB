# Complete Debian Deployment Guide

> This covers self-hosting. For the step-by-step runbook see
> **[`deploy/README.md`](../../deploy/README.md)** (Chinese); this file explains
> *why* each step matters and what to verify afterwards.
>
> Assumed:
> - A Debian 12/13 server
> - A domain with an A record pointing at it

---

## 1. Architecture

```
                 ┌──────────────────────────────────────────┐
   internet ───▶ │  nginx  :443                              │
                 │   ├─ TLS termination (Let's Encrypt)      │
                 │   ├─ reverse proxy → 127.0.0.1:3000      │
                 │   └─ SSE buffering disabled              │
                 └────────────────┬─────────────────────────┘
                                  │
                 ┌────────────────▼─────────────────────────┐
                 │  RelayAB  (systemd, node)                │
                 │   next start, WorkingDirectory=repo root  │
                 │   /v1/*  /anthropic/*  /api/*  admin UI   │
                 └────────────────┬─────────────────────────┘
                                  │  TCP (ioredis)
                 ┌────────────────▼─────────────────────────┐
                 │  Valkey 8.1  127.0.0.1:6379               │
                 │   users / keys / balances / usage logs   │
                 └──────────────────────────────────────────┘
```

Three things that matter:

1. **Valkey listens on `127.0.0.1` only** and is never exposed. No need to open 6379.
2. **nginx must disable response buffering**, or SSE streaming degrades into
   "hang, then dump everything at once".
3. **RelayAB must start from the repository root** — two admin pages read files
   out of the checkout at request time.

---

## 2. Environment variables

**Three required:**

| Name | Source | Notes |
|---|---|---|
| `RELAY_AUTH` | manual: `openssl rand -hex 32` | master password; also seeds the admin login and session key |
| `REDIS_URL` | manual: `redis://:<password>@127.0.0.1:6379` | self-hosted Valkey connection string |
| `RELAY_BUILD_ID` | manual: version or commit sha | surfaced as `revision` in `/healthz` |

**Strongly recommended:**

| Name | Notes |
|---|---|
| `RELAY_PUBLIC_URL` | `https://your.domain`. Without it the app falls back to nginx's `X-Forwarded-*` headers, which works but adds an implicit dependency |
| `NODE_ENV` | `production` |
| `EMULATE_VERCEL_LOCAL` | must be `0` (or unset), or nothing is persisted |

**Derived automatically** (do not set):
- session key — HMAC-SHA256 from `RELAY_AUTH`
- `RELAY_MASTER_KEY_HEX` — derived from `RELAY_AUTH` unless set explicitly

**Optional:**
- `OPENAI_KEYS` / `ANTHROPIC_KEYS` — comma-separated; auto-creates providers on first boot
- `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` — endpoint overrides (Azure / self-hosted proxy)
- `RELAY_ADMIN_USERNAME` — default `admin`
- `RELAY_DEFAULT_LOCALE` — `zh-CN` (default) or `en`
- `RELAY_MASTER_KEY_HEX` — explicit master key (set this to decouple it from `RELAY_AUTH`)

> **Why `RELAY_BUILD_ID` deserves its own row:** on Vercel, `/healthz` read
> `revision` from `VERCEL_GIT_COMMIT_SHA`, which the platform injected for free.
> Self-hosted there is no such variable, so without `RELAY_BUILD_ID` the field
> is `null` and you cannot answer "which build is actually live" — the single
> most useful fact when debugging a deployment. Have your deploy script write
> `git rev-parse --short HEAD` into it.

Full template: [`deploy/env.production.example`](../../deploy/env.production.example).

---

## 3. Database options

### 3.1 Valkey (recommended, the self-hosting default)

Debian 13 (trixie) ships `valkey-server` in its main archive:

```bash
sudo apt install -y valkey-server valkey-tools
```

Valkey is the community fork of Redis 7.2.4 (Linux Foundation, BSD). It is
**wire- and command-compatible**, so ioredis needs no changes. Debian also
carries `redis-server 8.x`; the licence difference (AGPLv3 vs BSD) has no
practical effect when you self-host, because AGPL's network clause only bites
when you run a *modified* copy as a service for others.

See [`deploy/valkey.conf.example`](../../deploy/valkey.conf.example). The one
line that must be right:

```conf
maxmemory-policy noeviction
```

**Why it has to be noeviction:** RelayAB stores **authoritative** data in Redis —
users, API keys, balances, usage logs, quotas. Valkey is an in-memory store, so
once `maxmemory` is reached, a policy like `allkeys-lru` will *silently evict*
those records: no error, endpoints keep returning 200, but quotas and usage logs
vanish. `noeviction` fails loudly instead, which is the safe behaviour.

### 3.2 Staying on hosted Upstash

Still supported: set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` and
the app uses the HTTP REST transport. `REDIS_URL` takes precedence when present.

Worth it when you do not want to operate a database, or when the app and the data
store live separately. The cost is that every Redis command becomes an HTTP
request (the code already batches them into pipelines — see `hgetallMany`).

---

## 4. First boot and bootstrap

Bootstrapping is **lazy**: the first request that actually touches the app
(submitting the login form, opening a page that reads the session, or calling
the proxy with a key) triggers it once. It never runs again per instance, and a
failure is retried on the next request.

Visiting `https://your.domain/login`:

- **The admin account is created automatically**
  - username: `admin` (or `RELAY_ADMIN_USERNAME`)
  - password: your `RELAY_AUTH` value

- **Upstream providers are auto-created** if `OPENAI_KEYS` / `ANTHROPIC_KEYS` are set
  - multiple keys create multiple provider entities (rotation enabled)

**Right after the first login:**
1. Change your own password in `/admin/users`
2. Create regular users in `/admin/users`
3. Issue API keys in `/admin/keys` (plaintext is shown once!)
4. Confirm/add upstream providers in `/admin/providers`
5. Distribute the keys

### Creating the admin manually

```bash
cd /opt/relayab
pnpm bootstrap-admin --username admin --password <your-password>
```

### Verifying configuration

```bash
curl -s https://your.domain/healthz | jq
```

Expect `{"ok":true,"status":"ok","storage":"redis",...}`.

`storage` is new in this deployment model and tells you which transport is live:

| Value | Meaning |
|---|---|
| `redis` | TCP transport via `REDIS_URL` — correct for self-hosting |
| `upstash` | REST transport. If you meant to use local Valkey, `REDIS_URL` is not being read |
| `memory` | in-memory store. **Should never appear in production** — `EMULATE_VERCEL_LOCAL` is misconfigured |

---

## 5. Wiring up real upstream keys

1. Sign in → **/admin/providers → New Provider**.
2. Fill in:
   - Name: `OpenAI Production`
   - Kind: `openai`
   - API Key: `sk-...`
   - Model Mapping: `{ "gpt-4o-mini": "gpt-4o-mini-2024-07-18" }`
3. Save.

Plaintext keys are **never persisted** — RelayAB encrypts them with
`RELAY_MASTER_KEY_HEX` (AES-256-GCM) before writing to Redis.

### Routing through a gateway

To reach upstreams via a third-party gateway (AI Gateway, unified proxy, …) you
need **no environment variable at all**: set the provider's API base URL to the
gateway and paste the gateway key into the provider's own key field. It is stored
and encrypted exactly like any other upstream key.

---

## 6. Smoke-test checklist

### 6.1 Basics
- [ ] `curl https://your.domain/healthz` returns `{"ok":true,...}` with `storage: redis`
- [ ] `revision` shows your `RELAY_BUILD_ID` (not `null`)
- [ ] `/login` renders
- [ ] Bootstrap admin can sign in
- [ ] Redirects to `/admin`

### 6.2 Administration
- [ ] Create a test user in `/admin/users`
- [ ] Issue a key for them (`quotaType=credits`, `quotaLimit=100000`)
- [ ] Copy the plaintext key (shown once)
- [ ] Disable then re-enable the key, confirm the state flips

### 6.3 Providers
- [ ] Add a real upstream provider in `/admin/providers`
- [ ] If you use image/audio/video, confirm `/admin/media-providers`

### 6.4 Proxy calls
- [ ] Non-streaming:
  ```bash
  curl -X POST https://your.domain/v1/chat/completions \
    -H "Authorization: Bearer sk-relay-xxx" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"say hi"}]}'
  ```
- [ ] Response contains `usage.total_tokens`
- [ ] **Streaming must arrive token by token** (not all at once):
  ```bash
  curl -N -X POST https://your.domain/v1/chat/completions \
    -H "Authorization: Bearer sk-relay-xxx" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"count to 20"}]}'
  ```
  > `-N` disables curl's own buffering. If this looks fine but a browser client
  > stutters, nginx buffering is misconfigured — see §8.1.
- [ ] `/admin/usage` shows the increased consumption

### 6.5 User dashboard
- [ ] Sign in as the test user (not admin)
- [ ] `/dashboard` lists their keys
- [ ] Per-key usage detail renders

### 6.6 Security
- [ ] Unauthenticated `GET /api/admin/users` → 401
- [ ] Disabled key → 403 `key_disabled`
- [ ] Expired key → 403 `key_expired`
- [ ] Exhausted quota → 403 `quota_exceeded_credits`
- [ ] Port 6379 is not publicly reachable: `ss -tlnp | grep 6379` must show only `127.0.0.1:6379`
- [ ] `valkey-cli -a '<password>' hgetall relay:user:<id>` shows a bcrypt `passwordHash`
- [ ] `valkey-cli -a '<password>' hgetall relay:provider:<id>` shows a base64 `encryptedApiKey`

---

## 7. Backups

All state lives under the standard `relay:*` key namespace, so a backup is a
backup of Redis itself:

```bash
valkey-cli -a '<password>' --rdb /var/backups/relayab-$(date +%F).rdb
```

A daily cron entry is worth adding. Usage logs are business records — archive
them separately.

Migrating from the old Upstash instance uses the same mechanism: export an RDB
and load it. **No transformation needed** — what is stored is plain strings;
Upstash's automatic `JSON.parse` was a client behaviour, not a data format.

> **No export/import scripts exist.** Earlier revisions of this doc told you to
> run `scripts/export-data.ts` and `scripts/import-data.ts`; neither file exists.

---

## 8. Troubleshooting

### 8.1 Streaming hangs, then dumps at once
nginx response buffering. The site config needs:
```nginx
proxy_buffering off;
proxy_cache off;
proxy_set_header X-Accel-Buffering no;
proxy_set_header Connection "";
```
Then `sudo nginx -t && sudo systemctl reload nginx`.

### 8.2 Docs pages show `http://127.0.0.1:3000`
nginx is not forwarding `X-Forwarded-Proto` / `X-Forwarded-Host`, or
`RELAY_PUBLIC_URL` is unset. The former is the cause; the latter is the cheap
belt-and-braces fix.

### 8.3 Admin doc pages say "could not read"
systemd's `WorkingDirectory` is not the repo root, or only `.next` was deployed.
`src/components/docs/ProtocolReference.tsx` and `SpecCheckReference.tsx` read
from the checkout via `process.cwd()`, so a full clone is required.

### 8.4 `/healthz` says ok but endpoints 500
Check `storage` first. If it is `unconfigured`, `REDIS_URL` is not being read —
look for a value starting with `http://` (only `redis://` / `rediss://` select
the TCP transport), or check systemd is actually loading the file
(`journalctl -u relayab | grep -i env`).

### 8.5 Redis connection errors in the log
```bash
valkey-cli -a '<password>' ping          # is the password right
sudo systemctl status valkey-server      # is it up
```
ioredis runs with `maxRetriesPerRequest: 3`, so requests during a Valkey restart
fail fast instead of hanging.

### 8.6 The service exits immediately
```bash
sudo journalctl -u relayab -n 100 --no-pager
```
Usually an absolute-path problem in `EnvironmentFile`, or `RELAY_AUTH` shorter
than 8 characters.

### 8.7 Calls return `model_not_mapped`
Check the provider's model mapping and that the provider is enabled.

### 8.8 Long responses get truncated
Proxy routes set `maxDuration = 300`; give nginx more headroom with
`proxy_read_timeout 600s`.

---

## 9. Upgrades and maintenance

### 9.1 Upgrading
```bash
cd /opt/relayab
git pull
corepack pnpm install --frozen-lockfile
corepack pnpm build
sudo systemctl restart relayab
```

**Update `RELAY_BUILD_ID` after every upgrade**, otherwise `/healthz` still
reports the old revision and you will think the deploy did not land.

### 9.2 Rotating the master key (important)
1. `openssl rand -hex 32`
2. `pnpm rotate-key` (pass the old key as `OLD_RELAY_MASTER_KEY_HEX`, the new
   one as `RELAY_MASTER_KEY_HEX`)
3. Re-encrypt `encryptedApiKey` on every `relay:provider:*`
4. Update `RELAY_MASTER_KEY_HEX` in `.env.production`
5. `sudo systemctl restart relayab`

> ⚠️ **Losing the master key = permanently losing every upstream key.** They are
> stored as AES-256-GCM ciphertext seeded with it, with no recovery path.

> Changing `RELAY_AUTH` has the same blast radius (it invalidates all sessions).
> Set `RELAY_MASTER_KEY_HEX` explicitly to decouple the two.
