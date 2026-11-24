/**
 * GET /api/currencies — the seeded ISO-4217 currency reference list (T2.5, §Q3-FX).
 *
 * The lightest DB-sourced feed for the Settings company-default-currency dropdown:
 * the same `listCurrencies` set the server validates a write against, so the UI can
 * never offer a code the PATCH would reject. Session-guarded (a logged-out request
 * gets no reference data); read-only, no entitlement gate — the currency catalogue
 * is reference data, not tenant data. Response: `ActionResult<CurrencyRow[]>`.
 * PATTERN 2 (CORS): every response + OPTIONS preflight.
 */
import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { listCurrencies } from "@/server/db/fx";

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const currencies = await listCurrencies(db);
  return apiResult(req, { ok: true, data: currencies });
});

export const OPTIONS = optionsHandler;
