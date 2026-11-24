/**
 * Content model for the first public page (ТЗ v1.0, 15.08.2026 — §17 "Контентная
 * модель", §15 "Feature-flag policy", §18 "Источники и контроль актуальности").
 *
 * WHY THE FACTS LIVE HERE AND THE WORDS LIVE IN `messages/landing.<locale>.json`
 * -----------------------------------------------------------------------------
 * The spec asks for two different things that pull in opposite directions:
 *
 *   §17 — "Контент в JSON/CMS без hardcode нормативных условий SPS": the SPS
 *         co-financing numbers must be editable without touching a component.
 *   §16 — the acceptance criteria pin exact figures (€300 / €1 000 / €2 000,
 *         €1 000 + €2 000 = €3 000, entity/site limits) and require that the
 *         pricing table, the depth table and the VESG block AGREE.
 *
 * Duplicating a price into two locale files is the fastest way to break the
 * second rule the first time someone edits one file and not the other. So the
 * split is by KIND, not by section: every number, limit, URL and `checkedAt`
 * date is declared once, here, and every sentence lives in the locale JSON.
 * Prices are never written as text — `formatEur()` renders them per locale, and
 * §14's non-breaking space between the amount and `€` is applied there once.
 *
 * Nothing in this module is localized, and nothing in it may be edited to
 * announce a capability: see `FEATURE_FLAGS` below.
 */

/**
 * The three SaaS plan identifiers (§7). White Label is deliberately NOT one of
 * them: §6/§7 forbid presenting it as a fourth tier, and giving it an id here is
 * the first step towards a fourth pricing card appearing by accident.
 */
export type PlanId = "starter" | "pro" | "enterprise";

/**
 * Status a capability can carry in the UI (§4, `CapabilityBadge`). `comingLater`
 * exists for the TYPE, not for the page: §15 forbids "Coming soon" in the MVP, so
 * a `comingLater` row is REMOVED from the layout rather than rendered greyed out.
 */
export type CapabilityStatus =
  "included" | "estimated" | "addOn" | "comingLater";

export interface PlanContent {
  id: PlanId;
  /** Annual list price in EUR, excluding VAT (§7). 12-month SaaS subscription. */
  annualPriceEur: number;
  /** Hard limits from the §6 depth table — the pricing card and the table read the same field. */
  entityLimit: number;
  /** `null` = "no limit" (Enterprise). Rendered as words, never as an empty cell (§13 a11y). */
  siteLimit: number | null;
  /** VSME depth: Basic only, or Basic + Comprehensive. */
  vsmeDepth: "basic" | "basicComprehensive";
  /**
   * Scope 3 as the product actually does it (партия 16, 15.09.2026): a
   * spend-based estimate of categories 1 and 2 on every plan, reported outside
   * the Scope 1+2 totals and marked as an estimate. The 15-category promise
   * came off the page because no plan delivers it.
   */
  scope3: "spendCategories12";
  /** A supplier registry the company fills in — not questionnaires sent out. */
  supplierRegistry: boolean;
  /** No plan sells an API until one exists (партия 16). Kept for the form's `selected_plan` shape. */
  api: boolean;
  /** Highlight Pro visually (§7) — as "for growing teams", NEVER as "most popular". */
  highlighted: boolean;
  /** Value carried into the lead form as `selected_plan` (§11 routes). */
  ctaTarget: "demo" | "enterprise";
}

export const PLANS: readonly PlanContent[] = [
  {
    id: "starter",
    annualPriceEur: 300,
    entityLimit: 1,
    siteLimit: 3,
    vsmeDepth: "basic",
    scope3: "spendCategories12",
    supplierRegistry: false,
    api: false,
    highlighted: false,
    ctaTarget: "demo",
  },
  {
    id: "pro",
    annualPriceEur: 1000,
    entityLimit: 3,
    siteLimit: 15,
    vsmeDepth: "basicComprehensive",
    scope3: "spendCategories12",
    supplierRegistry: true,
    api: false,
    highlighted: true,
    ctaTarget: "demo",
  },
  {
    id: "enterprise",
    annualPriceEur: 2000,
    entityLimit: 10,
    siteLimit: null,
    vsmeDepth: "basicComprehensive",
    scope3: "spendCategories12",
    supplierRegistry: true,
    api: false,
    highlighted: false,
    ctaTarget: "enterprise",
  },
] as const;

/** Lookup by id — the depth table and the pricing cards must never drift apart. */
export function plan(id: PlanId): PlanContent {
  const found = PLANS.find((p) => p.id === id);
  // Unreachable while every PlanId has a row in PLANS; kept so a future edit that
  // adds an id without a row fails loudly instead of rendering an empty card.
  if (!found) throw new Error(`No plan content for "${id}"`);
  return found;
}

/**
 * §8 — the VESG Pro first-year composition. `totalFirstYearEur` is DERIVED, not
 * declared: §16 requires the page to show €1 000 + €2 000 = €3 000, and a
 * hand-written total is a number that can silently stop adding up.
 */
export const VESG_OFFER = {
  saasPlan: "pro" as PlanId,
  saasPriceEur: plan("pro").annualPriceEur,
  expertServiceEur: 2000,
  get totalFirstYearEur(): number {
    return this.saasPriceEur + this.expertServiceEur;
  },
} as const;

/**
 * SPS (Slovenski podjetniški sklad) VESG programme conditions — §18.
 *
 * These are the only NORMATIVE numbers on the page, and they are the ones §17
 * says must never be hardcoded into a component. They carry `checkedAt` so that
 * §18's update rule ("перед каждым релизом ответственный обновляет checkedAt")
 * is a property of the data rather than a note in a wiki, and so `spsConditions
 * Stale()` below can act on it.
 *
 * Values as published on 15.08.2026: programme open until 31.03.2028, 60% of
 * eligible costs co-financed, subsidy between €1 000 and €9 999,99, with an
 * independent review and AJPES publication as conditions.
 */
export const SPS = {
  coFinancingPercent: 60,
  minSubsidyEur: 1000,
  maxSubsidyEur: 9999.99,
  programmeOpenUntil: "2028-03-31",
  sourceUrl:
    "https://www.podjetniskisklad.si/vesg-vavcer-za-pripravo-prostovoljnega-porocila-o-trajnostnosti/",
  /** ISO date the conditions above were last verified against `sourceUrl`. */
  checkedAt: "2026-08-15",
} as const;

/** EFRAG VSME standard — cited in the trust block with its version date (§9). */
export const EFRAG_VSME = {
  sourceUrl:
    "https://knowledgehub.efrag.org/interactive/vsme/vsme-standard-annex-i",
  checkedAt: "2026-08-15",
} as const;

/**
 * How long an SPS check stays publishable. §14: "Цена или условия VESG
 * недоступны: показывать нейтральный текст и ссылку SPS, не кешировать
 * устаревшее обещание" — so the staleness is enforced in code, not in a habit.
 * 180 days is deliberately generous: the point is to catch a page that has gone
 * unmaintained for half a year, not to blank the block between two releases.
 */
const SPS_MAX_AGE_DAYS = 180;

/**
 * True when the published SPS conditions are older than `SPS_MAX_AGE_DAYS` and
 * must be replaced by the neutral fallback sentence ("check the current SPS
 * documentation") plus the source link. `now` is injected so the page can pass a
 * build/request time and the unit test can pass a fixed one.
 */
export function spsConditionsStale(now: Date = new Date()): boolean {
  const checked = Date.parse(`${SPS.checkedAt}T00:00:00Z`);
  if (Number.isNaN(checked)) return true; // an unparseable date is not a check
  const ageDays = (now.getTime() - checked) / 86_400_000;
  return ageDays > SPS_MAX_AGE_DAYS;
}

/**
 * §15 / §6 — capabilities that are FORBIDDEN in public MVP promises until the
 * export actually exists, has been QA'd and the marketing copy is approved.
 *
 * Every flag is `false` and stays `false` here. Flipping one is not a code edit
 * on its own: the policy requires a working implementation, QA, a verified sample
 * export and approved copy first. While a flag is false the corresponding block
 * is REMOVED from the layout entirely (§14) and must not appear in structured
 * data either — `page.tsx` reads the same flags when it builds the JSON-LD.
 */
export const FEATURE_FLAGS = {
  xbrlExport: false,
  ixbrlExport: false,
  cdpMapping: false,
  sbtiMapping: false,
  tcfdMapping: false,
  /** A real, redacted sample report (§9) — off until one exists and is cleared. */
  sampleReport: false,
  /** Screenshots of shipped product screens in the hero (§3) — off until cleared. */
  productScreenshots: false,
  /** Self-service login route (§3: show "Войти" only if a working route exists).
   *  On since 10.09.2026 — `/login` is live and the cabinet is the product. */
  publicLogin: true,
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;

/** Read a flag. Centralised so a future env/CMS-backed source has one seam. */
export function isEnabled(flag: FeatureFlag): boolean {
  return FEATURE_FLAGS[flag];
}

/**
 * Format a EUR amount for a locale, with §14's requirement that the amount and
 * the `€` never break across lines — `Intl` emits a NARROW NO-BREAK SPACE in
 * some locales and a plain space in others, so the separator is normalised to
 * U+00A0 here rather than being left to the runtime's ICU version.
 *
 * Decimals are shown only when the amount has them (9 999,99 € keeps its cents;
 * 300 € does not grow a ",00").
 *
 * Grouping is left to CLDR and deliberately NOT forced. Slovene sets
 * `minimumGroupingDigits = 2`, so a four-digit amount is correctly written
 * "1000 €" and not "1.000 €"; overriding that with `useGrouping: true` would
 * put German typography into Slovene text.
 */
export function formatEur(amount: number, locale: string): string {
  const hasCents = !Number.isInteger(amount);
  return (
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "EUR",
      minimumFractionDigits: hasCents ? 2 : 0,
      maximumFractionDigits: hasCents ? 2 : 0,
    })
      .format(amount)
      // Depending on the runtime's ICU version the separator arrives as U+0020
      // (plain space) or U+202F (narrow no-break space); only U+00A0 satisfies
      // §14's "неразрывный визуальный пробел", so whichever one this runtime
      // chose is normalised to it.
      .replace(/[  ]/g, " ")
  );
}

/** Format an ISO date (`checkedAt`, `programmeOpenUntil`) for display. */
export function formatDate(iso: string, locale: string): string {
  const parsed = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed)) return iso;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}
