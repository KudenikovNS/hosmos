"use client";

// =============================================================================
// "ADD A SUBSIDIARY" — the ONE control PG-5 tells the product to HIDE.
//
// PG-5's general rule is that a locked feature stays visible with an explanation
// and an upgrade CTA. The tariff PDF prescribes exactly one exception ("Поведение
// продукта по тарифам", Starter): on a plan whose whole org tree is capped at one
// legal entity, this control is NOT SHOWN. Not disabled, not dimmed, not behind a
// tooltip — absent.
//
// That is why this component exists as its own file with nothing else in it. The
// `hidden` branch is the FIRST statement and it returns `null`, so "the button is
// absent from the DOM" is a property anyone can verify by reading five lines, and
// `subsidiaryAffordance` — which decides it — is a pure function under test in
// `../_lib/__tests__/limits.test.ts`. A `disabled` prop anywhere in this file
// would be the bug; there is none, and the test asserts that too.
//
// The `locked` branch is the general rule, and it is the one a Pro customer with
// three of three entities sees.
// =============================================================================
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui/Button";

import type { Affordance } from "../_lib/limits";
import { PlanLock } from "../../_components/ScreenKit";

export function AddSubsidiary({
  affordance,
  onAdd,
}: {
  affordance: Affordance;
  onAdd: () => void;
}) {
  const t = useTranslations("organisation");

  if (affordance === "hidden") return null;

  if (affordance === "locked") {
    return (
      <PlanLock
        title={t("group.subsidiaryLockedTitle")}
        body={t("group.subsidiaryLockedBody")}
      />
    );
  }

  return (
    <Button variant="secondary" size="sm" onClick={onAdd}>
      <Plus size={14} /> {t("group.addSubsidiary")}
    </Button>
  );
}
