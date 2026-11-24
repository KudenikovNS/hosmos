import {
  Award,
  LayoutDashboard,
  Gauge,
  BookText,
  Boxes,
  Building2,
  ClipboardCheck,
  Coins,
  FileText,
  Paperclip,
  Shield,
  Link2,
  Target,
  Settings,
  Layers,
  type LucideIcon,
} from "lucide-react";
import type { PlanFeatures } from "@/shared/plans";
import type { Capability } from "@/shared/roles";

export interface NavItem {
  href: string;
  labelKey: string;
  icon: LucideIcon;
  feature: keyof PlanFeatures | null;
  /** Entries shown in the user disclosure at the bottom of the sidebar. */
  placement?: "account";
  /**
   * A capability the ROLE must hold for the entry to be listed at all (T2.8).
   *
   * DIFFERENT FROM `feature`, and deliberately so: a plan-locked entry stays
   * VISIBLE with a padlock and routes to /settings, because an upgrade is
   * something the user can act on (PG-5). A capability the role does not have is
   * not purchasable — showing /admin/factors to a contributor would advertise a
   * screen whose every action answers 403. Absent = every role sees it.
   *
   * A LIST MEANS ANY ONE OF THEM, never all. `/review` needs it: the matrix
   * gives `approver` only `data.approve`, so a single `data.review` gate would
   * hide the approval workspace from the one role whose whole job it is.
   */
  capability?: Capability | readonly Capability[];
}

/**
 * May this session reach the screen behind `item`?
 *
 * THE one answer to that question. Both the sidebar and the blocking-rule list
 * of `/review` ask it, so a screen the sidebar hides can never be a screen
 * another list happily links to.
 */
export function mayOpenNavItem(
  item: Pick<NavItem, "capability">,
  // Structural on purpose: the sidebar holds a `CapabilityState`, `/review`
  // holds a plain array, and both answer the same question. Asking only for
  // `has` lets each pass what it already has instead of building a Set to be
  // read once.
  caps: { has(capability: Capability): boolean } | readonly Capability[],
): boolean {
  if (item.capability === undefined) return true;
  const held = Array.isArray(caps)
    ? { has: (capability: Capability) => caps.includes(capability) }
    : (caps as { has(capability: Capability): boolean });
  const required =
    typeof item.capability === "string" ? [item.capability] : item.capability;
  return required.some((capability) => held.has(capability));
}

export const NAV_ITEMS: NavItem[] = [
  // The stage-1 hub (13.08.2026 §5.2): readiness per VSME datapoint and the
  // eight-step journey. First on purpose — it is where the answer to "what do
  // I do next" lives; every other entry is a step it points at.
  {
    href: "/readiness",
    labelKey: "readiness",
    icon: Gauge,
    feature: null,
  },
  {
    href: "/dashboard",
    labelKey: "dashboard",
    icon: LayoutDashboard,
    feature: null,
  },
  // UI-1 — the organisation, its boundary and its periods. `feature: null`: the
  // SCREEN is on every plan (PG-5 shows the locked parts with an explanation);
  // only individual controls inside it answer to the plan matrix.
  {
    href: "/organisation",
    labelKey: "organisation",
    icon: Building2,
    feature: null,
    placement: "account",
  },
  // UI-2 — the Scope 1 / Scope 2 inventory. `feature: null` (PG-2 caps sites
  // and periods, never rows) and NO `capability`: reading the inventory is
  // `data.read`, which every role holds, so a reviewer and an auditor reach the
  // screen and see it without any of its forms.
  {
    href: "/inventory",
    labelKey: "inventory",
    icon: Boxes,
    feature: null,
  },
  // T3.5b — the narrative and scalar half of the report (B1…B11, C1…C9), one
  // generic form over `metric_catalog`. `feature: null`: the SCREEN is on every
  // plan and the Comprehensive metrics inside it are shown LOCKED with an
  // upgrade CTA (PG-5/PG-6) — hiding them would leave the upgrade unexplained.
  // No `capability`: reading disclosures is `data.read`, which every role holds.
  {
    href: "/inventory/disclosures",
    labelKey: "disclosures",
    icon: BookText,
    feature: null,
  },
  // Spend-based Scope 3 uses the same paid navigation as governance, supply
  // chain and goals: a locked entry leads to Settings. The page's FeatureGate
  // still explains the restriction when reached directly. Reading is data.read,
  // which every role holds, so there is no separate capability gate here.
  {
    href: "/inventory/scope-3",
    labelKey: "scope3",
    icon: Coins,
    feature: "scope3",
  },
  // UI-3 (T4.5) — the evidence library, the links, the data quality and the
  // change timeline. `feature: null`: PG-1 caps the SIZE of an upload, never the
  // screen, and the 402 is explained where the upload is refused rather than by
  // a padlock in the sidebar. NO `capability`: reading evidence and quality is
  // `data.read`, which every role holds — an auditor reaches the library and
  // sees none of its forms, which is the intended shape and not a degraded one.
  {
    href: "/evidence",
    labelKey: "evidence",
    icon: Paperclip,
    feature: null,
  },
  // UI-3 (T4.6) — the review and approval workspace: the DM-14 approval queue
  // and the §5.1 transitions of a revision. `feature: null`: F1 caps the SITES a
  // report may CLOSE over, and the 402 is explained where the Lock is refused
  // (with the numbers and an upgrade CTA) rather than by a padlock in the
  // sidebar. The capability gate is EVERY capability the §5.1 matrix assigns to
  // a transition, any one of them sufficing — asserted equal to that matrix in
  // `_lib/__tests__/navItems.test.ts`, so a seventh transition fails a test
  // instead of hiding the screen from whoever drives it.
  //
  // T4.6 specified `data.review` alone and that was wrong twice over. The role
  // matrix gives `approver` exactly `["data.approve", "audit.read",
  // "data.read"]`, so the gate hid the workspace from the only role that exists
  // to approve and lock it. And `/review` is the ONLY screen in the app that
  // drives a revision transition at all — `/organisation` manages periods but
  // never their state — so the same gate also hid `submit` from `contributor`,
  // whose `data.submit` exists for precisely that act. "A workspace whose every
  // control is somebody else's" was the wrong reading: `submit`, `resume` and
  // `abandon` belong to the person entering the data, and the blocking-rule
  // list is most useful to exactly them. What stays out is `auditor`, who holds
  // no transition capability and reads the same story from `/inventory`.
  {
    href: "/review",
    labelKey: "review",
    icon: ClipboardCheck,
    feature: null,
    capability: ["data.write", "data.submit", "data.review", "data.approve"],
  },
  // T3.8 deleted `/calculator`, `/people`, `/data-sources` and the LEGACY
  // `/reports` together with the wide-table stack behind them (О-5/О-6). Their
  // replacements are `/inventory`, `/inventory/disclosures`,
  // `/inventory/scope-3` and `/admin/factors` above — and `/reports` itself,
  // rebuilt by T5.8 as the render wizard and re-added here rather than left
  // dangling.
  //
  // UI-5 (T5.8) — pick a period, a revision, a format and a LANGUAGE; see what
  // the plan leaves out; download the immutable renders. `feature: null` and NO
  // `capability`, and both are deliberate:
  //   • The plan gates the FORMAT (PG-2), not the screen. A padlocked sidebar
  //     entry would hide the completeness preview and the render history from a
  //     trial company that is entitled to both, and would state the upgrade
  //     somewhere the user cannot see what it buys. The unsold format is shown
  //     blocked WHERE it is chosen, with the CTA beside it (PG-5).
  //   • Listing and downloading renders is `data.read` — the capability every
  //     role holds, and the one `GET /api/renders` answers to. That is the whole
  //     reason there is no capability gate: an AUDITOR's job is to read the
  //     reports a company published, and a `data.review` gate here would hide
  //     the published record from the only role that exists to examine it. The
  //     act of PRODUCING a render is `data.review`, and it is gated where it
  //     happens — the button — with the route enforcing it regardless.
  {
    href: "/reports",
    labelKey: "reports",
    icon: FileText,
    feature: null,
  },
  // Plan item 8.4 — the VESG voucher checklist: 16 requirements of the SPS
  // call judged from the data, four of them confirmed by hand. `feature: null`
  // and no `capability`: reading is `data.read`, confirming is `data.write`
  // and gated on the route.
  {
    href: "/vesg",
    labelKey: "vesg",
    icon: Award,
    feature: null,
  },
  {
    href: "/governance",
    labelKey: "governance",
    icon: Shield,
    feature: "governanceParams",
  },
  {
    href: "/supply-chain",
    labelKey: "supplyChain",
    icon: Link2,
    feature: "supplyChain",
  },
  { href: "/goals", labelKey: "goals", icon: Target, feature: "goals" },
  // UI-4 — the factor library. `feature: null` (no plan axis charges for
  // factors) and `capability: factors.custom`, which is what "видимость по
  // factors.custom" means: esg_admin and data_owner only.
  {
    href: "/admin/factors",
    labelKey: "factors",
    icon: Layers,
    feature: null,
    capability: "factors.custom",
  },
  {
    href: "/settings",
    labelKey: "settings",
    icon: Settings,
    feature: null,
    placement: "account",
  },
];
