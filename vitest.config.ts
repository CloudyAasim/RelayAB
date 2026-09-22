/**
 * vitest.config.ts
 *
 * Test runner configuration for RelayAB.
 * - Uses the Node environment (faster startup than jsdom).
 * - Path alias `@/*` mirrors tsconfig.json so tests can import from
 *   `@/lib/...` like production code does.
 */
import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Several integration tests deliberately hammer the bootstrap path with
    // concurrent calls while bcrypt runs at work factor 12 (on purpose, to
    // match production). Under parallel file execution that comfortably
    // exceeds the 5s default, so give the suite headroom.
    testTimeout: 20000,
    hookTimeout: 20000,
    setupFiles: ["./tests/setup.ts"],
    include: [
      "tests/unit/**/*.test.ts",
      "tests/integration/**/*.test.ts",
    ],
    exclude: ["tests/e2e/**", "node_modules/**", ".next/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/__mocks__/**",
        "src/app/**/page.tsx",
        "src/app/**/layout.tsx",
        "src/app/api/_emu/**", // emulator pass-through
      ],
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@tests": resolve(__dirname, "./tests"),
      // `revalidateTag()` requires a Next.js request context and throws in
      // tests; see tests/mocks/next-cache.ts.
      "next/cache": resolve(__dirname, "./tests/mocks/next-cache.ts"),
    },
  },
});
