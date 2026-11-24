// =============================================================================
// Currency + annual FX resolver (DATA-INTEGRITY §Q3-FX / D8, T1.5c). For carbon
// accounting we convert money-denominated inputs (spend-based Scope-3 cat 1/2)
// into EUR — the currency the EXIOBASE factors are published in — using an
// ANNUAL-AVERAGE rate per reporting year (a seeded `fx_rates` table, year-aware
// exactly like the emission factors; NOT a live feed). `rate_to_eur` = EUR per 1
// unit of the currency (EUR → 1.0).
//
// The pure functions (`resolveFxRateMap`, `convertToEur`, `resolveDefaultCurrency`)
// take their data as arguments so they run under node/vitest without a DB and
// without `server-only`. `getFxRates` is the thin DB loader (takes the db handle
// as a parameter, so this module never imports the db singleton).
// =============================================================================

import { asc } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "@/server/db/schema";
import { currencies, fxRates } from "@/server/db/schema";

/** One `fx_rates` row (numeric coerced to a JS number). */
export interface FxRateRow {
  currency_code: string;
  year: string;
  rate_to_eur: number;
}

/**
 * Resolve `currency_code → rate_to_eur` for `year`, with the same year-fallback
 * ladder the emission-factor resolver uses: exact year, else the nearest PAST
 * year, else the nearest FUTURE year. A currency with NO rate at all is OMITTED
 * from the map (the caller then warns per D4 — never a silent 1.0 or 0).
 */
export function resolveFxRateMap(
  rows: FxRateRow[],
  year: string,
): Map<string, number> {
  const byCurrency = new Map<string, FxRateRow[]>();
  for (const r of rows) {
    const list = byCurrency.get(r.currency_code);
    if (list) list.push(r);
    else byCurrency.set(r.currency_code, [r]);
  }

  const out = new Map<string, number>();
  for (const [code, list] of byCurrency) {
    const exact = list.find((r) => r.year === year);
    if (exact) {
      out.set(code, exact.rate_to_eur);
      continue;
    }
    // Nearest past year (max year < requested), else nearest future (min year >).
    const past = list
      .filter((r) => r.year < year)
      .sort((a, b) => (a.year < b.year ? 1 : -1))[0];
    const future = list
      .filter((r) => r.year > year)
      .sort((a, b) => (a.year < b.year ? -1 : 1))[0];
    const pick = past ?? future;
    if (pick) out.set(code, pick.rate_to_eur);
    // else: no rate for this currency at all → omit (caller warns).
  }
  return out;
}

/**
 * Convert `amount` in `currency` to EUR using a resolved rate map. Returns `null`
 * when the currency has no rate in the map (D4: the caller flags it with an
 * explicit warning; the line then contributes 0) — never a silent 1.0 or 0.
 */
export function convertToEur(
  amount: number,
  currency: string,
  rateMap: Map<string, number>,
): number | null {
  const rate = rateMap.get(currency);
  if (rate == null) return null;
  return amount * rate;
}

/** A default-currency resolution context (forward-compatible with subsidiaries, D8). */
export interface CurrencyContext {
  subsidiary?: { currency?: string | null } | null;
  company?: { currency?: string | null } | null;
}

/**
 * The default currency for data entry: a future per-subsidiary default wins, then
 * the company default, then EUR. Company-level today (D8); the subsidiary slot lets
 * a later multi-entity model attach a per-unit currency without a rewrite.
 */
export function resolveDefaultCurrency(ctx: CurrencyContext): string {
  return ctx.subsidiary?.currency ?? ctx.company?.currency ?? "EUR";
}

// The db singleton or a transaction handle (the recalc transaction passes its
// `tx`), mirroring the FactorDb union so `getFxRates` runs inside a transaction.
type Database = PostgresJsDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type FxDb = Database | Transaction;

/**
 * Load all `fx_rates` and resolve the `currency_code → rate_to_eur` map for `year`
 * (year-fallback via `resolveFxRateMap`). `numeric` columns come back as strings,
 * so they are coerced to numbers here.
 */
export async function getFxRates(
  db: FxDb,
  year: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      currency_code: fxRates.currencyCode,
      year: fxRates.year,
      rate_to_eur: fxRates.rateToEur,
    })
    .from(fxRates);
  return resolveFxRateMap(
    rows.map((r) => ({
      currency_code: r.currency_code,
      year: r.year,
      rate_to_eur: Number(r.rate_to_eur),
    })),
    year,
  );
}

/** One `currencies` reference row for the spend-editor currency dropdown. */
export interface CurrencyRow {
  code: string;
  name: string;
  symbol: string;
  decimals: number;
}

/**
 * List all seeded `currencies` (ISO-4217), ordered by code — the allowed set for a
 * spend line's `currency` AND the dropdown options. A write's currency is validated
 * against this set server-side; the client can only pick a seeded code.
 */
export async function listCurrencies(db: FxDb): Promise<CurrencyRow[]> {
  const rows = await db
    .select({
      code: currencies.code,
      name: currencies.name,
      symbol: currencies.symbol,
      decimals: currencies.decimals,
    })
    .from(currencies)
    .orderBy(asc(currencies.code));
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    symbol: r.symbol,
    decimals: r.decimals,
  }));
}
