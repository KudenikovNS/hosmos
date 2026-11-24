// =============================================================================
// A REFUSAL IS CLASSIFIED ONCE — the shared vocabulary of every `(app)` screen
// that writes through `/api/*`.
//
// It was written for `/organisation` (T2.7) and lived in that screen's `_lib`
// while it was the only caller. T2.8 gave it a second one (`/admin/factors`),
// and a second COPY of "which HTTP answer means what to a user" is exactly the
// drift worth avoiding: §0.2 makes 401/403, 402, 422-with-rules, 422-with-field
// and bare-422 five DIFFERENT things to say, and a screen that classified them
// its own way would tell the user something the next screen contradicts. So the
// decision moved up one directory, beside `navItems.ts`, and
// `organisation/_lib/api.ts` re-exports it — every existing importer is
// unchanged and there is still exactly one implementation.
//
// Nothing here is server code and nothing imports any: a screen may hold the
// server's DTO TYPES (erased at compile), but the meaning of a refusal is the
// client's own.
// =============================================================================

/** One blocking rule as API-1 carries it (`{code, message, scope}`). */
export interface RuleRef {
  code: string;
  message: string;
  scope: string;
}

/**
 * The body of any `/api/*` response, as `apiFetch` hands it over: the
 * `ActionResult` shape plus the additive API-1 detail keys — `rules` for a
 * blocking rule set, `field` for a malformed one, and `refusal` for a business
 * refusal that no VAL-* code owns (a rejected revision transition, T2.6; a
 * released factor set, T2.8).
 */
export type ApiBody<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      rules?: RuleRef[];
      field?: string;
      refusal?: string;
    };

/**
 * WHY a write was refused, in the vocabulary the UI speaks — never an HTTP code.
 *
 *  • `access_changed` — 401/403/no-company: the session's rights moved under the
 *    user (R-11). Benign copy, never a red technical error.
 *  • `plan_required`  — 402 (PG-2): rendered as a PLAN explanation + CTA.
 *  • `rules`          — 422 with blocking rules; localised by CODE through the
 *    `validation.*` keys T2.1 seeded for all 41 rules (О-12).
 *  • `refused`        — 422 with a NAMED business refusal that has no rule code
 *    (`NEW_VERSION_ONLY`, `CODE_TAKEN`…). The screen localises the token, and
 *    `detail` carries whatever the server sent with it.
 *  • `field`          — 422 from the parser: one malformed field, named.
 *  • `rejected`       — 422 with NONE of the above: API-1's "does not exist for
 *    this company" (a foreign reference, or an id that is simply not there). It
 *    has no rule of record, so it needs its own copy rather than an empty list.
 */
export type Refusal =
  | { kind: "access_changed" }
  | { kind: "plan_required" }
  | { kind: "rules"; rules: RuleRef[] }
  | { kind: "refused"; refusal: string; detail: Record<string, unknown> }
  | { kind: "field"; field: string }
  | { kind: "rejected" }
  | { kind: "unknown" };

/** Outcome of a write: the row, or WHY the server refused it. Never a throw. */
export type WriteOutcome<T> = { ok: true; data: T } | ({ ok: false } & Refusal);

/**
 * Is this error code the session's rights having moved (R-11)?
 *
 * `COMPANY_NOT_FOUND` counts: a membership that vanished reads to the user as
 * exactly the same event as a capability that was taken away, and both are
 * fixed by reloading.
 */
export function isAccessError(error: string): boolean {
  return (
    error === "FORBIDDEN" ||
    error === "UNAUTHENTICATED" ||
    error === "COMPANY_NOT_FOUND"
  );
}

/** A failed `ApiBody` → the refusal the UI renders (see {@link Refusal}). */
export function classifyRefusal(body: {
  error: string;
  rules?: RuleRef[];
  field?: string;
  refusal?: string;
  [key: string]: unknown;
}): Refusal {
  if (isAccessError(body.error)) return { kind: "access_changed" };
  if (body.error === "PLAN_REQUIRED") return { kind: "plan_required" };
  if (body.error === "VALIDATION") {
    if (body.rules && body.rules.length > 0) {
      return { kind: "rules", rules: body.rules };
    }
    // A named refusal outranks the field it may travel with (`CODE_TAKEN` sends
    // both): the token says WHAT happened, the field only says where.
    if (typeof body.refusal === "string" && body.refusal.length > 0) {
      return { kind: "refused", refusal: body.refusal, detail: body };
    }
    if (typeof body.field === "string" && body.field.length > 0) {
      return { kind: "field", field: body.field };
    }
    return { kind: "rejected" };
  }
  return { kind: "unknown" };
}
