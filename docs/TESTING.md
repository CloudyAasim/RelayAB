# 测试策略与规范

> 测试金字塔：**单元 → 集成 → 冒烟（端到端）**。
> 每个模块产出代码 + 至少一个对应的测试文件。

```bash
pnpm test          # 单元 + 集成（无网络依赖）
pnpm smoke         # 端到端冒烟：真实 next dev + 内存 Redis + mock 上游
pnpm type-check && pnpm build
```

---

## 1. 单元测试（Vitest）

### 1.1 覆盖范围
| 模块 | 文件 |
|---|---|
| 配置 / 派生密钥 | `tests/unit/config.test.ts` |
| `crypto/secrets`（AES-256-GCM） | `tests/unit/crypto-secrets.test.ts` |
| `crypto/hashing`（sha256 / 前缀） | `tests/unit/crypto-hashing.test.ts` |
| `crypto/password`（bcrypt，含同步版本） | `tests/unit/crypto-password.test.ts` |
| session（iron-session 选项） | `tests/unit/auth-session.test.ts` |
| Bearer 解析 + Key 校验 | `tests/unit/auth-apikey.test.ts` |
| 内存 Redis mock 自身 | `tests/unit/memory-redis.test.ts`、`tests/unit/redis-client.test.ts` |
| 类型 / schema | `tests/unit/db-types.test.ts` |
| 内置 bootstrap 流程 | `tests/unit/bootstrap.test.ts` |
| `quota/rates` | `tests/unit/quota-rates.test.ts` |
| `quota/calculator` | `tests/unit/quota-calculator.test.ts` |
| `vercel/client` | `tests/unit/vercel-client.test.ts` |
| `proxy/openai` | `tests/unit/proxy-openai.test.ts` |
| `proxy/anthropic` | `tests/unit/proxy-anthropic.test.ts` |

### 1.2 工具
- 纯函数，无副作用，无需 mock。
- 用 `vitest` 内置断言 + `@vitest/expect`。

### 1.3 运行
```bash
pnpm test:unit
```

---

## 2. 集成测试（Vitest + Next.js Route Handler）

### 2.1 测试环境
- 进程内直接跑仓库层与代理层，不启动 HTTP server。
- Redis：**内存 mock**（`src/lib/db/__mocks__/memory-redis.ts`），不依赖真实 Upstash。
- 上游 AI：代理层把 HTTP transport 抽象成 `fetchImpl`，测试注入假的 fetch，无需网络。
- 嵌入式 `@emulators/vercel` 只在需要 Vercel SDK 时使用。

### 2.2 覆盖范围

| 测试文件 | 覆盖内容 |
|---|---|
| `tests/integration/repos.test.ts` | users / keys / providers / usage 仓库：CRUD、索引、分页、配额累加、`bootstrapAdminIfNeeded` 幂等 |

> 路由级（HTTP）行为由 `pnpm smoke` 覆盖——见第 3 节。Cookie 鉴权依赖
> `next/headers`，只有真实请求上下文才能完整验证，因此在 HTTP 层测而不是 import
> Route Handler。

### 2.3 用例模板

```typescript
// tests/integration/repos.test.ts（节选）
import { beforeEach, expect, it } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { __resetConfigForTest } from "@/lib/config";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createApiKey, getApiKeyById } from "@/lib/db/keys";

beforeEach(() => {
  __resetRedisForTest();
  __setRedisForTest(createMemoryRedis()); // 每个用例一套干净数据
  __resetConfigForTest();
});

it("creating a key returns the plaintext once and stores only the hash", async () => {
  const { key, plainKey } = await createApiKey({
    userId: "u1",
    label: "demo",
    quotaType: "credits",
    quotaLimit: 500_000, // 0.001 积分单位 → 500 积分
  });
  expect(plainKey.startsWith("sk-relay-")).toBe(true);
  expect(await getApiKeyById(key.id)).not.toHaveProperty("plainKey");
});
```

### 2.4 运行
```bash
pnpm test:integration
```

---

## 3. 冒烟测试（真实 HTTP 端到端）

`scripts/smoke-local.sh` 会启动真实的 `next dev`，配 **内存 Redis**
（`EMULATE_VERCEL_LOCAL=1`）和一个本地 **mock OpenAI 上游**，然后按真实请求链路
逐项断言：

| 检查 | 断言 |
|---|---|
| `GET /healthz` | `{"ok":true,...}` |
| 空库首次登录 | 自动创建 admin 并可登录（bootstrap 生效） |
| 错误密码 | 401 |
| `/api/auth/me` | session 跨路由可用 |
| 无 cookie 访问 `/api/admin/users` | 403 |
| `POST /api/admin/keys` | 返回明文 `sk-relay-...`（仅此一次） |
| `POST /v1/chat/completions` | 转发成功，返回上游响应 |
| mock 上游收到 | 解密后的 Provider Key + 映射后的模型名 |
| `/api/admin/usage` | 用量 +1 次请求，`creditsUsed` = 1（0.001 积分精度） |
| Key 额度 | `quotaUsed` 增加 1（0.001 积分单位） |
| 未知 Key / 未映射模型 | 401 / `model_not_mapped` |

### 3.1 运行
```bash
pnpm smoke                      # 默认端口 3211 / 上游 8891
SMOKE_PORT=3300 pnpm smoke      # 自定义端口
```

### 3.2 说明

- 完全离线，不需要 Upstash / OpenAI 账号。
- 浏览器级 Playwright 用例（`tests/e2e/`）尚未实现，`pnpm test:e2e` 目前是占位脚本；
  流程级验证请用 `pnpm smoke`。

---

## 4. 覆盖率目标

| 类别 | 目标 |
|---|---|
| 单元 + 集成 | 业务逻辑 ≥ 80%，密码/加密模块 ≥ 95% |
| E2E | 关键流程 100%（登录、建 Key、调用代理） |

---

## 5. 调试技巧

### 5.1 看嵌入式 mock 数据
浏览器访问 `http://localhost:3000/api/_emu/vercel/v10/projects`（注意 dev 时 middleware 不挡）。

### 5.2 直接 hit Upstash Redis
```bash
curl -H "Authorization: Bearer $UPSTASH_TOKEN" \
  "$UPSTASH_URL/keys/relay:user:*?count=10"
```

### 5.3 复现加密 round-trip
```typescript
import { encryptSecret, decryptSecret } from "@/lib/crypto/secrets";
const ct = encryptSecret("sk-upstream-xxx");
const pt = decryptSecret(ct);
console.assert(pt === "sk-upstream-xxx");
```

---

## 6. CI 建议（v1 跳过，本地手跑）

```yaml
# .github/workflows/test.yml
- run: pnpm test:unit
- run: pnpm test:integration
- run: pnpm test:e2e
```
