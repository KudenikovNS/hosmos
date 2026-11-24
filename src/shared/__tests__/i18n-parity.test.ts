// =============================================================================
// i18n parity — every interface locale carries every key English carries.
//
// Six locales since 10.09.2026. Two kinds of file:
//   • `messages/<locale>.json` — the app. English is the reference; the other
//     five must hold every key (a missing key is rendered as its raw path).
//     The REPORT namespaces exist only in the report languages (en, sl): the
//     renderer reads them from its own map, never through the request config,
//     and `report_render.language` is CHECK-constrained to the two.
//   • `messages/landing.<locale>.json` — the public page, same rule.
// A translation copied verbatim from English is caught for the namespaces the
// suite names — the cheap way to notice a "translation" that was a paste.
// =============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { locales, REPORT_LANGUAGES } from "@/i18n/locales";

const REPO_ROOT = path.resolve(__dirname, "../../..");

/** Namespaces that live only in the report languages (see the header). */
const REPORT_ONLY = ["render"] as const;

type Messages = Record<string, unknown>;

function load(file: string): Messages {
  return JSON.parse(
    readFileSync(path.join(REPO_ROOT, "messages", file), "utf8"),
  ) as Messages;
}

function flatten(node: unknown, prefix = ""): string[] {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(node as Messages).flatMap(([key, value]) =>
    flatten(value, prefix ? `${prefix}.${key}` : key),
  );
}

function flattenValues(node: unknown, prefix = ""): Record<string, string> {
  if (typeof node === "string") return prefix ? { [prefix]: node } : {};
  if (!node || typeof node !== "object" || Array.isArray(node)) return {};
  return Object.entries(node as Messages).reduce<Record<string, string>>(
    (acc, [key, value]) =>
      Object.assign(
        acc,
        flattenValues(value, prefix ? `${prefix}.${key}` : key),
      ),
    {},
  );
}

const missing = (a: readonly string[], b: readonly string[]): string[] =>
  a.filter((value) => !b.includes(value)).sort();

const namespaceOf = (key: string) => key.split(".")[0];

const others = locales.filter((l) => l !== "en");

describe.each(others)("i18n parity — app messages, %s", (locale) => {
  const isReport = (REPORT_LANGUAGES as readonly string[]).includes(locale);
  const enKeys = flatten(load("en.json")).filter(
    (key) =>
      isReport ||
      !(REPORT_ONLY as readonly string[]).includes(namespaceOf(key)),
  );
  const keys = flatten(load(`${locale}.json`));

  it("has every English key", () => {
    expect(missing(enKeys, keys)).toEqual([]);
  });

  it("has no key English does not have", () => {
    expect(missing(keys, flatten(load("en.json")))).toEqual([]);
  });

  it("has no empty message", () => {
    const blank = Object.entries(flattenValues(load(`${locale}.json`)))
      .filter(([, value]) => value.trim() === "")
      .map(([key]) => key);
    expect(blank).toEqual([]);
  });
});

describe.each(others)("i18n parity — landing, %s", (locale) => {
  const enKeys = flatten(load("landing.en.json"));
  const keys = flatten(load(`landing.${locale}.json`));
  it("mirrors the English landing file key for key", () => {
    expect(missing(enKeys, keys)).toEqual([]);
    expect(missing(keys, enKeys)).toEqual([]);
  });
});

describe.each([["terms", "terms.en.json", "terms.sl.json"]])(
  "i18n parity — %s (en/sl)",
  (_name, en, sl) => {
    it("is key-for-key identical", () => {
      expect(missing(flatten(load(en)), flatten(load(sl)))).toEqual([]);
      expect(missing(flatten(load(sl)), flatten(load(en)))).toEqual([]);
    });
  },
);

describe.each(others)("i18n — %s is translated, not pasted", (locale) => {
  const enValues = flattenValues(load("en.json"));
  const values = flattenValues(load(`${locale}.json`));
  // Namespaces whose strings are real sentences; a paste there is a bug.
  const keys = Object.keys(enValues).filter((key) =>
    ["organisation", "readiness", "settings", "dashboard"].includes(
      namespaceOf(key),
    ),
  );

  // A "sentence" has at least four plain words; unit strings such as
  // "t CO₂e / EUR" or "Scope 2 — location-based" are the same in every locale.
  const plainWords = (value: string) =>
    value.split(/\s+/).filter((word) => /^\p{L}{3,}$/u.test(word)).length;

  it("differs from English in the sentence namespaces", () => {
    const pasted = keys.filter(
      (key) =>
        key in values &&
        enValues[key] === values[key] &&
        plainWords(enValues[key]) > 3,
    );
    expect(pasted).toEqual([]);
  });
});
