/**
 * POST /api/revisions/:id/transition — move one revision through the §5.1
 * matrix (T2.6; DM-10, D22, LC-1, LC-1a, LC-10, PG-3/F1).
 *
 * `{action: submit|start_review|approve|reject|lock|abandon}` (§12.2), plus the
 * two values §5.1's side-effect column needs: `comment` (mandatory on `reject`)
 * and `change_reason`. The seventh action of the matrix, `resume`
 * (`rejected → draft`), is deliberately NOT on the wire: it is executed by the
 * service that edits a row of a rejected revision (T3.1), so a client naming it
 * is a 422 like any other unknown action.
 *
 * THIS ROUTE DECIDES NOTHING. It parses, then calls `transitionRevision`, then
 * maps the result to a status code — no role branch, no status branch, no plan
 * check of its own (§0.2). Everything else in the product that wants to move a
 * revision calls the same function, which is what makes "one state machine, one
 * writer" (LC-1) a property of the code rather than a convention.
 *
 * THE STATUS CODES, all four decided by the service and merely rendered here:
 *   403 `FORBIDDEN`      — the role lacks the capability the MATRIX assigns the
 *                          action (`data.submit`/`data.review`/`data.approve`/
 *                          `data.write`, §5.4). Before the plan gate, always: an
 *                          upgrade cannot help a role that may not do this.
 *   402 `PLAN_REQUIRED`  — F1 (§11.3): Starter/Trial with more includable
 *                          facilities than the plan allows may not LOCK. The
 *                          VAL-105 result is written first, so the screen can
 *                          say "4 sites, your plan allows 3" instead of showing
 *                          a bare payment wall.
 *   422 `VALIDATION`     — the (action, from) pair is not in the matrix, or a
 *                          precondition refused. The payload names both: `rules`
 *                          (empty unless a VAL-* code owns the refusal) and the
 *                          transition detail `{action, from, allowed, …}`.
 *   404 `NO_DATA`        — no such revision FOR THIS COMPANY (API-1).
 *
 * PATTERN 2 (CORS): every response + the OPTIONS preflight.
 */
import {
  apiJson,
  apiResult,
  apiRoute,
  apiValidationDetail,
  isUuid,
  optionsHandler,
  statusForError,
} from "@/server/api/handler";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import {
  isWireAction,
  transitionRevision,
  type TransitionInput,
} from "@/server/revisions/transition";

type Ctx = { params: Promise<{ id: string }> };

/** The two optional values of §5.1's side-effect column, shape-checked only. */
function parseInput(body: unknown): TransitionInput {
  if (!body || typeof body !== "object") return {};
  const input = body as Record<string, unknown>;
  return {
    comment: typeof input.comment === "string" ? input.comment : null,
    changeReason:
      typeof input.change_reason === "string" ? input.change_reason : null,
    assignedTo: isUuid(input.assigned_to) ? input.assigned_to : null,
  };
}

export const POST = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const { id } = await ctx.params;
  if (!isUuid(id)) return apiValidationDetail(req, { field: "id" });

  const body = await req.json().catch(() => null);
  const action = (body as { action?: unknown } | null)?.action;
  // The capability is per-ACTION (§5.4), so an unknown action has none to
  // require: the shape is refused before the guard rather than 403-ing on a
  // capability nobody could name.
  if (!isWireAction(action))
    return apiValidationDetail(req, { field: "action" });

  const result = await transitionRevision(
    db,
    // PATTERN 3 — identity from the session only; `company` is narrowed above.
    { ...session, company },
    id,
    action,
    parseInput(body),
  );

  if (result.ok) {
    return apiResult(req, {
      ok: true,
      data: {
        revision: result.row.id,
        from: result.from,
        to: result.row.status,
      },
    });
  }
  if (result.error === "NOT_FOUND") {
    return apiResult(req, { ok: false, error: "NO_DATA" });
  }
  if (result.error === "FORBIDDEN") {
    return apiResult(req, { ok: false, error: "FORBIDDEN" });
  }
  // Both remaining cases carry WHY (API-1): the rule set (empty when no VAL-*
  // code owns the refusal) and the transition detail. `PLAN_REQUIRED` keeps its
  // 402 — a plan limit is never a 422, or the client cannot tell "you did it
  // wrong" from "you need to upgrade" (§7.1).
  return apiJson(
    req,
    {
      ok: false,
      error: result.error,
      rules: result.rules,
      transition: result.detail,
    },
    statusForError(result.error),
  );
});

export const OPTIONS = optionsHandler;
