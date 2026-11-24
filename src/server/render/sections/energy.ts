import type {
  AggregateWarningCode,
  EntityAggregate,
} from "@/server/calc/aggregate";
import type { RenderContext } from "../i18n";
import type { RenderBlock, RenderInput } from "./types";
import {
  disclosureTable,
  type QualificationCode,
  qualifications,
  qualificationText,
} from "./shared";

/**
 * The warnings whose subject is a figure the B3 section prints — the energy
 * split and the intensity, with its turnover and its exchange rate.
 *
 * `line_outside_boundary` is deliberately NOT here: it is about the
 * reconciliation of the emission totals, not about anything B3 shows, and it is
 * listed in full under completeness with the rest.
 */
const ENERGY_SECTION_WARNINGS: ReadonlySet<QualificationCode> =
  new Set<AggregateWarningCode>([
    "historical_context_missing",
    "energy_unconvertible",
    "renewable_share_missing",
    "turnover_missing",
    "currency_missing",
    "fx_rate_missing",
  ]);

/** B3 — energy and emissions, in total and per legal entity. */
export function energySection(
  ctx: RenderContext,
  input: RenderInput,
): RenderBlock[] {
  const { t } = ctx;
  const totals = input.aggregates?.totals ?? null;
  const energy = input.aggregates?.energy ?? null;
  const intensity = input.aggregates?.intensity ?? null;
  const perEntity: readonly EntityAggregate[] =
    input.aggregates?.byLegalEntity ?? [];

  const blocks: RenderBlock[] = [
    { kind: "paragraph", text: t("energy.intro") },
    {
      kind: "keyValues",
      rows: [
        {
          label: t("energy.totalMwh"),
          value: ctx.megawattHours(energy?.totalMwh ?? null),
        },
        {
          label: t("energy.renewableMwh"),
          value: ctx.megawattHours(energy?.renewableMwh ?? null),
        },
        {
          label: t("energy.nonRenewableMwh"),
          value: ctx.megawattHours(energy?.nonRenewableMwh ?? null),
        },
        {
          label: t("energy.scope1"),
          value: ctx.tonnes(totals?.scope1Co2e ?? null),
        },
        {
          label: t("energy.scope1Biogenic"),
          value: ctx.tonnes(totals?.scope1BiogenicCo2 ?? null),
        },
        {
          label: t("energy.scope2LocationBased"),
          value: ctx.tonnes(totals?.scope2LocationBasedCo2e ?? null),
        },
        {
          label: t("energy.scope2MarketBased"),
          value: ctx.tonnes(totals?.scope2MarketBasedCo2e ?? null),
        },
        {
          label: t("energy.turnover"),
          value: ctx.euro(intensity?.turnoverEur ?? null),
        },
        {
          label: t("energy.intensityLocationBased"),
          value: ctx.intensity(intensity?.locationBasedIntensity ?? null),
        },
        {
          label: t("energy.intensityMarketBased"),
          value: ctx.intensity(intensity?.marketBasedIntensity ?? null),
        },
      ],
    },
  ];

  // The caveats belong HERE, immediately under the figures they are about: the
  // energy split, the turnover and the two intensities are all printed above,
  // and every one of them can be withheld. A reason on the last page would be a
  // footnote nobody reaches; a reason under the blank is the explanation.
  const energyQualifications = qualifications(input).filter((entry) =>
    ENERGY_SECTION_WARNINGS.has(entry.code),
  );
  for (const entry of energyQualifications) {
    blocks.push({
      kind: "paragraph",
      text: qualificationText(ctx, input, entry),
    });
  }

  blocks.push({ kind: "subheading", text: t("energy.byEntityHeading") });
  if (perEntity.length === 0) {
    blocks.push({ kind: "paragraph", text: t("energy.noEntities") });
  } else {
    blocks.push({
      kind: "table",
      columns: [
        t("basis.columns.entity"),
        t("energy.scope1"),
        t("energy.scope2LocationBased"),
        t("energy.scope2MarketBased"),
        t("energy.totalMwh"),
      ],
      rows: perEntity.map((entity) => [
        entity.name ?? t("energy.entityNameMissing"),
        ctx.tonnes(entity.totals.scope1Co2e),
        ctx.tonnes(entity.totals.scope2LocationBasedCo2e),
        ctx.tonnes(entity.totals.scope2MarketBasedCo2e),
        ctx.megawattHours(entity.energy.totalMwh),
      ]),
    });
  }

  blocks.push(...disclosureTable(ctx, input, "B3"));
  return blocks;
}
