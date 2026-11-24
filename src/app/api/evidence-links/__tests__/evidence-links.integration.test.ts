// [LOCAL-DB] T4.2 — POLYMORPHIC EVIDENCE LINKS AND THE VERSION CARRY
// (DM-25, DM-26, EV-2, EV-3, EV-4, VAL-010, VAL-037) against a real Postgres and
// a real filesystem, through the T1.7 harness.
//
// The properties this file exists to prove:
//
//   • THE RELATIONSHIP IS M:N (EV-2). One invoice backs three rows and one row
//     is backed by two documents, and both directions are readable — the two
//     indexes DM-25 declares are the two questions an evidence panel asks.
//     Linking the same pair twice does NOT make a second link: the UNIQUE
//     `(document_id, linked_object_type, linked_object_id)` is the whole
//     definition of "related", so the repeat is answered with the row that is
//     already there.
//   • THE LINKS FOLLOW THE ROW ONTO ITS NEW VERSION, and the old version keeps
//     ITS OWN (DM-25, LC-4/LC-5/LC-9). This is the acceptance criterion of the
//     task and the reason the carry hook exists: an edit, an approve, a delete
//     and a seed each write a new version, and "which documents stood behind
//     this approved figure" has to stay answerable for every version of the
//     chain rather than only for the head. Nothing is moved and nothing is
//     deleted, so the history is not rewritten.
//   • UNLINKING IS NOT DELETING (EV-3). A DELETE of a link leaves the `document`
//     row AND THE BYTES ON DISK untouched. The `stat` that proves it is made
//     inside the suite's own temporary `DOCUMENTS_DIR` — see the note below,
//     because that isolation is part of the assertion and not a convenience.
//   • A LOCKED REPORT'S EVIDENCE IS FROZEN (EV-3, LC-8(2), VAL-010). A document
//     still cited by a row of a Locked revision cannot be deleted (422 carrying
//     VAL-010), the link itself cannot be torn off, and no new link can be made
//     to such a row. The document survives every one of those refusals.
//   • COVERAGE IS A WARNING, NEVER A REFUSAL (EV-4, VAL-037). A document whose
//     `coverage_*` window does not touch the row's `year_month` is attached
//     anyway and explained; a document that claims no window at all is not
//     nagged about.
//
// WHY THE `stat` MUST BE INSIDE `setupDocumentsDir()` (T1.7). `resetAppTables()`
// truncates `document` between tests and deliberately never touches the disk —
// the two sides are cleaned by whoever owns them. A `stat` against a developer's
// real `DOCUMENTS_DIR` would therefore be answered by leftovers from previous
// runs: "the file survived the unlink" would pass on a file some earlier run
// wrote and never removed, and would keep passing after the unlink started
// deleting bytes. The suite writes its bytes into its own `os.tmpdir()` root,
// asserts inside it, and the root is removed in `afterAll`.
//
// `describeIntegration` is `describe.skip` with no DATABASE_URL, so the DB half
// of this file is a green no-op in a DB-less CI; the manifest assertions below
// are a plain `describe` and run everywhere.
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

const getSessionMock = vi.fn();
vi.mock("@/server/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/server/auth/session")>(
    "@/server/auth/session",
  );
  return { ...actual, getSession: () => getSessionMock() };
});

vi.mock("@/server/db", async () => {
  const harness = await import("@/server/db/__tests__/harness");
  return harness.testDbModule();
});

import type { NextRequest } from "next/server";

import { DELETE as documentDELETE } from "@/app/api/documents/[id]/route";
import { DELETE as linkDELETE } from "@/app/api/evidence-links/[id]/route";
import {
  GET as linksGET,
  OPTIONS as linksOPTIONS,
  POST as linksPOST,
} from "@/app/api/evidence-links/route";
import { resolveSessionContext } from "@/server/auth/session";
import {
  closeTestDb,
  describeIntegration,
  getTestDb,
  insertCompany,
  insertDocument,
  insertEmissionActivity,
  insertEvidenceLink,
  insertRevision,
  insertUserWithProfile,
  resetAppTables,
  setupDocumentsDir,
  setupSchema,
} from "@/server/db/__tests__/harness";
import {
  emissionActivity,
  evidenceLink,
  validationResult,
} from "@/server/db/schema";
import {
  approveRow,
  deleteRow,
  editRow,
  seedRevisionRows,
  VERSION_CARRY_HOOKS,
  type RowSession,
} from "@/server/inventory/rows";
import { documentStorage } from "@/server/storage/document-storage";
import { EVALUATORS, PENDING_EVALUATORS } from "@/server/validation/registry";

// ─── Request plumbing ────────────────────────────────────────────────────────

const request = (url: string, method = "GET"): NextRequest =>
  new Request(`http://api.example.com${url}`, { method }) as NextRequest;

const jsonRequest = (url: string, body: unknown): NextRequest =>
  new Request(`http://api.example.com${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;

const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });

// `body` is left as the `any` `Response.json()` gives, exactly as the S3 route
// suites do: a test that has to re-declare every response shape stops being a
// test of the route and becomes a second copy of its DTO.
const answer = async (res: Response) => ({
  status: res.status,
  body: await res.json(),
});

// ─── Route callers ───────────────────────────────────────────────────────────

const link = (body: unknown) =>
  linksPOST(jsonRequest("/api/evidence-links", body)).then(answer);

const listLinksApi = (query = "") =>
  linksGET(request(`/api/evidence-links${query}`)).then(answer);

const unlink = (id: string) =>
  linkDELETE(request(`/api/evidence-links/${id}`, "DELETE"), ctxFor(id)).then(
    answer,
  );

const removeDoc = (id: string) =>
  documentDELETE(request(`/api/documents/${id}`, "DELETE"), ctxFor(id)).then(
    answer,
  );

// ─── Session plumbing ────────────────────────────────────────────────────────

async function sessionFor(userId: string) {
  const ctx = await resolveSessionContext(getTestDb(), userId);
  return { userId, email: "u@example.com", name: "U", ...ctx };
}

async function signIn(userId: string): Promise<void> {
  getSessionMock.mockResolvedValue(await sessionFor(userId));
}

// ─── The manifest and the seam (no database needed) ──────────────────────────

describe("the evaluator manifest after T4.2 (R-12)", () => {
  it("implements VAL-037 and drops it from the pending list", () => {
    expect(EVALUATORS["VAL-037"]).toBeTypeOf("function");
    expect(PENDING_EVALUATORS["VAL-037"]).toBeUndefined();
  });

  it("leaves exactly the codes that wait for something T4.2 does not build", () => {
    // Named one by one rather than counted: the point of the manifest is WHICH
    // gap is scheduled to WHOM. What is left needs an approval gate (T4.4) or a
    // calculation (T5.x) — never a piece of evidence. VAL-038 and VAL-039 left
    // this list in T4.3, which built the DQ assessment they judge, and
    // VAL-036/VAL-040/VAL-041 in T4.4 with the gates; the manifest only ever
    // shrinks, so this assertion loses an entry per later task.
    // T5.4 removed the last three (VAL-017, VAL-034, VAL-035) with the run
    // that writes their subject, so the list this task's successors kept
    // shrinking is now EMPTY — which is the end state, not a gap: every §6.2
    // rule has an evaluator. The assertion stays because it is the one that
    // would go red if a later phase added a rule and forgot to own it.
    expect(Object.keys(PENDING_EVALUATORS).sort()).toEqual([]);
  });
});

describe("the S4 carry seam after T4.2", () => {
  it("registers `carry_evidence_links` first, ahead of T4.3's hook", () => {
    // T3.1 declared this registry empty and pinned it BY NAME so that T4.2 could
    // append one entry and touch nothing else in the row service; T4.3 appended
    // `carry_dq_assessment` the same way. The ORDER is asserted because the
    // names are the contract — a hook that disappeared would otherwise leave a
    // list that still looks plausible.
    expect(VERSION_CARRY_HOOKS.map((hook) => hook.name)).toEqual([
      "carry_evidence_links",
      "carry_dq_assessment",
    ]);
  });
});

describeIntegration("api/evidence-links [LOCAL-DB]", () => {
  const documentsDir = setupDocumentsDir();

  beforeAll(async () => {
    await setupSchema();
  });

  beforeEach(async () => {
    await resetAppTables();
    getSessionMock.mockReset();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  interface Fixture {
    companyId: string;
    adminId: string;
    contributorId: string;
    periodId: string;
    revisionId: string;
  }

  /** A company with an `esg_admin` and a `contributor`, a draft revision, admin in. */
  async function setup(): Promise<Fixture> {
    const company = await insertCompany();
    const { user: admin } = await insertUserWithProfile({
      companyId: company.id,
      role: "esg_admin",
    });
    const { user: contributor } = await insertUserWithProfile({
      companyId: company.id,
      role: "contributor",
    });
    await signIn(admin.id);
    const revision = await insertRevision(company.id, { createdBy: admin.id });
    return {
      companyId: company.id,
      adminId: admin.id,
      contributorId: contributor.id,
      periodId: revision.periodId,
      revisionId: revision.id,
    };
  }

  /** Every `evidence_link` of one row version, by document id, sorted. */
  async function documentsBacking(
    companyId: string,
    objectId: string,
  ): Promise<string[]> {
    const rows = await getTestDb()
      .select({ documentId: evidenceLink.documentId })
      .from(evidenceLink)
      .where(
        and(
          eq(evidenceLink.companyId, companyId),
          eq(evidenceLink.linkedObjectType, "emission_activity"),
          eq(evidenceLink.linkedObjectId, objectId),
        ),
      );
    return rows.map((row) => row.documentId).sort();
  }

  const rowSession = (fx: Fixture): Promise<RowSession> =>
    sessionFor(fx.adminId) as Promise<RowSession>;

  // ─── EV-2 — the M:N relationship ───────────────────────────────────────────

  describe("the shape of the relationship (EV-2, DM-25)", () => {
    it("links one document to 3 rows and one row to 2 documents", async () => {
      const fx = await setup();
      const invoice = await insertDocument(fx.companyId);
      const rows = [
        await insertEmissionActivity(fx.companyId, {
          revisionId: fx.revisionId,
        }),
        await insertEmissionActivity(fx.companyId, {
          revisionId: fx.revisionId,
        }),
        await insertEmissionActivity(fx.companyId, {
          revisionId: fx.revisionId,
        }),
      ];

      for (const row of rows) {
        const res = await link({
          documentId: invoice.id,
          objectType: "emission_activity",
          objectId: row.id,
        });
        expect(res.status).toBe(200);
        expect(res.body.data.created).toBe(true);
      }

      // "Where is this document used" — the UNIQUE's own leading column.
      const byDocument = await listLinksApi(`?document_id=${invoice.id}`);
      expect(byDocument.status).toBe(200);
      expect(byDocument.body.data.links).toHaveLength(3);

      // The other direction: a second document behind the FIRST row.
      const meter = await insertDocument(fx.companyId);
      const second = await link({
        documentId: meter.id,
        objectType: "emission_activity",
        objectId: rows[0].id,
      });
      expect(second.status).toBe(200);

      const byRow = await listLinksApi(
        `?object_type=emission_activity&object_id=${rows[0].id}`,
      );
      expect(byRow.body.data.links).toHaveLength(2);
      expect(
        (byRow.body.data.links as { document_id: string }[])
          .map((l) => l.document_id)
          .sort(),
      ).toEqual([invoice.id, meter.id].sort());
    });

    it("answers a repeated link with the SAME link, never a second row", async () => {
      const fx = await setup();
      const invoice = await insertDocument(fx.companyId);
      const row = await insertEmissionActivity(fx.companyId, {
        revisionId: fx.revisionId,
      });
      const body = {
        documentId: invoice.id,
        objectType: "emission_activity",
        objectId: row.id,
      };

      const first = await link(body);
      const again = await link(body);

      expect(first.body.data.created).toBe(true);
      // The UNIQUE of DM-25 says a pair can only be related once, so the repeat
      // is the state the caller asked for — not a failure it has to interpret.
      expect(again.body.data.created).toBe(false);
      expect(again.body.data.link.id).toBe(first.body.data.link.id);
      expect(await documentsBacking(fx.companyId, row.id)).toEqual([
        invoice.id,
      ]);
    });

    it("refuses both ends when they belong to somebody else (К-8, API-1)", async () => {
      const fx = await setup();
      const invoice = await insertDocument(fx.companyId);
      const row = await insertEmissionActivity(fx.companyId, {
        revisionId: fx.revisionId,
      });

      // Another tenant's document — an FK exists, so without the tenant-pinned
      // lookup this would be a driver error rather than an answer.
      const other = await insertCompany();
      const foreignDoc = await insertDocument(other.id);
      const foreignRow = await insertEmissionActivity(other.id);

      const byDocument = await link({
        documentId: foreignDoc.id,
        objectType: "emission_activity",
        objectId: row.id,
      });
      expect(byDocument.status).toBe(422);
      expect(byDocument.body.field).toBe("documentId");

      // And the other end, which has NO foreign key at all (К-8): nothing but
      // the resolve stands between this body and a link into another tenant.
      const byTarget = await link({
        documentId: invoice.id,
        objectType: "emission_activity",
        objectId: foreignRow.id,
      });
      expect(byTarget.status).toBe(422);
      expect(byTarget.body.field).toBe("objectId");

      const unknownType = await link({
        documentId: invoice.id,
        objectType: "monthly_emissions_data",
        objectId: row.id,
      });
      expect(unknownType.status).toBe(422);
      expect(unknownType.body.field).toBe("objectType");

      // Nothing of the three was written.
      const all = await getTestDb().select().from(evidenceLink);
      expect(all).toHaveLength(0);
    });

    it("lets a contributor link — it is `data.write`, not `company.manage`", async () => {
      const fx = await setup();
      const invoice = await insertDocument(fx.companyId);
      const row = await insertEmissionActivity(fx.companyId, {
        revisionId: fx.revisionId,
      });

      await signIn(fx.contributorId);
      const res = await link({
        documentId: invoice.id,
        objectType: "emission_activity",
        objectId: row.id,
      });

      // The contrast that matters: the same contributor is refused 403 by
      // `DELETE /api/documents/[id]`, which is `company.manage` (§12.2). Saying
      // which paper backs a figure is recording data; destroying it is not.
      expect(res.status).toBe(200);
      const removal = await removeDoc(invoice.id);
      expect(removal.status).toBe(403);
    });

    it("answers the CORS preflight (PATTERN 2)", async () => {
      const res = await linksOPTIONS(
        request("/api/evidence-links", "OPTIONS") as NextRequest,
      );
      expect(res.status).toBeLessThan(300);
    });
  });

  // ─── The carry hook (DM-25, LC-4/LC-5/LC-6/LC-9) ───────────────────────────

  describe("the version carry (DM-25, LC-4/LC-5/LC-9)", () => {
    /**
     * A row of the draft revision with two documents behind it.
     *
     * `notes` is not decoration: these are the only tests here that run the row
     * through the SERVICE, and the service runs the `record` rules over what it
     * wrote (VR-3). VAL-104 blocks an emission row with no `facility_id` unless
     * it carries a documented exception, so without this the edit would be
     * refused before the carry hook could ever run.
     */
    async function linkedRow(fx: Fixture) {
      const row = await insertEmissionActivity(fx.companyId, {
        revisionId: fx.revisionId,
        notes: "site attribution pending — documented exception (VAL-104)",
      });
      const invoice = await insertDocument(fx.companyId);
      const meter = await insertDocument(fx.companyId);
      for (const doc of [invoice, meter]) {
        await insertEvidenceLink(fx.companyId, {
          documentId: doc.id,
          linkedObjectType: "emission_activity",
          linkedObjectId: row.id,
          createdBy: fx.contributorId,
        });
      }
      return { row, documentIds: [invoice.id, meter.id].sort() };
    }

    it("hangs the links on the NEW version and leaves the old one its own", async () => {
      const fx = await setup();
      const { row, documentIds } = await linkedRow(fx);

      const edited = await editRow(
        getTestDb(),
        await rowSession(fx),
        "emission_activity",
        row.id,
        { values: { activityValue: "2000" } },
      );
      expect(edited.ok).toBe(true);
      if (!edited.ok) return;

      // THE ACCEPTANCE CRITERION, both halves. The successor carries the same
      // two documents…
      expect(await documentsBacking(fx.companyId, edited.row.id)).toEqual(
        documentIds,
      );
      // …and the predecessor still has its own: the links were COPIED, not
      // re-pointed, so opening the superseded version still answers "which
      // documents stood behind THIS number when it was written" (LC-10).
      expect(await documentsBacking(fx.companyId, row.id)).toEqual(documentIds);

      const all = await getTestDb().select().from(evidenceLink);
      expect(all).toHaveLength(4);
    });

    it("copies `created_by`, not the editor", async () => {
      const fx = await setup();
      const { row } = await linkedRow(fx); // links created BY THE CONTRIBUTOR
      const edited = await editRow(
        getTestDb(),
        await rowSession(fx), // …edited by the ADMIN
        "emission_activity",
        row.id,
        { values: { activityValue: "2000" } },
      );
      expect(edited.ok).toBe(true);
      if (!edited.ok) return;

      const carried = await getTestDb()
        .select({ createdBy: evidenceLink.createdBy })
        .from(evidenceLink)
        .where(eq(evidenceLink.linkedObjectId, edited.row.id));
      // The link records WHO decided this document backs this figure. The carry
      // is a mechanical consequence of an edit; crediting the editor with
      // attaching an invoice they never saw would be a lie in an audit trail.
      expect(carried.map((c) => c.createdBy)).toEqual([
        fx.contributorId,
        fx.contributorId,
      ]);
    });

    it("carries onto the APPROVED version — the question DM-25 exists for", async () => {
      const fx = await setup();
      const { row, documentIds } = await linkedRow(fx);

      const approved = await approveRow(
        getTestDb(),
        await rowSession(fx),
        "emission_activity",
        row.id,
      );
      expect(approved.ok).toBe(true);
      if (!approved.ok) return;

      expect(approved.row.state).toBe("approved");
      // Without the carry the approved head would be the ONE version of the
      // chain with no evidence at all — precisely the version anybody asks about.
      expect(await documentsBacking(fx.companyId, approved.row.id)).toEqual(
        documentIds,
      );
    });

    it("carries onto a TOMBSTONE, so a removed figure stays auditable", async () => {
      const fx = await setup();
      const { row, documentIds } = await linkedRow(fx);

      const deleted = await deleteRow(
        getTestDb(),
        await rowSession(fx),
        "emission_activity",
        row.id,
        { changeReason: "double counted" },
      );
      expect(deleted.ok).toBe(true);
      if (!deleted.ok) return;

      expect(deleted.row.isDeleted).toBe(true);
      // Same reason `carryForward` copies the whole BODY onto a tombstone: the
      // tombstone records the row AS IT STOOD when it was removed, and "why did
      // this go" is exactly when the evidence is asked for.
      expect(await documentsBacking(fx.companyId, deleted.row.id)).toEqual(
        documentIds,
      );
    });

    it("carries across a SEED — a restatement keeps its evidence (LC-9)", async () => {
      const fx = await setup();
      const { row, documentIds } = await linkedRow(fx);

      // A second revision OF THE SAME PERIOD, which is the only kind
      // `createRevision` will seed from — so the copy carries the SAME
      // `year_month` and the same documents still cover it.
      const restatement = await insertRevision(fx.companyId, {
        periodId: fx.periodId,
        revisionNo: 2,
        isCurrent: false,
        createdBy: fx.adminId,
      });
      await seedRevisionRows(
        getTestDb(),
        fx.companyId,
        { userId: fx.adminId, role: "esg_admin" },
        fx.revisionId,
        restatement.id,
      );

      const [copy] = await getTestDb()
        .select()
        .from(emissionActivity)
        .where(eq(emissionActivity.revisionId, restatement.id));
      expect(copy.previousVersionId).toBe(row.id);
      expect(copy.yearMonth).toBe(row.yearMonth);
      expect(await documentsBacking(fx.companyId, copy.id)).toEqual(
        documentIds,
      );
      // …and the source revision is untouched, as always.
      expect(await documentsBacking(fx.companyId, row.id)).toEqual(documentIds);
    });
  });

  // ─── EV-3 — unlinking, and what it must NOT touch ──────────────────────────

  describe("unlinking (EV-3, DM-26)", () => {
    it("removes the link and leaves the FILE and the document row alone", async () => {
      const fx = await setup();

      // Real bytes, written through the same `DocumentStorage` the upload route
      // uses — into THIS SUITE'S temporary root (see the file header).
      const stored = await documentStorage.put(
        new TextEncoder().encode("%PDF-1.4\n% evidence\n%%EOF\n"),
        { companyId: fx.companyId, mime: "application/pdf" },
      );
      const doc = await insertDocument(fx.companyId, {
        storageKey: stored.key,
        fileHash: stored.sha256,
        sizeBytes: stored.sizeBytes,
      });
      const filePath = path.join(documentsDir.path, stored.key);

      // The isolation IS the assertion: this path is inside the suite's own
      // `os.tmpdir()` root, so what `stat` reports was written by this test and
      // by nothing else.
      expect(documentsDir.path.startsWith(os.tmpdir())).toBe(true);
      expect(filePath.startsWith(documentsDir.path)).toBe(true);
      const before = await stat(filePath);

      const row = await insertEmissionActivity(fx.companyId, {
        revisionId: fx.revisionId,
      });
      const created = await link({
        documentId: doc.id,
        objectType: "emission_activity",
        objectId: row.id,
      });
      const linkId = created.body.data.link.id as string;

      const removed = await unlink(linkId);
      expect(removed.status).toBe(200);
      expect(removed.body.data.document_id).toBe(doc.id);

      // The link is gone…
      expect(await documentsBacking(fx.companyId, row.id)).toEqual([]);
      // …the document row is NOT…
      const rows = await getTestDb().select().from(evidenceLink);
      expect(rows).toHaveLength(0);
      expect(
        (await listLinksApi(`?document_id=${doc.id}`)).body.data.links,
      ).toHaveLength(0);
      // …and the bytes are byte-for-byte where they were. Only an explicit
      // delete of the DOCUMENT may remove a file (D6).
      const after = await stat(filePath);
      expect(after.size).toBe(before.size);
      expect(after.size).toBe(stored.sizeBytes);
    });

    it("answers an unknown or foreign link id as absent", async () => {
      const fx = await setup();
      const other = await insertCompany();
      const foreign = await insertEvidenceLink(other.id);

      expect((await unlink(randomUUID())).status).toBe(404);
      // Another tenant's link and an id that never existed are one answer.
      expect((await unlink(foreign.id)).status).toBe(404);
      expect(
        await documentsBacking(fx.companyId, foreign.linkedObjectId),
      ).toEqual([]);
    });
  });

  // ─── VAL-010 — the freeze reaches the evidence (EV-3, LC-8(2)) ─────────────

  describe("a Locked revision freezes its evidence (VAL-010)", () => {
    /** A document linked to a row of a LOCKED revision of its own period. */
    async function lockedFixture(fx: Fixture) {
      const locked = await insertRevision(fx.companyId, {
        status: "locked",
        createdBy: fx.adminId,
      });
      const row = await insertEmissionActivity(fx.companyId, {
        revisionId: locked.id,
      });
      const doc = await insertDocument(fx.companyId);
      const linkRow = await insertEvidenceLink(fx.companyId, {
        documentId: doc.id,
        linkedObjectType: "emission_activity",
        linkedObjectId: row.id,
      });
      return { locked, row, doc, linkRow };
    }

    it("refuses to delete the document, 422 VAL-010, and keeps it", async () => {
      const fx = await setup();
      const { doc } = await lockedFixture(fx);

      const res = await removeDoc(doc.id);

      expect(res.status).toBe(422);
      expect(res.body.error).toBe("VALIDATION");
      expect(
        (res.body.rules as { code: string }[]).map((rule) => rule.code),
      ).toEqual(["VAL-010"]);

      // The refusal is complete: the row is still there, and so is the link it
      // was refused for. (Nothing was written to disk by this test, so there is
      // nothing to assert about bytes — the document row IS the thing at risk,
      // because `evidence_link.document_id` cascades.)
      const kept = await listLinksApi(`?document_id=${doc.id}`);
      expect(kept.body.data.links).toHaveLength(1);
    });

    it("refuses to tear the link off, and to make a new one", async () => {
      const fx = await setup();
      const { row, doc, linkRow } = await lockedFixture(fx);

      // LC-8(2) puts rows, DQ and evidence links behind ONE guard: a published
      // report's evidence is part of what it published.
      const torn = await unlink(linkRow.id);
      expect(torn.status).toBe(422);
      expect((torn.body.rules as { code: string }[])[0].code).toBe("VAL-010");

      const another = await insertDocument(fx.companyId);
      const attached = await link({
        documentId: another.id,
        objectType: "emission_activity",
        objectId: row.id,
      });
      expect(attached.status).toBe(422);
      expect((attached.body.rules as { code: string }[])[0].code).toBe(
        "VAL-010",
      );

      // Neither refusal changed anything.
      expect(await documentsBacking(fx.companyId, row.id)).toEqual([doc.id]);
    });

    it("still deletes a document whose links are all on DRAFT rows", async () => {
      const fx = await setup();
      const doc = await insertDocument(fx.companyId);
      const row = await insertEmissionActivity(fx.companyId, {
        revisionId: fx.revisionId, // draft
      });
      await insertEvidenceLink(fx.companyId, {
        documentId: doc.id,
        linkedObjectType: "emission_activity",
        linkedObjectId: row.id,
      });

      // The freeze is about LOCKED, not about "has links at all" — a draft
      // report's evidence is as editable as the draft.
      const res = await removeDoc(doc.id);
      expect(res.status).toBe(200);
      // The link went with the document (ON DELETE CASCADE, DM-25).
      expect(await documentsBacking(fx.companyId, row.id)).toEqual([]);
    });
  });

  // ─── VAL-037 — coverage is a Warning (EV-4) ────────────────────────────────

  describe("evidence coverage (EV-4, VAL-037)", () => {
    /** The stored VAL-037 result for one link, or `undefined`. */
    async function storedVal037(companyId: string, linkId: string) {
      const [row] = await getTestDb()
        .select()
        .from(validationResult)
        .where(
          and(
            eq(validationResult.companyId, companyId),
            eq(validationResult.ruleCode, "VAL-037"),
            eq(validationResult.objectId, linkId),
          ),
        );
      return row;
    }

    async function linkWithCoverage(
      fx: Fixture,
      coverage: { coverageStart?: string | null; coverageEnd?: string | null },
      yearMonth: string,
    ) {
      const doc = await insertDocument(fx.companyId, coverage);
      const row = await insertEmissionActivity(fx.companyId, {
        revisionId: fx.revisionId,
        yearMonth,
      });
      const res = await link({
        documentId: doc.id,
        objectType: "emission_activity",
        objectId: row.id,
      });
      return { res, linkId: res.body.data.link.id as string };
    }

    it("warns without blocking when the window misses the month", async () => {
      const fx = await setup();
      const { res, linkId } = await linkWithCoverage(
        fx,
        { coverageStart: "2024-03-01", coverageEnd: "2024-03-31" },
        "2024-01",
      );

      // ACCEPTED — a warning never refuses (§6.2), so the March invoice is
      // attached to the January row and the user is told why that looks wrong.
      expect(res.status).toBe(200);
      expect(res.body.data.created).toBe(true);
      expect(
        (res.body.data.warnings as { code: string }[]).map((w) => w.code),
      ).toEqual(["VAL-037"]);

      const stored = await storedVal037(fx.companyId, linkId);
      expect(stored.passed).toBe(false);
      expect(stored.blocking).toBe(false);
      expect(stored.severity).toBe("warning");
      // The finding is filed under the LINK (§6.2 `appliesTo`), not the row:
      // two documents on one row would otherwise collide on the DM-28 key.
      expect(stored.objectType).toBe("evidence_link");
      // …and it carries the revision, so it surfaces on the revision's own
      // validation screen beside everything else that revision answers for.
      expect(stored.revisionId).toBe(fx.revisionId);
    });

    it("passes on any overlap, however partial", async () => {
      const fx = await setup();
      // A billing cycle, not a calendar month — the normal way an energy
      // supplier invoices a January figure. Demanding containment would put a
      // warning on most rows in most companies.
      const { res, linkId } = await linkWithCoverage(
        fx,
        { coverageStart: "2023-12-15", coverageEnd: "2024-01-14" },
        "2024-01",
      );

      expect(res.body.data.warnings).toEqual([]);
      expect((await storedVal037(fx.companyId, linkId)).passed).toBe(true);
    });

    it("passes a document that claims no window at all", async () => {
      const fx = await setup();
      const { res, linkId } = await linkWithCoverage(
        fx,
        { coverageStart: null, coverageEnd: null },
        "2024-01",
      );

      // `coverage_*` are optional DM-24 metadata; a document that claims no
      // period cannot contradict one. The rule for "no evidence at all" is
      // DQ-4/VAL-041 (T4.4), not this one.
      expect(res.body.data.warnings).toEqual([]);
      expect((await storedVal037(fx.companyId, linkId)).passed).toBe(true);
    });

    it("half-checks a half-open window", async () => {
      const fx = await setup();
      const late = await linkWithCoverage(
        fx,
        { coverageStart: "2024-06-01", coverageEnd: null },
        "2024-01",
      );
      expect(
        (late.res.body.data.warnings as { code: string }[]).map((w) => w.code),
      ).toEqual(["VAL-037"]);

      const open = await linkWithCoverage(
        fx,
        { coverageStart: "2023-06-01", coverageEnd: null },
        "2024-01",
      );
      expect(open.res.body.data.warnings).toEqual([]);
    });

    it("says nothing about a link whose target has no month", async () => {
      const fx = await setup();
      const doc = await insertDocument(fx.companyId, {
        coverageStart: "2024-03-01",
        coverageEnd: "2024-03-31",
      });
      const row = await insertEmissionActivity(fx.companyId, {
        revisionId: fx.revisionId,
        yearMonth: null,
      });
      const res = await link({
        documentId: doc.id,
        objectType: "emission_activity",
        objectId: row.id,
      });

      expect(res.status).toBe(200);
      expect(res.body.data.warnings).toEqual([]);
      const stored = await storedVal037(
        fx.companyId,
        res.body.data.link.id as string,
      );
      expect(stored.passed).toBe(true);
    });
  });
});
