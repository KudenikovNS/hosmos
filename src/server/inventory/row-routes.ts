// THE HTTP SHAPE OF AN INPUT-ROW TABLE — one implementation, FOUR route
// families (`/api/activities/emission`, `/api/activities/energy`,
// `/api/activities/instruments`, `/api/disclosures`).
//
// See docs/decisions/server-inventory-row-routes.md for the full account.
import type { NextRequest, NextResponse } from "next/server";

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
import type { Capability } from "@/shared/roles";

import {
  approveRow,
  createRow,
  deleteRow,
  editRow,
  getVersion,
  history,
  listCurrent,
  type RowValues,
  type RowWriteResult,
} from "./rows";
import type { InputRow } from "./tables";
import {
  asNewRowValues,
  foreignReference,
  parseChangeReason,
  type CompanySession,
  type RowPrepared,
  type RowWireContract,
} from "./wire";

/** The `{params}` a Next.js `[id]` route hands its handler. */
type Ctx = { params: Promise<{ id: string }> };

/**
 * The session facts every handler below needs, or the response that refuses the
 * request before it needs them.
 *
 * THE GUARD ORDER IS HERE AND NOWHERE ELSE (§0.2): 401 for no session, 404 for a
 * session with no company, 403 for a role without the capability — and only then
 * does anything read the body. One implementation means the order cannot differ
 * between two routes that are supposed to behave identically.
 */
type Guarded =
  | { ok: true; session: CompanySession; companyId: string }
  | { ok: false; response: NextResponse };

async function guard(
  req: NextRequest,
  capability: Capability,
): Promise<Guarded> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      response: apiResult(req, { ok: false, error: "UNAUTHENTICATED" }),
    };
  }
  const company = session.company;
  if (!company) {
    return {
      ok: false,
      response: apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" }),
    };
  }
  const forbidden = requireCapability(session, capability);
  if (forbidden) return { ok: false, response: apiResult(req, forbidden) };
  return { ok: true, session: { ...session, company }, companyId: company.id };
}

/** The one refusal shape every write method answers with (API-1). */
function refusal(
  req: NextRequest,
  result: Extract<RowWriteResult, { ok: false }>,
): NextResponse {
  // NOT_FOUND (a foreign or unknown target) and a blocking rule set are the same
  // HTTP answer — 422 VALIDATION; only the payload differs.
  return apiValidationDetail(req, {
    rules: result.error === "VALIDATION" ? result.rules : [],
    ...(result.error === "VALIDATION" && result.detail ? result.detail : {}),
  });
}

/**
 * Refuse a body that names another tenant's row (PATTERN 3, §0.4 rule 1).
 *
 * Before the write, because an FK to a table this company cannot see would not
 * fail at all — `asset`, `facility` and `legal_entity` all carry their own
 * `company_id`, and the constraint knows nothing about it. Answered as a FIELD
 * (API-1: "does not exist for this company"), never as a rule code: no VAL-* code
 * has a foreign reference as its subject.
 */
async function foreignField(
  contract: RowWireContract<unknown>,
  companyId: string,
  values: RowValues,
): Promise<string | undefined> {
  return foreignReference(db, companyId, contract.references, values);
}

/**
 * The contract's second parsing stage, or the values unchanged when it has none
 * (`RowPrepare`, `./wire`).
 *
 * It runs AFTER the tenant check on purpose: a hook reads the database, and a
 * body naming another company's rows must be refused before anything is looked
 * up on its behalf.
 */
async function prepared(
  contract: RowWireContract<unknown>,
  guarded: Extract<Guarded, { ok: true }>,
  values: RowValues,
  current?: InputRow,
): Promise<RowPrepared> {
  if (!contract.prepare) return { ok: true, values };
  return contract.prepare({
    db,
    session: guarded.session,
    companyId: guarded.companyId,
    values,
    ...(current ? { current } : {}),
  });
}

// ─── The four route families ─────────────────────────────────────────────────

/** `GET`/`POST` of the collection: the current rows of a revision, and LC-3. */
export function rowCollectionRoutes<Dto>(contract: RowWireContract<Dto>) {
  const GET = apiRoute(async (req) => {
    const guarded = await guard(req, "data.read");
    if (!guarded.ok) return guarded.response;

    const revisionId = new URL(req.url).searchParams.get("revision_id");
    // A non-uuid would reach Postgres as a malformed literal → 500 (isUuid).
    if (revisionId !== null && !isUuid(revisionId)) {
      return apiValidationDetail(req, { field: "revision_id" });
    }

    const rows = await listCurrent(db, guarded.companyId, contract.table, {
      ...(revisionId ? { revisionId } : {}),
    });
    return apiResult(req, {
      ok: true,
      data: { [contract.listKey]: rows.map(contract.serialise) },
    });
  });

  const POST = apiRoute(async (req) => {
    const guarded = await guard(req, "data.write");
    if (!guarded.ok) return guarded.response;

    const body = await req.json().catch(() => null);
    const parsed = contract.parseNew(body);
    if (!parsed.ok) return apiValidationDetail(req, { field: parsed.field });

    const foreign = await foreignField(
      contract,
      guarded.companyId,
      parsed.values,
    );
    if (foreign) return apiValidationDetail(req, { field: foreign });

    const ready = await prepared(contract, guarded, parsed.values);
    if (!ready.ok) return apiValidationDetail(req, ready.detail);
    // The re-check is what lets `createRow` keep its `NewRowValues` promise
    // across a hook that may add and override columns: a hook that dropped
    // `revision_id` is refused here rather than reaching the insert.
    const values = asNewRowValues(ready.values);
    if (!values.ok) return apiValidationDetail(req, { field: values.field });

    const result = await createRow(
      db,
      guarded.session,
      contract.table,
      values.values,
    );
    if (!result.ok) return refusal(req, result);
    return apiResult(req, { ok: true, data: contract.serialise(result.row) });
  });

  return { GET, POST, OPTIONS: optionsHandler };
}

/** `GET`/`PATCH`/`DELETE` of one row: any version, LC-5 and LC-6. */
export function rowItemRoutes<Dto>(contract: RowWireContract<Dto>) {
  const GET = apiRoute<[Ctx]>(async (req, ctx) => {
    const guarded = await guard(req, "data.read");
    if (!guarded.ok) return guarded.response;

    const { id } = await ctx.params;
    if (!isUuid(id)) return apiResult(req, { ok: false, error: "NO_DATA" });

    const row = await getVersion(db, guarded.companyId, contract.table, id);
    if (!row) return apiResult(req, { ok: false, error: "NO_DATA" });
    return apiResult(req, { ok: true, data: contract.serialise(row) });
  });

  const PATCH = apiRoute<[Ctx]>(async (req, ctx) => {
    const guarded = await guard(req, "data.write");
    if (!guarded.ok) return guarded.response;

    const { id } = await ctx.params;
    if (!isUuid(id)) return apiValidationDetail(req, { field: "id" });

    const body = await req.json().catch(() => null);
    const parsed = contract.parsePatch(body);
    if (!parsed.ok) return apiValidationDetail(req, { field: parsed.field });
    const reason = parseChangeReason(body);
    if (!reason.ok) return apiValidationDetail(req, { field: reason.field });

    const foreign = await foreignField(
      contract,
      guarded.companyId,
      parsed.values,
    );
    if (foreign) return apiValidationDetail(req, { field: foreign });

    // A DELTA has to be judged against the row it is a delta OF (see
    // `RowPrepareContext.current`). An id that names nothing is left to
    // `editRow`, which answers NOT_FOUND for a foreign, superseded or
    // tombstoned target — one place, not two.
    const current = contract.prepare
      ? await getVersion(db, guarded.companyId, contract.table, id)
      : undefined;
    const ready = await prepared(contract, guarded, parsed.values, current);
    if (!ready.ok) return apiValidationDetail(req, ready.detail);

    const result = await editRow(db, guarded.session, contract.table, id, {
      values: ready.values,
      changeReason: reason.values.changeReason,
    });
    if (!result.ok) return refusal(req, result);
    return apiResult(req, { ok: true, data: contract.serialise(result.row) });
  });

  const DELETE = apiRoute<[Ctx]>(async (req, ctx) => {
    const guarded = await guard(req, "data.write");
    if (!guarded.ok) return guarded.response;

    const { id } = await ctx.params;
    if (!isUuid(id)) return apiValidationDetail(req, { field: "id" });

    // A DELETE may carry a body (`{change_reason}`); most clients send none, and
    // an absent body is not an error — only a malformed one is.
    const body = await req.json().catch(() => null);
    const reason = parseChangeReason(body);
    if (!reason.ok) return apiValidationDetail(req, { field: reason.field });

    const result = await deleteRow(db, guarded.session, contract.table, id, {
      changeReason: reason.values.changeReason,
    });
    if (!result.ok) return refusal(req, result);
    return apiResult(req, { ok: true, data: contract.serialise(result.row) });
  });

  return { GET, PATCH, DELETE, OPTIONS: optionsHandler };
}

/**
 * `POST …/[id]/approve` — LC-4. The response is a NEW row, not the one that was
 * approved: approval is a version, so the returned `id` differs from the `:id`
 * in the path and the author of the data stays visible one link back.
 */
export function rowApproveRoute<Dto>(contract: RowWireContract<Dto>) {
  const POST = apiRoute<[Ctx]>(async (req, ctx) => {
    const guarded = await guard(req, "data.approve");
    if (!guarded.ok) return guarded.response;

    const { id } = await ctx.params;
    if (!isUuid(id)) return apiValidationDetail(req, { field: "id" });

    const result = await approveRow(db, guarded.session, contract.table, id);
    if (!result.ok) return refusal(req, result);
    return apiResult(req, { ok: true, data: contract.serialise(result.row) });
  });

  return { POST, OPTIONS: optionsHandler };
}

/**
 * `GET …/[id]/history` — API-2, LC-10. The version chain IS the audit trail of
 * an input row, and ANY version of it identifies the chain: a stale tab or a
 * link in a review comment holds a superseded id and must reach the same list.
 */
export function rowHistoryRoute<Dto>(contract: RowWireContract<Dto>) {
  const GET = apiRoute<[Ctx]>(async (req, ctx) => {
    const guarded = await guard(req, "data.read");
    if (!guarded.ok) return guarded.response;

    const { id } = await ctx.params;
    if (!isUuid(id)) return apiResult(req, { ok: false, error: "NO_DATA" });

    const chain = await history(db, guarded.companyId, contract.table, id);
    if (chain.versions.length === 0) {
      return apiResult(req, { ok: false, error: "NO_DATA" });
    }
    return apiResult(req, {
      ok: true,
      data: {
        versions: chain.versions.map(contract.serialise),
        // The walk stops at a depth cap (`MAX_VERSION_CHAIN`); saying so is the
        // difference between "this is the history" and "this is as much of it
        // as we are willing to walk".
        truncated: chain.truncated,
      },
    });
  });

  return { GET, OPTIONS: optionsHandler };
}
