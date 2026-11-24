/**
 * WHAT «THE SITE» IS, AS OPPOSED TO «THE PRODUCT» (партия 20).
 *
 * One list, two readers, because the two questions are the same question:
 *
 *   • `src/proxy.ts` — may a stranger open this page, or is it a redirect to
 *     the login screen?
 *   • `@/shared/ga` — may analytics count this page? The owner's rule is «only
 *     the main site»: the public pages, never the product behind the login.
 *
 * Keeping the list in one place is what makes the second answer stay true. A
 * page added to the public site later is measured because it is public, and a
 * product screen can never be measured by forgetting to exclude it — it is
 * measured only if someone deliberately makes it public here.
 */
import { routing } from "@/i18n/routing";

/** Routes a visitor may open without an account (bare, i.e. locale stripped). */
export const PUBLIC_PATHS = [
  "/",
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  // BUG-002 — where the email-verification link lands; it must also open for
  // a visitor whose link failed and who therefore has no session.
  "/email-verified",
  "/auth",
  "/terms",
  // Партия 22 — the articles on reporting: a stranger must be able to read them,
  // and analytics counts them as part of the public site.
  "/articles",
  // The first public page (ТЗ §11 "Маршруты"). Its whole purpose is to be
  // reachable by a stranger, and its two forms POST to /api/leads.
  "/vsme",
] as const;

/**
 * The path without its locale prefix: `/sl/vsme` → `/vsme`. The default locale
 * carries no prefix, so `/vsme` is already bare.
 */
function stripLocale(pathname: string): string {
  const prefixed = routing.locales.find(
    (locale) =>
      locale !== routing.defaultLocale &&
      (pathname === `/${locale}` || pathname.startsWith(`/${locale}/`)),
  );
  if (!prefixed) return pathname || "/";
  return pathname.slice(`/${prefixed}`.length) || "/";
}

/** Is this bare path part of the public site? */
export function isPublicPath(bare: string): boolean {
  return PUBLIC_PATHS.some((p) =>
    p === "/" ? bare === "/" : bare.startsWith(p),
  );
}

/** Is this full path (locale and all) part of the public site? */
export function isPublicPathname(pathname: string): boolean {
  return isPublicPath(stripLocale(pathname));
}
