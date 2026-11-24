"use client";

// =============================================================================
// THE UPLOAD PANEL (UI-3, §4.16 DM-24, EV-0, EV-1, PG-1) — drag-and-drop, the
// seven metadata fields, and the two sentences the acceptance criteria are about.
//
// WHAT LEAVES THE BROWSER IS A `FormData`, field for field as the route parses
// it (`parseDocumentMeta`, `@/server/evidence/documents`). There is no client
// conversion layer, for the reason `useAutosave`'s header gives: the service
// parsers already speak what a form control speaks — `""` is a cleared column,
// `"2026-01-31"` is a date — so a `toWire` here would be a second, silent copy
// of the contract, and the day the two disagreed the screen would be sending
// values the API never agreed to accept.
//
// THE PLAN CEILING IS NOT AN ERROR (the first acceptance criterion). A file over
// `maxUploadMb` comes back 402 — from the `Content-Length` pre-check or from the
// streaming counter inside `DocumentStorage.put`, deliberately the same answer —
// and `uploadNotice` routes it to its own branch, which this panel renders as
// `PlanNote`: the number the plan allows, and an upgrade CTA. It never reaches
// the refusal list. THE CLIENT DOES NOT PRE-REFUSE ON `file.size` either, and
// that is deliberate: the entitlement is the server's to resolve (`writeFeatures`
// — a lapsed subscription is judged against the cap that will actually apply),
// so a client-side size check would be a second opinion that can be wrong in the
// direction that hurts, i.e. refusing an upload the server would have taken.
//
// A DUPLICATE IS A SUCCESS WITH A SUGGESTION (the second one). EV-1: identical
// bytes are ONE file and still TWO rows, because two uploads are two acts of
// evidence. So the panel says the document was stored, and then — as a hint, in
// the note register, never in the error one — that the same bytes are already
// here, naming the earlier document and offering to select it instead. Selecting
// it does not undo anything: the row that was just written stays, and removing
// it is a separate, explicit act that only `company.manage` can perform.
//
// THE FORM IS NOT THE GUARD. `data.write` is what the route requires; the panel
// is simply not rendered without it, and a direct POST is still a 403.
// =============================================================================
import { Loader2, Paperclip, UploadCloud } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { Select } from "@/shared/ui/Select";

import type { DocumentDto, UploadData, WriteOutcome } from "../_lib/api";
import {
  CONFIDENTIALITY_VALUES,
  DOCUMENT_META_FIELDS,
  uploadNotice,
  type UploadNotice,
} from "../_lib/upload";
import styles from "../page.module.css";
import {
  ACCEPTED_LABEL,
  ACCEPT_ATTRIBUTE,
  isAcceptedFileName,
} from "@/shared/evidence/accepted-files";

import { Muted, RefusalNote } from "../../_components/ScreenKit";
import { PlanNote, WarningHints } from "./common";

/** Which control each DM-24 metadata field gets. `confidentiality` is the enum. */
const DATE_FIELDS = new Set([
  "document_date",
  "coverage_start",
  "coverage_end",
  "retention_date",
]);

/** The file input's `accept`, mirroring EV-0's allowlist (the server decides). */
const ACCEPT = ACCEPT_ATTRIBUTE;

export function UploadPanel({
  library,
  maxUploadMb,
  upload,
  onReuse,
}: {
  /** The listing as it stands — what a duplicate hint points back into. */
  library: readonly DocumentDto[];
  /** From the session's resolved plan features, only ever used to WORD the 402. */
  maxUploadMb: number;
  upload: (form: FormData) => Promise<WriteOutcome<UploadData>>;
  /** "Use the one that is already here" — selects an existing document. */
  onReuse: (documentId: string) => void;
}) {
  const t = useTranslations("evidence");
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState<Record<string, string>>({});
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<UploadNotice | null>(null);

  const pick = (picked: File | null) => {
    // Партия 24 — a dropped file bypasses `accept` entirely, so the type is
    // judged here too. The size is NOT: that is the server's entitlement.
    if (picked && !isAcceptedFileName(picked.name)) {
      setFile(null);
      setNotice({ kind: "unsupportedType" });
      return;
    }
    setFile(picked);
    // The previous answer describes the previous file. Keeping it beside a new
    // one would be the panel telling the user about an upload they replaced.
    setNotice(null);
  };

  const send = async () => {
    if (!file || busy) return;
    setBusy(true);
    const form = new FormData();
    form.append("file", file);
    form.append("file_name", file.name);
    for (const field of DOCUMENT_META_FIELDS) {
      const value = meta[field];
      if (value) form.append(field, value);
    }
    const outcome = await upload(form);
    setBusy(false);
    setNotice(uploadNotice(outcome, library, maxUploadMb));
    // Only a stored document clears the picker: after a refusal the file is
    // still what the user meant to send, and making them choose it again would
    // be the screen forgetting an act it did not perform.
    if (outcome.ok) {
      setFile(null);
      setMeta({});
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <div className={styles.upload}>
      <div
        className={dragging ? styles.dropZoneActive : styles.dropZone}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files[0] ?? null);
        }}
      >
        <UploadCloud size={20} className={styles.iconBlue} />
        <p className={styles.dropTitle}>{t("upload.dropTitle")}</p>
        <p className={styles.dropBody}>
          {t("upload.dropBody", { limit: maxUploadMb })}
        </p>
        <input
          ref={fileInput}
          id="evidence-file"
          type="file"
          accept={ACCEPT}
          className={styles.fileInput}
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
        <label htmlFor="evidence-file" className={styles.fileLabel}>
          {t("upload.choose")}
        </label>
        {file && (
          <p className={styles.filePicked}>
            <Paperclip size={12} /> {file.name}
          </p>
        )}
      </div>

      <div className={styles.metaGrid}>
        {DOCUMENT_META_FIELDS.map((field) =>
          field === "confidentiality" ? (
            <Select
              key={field}
              id={`evidence-${field}`}
              label={t(`fields.${field}`)}
              options={CONFIDENTIALITY_VALUES.map((value) => ({
                value,
                label: t(`enums.confidentiality.${value}`),
              }))}
              value={meta[field] ?? ""}
              onChange={(e) =>
                setMeta((prev) => ({ ...prev, [field]: e.target.value }))
              }
            />
          ) : (
            <Input
              key={field}
              id={`evidence-${field}`}
              label={t(`fields.${field}`)}
              type={DATE_FIELDS.has(field) ? "date" : "text"}
              hint={t.has(`hints.${field}`) ? t(`hints.${field}`) : undefined}
              value={meta[field] ?? ""}
              onChange={(e) =>
                setMeta((prev) => ({ ...prev, [field]: e.target.value }))
              }
            />
          ),
        )}
      </div>

      <div className={styles.formActions}>
        <Button
          size="sm"
          disabled={!file}
          loading={busy}
          onClick={() => void send()}
        >
          {t("upload.submit")}
        </Button>
        {busy && (
          <span className={styles.saveStatus}>
            <Loader2 size={14} className={styles.spin} /> {t("upload.busy")}
          </span>
        )}
      </div>

      <UploadResult notice={notice} onReuse={onReuse} />
    </div>
  );
}

/**
 * The sentence the upload ended with. ONE reference per branch of
 * `UploadNotice`, so the acceptance criteria are decided by a tested function
 * and not by the shape of this JSX.
 */
function UploadResult({
  notice,
  onReuse,
}: {
  notice: UploadNotice | null;
  onReuse: (documentId: string) => void;
}) {
  const t = useTranslations("evidence");
  if (notice === null) return null;

  if (notice.kind === "plan") {
    return <PlanNote maxUploadMb={notice.maxUploadMb} />;
  }
  if (notice.kind === "refused") {
    return <RefusalNote screen="evidence" refusal={notice.refusal} />;
  }
  if (notice.kind === "unsupportedType") {
    // Партия 24 — the answer the owner did not get: WHICH formats are taken,
    // and what to do with the file in hand.
    return (
      <div className={styles.typeNote} role="alert">
        <p className={styles.typeTitle}>{t("upload.typeTitle")}</p>
        <p>{t("upload.typeBody", { formats: ACCEPTED_LABEL })}</p>
      </div>
    );
  }

  return (
    <div className={styles.storedNote}>
      <p className={styles.storedTitle}>
        {t("upload.stored", { name: notice.document.file_name })}
      </p>
      {notice.duplicate && (
        <div className={styles.duplicate}>
          {/* VAL-013 in the register it belongs to: the upload SUCCEEDED and
              this is a suggestion about what to do next. */}
          <p className={styles.duplicateTitle}>{t("upload.duplicateTitle")}</p>
          <WarningHints codes={notice.duplicate.codes} />
          {notice.duplicate.earlier.length === 0 ? (
            <Muted>{t("upload.duplicateUnknown")}</Muted>
          ) : (
            <ul className={styles.duplicateList}>
              {notice.duplicate.earlier.map((earlier) => (
                <li key={earlier.id}>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => onReuse(earlier.id)}
                  >
                    {t("upload.reuse", { name: earlier.file_name })}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Muted>{t("upload.duplicateBody")}</Muted>
        </div>
      )}
    </div>
  );
}
