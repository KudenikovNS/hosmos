import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Toaster } from "sonner";
import { routing } from "@/i18n/routing";
import type { Locale } from "@/i18n/locales";
import { localisedPath } from "@/i18n/localised-path";
import { CookieConsent } from "@/shared/consent/CookieConsent";
import { GoogleAnalytics } from "@/shared/ga/GoogleAnalytics";
import "../globals.css";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "metadata" });
  return {
    title: t("title"),
    description: t("description"),
    keywords: [
      "ESG",
      "CSRD",
      "GRI",
      "sustainability",
      "carbon",
      "Scope 1",
      "Scope 2",
      "Scope 3",
      "SME",
    ],
    // The brand mark (10.09.2026): `src/app/icon.png` / `apple-icon.png`, the
    // favicon cut of `shared/ui/planet.webp`. Explicit, because this locale
    // layout is the root layout and the file convention alone did not surface.
    icons: { icon: "/icon.png", apple: "/apple-icon.png" },
    // ── Партия 19: NO MACHINE TRANSLATION OF THIS APP ────────────────────────
    // Chrome's «translate this page» rewrites the DOM under React: it replaces
    // every text node with a <font> wrapper of its own. React then updates a
    // node that is no longer where it left it, throws
    // `NotFoundError: Failed to execute 'insertBefore'`, and — with no error
    // boundary above it — the whole client tree dies. Reproduced on prod
    // 20.09.2026: with the page translated, the FIRST keystroke in any form
    // killed the page («Эта страница не загрузилась»).
    //
    // The app is not monolingual and does not need the browser's translator:
    // it ships seven locales with its own switcher. So it opts out, the way
    // Google documents it — the meta tag here and `translate="no"` on <html>.
    other: { google: "notranslate" },
    alternates: {
      canonical: localisedPath("/", locale),
      languages: Object.fromEntries(
        routing.locales.map((l) => [l, localisedPath("/", l)]),
      ),
    },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  return (
    <html lang={locale} translate="no">
      <body className="notranslate">
        <NextIntlClientProvider>
          {children}
          <CookieConsent />
          <GoogleAnalytics />
          <Toaster richColors closeButton position="top-right" theme="light" />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
