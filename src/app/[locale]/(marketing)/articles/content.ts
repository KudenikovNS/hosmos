/**
 * THE ARTICLE REGISTRY (партия 22).
 *
 * The same split the landing uses (`vsme/content.ts`): FACTS here, WORDS in
 * `messages/articles.<locale>.json`. A slug, when the piece was last checked
 * and how long it takes to read are facts about the article; its sentences are
 * translated text.
 *
 * TWO LANGUAGES, LIKE THE TERMS. Long-form content is written, not machine
 * translated: Slovene for the market, English for everyone else — exactly the
 * rule `terms/page.tsx` has followed since it shipped. A visitor reading the
 * site in German gets the English article rather than a translation nobody
 * checked.
 *
 * The slugs are Slovene and STABLE: they are the public URLs, and a renamed URL
 * is a broken link in somebody's e-mail.
 */
export interface ArticleMeta {
  readonly slug: string;
  /** Minutes at ~200 words per minute, rounded up. Shown as «5 min read». */
  readonly minutes: number;
  /** ISO date the text was last reviewed against the standard. */
  readonly updated: string;
}

export const ARTICLES: readonly ArticleMeta[] = [
  { slug: "kaj-je-vsme", minutes: 4, updated: "2026-09-23" },
  { slug: "podatki-za-obseg-1-in-2", minutes: 5, updated: "2026-09-23" },
  { slug: "prvo-porocilo-korak-za-korakom", minutes: 4, updated: "2026-09-23" },
  { slug: "kaj-vas-bo-vprasala-banka", minutes: 4, updated: "2026-09-23" },
  { slug: "dokazila-in-kakovost-podatkov", minutes: 4, updated: "2026-09-23" },
  { slug: "obseg-3-po-porabi-sredstev", minutes: 4, updated: "2026-09-23" },
];

/**
 * The three the LANDING shows. The page has room for one row of cards, and the
 * first three are the introduction: what the standard is, which data it needs,
 * how a first report goes. The rest are one click away on `/articles`, which is
 * the page built to hold them all.
 */
export const LANDING_ARTICLES: readonly ArticleMeta[] = ARTICLES.slice(0, 3);

/** Is this slug one of ours? Anything else is a 404, never a blank page. */
export function isArticleSlug(slug: string): boolean {
  return ARTICLES.some((article) => article.slug === slug);
}

/** The article's facts, or `null` — the page decides what to do about it. */
export function articleBySlug(slug: string): ArticleMeta | null {
  return ARTICLES.find((article) => article.slug === slug) ?? null;
}

/** Which written language an article is served in for a UI locale. */
export function articleLanguage(locale: string): "sl" | "en" {
  return locale === "sl" ? "sl" : "en";
}
