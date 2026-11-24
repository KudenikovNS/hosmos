// =============================================================================
// THE WIRE, AS THE `/reports` SCREEN SEES IT (T5.8 — UI-5, REN-3…REN-5, D14,
// PG-2, F1, О-14, API-1, §12.2).
//
// The same two rules as the other five screens' `_lib/api.ts`:
//
//   1. THE DTOs ARE IMPORTED, NOT RE-DECLARED. `RenderDto`, `RenderPreviewDto`,
//      `PlanExclusion` and `RevisionDto` are owned by the services that
//      serialise them; every import is `import type`, so the server modules —
//      and the drizzle runtime behind them — are erased at compile and never
//      reach the browser bundle.
//   2. A REFUSAL IS CLASSIFIED ONCE — `../../_lib/refusal`, whose `Refusal` and
//      `WriteOutcome` are re-exported here so this screen's imports read like
//      its neighbours'. Only the TYPES: every write on this screen goes through
//      `useWrite`, which calls `classifyRefusal` itself, so re-exporting the
//      function too would only offer a second way to do the one thing.
//
// WHAT THIS SCREEN NEEDS THAT IS NOT A DTO, and it is only two things:
//
//   • THE DOWNLOAD IS A LINK, NOT A FETCH (`downloadHref`), for the reason
//     `/evidence` gives about documents: `GET /api/renders/[id]/download`
//     answers with `Content-Disposition`, and letting the browser follow an
//     ordinary link is what makes the file land in the download folder instead
//     of in memory.
//   • THE FORMATS AND THE RENDERABLE STATUSES COME FROM `@/shared/reports`,
//     which is where they live precisely so that this screen and the server gate
//     read the same two lists (see that module's header). Nothing here decides
//     what a format is.
// =============================================================================
import type { PlanExclusion } from "@/server/render/disclaimer";
import type { RenderDto, RenderPreviewDto } from "@/server/render/persist";
import type { RevisionDto } from "@/server/revisions/revisions";

import type { Refusal, WriteOutcome } from "../../_lib/refusal";

export type { PlanExclusion, RenderDto, RenderPreviewDto, RevisionDto };

export type { Refusal, WriteOutcome };

/** `GET /api/renders[?revision_id=…]` — the immutable renders, newest first. */
export interface RenderListData {
  renders: RenderDto[];
}

/** `GET /api/revisions/[id]/render?language=…` — what a render WOULD be. */
export interface RenderPreviewData {
  preview: RenderPreviewDto;
}

/** `POST /api/revisions/[id]/render` — the row that was just written. */
export interface RenderCreatedData {
  render: RenderDto;
  size_bytes: number;
}

/**
 * WHERE THE BYTES ARE FETCHED FROM — the one API URL this screen hands to the
 * browser instead of to `apiFetch`.
 *
 * The base is resolved exactly as `apiFetch` resolves it in the browser
 * (`NEXT_PUBLIC_BACKEND_URL`, the only backend URL that ships to the bundle), so
 * the link points at the same origin the rest of the screen talks to rather than
 * at whatever host happens to be serving the page. Absent — which is a
 * misconfiguration `apiFetch` throws on — it degrades to a same-origin path.
 */
export function downloadHref(renderId: string): string {
  const base = (process.env.NEXT_PUBLIC_BACKEND_URL ?? "").replace(/\/+$/, "");
  return `${base}/api/renders/${renderId}/download`;
}
