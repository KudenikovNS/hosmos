"use client";

import { Sigma } from "lucide-react";
import { useTranslations } from "next-intl";

import { EmptyStateBanner } from "@/shared/ui/EmptyStateBanner";

/** Entry point for companies that have not approved a calculation yet. */
export function NoApprovedCalculationBanner() {
  const t = useTranslations("dashboard.emissions");

  return (
    <EmptyStateBanner
      href="/inventory"
      icon={Sigma}
      title={t("noApproved")}
      description={t("noApprovedBody")}
    />
  );
}
