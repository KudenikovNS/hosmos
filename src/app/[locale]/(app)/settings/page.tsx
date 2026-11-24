"use client";

import { clsx } from "clsx";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { useState, useEffect, useTransition } from "react";
import { usePathname, useRouter } from "@/i18n/navigation";
import { locales, localeNames, type Locale } from "@/i18n/locales";
import { PageLayout } from "../_components/PageLayout";
import { Card } from "@/shared/ui/Card";
import { Input } from "@/shared/ui/Input";
import { Select } from "@/shared/ui/Select";
import { CookieSettingsLink } from "@/shared/consent/CookieSettingsLink";
import { Button } from "@/shared/ui/Button";
import { Badge } from "@/shared/ui/Badge";
import {
  Building2,
  Users,
  CreditCard,
  Globe,
  Save,
  Upload,
  Link2,
  FileText,
  Zap,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  Lock,
  RotateCcw,
  ShieldAlert,
  Info,
} from "lucide-react";
import { TrialBanner } from "@/shared/ui/TrialBanner";
import { usePlan, type BillingPeriod } from "@/shared/hooks/usePlan";
import {
  PLAN_FEATURES,
  getPlanBadgeVariant,
  getPlanFeatures,
  type PlanId,
} from "@/shared/plans";
import { annualPrice, transitionKind } from "./_lib/plan-transitions";
import { useMembers } from "./_lib/useMembers";
import { useInvitations, useSeats } from "./_lib/useInvitations";
import { useCapabilities } from "@/shared/hooks/useCapabilities";
import { apiFetch } from "@/shared/api/client";
import type { ActionResult } from "@/server/actions/types";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCompany,
  useSession,
  SESSION_QUERY_KEY,
} from "@/shared/hooks/useSession";
import styles from "./page.module.css";
import { UNITS } from "@/shared/units";
import { TeamMemberRow, TeamInvite, FeatureLine } from "./_components/team";

/**
 * The «Data integrations» and «Invoice scanner» cards are mock-ups: no
 * connector exists behind «Connect», and the «recent uploads» are hard-coded
 * sample files. They stay hidden until the features are real; the markup is
 * kept so the design is not lost.
 */
const SHOW_MOCK_INTEGRATIONS = false;

const INTEGRATIONS = [
  {
    id: "xero",
    name: "Xero",
    type: "API",
    tier: "starter",
    connected: false,
    desc: "Cloud accounting",
  },
  {
    id: "quickbooks",
    name: "QuickBooks",
    type: "API",
    tier: "starter",
    connected: false,
    desc: "Intuit accounting",
  },
  {
    id: "csv_import",
    name: "CSV / Excel",
    type: "File",
    tier: "starter",
    connected: true,
    desc: "Manual file upload",
  },
  {
    id: "pdf_scan",
    name: "Invoice Scanner",
    type: "OCR + AI",
    tier: "starter",
    connected: true,
    desc: "Upload PDF invoices",
  },
  {
    id: "sage",
    name: "Sage",
    type: "API",
    tier: "pro",
    connected: false,
    desc: "Accounting & payroll",
  },
  {
    id: "odoo",
    name: "Odoo",
    type: "API",
    tier: "pro",
    connected: false,
    desc: "Open-source ERP",
  },
  {
    id: "open_banking",
    name: "Open Banking",
    type: "PSD2",
    tier: "pro",
    connected: false,
    desc: "Bank transactions",
  },
  {
    id: "sap_b1",
    name: "SAP Business One",
    type: "CSV",
    tier: "enterprise",
    connected: false,
    desc: "SAP for SMEs",
  },
  {
    id: "1c",
    name: "1C:Enterprise",
    type: "CSV",
    tier: "enterprise",
    connected: false,
    desc: "CIS accounting",
  },
];

const PLAN_LIST: {
  id: PlanId;
  name: string;
  price: number;
  period: string;
  highlight: string;
}[] = [
  {
    id: "trial",
    name: "Trial",
    price: 0,
    period: "30 days",
    highlight: "Scope 1+2, 1 report",
  },
  {
    id: "starter",
    name: "Starter",
    price: 20,
    period: "/ month",
    highlight: "Scope 1+2+3, GRI & ESRS",
  },
  {
    id: "pro",
    name: "Pro",
    price: 100,
    period: "/ month",
    highlight: "Full Scope 3, CDP, Supply Chain",
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: 1000,
    period: "/ month",
    highlight: "API, White label, Unlimited",
  },
];

interface CompanyData {
  name: string;
  industry: string;
  country: string;
  nace_code: string;
  headcount: number;
  currency: string;
  website?: string;
}

/** One seeded ISO-4217 currency (the DB-sourced dropdown options, T2.5). */
interface CurrencyOption {
  code: string;
  name: string;
  symbol: string;
}

export default function SettingsPage() {
  const t = useTranslations("settings");
  const format = useFormatter();
  const {
    plan,
    features,
    mode,
    subscription,
    changePlan,
    transition,
    loading: planLoading,
    userId: currentUserId,
  } = usePlan();
  const {
    members,
    loading: membersLoading,
    accessChanged: membersAccessChanged,
    loadError: membersLoadError,
    changeRole,
    removeMember,
  } = useMembers();
  const {
    invitations,
    loading: invitesLoading,
    accessChanged: invitesAccessChanged,
    loadError: invitesLoadError,
    issue: issueInvite,
    resend: resendInvite,
    revoke: revokeInvite,
  } = useInvitations();
  const seats = useSeats();
  const caps = useCapabilities();
  // The invite controls are gated on the SAME capability the issue route requires
  // (`requireCapability(session, "members.manage")` in /api/invitations) — §0.1.
  const canManageMembers = caps.has("members.manage");
  const queryClient = useQueryClient();
  const router = useRouter();
  // The interface language: the same switch as the top bar's (LanguageSwitcher)
  // — the route is kept, only the locale prefix changes.
  const locale = useLocale() as Locale;
  const pathname = usePathname();
  const [languagePending, startLanguageTransition] = useTransition();
  const { company: sessionCompany } = useCompany();
  const { data: sessionData } = useSession();
  // R-7 grant disclosure: show ONLY when the D13 compensating grant is live FOR
  // THIS viewer — i.e. THEY hold `data.approve` (only `esg_admin` gets it) AND the
  // company has no independent approver (`hasIndependentApprover === false`, a
  // company-wide flag). Gating on the company flag alone would tell a contributor
  // "you approve your own data", which is false for them (R-7: never a false claim).
  const hasIndependentApprover =
    sessionData?.membership?.hasIndependentApprover;
  const selfApproves =
    caps.has("data.approve") && hasIndependentApprover === false;
  const [changingPlan, setChangingPlan] = useState<PlanId | null>(null);
  const [showPlanModal, setShowPlanModal] = useState(false);
  // The modal prices and the transition period. Annual is the only period a
  // NEW subscription can start on (партия 16); a live subscription keeps its own
  // period, because the server rejects a period switch on an in-place upgrade.
  const [period, setPeriod] = useState<BillingPeriod>("annual");
  const [modalMsg, setModalMsg] = useState<string | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const [company, setCompany] = useState<CompanyData>({
    name: "",
    industry: "",
    country: "",
    nace_code: "",
    headcount: 0,
    currency: "EUR",
  });
  const [currencyOptions, setCurrencyOptions] = useState<CurrencyOption[]>([]);
  const [saving, setSaving] = useState(false);

  // Readonly mirror (T-C3 §9): when entitlements are not `active` (a lapsed/past-due
  // subscription), the server BLOCKS writes (T-A4) — the UI disables the write
  // controls and shows an upgrade hint. This is UX only; data still renders.
  const readonly = mode !== "active";
  const isPaidPlan = plan !== "trial";

  // Both `period` and `company` are EDITABLE copies of data that arrives
  // asynchronously (the subscription query, the session). Re-seeding them from an
  // effect is what `react-hooks/set-state-in-effect` flags: an effect setState
  // renders once with stale local state, then again with the synced one. The
  // React-documented replacement is to adjust state DURING render, keyed on the
  // previous value of the source — one commit, no cascade, and a user's unsaved
  // edit is still preserved until the SOURCE actually changes (e.g. after the
  // session refetch that follows a successful save).
  const [seenPeriod, setSeenPeriod] = useState(subscription?.period);
  if (subscription?.period !== seenPeriod) {
    setSeenPeriod(subscription?.period);
    if (
      subscription?.period === "annual" ||
      subscription?.period === "monthly"
    ) {
      setPeriod(subscription.period);
    }
  }

  const [seenCompany, setSeenCompany] = useState(sessionCompany);
  if (sessionCompany !== seenCompany) {
    setSeenCompany(sessionCompany);
    if (sessionCompany) {
      setCompany({
        name: sessionCompany.name || "",
        industry: sessionCompany.industry || "",
        country: sessionCompany.country || "",
        nace_code: sessionCompany.nace_code || "",
        headcount: sessionCompany.headcount || 0,
        currency: sessionCompany.currency || "EUR",
      });
    }
  }

  // The default-currency dropdown options come from the seeded `currencies` (the
  // same set the server validates a write against, T2.5/§Q3-FX) — never a
  // client-side hardcoded list that could diverge from the DB.
  useEffect(() => {
    let active = true;
    apiFetch<ActionResult<CurrencyOption[]>>("/api/currencies").then((res) => {
      if (active && res.ok) setCurrencyOptions(res.data);
    });
    return () => {
      active = false;
    };
  }, []);

  const handleSaveCompany = async () => {
    if (readonly) return; // server also blocks this (T-A4); UI guard for safety.
    setSaving(true);
    // Компания определяется из сессии внутри action — companyId с клиента
    // не передаём (ARCH-DELTA 2.6 / принцип §3.4). Ошибка приходит кодом
    // в ActionResult, а не исключением через границу сервер/клиент.
    const result = await apiFetch<ActionResult<unknown>>("/api/company", {
      method: "PATCH",
      body: JSON.stringify({
        name: company.name,
        industry: company.industry,
        country: company.country,
        nace_code: company.nace_code,
        headcount: company.headcount,
        currency: company.currency,
      }),
    });
    setSaving(false);
    if (!result.ok) {
      toast.error(
        result.error === "UNAUTHENTICATED"
          ? t("sessionExpired")
          : t("saveFailed"),
      );
      return;
    }
    queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    toast.success(t("savedNote"));
  };

  // A plan-card button in the modal. Routing (T-C3 §8):
  //   • target = trial (drop to free), or NO live subscription for a paid target →
  //     the T-C2 engine can't transition it → use the instant `changePlan`, or route
  //     to /billing checkout to START a paid subscription.
  //   • otherwise → POST the real upgrade/downgrade. `applied` (charged/free) closes
  //     the modal (session refetch flips the plan); `needsCheckout` routes to the
  //     T-B3 widget; `scheduled` (downgrade) shows an end-of-period note; error →
  //     message. Money is never sent — the server re-prices.
  const handlePlanChange = async (target: PlanId) => {
    setModalMsg(null);
    setChangingPlan(target);
    try {
      if (target === "trial") {
        // A LIVE paid subscription can't just flip `company.plan` to trial — that
        // leaves the subscription active and BILLING while the UI shows "Trial"
        // (plan/features diverge). Schedule a cancel at period end instead; the
        // company drops to the free tier when the paid period actually ends.
        if (subscription) {
          const result = await transition("cancel");
          setModalMsg(
            result.ok ? t("msgCancelScheduled") : t("msgScheduleFailed"),
          );
          return;
        }
        // No live subscription → a plain denormalized flip to the free tier.
        const ok = await changePlan("trial");
        if (ok) setShowPlanModal(false);
        else setModalMsg(t("msgChangeFailed"));
        return;
      }
      if (!subscription) {
        // No live subscription → a paid plan must be started via checkout.
        router.push(`/billing?plan=${target}&period=${period}`);
        return;
      }
      const kind = transitionKind(plan, target);
      if (kind === "same") return;
      const result = await transition(kind, target, period);
      if (!result.ok) {
        setModalMsg(t("msgChangeFailed"));
        return;
      }
      const data = result.data;
      if ("needsCheckout" in data) {
        router.push(`/billing?plan=${data.plan}&period=${data.period}`);
        return;
      }
      if ("applied" in data) {
        setShowPlanModal(false);
        return;
      }
      if ("scheduled" in data) {
        setModalMsg(
          t("msgDowngradeScheduled", { name: getPlanFeatures(target).name }),
        );
      }
    } finally {
      setChangingPlan(null);
    }
  };

  const handleCancel = async () => {
    setSubBusy(true);
    const result = await transition("cancel");
    setSubBusy(false);
    if (result.ok) toast.success(t("msgCancelScheduled"));
    else toast.error(t("msgCancelFailed"));
  };

  const handleResume = async () => {
    setSubBusy(true);
    const result = await transition("resume");
    setSubBusy(false);
    if (result.ok) toast.success(t("msgResumeDone"));
    else toast.error(t("msgResumeFailed"));
  };

  const currentPlanInfo = PLAN_LIST.find((p) => p.id === plan) || PLAN_LIST[0];
  // `SubscriptionState.period` is a plain string from the DB, so anything that is
  // not "annual" reads as monthly — the same fallback main's inline ternary used.
  const periodLabel = (p: string) =>
    p === "annual" ? t("periodAnnual") : t("periodMonthly");

  // Formatted on the APP locale (next-intl), not the browser's — otherwise a
  // Slovenian UI could render dates in the visitor's own locale format.
  const fmtDate = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: "medium" }) : "—";

  return (
    <PageLayout
      title={t("title")}
      subtitle={t("subtitle")}
      loading={planLoading}
    >
      {/* Trial Banner */}
      {plan === "trial" && (
        <TrialBanner
          title={t("trialTitle")}
          description={t("trialDesc")}
          actionLabel={t("upgradeNow")}
          action={{ type: "button", onClick: () => setShowPlanModal(true) }}
        />
      )}

      {/* Company Profile */}
      <Card className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={clsx(styles.iconBox, styles.iconBoxBlue)}>
            <Building2 size={20} className={styles.iconBlue} />
          </div>
          <h3 className={styles.cardTitle}>{t("companyProfile")}</h3>
        </div>
        <div className={styles.formStack}>
          <Input
            label={t("companyName")}
            value={company.name}
            disabled={readonly}
            onChange={(e) =>
              setCompany((prev) => ({ ...prev, name: e.target.value }))
            }
          />
          <div className={styles.twoCol}>
            <Select
              label={t("industry")}
              options={[
                t("industries.manufacturing"),
                t("industries.it"),
                t("industries.retail"),
                t("industries.construction"),
                t("industries.transport"),
                t("industries.healthcare"),
                t("industries.financial"),
                t("industries.other"),
              ]}
              value={company.industry}
              disabled={readonly}
              onChange={(e) =>
                setCompany((prev) => ({ ...prev, industry: e.target.value }))
              }
            />
            <Select
              label={t("country")}
              options={[
                t("countries.slovenia"),
                t("countries.austria"),
                t("countries.germany"),
                t("countries.croatia"),
                t("countries.italy"),
                t("countries.czech"),
                t("countries.slovakia"),
                t("countries.hungary"),
              ]}
              value={company.country}
              disabled={readonly}
              onChange={(e) =>
                setCompany((prev) => ({ ...prev, country: e.target.value }))
              }
            />
          </div>
          <div className={styles.twoCol}>
            <Input
              label={t("naceCode")}
              value={company.nace_code}
              disabled={readonly}
              onChange={(e) =>
                setCompany((prev) => ({ ...prev, nace_code: e.target.value }))
              }
            />
            <Input
              label={t("employees")}
              type="number"
              value={String(company.headcount)}
              disabled={readonly}
              onChange={(e) =>
                setCompany((prev) => ({
                  ...prev,
                  headcount: parseInt(e.target.value) || 0,
                }))
              }
            />
          </div>
          <div className={styles.twoCol}>
            {/* Default operational currency for money-denominated data entry
                (Scope-3 spend, §Q3-FX/D8). NOT billing — plans stay EUR. Options
                come from the seeded `currencies`; the server re-validates on save. */}
            <Select
              label={t("defaultCurrency")}
              options={currencyOptions.map((c) => ({
                value: c.code,
                label: `${c.code} — ${c.name}`,
              }))}
              value={company.currency}
              disabled={readonly}
              onChange={(e) =>
                setCompany((prev) => ({ ...prev, currency: e.target.value }))
              }
            />
          </div>
          {readonly && (
            <p className={styles.readonlyHint}>
              <Lock size={12} /> {t("readonlyHint")}
            </p>
          )}
        </div>
      </Card>

      {/* Team */}
      <Card className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={clsx(styles.iconBox, styles.iconBoxViolet)}>
            <Users size={20} className={styles.iconViolet} />
          </div>
          <h3 className={styles.cardTitle}>{t("teamMembers")}</h3>
          <Badge variant="gray" size="sm">
            {features.maxTeamMembers === -1
              ? t("unlimited")
              : t("maxMembers", { count: features.maxTeamMembers })}
          </Badge>
        </div>
        {/* Over-seat banner (§10.3, R-5): the company has more active members than
            its plan allows — surfaced from the server-computed `seats.overLimit`,
            never recomputed client-side. */}
        {seats?.overLimit && (
          <div role="status" className={styles.overSeatBanner}>
            <ShieldAlert size={16} className={styles.overSeatIcon} />
            <span>
              {t("team.overSeat", {
                used: seats.used,
                limit: seats.limit,
              })}
            </span>
          </div>
        )}
        {membersAccessChanged ? (
          // R-11: a 403/401 on the roster is session-cache drift, not a crash —
          // explain it benignly. The server is the source of truth (§0.1).
          <p role="alert" className={styles.accessBanner}>
            {t("team.accessChanged")}
          </p>
        ) : membersLoading ? (
          <p className={styles.mutedNote}>{t("team.loadingMembers")}</p>
        ) : membersLoadError ? (
          // A transport/500 failure — distinct from an empty roster so an outage
          // never reads as "you have no teammates".
          <p role="alert" className={styles.rowError}>
            {t("team.loadMembersError")}
          </p>
        ) : (
          <div className={styles.rowStack}>
            {members.map((member) => (
              <TeamMemberRow
                key={member.userId}
                member={member}
                canManage={canManageMembers}
                isSelf={member.userId === currentUserId}
                onChangeRole={changeRole}
                onRemove={removeMember}
              />
            ))}
            {members.length === 0 && (
              <p className={styles.mutedNote}>{t("team.noMembers")}</p>
            )}
          </div>
        )}
        {/* Grant disclosure (R-7). Visible ONLY when the D13 grant is live for
            THIS viewer (`selfApproves`: they hold `data.approve` and the company
            has no independent approver), so this member approves their own data and
            it is disclosed in the report. Hidden once a real approver exists —
            otherwise the "approve" button disappearing later looks like a bug. */}
        {selfApproves && (
          <div className={styles.grantDisclosure}>
            <Info size={16} className={styles.grantDisclosureIcon} />
            <span>{t("team.grantDisclosure")}</span>
          </div>
        )}

        {/* Invitations — gated on `members.manage` (§0.1, UX only; the route
            enforces). Users without the capability keep the read-only roster. */}
        {canManageMembers && (
          <TeamInvite
            invitations={invitations}
            loading={invitesLoading}
            accessChanged={invitesAccessChanged}
            loadError={invitesLoadError}
            onIssue={issueInvite}
            onResend={resendInvite}
            onRevoke={revokeInvite}
            onUpgrade={() => setShowPlanModal(true)}
          />
        )}
      </Card>

      {/* Billing & Plan */}
      <Card className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={clsx(styles.iconBox, styles.iconBoxGreen)}>
            <CreditCard size={20} className={styles.iconGreen} />
          </div>
          <div className={styles.headerGrow}>
            <h3 className={styles.cardTitle}>{t("billingPlan")}</h3>
          </div>
          <Badge variant={getPlanBadgeVariant(plan)} size="md">
            {currentPlanInfo.name.toUpperCase()}
          </Badge>
        </div>

        {/* Current plan info */}
        <div className={styles.currentPlan}>
          <div className={styles.currentPlanRow}>
            <div>
              <p className={styles.planName}>
                {t("planNameSuffix", { name: currentPlanInfo.name })}
              </p>
              <p className={styles.planHighlight}>
                {t(`planHighlight.${currentPlanInfo.id}`)}
              </p>
            </div>
            <div className={styles.planPriceCol}>
              <p className={styles.planPrice}>
                {currentPlanInfo.price === 0
                  ? t("free")
                  : `\u20AC${currentPlanInfo.price}`}
              </p>
              <p className={styles.planPeriod}>
                {currentPlanInfo.id === "trial"
                  ? t("planPeriod.trial")
                  : t("planPeriod.monthly")}
              </p>
            </div>
          </div>
        </div>

        {/* Live subscription state (renewal / cancel / scheduled downgrade) */}
        {subscription && (
          <div className={styles.subState}>
            <div>
              {subscription.cancelAtPeriodEnd ? (
                <p className={clsx(styles.subStateNote, styles.subStateWarn)}>
                  {t("subCancelsOn", {
                    date: fmtDate(subscription.currentPeriodEnd),
                  })}
                </p>
              ) : subscription.pendingPlanId ? (
                <p className={clsx(styles.subStateNote, styles.subStateWarn)}>
                  {t("subDowngradesAt", {
                    name: getPlanFeatures(subscription.pendingPlanId).name,
                    date: fmtDate(subscription.currentPeriodEnd),
                  })}
                </p>
              ) : (
                <p className={styles.subStateNote}>
                  {t("subRenewsOn", {
                    date: fmtDate(subscription.currentPeriodEnd),
                    period: periodLabel(subscription.period),
                  })}
                </p>
              )}
            </div>
            <div className={styles.subActions}>
              {subscription.cancelAtPeriodEnd || subscription.pendingPlanId ? (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={subBusy}
                  onClick={handleResume}
                >
                  <RotateCcw size={14} className={styles.btnArrowIcon} />{" "}
                  {t("resumePlan")}
                </Button>
              ) : (
                isPaidPlan && (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={subBusy}
                    onClick={handleCancel}
                  >
                    {t("cancelPlan")}
                  </Button>
                )
              )}
            </div>
          </div>
        )}

        {/* Feature summary */}
        <div className={styles.featureGrid}>
          {[
            { label: t("featScope3"), ok: features.scope3 },
            { label: t("featSocial"), ok: features.socialParams },
            { label: t("featGovernance"), ok: features.governanceParams },
            { label: t("featSupplyChain"), ok: features.supplyChain },
            { label: t("featGoals"), ok: features.goals },
            { label: t("featDataExport"), ok: features.dataExport },
          ].map((f) => (
            <div key={f.label} className={styles.featureLine}>
              {f.ok ? (
                <CheckCircle2 size={14} className={styles.iconOk} />
              ) : (
                <AlertCircle size={14} className={styles.iconOff} />
              )}
              <span
                className={
                  f.ok ? styles.featureLabelOk : styles.featureLabelOff
                }
              >
                {f.label}
              </span>
            </div>
          ))}
        </div>

        <Button
          variant="primary"
          size="sm"
          onClick={() => setShowPlanModal(true)}
        >
          {plan === "enterprise" ? t("managePlan") : t("changePlan")}
        </Button>
      </Card>

      {/* Plan Selection Modal */}
      {showPlanModal && (
        <div
          className={styles.modalOverlay}
          onClick={() => setShowPlanModal(false)}
        >
          <div
            className={styles.modalPanel}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className={styles.modalTitle}>{t("modalTitle")}</h2>
            <p className={styles.modalSubtitle}>{t("modalSubtitle")}</p>

            {subscription && subscription.period !== "annual" && (
              <p className={styles.modalSubtitle}>
                {t("periodLocked", {
                  period: periodLabel(subscription.period),
                })}
              </p>
            )}

            <div className={styles.twoCol}>
              {PLAN_LIST.map((p) => {
                const isCurrent = p.id === plan;
                const planFeatures = PLAN_FEATURES[p.id];
                return (
                  <div
                    key={p.id}
                    className={
                      isCurrent ? styles.planCardCurrent : styles.planCard
                    }
                  >
                    <div className={styles.planCardHeader}>
                      <h3 className={styles.planCardTitle}>{p.name}</h3>
                      {isCurrent && (
                        <Badge variant="blue">{t("current")}</Badge>
                      )}
                    </div>
                    <div className={styles.planCardPriceRow}>
                      <span className={styles.planCardPrice}>
                        {p.id === "trial"
                          ? t("free")
                          : `\u20AC${
                              period === "annual"
                                ? annualPrice(getPlanFeatures(p.id).price)
                                : getPlanFeatures(p.id).price
                            }`}
                      </span>
                      <span className={styles.planCardPeriod}>
                        {p.id === "trial"
                          ? t("planPeriod.trial")
                          : period === "annual"
                            ? t("planPeriod.annual")
                            : t("planPeriod.monthly")}
                      </span>
                    </div>
                    <p className={styles.planCardHighlight}>
                      {t(`planHighlight.${p.id}`)}
                    </p>
                    <div className={styles.planCardFeatures}>
                      <FeatureLine ok={true} label={t("scope12")} />
                      <FeatureLine
                        ok={planFeatures.scope3}
                        label={t("featScope3")}
                      />
                      <FeatureLine
                        ok={planFeatures.socialParams}
                        label={t("featSocial")}
                      />
                      <FeatureLine
                        ok={planFeatures.governanceParams}
                        label={t("featGovernance")}
                      />
                      <FeatureLine
                        ok={planFeatures.supplyChain}
                        label={t("featSupplyChain")}
                      />
                      <FeatureLine
                        ok={planFeatures.goals}
                        label={t("featGoals")}
                      />
                      <FeatureLine
                        // О-15 (T5.8): the pricing card used to count the
                        // `reports` frameworks a plan sold. Phase 1 sells ONE
                        // report and prices its FORMATS (PG-2), so the line
                        // counts those — trial gets pdf only, every paid plan
                        // adds xlsx, and `> 1` is what makes that visible.
                        ok={planFeatures.reportFormats.length > 1}
                        label={t("reportFormats", {
                          count: planFeatures.reportFormats.length,
                        })}
                      />
                    </div>
                    {isCurrent ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className={styles.fullBtn}
                        disabled
                      >
                        {t("currentPlanBtn")}
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        size="sm"
                        className={styles.fullBtn}
                        loading={changingPlan === p.id}
                        onClick={() => handlePlanChange(p.id)}
                      >
                        {transitionKind(plan, p.id) === "downgrade"
                          ? t("downgradeToPlan", { name: p.name })
                          : transitionKind(plan, p.id) === "upgrade"
                            ? t("upgradeToPlan", { name: p.name })
                            : t("switchToPlan", { name: p.name })}
                        <ArrowRight size={14} className={styles.btnArrowIcon} />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>

            {modalMsg && <p className={styles.modalNote}>{modalMsg}</p>}

            <div className={styles.modalActions}>
              <Button variant="ghost" onClick={() => setShowPlanModal(false)}>
                {t("close")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Language */}
      <Card className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={clsx(styles.iconBox, styles.iconBoxBlue)}>
            <Globe size={20} className={styles.iconBlue} />
          </div>
          <h3 className={styles.cardTitle}>{t("langRegion")}</h3>
        </div>
        <div className={styles.twoCol}>
          <Select
            label={t("interfaceLang")}
            options={locales.map((l) => ({ value: l, label: localeNames[l] }))}
            value={locale}
            disabled={languagePending}
            onChange={(event) => {
              const next = event.target.value as Locale;
              if (!next || next === locale) return;
              startLanguageTransition(() => {
                router.replace(pathname, { locale: next });
              });
            }}
          />
        </div>
        {/* The report language is chosen per report, on «Reports» (en | sl,
            О-14); a second control here would be one that changes nothing. */}
        <p className={styles.mutedNote}>{t("reportLangNote")}</p>
        <p className={styles.mutedNote}>
          <CookieSettingsLink />
        </p>
      </Card>

      {/* Data Integrations — mock, hidden (SHOW_MOCK_INTEGRATIONS) */}
      {SHOW_MOCK_INTEGRATIONS && (
        <Card className={styles.card}>
          <div className={styles.cardHeaderTight}>
            <div className={clsx(styles.iconBox, styles.iconBoxViolet)}>
              <Link2 size={20} className={styles.iconViolet} />
            </div>
            <div className={styles.headerGrow}>
              <h3 className={styles.cardTitle}>{t("dataIntegrations")}</h3>
              <p className={styles.headerSubtitle}>
                {t("integrationsSubtitle")}
              </p>
            </div>
          </div>
          <div className={styles.integrationStack}>
            {INTEGRATIONS.map((intg) => {
              const isLocked = !features.integrations.includes(intg.tier);
              return (
                <div
                  key={intg.id}
                  className={clsx(
                    styles.integrationRow,
                    intg.connected
                      ? styles.integrationRowConnected
                      : isLocked
                        ? styles.integrationRowLocked
                        : styles.integrationRowDefault,
                  )}
                >
                  <div
                    className={clsx(
                      styles.integrationIconBox,
                      intg.connected
                        ? styles.integrationIconBoxConnected
                        : isLocked
                          ? styles.integrationIconBoxLocked
                          : styles.integrationIconBoxDefault,
                    )}
                  >
                    {intg.type === "OCR + AI" ? (
                      <FileText
                        size={18}
                        className={
                          intg.connected ? styles.iconGreen : styles.iconGray
                        }
                      />
                    ) : intg.type === "File" ? (
                      <Upload
                        size={18}
                        className={
                          intg.connected ? styles.iconGreen : styles.iconGray
                        }
                      />
                    ) : (
                      <Zap
                        size={18}
                        className={
                          intg.connected
                            ? styles.iconGreen
                            : isLocked
                              ? styles.iconOff
                              : styles.iconBlue
                        }
                      />
                    )}
                  </div>
                  <div className={styles.rowMain}>
                    <p className={styles.rowTitle}>{intg.name}</p>
                    <p className={styles.rowSubtitle}>
                      {t(`integrationDesc.${intg.id}`)} &middot; {intg.type}
                    </p>
                  </div>
                  {intg.connected ? (
                    <div className={styles.connectedTag}>
                      <CheckCircle2 size={14} />
                      <span className={styles.connectedTagText}>
                        {t("connected")}
                      </span>
                    </div>
                  ) : isLocked ? (
                    <Badge variant="gray" size="sm">
                      {intg.tier.toUpperCase()}
                    </Badge>
                  ) : (
                    <Button variant="secondary" size="sm">
                      {t("connect")}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Invoice Scanner — mock, hidden (SHOW_MOCK_INTEGRATIONS) */}
      {SHOW_MOCK_INTEGRATIONS && (
        <Card className={styles.card}>
          <div className={styles.cardHeaderMd}>
            <div className={clsx(styles.iconBox, styles.iconBoxBlue)}>
              <FileText size={20} className={styles.iconBlue} />
            </div>
            <div className={styles.headerGrow}>
              <h3 className={styles.cardTitle}>{t("invoiceScanner")}</h3>
              <p className={styles.headerSubtitle}>{t("scannerSubtitle")}</p>
            </div>
          </div>

          <div className={styles.dropzone}>
            <Upload size={32} className={styles.dropzoneIcon} />
            <p className={styles.dropzoneTitle}>{t("dropzoneTitle")}</p>
            <p className={styles.dropzoneSubtitle}>{t("dropzoneSubtitle")}</p>
          </div>

          <div className={styles.uploadsSection}>
            <p className={styles.uploadsHeading}>{t("recentUploads")}</p>
            {[
              {
                name: "Elektro_Ljubljana_Jan2025.pdf",
                type: "Electricity bill",
                status: "approved",
                kwh: "35,200 kWh",
                co2: `7.46 ${UNITS.tCO2e}`,
              },
              {
                name: "Petrol_Fleet_Card_Q4.pdf",
                type: "Fleet fuel card",
                status: "review",
                kwh: "2,840 L diesel",
                co2: `7.14 ${UNITS.tCO2e}`,
              },
              {
                name: "Lufthansa_Invoice_0392.pdf",
                type: "Travel invoice",
                status: "extracted",
                kwh: "3 flights",
                co2: `1.82 ${UNITS.tCO2e}`,
              },
            ].map((doc) => (
              <div key={doc.name} className={styles.uploadRow}>
                <FileText size={16} className={styles.iconMuted} />
                <div className={styles.uploadMain}>
                  <p className={styles.uploadName}>{doc.name}</p>
                  <p className={styles.uploadMeta}>
                    {doc.type} &middot; {doc.kwh}
                  </p>
                </div>
                <div className={styles.uploadRight}>
                  <p className={styles.uploadCo2}>{doc.co2}</p>
                  <div className={styles.uploadStatus}>
                    {doc.status === "approved" ? (
                      <>
                        <CheckCircle2
                          size={10}
                          className={styles.iconStatusApproved}
                        />
                        <span
                          className={clsx(
                            styles.statusText,
                            styles.statusApproved,
                          )}
                        >
                          {t("statusApproved")}
                        </span>
                      </>
                    ) : doc.status === "review" ? (
                      <>
                        <AlertCircle
                          size={10}
                          className={styles.iconStatusReview}
                        />
                        <span
                          className={clsx(
                            styles.statusText,
                            styles.statusReview,
                          )}
                        >
                          {t("statusReview")}
                        </span>
                      </>
                    ) : (
                      <>
                        <Zap size={10} className={styles.iconStatusExtracted} />
                        <span
                          className={clsx(
                            styles.statusText,
                            styles.statusExtracted,
                          )}
                        >
                          {t("statusExtracted")}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className={styles.saveRow}>
        <Button
          size="lg"
          onClick={handleSaveCompany}
          loading={saving}
          disabled={readonly}
        >
          <Save size={18} className={styles.saveIcon} /> {t("saveSettings")}
        </Button>
      </div>
    </PageLayout>
  );
}
