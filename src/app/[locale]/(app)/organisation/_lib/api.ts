// =============================================================================
// THE WIRE, AS THE `/organisation` SCREEN SEES IT (T2.7 — UI-1, API-1, API-3).
//
// Two things live here and nothing else:
//
//   1. THE DTOs ARE IMPORTED, NOT RE-DECLARED. `LegalEntityDto` & friends are
//      owned by the services that serialise them (`@/server/org/*`,
//      `@/server/periods/*`), which is where the К-1/К-2 renames
//      (`organisation_name`, `parent_organisation_id`) are decided. Re-typing
//      them here would create a second spelling of the contract that the
//      compiler could not compare with the first. The imports are `import type`,
//      so the server modules (and their drizzle runtime) are erased at compile
//      and never reach the browser bundle — the same trick `useSession.ts` uses
//      for `DbSession`/`Entitlements`.
//
//   2. A REFUSAL IS CLASSIFIED ONCE. Every write on this screen can come back as
//      401/403 (access), 402 (plan), or 422 (a rule set, a bad field, or a bare
//      "does not exist for this company"). §0.2 makes those FIVE different
//      things to say to a user, and the acceptance of this task names two of
//      them explicitly: a 402 must read as a plan explanation and a 403 as "your
//      access changed" — never as a technical error. `classifyRefusal` is the
//      one place that decision is made; the components only render it. IT NOW
//      LIVES ONE DIRECTORY UP (`../../_lib/refusal`), where T2.8's
//      /admin/factors reads the same vocabulary; it is re-exported here so this
//      screen's imports are exactly what they were.
// =============================================================================
import type { AssetDto } from "@/server/org/assets";
import type { FacilityDto } from "@/server/org/facilities";
import type { LegalEntityDto } from "@/server/org/legal-entities";
import type { PeriodDto } from "@/server/periods/periods";
import type { PeriodScopeDto } from "@/server/periods/scope";

export type {
  AssetDto,
  FacilityDto,
  LegalEntityDto,
  PeriodDto,
  PeriodScopeDto,
};

export {
  classifyRefusal,
  isAccessError,
  type ApiBody,
  type Refusal,
  type WriteOutcome,
} from "../../_lib/refusal";

/** `GET /api/org/entities` (API-3: the list carries its own counter). */
export interface EntityListData {
  entities: LegalEntityDto[];
  used: number;
  limit: number;
}

/** `GET /api/org/facilities` (API-3). */
export interface FacilityListData {
  facilities: FacilityDto[];
  used: number;
  limit: number;
}

/** `GET /api/org/assets` — `used` and DELIBERATELY no `limit` (F5, no plan axis). */
export interface AssetListData {
  assets: AssetDto[];
  used: number;
}

/** `GET /api/periods` — `used`, and the plan fact the create form needs (PG-2). */
export interface PeriodListData {
  periods: PeriodDto[];
  used: number;
  consolidated_available: boolean;
}

/** `GET|PUT /api/periods/[id]/scope` — the boundary in its entirety (DM-8). */
export interface BoundaryData {
  period_id: string;
  entries: PeriodScopeDto[];
}
