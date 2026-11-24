// =============================================================================
// `/inventory/scope-3` READS THE REFUSAL THE SERVER SENDS — and says it in both
// locales.
//
// The route's own suite proves the WIRE (a 422 that carries `NO_SPEND_FACTORS`
// and the set in force, a GET that carries the same payload as `spendRefusal`).
// What it cannot prove is the half that lives in the browser, and that half has
// exactly three ways to fail silently:
//
//   1. THE TOKEN IS SPELLED TWICE. The server owns the constant; the client
//      cannot import it (`server-only`), so it re-declares the literal. A typo
//      in either one produces no error anywhere — the screen would simply fall
//      through to the generic "failed to save" it shows for a network blip, and
//      every other test would stay green. So both are imported here and compared.
//   2. THE SENTENCE IS KEYED BUT NOT WRITTEN. `t.has(...)` falls back rather than
//      throwing, and whole-file i18n parity only proves the two locales have the
//      SAME keys — two missing keys are still parity. The keys are therefore
//      checked against this file, and the Slovenian values against the English
//      ones (a copied value is an untranslated one).
//   3. THE BRANCH FIRES ON THE WRONG REFUSAL. `unpriceableSpend` decides whether
//      an editor is replaced by an explanation; a 403 or a plan gate must not
//      trigger it, and neither must a DIFFERENT named refusal.
//
// No DB and no React: these are pure functions and a pair of JSON files.
// =============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

// The server module is a plain `const` behind a `server-only` guard — stubbed
// the way every suite in this repository stubs it. Importing it is the point:
// a literal re-typed on the client side is exactly what this file exists to
// catch, and a copy of the token here would catch nothing.
vi.mock("server-only", () => ({}));

import { NO_SPEND_FACTORS as SERVER_TOKEN } from "@/server/scope3/factors";

import {
  classifyRefusal,
  NO_SPEND_FACTORS,
  spendRefusalOf,
  unpriceableSpend,
  type SpendView,
} from "../api";

const REPO_ROOT = path.resolve(__dirname, "../../../../../../../..");

/** Every leaf VALUE by dotted key — the shape `i18n-parity` flattens. */
function flatten(node: unknown, prefix = ""): Record<string, string> {
  if (typeof node === "string") return prefix ? { [prefix]: node } : {};
  if (!node || typeof node !== "object" || Array.isArray(node)) return {};
  return Object.entries(node as Record<string, unknown>).reduce<
    Record<string, string>
  >(
    (acc, [key, value]) =>
      Object.assign(acc, flatten(value, prefix ? `${prefix}.${key}` : key)),
    {},
  );
}

function load(locale: string): Record<string, string> {
  return flatten(
    JSON.parse(
      readFileSync(path.join(REPO_ROOT, "messages", `${locale}.json`), "utf8"),
    ),
  );
}

/** A GET body in the state 0011 leaves behind. */
const unpriceableView = (
  factorSet: { code: string; name: string } | null = {
    code: "si-2025",
    name: "Slovenia 2025",
  },
): SpendView => ({
  year: "2024",
  lines: [],
  commodities: [],
  currencies: [],
  defaultCurrency: "EUR",
  warnings: [],
  spendRefusal: { refusal: NO_SPEND_FACTORS, factor_set: factorSet },
});

describe("the spend refusal, as the screen reads it", () => {
  it("spells the token exactly as the server sends it", () => {
    expect(NO_SPEND_FACTORS).toBe(SERVER_TOKEN);
  });

  it("classifies the GET payload as a NAMED refusal, through the shared classifier", () => {
    const refusal = spendRefusalOf(unpriceableView());
    expect(refusal).toEqual({
      kind: "refused",
      refusal: "NO_SPEND_FACTORS",
      detail: {
        error: "VALIDATION",
        refusal: "NO_SPEND_FACTORS",
        factor_set: { code: "si-2025", name: "Slovenia 2025" },
      },
    });
    // …and the set travels with it, so the sentence can name it.
    expect(unpriceableSpend(refusal)).toEqual({
      factorSet: { code: "si-2025", name: "Slovenia 2025" },
    });
  });

  it("is silent on an ordinary read — the editor is not replaced by an explanation", () => {
    const view = { ...unpriceableView(), spendRefusal: null };
    expect(spendRefusalOf(view)).toBeNull();
    expect(unpriceableSpend(null)).toBeNull();
  });

  it("reads the POST's 422 body the same way it reads the GET's", () => {
    const refusal = classifyRefusal({
      error: "VALIDATION",
      refusal: "NO_SPEND_FACTORS",
      factor_set: { code: "si-2025", name: "Slovenia 2025" },
    });
    expect(unpriceableSpend(refusal)).toEqual({
      factorSet: { code: "si-2025", name: "Slovenia 2025" },
    });
  });

  it("does not fire on any other refusal", () => {
    expect(unpriceableSpend({ kind: "access_changed" })).toBeNull();
    expect(unpriceableSpend({ kind: "plan_required" })).toBeNull();
    expect(unpriceableSpend({ kind: "rejected" })).toBeNull();
    expect(
      unpriceableSpend({ kind: "field", field: "spendAmount" }),
    ).toBeNull();
    expect(
      unpriceableSpend(
        classifyRefusal({ error: "VALIDATION", refusal: "CODE_TAKEN" }),
      ),
    ).toBeNull();
  });

  it("survives a refusal with no set to name rather than printing a blank", () => {
    // The platform has no active set at all: the screen still gets its branch,
    // with `factorSet: null`, and says the same thing without naming one.
    expect(unpriceableSpend(spendRefusalOf(unpriceableView(null)))).toEqual({
      factorSet: null,
    });
    // A malformed `factor_set` is treated the same way — never rendered raw.
    expect(
      unpriceableSpend(
        classifyRefusal({
          error: "VALIDATION",
          refusal: "NO_SPEND_FACTORS",
          factor_set: { code: 7 },
        }),
      ),
    ).toEqual({ factorSet: null });
  });
});

describe("the sentence a user sees, in both locales", () => {
  const en = load("en");
  const sl = load("sl");

  /** Every key the unpriceable branch renders — none has a `t.has` fallback. */
  const KEYS = [
    `scope3.refusals.${NO_SPEND_FACTORS}`,
    "scope3.editor.unpriceableTitle",
    "scope3.editor.unpriceableBody",
    "scope3.editor.unpriceableBodyNoSet",
    "scope3.editor.unpriceableLines",
    "scope3.editor.unpriced",
    "scope3.editor.unpricedHint",
    "scope3.editor.emptyUnpriceable",
  ];

  it("is written in English and in Slovenian, and not the same words twice", () => {
    for (const key of KEYS) {
      expect(en[key], `missing en: ${key}`).toBeTruthy();
      expect(sl[key], `missing sl: ${key}`).toBeTruthy();
      expect(en[key], `untranslated: ${key}`).not.toBe(sl[key]);
    }
  });

  it("names the set in the sentence that promises to name it", () => {
    for (const messages of [en, sl]) {
      const body = messages["scope3.editor.unpriceableBody"];
      expect(body).toContain("{name}");
      expect(body).toContain("{code}");
      expect(body).toContain("{year}");
    }
  });

  it("says 'not zero' where a zero could be read into it", () => {
    // The English is asserted verbatim, because the acceptance criterion IS the
    // sentence: an unpriced line must not read as a line worth nothing.
    expect(en["scope3.editor.unpriceableLines"]).toContain("not as zero");
    expect(en["scope3.editor.unpricedHint"]).toContain("not a zero");
    // And the ordinary empty state — the one that DOES promise 0 — is not the
    // one shown while nothing can be priced.
    expect(en["scope3.editor.empty"]).toContain("stay at 0");
    expect(en["scope3.editor.emptyUnpriceable"]).not.toContain("0");
  });
});
