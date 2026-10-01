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
                                  │  node:sqlite (in-process)
                 ┌────────────────▼─────────────────────────┐
                 │  /var/lib/relayab/relayab.db              │
                 │   users / api_keys / providers            │
                 │   usage_logs / settings / meta            │
                 └──────────────────────────────────────────┘
```

Three things that matter:

1. **The database is a file** — no listening port, no password, no service to
   babysit. The firewall needs no rule for it.
2. **nginx must disable response buffering**, or SSE streaming degrades into
   "hang, then dump everything at once".
3. **RelayAB must start from the repository root** — two admin pages read files
   out of the checkout at request time.

---

## 2. Environment variables

**One required:**

| Name | Source | Notes |
|---|---|---|
| `RELAY_AUTH` | manual: `openssl rand -hex 32` | master password; also seeds the admin login and session key |

**Strongly recommended:**

| Name | Notes |
|---|---|
| `RELAY_DB_PATH` | Path to the database file. Unset, it defaults to `./data/relayab.db` under the working directory. **Set it explicitly in production** and put the file outside the release directory, so `git pull` and a rebuild can never touch it |
| `RELAY_BUILD_ID` | manual: version or commit sha; surfaced as `revision` in `/healthz`. Without it there is no `revision` at all (see the note below) |
| `RELAY_PUBLIC_URL` | `https://your.domain`. Without it the app falls back to nginx's `X-Forwarded-*` headers, which works but adds an implicit dependency |
| `NODE_ENV` | `production` |

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

### 3.1 SQLite (the self-hosting default)

The store is **one file**, driven by Node 24's built-in `node:sqlite` — no npm
dependency, nothing to install:

```bash
# create the directory and point the app at a database outside the release tree
sudo mkdir -p /var/lib/relayab
sudo chown relayab:relayab /var/lib/relayab
echo 'RELAY_DB_PATH="/var/lib/relayab/relayab.db"' >> /opt/relayab/.env.production
```

**Why this is the least moving parts:**

- **Nothing to install.** No `apt install valkey-server`, no systemd unit, no
  port, no password. One fewer listening port, one fewer password, one fewer
  failure mode.
- **Backup is copying the file** (see §7), and restoring is copying it back.
- **Constraints are the database's job.** Username uniqueness, key uniqueness and
  delete-user-cascades-to-keys used to be maintained carefully in application
  code; they are now a `UNIQUE` and an `ON DELETE CASCADE`.
- Write concurrency is serialised with WAL plus `BEGIN IMMEDIATE`, and
  `busy_timeout = 5000` turns a lock collision into a short wait instead of an
  immediate `SQLITE_BUSY`.

The cost is a single file on a single machine: no built-in high availability and
nothing reachable over the network — **a sensible trade for single-box
self-hosting**, but it means backups are on you (see §7 and the risk table in
architecture.md).

### 3.2 Staying on hosted Upstash

Still supported: set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` and
the app uses the HTTP REST transport.

Worth it when the app and the data store must live separately, or when you do not
want state sitting on local disk. The cost is that every Redis command becomes an
HTTP request. **The two variables must be set together** — setting only one does
not silently fall back to the local file; `/healthz` reports `degraded` and names
the missing half.

> The local TCP transport (`REDIS_URL` / `ioredis`) was **removed along with this
> migration**. Older docs said `REDIS_URL` took precedence over Upstash; that is
> no longer true and setting it does nothing.

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

Expect:

```json
{"ok":true,"data":{"status":"ok","storage":"sqlite","env":{"required":1,"configured":1},"revision":"v179"}}
```

The fields are nested under `data`, with `required` / `configured` one level
deeper still, inside `data.env`.

`storage` tells you which store is live:

| Value | Meaning |
|---|---|
| `sqlite` | the local SQLite file — the normal self-hosting case. Needs no configuration at all |
| `upstash` | the REST transport — this only appears if you **explicitly set `UPSTASH_REDIS_REST_*`**. Seeing it when you did not intend to is a sign the variables are being read |
| `memory` | in-process store. **Should never appear in production** |

`required` follows `storage`: SQLite needs only `RELAY_AUTH` (1), while the
hosted Redis path also needs the URL and token pair (3).

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
`RELAY_MASTER_KEY_HEX` (AES-256-GCM) before writing them to the database.

### Routing through a gateway

To reach upstreams via a third-party gateway (AI Gateway, unified proxy, …) you
need **no environment variable at all**: set the provider's API base URL to the
gateway and paste the gateway key into the provider's own key field. It is stored
and encrypted exactly like any other upstream key.

---

## 6. Smoke-test checklist

### 6.1 Basics
- [ ] `curl https://your.domain/healthz` returns `{"ok":true,...}` with `storage: sqlite`
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
- [ ] The database file exists and is outside the release directory: `ls -l /var/lib/relayab/relayab.db`
- [ ] The file is not world-readable: `chmod 600 /var/lib/relayab/relayab.db`
- [ ] `sqlite3 /var/lib/relayab/relayab.db "SELECT password_hash FROM users LIMIT 1;"` shows a bcrypt hash
- [ ] `sqlite3 /var/lib/relayab/relayab.db "SELECT encrypted_api_key FROM providers LIMIT 1;"` shows base64 ciphertext

---

## 7. Backups

All state lives in one file, so a backup is a file copy:

```bash
sudo cp /var/lib/relayab/relayab.db /var/backups/relayab-$(date +%F).db
```

WAL mode also creates `-wal` and `-shm` side files, so a plain `cp` while the
service is running can capture an inconsistent snapshot. Two safe approaches:

```bash
# Option A: sqlite3's online backup API (no downtime)
sudo -u relayab sqlite3 /var/lib/relayab/relayab.db \
  ".backup /var/backups/relayab-$(date +%F).db"

# Option B: stop the service, then copy
sudo systemctl stop relayab
sudo cp /var/lib/relayab/relayab.db /var/backups/relayab-$(date +%F).db
sudo systemctl start relayab
```

A daily cron entry is worth adding. Usage logs are business records — archive
them separately.

> **No export/import scripts exist.** Earlier revisions of this doc told you to
> run `scripts/export-data.ts` and `scripts/import-data.ts`; neither file exists.
> The database file *is* the backup.

### Migrating from the old Redis deployment

Older RelayAB releases kept their data in Redis keys (`relay:user:*` and
friends). **There is no automated migration tool in the repository.** Two
practical routes:

- **Small dataset, and you want a clean slate**: start fresh and re-add your
  upstream providers in the admin panel; users and balances begin from zero.
- **History must be preserved**: export a dump from the old Redis instance, read
  it out on a machine with Redis/Valkey installed, and write the rows table by
  table into the new `.db` using the column names in
  [data-model.md §1–§4](data-model.md). Mind the differences in shape between
  the two: `0/1` vs `1/2` for booleans, CSV vs JSON text for `allowed_models`,
  epoch vs ISO strings for timestamps. There is no shortcut here.

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
Check `storage` first.

- It says `sqlite` and requests still fail → the **database file is probably not
  writable**: check that `/var/lib/relayab` exists and that both it and the file
  are owned by `relayab`.
- It says `upstash` when you meant the local file → look for leftover
  `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` in the environment.
- The `missing` array names variables → systemd is not loading
  `.env.production` (`journalctl -u relayab | grep -i env`).

### 8.5 SQLite errors in the log
```bash
sudo -u relayab sqlite3 /var/lib/relayab/relayab.db "PRAGMA integrity_check;"  # corrupt?
df -h /var/lib                                          # a full disk reports SQLITE_FULL
sudo journalctl -u relayab -n 100 --no-pager | grep -i sqlite
```

The two common ones are `SQLITE_CANTOPEN` (directory missing or wrong owner) and
`SQLITE_READONLY` (the service user cannot write the file). `SQLITE_BUSY` means
another process holds the write lock — under WAL `busy_timeout` waits 5 seconds
before giving up, so an occasional one is harmless, but a persistent stream means
you are probably running two instances.

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

`git pull` and the rebuild cannot touch your data **as long as `RELAY_DB_PATH`
points outside `/opt/relayab`** — which is why setting it explicitly (see §3.1)
matters even though the default would also work on a fresh machine.

### 9.2 Rotating the master key (important)
1. `openssl rand -hex 32`
2. `pnpm rotate-key` (pass the old key as `OLD_RELAY_MASTER_KEY_HEX`, the new
   one as `RELAY_MASTER_KEY_HEX`)
3. Re-encrypt `encrypted_api_key` on every row of the `providers` table
4. Update `RELAY_MASTER_KEY_HEX` in `.env.production`
5. `sudo systemctl restart relayab`

> ⚠️ **Losing the master key = permanently losing every upstream key.** They are
> stored as AES-256-GCM ciphertext seeded with it, with no recovery path.

> Changing `RELAY_AUTH` has the same blast radius (it invalidates all sessions).
> Set `RELAY_MASTER_KEY_HEX` explicitly to decouple the two.
