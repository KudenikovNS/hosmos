/**
 * Regression guard for the T1.2 review finding C1 — the "safe" circular import
 * that was not safe.
 *
 * `lifecycleColumns()` CALLS `appUuidPk()` and `timestamptz()` eagerly. While
 * those two helpers lived in `./schema` — which imports `./lifecycle` — the
 * cycle only worked because `schema.ts` was always the first of the pair to be
 * evaluated. Loading `@/server/db/lifecycle` FIRST left `./schema` half
 * initialised and produced, at module scope:
 *
 *     TypeError: Cannot read properties of undefined (reading 'appUuidPk')
 *
 * which is not a broken mixin but a dead `schema.ts`, i.e. a 500 on every route
 * that touches the database. The fix moved the two helpers into the leaf module
 * `./columns`, so the cycle no longer exists at all.
 *
 * THE IMPORT ORDER BELOW IS THE TEST: `@/server/db/lifecycle` is imported
 * before anything that reaches `../schema`, which is exactly the order that
 * used to crash. Vitest gives every test file its own module registry, so this
 * really is a cold load. Do not re-sort these imports.
 */
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { lifecycleColumns } from "@/server/db/lifecycle"; // ← FIRST, on purpose

import { describe, expect, it } from "vitest";

/** Reach the builder's config the way Drizzle stores it (no public getter). */
type BuilderConfig = { name: string; primaryKey?: boolean };
const cfg = (builder: unknown): BuilderConfig =>
  (builder as { config: BuilderConfig }).config;

describe("D23 lifecycle mixin — import-order independence (C1)", () => {
  it("evaluates when `@/server/db/lifecycle` is the first module loaded", () => {
    // Before the fix this threw inside `lifecycleColumns` on `appUuidPk()`,
    // before any assertion below could run.
    const self = (): AnyPgColumn => {
      throw new Error("the self-FK thunk must stay lazy and is never called");
    };
    const columns = lifecycleColumns(self);

    // The two eagerly-called helpers really produced builders, not `undefined`.
    expect(cfg(columns.id).name).toBe("id");
    expect(cfg(columns.id).primaryKey).toBe(true);
    expect(cfg(columns.createdAt).name).toBe("created_at");
    expect(cfg(columns.approvedAt).name).toBe("approved_at");

    // And the mixin is still the full 20-column shape (spec §4.8, DM-11).
    expect(Object.keys(columns)).toHaveLength(20);
  });
});
