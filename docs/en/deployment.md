# Complete guide to deploying on Vercel

> Assumes you have already:
> - Forked / cloned the RelayAB project into your own GitHub account.
> - Registered a Vercel account (https://vercel.com).

---

## 1. One-click deploy

### 1.1 Import the project
1. Log in to the Vercel Dashboard.
2. **Add New → Project → Import** the GitHub repository you forked.
3. The Framework Preset is auto-detected as **Next.js**.
4. **Do not click Deploy yet** — first install the Upstash integration as described in §2.

### 1.2 Required environment variables

**Only one variable is truly required:**

| Name | Source | Notes |
| --- | --- | --- |
| `RELAY_AUTH` | Manual: `openssl rand -hex 32` | Master password. Doubles as the admin login password and as the session-key derivation seed |
| `UPSTASH_REDIS_REST_URL` | Injected automatically by the Vercel Marketplace | Upstash REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Injected automatically by the Vercel Marketplace | Upstash REST token |

> **You do not need to configure a public URL.** The endpoint address shown on the
> docs page and the welcome page falls back to `VERCEL_URL`, and when that is
> absent it reads the Host header of the current request — so both Vercel
> deployments and common self-hosted setups work with zero configuration.
> Only set `RELAY_PUBLIC_URL` to override when "the address users should call"
> differs from "the address they actually reach" (for example, a custom domain
> or a reverse proxy sits in front of the app).

**Derived automatically** (no manual setup needed):
- `SESSION_PASSWORD` — derived from `RELAY_AUTH` (HMAC-SHA256)
- `RELAY_MASTER_KEY_HEX` — derived from `RELAY_AUTH` by default (set it explicitly to rotate it independently)

**Optional**:
- `OPENAI_KEYS` — comma-separated list of keys; an OpenAI provider is created automatically on first run (rotation enabled when several keys are given)
- `ANTHROPIC_KEYS` — same, for the Anthropic provider
- `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` — override the default endpoint (Azure / self-hosted proxy)
- `RELAY_ADMIN_USERNAME` — admin username (default `admin`)
- `RELAY_DEFAULT_LOCALE` — default UI language, `zh-CN` (default) or `en`; visitors can still switch in the footer
- `VERCEL_PROTECTION_BYPASS` — bypass secret for deployment protection
- `EMULATE_VERCEL_LOCAL` — `"1"` enables the embedded Vercel mock (**local development only**)
- `RELAY_MASTER_KEY_HEX` — explicit master key (**set this when rotating independently of `RELAY_AUTH`**)

> ⚠️ **`AI_GATEWAY_API_KEY` is not read by this codebase.** Earlier versions of this
> document listed it as a way to route upstream traffic through the Vercel AI
> Gateway, and §4 below told you to set it. Nothing in `src/` or `scripts/` reads
> that variable, so setting it has **no effect**. It is left out of the table
> above deliberately.

### 1.3 Deploy
Click **Deploy**. Vercel runs `pnpm install && pnpm build`, then publishes to `*.vercel.app`.

---

## 2. Upstash for Redis (Vercel Marketplace integration) ⭐ recommended

> This is the official Marketplace integration on Vercel:
> - One-click install, creates an Upstash database automatically.
> - Credentials are injected into the project's environment variables automatically.
> - The region is chosen automatically as the one closest to your Vercel deployment.
> - Managed together with the Vercel project — no separate account to maintain.
>
> We call the REST API directly through the `@upstash/redis` SDK, which is
> **fully compatible with a standalone Upstash database**.

### 2.1 Installation steps

1. Open your Vercel project → the **Storage** tab.
2. Click **Create Database** → find **Upstash** under the **Marketplace** section.
   > You can also search for "Upstash" directly in the Vercel Dashboard.
3. Choose **Upstash for Redis**.
4. Configure:
   - **Plan**: Free (plenty — 30k requests/day, 256 MB storage)
   - **Region**: the default is fine, Vercel picks the closest region
   - **Name**: changeable, defaults to `relayab-redis`
5. Click **Create** and accept the Marketplace terms.
6. Vercel then automatically:
   - creates an Upstash database
   - binds the following environment variables to **all environments** (Production / Preview / Development):
     - `UPSTASH_REDIS_REST_URL`
     - `UPSTASH_REDIS_REST_TOKEN`
   - (optionally) in some cases also `KV_REST_API_URL` / `KV_REST_API_TOKEN` (the Vercel KV naming convention, **which we do not use**)

### 2.2 Verify the integration

After the deployment finishes, check in Vercel Dashboard → Project → **Settings → Environment Variables** that:
- `UPSTASH_REDIS_REST_URL` exists
- `UPSTASH_REDIS_REST_TOKEN` exists

Check the Functions logs to see whether startup succeeded:
```
[relayab] redis: connected to https://xxx.upstash.io
```

### 2.3 Why not Vercel KV?

Vercel KV was superseded by **Upstash for Redis** in 2024 (Vercel unified its storage backend on Upstash). The underlying API is identical, but the Marketplace integration is more stable. We use the `@upstash/redis` SDK directly and depend on no Vercel private package.

### 2.4 Backup strategy

- Free plan: automatic daily backups, 1 day of retention.
- In the Upstash Console (click "Open in Upstash" at the top right of the Marketplace card) you can trigger an Export manually.
- Recommend a manual Export once a week.

### 2.5 If you prefer not to use the Marketplace integration

You can also sign up for a standalone Upstash account (https://upstash.com), create a database by hand, and fill `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` into the Vercel environment variables. **There is zero impact on the code** — the SDK call path is exactly the same.

---

## 3. First run and bootstrap

Bootstrap is **lazy**: after the deployment finishes, the first request that actually
touches the app (submitting the login form, visiting any page/endpoint that reads
the session, or calling the proxy endpoint with a key) triggers a single bootstrap;
it never runs again afterwards (once per instance, and a failure is retried on the
next request).

When you visit `https://your-app.vercel.app/login` you will see:

- **The admin account has been created automatically**
  - Username: `admin` (or your custom `RELAY_ADMIN_USERNAME`)
  - Password: your `RELAY_AUTH` value

- **The upstream provider has been created automatically** (if `OPENAI_KEYS` / `ANTHROPIC_KEYS` are set)
  - Several keys create several provider entities (with rotation enabled)
  - The default model mapping covers common models such as gpt-4o / gpt-4o-mini / claude-3-5-sonnet

- **If no upstream key is set**, add one by hand at `/admin/providers` after logging in

**Recommended immediately after the first login**:
1. Change your own password at `/admin/users` (or reset a new one)
2. Create a regular user at `/admin/users`
3. Create an API key for each user at `/admin/keys` (the plaintext is shown only once!)
4. Confirm / add the upstream provider at `/admin/providers`
5. Hand the customer keys out to the users

### Creating the admin manually with no environment variables locally

If you would rather not derive the password from `RELAY_AUTH`, use the script:

```bash
pnpm bootstrap-admin --username admin --password <your-password>
```

This script creates the admin account and returns immediately.

## 4. Routing Upstream Traffic Through the Vercel AI Gateway (optional)

If you want upstream traffic to go through the Vercel AI Gateway instead of calling
OpenAI/Anthropic directly:

1. Create a key in Vercel Dashboard → **AI Gateway → API Keys**.
2. Add a provider in `/admin/providers` with:
   - **API base URL** = `https://ai-gateway.vercel.sh/v1`
   - **upstream key** = the AI Gateway key (paste it into the provider's key field)
   - **Kind** stays `openai` or `anthropic` — the Gateway speaks those protocols
3. Map the models you want to route through it.

This way the Vercel AI Gateway adds its own quota / rate limiting, which stacks on
top of RelayAB's.

> ⚠️ There is **no `AI_GATEWAY_API_KEY` environment variable** in this codebase.
> Earlier versions of this section told you to set one; nothing reads it, so it did
> nothing. The gateway key goes into the **provider's own key field**, like any
> other upstream key — which is encrypted with AES-256-GCM before being stored.

---

## 5. Connecting real upstream API keys

### 5.1 Adding a provider
1. Log in to RelayAB → **/admin/providers → New Provider**.
2. Fill in:
   - Name: `OpenAI Production`
   - Kind: `openai`
   - API Key: `sk-...` (taken from the OpenAI Dashboard)
   - Model Mapping: `{ "gpt-4o-mini": "gpt-4o-mini-2024-07-18", "gpt-4o": "gpt-4o-2024-08-06" }`
3. Save.

Plaintext keys are **never persisted** — RelayAB encrypts them with `RELAY_MASTER_KEY_HEX` and stores the ciphertext in Redis.

### 5.2 Model mapping strategy
- The `model` field in a client request is treated as a "logical name".
- The admin writes "logical name → real upstream model name" in the model mapping.
- If the mapping does not match: in v1 the client's `model` is forwarded verbatim (suits the case where the provider itself is the naming authority).

---

## 6. Embedded Vercel API mock (development mode)

During local development, `src/app/api/_emu/[...path]/route.ts` is enabled:
- When `EMULATE_VERCEL_LOCAL === "1"` and `NODE_ENV !== "production"`.
- All SDK calls to `https://api.vercel.com/*` are redirected to `http://localhost:3000/api/_emu/*`.
- This lets you test everything locally without any external service.

**It must be off in production** (it is off by default), otherwise users will be served mock data.

---

## 7. Bypassing deployment protection

### 7.1 When you need it
When the Vercel project has **Deployment Protection** enabled (Settings → Deployment Protection → Enabled):
- Every request (including API calls) is intercepted by Vercel with an SSO login.
- Client SDKs can no longer call the API normally.

### 7.2 Generating a bypass secret
1. Vercel Dashboard → your project → **Settings → Deployment Protection**.
2. Find the **Protection Bypass** section → enter an easy-to-remember secret → **Add**.
3. Copy the generated **Bypass Secret** (shown once — store it in a password manager).

### 7.3 Using it with RelayAB

#### Scenario A: client SDK calls
Have users add a header in their own OpenAI client configuration:
```typescript
import OpenAI from "openai";
const client = new OpenAI({
  apiKey: "sk-relay-xxx",
  baseURL: "https://your-app.vercel.app/v1",
  defaultHeaders: {
    "x-vercel-protection-bypass": "<your-bypass-secret>",
  },
});
```

#### Scenario B: server-side internal calls
`src/middleware.ts` injects it automatically:
```typescript
if (process.env.VERCEL_PROTECTION_BYPASS) {
  headers.set("x-vercel-protection-bypass", process.env.VERCEL_PROTECTION_BYPASS);
}
```

### 7.4 Security advice
- A bypass secret is equivalent to "can bypass Vercel authentication" — if it leaks, anyone can get in.
- Requests only really reach RelayAB after your `sk-relay-xxx` API key has also been validated → two layers of protection.
- Never commit the bypass secret to Git.

---

## 8. Smoke test checklist (tick off each item after deploying)

### 8.1 Basics
- [ ] Visiting `https://your-app.vercel.app/healthz` returns `{"ok":true,...}`.
- [ ] The `/login` page renders correctly.
- [ ] You can log in with the bootstrapped admin account.
- [ ] After login you are redirected to `/admin`.

### 8.2 Administration
- [ ] Create a test user at `/admin/users`.
- [ ] Create a key for that user (set `quotaType=credits`, `quotaLimit=100000`, i.e. 100 credits).
- [ ] Copy the plaintext key (shown only once).
- [ ] The key shows up in the list at `/admin/keys`.
- [ ] Disable the key, then re-enable it, and confirm the status switches correctly.

### 8.3 Providers
- [ ] Add a real OpenAI provider at `/admin/providers` (with your own OpenAI key).
- [ ] Add an Anthropic provider.

### 8.4 Proxy calls
- [ ] Call `/v1/chat/completions` with `curl`, passing `Authorization: Bearer sk-relay-xxx`:
  ```bash
  curl -X POST https://your-app.vercel.app/v1/chat/completions \
    -H "Authorization: Bearer sk-relay-xxx" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"say hi"}]}'
  ```
- [ ] The response contains `usage.total_tokens`.
- [ ] Visit `/admin/usage` again and confirm `creditsUsed` increased (accumulated at 0.001-credit precision).

### 8.5 User dashboard
- [ ] Log in with the test user account (not admin).
- [ ] Open `/dashboard` and you can see your own keys.
- [ ] Inspect the per-key usage details.

### 8.6 Security
- [ ] Calling `/api/admin/users` directly (no cookie) → 401.
- [ ] Calling `/v1/chat/completions` with a disabled key → 403 key_disabled.
- [ ] Calling with an expired key → 403 key_expired.
- [ ] Calling with a key whose quota is exhausted → 403 `quota_exceeded_credits`.
- [ ] In the Upstash Console, search `relay:user:*` and confirm `passwordHash` is a bcrypt hash.
- [ ] In the Upstash Console, search `relay:provider:*` and confirm `encryptedApiKey` is base64 ciphertext.

---

## 9. Troubleshooting

### 9.1 500 errors after deploying
- Check the Vercel function logs: `Dashboard → Deployments → click into it → Functions`.
- Most common cause: missing environment variables (confirm that `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` were injected automatically by the Marketplace).

### 9.2 The Marketplace integration did not take effect
- Vercel Dashboard → Project → **Storage** → confirm the Upstash database card shows **Connected**.
- If it shows **Not Connected**: click into the card → **Connect to Project**.

### 9.3 Calls return `model_not_mapped`
- Check `/admin/providers` and make sure the model mapping contains the requested model.
- Check that the provider is enabled.

### 9.4 Calls time out
- Vercel Hobby functions run for at most 10 seconds (streaming can be extended to 30 seconds).
- Pro allows up to 60 seconds.
- Extremely long streaming responses may get truncated → consider chunking (v2).

### 9.5 Upstash connection errors
- In the Upstash Console (click "Open in Upstash" on the Marketplace card), under the **Connect** tab, verify the credentials with cURL.
- Check whether the region is very far from your Vercel region.

### 9.6 The embedded mock shows up in production
- Confirm that `EMULATE_VERCEL_LOCAL` is unset or `"0"`.
- `src/app/api/_emu/[...path]/route.ts` has a production guard at the top.

---

## 10. Upgrades / maintenance

### 10.1 Upgrading dependencies
```bash
pnpm update --latest
```
Then run the full test suite locally + verify in a preview deployment.

### 10.2 Master key rotation (important)
1. Generate a new master key: `openssl rand -hex 32`.
2. Run `pnpm rotate-key` (which runs `scripts/rotate-master-key.ts`; it needs the
   old key as `OLD_RELAY_MASTER_KEY_HEX` and the new one as `RELAY_MASTER_KEY_HEX`).
3. Re-encrypt the `encryptedApiKey` of every `relay:provider:*` with the new master key.
4. Update the Vercel environment variable `RELAY_MASTER_KEY_HEX`.
5. Redeploy.

> ⚠️ **Losing the master key means losing every upstream key permanently** — they
> are stored as AES-256-GCM ciphertext keyed by it, and there is no recovery path.
> Take a copy of `RELAY_MASTER_KEY_HEX` somewhere safe before rotating.

### 10.3 Data export / import

> ⚠️ **There are no export/import scripts.** Earlier versions of this section told
> you to run `scripts/export-data.ts` and `scripts/import-data.ts`; **neither file
> exists**. `scripts/` contains only `bootstrap-admin.ts`, `check-env.ts`,
> `list-usage.ts`, `reset-user-password.ts`, `rotate-master-key.ts`,
> `smoke-local.sh` and `spec-check.ts`.
>
> For now, a backup means dumping Redis yourself — the data lives in the standard
> `relay:*` keys, so a `SCAN`-based export of that namespace is sufficient.
