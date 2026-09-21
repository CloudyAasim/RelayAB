/**
 * src/lib/proxy/index.ts
 *
 * Barrel export for upstream proxy implementations.
 */
export * from "./openai";
export { proxyAnthropicMessage } from "./anthropic";
export type { AnthropicProxyResult, AnthropicProxyDeps } from "./anthropic";
