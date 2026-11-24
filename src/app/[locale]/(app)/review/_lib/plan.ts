// =============================================================================
// THE TWO NUMBERS F1's 402 IS ABOUT — one pure function, and the only place this
// screen counts them (T4.6 acceptance; F1, PG-3, PG-5, VAL-105).
//
// THE ACCEPTANCE CRITERION IS ABOUT A SENTENCE: a refused Lock must read
// "upgrade required: 4 sites included of 3, with a CTA" and not as an error. The
// server owns the REFUSAL — `facilityGateVerdict` computes the verdict, VAL-105
// stores it, `plan_facility_limit` answers 402 — but the 402's payload carries
// only `{reason: "facility_limit", period_id}`. The COUNTS are not on the wire,
// so the sentence has to be worded from what the browser already holds: the
// period's boundary (`GET /api/periods/[id]/scope`), the facility registry
// (`GET /api/org/facilities`) and the plan's `maxFacilities` as the SERVER
// resolved it (`/api/session` → `usePlan().features`).
//
// THAT IS A SECOND OPINION, SO ITS SCOPE IS DELIBERATELY TINY. This function is
// consulted ONLY on the plan branch of `transitionNotice`, i.e. only after the
// server has already refused. It never decides whether Lock is offered, never
// pre-refuses one, and cannot turn a permitted Lock into a blocked one — exactly
// the discipline `evidence/_lib/upload` keeps around `maxUploadMb` ("only ever
// used to WORD the 402; the refusal itself is the server's"). If the count here
// ever disagreed with the server's, the user would see a wrong NUMBER in a
// correct refusal — never a refusal that did not happen.
//
// THE COUNT IS `countIncludableFacilities`' COUNT, both halves of it (§11.3):
// `period_scope.status = 'included'` is the PERIOD's decision (DM-8) and
// `facility.included_in_boundary` is the REGISTRY's (DM-5). A facility counts
// only when both say yes — which is why excluding a subsidiary and flagging a
// site out of the registry are both real ways back under the limit, and why
// counting either one alone would print a number the customer cannot reconcile
// with what they just changed.
//
// WHAT IS NOT RESTATED HERE, on purpose: WHICH PLANS F1 hard-gates
// (`HARD_GATED_PLANS` — trial and starter). Whether the gate applies is the
// server's answer and arrives as the 402 itself; a copy of that list here could
// only ever produce a warning the server would not have made.
// =============================================================================

/** The `PlanFeatures` convention for "no limit". */
const UNLIMITED = -1;

/** A boundary row, reduced to what the count depends on (`PeriodScopeDto`). */
export interface GatedScopeEntry {
  readonly legal_entity_id: string;
  /** `included` | `excluded` (DM-8). Only the first is counted. */
  readonly status: string;
}

/** A facility, reduced to what the count depends on (`FacilityDto`). */
export interface GatedFacility {
  readonly legal_entity_id: string;
  readonly included_in_boundary: boolean;
}

export interface FacilityGateFacts {
  /** Facilities the report would actually cover — §11.3's number. */
  readonly facilities: number;
  /** `maxFacilities` of the plan, as the server resolved it (`-1` = unlimited). */
  readonly limit: number;
  /**
   * Is the count above the cap? `false` for an unlimited plan.
   *
   * NOT A GATE. It only tells the notice whether the numbers it holds can
   * explain the refusal the server already made — see the header.
   */
  readonly over: boolean;
}

/**
 * How many facilities this period's report covers, and how many the plan allows.
 *
 * `boundary` empty means the boundary has not been drawn yet, which counts as
 * zero facilities — the same reading the evaluator's `loadBoundary` takes ("an
 * empty result is nothing to judge", not "everything is in").
 */
export function facilityGateFacts(input: {
  /** `usePlan().features.maxFacilities` — the SERVER's resolution of the plan. */
  readonly maxFacilities: number;
  readonly boundary: readonly GatedScopeEntry[];
  readonly facilities: readonly GatedFacility[];
}): FacilityGateFacts {
  const { maxFacilities, boundary, facilities } = input;
  const included = new Set(
    boundary
      .filter((entry) => entry.status === "included")
      .map((entry) => entry.legal_entity_id),
  );
  const covered = facilities.filter(
    (facility) =>
      facility.included_in_boundary && included.has(facility.legal_entity_id),
  ).length;

  return {
    facilities: covered,
    limit: maxFacilities,
    over: maxFacilities !== UNLIMITED && covered > maxFacilities,
  };
}
