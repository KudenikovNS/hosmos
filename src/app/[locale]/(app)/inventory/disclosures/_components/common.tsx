"use client";

// =============================================================================
// THE PIECES THIS SCREEN OWNS — and, just as importantly, the ones it does not.
//
// WHAT IS IMPORTED FROM `../../../_components/ScreenKit` (shared by every
// screen): `SectionCard`, `Muted`, `AccessNote`, `LoadErrorNote` and
// `RefusalNote` (with the `inventory` namespace, whose field labels this screen
// writes through). Those are statements about the WIRE — "we could not load
// this", "your access changed" (R-11), "the server refused, and here is the
// rule" — and their vocabulary is the same on every screen that writes through
// `/api/*` (§0.2).
//
// WHAT LIVES HERE: the vocabulary that is this screen's own — the three states
// `T5.6` prints. They are localised (`disclosures.state.*`) because they are the
// PRODUCT's words about a metric; the metric's own words are the CATALOGUE's and
// are never translated by the app (О-20 — `title_en` is the standard's English,
// `title` the workbook's Russian, and a report in either language prints the
// domain text as the standard wrote it).
// =============================================================================
import { useTranslations } from "next-intl";

import { Badge } from "@/shared/ui/Badge";

import type { DisclosureState } from "../_lib/catalog";

/** The badge colour of each state — `filled` is the only positive one. */
const VARIANT: Record<DisclosureState, "green" | "gray" | "yellow"> = {
  filled: "green",
  not_collected: "yellow",
  not_applicable: "gray",
};

/** «filled» / «not collected» / «not applicable», as a badge. */
export function StateBadge({ state }: { state: DisclosureState }) {
  const t = useTranslations("disclosures");
  return (
    <Badge variant={VARIANT[state]} size="sm">
      {t(`state.${state}`)}
    </Badge>
  );
}
