"use client";

import { ClipboardCheck } from "lucide-react";
import { useTranslations } from "next-intl";

import { EmptyStateBanner, EmptyStateBannerLinkText } from "./EmptyStateBanner";

export function ReportApprovalRequiredBanner({
  periodName,
}: {
  periodName: string;
}) {
  const t = useTranslations("common.reportApprovalRequired");
  return (
    <EmptyStateBanner
      href="/review"
      icon={ClipboardCheck}
      title={t("title")}
      description={t.rich("description", {
        period: periodName,
        review: (chunks) => (
          <EmptyStateBannerLinkText>{chunks}</EmptyStateBannerLinkText>
        ),
      })}
    />
  );
}
