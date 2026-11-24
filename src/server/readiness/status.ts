/**
 * VSME readiness — the status of ONE datapoint, as a pure function.
 *
 * The stage-1 specification (13.08.2026, §5.2) defines readiness per datapoint
 * with six statuses. The seventh here, `open_conditional`, is what an
 * unanswered conditional or voluntary datapoint IS before anyone decided
 * whether it applies: neither a gap nor an exemption. Folding it into
 * `needs_data` would count every unused option against the company; folding it
 * into `not_applicable` would invent a decision nobody took.
 *
 * Readiness is "the share of applicable datapoints that are ready" (§5.2), so
 * `isApplicable` is the denominator and `ready` the numerator. Nothing here
 * touches the database; `readiness.ts` gathers the facts and calls this.
 */

const DATAPOINT_STATUSES = [
  "ready",
  "needs_data",
  "needs_evidence",
  "needs_confirmation",
  "not_applicable",
  "sensitive_omitted",
  "open_conditional",
] as const;
export type DatapointStatus = (typeof DATAPOINT_STATUSES)[number];

export type RequirementType = "mandatory" | "conditional" | "voluntary";

export interface DatapointFacts {
  readonly requirement: RequirementType;
  /** Integer / Decimal / Percentage — a figure an auditor expects a document behind. */
  readonly quantitative: boolean;
  /**
   * For datapoints the product DERIVES (B1 from the organisation, B3 from the
   * calculation): whether the source currently yields a value. `null` for a
   * datapoint that is typed into `disclosure_record`.
   */
  readonly derived: "present" | "missing" | null;
  /** The current `disclosure_record` for the metric, if any. */
  readonly record: {
    readonly state: "draft" | "approved";
    readonly hasValue: boolean;
    readonly evidenceCount: number;
  } | null;
  /** A stored `disclosure_applicability` decision, if any. */
  readonly decision: "not_applicable" | "sensitive_omitted" | null;
}

export function datapointStatus(facts: DatapointFacts): DatapointStatus {
  if (facts.decision) return facts.decision;
  if (facts.derived !== null) {
    return facts.derived === "present" ? "ready" : "needs_data";
  }
  const { record } = facts;
  if (record && record.hasValue) {
    if (record.state === "approved") return "ready";
    return facts.quantitative && record.evidenceCount === 0
      ? "needs_evidence"
      : "needs_confirmation";
  }
  return facts.requirement === "mandatory" ? "needs_data" : "open_conditional";
}

/** Counts in the denominator of readiness (§5.2). */
export function isApplicable(status: DatapointStatus): boolean {
  return (
    status !== "not_applicable" &&
    status !== "sensitive_omitted" &&
    status !== "open_conditional"
  );
}

export type StatusCounts = Record<DatapointStatus, number>;

export function emptyCounts(): StatusCounts {
  return Object.fromEntries(
    DATAPOINT_STATUSES.map((status) => [status, 0]),
  ) as StatusCounts;
}

/** `ready / applicable`, as a whole percentage; 0 when nothing applies. */
export function readinessPercent(counts: StatusCounts): number {
  const applicable = DATAPOINT_STATUSES.filter(isApplicable).reduce(
    (sum, status) => sum + counts[status],
    0,
  );
  return applicable === 0 ? 0 : Math.round((counts.ready / applicable) * 100);
}
