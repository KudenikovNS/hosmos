/**
 * VESG VOUCHER READINESS — the 16 requirements of the Slovenian SPS voucher
 * («vavčer za pripravo prostovoljnega poročila o trajnostnosti»), judged from
 * what HOSMOS holds. Stage-1 plan item 8.4; the list is the expert's checklist
 * of 06.09.2026 (`docs/expert-aleksandra/extracted/…/VESG_чеклист.csv`),
 * requirement by requirement, in her order.
 *
 * ── THREE KINDS ─────────────────────────────────────────────────────────────
 *   • `auto`   — judged from data: `met` or `attention`. The judgement is a
 *                pure function of `VesgFacts` (this file), tested without a
 *                database; `./vesg.ts` only gathers the facts.
 *   • `manual` — outside the platform (the budget, the expert's contract, the
 *                AJPES publication, the ePortal application): `pending` until a
 *                person confirms it, then `confirmed`; the note travels with it
 *                (0022).
 *   • `info`   — a statement, not a gate (Comprehensive as a second module;
 *                the micro-undertaking rule): always `info`.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * Not a promise of the voucher. The public page (ТЗ лендинга 15.08.2026) says
 * so in as many words and this screen repeats it: eligibility is the
 * applicant's to prove, the review is a licensed audit firm's, and the money
 * is the fund's. This is the list of what must be true, and where HOSMOS can
 * see whether it is.
 */
import type { StatusCounts } from "@/server/readiness/status";

export const VESG_REQUIREMENTS = [
  "eligibility_sme",
  "eligibility_employee",
  "funding",
  "provider",
  "independence",
  "standard",
  "publication",
  "auditability",
  "versioning",
  "data_quality",
  "social",
  "general_info",
  "environmental",
  "comprehensive",
  "micro_logic",
  "submission",
] as const;
export type VesgRequirementId = (typeof VESG_REQUIREMENTS)[number];

export type VesgKind = "auto" | "manual" | "info";
type VesgStatus = "met" | "attention" | "pending" | "confirmed" | "info";

/** The block the expert's sheet files each requirement under. */
const VESG_BLOCK: Readonly<Record<VesgRequirementId, string>> = {
  eligibility_sme: "eligibility",
  eligibility_employee: "eligibility",
  funding: "funding",
  provider: "provider",
  independence: "independence",
  standard: "standard",
  publication: "publication",
  auditability: "auditability",
  versioning: "versioning",
  data_quality: "data_quality",
  social: "social",
  general_info: "general_info",
  environmental: "environmental",
  comprehensive: "comprehensive",
  micro_logic: "micro_logic",
  submission: "submission",
};

export const VESG_KIND: Readonly<Record<VesgRequirementId, VesgKind>> = {
  eligibility_sme: "auto",
  eligibility_employee: "auto",
  funding: "manual",
  provider: "manual",
  independence: "auto",
  standard: "auto",
  publication: "manual",
  auditability: "auto",
  versioning: "auto",
  data_quality: "auto",
  social: "auto",
  general_info: "auto",
  environmental: "auto",
  comprehensive: "info",
  micro_logic: "info",
  submission: "manual",
};

/** Where each requirement is worked on. */
const VESG_HREF: Readonly<Record<VesgRequirementId, string>> = {
  eligibility_sme: "/organisation",
  eligibility_employee: "/organisation",
  funding: "/vesg",
  provider: "/vesg",
  independence: "/review",
  standard: "/readiness",
  publication: "/reports",
  auditability: "/evidence",
  versioning: "/organisation",
  data_quality: "/review",
  social: "/inventory/disclosures#B8",
  general_info: "/inventory/disclosures#B2",
  environmental: "/inventory",
  comprehensive: "/settings",
  micro_logic: "/readiness",
  submission: "/vesg",
};

/** The SME ceiling of Recommendation 2003/361/EC — fewer than 250 persons. */
const SME_EMPLOYEE_CEILING = 250;
/** VSME's micro-undertaking threshold (≤ 10 employees). */
const MICRO_EMPLOYEE_CEILING = 10;
/** The call closes on this date or when the funds run out (SPS). */
export const VESG_CALL_CLOSES = "2028-03-31";

/** A stored manual confirmation (0022). */
export interface VesgDecision {
  readonly confirmed: boolean;
  readonly note: string | null;
  readonly decided_at: string | null;
}

/** One disclosure's readiness, as the hub computes it. */
interface VesgDisclosureFact {
  readonly percent: number;
  readonly applicable: number;
}

/** Everything the judgement reads. `./vesg.ts` fills it; tests hand-build it. */
export interface VesgFacts {
  readonly root: {
    readonly country: string | null;
    readonly employeeCount: number | null;
    readonly averageFte: number | null;
  } | null;
  /** The newest period's readiness, or `null` without a period. */
  readonly readiness: {
    readonly summary: StatusCounts & { readonly percent: number };
    readonly byCode: Readonly<Record<string, VesgDisclosureFact>>;
    readonly voluntary: number;
    readonly comprehensive: boolean;
  } | null;
  readonly factorSetCode: string | null;
  readonly run: {
    readonly ok: boolean;
    readonly stale: boolean;
    readonly formulaVersion: string | null;
  } | null;
  /** A locked revision exists for the newest period. */
  readonly locked: boolean;
  /** Immutable renders of the company (all periods). */
  readonly renders: number;
  /** Active members holding a reviewing role (reviewer, approver, auditor). */
  readonly reviewers: number;
  readonly evidenceLinks: number;
  readonly decisions: Readonly<
    Partial<Record<VesgRequirementId, VesgDecision>>
  >;
}

export interface VesgItem {
  readonly id: VesgRequirementId;
  readonly block: string;
  readonly kind: VesgKind;
  readonly status: VesgStatus;
  readonly href: string;
  /** The figures the result sentence is written with (message params). */
  readonly params: Readonly<Record<string, string | number>>;
  readonly decision: VesgDecision | null;
}

export interface VesgSummary {
  readonly auto_total: number;
  readonly auto_met: number;
  readonly manual_total: number;
  readonly manual_confirmed: number;
  readonly info: number;
}

function employees(facts: VesgFacts): number | null {
  const root = facts.root;
  if (!root) return null;
  if (root.employeeCount !== null) return root.employeeCount;
  if (root.averageFte !== null) return Math.round(root.averageFte);
  return null;
}

function percentOf(facts: VesgFacts, code: string): number {
  const d = facts.readiness?.byCode[code];
  return d && d.applicable > 0 ? d.percent : 0;
}

function allComplete(facts: VesgFacts, codes: readonly string[]): boolean {
  return (
    facts.readiness !== null &&
    codes.every((code) => {
      const d = facts.readiness!.byCode[code];
      return !!d && (d.applicable === 0 || d.percent === 100);
    })
  );
}

type Verdict = {
  readonly ok: boolean;
  readonly params: Readonly<Record<string, string | number>>;
};

const dash = (v: string | number | null | undefined) =>
  v === null || v === undefined ? "—" : v;

/** The automatic judgements, one per `auto`/`info` requirement. */
const JUDGE: Readonly<
  Record<
    Exclude<
      VesgRequirementId,
      "funding" | "provider" | "publication" | "submission"
    >,
    (facts: VesgFacts) => Verdict
  >
> = {
  eligibility_sme: (f) => {
    const n = employees(f);
    const country = f.root?.country ?? null;
    return {
      ok: country === "SI" && n !== null && n >= 1 && n < SME_EMPLOYEE_CEILING,
      params: { country: dash(country), employees: dash(n) },
    };
  },
  eligibility_employee: (f) => {
    const n = employees(f);
    return { ok: n !== null && n >= 1, params: { employees: dash(n) } };
  },
  independence: (f) => ({
    ok: f.locked && f.renders > 0 && f.reviewers > 0,
    params: {
      locked: f.locked ? 1 : 0,
      renders: f.renders,
      reviewers: f.reviewers,
    },
  }),
  standard: (f) => {
    const s = f.readiness?.summary;
    const open = s
      ? s.needs_data + s.needs_confirmation + s.open_conditional
      : 0;
    return {
      ok: !!s && open === 0 && s.needs_evidence === 0,
      params: {
        percent: s?.percent ?? 0,
        open,
        needsEvidence: s?.needs_evidence ?? 0,
      },
    };
  },
  auditability: (f) => {
    const s = f.readiness?.summary;
    return {
      ok: !!s && s.needs_evidence === 0 && f.evidenceLinks > 0,
      params: { needsEvidence: s?.needs_evidence ?? 0, links: f.evidenceLinks },
    };
  },
  versioning: (f) => ({
    ok: f.factorSetCode !== null && f.run?.formulaVersion != null,
    params: {
      factorSet: dash(f.factorSetCode),
      formulaVersion: dash(f.run?.formulaVersion),
    },
  }),
  data_quality: (f) => ({
    ok: !!f.run && f.run.ok && !f.run.stale,
    params: { calculated: f.run ? 1 : 0, stale: f.run?.stale ? 1 : 0 },
  }),
  social: (f) => ({
    ok: allComplete(f, ["B8", "B9", "B10"]),
    params: {
      b8: percentOf(f, "B8"),
      b9: percentOf(f, "B9"),
      b10: percentOf(f, "B10"),
    },
  }),
  general_info: (f) => ({
    ok: allComplete(f, ["B1", "B2"]),
    params: { b1: percentOf(f, "B1"), b2: percentOf(f, "B2") },
  }),
  environmental: (f) => ({
    ok: allComplete(f, ["B3", "B6", "B7"]),
    params: {
      b3: percentOf(f, "B3"),
      b6: percentOf(f, "B6"),
      b7: percentOf(f, "B7"),
    },
  }),
  comprehensive: (f) => ({
    ok: true,
    params: { available: f.readiness?.comprehensive ? 1 : 0 },
  }),
  micro_logic: (f) => {
    const n = employees(f);
    return {
      ok: true,
      params: {
        employees: dash(n),
        micro: n !== null && n <= MICRO_EMPLOYEE_CEILING ? 1 : 0,
        voluntary: f.readiness?.voluntary ?? 0,
      },
    };
  },
};

/** THE judgement — pure, total over `VESG_REQUIREMENTS`, in the sheet's order. */
export function evaluateVesg(facts: VesgFacts): {
  items: VesgItem[];
  summary: VesgSummary;
} {
  const items: VesgItem[] = VESG_REQUIREMENTS.map((id) => {
    const kind = VESG_KIND[id];
    const decision = facts.decisions[id] ?? null;
    if (kind === "manual") {
      const params: Record<string, string | number> =
        id === "submission" ? { closes: VESG_CALL_CLOSES } : {};
      return {
        id,
        block: VESG_BLOCK[id],
        kind,
        status: decision?.confirmed ? "confirmed" : "pending",
        href: VESG_HREF[id],
        params,
        decision,
      };
    }
    const verdict = JUDGE[id as keyof typeof JUDGE](facts);
    return {
      id,
      block: VESG_BLOCK[id],
      kind,
      status: kind === "info" ? "info" : verdict.ok ? "met" : "attention",
      href: VESG_HREF[id],
      params: verdict.params,
      decision: null,
    };
  });
  const summary: VesgSummary = {
    auto_total: items.filter((i) => i.kind === "auto").length,
    auto_met: items.filter((i) => i.status === "met").length,
    manual_total: items.filter((i) => i.kind === "manual").length,
    manual_confirmed: items.filter((i) => i.status === "confirmed").length,
    info: items.filter((i) => i.kind === "info").length,
  };
  return { items, summary };
}
