// =============================================================================
// YEAR-FALLBACK FACTOR RESOLUTION FOR THE SPEND PATH (plan T3.8, §5 "4th tail").
//
// `FactorRow`, `ResolvedFactor`, `Year` and `resolveFactor` used to live in
// the legacy `emissions/{factor-resolver,types}.ts`, next to the wide-table
// monthly engine. T3.6 moved `computeScope3Spend` into this directory but left
// those four behind, because they are a TYPE and a PURE FUNCTION — no table, no
// db import — and moving them was T3.8's job. T3.8 deletes that whole directory
// wholesale, so they are moved here VERBATIM: the ladder below is the same code,
// so a spend number cannot move because a file did.
//
// WHAT WAS LEFT BEHIND, and why none of it belongs here:
//   • `GridRow` / `resolveGridFactor`  — grid electricity is Scope 2, not spend;
//   • `FactorRowsBundle` / `resolveAllFactors` / `FACTOR_SPECS` — the 23 fixed
//     wide-table factors of the deleted monthly engine;
//   • `CalculationFactors` / `FactorSnapshot` — that engine's output shapes.
// The spend path resolves exactly ONE factor per line, by commodity key, so the
// ladder plus the two row shapes it needs is the whole surviving surface.
//
// PURE — no `server-only`, no db import (`recalculate.ts` is the module that
// talks to Postgres and builds `FactorRow[]` out of the NEW `emission_factor`
// rows). Keeping it that way is what lets `compute.test.ts` run in node env.
// =============================================================================

/** A reporting year as the row shapes carry it — TEXT in the legacy tables ('2024'). */
export type Year = string;

/** Normalised factor row the ladder resolves against (one candidate per year/country). */
export interface FactorRow {
  id: string; // uuid строки
  factor_id: string;
  country_code: string | null; // NULL = дефолт EU/DEFRA
  year: string;
  value: number; // kg_co2e | kg_co2e_per_km | kg_co2e_with_rf | kg_co2e_per_kwh
  unit: string | null;
  source: string | null; // код источника фактора
}

/** The ladder's verdict — the row that won, or `missing: true` when none did. */
export interface ResolvedFactor {
  table: string;
  id: string | null;
  value: number;
  unit: string | null;
  country: string | null;
  year: string | null;
  source: string | null;
  fallback: boolean;
  missing: boolean;
}

// Годы в строках — TEXT ('2023'…'2025'); сравнение всегда численное.
const yearNum = (year: string): number => parseInt(year, 10);

/** max(year) WHERE year < pYear. */
function maxPast<T extends { year: string }>(
  rows: T[],
  pYear: number,
): T | undefined {
  let best: T | undefined;
  for (const row of rows) {
    const y = yearNum(row.year);
    if (y < pYear && (best === undefined || y > yearNum(best.year))) best = row;
  }
  return best;
}

/** min(year) WHERE year > pYear. */
function minFuture<T extends { year: string }>(
  rows: T[],
  pYear: number,
): T | undefined {
  let best: T | undefined;
  for (const row of rows) {
    const y = yearNum(row.year);
    if (y > pYear && (best === undefined || y < yearNum(best.year))) best = row;
  }
  return best;
}

function fromRow(
  table: string,
  row: FactorRow,
  fallback: boolean,
): ResolvedFactor {
  return {
    table,
    id: row.id,
    value: row.value,
    unit: row.unit,
    country: row.country_code,
    year: row.year,
    source: row.source,
    fallback,
    missing: false,
  };
}

// Ступень 6: строки нет — value 0, дырка видна вызывающему через `missing`.
// fallback: false — отсутствие строки сигнализируется отдельным флагом missing.
// D4: спенд-путь на `missing` НЕ считает 0 молча, а пишет warning и пропускает строку.
function missingFactor(table: string): ResolvedFactor {
  return {
    table,
    id: null,
    value: 0,
    unit: null,
    country: null,
    year: null,
    source: null,
    fallback: false,
    missing: true,
  };
}

/**
 * Ступени (первое совпадение выигрывает), country = страна компании | null:
 * 1. (factor_id, country, year)                        → fallback: false
 * 2. (factor_id, NULL,    year)                        → fallback: country != null
 * 3. (factor_id, country, max(year) WHERE year < p)    → fallback: true
 * 4. (factor_id, NULL,    max(year) WHERE year < p)    → fallback: true
 * 5. (factor_id, country|NULL, min(year) WHERE year > p) — сначала страна,
 *    затем NULL                                        → fallback: true
 * 6. missing: true, value 0, id/unit/source/country/year = null
 *
 * `table` is a free label copied onto the verdict (the spend path passes
 * `"scope3_factors"`); it never selects rows — `rows` is already the candidate set.
 */
export function resolveFactor(
  rows: FactorRow[],
  table: string,
  factorId: string,
  country: string | null,
  year: Year,
): ResolvedFactor {
  const pYear = yearNum(year);
  const candidates = rows.filter((r) => r.factor_id === factorId);
  const national =
    country === null
      ? []
      : candidates.filter((r) => r.country_code === country);
  const defaults = candidates.filter((r) => r.country_code === null);

  // 1. точное национальное значение
  const exactNational = national.find((r) => yearNum(r.year) === pYear);
  if (exactNational) return fromRow(table, exactNational, false);

  // 2. дефолт нужного года; при country = null дефолт и запрашивался → false
  const exactDefault = defaults.find((r) => yearNum(r.year) === pYear);
  if (exactDefault) return fromRow(table, exactDefault, country !== null);

  // 3–4. максимальный прошлый год: сначала страна, затем дефолт
  const pastRow = maxPast(national, pYear) ?? maxPast(defaults, pYear);
  if (pastRow) return fromRow(table, pastRow, true);

  // 5. минимальный будущий год: сначала страна, затем дефолт
  const futureRow = minFuture(national, pYear) ?? minFuture(defaults, pYear);
  if (futureRow) return fromRow(table, futureRow, true);

  // 6. строки нет вовсе
  return missingFactor(table);
}
