"use client";

// T-B3: Revolut card-field checkout widget page.
//
// A signed-in user pays for a paid plan using Revolut's EMBEDDED card-field widget:
// the card number/expiry/CVC live only inside Revolut's iframe (PCI SAQ-A) — this
// page never sees raw card data, nor any `sk_`/`pk_` secret. It only handles the
// per-order `token` returned by `POST /api/billing/checkout` (T-B2).
//
// Flow:
//   1. Resolve `{plan, period}` from the URL (`?plan=pro&period=monthly`) — the
//      contract used by upgrade CTAs — or from an in-page picker.
//   2. On "Continue", call the checkout endpoint. `{free:true}` → nothing to charge
//      → route to the return page. Otherwise mount the card field with the token.
//   3. On "Pay", submit WITH `savePaymentMethodFor:"merchant"` so the card can be
//      charged later via MIT (recurring subscription renewals).
//   4. `onSuccess` is a UX signal only — real activation is the Revolut webhook
//      (later task) — so we route to `/billing/return`, which says "being activated".
//
// The `@revolut/checkout` SDK is browser-only; importing it at the top level breaks
// SSR/build. It is therefore loaded EXCLUSIVELY via `await import(...)` inside the
// mount effect. The type is referenced through a `typeof import(...)` type position
// only (fully erased — no runtime import).

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@/i18n/navigation";
import { CreditCard, Lock, AlertCircle } from "lucide-react";
import { PageLayout } from "../_components/PageLayout";
import { Card } from "@/shared/ui/Card";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { Select } from "@/shared/ui/Select";
import { apiFetch } from "@/shared/api/client";
import { useCurrentUser } from "@/shared/hooks/useCurrentUser";
import { useCompany } from "@/shared/hooks/useSession";
import { getPlanFeatures } from "@/shared/plans";
import {
  parseCheckoutTarget,
  buildBillingAddress,
  PAID_PLAN_IDS,
  type PaidPlanId,
  type CheckoutPeriod,
  type BillingAddress,
} from "./_lib/checkout-params";
import styles from "./page.module.css";

// Shape of the T-B2 checkout response body (raw JSON; VALIDATION/UNKNOWN aren't in
// ActionErrorCode, so we type `error` loosely rather than reuse ActionResult).
type CheckoutData =
  { free: true } | { free?: false; token: string; publicKey?: string };
type CheckoutResponse =
  { ok: true; data: CheckoutData } | { ok: false; error: string };

// Local description of the Revolut card-field handle we drive. The SDK types are
// only reachable under a dynamic import, so we model the handle we need and cast
// at the mount boundary.
interface CardFieldHandle {
  submit: (meta: {
    name: string;
    email: string;
    savePaymentMethodFor: "merchant" | "customer";
    billingAddress: BillingAddress;
  }) => void;
  destroy?: () => void;
}

/** Card-field widget mode from env; anything but "prod" is treated as sandbox. */
function resolveMode(): "sandbox" | "prod" {
  return process.env.NEXT_PUBLIC_REVOLUT_MODE === "prod" ? "prod" : "sandbox";
}

// Annual price = 10 × monthly (two months free, ≈17% off) — the business rule the
// server seeds into `plan_prices` (0001_billing.sql). The server is the price
// authority at charge time; this is display only, kept in sync with that rule.
const ANNUAL_MONTHS_CHARGED = 10;

function annualPrice(monthly: number): number {
  return monthly * ANNUAL_MONTHS_CHARGED;
}

function BillingContent() {
  const t = useTranslations("billing");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { email, name } = useCurrentUser();
  const { company } = useCompany();

  // Target from URL (upgrade-CTA contract), else driven by the in-page picker.
  const urlTarget = parseCheckoutTarget(
    searchParams.get("plan"),
    searchParams.get("period"),
  );
  const [plan, setPlan] = useState<PaidPlanId>(urlTarget?.plan ?? "pro");
  // Annual only (партия 16): the one period the checkout sells.
  const period: CheckoutPeriod = urlTarget?.period ?? "annual";

  // "select" → picking a plan; "pay" → card field mounted, awaiting card entry.
  const [phase, setPhase] = useState<"select" | "opening" | "pay">("select");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [token, setToken] = useState<string | null>(null);
  // The card field mounts asynchronously (dynamic SDK import); until it's ready a
  // Pay click would silently no-op, so the button stays disabled/loading.
  const [cardReady, setCardReady] = useState(false);

  // Editable customer/address fields. Prefilled in `handleContinue` (by then the
  // session has loaded); the address defaults keep sandbox submits from being
  // blocked on a missing field — see buildBillingAddress.
  const [cardName, setCardName] = useState("");
  const [cardCountry, setCardCountry] = useState("");
  const [city, setCity] = useState("");
  const [postcode, setPostcode] = useState("");
  const [street, setStreet] = useState("");

  const cardTargetRef = useRef<HTMLDivElement>(null);
  const cardFieldRef = useRef<CardFieldHandle | null>(null);

  // "€490 / year" | "€49 / month" — display only; the server re-prices at charge.
  const priceLabel = (p: PaidPlanId, per: CheckoutPeriod): string => {
    const monthly = getPlanFeatures(p).price;
    return per === "annual"
      ? `€${annualPrice(monthly)} ${t("perYear")}`
      : `€${monthly} ${t("perMonth")}`;
  };

  // The ISO-3166 codes are the contract with Revolut; only labels are localised.
  const countryOptions = useMemo(
    () =>
      COUNTRY_CODES.map((code) => ({
        value: code,
        label: t(`countries.${code}`),
      })),
    [t],
  );

  // Mount the Revolut card field once we hold an order token and the target div is
  // in the DOM. The SDK is loaded here — never at module scope.
  useEffect(() => {
    if (!token) return;
    const target = cardTargetRef.current;
    if (!target) return;

    let cancelled = false;
    (async () => {
      try {
        const RevolutCheckout = (await import("@revolut/checkout")).default;
        const { createCardField } = await RevolutCheckout(token, resolveMode());
        if (cancelled) return;
        const field = createCardField({
          target,
          onSuccess() {
            // UX signal only — activation is the webhook. Go to the return page.
            router.push("/billing/return");
          },
          onError() {
            setError(t("errCardDeclined"));
            setSubmitting(false);
          },
        });
        cardFieldRef.current = field as unknown as CardFieldHandle;
        setCardReady(true);
      } catch {
        if (!cancelled) {
          setError(t("errFormLoad"));
          setPhase("select");
        }
      }
    })();

    return () => {
      cancelled = true;
      setCardReady(false);
      cardFieldRef.current?.destroy?.();
      cardFieldRef.current = null;
    };
  }, [token, router, t]);

  // Step 1 → open a Revolut order for the selected plan.
  async function handleContinue() {
    setError("");
    setPhase("opening");
    let res: CheckoutResponse;
    try {
      res = await apiFetch<CheckoutResponse>("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ plan, period }),
      });
    } catch {
      setError(t("errNetwork"));
      setPhase("select");
      return;
    }

    if (!res.ok) {
      setError(
        res.error === "UNAUTHENTICATED"
          ? t("errSessionExpired")
          : t("errCheckoutStart"),
      );
      setPhase("select");
      return;
    }

    if ("free" in res.data && res.data.free) {
      router.push("/billing/return?status=free");
      return;
    }

    // Prefill billing details from the (now-loaded) session before showing the form.
    setCardName((prev) => prev || name);
    setCardCountry((prev) => prev || company?.country_code || "");
    setToken(res.data.token);
    setPhase("pay");
  }

  // Step 2 → hand card entry to Revolut. `savePaymentMethodFor:"merchant"` is what
  // lets the saved card be charged later via MIT (subscription renewals).
  function handlePay() {
    if (!cardFieldRef.current) return;
    setError("");
    setSubmitting(true);
    cardFieldRef.current.submit({
      name: cardName || name || email,
      email,
      savePaymentMethodFor: "merchant",
      billingAddress: buildBillingAddress({
        countryCode: cardCountry,
        city,
        postcode,
        streetLine1: street,
      }),
    });
  }

  return (
    <Card className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.iconBox}>
          <CreditCard size={20} />
        </div>
        <div>
          <h2 className={styles.title}>{t("panelTitle")}</h2>
          <p className={styles.subtitle}>{t("panelSubtitle")}</p>
        </div>
      </div>

      {error && (
        <div className={styles.error}>
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      {phase === "select" || phase === "opening" ? (
        <>
          <div className={styles.planGrid}>
            {PAID_PLAN_IDS.map((p) => {
              const f = getPlanFeatures(p);
              return (
                <button
                  key={p}
                  type="button"
                  className={
                    plan === p ? styles.planCardActive : styles.planCard
                  }
                  onClick={() => setPlan(p)}
                >
                  <div className={styles.planCardHeader}>
                    <span className={styles.planName}>{f.name}</span>
                  </div>
                  <div>
                    <span className={styles.planPrice}>
                      {`€${period === "annual" ? annualPrice(f.price) : f.price}`}
                    </span>{" "}
                    <span className={styles.planPeriod}>
                      {period === "annual" ? t("perYear") : t("perMonth")}
                    </span>
                  </div>
                  <p className={styles.planHighlight}>
                    {f.scope3Full ? t("highlightFull") : t("highlightCore")}
                  </p>
                </button>
              );
            })}
          </div>

          <div className={styles.summary}>
            <span className={styles.summaryLabel}>
              {getPlanFeatures(plan).name} · {priceLabel(plan, period)}
            </span>
            <Button
              variant="primary"
              size="md"
              loading={phase === "opening"}
              onClick={handleContinue}
            >
              {t("continueToPayment")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className={styles.summary}>
            <span className={styles.summaryLabel}>{t("youArePaying")}</span>
            <span className={styles.summaryValue}>
              {getPlanFeatures(plan).name} · {priceLabel(plan, period)}
            </span>
          </div>

          <div className={styles.formStack}>
            <span className={styles.sectionLabel}>{t("billingDetails")}</span>
            <Input
              label={t("cardholderName")}
              value={cardName}
              onChange={(e) => setCardName(e.target.value)}
            />
            <div className={styles.twoCol}>
              <Input
                label={t("city")}
                value={city}
                onChange={(e) => setCity(e.target.value)}
              />
              <Input
                label={t("postcode")}
                value={postcode}
                onChange={(e) => setPostcode(e.target.value)}
              />
            </div>
            <div className={styles.twoCol}>
              <Input
                label={t("street")}
                value={street}
                onChange={(e) => setStreet(e.target.value)}
              />
              <Select
                label={t("country")}
                options={countryOptions}
                value={cardCountry}
                onChange={(e) => setCardCountry(e.target.value)}
              />
            </div>
          </div>

          <div>
            <p className={styles.cardFieldLabel}>{t("cardDetails")}</p>
            {/* Revolut mounts its PCI iframe into this element. */}
            <div ref={cardTargetRef} className={styles.cardField} />
          </div>

          <div className={styles.actions}>
            <Button
              variant="primary"
              size="lg"
              loading={submitting || !cardReady}
              disabled={!cardReady}
              onClick={handlePay}
            >
              {t("payAmount", { amount: priceLabel(plan, period) })}
            </Button>
            <div className={styles.secureNote}>
              <Lock size={12} />
              <span>{t("secureNote")}</span>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

// A short ISO-3166 alpha-2 list; Revolut validates the code, and the address
// defaults cover anything not listed. Kept minimal — this is a sandbox-friendly
// convenience, not an exhaustive picker. The codes are the wire contract; the
// display names come from billing.countries.<code>.
const COUNTRY_CODES = [
  "SI",
  "AT",
  "DE",
  "HR",
  "IT",
  "GB",
  "FR",
  "NL",
  "US",
] as const;

export default function BillingPage() {
  const t = useTranslations("billing");
  return (
    <PageLayout title={t("title")} subtitle={t("subtitle")}>
      <div className={styles.layout}>
        <Suspense>
          <BillingContent />
        </Suspense>
      </div>
    </PageLayout>
  );
}
