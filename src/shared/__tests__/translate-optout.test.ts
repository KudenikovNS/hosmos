/**
 * Партия 19 — the app opts out of machine translation, and a client crash has
 * a screen.
 *
 * WHY A SOURCE TEST. Both facts are one-line attributes in files no unit test
 * otherwise reads, and both were absent until a crash on prod proved they were
 * needed: with the page translated by the browser, React's next update threw
 * `insertBefore` and — with no error boundary anywhere in the tree — the whole
 * page died with the browser's own «this page couldn't load». A future refactor
 * that drops either line gets that failure back silently; this test is the
 * cheapest thing that notices.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import en from "../../../messages/en.json";
import sl from "../../../messages/sl.json";

const APP = path.resolve(__dirname, "../../app");
const read = (file: string) => readFileSync(path.join(APP, file), "utf8");

describe("machine translation is opted out of", () => {
  const layout = read("[locale]/layout.tsx");

  it("marks the document as not translatable", () => {
    expect(layout).toContain('<html lang={locale} translate="no">');
    expect(layout).toContain('className="notranslate"');
  });

  it("tells Google's translator the same thing in the metadata", () => {
    expect(layout).toContain('other: { google: "notranslate" }');
  });
});

describe("a client crash has a screen", () => {
  it("ships a boundary for the locale tree and a last resort above it", () => {
    const error = read("[locale]/error.tsx");
    expect(error).toContain('"use client"');
    expect(error).toContain("reset");
    // The one sentence that fixes the reported crash must be reachable.
    expect(error).toContain("translated-ltr");
    expect(error).toContain('t("translated")');

    const global = read("global-error.tsx");
    expect(global).toContain("<html");
    expect(global).toContain("<body");
  });

  it("has the copy in the catalogue, in both report languages", () => {
    for (const messages of [en, sl]) {
      const boundary = (messages as Record<string, unknown>)
        .errorBoundary as Record<string, string>;
      expect(Object.keys(boundary).sort()).toEqual([
        "body",
        "digest",
        "reload",
        "retry",
        "title",
        "translated",
      ]);
      for (const value of Object.values(boundary))
        expect(value.trim()).not.toBe("");
    }
    // The hint names the way out: the app's own switcher, not the browser.
    expect(sl.errorBoundary.translated).toMatch(/prevajanje/i);
    expect(en.errorBoundary.translated).toMatch(/translation/i);
  });
});
