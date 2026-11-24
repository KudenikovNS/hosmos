import bcrypt from "bcryptjs";
import { hashPassword } from "better-auth/crypto";
import { describe, expect, it } from "vitest";

import { verifyImportedPassword } from "@/server/auth/verify-password";

// T-9 / §3.6, ОВ-2: better-auth `emailAndPassword.password.verify` must accept
// bcrypt hashes imported from Supabase ($2a/$2b/$2y...) while still verifying
// better-auth's own scrypt hashes for new signups / resets.
describe("verifyImportedPassword", () => {
  it("verifies an imported bcrypt hash ($2*) with bcryptjs", async () => {
    const hash = await bcrypt.hash("s3cret", 10);
    expect(hash.startsWith("$2")).toBe(true);

    await expect(
      verifyImportedPassword({ hash, password: "s3cret" }),
    ).resolves.toBe(true);
    await expect(
      verifyImportedPassword({ hash, password: "wrong" }),
    ).resolves.toBe(false);
  });

  it("delegates non-bcrypt hashes to better-auth's default (scrypt) verifier", async () => {
    const hash = await hashPassword("s3cret");
    expect(hash.startsWith("$2")).toBe(false);

    await expect(
      verifyImportedPassword({ hash, password: "s3cret" }),
    ).resolves.toBe(true);
    await expect(
      verifyImportedPassword({ hash, password: "wrong" }),
    ).resolves.toBe(false);
  });
});
