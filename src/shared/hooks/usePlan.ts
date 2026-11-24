"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/shared/api/client";
import type { ActionResult } from "@/server/actions/types";
import type { Entitlements, SubscriptionState } from "@/server/billing/guard";
import {
  getPlanFeatures,
  type PlanId,
  type PlanFeatures,
} from "@/shared/plans";
import { useSession, SESSION_QUERY_KEY } from "./useSession";

/** The four transitions the `/api/billing/subscription` engine (T-C2) accepts. */
type TransitionAction = "upgrade" | "downgrade" | "cancel" | "resume";
export type BillingPeriod = "monthly" | "annual";

/**
 * The `data` payloads the subscription engine returns, unioned. The caller branches
 * on which key is present: `applied` (upgrade charged/free → refetch), `needsCheckout`
 * (route to /billing), `scheduled` (downgrade at EOP), `cancelAtPeriodEnd`/`resumed`.
 */
type TransitionData =
  | { applied: true }
  | { needsCheckout: true; plan: PlanId; period: BillingPeriod }
  | { scheduled: true }
  | { cancelAtPeriodEnd: true }
  | { resumed: true };

/** ActionResult-shaped body of `/api/billing/subscription` (raw JSON, not thrown). */
type TransitionResult =
  { ok: true; data: TransitionData } | { ok: false; error: string };

interface PlanState {
  plan: PlanId;
  features: PlanFeatures;
  mode: Entitlements["mode"];
  subscription: SubscriptionState | null;
  companyId: string | null;
  companyName: string;
  loading: boolean;
  userId: string | null;
  changePlan: (newPlan: PlanId) => Promise<boolean>;
  transition: (
    action: TransitionAction,
    plan?: PlanId,
    period?: BillingPeriod,
  ) => Promise<TransitionResult>;
}

export function usePlan(): PlanState {
  const queryClient = useQueryClient();
  const { data, isLoading } = useSession();
  const company = data?.company ?? null;
  const plan = (company?.plan || "trial") as PlanId;

  const mutation = useMutation({
    mutationFn: async (newPlan: PlanId) => {
      if (!company?.id) throw new Error("No company");
      // T-22 (§1.5, §4.3): мутация ушла с server action `changePlan` на HTTP —
      // `POST /api/company/plan` (T-21). UPDATE companies по-прежнему не из
      // браузера. Эндпоинт отдаёт ActionResult<{plan}> телом (apiFetch не бросает
      // на не-2xx) — маппим ok:false в throw, чтобы внешний контракт
      // (changePlan → Promise<boolean>) не изменился.
      const result = await apiFetch<ActionResult<{ plan: PlanId }>>(
        "/api/company/plan",
        { method: "POST", body: JSON.stringify({ plan: newPlan }) },
      );
      if (!result.ok) throw new Error(`Plan change failed: ${result.error}`);
      return newPlan;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    },
  });

  const changePlan = async (newPlan: PlanId): Promise<boolean> => {
    try {
      await mutation.mutateAsync(newPlan);
      return true;
    } catch (e) {
      console.error("Plan change error:", e);
      return false;
    }
  };

  // T-C3 (§8): drive a REAL subscription transition through the T-C2 engine. Unlike
  // `changePlan` (the instant denormalized flip), this prorates/schedules server-side
  // and can require checkout. Returns the raw ActionResult-shaped body so the caller
  // branches on `applied`/`needsCheckout`/`scheduled`. On any success we invalidate
  // the session so `plan`/`mode`/`subscription` refetch (a live upgrade is immediate;
  // a cancel/downgrade updates the scheduled flags). Money is NEVER sent — only
  // `{action, plan?, period?}`; the server re-prices from `plan_prices`.
  const transition = async (
    action: TransitionAction,
    targetPlan?: PlanId,
    period?: BillingPeriod,
  ): Promise<TransitionResult> => {
    const result = await apiFetch<TransitionResult>(
      "/api/billing/subscription",
      {
        method: "POST",
        body: JSON.stringify({ action, plan: targetPlan, period }),
      },
    );
    if (result.ok) {
      queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    }
    return result;
  };

  return {
    plan,
    // T-A3 (§6.3, §13.4): prefer the server-resolved `features` from `/api/session`
    // (client & server then decide on the SAME matrix — the plan can't be faked
    // client-side). Fall back to the local `getPlanFeatures(plan)` when the field
    // is absent (older/cached response or logged-out) — the current behaviour.
    features: data?.features ?? getPlanFeatures(plan),
    // T-C3 (§9): the entitlement mode drives the readonly UI mirror; absent (logged
    // out / cached) → treat as `active` (no false lock).
    mode: data?.mode ?? "active",
    subscription: data?.subscription ?? null,
    companyId: company?.id ?? null,
    companyName: company?.name ?? "",
    loading: isLoading,
    userId: data?.userId ?? null,
    changePlan,
    transition,
  };
}
