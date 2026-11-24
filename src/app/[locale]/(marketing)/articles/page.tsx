/**
 * `/articles` — the three pieces on reporting (партия 22).
 *
 * The owner asked for articles on the public site and a tab that leads to them.
 * They are marketing in the sense that they are why a stranger stays on the
 * page; they are NOT sales copy: every claim in them is one the product and the
 * standard can carry, which is the same rule the landing lives under (ТЗ §3/§4
 * — no «CSRD-ready in 30 minutes», no capability that does not exist).
 */
import { setRequestLocale } from "next-intl/server";

import { Link } from "@/i18n/navigation";

import { ARTICLES, articleLanguage } from "./content";
import { ArticleHeader } from "./_components/ArticleHeader";
import styles from "./page.module.css";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const { articles } = (
    await import(
      `../../../../../messages/articles.${articleLanguage(locale)}.json`
    )
  ).default;
  return { title: articles.meta.title, description: articles.meta.description };
}

export default async function ArticlesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { articles } = (
    await import(
      `../../../../../messages/articles.${articleLanguage(locale)}.json`
    )
  ).default;

  return (
    <div className={styles.page}>
      <ArticleHeader backLabel={articles.backToList} />
      <main className={styles.main} id="main">
        <h1 className={styles.title}>{articles.listTitle}</h1>
        <p className={styles.lead}>{articles.listLead}</p>

        <div className={styles.grid}>
          {ARTICLES.map((meta) => {
            const item = articles.items[meta.slug];
            return (
              <Link
                key={meta.slug}
                href={`/articles/${meta.slug}`}
                className={styles.card}
              >
                <h2 className={styles.cardTitle}>{item.title}</h2>
                <p className={styles.cardTeaser}>{item.teaser}</p>
                <span className={styles.cardMeta}>
                  {articles.readingTime.replace(
                    "{minutes}",
                    String(meta.minutes),
                  )}
                </span>
              </Link>
            );
          })}
        </div>

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
