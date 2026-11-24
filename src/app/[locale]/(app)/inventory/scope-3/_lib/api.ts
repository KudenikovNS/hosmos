// =============================================================================
// THE WIRE, AS `/inventory/scope-3` SEES IT.
//
// Same two rules as the other `(app)` screens' `_lib/api.ts`:
//
//   1. THE DTOs ARE IMPORTED, NOT RE-DECLARED — `@/server/db/scope3-spend` and
//      `@/server/scope3/factors` own them, and `import type` erases the server
//      module (and its drizzle runtime) before the browser bundle is built. The
//      editor used to re-type all four shapes by hand; they are now one import.
//   2. A REFUSAL IS CLASSIFIED ONCE — `../../../_lib/refusal`. §0.2 makes
//      401/403, 402, 422-with-rules, 422-with-field and bare-422 five different
//      things to say, and this screen must not invent a sixth.
//
// THE REFUSAL THIS SCREEN CARES ABOUT BY NAME is `NO_SPEND_FACTORS`: no ACTIVE
// factor set carries per-€1000 spend factors, so nothing on this screen can be
// priced. It arrives as `{refusal, factor_set}` — the same additive shape
// `NEW_VERSION_ONLY` travels on — from BOTH ends of the route:
//
//   • the POST refuses the write with it (still 422, never a 200);
//   • the GET hands it over as `spendRefusal`, so the screen says why BEFORE the
//     user types a figure into a form that is going to be refused.
//
// One token, one classification, one sentence — see {@link unpriceableSpend}.
// =============================================================================
import type { Scope3SpendLine } from "@/server/db/scope3-spend";
import type {
  Scope3Commodity,
  SpendFactorSetRef,
} from "@/server/scope3/factors";

export type { SpendFactorSetRef };

export {
  classifyRefusal,
  type ApiBody,
  type Refusal,
} from "../../../_lib/refusal";

import { classifyRefusal, type Refusal } from "../../../_lib/refusal";

/**
 * The token `@/server/scope3/factors#NO_SPEND_FACTORS` sends.
 *
 * A LITERAL, not that import: the server module carries `server-only`, so a
 * runtime import of it would be a build error in a client component (the DTO
 * types above are `import type` and erase). The two spellings are held together
 * by `__tests__/refusal.test.ts`, which imports both and asserts they are equal
 * — and by the message key `scope3.refusals.NO_SPEND_FACTORS`, which the same
 * test requires to exist in both locales.
 */
export const NO_SPEND_FACTORS = "NO_SPEND_FACTORS";

/** One currency the editor may denominate a line in. */
interface CurrencyOpt {
  code: string;
  name: string;
  symbol: string;
}

/** The named refusal as the wire carries it, on a 422 body or inside the GET. */
interface SpendRefusalPayload {
  refusal: string;
  factor_set: SpendFactorSetRef | null;
}

/** `GET /api/scope3-spend` — the lines plus every input the editor needs. */
export interface SpendView {
  year: string;
  lines: Scope3SpendLine[];
  commodities: Scope3Commodity[];
  currencies: CurrencyOpt[];
  defaultCurrency: string;
  warnings: string[];
  /** Why the editor cannot be used, when it cannot. `null` on an ordinary read. */
  spendRefusal: SpendRefusalPayload | null;
}

/** What a POST/DELETE answers with: the surviving lines and the recalc's D4 warnings. */
export interface SpendWriteData {
  lines: Scope3SpendLine[];
  warnings: string[];
}

/** A `{code,name}` pair, checked rather than cast — `detail` is `unknown` by type. */
function isFactorSetRef(value: unknown): value is SpendFactorSetRef {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as { code?: unknown; name?: unknown };
  return typeof ref.code === "string" && typeof ref.name === "string";
}

/**
 * The GET's `spendRefusal` through the SHARED classifier — the same function,
 * and therefore the same reading, that the POST's 422 body goes through.
 *
 * `{error: "VALIDATION"}` is prepended because that is literally the body the
 * POST answers with; the GET carries the detail keys without the envelope, since
 * a 200 has no error to report.
 */
export function spendRefusalOf(view: SpendView | null): Refusal | null {
  const payload = view?.spendRefusal;
  return payload ? classifyRefusal({ error: "VALIDATION", ...payload }) : null;
}

/**
 * IS THIS REFUSAL "nothing can price spend", AND WHICH SET IS IT ABOUT?
 *
 * `null` for every other refusal (a 403, a plan gate, a malformed field) — those
 * are the editor failing on one request, and they keep their existing copy. A
 * non-null answer means the FEATURE cannot be used at all, which is the state
 * the screen replaces its editor with an explanation for.
 *
 * `factorSet` is `null` when the platform has no active set to name. The screen
 * then says the same thing without naming one, rather than printing a blank —
 * a missing name is better than a wrong one in a refusal a user has to act on.
 */
export function unpriceableSpend(
  refusal: Refusal | null,
): { factorSet: SpendFactorSetRef | null } | null {
  if (refusal === null || refusal.kind !== "refused") return null;
  if (refusal.refusal !== NO_SPEND_FACTORS) return null;
  const set = refusal.detail.factor_set;
  return { factorSet: isFactorSetRef(set) ? set : null };
}
