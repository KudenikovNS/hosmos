/**
 * Central camel→snake row mapper (PG-PLAN T-19, PATTERN 1 / §4.1–4.2).
 *
 * The Drizzle service functions return NATIVE Drizzle rows, whose JS keys are
 * camelCase (`naceCode`, `reportingYear`, …) and whose NUMERIC columns come back
 * as `string`. The frontend, however, was built against the OLD Supabase shapes:
 * snake_case keys (`nace_code`, `reporting_year`, …) with NUMERIC already
 * deserialised to `number | null`. To keep `/api/*` responses byte-for-byte
 * compatible with the old server actions (PG COORDINATION note #44), every API
 * handler funnels its rows through the mapper here rather than re-deriving the
 * mapping per route.
 *
 * TRIMMED IN T3.8 (plan §5, «легаси-мапперы … подрезка»). This module used to
 * carry six mappers; five of them mapped rows of the wide-table reporting model
 * and left with their only callers:
 *   • `toDbMonthly` / `DbMonthlyRow`           → `/api/emissions/{monthly,save}`, `/api/reports`;
 *   • `toDbEmissionResults` / …Row             → `/api/reports`;
 *   • `toDbPeople` / `DbPeopleRow`             → `/api/people`;
 *   • `toDbFactorSource` / `DbFactorSourceRow` → `/api/factors?type=sources`;
 *   • `toEmissionFactor` / `EmissionFactorSelectRow` → `src/server/db/factors.ts`.
 * `toDbCompany` stays: `companies` is the TENANT PROFILE, not the reporting model
 * (О-10), and `/api/company` + `/api/company/governance` read it.
 *
 * Two invariants, both to match the OLD form:
 *   - keys are snake_case (the SQL column names);
 *   - NUMERIC columns are converted `string → number` (null-preserving), because
 *     the old Supabase/PostgREST responses gave the UI numbers, not strings
 *     (database.types.ts typed them `number | null`). Integer columns already
 *     arrive as `number | null` from Drizzle and pass through untouched.
 */
import type { companies } from "@/server/db/schema";
import type { DbCompany } from "@/server/db/types";

type CompanyRow = typeof companies.$inferSelect;

// ─── Company ─────────────────────────────────────────────────────────────────

/**
 * `DbCompany` plus `governance_data` — the old `.from("companies").select("*")`
 * carried every column, and the governance screen reads `governance_data` off the
 * company (via a cast, since the narrow `DbCompany` type never declared it). We
 * expose it as a typed field so consumers that need it get it without casting,
 * while narrower consumers keep seeing a plain `DbCompany`.
 */
export interface DbCompanyRow extends DbCompany {
  governance_data: Record<string, boolean> | null;
}

/** Map a native Drizzle `companies` row to the old snake_case `DbCompany` shape. */
export function toDbCompany(row: CompanyRow): DbCompanyRow {
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    nace_code: row.naceCode,
    country: row.country,
    country_code: row.countryCode,
    headcount: row.headcount,
    // `plan` has a NOT-NULL default ('trial') in the schema and the old DbCompany
    // contract types it as a non-null string — preserve that guarantee.
    plan: row.plan ?? "trial",
    reporting_year: row.reportingYear,
    currency: row.currency,
    governance_data:
      (row.governanceData as Record<string, boolean> | null) ?? null,
  };
}
