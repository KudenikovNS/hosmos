// =============================================================================
// NACE Rev. 2 — the reference classification VAL-002 checks `nace_code` against.
//
// WHY THIS EXISTS. §6.2 requires VAL-002 to validate country, currency and NACE
// "из актуального справочника". Country and currency already have their lists
// (`COUNTRY_CODES` in `@/shared/constants`, the seeded `currencies` table);
// NACE had none, so `legal_entity.nace_code` was free text that nothing could
// contradict — and a rule that cannot fail is the R-12 problem the validation
// registry exists to prevent.
//
// WHAT IS MODELLED AND WHY ONLY THIS. The 21 SECTIONS (A…U) and the 88
// DIVISIONS they own — the two top levels of NACE Rev. 2 (Regulation (EC) No
// 1893/2006, Annex I; Eurostat RAMON). The lower levels (615 classes) are NOT
// enumerated: they would be ~600 lines of data to reject a two-digit typo that
// the division already rejects, they change more often than the divisions, and
// nothing in Phase 1 branches on a class. The check is therefore
// "well-formed, and the division exists — and belongs to the section, when one
// is written" rather than "is exactly one of the 615 published classes". That
// catches every realistic input error (a made-up section, a division in a gap
// such as 04/34/40, a section/division pair that does not belong together)
// while staying data no one has to maintain.
//
// NACE Rev. 2.1 applies to reference year 2025 onwards and renumbers parts of
// the tree; Phase-1 data (`companies.nace_code`, the DD) is Rev. 2, so Rev. 2
// is what is encoded here. A migration to 2.1 replaces the ranges below and
// nothing else.
// =============================================================================

/** One NACE Rev. 2 section: its letter, the inclusive division range, its title. */
interface NaceSection {
  readonly section: string;
  /** First division of the section (e.g. 10 for C). */
  readonly from: number;
  /** Last division of the section (e.g. 33 for C). */
  readonly to: number;
  readonly title: string;
}

/**
 * The 21 sections, in order, with the divisions each owns. The ranges are
 * contiguous WITHIN a section and leave the published gaps BETWEEN sections
 * (04, 34, 40, 44, 48, 54, 57, 67, 76, 83, 89 are not divisions of anything),
 * so an unknown division falls out of the map for free. Total: 88 divisions.
 */
const NACE_SECTIONS: readonly NaceSection[] = [
  { section: "A", from: 1, to: 3, title: "Agriculture, forestry and fishing" },
  { section: "B", from: 5, to: 9, title: "Mining and quarrying" },
  { section: "C", from: 10, to: 33, title: "Manufacturing" },
  {
    section: "D",
    from: 35,
    to: 35,
    title: "Electricity, gas, steam and air conditioning supply",
  },
  {
    section: "E",
    from: 36,
    to: 39,
    title: "Water supply; sewerage, waste management and remediation",
  },
  { section: "F", from: 41, to: 43, title: "Construction" },
  {
    section: "G",
    from: 45,
    to: 47,
    title: "Wholesale and retail trade; repair of motor vehicles",
  },
  { section: "H", from: 49, to: 53, title: "Transportation and storage" },
  {
    section: "I",
    from: 55,
    to: 56,
    title: "Accommodation and food service activities",
  },
  { section: "J", from: 58, to: 63, title: "Information and communication" },
  {
    section: "K",
    from: 64,
    to: 66,
    title: "Financial and insurance activities",
  },
  { section: "L", from: 68, to: 68, title: "Real estate activities" },
  {
    section: "M",
    from: 69,
    to: 75,
    title: "Professional, scientific and technical activities",
  },
  {
    section: "N",
    from: 77,
    to: 82,
    title: "Administrative and support service activities",
  },
  {
    section: "O",
    from: 84,
    to: 84,
    title: "Public administration and defence; compulsory social security",
  },
  { section: "P", from: 85, to: 85, title: "Education" },
  {
    section: "Q",
    from: 86,
    to: 88,
    title: "Human health and social work activities",
  },
  {
    section: "R",
    from: 90,
    to: 93,
    title: "Arts, entertainment and recreation",
  },
  { section: "S", from: 94, to: 96, title: "Other service activities" },
  {
    section: "T",
    from: 97,
    to: 98,
    title: "Activities of households as employers",
  },
  {
    section: "U",
    from: 99,
    to: 99,
    title: "Activities of extraterritorial organisations and bodies",
  },
];

/** division number → owning section letter (88 entries, built from the ranges). */
const DIVISION_TO_SECTION: ReadonlyMap<number, string> = new Map(
  NACE_SECTIONS.flatMap(({ section, from, to }) =>
    Array.from({ length: to - from + 1 }, (_, i): [number, string] => [
      from + i,
      section,
    ]),
  ),
);

/**
 * `[section?] division [. group[ class ]]` — the shapes the field is written in
 * across the product and the Data Dictionary: `C`, `C25`, `C25.11`, `25.11`,
 * `62.01`. The optional separator after the section letter accepts `C.25`.
 */
const NACE_PATTERN = /^([A-U])?\.?(\d{2})(?:\.(\d{1,2}))?$/;

/**
 * True when `value` is a NACE Rev. 2 code this product recognises.
 *
 * Accepted: a bare section letter; a division, with or without its section
 * letter; a division plus a group/class suffix. Rejected: anything else, a
 * division that does not exist (`04`, `34`, `40`, …), and a section/division
 * pair that contradicts itself (`A25` — division 25 is Manufacturing, section
 * C, not Agriculture). Case and surrounding whitespace are normalised first, so
 * `" c25 "` is the same code as `"C25"`.
 */
export function isNaceCode(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const code = value.replace(/\s+/g, "").toUpperCase();
  if (code === "") return false;
  if (/^[A-U]$/.test(code)) return true;

  const match = NACE_PATTERN.exec(code);
  if (!match) return false;
  const [, section, division] = match;
  const owner = DIVISION_TO_SECTION.get(Number(division));
  if (owner === undefined) return false;
  return section === undefined || section === owner;
}
