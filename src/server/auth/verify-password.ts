/**
 * Password verifier for better-auth's `emailAndPassword.password.verify`
 * (PG-IMPL-SPEC §3.6, ОВ-2).
 *
 * Supabase stored passwords as bcrypt in `auth.users.encrypted_password`
 * (`$2a$/$2b$/$2y$...`). To let imported users keep logging in without a forced
 * reset, we detect the bcrypt prefix and verify with `bcryptjs`. Every other
 * hash is a better-auth scrypt hash (new signups / password resets) and is
 * delegated to better-auth's own default verifier — so we never re-implement
 * password crypto ourselves (PG-SPEC §5 "Never").
 *
 * Kept in its own module (no `server-only`, no db import) so the branch that
 * carries the migration risk is unit-testable in isolation.
 */
import bcrypt from "bcryptjs";
import { verifyPassword as scryptVerify } from "better-auth/crypto";

export async function verifyImportedPassword(data: {
  hash: string;
  password: string;
}): Promise<boolean> {
  const { hash, password } = data;

  // Imported Supabase bcrypt hash → verify with bcryptjs.
  if (hash.startsWith("$2")) {
    return bcrypt.compare(password, hash);
  }

  // Native better-auth scrypt hash (new signups / resets) → default verifier.
  return scryptVerify({ hash, password });
}
