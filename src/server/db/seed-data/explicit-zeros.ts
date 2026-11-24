// =============================================================================
// The SEEDED factors whose value is a LEGITIMATE zero (VAL-033's "unless
// explicitly valid zero") — a LEAF module: it imports nothing.
//
// WHY IT IS NOT IN `./factor-set-v1`, WHERE IT WAS BORN. T1.5 declared this list
// beside the 440 rows it exempts, which was the right home while the only reader
// was the seed's own test. T2.8 gave it a SECOND reader — VAL-033's evaluator,
// which runs on every hand-written factor and must pass the two seeded zeros for
// the same reason the seed ships them. Importing `./factor-set-v1` from a
// request path would have dragged the whole legacy factor corpus (and the maps
// it builds at module load) into a route bundle to read two strings, so the
// strings moved out and `./factor-set-v1` re-exports them: one definition, no
// payload, and the T1.5 suite's import keeps working unchanged.
//
// THE EXEMPTION IS A LIST BECAUSE THESE ROWS HAVE NO AUTHOR. They arrive with
// migration `0004`, so there is nobody to write the justification a hand-added
// zero states in `source_locator` (see `EXPLICIT_ZERO_PREFIX` in
// `@/server/validation/evaluators/factors`). A silent zero is the failure §0.7
// exists to prevent, so the exemption has to be enumerable and reviewable — and
// the T1.5 suite asserts it BOTH ways: no unlisted zero exists in the set, and
// every listed activity really is zero.
// =============================================================================

/**
 * The activity types of `legacy-v1` whose factor is genuinely `0`.
 *
 *   - `r717` — ammonia, GWP-100 = 0. Not missing data: NH₃ is not a greenhouse
 *     gas, which is precisely why it is the natural-refrigerant recommendation.
 *   - `scope3:s3_c7_bicycle` — commuting by bicycle. Zero direct emissions is
 *     the answer, not the absence of one.
 */
export const EXPLICIT_ZERO_ACTIVITY_TYPES: readonly string[] = [
  "r717",
  "scope3:s3_c7_bicycle",
];
