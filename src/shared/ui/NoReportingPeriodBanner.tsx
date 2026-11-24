"use client";

import { Building2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { EmptyStateBanner, EmptyStateBannerLinkText } from "./EmptyStateBanner";

/** Shared first step for screens that need a reporting period. */
export function NoReportingPeriodBanner() {
  const t = useTranslations("common.noReportingPeriod");

  return (
    <EmptyStateBanner
      href="/organisation"
      icon={Building2}
      title={t("title")}
      description={t.rich("description", {
        organisation: (chunks) => (
          <EmptyStateBannerLinkText>{chunks}</EmptyStateBannerLinkText>
        ),
      })}
    />
  );
}
