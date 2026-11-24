// Plan item 8.4 — the VESG voucher judgement, DB-less. The facts are hand-built;
// what is pinned is that every requirement of the expert's sheet is judged, in
// her order, that the automatic ones flip on the fact they name, that the
// manual ones follow the stored confirmation, and that the two informational
// ones never gate.
import { describe, expect, it } from "vitest";

import { emptyCounts } from "@/server/readiness/status";

import {
  evaluateVesg,
  VESG_KIND,
  VESG_REQUIREMENTS,
  type VesgFacts,
} from "../evaluate";

const complete = { percent: 100, applicable: 3 };

/** A company that has done everything HOSMOS can see. */
function ready(overrides: Partial<VesgFacts> = {}): VesgFacts {
  return {
    root: { country: "SI", employeeCount: 42, averageFte: null },
    readiness: {
      summary: { ...emptyCounts(), ready: 51, percent: 100 },
      byCode: Object.fromEntries(
        [
          "B1",
          "B2",
          "B3",
          "B4",
          "B5",
          "B6",
          "B7",
          "B8",
          "B9",
          "B10",
          "B11",
        ].map((code) => [code, complete]),
      ),
      voluntary: 4,
      comprehensive: false,
    },
    factorSetCode: "si-2025-r3",
    run: { ok: true, stale: false, formulaVersion: "1.0.0" },
    locked: true,
    renders: 2,
    reviewers: 1,
    evidenceLinks: 12,
    decisions: {},
    ...overrides,
  };
}

describe("evaluateVesg — shape", () => {
  it("judges every requirement of the sheet, in its order, and nothing else", () => {
    const { items } = evaluateVesg(ready());
    expect(items.map((i) => i.id)).toEqual([...VESG_REQUIREMENTS]);
    expect(VESG_REQUIREMENTS).toHaveLength(16);
    for (const item of items) expect(item.kind).toBe(VESG_KIND[item.id]);
  });

  it("a fully prepared company: every automatic check met, manual ones pending", () => {
    const { items, summary } = evaluateVesg(ready());
    for (const item of items) {
      if (item.kind === "auto") expect(item.status, item.id).toBe("met");
      if (item.kind === "manual") expect(item.status, item.id).toBe("pending");
      if (item.kind === "info") expect(item.status, item.id).toBe("info");
    }
    expect(summary).toEqual({
      auto_total: 10,
      auto_met: 10,
      manual_total: 4,
      manual_confirmed: 0,
      info: 2,
    });
  });

  it("without a period nothing automatic is met, and nothing throws", () => {
    const { items } = evaluateVesg({
      root: null,
      readiness: null,
      factorSetCode: null,
      run: null,
      locked: false,
      renders: 0,
      reviewers: 0,
      evidenceLinks: 0,
      decisions: {},
    });
    for (const item of items) {
      if (item.kind === "auto") expect(item.status, item.id).toBe("attention");
    }
  });
});

describe("evaluateVesg — each automatic check flips on the fact it names", () => {
  const statusOf = (facts: VesgFacts, id: string) =>
    evaluateVesg(facts).items.find((i) => i.id === id)!;

  it("eligibility: seat in SI and 1…249 employees", () => {
    expect(
      statusOf(
        ready({ root: { country: "DE", employeeCount: 5, averageFte: null } }),
        "eligibility_sme",
      ).status,
    ).toBe("attention");
    expect(
      statusOf(
        ready({
          root: { country: "SI", employeeCount: 250, averageFte: null },
        }),
        "eligibility_sme",
      ).status,
    ).toBe("attention");
    // Average FTE stands in for a missing headcount.
    const fte = ready({
      root: { country: "SI", employeeCount: null, averageFte: 3.4 },
    });
    expect(statusOf(fte, "eligibility_sme").status).toBe("met");
    expect(statusOf(fte, "eligibility_employee").params.employees).toBe(3);
    expect(
      statusOf(
        ready({ root: { country: "SI", employeeCount: 0, averageFte: null } }),
        "eligibility_employee",
      ).status,
    ).toBe("attention");
  });

  it("independence needs a locked revision, a render and a reviewing role", () => {
    expect(statusOf(ready({ locked: false }), "independence").status).toBe(
      "attention",
    );
    expect(statusOf(ready({ renders: 0 }), "independence").status).toBe(
      "attention",
    );
    expect(statusOf(ready({ reviewers: 0 }), "independence").status).toBe(
      "attention",
    );
  });

  it("standard and auditability read the readiness counts", () => {
    const open = ready({
      readiness: {
        ...ready().readiness!,
        summary: { ...emptyCounts(), ready: 40, needs_data: 3, percent: 93 },
      },
    });
    const item = statusOf(open, "standard");
    expect(item.status).toBe("attention");
    expect(item.params).toMatchObject({ percent: 93, open: 3 });

    const noEvidence = ready({
      readiness: {
        ...ready().readiness!,
        summary: {
          ...emptyCounts(),
          ready: 40,
          needs_evidence: 2,
          percent: 95,
        },
      },
    });
    expect(statusOf(noEvidence, "auditability").status).toBe("attention");
    expect(statusOf(ready({ evidenceLinks: 0 }), "auditability").status).toBe(
      "attention",
    );
  });

  it("versioning and data quality read the pinned set and the run", () => {
    expect(statusOf(ready({ factorSetCode: null }), "versioning").status).toBe(
      "attention",
    );
    expect(statusOf(ready({ run: null }), "versioning").status).toBe(
      "attention",
    );
    expect(
      statusOf(
        ready({ run: { ok: true, stale: true, formulaVersion: "1.0.0" } }),
        "data_quality",
      ).status,
    ).toBe("attention");
    expect(
      statusOf(
        ready({ run: { ok: false, stale: false, formulaVersion: "1.0.0" } }),
        "data_quality",
      ).status,
    ).toBe("attention");
  });

  it("the three disclosure groups: a disclosure with nothing applicable counts as complete", () => {
    const facts = ready({
      readiness: {
        ...ready().readiness!,
        byCode: {
          ...ready().readiness!.byCode,
          B9: { percent: 0, applicable: 0 }, // every B9 datapoint decided away
          B6: { percent: 50, applicable: 2 },
        },
      },
    });
    expect(statusOf(facts, "social").status).toBe("met");
    const env = statusOf(facts, "environmental");
    expect(env.status).toBe("attention");
    expect(env.params).toMatchObject({ b3: 100, b6: 50, b7: 100 });
    expect(statusOf(facts, "general_info").status).toBe("met");
  });

  it("the informational items never gate and carry their figures", () => {
    const micro = ready({
      root: { country: "SI", employeeCount: 8, averageFte: null },
    });
    expect(statusOf(micro, "micro_logic")).toMatchObject({
      status: "info",
      params: { employees: 8, micro: 1, voluntary: 4 },
    });
    expect(statusOf(ready(), "micro_logic").params.micro).toBe(0);
    expect(statusOf(ready(), "comprehensive").params.available).toBe(0);
    expect(
      statusOf(
        ready({ readiness: { ...ready().readiness!, comprehensive: true } }),
        "comprehensive",
      ).params.available,
    ).toBe(1);
  });
});

describe("evaluateVesg — the manual items follow the stored confirmation", () => {
  it("pending without a row, confirmed with one, and the note travels", () => {
    const facts = ready({
      decisions: {
        publication: {
          confirmed: true,
          note: "https://www.ajpes.si/…",
          decided_at: "2026-09-07T00:00:00Z",
        },
        funding: {
          confirmed: false,
          note: "offer pending",
          decided_at: "2026-09-07T00:00:00Z",
        },
      },
    });
    const { items, summary } = evaluateVesg(facts);
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(by.publication.status).toBe("confirmed");
    expect(by.publication.decision?.note).toBe("https://www.ajpes.si/…");
    expect(by.funding.status).toBe("pending");
    expect(by.provider.status).toBe("pending");
    expect(by.submission.params.closes).toBe("2028-03-31");
    expect(summary.manual_confirmed).toBe(1);
  });

  it("a confirmation stored against an automatic item is ignored", () => {
    const facts = ready({
      locked: false,
      decisions: {
        independence: { confirmed: true, note: null, decided_at: null },
      } as VesgFacts["decisions"],
    });
    const item = evaluateVesg(facts).items.find(
      (i) => i.id === "independence",
    )!;
    expect(item.status).toBe("attention");
    expect(item.decision).toBeNull();
  });
});
