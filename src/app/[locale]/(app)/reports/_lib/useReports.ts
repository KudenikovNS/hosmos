"use client";

// =============================================================================
// THE DATA HOOKS OF `/reports` (T5.8) — shaped exactly like `/review`'s and
// `/evidence`'s, and importing their primitives rather than re-writing them:
// `useList` (a 403 on a list is `accessChanged`, not a crash — R-11) and
// `useWrite` (a write returns a `WriteOutcome` and never throws) are ONE
// decision for every screen of this app. The period picker and the revision
// list are `/inventory`'s hooks, imported — so opening `/reports` after
// `/review` refetches nothing either screen already holds.
//
// WHAT IS DIFFERENT HERE, and there are two things:
//
//   1. THE PREVIEW IS KEYED BY LANGUAGE. `GET /api/revisions/[id]/render`
//      answers in a language, because the `completeness_note` it returns is the
//      SENTENCE that will be stamped into the file (D14/О-14). Switching the
//      language picker therefore refetches rather than re-rendering the old
//      note, and the two answers are cached side by side — a user comparing
//      `en` and `sl` before deciding is doing exactly what О-14 is for.
//   2. A RENDER INVALIDATES THE RENDER LIST BY PREFIX. `["renders"]` is
//      invalidated as a PREFIX rather than as the exact tuple, because a render
//      belongs both to the all-renders listing and to its revision's; a screen
//      that guessed one spelling would show a list missing the file the user
//      just made. It does NOT invalidate the preview: a render changes nothing
//      the preview reports (REN-5 appends, it never mutates), and refetching it
//      would only make the screen flicker.
// =============================================================================
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import type { ReportLanguage } from "@/i18n/locales";
import type { RenderFormat } from "@/shared/reports";

import { useList, useWrite } from "../../inventory/_lib/useInventory";
import { usePeriods, useRevisions } from "../../inventory/_lib/useInventory";
import type {
  RenderCreatedData,
  RenderDto,
  RenderListData,
  RenderPreviewData,
  RenderPreviewDto,
  WriteOutcome,
} from "./api";

export { usePeriods, useRevisions };

/** react-query keys. `RENDERS_PREFIX` is a prefix, so invalidation cannot miss. */
const RENDERS_PREFIX = ["renders"] as const;
const rendersKey = (revisionId: string | null) =>
  [...RENDERS_PREFIX, revisionId ?? "all"] as const;
const previewKey = (revisionId: string, language: string) =>
  ["render-preview", revisionId, language] as const;

/** Stable empty array — a fresh `[]` per render would churn every memo. */
const NO_RENDERS: RenderDto[] = [];

/**
 * What a render of this revision, in this language, WOULD be (REN-3 + D14 + F1).
 *
 * A pure READ that writes nothing and gates nothing: the endpoint reports the
 * REN-3 verdict rather than enforcing it, so a `draft` revision still answers
 * 200 with `renderable: false` and a reason the screen can explain. `null`
 * `revisionId` — no period, or no renderable revision yet — disables the query
 * rather than fetching a preview of nothing.
 */
export function useRenderPreview(
  revisionId: string | null,
  language: ReportLanguage,
): {
  preview: RenderPreviewDto | null;
  loading: boolean;
  accessChanged: boolean;
  loadError: boolean;
} {
  const list = useList<RenderPreviewData>(
    previewKey(revisionId ?? "none", language),
    revisionId
      ? `/api/revisions/${revisionId}/render?language=${language}`
      : null,
  );
  return {
    preview: list.data?.preview ?? null,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
  };
}

/**
 * The immutable renders of the company, newest first (DM-30, REN-5).
 *
 * `revisionId` narrows the list to one revision; `null` lists the whole company,
 * which is what the screen shows — a report published last year is still the
 * artefact somebody has to find, and scoping the list to whatever revision the
 * wizard happens to have selected would hide it.
 */
export function useRenders(revisionId: string | null = null) {
  const list = useList<RenderListData>(
    rendersKey(revisionId),
    revisionId ? `/api/renders?revision_id=${revisionId}` : "/api/renders",
  );
  return {
    renders: list.data?.renders ?? NO_RENDERS,
    loading: list.loading,
    accessChanged: list.accessChanged,
    loadError: list.loadError,
  };
}

/**
 * Produce one render (REN-3…REN-5). The ONE write of this screen.
 *
 * `language` is always sent, never left to the server's default: the wizard has
 * shown the user which language they are about to get, and a request that omits
 * it would let `profiles.locale` decide something the screen has already
 * promised (О-14).
 */
export function useRenderRevision(): (
  revisionId: string,
  input: { format: RenderFormat; language: ReportLanguage },
) => Promise<WriteOutcome<RenderCreatedData>> {
  const write = useWrite();
  const queryClient = useQueryClient();
  return useCallback(
    async (
      revisionId: string,
      input: { format: RenderFormat; language: ReportLanguage },
    ) => {
      const outcome = await write<RenderCreatedData>(
        `/api/revisions/${revisionId}/render`,
        "POST",
        { format: input.format, language: input.language },
        [],
      );
      // Once, and by PREFIX: the new row belongs to both listings.
      if (outcome.ok) {
        queryClient.invalidateQueries({ queryKey: RENDERS_PREFIX });
      }
      return outcome;
    },
    [write, queryClient],
  );
}
