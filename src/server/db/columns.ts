/**
 * Column helpers — a LEAF module: it imports nothing from this package.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `appUuidPk()` and `timestamptz()` are needed by BOTH `./schema` and the D23
 * lifecycle mixin in `./lifecycle`, and `./lifecycle` is itself imported by
 * `./schema`. Keeping the helpers in `schema.ts` therefore made `lifecycle.ts`
 * import from `schema.ts` and `schema.ts` import from `lifecycle.ts` — a real
 * cycle, and one that CRASHED rather than merely looking untidy.
 *
 * The `.references(() => …)` thunks in the mixin are lazy and genuinely safe
 * inside a cycle: nothing reads them until Drizzle resolves the FK. The COLUMN
 * HELPER CALLS are not — `appUuidPk()` and `timestamptz("created_at")` run the
 * moment `lifecycleColumns()` is invoked, i.e. while `schema.ts` is still
 * evaluating its own module body. That only worked because `schema.ts` was
 * always the first of the pair to be loaded. Import `@/server/db/lifecycle`
 * from anywhere else first — a T2.x service, a unit test — and the partially
 * initialised `./schema` namespace yields `undefined` for `appUuidPk`, so the
 * whole schema module dies with `TypeError: Cannot read properties of undefined
 * (reading 'appUuidPk')` and every DB route 500s. Verified under both the
 * tsx/CJS and the vitest/ESM loaders.
 *
 * `schema.ts ↔ lifecycle.ts` is STILL a cycle after this change — the mixin's
 * FK targets legitimately live in `schema.ts`. What is gone is the eager edge:
 * every remaining reference to `./schema` from `./lifecycle` sits inside a
 * thunk, so neither module dereferences the other while either is evaluating,
 * and import order stops mattering.
 * `__tests__/lifecycle-import-order.test.ts` is the regression guard — it
 * imports `./lifecycle` FIRST and asserts the mixin evaluates.
 *
 * Anything added here must keep the module a leaf: no `./schema` import, ever.
 */
import { timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * App-generated UUID primary key (no dependency on gen_random_uuid/pgcrypto,
 * PG-PLAN decision 2026-07-14).
 */
export const appUuidPk = () =>
  uuid("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

/** `timestamptz` column helper — every date/time column in this schema is one. */
export const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true });
