// =============================================================================
// Dunning schedule (BILLING §5, layer D). PURE — no DB, no `server-only` — so the
// cron engine (`cron.ts`) and the later retry loop (T-D2) share ONE definition of
// "how long until the nth charge attempt", and it is unit-testable in isolation.
//
// `DUNNING_INTERVAL_DAYS` is operator config: a CSV schedule (e.g. `1,3,5` → retry
// 1 day after the failure, then 3, then 5) OR a single number (a fixed gap). T-D1
// only consults `intervalDays(1)` (the first past_due schedule); T-D2 walks the
// rest as `dunningAttempts` climbs.
// =============================================================================

/** Fallback gap (days) when `DUNNING_INTERVAL_DAYS` is unset or unparseable. */
const DEFAULT_INTERVAL_DAYS = 1;

/** Fallback retry cap when `DUNNING_RETRIES` is unset or unparseable. */
const DEFAULT_DUNNING_RETRIES = 3;

/**
 * How many failed MIT charge attempts a `past_due` subscription tolerates before it
 * is expired (downgraded to free). Counts the ORIGINAL failed renewal as attempt 1,
 * so with the default `3` a sub is expired after the renewal plus two retries fail.
 * Reads `DUNNING_RETRIES`; a missing / non-integer / non-positive value falls back to
 * `DEFAULT_DUNNING_RETRIES`. Read at call time so tests (and config reloads) take
 * effect without a restart.
 */
export function dunningRetries(): number {
  const raw = process.env.DUNNING_RETRIES?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DUNNING_RETRIES;
}

/**
 * Days to wait before the `attempt`-th charge retry (1-based). Reads the CSV/single
 * `DUNNING_INTERVAL_DAYS`; `attempt` indexes into it (1 → first element), CLAMPED to
 * the last element for attempts past the schedule. A single number applies to every
 * attempt. Non-positive / non-finite entries are dropped; an empty schedule falls
 * back to `DEFAULT_INTERVAL_DAYS`.
 */
export function intervalDays(attempt: number): number {
  const raw = process.env.DUNNING_INTERVAL_DAYS?.trim();
  const parts = (raw ? raw.split(",") : [])
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (parts.length === 0) return DEFAULT_INTERVAL_DAYS;
  const oneBased = Math.max(1, Math.floor(attempt));
  const idx = Math.min(oneBased, parts.length) - 1; // clamp to the last element
  return parts[idx];
}
