/**
 * `/vsme/v2` was the address of variant 2 while the two landing variants were
 * compared side by side. Variant 2 became the page at `/vsme` on 06.09.2026;
 * this route only keeps links from the review period alive.
 */
import { redirect } from "@/i18n/navigation";
import { isLocale } from "@/i18n/locales";

export default async function VsmeV2Redirect({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect({ href: "/vsme", locale: isLocale(locale) ? locale : "sl" });
}
