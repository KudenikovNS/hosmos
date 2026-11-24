// REN-3 / REN-4 / REN-5 — AN IMMUTABLE RENDER (T5.7; DM-30, DM-31, D14, PG-4,
// О-14, AC-12).
//
// See docs/decisions/server-render-persist.md for the full account.
import "server-only";

import {
  deleteUnreferencedBlob,
  prepareBlobReference,
} from "@/server/storage/blob-references";

import { and, desc, eq, sql } from "drizzle-orm";

import {
  isReportLanguage,
  reportLanguageFor,
  type ReportLanguage,
} from "@/i18n/locales";
import {
  isRenderableStatus,
  RENDERABLE_REVISION_STATUSES,
  type RenderFormat,
  type RenderGateReason,
} from "@/shared/reports";
import type { DbClient } from "@/server/db/client";
import {
  periodScope,
  profiles,
  reportRender,
  reportRevision,
  reportingPeriod,
} from "@/server/db/schema";
import {
  frozenRenderBoundary,
  historicalRenderContext,
  historicalRenderCoverage,
} from "./historical";
import { runFreshness } from "@/server/calc/run";
import { listFacilities } from "@/server/org/facilities";
import { listLegalEntities } from "@/server/org/legal-entities";
import {
  facilityGateVerdict,
  planOrgLimits,
  type FacilityGateVerdict,
} from "@/server/periods/plan-gate";
import type { RevisionRow } from "@/server/revisions/revisions";
import {
  documentStorage,
  type DocumentStorage,
} from "@/server/storage/document-storage";
import { storedBlockingFailures } from "@/server/validation/run";

import type { PlanExclusion, RenderCoverage } from "./disclaimer";
import { renderContext, type RenderContext } from "./i18n";
import { loadRenderInput, renderVsmeBasicPdf } from "./vsme-basic";
import { renderVsmeBasicXlsx, XLSX_MIME } from "./xlsx";

// ─── The formats ─────────────────────────────────────────────────────────────
//
// `RENDER_FORMATS` / `isRenderFormat` live in `@/shared/reports` (T5.8) and are
// re-exported here, unchanged, for every server caller that already imports them
// from this module. They moved because this file is `server-only` and the
// `/reports` wizard has to offer exactly the formats REN-3 accepts — see that
// module's header.

export { RENDER_FORMATS, isRenderFormat } from "@/shared/reports";

/** The MIME type each format is stored and served with. */
const FORMAT_MIME: Readonly<Record<RenderFormat, string>> = {
  pdf: "application/pdf",
  xlsx: XLSX_MIME,
};

/** The file extension each format is downloaded as. */
const FORMAT_EXTENSION: Readonly<Record<RenderFormat, string>> = {
  pdf: "pdf",
  xlsx: "xlsx",
};

/** `en`/`sl`, or the app default — an unknown value is never rendered blindly. */
function renderLanguageOf(value: unknown): ReportLanguage {
  return isReportLanguage(value)
    ? value
    : reportLanguageFor(typeof value === "string" ? value : null);
}

/**
 * The language a render gets when the caller did not name one (О-14).
 *
 * The acting user's own `profiles.locale`, falling back to the app default. A
 * DEFAULT, not a preference: it is resolved once, before the render, and then
 * frozen onto the row — reading the same file later in the other UI language
 * must not change what the file says.
 */
export async function defaultRenderLanguage(
  db: DbClient,
  userId: string,
): Promise<ReportLanguage> {
  const [row] = await db
    .select({ locale: profiles.locale })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  return renderLanguageOf(row?.locale);
}

// ─── D14: what the plan leaves out ───────────────────────────────────────────

/** Unlimited, in the `PlanFeatures` numeric-limit convention. */
const UNLIMITED = -1;

/**
 * The F1 rule, which this gate must NOT enforce. See the module header: a plan
 * limit blocks a LOCK and stamps a RENDER, and confusing the two would make
 * AC-12 impossible to satisfy.
 */
const PLAN_GATE_RULE = "VAL-105";

/**
 * The records the subscription plan leaves outside the report (REN-4, PG-4).
 *
 * THE ORDER IS THE ORDER THE ROWS WERE CREATED IN, and that is what makes this
 * agree with the guard that would have refused an over-limit write. `POST
 * /api/org/facilities` refuses when `countFacilities() >= maxFacilities`, and
 * `countFacilities` counts exactly the set `listFacilities` returns, sorted by
 * `(created_at, id)`. So the rows that could never have been created through the
 * API are precisely the tail past the limit, and
 *
 *     excludedByPlan.length > 0   ⟺   the registry is over the limit
 *                                 ⟺   the create guard would refuse the next row
 *
 * holds by construction rather than by two implementations happening to agree.
 * The same argument runs for `maxLegalEntities` / `countLegalEntities`.
 *
 * WHICH MEANS THE SET IS NORMALLY EMPTY, and the interesting question is how it
 * ever fills. A DOWNGRADE: a `pro` company with 15 sites moving to `starter`
 * keeps its 15 rows (nothing deletes customer data on a plan change) and its
 * limit drops to 3. The report it can produce afterwards covers 3 of them, and
 * D14 is the rule that says so out loud instead of quietly printing a smaller
 * inventory as if it were the whole one.
 *
 * THE ONE PLACE THE TWO SIDES CAN DISAGREE is whose plan they read.
 * `requireWithinLimit` reads `getEntitlements().writeFeatures`, which downgrades
 * a LAPSED subscription to trial; `planOrgLimits` reads `companies.plan`, as F1
 * does, for the reason `plan-gate.ts` gives — a billing lapse must not silently
 * re-decide what a finished report claims to cover. So during a lapse the create
 * guard is the stricter of the two. That is deliberate: the guard gates BUYING
 * capacity, the stamp describes a REPORT.
 */
async function planExclusions(
  db: DbClient,
  companyId: string,
): Promise<{ excluded: PlanExclusion[]; counts: PlanExclusionCounts }> {
  const limits = await planOrgLimits(db, companyId);
  const [entities, facilities] = await Promise.all([
    listLegalEntities(db, companyId),
    listFacilities(db, companyId),
  ]);

  const overflow = <T>(rows: readonly T[], limit: number): readonly T[] =>
    limit === UNLIMITED ? [] : rows.slice(Math.max(limit, 0));

  const excludedEntities = overflow(entities, limits.maxLegalEntities);
  const excludedFacilities = overflow(facilities, limits.maxFacilities);

  return {
    excluded: [
      ...excludedEntities.map((row): PlanExclusion => ({
        type: "legal_entity",
        id: row.id,
        name: row.name,
      })),
      ...excludedFacilities.map((row): PlanExclusion => ({
        type: "facility",
        id: row.id,
        name: row.facilityName,
      })),
    ],
    counts: {
      plan: limits.plan,
      entities: {
        total: entities.length,
        excluded: excludedEntities.length,
        limit: limits.maxLegalEntities,
      },
      facilities: {
        total: facilities.length,
        excluded: excludedFacilities.length,
        limit: limits.maxFacilities,
      },
    },
  };
}

/** The numbers behind the completeness note — one line per limited axis. */
interface PlanExclusionCounts {
  readonly plan: string;
  readonly entities: { total: number; excluded: number; limit: number };
  readonly facilities: { total: number; excluded: number; limit: number };
}

/**
 * The completeness note D14 requires beside a `partial` claim, in the render's
 * language.
 *
 * A bare "coverage is partial" is a statement nobody can act on; the note names
 * the axis, the counts and the limit, so the reader learns what is missing and
 * the customer learns which upgrade would restore it.
 */
function completenessNote(
  ctx: RenderContext,
  counts: PlanExclusionCounts,
): string {
  const details: string[] = [];
  if (counts.entities.excluded > 0) {
    details.push(
      ctx.t("completeness.planNoteEntities", {
        excluded: ctx.count(counts.entities.excluded),
        total: ctx.count(counts.entities.total),
        limit: ctx.count(counts.entities.limit),
      }),
    );
  }
  if (counts.facilities.excluded > 0) {
    details.push(
      ctx.t("completeness.planNoteFacilities", {
        excluded: ctx.count(counts.facilities.excluded),
        total: ctx.count(counts.facilities.total),
        limit: ctx.count(counts.facilities.limit),
      }),
    );
  }
  return ctx.t("completeness.planNote", {
    plan: counts.plan,
    details: details.join("; "),
  });
}

/**
 * The D14 coverage stamp for one company, in one language.
 *
 * `claim` is DERIVED from the exclusions and never passed in — the whole point
 * of REN-4 is that the renderer cannot be asked for a `full` report it is not
 * entitled to make. DM-31 then refuses to store the pair even if this function
 * were bypassed.
 */
export async function planCoverage(
  db: DbClient,
  companyId: string,
  language: ReportLanguage,
): Promise<RenderCoverage> {
  const { excluded, counts } = await planExclusions(db, companyId);
  if (excluded.length === 0) {
    return { claim: "full", completenessNote: null, excludedByPlan: [] };
  }
  return {
    claim: "partial",
    completenessNote: completenessNote(renderContext(language), counts),
    excludedByPlan: excluded,
  };
}

// ─── REN-3: may this revision be rendered at all? ────────────────────────────

/**
 * Why a render was refused. The reason is the contract the screen explains, so
 * the list lives in `@/shared/reports` where the screen can read it too.
 */
/** A refusal, with everything the caller needs to explain it. */
export interface RenderGateFailure {
  readonly reason: RenderGateReason;
  readonly detail: Record<string, unknown>;
}

/**
 * REN-3, as three checks in the order a preparer would fix them.
 *
 * STALENESS IS NOT ONE OF THEM, on purpose. `runFreshness` also reports whether
 * an input moved after the run, and the `approve` transition already refuses on
 * that; once a revision is approved its rows can no longer be written, so a
 * fresh-at-approval run cannot go stale under a render. Re-refusing here would
 * add a fourth refusal that can only fire when something else is already broken.
 * The known historical output-unit fault is checked explicitly: it requires
 * recalculation for an open revision, or restatement for a locked one.
 */
export async function renderGate(
  db: DbClient,
  companyId: string,
  revision: RevisionRow,
): Promise<RenderGateFailure | null> {
  if (!isRenderableStatus(revision.status)) {
    return {
      reason: "revision_not_approved",
      detail: {
        status: revision.status,
        allowed: RENDERABLE_REVISION_STATUSES,
      },
    };
  }

  if (revision.status === "locked" && !frozenRenderBoundary(revision)) {
    return {
      reason: "historical_context_missing",
      detail: { revision_id: revision.id },
    };
  }
  const historical = historicalRenderContext(companyId, revision);
  if (historical && historical.run_id === null)
    return { reason: "no_green_run", detail: { run_id: null, failed: null } };
  const freshness = await runFreshness(
    db,
    companyId,
    revision,
    historical?.run_id ?? undefined,
  );
  if (
    !freshness.run ||
    freshness.run.status !== "ok" ||
    (revision.status !== "locked" && freshness.staleSources.includes("formula"))
  ) {
    return {
      reason: "no_green_run",
      detail: {
        run_id: freshness.run?.runId ?? null,
        failed: freshness.run?.failedCount ?? null,
      },
    };
  }

  // A successor's mutable period validation cannot invalidate a closed report.
  // A known error in its own pinned calculation does prevent a new publication.
  if (
    revision.status === "locked" &&
    freshness.staleSources.includes("formula")
  )
    return {
      reason: "historical_formula_unsupported",
      detail: {
        revision_id: revision.id,
        run_id: freshness.run.runId,
        requires_restatement: true,
      },
    };
  if (revision.status === "locked") return null;
  const blocking = await periodBlockingFailures(db, companyId, revision);
  if (blocking.length > 0) {
    return {
      reason: "period_blocking_errors",
      detail: {
        rules: [...new Set(blocking.map((row) => row.ruleCode))].sort(),
      },
    };
  }

  return null;
}

/**
 * The stored blocking `period` failures that are about THIS period.
 *
 * `storedBlockingFailures` answers for the whole company, because that is what
 * the submit gate needs; a render is about one period, and refusing it over a
 * finding recorded against a different year would be a refusal nobody could act
 * on from the screen they are standing in. The `period` rules address three
 * object types (`reporting_period`, `period_scope`, `legal_entity`), so the
 * period's boundary is read once and used to decide which findings belong to it.
 *
 * `VAL-105` is dropped for the reason in the module header: it IS the plan
 * limit, and D14 stamps plan limits rather than blocking on them (AC-12).
 */
async function periodBlockingFailures(
  db: DbClient,
  companyId: string,
  revision: RevisionRow,
) {
  const stored = await storedBlockingFailures(db, companyId, "period");
  if (stored.length === 0) return stored;

  const boundary = await db
    .select({
      id: periodScope.id,
      legalEntityId: periodScope.legalEntityId,
    })
    .from(periodScope)
    .where(
      and(
        eq(periodScope.companyId, companyId),
        eq(periodScope.periodId, revision.periodId),
      ),
    );
  const scopeIds = new Set(boundary.map((row) => row.id));
  const entityIds = new Set(boundary.map((row) => row.legalEntityId));

  return stored.filter((row) => {
    if (row.ruleCode === PLAN_GATE_RULE) return false;
    if (row.revisionId === revision.id) return true;
    if (row.objectId === null) return false;
    if (row.objectType === "reporting_period")
      return row.objectId === revision.periodId;
    if (row.objectType === "period_scope") return scopeIds.has(row.objectId);
    if (row.objectType === "legal_entity") return entityIds.has(row.objectId);
    return false;
  });
}

// ─── The preview: the same two answers, before anything is written ──────────

/**
 * What a render of this revision, in this language, WOULD be (T5.8, UI-5, D14).
 *
 * See docs/decisions/server-render-persist-L403.md for the full account.
 */
export interface RenderPreview {
  /** `null` when REN-3 would let this revision through; the refusal otherwise. */
  readonly gate: RenderGateFailure | null;
  /** D14's stamp, exactly as it would be written to the row. */
  readonly coverage: RenderCoverage;
  /** F1/PG-3 as `approved → locked` will see it. Never blocks a render. */
  readonly lockGate: FacilityGateVerdict;
}

/**
 * Evaluate REN-3, D14 and F1 for one revision without writing anything.
 *
 * The three are independent — a gate refusal says nothing about coverage, and
 * neither says anything about the lock — so they are resolved together rather
 * than short-circuited. All three are pure reads.
 */
export async function renderPreview(
  db: DbClient,
  companyId: string,
  revision: RevisionRow,
  language: ReportLanguage,
): Promise<RenderPreview> {
  const [gate, coverage, lockGate] = await Promise.all([
    renderGate(db, companyId, revision),
    historicalRenderCoverage(companyId, revision, language) ??
      planCoverage(db, companyId, language),
    historicalRenderContext(companyId, revision)?.lock_gate ??
      facilityGateVerdict(db, companyId, revision.periodId),
  ]);
  return { gate, coverage, lockGate };
}

/** A preview on the wire (§12.2 shape). Snake_case, like every other DTO. */
export interface RenderPreviewDto {
  revision_id: string;
  language: string;
  /** Would `POST …/render` succeed? The screen explains `gate_reason` when not. */
  renderable: boolean;
  /** The same refusal reason used by the render API. */
  gate_reason: RenderGateReason | null;
  /** The refusal's own payload (status, run id, rule codes) — for the sentence. */
  gate_detail: Record<string, unknown> | null;
  coverage_claim: RenderCoverage["claim"];
  completeness_note: string | null;
  excluded_by_plan: readonly PlanExclusion[];
  /**
   * F1/PG-3 (§11.3) — what `approved → locked` would answer, for the warning
   * the wizard shows BEFORE a Lock is attempted. `applies` is false on the
   * plans F1 does not hard-gate, so a screen never has to know which those are.
   */
  lock_gate: {
    plan: string;
    applies: boolean;
    limit: number;
    facilities: number;
    passed: boolean;
  };
}

/** A {@link RenderPreview} as the API returns it. */
export function serialiseRenderPreview(
  revision: RevisionRow,
  language: ReportLanguage,
  preview: RenderPreview,
): RenderPreviewDto {
  return {
    revision_id: revision.id,
    language,
    renderable: preview.gate === null,
    gate_reason: preview.gate?.reason ?? null,
    gate_detail: preview.gate?.detail ?? null,
    coverage_claim: preview.coverage.claim,
    completeness_note: preview.coverage.completenessNote,
    excluded_by_plan: preview.coverage.excludedByPlan,
    lock_gate: {
      plan: preview.lockGate.plan,
      applies: preview.lockGate.applies,
      limit: preview.lockGate.limit,
      facilities: preview.lockGate.facilities,
      passed: preview.lockGate.passed,
    },
  };
}

// ─── The render itself ───────────────────────────────────────────────────────

/** A `report_render` row as Drizzle reads it. */
export type RenderRow = typeof reportRender.$inferSelect;

/** What `renderRevision` was asked to produce. */
export interface RenderRequest {
  readonly format: RenderFormat;
  /** О-14 — resolved by the caller from the body, the session or the company. */
  readonly language: ReportLanguage;
  /** DM-13 — `profiles.id` of whoever pressed Render. */
  readonly renderedBy: string;
  /** Injected so a test can pin the cover's timestamp. */
  readonly generatedAt?: Date;
  /** Injected by the storage-failure tests; production uses the singleton. */
  readonly storage?: DocumentStorage;
}

/** Success, a refusal with a reason, or "there is nothing to render". */
export type RenderResult =
  | { readonly ok: true; readonly row: RenderRow; readonly bytes: number }
  | { readonly ok: false; readonly error: "NO_DATA" }
  | {
      readonly ok: false;
      readonly error: "VALIDATION";
      readonly failure: RenderGateFailure;
    };

/**
 * Gate → render → store → insert. The whole of REN-3…REN-5 for one revision.
 *
 * THE BYTES GO THROUGH `DocumentStorage` AND NOWHERE ELSE (EV-0/REN-5). The
 * storage key is content-addressed, so `file_hash` is not a second computation
 * of the digest that could drift from the file: it IS the key's object part,
 * returned by the write that produced it.
 *
 * The row is inserted AFTER the bytes are on disk. The other order would allow a
 * `report_render` pointing at a `storage_key` that does not exist; this order
 * can at worst leave an unreferenced blob, which is the failure the T4.1
 * hardening already accounts for (a blob is only ever deleted when no row still
 * names its key).
 */
export async function renderRevision(
  db: DbClient,
  companyId: string,
  revision: RevisionRow,
  request: RenderRequest,
): Promise<RenderResult> {
  // THE SAME CALL THE PREVIEW MAKES (T5.8). `coverage` below is the object the
  // `/reports` wizard has already shown the user; it is inserted verbatim, so
  // the preview and the stamp cannot be two implementations of D14. The
  // preview's third answer (`lockGate`) is not read here and costs two reads a
  // render — a price worth paying for there being ONE way to ask "what would
  // this render be", next to a PDF that costs orders of magnitude more.
  const { gate: failure, coverage } = await renderPreview(
    db,
    companyId,
    revision,
    request.language,
  );
  if (failure) return { ok: false, error: "VALIDATION", failure };

  const input = await loadRenderInput(db, companyId, revision, {
    language: request.language,
    coverage,
    generatedAt: request.generatedAt,
  });
  // The gate above proved a green run exists, so a `null` here means the
  // PERIOD is gone — there is no report to make about it (`loadRenderInput`).
  if (!input || !input.run) return { ok: false, error: "NO_DATA" };
  const runId = input.run.runId;

  const rendered =
    request.format === "pdf"
      ? await renderVsmeBasicPdf(input)
      : await renderVsmeBasicXlsx(input);
  const bytes = "pdf" in rendered ? rendered.pdf : rendered.xlsx;

  const storage = request.storage ?? documentStorage;
  const stored = await storage.put(bytes, {
    companyId,
    mime: FORMAT_MIME[request.format],
  });

  const row = await db
    .transaction(async (tx) => {
      await prepareBlobReference(tx, companyId, stored, storage, () =>
        storage.put(bytes, { companyId, mime: FORMAT_MIME[request.format] }),
      );
      const [row] = await tx
        .insert(reportRender)
        .values({
          companyId,
          revisionId: revision.id,
          format: request.format,
          language: request.language,
          storageKey: stored.key,
          fileHash: stored.sha256,
          coverageClaim: coverage.claim,
          completenessNote: coverage.completenessNote,
          excludedByPlan: coverage.excludedByPlan,
          disclaimerText: rendered.disclaimerText,
          calcRunId: runId,
          renderedBy: request.renderedBy,
        })
        .returning();
      return row;
    })
    .catch(async (error) => {
      await deleteUnreferencedBlob(db, companyId, stored.key, storage);
      throw error;
    });

  return { ok: true, row, bytes: stored.sizeBytes };
}

// ─── Reading renders back ────────────────────────────────────────────────────

/** A render, joined to the period and revision a download's filename needs. */
export interface RenderWithContext {
  readonly row: RenderRow;
  readonly periodName: string | null;
  readonly periodNameIsCurrent: boolean;
  readonly revisionNo: number | null;
}

// Extract just the trusted name in PostgreSQL; never transfer both full
// historical snapshots for every archived render.
const HISTORICAL_PERIOD_NAME = sql<string | null>`case when
  ${reportRevision.frozenScope}->>'version' = '1'
  and ${reportRevision.frozenScope}->>'period_id' = ${reportRevision.periodId}::text
  and ${reportRevision.frozenScope}#>>'{render_context,version}' = '1'
  and ${reportRevision.frozenScope}#>>'{render_context,company_id}' = ${reportRevision.companyId}::text
  and ${reportRevision.frozenScope}#>>'{render_context,revision_id}' = ${reportRevision.id}::text
  and ${reportRevision.frozenScope}#>>'{render_context,data,en,period,id}' = ${reportRevision.periodId}::text
  then ${reportRevision.frozenScope}#>>'{render_context,data,en,period,name}'
  else null end`;

/** The `select` shape shared by the list and the single read. */
const RENDER_SELECTION = {
  row: reportRender,
  periodName: sql<string | null>`case when ${reportRevision.status} = 'locked'
    then coalesce(${HISTORICAL_PERIOD_NAME}, ${reportingPeriod.periodName})
    else ${reportingPeriod.periodName} end`,
  periodNameIsCurrent: sql<boolean>`${reportRevision.status} = 'locked'
    and (${HISTORICAL_PERIOD_NAME}) is null`,
  revisionNo: reportRevision.revisionNo,
};

/**
 * Every render of a company, newest first, optionally narrowed to one revision.
 *
 * Tenant-pinned, so a foreign `revisionId` reads as an empty list rather than
 * another company's reports (API-1).
 */
export async function listRenders(
  db: DbClient,
  companyId: string,
  revisionId?: string,
): Promise<RenderWithContext[]> {
  const rows = await db
    .select(RENDER_SELECTION)
    .from(reportRender)
    .innerJoin(reportRevision, eq(reportRevision.id, reportRender.revisionId))
    .innerJoin(reportingPeriod, eq(reportingPeriod.id, reportRevision.periodId))
    .where(
      revisionId
        ? and(
            eq(reportRender.companyId, companyId),
            eq(reportRender.revisionId, revisionId),
          )
        : eq(reportRender.companyId, companyId),
    )
    .orderBy(desc(reportRender.renderedAt));
  return rows;
}

/** One render of THIS company, or `null` (a foreign id reads as absent, API-1). */
export async function getRender(
  db: DbClient,
  companyId: string,
  id: string,
): Promise<RenderWithContext | null> {
  const [row] = await db
    .select(RENDER_SELECTION)
    .from(reportRender)
    .innerJoin(reportRevision, eq(reportRevision.id, reportRender.revisionId))
    .innerJoin(reportingPeriod, eq(reportingPeriod.id, reportRevision.periodId))
    .where(and(eq(reportRender.companyId, companyId), eq(reportRender.id, id)))
    .limit(1);
  return row ?? null;
}

/** Characters a download filename may carry — everything else becomes `-`. */
const FILENAME_UNSAFE = /[^A-Za-z0-9._-]+/g;

/**
 * The name the browser saves a render under.
 *
 * Derived from the period, the revision number and the LANGUAGE, because the
 * language is part of the render's identity (О-14): two files of the same
 * revision landing in one download folder must not be `report.pdf` and
 * `report (1).pdf`.
 */
export function renderFileName(render: RenderWithContext): string {
  const parts = [
    "VSME-Basic",
    render.periodName ?? render.row.revisionId.slice(0, 8),
    ...(render.periodNameIsCurrent ? ["current-period-name"] : []),
    `rev${render.revisionNo ?? 0}`,
    render.row.language,
  ];
  const stem = parts
    .join("_")
    .replace(FILENAME_UNSAFE, "-")
    .replace(/^-+|-+$/g, "");
  const format = render.row.format as RenderFormat;
  return `${stem || "report"}.${FORMAT_EXTENSION[format] ?? "bin"}`;
}

/** The `Content-Type` a render is served with. */
export function renderMime(row: RenderRow): string {
  return FORMAT_MIME[row.format as RenderFormat] ?? "application/octet-stream";
}

/** One render on the wire (§12.2 shape). `storage_key` is deliberately absent. */
export interface RenderDto {
  id: string;
  revision_id: string;
  period_name: string | null;
  period_name_is_current: boolean;
  revision_no: number | null;
  pack_code: string;
  format: string;
  language: string;
  file_hash: string;
  file_name: string;
  coverage_claim: string;
  completeness_note: string | null;
  excluded_by_plan: PlanExclusion[];
  disclaimer_text: string;
  calc_run_id: string;
  rendered_by: string;
  rendered_at: string | null;
}

/**
 * A render as the API returns it.
 *
 * `storage_key` never leaves the server: it is the address of the bytes inside
 * `DOCUMENTS_DIR`, and the ONLY sanctioned way to those bytes is
 * `GET /api/renders/[id]/download`, which re-checks the tenant.
 */
export function serialiseRender(render: RenderWithContext): RenderDto {
  const { row } = render;
  return {
    id: row.id,
    revision_id: row.revisionId,
    period_name: render.periodName,
    period_name_is_current: render.periodNameIsCurrent,
    revision_no: render.revisionNo,
    pack_code: row.packCode,
    format: row.format,
    language: row.language,
    file_hash: row.fileHash,
    file_name: renderFileName(render),
    coverage_claim: row.coverageClaim,
    completeness_note: row.completenessNote,
    excluded_by_plan: (row.excludedByPlan ?? []) as PlanExclusion[],
    disclaimer_text: row.disclaimerText,
    calc_run_id: row.calcRunId,
    rendered_by: row.renderedBy,
    rendered_at: row.renderedAt ? row.renderedAt.toISOString() : null,
  };
}
