// =============================================================================
// THE FOUR DECISIONS OF THE `/reports` WIZARD (T5.8 acceptance; REN-3, PG-2/
// PG-5, F1/PG-3, D14, О-14).
//
// Each `describe` below is one acceptance line of the task, and each is checked
// against the SHARED list it must agree with rather than against a copy: the
// renderable statuses come from `@/shared/reports` (which `renderGate` also
// reads), the formats from `RENDER_FORMATS`, the languages from the app's
// REPORT_LANGUAGES. A test that restated those lists would go green on the day the
// screen and the server stopped agreeing.
// =============================================================================
import { describe, expect, it } from "vitest";

import { REPORT_LANGUAGES } from "@/i18n/locales";
import { WORKFLOW_STATUSES } from "@/shared/enums";
import { RENDER_FORMATS, RENDERABLE_REVISION_STATUSES } from "@/shared/reports";

import type { RenderPreviewDto, RevisionDto } from "../api";
import {
  defaultLanguage,
  exclusionCounts,
  formatChoices,
  lockWarning,
  pickedFormat,
  pickedRevision,
  RENDER_LANGUAGES,
  revisionChoices,
  shortHash,
} from "../wizard";

/** A revision, reduced to what the picker reads. */
const revision = (no: number, status: string, id = `rev-${no}`): RevisionDto =>
  ({ id, revision_no: no, status }) as unknown as RevisionDto;

/** A preview, reduced to what `lockWarning` reads. */
const preview = (
  lock: Partial<RenderPreviewDto["lock_gate"]>,
): RenderPreviewDto =>
  ({
    lock_gate: {
      plan: "starter",
      applies: true,
      limit: 3,
      facilities: 4,
      passed: false,
      ...lock,
    },
  }) as unknown as RenderPreviewDto;

// ─── 1. "A draft revision is unavailable WITH AN EXPLANATION" ────────────────

describe("revisionChoices — REN-3, stated per revision", () => {
  it("marks exactly the approved/locked revisions renderable", () => {
    const choices = revisionChoices(
      WORKFLOW_STATUSES.map((status, index) => revision(index + 1, status)),
      null,
    );
    const renderable = choices
      .filter((choice) => choice.renderable)
      .map((choice) => choice.status);
    expect(renderable.sort()).toEqual([...RENDERABLE_REVISION_STATUSES].sort());
  });

  it("keeps a draft ON the list, with a reason rather than a silence", () => {
    const [draft] = revisionChoices([revision(1, "draft")], null);
    expect(draft.renderable).toBe(false);
    // The criterion is not "it is absent" — it is "the user is told why".
    expect(draft.reason).toBe("not_approved");
  });

  it("gives a renderable revision no reason at all", () => {
    const [approved] = revisionChoices([revision(1, "approved")], null);
    expect(approved.renderable).toBe(true);
    expect(approved.reason).toBeNull();
  });

  it("preserves the server's order and flags the current revision", () => {
    const choices = revisionChoices(
      [revision(1, "locked"), revision(2, "approved"), revision(3, "draft")],
      "rev-3",
    );
    expect(choices.map((c) => c.revisionNo)).toEqual([1, 2, 3]);
    expect(choices.map((c) => c.isCurrent)).toEqual([false, false, true]);
  });
});

describe("pickedRevision — the default is an expression, never state", () => {
  const choices = revisionChoices(
    [revision(1, "locked"), revision(2, "approved"), revision(3, "draft")],
    "rev-3",
  );

  it("defaults to the NEWEST renderable revision, not the first", () => {
    // A restatement (LC-9) supersedes what it restates; defaulting to revision
    // 1 of three would offer a report nobody asked for.
    expect(pickedRevision(choices, null)?.revisionNo).toBe(2);
  });

  it("honours a pick that is still renderable", () => {
    expect(pickedRevision(choices, "rev-1")?.revisionNo).toBe(1);
  });

  it("falls back rather than selecting a draft that was picked", () => {
    expect(pickedRevision(choices, "rev-3")?.revisionNo).toBe(2);
  });

  it("falls back rather than pointing at a revision that has gone", () => {
    expect(pickedRevision(choices, "rev-gone")?.revisionNo).toBe(2);
  });

  it("is null when nothing at all can be rendered", () => {
    expect(
      pickedRevision(revisionChoices([revision(1, "draft")], null), null),
    ).toBeNull();
  });
});

// ─── 2. "An unavailable format is VISIBLE but blocked" (PG-5) ────────────────

describe("formatChoices — PG-2 shown, PG-5 not hidden", () => {
  it("offers every format the product can produce, whatever the plan sells", () => {
    const trial = formatChoices(["pdf"]);
    expect(trial.map((choice) => choice.format)).toEqual([...RENDER_FORMATS]);
    // The criterion in one line: xlsx is PRESENT and NOT allowed.
    expect(trial.find((c) => c.format === "xlsx")).toEqual({
      format: "xlsx",
      allowed: false,
    });
  });

  it("allows what the plan sells", () => {
    expect(
      formatChoices(["pdf", "xlsx"]).every((choice) => choice.allowed),
    ).toBe(true);
  });

  it("treats a missing entitlement as selling nothing, not everything", () => {
    // A catalogue row without `reportFormats` must not open the gate. (The
    // overlay in `plan-catalog` makes this unreachable in practice; the screen
    // still must not be the place where it would have been.)
    expect(formatChoices(undefined).some((choice) => choice.allowed)).toBe(
      false,
    );
  });
});

describe("pickedFormat", () => {
  it("defaults to the first format the plan sells", () => {
    expect(pickedFormat(formatChoices(["pdf", "xlsx"]), null)).toBe("pdf");
  });

  it("refuses to submit a format the plan does not sell", () => {
    expect(pickedFormat(formatChoices(["pdf"]), "xlsx")).toBe("pdf");
  });

  it("honours a pick the plan does sell", () => {
    expect(pickedFormat(formatChoices(["pdf", "xlsx"]), "xlsx")).toBe("xlsx");
  });

  it("is null when the plan sells none of them", () => {
    expect(pickedFormat(formatChoices([]), "pdf")).toBeNull();
  });
});

// ─── 3. The language is chosen, not inherited (О-14) ────────────────────────

describe("the render languages", () => {
  it("are the app's REPORT_LANGUAGES — the renderer speaks the app's message file", () => {
    expect([...RENDER_LANGUAGES]).toEqual([...REPORT_LANGUAGES]);
  });

  it("default to the interface locale when it is one of them", () => {
    for (const locale of REPORT_LANGUAGES) {
      expect(defaultLanguage(locale)).toBe(locale);
    }
  });

  it("fall back rather than render in a language nobody wrote", () => {
    expect(defaultLanguage("de")).toBe(RENDER_LANGUAGES[0]);
  });
});

// ─── 4. The F1 warning, before a Lock is attempted (PG-3) ───────────────────

describe("lockWarning — F1's verdict, never F1's arithmetic", () => {
  it("warns with the SERVER's two numbers when the lock would be refused", () => {
    expect(lockWarning(preview({}), "approved")).toEqual({
      facilities: 4,
      limit: 3,
      plan: "starter",
    });
  });

  it("says nothing on a plan F1 does not hard-gate", () => {
    // `applies: false` is how the server reports pro/enterprise, where an
    // over-limit site is a D14 stamp and not a lock refusal. Warning there
    // would describe a 402 that will never happen.
    expect(
      lockWarning(
        preview({ applies: false, plan: "pro", limit: 15 }),
        "approved",
      ),
    ).toBeNull();
  });

  it("says nothing when the count is within the cap", () => {
    expect(
      lockWarning(preview({ passed: true, facilities: 2 }), "approved"),
    ).toBeNull();
  });

  it("says nothing about a revision that is ALREADY locked", () => {
    // The gate was passed when it was locked; re-warning would contradict a
    // fact on screen.
    expect(lockWarning(preview({}), "locked")).toBeNull();
  });

  it("says nothing before the preview has loaded", () => {
    expect(lockWarning(null, "approved")).toBeNull();
  });
});

// ─── 5. The completeness tally (D14) ────────────────────────────────────────

describe("exclusionCounts", () => {
  it("tallies the server's array by kind", () => {
    expect(
      exclusionCounts([
        { type: "facility", id: "a", name: "A" },
        { type: "facility", id: "b", name: "B" },
        { type: "legal_entity", id: "c", name: "C" },
      ]),
    ).toEqual({ legalEntities: 1, facilities: 2, total: 3 });
  });

  it("is empty for a full report", () => {
    expect(exclusionCounts([])).toEqual({
      legalEntities: 0,
      facilities: 0,
      total: 0,
    });
  });

  it("counts an unknown kind towards the total rather than dropping it", () => {
    const counts = exclusionCounts([
      { type: "asset" as "facility", id: "a", name: "A" },
    ]);
    expect(counts.total).toBe(1);
  });
});

describe("shortHash", () => {
  it("truncates with an ellipsis, so it cannot read as the whole digest", () => {
    const hash = "a".repeat(64);
    const short = shortHash(hash);
    expect(short).toBe(`${"a".repeat(12)}…`);
    expect(short).not.toBe(hash);
  });

  it("leaves a value shorter than the prefix alone", () => {
    expect(shortHash("abc")).toBe("abc");
  });
});
