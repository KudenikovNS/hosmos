/**
 * POST /api/leads — the landing page's two lead forms (ТЗ §11).
 *
 * The endpoint is PUBLIC and UNAUTHENTICATED, which makes it the only route in
 * this app that a stranger can write to. Everything unusual about it follows
 * from that one fact:
 *
 *   • Success means SAVED. §16: "success отправляется только после сохранения
 *     лида". The handler answers `{ok:true}` after the INSERT returns, never
 *     before, and an INSERT failure is a `PERSIST_FAILED` the form shows as an
 *     error. A visitor is never told we have their enquiry when we do not.
 *
 *   • Validation is repeated, not trusted. The browser validated already; that
 *     was for the visitor's benefit. `validateLead` runs again here because the
 *     browser is not a security boundary.
 *
 *   • The honeypot answers `{ok:true}` and writes nothing. Telling a bot it was
 *     detected is free tuition — see `honeypotTripped`.
 *
 *   • Rate limiting counts rows, not memory. An in-process counter is worthless
 *     on the target host, where Passenger runs several workers each with their
 *     own module state (see `server/db/index.ts`): a flood simply lands on the
 *     other worker. Counting recent `marketing_lead` rows by `ip_hash` is shared
 *     by construction and needs no extra infrastructure.
 *
 *   • The client IP is hashed, never stored. Rate limiting needs to recognise a
 *     repeat sender, not to identify a person.
 *
 * PATTERN 2 (CORS) applies as it does to every route here: responses go through
 * `apiResult` and `OPTIONS` is exported.
 */
import { createHash } from "node:crypto";

import { and, eq, gt, sql } from "drizzle-orm";

import {
  apiResult,
  apiRoute,
  apiValidationDetail,
  optionsHandler,
} from "@/server/api/handler";
import { db } from "@/server/db";
import { marketingLead } from "@/server/db/schema";
import {
  enumValue,
  honeypotTripped,
  isValid,
  str,
  validateLead,
  type LeadFormType,
} from "@/server/leads/validate";

/**
 * Which iteration of the page produced a lead (§11 `landing_version`), as an
 * ALLOW-LIST rather than a constant.
 *
 * Two landing variants are live at once — `/vsme` and `/vsme/v2` — and the whole
 * point of running both is being able to ask later which one produced better
 * leads. That question is unanswerable if every row records the same version, so
 * the client names its own variant. It is still an allow-list and not a
 * pass-through: this is a public endpoint, and a free-text version column is a
 * free-text column a stranger can write into.
 */
const LANDING_VERSIONS = ["vsme-1.0", "vsme-2.0"] as const;
const DEFAULT_LANDING_VERSION = LANDING_VERSIONS[0];

/** The submitted variant, or the default when it is absent or not recognised. */
function landingVersion(value: unknown): string {
  const candidate = str(value);
  return (LANDING_VERSIONS as readonly string[]).includes(candidate ?? "")
    ? candidate!
    : DEFAULT_LANDING_VERSION;
}

/** Max submissions per hashed IP per window, and the window itself. */
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MINUTES = 30;

/** The five UTM keys §12 allows; anything else in the query string is ignored. */
const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;

/**
 * Salted SHA-256 of the client IP. The salt lives in `LEAD_IP_SALT`; without it
 * the hash of an IPv4 address is trivially reversible by enumerating all four
 * billion of them, which would make "we do not store IPs" untrue. A missing salt
 * therefore disables IP hashing entirely (returns null) rather than storing a
 * reversible digest — the rate limiter degrades, the privacy promise does not.
 */
function hashIp(ip: string | null): string | null {
  const salt = process.env.LEAD_IP_SALT;
  if (!ip || !salt) return null;
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

/**
 * Best-effort client IP. Behind the cPanel/Passenger proxy the socket address is
 * the proxy's, so `x-forwarded-for`'s FIRST entry is the closest thing to the
 * caller. It is spoofable — which is fine here, because the value is only ever
 * used to throttle and never to authorise or to identify.
 */
function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip");
}

/** Origin of a referrer URL — never the full URL (§11: no PII in attribution). */
function referrerOrigin(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** Keep only the five standard UTM keys, each capped, from the submitted object. */
function pickUtm(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    const v = str(source[key]);
    if (v) out[key] = v.slice(0, 120);
  }
  return out;
}

/** Has this sender exceeded the window? A DB error here is treated as "no". */
async function rateLimited(ipHash: string | null): Promise<boolean> {
  if (!ipHash) return false;
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60_000);
  try {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(marketingLead)
      .where(
        and(
          eq(marketingLead.ipHash, ipHash),
          gt(marketingLead.createdAt, since),
        ),
      );
    return (row?.count ?? 0) >= RATE_LIMIT_MAX;
  } catch {
    // A throttle that fails closed would take the contact form down with the
    // database's first hiccup. The INSERT below will fail loudly anyway if the
    // database is genuinely unavailable, so failing open costs nothing.
    return false;
  }
}

export const POST = apiRoute(async (req) => {
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) return apiResult(req, { ok: false, error: "VALIDATION" });

  const formType: LeadFormType = body.formType === "vesg" ? "vesg" : "demo";

  // The honeypot is checked FIRST and answers exactly like a success: no write,
  // no error, nothing for a bot to learn from.
  if (honeypotTripped(body)) return apiResult(req, { ok: true, data: null });

  const errors = validateLead(formType, body);
  if (!isValid(errors)) {
    // 422 carrying the field map, so the form can mark each field and move focus
    // to the first invalid one (§13). `apiValidationDetail` is the sanctioned way
    // to add detail to a VALIDATION refusal without widening `ApiResult`.
    return apiValidationDetail(req, { errors });
  }

  const ipHash = hashIp(clientIp(req));
  if (await rateLimited(ipHash)) {
    return apiResult(req, { ok: false, error: "RATE_LIMITED" });
  }

  const now = new Date();
  try {
    await db.insert(marketingLead).values({
      formType,
      fullName: str(body.fullName)!,
      email: str(body.email)!.toLowerCase(),
      company: str(body.company)!,

      country: str(body.country) ?? null,
      entityCount: enumValue("entityCount", body.entityCount) ?? null,
      siteCount: str(body.siteCount) ?? null,
      interest: enumValue("interest", body.interest) ?? null,

      inSlovenia: enumValue("inSlovenia", body.inSlovenia) ?? null,
      companySize: enumValue("companySize", body.companySize) ?? null,
      hasEmployee: enumValue("hasEmployee", body.hasEmployee) ?? null,
      reportingPeriod: str(body.reportingPeriod) ?? null,

      comment: str(body.comment) ?? null,

      // `selected_plan` carries the pricing card the visitor clicked, so a lead
      // arrives with the offer it came from attached (§11 routes).
      selectedPlan: enumValue("interest", body.selectedPlan) ?? null,
      leadSource: "landing",
      landingVersion: landingVersion(body.landingVersion),
      locale: str(body.locale)?.slice(0, 8) ?? "sl",
      referrerOrigin: referrerOrigin(body.referrer),
      utm: pickUtm(body.utm),

      // Consent timestamps are stamped SERVER-side. A client-supplied consent
      // time is not evidence of anything — it is a number the client chose.
      consentPrivacyAt: now,
      consentMarketingAt: body.consentMarketing === true ? now : null,

      ipHash,
    });
  } catch (error) {
    console.error("[leads] insert failed", error);
    return apiResult(req, { ok: false, error: "PERSIST_FAILED" });
  }

  // Only now is the lead real, and only now does the visitor see "sent".
  return apiResult(req, { ok: true, data: null });
});

export const OPTIONS = optionsHandler;
