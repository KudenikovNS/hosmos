"use client";

// =============================================================================
// ONE DOCUMENT, WHOLE (UI-3, §4.16 DM-24, EV-3, EV-6, D6).
//
// THE METADATA IS SHOWN AS IT IS STORED, INCLUDING THE HASH. `file_hash` is the
// only field here that is not a fact about the paper — it is the dedup key, the
// thing VAL-013 reasons about — and it is on screen because "why is this
// document flagged as a possible duplicate" has no other answer a user can
// check. It is also the only field the server may WITHHOLD: for a `confidential`
// document read by someone who could not download it, `file_hash` arrives as
// `null` (EV-6, `serialiseDocument`), because a digest of contents you may not
// read lets you confirm a guess at them. It renders as the same em-dash every
// other absent value uses — there is nothing to explain to a reader who was
// never going to be shown the bytes. `storage_key` is deliberately NOT on the wire at all (see
// `serialiseDocument`): it is the blob backend's addressing scheme and a client
// that learned to build one would be reaching past the download route that
// enforces EV-6.
//
// DOWNLOADING IS A LINK, NOT A FETCH. `GET /api/documents/[id]/download` is the
// route that applies EV-6 to the CONTENTS (the listing is `data.read`, the bytes
// are not), and it answers with a `Content-Disposition`. Letting the browser
// follow it is what makes the refusal land on the browser's own error path
// rather than in a promise this screen would have to invent copy for.
//
// DELETING IS `company.manage`, NOT `data.write` — the one evidence action that
// cannot be undone from inside the app (§12.2). The button is therefore absent
// for everyone else, and the route requires the capability itself, so a direct
// DELETE is still a 403. Two refusals are worth their own words:
//   • VAL-010 — the document is still cited by a row of a LOCKED revision, so it
//     is not deletable at all (EV-3). It arrives as a rule code and is rendered
//     as one sentence, like every other blocking rule.
//   • `bytes_removed: false` on SUCCESS — another row of this company still
//     points at the same content-addressed key, so the file stayed. That is EV-0
//     dedup being honest about what a delete did, and the panel repeats it
//     rather than letting "deleted" mean two different things.
// =============================================================================
import { Download, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/shared/ui/Button";

import {
  downloadHref,
  type DocumentDto,
  type EvidenceLinkDto,
  type Refusal,
} from "../_lib/api";
import type { useEvidenceWrites } from "../_lib/useEvidence";
import styles from "../page.module.css";
import { Muted, RefusalNote } from "../../_components/ScreenKit";
import { useInstant } from "../../_lib/useInstant";
import { useDay, useEnumLabel } from "./common";

/** One label/value pair of the metadata grid. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.fact}>
      <span className={styles.factLabel}>{label}</span>
      <span className={styles.factValue}>{value}</span>
    </div>
  );
}

export function DocumentDetail({
  document,
  links,
  canDelete,
  writes,
  onDeleted,
  describeTarget,
}: {
  document: DocumentDto;
  /** Where this document is used — its half of DM-25, already indexed. */
  links: readonly EvidenceLinkDto[];
  /** `company.manage` (§12.2). The route requires it regardless. */
  canDelete: boolean;
  writes: ReturnType<typeof useEvidenceWrites>;
  onDeleted: () => void;
  /** A link target as a sentence — the page knows the inventory, this does not. */
  describeTarget: (objectType: string, objectId: string) => string;
}) {
  const t = useTranslations("evidence");
  const day = useDay();
  const instant = useInstant();
  const label = useEnumLabel();

  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [bytesKept, setBytesKept] = useState(false);

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    const result = await writes.removeDocument(document.id);
    setBusy(false);
    if (!result.ok) {
      setRefusal(result);
      return;
    }
    // Stated, not assumed: the row went, the FILE went only if nothing else of
    // this company still points at the same key (EV-0).
    setBytesKept(!result.data.bytes_removed);
    onDeleted();
  };

  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>
        <p className={styles.cardTitle}>{document.file_name}</p>
        <a
          className={styles.downloadLink}
          href={downloadHref(document.id)}
          target="_blank"
          rel="noreferrer"
        >
          <Download size={14} /> {t("document.download")}
        </a>
      </div>

      <div className={styles.factGrid}>
        <Fact
          label={t("fields.file_type")}
          value={label("fileType", document.file_type)}
        />
        <Fact
          label={t("fields.confidentiality")}
          value={label("confidentiality", document.confidentiality)}
        />
        <Fact label={t("fields.issuer")} value={document.issuer ?? "—"} />
        <Fact
          label={t("fields.document_date")}
          value={day(document.document_date)}
        />
        <Fact
          label={t("fields.coverage_start")}
          value={day(document.coverage_start)}
        />
        <Fact
          label={t("fields.coverage_end")}
          value={day(document.coverage_end)}
        />
        <Fact
          label={t("fields.retention_date")}
          value={day(document.retention_date)}
        />
        <Fact
          label={t("document.uploadedAt")}
          value={instant(document.uploaded_at)}
        />
        <Fact
          label={t("document.size")}
          value={
            document.size_bytes === null
              ? "—"
              : t("document.sizeValue", {
                  kb: Math.max(1, Math.round(document.size_bytes / 1024)),
                })
          }
        />
        <Fact
          label={t("document.hash")}
          value={
            document.file_hash === null ? "—" : document.file_hash.slice(0, 16)
          }
        />
      </div>

      <p className={styles.subsectionTitle}>{t("document.usedBy")}</p>
      {links.length === 0 ? (
        <Muted>{t("document.usedByNone")}</Muted>
      ) : (
        <ul className={styles.usageList}>
          {links.map((link) => (
            <li key={link.id}>
              {describeTarget(link.linked_object_type, link.linked_object_id)}
            </li>
          ))}
        </ul>
      )}

      {canDelete && (
        <div className={styles.formActions}>
          <Button
            variant="danger"
            size="sm"
            loading={busy}
            onClick={() => void remove()}
          >
            <Trash2 size={14} /> {t("document.delete")}
          </Button>
          <span className={styles.saveStatus}>{t("document.deleteHint")}</span>
        </div>
      )}
      {bytesKept && <Muted>{t("document.bytesKept")}</Muted>}
      <RefusalNote screen="evidence" refusal={refusal} />
    </div>
  );
}
