// REPORTING PERIODS (DM-7, DM-7a) — the row every number in the product is
// eventually attributed to, and the one that PINS what it is calculated with.
//
// See docs/decisions/server-periods-periods.md for the full account.
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import {
  integerOrNull,
  isoDateOrNull,
  oneOfOrNull,
  textOrNull,
  uuidOrNull,
  type ParseResult,
} from "@/server/api/parse";
import type { DbClient } from "@/server/db/client";
import { factorSet, reportingPeriod } from "@/server/db/schema";
import {
  refuseValidation,
  ruleRef,
  writeValidated,
  type WriteResult,
} from "@/server/validation/write";
import {
  isMethodologyVersion,
  isReportingBasis,
  METHODOLOGY_VERSIONS,
  type PeriodStatus,
} from "@/shared/enums";

import {
  CALCULATION_BEARING_FIELDS,
  derivePeriodStatus,
  loadCurrentRevisions,
  loadPeriodsWithLockedRevision,
} from "./lifecycle";

/** A `reporting_period` row as Drizzle returns it. */
export type PeriodRow = typeof reportingPeriod.$inferSelect;

/** The column values a create/update writes (never `company_id`, never `id`). */
export type PeriodValues = Partial<
  Omit<typeof reportingPeriod.$inferInsert, "id" | "companyId">
>;

/** A create's values: the NOT NULL columns are guaranteed present. */
export type NewPeriodValues = PeriodValues & {
  periodName: string;
  startDate: string;
  endDate: string;
  reportingYear: number;
  methodologyVersion: string;
};

/**
 * A calendar year a human could have meant. NOT a rule's range — no VAL-* code
 * owns `reporting_year` — so it is enforced here, for the same reason
 * `floor_area` is: nothing downstream would ever catch year 12, and `integer`
 * overflows as a driver error rather than as a validation failure.
 */
const YEAR_MIN = 1900;
const YEAR_MAX = 2200;

// ─── Wire contract (§4.5 — DD names, plus К-13/К-19/К-24) ────────────────────

/**
 * One period as the API speaks it.
 *
 * `company_id` is absent (the tenant is the session, PATTERN 3). Two fields are
 * DERIVED and have no column behind them: `factor_set_version` (К-24 — the
 * pinned set's `code`) and `period_status` (К-4 — the LC-2 mapping of the
 * current revision, in the workbook's own spelling, spaces and capitals
 * included).
 */
export interface PeriodDto {
  id: string;
  period_name: string;
  start_date: string;
  end_date: string;
  reporting_year: number;
  base_year: number | null;
  reporting_basis: string;
  methodology_version: string;
  factor_set_id: string;
  /** К-24 — `factor_set.code` of the pinned set, e.g. `'legacy-v1'`. */
  factor_set_version: string;
  comparative_period_id: string | null;
  /** К-4 / LC-2 — derived, never stored. `Draft` while there are no revisions. */
  period_status: PeriodStatus;
  /** The current revision's id, or `null` while the period has none (партия 17). */
  current_revision_id: string | null;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** The two derived fields a period cannot be serialised without. */
interface DerivedFields {
  factorSetVersion: string;
  periodStatus: PeriodStatus;
  currentRevisionId: string | null;
}

/** THE serialiser. Every response about a period goes through it. */
function toDto(row: PeriodRow, derived: DerivedFields): PeriodDto {
  return {
    id: row.id,
    period_name: row.periodName,
    start_date: row.startDate,
    end_date: row.endDate,
    reporting_year: row.reportingYear,
    base_year: row.baseYear,
    reporting_basis: row.reportingBasis,
    methodology_version: row.methodologyVersion,
    factor_set_id: row.factorSetId,
    factor_set_version: derived.factorSetVersion,
    comparative_period_id: row.comparativePeriodId,
    period_status: derived.periodStatus,
    current_revision_id: derived.currentRevisionId,
    created_by: row.createdBy,
    created_at: row.createdAt?.toISOString() ?? null,
    updated_at: row.updatedAt?.toISOString() ?? null,
  };
}

/**
 * Serialise periods, resolving the two derived fields in THREE queries for the
 * WHOLE list rather than three per row — the period screen lists every period of
 * the company, and an N+1 introduced here would be an N+1 for ever.
 *
 * The third query is LC-2's seventh case (T2.6): `Reopened` is a draft revision
 * with `revision_no > 1` over a period that already has a LOCKED one, and
 * "already has a locked one" is not visible on the current revision. T2.4 left
 * it as a defaulted parameter of `derivePeriodStatus` because nothing could lock
 * a revision yet; this is the call site that fills it.
 *
 * A period whose pinned set has somehow vanished serialises with an empty
 * `factor_set_version` rather than throwing: the FK makes that impossible today,
 * and a 500 on a read would be a poor way to report a broken pin.
 */
export async function serialisePeriods(
  db: DbClient,
  companyId: string,
  rows: readonly PeriodRow[],
): Promise<PeriodDto[]> {
  if (rows.length === 0) return [];

  const setIds = [...new Set(rows.map((row) => row.factorSetId))];
  const sets = await db
    .select({ id: factorSet.id, code: factorSet.code })
    .from(factorSet)
    .where(inArray(factorSet.id, setIds));
  const codeById = new Map(sets.map((set) => [set.id, set.code]));

  const periodIds = rows.map((row) => row.id);
  const current = await loadCurrentRevisions(db, companyId, periodIds);
  const locked = await loadPeriodsWithLockedRevision(db, companyId, periodIds);

  return rows.map((row) =>
    toDto(row, {
      factorSetVersion: codeById.get(row.factorSetId) ?? "",
      periodStatus: derivePeriodStatus(current.get(row.id), {
        hasLockedRevision: locked.has(row.id),
      }),
      currentRevisionId: current.get(row.id)?.id ?? null,
    }),
  );
}

/** Serialise one period (the single-row half of {@link serialisePeriods}). */
export async function serialisePeriod(
  db: DbClient,
  companyId: string,
  row: PeriodRow,
): Promise<PeriodDto> {
  const [dto] = await serialisePeriods(db, companyId, [row]);
  return dto;
}

/**
 * Wire → columns, with per-field SHAPE validation only (see `@/server/api/parse`
 * for where the line runs). Three fields are worth naming:
 *
 *   • `start_date`/`end_date` are parsed as dates and NOT compared — the
 *     ordering is VAL-008's, and duplicating it here would answer
 *     `{field:"end_date"}` and leave the rule unreachable from the API (the
 *     same mistake `latitude` avoids in `@/server/org/facilities`);
 *   • `methodology_version` IS membership-checked, because К-19 makes the
 *     constant the dictionary of the column — there is no rule behind it;
 *   • `factor_set_id` is only checked as a uuid here; whether it names an
 *     ACTIVE set is resolved against the table inside the write.
 *
 * `partial` is PATCH semantics: an absent key means "leave it alone", and an
 * empty result means "you asked me to change nothing", which is a rejection.
 */
function parseInput(
  body: unknown,
  opts: { partial: boolean },
): ParseResult<PeriodValues> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, field: "body" };
  }
  const input = body as Record<string, unknown>;
  const values: PeriodValues = {};
  const reject = (field: string): ParseResult<PeriodValues> => ({
    ok: false,
    field,
  });

  // NOT NULL text: present on a create, never blankable on a PATCH.
  if (input.period_name !== undefined || !opts.partial) {
    const name = textOrNull(input.period_name);
    if (name === undefined || name === null) return reject("period_name");
    values.periodName = name;
  }

  const DATE_FIELDS = [
    ["start_date", "startDate"],
    ["end_date", "endDate"],
  ] as const;
  for (const [api, column] of DATE_FIELDS) {
    if (input[api] === undefined && opts.partial) continue;
    const parsed = isoDateOrNull(input[api]);
    // Both are NOT NULL — clearing one is a rejection, not a NULL.
    if (parsed === undefined || parsed === null) return reject(api);
    values[column] = parsed;
  }

  if (input.reporting_year !== undefined) {
    const year = integerOrNull(input.reporting_year, YEAR_MIN, YEAR_MAX);
    if (year === undefined || year === null) return reject("reporting_year");
    values.reportingYear = year;
  }

  if (input.base_year !== undefined) {
    const year = integerOrNull(input.base_year, YEAR_MIN, YEAR_MAX);
    if (year === undefined) return reject("base_year");
    values.baseYear = year; // nullable — clearing a base year is legitimate
  }

  if (input.reporting_basis !== undefined) {
    const basis = oneOfOrNull(input.reporting_basis, isReportingBasis);
    if (basis === undefined || basis === null) return reject("reporting_basis");
    values.reportingBasis = basis;
  }

  if (input.methodology_version !== undefined) {
    const version = oneOfOrNull(
      input.methodology_version,
      isMethodologyVersion,
    );
    if (version === undefined || version === null) {
      return reject("methodology_version");
    }
    values.methodologyVersion = version;
  }

  if (input.factor_set_id !== undefined) {
    const id = uuidOrNull(input.factor_set_id);
    // NOT NULL (К-24): a period without a pinned set is not a period, so
    // `null` is a rejection here and not "use the default" — omitting the key
    // is how a caller asks for the default.
    if (id === undefined || id === null) return reject("factor_set_id");
    values.factorSetId = id;
  }

  if (input.comparative_period_id !== undefined) {
    const id = uuidOrNull(input.comparative_period_id);
    if (id === undefined) return reject("comparative_period_id");
    values.comparativePeriodId = id; // nullable — unlinking is legitimate
  }

  if (opts.partial && Object.keys(values).length === 0) return reject("body");
  return { ok: true, values };
}

/**
 * POST body → the values of a NEW period, with the three defaults DM-7 allows
 * a caller to omit:
 *
 *   • `reporting_year` — the calendar year of `start_date`. The column is NOT
 *     NULL and for a Phase-1 period the value is not an independent fact; a
 *     fiscal year that straddles two calendar years overrides it explicitly.
 *   • `methodology_version` — the current entry of the К-19 dictionary.
 *   • `factor_set_id` — the active set, resolved against the table by the write
 *     (it is a reference, not a shape, so it does not belong in a parser).
 */
export function parseNewPeriod(body: unknown): ParseResult<NewPeriodValues> {
  const parsed = parseInput(body, { partial: false });
  if (!parsed.ok) return parsed;
  const { periodName, startDate, endDate } = parsed.values;
  if (periodName === undefined) return { ok: false, field: "period_name" };
  if (startDate === undefined) return { ok: false, field: "start_date" };
  if (endDate === undefined) return { ok: false, field: "end_date" };
  return {
    ok: true,
    values: {
      ...parsed.values,
      periodName,
      startDate,
      endDate,
      reportingYear:
        parsed.values.reportingYear ?? Number(startDate.slice(0, 4)),
      methodologyVersion:
        parsed.values.methodologyVersion ?? METHODOLOGY_VERSIONS[0],
    },
  };
}

/** PATCH body → the values to change (absent key = leave alone). */
export function parsePeriodPatch(body: unknown): ParseResult<PeriodValues> {
  return parseInput(body, { partial: true });
}

/**
 * Does this body ask for a CONSOLIDATED period (К-13)?
 *
 * Read off the RAW body, before parsing, because PG-2's 402 has to be decided
 * before the parser's 422 (§0.2) and the plan gate depends on a body field.
 * Anything that is not the literal is "no": a misspelt basis is the parser's
 * rejection, not an upgrade prompt. It lives in the service rather than in the
 * route because BOTH routes gate on it — and because a Next `route.ts` may only
 * export handlers.
 */
export function wantsConsolidatedBasis(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return (body as Record<string, unknown>).reporting_basis === "consolidated";
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** Every period of the company, chronologically. */
export async function listPeriods(
  db: DbClient,
  companyId: string,
): Promise<PeriodRow[]> {
  return db
    .select()
    .from(reportingPeriod)
    .where(eq(reportingPeriod.companyId, companyId))
    .orderBy(asc(reportingPeriod.startDate), asc(reportingPeriod.id));
}

// NO `countPeriods`, deliberately: the `used` of API-3 is the length of the list
// the GET already read, and no plan gate counts periods (PG-1 has no per-period
// axis — see the route). `countFacilities`/`countLegalEntities` exist because a
// LIMIT is spent against them before a row is read.

/** One period of THIS company, or `undefined` (foreign ids read as absent). */
export async function getPeriod(
  db: DbClient,
  companyId: string,
  id: string,
): Promise<PeriodRow | undefined> {
  const [row] = await db
    .select()
    .from(reportingPeriod)
    .where(
      and(eq(reportingPeriod.id, id), eq(reportingPeriod.companyId, companyId)),
    )
    .limit(1);
  return row;
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/** Outcome of a create/update: the row, or why it was refused. */
export type PeriodWriteResult = WriteResult<PeriodRow>;

/** The `period` scope, named once — both writes validate against it. */
const SCOPE = { scope: "period" } as const;

/**
 * The six calculation-bearing fields (DM-7a), as (column, API name) pairs.
 *
 * The API half is typed against `CALCULATION_BEARING_FIELDS`, so renaming a
 * field in one place and not the other is a compile error rather than a rule
 * that silently stops covering a column.
 */
const CALCULATION_BEARING_COLUMNS: readonly (readonly [
  keyof PeriodValues,
  (typeof CALCULATION_BEARING_FIELDS)[number],
])[] = [
  ["factorSetId", "factor_set_id"],
  ["startDate", "start_date"],
  ["endDate", "end_date"],
  ["reportingBasis", "reporting_basis"],
  ["methodologyVersion", "methodology_version"],
  ["baseYear", "base_year"],
];

/**
 * Which calculation-bearing fields a PATCH actually CHANGES (DM-7a).
 *
 * A DIFF, not "which keys were present", and the difference is the whole
 * usability of the period screen: a form that PUTs every field it rendered
 * would otherwise be refused for re-sending `start_date` unchanged, and the
 * user would be told the period is frozen when nothing was being edited.
 * Re-sending an identical value changes no calculation input, so it is not an
 * edit. (The pre-image is read outside the transaction; the FREEZE decision —
 * the revision's status — is taken inside it, by VAL-106.)
 */
function changedCalculationFields(
  existing: PeriodRow,
  values: PeriodValues,
): string[] {
  const changed: string[] = [];
  for (const [column, field] of CALCULATION_BEARING_COLUMNS) {
    const next = values[column];
    if (next !== undefined && next !== existing[column as keyof PeriodRow]) {
      changed.push(field);
    }
  }
  return changed;
}

/**
 * Resolve the factor set a period pins (К-24), tenant-independently — the
 * library is REFERENCE DATA, shared by every company, so there is no
 * `company_id` to pin here. What replaces it is the STATUS: only an `active`
 * set may be pinned (DM-21), so a draft set (not released yet) and an archived
 * one (superseded) are both refused, with no rule code — as with any other
 * reference that does not resolve, the API's answer is that it does not exist
 * for this purpose (API-1).
 *
 * With no id at all the ACTIVE set is chosen: the most recently PUBLISHED one,
 * breaking ties by code so the choice is deterministic rather than
 * insertion-ordered. `NULLS LAST` is load-bearing and not decoration —
 * Postgres sorts NULLs FIRST under `DESC`, so without it an active set that was
 * never stamped with a `published_at` would outrank every released one and
 * quietly become the default pin of every new period. A platform with no active
 * set cannot have periods at all (the column is NOT NULL) and the create is
 * refused rather than crashing on the FK.
 */
async function resolveFactorSet(
  tx: DbClient,
  id: string | undefined,
): Promise<string> {
  const rows = await tx
    .select({ id: factorSet.id })
    .from(factorSet)
    .where(
      id === undefined
        ? eq(factorSet.status, "active")
        : and(eq(factorSet.id, id), eq(factorSet.status, "active")),
    )
    .orderBy(sql`${factorSet.publishedAt} DESC NULLS LAST`, asc(factorSet.code))
    .limit(1);

  if (rows.length === 0) refuseValidation();
  return rows[0].id;
}

/**
 * Refuse an inverted period BEFORE the insert, naming VAL-008.
 *
 * SAME REASON AS AN FK (see `@/server/validation/write`), and it is worth being
 * explicit about because the CHECK looks like it makes this redundant.
 * `reporting_period_dates_check` is a STORAGE guarantee: it fires as a driver
 * error, which `writeValidated` cannot turn into anything but a 500, and it
 * fires BEFORE the evaluator that owns the ordering could speak. So the two
 * live at two levels on purpose — the app refuses with the rule code the UI
 * renders against the field, the database refuses the row no matter who writes
 * it, and neither is load-bearing for the other.
 *
 * A PATCH is judged on the MERGED dates: sending only `end_date` still has to
 * be checked against the stored `start_date`.
 */
function assertDatesOrdered(
  existing: PeriodRow | undefined,
  values: PeriodValues,
): void {
  const startDate = values.startDate ?? existing?.startDate;
  const endDate = values.endDate ?? existing?.endDate;
  if (
    startDate !== undefined &&
    endDate !== undefined &&
    startDate >= endDate
  ) {
    refuseValidation([ruleRef("VAL-008")]);
  }
}

/**
 * Resolve the references a period carries, before anything is written: an FK
 * violation fires as a driver error (500) before any rule could speak.
 */
async function assertReferences(
  tx: DbClient,
  companyId: string,
  values: PeriodValues,
): Promise<void> {
  const comparativeId = values.comparativePeriodId;
  if (comparativeId && !(await getPeriod(tx, companyId, comparativeId))) {
    // Another company's period, or none — indistinguishable by design (API-1).
    refuseValidation();
  }
}

/**
 * Create one period (DM-7). The factor set is pinned inside the transaction, so
 * a set archived between the request and the insert cannot be pinned.
 */
export async function createPeriod(
  db: DbClient,
  companyId: string,
  values: NewPeriodValues,
  createdBy: string,
): Promise<PeriodWriteResult> {
  return writeValidated(db, { companyId, ...SCOPE }, async (tx) => {
    assertDatesOrdered(undefined, values);
    await assertReferences(tx, companyId, values);
    const factorSetId = await resolveFactorSet(tx, values.factorSetId);
    const [row] = await tx
      .insert(reportingPeriod)
      .values({ ...values, factorSetId, companyId, createdBy })
      .returning();
    return row;
  });
}

/**
 * Update one period. A foreign `id` is `NOT_FOUND` (the route answers
 * `VALIDATION` — API-1); a change to a calculation-bearing field is declared to
 * the validation run, which is what lets VAL-106 refuse it while the current
 * revision is past draft (DM-7a).
 *
 * As with the organisational registries this is a plain UPDATE: append-only
 * (D5) governs INPUT ROWS. A period's history is its revisions.
 */
export async function updatePeriod(
  db: DbClient,
  companyId: string,
  id: string,
  values: PeriodValues,
): Promise<PeriodWriteResult> {
  const existing = await getPeriod(db, companyId, id);
  if (!existing) return { ok: false, error: "NOT_FOUND" };
  const mutatedFields = changedCalculationFields(existing, values);

  return writeValidated(
    db,
    { companyId, ...SCOPE, mutatedFields },
    async (tx) => {
      assertDatesOrdered(existing, values);
      await assertReferences(tx, companyId, values);
      const factorSetId =
        values.factorSetId === undefined
          ? undefined
          : await resolveFactorSet(tx, values.factorSetId);
      const [row] = await tx
        .update(reportingPeriod)
        .set({
          ...values,
          ...(factorSetId ? { factorSetId } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(reportingPeriod.id, id),
            eq(reportingPeriod.companyId, companyId),
          ),
        )
        .returning();
      return row;
    },
  );
}
