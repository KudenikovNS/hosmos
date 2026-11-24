# Migrations

`0000_baseline.sql` is the **single, hand-authored, authoritative** schema for
this project. It is applied by `drizzle-kit migrate` (driven by
`meta/_journal.json`), which is the only migration path we use.

## Why the baseline is hand-authored (and there is no snapshot)

The schema relies on expression indexes `drizzle-kit generate` cannot emit —
e.g. the `COALESCE(country_code, '--')` / `COALESCE(year, 0)` unique indexes
(the one on `emission_factors` in the baseline, the **eight** in `0004`), and the
app-generated UUID PKs. The baseline is therefore maintained by hand, and
`meta/0000_snapshot.json` was intentionally removed because it never matched the
real baseline and only misled `drizzle-kit generate`. `migrate` does not need it
(verified: a clean `migrate` applies the baseline without any snapshot).

## Billing cron (renewals + period-end transitions)

The daily billing cron (`POST /api/billing/cron`, T-D1) renews due subscriptions
(off-session MIT charge), applies scheduled downgrades at period end, and expires
cancelled subs and elapsed trials. It is NOT session-authenticated — it self-guards
on the `BILLING_CRON_SECRET` env (a `Authorization: Bearer` header). Wire it up as a
cPanel cron job (daily at 03:00):

```
0 3 * * * curl -sS -X POST -H "Authorization: Bearer <BILLING_CRON_SECRET>" https://hosmos.eu/api/billing/cron
```

A missing/wrong token returns 401 and does no work; a correct token returns the run
summary (`{renewed, downgraded, expired, pastDue, failed, errors}`) as JSON.

## `0003_users_roles` — memberships, invitations, roles

`0003_users_roles.sql` adds the company-membership model (`company_members`,
`company_invitations`), a `profiles.active_company_id` column, an
`audit_log.actor_role` snapshot, and a backfill. It is **strictly additive**:
`0000`/`0001`/`0002` are untouched.

### Manual journal (no `drizzle-kit generate`)

Like the baseline, `0003` is hand-authored and registered by hand-editing
`meta/_journal.json` — `drizzle-kit generate` is **not** run for this project
(§0.4). It is applied by `drizzle-kit migrate` in journal order
(`0000 → 0001 → 0002 → 0003`).

### Two partial indexes — hand-authored, edited in PAIRS (R-1)

Both partial indexes below carry a `WHERE` predicate that `drizzle-kit`
serialises **incorrectly**, which is why they are hand-authored in the `.sql`
file rather than generated. Each is **also declared** in
`src/server/db/schema.ts` (so Drizzle's query builder knows about them), and the
two declarations are **not** checked against each other by the compiler. **The
`.sql` and `schema.ts` pair MUST be edited together** — the `.sql` file is the
source of truth; a drift will not fail the build (R-1).

Membership seat/`last-admin` index (`0003_users_roles.sql`, `schema.ts:758-760`):

```sql
CREATE INDEX IF NOT EXISTS company_members_active_idx
  ON company_members (company_id) WHERE status = 'active';
```

One-live-invitation-per-`(company, email)` unique index
(`0003_users_roles.sql`, `schema.ts:798-800`):

```sql
CREATE UNIQUE INDEX IF NOT EXISTS company_invitations_pending_key
  ON company_invitations (company_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
```

The `pending_key` predicate deliberately contains **no `now()`**: `now()` is not
immutable and is forbidden inside an index predicate. So an **expired but
unrevoked** invitation still occupies the slot for its `(company, email)` — a
re-invite must **revoke the old row first**, then insert (§9.6). Expiry is
enforced in application code, not by the index.

### Diagnostic — companies with zero active `esg_admin` (R-3)

The backfill grants every linked profile an `esg_admin`/`active` membership, so a
freshly migrated DB has an admin per company. But a company can still end up with
no admin (backfill missed it, or the last admin was removed by direct SQL). Such
a company is **walled off** — no one holds `members.manage`, so no membership can
be changed through the app. Detect it with:

```sql
SELECT c.id FROM companies c LEFT JOIN company_members m ON m.company_id=c.id AND m.status='active' AND m.role='esg_admin' GROUP BY c.id HAVING count(m.id)=0
```

An empty result means every company has an admin. A non-empty result is a
walled-off company; **recovery is a manual SQL insert/promote** (insert an
`esg_admin`/`active` membership, or promote an existing member). There is no
in-app recovery path — this is accepted explicitly (R-3). The application-level
D9 guard (last-admin protection) prevents the app from ever creating this state.

### Additive and reversible (D11)

`0003` does **not** drop or rewrite the legacy `profiles.company_id` /
`profiles.role` columns — they are retained alongside the new membership rows.
That retention is the **free-rollback mechanism** (D11): the old single-company
model keeps working from its own columns, so reverting to pre-`0003` code needs
no data migration back.

## `0004_data_model` — the Phase-1 data model, and its reference-data tail

`0004_data_model.sql` adds the **20** Phase-1 tables (spec §4, DM-1…DM-31), in
seven banded sections:

| §                                 | tables                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1. Reference                      | `metric_catalog`, `factor_set`, `emission_factor`, `unit_conversion`                            |
| 2. Organisational axis            | `legal_entity`, `facility`, `asset`                                                             |
| 3. Period and boundary            | `reporting_period`, `period_scope`                                                              |
| 4. Revision                       | `report_revision`                                                                               |
| 5. Input (append-only, D23 mixin) | `emission_activity`, `purchased_energy_activity`, `contractual_instrument`, `disclosure_record` |
| 6. Evidence / DQ / validation     | `document`, `evidence_link`, `dq_assessment`, `validation_result`                               |
| 7. Derived artefacts              | `calculation`, `report_render`                                                                  |

### The journal is hand-maintained

Like every migration in this folder, `0004` is hand-authored and registered by
**hand-editing** `meta/_journal.json` — `drizzle-kit generate` is never run
against this branch (§0.4). Its entry is `idx: 4`, tag `0004_data_model`. The
stock migrator (`scripts/migrate.mjs` → `drizzle-orm/postgres-js/migrator`)
applies the journal in `idx` order and decides what is outstanding by comparing
each entry's `when` against the newest `created_at` in
`drizzle.__drizzle_migrations` — **by journal, never by file content**. That
single fact is the reason `0006` exists as its own file (below) and the reason
for the warm-database caveat further down.

### The eight partial/expression indexes — edited ONLY in pairs (R-7)

`drizzle-kit` serialises a `WHERE` predicate wrongly and truncates a string
literal inside a `COALESCE`, so these eight indexes are written by hand in the
`.sql`. Each is **also** declared in `src/server/db/schema.ts` so Drizzle's query
builder knows about it, and **nothing in the compiler checks the two
declarations against each other** (R-1, inherited from the `0003` pair above).

**The `.sql` is the source of truth. The pair MUST be edited together.** The
guard against drift is a test, not the type system:
`src/server/db/__tests__/schema-0004.integration.test.ts` →
`"T1.2 — the eight hand-authored indexes are declared as PAIRS (R-1)"` pins both
sides — the `pg_indexes.indexdef` fragment in a live database _and_ a regex over
the `schema.ts` source, name **and** predicate. Reformatting a declaration means
updating that regex in the same commit.

All eight, verbatim from `0004_data_model.sql`:

```sql
-- [INDEX 1/8] PARTIAL — "the current rows of a revision" (§0.4, DM-12).
-- PAIR (R-1): schema.ts `emissionActivity`.
CREATE INDEX IF NOT EXISTS emission_activity_current_idx
  ON emission_activity (revision_id) WHERE superseded_by_id IS NULL;

-- [INDEX 2/8] PARTIAL (DM-12). PAIR (R-1): schema.ts `purchasedEnergyActivity`.
CREATE INDEX IF NOT EXISTS purchased_energy_activity_current_idx
  ON purchased_energy_activity (revision_id) WHERE superseded_by_id IS NULL;

-- [INDEX 3/8] PARTIAL (DM-12). PAIR (R-1): schema.ts `contractualInstrument`.
CREATE INDEX IF NOT EXISTS contractual_instrument_current_idx
  ON contractual_instrument (revision_id) WHERE superseded_by_id IS NULL;

-- [INDEX 4/8] PARTIAL (DM-12). PAIR (R-1): schema.ts `disclosureRecord`.
CREATE INDEX IF NOT EXISTS disclosure_record_current_idx
  ON disclosure_record (revision_id) WHERE superseded_by_id IS NULL;

-- [INDEX 5/8] PARTIAL unique — exactly one current revision per period.
CREATE UNIQUE INDEX IF NOT EXISTS report_revision_period_current_key
  ON report_revision (period_id) WHERE is_current;

-- [INDEX 6/8] EXPRESSION unique — VAL-031: one factor per (set, source+version,
-- activity, geography, unit, year).
CREATE UNIQUE INDEX IF NOT EXISTS emission_factor_resolution_key
  ON emission_factor (
    factor_set_id,
    source_name,
    source_version,
    activity_type,
    geography,
    input_unit,
    COALESCE(applicable_year, -1)
  );

-- [INDEX 7/8] EXPRESSION unique — COALESCE placeholder for the nullable context.
CREATE UNIQUE INDEX IF NOT EXISTS unit_conversion_from_to_context_key
  ON unit_conversion (from_unit, to_unit, COALESCE(activity_context, '--'));

-- [INDEX 8/8] EXPRESSION unique — upsert "latest result per (rule, target)".
CREATE UNIQUE INDEX IF NOT EXISTS validation_result_target_key
  ON validation_result (
    company_id,
    rule_code,
    COALESCE(object_type, '--'),
    COALESCE(object_id,  '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(revision_id,'00000000-0000-0000-0000-000000000000'::uuid)
  );
```

Why each one cannot be an ordinary constraint, in one line apiece:

- **1–4** are partial by intent, not by optimisation: an append-only table
  accumulates every superseded version, and every read that matters asks for the
  _live_ rows of a revision. The predicate keeps the index the size of the
  working set rather than of the history.
- **5** is a partial **unique** — `is_current` is a flag, not a key, so
  "at most one current revision per period" is expressible only as a predicate.
  Proven by behaviour, not by inspection: a second `is_current` row errors at the
  database.
- **6** is an expression unique because `applicable_year` is nullable (the 14
  refrigerant factors leave it NULL — a GWP is year-independent) and Postgres
  treats NULLs as DISTINCT under a plain `UNIQUE`. A table constraint therefore
  could not reject a duplicate refrigerant row at all; `-1` is a value no real
  year can take. `geography` needs no `COALESCE` — it is `NOT NULL` (a missing
  country normalises to `'GLOBAL'`).
- **7** is the same trick for `activity_context`, whose NULL means "universal
  physical conversion".
- **8** is the same trick for all three nullable target columns — and note that
  `company_id` **leads** the key (О-17, deviating from spec §4.18): without it a
  fully-NULL-target row would be unique across the whole installation and one
  tenant's upsert would silently overwrite another's.

### `-- === REFERENCE DATA ===` — why the seed ships inside the migration

The file ends with the marker

```
-- === REFERENCE DATA (owners: T1.4 metrics, T1.5 factors/units, T1.8 plans.features) ===
```

Everything below it is DATA, not DDL, appended **into this same file** by
T1.4/T1.5/T1.8 rather than into a new migration (О-13, MIG-6). Five generated
blocks, each fenced by `>>> BEGIN GENERATED: <table>` / `<<< END GENERATED`:
`metric_catalog` (141 VSME rows), `factor_set`, `emission_factor`,
`unit_conversion`, `plans` (the six new `features` keys).

**Why the migration and not the seed.** `deploy.yml` ships to the server exactly
three things — `.next/standalone`, `scripts/migrate.mjs` and `drizzle/` — and
then runs `node scripts/migrate.mjs`. Neither `src/server/db/seed.ts` nor `tsx`
ever reaches the host, and there is no other production entry point. Reference
data that lived only in the seed would therefore never exist in production: no
active `factor_set` means every calculation fails on a missing factor, an empty
`metric_catalog` means every disclosure 422s, and a period cannot be created at
all. So the Phase-1 reference minimum has to travel **with** the migration. The
precedent was already in the tree — `0002_data_integrity.sql` inserts
`currencies` inline for exactly this reason.

**Why there is nevertheless a single source of truth.** The SQL blocks are not
typed by hand: `scripts/gen-reference-sql.mjs` renders them from
`src/server/db/seed-data/*` (`vsme-metrics.ts`/`.json`, `factor-set-v1.ts`,
`legacy-factors.ts`, `unit-conversions.ts`) plus `PLAN_SEED` from
`src/server/billing/plan-catalog.ts`. `src/server/db/seed.ts` is a thin wrapper
over the **same** modules. Two delivery paths, one source — they cannot
disagree, and a corrected workbook is regenerated, never re-typed:

```
node scripts/gen-vsme-metrics.mjs   # workbooks → seed-data/vsme-metrics.json
node scripts/gen-reference-sql.mjs  # seed-data/* → the GENERATED blocks in 0004
```

Never edit inside a `GENERATED` fence by hand. Each block is idempotent:
`ON CONFLICT DO NOTHING` for the factor tables (DM-21 — a released factor set is
never edited; a correction is a NEW set) and `DO UPDATE` for `metric_catalog`.

### Operational caveat — a warm dev DB will never see the appended data

The migrator decides what to apply from `meta/_journal.json`'s `when` timestamp
versus `__drizzle_migrations.created_at`, **not** from the file's hash. So a
database that already ran `db:migrate` on the DDL-only version of `0004` has
`0004` recorded as applied, and every later run skips the file entirely —
including the reference-data blocks appended afterwards. Symptoms: no active
`factor_set`, an empty `metric_catalog`, disclosures 422-ing.

Two ways out, both fine:

- `npm run db:seed` — the catch-up path. `seed.ts` reads the same `seed-data/*`
  source as the generated SQL, so it cannot disagree with it.
- Recreate the database (`db:migrate` from scratch), which is what the
  `[LOCAL-DB]` recipe does on every run anyway.

Production is never affected: `0004` is unapplied there until S1 merges, so it
arrives complete. This caveat exists purely for warm developer databases.

Because this data reaches production only through the migrator, it is verified
**on production** after the S1 deploy, not only on a throwaway database
(О-13/MIG-6, checkpoint KT-1):

```sql
SELECT count(*) FROM metric_catalog;                    -- 141
SELECT code, status FROM factor_set;                    -- legacy-v1 / active
                                                        -- (after 0011: si-2025 alone)
SELECT count(*) FROM emission_factor;                   -- non-empty
SELECT count(*) FROM unit_conversion;                   -- non-empty
SELECT code, features FROM plans;                       -- six new keys, all four plans
```

## `0005_drop_legacy` — the first destructive migration

`0005_drop_legacy.sql` drops the five tables of the pre-Phase-1 model:
`monthly_emissions_data`, `people_data`, `emission_results`, `emission_factors`
and `emission_factor_sources` (plan T3.9; spec MIG-9/MIG-11). Their last
consumers were removed in T3.6/T3.7/T3.8, and the same commit removes their
declarations from `src/server/db/schema.ts` and their seeding from `seed.ts`.
The legacy factor VALUES survive as code in
`src/server/db/seed-data/legacy-factors.ts` — factor set `legacy-v1` is built
from them, which is what made the table droppable.

Journal entry: hand-written `idx: 5`, tag `0005_drop_legacy`.

**Why dropping is safe (О-2).** The product is **pre-launch**. These five tables
hold development rows only — there is no customer data in them, so "archive
instead of drop" would preserve nothing anyone will ever want. The one thing
worth keeping, the legacy factor _values_, was already moved into code
(`seed-data/legacy-factors.ts`) by T1.3 and is what factor set `legacy-v1` is
built from. That move is precisely what made the table droppable, and it means
the numbers a company is calculated with did not change across `0005` — only the
table that held a second copy of them is gone.

**Why the only rollback is forward (R-8).** Reversibility here is not a data
problem, it is a code problem, and it is stated honestly rather than pretended
away:

- **Before** `0005` reaches `main`, a rollback is a redeploy of the previous
  build. `0000`–`0004` are strictly additive, so old code simply does not see the
  new tables and keeps working from the old ones.
- **After** `0005` has run, the tables are gone. An older build would issue
  `SELECT … FROM monthly_emissions_data` against a relation that no longer
  exists and fail on the first request. There is no down-migration, and writing
  one would be a lie: it could recreate the empty shells but not the rows.
  **The only way back is forward — a fix commit.** This is accepted deliberately
  (R-8): pre-launch, the cost of a forward fix is a deploy, and the alternative
  (keeping five dead tables and a schema nobody reads) is the "two mechanisms
  that silently diverge" failure the whole phase is written against.

**Every statement is `DROP TABLE IF EXISTS … CASCADE`**, so a repeat run is a
no-op and the migration does not trip over the dependent FK/index objects
(`emission_factors.source_id`, the hand-written `COALESCE` unique index on
`emission_factors`, the `companies`/`profiles` FKs of the three wide tables).
`CASCADE` cannot reach a surviving table: nothing outside those five referenced
them (checked against `pg_constraint`).

Also deleted with it: the whole pre-drizzle Supabase migration tree
(`001_baseline`, `002_seed_emission_factors`, `003_factors_country_year`). It
created and seeded exactly the tables `0005` drops, so leaving it would make it
the last place in the repository where the legacy schema lived — and the first
place someone would reach when standing a database up from scratch. **The way to
create a database is `npm run db:migrate` (or `node scripts/migrate.mjs`), and
nothing else.**

## `0006_retire_report_gating` — the legacy report gate leaves `plans.features`

`0006_retire_report_gating.sql` is one statement:

```sql
UPDATE plans SET features = features - 'reports' - 'maxReportsPerMonth';
```

Journal entry: hand-written `idx: 6`, tag `0006_retire_report_gating`.

**What goes and why (О-15).** `features->'reports'` (a list of framework ids —
gri, esrs, cdp, ungc, taxonomy, tcfd) and `features->'maxReportsPerMonth'` (a
render quota) come from the pre-Phase-1 product, where a "report" was a framework
you subscribed to. Phase 1 renders exactly **one** pack, VSME Basic, and prices
the **format** of it (`reportFormats`, PG-2) while _disclosing_ what the plan
leaves out (`excluded_by_plan` / `coverage_claim`, D14). The last consumer of the
old keys — the legacy `/reports` page — died in T3.8; `canAccessReport()`,
`getRequiredPlan()` and `requireReport()` were deleted in the same commit as this
migration, and `PlanFeatures` lost both fields.

**Why the row has to be touched at all, given nothing reads it.**
`planRowsToFeatures` builds the runtime entitlement matrix by spreading the
**stored** config over the code defaults, so a key that survives in
`plans.features` survives in `getEntitlements().features`. An entitlement object
still advertising `reports: ["gri"]` that no code may consult is exactly the pair
of near-homonymous gates О-15 refuses to keep — two mechanisms left "just in
case" diverge silently. The catalogue is the runtime source of truth (§6.2); it
must stop offering a gate that no longer exists. After `0006`, the only format
gate is `reportFormats`, alongside the D14/F1 completeness gates.

**Why a new migration and not an edit to `0004`.** By S5, `0004` is long applied
in production. The migrator applies **by journal, not by content** (see the
`0004` section above), so anything appended to `0004` today would run on a fresh
database and never on the server that matters. The rule this produced: _a change
to already-shipped data is a NEW numbered migration, always._

**Idempotent by the operator itself.** `jsonb - 'key'` returns the object
unchanged when the key is absent, so a second run is a no-op, a database that
never had the keys lands on the same rows, and a row carrying only one of the two
loses that one and keeps the rest. The `UPDATE` deliberately has **no `WHERE`** —
all four plans are subject to the same retirement, and a `WHERE features ?
'reports'` filter would only make the no-op case implicit instead of explicit.
`updated_at` is left alone: that column tracks catalogue edits an administrator
made, not schema maintenance.

Verified end-to-end in
`src/server/billing/__tests__/plans-migration.integration.test.ts` (`0006`
removes both keys whatever else is stored; is a no-op where they never existed;
is stable across repeated runs; and after a full `0000→0006` the real `plans`
table carries neither key).

## `0011_retire_legacy_v1` — the second destructive migration

`0011_retire_legacy_v1.sql` empties every operational table and then deletes
factor set `legacy-v1`. Journal entry: hand-written `idx: 11`, tag
`0011_retire_legacy_v1` (`idx: 8` stays reserved for `0008_fx_rates` on its own
branch). The file's own header carries the full argument; this is the short form.

**What it empties, in order:** `report_render`, `calculation`,
`validation_result`, `evidence_link`, `dq_assessment`, the four input tables,
`report_revision`, `period_scope`, `reporting_period`, `asset`, `facility`,
`legal_entity` — then `DELETE FROM factor_set WHERE code = 'legacy-v1'`.

**What it keeps:** accounts, tenancy and billing; `document` (DM-26 — a document
is company evidence, not revision output); `audit_log`; the parked per-company
tables (`scope3_spend`, `scope3_results`, `supply_chain_data`, `goals`); and all
reference data that is not `legacy-v1`, including the **38 shared**
`unit_conversion` rows (`factor_set_id IS NULL`), which `si-2025` resolves
through.

**Why the order is explicit and not a cascade.** `reporting_period.factor_set_id`,
`calculation.factor_id` and `purchased_energy_activity.location_factor_id` /
`market_factor_id` are declared with **no** `ON DELETE`, so Postgres refuses the
delete instead of following it — that refusal is the AC-8 reproducibility
guarantee (`reproducibility.integration.test.ts` proves it). **`0011` does not
weaken those constraints**; it deletes the dependents itself, so the blast radius
is readable in the SQL rather than hidden in a cascade. `TRUNCATE … CASCADE` was
rejected for the same reason.

**Why it is safe (О-2, as for `0005`).** Pre-launch: no customer row exists, and
the showcase demo is regenerated afterwards by `scripts/demo-seed.mjs` through
the product's own API. Rollback is forward only (R-8) — a down-migration could
re-insert `legacy-v1` from `0004`'s generated block but not one row of the
operational data.

**Two consequences to know about.** Scope-3 spend loses its factors (the 16
`scope3_spend:*` EXIOBASE rows lived only in `legacy-v1`), so
`activeFactorSetId` returns `null`, the commodity dropdown empties, spend writes
are refused with `VALIDATION`, and stored lines price at 0 with a
`no spend factor for …` warning. And `npm run db:seed` still rebuilds
`legacy-v1` on developer/CI databases on purpose (see the header of
`src/server/db/seed.ts`) — the test corpus is pinned to its factors. **After
`db:migrate` alone, which is all the server ever runs, `si-2025` was then the
only set.** Later migrations add revisions of it — `si-2025-r2` … `si-2025-r5`
(`0015`, `0020`, `0023`, `0024`); `r4` brings Scope-3 spend factors back.

## `DOCUMENTS_DIR` — the blob root (operations)

Evidence uploads (T4.1) and immutable report renders (T5.7) are the only bytes
this product stores outside Postgres. They all go through
`src/server/storage/document-storage.ts` (`DocumentStorage`, EV-0); nothing else
touches `fs`. The Phase-1 backend is the server's local filesystem, because the
deploy target is shared cPanel (neoserv) with no S3.

Layout — the key **is** the content hash, which is what makes a re-uploaded
invoice free:

```
$DOCUMENTS_DIR/<companyId-uuid>/<sha256>      # one stored object
$DOCUMENTS_DIR/.tmp/put-<uuid>                # in-flight upload, mode 0600
```

### Where it must live

**Outside the web root, and outside the deployed application directory.** Two
separate hazards, both real on this host:

1. Anything under `public_html` would be served by the web server directly,
   bypassing the authorised download route — customer evidence published to the
   internet. `DocumentStorage` refuses to guess: an unset or blank
   `DOCUMENTS_DIR` is a loud `STORAGE_NOT_CONFIGURED` on **first use**, never a
   silent `./uploads` fallback (that fallback is precisely what would land inside
   the deployed app directory).
2. `deploy.yml` rsyncs the build with `rsync -az --delete … .next/standalone/ →
~/hosmos/`, excluding only `tmp` and `.ftpquota`. A documents directory placed
   anywhere under `~/hosmos` would therefore be **deleted on the next deploy**.

The convention (see `.env.example`) is a sibling of the app directory:

```
DOCUMENTS_DIR=/home/<cpanel-user>/hosmos-documents
```

Absolute path, must already exist. `DocumentStorage` `stat`s it on every call and
throws `STORAGE_NOT_CONFIGURED` if it is not a directory.

### Permissions

```
mkdir -p /home/<cpanel-user>/hosmos-documents
chmod 700 /home/<cpanel-user>/hosmos-documents
```

`0700` on the root: only the cPanel account (which is the Passenger worker's
user) needs to read or write it. Temp files are created with an explicit `0600`;
the per-company subdirectories are created by `mkdir` and inherit the process
umask, so the `0700` root is what actually guarantees containment — set it once,
at creation. Two independent traversal defences sit in front of the path anyway:
the key is validated against `^uuid/[0-9a-f]{64}$` (never url-decoded, so
`..%2f..` stays one malformed segment), and the resolved path is re-checked to
start with the root.

### Volume

Dominated by evidence PDFs; renders are small and one per (revision, format,
language). Growth is bounded by the per-plan `maxUploadMb` cap, which storage
enforces **streaming** — an over-limit body is aborted mid-flight and never lands
under a real key — and damped by content-hash dedup: two documents with identical
bytes share one file.

Check what is used and what is left:

```bash
# free space on the filesystem holding the blob root — the command to run first
df -h "$DOCUMENTS_DIR"

# what this directory itself costs, and where it went
du -sh "$DOCUMENTS_DIR"
du -sh "$DOCUMENTS_DIR"/*/ | sort -h | tail -20

# on shared cPanel the account QUOTA bites long before the filesystem does
quota -s 2>/dev/null || echo "no quota tool — read the cPanel disk-usage panel"
```

There is **no quota monitoring in this project** — that is the explicitly
accepted residual of risk R-3, and this note is the whole of the mitigation.
Check `df -h "$DOCUMENTS_DIR"` before and after any bulk evidence import.

### Backup

Postgres and the blob root are backed up **separately**, and a restore that mixes
generations is a report whose `storage_key` points at nothing. The backup path
this project standardises on:

```
/home/<cpanel-user>/backups/hosmos-documents/documents-<YYYY-MM-DD>.tar.gz
```

```bash
mkdir -p /home/<cpanel-user>/backups/hosmos-documents
tar -czf "/home/<cpanel-user>/backups/hosmos-documents/documents-$(date +%F).tar.gz" \
    -C "$DOCUMENTS_DIR" --exclude='.tmp' .
```

`.tmp` is excluded deliberately: it holds in-flight uploads that are not
addressable by any key and are worthless in a restore. Note that the backup
directory is _also_ outside `~/hosmos`, for the `--delete` reason above.

Restore is `tar -xzf … -C "$DOCUMENTS_DIR"`; because the filename is the content
hash, extracting over an existing tree is idempotent and cannot corrupt an object
— a file either matches its own hash or does not exist. **No automation ships
with the repository**: there is no backup cron, no retention policy and no
restore drill. Whoever operates the host schedules the command above (the billing
cron above is the precedent for how a cPanel cron job is registered).

### When the disk quota is exhausted

What happens, concretely:

- **Uploads fail.** `put` writes to `.tmp/put-<uuid>` first, so `ENOSPC` /`EDQUOT`
  surfaces from the write and the object never appears under a real key — a
  truncated document is not a possible outcome. The `finally` block unlinks the
  temp file, so a failed upload leaves nothing behind.
- **Renders fail the same way**, and because a render row is inserted only after
  the bytes are stored, a full disk produces no `report_render` row pointing at a
  missing file.
- **Reads keep working.** `getStream`, `stat` and `delete` need no space; already
  stored evidence and already generated reports stay downloadable, and the
  application keeps serving. Only the write paths degrade.
- **Caveat, stated rather than implied:** a quota error is _not_ one of the typed
  `DocumentStorageError` codes. `LIMIT_EXCEEDED` means "the caller's per-plan cap
  was exceeded", not "the disk is full"; a genuine `ENOSPC`/`EDQUOT` propagates
  as a raw Node `ErrnoException` out of `put` and is answered as a generic 500.
  So the operator's signal is a 500 on upload plus the `df` output above — the
  application will not name the disk for you.

### What the `.tmp` sweep does and does not cover

`put`'s `finally` deletes its own temp file on **every way a request ends** — a
refusal, an over-limit body, a broken stream, a dedup hit. It cannot cover a way
the _process_ stops: SIGKILL, an OOM kill, a Passenger restart mid-upload. Each
such death strands one temp file of up to `maxUploadMb`. The sweep collects
those.

**Covered:** regular files named `put-*` directly inside `$DOCUMENTS_DIR/.tmp`
whose `mtime` is older than one hour. It runs at the top of `put`, at most once
per hour per worker instance, before that call's own temp file exists, and each
candidate is re-`stat`ed immediately before `unlink` so a stale listing cannot
remove a file that has since been rewritten. Age is measured from `mtime`, not
from creation, so an upload that is still writing keeps pushing itself out of
range — a slow client trickling 20 MB for two hours is never one hour stale.

**Not covered, and each is deliberate:**

- **Stored objects.** The sweep reads `.tmp` only. Nothing ever garbage-collects
  `<companyId>/<sha256>`: deletion is an explicit product action (D6/EV-3), and a
  file survives being unlinked from a row (DM-26). An orphaned object — a
  document row deleted while another row still referenced the same bytes, or a
  discarded revision — is **not** reclaimed. Reclaiming disk from stored objects
  is a manual operation, and today there is no report that lists orphans.
- **Anything not named `put-*`, and any subdirectory of `.tmp`.** A file dropped
  there by hand stays forever.
- **A stalled upload younger than an hour.** Up to `maxUploadMb` per crashed
  worker is held until the next hourly window.
- **An idle deployment.** The sweep hangs off `put`, so a server nobody uploads
  to never sweeps. That is the intended trade: the collector runs exactly when
  the resource is being consumed, needs no cron to be installed by hand, and
  cannot silently fail to be scheduled. If disk is tight and uploads have
  stopped, `find "$DOCUMENTS_DIR/.tmp" -name 'put-*' -mmin +60 -delete` does the
  same job by hand.

## `0025_dq_assessment_tenant_key` — company-owned quality assessments

Replaces the global `dq_assessment` unique key with
`(company_id, object_type, object_id)`. Shared emission factors can now have an
independent assessment in each company. The upsert and carry hook use the same
key. Existing assessment rows, ids, scores and authors are retained; the
migration cannot recover values overwritten before the fix.

Apply through `node scripts/migrate.mjs` as part of the normal deployment path.
Migration checks and tests run only on databases created by `scripts/review-db.sh`.

### Read-only diagnostic for previously overwritten assessments

The following query lists factor assessments whose author has no membership
record in the assessment's company. It can be used before or after migration
to identify records for investigation; it does not change any data.

```sql
SELECT d.id, d.company_id, d.object_id, d.assessed_by, d.assessed_at
FROM dq_assessment d
WHERE d.object_type = 'emission_factor'
  AND d.assessed_by IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM company_members m
    WHERE m.user_id = d.assessed_by
      AND m.company_id = d.company_id
  );
```

An empty result means this check found no suspicious records, not that no
overwrite ever occurred: an author who also belongs to the affected company
will not be detected. Matches also need to be checked against membership
history. Do not filter only active memberships: a legitimate assessor may
have since left the company. The query cannot recover the original scores;
any restoration requires verified historical data, such as a backup or audit
record containing the original values.

## `0026_calculation_run_context` — immutable calculation inputs

Adds `calculation_run_context` with one versioned JSON snapshot per run,
including runs with zero result lines. The application writes it atomically
with `calculation` rows. The table has company ownership, a revision FK and an
index for the latest run; no existing rows or constraints are changed.

Deploy code and SQL/journal together. The normal production runner
`node scripts/migrate.mjs` applies the migration before restarting the app.
No manual seed or data rewrite is needed. The old code can continue running
while the additive table is created.

There is deliberately no backfill from the live registry. Existing runs keep
their saved emission results, but historical turnover/intensity/energy split
are withheld with an explicit missing-context explanation. Open revisions can
be recalculated after deployment. Old locked revisions without a pinned context
require verified historical inputs before recalculation; an existing archived
file remains untouched. Restating an old report creates a new draft that can
use current inputs without rewriting the old run.

Legacy locked runs therefore remain stale with source `context`: VESG
`data_quality` needs attention and readiness's calculation step is incomplete.
Restatement allows work to continue in a new revision, but does not restore the
old context. VSME-032 (GHG intensity) reads as missing while its intensity is
withheld (F12, fixed 20.11.2026).
In newly generated legacy reports, B3 labels unknown historical entity names
explicitly in the report language; UUIDs and unmarked current names are not used
as entity display names. Existing archived PDF/XLSX files are not changed.

## Changing the schema

Edit `src/server/db/schema.ts` **and** the `.sql` by hand, together — the
baseline for a table it created, otherwise a NEW numbered migration plus its
hand-written journal entry (never a retro-edit of an applied file). Then verify
with a clean run: drop the DB, `npm run db:migrate`, `npm run db:seed`, and
`npm test`. Do **not** run `drizzle-kit generate`
against this branch — without a snapshot it would emit a spurious full-schema
migration. If the project ever moves to generated migrations, regenerate a
matching snapshot first.
