// =============================================================================
// PLAN AFFORDANCES (PG-5, UI-7) — what a locked feature looks like, decided as
// DATA so it can be tested without a DOM.
//
// PG-5 has a general rule and exactly ONE exception, and the difference between
// them is the whole of this module:
//
//   • GENERAL RULE — a locked feature stays VISIBLE, with an explanation and an
//     upgrade CTA. Hiding paid surfaces is the mistake `FeatureGate` was written
//     to avoid: a control that disappears reads as a bug, not as a price.
//   • THE EXCEPTION — "add a subsidiary" on Starter is NOT shown at all. It is
//     the one thing the tariff PDF prescribes ("Поведение продукта по тарифам",
//     Starter), so it is the one place the product hides rather than explains.
//
// `hidden` therefore means ABSENT FROM THE DOM — not `disabled`, not dimmed. A
// disabled button is still a promise; the PDF says there is no promise to make.
//
// WHY THE PREDICATE IS `maxLegalEntities <= 1` AND NOT `plan === "starter"`:
// the rule is about a plan that can never hold a subsidiary at all, and the
// matrix says that is true of `starter` AND of `trial` (PG-1 gives trial the
// Starter limits). Branching on the plan NAME would show a trial user a control
// whose every use answers 402, which is the outcome PG-5 exists to prevent. A
// plan whose cap is 3 is a different case entirely — there the control is real
// and only the last create is refused, which is the general rule's job.
// =============================================================================

/** `-1` in the plan matrix — no cap on this axis. */
export const UNLIMITED = -1;

/**
 * How a create control should be offered:
 *  • `available` — render it;
 *  • `locked`    — render it WITH an explanation and an upgrade CTA (PG-5);
 *  • `hidden`    — render nothing at all (the PG-5 exception).
 */
export type Affordance = "available" | "locked" | "hidden";

/** Is there room for one more row under `limit` (`-1` = unlimited)? */
export function withinLimit(limit: number, used: number): boolean {
  return limit === UNLIMITED || used < limit;
}

/**
 * The GENERAL PG-5 rule: over the cap, the control stays visible and explains
 * itself. Used by the facility registry, whose Starter counter reads "3 of 3"
 * next to an upgrade CTA.
 */
export function limitAffordance(
  limit: number,
  used: number,
): Exclude<Affordance, "hidden"> {
  return withinLimit(limit, used) ? "available" : "locked";
}

/**
 * The PG-5 EXCEPTION: "add a subsidiary".
 *
 * A plan that caps the WHOLE org tree at one entity has no subsidiary to offer
 * — the control is `hidden`. Everywhere else the general rule applies: room →
 * `available`, no room → `locked` (visible, explained, with a CTA).
 */
export function subsidiaryAffordance(
  maxLegalEntities: number,
  used: number,
): Affordance {
  if (maxLegalEntities !== UNLIMITED && maxLegalEntities <= 1) return "hidden";
  return limitAffordance(maxLegalEntities, used);
}
