/**
 * GET / POST /api/periods/:id/revisions — the report revisions of one period
 * (DATA-MODEL T2.6; DM-10, D22, §5.1 row 1, LC-1a, LC-9, LC-10).
 *
 * PATTERN 3 (§0.1): `:id` is the TARGET, never an identity — the period is
 * resolved strictly inside `session.company.id`, so another tenant's period has
 * no revisions to list (404 `NO_DATA`) and cannot be given one (422
 * `VALIDATION`, API-1).
 *
 * WHAT A POST MAY DO (§5.1's first row, decided in `@/server/revisions/revisions`
 * and not here): a new revision is allowed while the current one is `draft`
 * (D22 puts no limit on drafts), `rejected`, or `locked` (a restatement, which
 * must state `change_reason`), and refused while a review is in flight
 * (`submitted`/`in_review`/`approved`). The refusal names the current status and
 * the statuses that would allow it, because "no" without "when" is unactionable
 * on a screen.
 *
 * `{seedFrom}` SEEDS THE NEW REVISION (LC-9, T3.4). The current, non-deleted
 * rows of the named revision are copied into the new one as fresh DRAFT rows
 * whose `previous_version_id` points back at the row they came from, so
 * provenance crosses the revision boundary and `GET …/history` reads through it.
 * The source must be a revision of the SAME period; anything else is 422 on the
 * field, with no revision created. The copy and the `seeded_from_revision_id`
 * stamp are one transaction — a stamped revision with no rows under it would
 * look exactly like a restatement whose data vanished, which is why T2.6 shipped
 * a refusal rather than an approximation.
 *
 * GUARD ORDER (§0.2): 401 → 404 (no company) → 403 capability → 422 body. READ
 * is `data.read` (a reviewer must see the history), WRITE is `data.write`
 * (§5.4). NO plan gate: PG-1 caps the entity registries and F1 is spent at LOCK
 * (T2.6's transition), never on starting a draft — refusing a draft would be
 * charging for work rather than for a claim of completeness.
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight.
 */
import {
  apiResult,
  apiRoute,
  apiValidationDetail,
  isUuid,
  optionsHandler,
} from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { getPeriod } from "@/server/periods/periods";
import {
  createRevision,
  listRevisions,
  parseNewRevision,
  serialiseRevision,
} from "@/server/revisions/revisions";

type Ctx = { params: Promise<{ id: string }> };

export const GET = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  const { id } = await ctx.params;
  // A non-uuid would reach Postgres as a malformed literal → 500 (isUuid, T2.1).
  if (!isUuid(id)) return apiResult(req, { ok: false, error: "NO_DATA" });

  // The PERIOD is what a caller may or may not see; "no revisions yet" is a
  // legitimate answer for one that exists, so the two are distinguished here
  // rather than by row count.
  const period = await getPeriod(db, company.id, id);
  if (!period) return apiResult(req, { ok: false, error: "NO_DATA" });

  const rows = await listRevisions(db, company.id, id);
  return apiResult(req, {
    ok: true,
    data: {
      period_id: id,
      revisions: rows.map(serialiseRevision),
      // LC-1a — exactly one, or none before the first create. Published so a
      // client never has to scan the list for `is_current` itself.
      current_revision_id: rows.find((row) => row.isCurrent)?.id ?? null,
    },
  });
});

export const POST = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.write");
  if (forbidden) return apiResult(req, forbidden);

  const { id } = await ctx.params;
  if (!isUuid(id)) return apiValidationDetail(req, { field: "id" });

  const body = await req.json().catch(() => null);
  const parsed = parseNewRevision(body);
  if (!parsed.ok) return apiValidationDetail(req, { field: parsed.field });

  const result = await createRevision(db, company.id, id, parsed.values, {
    userId: session.userId,
    role: session.membership?.role ?? null,
  });
  if (!result.ok) {
    // NOT_FOUND (a foreign or unknown period) and a refused state are the same
    // HTTP answer (422 VALIDATION, API-1); only the payload differs.
    return apiValidationDetail(
      req,
      result.error === "VALIDATION"
        ? { rules: result.rules, ...result.detail }
        : { rules: [] },
    );
  }

  return apiResult(req, { ok: true, data: serialiseRevision(result.row) });
});

export const OPTIONS = optionsHandler;
