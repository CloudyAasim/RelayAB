/**
 * tests/mocks/node-sqlite.ts
 *
 * Test-only loader for the `node:sqlite` builtin.
 *
 * Vite 5 (the major that Vitest 2 ships) predates `node:sqlite`, so a static
 * import of it makes the bundler strip the `node:` prefix and go looking for
 * an npm package called `sqlite` — every test file then dies with
 * "Failed to load url sqlite". None of Vite's `ssr.external`,
 * `server.deps.external` or `optimizeDeps.exclude` keys help: Vite resolves the
 * specifier before those lists are consulted.
 *
 * So the alias in vitest.config.ts points `node:sqlite` at this file, and this
 * file loads the builtin through `createRequire` — which is a runtime call
 * Vite never inspects. Production code keeps the plain static import; only the
 * test run takes this detour, and `next.config.ts` externalises the module for
 * the webpack build.
 */
import { createRequire } from "node:module";

const nodeRequire = createRequire(__filename);

export const { DatabaseSync } = nodeRequire("node:sqlite") as {
  DatabaseSync: typeof import("node:sqlite").DatabaseSync;
};
