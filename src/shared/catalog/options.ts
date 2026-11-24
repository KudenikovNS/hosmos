// =============================================================================
// THE CHOICES OF THE CHOICE-TYPE DATAPOINTS (партия 18).
//
// `metric_catalog` declares no option list for its `enum` / `multi_enum` rows:
// the choices live in the metric's prose («OPTION A: Basic либо OPTION B…»).
// Until this file the form therefore offered an empty text box for «Reporting
// option selected» and left the user to guess what to type — which is exactly
// what the pilot user could not do.
//
// These lists are the choices THE STANDARD ITSELF names in the datapoint's
// guidance (VSME §24(a), §24(c), guidance para. 68, paras. 228–230), not a
// domain invented here. The STORED value is the `value` string — the same free
// string the control wrote before, so a report reads it back unchanged and an
// answer typed before this file existed still loads (it shows under «Other»).
// Only the label is translated.
//
// `other: true` keeps a free-text escape where the standard's list is open
// (legal forms differ per country; a target may use any unit).
// =============================================================================

import otherLabels from "./option-labels.json";

const OTHER_LABELS = otherLabels as Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

interface MetricOption {
  readonly value: string;
  readonly label: {
    readonly en: string;
    readonly sl: string;
    readonly ru: string;
  };
}

export interface MetricChoices {
  readonly options: readonly MetricOption[];
  /** A free-text «Other» is offered beside the list. */
  readonly other: boolean;
}

const opt = (
  value: string,
  en: string,
  sl: string,
  ru: string,
): MetricOption => ({
  value,
  label: { en, sl, ru },
});

/**
 * The label in `locale`: English, Slovene and Russian sit beside each option;
 * German, Italian, Serbian and Croatian come from `option-labels.json`, keyed
 * by the stored value. A value missing there reads in English.
 */
function labelIn(option: MetricOption, locale: string): string {
  if (locale === "sl") return option.label.sl;
  if (locale === "ru") return option.label.ru;
  return OTHER_LABELS[locale]?.[option.value] ?? option.label.en;
}

/** The disclosure codes a B1 omission (VSME-002) may name. */
const DISCLOSURE_CODES = [
  "B2",
  "B3",
  "B4",
  "B5",
  "B6",
  "B7",
  "B8",
  "B9",
  "B10",
  "B11",
  "C1",
  "C2",
  "C3",
  "C4",
  "C5",
  "C6",
  "C7",
  "C8",
  "C9",
] as const;

export const METRIC_CHOICES: Readonly<Record<string, MetricChoices>> = {
  // §24(a) — the reporting option.
  "VSME-001": {
    other: false,
    options: [
      opt(
        "OPTION A: Basic Module",
        "Option A — Basic Module only",
        "Možnost A — samo osnovni modul",
        "Вариант A — только базовый модуль",
      ),
      opt(
        "OPTION B: Basic and Comprehensive Modules",
        "Option B — Basic and Comprehensive Modules",
        "Možnost B — osnovni in celoviti modul",
        "Вариант B — базовый и расширенный модули",
      ),
    ],
  },
  // §24(b) — which disclosures were omitted as classified or sensitive.
  "VSME-002": {
    other: false,
    options: DISCLOSURE_CODES.map((code) => opt(code, code, code, code)),
  },
  // §24(c) — individual or consolidated basis.
  "VSME-003": {
    other: false,
    options: [
      opt(
        "Individual basis",
        "Individual — the undertaking only",
        "Posamična — samo podjetje",
        "Индивидуальная — только компания",
      ),
      opt(
        "Consolidated basis",
        "Consolidated — the undertaking and its subsidiaries",
        "Konsolidirana — podjetje in njegove odvisne družbe",
        "Консолидированная — компания и её дочерние организации",
      ),
    ],
  },
  // Guidance para. 68 — the legal form under national law (Slovenian forms;
  // «Other» for any other country).
  "VSME-006": {
    other: true,
    options: [
      opt(
        "d.o.o. — družba z omejeno odgovornostjo",
        "d.o.o. — limited liability company",
        "d.o.o. — družba z omejeno odgovornostjo",
        "d.o.o. — общество с ограниченной ответственностью",
      ),
      opt(
        "d.d. — delniška družba",
        "d.d. — public limited company",
        "d.d. — delniška družba",
        "d.d. — акционерное общество",
      ),
      opt(
        "s.p. — samostojni podjetnik",
        "s.p. — sole trader",
        "s.p. — samostojni podjetnik",
        "s.p. — индивидуальный предприниматель",
      ),
      opt(
        "k.d. — komanditna družba",
        "k.d. — limited partnership",
        "k.d. — komanditna družba",
        "k.d. — коммандитное товарищество",
      ),
      opt(
        "d.n.o. — družba z neomejeno odgovornostjo",
        "d.n.o. — general partnership",
        "d.n.o. — družba z neomejeno odgovornostjo",
        "d.n.o. — полное товарищество",
      ),
      opt(
        "k.d.d. — komanditna delniška družba",
        "k.d.d. — partnership limited by shares",
        "k.d.d. — komanditna delniška družba",
        "k.d.d. — коммандитное товарищество на акциях",
      ),
      opt(
        "z.o.o. — zadruga",
        "z.o.o. — cooperative",
        "z.o.o. — zadruga",
        "z.o.o. — кооператив",
      ),
    ],
  },
  // Comprehensive guidance paras. 216–227 — the unit of an emissions target.
  "VSME-099": {
    other: true,
    options: [
      opt(
        "tCO2e",
        "tCO2e (absolute emissions)",
        "tCO2e (absolutne emisije)",
        "тCO2e (абсолютные выбросы)",
      ),
      opt(
        "% reduction vs base year",
        "% reduction against the base year",
        "% zmanjšanja glede na izhodiščno leto",
        "% сокращения относительно базового года",
      ),
      opt(
        "tCO2e per EUR revenue",
        "tCO2e per EUR of revenue (intensity)",
        "tCO2e na EUR prihodkov (intenzivnost)",
        "тCO2e на EUR выручки (интенсивность)",
      ),
    ],
  },
  // Comprehensive guidance paras. 228–230 — short-, medium- or long-term.
  "VSME-110": {
    other: false,
    options: [
      opt("Short term", "Short term", "Kratkoročno", "Краткосрочный"),
      opt("Medium term", "Medium term", "Srednjeročno", "Среднесрочный"),
      opt("Long term", "Long term", "Dolgoročno", "Долгосрочный"),
    ],
  },
  "VSME-113": {
    other: false,
    options: [
      opt("Low", "Low", "Nizka", "Низкий"),
      opt("Medium", "Medium", "Srednja", "Средний"),
      opt("High", "High", "Visoka", "Высокий"),
    ],
  },
};

/** A choice list with labels in `locale`. */
export function choicesFor(
  metricKey: string,
  locale: string,
): {
  options: { value: string; label: string }[];
  other: boolean;
} | null {
  const choices = METRIC_CHOICES[metricKey];
  if (!choices) return null;
  return {
    other: choices.other,
    options: choices.options.map((o) => ({
      value: o.value,
      label: labelIn(o, locale),
    })),
  };
}

/**
 * The label of a stored choice in `locale`, or null when `value` is not one of
 * the listed values (a typed «Other» answer prints as typed). The report uses
 * this so a Slovene report reads «Možnost A — samo osnovni modul», not the
 * stored code.
 */
export function choiceLabel(
  metricKey: string,
  value: string,
  locale: string,
): string | null {
  const hit = METRIC_CHOICES[metricKey]?.options.find((o) => o.value === value);
  if (!hit) return null;
  return labelIn(hit, locale);
}

/** Is `value` one of the list's stored values? */
export function isListed(metricKey: string, value: string): boolean {
  return (
    METRIC_CHOICES[metricKey]?.options.some((o) => o.value === value) ?? false
  );
}
