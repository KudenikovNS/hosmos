// =============================================================================
// `review.*` PARITY AND COMPLETENESS (T4.6 acceptance — "i18n parity of
// `review.*` between `en` and `sl`").
//
// WHY A SUITE OF ITS OWN WHEN `shared/__tests__/i18n-parity.test.ts` ALREADY
// COMPARES THE WHOLE FILE. That test proves the two files carry the same KEYS,
// which is necessary and not sufficient for this screen. `/review` renders four
// closed vocabularies straight off the wire — revision statuses, the §5.1 wire
// actions, the validation scopes and the object types a rule can be about — and
// each is looked up with a `t.has()` fallback to the raw token, so a missing key
// does not fail: it silently prints `in_review` or `purchased_energy_activity`
// at a user. Both locales would do it identically, and whole-file parity would
// stay green. So the vocabularies are checked against their SOURCE lists here,
// which is the only place that can catch it.
//
// AND ONE VALUE CHECK. An English string copy-pasted into `sl.json` passes any
// key-set test while being, to a Slovenian user, exactly the untranslated string
// the check exists to prevent. The allowlist below is for the handful of tokens
// that are legitimately identical in both locales (product names and acronyms),
// and it is a list of exact KEYS rather than a heuristic, so adding to it is a
// deliberate act.
// =============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { WORKFLOW_STATUSES } from "@/shared/enums";

import { INPUT_TABLE_NAMES } from "../api";
import { OBJECT_SCREEN } from "../blocking";
import { WIRE_ACTIONS } from "../transitions";
import { TIMELINE_STEPS } from "../timeline";

const REPO_ROOT = path.resolve(__dirname, "../../../../../../..");

/** The `validation_result.scope` vocabulary (VALIDATION_SCOPES, §6.1). */
const VALIDATION_SCOPES = ["record", "revision", "period", "reference_org"];

/**
 * Keys whose Slovenian value is legitimately the English one: acronyms and
 * product names that are not translated in either locale (`/evidence` carries
 * the same value for the same key).
 */
const IDENTICAL_BY_DESIGN = ["review.enums.kind.REGO"];

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
const reviewKeys = Object.keys(en).filter((key) => key.startsWith("review."));

describe("review.* parity", () => {
  it("exists at all", () => {
    expect(reviewKeys.length).toBeGreaterThan(0);
  });

  it("has no key that exists only in English", () => {
    expect(reviewKeys.filter((key) => !(key in sl))).toEqual([]);
  });

  it("has no key that exists only in Slovenian", () => {
    const slReview = Object.keys(sl).filter((key) => key.startsWith("review."));
    expect(slReview.filter((key) => !(key in en))).toEqual([]);
  });

  it("has no empty message in either locale", () => {
    expect(reviewKeys.filter((key) => en[key].trim() === "")).toEqual([]);
    expect(reviewKeys.filter((key) => (sl[key] ?? "").trim() === "")).toEqual(
      [],
    );
  });

  it("has no Slovenian value copied verbatim from the English one", () => {
    const copied = reviewKeys.filter(
      (key) => en[key] === sl[key] && !IDENTICAL_BY_DESIGN.includes(key),
    );
    expect(copied).toEqual([]);
  });

  it("labels the navigation entry in both locales", () => {
    expect(en["nav.review"]).toBeTruthy();
    expect(sl["nav.review"]).toBeTruthy();
    expect(en["nav.review"]).not.toBe(sl["nav.review"]);
  });
});

describe("review.* completeness — no wire token can reach a user", () => {
  const bothHave = (keys: readonly string[]) =>
    keys.filter((key) => !(key in en) || !(key in sl));

  it("names every revision status (§5.1)", () => {
    expect(
      bothHave(
        WORKFLOW_STATUSES.map((status) => `review.revisionStatus.${status}`),
      ),
    ).toEqual([]);
  });

  it("names every wire action of the machine (§12.2)", () => {
    expect(
      bothHave(WIRE_ACTIONS.map((action) => `review.actions.${action}`)),
    ).toEqual([]);
  });

  it("names every step of the status timeline", () => {
    expect(
      bothHave(TIMELINE_STEPS.map((step) => `review.timeline.steps.${step}`)),
    ).toEqual([]);
  });

  it("names every validation scope a blocking rule can carry (§6.1)", () => {
    expect(
      bothHave(VALIDATION_SCOPES.map((scope) => `review.enums.scope.${scope}`)),
    ).toEqual([]);
  });

  it("names every object type a rule can point at", () => {
    const types = [...Object.keys(OBJECT_SCREEN), "report_revision"];
    expect(
      bothHave(types.map((type) => `review.enums.objectType.${type}`)),
    ).toEqual([]);
  });

  it("names every input table the queue can list (К-8)", () => {
    expect(
      bothHave(
        INPUT_TABLE_NAMES.map((table) => `review.enums.sourceTable.${table}`),
      ),
    ).toEqual([]);
  });
});
