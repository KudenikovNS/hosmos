/**
 * better-auth server configuration (PG-IMPL-SPEC §3.3, §3.5, §3.6 — task T-9).
 *
 * Verified against the official better-auth docs for ^1.6.23:
 *   - https://www.better-auth.com/docs/reference/options
 *   - https://www.better-auth.com/docs/adapters/drizzle
 *   - https://www.better-auth.com/docs/authentication/email-password
 * Exact option shapes were cross-checked against the installed
 * @better-auth/core `init-options` types (not memory).
 *
 * This module is the single source of the `auth` instance. It is server-only and
 * mounts NOTHING (route handler + client are T-10). Import-time is side-effect
 * free w.r.t. the database: `db` (T-6) is a lazy Proxy and `drizzleAdapter`
 * only captures the reference — so `next build` without DATABASE_URL stays green.
 */
import "server-only";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { db } from "@/server/db";
import * as schema from "@/server/db/schema";

import { sendMail } from "./mailer";
import { verifyImportedPassword } from "./verify-password";

/** dev + prod origins allowed to send credentialed cross-origin requests (§3.5). */
function trustedOrigins(): string[] {
  const fromEnv = (process.env.TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  // Keep local full-stack dev working out of the box even if the env is unset.
  return fromEnv.length > 0 ? fromEnv : ["http://localhost:3000"];
}

// Whether a session may be created only after email verification. Supabase's
// `handle_new_user` trigger auto-confirmed users (session issued immediately);
// we preserve that as the default (false) while still sending a verification
// email on sign-up, so both the old "auto-confirm" and "check your email"
// branches remain reachable (§3.6, ОВ-2). Flip via env for stricter setups.
const requireEmailVerification =
  process.env.REQUIRE_EMAIL_VERIFICATION === "true";

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,

  // Drizzle adapter over the Postgres pool; `schema` exposes the better-auth
  // tables (user/session/account/verification) whose exported keys match the
  // default model names, so the adapter resolves them by key (§3.2, §3.3).
  database: drizzleAdapter(db, { provider: "pg", schema }),

  emailAndPassword: {
    enabled: true,
    requireEmailVerification,
    // Invalidate every existing session when the password is reset (default is
    // false). A reset typically follows a suspected compromise; without this an
    // attacker holding a live session survives the reset (OWASP ASVS v4 §3.3.1 /
    // Session Management: terminate sessions on password change).
    revokeSessionsOnPasswordReset: true,
    // hash: default better-auth scrypt for new passwords (omitted → default).
    // verify: bcrypt-aware branch so imported Supabase hashes still work (§3.6).
    password: {
      verify: verifyImportedPassword,
    },
    // Password reset over SMTP (§3.3).
    sendResetPassword: async ({ user, url }) => {
      await sendMail({
        to: user.email,
        subject: "Reset your password",
        text: `Reset your password using the following link:\n\n${url}`,
        html: `<p>Reset your password using the following link:</p><p><a href="${url}">${url}</a></p>`,
      });
    },
  },

  emailVerification: {
    // Always send a verification email on sign-up (preserves the old
    // "Check your email to confirm your account" path), and sign the user in
    // once they verify (preserves the auto-confirm session experience).
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendMail({
        to: user.email,
        subject: "Verify your email",
        text: `Verify your email address using the following link:\n\n${url}`,
        html: `<p>Verify your email address using the following link:</p><p><a href="${url}">${url}</a></p>`,
      });
    },
  },

  // Auto-provision the application `profiles` row on user creation — the
  // replacement for Supabase's `handle_new_user` trigger (§1.4, §3.2). Runs
  // after the `user` row exists, so the FK profiles.id → user.id is satisfied.
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await db.insert(schema.profiles).values({
            id: user.id,
            email: user.email,
            fullName: user.name,
          });
        },
      },
    },
  },

  // CSRF: only these origins may make credentialed cross-origin auth requests.
  trustedOrigins: trustedOrigins(),

  advanced: {
    database: {
      // App-generated UUIDs, consistent with the uuid PKs in schema.ts and
      // independent of gen_random_uuid()/pgcrypto (§2.1, §3.2, T-1 decision).
      generateId: () => crypto.randomUUID(),
    },
    // Cross-origin cookie for the front-dev → prod-API scenario (§3.5, ОВ-4):
    // SameSite=None requires Secure. In prod (same-origin) this is harmless.
    defaultCookieAttributes: {
      sameSite: "none",
      secure: true,
    },
  },
});
