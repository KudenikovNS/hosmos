"use client";

import { FilePenLine } from "lucide-react";
import { useTranslations } from "next-intl";

import { EmptyStateBanner, EmptyStateBannerLinkText } from "./EmptyStateBanner";

/** The selected period exists, but its first report revision has not been started. */
export function NoReportRevisionBanner({ periodName }: { periodName: string }) {
  const t = useTranslations("common.noReportRevision");
  const tPeriods = useTranslations("organisation.periods");

  return (
    <EmptyStateBanner
      href="/organisation"
      icon={FilePenLine}
      title={t("title")}
      description={t.rich("description", {
        period: periodName,
        action: tPeriods("startRevision"),
        organisation: (chunks) => (
          <EmptyStateBannerLinkText>{chunks}</EmptyStateBannerLinkText>
        ),
      })}
    />
  );
}
