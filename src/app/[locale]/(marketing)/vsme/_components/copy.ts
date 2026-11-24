/**
 * The shapes of the copy slices the client islands receive as props.
 *
 * WHY PROPS AND NOT `useTranslations`
 * -----------------------------------
 * The landing copy lives in `messages/landing.<locale>.json`, which is loaded
 * server-side by `page.tsx` and is deliberately NOT merged into the
 * `NextIntlClientProvider` messages — for exactly the reason `src/i18n/request.ts`
 * already gives about the legal text: merging serialises the whole file into the
 * client payload of EVERY page in the app, not just this one. This page's copy is
 * of the same order of size, and it is needed by one route.
 *
 * So the server formats the strings (including the ICU plurals in the depth
 * table, via `createTranslator`) and hands the finished text to the few client
 * components that need it. These interfaces are the contract for that handover;
 * they are also what makes a missing key a TypeScript error at build time rather
 * than a `landing.form.submit` string rendered to a visitor.
 */

/** Strings the sticky header and its mobile drawer need. */
export interface NavCopy {
  aria: string;
  features: string;
  process: string;
  pricing: string;
  vesg: string;
  faq: string;
  /** Партия 22 — the tab that leads to `/articles`. */
  articles: string;
  open: string;
  close: string;
  logIn: string;
  demoCta: string;
}

/** One entry of the "how it works" list. */
export interface ProcessStepCopy {
  title: string;
  action: string;
  result: string;
}

/** One FAQ entry. */
export interface FaqItemCopy {
  q: string;
  a: string;
}

/** Option label pairs for the two forms' selects. */
interface FormOptionsCopy {
  entities1: string;
  entities2to3: string;
  entities4to10: string;
  entities10plus: string;
  yes: string;
  no: string;
  unknown: string;
  sizeMicro: string;
  sizeSmall: string;
  sizeMedium: string;
  sizeOther: string;
  interestStarter: string;
  interestPro: string;
  interestEnterprise: string;
  interestWhiteLabel: string;
}

/** Every string the lead dialog and its two forms render. */
export interface FormCopy {
  demoTitle: string;
  demoSubtitle: string;
  vesgTitle: string;
  vesgSubtitle: string;
  close: string;
  required: string;
  submit: string;
  submitVesg: string;
  submitting: string;
  name: string;
  email: string;
  company: string;
  country: string;
  entityCount: string;
  siteCount: string;
  interest: string;
  size: string;
  hasEmployee: string;
  period: string;
  comment: string;
  inSlovenia: string;
  choose: string;
  options: FormOptionsCopy;
  consent: string;
  consentLink: string;
  marketing: string;
  honeypotLabel: string;
  errors: {
    required: string;
    email: string;
    consent: string;
    tooLong: string;
    server: string;
    rateLimited: string;
    /**
     * The four Slovene plural classes of the error-summary sentence, each with an
     * `{n}` placeholder the client fills in. The class is chosen on the client
     * (`errorSummary`) because the count is only known once the visitor has
     * submitted; English supplies the same sentence for two/few/other.
     */
    summaryOne: string;
    summaryTwo: string;
    summaryFew: string;
    summaryOther: string;
  };
  successTitle: string;
  successBody: string;
  successClose: string;
}

/**
 * Build the error-summary sentence for `count` invalid fields.
 *
 * Slovene plural classes are selected on `count % 100`: 1 → one, 2 → two, 3–4 →
 * few, everything else → other (CLDR). English carries the same sentence in the
 * last three slots, so the rule is safe to apply to both locales rather than
 * shipping an ICU formatter to the client for a single sentence.
 */
export function errorSummary(copy: FormCopy, count: number): string {
  const rest = count % 100;
  const template =
    rest === 1
      ? copy.errors.summaryOne
      : rest === 2
        ? copy.errors.summaryTwo
        : rest === 3 || rest === 4
          ? copy.errors.summaryFew
          : copy.errors.summaryOther;
  return template.replace("{n}", String(count));
}
