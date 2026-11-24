// =============================================================================
// THE WIRE, AS THE `/inventory` SCREEN SEES IT (T3.5 — UI-2, API-1, API-2).
//
// Same two rules as `organisation/_lib/api.ts`, for the same reasons:
//
//   1. THE DTOs ARE IMPORTED, NOT RE-DECLARED. `EmissionActivityDto` & friends
//      are owned by the wire contracts that serialise them
//      (`@/server/inventory/*`), which is where the К-5/К-6/К-7 renames are
//      decided. Re-typing them here would create a second spelling of the
//      contract that the compiler could not compare with the first. Every import
//      is `import type`, so the server modules (and their drizzle runtime) are
//      erased at compile and never reach the browser bundle.
//
//   2. A REFUSAL IS CLASSIFIED ONCE — `../../_lib/refusal`, re-exported here so
//      this screen's imports read like the other two screens'. §0.2 makes
//      401/403, 402, 422-with-rules, 422-with-field and bare-422 five different
//      things to say, and this screen must not invent a sixth.
//
// THE ONE REFUSAL THIS SCREEN CARES ABOUT BY NAME is LC-5's: superseding an
// APPROVED version without a `change_reason` comes back as 422 with
// `{field: "change_reason", reason: "approved_row_needs_reason"}` — i.e. as
// `{kind: "field", field: "change_reason"}` once classified. The form asks for
// the reason BEFORE that happens (see `./actions#rowActionGates`), so the
// refusal is the belt and the form is the braces; the server stays the authority
// either way (VR-2).
// =============================================================================
import type { ContractualInstrumentDto } from "@/server/inventory/contractual-instrument";
import type { EmissionActivityDto } from "@/server/inventory/emission-activity";
import type { InventoryRowDto } from "@/server/inventory/inventory";
import type { PurchasedEnergyDto } from "@/server/inventory/purchased-energy";
import type { AssetDto } from "@/server/org/assets";
import type { FacilityDto } from "@/server/org/facilities";
import type { LegalEntityDto } from "@/server/org/legal-entities";
import type { PeriodDto } from "@/server/periods/periods";
import type { RevisionDto } from "@/server/revisions/revisions";

export type {
  AssetDto,
  FacilityDto,
  InventoryRowDto,
  LegalEntityDto,
  PeriodDto,
  RevisionDto,
};

export {
  classifyRefusal,
  isAccessError,
  type ApiBody,
  type Refusal,
  type WriteOutcome,
} from "../../_lib/refusal";

/**
 * ONE VERSION OF AN INPUT ROW, whichever of the three tables this screen edits
 * it lives in.
 *
 * A union rather than a base type: the drawer dispatches on `source_table`
 * (which the inventory listing hands it, К-8) and narrows before it reads a body
 * column, so a field that exists on one table cannot be read off another by
 * accident. The 19 mixin fields are common to all three by construction (§4.8),
 * which is why the version chain, the state badge and the placement summary can
 * be written once.
 */
export type RowDto =
  EmissionActivityDto | PurchasedEnergyDto | ContractualInstrumentDto;

/** `GET /api/inventory` — the cross-table listing (T3.4, DM-14). */
export interface InventoryListData {
  inventory: InventoryRowDto[];
  /** The read stopped at `MAX_INVENTORY_ROWS`; the screen says so (API-2). */
  truncated: boolean;
}

/** `GET /api/activities/<family>/[id]/history` — the version chain (API-2). */
export interface HistoryData {
  /** Oldest first — the order `history()` returns and the order LC-10 reads in. */
  versions: RowDto[];
  /** The walk hit `MAX_VERSION_CHAIN`; this is a prefix, not the whole chain. */
  truncated: boolean;
}

/** `GET /api/periods` — the periods a revision can be picked from. */
export interface PeriodListData {
  periods: PeriodDto[];
  used: number;
  consolidated_available: boolean;
}

/** `GET /api/periods/[id]/revisions` — LC-1a publishes the current one. */
export interface RevisionListData {
  period_id: string;
  revisions: RevisionDto[];
  current_revision_id: string | null;
}
