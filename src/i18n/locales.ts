/**
 * The interface locales. `en` is the default (no URL prefix, `localePrefix:
 * "as-needed"`); every other locale lives under its prefix (`/sl/…`).
 *
 * Seven since 10.09.2026: English, Slovene, Russian, German, Italian, Serbian
 * (Cyrillic — `sr`, as CLDR defaults it) and Croatian. A locale whose message
 * file lacks a key falls back to
 * English at request time (`./request.ts`), so a translation can land
 * namespace by namespace without a missing key ever reaching the screen.
 */
export const locales = ["en", "sl", "ru", "de", "it", "sr", "hr"] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";

/** Native names, for switchers and `hreflang` titles. */
export const localeNames: Record<Locale, string> = {
  en: "English",
  sl: "Slovenščina",
  ru: "Русский",
  de: "Deutsch",
  it: "Italiano",
  sr: "Српски",
  hr: "Hrvatski",
};

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (locales as readonly string[]).includes(value)
  );
}

/**
 * The languages a REPORT can be rendered in (О-14). Narrower than the
 * interface locales on purpose: the report wording is the expert-approved
 * Slovene and English, `report_render.language` is CHECK-constrained to the
 * two, and the PDF fonts carry Latin only. The interface can be in Russian
 * while the report it produces is Slovene.
 */
export const REPORT_LANGUAGES = ["en", "sl"] as const;

export type ReportLanguage = (typeof REPORT_LANGUAGES)[number];

export function isReportLanguage(value: unknown): value is ReportLanguage {
  return (
    typeof value === "string" &&
    (REPORT_LANGUAGES as readonly string[]).includes(value)
  );
}

/** The report language a user of `locale` gets by default: Slovene stays Slovene, everything else English. */
export function reportLanguageFor(
  locale: string | null | undefined,
): ReportLanguage {
  return locale === "sl" ? "sl" : "en";
}
