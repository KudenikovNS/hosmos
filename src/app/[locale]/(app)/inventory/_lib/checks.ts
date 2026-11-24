// THE INLINE CHECKS OF `/inventory` — VR-2's client half, and the ONE property
// that keeps it honest.
//
// See docs/decisions/app-inventory-_lib-checks.md for the full account.
import type { InputTableName } from "@/server/inventory/tables";

import type { Draft } from "../../organisation/_lib/useAutosave";

/** The VAL-* codes this module can emit. A hint is localised by CODE (О-12). */
export type CheckCode =
  "VAL-011" | "VAL-015" | "VAL-016" | "VAL-020" | "VAL-104";

/**
 * The two rules that need the period's pinned factor set and are therefore NOT
 * mirrored — see the header. Exported so the test can assert the abstention and
 * so the drawer can say WHICH checks it is deferring rather than implying there
 * are none.
 */
export const FACTOR_SET_CHECKS = ["VAL-014", "VAL-019"] as const;

/** One advisory annotation: the rule it mirrors and the field it hangs on. */
export interface InlineCheck {
  readonly code: CheckCode;
  /** The API field name — the form control it is rendered under. */
  readonly field: string;
}

/**
 * `distance_based`'s unit, and `fuel_based`'s units — VAL-016's subject.
 *
 * A COPY of the server evaluator's two constants, and the only copy in this
 * file. It is safe precisely because of the advisory rule at the top: if the
 * server's list grows, this one misses a hint the server accepts (noise-free);
 * if it shrinks, this one shows a hint on a row the server then refuses with the
 * very same VAL-016 sentence. Neither outcome can change what is written.
 */
const FUEL_QUANTITY_UNITS: readonly string[] = [
  "L",
  "m3",
  "kg",
  "t",
  "kWh",
  "kWh_gross",
  "kWh_net",
  "MWh",
  "GJ",
];
const DISTANCE_UNIT = "km";

/** The six К-5 refrigerant figures — the input of a `mass_balance` method. */
const REFRIGERANT_FIELDS = [
  "refrigerant_added",
  "refrigerant_recovered",
  "equipment_capacity",
  "opening_stock",
  "closing_stock",
  "leakage_rate",
] as const;

/** A form value that is actually there (the server's `filled`, on strings). */
function filled(value: string | undefined): boolean {
  return (value ?? "").trim() !== "";
}

/** A form value as a number, or `null` when it is blank or not one. */
function numeric(value: string | undefined): number | null {
  if (!filled(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * VAL-104 (AC-2) — a row with no site carries a non-empty `notes`. Declared
 * against `emission_activity` and `purchased_energy_activity`, which is why the
 * instruments tab never shows it.
 */
function documentedException(values: Draft): InlineCheck[] {
  if (filled(values.facility_id) || filled(values.notes)) return [];
  return [{ code: "VAL-104", field: "notes" }];
}

/** The mirrored rules of a Scope-1 row (§4.9, DM-15). */
function emissionChecks(values: Draft): InlineCheck[] {
  const checks: InlineCheck[] = [];

  // VAL-011 — the quantity is ≥ 0. Zero is legal and is not an omission.
  const value = numeric(values.activity_value);
  if (value !== null && value < 0) {
    checks.push({ code: "VAL-011", field: "activity_value" });
  }

  const method = values.method ?? "";
  const unit = values.unit ?? "";

  // VAL-015 — a method is selected but its input is missing. For `mass_balance`
  // the input is the К-5 column group; for the other eight it is the unit.
  if (filled(method)) {
    const hasInput =
      method === "mass_balance"
        ? REFRIGERANT_FIELDS.some((field) => filled(values[field]))
        : filled(unit);
    if (!hasInput) {
      checks.push({
        code: "VAL-015",
        field: method === "mass_balance" ? "refrigerant_added" : "unit",
      });
    }
  }

  // VAL-016 — the method and the input that IS present do not agree. The
  // vehicle half is not asserted here: `activity_type` is an open list whose
  // membership the pinned factor set decides, so the unit half is the part a
  // form can see. The server checks both.
  if (method === "distance_based" && filled(unit) && unit !== DISTANCE_UNIT) {
    checks.push({ code: "VAL-016", field: "unit" });
  }
  if (
    method === "fuel_based" &&
    filled(unit) &&
    !FUEL_QUANTITY_UNITS.includes(unit)
  ) {
    checks.push({ code: "VAL-016", field: "unit" });
  }

  return [...checks, ...documentedException(values)];
}

/** The mirrored rules of a purchased-energy row (§4.10, DM-16). */
function energyChecks(values: Draft): InlineCheck[] {
  const checks: InlineCheck[] = [];
  const consumption = numeric(values.consumption);
  if (consumption !== null && consumption < 0) {
    // Both codes are true of the same row and both are declared against this
    // table: VAL-020 says it in the energy domain's words, VAL-011 in the
    // activity domain's. The server writes both; so does the hint.
    checks.push({ code: "VAL-020", field: "consumption" });
    checks.push({ code: "VAL-011", field: "consumption" });
  }
  return [...checks, ...documentedException(values)];
}

/**
 * THE mirror: the advisory annotations for one form state (see the header — this
 * result may not gate a write).
 *
 * `contractual_instrument` gets none, and that is a statement rather than a gap:
 * its Phase-1 rules are VAL-023 (the vintage window against the reporting
 * period, a Warning) and VAL-022/VAL-024 (T5.3, matched volumes) — none of which
 * a form can evaluate without the period and the matched consumption.
 */
export function inlineChecks(
  table: InputTableName,
  values: Draft,
): InlineCheck[] {
  if (table === "emission_activity") return emissionChecks(values);
  if (table === "purchased_energy_activity") return energyChecks(values);
  return [];
}

/** The codes annotating one field, for the control that renders them. */
export function checksForField(
  checks: readonly InlineCheck[],
  field: string,
): CheckCode[] {
  return checks.filter((check) => check.field === field).map((c) => c.code);
}
