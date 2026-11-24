// =============================================================================
// THE RENDERER'S LOCALE (О-14) — MESSAGES, NUMBERS AND DATES.
//
// ── WHY THE RENDERER TAKES A LOCALE INSTEAD OF READING ONE ───────────────────
// A render is an IMMUTABLE, hash-pinned artefact (REN-5): its bytes are the
// report. So the language cannot be a property of LOOKING at the report — two
// people opening the same `report_render` row must see the same file, or the
// hash stops meaning anything. О-14 therefore makes the language an INPUT of the
// render and a column of the row (`report_render.language`, CHECK `en|sl`), and
// this module is where that input becomes text. `T5.7` persists the value; this
// task only insists that nothing downstream can print a word the caller did not
// choose a language for.
//
// ── WHY THE MESSAGE FILES ARE STATICALLY IMPORTED (R-9) ──────────────────────
// `src/i18n/request.ts` loads `messages/${locale}.json` with a TEMPLATE-LITERAL
// dynamic import, which is right for a request-scoped React tree: only the
// locale actually requested is paid for. It is exactly wrong here. This module
// runs inside a route handler that ends up in `.next/standalone`, and Next's
// file tracer resolves STATIC imports; a computed specifier is a shrug. R-9 is
// the record of the last time this bit — `deploy.yml` copies `drizzle-orm` and
// `postgres` by hand because the tracer pruned them — and a report that renders
// in `npm run dev` and throws `MODULE_NOT_FOUND` in production is the same bug
// one layer up. Both locales are therefore imported by name. They are ~100 KB of
// JSON on a server that already holds a Postgres pool.
//
// ── NUMBERS AND DATES DO NOT COME FROM next-intl ─────────────────────────────
// `createTranslator` gives message lookup and ICU interpolation; the formatting
// half of next-intl lives in `useFormatter`, which is a React hook. So the two
// formatters here are plain `Intl`, constructed once per render. `Intl` is also
// the reason the FIGURES are passed as STRINGS: `numeric` values arrive from
// Postgres as decimal strings, `Intl.NumberFormat.format` accepts a string and
// reads it as a decimal rather than a double, and the report therefore never
// rounds a figure through a float on its way to the page.
// =============================================================================
import { createTranslator } from "next-intl";

import { localeNames, type ReportLanguage } from "@/i18n/locales";
import { kilogramsToTonnes } from "@/shared/units";

import en from "../../../messages/en.json";
import sl from "../../../messages/sl.json";

/**
 * The Slovenian bundle, typed as the English one.
 *
 * The two files are supposed to have identical key sets, and that IS enforced —
 * by `src/shared/__tests__/i18n-parity.test.ts`, which compares every leaf key
 * of every locale pair. It is not enforced by the type system, because JSON
 * imports are typed structurally and the two literals are two different types
 * the moment one of them gains a key. Rather than lose key checking on the
 * translator (which is the whole point of using next-intl here), the file is
 * asserted into the English shape and the parity test keeps the assertion true.
 */
const slovenian = sl as unknown as typeof en;

/** The bundle of a locale. Static (see the header, R-9), never computed. */
const MESSAGES: Readonly<Record<ReportLanguage, typeof en>> = {
  en,
  sl: slovenian,
};

/**
 * The namespace О-14 reserves for the renderer.
 *
 * Every word of TEMPLATE text the PDF prints comes from under here. Subject text
 * — the metric catalogue's own titles, an entity's registered address, a
 * preparer's exclusion reason — is DATA and is printed as stored; translating it
 * would mean inventing content the company did not write.
 */
const NAMESPACE = "render";

/**
 * A translator over `render.*`, wired to THROW on a missing key.
 *
 * next-intl's default is to log and fall back to the key itself, which is the
 * right behaviour for a screen (a broken label beats a blank page) and the wrong
 * one for a report: `render.basis.heading` printed as a heading in a signed PDF
 * is a defect that ships silently. Here a missing message stops the render.
 */
function renderTranslator(locale: ReportLanguage) {
  return createTranslator({
    locale,
    messages: MESSAGES[locale],
    namespace: NAMESPACE,
    onError: (error) => {
      throw error;
    },
  });
}

/** The translator {@link renderTranslator} builds — keys checked against `en`. */
type RenderTranslator = ReturnType<typeof renderTranslator>;

// ─── Formatting ──────────────────────────────────────────────────────────────

/** Decimals kept for a tonne figure on the page (a kilogram of CO₂e). */
const TONNE_PAGE_DECIMALS = 3;

/** Decimals kept for an MWh figure on the page (a kilowatt-hour). */
const ENERGY_PAGE_DECIMALS = 3;

/** Decimals kept for an intensity — tiny by nature, see `calc/aggregate.ts`. */
const INTENSITY_PAGE_DECIMALS = 9;

/**
 * Everything a section builder needs to turn values into words.
 *
 * Passed around as one object so that no builder can reach a formatter without
 * also having the translator that owns the "not collected" / "not published"
 * wordings — the two are a pair, and splitting them is how a `?? "—"` gets
 * written by accident.
 */
export interface RenderContext {
  readonly locale: ReportLanguage;
  readonly t: RenderTranslator;
  /** The locale's own name, for the cover page (`English` / `Slovenščina`). */
  readonly localeName: string;
  /**
   * A figure with a unit, or the words for "there is no figure".
   *
   * THE ONE RULE OF THIS MODULE: `null` NEVER BECOMES `0`. `calc/aggregate.ts`
   * publishes `null` for every total of a failed run precisely so that the sum
   * of the lines that happened to work cannot be printed as if it were the
   * inventory; if this function answered `"0"` it would undo that decision in
   * the only place where it is visible to an auditor.
   */
  quantity(value: string | null, unit: string, decimals?: number): string;
  /** A kilogram figure printed in tonnes (the unit VSME B3 reports in). */
  tonnes(kilograms: string | null): string;
  /** An MWh figure. */
  megawattHours(value: string | null): string;
  /** An intensity (tCO₂e per EUR of turnover). */
  intensity(value: string | null): string;
  /** A plain count — a count of nothing is a real `0`, not a withheld figure. */
  count(value: number): string;
  /** A money figure in EUR. */
  euro(value: string | null): string;
  /** A percentage, `0`–`100` as stored. */
  percent(value: string | null): string;
  /** An ISO date (`YYYY-MM-DD` or a timestamp), or the "not collected" words. */
  date(value: string | Date | null): string;
  /** An ISO timestamp down to the minute — the render's own stamp. */
  dateTime(value: string | Date | null): string;
  /** The words for a value the company has not recorded. */
  notCollected(): string;
  /** The words for a figure no completed calculation run published. */
  notCalculated(): string;
}

/** `Intl` formatters and the two withheld-value wordings, bound to one locale. */
export function renderContext(locale: ReportLanguage): RenderContext {
  const t = renderTranslator(locale);
  const decimal = (digits: number) =>
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    });
  const integer = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  });
  // UTC, always. A `date` column has no time zone, and rendering `2024-12-31`
  // through the server's local zone is how a period silently ends on the 30th.
  const day = new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeZone: "UTC",
  });
  const minute = new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  });

  const notCalculated = () => t("common.notCalculated");
  const notCollected = () => t("common.notCollected");

  const quantity = (
    value: string | null,
    unit: string,
    decimals = TONNE_PAGE_DECIMALS,
  ): string =>
    value === null
      ? notCalculated()
      : `${decimal(decimals).format(asNumericLiteral(value))} ${unit}`;

  return {
    locale,
    t,
    localeName: localeNames[locale],
    quantity,
    tonnes: (kilograms) =>
      quantity(
        kilograms === null ? null : kilogramsToTonnes(kilograms),
        t("units.tco2e"),
        TONNE_PAGE_DECIMALS,
      ),
    megawattHours: (value) =>
      quantity(value, t("units.mwh"), ENERGY_PAGE_DECIMALS),
    intensity: (value) =>
      quantity(value, t("units.intensity"), INTENSITY_PAGE_DECIMALS),
    count: (value) => integer.format(value),
    euro: (value) => quantity(value, t("units.eur"), 2),
    percent: (value) => quantity(value, "%", 2),
    date: (value) =>
      value === null ? notCollected() : day.format(asDate(value)),
    dateTime: (value) =>
      value === null ? notCollected() : minute.format(asDate(value)),
    notCollected,
    notCalculated,
  };
}

/**
 * A `numeric` column's value as `Intl.NumberFormat.format` will actually take it.
 *
 * `format` accepts a decimal STRING at runtime and reads it as a decimal rather
 * than a double — which is exactly why the figures travel as strings. Its
 * published type, however, admits only the template-literal type
 * `StringNumericLiteral`, and a value read out of Postgres is not statically one
 * of those. The narrowing happens HERE, once and with the reason attached,
 * instead of at each of the six call sites where it would look like sloppiness.
 */
type NumericLiteral = Parameters<Intl.NumberFormat["format"]>[0];

/** See {@link NumericLiteral}. */
function asNumericLiteral(value: string): NumericLiteral {
  return value as NumericLiteral;
}

/** A `date`/`timestamptz` column as a `Date`, whatever the driver handed back. */
function asDate(value: string | Date): Date {
  if (value instanceof Date) return value;
  // A bare `YYYY-MM-DD` parses as UTC midnight; a timestamp keeps its offset.
  return new Date(value);
}
