// =============================================================================
// AN ENTITY'S WINDOW AGAINST A REPORTING PERIOD (партия 21).
//
// `effective_from`/`effective_to` decide whether a legal entity is part of a
// report: the boundary of a period only offers entities whose window overlaps
// it. That is correct and invisible — the owner set «velja od 02.02.2030» on
// the parent company and nothing on the screen said that the 2024 report had
// just lost its only entity.
//
// The server now refuses a window that runs backwards; a window that simply
// misses the period is NOT an error (an entity really can join next year), so
// it is a warning, and this is the function behind it.
// =============================================================================

/** ISO dates, inclusive at both ends; an open end is `null`. */
export function overlapsPeriod(
  from: string | null,
  to: string | null,
  periodStart: string | null,
  periodEnd: string | null,
): boolean {
  if (!periodStart || !periodEnd) return true;
  if (from && from > periodEnd) return false;
  if (to && to < periodStart) return false;
  return true;
}
