// =============================================================================
// THE WIRE, AS THE `/inventory/disclosures` SCREEN SEES IT (T3.5b — UI-2,
// DM-18, DM-19, §4.12, §4.13).
//
// The two rules of `../../_lib/api.ts` hold here unchanged:
//
//   1. THE DTOs ARE IMPORTED, NOT RE-DECLARED. `DisclosureDto` belongs to the
//      wire contract that serialises it (`@/server/inventory/disclosures`) and
//      `MetricDto` to the catalogue reader (`@/server/factors/reference`).
//      Re-typing either here would create a second spelling of a contract the
//      compiler could not compare with the first. Both imports are `import
//      type`, so the server modules (and their drizzle runtime) are erased at
//      compile and never reach the browser bundle.
//   2. A REFUSAL IS CLASSIFIED ONCE — `../../../_lib/refusal`. §0.2 makes
//      401/403, 402, 422-with-rules, 422-with-field and bare-422 five different
//      things to say, and this screen must not invent a sixth.
//
// THE TWO REFUSALS THIS SCREEN CARES ABOUT BY NAME, both from T3.3:
//
//   • PG-6 — a `comprehensive` metric on a plan without `vsmeComprehensive`
//     comes back 422 with `{field: "metric_key"}`, i.e. `{kind: "field"}` once
//     classified. The screen locks such a metric BEFORE the round trip (a
//     product statement with an upgrade CTA, PG-5), and the server stays the
//     authority: a direct POST is still refused (AC-14).
//   • DM-19 — a value in the wrong column, two values, or a breakdown answered
//     as a number comes back 422 with `{field: "value_*"}`. `_lib/catalog`
//     composes the body so the first two cannot be composed at all, and the
//     third is what makes the breakdown editor write ONE `value_json`.
// =============================================================================
import type { MetricDto } from "@/server/factors/reference";
import type { DisclosureDto } from "@/server/inventory/disclosures";

export type { DisclosureDto, MetricDto };

export { type Refusal, type WriteOutcome } from "../../../_lib/refusal";

/** `GET /api/metrics?standard=all` — the 141 VSME + 50 ESRS rows (DM-20, 0019). */
export interface MetricListData {
  metrics: MetricDto[];
  total: number;
}

/** `GET /api/disclosures?revision_id=…` — the CURRENT rows of one revision. */
export interface DisclosureListData {
  disclosures: DisclosureDto[];
}
