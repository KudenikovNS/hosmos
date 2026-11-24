// =============================================================================
// WHAT THIS SUITE PROVES (T4.6 — "bulk approve by capability").
//
// Bulk approve is N requests and partial refusal is the NORMAL outcome (VAL-036
// blocks exactly the rows whose evidence is missing). So what is pinned is that
// the tally reports BOTH halves and rounds neither away: a run that said only
// "some rows failed" would leave the user re-approving the successful ones to
// find the failing ones.
// =============================================================================
import { describe, expect, it } from "vitest";

import type { InventoryRowDto } from "../api";
import { bulkReport, refusedCodes, type RowApprovalAttempt } from "../bulk";

/** A queue row reduced to what the tally reads (the rest is irrelevant here). */
function row(id: string, label: string | null): InventoryRowDto {
  return { id, label } as InventoryRowDto;
}

const VAL036 = {
  code: "VAL-036",
  message: "evidence missing",
  scope: "record",
};

describe("bulkReport", () => {
  it("reports nothing for a run that was not made", () => {
    expect(bulkReport([])).toEqual({
      attempted: 0,
      approved: 0,
      refusals: [],
      accessChanged: false,
    });
  });

  it("counts both halves of a partial run and names the refused rows", () => {
    const attempts: RowApprovalAttempt[] = [
      { row: row("a", "Gas, January"), outcome: { ok: true, data: {} } },
      {
        row: row("b", "Diesel, January"),
        outcome: { ok: false, kind: "rules", rules: [VAL036] },
      },
      { row: row("c", "Gas, February"), outcome: { ok: true, data: {} } },
      {
        row: row("d", null),
        outcome: { ok: false, kind: "rules", rules: [VAL036] },
      },
    ];
    const report = bulkReport(attempts);
    expect(report.attempted).toBe(4);
    expect(report.approved).toBe(2);
    expect(report.refusals.map((refusal) => refusal.rowId)).toEqual(["b", "d"]);
    expect(report.refusals[0].label).toBe("Diesel, January");
    // An unnamed row still gets a line; the component words the missing label.
    expect(report.refusals[1].label).toBeNull();
  });

  it("keeps the attempt order, so the list matches the queue", () => {
    const attempts: RowApprovalAttempt[] = ["a", "b", "c"].map((id) => ({
      row: row(id, id),
      outcome: { ok: false, kind: "rejected" },
    }));
    expect(bulkReport(attempts).refusals.map((r) => r.rowId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("flags a mid-run rights change once, rather than per row", () => {
    const report = bulkReport([
      { row: row("a", "a"), outcome: { ok: true, data: {} } },
      { row: row("b", "b"), outcome: { ok: false, kind: "access_changed" } },
      { row: row("c", "c"), outcome: { ok: false, kind: "access_changed" } },
    ]);
    expect(report.accessChanged).toBe(true);
    expect(report.approved).toBe(1);
  });

  it("does not flag an ordinary rule refusal as a rights change", () => {
    const report = bulkReport([
      {
        row: row("a", "a"),
        outcome: { ok: false, kind: "rules", rules: [VAL036] },
      },
    ]);
    expect(report.accessChanged).toBe(false);
  });

  it("reports an all-refused run as 0 of N rather than as a failure", () => {
    const report = bulkReport([
      {
        row: row("a", "a"),
        outcome: { ok: false, kind: "rules", rules: [VAL036] },
      },
      {
        row: row("b", "b"),
        outcome: { ok: false, kind: "rules", rules: [VAL036] },
      },
    ]);
    expect(report.approved).toBe(0);
    expect(report.attempted).toBe(2);
  });
});

describe("refusedCodes", () => {
  it("says the shared reason once, not once per row", () => {
    const report = bulkReport(
      ["a", "b", "c"].map((id) => ({
        row: row(id, id),
        outcome: {
          ok: false as const,
          kind: "rules" as const,
          rules: [VAL036],
        },
      })),
    );
    expect(refusedCodes(report)).toEqual(["VAL-036"]);
  });

  it("collects every distinct code, sorted", () => {
    const report = bulkReport([
      {
        row: row("a", "a"),
        outcome: {
          ok: false,
          kind: "rules",
          rules: [{ ...VAL036, code: "VAL-041" }],
        },
      },
      {
        row: row("b", "b"),
        outcome: { ok: false, kind: "rules", rules: [VAL036] },
      },
    ]);
    expect(refusedCodes(report)).toEqual(["VAL-036", "VAL-041"]);
  });

  it("has nothing to say about refusals that carry no rule", () => {
    const report = bulkReport([
      { row: row("a", "a"), outcome: { ok: false, kind: "access_changed" } },
    ]);
    expect(refusedCodes(report)).toEqual([]);
  });
});
