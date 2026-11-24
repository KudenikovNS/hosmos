// Password-reset flow integration test — the full better-auth loop against a
// real Postgres via the T-13 harness:
//   sign-up → POST /request-password-reset → token lands in `verification`
//   (identifier `reset-password:<token>`, better-auth 1.6.23
//   dist/api/routes/password.mjs) → POST /reset-password with the new password
//   → sign-in with the OLD password fails, with the NEW one succeeds.
//
// The mailer is mocked (no SMTP in tests; we also assert the reset URL shape
// `${baseURL}/reset-password/<token>?callbackURL=...` that the email carries).
// `@/server/db` is mocked to the harness pool so better-auth's drizzleAdapter
// writes the same Postgres the assertions read.
//
// Gating: `describeIntegration` self-skips without a reachable DATABASE_URL.
// All auth imports are dynamic (inside beforeAll) because `@/server/auth`
// evaluates `drizzleAdapter(db, …)` at module scope — a static import would
// touch the mocked lazy `db` getter and throw in a DB-less CI even though the
// suite itself is skipped.
import { like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const sendMailMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/auth/mailer", () => ({
  sendMail: (input: unknown) => sendMailMock(input),
}));

vi.mock("@/server/db", async () => {
  const harness = await import("@/server/db/__tests__/harness");
  return {
    get db() {
      return harness.getTestDb();
    },
  };
});

import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";
import { verification } from "@/server/db/schema";

const BASE = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

type AuthHandler = (request: Request) => Promise<Response>;
let authPOST: AuthHandler;
let authGET: AuthHandler;

/** POST a JSON body to a better-auth endpoint under /api/auth. */
function post(path: string, body: unknown): Promise<Response> {
  return authPOST(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** The session cookie pairs (`name=value; …`) set by an auth response. */
function sessionCookieFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

/** GET /get-session presenting the given Cookie header. */
function getSession(cookie: string): Promise<Response> {
  return authGET(
    new Request(`${BASE}/api/auth/get-session`, {
      method: "GET",
      headers: { cookie },
    }),
  );
}

/** The single pending reset token, read from the `verification` table. */
async function resetTokenFromDb(): Promise<string> {
  const rows = await getTestDb()
    .select({ identifier: verification.identifier })
    .from(verification)
    .where(like(verification.identifier, "reset-password:%"));
  expect(rows).toHaveLength(1);
  return rows[0].identifier.slice("reset-password:".length);
}

describeIntegration("password reset flow (better-auth handlers)", () => {
  const email = "reset-me@example.com";
  const oldPassword = "old-password-123";
  const newPassword = "new-password-456";

  beforeAll(async () => {
    await setupSchema();
    // Dynamic import AFTER the mocks: pulls in `@/server/auth` (drizzleAdapter
    // over the harness db) and the Next catch-all handler in one go.
    const route = await import("@/app/api/auth/[...all]/route");
    authPOST = route.POST;
    authGET = route.GET;
  });
  beforeEach(async () => {
    await resetAppTables();
    sendMailMock.mockClear();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it("resets the password end-to-end: old password stops working, new one signs in", async () => {
    // 1. Create the user (auto-confirm branch: REQUIRE_EMAIL_VERIFICATION unset).
    const signUp = await post("/sign-up/email", {
      email,
      password: oldPassword,
      name: "Reset Me",
    });
    expect(signUp.status).toBe(200);

    // 2. Request a reset — same flow the /forgot-password page triggers via
    //    authClient.requestPasswordReset({ email, redirectTo: "/reset-password" }).
    const request = await post("/request-password-reset", {
      email,
      redirectTo: "/reset-password",
    });
    expect(request.status).toBe(200);
    expect(await request.json()).toMatchObject({ status: true });

    // 3. The token is in `verification`; the email (mocked here) carries
    //    ${baseURL}/reset-password/<token>?callbackURL=<redirectTo> — better-auth's
    //    GET callback then forwards the browser to /reset-password?token=<token>.
    const token = await resetTokenFromDb();
    const resetMail = sendMailMock.mock.calls
      .map(([input]) => input as { subject: string; text: string })
      .find((m) => m.subject === "Reset your password");
    expect(resetMail).toBeDefined();
    expect(resetMail!.text).toContain(
      `/api/auth/reset-password/${token}?callbackURL=${encodeURIComponent("/reset-password")}`,
    );

    // 4. Set the new password — same call the /reset-password page makes via
    //    authClient.resetPassword({ newPassword, token }).
    const reset = await post("/reset-password", { newPassword, token });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ status: true });

    // 5. Old password must FAIL…
    const oldSignIn = await post("/sign-in/email", {
      email,
      password: oldPassword,
    });
    expect(oldSignIn.status).toBe(401);

    // …and the new password must succeed.
    const newSignIn = await post("/sign-in/email", {
      email,
      password: newPassword,
    });
    expect(newSignIn.status).toBe(200);
    const session = (await newSignIn.json()) as {
      token?: string;
      user?: { email?: string };
    };
    expect(session.token).toBeTruthy();
    expect(session.user?.email).toBe(email);
  });

  it("does not reveal whether an email exists (enumeration-safe 200)", async () => {
    const res = await post("/request-password-reset", {
      email: "nobody@example.com",
      redirectTo: "/reset-password",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: true });
    // No reset email is sent for an unknown address…
    expect(
      sendMailMock.mock.calls.filter(
        ([input]) =>
          (input as { subject: string }).subject === "Reset your password",
      ),
    ).toHaveLength(0);
  });

  it("rejects an invalid token with 400 INVALID_TOKEN and keeps the old password working", async () => {
    const signUp = await post("/sign-up/email", {
      email,
      password: oldPassword,
      name: "Reset Me",
    });
    expect(signUp.status).toBe(200);

    const res = await post("/reset-password", {
      newPassword,
      token: "not-a-real-token",
    });
    expect(res.status).toBe(400);

    const signIn = await post("/sign-in/email", {
      email,
      password: oldPassword,
    });
    expect(signIn.status).toBe(200);
  });

  it("revokes pre-reset sessions: the old session cookie stops working after a reset", async () => {
    // 1. Sign up (auto sign-in) → a live session for the "old device"
    //    (e.g. an attacker who knew the compromised password).
    const signUp = await post("/sign-up/email", {
      email,
      password: oldPassword,
      name: "Reset Me",
    });
    expect(signUp.status).toBe(200);
    const oldCookie = sessionCookieFrom(signUp);
    expect(oldCookie).toContain("session_token");

    // Sanity: the session is live before the reset.
    const before = await getSession(oldCookie);
    expect(before.status).toBe(200);
    expect(await before.json()).not.toBeNull();

    // 2. Full reset flow: request → token from `verification` → reset.
    await post("/request-password-reset", {
      email,
      redirectTo: "/reset-password",
    });
    const token = await resetTokenFromDb();
    const reset = await post("/reset-password", { newPassword, token });
    expect(reset.status).toBe(200);

    // 3. The pre-reset session must be revoked: better-auth /get-session
    //    answers 200 with a `null` body when the cookie no longer maps to a
    //    session (dist/api/routes/session.mjs).
    const after = await getSession(oldCookie);
    expect(after.status).toBe(200);
    expect(await after.json()).toBeNull();
  });

  it("consumes the token: a second reset with the same token fails", async () => {
    await post("/sign-up/email", { email, password: oldPassword, name: "R" });
    await post("/request-password-reset", {
      email,
      redirectTo: "/reset-password",
    });
    const token = await resetTokenFromDb();

    const first = await post("/reset-password", { newPassword, token });
    expect(first.status).toBe(200);

    const second = await post("/reset-password", {
      newPassword: "another-pass-789",
      token,
    });
    expect(second.status).toBe(400);
  });
});
