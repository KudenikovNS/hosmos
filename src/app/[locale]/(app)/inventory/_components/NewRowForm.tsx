"use client";

// =============================================================================
// ADDING A ROW TO THE OPEN REVISION (LC-3) — the create half of a tab.
//
// IT IS NOT AN AUTOSAVING FORM, and the difference from the drawer is the point:
// there is nothing on the server yet to layer a draft over, so "dirty" has no
// meaning and a debounce would post half-typed rows. The drawer autosaves
// because a row EXISTS and the patch is the difference; this submits once.
//
// THE DISCRIMINATOR COMES FROM THE TAB, NOT FROM THE USER. `activity_category`
// (К-6) and the Scope-2 `energy_type` are set from `TabSpec`, so a row created
// on the mobile tab cannot arrive as stationary; the field is not offered
// because the tab already answered it. `revision_id` likewise comes from the
// screen's selection — and the server resolves it tenant-pinned regardless
// (PATTERN 3), so a foreign one reads as absent rather than as a row.
//
// THE INLINE CHECKS RUN HERE TOO and are still advisory (VR-2): the submit is
// always offered. A required column left blank arrives as `null` at the parser
// and comes back as 422 `{field: …}` — named, on the field, in the user's
// language — which is a better answer than a disabled button that never says
// which control it is waiting for.
// =============================================================================
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/shared/ui/Button";

import type { Draft } from "../../organisation/_lib/useAutosave";
import type {
  AssetDto,
  FacilityDto,
  LegalEntityDto,
  Refusal,
  RowDto,
  WriteOutcome,
} from "../_lib/api";
import { inlineChecks } from "../_lib/checks";
import type { TabSpec } from "../_lib/tabs";
import styles from "../page.module.css";
import { RefusalNote } from "../../_components/ScreenKit";
import {
  EmissionFields,
  EnergyFields,
  InstrumentFields,
  MixinFields,
  unitsFor,
} from "./RowFields";

/** The empty row of one tab: the mixin blanks plus the tab's discriminator. */
function emptyDraft(tab: TabSpec, firstEntityId: string): Draft {
  const base: Draft = {
    legal_entity_id: firstEntityId,
    facility_id: "",
    year_month: "",
    unit: "",
    notes: "",
  };
  if (tab.family === "emission") {
    return {
      ...base,
      // К-6 — the tab IS the category; it is never a control.
      activity_category: tab.category ?? "",
      source_name: "",
      activity_type: "",
      activity_value: "",
      method: "",
    };
  }
  if (tab.family === "energy") {
    return { ...base, energy_type: tab.energyType ?? "", consumption: "" };
  }
  return { ...base, instrument_type: "" };
}

export function NewRowForm({
  tab,
  revisionId,
  entities,
  facilities,
  assets,
  onCreate,
  onCreated,
}: {
  tab: TabSpec;
  revisionId: string;
  entities: LegalEntityDto[];
  facilities: FacilityDto[];
  assets: AssetDto[];
  onCreate: (body: unknown) => Promise<WriteOutcome<RowDto>>;
  onCreated: (id: string) => void;
}) {
  const t = useTranslations("inventory");
  const [draft, setDraft] = useState<Draft>(() =>
    emptyDraft(tab, entities[0]?.id ?? ""),
  );
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const set = (patch: Draft) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setRefusal(null);
  };
  const checks = inlineChecks(tab.table, draft);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const result = await onCreate({ ...draft, revision_id: revisionId });
    setBusy(false);
    if (result.ok) {
      setDraft(emptyDraft(tab, entities[0]?.id ?? ""));
      onCreated(result.data.id);
    } else {
      setRefusal(result);
    }
  };

  return (
    <form className={styles.inlineForm} onSubmit={submit}>
      <p className={styles.inlineFormTitle}>
        {t("actions.newTitle", { tab: t(`tabs.${tab.id}`) })}
      </p>
      <div className={styles.twoCol}>
        <MixinFields
          values={draft}
          set={set}
          checks={checks}
          disabled={false}
          idPrefix="new"
          entities={entities}
          facilities={facilities}
          units={unitsFor(tab)}
        />
        {tab.family === "emission" && (
          <EmissionFields
            tab={tab}
            values={draft}
            set={set}
            checks={checks}
            disabled={false}
            idPrefix="new"
          />
        )}
        {tab.family === "energy" && (
          <EnergyFields
            values={draft}
            set={set}
            checks={checks}
            disabled={false}
            idPrefix="new"
            assets={assets}
          />
        )}
        {tab.family === "instruments" && (
          <InstrumentFields
            values={draft}
            set={set}
            checks={checks}
            disabled={false}
            idPrefix="new"
          />
        )}
      </div>
      <RefusalNote screen="inventory" refusal={refusal} />
      <div className={styles.formActions}>
        <Button type="submit" size="sm" loading={busy}>
          <Plus size={14} /> {t("actions.new")}
        </Button>
      </div>
    </form>
  );
}
