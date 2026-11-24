/**
 * Integration test harness for Drizzle data-access tests (PG-PLAN T-13).
 *
 * This is the foundation for the phase-C tests: as `queries/*` are rewritten onto
 * Drizzle (T-14…T-17) they are exercised against a REAL Postgres, not mocks. The
 * harness owns four concerns:
 *
 *   1. Availability gating. Pure engine tests (calculate / factor-resolver /
 *      golden) MUST stay green with no database. Integration tests therefore
 *      self-skip when Postgres is unreachable: `describeIntegration` is `describe`
 *      when the DB is up and `describe.skip` otherwise. A single connectivity
 *      probe runs once at import (top-level await). CI without Postgres → skipped,
 *      never red; CI/local with Postgres → the suite really runs.
 *
 *   2. Its own connection. Like `seed.ts`, the harness builds a standalone
 *      postgres.js client rather than importing `../index` (which is `server-only`
 *      and would throw under vitest). Small pool, closed on teardown.
 *
 *   3. Schema + reference data. `setupSchema()` applies the baseline migration
 *      (drizzle-kit journal in `drizzle/`) and seeds the factor reference tables
 *      once (idempotent: seeding is skipped when already populated). Call it from
 *      a suite `beforeAll`.
 *
 *   4. Isolation between tests. `resetAppTables()` TRUNCATEs the per-tenant
 *      application tables (company / profile / user / session / account / monthly
 *      / people / results / …) while leaving the factor reference tables seeded,
 *      so every test starts from a clean tenant state without re-seeding factors.
 *      Call it from `beforeEach` (or `afterEach`).
 *
 *   5. Filesystem isolation (T1.7). `setupDocumentsDir()` gives a suite its own
 *      `DOCUMENTS_DIR` under `os.tmpdir()` and removes it afterwards, so the
 *      byte-writing tests of S4/S5 never touch a developer's real storage root.
 *
 * Fixture factories build minimal valid rows and return the inserted record, so
 * tests can assemble exactly the state they need: the tenant pair
 * (`insertCompany`, `insertUserWithProfile`) plus the Phase-1
 * model (`insertLegalEntity`, `insertFacility`, `insertAsset`, `insertPeriod`,
 * `insertPeriodScope`, `insertRevision`, `insertEmissionActivity`, `insertEnergyActivity`,
 * `insertInstrument`, `insertDisclosure`, `insertDocument`, `insertEvidenceLink`,
 * `insertDq`).
 *
 * THE PHASE-1 FIXTURES FILL THEIR OWN PREREQUISITES. Every one of them takes
 * `(companyId, overrides)` and nothing else, because a `disclosure_record` needs
 * a revision, which needs a period, which needs a legal entity, a factor set and
 * an actor — five rows of ceremony before the row under test. Whatever the
 * caller does not supply is created on the spot (and the created ids are
 * reachable from the returned row), so a test asks for exactly the graph it
 * cares about and no more.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe } from "vitest";

import { documentStorage } from "@/server/storage/document-storage";
import { METHODOLOGY_VERSIONS, type ApplicabilityStatus } from "@/shared/enums";

import * as schema from "../schema";

type TestDb = PostgresJsDatabase<typeof schema>;

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "drizzle");

/**
 * Per-tenant application tables — truncated between tests. The reference tables
 * (`currencies`, `fx_rates`, `plans`, `plan_prices` and the four Phase-1
 * catalogues `metric_catalog` / `factor_set` / `emission_factor` /
 * `unit_conversion`) are deliberately absent: they are seeded once by
 * `setupSchema()` and must survive every reset.
 *
 * EVERY TENANT TABLE IS NAMED HERE, NONE IS LEFT TO THE CASCADE (T1.7). A shorter
 * list would still *appear* to work — `TRUNCATE companies … CASCADE` reaches
 * anything with an FK chain back to `companies`, which today is most of this
 * list. That is precisely the problem: the invariant would then be "someone kept
 * an `ON DELETE` chain intact", not "the harness truncates the table". Relax one
 * FK — or add a Phase-1 table that hangs off `report_revision` rather than off
 * `companies` (`calculation`, `report_render`, `validation_result` all do) — and
 * rows start leaking between tests as intermittent failures in *other people's*
 * suites. The list is checked mechanically by `harness-fixtures.integration.test`:
 * every table in the schema carrying a `company_id` column must appear below.
 */
export const APP_TABLES = [
  // ─ Parked pre-Phase-1 features (§5: Phase 3/5 own their removal). The three
  //   legacy wide tables that used to head this list — `monthly_emissions_data`,
  //   `people_data`, `emission_results` — were dropped by 0005 (T3.9). ────────
  "scope3_results",
  "supply_chain_data",
  "goals",
  "scope3_spend",
  "audit_log",
  // ─ Phase-1 organisational axis, periods and the one state machine ──────────
  "legal_entity",
  "facility",
  "asset",
  "reporting_period",
  "period_scope",
  "report_revision",
  // ─ Phase-1 input tables (the D23 mixin) ────────────────────────────────────
  "emission_activity",
  "purchased_energy_activity",
  "contractual_instrument",
  "disclosure_record",
  "disclosure_applicability", // 0016 — decisions per revision × metric
  // ─ Phase-1 evidence, data quality, validation ──────────────────────────────
  "document",
  "evidence_link",
  "dq_assessment",
  "validation_result",
  // ─ Phase-1 derived artefacts (hang off `report_revision`, NOT off companies) ─
  "calculation",
  "calculation_run_context",
  "report_render",
  // ─ Stage-1 extras (партия 10) ──────────────────────────────────────────────
  "vesg_decision", // 0022 — manual VESG confirmations per company
  // ─ Billing rows of a tenant (BILLING T-*) ──────────────────────────────────
  "company_subscription",
  "payments",
  "payment_events", // no company_id of its own — owned through `payments`
  // ─ Membership/invitation rows (USERS-ROLES T0.1). Listed explicitly even
  //   though `TRUNCATE … CASCADE` from companies/user would reach them: an
  //   incomplete list lets memberships leak between tests and produces false
  //   "last admin" / seat errors in later suites (§14.1).
  "company_members",
  "company_invitations",
  // ─ Identity ────────────────────────────────────────────────────────────────
  "profiles",
  "session",
  "account",
  "verification",
  '"user"', // reserved word — quote it
  "companies",
] as const;

// ─── Connectivity probe (runs once, gates the integration group) ─────────────
async function probe(): Promise<boolean> {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  let client: postgres.Sql | undefined;
  try {
    client = postgres(url, { max: 1, connect_timeout: 3, idle_timeout: 1 });
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client?.end({ timeout: 1 }).catch(() => {});
  }
}

/** True when a Postgres reachable via DATABASE_URL answered a `select 1`. */
export const dbReady: boolean = await probe();

/**
 * `describe` when the database is reachable, `describe.skip` otherwise. Use this
 * for every DB-backed suite so `npm test` stays green with no Postgres.
 */
export const describeIntegration = dbReady ? describe : describe.skip;

// ─── Test database singleton ─────────────────────────────────────────────────
let client: postgres.Sql | undefined;
let db: TestDb | undefined;

/** The Drizzle instance bound to the test Postgres (throws if DB is unreachable). */
export function getTestDb(): TestDb {
  if (db) return db;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set — the integration harness needs a test Postgres. " +
        "Start docker-compose and export DATABASE_URL, or rely on describeIntegration to skip.",
    );
  }
  client = postgres(url, {
    max: 2,
    idle_timeout: 5,
    onnotice: () => {}, // silence migrator NOTICE noise (schema already exists, …)
  });
  db = drizzle(client, { schema });
  return db;
}

/**
 * An inert stand-in for `db`, handed out only when there is no database. Reading
 * any property (or calling it) yields another inert proxy, so module top-level
 * code that merely *constructs* things from `db` — notably `drizzleAdapter(db, …)`
 * at `@/server/auth/index` top level, reached whenever a suite imports the real
 * `@/server/auth/session` graph — neither opens a connection nor throws. It is
 * never touched from inside a test: those suites are `describe.skip`ped with no
 * DB, so no query ever runs against it.
 */
const inertDb: unknown = new Proxy(function () {}, {
  get: () => inertDb,
  apply: () => inertDb,
});

/**
 * The module object a `vi.mock("@/server/db", …)` factory must return: a `db`
 * getter bound to the shared test pool.
 *
 * The getter is deliberately guarded on `dbReady` rather than calling
 * `getTestDb()` unconditionally. `vi.mock` is hoisted, so `db` is resolved as
 * modules are collected — and a suite that pulls the real `@/server/auth/session`
 * graph triggers `drizzleAdapter(db, …)` at `auth/index` top level, which READS
 * `db` at import time. With no DATABASE_URL that read would call `getTestDb()` and
 * throw, failing the suite on collection instead of letting `describeIntegration`
 * (`describe.skip`) skip it cleanly. Returning the inert stand-in keeps collection
 * green; when a DB is present the getter yields the real pooled Drizzle instance
 * and the suite runs for real. Shared by every DB-backed suite so the mock is one
 * pattern, not four copies.
 */
export function testDbModule(): { readonly db: TestDb } {
  return {
    get db(): TestDb {
      return dbReady ? getTestDb() : (inertDb as TestDb);
    },
  };
}

/** Close the pooled connection (call from a suite `afterAll`). */
export async function closeTestDb(): Promise<void> {
  await client?.end({ timeout: 5 });
  client = undefined;
  db = undefined;
  // Ids memoised off the closed connection — a reconnect re-resolves them.
  actorByCompany.clear();
  legacyFactorSetId = undefined;
  defaultMetricKey = undefined;
}

// ─── Schema + seed bootstrap ─────────────────────────────────────────────────
let schemaReady = false;

/**
 * Apply the baseline migration and ensure factor reference data exists. Idempotent
 * and cheap on a warm DB: the drizzle journal short-circuits an already-applied
 * migration and seeding is skipped when factors are already present. Safe to call
 * from every suite's `beforeAll`.
 */
export async function setupSchema(): Promise<void> {
  if (schemaReady) return;
  const conn = getTestDb();
  await migrate(conn, { migrationsFolder: MIGRATIONS_DIR });
  await ensureSeeded(conn);
  schemaReady = true;
}

/**
 * The `factor_set.code` a period is pinned to by default — the set seeded from
 * `seed-data/factor-set-v1.ts` (T1.5). Written out rather than imported so that
 * 30-odd suites do not pull the 440-row factor module into memory; the literal
 * is pinned against `LEGACY_FACTOR_SET.code` by `harness-fixtures.integration`.
 */
const LEGACY_FACTOR_SET_CODE = "legacy-v1";

/**
 * Seed the reference tables if they are not already populated.
 *
 * THE PROBE MUST COVER EVERY CATALOGUE, NOT JUST ONE OF THEM. It used to look at
 * the legacy `emission_factors` alone, which was true-by-accident while that was
 * the only reference table; a warm developer database migrated and seeded before
 * T1.4/T1.5 existed had it full while `metric_catalog` and `factor_set` were
 * empty, and a single-table probe short-circuited and left them empty forever.
 * The failure then surfaced two layers away as `insertDisclosure` violating an FK
 * or `insertPeriod` finding no factor set, and read like a bug in the seed rather
 * than a stale database. `emission_factors` itself was dropped in T3.9; the three
 * catalogues below are what the fixtures actually need — the metrics a disclosure
 * points at, the factor set a period pins, and its factors.
 *
 * `seed.ts` is idempotent (upserts throughout), so re-running it to fill one
 * missing catalogue costs a few seconds and changes nothing that already exists.
 */
async function ensureSeeded(conn: TestDb): Promise<void> {
  const [counts] = await conn.execute<{
    metrics: number;
    factor_sets: number;
    factors: number;
  }>(sql`
    SELECT (SELECT count(*)::int FROM metric_catalog)   AS metrics,
           (SELECT count(*)::int FROM factor_set
             WHERE code = ${LEGACY_FACTOR_SET_CODE})    AS factor_sets,
           (SELECT count(*)::int FROM emission_factor f
              JOIN factor_set s ON s.id = f.factor_set_id
             WHERE s.code = ${LEGACY_FACTOR_SET_CODE})  AS factors
  `);
  if (counts.metrics > 0 && counts.factor_sets > 0 && counts.factors > 0) {
    return;
  }
  // Fresh (or partially seeded) DB — run the real seed script once.
  execFileSync(
    path.join(REPO_ROOT, "node_modules/.bin/tsx"),
    ["src/server/db/seed.ts"],
    { cwd: REPO_ROOT, env: process.env, stdio: "ignore" },
  );
}

// ─── Isolation ───────────────────────────────────────────────────────────────
/**
 * Truncate all per-tenant application tables (RESTART IDENTITY, CASCADE), leaving
 * the factor reference tables seeded. Call from `beforeEach` for a clean slate.
 */
export async function resetAppTables(): Promise<void> {
  const conn = getTestDb();
  await conn.execute(
    sql.raw(`TRUNCATE TABLE ${APP_TABLES.join(", ")} RESTART IDENTITY CASCADE`),
  );
  // The per-company default actor is one of the rows just deleted.
  actorByCompany.clear();
}

// ─── Filesystem isolation for DOCUMENTS_DIR (T1.7) ───────────────────────────
/** What `setupDocumentsDir()` hands back: the live path of the suite's root. */
export interface DocumentsDirHandle {
  /** Absolute path of this suite's temporary `DOCUMENTS_DIR` (`""` before `beforeAll`). */
  readonly path: string;
}

/**
 * Give the calling suite its own `DOCUMENTS_DIR` under `os.tmpdir()`.
 *
 * Call it once at the top of a suite (module scope or inside a `describe`); it
 * registers its own `beforeAll`/`afterAll`. The directory is created fresh per
 * suite, `process.env.DOCUMENTS_DIR` points at it for the duration, and both the
 * directory and the previous value of the variable are restored afterwards — a
 * previously UNSET variable is unset again, not left as an empty string.
 *
 * WHY THE HARNESS OWNS THIS. `resetAppTables()` truncates `document` and
 * `report_render` but never touches the disk, while evidence upload (T4.1) and
 * report renders (T5.7) write real bytes through `DocumentStorage` (T1.6) and
 * even `stat` a key after deleting it. Without a per-suite root those tests
 * would either collide with each other or scribble into whatever
 * `DOCUMENTS_DIR` the developer has exported. It works because `DocumentStorage`
 * reads `DOCUMENTS_DIR` PER CALL rather than caching it in its constructor
 * (T1.6), so an instance created at module scope still lands in this directory.
 *
 * It exists now, ahead of its first consumer, so that the S4/S5 file tests can
 * be added without editing a harness that 30-odd suites already import.
 */
export function setupDocumentsDir(): DocumentsDirHandle {
  let dir = "";
  let previous: string | undefined;
  let hadPrevious = false;

  beforeAll(async () => {
    hadPrevious = "DOCUMENTS_DIR" in process.env;
    previous = process.env.DOCUMENTS_DIR;
    dir = await mkdtemp(path.join(os.tmpdir(), "hosmos-docs-"));
    process.env.DOCUMENTS_DIR = dir;
  });

  afterAll(async () => {
    if (hadPrevious && previous !== undefined) {
      process.env.DOCUMENTS_DIR = previous;
    } else {
      delete process.env.DOCUMENTS_DIR;
    }
    const created = dir;
    dir = "";
    if (created) await rm(created, { recursive: true, force: true });
  });

  return {
    get path(): string {
      return dir;
    },
  };
}

// ─── Fixture factories ───────────────────────────────────────────────────────
type Company = typeof schema.companies.$inferSelect;
type User = typeof schema.user.$inferSelect;
type Profile = typeof schema.profiles.$inferSelect;
type Membership = typeof schema.companyMembers.$inferSelect;
type Invitation = typeof schema.companyInvitations.$inferSelect;

// Phase-1 model (§4). `DocumentRow` rather than `Document` on purpose: the DOM
// lib is in scope here and shadowing its `Document` reads as a mistake.
type LegalEntity = typeof schema.legalEntity.$inferSelect;
type Facility = typeof schema.facility.$inferSelect;
type Asset = typeof schema.asset.$inferSelect;
type ReportingPeriod = typeof schema.reportingPeriod.$inferSelect;
type PeriodScope = typeof schema.periodScope.$inferSelect;
type ReportRevision = typeof schema.reportRevision.$inferSelect;
type EmissionActivity = typeof schema.emissionActivity.$inferSelect;
type EnergyActivity = typeof schema.purchasedEnergyActivity.$inferSelect;
type Instrument = typeof schema.contractualInstrument.$inferSelect;
type Disclosure = typeof schema.disclosureRecord.$inferSelect;
type DocumentRow = typeof schema.document.$inferSelect;
type EvidenceLink = typeof schema.evidenceLink.$inferSelect;
type DqAssessment = typeof schema.dqAssessment.$inferSelect;

// The shared role/status domains live in `src/shared/roles.ts`, which is only
// introduced in T1.1. To avoid reaching into that task's surface, the harness
// declares the two string unions locally, mirroring the CHECK constraints on
// `company_members` (schema.ts §8.1). Swap these for the shared types once T1.1
// lands.
type CompanyRole =
  | "esg_admin"
  | "data_owner"
  | "contributor"
  | "reviewer"
  | "approver"
  | "auditor";
type MemberStatus = "active" | "suspended" | "removed";

let seq = 0;
const uniq = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** Insert a company; overrides win over the minimal defaults. Returns the row. */
export async function insertCompany(
  overrides: Partial<typeof schema.companies.$inferInsert> = {},
): Promise<Company> {
  const conn = getTestDb();
  const [row] = await conn
    .insert(schema.companies)
    .values({
      name: `Test Co ${uniq()}`,
      country: "SI",
      countryCode: "SI",
      ...overrides,
    })
    .returning();
  return row;
}

/**
 * Insert a company on a **paid** plan (starter or higher). The default company
 * (`insertCompany`) is on `trial`, whose `maxTeamMembers = 1` (`plans.ts`), so any
 * multi-member scenario on it would hit a 402 seat cap before the role logic is
 * even reached (Q1). Multi-participant suites (phases 2–3) must use this. Returns
 * the row; `overrides` win, but the plan defaults to `starter` (maxTeamMembers ≥ 5).
 */
export async function insertPaidCompany(
  overrides: Partial<typeof schema.companies.$inferInsert> = {},
): Promise<Company> {
  return insertCompany({ plan: "starter", ...overrides });
}

/**
 * Insert a better-auth `user` and its 1:1 `profiles` row (FK profiles.id → user.id).
 *
 * When `companyId` is given the user is also made a **member** of that company:
 * a `company_members` row is created (role default `esg_admin`, status default
 * `active`, `accepted_at` stamped) AND both profile company columns — `company_id`
 * and `active_company_id` — are written with the same value (D11). The default
 * role is `esg_admin` so that existing suites, which write company data, keep the
 * permissions they always had (§14.1).
 *
 * The signature is preserved: the return adds a third field `membership` (null
 * when no `companyId` was passed); existing `{ user, profile }` destructuring is
 * unaffected.
 */
export async function insertUserWithProfile(
  overrides: {
    user?: Partial<typeof schema.user.$inferInsert>;
    profile?: Partial<typeof schema.profiles.$inferInsert>;
    companyId?: string;
    role?: CompanyRole;
    memberStatus?: MemberStatus;
  } = {},
): Promise<{ user: User; profile: Profile; membership: Membership | null }> {
  const conn = getTestDb();
  const email = overrides.user?.email ?? `user-${uniq()}@example.com`;
  const [u] = await conn
    .insert(schema.user)
    .values({ name: `User ${uniq()}`, email, ...overrides.user })
    .returning();
  const [p] = await conn
    .insert(schema.profiles)
    .values({
      id: u.id,
      email: u.email,
      // D11: both company columns carry the same value when a membership exists.
      companyId: overrides.companyId ?? null,
      activeCompanyId: overrides.companyId ?? null,
      ...overrides.profile,
    })
    .returning();

  let membership: Membership | null = null;
  if (overrides.companyId) {
    membership = await insertMembership(overrides.companyId, u.id, {
      role: overrides.role,
      status: overrides.memberStatus,
    });
  }

  return { user: u, profile: p, membership };
}

/**
 * Insert a `company_members` row linking a user to a company. Role defaults to
 * `esg_admin`, status to `active`; an active membership is stamped `accepted_at`
 * (it represents an already-joined member, not a pending invite). Returns the row.
 */
export async function insertMembership(
  companyId: string,
  userId: string,
  overrides: { role?: CompanyRole; status?: MemberStatus } = {},
): Promise<Membership> {
  const conn = getTestDb();
  const [row] = await conn
    .insert(schema.companyMembers)
    .values({
      companyId,
      userId,
      role: overrides.role ?? "esg_admin",
      status: overrides.status ?? "active",
      acceptedAt: new Date(),
    })
    .returning();
  return row;
}

/**
 * Insert a `company_invitations` row. A raw single-use token is generated
 * (base64url of 32 random bytes, §9.2) and only its sha256 hex hash is stored in
 * `token_hash`; the raw token is returned to the caller (never persisted). Role
 * defaults to `contributor`, `expires_at` to now + 7 days (§9.3). Returns the row
 * plus the `rawToken` the caller needs to exercise preview/accept flows.
 */
export async function insertInvitation(
  companyId: string,
  opts: {
    email: string;
    role?: CompanyRole;
    expiresAt?: Date;
    token?: string;
  },
): Promise<{ row: Invitation; rawToken: string }> {
  const conn = getTestDb();
  const rawToken = opts.token ?? randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const expiresAt =
    opts.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const [row] = await conn
    .insert(schema.companyInvitations)
    .values({
      companyId,
      email: opts.email,
      role: opts.role ?? "contributor",
      tokenHash,
      expiresAt,
    })
    .returning();
  return { row, rawToken };
}

// ─── Phase-1 fixtures (T1.7) ─────────────────────────────────────────────────
// Everything below builds the model of DATA-MODEL-PHASE1-SPEC §4. Three rules
// hold for all of them:
//
//   1. Signature is always `(companyId, overrides)`; `overrides` win over every
//      default, exactly as in the fixtures above.
//   2. `company_id`, the actor column and — where the table has one — a valid
//      `revision_id` are always filled. A row these fixtures produce is a row
//      the application would accept, not merely a row Postgres tolerates.
//   3. Missing parents are created, not demanded. The ids of whatever got
//      created are readable off the returned row (`row.legalEntityId`,
//      `row.revisionId`, …), so a test that cares can chain from there.

/**
 * The default actor of a company, memoised for the lifetime of one test.
 *
 * Every Phase-1 table stamps an actor (`actor_id`, `created_by`, `uploaded_by`,
 * `assessed_by` — all → `profiles.id`, DM-13) and most of them make it NOT NULL.
 * Without memoisation a five-fixture graph would leave five users and five
 * memberships behind, which quietly breaks any assertion about seats or member
 * counts. One user per company per test is both cheaper and closer to what a
 * real tenant looks like. Cleared by `resetAppTables()` — the profile it points
 * at is one of the rows that truncate deletes.
 */
const actorByCompany = new Map<string, string>();

/** Resolve the actor to stamp on a row: the caller's, or the company default. */
async function resolveActorId(
  companyId: string,
  actorId?: string | null,
): Promise<string> {
  if (actorId) return actorId;
  const cached = actorByCompany.get(companyId);
  if (cached) return cached;
  const { profile } = await insertUserWithProfile({ companyId });
  actorByCompany.set(companyId, profile.id);
  return profile.id;
}

/** The seeded `legacy-v1` factor set id (reference data — never truncated). */
let legacyFactorSetId: string | undefined;

async function resolveFactorSetId(): Promise<string> {
  if (legacyFactorSetId) return legacyFactorSetId;
  const conn = getTestDb();
  const [row] = await conn
    .select({ id: schema.factorSet.id })
    .from(schema.factorSet)
    .where(eq(schema.factorSet.code, LEGACY_FACTOR_SET_CODE))
    .limit(1);
  if (!row) {
    throw new Error(
      `factor_set '${LEGACY_FACTOR_SET_CODE}' is missing — reporting_period.factor_set_id ` +
        "is NOT NULL, so a period cannot be created. Call setupSchema() in beforeAll.",
    );
  }
  legacyFactorSetId = row.id;
  return row.id;
}

/** The lowest-sorted free-text metric of the seeded catalogue (141 rows, T1.4). */
let defaultMetricKey: string | undefined;

async function resolveMetricKey(): Promise<string> {
  if (defaultMetricKey) return defaultMetricKey;
  const conn = getTestDb();
  // A `text` metric is chosen so the default disclosure can be a plain
  // `value_text` row: DM-19 maps exactly one value column per `value_type`, and
  // picking, say, an `enum` metric would make the minimal row internally
  // inconsistent the moment T3.2 starts checking that mapping.
  const [row] = await conn
    .select({ metricKey: schema.metricCatalog.metricKey })
    .from(schema.metricCatalog)
    .where(
      and(
        eq(schema.metricCatalog.valueType, "text"),
        eq(schema.metricCatalog.isActive, true),
      ),
    )
    .orderBy(asc(schema.metricCatalog.sortOrder))
    .limit(1);
  if (!row) {
    throw new Error(
      "metric_catalog holds no active `text` metric — disclosure_record.metric_key " +
        "is NOT NULL and cannot be filled. Call setupSchema() in beforeAll.",
    );
  }
  defaultMetricKey = row.metricKey;
  return row.metricKey;
}

/** Insert a `legal_entity` (DM-2) — the root of the organisational axis. */
export async function insertLegalEntity(
  companyId: string,
  overrides: Partial<typeof schema.legalEntity.$inferInsert> = {},
): Promise<LegalEntity> {
  const conn = getTestDb();
  const [row] = await conn
    .insert(schema.legalEntity)
    .values({
      companyId,
      name: `Entity ${uniq()}`,
      // VAL-001 wants a registration number on an included entity, so the
      // minimal row carries one rather than being valid only until validation
      // exists (T2.1). VAL-103 (T2.4) wants a `registered_address` on the same
      // grounds — an entity inside a period's boundary must have one before the
      // report — so the minimal row carries that too. Both are here for the same
      // reason: a fixture should produce a row the APPLICATION accepts, not one
      // that merely satisfies the FKs and fails the first rule that looks at it.
      registrationNumber: `REG-${uniq()}`,
      registeredAddress: `Testna ulica 1, 1000 Ljubljana`,
      country: "SI",
      groupStructureType: "standalone",
      ...overrides,
    })
    .returning();
  return row;
}

/** Insert a `facility` (DM-5); its legal entity is created when not supplied. */
export async function insertFacility(
  companyId: string,
  overrides: Partial<typeof schema.facility.$inferInsert> = {},
): Promise<Facility> {
  const conn = getTestDb();
  const legalEntityId =
    overrides.legalEntityId ?? (await insertLegalEntity(companyId)).id;
  const [row] = await conn
    .insert(schema.facility)
    .values({
      companyId,
      facilityName: `Facility ${uniq()}`,
      facilityType: "office",
      country: "SI",
      tenure: "owned",
      controlStatus: "controlled",
      ...overrides,
      legalEntityId,
    })
    .returning();
  return row;
}

/** Insert an `asset` (DM-6) — a flat registry entry, not a level of the tree. */
export async function insertAsset(
  companyId: string,
  overrides: Partial<typeof schema.asset.$inferInsert> = {},
): Promise<Asset> {
  const conn = getTestDb();
  const legalEntityId =
    overrides.legalEntityId ?? (await insertLegalEntity(companyId)).id;
  const [row] = await conn
    .insert(schema.asset)
    .values({
      companyId,
      name: `Asset ${uniq()}`,
      assetType: "equipment",
      ...overrides,
      legalEntityId,
    })
    .returning();
  return row;
}

/**
 * Insert a `reporting_period` (DM-7) **and its boundary row** (DM-8).
 *
 * A period without a `period_scope` row is not a usable period — the boundary is
 * what a calculation and a render read (D10/D15) — so the two are one fixture.
 * The scope row covers the ROOT legal entity: the one passed as
 * `overrides.legalEntityId`, or a freshly created one. Its id is on the returned
 * `scope.legalEntityId`.
 *
 * `factor_set_id` is pinned to the seeded `legacy-v1` set (К-24) — the pin is
 * what makes a locked revision reproducible (AC-8), so it is not left to chance.
 */
export async function insertPeriod(
  companyId: string,
  overrides: Partial<typeof schema.reportingPeriod.$inferInsert> & {
    /** Root entity of the boundary; created when omitted. */
    legalEntityId?: string;
    /** `period_scope.status` (default `included`) — CHECK-constrained (§0.8). */
    scopeStatus?: ApplicabilityStatus;
  } = {},
): Promise<{ period: ReportingPeriod; scope: PeriodScope }> {
  const conn = getTestDb();
  const {
    legalEntityId: overrideEntityId,
    scopeStatus,
    ...periodOverrides
  } = overrides;
  const legalEntityId =
    overrideEntityId ?? (await insertLegalEntity(companyId)).id;
  const factorSetId =
    periodOverrides.factorSetId ?? (await resolveFactorSetId());
  const createdBy = await resolveActorId(companyId, periodOverrides.createdBy);

  const [period] = await conn
    .insert(schema.reportingPeriod)
    .values({
      companyId,
      periodName: `FY2024 ${uniq()}`,
      startDate: "2024-01-01",
      endDate: "2024-12-31", // start < end (VAL-008, CHECK)
      reportingYear: 2024,
      reportingBasis: "individual",
      methodologyVersion: METHODOLOGY_VERSIONS[0],
      ...periodOverrides,
      factorSetId,
      createdBy,
    })
    .returning();

  const [scope] = await conn
    .insert(schema.periodScope)
    .values({
      companyId,
      periodId: period.id,
      legalEntityId,
      status: scopeStatus ?? "included",
      updatedBy: createdBy,
    })
    .returning();

  return { period, scope };
}

/**
 * Insert ONE `period_scope` row (DM-8) — a second (third, fourth…) entity in a
 * period's boundary.
 *
 * `insertPeriod` already puts the ROOT entity in scope, which is all a test
 * about a single-entity period needs. This is for the ones that are about the
 * boundary itself: a consolidated group (VAL-102 wants ≥2 included entities), an
 * excluded subsidiary (VAL-103 must NOT fire on it), a `not_assessed` row. As
 * everywhere else the missing parents are created — but a caller that wants the
 * entity to be in a PARTICULAR period passes `periodId`, since a created one
 * comes with a boundary row of its own.
 *
 * T2.5 gives this table a write path (`PUT /api/periods/[id]/scope`); until then
 * this fixture is how the rules that READ the boundary are exercised.
 */
export async function insertPeriodScope(
  companyId: string,
  overrides: Partial<typeof schema.periodScope.$inferInsert> = {},
): Promise<PeriodScope> {
  const conn = getTestDb();
  const periodId =
    overrides.periodId ?? (await insertPeriod(companyId)).period.id;
  const legalEntityId =
    overrides.legalEntityId ?? (await insertLegalEntity(companyId)).id;
  const updatedBy = await resolveActorId(companyId, overrides.updatedBy);
  const [row] = await conn
    .insert(schema.periodScope)
    .values({
      companyId,
      status: "included",
      ...overrides,
      periodId,
      legalEntityId,
      updatedBy,
    })
    .returning();
  return row;
}

/**
 * Insert a `report_revision` (DM-10) — the ONE state machine of Phase 1.
 *
 * Defaults to revision 1, `draft`, `is_current`. A period is created when
 * `overrides.periodId` is absent, so the default row satisfies the partial
 * unique index `report_revision_period_current_key` (one current revision per
 * period): a second call on the SAME period must pass `isCurrent: false` or a
 * different `revisionNo` + flip, exactly as the state machine does.
 */
export async function insertRevision(
  companyId: string,
  overrides: Partial<typeof schema.reportRevision.$inferInsert> = {},
): Promise<ReportRevision> {
  const conn = getTestDb();
  const periodId =
    overrides.periodId ?? (await insertPeriod(companyId)).period.id;
  const createdBy = await resolveActorId(companyId, overrides.createdBy);
  const [row] = await conn
    .insert(schema.reportRevision)
    .values({
      companyId,
      revisionNo: 1,
      status: "draft",
      isCurrent: true,
      ...overrides,
      periodId,
      createdBy,
    })
    .returning();
  return row;
}

/**
 * The three links every input row needs above `company_id`: the revision it
 * belongs to, the legal entity it is attributed to (D9) and the actor who wrote
 * this version. Whatever the caller left out is created here — and the period
 * created for a missing revision gets the SAME legal entity, so the row lands
 * inside its own boundary instead of pointing at an entity that is not in scope.
 */
async function resolveInputRowLinks(
  companyId: string,
  overrides: {
    revisionId?: string;
    legalEntityId?: string;
    actorId?: string;
  },
): Promise<{ revisionId: string; legalEntityId: string; actorId: string }> {
  const actorId = await resolveActorId(companyId, overrides.actorId);
  let legalEntityId = overrides.legalEntityId;
  let revisionId = overrides.revisionId;
  if (!revisionId) {
    const { period, scope } = await insertPeriod(
      companyId,
      legalEntityId ? { legalEntityId } : {},
    );
    legalEntityId ??= scope.legalEntityId;
    revisionId = (
      await insertRevision(companyId, {
        periodId: period.id,
        createdBy: actorId,
      })
    ).id;
  }
  legalEntityId ??= (await insertLegalEntity(companyId)).id;
  return { revisionId, legalEntityId, actorId };
}

/** Insert an `emission_activity` row (DM-15) — Scope 1, stationary by default. */
export async function insertEmissionActivity(
  companyId: string,
  overrides: Partial<typeof schema.emissionActivity.$inferInsert> = {},
): Promise<EmissionActivity> {
  const conn = getTestDb();
  const links = await resolveInputRowLinks(companyId, overrides);
  const [row] = await conn
    .insert(schema.emissionActivity)
    .values({
      companyId,
      activityCategory: "stationary_combustion",
      sourceName: `Boiler ${uniq()}`,
      activityType: "natural_gas",
      activityValue: "1000",
      unit: "kWh",
      method: "fuel_based",
      yearMonth: "2024-01",
      ...overrides,
      ...links,
    })
    .returning();
  return row;
}

/** Insert a `purchased_energy_activity` row (DM-16) — Scope 2 electricity. */
export async function insertEnergyActivity(
  companyId: string,
  overrides: Partial<typeof schema.purchasedEnergyActivity.$inferInsert> = {},
): Promise<EnergyActivity> {
  const conn = getTestDb();
  const links = await resolveInputRowLinks(companyId, overrides);
  const [row] = await conn
    .insert(schema.purchasedEnergyActivity)
    .values({
      companyId,
      energyType: "electricity",
      supplier: `Utility ${uniq()}`,
      consumption: "1000",
      unit: "kWh",
      yearMonth: "2024-01",
      ...overrides,
      ...links,
    })
    .returning();
  return row;
}

/**
 * Insert a `contractual_instrument` row (DM-17) — a market-based Scope 2
 * certificate. `year_month` stays NULL: an instrument covers the whole period.
 */
export async function insertInstrument(
  companyId: string,
  overrides: Partial<typeof schema.contractualInstrument.$inferInsert> = {},
): Promise<Instrument> {
  const conn = getTestDb();
  const links = await resolveInputRowLinks(companyId, overrides);
  const [row] = await conn
    .insert(schema.contractualInstrument)
    .values({
      companyId,
      instrumentType: "GoO",
      certificateId: `GOO-${uniq()}`,
      coveredVolume: "100",
      productionCountry: "SI",
      technology: "wind",
      generationPeriodStart: "2024-01-01",
      generationPeriodEnd: "2024-12-31",
      qualityCriteriaStatus: "pass",
      ...overrides,
      ...links,
    })
    .returning();
  return row;
}

/**
 * Insert a `disclosure_record` row (DM-18). `metric_key` defaults to the first
 * free-text metric of the seeded VSME catalogue and `value_type`/`value_text`
 * match it, so the minimal row obeys DM-19 (exactly one value column filled).
 */
export async function insertDisclosure(
  companyId: string,
  overrides: Partial<typeof schema.disclosureRecord.$inferInsert> = {},
): Promise<Disclosure> {
  const conn = getTestDb();
  const links = await resolveInputRowLinks(companyId, overrides);
  const metricKey = overrides.metricKey ?? (await resolveMetricKey());
  const [row] = await conn
    .insert(schema.disclosureRecord)
    .values({
      companyId,
      valueType: "text",
      valueText: `Disclosure ${uniq()}`,
      ...overrides,
      metricKey,
      ...links,
    })
    .returning();
  return row;
}

/**
 * Insert a `document` row (DM-24) — WITH ITS BYTES when a suite has called
 * `setupDocumentsDir()`, metadata only when it has not.
 *
 * WHY THE BYTES (T4.4). VAL-036 asks `DocumentStorage.stat` whether the file
 * behind an approved figure is still there (EV-5), so a document row whose
 * `storage_key` points at nothing is not a document — it is a BROKEN one, and a
 * fixture that produced only broken documents would make every test about
 * evidence a test about a missing file. The harness follows the rule it already
 * follows for `insertLegalEntity`: the minimal row is one the APPLICATION
 * accepts. A test that wants a broken document breaks it explicitly (delete the
 * file, or pass a `storageKey` of its own) — which is exactly the T4.4 scenario
 * "a document deleted from disk behind the application's back".
 *
 * The bytes are written through `documentStorage`, not through `fs`, so the key
 * layout stays the storage module's business (EV-0: `{companyId}/{sha256}`) and
 * `file_hash` is the digest of the bytes that are actually on disk rather than a
 * number this fixture made up.
 *
 * WITHOUT `DOCUMENTS_DIR` there is nowhere to put them, so the row is written as
 * before. Two suites configure a directory today; a third that starts approving
 * rows with evidence will find out loudly (VAL-036 rethrows a storage failure
 * rather than calling the file missing) rather than silently.
 *
 * Explicit `fileHash`/`storageKey` overrides are honoured and NOTHING is
 * written: the caller is describing a specific object, usually one it stored
 * itself.
 */
export async function insertDocument(
  companyId: string,
  overrides: Partial<typeof schema.document.$inferInsert> = {},
): Promise<DocumentRow> {
  const conn = getTestDb();
  const uploadedBy = await resolveActorId(companyId, overrides.uploadedBy);
  const described =
    overrides.fileHash !== undefined || overrides.storageKey !== undefined;
  const content = Buffer.from(`document-${uniq()}`);

  let fileHash =
    overrides.fileHash ?? createHash("sha256").update(content).digest("hex");
  let storageKey = overrides.storageKey ?? `${companyId}/${fileHash}`;
  let sizeBytes = content.byteLength;
  if (!described && process.env.DOCUMENTS_DIR) {
    const stored = await documentStorage.put(content, { companyId });
    fileHash = stored.sha256;
    storageKey = stored.key;
    sizeBytes = stored.sizeBytes;
  }

  const [row] = await conn
    .insert(schema.document)
    .values({
      companyId,
      fileName: `evidence-${uniq()}.pdf`,
      fileType: "pdf",
      mime: "application/pdf",
      sizeBytes,
      confidentiality: "internal",
      ...overrides,
      // `{companyId}/{sha256}` — the layout DocumentStorage uses (EV-0).
      storageKey,
      fileHash,
      uploadedBy,
    })
    .returning();
  return row;
}

/**
 * Insert an `evidence_link` row (DM-25) — the polymorphic document↔row link.
 *
 * `linked_object_id` deliberately has NO foreign key (the target may be any of
 * seven tables, К-8), so the default is a fresh uuid rather than a row this
 * fixture invents: pass the real id when the test is about the target.
 */
export async function insertEvidenceLink(
  companyId: string,
  overrides: Partial<typeof schema.evidenceLink.$inferInsert> = {},
): Promise<EvidenceLink> {
  const conn = getTestDb();
  const documentId =
    overrides.documentId ?? (await insertDocument(companyId)).id;
  const createdBy = await resolveActorId(companyId, overrides.createdBy);
  const [row] = await conn
    .insert(schema.evidenceLink)
    .values({
      companyId,
      linkedObjectType: "emission_activity",
      linkedObjectId: randomUUID(),
      ...overrides,
      documentId,
      createdBy,
    })
    .returning();
  return row;
}

/**
 * Insert a `dq_assessment` row (DM-27) — one per row VERSION (К-16). As with
 * `evidence_link`, `object_id` is polymorphic and defaults to a fresh uuid; the
 * UNIQUE `(company_id, object_type, object_id)` never collides by accident.
 */
export async function insertDq(
  companyId: string,
  overrides: Partial<typeof schema.dqAssessment.$inferInsert> = {},
): Promise<DqAssessment> {
  const conn = getTestDb();
  const assessedBy = await resolveActorId(companyId, overrides.assessedBy);
  const [row] = await conn
    .insert(schema.dqAssessment)
    .values({
      companyId,
      objectType: "emission_activity",
      objectId: randomUUID(),
      // Mid-scale pedigree: inside the 1–5 CHECKs, and not so good or so bad
      // that a tier assertion passes for the wrong reason.
      reliabilityScore: 3,
      temporalScore: 3,
      geographicalScore: 3,
      technologyScore: 3,
      completenessScore: "100",
      coverageScore: "100",
      qualityTier: "medium_calculated",
      ...overrides,
      assessedBy,
    })
    .returning();
  return row;
}
