/**
 * `/` — the public entry point sends the visitor to the VSME page.
 *
 * Decision of 06.09.2026. The previous page here promised what the product does
 * not do — "CSRD-ready in 30 minutes", "Full Scope 3, CDP", a customer quote
 * that never happened — every one of them a sentence the landing ТЗ (v1.0,
 * 15.08.2026, §3/§4/§15) forbids. Rather than edit the claims down, the page
 * is gone and `/vsme` (variant 2) is the only public offer. A redirect rather
 * than a rewrite so the canonical URL in search is `/vsme`, the one the page
 * itself declares.
 */
import { redirect } from "@/i18n/navigation";
import { isLocale } from "@/i18n/locales";

export default async function Home({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  // ТЗ §13: `/` is a plain redirect to the SLOVENIAN page, no geolocation. A
  // visitor who wants English has SL / EN in the header. `/sl` (locale `sl`)
  // lands on the same page; `isLocale` only keeps an unknown segment out.
  const { locale } = await params;
  redirect({
    href: "/vsme",
    locale: isLocale(locale) && locale !== "en" ? locale : "sl",
  });
}
