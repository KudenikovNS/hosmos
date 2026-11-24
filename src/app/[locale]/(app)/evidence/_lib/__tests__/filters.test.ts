// =============================================================================
// THE LIBRARY FILTERS AND THE TWO LINK INDEXES (T4.5).
//
// The filters are the reason this screen makes two requests instead of one per
// keystroke, and the one of them that cannot be a column comparison is the one
// worth pinning: "evidence I uploaded and never attached to anything" is a fact
// about the LINK table, and it is exactly the view a person opens when they are
// looking for what they forgot to do.
// =============================================================================
import { describe, expect, it } from "vitest";

import type { DocumentDto, EvidenceLinkDto } from "../api";
import {
  linkCounts,
  linksByTarget,
  matchesDocument,
  matchesRow,
  NO_FILTER,
  targetKey,
} from "../filters";

function doc(over: Partial<DocumentDto> = {}): DocumentDto {
  return {
    id: "doc-1",
    file_name: "Elektro-invoice-January.pdf",
    file_type: "pdf",
    mime: "application/pdf",
    size_bytes: 2048,
    file_hash: "a".repeat(64),
    issuer: "Elektro Ljubljana",
    document_date: "2026-01-31",
    coverage_start: "2026-01-01",
    coverage_end: "2026-01-31",
    confidentiality: "internal",
    retention_date: null,
    uploaded_by: "user-1",
    uploaded_at: "2026-02-01T00:00:00.000Z",
    ...over,
  };
}

function link(
  id: string,
  documentId: string,
  objectType: string,
  objectId: string,
): EvidenceLinkDto {
  return {
    id,
    document_id: documentId,
    linked_object_type: objectType,
    linked_object_id: objectId,
    created_by: "user-1",
    created_at: "2026-02-01T00:00:00.000Z",
  };
}

describe("matchesDocument — absent means everything", () => {
  it("lists the whole library under the empty filter", () => {
    expect(matchesDocument(doc(), NO_FILTER, 0)).toBe(true);
  });

  it("matches the file name and the issuer, case-insensitively", () => {
    expect(matchesDocument(doc(), { ...NO_FILTER, text: "elektro" }, 0)).toBe(
      true,
    );
    expect(matchesDocument(doc(), { ...NO_FILTER, text: "JANUARY" }, 0)).toBe(
      true,
    );
    expect(matchesDocument(doc(), { ...NO_FILTER, text: "ljubljana" }, 0)).toBe(
      true,
    );
    expect(matchesDocument(doc(), { ...NO_FILTER, text: "gas" }, 0)).toBe(
      false,
    );
  });

  it("does not fall over on a document with no issuer", () => {
    expect(
      matchesDocument(
        doc({ issuer: null }),
        { ...NO_FILTER, text: "elektro" },
        0,
      ),
    ).toBe(true);
    expect(
      matchesDocument(doc({ issuer: null }), { ...NO_FILTER, text: "zzz" }, 0),
    ).toBe(false);
  });

  it("narrows by file type and by confidentiality", () => {
    expect(matchesDocument(doc(), { ...NO_FILTER, fileType: "xlsx" }, 0)).toBe(
      false,
    );
    expect(matchesDocument(doc(), { ...NO_FILTER, fileType: "pdf" }, 0)).toBe(
      true,
    );
    expect(
      matchesDocument(doc(), { ...NO_FILTER, confidentiality: "public" }, 0),
    ).toBe(false);
    expect(
      matchesDocument(doc(), { ...NO_FILTER, confidentiality: "internal" }, 0),
    ).toBe(true);
  });

  it("finds evidence nobody attached to anything", () => {
    expect(matchesDocument(doc(), { ...NO_FILTER, usage: "unlinked" }, 0)).toBe(
      true,
    );
    expect(matchesDocument(doc(), { ...NO_FILTER, usage: "unlinked" }, 2)).toBe(
      false,
    );
    expect(matchesDocument(doc(), { ...NO_FILTER, usage: "linked" }, 0)).toBe(
      false,
    );
    expect(matchesDocument(doc(), { ...NO_FILTER, usage: "linked" }, 1)).toBe(
      true,
    );
  });
});

describe("the two indexes of DM-25", () => {
  const links = [
    link("l1", "doc-1", "emission_activity", "row-1"),
    link("l2", "doc-1", "emission_activity", "row-2"),
    link("l3", "doc-2", "purchased_energy_activity", "row-1"),
  ];

  it("counts how many objects each document backs", () => {
    const counts = linkCounts(links);
    expect(counts.get("doc-1")).toBe(2);
    expect(counts.get("doc-2")).toBe(1);
    expect(counts.get("doc-3")).toBeUndefined();
  });

  it("keeps the object TYPE in the key, as the UNIQUE does", () => {
    const byTarget = linksByTarget(links);
    expect(
      byTarget.get(targetKey("emission_activity", "row-1"))?.map((l) => l.id),
    ).toEqual(["l1"]);
    expect(
      byTarget
        .get(targetKey("purchased_energy_activity", "row-1"))
        ?.map((l) => l.id),
    ).toEqual(["l3"]);
  });
});

describe("matchesRow — finding the row an invoice belongs to", () => {
  const row = {
    label: "Boiler house — natural gas",
    kind: "stationary_combustion",
    year_month: "2026-01",
  };

  it("lists everything for an empty query", () => {
    expect(matchesRow(row, "")).toBe(true);
  });

  it("matches the label, the kind and the month", () => {
    expect(matchesRow(row, "boiler")).toBe(true);
    expect(matchesRow(row, "stationary")).toBe(true);
    expect(matchesRow(row, "2026-01")).toBe(true);
    expect(matchesRow(row, "refrigerant")).toBe(false);
  });

  it("survives a row with no label and no month", () => {
    const bare = { label: null, kind: "electricity", year_month: null };
    expect(matchesRow(bare, "electric")).toBe(true);
    expect(matchesRow(bare, "boiler")).toBe(false);
  });
});
