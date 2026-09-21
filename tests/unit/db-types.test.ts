/**
 * tests/unit/db-types.test.ts
 *
 * Verifies that the Zod schemas in lib/db/types.ts correctly accept
 * well-formed records and reject malformed ones. The `toPublic*`
 * helpers must strip secrets.
 */
import { describe, it, expect } from "vitest";
import {
  UserSchema,
  ApiKeySchema,
  ProviderSchema,
  UsageLogSchema,
  toPublicUser,
  toPublicProvider,
} from "@/lib/db/types";

describe("db types - schemas", () => {
  it("UserSchema accepts a valid user", () => {
    const u = {
      id: "01J7R5K8W6X8X8X8X8X8X8X8X8",
      username: "alice",
      passwordHash: "$2a$12$...",
      role: "user" as const,
      displayName: "Alice",
      createdAt: "2026-09-21T08:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      lastLoginAt: null,
      disabled: false,
    };
    expect(() => UserSchema.parse(u)).not.toThrow();
  });

  it("UserSchema rejects an invalid role", () => {
    const u = {
      id: "01J",
      username: "alice",
      passwordHash: "$2a$12$...",
      role: "superuser",
      displayName: "Alice",
      createdAt: "2026-09-21T08:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      lastLoginAt: null,
      disabled: false,
    };
    expect(() => UserSchema.parse(u)).toThrow();
  });

  it("ApiKeySchema rejects short keyHash", () => {
    const k = {
      id: "01J",
      userId: "01J",
      label: "l",
      keyHash: "short",
      keyPrefix: "sk-relay-X3K...m2pQ",
      quotaType: "credits" as const,
      quotaLimit: 100,
      quotaUsed: 0,
      expiresAt: null,
      enabled: true,
      allowedModels: [],
      createdAt: "2026-09-21T08:00:00.000Z",
      lastUsedAt: null,
    };
    expect(() => ApiKeySchema.parse(k)).toThrow();
  });

  it("ProviderSchema accepts valid provider", () => {
    const p = {
      id: "01J",
      name: "OpenAI",
      kind: "openai" as const,
      baseUrl: null,
      encryptedApiKey: "Abc==",
      modelMapping: { "gpt-4o-mini": "gpt-4o-mini-2024-07-18" },
      enabled: true,
      priority: 1,
      headers: {},
      createdAt: "2026-09-21T08:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    expect(() => ProviderSchema.parse(p)).not.toThrow();
  });

  it("UsageLogSchema requires non-negative token counts", () => {
    const log = {
      id: "01J",
      apiKeyId: "01J",
      userId: "01J",
      providerId: "01J",
      model: "gpt-4o-mini",
      upstreamModel: "gpt-4o-mini-2024-07-18",
      promptTokens: -1,
      completionTokens: 10,
      totalTokens: 10,
      creditsUsed: 5,
      status: "success" as const,
      errorMessage: null,
      createdAt: "2026-09-21T08:00:00.000Z",
    };
    expect(() => UsageLogSchema.parse(log)).toThrow();
  });
});

describe("db types - toPublic helpers", () => {
  it("toPublicUser strips passwordHash", () => {
    const u: import("@/lib/db/types").User = {
      id: "01J",
      username: "alice",
      passwordHash: "$2a$12$secret",
      role: "user",
      displayName: "Alice",
      createdAt: "2026-09-21T08:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      lastLoginAt: null,
      disabled: false,
      quotaType: "credits",
      quotaLimit: 1000,
      quotaUsed: 0,
      maxActiveKeys: 0,
      allowedModels: [],
    };
    const pub = toPublicUser(u);
    expect("passwordHash" in pub).toBe(false);
    expect(pub.username).toBe("alice");
  });

  it("toPublicProvider strips encryptedApiKey", () => {
    const p: import("@/lib/db/types").Provider = {
      id: "01J",
      name: "OpenAI",
      kind: "openai",
      baseUrl: null,
      encryptedApiKey: "Abc==",
      modelMapping: {},
      enabled: true,
      priority: 1,
      headers: {},
      createdAt: "2026-09-21T08:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    const pub = toPublicProvider(p);
    expect("encryptedApiKey" in pub).toBe(false);
    expect(pub.name).toBe("OpenAI");
  });
});
