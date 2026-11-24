// =============================================================================
// `reports.*` PARITY AND COMPLETENESS (T5.8 acceptance — "i18n parity of
// `reports.*`").
//
// WHY A SUITE OF ITS OWN WHEN `shared/__tests__/i18n-parity.test.ts` ALREADY
// COMPARES THE WHOLE FILE. That test proves the two files carry the same KEYS,
// which is necessary and not sufficient for this screen. `/reports` renders five
// closed vocabularies straight off the wire — revision statuses, render formats,
// render languages, REN-3 gate reasons, D14 coverage claims and the kinds of
// record a plan can exclude — and each is looked up with a `t.has()` fallback to
// the raw token, so a missing key does not fail: it silently prints
// `period_blocking_errors` or `legal_entity` at a user. Both locales would do it
// identically, and whole-file parity would stay green. So the vocabularies are
// checked against their SOURCE lists here, which is the only place that can
// catch it.
//
// AND ONE VALUE CHECK. An English string copy-pasted into `sl.json` passes any
// key-set test while being, to a Slovenian user, exactly the untranslated string
// the check exists to prevent. The allowlist below is for the handful of tokens
// that are legitimately identical in both locales (file-format names and a
// digest algorithm), and it is a list of exact KEYS rather than a heuristic, so
// adding to it is a deliberate act.
// =============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { REPORT_LANGUAGES } from "@/i18n/locales";
import { WORKFLOW_STATUSES } from "@/shared/enums";
import {
  COVERAGE_CLAIMS,
  PLAN_EXCLUSION_TYPES,
  RENDER_FORMATS,
  RENDER_GATE_REASONS,
} from "@/shared/reports";

import { REVISION_BLOCK_REASONS } from "../wizard";

const REPO_ROOT = path.resolve(__dirname, "../../../../../../..");

/**
 * Keys whose Slovenian value is legitimately the English one: file-format names
 * and the digest label. `PDF` and `Excel (XLSX)` are product names in both
 * locales, and `SHA-256 {hash}` is an algorithm plus a placeholder.
 */
const IDENTICAL_BY_DESIGN = [
  "reports.formats.pdf",
  "reports.formats.xlsx",
  "reports.renders.hash",
];

type Messages = Record<string, unknown>;

function load(locale: string): Messages {
  return JSON.parse(
    readFileSync(path.join(REPO_ROOT, "messages", `${locale}.json`), "utf8"),
  ) as Messages;
}

/** Every leaf VALUE of a message tree, by dotted key (strings only). */
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

const en = flattenValues(load("en"));
const sl = flattenValues(load("sl"));
const reportKeys = Object.keys(en).filter((key) => key.startsWith("reports."));

describe("reports.* parity", () => {
  it("exists at all", () => {
    expect(reportKeys.length).toBeGreaterThan(0);
  });

  it("has no key that exists only in English", () => {
    expect(reportKeys.filter((key) => !(key in sl))).toEqual([]);
  });

  it("has no key that exists only in Slovenian", () => {
    const slReports = Object.keys(sl).filter((key) =>
      key.startsWith("reports."),
    );
    expect(slReports.filter((key) => !(key in en))).toEqual([]);
  });

  it("has no empty message in either locale", () => {
    expect(reportKeys.filter((key) => en[key].trim() === "")).toEqual([]);
    expect(reportKeys.filter((key) => (sl[key] ?? "").trim() === "")).toEqual(
      [],
    );
  });

  it("has no Slovenian value copied verbatim from the English one", () => {
    const copied = reportKeys.filter(
      (key) => en[key] === sl[key] && !IDENTICAL_BY_DESIGN.includes(key),
    );
    expect(copied).toEqual([]);
  });

  it("labels the navigation entry in both locales", () => {
    expect(en["nav.reports"]).toBeTruthy();
    expect(sl["nav.reports"]).toBeTruthy();
    expect(en["nav.reports"]).not.toBe(sl["nav.reports"]);
  });
});

describe("reports.* completeness — no wire token can reach a user", () => {
  const bothHave = (keys: readonly string[]) =>
    keys.filter((key) => !(key in en) || !(key in sl));

  it("names every revision status the picker can list (§5.1)", () => {
    expect(
      bothHave(
        WORKFLOW_STATUSES.map((status) => `reports.revisionStatus.${status}`),
      ),
    ).toEqual([]);
  });

  it("names every format this product can produce (К-22)", () => {
    expect(
      bothHave(RENDER_FORMATS.map((format) => `reports.formats.${format}`)),
    ).toEqual([]);
  });

  it("names every language a render can be made in (О-14)", () => {
    expect(
      bothHave(REPORT_LANGUAGES.map((lang) => `reports.languages.${lang}`)),
    ).toEqual([]);
  });

  it("explains every REN-3 refusal the gate can produce", () => {
    expect(
      bothHave(RENDER_GATE_REASONS.map((reason) => `reports.gate.${reason}`)),
    ).toEqual([]);
  });

  it("explains every reason the picker can block a revision for", () => {
    expect(
      bothHave(
        REVISION_BLOCK_REASONS.map(
          (reason) => `reports.scope.blocked.${reason}`,
        ),
      ),
    ).toEqual([]);
  });

  it("names both D14 coverage claims", () => {
    expect(
      bothHave(COVERAGE_CLAIMS.map((claim) => `reports.coverage.${claim}`)),
    ).toEqual([]);
  });

  it("names every kind of record a plan can exclude (REN-4)", () => {
    expect(
      bothHave(
        PLAN_EXCLUSION_TYPES.map((type) => `reports.objectType.${type}`),
      ),
    ).toEqual([]);
  });
});

describe("reports.* says the things T5.8 is about", () => {
  // The F1 sentence is an acceptance criterion in words, not only in code: it
  // has to carry BOTH numbers and the plan, or it is the unactionable refusal
  // the task exists to eliminate ("a report with 4 sites cannot be closed on
  // Starter — an upgrade is needed").
  it("words the F1 warning with the count, the limit and the plan", () => {
    for (const messages of [en, sl]) {
      const body = messages["reports.lock.body"];
      expect(body).toContain("{facilities}");
      expect(body).toContain("{limit}");
      expect(body).toContain("{plan}");
    }
  });

  it("states that the report language is frozen onto the file (О-14)", () => {
    for (const messages of [en, sl]) {
      expect(messages["reports.output.languageHint"].length).toBeGreaterThan(
        40,
      );
    }
  });
});
