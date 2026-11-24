import { defaultLocale, isLocale, type Locale } from "./locales";

/**
 * Prefix a bare app path with the locale for a FULL navigation
 * (`window.location.href`), which bypasses next-intl's `Link`/`router`.
 *
 * `localePrefix: "as-needed"`: the default locale has no prefix, every other
 * one does. Without this a Slovenian user who signed in on `/sl/login` landed
 * on the English `/readiness` — the proxy only adds a prefix when it has a
 * cookie or header to go by, and a bare path carries neither.
 */
export function localisedPath(path: string, locale: string): string {
  if (!isLocale(locale) || locale === defaultLocale) return path;
  const already = (locales: readonly Locale[]) =>
    locales.some((l) => path === `/${l}` || path.startsWith(`/${l}/`));
  return already([locale]) ? path : `/${locale}${path}`;
}
