"use client";

import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useCompany } from "@/shared/hooks/useSession";
import { useCompanySaves } from "@/shared/autosave/CompanySaveProvider";
import { autosaveKey } from "@/shared/autosave/controller";
import type { Draft, SaveStatus } from "@/shared/autosave/controller";
import type { Refusal, WriteOutcome } from "./api";

export type { Draft, SaveStatus };
export interface Autosave {
  values: Draft;
  set: (patch: Draft) => void;
  patch: Draft;
  dirty: boolean;
  status: SaveStatus;
  refusal: Refusal | null;
  confirm: () => void;
}

/** String-valued controls go straight to the service parser; no conversion layer.
 * Every draft is owned by a company AND form/object. Acknowledged edits are
 * removed; newer input survives. Closing a form flushes its draft immediately;
 * a refusal keeps it recoverable and surfaces an error notification.
 */
export function useAutosave(opts: {
  contextKey: string;
  baseline: Draft;
  save: (patch: Draft) => Promise<WriteOutcome<unknown>>;
  enabled: boolean;
}): Autosave {
  const t = useTranslations("topbar");
  const detachedSaveError = t("detachedSaveError");
  const { company } = useCompany();
  const { coordinator } = useCompanySaves();
  const key = autosaveKey(company?.id, opts.contextKey);
  // A new object gets a different controller, never the previous object's draft.
  const form = useMemo(() => coordinator.form(key, opts), [coordinator, key]); // eslint-disable-line react-hooks/exhaustive-deps
  useSyncExternalStore(form.subscribe, form.snapshot, form.snapshot);
  useLayoutEffect(() => {
    form.update(opts);
  });
  useLayoutEffect(() => {
    coordinator.attach(key, form);
    form.mount();
    return () => {
      void coordinator.detach(key, form).then((saved) => {
        if (!saved) toast.error(detachedSaveError);
      });
    };
  }, [form, coordinator, key, detachedSaveError]);
  return form.view;
}
