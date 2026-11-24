// T-A3 / T-C3 (§6.3, §9): `/api/session` serves the server-resolved plan `features`
// as an ADDITIVE sibling of `DbSession` (never inside `DbCompany`), plus the
// entitlement `mode` and the live `subscription` state. DB-free: `getSession` and
// the guard (`getEntitlements`/`getLiveSubscription`) are mocked, so this runs green
// without Postgres and pins the additive contract + the DbSession preservation.
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getSessionMock = vi.fn();
vi.mock("@/server/auth/session", () => ({
  getSession: () => getSessionMock(),
}));

const getEntitlementsMock = vi.fn();
const getLiveSubscriptionMock = vi.fn();
vi.mock("@/server/billing/guard", () => ({
  getEntitlements: (s: unknown) => getEntitlementsMock(s),
  getLiveSubscription: (id: string) => getLiveSubscriptionMock(id),
}));

import { GET as sessionGET } from "@/app/api/session/route";
import { PLAN_FEATURES, type PlanFeatures } from "@/shared/plans";
import type { DbCompany, DbSession } from "@/server/db/types";
import type { SubscriptionState } from "@/server/billing/guard";

const request = () =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new Request("http://api.example.com/api/session") as any;

function sessionWith(plan: string): DbSession {
  const company: DbCompany = {
    id: "c1",
    name: "Acme",
    industry: null,
    nace_code: null,
    country: null,
    country_code: null,
    headcount: null,
    plan,
    reporting_year: null,
    currency: null,
  };
  return { userId: "u1", email: "u@example.com", name: "U", company };
}

/** Mirror the guard: read-tier `features` + `mode` for the given plan. */
function entitlements(features: PlanFeatures, mode = "active" as const) {
  return { features, writeFeatures: features, mode };
}

beforeEach(() => {
  vi.clearAllMocks();
});

it("logged out → null (200), no features, guard never called", async () => {
  getSessionMock.mockResolvedValue(null);
  const res = await sessionGET(request());
  expect(res.status).toBe(200);
  expect(await res.json()).toBeNull();
  expect(getEntitlementsMock).not.toHaveBeenCalled();
  expect(getLiveSubscriptionMock).not.toHaveBeenCalled();
});

it("session + company → DbSession preserved AND additive features/mode/subscription", async () => {
  const sub: SubscriptionState = {
    status: "active",
    period: "monthly",
    cancelAtPeriodEnd: false,
    currentPeriodEnd: "2026-08-01T00:00:00.000Z",
    pendingPlanId: null,
  };
  getSessionMock.mockResolvedValue(sessionWith("pro"));
  getEntitlementsMock.mockResolvedValue(entitlements(PLAN_FEATURES.pro));
  getLiveSubscriptionMock.mockResolvedValue(sub);

  const res = await sessionGET(request());
  expect(res.status).toBe(200);
  const body = await res.json();

  // DbSession intact (features is a sibling, NOT inside company).
  expect(body.userId).toBe("u1");
  expect(body.company.plan).toBe("pro");
  expect(body.company).not.toHaveProperty("features");

  // Additive resolved fields from the subscription-aware guard.
  expect(body.features).toEqual(PLAN_FEATURES.pro);
  expect(body.mode).toBe("active");
  expect(body.subscription).toEqual(sub);
  expect(getEntitlementsMock).toHaveBeenCalledTimes(1);
  expect(getLiveSubscriptionMock).toHaveBeenCalledWith("c1");
});

it("lapsed company → readonly mode, no live subscription", async () => {
  getSessionMock.mockResolvedValue(sessionWith("trial"));
  // readonly: reads the last paid plan, mode is readonly, no live row.
  getEntitlementsMock.mockResolvedValue({
    features: PLAN_FEATURES.pro,
    writeFeatures: PLAN_FEATURES.trial,
    mode: "readonly",
  });
  getLiveSubscriptionMock.mockResolvedValue(null);

  const res = await sessionGET(request());
  const body = await res.json();
  expect(body.mode).toBe("readonly");
  expect(body.subscription).toBeNull();
  expect(body.features).toEqual(PLAN_FEATURES.pro);
});
