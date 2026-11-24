import { ArrowLeft } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { PlanetIcon } from "@/shared/ui/PlanetIcon";
import styles from "./page.module.css";

export default async function TermsOfServicePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("terms");
  const { termsContent } = (
    await import(
      `../../../../../messages/terms.${locale === "sl" ? "sl" : "en"}.json`
    )
  ).default;

  return (
    <div className={styles.page}>
      {/* Navigation */}
      <nav className={styles.nav}>
        <div className={styles.navInner}>
          <Link href="/" className={styles.brandLink}>
            <div className={styles.logo}>
              <PlanetIcon size={28} />
            </div>
            <span className={styles.brand}>Hosmos</span>
          </Link>
          <Link href="/" className={styles.backLink}>
            <ArrowLeft size={14} />
            {t("backToHome")}
          </Link>
        </div>
      </nav>

      {/* Content */}
      <main className={styles.main}>
        <article className={styles.article}>
          <h1 className={styles.pageTitle}>{t("pageTitle")}</h1>
          <p className={styles.updated}>{t("lastUpdated")}</p>

          {/* Quick nav */}
          <div className={styles.quickNav}>
            <a
              href="#terms"
              className={`${styles.quickLink} ${styles.quickLinkTerms}`}
            >
              {t("quickTerms")}
            </a>
            <a
              href="#privacy"
              className={`${styles.quickLink} ${styles.quickLinkPrivacy}`}
            >
              {t("quickPrivacy")}
            </a>
          </div>

          <TermsBody content={termsContent} />
        </article>
      </main>

      {/* Footer */}
      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.footerBrand}>
            <div className={styles.footerLogo}>
              <PlanetIcon size={24} />
            </div>
            <span className={styles.footerName}>Hosmos</span>
            <span className={styles.footerBy}>by HelpH D.O.O.</span>
          </div>
          <div className={styles.footerLinks}>
            <Link href="/terms" className={styles.footerLinkActive}>
              {t("footerTermsPrivacy")}
            </Link>
            <Link href="#" className={styles.footerLink}>
              {t("footerContact")}
            </Link>
            <span>&copy; 2026 Hosmos</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Section({
  number,
  id,
  title,
  children,
}: {
  number: string;
  id?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={styles.section}>
      <h2 className={styles.sectionTitle}>
        <span className={styles.sectionNumber}>{number}.</span>
        {title}
      </h2>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}

type Block =
  | { type: "p"; text: string }
  | { type: "h4"; text: string; tight?: boolean }
  | { type: "ul"; items: string[] }
  | { type: "infobox"; intro: string; items: string[] }
  | { type: "table"; head: string[]; rows: string[][] }
  | { type: "rights"; items: [string, string][] }
  | { type: "contact"; lines: string[] };

interface TermsSection {
  number: string;
  /** Optional anchor, e.g. `cookies` for `/terms#cookies`. */
  id?: string;
  title: string;
  blocks: Block[];
}

interface TermsContent {
  sections: TermsSection[];
  privacySections: TermsSection[];
  privacyTitle: string;
  privacyIntro: string;
}

function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)]+)\)|\{\{(.+?)\}\}/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      parts.push(<strong key={key++}>{m[1]}</strong>);
    } else if (m[2] !== undefined) {
      parts.push(
        <a key={key++} href={m[3]} className={styles.inlineLink}>
          {m[2]}
        </a>,
      );
    } else if (m[4] !== undefined) {
      parts.push(
        <span key={key++} className={styles.accentText}>
          {m[4]}
        </span>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function renderBlock(block: Block, key: number): React.ReactNode {
  switch (block.type) {
    case "p":
      return <p key={key}>{renderInline(block.text)}</p>;
    case "h4":
      return (
        <h4
          key={key}
          className={block.tight ? styles.subheadingTight : styles.subheading}
        >
          {renderInline(block.text)}
        </h4>
      );
    case "ul":
      return (
        <ul key={key} className={styles.list}>
          {block.items.map((it, i) => (
            <li key={i}>{renderInline(it)}</li>
          ))}
        </ul>
      );
    case "infobox":
      return (
        <div key={key} className={styles.infoBox}>
          <p className={styles.infoBoxText}>{renderInline(block.intro)}</p>
          <ul className={styles.list}>
            {block.items.map((it, i) => (
              <li key={i}>{renderInline(it)}</li>
            ))}
          </ul>
        </div>
      );
    case "table":
      return (
        <div key={key} className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr className={styles.tableHeadRow}>
                {block.head.map((h, i) => (
                  <th key={i} className={styles.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={styles.tableBody}>
              {block.rows.map((row, i) => (
                <tr key={i} className={styles.tableRow}>
                  {row.map((cell, j) => (
                    <td key={j} className={styles.td}>
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rights":
      return (
        <div key={key} className={styles.rightsGrid}>
          {block.items.map((it, i) => (
            <div key={i} className={styles.rightRow}>
              <span className={styles.rightLabel}>{it[0]}</span>
              <span className={styles.rightDesc}>{renderInline(it[1])}</span>
            </div>
          ))}
        </div>
      );
    case "contact":
      return (
        <div key={key} className={styles.contactBox}>
          {block.lines.map((ln, i) => (
            <p key={i}>{renderInline(ln)}</p>
          ))}
        </div>
      );
    default:
      return null;
  }
}

function TermsBody({ content }: { content: TermsContent }) {
  const { sections, privacySections, privacyTitle, privacyIntro } = content;

  return (
    <>
      <div id="terms" className={styles.anchor} />

      {sections.map((section) => (
        <Section
          key={section.number}
          number={section.number}
          title={section.title}
        >
          {section.blocks.map((block, i) => renderBlock(block, i))}
        </Section>
      ))}

      <div id="privacy" className={styles.privacyAnchor} />

      <h2 className={styles.privacyTitle}>{privacyTitle}</h2>
      <p className={styles.privacyIntro}>{privacyIntro}</p>

      {privacySections.map((section) => (
        <Section
          key={section.number}
          number={section.number}
          id={section.id}
          title={section.title}
        >
          {section.blocks.map((block, i) => renderBlock(block, i))}
        </Section>
      ))}
    </>
  );
}
