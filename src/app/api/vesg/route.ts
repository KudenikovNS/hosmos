/**
 * GET /api/vesg — the VESG-voucher checklist of the company (plan item 8.4):
 * the 16 requirements of the expert's sheet, judged from the data, plus the
 * stored confirmations of the four manual ones. Read-only, `data.read`.
 */
import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { requireCapability } from "@/server/auth/capabilities";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { loadVesg } from "@/server/vesg/vesg";

export const GET = apiRoute(async (req) => {
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });
  const company = session.company;
  if (!company)
    return apiResult(req, { ok: false, error: "COMPANY_NOT_FOUND" });

  const forbidden = requireCapability(session, "data.read");
  if (forbidden) return apiResult(req, forbidden);

  return apiResult(req, {
    ok: true,
    data: await loadVesg(db, company.id, {
      canConfirm: session.capabilities?.includes("data.write") ?? false,
    }),
  });
});

export const OPTIONS = optionsHandler;
