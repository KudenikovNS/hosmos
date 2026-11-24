/**
 * Партия 18 — every catalogue row, in every UI locale, reads in that locale's
 * words: a label always, a «what to enter» hint for every VSME datapoint, the
 * standard's guidance in Slovene, and NO Russian outside the Russian UI (the
 * pilot user read «Velja, kadar: Всегда» in a Slovene form).
 */
import { describe, expect, it } from "vitest";

import esrsRows from "@/server/db/seed-data/esrs-metrics.json";
import vsmeExtras from "@/server/db/seed-data/vsme-metrics.esrs.json";
import vsmeRows from "@/server/db/seed-data/vsme-metrics.json";
import slTitles from "@/server/db/seed-data/vsme-metrics.sl.json";
import { locales as LOCALES } from "@/i18n/locales";

import {
  conditionTexts,
  latinOnly,
  metricText,
  type MetricTextSource,
} from "../metric-text";

const CYRILLIC = /[Ѐ-ӿ]/;
/** Letters Russian has and Serbian Cyrillic does not. */
const RUSSIAN_ONLY = /[ыэъьёйщюяЫЭЪЬЁЙЩЮЯ]/;
/** The UI languages with their own catalogue texts (all but English). */
const TRANSLATED = LOCALES.filter((l) => l !== "en");

type Row = Record<string, unknown>;
const extras = vsmeExtras as Record<string, Row>;
const titles = slTitles as Record<string, string>;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const toSource = (row: Row): MetricTextSource => {
  const key = row.metric_key as string;
  return {
    metric_key: key,
    title: row.title as string,
    title_en: str(row.title_en),
    title_sl: titles[key] ?? null,
    disclosure_title: str(row.disclosure_title),
    disclosure_title_en: str(row.disclosure_title_en),
    disclosure_title_sl: null,
    description: str(row.description),
    applicability_condition: str(row.applicability_condition),
    guidance: str(row.guidance),
    client_data_source:
      str(row.client_data_source) ?? str(extras[key]?.client_data_source),
    disclosure_code: str(row.disclosure_code),
    unit: str(row.unit),
  };
};

/**
 * A run of three or more Latin words — an English phrase rather than a term.
 * Codes and terms the Russian text keeps (Scope 3, GHG Protocol, OPTION A,
 * NACE, tCO2e, ESRS S4) are at most two words in a row.
 */
const ENGLISH_PHRASE = /[A-Za-z][A-Za-z.-]*(?:[\s/]+[A-Za-z][A-Za-z.-]*){2,}/;

const VSME = (vsmeRows as Row[]).map(toSource);
const ESRS = (esrsRows as Row[]).map(toSource);
const ALL = [...VSME, ...ESRS];

describe("metricText — the catalogue in the reader's language", () => {
  it("covers all 191 catalogue rows", () => {
    expect(VSME).toHaveLength(141);
    expect(ESRS).toHaveLength(50);
  });

  it.each(LOCALES.filter((l) => l !== "ru"))(
    "prints no Russian anywhere in the %s UI",
    (locale) => {
      for (const metric of ALL) {
        const text = metricText(metric, locale);
        // Serbian is written in Cyrillic; what must not appear there is the
        // Russian alphabet's own letters, i.e. the catalogue's Russian text.
        const russian = locale === "sr" ? RUSSIAN_ONLY : CYRILLIC;
        for (const [field, value] of Object.entries(text)) {
          expect(
            value === null || !russian.test(value),
            `${metric.metric_key}.${field} in ${locale}: ${value}`,
          ).toBe(true);
        }
      }
    },
  );

  it.each(LOCALES)("gives every row a label in %s", (locale) => {
    for (const metric of ALL)
      expect(metricText(metric, locale).label.trim()).not.toBe("");
  });

  it("gives every VSME datapoint a Slovene hint and Slovene guidance", () => {
    for (const metric of VSME) {
      const sl = metricText(metric, "sl");
      const en = metricText(metric, "en");
      expect(sl.hint, metric.metric_key).toBeTruthy();
      expect(sl.guidance, metric.metric_key).toBeTruthy();
      // Written for Slovene, not the English falling through.
      expect(sl.hint, metric.metric_key).not.toBe(en.hint);
      expect(sl.guidance, metric.metric_key).not.toBe(en.guidance);
      expect(sl.label).toBe(metric.title_sl);
    }
  });

  // The pilot user switched the form to Russian and read ESRS S4-1 in English:
  // the 50 ESRS rows, the guidance and the data sources had no Russian at all.
  it("prints no English in the Russian UI", () => {
    for (const metric of ALL) {
      const text = metricText(metric, "ru");
      for (const field of [
        "label",
        "disclosure",
        "hint",
        "guidance",
        "applies_when",
        "data_source",
      ] as const) {
        const value = text[field];
        if (value === null) continue;
        const where = `${metric.metric_key}.${field}: ${value}`;
        expect(CYRILLIC.test(value), where).toBe(true);
        // Parentheses hold the standard's own name for a term, as a reference.
        const prose = value.replace(/\([^)]*\)/g, "");
        expect(ENGLISH_PHRASE.test(prose), where).toBe(false);
      }
    }
  });

  it("gives every VSME datapoint a Russian hint and Russian guidance", () => {
    for (const metric of VSME) {
      const ru = metricText(metric, "ru");
      expect(ru.hint, metric.metric_key).toBeTruthy();
      expect(ru.guidance, metric.metric_key).toBeTruthy();
    }
  });

  it("names every section in Russian once, without the English half", () => {
    for (const metric of ALL) {
      const disclosure = metricText(metric, "ru").disclosure ?? "";
      expect(disclosure, metric.metric_key).not.toMatch(/ \/ [A-Za-z]/);
    }
  });

  it("translates every worded unit into Russian and Slovene", () => {
    // Symbols and codes stay as they are: %, EUR, FTE, tCO2e, MWh, ha, kg, m3.
    const words = (unit: string) =>
      unit
        .replace(/\b(EUR|FTE|MWh|t?CO2e|ha|kg|m3)\b/g, "")
        .match(/[A-Za-z]{3,}/g);
    for (const metric of ALL) {
      if (!metric.unit || !words(metric.unit)) continue;
      const ru = metricText(metric, "ru").unit ?? "";
      const sl = metricText(metric, "sl").unit ?? "";
      expect(words(ru), `${metric.metric_key} ru: ${ru}`).toBeNull();
      expect(sl, `${metric.metric_key} sl`).not.toBe(metric.unit);
    }
  });

  // «Нужно поправить для всех языков»: every UI language reads its own words
  // for every datapoint, not the English falling through.
  it.each(TRANSLATED)("translates every catalogue text into %s", (locale) => {
    // Strings that are genuinely the same word in that language.
    const SAME = new Set(["Optional"]);
    for (const metric of ALL) {
      const text = metricText(metric, locale);
      const en = metricText(metric, "en");
      for (const field of [
        "label",
        "disclosure",
        "hint",
        "guidance",
        "applies_when",
        "data_source",
      ] as const) {
        const value = text[field];
        if (en[field] === null) continue;
        const where = `${metric.metric_key}.${field} in ${locale}: ${value}`;
        expect(value, where).toBeTruthy();
        if (!SAME.has(value!)) expect(value, where).not.toBe(en[field]);
      }
    }
  });

  it("writes Serbian in Cyrillic, keeping only codes and terms in Latin", () => {
    // Codes and international terms: anything with a digit or two capitals
    // (tCO2e, B2, NACE, EUR, NOx, SoC) and a few named terms.
    const TERM = /^(Scope|Protocol|OPTION|A|B|EU|Ecolabel|Gold|phase-in)$/;
    for (const metric of ALL) {
      const text = metricText(metric, "sr");
      for (const value of Object.values(text)) {
        for (const word of value?.match(/[A-Za-z][A-Za-z0-9.-]*/g) ?? []) {
          const core = word.replace(/[.-]+$/, "");
          const isTerm =
            TERM.test(core) ||
            /\d/.test(core) ||
            (core.match(/[A-Z]/g) ?? []).length >= 2;
          expect(isTerm, `${metric.metric_key}: ${word} in ${value}`).toBe(
            true,
          );
        }
      }
    }
  });

  it("gives every VSME datapoint an English hint", () => {
    for (const metric of VSME)
      expect(metricText(metric, "en").hint, metric.metric_key).toBeTruthy();
  });

  it("translates every applicability condition the catalogue uses", () => {
    for (const metric of ALL) {
      if (!metric.applicability_condition) continue;
      for (const locale of ["en", "sl", "ru"])
        expect(
          metricText(metric, locale).applies_when,
          `${metric.metric_key} ${locale}`,
        ).toBeTruthy();
    }
  });

  it("reads «Всегда» as Vedno / Always / Всегда", () => {
    const always = VSME.find((m) => m.applicability_condition === "Всегда")!;
    expect(metricText(always, "sl").applies_when).toBe("Vedno");
    expect(metricText(always, "en").applies_when).toBe("Always");
    expect(metricText(always, "ru").applies_when).toBe("Всегда");
    expect(conditionTexts("Всегда")).toEqual({
      en: "Always",
      sl: "Vedno",
      ru: "Всегда",
      de: "Immer",
      it: "Sempre",
      sr: "Увек",
      hr: "Uvijek",
    });
  });

  it("names the reporting option in Slovene", () => {
    const option = VSME.find((m) => m.metric_key === "VSME-001")!;
    const sl = metricText(option, "sl");
    expect(sl.label).toBe("Izbrana možnost poročanja");
    expect(sl.hint).toMatch(/OPTION A/);
    expect(sl.hint).toMatch(/OPTION B/);
  });

  it("reads a mixed Russian condition as plain Russian", () => {
    const raw = "Если выбран Comprehensive; actions если incidents=Yes";
    expect(conditionTexts(raw)?.ru).toBe(
      "Если выбран расширенный модуль; меры — если были инциденты",
    );
    const esrs = ESRS.find((m) => m.metric_key === "ESRS-042")!;
    const ru = metricText(esrs, "ru");
    expect(ru.disclosure).toBe(
      "ESRS S4 — Политики в отношении потребителей и конечных пользователей",
    );
    expect(ru.applies_when).toBe(
      "Если тема потребителей и конечных пользователей существенна",
    );
  });

  it("latinOnly drops Cyrillic and blanks, keeps everything else", () => {
    expect(latinOnly("Всегда")).toBeNull();
    expect(latinOnly("  ")).toBeNull();
    expect(latinOnly(null)).toBeNull();
    expect(latinOnly(" If applied ")).toBe("If applied");
  });
});
