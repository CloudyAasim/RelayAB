# Test Strategy and Conventions

> Test pyramid: **unit → integration → smoke (end-to-end)**.
> Every module ships code plus at least one matching test file.

```bash
pnpm test          # unit + integration (no network dependency)
pnpm smoke         # end-to-end smoke: real next dev + in-memory Redis + mock upstream
pnpm type-check && pnpm build
```

---

## 1. Unit Tests (Vitest)

### 1.1 Coverage

There are currently **66 unit test files**. The table below is a **representative
sample**, not an exhaustive index — run `ls tests/unit/` for the full list.

| Area | Representative files |
| --- | --- |
| Config / derived keys | `tests/unit/config.test.ts`, `config-public-url.test.ts` |
| `crypto/secrets` (AES-256-GCM) | `tests/unit/crypto-secrets.test.ts` |
| `crypto/hashing` (sha256 / prefix) | `tests/unit/crypto-hashing.test.ts` |
| `crypto/password` (bcrypt, including the sync variant) | `tests/unit/crypto-password.test.ts` |
| Session (iron-session options) | `tests/unit/auth-session.test.ts` |
| Bearer parsing + key validation | `tests/unit/auth-apikey.test.ts` |
| Error vocabulary | `tests/unit/api-errors.test.ts` |
| The in-memory Redis mock itself | `tests/unit/memory-redis.test.ts`, `redis-client.test.ts` |
| Types / schema | `tests/unit/db-types.test.ts` |
| Built-in bootstrap flow | `tests/unit/bootstrap.test.ts` |
| Quota | `tests/unit/quota-rates.test.ts`, `quota-calculator.test.ts`, `credit-pool.test.ts` |
| Credits | `tests/unit/credits.test.ts` |
| **Concurrency** | `tests/unit/concurrency.test.ts` |
| **Login throttling** | `tests/unit/login-throttle.test.ts` |
| **Security hardening** | `tests/unit/security-hardening.test.ts` |
| `proxy/openai` | `tests/unit/proxy-openai.test.ts`, `proxy-openai-stream.test.ts` |
| `proxy/anthropic` | `tests/unit/proxy-anthropic.test.ts`, `proxy-anthropic-stream.test.ts`, `proxy-anthropic-thinking.test.ts` |
| **Streaming edge cases** | `tests/unit/proxy-stream-disconnect.test.ts`, `proxy-strip-stream-options.test.ts`, `stream-stopgap.test.ts` |
| **Responses protocol conversion** | `tests/unit/proxy-responses-conversion.test.ts` |
| **Media engine** | `tests/unit/media-engine.test.ts`, `media-engine-hardening.test.ts`, `media-engine-iterator.test.ts`, `media-fetch.test.ts` |
| **Media protocol + the judge** | `tests/unit/media-spec-v2.test.ts`, `media-spec-check.test.ts`, `spec-check-standalone.test.ts` |
| **Protocol document** | `tests/unit/media-protocol-doc.test.ts`, `docs-spec-check-page.test.ts` |
| **Middleware** | `tests/unit/middleware-cors.test.ts`, `middleware-v1-clean.test.ts` |
| **i18n** | `tests/unit/i18n.test.ts`, `i18n-dict.test.ts`, `i18n-dict-hygiene.test.ts`, `i18n-usage.test.ts` |
| **Timezone handling** | `tests/unit/timezone.test.ts` |
| **Usage reporting** | `tests/unit/usage-load.test.ts`, `usage-recent.test.ts`, `usage-report.test.ts`, `usage-totals.test.ts`, `usage-view-prefs.test.ts` |
| **UI invariants** | `tests/unit/ui-invariants.test.ts`, `ui-primitives.test.ts`, `nav-*.test.ts`, `card-padding.test.ts` |
| **License / route surfaces** | `tests/unit/license-completeness.test.ts`, `public-path-routes.test.ts` |

### 1.2 Tooling
- Pure functions with no side effects, so no mocks are needed.
- `vitest`'s built-in assertions plus `@vitest/expect`.

### 1.3 Running
```bash
pnpm test:unit
```

---

## 2. Integration Tests (Vitest + Next.js Route Handler)

### 2.1 Test Environment
- The repository layer and the proxy layer run in-process, without starting an HTTP server.
- Redis: an **in-memory mock** (`src/lib/db/__mocks__/memory-redis.ts`), with no dependency on real Upstash.
- Upstream AI: the proxy layer abstracts HTTP transport behind `fetchImpl`, so tests inject a fake fetch and need no network.

### 2.2 Coverage

There are currently **16 integration test files**, exercising the real Route
Handlers in-process:

| Test file | What it covers |
| --- | --- |
| `tests/integration/repos.test.ts` | users / keys / providers / usage repositories: CRUD, indexes, pagination, quota accumulation, `bootstrapAdminIfNeeded` idempotency |
| `tests/integration/models-route.test.ts` | `GET /v1/models` and `/anthropic/v1/models` |
| `tests/integration/responses-surface.test.ts` | the OpenAI Responses surface |
| `tests/integration/anthropic-surface.test.ts` | the Anthropic Messages surface |
| `tests/integration/streaming-routes.test.ts` | SSE streaming through the route handlers |
| `tests/integration/media-images.test.ts` | image generation and edits, per-item billing |
| `tests/integration/media-audio-video.test.ts` | video polling, speech bytes, multipart transcription |
| `tests/integration/media-catalog-capability.test.ts` | the catalog labels each model with the spec serving it |
| `tests/integration/user-self-service.test.ts` | the user panel managing their own keys |
| `tests/integration/provider-faces.test.ts` | a provider's two protocol faces |
| `tests/integration/admin-provider-patch.test.ts`, `admin-rename-patch.test.ts` | admin provider updates |
| `tests/integration/admin-user-form-routes.test.ts` | admin user form routes |
| `tests/integration/bootstrap-race.test.ts`, `create-user-race.test.ts`, `bootstrap-no-throw.test.ts` | concurrent bootstrap and user creation |

> Route-level (HTTP) behaviour is covered by `pnpm smoke` — see §3. Cookie authentication depends
> on `next/headers` and can only be fully verified inside a real request context, so it is tested at
> the HTTP layer rather than by importing the Route Handler.

### 2.3 Case Template

```typescript
// tests/integration/repos.test.ts (excerpt)
import { beforeEach, expect, it } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { __resetConfigForTest } from "@/lib/config";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createApiKey, getApiKeyById } from "@/lib/db/keys";

beforeEach(() => {
  __resetRedisForTest();
  __setRedisForTest(createMemoryRedis()); // a clean set of data per case
  __resetConfigForTest();
});

it("creating a key returns the plaintext once and stores only the hash", async () => {
  const { key, plainKey } = await createApiKey({
    userId: "u1",
    label: "demo",
    quotaType: "credits",
    quotaLimit: 500_000, // 0.001 credit unit → 500 credits
  });
  expect(plainKey.startsWith("sk-relay-")).toBe(true);
  expect(await getApiKeyById(key.id)).not.toHaveProperty("plainKey");
});
```

### 2.4 Running
```bash
pnpm test:integration
```

---

## 3. Smoke Tests (Real HTTP End-to-End)

`scripts/smoke-local.sh` starts a real `next dev` with an **in-memory Redis**
(`EMULATE_VERCEL_LOCAL=1`) and a local **mock OpenAI upstream**, then asserts each
step along the real request path:

| Check | Assertion |
| --- | --- |
| `GET /healthz` | `{"ok":true,...}` |
| First sign-in against an empty database | an admin is created automatically and can sign in (bootstrap takes effect) |
| Wrong password | 401 |
| `/api/auth/me` | the session works across routes |
| Accessing `/api/admin/users` with no cookie | 403 |
| `POST /api/admin/keys` | returns the plaintext `sk-relay-...` (only once) |
| `POST /v1/chat/completions` | forwards successfully and returns the upstream response |
| What the mock upstream receives | the decrypted provider key + the mapped model name |
| `/api/admin/usage` | usage +1 request, `creditsUsed` = 1 (0.001 credit precision) |
| Key quota | `quotaUsed` increases by 1 (0.001 credit unit) |
| Unknown key / unmapped model | 401 / `model_not_mapped` |

### 3.1 Running
```bash
pnpm smoke                      # default ports 3211 / upstream 8891
SMOKE_PORT=3300 pnpm smoke      # custom port
```

### 3.2 Notes

- Fully offline; no Upstash / OpenAI account required.
- Browser-level Playwright cases **do exist** — `tests/e2e/login.spec.ts`, wired up
  by `playwright.config.ts` (`testDir: "./tests/e2e"`) and runnable with
  `pnpm test:e2e` (`playwright test`). An earlier version of this document called
  them "not implemented yet" and `test:e2e` a placeholder; both were true once and
  are not true now. Browser tests need a running dev server, so they are kept out
  of `pnpm test`; use `pnpm smoke` for flow-level verification without a browser.

---

## 4. Coverage Targets

| Category | Target |
| --- | --- |
| Unit + integration | business logic ≥ 80%, password/crypto modules ≥ 95% |
| E2E | critical flows 100% (sign-in, key creation, calling the proxy) |

---

## 5. Debugging Tips

### 5.1 Hit Upstash Redis Directly
```bash
# the env var names RelayAB itself uses; KV_REST_API_* is the legacy alias some
# Marketplace injects and works here too
curl -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  "$UPSTASH_REDIS_REST_URL/keys/relay:user:*?count=10"
```

### 5.2 Reproduce the Encryption Round-Trip
```typescript
import { encryptSecret, decryptSecret } from "@/lib/crypto/secrets";
const ct = encryptSecret("sk-upstream-xxx");
const pt = decryptSecret(ct);
console.assert(pt === "sk-upstream-xxx");
```

---

## 6. CI Suggestions (skipped for v1, run by hand locally)

> ⚠️ **There is no CI in this repository.** There is no `.github/` directory and no
> workflow file. The block below is a *suggestion* for what a workflow would run —
> it is not a file that exists, and nothing runs it automatically.

```yaml
# suggested, NOT present in the repo
- run: pnpm test:unit
- run: pnpm test:integration
- run: pnpm test:e2e
```
