"use client";

import { Boxes } from "lucide-react";
import { useTranslations } from "next-intl";

import { EmptyStateBanner, EmptyStateBannerLinkText } from "./EmptyStateBanner";

export function NoInventoryDataBanner() {
  const t = useTranslations("common.noInventoryData");
  return (
    <EmptyStateBanner
      href="/inventory"
      icon={Boxes}
      title={t("title")}
      description={t.rich("description", {
        inventory: (chunks) => (
          <EmptyStateBannerLinkText>{chunks}</EmptyStateBannerLinkText>
        ),
      })}
    />
  );
}
