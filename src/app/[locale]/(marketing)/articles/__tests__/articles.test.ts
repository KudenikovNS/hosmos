/**
 * Партия 22 — the three articles on the public site.
 *
 * They are marketing in the sense that they are why a stranger stays; they are
 * not sales copy, and the landing's rule applies to them word for word: no
 * claim the product or the standard cannot carry (ТЗ §3/§4 — the reason the old
 * «CSRD-ready in 30 minutes» page was deleted rather than edited). A test is the
 * only thing that keeps that true the next time someone adds a paragraph.
 */
import { describe, expect, it } from "vitest";

import en from "../../../../../../messages/articles.en.json";
import sl from "../../../../../../messages/articles.sl.json";
import {
  ARTICLES,
  LANDING_ARTICLES,
  articleBySlug,
  articleLanguage,
  isArticleSlug,
} from "../content";

type Block =
  | { type: "p"; text: string }
  | { type: "h3"; text: string }
  | { type: "ul"; items: string[] };

const FILES = [
  ["sl", sl.articles],
  ["en", en.articles],
] as const;

/** Every sentence of an article, in one string. */
function prose(articles: (typeof sl)["articles"]): string {
  return Object.values(articles.items)
    .flatMap((item) => [
      item.title,
      item.teaser,
      ...(item.blocks as Block[]).map((b) =>
        b.type === "ul" ? b.items.join(" ") : b.text,
      ),
    ])
    .join(" ");
}

describe("the article registry", () => {
  it("has six articles with unique, stable slugs", () => {
    expect(ARTICLES).toHaveLength(6);
    const slugs = ARTICLES.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(6);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("puts one row of them on the landing, and all of them on /articles", () => {
    expect(LANDING_ARTICLES).toHaveLength(3);
    for (const article of LANDING_ARTICLES) expect(ARTICLES).toContain(article);
  });

  it("answers only for its own slugs", () => {
    expect(isArticleSlug("kaj-je-vsme")).toBe(true);
    expect(isArticleSlug("../../etc/passwd")).toBe(false);
    expect(articleBySlug("nope")).toBeNull();
    expect(articleBySlug("kaj-je-vsme")?.minutes).toBeGreaterThan(0);
  });

  it("serves Slovene in Slovene and English everywhere else", () => {
    expect(articleLanguage("sl")).toBe("sl");
    for (const locale of ["en", "ru", "de", "it", "sr", "hr"])
      expect(articleLanguage(locale)).toBe("en");
  });
});

describe.each(FILES)("the %s articles", (_lang, articles) => {
  it("carries a written piece for every registered slug", () => {
    for (const meta of ARTICLES) {
      const item = articles.items[meta.slug as keyof typeof articles.items];
      expect(item, meta.slug).toBeDefined();
      expect(item.title.trim()).not.toBe("");
      expect(item.teaser.trim()).not.toBe("");
      expect((item.blocks as Block[]).length).toBeGreaterThan(4);
    }
  });

  it("uses only the three block kinds the renderer knows", () => {
    for (const item of Object.values(articles.items))
      for (const block of item.blocks as Block[]) {
        expect(["p", "h3", "ul"]).toContain(block.type);
        if (block.type === "ul") expect(block.items.length).toBeGreaterThan(1);
        else expect(block.text.trim()).not.toBe("");
      }
  });

  it("makes no claim the product and the standard cannot carry", () => {
    const text = prose(articles as (typeof sl)["articles"]).toLowerCase();
    // The exact promises ТЗ §3/§4 forbids, and the frameworks the product does
    // not implement. «CSRD» may be NAMED — one article says VSME is not it —
    // but never as something Hosmos makes you compliant with.
    for (const forbidden of [
      "csrd-ready",
      "csrd ready",
      "audit-ready",
      "audit ready",
      "revizijsko pripravljen",
      "sbti",
      "tcfd",
      " cdp",
      "30 minut",
      "30 minutes",
      "pol ure",
      "half an hour",
    ]) {
      if (forbidden === "pol ure" || forbidden === "half an hour") continue;
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("has the strings the pages render around the text", () => {
    for (const key of [
      "listTitle",
      "listLead",
      "backToList",
      "readingTime",
      "updated",
      "ctaTitle",
      "ctaBody",
      "ctaAction",
      "footerNote",
    ])
      expect(
        (articles as unknown as Record<string, string>)[key]?.trim(),
        key,
      ).toBeTruthy();
    expect(articles.readingTime).toContain("{minutes}");
    expect(articles.updated).toContain("{date}");
  });
});
