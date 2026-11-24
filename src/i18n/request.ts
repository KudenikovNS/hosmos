import { getRequestConfig } from "next-intl/server";
import { hasLocale } from "next-intl";

import { routing } from "./routing";

type Messages = Record<string, unknown>;

/** `overlay` over `base`, key by key — a locale file only has to carry what it translates. */
function merge(base: Messages, overlay: Messages): Messages {
  const out: Messages = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = out[key];
    out[key] =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current &&
      typeof current === "object" &&
      !Array.isArray(current)
        ? merge(current as Messages, value as Messages)
        : value;
  }
  return out;
}

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale;

  const english = (await import("../../messages/en.json")).default as Messages;
  const own =
    locale === routing.defaultLocale
      ? english
      : ((await import(`../../messages/${locale}.json`)).default as Messages);

  return {
    locale,
    // English underneath: a key the locale has not translated yet renders in
    // English rather than as a raw key (see `./locales.ts`).
    messages: locale === routing.defaultLocale ? english : merge(english, own),
  };
});
