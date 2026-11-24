/**
 * POST /api/register — create the company + link the profile (T-21, §3.4/§4.2).
 *
 * This is STEP 2 of registration. Step 1 (create the user) is done by better-auth
 * (`authClient.signUp.email`, T-23) BEFORE this endpoint is called, so the caller
 * already has a session. Replaces the second half of the old `signUp` server
 * action (`auth-actions.ts`): insert a `companies` row, then link the current
 * user's `profiles` row to it. The identity comes ONLY from `getSession()`
 * (PATTERN 3) — the userId is never taken from the client; the client supplies
 * only the company `name`.
 *
 * A FAILURE IS REPORTED (BUG-004, register-company-failure-reported-as-success):
 * the company, the owner membership and the profile link are one transaction, so
 * a failure leaves none of them behind and answers `PERSIST_FAILED` (500). The
 * account from step 1 stays — it is not rolled back — and the registration form
 * offers to retry this step, which is safe because of the rule below. (The old
 * signUp swallowed the error and returned success; the form then landed the
 * user on an empty workspace with no company.)
 *
 * ONCE PER ACCOUNT (F11, register-bypasses-max-companies): this is the only path
 * that creates a company, so an account that already belongs to one (any
 * membership not `removed`) gets that company back instead of a new one. A
 * repeated or replayed call is therefore a no-op, and the plan's `maxCompanies`
 * (1 on Trial/Starter) cannot be bypassed here. The account's `user` row is
 * locked `FOR UPDATE` for the check-then-insert, so concurrent calls serialise
 * and cannot each see "no company yet". An account whose only memberships are
 * `suspended` gets `FORBIDDEN` (403): it may not start a second company, and
 * it has no active one to return. Adding a further company on a plan that
 * allows it (Pro, Enterprise) is a separate, limit-checked path, not this one.
 *
 * Response: `ActionResult<{companyId}>` — `companyId` is the new company's id,
 * the account's existing company when it already has one, or `null` when no
 * company name was supplied; `PERSIST_FAILED` when the write failed. Rows are written via Drizzle
 * directly (T-20 pattern) so the route is harness-testable.
 * PATTERN 2 (CORS): every response + the OPTIONS preflight.
 */
import { and, asc, eq, ne } from "drizzle-orm";

import { apiResult, apiRoute, optionsHandler } from "@/server/api/handler";
import { getSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { companies, companyMembers, profiles, user } from "@/server/db/schema";

export const POST = apiRoute(async (req) => {
  // Identity from the session only (PATTERN 3) — the user just signed up.
  const session = await getSession();
  if (!session) return apiResult(req, { ok: false, error: "UNAUTHENTICATED" });

  const body = (await req.json().catch(() => ({}))) as { company?: unknown };
  const companyName =
    typeof body.company === "string" ? body.company.trim() : "";

  let companyId: string | null = null;
  // Only create a company when a name was given (1:1 with `if (data.user && company)`).
  if (companyName) {
    let outcome: string; // the company id, or "suspended"
    try {
      outcome = await db.transaction(async (tx) => {
        // Serialise this account's registrations (see the header): the lock is
        // held until commit, so a concurrent call waits and then sees the
        // membership written here.
        await tx
          .select({ id: user.id })
          .from(user)
          .where(eq(user.id, session.userId))
          .for("update");
        const existing = await tx
          .select({
            companyId: companyMembers.companyId,
            status: companyMembers.status,
          })
          .from(companyMembers)
          .where(
            and(
              eq(companyMembers.userId, session.userId),
              ne(companyMembers.status, "removed"),
            ),
          )
          .orderBy(asc(companyMembers.createdAt));
        const active = existing.find((m) => m.status === "active");
        if (active) return active.companyId;
        // Only suspended memberships: the account still counts as belonging
        // to a company (F11), but it has no workspace to hand back. Say so
        // rather than answer ok with a company the session will not show.
        if (existing.length > 0) return "suspended";

        const [row] = await tx
          .insert(companies)
          .values({ name: companyName })
          .returning();
        if (!row) throw new Error("company insert returned no row");
        // The registrant is the company's first member — its owner (esg_admin,
        // T1.4/§13.1). Membership is created in the SAME transaction as the
        // company itself, so a failure here rolls both back and is reported
        // below; the account itself stays. `accepted_at` is stamped now: this
        // is a self-join, not a pending invite. There are no other members yet,
        // so the D13 grant makes this solo esg_admin the independent approver
        // (data.approve).
        await tx.insert(companyMembers).values({
          companyId: row.id,
          userId: session.userId,
          role: "esg_admin",
          status: "active",
          acceptedAt: new Date(),
        });
        // Link the profile to the company; carry the display name from the
        // session, exactly as the old signUp set `full_name` during the link.
        // BOTH company columns point at the new company (D11): the newly-created
        // company is also the active one.
        await tx
          .update(profiles)
          .set({
            companyId: row.id,
            activeCompanyId: row.id,
            fullName: session.name,
          })
          .where(eq(profiles.id, session.userId));
        return row.id;
      });
    } catch (e) {
      // The transaction rolled back: nothing of the company is left. The
      // account stays, and the client offers to retry this step (see header).
      console.error("POST /api/register: company create/link failed:", e);
      return apiResult(req, { ok: false, error: "PERSIST_FAILED" });
    }
    if (outcome === "suspended") {
      return apiResult(req, { ok: false, error: "FORBIDDEN" });
    }
    companyId = outcome;
  }

  return apiResult(req, { ok: true, data: { companyId } });
});

export const OPTIONS = optionsHandler;
