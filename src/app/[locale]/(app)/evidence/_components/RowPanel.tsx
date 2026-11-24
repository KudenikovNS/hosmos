"use client";

// =============================================================================
// ONE ROW, AND EVERYTHING EVIDENCE HAS TO SAY ABOUT IT (UI-3, EV-2, EV-4, DQ-2,
// LC-10).
//
// THE LINK IS MADE FROM THIS SIDE, and that is the direction UI-3 describes:
// "привязка к строкам (поиск строки → линк)". A person holding an invoice looks
// for the figure it backs, not the other way round — so the library selects a
// document, the picker finds the row, and the button here states the
// relationship. The reverse direction is a READ (the library's usage column),
// never a second way to write the same row.
//
// A LINK POINTS AT ONE IMMUTABLE VERSION (DM-25), not at "the row". That is why
// the panel links the version the LISTING carries — the current head — and why
// nothing is re-pointed later: the carry hook copies a version's links onto its
// successor inside the write transaction, and the predecessor keeps its own. So
// "which documents stood behind this approved figure" stays answerable for every
// version of the chain.
//
// AN ALREADY-LINKED PAIR IS NOT AN ERROR. The UNIQUE of DM-25 makes a repeat a
// no-op and the route answers `created: false` rather than inventing a conflict
// code; the panel says "that document was already attached" instead of showing a
// failure for an action that reached exactly the state it asked for.
//
// VAL-037 IS A WARNING ON A LINK THAT WAS MADE (EV-4). A document whose coverage
// window misses the row's month is attached anyway and explained — so it renders
// as a hint under a link that exists, never as a refusal.
//
// UNLINKING IS NOT DELETING (EV-3, DM-26). The row loses a claim; the document
// and its bytes are untouched. Removing a file is a separate `company.manage`
// act over the document itself.
// =============================================================================
import { Link2, Paperclip, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import type { WorkflowStatus } from "@/shared/enums";
import type { Capability } from "@/shared/roles";
import { Button } from "@/shared/ui/Button";

import { rowActionGates } from "../../inventory/_lib/actions";
import type {
  AuditEntryDto,
  DocumentDto,
  DqAssessmentDto,
  EvidenceLinkDto,
  InventoryRowDto,
  Refusal,
  RowMixinDto,
  RuleRef,
} from "../_lib/api";
import { AUDIT_LIMIT, useEvidenceWrites } from "../_lib/useEvidence";
import styles from "../page.module.css";
import { ChangeTimeline } from "./ChangeTimeline";
import { LoadErrorNote, Muted, RefusalNote } from "../../_components/ScreenKit";
import { StateBadge, useEnumLabel, WarningHints } from "./common";
import { DqEditor } from "./DqEditor";

export function RowPanel({
  row,
  links,
  documents,
  selectedDocument,
  capabilities,
  revisionStatus,
  revisionId,
  assessment,
  assessmentLoading,
  assessmentLoadError,
  versions,
  chainTruncated,
  chainLoading,
  audit,
  auditAvailable,
  nameOf,
  writes,
  onClose,
}: {
  row: InventoryRowDto;
  /** The links of THIS row, already indexed (`_lib/filters#linksByTarget`). */
  links: readonly EvidenceLinkDto[];
  /** The whole library, so a link id can be shown as a file name. */
  documents: readonly DocumentDto[];
  /** What the library has selected — the document this panel offers to attach. */
  selectedDocument: DocumentDto | null;
  capabilities: readonly Capability[];
  revisionStatus: WorkflowStatus | null;
  revisionId: string | null;
  assessment: DqAssessmentDto | null;
  assessmentLoading: boolean;
  assessmentLoadError: boolean;
  versions: readonly RowMixinDto[];
  chainTruncated: boolean;
  chainLoading: boolean;
  audit: readonly AuditEntryDto[];
  auditAvailable: boolean;
  nameOf: (userId: string | null) => string | null;
  writes: ReturnType<typeof useEvidenceWrites>;
  onClose: () => void;
}) {
  const t = useTranslations("evidence");
  // `kind` is a free discriminator on the wire (§4.9–§4.12), so an unknown value
  // renders as its literal rather than throwing on a missing message key.
  const label = useEnumLabel();

  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [warnings, setWarnings] = useState<readonly RuleRef[]>([]);
  const [alreadyLinked, setAlreadyLinked] = useState(false);
  // VAL-038 from the DQ editor, held HERE because the editor is remounted by a
  // successful save — see the `key` below.
  const [dqWarnings, setDqWarnings] = useState<readonly RuleRef[]>([]);

  // ONE answer to "may this session write to this revision" — the same pure
  // function `/inventory` asks, so the two screens cannot disagree about a row
  // whose revision has been submitted (LC-5, VAL-010).
  const gates = rowActionGates({ capabilities, revisionStatus, row });

  const nameOfDocument = (documentId: string): string =>
    documents.find((document) => document.id === documentId)?.file_name ??
    t("row.unknownDocument");

  const attach = async () => {
    if (!selectedDocument || busy) return;
    setBusy(true);
    setRefusal(null);
    setWarnings([]);
    setAlreadyLinked(false);
    const result = await writes.link({
      documentId: selectedDocument.id,
      objectType: row.source_table,
      objectId: row.id,
    });
    setBusy(false);
    if (!result.ok) {
      setRefusal(result);
      return;
    }
    // `created: false` is the UNIQUE doing its job, not a failure (EV-2).
    setAlreadyLinked(!result.data.created);
    setWarnings(result.data.warnings);
  };

  const detach = async (linkId: string) => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    const result = await writes.unlink(linkId);
    setBusy(false);
    if (!result.ok) setRefusal(result);
  };

  return (
    <aside className={styles.drawer} aria-label={t("row.title")}>
      <div className={styles.drawerHead}>
        <div className={styles.headerGrow}>
          <p className={styles.cardTitle}>{row.label ?? t("row.unnamed")}</p>
          <p className={styles.headerSubtitle}>
            {t("row.subtitle", {
              kind: label("kind", row.kind),
              month: row.year_month ?? t("row.wholePeriod"),
            })}
          </p>
        </div>
        <StateBadge state={row.state} />
        <button
          type="button"
          className={styles.iconButton}
          aria-label={t("row.close")}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>

      <p className={styles.subsectionTitle}>
        <Paperclip size={14} /> {t("row.evidence")}
      </p>
      {links.length === 0 ? (
        <Muted>{t("row.noEvidence")}</Muted>
      ) : (
        <ul className={styles.linkList}>
          {links.map((link) => (
            <li key={link.id}>
              <span>{nameOfDocument(link.document_id)}</span>
              {gates.canSaveDraft && (
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => void detach(link.id)}
                >
                  {t("row.unlink")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* `data.write` renders the attach control; the route requires it too, so
          a direct POST without it is still a 403. A frozen revision is stated
          here rather than discovered through VAL-010. */}
      {gates.canSaveDraft ? (
        <div className={styles.formActions}>
          <Button
            size="sm"
            disabled={!selectedDocument}
            loading={busy}
            onClick={() => void attach()}
          >
            <Link2 size={14} />{" "}
            {selectedDocument
              ? t("row.attach", { name: selectedDocument.file_name })
              : t("row.attachNone")}
          </Button>
        </div>
      ) : (
        <Muted>
          {gates.revisionOpen ? t("row.readOnly") : t("row.frozen")}
        </Muted>
      )}
      {alreadyLinked && <Muted>{t("row.alreadyLinked")}</Muted>}
      <WarningHints codes={warnings.map((warning) => warning.code)} />
      <RefusalNote screen="evidence" refusal={refusal} />

      {assessmentLoadError ? (
        <LoadErrorNote />
      ) : (
        <DqEditor
          // REMOUNTED BY A SUCCESSFUL SAVE, and only by one. `assessed_at` is
          // restamped on every accepted PUT (`putAssessment`), so this key
          // changes exactly when the server has stored something new — which is
          // the moment the editor's draft must be dropped and re-read from what
          // was actually stored.
          //
          // IT IS NOT COSMETIC. `useAutosave` keeps a field dirty while its
          // typed text differs from the stored value, and the server does not
          // echo text back verbatim: `50.0` comes back as `50`, and an override
          // that has just been switched OFF comes back with its reason cleared.
          // Without the remount those two would stay "different" for ever, the
          // debounce would fire again, and the screen would sit in a save loop
          // against a server that has already agreed with it. A REFUSAL leaves
          // `assessed_at` alone, so nothing is remounted and the dirty draft and
          // its refusal survive — which is the property that must not break.
          key={assessment?.assessed_at ?? "unassessed"}
          objectType={row.source_table}
          objectId={row.id}
          assessment={assessment}
          loading={assessmentLoading}
          capabilities={capabilities}
          revisionStatus={revisionStatus}
          writes={writes}
          warnings={dqWarnings}
          onWarnings={setDqWarnings}
        />
      )}

      <ChangeTimeline
        versions={versions}
        chainTruncated={chainTruncated}
        loading={chainLoading}
        audit={audit}
        auditLimit={AUDIT_LIMIT}
        auditAvailable={auditAvailable}
        revisionId={revisionId}
        nameOf={nameOf}
      />
    </aside>
  );
}
