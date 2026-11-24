/**
 * THE CATALOGUE'S TEXT IN THE READER'S LANGUAGE (партия 18).
 *
 * The seeded catalogue (`seed-data/vsme-metrics.json`, 0004) was written for the
 * methodologist, not for the person filling the form: titles in Russian and
 * English, the applicability condition in Russian («Всегда»), a Russian or
 * mixed hint («OPTION A: Basic либо OPTION B…») and the standard's completion
 * instruction in English. The disclosure form printed all of it verbatim, so a
 * Slovene user read «Velja, kadar: Всегда» above an empty box with nothing to
 * say what belongs in it. The report already spoke Slovene (`title_sl`, 0017);
 * the form never did.
 *
 * This module is the one place that turns a catalogue row into the words a user
 * reads, per locale:
 *
 *   label        the datapoint's name — `title_sl` in Slovene, the Russian
 *                text file (then `title`) in Russian, `title_en` elsewhere;
 *   hint         WHAT TO ENTER, one or two imperative sentences written for
 *                this screen (`texts/metrics.{en,sl,ru}.json`);
 *   guidance     the standard's own completion instruction — translated in
 *                Slovene and Russian, the English original elsewhere;
 *   applies_when the applicability condition (`texts/conditions.json`);
 *   data_source  where a client usually finds the data (`texts/sources.json`).
 *
 * THE ONE RULE: no Russian outside the Russian UI. Every fallback that reaches
 * for a raw catalogue string passes `latinOnly`, so a row nobody translated yet
 * shows its English, or nothing — never «Всегда» in a Slovene form. The test
 * `catalog-text.test.ts` sweeps all 191 rows in every locale to hold that.
 *
 * AND ITS MIRROR: no English in a translated UI. The catalogue's «Russian»
 * columns are only partly Russian — the 50 ESRS rows are English, VSME titles
 * mix in English terms («Политика охватывает child labour»), the section titles
 * are bilingual («Основа подготовки отчёта / Basis for preparation») and the
 * standard's guidance exists in English only. So every UI language reads from
 * its own text files — `texts/metrics.<locale>.json` (label, hint, guidance),
 * `texts/disclosures.<locale>.json` (section titles), the `<locale>` of
 * conditions, sources and units — and the raw columns are only a fallback.
 * Slovene keeps `title_sl` (0017) as the VSME label; its files carry the rest,
 * including the ESRS rows that column never covered.
 * Serbian is written in Cyrillic, like the rest of the Serbian UI, with codes
 * and international terms (Scope 3, NACE, tCO2e) in Latin.
 *
 * `unit` is the catalogue's unit, translated where it is a word («Narrative»,
 * «mass unit»); symbols (%, EUR, FTE) read the same in every language.
 *
 * Nothing here touches the database or the stored values; the catalogue rows
 * and the report are unchanged. Additive only.
 */
import conditions from "./texts/conditions.json";
import disclosuresDe from "./texts/disclosures.de.json";
import disclosuresHr from "./texts/disclosures.hr.json";
import disclosuresIt from "./texts/disclosures.it.json";
import disclosuresRu from "./texts/disclosures.ru.json";
import disclosuresSl from "./texts/disclosures.sl.json";
import disclosuresSr from "./texts/disclosures.sr.json";
import metricsDe from "./texts/metrics.de.json";
import metricsEn from "./texts/metrics.en.json";
import metricsHr from "./texts/metrics.hr.json";
import metricsIt from "./texts/metrics.it.json";
import metricsRu from "./texts/metrics.ru.json";
import metricsSl from "./texts/metrics.sl.json";
import metricsSr from "./texts/metrics.sr.json";
import sources from "./texts/sources.json";
import units from "./texts/units.json";

/** The catalogue fields this module reads (a subset of `MetricDto`). */
export interface MetricTextSource {
  metric_key: string;
  title: string;
  title_en: string | null;
  title_sl: string | null;
  disclosure_title: string | null;
  disclosure_title_en: string | null;
  disclosure_title_sl: string | null;
  description: string | null;
  applicability_condition: string | null;
  guidance: string | null;
  client_data_source: string | null;
  /** The section the row belongs to — keys `texts/disclosures.<locale>.json`. */
  disclosure_code?: string | null;
  unit?: string | null;
}

/** What the form prints for one datapoint, already in the reader's language. */
export interface MetricText {
  label: string;
  disclosure: string | null;
  hint: string | null;
  guidance: string | null;
  applies_when: string | null;
  data_source: string | null;
  unit: string | null;
}

type PerMetric = Record<
  string,
  { label?: string; hint?: string; guidance?: string }
>;
/** One catalogue string in the UI languages that translate it. */
type ByLocale = Partial<Record<string, string>>;

/** The per-datapoint texts of every UI language except English. */
const METRICS: Readonly<Record<string, PerMetric>> = {
  sl: metricsSl,
  ru: metricsRu,
  de: metricsDe,
  it: metricsIt,
  sr: metricsSr,
  hr: metricsHr,
};
const DISCLOSURES: Readonly<Record<string, Record<string, string>>> = {
  sl: disclosuresSl,
  ru: disclosuresRu,
  de: disclosuresDe,
  it: disclosuresIt,
  sr: disclosuresSr,
  hr: disclosuresHr,
};
const EN = metricsEn as PerMetric;
const CONDITIONS = conditions as Record<string, ByLocale & { en: string }>;
const SOURCES = sources as Record<string, ByLocale>;
const UNITS = units as Record<string, ByLocale>;

/** The catalogue unit in `locale`: translated where it is a word. */
function unitText(
  unit: string | null | undefined,
  locale: string,
): string | null {
  const raw = nonEmpty(unit);
  if (!raw) return null;
  return UNITS[raw]?.[locale] ?? raw;
}

const CYRILLIC = /[Ѐ-ӿ]/;

/** A raw catalogue string, or null when it carries Cyrillic (i.e. Russian). */
export function latinOnly(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "" || CYRILLIC.test(trimmed)) return null;
  return trimmed;
}

const nonEmpty = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.trim() === ""
    ? null
    : value.trim();

/**
 * The words the form prints for `metric` in `locale`. A locale without text
 * files (none today) reads as English, never as the Russian catalogue columns.
 */
export function metricText(
  metric: MetricTextSource,
  locale: string,
): MetricText {
  const key = metric.metric_key;
  const raw = metric.applicability_condition;
  const condition = raw ? CONDITIONS[raw] : undefined;
  const source = metric.client_data_source;
  const code = metric.disclosure_code;
  const englishLabel =
    nonEmpty(metric.title_en) ?? latinOnly(metric.title) ?? key;
  const englishHint = nonEmpty(EN[key]?.hint) ?? latinOnly(metric.description);
  const own = METRICS[locale]?.[key];
  const ownDisclosure = code ? nonEmpty(DISCLOSURES[locale]?.[code]) : null;

  if (locale === "ru") {
    // The catalogue's own columns are Russian (if not always purely), so they
    // stay the fallback here — and only here.
    return {
      label: nonEmpty(own?.label) ?? nonEmpty(metric.title) ?? englishLabel,
      disclosure:
        ownDisclosure ??
        nonEmpty(metric.disclosure_title) ??
        nonEmpty(metric.disclosure_title_en),
      hint: nonEmpty(own?.hint) ?? nonEmpty(metric.description) ?? englishHint,
      guidance: nonEmpty(own?.guidance) ?? nonEmpty(metric.guidance),
      applies_when: condition?.ru ?? nonEmpty(raw),
      data_source: (source ? SOURCES[source]?.ru : null) ?? nonEmpty(source),
      unit: unitText(metric.unit, locale),
    };
  }

  const sl = locale === "sl";
  return {
    label:
      nonEmpty(own?.label) ??
      (sl ? nonEmpty(metric.title_sl) : null) ??
      englishLabel,
    disclosure:
      ownDisclosure ??
      (sl ? nonEmpty(metric.disclosure_title_sl) : null) ??
      nonEmpty(metric.disclosure_title_en),
    hint: nonEmpty(own?.hint) ?? englishHint,
    guidance: nonEmpty(own?.guidance) ?? latinOnly(metric.guidance),
    applies_when: condition?.[locale] ?? condition?.en ?? latinOnly(raw),
    data_source:
      (source ? SOURCES[source]?.[locale] : null) ?? latinOnly(source),
    unit: unitText(metric.unit, locale),
  };
}

/** One applicability condition per UI language (`conditionTexts`). */
export type ConditionTexts = Record<string, string | null>;

/**
 * One applicability condition in every UI language — for screens (Readiness)
 * that ship the whole catalogue once and pick the language in the browser.
 * A language without a translation reads the English, never the Russian raw
 * string; only `ru` falls back to the catalogue original.
 */
export function conditionTexts(raw: string | null): ConditionTexts | null {
  if (raw === null || raw.trim() === "") return null;
  const known = CONDITIONS[raw];
  const english = known?.en ?? latinOnly(raw);
  const texts: ConditionTexts = { en: english, ru: known?.ru ?? raw };
  for (const locale of Object.keys(METRICS))
    if (locale !== "ru") texts[locale] = known?.[locale] ?? english;
  return texts;
}
