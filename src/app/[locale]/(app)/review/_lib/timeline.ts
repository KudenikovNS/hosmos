// =============================================================================
// THE STATUS TIMELINE OF ONE REVISION — one pure function (T4.6; §5.1, LC-1,
// LC-10).
//
// THE TIMELINE IS READ OFF THE REVISION ROW ITSELF, not off `audit_log`, and
// that is deliberate: §5.1 gives every transition a STAMP on the row
// (`submitted_by/at`, `reviewed_by/at`, `approved_by/at`, `locked_by/at`, plus
// `created_by/at` for the first row of the matrix), and those stamps are the
// authoritative record of what happened to this revision. They are also
// available to every role that can read the revision, whereas `/api/audit`
// requires `audit.read` — a contributor deliberately lacks it (§6.2), and a
// timeline that went blank for them would be hiding the state of their own
// submission.
//
// WHAT IT CANNOT SHOW, and says so rather than inventing it. A revision that
// went `submitted → in_review → rejected → draft → submitted` again keeps only
// the LATEST stamp of each kind — the row has one `submitted_at`, not a list. So
// this is the timeline of the CURRENT pass, and the full history of every
// attempt is `audit_log`'s (LC-10), which `/evidence` renders. Presenting these
// five stamps as if they were a complete event log would be the one lie a status
// timeline must not tell.
//
// `abandon` HAS NO STAMP because it changes currency, not status (LC-1a): the
// revision keeps its rows and its files and simply stops being current. The
// panel states that as a property of the revision (`is_current`), which is what
// it is.
// =============================================================================
import type { RevisionDto } from "./api";

/** The five stamped moments of §5.1, in the order they can occur. */
export const TIMELINE_STEPS = [
  "created",
  "submitted",
  "reviewed",
  "approved",
  "locked",
] as const;

type TimelineStep = (typeof TIMELINE_STEPS)[number];

/** One stamped moment: what happened, who did it, when. */
export interface TimelineEntry {
  readonly step: TimelineStep;
  readonly userId: string | null;
  /** ISO instant. Entries without one did not happen and are not returned. */
  readonly at: string;
}

/**
 * The stamps this revision carries, oldest first.
 *
 * A stamp with no timestamp has not happened; it is omitted rather than rendered
 * as a pending step, because "not yet" and "we do not know when" look identical
 * on a timeline and only one of them is true here.
 */
export function revisionTimeline(
  revision: RevisionDto | null,
): TimelineEntry[] {
  if (!revision) return [];
  const stamps: {
    step: TimelineStep;
    userId: string | null;
    at: string | null;
  }[] = [
    { step: "created", userId: revision.created_by, at: revision.created_at },
    {
      step: "submitted",
      userId: revision.submitted_by,
      at: revision.submitted_at,
    },
    {
      step: "reviewed",
      userId: revision.reviewed_by,
      at: revision.reviewed_at,
    },
    {
      step: "approved",
      userId: revision.approved_by,
      at: revision.approved_at,
    },
    { step: "locked", userId: revision.locked_by, at: revision.locked_at },
  ];
  return stamps.flatMap((stamp) =>
    stamp.at === null
      ? []
      : [{ step: stamp.step, userId: stamp.userId, at: stamp.at }],
  );
}
