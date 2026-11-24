-- 0003_users_roles.sql — additive; 0000/0001/0002 untouched.
-- Order matters: tables → columns → backfill.

-- ── 1. Memberships ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_members (
  id           uuid PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES "user"(id)    ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'contributor',
  status       text NOT NULL DEFAULT 'active',
  invited_by   uuid REFERENCES "user"(id) ON DELETE SET NULL,
  invited_at   timestamptz,
  accepted_at  timestamptz,
  removed_at   timestamptz,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now(),
  CONSTRAINT company_members_role_check CHECK (
    role IN ('esg_admin','data_owner','contributor','reviewer','approver','auditor')),
  CONSTRAINT company_members_status_check CHECK (
    status IN ('active','suspended','removed')),
  CONSTRAINT company_members_company_user_key UNIQUE (company_id, user_id)
);

CREATE INDEX IF NOT EXISTS company_members_user_status_idx
  ON company_members (user_id, status);

-- Partial: drizzle-kit serializes WHERE broken → hand-authored only (§0.4).
CREATE INDEX IF NOT EXISTS company_members_active_idx
  ON company_members (company_id) WHERE status = 'active';

-- ── 2. Invitations ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_invitations (
  id           uuid PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email        text NOT NULL,                     -- always lower(trim(...))
  role         text NOT NULL,
  token_hash   text NOT NULL,                     -- sha256(raw) hex (D7)
  invited_by   uuid REFERENCES "user"(id) ON DELETE SET NULL,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  accepted_by  uuid REFERENCES "user"(id) ON DELETE SET NULL,
  revoked_at   timestamptz,
  created_at   timestamptz DEFAULT now(),
  CONSTRAINT company_invitations_role_check CHECK (
    role IN ('esg_admin','data_owner','contributor','reviewer','approver','auditor')),
  CONSTRAINT company_invitations_token_hash_key UNIQUE (token_hash)
);

-- One LIVE invitation per (company, email). Partial → hand-authored.
-- Predicate without now(): an expired invite holds the slot too, re-inviting
-- revokes the old one first (§9.6).
CREATE UNIQUE INDEX IF NOT EXISTS company_invitations_pending_key
  ON company_invitations (company_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS company_invitations_company_created_idx
  ON company_invitations (company_id, created_at DESC);

-- ── 3. Active company on the profile ────────────────────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS active_company_id uuid
  REFERENCES companies(id) ON DELETE SET NULL;

-- ── 4. Actor role in the journal ────────────────────────────────────────────
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS actor_role text;   -- role snapshot; NULL for pre-roles rows

-- ── 5. Backfill: every linked profile → an esg_admin/active membership ───────
-- FK requirement: user_id references "user"(id), and profiles.id IS user.id
-- (profiles.id → user.id) → the substitution is safe.
INSERT INTO company_members
  (id, company_id, user_id, role, status, accepted_at, created_at, updated_at)
SELECT gen_random_uuid(), p.company_id, p.id, 'esg_admin', 'active',
       now(), COALESCE(p.created_at, now()), now()
FROM profiles p
WHERE p.company_id IS NOT NULL
ON CONFLICT (company_id, user_id) DO NOTHING;

UPDATE profiles
   SET active_company_id = company_id
 WHERE company_id IS NOT NULL AND active_company_id IS NULL;
