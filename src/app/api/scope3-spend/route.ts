/**
 * Scope-3 spend-line route (§Q3(b)/§Q3-FX, DATA-INTEGRITY-PLAN T2.4). The WRITE
 * side for the T1.5b spend engine: the client edits annual per-commodity spend
 * lines here, and the server applies the EXIOBASE factor + FX and recalculates.
 *
 * See docs/decisions/app-api-scope3-spend-route.md for the full account.
 */
import {
  apiResult,
  apiRoute,
  apiValidationDetail,
  optionsHandler,
} from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { requireFeature } from "@/server/billing/guard";
import { db } from "@/server/db";
import { logAudit } from "@/server/db/audit";
import { listCurrencies, resolveDefaultCurrency } from "@/server/db/fx";
import {
  deleteScope3SpendLine,
  getScope3Spend,
  upsertScope3SpendLine,
  type Scope3SpendLine,
} from "@/server/db/scope3-spend";
import {
  activeFactorSetId,
  factorSetInForce,
  listSpendCommodities,
  NO_SPEND_FACTORS,
  type Scope3Commodity,
  type SpendFactorSetRef,
} from "@/server/scope3/factors";
import { recalculateScope3Spend } from "@/server/scope3/recalculate";

/**
 * Why the editor cannot be used, when it cannot: the SAME named-refusal payload
 * the POST is refused with, handed to the GET so the screen can say it BEFORE a
 * user types a number into a form that is going to be refused.
 *
 * It is `null` on every ordinary read. The keys are the wire's own (`refusal` +
 * `factor_set`), so the screen classifies it with the shared `classifyRefusal`
 * rather than reading a second, GET-only shape.
 */
interface SpendRefusal {
  refusal: string;
  factor_set: SpendFactorSetRef | null;
}

/** The GET payload feeding the editor: lines + all dropdown inputs. */
interface Scope3SpendView {
  year: string;
  lines: Scope3SpendLine[];
  commodities: Scope3Commodity[];
  currencies: { code: string; name: string; symbol: string }[];
  defaultCurrency: string;
  /** Any warning from the last recalc (POST/DELETE), e.g. a missing FX rate (D4). */
  warnings: string[];
  /**
   * `NO_SPEND_FACTORS` + the set in force when no active factor set can price
   * spend; `null` otherwise. An empty `commodities` list is the SYMPTOM — this
   * is the reason, and the reason is what the screen renders.
   */
  spendRefusal: SpendRefusal | null;
}

/** 4-digit reporting year from `?year=`, else the session company's reporting year. */
function resolveYear(url: URL, fallback: string): string {
  const raw = url.searchParams.get("year");
  return raw && /^\d{4}$/.test(raw) ? raw : fallback;
}

/**
 * Recalculate so the spend change is reflected in `scope3_results` cats 1/2,
 * returning any D4 warnings (a currency with no FX rate, a commodity with no
 * factor). T3.6: this is the NARROW `recalculateScope3Spend` — it reads only
 * spend lines, factors and FX, so there is nothing left to fail on a company that
 * has no monthly activity data, and no `NoMonthlyDataError` to swallow. Empty
 * spend simply yields empty results.
 */
async function recalcAfterWrite(
  companyId: string,
  year: string,
): Promise<string[]> {
  const result = await recalculateScope3Spend(companyId, year);
  return result.warnings;
}

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  // Role gate (403) — every member has `data.read`; a future read-less role does not.
  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  const year = resolveYear(
    new URL(req.url),
    company.reporting_year ?? String(new Date().getFullYear()),
  );
  const [lines, spendSetId, commodities, currencyRows] = await Promise.all([
    getScope3Spend(db, company.id, year),
    activeFactorSetId(db),
    listSpendCommodities(db),
    listCurrencies(db),
  ]);
  // The one conditional branch of this feature: `activeFactorSetId` is `null`
  // exactly when NO active factor set carries per-€1000 spend factors. The set
  // in force is looked up ONLY on that branch — an ordinary read pays nothing.
  const spendRefusal: SpendRefusal | null =
    spendSetId === null
      ? {
          refusal: NO_SPEND_FACTORS,
          factor_set: await factorSetInForce(db, company.id, year),
        }
      : null;
  const view: Scope3SpendView = {
    year,
    lines,
    commodities,
    currencies: currencyRows.map((c) => ({
      code: c.code,
      name: c.name,
      symbol: c.symbol,
    })),
    defaultCurrency: resolveDefaultCurrency({ company }),
    warnings: [],
    spendRefusal,
  };
  return apiResult(req, { ok: true, data: view });
});

export const POST = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  // Role gate (403) BEFORE the paid-feature check (§7.1): a role that cannot write
  // is refused with 403, never offered an upgrade CTA (402) that would not help.
  const forbidden = requireCapability(session, "data.write");
  if (forbidden) return apiResult(req, forbidden);

  // Server-side entitlement gate: persisting spend requires the scope3 feature.
  const denied = await requireFeature(session, "scope3", { mutation: true });
  if (denied) return apiResult(req, denied);

  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body || typeof body !== "object")
    return apiResult(req, { ok: false, error: "VALIDATION" });

  const year = resolveYear(
    new URL(req.url),
    company.reporting_year ?? String(new Date().getFullYear()),
  );

  // NOTHING CAN PRICE SPEND AT ALL — refuse BY NAME, before the commodity is
  // even looked at. Every commodity key would fail the whitelist below (the
  // catalogue is empty), and a bare `VALIDATION` would tell the user their
  // commodity was wrong when nothing about their request was. The refusal keeps
  // its 422 and adds WHY plus the set it is talking about, so the screen renders
  // a sentence instead of a shrug (see {@link NO_SPEND_FACTORS}).
  if ((await activeFactorSetId(db)) === null) {
    return apiValidationDetail(req, {
      refusal: NO_SPEND_FACTORS,
      factor_set: await factorSetInForce(db, company.id, year),
    });
  }

  // commodity_key MUST be one of the seeded EXIOBASE spend commodities — this both
  // validates the input and DERIVES the category (1|2). A client-sent category /
  // factor / rate is never read (§0.4: the server is the source of truth).
  const commodityKey =
    typeof body.commodityKey === "string" ? body.commodityKey : "";
  const commodities = await listSpendCommodities(db);
  const commodity = commodities.find((c) => c.commodityKey === commodityKey);
  if (!commodity) return apiResult(req, { ok: false, error: "VALIDATION" });

  // spend_amount: finite ≥ 0.
  const spendAmount =
    typeof body.spendAmount === "number"
      ? body.spendAmount
      : Number(body.spendAmount);
  if (!Number.isFinite(spendAmount) || spendAmount < 0)
    return apiResult(req, { ok: false, error: "VALIDATION" });

  // currency: must be a seeded ISO-4217 code (the FK would reject otherwise, but we
  // validate up front so a bad code is a clean 422 rather than a 500).
  const currency =
    typeof body.currency === "string" ? body.currency.toUpperCase() : "";
  const currencyRows = await listCurrencies(db);
  if (!currencyRows.some((c) => c.code === currency))
    return apiResult(req, { ok: false, error: "VALIDATION" });

  const row = await upsertScope3SpendLine(db, company.id, year, {
    commodityKey: commodity.commodityKey,
    category: commodity.category, // derived, never from the body
    spendAmount,
    currency,
  });

  await logAudit(db, {
    companyId: company.id,
    userId: session.userId,
    actorRole: session.membership?.role ?? null,
    entity: "scope3_spend",
    entityId: row.id,
    action: "update",
    summary: {
      year,
      commodityKey: commodity.commodityKey,
      category: commodity.category,
      spendAmount,
      currency,
    },
  });

  // Recompute so the new spend lands in scope3_results cats 1/2. The factor
  // and FX are applied inside recalc (server-side); warnings (e.g. a missing FX rate,
  // D4) surface to the client.
  const warnings = await recalcAfterWrite(company.id, year);
  const lines = await getScope3Spend(db, company.id, year);
  return apiResult(req, { ok: true, data: { lines, warnings } });
});

export const DELETE = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  // Role gate (403) BEFORE the paid-feature check (§7.1).
  const forbidden = requireCapability(session, "data.write");
  if (forbidden) return apiResult(req, forbidden);

  const denied = await requireFeature(session, "scope3", { mutation: true });
  if (denied) return apiResult(req, denied);

  const url = new URL(req.url);
  const year = resolveYear(
    url,
    company.reporting_year ?? String(new Date().getFullYear()),
  );
  const id = url.searchParams.get("id") ?? undefined;
  const commodityKey = url.searchParams.get("commodityKey") ?? undefined;
  if (!id && !commodityKey)
    return apiResult(req, { ok: false, error: "VALIDATION" });

  // Pinned to the session company: a cross-tenant id/commodity deletes nothing.
  const deleted = await deleteScope3SpendLine(db, company.id, {
    id,
    year,
    commodityKey,
  });
  if (!deleted) return apiResult(req, { ok: false, error: "NO_DATA" });

  await logAudit(db, {
    companyId: company.id,
    userId: session.userId,
    actorRole: session.membership?.role ?? null,
    entity: "scope3_spend",
    entityId: id ?? null,
    action: "delete",
    summary: { year, commodityKey },
  });

  const warnings = await recalcAfterWrite(company.id, year);
  const lines = await getScope3Spend(db, company.id, year);
  return apiResult(req, { ok: true, data: { lines, warnings } });
});

export const OPTIONS = optionsHandler;
