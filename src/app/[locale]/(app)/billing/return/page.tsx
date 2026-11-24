"use client";

// T-B3: post-checkout confirmation page. The Revolut card-field widget navigates
// here on `onSuccess`, and the checkout endpoint's `redirect_url` also points here.
//
// IMPORTANT: widget success is only a UX signal — it means the browser finished
// the card flow, NOT that the subscription is active. Authoritative activation
// happens server-side when the Revolut webhook is processed (a later task). So the
// copy here deliberately says "being activated" and never claims the plan is live.
//
// `?status=free` is used for the free/trial path, where no payment was needed.

import { Suspense } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Clock } from "lucide-react";
import { PageLayout } from "../../_components/PageLayout";
import { Card } from "@/shared/ui/Card";
import { Button } from "@/shared/ui/Button";
import styles from "./page.module.css";

function ReturnContent() {
  const t = useTranslations("billing.return");
  const searchParams = useSearchParams();
  const isFree = searchParams.get("status") === "free";

  return (
    <Card className={styles.panel}>
      <div
        className={`${styles.iconBox} ${
          isFree ? styles.iconBoxBlue : styles.iconBoxGreen
        }`}
      >
        {isFree ? <Clock size={28} /> : <CheckCircle2 size={28} />}
      </div>

      {isFree ? (
        <>
          <h2 className={styles.title}>{t("freeTitle")}</h2>
          <p className={styles.body}>{t("freeBody")}</p>
        </>
      ) : (
        <>
          <h2 className={styles.title}>{t("paidTitle")}</h2>
          <p className={styles.body}>{t("paidBody")}</p>
          <p className={styles.note}>{t("paidNote")}</p>
        </>
      )}

      <div className={styles.actions}>
        <Link href="/dashboard">
          <Button variant="primary" size="md">
            {t("goToDashboard")}
          </Button>
        </Link>
        <Link href="/settings">
          <Button variant="secondary" size="md">
            {t("viewSettings")}
          </Button>
        </Link>
      </div>
    </Card>
  );
}

export default function BillingReturnPage() {
  const t = useTranslations("billing");
  return (
    <PageLayout title={t("title")} subtitle={t("return.subtitle")}>
      <div className={styles.wrap}>
        <Suspense>
          <ReturnContent />
        </Suspense>
      </div>
    </PageLayout>
  );
}
