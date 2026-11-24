// =============================================================================
// THE TWO SENTENCES AN UPLOAD ENDS WITH, PINNED WITHOUT A DOM (T4.5 acceptance).
//
// The suite is `environment: "node"` and includes only `*.test.ts` — no jsdom,
// no `.tsx` — so "the 402 rendered as a plan explanation and not as an error"
// cannot be asserted by querying a document. `uploadNotice` exists so it CAN be:
// the panel holds one reference to each branch, and everything that decides
// which branch it is, is data.
//
// WHAT THESE TESTS ARE ACTUALLY GUARDING:
//   1. A 402 NEVER becomes a `refused` notice. That is the whole first criterion
//      — "an upload over the plan limit shows the plan explanation, not a
//      technical error" — and the failure mode it prevents is the innocent one:
//      somebody simplifies the panel to `if (!outcome.ok) showError(...)` and
//      the price silently becomes a bug report.
//   2. A DUPLICATE NEVER becomes a refusal. `POST /api/documents` answers
//      `ok: true` for it (EV-1: the row IS written, the bytes are deduplicated),
//      so the branch is `stored` and VAL-013 travels as a hint hanging off a
//      SUCCESS. A screen that showed it as a failure would have the user upload
//      the same invoice a third time.
// =============================================================================
import { describe, expect, it } from "vitest";

import type { DocumentDto, RuleRef, UploadData, WriteOutcome } from "../api";
import { duplicateHint, uploadNotice } from "../upload";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function doc(id: string, fileHash: string): DocumentDto {
  return {
    id,
    file_name: `${id}.pdf`,
    file_type: "pdf",
    mime: "application/pdf",
    size_bytes: 1024,
    file_hash: fileHash,
    issuer: null,
    document_date: null,
    coverage_start: null,
    coverage_end: null,
    confidentiality: "internal",
    retention_date: null,
    uploaded_by: "user-1",
    uploaded_at: "2026-01-01T00:00:00.000Z",
  };
}

const VAL_013: RuleRef = {
  code: "VAL-013",
  message: "Возможный дубликат документа",
  scope: "record",
};

function accepted(data: Partial<UploadData> = {}): WriteOutcome<UploadData> {
  return {
    ok: true,
    data: {
      document: doc("new", HASH_A),
      deduplicated: false,
      warnings: [],
      ...data,
    },
  };
}

describe("uploadNotice — the plan ceiling is a price, never an error", () => {
  it("turns 402 into the plan branch, carrying the number", () => {
    const notice = uploadNotice({ ok: false, kind: "plan_required" }, [], 20);
    expect(notice).toEqual({ kind: "plan", maxUploadMb: 20 });
  });

  it("never routes a 402 into the refusal branch", () => {
    // The criterion, stated as the thing that must not happen.
    const notice = uploadNotice({ ok: false, kind: "plan_required" }, [], 50);
    expect(notice.kind).not.toBe("refused");
  });

  it.each([
    { name: "a named field (422)", outcome: { field: "issuer" } },
    { name: "blocking rules (422)", outcome: { rules: [VAL_013] } },
    { name: "a bare 422", outcome: {} },
  ])("does NOT claim a plan problem for $name", ({ outcome }) => {
    const refusal = (
      "field" in outcome
        ? { ok: false, kind: "field", field: outcome.field }
        : "rules" in outcome
          ? { ok: false, kind: "rules", rules: outcome.rules }
          : { ok: false, kind: "rejected" }
    ) as WriteOutcome<UploadData>;
    expect(uploadNotice(refusal, [], 20).kind).toBe("refused");
  });

  it("reads a refusal on the FILE field as «this type is not accepted»", () => {
    // Партия 24 — EV-0's allowlist is the only thing that refuses that field,
    // and «check the field file» told the owner nothing. The metadata fields
    // keep their own names and their own branch.
    const refusal = {
      ok: false,
      kind: "field",
      field: "file",
    } as WriteOutcome<UploadData>;
    expect(uploadNotice(refusal, [], 20)).toEqual({ kind: "unsupportedType" });
  });

  it("keeps 401/403 in the refusal branch, where R-11's copy lives", () => {
    const notice = uploadNotice({ ok: false, kind: "access_changed" }, [], 20);
    expect(notice).toEqual({
      kind: "refused",
      refusal: { ok: false, kind: "access_changed" },
    });
  });
});

describe("uploadNotice — a duplicate is a stored document with a hint", () => {
  it("is `stored`, not `refused`, when VAL-013 came back", () => {
    const notice = uploadNotice(
      accepted({ deduplicated: true, warnings: [VAL_013] }),
      [doc("earlier", HASH_A)],
      20,
    );
    expect(notice.kind).toBe("stored");
  });

  it("names the earlier document the hint offers to reuse", () => {
    const notice = uploadNotice(
      accepted({ deduplicated: true, warnings: [VAL_013] }),
      [doc("earlier", HASH_A), doc("unrelated", HASH_B)],
      20,
    );
    expect(notice.kind === "stored" && notice.duplicate).toMatchObject({
      earlier: [{ id: "earlier" }],
      codes: ["VAL-013"],
    });
  });

  it("has no hint at all for an ordinary first upload", () => {
    const notice = uploadNotice(accepted(), [doc("unrelated", HASH_B)], 20);
    expect(notice.kind === "stored" && notice.duplicate).toBeNull();
  });
});

describe("duplicateHint — either signal is enough", () => {
  it("fires on dedup alone, even with an empty warning list", () => {
    const hint = duplicateHint(
      { document: doc("new", HASH_A), deduplicated: true, warnings: [] },
      [doc("earlier", HASH_A)],
    );
    expect(hint?.earlier.map((d) => d.id)).toEqual(["earlier"]);
    expect(hint?.codes).toEqual([]);
  });

  it("fires on VAL-013 alone, even when storage did not deduplicate", () => {
    const hint = duplicateHint(
      {
        document: doc("new", HASH_A),
        deduplicated: false,
        warnings: [VAL_013],
      },
      [doc("earlier", HASH_A)],
    );
    expect(hint?.codes).toEqual(["VAL-013"]);
  });

  it("never points at the document that was just stored", () => {
    const stored = doc("new", HASH_A);
    const hint = duplicateHint(
      { document: stored, deduplicated: true, warnings: [VAL_013] },
      [stored, doc("earlier", HASH_A)],
    );
    expect(hint?.earlier.map((d) => d.id)).toEqual(["earlier"]);
  });

  it("still offers the hint when the library holds no match to point at", () => {
    // The listing this compares against is the one loaded BEFORE the upload, so
    // the earlier row can legitimately be absent. Silence would be worse: the
    // server said "possible duplicate" and the screen would have swallowed it.
    const hint = duplicateHint(
      {
        document: doc("new", HASH_A),
        deduplicated: true,
        warnings: [VAL_013],
      },
      [],
    );
    expect(hint).not.toBeNull();
    expect(hint?.earlier).toEqual([]);
  });
});
