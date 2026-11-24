/**
 * GOOGLE ANALYTICS 4 — THE RULES, AS FUNCTIONS (партия 20).
 *
 * The owner created a GA4 property for hosmos.eu (Climatise EU account, Europe/
 * Ljubljana, EUR). Everything about HOW it may be used is already decided by
 * two promises this codebase made before the tag existed, so this file is where
 * they become code rather than intentions:
 *
 *   1. NOTHING FIRES BEFORE CONSENT (ePrivacy Art. 5(3), ZEKom-2 čl. 225, and
 *      the banner's own wording). The tag is not merely configured with
 *      «consent denied» — the script is not loaded at all until the visitor
 *      picks «Accept all». «Only necessary» loads nothing and, once chosen,
 *      revokes what a previous «yes» granted.
 *   2. NO PERSONAL DATA IN AN EVENT (§12, `@/shared/analytics`). A path is the
 *      one thing a page view must carry, and a path is exactly where an id can
 *      hide — `/sl/evidence/9d73dd0a-…`. `analyticsPath` therefore strips the
 *      query string and replaces every identifier-shaped segment with a
 *      placeholder BEFORE the value reaches Google, so a screen is countable
 *      and the row it was opened for is not.
 *
 * The measurement id is public by design (it ships inside the page), so it is
 * committed rather than hidden in an env file the deploy would have to carry;
 * `NEXT_PUBLIC_GA_MEASUREMENT_ID` overrides it for a staging property.
 */

/** The property for hosmos.eu — Climatise EU, Europe/Ljubljana, EUR. */
import { isPublicPathname } from "@/shared/routes";

export const DEFAULT_MEASUREMENT_ID = "G-FNT7ZJBFER";

/** `G-XXXXXXXXXX`, the only shape GA4 accepts. */
export function isMeasurementId(value: string): boolean {
  return /^G-[A-Z0-9]{6,12}$/.test(value);
}

/**
 * The id this build measures with, or `null` when it is switched off. An
 * env value that is not a measurement id is treated as «off» rather than
 * passed on: a typo would otherwise ship a tag that silently collects nothing.
 */
export function measurementId(
  env: string | undefined = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID,
): string | null {
  const raw = (env ?? "").trim();
  if (raw === "off" || raw === "none") return null;
  if (raw === "") return DEFAULT_MEASUREMENT_ID;
  return isMeasurementId(raw) ? raw : null;
}

/** Segments that look like an identifier rather than a screen name. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX = /^[0-9a-f]{16,}$/i;
// Six digits or more: a year («2024») is a screen, an id is not.
const NUMERIC = /^\d{6,}$/;
const TOKENISH = /^[A-Za-z0-9_-]{24,}$/;

/** Is this path segment an id (a row, a document, an invitation token)? */
export function isIdSegment(segment: string): boolean {
  return (
    UUID.test(segment) ||
    LONG_HEX.test(segment) ||
    NUMERIC.test(segment) ||
    TOKENISH.test(segment)
  );
}

/**
 * The path as analytics may see it: no query string, no fragment, and every
 * identifier-shaped segment replaced by `:id`. `/sl/evidence/9d73dd0a-…?tab=x`
 * becomes `/sl/evidence/:id`.
 */
export function analyticsPath(pathname: string): string {
  const [withoutHash] = pathname.split("#");
  const [clean] = withoutHash.split("?");
  const segments = clean.split("/");
  return (
    segments
      .map((segment) => (isIdSegment(segment) ? ":id" : segment))
      .join("/") || "/"
  );
}

/**
 * Партия 20, the owner's rule: «only the main site». A screen behind the login
 * is the product, and the product is not measured — not its paths, not its
 * page views, not a session. `@/shared/routes` owns the list; analytics only
 * asks it, so a new product screen is excluded by default rather than by
 * remembering to exclude it.
 */
export function measuredHere(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return isPublicPathname(pathname);
}

/** The consent cookie's value → whether the tag may run at all. */
export function analyticsAllowed(choice: string | null): boolean {
  return choice === "all";
}

/**
 * gtag.js reads `window['ga-disable-G-…']` before every hit: set, it sends
 * nothing at all. It is the only way to silence a library that is already
 * loaded in the tab — unmounting the <script> does not unload it — so a
 * visitor who withdraws consent stops being measured without a reload.
 */
export function disableFlag(id: string): string {
  return `ga-disable-${id}`;
}

/** The cookies GA4 writes for `id`, so a withdrawal can expire them. */
export function gaCookieNames(id: string): string[] {
  return ["_ga", `_ga_${id.replace(/^G-/, "")}`];
}
