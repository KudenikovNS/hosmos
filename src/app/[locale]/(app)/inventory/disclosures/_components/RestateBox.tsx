"use client";

// =============================================================================
// «THE REVISION IS CLOSED» — WITH A WAY FORWARD (партия 21).
//
// The screen used to state the fact and stop: «this revision is no longer open,
// its answers cannot be changed. Create a new revision to restate the
// disclosure.» Where, it did not say — the control lived on another screen —
// so the owner read it as «this data cannot be entered at all».
//
// The box below is that control, next to the sentence that sends you looking
// for it. Two things it does NOT take liberties with:
//
//   • THE REASON IS REQUIRED (§5.1). A restatement of a locked report is an
//     audited act; the field is the reason, not a formality.
//   • `seedFrom` IS ALWAYS SENT. Without it the API opens an EMPTY revision —
//     the locked report's rows stay behind and the new one has nothing to
//     calculate. That mistake has been made here once; it cannot be made from
//     this form.
// =============================================================================
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";

import { RefusalNote } from "../../../_components/ScreenKit";
import { useStartRevision } from "../../_lib/useInventory";
import type { Refusal } from "../_lib/api";
import styles from "../page.module.css";

export function RestateBox({
  periodId,
  revisionId,
}: {
  periodId: string | null;
  revisionId: string | null;
}) {
  const t = useTranslations("disclosures");
  const start = useStartRevision();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  if (!periodId || !revisionId) return null;
  const ready = reason.trim() !== "";

  const submit = async () => {
    if (busy || !ready) return;
    setBusy(true);
    setRefusal(null);
    const result = await start(periodId, {
      seedFrom: revisionId,
      changeReason: reason.trim(),
    });
    setBusy(false);
    if (result.ok) setReason("");
    else setRefusal(result);
  };

  return (
    <div className={styles.restate}>
      <p className={styles.restateTitle}>{t("restate.title")}</p>
      <p className={styles.controlHint}>{t("restate.hint")}</p>
      <Input
        label={t("restate.reason")}
        id="disclosures-restate-reason"
        required
        value={reason}
        disabled={busy}
        onChange={(e) => setReason(e.target.value)}
      />
      <RefusalNote screen="inventory" refusal={refusal} />
      <div className={styles.restateActions}>
        <Button
          size="sm"
          loading={busy}
          disabled={!ready}
          onClick={() => void submit()}
        >
          {t("restate.action")}
        </Button>
      </div>
    </div>
  );
}
