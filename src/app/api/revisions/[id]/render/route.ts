/**
 * POST /api/revisions/:id/render — produce ONE immutable render of a revision
 * (T5.7; REN-3, REN-4, REN-5, DM-30, DM-31, D14, PG-2, О-14).
 * GET  /api/revisions/:id/render — what that POST WOULD produce (T5.8; UI-5).
 *
 * See docs/decisions/app-api-revisions-id-render-route.md for the full account.
 */
import { isReportLanguage } from "@/i18n/locales";
import {
  apiResult,
  apiRoute,
  apiValidationDetail,
  isUuid,
  optionsHandler,
} from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { requireReportFormat } from "@/server/billing/guard";
import { db } from "@/server/db";
import { logAudit } from "@/server/db/audit";
import {
  defaultRenderLanguage,
  getRender,
  isRenderFormat,
  renderPreview,
  renderRevision,
  serialiseRender,
  serialiseRenderPreview,
  RENDER_FORMATS,
} from "@/server/render/persist";
import { getRevision } from "@/server/revisions/revisions";

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
  if (!isUuid(id)) return apiResult(req, { ok: false, error: "NO_DATA" });

  const revision = await getRevision(db, company.id, id);
  if (!revision) return apiResult(req, { ok: false, error: "NO_DATA" });

  // О-14 — the preview is language-specific because the completeness NOTE is:
  // the same exclusions read differently in `en` and `sl`, and the screen must
  // show the sentence the file will actually carry. An unknown value is refused
  // rather than coerced, exactly as on the POST.
  const requested = new URL(req.url).searchParams.get("language");
  if (requested !== null && !isReportLanguage(requested)) {
    return apiValidationDetail(req, { field: "language" });
  }
  const language =
    requested === null
      ? await defaultRenderLanguage(db, session.userId)
      : requested;

  const preview = await renderPreview(db, company.id, revision, language);
  return apiResult(req, {
    ok: true,
    data: { preview: serialiseRenderPreview(revision, language, preview) },
  });
});

export const POST = apiRoute<[Ctx]>(async (req, ctx) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const body = (await req.json().catch(() => null)) as {
    format?: unknown;
    language?: unknown;
  } | null;

  const format = body?.format;
  if (!isRenderFormat(format)) {
    return apiValidationDetail(req, {
      field: "format",
      allowed: [...RENDER_FORMATS],
    });
  }
  // О-14: an unknown language is refused, never coerced. See the header.
  const requested = body?.language;
  if (
    requested !== undefined &&
    requested !== null &&
    !isReportLanguage(requested)
  ) {
    return apiValidationDetail(req, { field: "language" });
  }

  const forbidden = requireCapability(session, "data.review");
  if (forbidden) return apiResult(req, forbidden);

  // PG-2 — the ONE tariff gate on this route.
  const denied = await requireReportFormat(session, format);
  if (denied) return apiResult(req, denied);

  const { id } = await ctx.params;
  if (!isUuid(id)) return apiResult(req, { ok: false, error: "NO_DATA" });

  const revision = await getRevision(db, company.id, id);
  if (!revision) return apiResult(req, { ok: false, error: "NO_DATA" });

  const language =
    requested === undefined || requested === null
      ? await defaultRenderLanguage(db, session.userId)
      : requested;

  const outcome = await renderRevision(db, company.id, revision, {
    format,
    language,
    renderedBy: session.userId,
  });

  if (!outcome.ok) {
    if (outcome.error === "NO_DATA") {
      return apiResult(req, { ok: false, error: "NO_DATA" });
    }
    // REN-3 refused. The REASON is the contract the screen explains (T5.8).
    return apiValidationDetail(req, {
      reason: outcome.failure.reason,
      ...outcome.failure.detail,
    });
  }

  // A render is a published FACT about the report and is audited like every
  // other one (LC-10). `create` because a render is appended, never amended.
  await logAudit(db, {
    companyId: company.id,
    userId: session.userId,
    actorRole: session.membership?.role ?? null,
    entity: "report_render",
    entityId: outcome.row.id,
    action: "create",
    summary: {
      revision_id: revision.id,
      format: outcome.row.format,
      language: outcome.row.language,
      file_hash: outcome.row.fileHash,
      coverage_claim: outcome.row.coverageClaim,
      excluded_by_plan: outcome.row.excludedByPlan,
      calc_run_id: outcome.row.calcRunId,
    },
  });

  // Re-read through the join so the response carries the period and revision
  // number the filename and the T5.8 list are built from.
  const stored = await getRender(db, company.id, outcome.row.id);
  if (!stored) return apiResult(req, { ok: false, error: "PERSIST_FAILED" });

  return apiResult(req, {
    ok: true,
    data: { render: serialiseRender(stored), size_bytes: outcome.bytes },
  });
});

export const OPTIONS = optionsHandler;
