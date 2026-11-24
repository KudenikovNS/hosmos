/**
 * `/articles/<slug>` — one article (партия 22).
 *
 * The slug is checked against the registry rather than trusted: an unknown one
 * is a 404, not a page with empty headings. Static params are the three slugs,
 * so the pieces are rendered at build time like the rest of the public site.
 */
import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";

import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

import { renderBlock, type Block } from "../blocks";
import { ARTICLES, articleBySlug, articleLanguage } from "../content";
import { ArticleHeader } from "../_components/ArticleHeader";
import styles from "../page.module.css";

export function generateStaticParams() {
  return routing.locales.flatMap((locale) =>
    ARTICLES.map((article) => ({ locale, slug: article.slug })),
  );
}

async function load(locale: string) {
  return (
    await import(
      `../../../../../../messages/articles.${articleLanguage(locale)}.json`
    )
  ).default.articles;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  if (!articleBySlug(slug)) return {};
  const articles = await load(locale);
  const item = articles.items[slug];
  return { title: `${item.title} | Hosmos`, description: item.teaser };
}

export default async function ArticlePage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const meta = articleBySlug(slug);
  if (!meta) notFound();

  const articles = await load(locale);
  const item = articles.items[slug];
  const updated = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(meta.updated));

  return (
    <div className={styles.page}>
      <ArticleHeader backLabel={articles.backToList} />
      <main className={styles.main} id="main">
        <Link href="/articles" className={styles.back}>
          ← {articles.backToList}
        </Link>
        <article className={styles.article}>
          <h1 className={styles.title}>{item.title}</h1>
          <p className={styles.articleMeta}>
            {articles.readingTime.replace("{minutes}", String(meta.minutes))} ·{" "}
            {articles.updated.replace("{date}", updated)}
          </p>
          {(item.blocks as Block[]).map((block, index) =>
            renderBlock(block, index),
          )}
        </article>

        <section className={styles.cta}>
          <h2 className={styles.ctaTitle}>{articles.ctaTitle}</h2>
          <p className={styles.ctaBody}>{articles.ctaBody}</p>
          <Link href="/vsme#pricing" className={styles.ctaAction}>
            {articles.ctaAction}
          </Link>
        </section>
      </main>
      <p className={styles.footer}>{articles.footerNote}</p>
    </div>
  );
}
