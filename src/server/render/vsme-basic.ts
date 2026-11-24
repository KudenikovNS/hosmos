// =============================================================================
// REN-1 — THE HARDCODED VSME BASIC RENDERER (T5.6).
//
// Two halves, and the seam between them is the point of the file:
//   • {@link loadRenderInput} — every read the report needs, in one place.
//   • {@link renderVsmeBasicPdf} — the input, as bytes.
// `sections.ts` sits between them and owns the WORDS. Nothing here decides what
// the report says; nothing there knows a database exists.
//
// ── SERVER-SIDE, WHICH IS NOT WHAT THE DELETED LEGACY DID ───────────────────
// The renderer T3.8 deleted built its PDF in the BROWSER (`pdfmake/build/pdfmake`
// plus a base64 VFS) and handed the user a download. Phase 1 needs a FILE with a
// `storage_key` and a `file_hash` (REN-5): a report whose bytes are assembled on
// the reader's machine cannot be pinned by a hash, because there are as many
// byte streams as there are readers. So the printer runs here, on the server,
// through `pdfmake/src/printer` — the Node class, not the bundled browser entry.
//
// ── R-9: THE IMPORT PATH IS THE RISK ────────────────────────────────────────
// `pdfmake/src/printer` is an UNBUNDLED CJS path inside the package, not its
// entry point, and `@foliojs-fork/pdfkit` underneath it reads `.afm` metrics and
// `.trie` tables off disk at runtime. Next's standalone tracer has already
// pruned a package this project needed (`deploy.yml` copies `drizzle-orm` and
// `postgres` back by hand for exactly that reason), and a bundler that inlined
// pdfkit's JavaScript would leave its DATA files behind. Both are handled in
// `next.config.mjs`: `serverExternalPackages` keeps pdfmake out of the bundle,
// and `outputFileTracingIncludes` copies its whole runtime closure into
// `.next/standalone`. `scripts/check-standalone-render.mjs` then renders a PDF
// out of that directory, because a vitest run over `src/` cannot prove anything
// about a bundle it never opens.
//
// ── THE FONT IS AN ASSET THIS REPO ALREADY OWNS ─────────────────────────────
// `src/features/reports/lib/figtree-vfs.ts` holds Figtree 400/700 with both
// italics, base64-encoded for the pdfmake VFS. T3.8 kept it ALIVE ON PURPOSE
// (knip ignore + a marker comment) so that this task would not have to re-embed
// a font two stages later, and this module is the consumer that comment names.
// The strings are decoded to `Buffer`s once, memoised for the process, and
// registered under the four face names PDFKit embeds them by.
// =============================================================================
import { conditionTexts } from "@/server/catalog/metric-text";
import { choiceLabel } from "@/shared/catalog/options";
import "server-only";

import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import PdfPrinter from "pdfmake/src/printer";
import type {
  Content,
  ContentTable,
  TDocumentDefinitions,
} from "pdfmake/interfaces";

import { figtreeVfs } from "@/features/reports/lib/figtree-vfs";
import {
  isReportLanguage,
  reportLanguageFor,
  type ReportLanguage,
} from "@/i18n/locales";
import type { DbClient } from "@/server/db/client";
import { getScope3Results } from "@/server/db/scope3-spend";
import {
  companies,
  disclosureApplicability,
  disclosureRecord,
  document as documentTable,
  dqAssessment,
  emissionActivity,
  evidenceLink,
  factorSet,
  legalEntity,
  metricCatalog,
  periodScope,
  reportRevision,
  reportingPeriod,
} from "@/server/db/schema";
import type { FactorSnapshot, RunLine } from "@/server/calc/run";
import { loadLatestRun, loadStoredRun } from "@/server/calc/run";
import {
  frozenRenderBoundary,
  historicalRenderContext,
  historicalRenderCoverage,
} from "./historical";
import { loadCompanyModules } from "@/server/billing/modules";
import {
  ACTIVITY_CATEGORIES,
  isActivityCategory,
} from "@/server/inventory/emission-activity";
import { currentRowIds } from "@/server/inventory/tables";
import type { RevisionRow } from "@/server/revisions/revisions";
import {
  isApplicabilityStatus,
  isConsolidationMethod,
  isQualityTier,
  isReportingBasis,
  QUALITY_TIERS,
  type QualityTier,
} from "@/shared/enums";

import type { RenderCoverage } from "./disclaimer";
import { disclaimerText } from "./disclaimer";
import { renderContext } from "./i18n";
import {
  buildSections,
  hasMandatoryGaps,
  type RenderEsrsIndex,
  sectionsToText,
  type RenderBlock,
  type RenderDisclosure,
  type RenderFactorBasis,
  type RenderFactorSubstitution,
  type RenderInput,
  type RenderScope1Category,
  type RenderScopeEntry,
  type RenderSection,
} from "./sections";

// ─── The font (R-9) ──────────────────────────────────────────────────────────

/** The family every style of the document resolves to. */
const RENDER_FONT_FAMILY = "Figtree";

/**
 * The four faces, by the VFS key that holds them.
 *
 * Named explicitly rather than derived from `Object.keys(figtreeVfs)` so that a
 * regenerated VFS missing the italic face fails HERE, with the face named,
 * instead of at layout time inside pdfmake with "font not found".
 */
export const RENDER_FONT_FACES = {
  normal: "Figtree-Regular.ttf",
  bold: "Figtree-Bold.ttf",
  italics: "Figtree-Italic.ttf",
  bolditalics: "Figtree-BoldItalic.ttf",
} as const;

/** The dictionary shape `new PdfPrinter(...)` takes — from its own signature. */
export type RenderFontDictionary = ConstructorParameters<typeof PdfPrinter>[0];

/** The decoded faces, once per process — 215 KB of base64 is not free. */
let fontCache: RenderFontDictionary | null = null;

/** One face, decoded, or a failure that names the face that is missing. */
function face(style: keyof typeof RENDER_FONT_FACES): Buffer {
  const key = RENDER_FONT_FACES[style];
  const encoded = figtreeVfs[key];
  if (!encoded) {
    throw new Error(
      `figtree-vfs.ts is missing the ${style} face (${key}) — the VSME renderer cannot embed a font it does not have (R-9)`,
    );
  }
  return Buffer.from(encoded, "base64");
}

/**
 * The font dictionary `PdfPrinter` is constructed with.
 *
 * Exported because the standalone check (R-9) calls it: "the font VFS shipped"
 * is a claim about these four buffers being decodable in the built artefact, and
 * the only honest way to make it is to decode them there.
 */
export function renderFonts(): RenderFontDictionary {
  if (fontCache) return fontCache;
  fontCache = {
    [RENDER_FONT_FAMILY]: {
      normal: face("normal"),
      bold: face("bold"),
      italics: face("italics"),
      bolditalics: face("bolditalics"),
    },
  };
  return fontCache;
}

// ─── The document definition ─────────────────────────────────────────────────

/** Points. A4 with room for the running footer. */
const PAGE_MARGINS: [number, number, number, number] = [48, 56, 48, 56];

/** One block of the document model → pdfmake content. */
function blockContent(block: RenderBlock): Content[] {
  switch (block.kind) {
    case "paragraph":
      return [{ text: block.text, style: "paragraph" }];
    case "subheading":
      return [{ text: block.text, style: "subheading" }];
    case "keyValues":
      return [
        {
          style: "table",
          table: {
            widths: ["40%", "60%"],
            body: block.rows.map((row) => [
              { text: row.label, style: "label" },
              { text: row.value },
            ]),
          },
          layout: "lightHorizontalLines",
        } satisfies ContentTable,
      ];
    case "table":
      return [
        {
          style: "table",
          table: {
            headerRows: 1,
            widths: block.columns.map(() => "*"),
            body: [
              block.columns.map((column) => ({ text: column, style: "label" })),
              ...block.rows.map((row) => row.map((cell) => ({ text: cell }))),
            ],
          },
          layout: "lightHorizontalLines",
        } satisfies ContentTable,
      ];
    case "list":
      return [{ ol: [...block.items], style: "paragraph" }];
  }
}

/** The sections as a pdfmake document definition. */
function buildDocDefinition(
  input: RenderInput,
  sections: readonly RenderSection[],
): TDocumentDefinitions {
  const ctx = renderContext(input.language);
  const content: Content[] = [];
  for (const [index, section] of sections.entries()) {
    content.push({
      text: section.heading,
      style: index === 0 ? "title" : "heading",
      pageBreak: index === 0 ? undefined : "before",
    });
    for (const block of section.blocks) content.push(...blockContent(block));
  }

  return {
    info: {
      title: `${ctx.t(
        hasMandatoryGaps(input)
          ? "document.titleReadiness"
          : input.comprehensive
            ? "document.titleComprehensive"
            : "document.title",
      )} — ${input.company.name}`,
      author: input.company.name,
      subject: ctx.t("document.subtitle"),
      // The language a render was made in is part of its identity (О-14), so it
      // is stamped into the file's own metadata and not only into the row.
      keywords: `VSME_BASIC ${input.language} ${input.period.name}`,
    },
    content,
    // `Intl` decides the shape of every number and date on the page; PDF's own
    // `Lang` entry tells a screen reader which language those words are in.
    language: input.language,
    pageSize: "A4",
    pageMargins: PAGE_MARGINS,
    defaultStyle: { font: RENDER_FONT_FAMILY, fontSize: 9, lineHeight: 1.25 },
    styles: {
      title: { fontSize: 22, bold: true, margin: [0, 0, 0, 12] },
      heading: { fontSize: 15, bold: true, margin: [0, 0, 0, 8] },
      subheading: { fontSize: 11, bold: true, margin: [0, 10, 0, 4] },
      paragraph: { margin: [0, 0, 0, 6] },
      label: { bold: true },
      table: { margin: [0, 4, 0, 8], fontSize: 8 },
    },
    footer: (currentPage: number, pageCount: number) => ({
      text: ctx.t("document.page", {
        page: ctx.count(currentPage),
        pages: ctx.count(pageCount),
      }),
      alignment: "center",
      fontSize: 7,
      margin: [0, 16, 0, 0],
    }),
  };
}

// ─── The render ──────────────────────────────────────────────────────────────

/** A finished render: the bytes, plus what T5.7 pins beside them. */
export interface VsmeBasicRender {
  readonly pdf: Buffer;
  /** The intermediate model — what the acceptance criteria are asserted on. */
  readonly sections: readonly RenderSection[];
  /** The same words as plain text. */
  readonly text: string;
  /** REN-2a's four points, as `report_render.disclaimer_text` stores them. */
  readonly disclaimerText: string;
  /** О-14 — the language this render IS, echoed back for the row. */
  readonly language: ReportLanguage;
}

/**
 * REN-1/REN-2 end to end: an input, a language, and a PDF.
 *
 * The stream is drained rather than written to a path: T5.7 hands the bytes to
 * `DocumentStorage` and hashes them, and a renderer that wrote a temporary file
 * would put a second copy of a report on disk that nothing owns.
 */
export async function renderVsmeBasicPdf(
  input: RenderInput,
): Promise<VsmeBasicRender> {
  const sections = buildSections(input);
  const printer = new PdfPrinter(renderFonts());
  const doc = printer.createPdfKitDocument(buildDocDefinition(input, sections));

  const pdf = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.end();
  });

  return {
    pdf,
    sections,
    text: sectionsToText(sections),
    disclaimerText: disclaimerText(
      renderContext(input.language),
      input.coverage,
    ),
    language: input.language,
  };
}

// ─── Gathering the input ─────────────────────────────────────────────────────

/** What the caller must decide before a report can be rendered. */
export interface RenderOptions {
  /** О-14 — an input, never a viewing preference. Defaults to `en`. */
  readonly language?: string | null;
  /**
   * D14's completeness stamp. Supplied rather than derived: only T5.7 knows the
   * plan's limits, and DM-31 makes an inconsistent pair unwritable anyway.
   */
  readonly coverage: RenderCoverage;
  /** The moment stamped on the cover. Injected so a test can pin it. */
  readonly generatedAt?: Date;
}

/** `en`/`sl`, or the default — an unknown value is never rendered blindly. */
export function renderLanguage(
  value: string | null | undefined,
): ReportLanguage {
  return isReportLanguage(value) ? value : reportLanguageFor(value);
}

/**
 * EVERY READ THE REPORT NEEDS (REN-2), in one function.
 *
 * Returns `null` when the revision's period is gone — there is no report to make
 * about a period that does not exist, and inventing an empty one would produce a
 * plausible PDF full of "not collected".
 */
export async function loadRenderInput(
  db: DbClient,
  companyId: string,
  revision: RevisionRow,
  options: RenderOptions,
): Promise<RenderInput | null> {
  if (revision.companyId !== companyId) return null;
  if (revision.status !== "locked")
    return loadLiveRenderInput(db, companyId, revision, options);
  const language = renderLanguage(options.language);
  const context = historicalRenderContext(companyId, revision);
  if (context) {
    const stored =
      context.run_id === null
        ? null
        : await loadStoredRun(db, companyId, revision, context.run_id);
    return {
      ...context.data[language],
      language,
      generatedAt: options.generatedAt ?? new Date(),
      historicalContext: "recorded",
      revision: {
        id: revision.id,
        revisionNo: revision.revisionNo,
        status: revision.status,
        approvedAt: revision.approvedAt,
        lockedAt: revision.lockedAt,
        frozen: true,
      },
      run: stored
        ? {
            ...stored.run,
            formulaVersion: stored.lines[0]?.formulaVersion ?? null,
            roundingRule: stored.lines[0]?.roundingRule ?? null,
          }
        : null,
      aggregates: stored?.aggregates ?? null,
    };
  }
  return loadLegacyRenderInput(db, companyId, revision, options);
}

/** Capture/current approved preview only; locked exports use loadRenderInput. */
export async function loadLiveRenderInput(
  db: DbClient,
  companyId: string,
  revision: RevisionRow,
  options: RenderOptions,
): Promise<RenderInput | null> {
  const language = renderLanguage(options.language);

  const [company] = await db
    .select({ name: companies.name, country: companies.country })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!company) return null;

  const [period] = await db
    .select()
    .from(reportingPeriod)
    .where(
      and(
        eq(reportingPeriod.id, revision.periodId),
        eq(reportingPeriod.companyId, companyId),
      ),
    )
    .limit(1);
  if (!period) return null;

  const [set] = await db
    .select()
    .from(factorSet)
    .where(eq(factorSet.id, period.factorSetId))
    .limit(1);

  const stored = await loadLatestRun(db, companyId, revision);
  const modules = await loadCompanyModules(db, companyId);

  const [
    scope,
    categories,
    scope3,
    disclosures,
    dataQuality,
    evidence,
    esrs,
    comprehensive,
  ] = await Promise.all([
    loadScope(db, companyId, period.id),
    loadScope1Categories(db, companyId, revision.id, stored?.lines ?? []),
    loadScope3(db, companyId, String(period.reportingYear)),
    loadDisclosures(db, companyId, revision.id, language),
    loadDataQuality(db, companyId, revision.id),
    loadEvidence(db, companyId, revision.id),
    // Партия 9 — the cross-reference appendix, only with the layer (0021).
    modules.simplifiedEsrs
      ? loadEsrsIndex(db, companyId, revision.id, language)
      : Promise.resolve(null),
    // Партия 16 — C1…C9, only when the plan has the Comprehensive module.
    modules.comprehensive
      ? loadDisclosures(db, companyId, revision.id, language, "comprehensive")
      : Promise.resolve(null),
  ]);

  const provenance = factorProvenance(stored?.lines ?? []);

  return {
    language,
    generatedAt: options.generatedAt ?? new Date(),
    company: { name: company.name, country: company.country },
    period: {
      id: period.id,
      name: period.periodName,
      startDate: period.startDate,
      endDate: period.endDate,
      reportingYear: period.reportingYear,
      baseYear: period.baseYear,
      reportingBasis: isReportingBasis(period.reportingBasis)
        ? period.reportingBasis
        : "individual",
      methodologyVersion: period.methodologyVersion,
      comparativePeriodId: period.comparativePeriodId,
    },
    factorSet: set
      ? {
          code: set.code,
          name: set.name,
          status: set.status,
          sources: provenance.sources,
          gwpBases: provenance.gwpBases,
          bases: provenance.bases,
          substitutions: provenance.substitutions,
        }
      : null,
    revision: {
      id: revision.id,
      revisionNo: revision.revisionNo,
      status: revision.status,
      approvedAt: revision.approvedAt,
      lockedAt: revision.lockedAt,
      frozen: revision.status === "locked" && revision.frozenScope !== null,
    },
    run: stored
      ? {
          ...stored.run,
          formulaVersion: stored.lines[0]?.formulaVersion ?? null,
          roundingRule: stored.lines[0]?.roundingRule ?? null,
        }
      : null,
    aggregates: stored?.aggregates ?? null,
    scope,
    scope1Categories: categories,
    scope3,
    disclosures,
    dataQuality,
    evidence,
    comparative: await loadComparative(
      db,
      companyId,
      period.comparativePeriodId,
    ),
    coverage: options.coverage,
    esrs,
    comprehensive,
  };
}

/** Legacy exports contain only facts backed by a historical source. */
async function loadLegacyRenderInput(
  db: DbClient,
  companyId: string,
  revision: RevisionRow,
  options: RenderOptions,
): Promise<RenderInput | null> {
  const frozen = frozenRenderBoundary(revision);
  if (!frozen) return null;
  const language = renderLanguage(options.language);
  const { t } = renderContext(language);
  const stored = await loadLatestRun(db, companyId, revision);
  const [scope1Categories, dataQuality, evidence] = await Promise.all([
    loadScope1Categories(db, companyId, revision.id, stored?.lines ?? []),
    loadDataQuality(db, companyId, revision.id),
    loadEvidence(db, companyId, revision.id),
  ]);
  const provenance = factorProvenance(stored?.lines ?? []);
  const entities = new Map(
    frozen.calculation_context?.entities.map((entity) => [entity.id, entity]) ??
      [],
  );
  return {
    language,
    generatedAt: options.generatedAt ?? new Date(),
    historicalContext: "partial",
    company: { name: t("history.companyNameMissing"), country: null },
    period: {
      id: frozen.period_id,
      name: t("history.periodNameMissing"),
      startDate: String(frozen.period.start_date),
      endDate: String(frozen.period.end_date),
      reportingYear: null,
      baseYear:
        typeof frozen.period.base_year === "number"
          ? frozen.period.base_year
          : null,
      reportingBasis: frozen.period.reporting_basis as
        "individual" | "consolidated",
      methodologyVersion:
        typeof frozen.period.methodology_version === "string"
          ? frozen.period.methodology_version
          : t("history.notRecorded"),
      comparativePeriodId: null,
    },
    factorSet: stored
      ? { code: null, name: null, status: null, ...provenance }
      : null,
    revision: {
      id: revision.id,
      revisionNo: revision.revisionNo,
      status: revision.status,
      approvedAt: revision.approvedAt,
      lockedAt: revision.lockedAt,
      frozen: true,
    },
    run: stored
      ? {
          ...stored.run,
          formulaVersion: stored.lines[0]?.formulaVersion ?? null,
          roundingRule: stored.lines[0]?.roundingRule ?? null,
        }
      : null,
    aggregates: stored?.aggregates ?? null,
    scope: frozen.scope.map((entry) => ({
      legalEntityId: entry.legal_entity_id,
      name:
        entities.get(entry.legal_entity_id)?.name ??
        t("history.entityNameMissing"),
      country: entities.get(entry.legal_entity_id)?.country ?? null,
      registrationNumber: null,
      registeredAddress: null,
      consolidationMethod: null,
      ownershipPercentage: null,
      isSubsidiary: null,
      status: isApplicabilityStatus(entry.status)
        ? entry.status
        : "not_assessed",
      exclusionReason: entry.exclusion_reason,
    })),
    scope1Categories,
    dataQuality,
    evidence,
    scope3: [],
    disclosures: [],
    comparative: null,
    esrs: null,
    comprehensive: null,
    coverage: historicalRenderCoverage(companyId, revision, language)!,
  };
}

/** The boundary (DM-8) joined to the registry — AC-3's source of truth. */
async function loadScope(
  db: DbClient,
  companyId: string,
  periodId: string,
): Promise<RenderScopeEntry[]> {
  const rows = await db
    .select({
      legalEntityId: periodScope.legalEntityId,
      status: periodScope.status,
      exclusionReason: periodScope.exclusionReason,
      name: legalEntity.name,
      registrationNumber: legalEntity.registrationNumber,
      registeredAddress: legalEntity.registeredAddress,
      country: legalEntity.country,
      consolidationMethod: legalEntity.consolidationMethod,
      ownershipPercentage: legalEntity.ownershipPercentage,
      parentLegalEntityId: legalEntity.parentLegalEntityId,
      groupStructureType: legalEntity.groupStructureType,
    })
    .from(periodScope)
    .innerJoin(legalEntity, eq(legalEntity.id, periodScope.legalEntityId))
    .where(
      and(
        eq(periodScope.companyId, companyId),
        eq(periodScope.periodId, periodId),
      ),
    )
    .orderBy(asc(legalEntity.name), asc(periodScope.legalEntityId));

  return rows.map((row) => ({
    legalEntityId: row.legalEntityId,
    name: row.name,
    registrationNumber: row.registrationNumber,
    registeredAddress: row.registeredAddress,
    country: row.country,
    consolidationMethod: isConsolidationMethod(row.consolidationMethod)
      ? row.consolidationMethod
      : null,
    ownershipPercentage: row.ownershipPercentage,
    isSubsidiary:
      row.parentLegalEntityId !== null ||
      row.groupStructureType === "subsidiary",
    // An unrecognised status is reported as `not_assessed` rather than crashing
    // the render: the CHECK constraint makes it impossible today, and a report
    // that refuses to print because of one enum value would be worse than one
    // that prints the most conservative reading of it.
    status: isApplicabilityStatus(row.status) ? row.status : "not_assessed",
    exclusionReason: row.exclusionReason,
  }));
}

/**
 * AC-4's evidence: how many rows of each of the five §4.9 categories the
 * revision holds, and how many of them the run priced.
 *
 * Driven by `ACTIVITY_CATEGORIES`, so a sixth category cannot be added to the
 * schema and silently omitted from the report.
 */
async function loadScope1Categories(
  db: DbClient,
  companyId: string,
  revisionId: string,
  lines: readonly RunLine[],
): Promise<RenderScope1Category[]> {
  const rows = await db
    .select({
      id: emissionActivity.id,
      category: emissionActivity.activityCategory,
    })
    .from(emissionActivity)
    .where(
      and(
        eq(emissionActivity.companyId, companyId),
        eq(emissionActivity.revisionId, revisionId),
        sql`${emissionActivity.supersededById} IS NULL`,
        eq(emissionActivity.isDeleted, false),
      ),
    );

  const calculated = new Set(
    lines
      .filter(
        (line) =>
          line.activityTable === "emission_activity" &&
          line.calculationStatus === "ok",
      )
      .map((line) => line.activityRowId),
  );

  return ACTIVITY_CATEGORIES.map((category) => {
    const own = rows.filter(
      (row) => isActivityCategory(row.category) && row.category === category,
    );
    return {
      category,
      rowCount: own.length,
      calculatedCount: own.filter((row) => calculated.has(row.id)).length,
    };
  });
}

/** The spend-based Scope-3 estimates of the reporting year (MIG-10). */
async function loadScope3(db: DbClient, companyId: string, year: string) {
  const rows = await getScope3Results(db, companyId, year);
  return rows.map((row) => ({
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    tco2e: row.tco2e,
    dataQuality: row.dataQuality,
  }));
}

/**
 * The Basic catalogue, LEFT-joined to the revision's current answers.
 *
 * The catalogue drives, never `disclosure_record` — see `sections.ts` on why a
 * metric nobody answered has to appear anyway.
 */
async function loadDisclosures(
  db: DbClient,
  companyId: string,
  revisionId: string,
  language: ReportLanguage,
  module: "basic" | "comprehensive" = "basic",
): Promise<RenderDisclosure[]> {
  const [metrics, answers, decisions] = await Promise.all([
    db
      .select()
      .from(metricCatalog)
      .where(
        and(
          eq(metricCatalog.standard, "vsme"),
          eq(metricCatalog.module, module),
          eq(metricCatalog.isActive, true),
        ),
      )
      .orderBy(asc(metricCatalog.sortOrder), asc(metricCatalog.metricKey)),
    db
      .select()
      .from(disclosureRecord)
      .where(
        and(
          eq(disclosureRecord.companyId, companyId),
          eq(disclosureRecord.revisionId, revisionId),
          sql`${disclosureRecord.supersededById} IS NULL`,
          eq(disclosureRecord.isDeleted, false),
        ),
      ),
    db
      .select()
      .from(disclosureApplicability)
      .where(
        and(
          eq(disclosureApplicability.companyId, companyId),
          eq(disclosureApplicability.revisionId, revisionId),
        ),
      ),
  ]);

  const byMetric = new Map(answers.map((row) => [row.metricKey, row]));
  const decisionByMetric = new Map(
    decisions.map((row) => [row.metricKey, row]),
  );
  // О-14: the report is rendered IN a language. The Slovene titles of
  // 0017/0018 are used when present and fall back to the English ones — never
  // to the DM-20 Russian workbook name, which stays the last resort.
  const sl = language === "sl";

  return metrics.map((metric) => {
    const answer = byMetric.get(metric.metricKey);
    const decision = decisionByMetric.get(metric.metricKey);
    return {
      metricKey: metric.metricKey,
      disclosureCode: metric.disclosureCode,
      disclosureTitle:
        (sl ? metric.disclosureTitleSl : null) ??
        metric.disclosureTitleEn ??
        metric.disclosureTitle ??
        "",
      title: (sl ? metric.titleSl : null) ?? metric.titleEn ?? metric.title,
      unit: metric.unit,
      requirementType: metric.requirementType,
      value: answer ? disclosureValue(answer, language) : null,
      decision: decision
        ? {
            status: decision.status as "not_applicable" | "sensitive_omitted",
            reason: decision.reason,
          }
        : null,
    };
  });
}

/**
 * The simplified-ESRS cross-reference (партия 9): the printed Basic datapoints
 * that carry an `esrs_reference` (0019), and the 50 ESRS-only datapoints with
 * their answers and decisions — the same three tables `loadDisclosures` reads.
 */
async function loadEsrsIndex(
  db: DbClient,
  companyId: string,
  revisionId: string,
  language: ReportLanguage,
): Promise<RenderEsrsIndex> {
  const [metrics, answers, decisions] = await Promise.all([
    db
      .select()
      .from(metricCatalog)
      .where(
        and(
          eq(metricCatalog.isActive, true),
          or(
            and(
              eq(metricCatalog.standard, "vsme"),
              eq(metricCatalog.module, "basic"),
              isNotNull(metricCatalog.esrsReference),
            ),
            eq(metricCatalog.standard, "esrs"),
          ),
        ),
      )
      .orderBy(asc(metricCatalog.sortOrder), asc(metricCatalog.metricKey)),
    db
      .select()
      .from(disclosureRecord)
      .where(
        and(
          eq(disclosureRecord.companyId, companyId),
          eq(disclosureRecord.revisionId, revisionId),
          sql`${disclosureRecord.supersededById} IS NULL`,
          eq(disclosureRecord.isDeleted, false),
        ),
      ),
    db
      .select()
      .from(disclosureApplicability)
      .where(
        and(
          eq(disclosureApplicability.companyId, companyId),
          eq(disclosureApplicability.revisionId, revisionId),
        ),
      ),
  ]);
  const byMetric = new Map(answers.map((row) => [row.metricKey, row]));
  const decisionByMetric = new Map(
    decisions.map((row) => [row.metricKey, row]),
  );
  const sl = language === "sl";
  const titleOf = (metric: (typeof metrics)[number]) =>
    (sl ? metric.titleSl : null) ?? metric.titleEn ?? metric.title;
  const decisionOf = (metricKey: string) => {
    const decision = decisionByMetric.get(metricKey);
    return decision
      ? {
          status: decision.status as "not_applicable" | "sensitive_omitted",
          reason: decision.reason,
        }
      : null;
  };

  return {
    regulatoryStatus:
      metrics.find((m) => m.standard === "esrs")?.regulatoryStatus ?? null,
    cross: metrics
      .filter((m) => m.standard === "vsme" && m.esrsReference !== null)
      .map((metric) => {
        const answer = byMetric.get(metric.metricKey);
        const value = answer ? disclosureValue(answer, language) : null;
        return {
          reference: metric.esrsReference!,
          metricKey: metric.metricKey,
          disclosureCode: metric.disclosureCode,
          title: titleOf(metric),
          state:
            value !== null
              ? ("answered" as const)
              : decisionOf(metric.metricKey)
                ? ("decided" as const)
                : ("open" as const),
        };
      }),
    additional: metrics
      .filter((m) => m.standard === "esrs")
      .map((metric) => {
        const answer = byMetric.get(metric.metricKey);
        return {
          reference: metric.esrsReference,
          metricKey: metric.metricKey,
          disclosureCode: metric.disclosureCode,
          title: titleOf(metric),
          // Партия 18 — in the report language; never the Russian original.
          appliesWhen:
            metric.esrsApplicability ??
            conditionTexts(metric.applicabilityCondition)?.[sl ? "sl" : "en"] ??
            null,
          value: answer ? disclosureValue(answer, language) : null,
          decision: decisionOf(metric.metricKey),
        };
      }),
  };
}

/**
 * The ONE non-null value column of a `disclosure_record` row, as text.
 *
 * DM-19 guarantees exactly one is filled, and "filled" means NOT NULL rather
 * than truthy: `false` and `0` are answers, and a `??`-chain that skipped them
 * would print "not collected" over the two most common ones in a compliance
 * questionnaire.
 */
function disclosureValue(
  row: typeof disclosureRecord.$inferSelect,
  language: string,
): string | null {
  if (row.valueNumeric !== null) return row.valueNumeric;
  if (row.valueText !== null) return row.valueText;
  if (row.valueBoolean !== null) return String(row.valueBoolean);
  if (row.valueDate !== null) return row.valueDate;
  if (row.valueJson !== null) return jsonValue(row, language);
  return null;
}

/**
 * Партия 18 — a `value_json` answer as a reader sees it. A choice prints its
 * label in the report language (`@/shared/catalog/options`), a list prints its
 * items separated by «; », and only a structured value (a breakdown) stays
 * JSON. Before this the report printed `["10.13"]` and `"OPTION A: Basic Module"`
 * — the storage format, quotes and brackets included.
 */
function jsonValue(
  row: typeof disclosureRecord.$inferSelect,
  language: string,
): string {
  const item = (value: unknown): string =>
    typeof value === "string"
      ? (choiceLabel(row.metricKey, value, language) ?? value)
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);
  const json = row.valueJson;
  if (Array.isArray(json)) return json.map(item).join("; ");
  if (typeof json === "string") return item(json);
  return JSON.stringify(json);
}

/** The DQ picture of the revision's current rows. */
async function loadDataQuality(
  db: DbClient,
  companyId: string,
  revisionId: string,
) {
  const refs = await currentRowIds(db, companyId, revisionId);
  const byTier = Object.fromEntries(
    QUALITY_TIERS.map((tier) => [tier, 0]),
  ) as Record<QualityTier, number>;

  if (refs.length === 0) {
    return {
      assessedCount: 0,
      rowCount: 0,
      byTier,
      untieredCount: 0,
      averagePedigree: null,
      overriddenCount: 0,
    };
  }

  const rows = await db
    .select()
    .from(dqAssessment)
    .where(
      and(
        eq(dqAssessment.companyId, companyId),
        inArray(
          dqAssessment.objectId,
          refs.map((ref) => ref.id),
        ),
      ),
    );

  let pedigreeSum = 0;
  let pedigreeCount = 0;
  let untiered = 0;
  let overridden = 0;
  for (const row of rows) {
    if (isQualityTier(row.qualityTier)) byTier[row.qualityTier] += 1;
    else untiered += 1;
    if (row.isOverridden) overridden += 1;
    for (const score of [
      row.reliabilityScore,
      row.temporalScore,
      row.geographicalScore,
      row.technologyScore,
    ]) {
      if (score !== null) {
        pedigreeSum += score;
        pedigreeCount += 1;
      }
    }
  }

  return {
    assessedCount: rows.length,
    rowCount: refs.length,
    byTier,
    untieredCount: untiered,
    averagePedigree:
      pedigreeCount === 0 ? null : (pedigreeSum / pedigreeCount).toFixed(2),
    overriddenCount: overridden,
  };
}

/** The evidence appendix: the documents linked to this revision's rows (EV-0). */
async function loadEvidence(
  db: DbClient,
  companyId: string,
  revisionId: string,
) {
  const refs = await currentRowIds(db, companyId, revisionId);
  if (refs.length === 0) return [];

  const links = await db
    .select({
      documentId: evidenceLink.documentId,
      fileName: documentTable.fileName,
      fileType: documentTable.fileType,
      fileHash: documentTable.fileHash,
      uploadedAt: documentTable.uploadedAt,
    })
    .from(evidenceLink)
    .innerJoin(documentTable, eq(documentTable.id, evidenceLink.documentId))
    .where(
      and(
        eq(evidenceLink.companyId, companyId),
        inArray(
          evidenceLink.linkedObjectId,
          refs.map((ref) => ref.id),
        ),
      ),
    )
    .orderBy(asc(documentTable.fileName), asc(evidenceLink.documentId));

  // One APPENDIX ENTRY PER DOCUMENT, with the number of rows it supports — a
  // document cited by six rows is one piece of evidence, not six.
  const byDocument = new Map<
    string,
    {
      fileName: string;
      fileType: string;
      fileHash: string | null;
      uploadedAt: Date | string | null;
      linkCount: number;
    }
  >();
  for (const link of links) {
    const existing = byDocument.get(link.documentId);
    if (existing) existing.linkCount += 1;
    else
      byDocument.set(link.documentId, {
        fileName: link.fileName,
        fileType: link.fileType,
        fileHash: link.fileHash,
        uploadedAt: link.uploadedAt,
        linkCount: 1,
      });
  }
  return [...byDocument.values()];
}

/**
 * The comparative period's headline figures (REN-2's YoY).
 *
 * Read through the SAME `loadLatestRun` as the reported period, so the two
 * columns of the comparison are produced by one implementation. A comparative
 * period with no current revision, or with no run, yields `null` — and the
 * executive summary says so rather than printing an empty column.
 */
async function loadComparative(
  db: DbClient,
  companyId: string,
  comparativePeriodId: string | null,
) {
  if (comparativePeriodId === null) return null;

  const [period] = await db
    .select()
    .from(reportingPeriod)
    .where(
      and(
        eq(reportingPeriod.id, comparativePeriodId),
        eq(reportingPeriod.companyId, companyId),
      ),
    )
    .limit(1);
  if (!period) return null;

  const [revision] = await db
    .select()
    .from(reportRevision)
    .where(
      and(
        eq(reportRevision.companyId, companyId),
        eq(reportRevision.periodId, period.id),
        eq(reportRevision.isCurrent, true),
      ),
    )
    .limit(1);
  if (!revision) return null;

  const stored = await loadLatestRun(db, companyId, revision);
  if (!stored) return null;

  return {
    periodName: period.periodName,
    reportingYear: period.reportingYear,
    totals: stored.aggregates.totals,
    energy: stored.aggregates.energy,
  };
}

/** `source_name source_version`, or just the name when there is no edition. */
function sourceLabel(name: string, version: string): string {
  return version ? `${name} ${version}` : name;
}

/**
 * WHAT PRICED THIS REPORT, off the run's own `factor_snapshot`s (DM-29).
 *
 * Four answers, all from the same single pass and none of them from a live read
 * of the factor library — the library has moved on by the time anyone reads a
 * locked report, and the snapshot is the only thing that has not:
 *
 *   • `sources` / `gwpBases` — which publications and which GWP basis (T5.7).
 *   • `bases` — the BASIS every figure rests on, grouped: which rung of the
 *     geography ladder, which country, which year, from whose edition, over how
 *     many lines. "Pinned `si-2025`" and "priced by a 2006 IPCC global default"
 *     are different claims and until now the report only made the first.
 *   • `substitutions` — the honest half. Every line whose account records a
 *     better-ranked factor it could not reach, grouped so that four
 *     denominations of one national measurement are one sentence.
 *
 * EVERY GROUP IS SORTED, and the sort keys are total. REN-5 hashes the bytes of
 * the finished document, so a list that depended on the order the run's lines
 * came back from Postgres would make the same revision render to two different
 * hashes.
 */
function factorProvenance(lines: readonly RunLine[]): {
  sources: string[];
  gwpBases: string[];
  bases: RenderFactorBasis[];
  substitutions: RenderFactorSubstitution[];
} {
  const sources = new Set<string>();
  const gwpBases = new Set<string>();
  const bases = new Map<string, RenderFactorBasis>();
  const substitutions = new Map<string, RenderFactorSubstitution>();

  for (const line of lines) {
    const snapshot: FactorSnapshot = line.factorSnapshot;
    if (!snapshot.resolved) continue;
    const source = sourceLabel(snapshot.source_name, snapshot.source_version);
    sources.add(source);
    if (snapshot.gwp_basis) gwpBases.add(snapshot.gwp_basis);

    // A run written before the account existed carries no provenance at all.
    // It is skipped rather than described: "nothing was passed over" is a claim
    // this report has no evidence for.
    const account = snapshot.provenance;
    if (!account) continue;

    const basisKey = [
      account.tier,
      snapshot.geography,
      snapshot.applicable_year ?? "",
      source,
    ].join(" ");
    const basis = bases.get(basisKey);
    if (basis) {
      bases.set(basisKey, { ...basis, lineCount: basis.lineCount + 1 });
    } else {
      bases.set(basisKey, {
        tier: account.tier,
        geography: snapshot.geography,
        applicableYear: snapshot.applicable_year,
        source,
        lineCount: 1,
      });
    }

    for (const passed of account.passed_over) {
      const betterSource = sourceLabel(
        passed.source_name,
        passed.source_version,
      );
      const key = [
        passed.reason,
        snapshot.activity_type,
        snapshot.geography,
        source,
        account.entered_unit,
        account.requested_year ?? "",
        passed.geography,
        betterSource,
        passed.applicable_year ?? "",
        passed.input_units.join("+"),
      ].join(" ");
      const seen = substitutions.get(key);
      if (seen) {
        substitutions.set(key, { ...seen, lineCount: seen.lineCount + 1 });
        continue;
      }
      substitutions.set(key, {
        reason: passed.reason,
        activityType: snapshot.activity_type,
        chosenGeography: snapshot.geography,
        chosenSource: source,
        enteredUnit: account.entered_unit,
        requestedYear: account.requested_year,
        betterGeography: passed.geography,
        betterSource,
        betterYear: passed.applicable_year,
        betterUnits: passed.input_units,
        lineCount: 1,
      });
    }
  }

  return {
    sources: [...sources].sort(),
    gwpBases: [...gwpBases].sort(),
    bases: [...bases.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value),
    substitutions: [...substitutions.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value),
  };
}
