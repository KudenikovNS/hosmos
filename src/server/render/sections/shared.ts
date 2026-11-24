import {
  type AggregateWarningCode,
  AGGREGATE_WARNINGS,
} from "@/server/calc/aggregate";
import type { RenderContext } from "../i18n";
import type {
  RenderSectionId,
  RenderBlock,
  RenderDisclosure,
  RenderFactorSubstitution,
  RenderInput,
} from "./types";

// Helpers shared by several section builders: code order, the disclosure
// table, factor-set labels, and the qualification notes.

/**
 * The Basic disclosure codes that have a SECTION OF THEIR OWN.
 *
 * B1 is the basis of preparation and B3 is energy and emissions; both are
 * generated from the organisation and the calculation rather than typed into
 * `disclosure_record`, so REN-2 gives each a dedicated section. Their catalogue
 * metrics are still printed — inside those sections — which is why this is a
 * routing table and not an exclusion list. `disclosures` takes the rest: B2,
 * B4…B11, INCLUDING the social B8–B10 and the governance B11 (К-26: a Basic
 * report is not only a climate report).
 */
export const OWN_SECTION_CODES: Readonly<Record<string, RenderSectionId>> = {
  B1: "basis",
  B3: "energyEmissions",
};

/** `B2` → 2, so B10 sorts after B9 rather than after B1. */
function codeOrder(code: string): number {
  const digits = code.replace(/^\D+/, "");
  const value = Number.parseInt(digits, 10);
  return Number.isNaN(value) ? Number.MAX_SAFE_INTEGER : value;
}

/** The disclosure codes of `input.disclosures`, in B1…B11 order. */
export function disclosureCodes(input: RenderInput): string[] {
  return codesOf(input.disclosures);
}

/** The distinct codes of any catalogue slice, in C1…C9 / B1…B11 order. */
export function codesOf(rows: readonly RenderDisclosure[]): string[] {
  return [...new Set(rows.map((row) => row.disclosureCode))].sort(
    (a, b) => codeOrder(a) - codeOrder(b) || a.localeCompare(b),
  );
}

/**
 * The catalogue metrics of one disclosure code, as a table.
 *
 * EVERY metric of the code is a row. A metric with no `disclosure_record`
 * carries the "not collected" words in its value column — see the header.
 */
export function disclosureTable(
  ctx: RenderContext,
  input: RenderInput,
  code: string,
): RenderBlock[] {
  return disclosureTableFor(ctx, input.disclosures, code);
}

/** The same table over any catalogue slice — the Comprehensive module reuses it. */
export function disclosureTableFor(
  ctx: RenderContext,
  all: readonly RenderDisclosure[],
  code: string,
): RenderBlock[] {
  const rows = all.filter((row) => row.disclosureCode === code);
  if (rows.length === 0) return [];
  const collected = rows.filter((row) => row.value !== null).length;
  return [
    {
      kind: "paragraph",
      text: ctx.t("disclosures.collectedOf", {
        collected: ctx.count(collected),
        total: ctx.count(rows.length),
        code,
      }),
    },
    {
      kind: "table",
      columns: [
        ctx.t("disclosures.columns.metric"),
        ctx.t("disclosures.columns.value"),
        ctx.t("disclosures.columns.unit"),
        ctx.t("disclosures.columns.requirement"),
      ],
      rows: rows.map((row) => [
        row.title,
        row.value ??
          (row.decision
            ? ctx.t(
                row.decision.status === "not_applicable"
                  ? "disclosures.notApplicable"
                  : "disclosures.sensitiveOmitted",
                { reason: row.decision.reason },
              )
            : ctx.notCollected()),
        row.unit ?? "—",
        row.requirementType,
      ]),
    },
  ];
}

/** `code — name (status)`, or the "not collected" words when nothing is pinned. */
export function factorSetLabel(ctx: RenderContext, input: RenderInput): string {
  const set = input.factorSet;
  if (set === null) return ctx.notCollected();
  const label =
    [set.code, set.name].filter((value) => value !== null).join(" — ") ||
    ctx.t("history.factorSetNameMissing");
  return set.status === null ? label : `${label} (${set.status})`;
}

/**
 * The bases the run's figures rest on, as one sentence per group.
 *
 * "`si-2025` was pinned" says which catalogue was consulted. THIS says what came
 * out of it — which rung of the geography ladder, whose edition, for which year,
 * over how many lines — and it is the difference between a report a reader can
 * weigh and one they have to take on trust. Geography codes and units are
 * printed VERBATIM, as everywhere else in this module: `SI` and `GLOBAL` are
 * data, and translating them would invent a claim the run did not make.
 */
export function factorBasisLabel(
  ctx: RenderContext,
  input: RenderInput,
): string {
  const bases = input.factorSet?.bases ?? [];
  if (bases.length === 0) return ctx.notCalculated();
  return bases
    .map((basis) =>
      ctx.t("methodology.basisEntry", {
        tier: ctx.t(`methodology.tier.${basis.tier}`),
        geography: basis.geography,
        year:
          basis.applicableYear === null
            ? ctx.t("methodology.anyYear")
            : String(basis.applicableYear),
        source: basis.source,
        lines: ctx.count(basis.lineCount),
      }),
    )
    .join("; ");
}

/**
 * One substitution as the sentence the report prints.
 *
 * Every value it names comes from the run's own snapshots, so the sentence is
 * still true after the factor library changes: the passed-over factor may have
 * been deleted, corrected or superseded since, and this paragraph describes the
 * moment the figure was produced, not the library as it stands.
 */
export function substitutionText(
  ctx: RenderContext,
  entry: RenderFactorSubstitution,
): string {
  return ctx.t(`methodology.substitution.${entry.reason}`, {
    lines: ctx.count(entry.lineCount),
    activity: entry.activityType,
    chosenGeography: entry.chosenGeography,
    chosenSource: entry.chosenSource,
    enteredUnit: entry.enteredUnit,
    year:
      entry.requestedYear === null
        ? ctx.t("methodology.anyYear")
        : String(entry.requestedYear),
    betterGeography: entry.betterGeography,
    betterSource: entry.betterSource,
    betterYear:
      entry.betterYear === null
        ? ctx.t("methodology.anyYear")
        : String(entry.betterYear),
    betterUnits: entry.betterUnits.join(", "),
  });
}

/**
 * WHY THE RENDERER READS `aggregates.warnings` AT ALL.
 *
 * The whole calculation layer refuses to invent a number: no exchange rate
 * means no intensity, an unstated renewable share means no split, an
 * unconvertible unit means no energy figure. Every one of those refusals is
 * recorded as a warning (`calc/aggregate.ts`) — and until this section existed,
 * the warnings were visible on the API and INVISIBLE in the PDF and the
 * workbook. The report therefore printed "not published" where a figure should
 * be and said nothing about why, which is the one thing a reader cannot work out
 * for themselves: a blank intensity looks like a bug, a missing exchange rate is
 * an auditable fact about the data.
 *
 * So the rule this module already applies to metrics (§ "what `not collected` is
 * for") applies to figures too: a withheld number states its reason IN THE
 * DOCUMENT, in both formats, or the honesty of the calculation layer stops at
 * the API boundary.
 */
/**
 * The one qualification that is NOT an aggregate warning.
 *
 * The aggregate's six warnings are all "a figure was withheld". This one is the
 * opposite shape — a figure WAS published, by a factor weaker than the pinned
 * set holds — and it belongs in the same list for the same reason: the reader
 * who goes to "what is not in this report" is the reader who needs it. It is
 * raised from the run's own `factor_snapshot`s (see `factorSet.substitutions`),
 * not from `aggregates.warnings`, because the aggregation sums kilograms and
 * knows nothing about which factor produced one.
 */
const FACTOR_BASIS_QUALIFICATION = "factor_basis_downgraded";

/** A code the completeness section can qualify a figure with. */
export type QualificationCode =
  AggregateWarningCode | typeof FACTOR_BASIS_QUALIFICATION;

interface Qualification {
  readonly code: QualificationCode;
  /** How many records raised it — warnings are per row/entity, not per code. */
  readonly count: number;
}

/**
 * The run's warnings, grouped by code and ordered by {@link AGGREGATE_WARNINGS}.
 *
 * The ORDER comes from the constant rather than from the order the warnings
 * happened to be raised in, so the same run prints the same document (REN-5's
 * hash is a promise about bytes). `null` aggregates — a revision that was never
 * calculated — produce an empty list; the executive summary already refuses on
 * that page and a second refusal here would say nothing new.
 */
export function qualifications(input: RenderInput): Qualification[] {
  const entries = aggregateQualifications(input);

  // LAST, and only when the run actually recorded a substitution. The count is
  // calculation LINES, the same unit every other reason counts in.
  const downgraded = substitutedLineCount(input);
  if (downgraded > 0) {
    entries.push({ code: FACTOR_BASIS_QUALIFICATION, count: downgraded });
  }
  return entries;
}

/** The six WITHHELD-figure warnings alone, without the substitution entry. */
export function aggregateQualifications(input: RenderInput): Qualification[] {
  const counts = new Map<AggregateWarningCode, number>();
  for (const warning of input.aggregates?.warnings ?? []) {
    counts.set(warning.code, (counts.get(warning.code) ?? 0) + 1);
  }
  return AGGREGATE_WARNINGS.filter((code) => counts.has(code)).map((code) => ({
    code,
    count: counts.get(code) ?? 0,
  }));
}

/** How many calculation lines were priced by less than the pinned set holds. */
export function substitutedLineCount(input: RenderInput): number {
  return (input.factorSet?.substitutions ?? []).reduce(
    (total, entry) => total + entry.lineCount,
    0,
  );
}

/**
 * One warning as the sentence the report prints.
 *
 * ONE WORDING PER CODE, printed in two places: beside the figures it withheld
 * (the B3 section) and in the completeness section's full list. Two wordings
 * would be two chances to describe the same refusal differently in the same
 * document. `year` is offered to every message because `fx_rate_missing` needs
 * it and an ICU message ignores a value it does not name.
 */
export function qualificationText(
  ctx: RenderContext,
  input: RenderInput,
  entry: Qualification,
): string {
  return ctx.t(`qualifications.reason.${entry.code}`, {
    count: ctx.count(entry.count),
    year: input.aggregates?.intensity.fxYear ?? "",
  });
}

/** A list of provenance strings, or the words for "the run recorded none". */
export function joinOrNotCollected(
  ctx: RenderContext,
  values: readonly string[] | undefined,
): string {
  return values === undefined || values.length === 0
    ? ctx.notCollected()
    : values.join("; ");
}
