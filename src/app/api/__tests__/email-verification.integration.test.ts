// BUG-002 — the email-verification link leads to /email-verified, not to the
// public home page. The full better-auth loop against a real Postgres:
//   sign-up with the callbackURL the registration form sends → the mocked
//   mailer receives the link → GET of that link verifies the address, signs
//   the user in and redirects to the callbackURL; an unusable token redirects
//   to the same page with `?error=`.
//
// Same harness and mocks as password-reset.integration.test.ts: the mailer is
// mocked (no SMTP in tests), `@/server/db` is the harness pool, and the auth
// route is imported dynamically so a DB-less run self-skips cleanly.
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

import { localisedPath } from "@/i18n/localised-path";
import {
  closeTestDb,
  describeIntegration,
  resetAppTables,
  setupSchema,
} from "@/server/db/__tests__/harness";

const BASE = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
// What the registration form sends for a Russian-interface sign-up.
const CALLBACK = localisedPath("/email-verified", "ru");

type AuthHandler = (request: Request) => Promise<Response>;
let authPOST: AuthHandler;
let authGET: AuthHandler;

function post(path: string, body: unknown): Promise<Response> {
  return authPOST(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function get(url: string, cookie?: string): Promise<Response> {
  return authGET(
    new Request(url, {
      method: "GET",
      headers: cookie ? { cookie } : {},
      redirect: "manual",
    }),
  );
}

/** The verification link from the (mocked) "Verify your email" mail. */
function verificationLink(): string {
  const mail = sendMailMock.mock.calls
    .map(([input]) => input as { subject: string; text: string })
    .find((m) => m.subject === "Verify your email");
  expect(mail).toBeDefined();
  const link = mail!.text.match(/https?:\/\/\S+/)?.[0];
  expect(link).toBeDefined();
  return link!;
}

describeIntegration("email verification lands on /email-verified", () => {
  beforeAll(async () => {
    await setupSchema();
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

  it("the link verifies, signs in and redirects to the callback page", async () => {
    expect(CALLBACK).toBe("/ru/email-verified");
    const signUp = await post("/sign-up/email", {
      email: "verify-me@example.com",
      password: "verify-password-123",
      name: "Verify Me",
      callbackURL: CALLBACK,
    });
    expect(signUp.status).toBe(200);

    const link = verificationLink();
    expect(link).toContain(`callbackURL=${encodeURIComponent(CALLBACK)}`);

    const res = await get(link);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(CALLBACK);
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(cookie).not.toBe("");

    const session = await get(`${BASE}/api/auth/get-session`, cookie);
    const body = (await session.json()) as {
      user: { email: string; emailVerified: boolean };
    };
    expect(body.user.email).toBe("verify-me@example.com");
    expect(body.user.emailVerified).toBe(true);
  });

  it("an unusable token redirects to the same page with ?error=", async () => {
    const res = await get(
      `${BASE}/api/auth/verify-email?token=not-a-token&callbackURL=${encodeURIComponent(CALLBACK)}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${CALLBACK}?error=INVALID_TOKEN`);
  });
});
