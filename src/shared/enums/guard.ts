// =============================================================================
// Enum guard factory — the shared shape every list in `shared/enums/` uses.
//
// Every domain list is exported three times over: an `as const` readonly tuple
// (the values), a union type derived from it (`T[number]`), and an `isX()` type
// guard produced here. Writing 29 hand-rolled `includes()` guards would be 29
// chances to typo a list name into the wrong guard; the factory closes over the
// tuple it is given, so guard and list cannot drift apart.
// =============================================================================

/**
 * Builds a type predicate for `values`. Accepts `unknown` (not `string`) on
 * purpose: these guards are the app-level replacement for the CHECK constraints
 * the schema deliberately does not carry (§0.8), so their first job is narrowing
 * unvalidated request payloads, where the field may be absent or non-string.
 */
export function enumGuard<T extends readonly string[]>(
  values: T,
): (value: unknown) => value is T[number] {
  const allowed: ReadonlySet<string> = new Set(values);
  return (value: unknown): value is T[number] =>
    typeof value === "string" && allowed.has(value);
}
