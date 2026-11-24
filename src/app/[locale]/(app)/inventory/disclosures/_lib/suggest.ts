// =============================================================================
// «WE ALREADY KNOW THIS» — SUGGESTED ANSWERS FROM THE ORGANISATION (партия 18).
//
// Half of B1 repeats what the user typed on the Organisation screen a minute
// earlier: the NACE code, turnover, headcount, country, the sites and their
// addresses, whether the period is individual or consolidated. The form asked
// for all of it again, blank, with no link between the two screens — the pilot
// user's «there is no logic for how to fill this».
//
// A suggestion is NEVER written on its own. The card shows it beside the field
// with one «Use» button; the user still presses Save, and the saved value is
// the user's answer like any other (it is versioned, evidenced and approved the
// same way). Nothing here reads the network: it is a pure function of data the
// page already holds, so it is tested without a browser.
// =============================================================================
import type { FacilityDto } from "@/server/org/facilities";
import type { LegalEntityDto } from "@/server/org/legal-entities";

import type { ValueDraft } from "./catalog";

export interface SuggestContext {
  /** The legal entity whose answers are being edited. */
  readonly entity: LegalEntityDto | null;
  readonly entities: readonly LegalEntityDto[];
  readonly facilities: readonly FacilityDto[];
  /** `individual` | `consolidated` — the period's reporting basis. */
  readonly reportingBasis: string | null;
  /** The plan writes Comprehensive values (→ OPTION B). */
  readonly comprehensive: boolean;
}

export interface Suggestion {
  /** The part of the draft the «Use» button writes. */
  readonly draft: Partial<ValueDraft>;
  /** The same value as the user reads it. */
  readonly display: string;
}

/** Slovene legal-form suffixes → the stored VSME-006 value (`@/shared/catalog/options`). */
const LEGAL_FORMS: readonly [RegExp, string][] = [
  [/\bk\.\s?d\.\s?d\.?/i, "k.d.d. — komanditna delniška družba"],
  [/\bd\.\s?o\.\s?o\.?/i, "d.o.o. — družba z omejeno odgovornostjo"],
  [/\bd\.\s?n\.\s?o\.?/i, "d.n.o. — družba z neomejeno odgovornostjo"],
  [/\bd\.\s?d\.?(?!\w)/i, "d.d. — delniška družba"],
  [/\bk\.\s?d\.?(?!\w)/i, "k.d. — komanditna družba"],
  [/\bs\.\s?p\.?(?!\w)/i, "s.p. — samostojni podjetnik"],
  [/\bz\.\s?o\.\s?o\.?/i, "z.o.o. — zadruga"],
];

const text = (value: string): Suggestion => ({
  draft: { text: value },
  display: value,
});
const lines = (values: readonly string[]): Suggestion | null =>
  values.length === 0
    ? null
    : { draft: { lines: values.join("\n") }, display: values.join("; ") };
const numeric = (value: number | null | undefined): Suggestion | null =>
  value === null || value === undefined || !Number.isFinite(value)
    ? null
    : text(String(value));

const siteLine = (site: FacilityDto): string =>
  [site.facility_name, site.address, site.postal_code, site.country]
    .filter((part): part is string => !!part && part.trim() !== "")
    .join(", ");

/** The suggested answer for `metricKey`, or `null` when nothing is known. */
export function suggestionFor(
  metricKey: string,
  ctx: SuggestContext,
): Suggestion | null {
  const { entity } = ctx;
  const consolidated = ctx.reportingBasis === "consolidated";
  const subsidiaries = ctx.entities.filter(
    (e) => e.id !== entity?.id && e.group_structure_type === "subsidiary",
  );
  const sites = ctx.facilities.filter(
    (f) =>
      f.included_in_boundary &&
      (!entity || f.legal_entity_id === entity.id || consolidated),
  );

  switch (metricKey) {
    case "VSME-001":
      return text(
        ctx.comprehensive
          ? "OPTION B: Basic and Comprehensive Modules"
          : "OPTION A: Basic Module",
      );
    case "VSME-003":
      return ctx.reportingBasis
        ? text(consolidated ? "Consolidated basis" : "Individual basis")
        : null;
    case "VSME-004":
      return consolidated
        ? lines(subsidiaries.map((s) => s.organisation_name))
        : null;
    case "VSME-005": {
      if (!consolidated) return null;
      const withAddress = subsidiaries
        .filter((s) => s.registered_address)
        .map((s) => `${s.organisation_name}: ${s.registered_address}`);
      return withAddress.length ? text(withAddress.join("; ")) : null;
    }
    case "VSME-006": {
      const name = entity?.organisation_name ?? "";
      const hit = LEGAL_FORMS.find(([pattern]) => pattern.test(name));
      return hit ? text(hit[1]) : null;
    }
    case "VSME-007":
      return entity?.nace_code ? lines([entity.nace_code]) : null;
    case "VSME-009":
      return numeric(entity?.turnover);
    case "VSME-010":
      return (
        numeric(entity?.employee_count) ??
        numeric(
          entity?.average_fte === null || entity?.average_fte === undefined
            ? null
            : Math.round(entity.average_fte * 100) / 100,
        )
      );
    case "VSME-011":
      return entity?.country ? text(entity.country) : null;
    case "VSME-012":
      return lines(sites.map(siteLine).filter((l) => l !== ""));
    case "VSME-013": {
      const located = sites
        .filter((s) => s.latitude !== null && s.longitude !== null)
        .map((s) => `${s.facility_name}: ${s.latitude}, ${s.longitude}`);
      return located.length ? text(located.join("; ")) : null;
    }
    default:
      return null;
  }
}

/** Does the draft already hold what the suggestion would write? */
export function suggestionApplied(
  suggestion: Suggestion,
  draft: ValueDraft,
): boolean {
  return Object.entries(suggestion.draft).every(
    ([field, value]) =>
      (draft as unknown as Record<string, unknown>)[field] === value,
  );
}
