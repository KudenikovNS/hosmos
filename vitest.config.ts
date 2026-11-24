import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    // DB-backed integration suites (harness T-13) share a single Postgres and
    // TRUNCATE between tests, so test FILES must not run in parallel — otherwise
    // one file's truncate wipes another's fixtures mid-run. Within a file tests
    // stay sequential already. Pure engine tests are unaffected.
    fileParallelism: false,
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } }, // как tsconfig paths
});
