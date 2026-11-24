/**
 * Hosmos — the first public page (`/vsme`; `/` redirects here). This is
 * VARIANT 2, chosen on 06.09.2026 after the side-by-side review.
 *
 * Variant 1 (formerly `/vsme/v1`) was removed once the choice was final;
 * `/vsme/v2` redirects here so old links keep working. This
 * one keeps every commercial fact, limit and disclaimer identical — they come
 * from the same `../content` module and the same `messages/landing.<locale>.json`
 * — and changes only how the page SELLS. Six differences, each one a defect in
 * v1 rather than a matter of taste:
 *
 *   1. The hero shows the product (`ProductPreview`) instead of a four-box
 *      schematic. A visitor could read v1's hero and still not know what they
 *      would be buying.
 *   2. A "when this becomes urgent" block names the four buying triggers §1
 *      already lists — bank, large customer, tender, VESG voucher — so a reader
 *      qualifies themselves before they read a single feature.
 *   3. The §6 depth matrix and the §7 price cards share one section. In v1 they
 *      are two screens apart, which makes "what do I get / what does it cost"
 *      a scroll-and-remember exercise.
 *   4. VESG Pro is an equation (€1 000 + €2 000 = €3 000) rather than a table —
 *      but what the price EXCLUDES keeps equal visual weight, which is the part
 *      the reference mockups quietly demoted to small print.
 *   5. The final CTA is a dark band, so the page ends somewhere instead of
 *      fading out on white.
 *   6. Each process step carries the fields it actually produces.
 *
 * Deliberately NOT copied from the reference mockups, because §16 would reject
 * the page: a "most popular" badge on Pro (§7 allows "for growing teams" only),
 * "Choose" CTAs that imply the self-service checkout §15 excludes, an
 * "audit-ready" feature heading (§4), a login link with no working route (§3),
 * and unlabelled demo numbers (§3 forbids invented KPIs — hence the visible
 * "this is an example" caption under the hero panel).
 */
import type { Metadata } from "next";
import { createTranslator } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import {
  ArrowRight,
  BadgeCheck,
  Building2,
  Calculator,
  CheckCircle2,
  ExternalLink,
  FileSpreadsheet,
  Landmark,
  ListChecks,
  Minus,
  ShieldAlert,
  ShoppingCart,
  Ticket,
  Users,
} from "lucide-react";

import { Link } from "@/i18n/navigation";
import { PlanetIcon } from "@/shared/ui/PlanetIcon";
import { isLocale, type Locale } from "@/i18n/locales";

import {
  EFRAG_VSME,
  PLANS,
  SPS,
  VESG_OFFER,
  formatDate,
  formatEur,
  isEnabled,
  plan as planContent,
  spsConditionsStale,
  type CapabilityStatus,
  type PlanContent,
} from "./content";
import { LANDING_ARTICLES, articleLanguage } from "../articles/content";
import { FaqAccordion } from "./_components/FaqAccordion";
import { LandingHeader } from "./_components/LandingHeader";
import { LeadCta, LeadProvider } from "./_components/LeadProvider";
import { PageAnalytics, SectionView } from "./_components/Telemetry";
import type {
  FaqItemCopy,
  FormCopy,
  ProcessStepCopy,
} from "./_components/copy";
import { ProductPreview } from "./_components/ProductPreview";
import { CookieSettingsLink } from "@/shared/consent/CookieSettingsLink";
import {
  ProcessStepsV2,
  type StepPreviewCopy,
} from "./_components/ProcessStepsV2";
import styles from "./page.module.css";

/** This variant's `landing_version`, carried into every lead and view event. */
const LANDING_VERSION = "vsme-2.0";

type LandingMessages = typeof import("../../../../../messages/landing.sl.json");

async function landingMessages(locale: string): Promise<LandingMessages> {
  // A locale without its own landing file reads the English one.
  try {
    return (await import(`../../../../../messages/landing.${locale}.json`))
      .default;
  } catch {
    return (await import(`../../../../../messages/landing.en.json`)).default;
  }
}

async function landingCopy(locale: Locale) {
  const messages = await landingMessages(locale);
  return {
    t: createTranslator({ locale, messages, namespace: "landing" }),
    raw: messages.landing,
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const resolved: Locale = isLocale(locale) ? locale : "sl";
  const { t } = await landingCopy(resolved);
  const path = "/vsme";
  return {
    title: t("meta.title"),
    description: t("meta.description"),
    alternates: {
      canonical: resolved === "en" ? path : `/sl${path}`,
      languages: { en: path, sl: `/sl${path}` },
    },
  };
}

export default async function VsmeLandingV2({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const resolved: Locale = isLocale(locale) ? locale : "sl";
  const { t, raw } = await landingCopy(resolved);

  const eur = (amount: number) => formatEur(amount, resolved);
  const starterPrice = eur(planContent("starter").annualPriceEur);
  const privacyHref =
    resolved === "en" ? "/terms#privacy" : "/sl/terms#privacy";
  const spsStale = spsConditionsStale();

  const formCopy: FormCopy = raw.form;
  const processSteps: ProcessStepCopy[] = raw.process.steps;
  // Партия 22 — the three article cards. Their words come from the WRITTEN
  // article file (Slovene, English elsewhere), never from the landing copy: a
  // teaser that drifts from the piece it links to is worse than no teaser.
  const articleTexts = (
    await import(
      `../../../../../messages/articles.${articleLanguage(resolved)}.json`
    )
  ).default.articles;
  const articleCards = LANDING_ARTICLES.map((article) => ({
    slug: article.slug,
    title: articleTexts.items[article.slug].title as string,
    teaser: articleTexts.items[article.slug].teaser as string,
  }));

  const stepPreviews: StepPreviewCopy[] = raw.v2.stepPreview.steps;
  const faqItems: FaqItemCopy[] = raw.faq.items;
  const outcomeRows = raw.outcome.rows;
  const trustRows = raw.trust.rows;
  const pricingNotes = raw.pricing.notes;
  const triggerItems = raw.v2.triggers.items;
  const featureItems = raw.features.items as Array<{
    key: string;
    title: string;
    text: string;
    status: CapabilityStatus;
  }>;

  const featureIcons: Record<string, typeof ListChecks> = {
    guidedVsme: ListChecks,
    ghg: Calculator,
    evidence: BadgeCheck,
    entities: Building2,
    suppliers: Users,
    exports: FileSpreadsheet,
  };
  const triggerIcons: Record<string, typeof Landmark> = {
    bank: Landmark,
    client: ShoppingCart,
    tender: FileSpreadsheet,
    vesg: Ticket,
  };

  // Cells shared by the matrix and the price cards — one source, so the two
  // halves of the merged section cannot disagree (§16).
  const boundaries = (p: PlanContent) =>
    `${
      p.entityLimit === 1
        ? t("depth.entityLimit", { count: p.entityLimit })
        : t("depth.entityLimitUpTo", { count: p.entityLimit })
    } · ${
      p.siteLimit === null
        ? t("depth.siteUnlimited")
        : t("depth.siteLimit", { count: p.siteLimit })
    }`;

  // Every plan: the spend-based cat. 1–2 estimate (партия 16). The parameter
  // stays so the depth table keeps one call shape per cell.
  const scope3Cell = (_p: PlanContent) => t("depth.scope3Spend");

  const vsmeCell = (p: PlanContent) =>
    p.vsmeDepth === "basic"
      ? t("depth.vsmeBasic")
      : t("depth.vsmeBasicComprehensive");

  const outputCell = (p: PlanContent) =>
    p.id === "starter"
      ? t("depth.outputStarter")
      : p.id === "pro"
        ? t("depth.outputPro")
        : t("depth.outputEnterprise");

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        name: "Hosmos",
        legalName: "HelpH d.o.o.",
        url: "https://hosmos.si",
      },
      {
        "@type": "SoftwareApplication",
        name: "Hosmos",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        description: t("meta.description"),
        featureList: featureItems.map((f) => f.title),
        offers: PLANS.map((p) => ({
          "@type": "Offer",
          name: t(`pricing.planName.${p.id}`),
          price: p.annualPriceEur,
          priceCurrency: "EUR",
          eligibleDuration: {
            "@type": "QuantitativeValue",
            value: 12,
            unitCode: "MON",
          },
          valueAddedTaxIncluded: false,
        })),
      },
      {
        "@type": "FAQPage",
        mainEntity: faqItems.map((item) => ({
          "@type": "Question",
          name: item.q,
          acceptedAnswer: { "@type": "Answer", text: item.a },
        })),
      },
    ],
  };

  return (
    <LeadProvider
      copy={formCopy}
      locale={resolved}
      privacyHref={privacyHref}
      landingVersion={LANDING_VERSION}
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <noscript>
        <style>{`[data-faq-panel]{display:block !important}`}</style>
      </noscript>

      <PageAnalytics locale={resolved} />

      <a href="#main" className={styles.skipLink}>
        {t("nav.skipToContent")}
      </a>

      {/* 01 — Header */}
      <LandingHeader
        showLogin={isEnabled("publicLogin")}
        copy={{
          aria: t("nav.aria"),
          features: t("nav.features"),
          process: t("nav.process"),
          pricing: t("nav.pricing"),
          vesg: t("nav.vesg"),
          faq: t("nav.faq"),
          articles: t("nav.articles"),
          open: t("nav.open"),
          close: t("nav.close"),
          logIn: t("nav.logIn"),
          demoCta: t("cta.demo"),
        }}
      />

      <main id="main" className={styles.page}>
        {/* 02 — Hero. Copy and brand mark on one row, the product panel full
            width beneath: a dense UI next to an H1 makes the two compete, and
            the H1 has to win the first two seconds. */}
        <section className={styles.hero}>
          <div className={styles.container}>
            <div className={styles.heroTop}>
              <div className={styles.heroCopy}>
                <p className={styles.eyebrow}>{t("hero.eyebrow")}</p>
                <h1 className={styles.h1}>{t("hero.title")}</h1>
                <p className={styles.lede}>{t("hero.subtitle")}</p>
                <div className={styles.heroActions}>
                  <LeadCta
                    form="demo"
                    placement="hero"
                    event="hero_cta_click"
                    eventParams={{ cta: "demo" }}
                    size="lg"
                  >
                    {t("cta.demo")}
                    <ArrowRight
                      size={18}
                      className={styles.btnIcon}
                      aria-hidden="true"
                    />
                  </LeadCta>
                  <a href="#vesg" className={styles.secondaryLink}>
                    {t("cta.learnVesg")}
                  </a>
                </div>
                <p className={styles.microcopy}>
                  {t("hero.microcopy", { price: starterPrice })}
                </p>
              </div>

              {/* The brand mark, finally used at a size where it reads. Inline
                  SVG, so it costs no request and cannot shift the layout. */}
              <div className={styles.heroMark} aria-hidden="true">
                <span className={styles.heroMarkGlow} />
                <PlanetIcon size={200} />
              </div>
            </div>

            <ProductPreview copy={raw.v2.preview} />
          </div>
        </section>

        {/* 03 — Buying triggers. New in v2: it answers "is this about me?"
            before the reader has to evaluate a single feature. The four
            segments are §1's own, not invented. */}
        <section className={styles.sectionAlt}>
          <div className={styles.container}>
            <p className={styles.eyebrow}>{t("v2.triggers.eyebrow")}</p>
            <h2 className={styles.h2}>{t("v2.triggers.title")}</h2>
            <p className={styles.sectionLede}>{t("v2.triggers.subtitle")}</p>
            <ul className={styles.triggerGrid}>
              {triggerItems.map((item) => {
                const Icon = triggerIcons[item.key] ?? Landmark;
                return (
                  <li key={item.key} className={styles.triggerCard}>
                    <span className={styles.triggerIcon}>
                      <Icon size={20} aria-hidden="true" />
                    </span>
                    <h3 className={styles.triggerTitle}>{item.title}</h3>
                    <p className={styles.triggerText}>{item.text}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>

        {/* 04 — Pain → outcome */}
        <section className={styles.section}>
          <div className={styles.container}>
            <h2 className={styles.h2}>{t("outcome.title")}</h2>
            <div className={styles.outcomeGrid}>
              <div className={styles.outcomeHead}>{t("outcome.now")}</div>
              <div className={styles.outcomeHead}>
                {t("outcome.withHosmos")}
              </div>
              {outcomeRows.map((row) => (
                <div key={row.now} className={styles.outcomePair}>
                  <p className={styles.outcomeNow}>
                    <Minus
                      size={14}
                      aria-hidden="true"
                      className={styles.outcomeIconNow}
                    />
                    {row.now}
                  </p>
                  <p className={styles.outcomeWith}>
                    <CheckCircle2
                      size={14}
                      aria-hidden="true"
                      className={styles.outcomeIconWith}
                    />
                    {row.with}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 05 — Features */}
        <section id="features" className={styles.sectionAlt}>
          <div className={styles.container}>
            <h2 className={styles.h2}>{t("features.title")}</h2>
            <p className={styles.sectionLede}>{t("features.subtitle")}</p>
            <ul className={styles.featureGrid}>
              {featureItems.map((feature) => {
                const Icon = featureIcons[feature.key] ?? ListChecks;
                return (
                  <li key={feature.key} className={styles.featureCard}>
                    <span className={styles.featureIcon}>
                      <Icon size={20} aria-hidden="true" />
                    </span>
                    <h3 className={styles.featureTitle}>{feature.title}</h3>
                    <p className={styles.featureText}>{feature.text}</p>
                    <span
                      className={styles.badge}
                      aria-label={t("features.badge.aria", {
                        status: t(`features.badge.${feature.status}`),
                      })}
                    >
                      {t(`features.badge.${feature.status}`)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>

        {/* 06 — How it works, with a preview of each step's own fields */}
        <section id="process" className={styles.section}>
          <div className={styles.container}>
            <h2 className={styles.h2}>{t("process.title")}</h2>
            <p className={styles.sectionLede}>{t("process.subtitle")}</p>
            <ProcessStepsV2
              steps={processSteps}
              previews={stepPreviews}
              resultLabel={t("process.resultLabel")}
              previewLabel={t("v2.stepPreview.label")}
            />
            <aside className={styles.boundary}>
              <ShieldAlert
                size={18}
                aria-hidden="true"
                className={styles.boundaryIcon}
              />
              <div>
                <p className={styles.boundaryTitle}>
                  {t("process.boundaryTitle")}
                </p>
                <p className={styles.boundaryText}>{t("process.boundary")}</p>
              </div>
            </aside>
          </div>
        </section>

        {/* 07 — Depth AND price, one section. The single biggest UX fix over
            v1: "what do I get" and "what does it cost" no longer sit two
            screens apart. On mobile the cards come first — price is the
            question a visitor arrives with — and Starter leads (§14). */}
        <SectionView
          event="pricing_view"
          params={{ plans_version: LANDING_VERSION }}
        >
          <section id="pricing" className={styles.sectionAlt}>
            <div className={styles.container}>
              <h2 className={styles.h2}>{t("v2.depthPricing.title")}</h2>
              <p className={styles.sectionLede}>
                {t("v2.depthPricing.subtitle")}
              </p>

              <div className={styles.depthPricing}>
                <div className={styles.matrixCol}>
                  <h3 className={styles.matrixHeading}>
                    {t("v2.depthPricing.matrixHeading")}
                  </h3>
                  {/* TRANSPOSED against v1: criteria in rows, plans in
                      columns. v1's orientation needs five columns and, squeezed
                      beside the price cards, pushes "Dobavitelji in izhod" into
                      a horizontal scroll a reader can miss entirely — which
                      would defeat the point of merging the two sections. Four
                      columns fit without scrolling at every width from 1024 px
                      up. White Label is deliberately NOT a column here: §6
                      forbids showing it as a fourth tier, and a fourth column
                      beside three plans is exactly that. It keeps its own strip
                      below, with no price. */}
                  <div className={styles.tableScroll}>
                    <table className={`${styles.table} ${styles.tableMatrix}`}>
                      <caption className={styles.srOnly}>
                        {t("depth.tableAria")}
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">
                            <span className={styles.srOnly}>
                              {t("depth.colPlan")}
                            </span>
                          </th>
                          {PLANS.map((p) => (
                            <th key={p.id} scope="col">
                              {t(`pricing.planName.${p.id}`)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(
                          [
                            [t("depth.colVsme"), vsmeCell],
                            [t("depth.colScope3"), scope3Cell],
                            [t("depth.colBoundaries"), boundaries],
                            [t("depth.colOutput"), outputCell],
                          ] as Array<[string, (p: PlanContent) => string]>
                        ).map(([label, cell]) => (
                          <tr key={label}>
                            <th scope="row">{label}</th>
                            {PLANS.map((p) => (
                              <td key={p.id}>{cell(p)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className={styles.tableNote}>{t("depth.estimatedNote")}</p>
                  <p className={styles.tableNote}>
                    {t("depth.whiteLabelNote")}
                  </p>
                </div>

                <div className={styles.cardsCol}>
                  {PLANS.map((p) => (
                    <article
                      key={p.id}
                      className={
                        p.highlighted
                          ? `${styles.planCard} ${styles.planCardHighlighted}`
                          : styles.planCard
                      }
                    >
                      <div className={styles.planHead}>
                        <h3 className={styles.planName}>
                          {t(`pricing.planName.${p.id}`)}
                        </h3>
                        {/* §7: "for growing teams" — NOT "most popular", which
                            we have no data for. */}
                        {p.highlighted && (
                          <span className={styles.planFlag}>
                            {t("pricing.highlighted")}
                          </span>
                        )}
                      </div>
                      <p className={styles.planPrice}>
                        {eur(p.annualPriceEur)}
                        <span className={styles.planPeriod}>
                          {" / "}
                          {t("pricing.perYear")}
                          <span className={styles.planVat}>
                            {" · "}
                            {t("pricing.vatNote")}
                          </span>
                        </span>
                      </p>
                      <p className={styles.planSummary}>
                        {t(`pricing.planSummary.${p.id}`)}
                      </p>
                      {/* Demo, never "Choose": §15 excludes self-service
                          checkout from the MVP, so a buy-looking button would
                          promise a flow that does not exist. */}
                      <LeadCta
                        form="demo"
                        plan={p.id}
                        placement={`pricing_${p.id}`}
                        event="pricing_cta_click"
                        eventParams={{ plan: p.id }}
                        variant={p.highlighted ? "primary" : "secondary"}
                        className={styles.planCta}
                      >
                        {p.ctaTarget === "enterprise"
                          ? t("cta.enterprise")
                          : t("cta.demo")}
                      </LeadCta>
                    </article>
                  ))}
                </div>
              </div>

              <ul className={styles.pricingNotes}>
                {pricingNotes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>

              <div className={styles.whiteLabel}>
                <div>
                  <p className={styles.whiteLabelTitle}>
                    {t("pricing.whiteLabelTitle")}
                  </p>
                  <p className={styles.whiteLabelText}>
                    {t("pricing.whiteLabelText")}
                  </p>
                </div>
                <LeadCta
                  form="demo"
                  plan="white_label"
                  placement="white_label"
                  event="pricing_cta_click"
                  eventParams={{ plan: "white_label" }}
                  variant="secondary"
                >
                  {t("cta.whiteLabel")}
                </LeadCta>
              </div>
            </div>
          </section>
        </SectionView>

        {/* 08 — VESG Pro as an equation. The reference mockups do this well and
            then bury "review and AJPES are extra" in small print; here those two
            keep a full-width row of their own, because they are the difference
            between a €3 000 quote and a €3 000 misunderstanding. */}
        <SectionView
          event="vesg_block_view"
          params={{ content_version: `sps-${SPS.checkedAt}` }}
        >
          <section id="vesg" className={styles.section}>
            <div className={styles.container}>
              <p className={styles.eyebrow}>{t("vesg.eyebrow")}</p>
              <h2 className={styles.h2}>{t("vesg.title")}</h2>
              <p className={styles.sectionLede}>{t("vesg.intro")}</p>

              <div className={styles.equation}>
                <div className={styles.eqCard}>
                  <span className={styles.eqLabel}>{t("vesg.rowSaas")}</span>
                  <span className={styles.eqValue}>
                    {eur(VESG_OFFER.saasPriceEur)}
                  </span>
                </div>
                <span className={styles.eqOp} aria-hidden="true">
                  +
                </span>
                <div className={styles.eqCard}>
                  <span className={styles.eqLabel}>{t("vesg.rowExpert")}</span>
                  <span className={styles.eqValue}>
                    {eur(VESG_OFFER.expertServiceEur)}
                  </span>
                </div>
                <span className={styles.eqOp} aria-hidden="true">
                  =
                </span>
                <div className={`${styles.eqCard} ${styles.eqCardTotal}`}>
                  <span className={styles.eqLabel}>{t("vesg.rowTotal")}</span>
                  <span className={styles.eqValue}>
                    {eur(VESG_OFFER.totalFirstYearEur)}
                  </span>
                  <span className={styles.eqVat}>{t("vesg.totalSuffix")}</span>
                </div>
              </div>

              <div className={styles.outside}>
                <p className={styles.outsideTitle}>
                  {t("v2.vesgEquation.outsideTitle")}
                </p>
                <ul className={styles.outsideList}>
                  <li>
                    <span>{t("vesg.rowReview")}</span>
                    <strong>{t("vesg.rowReviewValue")}</strong>
                  </li>
                  <li>
                    <span>{t("vesg.rowAjpes")}</span>
                    <strong>{t("vesg.rowAjpesValue")}</strong>
                  </li>
                </ul>
              </div>

              <aside className={styles.spsBox}>
                <p className={styles.spsTitle}>{t("vesg.conditionsTitle")}</p>
                <p className={styles.spsText}>
                  {spsStale
                    ? t("vesg.conditionsStale")
                    : t("vesg.conditions", {
                        percent: SPS.coFinancingPercent,
                        min: eur(SPS.minSubsidyEur),
                        max: eur(SPS.maxSubsidyEur),
                        openUntil: formatDate(SPS.programmeOpenUntil, resolved),
                      })}
                </p>
                {!spsStale && (
                  <p className={styles.spsChecked}>
                    {t("vesg.checkedAt", {
                      date: formatDate(SPS.checkedAt, resolved),
                    })}
                  </p>
                )}
                <a
                  href={SPS.sourceUrl}
                  className={styles.sourceLink}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("vesg.sourceLink")}
                  <ExternalLink size={13} aria-hidden="true" />
                </a>
              </aside>

              <div className={styles.vesgCtaRow}>
                <LeadCta
                  form="vesg"
                  placement="vesg_block"
                  event="vesg_cta_click"
                  eventParams={{ placement: "vesg_block" }}
                  size="lg"
                >
                  {t("cta.vesg")}
                </LeadCta>
                <p className={styles.microcopy}>{t("vesg.formNote")}</p>
              </div>
            </div>
          </section>
        </SectionView>

        {/* 09 — Trust, limits, disclaimers */}
        <section className={styles.sectionAlt}>
          <div className={styles.container}>
            <h2 className={styles.h2}>{t("trust.title")}</h2>
            <p className={styles.sectionLede}>{t("trust.subtitle")}</p>

            <div className={styles.trustGrid}>
              <div className={styles.trustCard}>
                <h3 className={styles.trustHeading}>
                  {t("trust.sourcesTitle")}
                </h3>
                <ul className={styles.sourceList}>
                  <li>
                    <a
                      href={EFRAG_VSME.sourceUrl}
                      className={styles.sourceLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("trust.efragLink")}
                      <ExternalLink size={13} aria-hidden="true" />
                    </a>
                    <p className={styles.sourceNote}>
                      {t("trust.efragNote", {
                        date: formatDate(EFRAG_VSME.checkedAt, resolved),
                      })}
                    </p>
                  </li>
                  <li>
                    <a
                      href={SPS.sourceUrl}
                      className={styles.sourceLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("trust.spsLink")}
                      <ExternalLink size={13} aria-hidden="true" />
                    </a>
                    <p className={styles.sourceNote}>
                      {t("trust.spsNote", {
                        date: formatDate(SPS.checkedAt, resolved),
                      })}
                    </p>
                  </li>
                </ul>
              </div>

              <div className={styles.trustCard}>
                <h3 className={styles.trustHeading}>
                  {t("trust.auditTrailTitle")}
                </h3>
                <p className={styles.trustText}>{t("trust.auditTrailNote")}</p>
              </div>
            </div>

            <h3 className={styles.limitsHeading}>{t("trust.limitsTitle")}</h3>
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{t("trust.allowed")}</th>
                    <th scope="col">{t("trust.forbidden")}</th>
                  </tr>
                </thead>
                <tbody>
                  {trustRows.map((row) => (
                    <tr key={row.allowed}>
                      <td>{row.allowed}</td>
                      <td className={styles.forbiddenCell}>{row.forbidden}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className={styles.legal}>{t("trust.legal")}</p>
          </div>
        </section>

        {/* 10 — FAQ */}
        <section id="faq" className={styles.section}>
          <div className={styles.containerNarrow}>
            <h2 className={styles.h2}>{t("faq.title")}</h2>
            <p className={styles.sectionLede}>{t("faq.subtitle")}</p>
            <FaqAccordion items={faqItems} />
          </div>
        </section>

        {/* 10b — Articles (партия 22). Three pieces on reporting, on their own
            route: the landing answers «what do I buy», an article answers «what
            is this and what will it take», and a visitor who is not ready to
            buy has somewhere to go that is not away. */}
        <section id="articles" className={styles.sectionAlt}>
          <div className={styles.containerNarrow}>
            <h2 className={styles.h2}>{t("articles.title")}</h2>
            <p className={styles.sectionLede}>{t("articles.lead")}</p>
            <div className={styles.articleGrid}>
              {articleCards.map((card) => (
                <Link
                  key={card.slug}
                  href={`/articles/${card.slug}`}
                  className={styles.articleCard}
                >
                  <span className={styles.articleCardTitle}>{card.title}</span>
                  <span className={styles.articleCardTeaser}>
                    {card.teaser}
                  </span>
                </Link>
              ))}
            </div>
            <Link href="/articles" className={styles.articleAll}>
              {t("articles.all")} →
            </Link>
          </div>
        </section>

        {/* 11 — Final CTA, dark. v1 ends on white and simply stops; a band gives
            the page a floor and the CTA somewhere to sit. */}
        <section className={styles.finalCta}>
          <span className={styles.finalGlow} aria-hidden="true" />
          <div className={styles.containerNarrow}>
            <span className={styles.finalMark} aria-hidden="true">
              <PlanetIcon size={56} />
            </span>
            <h2 className={styles.finalTitle}>{t("finalCta.title")}</h2>
            <p className={styles.finalLede}>{t("finalCta.subtitle")}</p>
            <div className={styles.finalActions}>
              <LeadCta
                form="demo"
                placement="final"
                event="hero_cta_click"
                eventParams={{ cta: "demo" }}
                size="lg"
              >
                {t("cta.demo")}
              </LeadCta>
              <LeadCta
                form="vesg"
                placement="final"
                event="vesg_cta_click"
                eventParams={{ placement: "final" }}
                variant="secondary"
                size="lg"
              >
                {t("cta.vesg")}
              </LeadCta>
            </div>
            <p className={styles.finalNote}>{t("v2.finalCta.note")}</p>
            <p className={styles.finalNote}>
              {t("finalCta.note", { price: starterPrice })}
            </p>
            <noscript>
              <p className={styles.noscript}>{t("noscript")}</p>
            </noscript>
          </div>
        </section>
      </main>

      {/* 12 — Footer */}
      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.footerBrandCol}>
            <span className={styles.footerBrandRow}>
              <span className={styles.footerLogo}>
                <PlanetIcon size={24} />
              </span>
              <span className={styles.footerBrand}>Hosmos</span>
              <span className={styles.footerBy}>{t("footer.by")}</span>
            </span>
            <p className={styles.footerTagline}>{t("footer.tagline")}</p>
          </div>

          <nav
            className={styles.footerNav}
            aria-label={t("footer.sectionProduct")}
          >
            <p className={styles.footerHeading}>{t("footer.sectionProduct")}</p>
            <a href="#features">{t("nav.features")}</a>
            <a href="#pricing">{t("nav.pricing")}</a>
            <a href="#vesg">{t("nav.vesg")}</a>
            <a href="#faq">{t("nav.faq")}</a>
          </nav>

          <nav
            className={styles.footerNav}
            aria-label={t("footer.sectionLegal")}
          >
            <p className={styles.footerHeading}>{t("footer.sectionLegal")}</p>
            <Link href="/terms">{t("footer.terms")}</Link>
            <CookieSettingsLink />
            <a href="mailto:info@hosmos.si">{t("footer.contact")}</a>
          </nav>

          <nav
            className={styles.footerNav}
            aria-label={t("footer.sectionSources")}
          >
            <p className={styles.footerHeading}>{t("footer.sectionSources")}</p>
            <a href={EFRAG_VSME.sourceUrl} target="_blank" rel="noreferrer">
              EFRAG VSME
            </a>
            <a href={SPS.sourceUrl} target="_blank" rel="noreferrer">
              SPS VESG
            </a>
          </nav>
        </div>

        <div className={styles.footerBottom}>
          <p>{t("footer.copyright", { year: new Date().getFullYear() })}</p>
          <p>{t("footer.disclaimer")}</p>
        </div>
      </footer>
    </LeadProvider>
  );
}
