// A BLOCKING RULE, TURNED INTO SOMETHING THE USER CAN GO AND FIX — one pure
// module, and the only place `/review` decides what a failed rule links to
// (T4.6 acceptance; VR-3, DM-28, §5.1, UI-3).
//
// See docs/decisions/app-review-_lib-blocking.md for the full account.
import type { Capability } from "@/shared/roles";

import { mayOpenNavItem, NAV_ITEMS } from "../../_lib/navItems";
import { isInputTable, type InputTableName } from "./api";
import type { TransitionFailure } from "./transitions";

/**
 * WHICH SCREEN OWNS AN OBJECT TYPE — the `object_type` vocabulary the evaluators
 * actually write (`RuleFinding.objectType`), mapped to the route that can show
 * it.
 *
 * `report_revision` is deliberately absent: it is THIS screen, and a link that
 * reloads the page the user is already on is worse than no link. Anything else
 * missing from this table (a type a future evaluator invents) degrades to a
 * sentence without a link rather than to a dead route.
 */
export const OBJECT_SCREEN: Readonly<Record<string, string>> = {
  // The four input tables (К-8) — the numbers themselves.
  emission_activity: "/inventory",
  purchased_energy_activity: "/inventory",
  contractual_instrument: "/inventory",
  disclosure_record: "/inventory/disclosures",
  // The organisation, its sites, its periods and its boundary.
  legal_entity: "/organisation",
  facility: "/organisation",
  reporting_period: "/organisation",
  period_scope: "/organisation",
  // The evidence half of UI-3 (T4.5).
  document: "/evidence",
  evidence_link: "/evidence",
  dq_assessment: "/evidence",
  // The factor library (UI-4) — capability-gated, see the header.
  emission_factor: "/admin/factors",
};

/**
 * May this session open the screen at `href`?
 *
 * Delegated to `mayOpenNavItem` over `NAV_ITEMS` so this file cannot disagree
 * with the sidebar about who may reach a screen (see point 3 of the header) —
 * including the "any one of these capabilities" case, which `/review` itself
 * needs and which a local re-implementation would have got wrong.
 *
 * A route with no nav entry at all is open: absence from the sidebar is not a
 * permission, and every such route guards itself server-side.
 */
function mayOpenScreen(
  href: string,
  capabilities: readonly Capability[],
): boolean {
  const item = NAV_ITEMS.find((entry) => entry.href === href);
  return item === undefined || mayOpenNavItem(item, capabilities);
}

/** Where a failing rule's object can be opened, if anywhere. */
export type RuleTarget =
  /**
   * A row of the queue this screen is already showing — selected in place
   * rather than navigated to, because the row detail is right here.
   */
  | { kind: "row"; table: InputTableName; id: string }
  /** Another screen owns it, and this session may open that screen. */
  | { kind: "screen"; href: string; objectType: string }
  /** Nothing to open: no object, no screen, or no right to it (header). */
  | { kind: "none"; objectType: string | null };

/**
 * Where one finding points.
 *
 * `queueRowIds` is what the queue currently holds. An input row that is NOT in
 * it (an already-approved row, a row of another revision) is still an input row
 * — it just cannot be selected here, so it routes to `/inventory` instead of
 * pretending the queue can show it.
 */
export function ruleTarget(input: {
  readonly objectType: string | null;
  readonly objectId: string | null;
  /** Straight from `useCapabilities().capabilities`. Never a role. */
  readonly capabilities: readonly Capability[];
  readonly queueRowIds: ReadonlySet<string>;
}): RuleTarget {
  const { objectType, objectId, capabilities, queueRowIds } = input;
  if (objectType === null || objectId === null) {
    return { kind: "none", objectType };
  }
  if (isInputTable(objectType) && queueRowIds.has(objectId)) {
    return { kind: "row", table: objectType, id: objectId };
  }
  const href = OBJECT_SCREEN[objectType];
  if (href === undefined) return { kind: "none", objectType };

  if (!mayOpenScreen(href, capabilities)) {
    // The sidebar hides this screen from this session; so does this list.
    return { kind: "none", objectType };
  }
  return { kind: "screen", href, objectType };
}

/** A stored finding, reduced to what this module reads (`ValidationResultDto`). */
export interface BlockingResult {
  readonly ruleCode: string;
  readonly scope: string;
  readonly objectType: string | null;
  readonly objectId: string | null;
}

/** One line of the blocking list: a rule, an object, and where it can be opened. */
export interface BlockingItem {
  readonly key: string;
  readonly code: string;
  readonly scope: string;
  readonly objectType: string | null;
  readonly objectId: string | null;
  readonly target: RuleTarget;
  /** The last refused transition named this code (highlighted, never hidden). */
  readonly refusedNow: boolean;
}

/** Stable identity of one line — one per (rule, object), not one per row read. */
function itemKey(result: BlockingResult): string {
  return `${result.ruleCode}|${result.objectType ?? "-"}|${result.objectId ?? "-"}`;
}

/** Findings → one item per (rule, object), each routed. Shared by both lists. */
function placeFindings(
  results: readonly BlockingResult[],
  ctx: {
    readonly capabilities: readonly Capability[];
    readonly queueRowIds: ReadonlySet<string>;
    readonly refusedCodes: ReadonlySet<string>;
  },
): Map<string, BlockingItem> {
  const items = new Map<string, BlockingItem>();
  for (const result of results) {
    const key = itemKey(result);
    if (items.has(key)) continue;
    items.set(key, {
      key,
      code: result.ruleCode,
      scope: result.scope,
      objectType: result.objectType,
      objectId: result.objectId,
      target: ruleTarget({
        objectType: result.objectType,
        objectId: result.objectId,
        capabilities: ctx.capabilities,
        queueRowIds: ctx.queueRowIds,
      }),
      refusedNow: ctx.refusedCodes.has(result.ruleCode),
    });
  }
  return items;
}

/** Nothing was refused — the advisory list has no transition to point back at. */
const NOTHING_REFUSED: ReadonlySet<string> = new Set<string>();

/**
 * THE ADVISORY LIST: findings that did NOT stop anything and are still worth
 * saying — one line per (rule, object), routed exactly like a blocking one.
 *
 * WHY THIS EXISTS AT ALL. Until now `/review` rendered `validation.blocking`
 * only, so a WARNING was stored, counted on the dashboard, and shown to nobody
 * who could act on it. That was tolerable while every warning was a small
 * data-entry nag; it stopped being tolerable with VAL-107, which reports that a
 * published figure rests on a weaker factor than the pinned set holds. Nothing
 * is wrong with that report — it must not block — and a reviewer signing it has
 * to be able to see it. A finding that only a database query reveals is not a
 * disclosure.
 *
 * IT IS A SECOND LIST AND NOT A SECOND COLUMN OF THE FIRST, because the two
 * answer different questions. The blocking list is "what is stopping this
 * revision"; this one is "what will still be true when it goes through". Merging
 * them would make a submit look refused by a rule that refuses nothing.
 *
 * `refusedNow` is always `false` here: a non-blocking rule is never a reason a
 * transition was refused, so highlighting one as "just refused" would be a lie
 * the same shape as the merge above.
 */
export function advisoryItems(input: {
  readonly results: readonly BlockingResult[];
  readonly capabilities: readonly Capability[];
  readonly queueRowIds: ReadonlySet<string>;
}): BlockingItem[] {
  const items = placeFindings(input.results, {
    capabilities: input.capabilities,
    queueRowIds: input.queueRowIds,
    refusedCodes: NOTHING_REFUSED,
  });
  return sortItems([...items.values()]);
}

/** By rule code, then object id — stable across refetches (see below). */
function sortItems(items: BlockingItem[]): BlockingItem[] {
  return items.sort(
    (a, b) =>
      a.code.localeCompare(b.code) ||
      (a.objectId ?? "").localeCompare(b.objectId ?? ""),
  );
}

/**
 * THE blocking list: one line per (rule, object), plus a line for every code the
 * refusal named that the stored results cannot place (case 1 of the header).
 *
 * DEDUPLICATION IS BY (RULE, OBJECT) AND NOT BY RULE. Ten rows failing VAL-036
 * are ten things to fix and ten links; one row failing it twice is one. That is
 * the opposite of the API-1 payload, which carries one `RuleRef` per CODE
 * precisely so a refusal is not ten identical rules — the refusal answers "what
 * is wrong", this list answers "where".
 *
 * ORDER: by rule code, then by object id. Stable, so a refetch does not reshuffle
 * a list the user is working through.
 */
export function blockingItems(input: {
  readonly results: readonly BlockingResult[];
  readonly failures: readonly TransitionFailure[];
  readonly capabilities: readonly Capability[];
  readonly queueRowIds: ReadonlySet<string>;
}): BlockingItem[] {
  const { results, failures, capabilities, queueRowIds } = input;
  const refusedCodes = new Set(failures.map((failure) => failure.code));

  const items = placeFindings(results, {
    capabilities,
    queueRowIds,
    refusedCodes,
  });

  // Case 1: a code the refusal named that no stored row of this revision
  // explains. It is still a reason the transition did not happen, so it is
  // stated — without an object, because there is honestly none to point at.
  const placed = new Set([...items.values()].map((item) => item.code));
  for (const failure of failures) {
    if (placed.has(failure.code)) continue;
    const key = `${failure.code}|-|-`;
    if (items.has(key)) continue;
    items.set(key, {
      key,
      code: failure.code,
      scope: failure.scope,
      objectType: null,
      objectId: null,
      target: { kind: "none", objectType: null },
      refusedNow: true,
    });
  }

  return sortItems([...items.values()]);
}
