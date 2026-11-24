// =============================================================================
// THE TWO READ-ONLY REFERENCE CATALOGUES (T2.8 — DM-20 §4.13, DM-23 §4.15).
//
// `metric_catalog` (the 141 VSME disclosures) and `unit_conversion` (D7) are
// pure reference data: they arrive with migration `0004` (О-13 — `deploy.yml`
// ships `migrate.mjs` and never `seed.ts`), no route writes them, and neither
// carries a `company_id`. §12.2 gives both `data.read` and nothing else, and
// this module is the read half of that: the queries, the filters and the wire
// shape. The routes add the guards and nothing more.
//
// WHY THEY LIVE BESIDE THE FACTOR SETS. Both are consumed by the same three
// things: /admin/factors (a factor's `input_unit` means nothing without the
// conversion graph), the disclosure editor of T3.3 (which asks the catalogue
// what a metric IS) and CALC-3, which walks `unit_conversion` to bring an
// activity's unit onto its factor's. Splitting them into two modules would
// scatter the reference layer across three directories for no gain.
// =============================================================================
import { and, asc, eq, isNull, type SQL } from "drizzle-orm";

import { num } from "@/server/api/parse";
import { metricText, type MetricText } from "@/server/catalog/metric-text";
import type { DbClient } from "@/server/db/client";
import { metricCatalog, unitConversion } from "@/server/db/schema";

/** A `metric_catalog` row as Drizzle returns it. */
type MetricRow = typeof metricCatalog.$inferSelect;
/** A `unit_conversion` row as Drizzle returns it. */
type UnitConversionRow = typeof unitConversion.$inferSelect;

/**
 * One catalogue entry as the API speaks it (DM-20 column names, 1:1).
 *
 * `title_en` / `disclosure_title_en` travel beside the Russian `title` /
 * `disclosure_title` rather than instead of them (О-20): the workbook's names
 * are the author's, the English ones are the standard's, and the `en`/`sl`
 * renderer needs the second pair. Neither is dropped here — the consumer picks.
 */
export interface MetricDto {
  metric_key: string;
  standard: string;
  pillar: string;
  module: string;
  disclosure_code: string;
  disclosure_title: string | null;
  disclosure_title_en: string | null;
  paragraph: string | null;
  requirement_type: string;
  title: string;
  title_en: string | null;
  description: string | null;
  unit: string | null;
  applicability_condition: string | null;
  value_type: string;
  breakdown_dimensions: unknown;
  guidance: string | null;
  sort_order: number;
  is_active: boolean;
  /** 0017/0018 — Slovene wording; `null` falls back to the English. */
  title_sl: string | null;
  disclosure_title_sl: string | null;
  /** 0019 — the simplified-ESRS mapping and where a client finds the data. */
  esrs_reference: string | null;
  esrs_applicability: string | null;
  client_data_source: string | null;
  official_source: string | null;
  /**
   * Партия 18 — the words the form prints, in the reader's language. Present
   * only when the caller asked for a `locale` (see `metricText`).
   */
  text?: MetricText;
}

/** One unit conversion as the API speaks it (DM-23). `to = from × multiplier`. */
export interface UnitConversionDto {
  id: string;
  from_unit: string;
  to_unit: string;
  multiplier: number | null;
  /** NULL = a universal physical conversion; non-null = calorific/contextual. */
  activity_context: string | null;
  /**
   * NULL = shared by every factor set; non-null = this row belongs to THAT set
   * and outranks the shared one when that set is pinned (0010). Without it two
   * rows of one `(from, to, context)` reach the wire indistinguishable.
   */
  factor_set_id: string | null;
  source: string | null;
  notes: string | null;
}

/** THE metric serialiser. */
function serialiseMetric(row: MetricRow): MetricDto {
  return {
    metric_key: row.metricKey,
    standard: row.standard,
    pillar: row.pillar,
    module: row.module,
    disclosure_code: row.disclosureCode,
    disclosure_title: row.disclosureTitle,
    disclosure_title_en: row.disclosureTitleEn,
    paragraph: row.paragraph,
    requirement_type: row.requirementType,
    title: row.title,
    title_en: row.titleEn,
    description: row.description,
    unit: row.unit,
    applicability_condition: row.applicabilityCondition,
    value_type: row.valueType,
    breakdown_dimensions: row.breakdownDimensions,
    guidance: row.guidance,
    sort_order: row.sortOrder,
    is_active: row.isActive,
    title_sl: row.titleSl,
    disclosure_title_sl: row.disclosureTitleSl,
    esrs_reference: row.esrsReference,
    esrs_applicability: row.esrsApplicability,
    client_data_source: row.clientDataSource,
    official_source: row.officialSource,
  };
}

/** THE unit-conversion serialiser. `numeric` crosses the wire as a number. */
function serialiseUnitConversion(row: UnitConversionRow): UnitConversionDto {
  return {
    id: row.id,
    from_unit: row.fromUnit,
    to_unit: row.toUnit,
    multiplier: num(row.multiplier),
    activity_context: row.activityContext,
    factor_set_id: row.factorSetId,
    source: row.source,
    notes: row.notes,
  };
}

/**
 * How `GET /api/metrics` is narrowed (§12.2 names `module`; `pillar` and
 * `standard` come free from the columns К-26 put there on day one).
 *
 * A filter value is NOT validated against a list, and that is deliberate:
 * `module` holds `basic`/`comprehensive` for VSME and a topic-standard
 * identifier for the ESRS/GRI rows Phase 4 seeds, so there is no closed set to
 * check against. An unrecognised value therefore matches nothing and returns an
 * empty list — which is the truthful answer — rather than a 422 that would have
 * to be relaxed the day the catalogue grows.
 */
export interface MetricQuery {
  module?: string | null;
  pillar?: string | null;
  standard?: string | null;
  /** Партия 18 — attach `text` in this UI locale (`metricText`). */
  locale?: string | null;
}

/** The catalogue, filtered, in workbook order (`sort_order`, then the key). */
export async function listMetrics(
  db: DbClient,
  query: MetricQuery = {},
): Promise<MetricDto[]> {
  const filters: SQL[] = [];
  if (query.module) filters.push(eq(metricCatalog.module, query.module));
  if (query.pillar) filters.push(eq(metricCatalog.pillar, query.pillar));
  // 0019 added `standard = 'esrs'` rows. Every existing caller means the VSME
  // catalogue, so that stays the default; `standard=esrs` asks for the other
  // list and `standard=all` for both.
  const standard = query.standard ?? "vsme";
  if (standard !== "all") filters.push(eq(metricCatalog.standard, standard));

  const rows = await db
    .select()
    .from(metricCatalog)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(metricCatalog.sortOrder), asc(metricCatalog.metricKey));
  const metrics = rows.map(serialiseMetric);
  const locale = query.locale;
  if (!locale) return metrics;
  return metrics.map((metric) => ({
    ...metric,
    text: metricText(metric, locale),
  }));
}

/** How `GET /api/unit-conversions` is narrowed. */
export interface UnitConversionQuery {
  fromUnit?: string | null;
  toUnit?: string | null;
  /**
   * `""` selects the UNIVERSAL conversions (`activity_context IS NULL`), which
   * is a different question from "all of them" and cannot be asked with a
   * plain equality — hence the empty string as an explicit spelling.
   */
  activityContext?: string | null;
}

/** The conversion table, filtered, ordered so the graph reads predictably. */
export async function listUnitConversions(
  db: DbClient,
  query: UnitConversionQuery = {},
): Promise<UnitConversionDto[]> {
  const filters: SQL[] = [];
  if (query.fromUnit) filters.push(eq(unitConversion.fromUnit, query.fromUnit));
  if (query.toUnit) filters.push(eq(unitConversion.toUnit, query.toUnit));
  if (query.activityContext === "") {
    filters.push(isNull(unitConversion.activityContext));
  } else if (query.activityContext) {
    filters.push(eq(unitConversion.activityContext, query.activityContext));
  }

  const rows = await db
    .select()
    .from(unitConversion)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(
      asc(unitConversion.fromUnit),
      asc(unitConversion.toUnit),
      asc(unitConversion.activityContext),
    );
  return rows.map(serialiseUnitConversion);
}
