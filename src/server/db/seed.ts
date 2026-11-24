/**
 * Seed script — the reference minimum of a local database (PG-PLAN T-8,
 * PG-IMPL-SPEC §2.3/§5.3; plan T1.4/T1.5/T1.8, О-13).
 *
 * See docs/decisions/server-db-seed.md for the full account.
 */
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { PLAN_SEED } from "@/server/billing/plan-catalog";

import * as schema from "./schema";
import {
  currencies,
  emissionFactor,
  factorSet,
  fxRates,
  metricCatalog,
  planPrices,
  plans,
  unitConversion,
} from "./schema";
import { legacyFactorRows, LEGACY_FACTOR_SET } from "./seed-data/factor-set-v1";
import { unitConversionRows } from "./seed-data/unit-conversions";
import { VSME_METRICS } from "./seed-data/vsme-metrics";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set — cannot seed. Set DATABASE_URL (e.g. " +
        "postgres://hosmos:hosmos@localhost:5432/hosmos) before running db:seed.",
    );
  }

  // Dedicated single-use connection for the CLI (max:1); ends in finally.
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    await db.transaction(async (tx) => {
      // ─── Plan catalogue — plans + plan_prices (§5, T-A2) ─────────────────
      // Idempotent UPSERT (NOT truncate): `plans` is FK-referenced by
      // `company_subscription` / `payments`, so the catalogue is replaced in
      // place by primary/unique key. Rows come verbatim from `PLAN_SEED`
      // (derived 1:1 from `PLAN_FEATURES`), incl. `features.integrations` (Ф-1).
      await tx
        .insert(plans)
        .values(
          PLAN_SEED.plans.map((p) => ({
            id: p.id,
            name: p.name,
            sortOrder: p.sortOrder,
            features: p.features,
          })),
        )
        .onConflictDoUpdate({
          target: plans.id,
          set: {
            name: sql`excluded.name`,
            sortOrder: sql`excluded.sort_order`,
            features: sql`excluded.features`,
            updatedAt: sql`now()`,
          },
        });

      await tx
        .insert(planPrices)
        .values(
          PLAN_SEED.prices.map((p) => ({
            planId: p.planId,
            period: p.period,
            currency: p.currency,
            amountMinor: p.amountMinor,
          })),
        )
        .onConflictDoUpdate({
          target: [planPrices.planId, planPrices.period, planPrices.currency],
          set: { amountMinor: sql`excluded.amount_minor` },
        });

      // DATA-INTEGRITY T1.5c — currency reference + annual FX rates (§5, D8).
      // The 0002 migration already inserts the currency rows inline (so the
      // companies.currency FK validates at migrate time); this is the canonical
      // seed for a fresh db, idempotent (no-op after the migration).
      await tx
        .insert(currencies)
        .values([
          { code: "EUR", name: "Euro", symbol: "€", decimals: 2 },
          { code: "USD", name: "US Dollar", symbol: "$", decimals: 2 },
          { code: "GBP", name: "Pound Sterling", symbol: "£", decimals: 2 },
          { code: "RSD", name: "Serbian Dinar", symbol: "дин.", decimals: 2 },
          { code: "CHF", name: "Swiss Franc", symbol: "CHF", decimals: 2 },
          { code: "PLN", name: "Polish Złoty", symbol: "zł", decimals: 2 },
          { code: "SEK", name: "Swedish Krona", symbol: "kr", decimals: 2 },
          { code: "NOK", name: "Norwegian Krone", symbol: "kr", decimals: 2 },
          { code: "DKK", name: "Danish Krone", symbol: "kr", decimals: 2 },
          { code: "CZK", name: "Czech Koruna", symbol: "Kč", decimals: 2 },
        ])
        .onConflictDoNothing();

      // rate_to_eur = EUR per 1 unit of currency (EUR → 1.0). ECB/NBS annual
      // averages, years 2023/2024/2025 (§5, verify-before-prod-seed).
      const FX: Record<string, [string, string, string]> = {
        EUR: ["1", "1", "1"],
        USD: ["0.92480", "0.92390", "0.92500"],
        GBP: ["1.14970", "1.18120", "1.19000"],
        RSD: ["0.008528", "0.008541", "0.008540"],
        CHF: ["1.02900", "1.04980", "1.06500"],
        PLN: ["0.22070", "0.23220", "0.23600"],
        SEK: ["0.086800", "0.087490", "0.091000"],
        NOK: ["0.089200", "0.085980", "0.086000"],
        DKK: ["0.134200", "0.134050", "0.134000"],
        CZK: ["0.041700", "0.039770", "0.040000"],
      };
      const YEARS = ["2023", "2024", "2025"] as const;
      const fxRows = Object.entries(FX).flatMap(([code, rates]) =>
        YEARS.map((year, i) => ({
          currencyCode: code,
          year,
          rateToEur: rates[i],
        })),
      );
      await tx.insert(fxRates).values(fxRows).onConflictDoNothing();

      // ─── VSME metric catalogue — 141 rows (T1.4, MIG-3, DM-20) ───────────
      // A THIN WRAPPER over `seed-data/vsme-metrics.ts`, not a second copy of
      // the data: `drizzle/0004_data_model.sql` already inserts the very same
      // rows (production never runs this script — О-13), and this upsert is the
      // catch-up path for a warm local database plus the way a corrected
      // workbook reaches an already-migrated one. Hence DO UPDATE rather than
      // DO NOTHING: re-running `db:seed` after regenerating the JSON must move
      // the text, while never touching `metric_key` and never duplicating a row.
      await tx
        .insert(metricCatalog)
        .values(
          VSME_METRICS.map((m) => ({
            metricKey: m.metric_key,
            standard: m.standard,
            pillar: m.pillar,
            module: m.module,
            disclosureCode: m.disclosure_code,
            disclosureTitle: m.disclosure_title,
            disclosureTitleEn: m.disclosure_title_en,
            paragraph: m.paragraph,
            requirementType: m.requirement_type,
            title: m.title,
            titleEn: m.title_en,
            description: m.description,
            unit: m.unit,
            applicabilityCondition: m.applicability_condition,
            valueType: m.value_type,
            breakdownDimensions: m.breakdown_dimensions,
            guidance: m.guidance,
            sortOrder: m.sort_order,
            isActive: m.is_active,
          })),
        )
        .onConflictDoUpdate({
          target: metricCatalog.metricKey,
          set: {
            standard: sql`excluded.standard`,
            pillar: sql`excluded.pillar`,
            module: sql`excluded.module`,
            disclosureCode: sql`excluded.disclosure_code`,
            disclosureTitle: sql`excluded.disclosure_title`,
            disclosureTitleEn: sql`excluded.disclosure_title_en`,
            paragraph: sql`excluded.paragraph`,
            requirementType: sql`excluded.requirement_type`,
            title: sql`excluded.title`,
            titleEn: sql`excluded.title_en`,
            description: sql`excluded.description`,
            unit: sql`excluded.unit`,
            applicabilityCondition: sql`excluded.applicability_condition`,
            valueType: sql`excluded.value_type`,
            breakdownDimensions: sql`excluded.breakdown_dimensions`,
            guidance: sql`excluded.guidance`,
            sortOrder: sql`excluded.sort_order`,
            isActive: sql`excluded.is_active`,
          },
        });

      // ─── Factor set `legacy-v1` — 440 factors + units (T1.5, MIG-4/MIG-5) ─
      // The same THIN WRAPPER shape as the catalogue above: the rows come from
      // `seed-data/factor-set-v1.ts` / `seed-data/unit-conversions.ts`, and
      // `drizzle/0004_data_model.sql` inserts the identical rows because
      // production never runs this script (О-13). Ids are derived (UUIDv5 of the
      // natural key) in that module, so the two paths write the SAME row, not
      // merely the same values.
      //
      // DO NOTHING, not DO UPDATE, and no TRUNCATE: DM-21 says a factor set is
      // released, never edited — a correction is a NEW `factor_set`. Rewriting
      // `legacy-v1` in place would silently change the numbers under any period
      // already pinned to it, which is exactly what the pin exists to prevent.
      await tx
        .insert(factorSet)
        .values({
          id: LEGACY_FACTOR_SET.id,
          code: LEGACY_FACTOR_SET.code,
          name: LEGACY_FACTOR_SET.name,
          description: LEGACY_FACTOR_SET.description,
          status: LEGACY_FACTOR_SET.status,
          publishedAt: new Date(LEGACY_FACTOR_SET.published_at),
        })
        .onConflictDoNothing({ target: factorSet.code });

      // Read the id back rather than trusting the constant: on a database where
      // the set already exists the INSERT above was a no-op, and the factors
      // must hang off whatever row is actually there (FK, not a hope).
      const [existingSet] = await tx
        .select({ id: factorSet.id })
        .from(factorSet)
        .where(eq(factorSet.code, LEGACY_FACTOR_SET.code))
        .limit(1);
      if (!existingSet) {
        throw new Error(
          `factor_set '${LEGACY_FACTOR_SET.code}' is missing after the upsert — ` +
            "emission_factor.factor_set_id is NOT NULL and cannot be filled.",
        );
      }

      await tx
        .insert(emissionFactor)
        .values(
          legacyFactorRows().map((f) => ({
            id: f.id,
            factorSetId: existingSet.id,
            factorCode: f.factor_code,
            factorName: f.factor_name,
            sourceName: f.source_name,
            sourceVersion: f.source_version,
            applicableYear: f.applicable_year,
            geography: f.geography,
            activityType: f.activity_type,
            inputUnit: f.input_unit,
            factorValue: f.factor_value,
            outputUnit: f.output_unit,
            gwpBasis: f.gwp_basis,
            wttIncluded: f.wtt_included,
            biogenicTreatment: f.biogenic_treatment,
            rfIncluded: f.rf_included,
            sourceUrl: f.source_url,
            licence: f.licence,
            status: f.status,
          })),
        )
        .onConflictDoNothing();

      await tx
        .insert(unitConversion)
        .values(
          unitConversionRows().map((c) => ({
            id: c.id,
            fromUnit: c.from_unit,
            toUnit: c.to_unit,
            multiplier: c.multiplier,
            activityContext: c.activity_context,
            source: c.source,
            notes: c.notes,
          })),
        )
        // The arbiter is the hand-written COALESCE expression index, which
        // `onConflictDoNothing` cannot name — so the target is left off and any
        // conflict (that index included) is a no-op.
        .onConflictDoNothing();
    });

    // Plan catalogue post-check (§5.3): exactly 4 plans + 8 prices.
    const [{ plans_n, prices_n }] = await db.execute<{
      plans_n: number;
      prices_n: number;
    }>(sql`
      SELECT (SELECT count(*)::int FROM plans) AS plans_n,
             (SELECT count(*)::int FROM plan_prices) AS prices_n
    `);
    if (plans_n !== 4 || prices_n !== 8) {
      throw new Error(
        `Plan catalogue seed check failed: expected plans=4, plan_prices=8; ` +
          `got plans=${plans_n}, plan_prices=${prices_n}.`,
      );
    }
    console.log(`Plan catalogue: plans=${plans_n}, plan_prices=${prices_n}.`);

    // Metric catalogue post-check (T1.4): 141 rows, 70 basic / 71 comprehensive.
    // Asserted here as well as in the test so a broken seed fails at `db:seed`.
    const [{ metrics_n, basic, comprehensive }] = await db.execute<{
      metrics_n: number;
      basic: number;
      comprehensive: number;
    }>(sql`
      SELECT count(*)::int AS metrics_n,
             count(*) FILTER (WHERE module = 'basic')::int AS basic,
             count(*) FILTER (WHERE module = 'comprehensive')::int AS comprehensive
      FROM metric_catalog WHERE standard = 'vsme'
    `);
    if (metrics_n !== 141 || basic !== 70 || comprehensive !== 71) {
      throw new Error(
        `Metric catalogue seed check failed: expected 141 (70 basic / 71 ` +
          `comprehensive); got ${metrics_n} (${basic}/${comprehensive}).`,
      );
    }
    console.log(
      `Metric catalogue: ${metrics_n} VSME metrics ` +
        `(${basic} basic / ${comprehensive} comprehensive).`,
    );

    // Factor set post-check (T1.5): every row of `legacy-v1` present and the set
    // ACTIVE. Asserted here as well as in the test, because a set that is short a
    // category does not fail until a calculation asks for it (§0.7).
    //
    // Scoped to what THIS seed owns — the `legacy-v1` set and the derived
    // conversion ids — never to a global `count(*)`. A database that has run the
    // test suite carries other suites' throwaway `factor_set` and
    // `unit_conversion` rows, and neither is a reason for `db:seed` to fail.
    const expectedFactors = legacyFactorRows().length;
    const expectedConversions = unitConversionRows().length;
    const [{ sets_n, factors_n }] = await db.execute<{
      sets_n: number;
      factors_n: number;
    }>(sql`
      SELECT (SELECT count(*)::int FROM factor_set
               WHERE code = ${LEGACY_FACTOR_SET.code} AND status = 'active') AS sets_n,
             (SELECT count(*)::int FROM emission_factor f
                JOIN factor_set s ON s.id = f.factor_set_id
               WHERE s.code = ${LEGACY_FACTOR_SET.code}) AS factors_n
    `);
    const seededIds = new Set(unitConversionRows().map((c) => c.id));
    const conversions_n = [
      ...(await db.execute<{ id: string }>(
        sql`SELECT id FROM unit_conversion`,
      )),
    ].filter((c) => seededIds.has(c.id)).length;
    if (
      sets_n !== 1 ||
      factors_n !== expectedFactors ||
      conversions_n !== expectedConversions
    ) {
      throw new Error(
        `Factor set seed check failed: expected 1 active '${LEGACY_FACTOR_SET.code}', ` +
          `${expectedFactors} emission_factor and ${expectedConversions} ` +
          `unit_conversion rows; got ${sets_n}, ${factors_n}, ${conversions_n}.`,
      );
    }
    console.log(
      `Factor set ${LEGACY_FACTOR_SET.code}: ${factors_n} emission factors, ` +
        `${conversions_n} unit conversions.`,
    );

    // The per-category `emission_factors` report that used to close the run went
    // with its table in T3.9. Its successor is the factor-set post-check above:
    // it counts the rows of `legacy-v1` in `emission_factor` and fails loudly if
    // the set is short, which is the check that actually protects a calculation
    // (§0.7 — a missing factor must never become a zero).
    console.log("Seed complete.");
  } finally {
    await client.end({ timeout: 5 });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
