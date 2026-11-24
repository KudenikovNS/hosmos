import type { CalcAggregates } from "@/server/calc/aggregate";
import type { PassedOverReason } from "@/server/calc/factors";
import type { FactorPriorityTier } from "@/server/calc/formula-version";
import type { ActivityCategory } from "@/server/inventory/emission-activity";
import type {
  ApplicabilityStatus,
  ConsolidationMethod,
  QualityTier,
  ReportingBasis,
} from "@/shared/enums";
import type { RenderCoverage } from "../disclaimer";
import type { ReportLanguage } from "@/i18n/locales";

// The render input and output shapes (REN-2). Pure data; no builder here.

/**
 * THE SECTIONS REN-2 REQUIRES, IN THE ORDER THE REPORT PRINTS THEM.
 *
 * Exported as a constant so that the acceptance test iterates it instead of
 * re-typing a list: a section added here without a heading, or a heading added
 * without a builder, fails at once rather than the day somebody notices the PDF
 * is one chapter short.
 */
export const RENDER_SECTIONS = [
  /** Cover: who, which period, which revision, which factor set (REN-2). */
  "title",
  /** Scope 1 / Scope 2 LB+MB, energy, intensity, coverage, YoY (REN-2). */
  "executiveSummary",
  /** B1 — basis of preparation: boundary, statuses, exclusion reasons (AC-3). */
  "basis",
  /** Methodology: version, factor set, consolidation, the five sources (AC-4). */
  "methodology",
  /** B3 — energy and emissions. */
  "energyEmissions",
  /** The Scope 3 coverage statement (spend-based, outside the totals). */
  "scope3",
  /** B2, B4…B11 from `disclosure_record`, including the social and governance. */
  "disclosures",
  /** C1…C9 — the Comprehensive module (партия 16); «not included» without it. */
  "comprehensive",
  /** The data-quality summary. */
  "dataQuality",
  /** Exclusions and completeness (D14). */
  "completeness",
  /** Gap plan: open datapoints per disclosure + the recorded decisions (stage 1 §5.6). */
  "gapPlan",
  /** Simplified-ESRS cross-reference (0019/0021) — «not included» without the layer. */
  "esrsIndex",
  /** The four-point disclaimer (REN-2a). */
  "disclaimer",
  /** The evidence appendix. */
  "evidence",
] as const;

/** One section of {@link RENDER_SECTIONS}. */
export type RenderSectionId = (typeof RENDER_SECTIONS)[number];

/** A block of one section. Five kinds, because a report is not a spreadsheet. */
export type RenderBlock =
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "subheading"; readonly text: string }
  | {
      readonly kind: "keyValues";
      readonly rows: readonly {
        readonly label: string;
        readonly value: string;
      }[];
    }
  | {
      readonly kind: "table";
      readonly columns: readonly string[];
      readonly rows: readonly (readonly string[])[];
    }
  | { readonly kind: "list"; readonly items: readonly string[] };

/** One section: its id, the heading that is printed, and its blocks. */
export interface RenderSection {
  readonly id: RenderSectionId;
  readonly heading: string;
  readonly blocks: readonly RenderBlock[];
}

/** The company the report is about. */
interface RenderCompany {
  readonly name: string;
  readonly country: string | null;
}

/** The reporting period and its calculation-bearing pins. */
interface RenderPeriod {
  readonly id: string;
  readonly name: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly reportingYear: number | null;
  readonly baseYear: number | null;
  readonly reportingBasis: ReportingBasis;
  readonly methodologyVersion: string;
  readonly comparativePeriodId: string | null;
}

/**
 * The factor set the period pinned (К-24) — the report's price list.
 *
 * `sources` and `gwpBases` are NOT columns of `factor_set`: they are read off
 * the `factor_snapshot` of the lines the run actually produced (DM-29). That is
 * the difference between "which catalogue was pinned" and "which sources priced
 * this report", and only the second is re-derivable from the stored run after
 * an administrator edits the catalogue.
 */
interface RenderFactorSet {
  readonly code: string | null;
  readonly name: string | null;
  readonly status: string | null;
  /** `source_name source_version` pairs seen in the run's snapshots, sorted. */
  readonly sources: readonly string[];
  /** AR5 / AR6 — the GWP bases the run's factors were published under. */
  readonly gwpBases: readonly string[];
  /** WHICH BASIS the figures rest on, grouped — see {@link RenderFactorBasis}. */
  readonly bases: readonly RenderFactorBasis[];
  /** Where a weaker basis was taken — see {@link RenderFactorSubstitution}. */
  readonly substitutions: readonly RenderFactorSubstitution[];
}

/**
 * One BASIS the run's figures rest on: a rung of CALC-2's geography ladder, a
 * country, a year and an edition, over some number of calculation lines.
 *
 * "The period pinned `si-2025`" is a fact about the catalogue; "43 lines were
 * priced by a GLOBAL 2006 IPCC default" is a fact about the report, and only the
 * second tells a reader what the number is worth. Both are printed.
 */
export interface RenderFactorBasis {
  readonly tier: FactorPriorityTier;
  readonly geography: string;
  readonly applicableYear: number | null;
  /** `source_name source_version`, as the methodology row prints it. */
  readonly source: string;
  readonly lineCount: number;
}

/**
 * A place where the report was priced by LESS than the pinned set holds — the
 * resolver's `passed_over` account, grouped for print.
 *
 * It is a disclosure and not an error. The ladder took the only candidate it
 * could reach, the figure is published, and this sentence says what it was
 * published INSTEAD OF: a factor for the site's own country, or one for the
 * row's own year, that the entered unit or the entered year could not reach.
 */
export interface RenderFactorSubstitution {
  readonly reason: PassedOverReason;
  readonly activityType: string;
  /** The geography the figures WERE priced by (`GLOBAL`, typically). */
  readonly chosenGeography: string;
  readonly chosenSource: string;
  /** The unit the activity rows were entered in — half of why the other failed. */
  readonly enteredUnit: string;
  readonly requestedYear: number | null;
  /** The geography that was passed over (the site's own country, typically). */
  readonly betterGeography: string;
  readonly betterSource: string;
  readonly betterYear: number | null;
  /** Every denomination the passed-over group is published in. */
  readonly betterUnits: readonly string[];
  readonly lineCount: number;
}

/** The revision being rendered — a report is always a revision of a period. */
interface RenderRevision {
  readonly id: string;
  readonly revisionNo: number;
  readonly status: string;
  readonly approvedAt: string | Date | null;
  readonly lockedAt: string | Date | null;
  /** `true` when the boundary came from `frozen_scope` rather than live rows. */
  readonly frozen: boolean;
}

/** The calculation run whose figures the report prints (CALC-6). */
interface RenderRun {
  readonly runId: string;
  readonly calculatedAt: string;
  readonly status: "ok" | "failed";
  readonly lineCount: number;
  readonly failedCount: number;
  readonly formulaVersion: string | null;
  readonly roundingRule: string | null;
}

/** One legal entity of the boundary, with its `period_scope` verdict (DM-8). */
export interface RenderScopeEntry {
  readonly legalEntityId: string;
  readonly name: string;
  readonly registrationNumber: string | null;
  readonly registeredAddress: string | null;
  readonly country: string | null;
  readonly consolidationMethod: ConsolidationMethod | null;
  readonly ownershipPercentage: string | null;
  readonly isSubsidiary: boolean | null;
  readonly status: ApplicabilityStatus;
  /** VAL-101 makes this mandatory when the status is `excluded` — AC-3. */
  readonly exclusionReason: string | null;
}

/** One of the five §4.9 Scope-1 sources, and whether this company has it (AC-4). */
export interface RenderScope1Category {
  readonly category: ActivityCategory;
  /** Current, non-deleted rows of this category in the revision. */
  readonly rowCount: number;
  /** Rows of this category that the run turned into a calculation line. */
  readonly calculatedCount: number;
}

/** One spend-based Scope-3 estimate (MIG-10) — outside the gross totals. */
interface RenderScope3Category {
  readonly categoryId: number;
  readonly categoryName: string;
  readonly tco2e: number;
  readonly dataQuality: string | null;
}

/** One Basic metric of the catalogue, joined to its answer (or the lack of one). */
export interface RenderDisclosure {
  readonly metricKey: string;
  readonly disclosureCode: string;
  readonly disclosureTitle: string;
  readonly title: string;
  readonly unit: string | null;
  readonly requirementType: string;
  /** The stored answer as text, or `null` — "not collected", printed as such. */
  readonly value: string | null;
  /**
   * A stored `disclosure_applicability` decision (0016): the datapoint was
   * declared not applicable, or omitted as classified/sensitive (B1 §24(b)),
   * with the reason. Printed in place of «not collected» and listed by the gap
   * plan. Optional so a hand-built input without decisions stays valid.
   */
  readonly decision?: {
    readonly status: "not_applicable" | "sensitive_omitted";
    readonly reason: string;
  } | null;
}

/**
 * The simplified-ESRS cross-reference appendix (партия 9).
 *
 * TWO LISTS, one source. `cross` is every printed VSME datapoint that 0019
 * maps onto a simplified-ESRS disclosure (`metric_catalog.esrs_reference`),
 * with whether the REPORT has something for it — an answer or a decision.
 * `additional` is the 50 `standard='esrs'` datapoints the simplified ESRS
 * asks for beyond VSME, printed like a disclosure table. Present only when the
 * plan has the layer (`loadCompanyModules`); the builder prints «not
 * included» otherwise, so the section count never depends on the plan.
 */
export interface RenderEsrsIndex {
  readonly regulatoryStatus: string | null;
  readonly cross: readonly RenderEsrsCrossRow[];
  readonly additional: readonly RenderEsrsExtraRow[];
}

interface RenderEsrsCrossRow {
  /** `ESRS E1-7` — as the catalogue spells it. */
  readonly reference: string;
  readonly metricKey: string;
  readonly disclosureCode: string;
  readonly title: string;
  readonly state: "answered" | "decided" | "open";
}

interface RenderEsrsExtraRow {
  readonly reference: string | null;
  readonly metricKey: string;
  readonly disclosureCode: string;
  readonly title: string;
  readonly appliesWhen: string | null;
  readonly value: string | null;
  readonly decision?: RenderDisclosure["decision"];
}

/** A datapoint with no answer and no decision — what the gap plan lists. */
export function isOpenDatapoint(row: RenderDisclosure): boolean {
  return row.value === null && !row.decision;
}

/** Any MANDATORY Basic datapoint still open — the document is then a draft. */
export function hasMandatoryGaps(input: RenderInput): boolean {
  if (input.historicalContext === "partial") return true;
  return input.disclosures.some(
    (row) => row.requirementType === "mandatory" && isOpenDatapoint(row),
  );
}

/** The data-quality picture of the revision's rows (DQ summary). */
interface RenderDataQuality {
  readonly assessedCount: number;
  readonly rowCount: number;
  readonly byTier: Readonly<Record<QualityTier, number>>;
  readonly untieredCount: number;
  /** Mean of the four pedigree scores over the assessed rows, or `null`. */
  readonly averagePedigree: string | null;
  readonly overriddenCount: number;
}

/** One document of the evidence appendix. */
interface RenderEvidence {
  readonly fileName: string;
  readonly fileType: string;
  readonly fileHash: string | null;
  readonly uploadedAt: string | Date | null;
  readonly linkCount: number;
}

/** The comparative period's headline figures, for the YoY block (REN-2). */
interface RenderComparative {
  readonly periodName: string;
  readonly reportingYear: number;
  readonly totals: CalcAggregates["totals"];
  readonly energy: CalcAggregates["energy"];
}

/** EVERYTHING the renderer prints. Gathered by `vsme-basic.ts`, pure from here. */
export interface RenderInput {
  /** Historical metadata source; absent for live approved previews. */
  readonly historicalContext?: "recorded" | "partial";
  /** О-14 — an INPUT of the render, recorded in `report_render.language`. */
  readonly language: ReportLanguage;
  readonly generatedAt: string | Date;
  readonly company: RenderCompany;
  readonly period: RenderPeriod;
  readonly factorSet: RenderFactorSet | null;
  readonly revision: RenderRevision;
  /** `null` when the revision was never calculated — NOT an empty run. */
  readonly run: RenderRun | null;
  /** `null` alongside a `null` run; every figure of a failed run is `null`. */
  readonly aggregates: CalcAggregates | null;
  readonly scope: readonly RenderScopeEntry[];
  readonly scope1Categories: readonly RenderScope1Category[];
  readonly scope3: readonly RenderScope3Category[];
  readonly disclosures: readonly RenderDisclosure[];
  readonly dataQuality: RenderDataQuality;
  readonly evidence: readonly RenderEvidence[];
  readonly comparative: RenderComparative | null;
  readonly coverage: RenderCoverage;
  /** Партия 9 — optional so a hand-built input without it stays valid. */
  readonly esrs?: RenderEsrsIndex | null;
  /**
   * Партия 16 — the Comprehensive module's datapoints (C1…C9), catalogue-driven
   * like `disclosures`. `null`/absent when the plan has no Comprehensive
   * module: the section then prints «not included», so the section count and
   * the sheet list never depend on the plan.
   */
  readonly comprehensive?: readonly RenderDisclosure[] | null;
}
