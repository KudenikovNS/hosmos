import type { RenderContext } from "../i18n";
import type { RenderBlock, RenderInput } from "./types";
import { aggregateQualifications, substitutedLineCount } from "./shared";

/** REN-2's executive summary — or its refusal, when the run did not complete. */
export function executiveSection(
  ctx: RenderContext,
  input: RenderInput,
): RenderBlock[] {
  const { t } = ctx;
  const blocks: RenderBlock[] = [];
  const totals = input.aggregates?.totals ?? null;
  const energy = input.aggregates?.energy ?? null;
  const intensity = input.aggregates?.intensity ?? null;

  // The refusal comes FIRST, before any table, so a reader cannot reach the
  // figures without having read why there are none (§0.7 / AC-6).
  if (input.run === null) {
    blocks.push({ kind: "paragraph", text: t("executive.noRun") });
  } else if (input.run.status === "failed") {
    blocks.push({
      kind: "paragraph",
      text: t("executive.failedRun", {
        failed: ctx.count(input.run.failedCount),
        lines: ctx.count(input.run.lineCount),
      }),
    });
  } else {
    blocks.push({ kind: "paragraph", text: t("executive.intro") });
  }

  // A reader must not reach the table below without being told that some of it
  // is deliberately blank. The REASONS are not repeated here — they are printed
  // beside the figures they withheld (B3) and in full under completeness — but
  // the fact is stated at the first place a "not published" appears.
  //
  // THE TWO FLAGS ARE SEPARATE, AND MUST BE. `executive.qualified` says figures
  // were WITHHELD rather than estimated; that sentence is simply untrue of a
  // report whose only qualification is a downgraded factor basis, where every
  // figure IS published. Folding the substitution into it would buy one fewer
  // paragraph at the price of the first sentence a reader meets being wrong.
  if (input.aggregates !== null && aggregateQualifications(input).length > 0) {
    blocks.push({
      kind: "paragraph",
      text: t("executive.qualified", { section: t("sections.completeness") }),
    });
  }
  if (substitutedLineCount(input) > 0) {
    blocks.push({
      kind: "paragraph",
      text: t("executive.basisQualified", {
        section: t("sections.methodology"),
      }),
    });
  }

  const included = input.scope.filter((row) => row.status === "included");
  blocks.push({
    kind: "keyValues",
    rows: [
      {
        label: t("executive.scope1"),
        value: ctx.tonnes(totals?.scope1Co2e ?? null),
      },
      {
        label: t("executive.scope1Biogenic"),
        value: ctx.tonnes(totals?.scope1BiogenicCo2 ?? null),
      },
      {
        label: t("executive.scope2LocationBased"),
        value: ctx.tonnes(totals?.scope2LocationBasedCo2e ?? null),
      },
      {
        label: t("executive.scope2MarketBased"),
        value: ctx.tonnes(totals?.scope2MarketBasedCo2e ?? null),
      },
      {
        label: t("executive.energyTotal"),
        value: ctx.megawattHours(energy?.totalMwh ?? null),
      },
      {
        label: t("executive.intensityLocationBased"),
        value: ctx.intensity(intensity?.locationBasedIntensity ?? null),
      },
      {
        label: t("executive.intensityMarketBased"),
        value: ctx.intensity(intensity?.marketBasedIntensity ?? null),
      },
      {
        label: t("executive.coverage"),
        value: t("executive.coverageValue", {
          included: ctx.count(included.length),
          total: ctx.count(input.scope.length),
        }),
      },
    ],
  });

  if (input.comparative) {
    blocks.push({ kind: "subheading", text: t("executive.comparative") });
    blocks.push({
      kind: "table",
      columns: [
        t("executive.columns.figure"),
        `${input.period.name}`,
        `${input.comparative.periodName}`,
      ],
      rows: [
        [
          t("executive.scope1"),
          ctx.tonnes(totals?.scope1Co2e ?? null),
          ctx.tonnes(input.comparative.totals.scope1Co2e),
        ],
        [
          t("executive.scope2LocationBased"),
          ctx.tonnes(totals?.scope2LocationBasedCo2e ?? null),
          ctx.tonnes(input.comparative.totals.scope2LocationBasedCo2e),
        ],
        [
          t("executive.scope2MarketBased"),
          ctx.tonnes(totals?.scope2MarketBasedCo2e ?? null),
          ctx.tonnes(input.comparative.totals.scope2MarketBasedCo2e),
        ],
        [
          t("executive.energyTotal"),
          ctx.megawattHours(energy?.totalMwh ?? null),
          ctx.megawattHours(input.comparative.energy.totalMwh),
        ],
      ],
    });
  } else {
    blocks.push({ kind: "paragraph", text: t("executive.noComparative") });
  }

  return blocks;
}
