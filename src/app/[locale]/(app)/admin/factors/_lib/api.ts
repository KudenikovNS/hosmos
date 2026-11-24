// =============================================================================
// THE WIRE, AS `/admin/factors` SEES IT (T2.8 — UI-4, API-1).
//
// Same two rules as `organisation/_lib/api.ts`, for the same reasons:
//
//   1. THE DTOs ARE IMPORTED, NOT RE-DECLARED — `@/server/factors/*` owns them,
//      and `import type` erases the server module (and its drizzle runtime)
//      before the browser bundle is built.
//   2. THE REFUSAL VOCABULARY IS THE SHARED ONE (`../../../_lib/refusal`), which
//      T2.8 lifted out of the organisation screen precisely so this one does not
//      get a second opinion about what a 402 or a 422 means to a user.
//
// The one thing this screen adds to that vocabulary is a NAMED refusal:
// `NEW_VERSION_ONLY` is DM-21 speaking (a released set is never edited), and it
// arrives as `{refusal, factor_set}` rather than as a VAL-* code, because no
// rule owns it. `classifyRefusal` already turns it into `{kind: "refused"}`; the
// copy lives under `factors.refusals.*`.
// =============================================================================
import type {
  EmissionFactorDto,
  FactorProvenanceDto,
  FactorSetDto,
} from "@/server/factors/factor-sets";

export type { EmissionFactorDto, FactorProvenanceDto, FactorSetDto };

export {
  classifyRefusal,
  isAccessError,
  type ApiBody,
  type Refusal,
  type WriteOutcome,
} from "../../../_lib/refusal";

/** `GET /api/factor-sets`. */
export interface FactorSetListData {
  factor_sets: FactorSetDto[];
}

/** `GET /api/factor-sets/[id]` — the set plus UI-4's sources and licences. */
export interface FactorSetDetailData {
  factor_set: FactorSetDto;
  provenance: FactorProvenanceDto[];
}

/** `GET /api/factor-sets/[id]/factors` — one page, and the filter's total. */
export interface FactorPageData {
  factors: EmissionFactorDto[];
  total: number;
  limit: number;
  offset: number;
}
