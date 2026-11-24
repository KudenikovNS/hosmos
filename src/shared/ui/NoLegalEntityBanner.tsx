"use client";

import { Building2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { EmptyStateBanner, EmptyStateBannerLinkText } from "./EmptyStateBanner";

export function NoLegalEntityBanner() {
  const t = useTranslations("common.noLegalEntity");

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
