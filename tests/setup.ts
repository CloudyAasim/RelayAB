/**
 * tests/setup.ts
 *
 * Global test setup loaded by vitest (see vitest.config.ts).
 *
 * Sets the minimum env vars RelayAB needs to boot in test mode.
 * In test mode, config.ts auto-fills sensible defaults for anything
 * missing, so this file only sets the truly required ones.
 */
(process.env as Record<string, string>).NODE_ENV = "test";
process.env.RELAY_AUTH = "test-relay-auth-must-be-8-chars-long-padding";
process.env.UPSTASH_REDIS_REST_URL = "http://localhost:13700";
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
