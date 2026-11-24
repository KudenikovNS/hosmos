/**
 * WHICH FILES THE EVIDENCE LIBRARY TAKES (партия 24).
 *
 * EV-0's allowlist lives on the server (`@/server/evidence/documents`), and it
 * decides. This module is the same list in the one form the BROWSER needs: the
 * `accept` attribute of the picker, and a check the panel can run the instant a
 * file is dropped.
 *
 * WHY THE CLIENT CHECKS THE TYPE (and still does not check the SIZE). The
 * picker's `accept` filters what the dialogue offers, and nothing else: a
 * drag-and-drop, or «all files» in the dialogue, brings anything. Before this
 * check, such a file travelled the whole way to the server only to come back as
 * `{field: "file"}` — rendered to the owner as «check the field file», which is
 * the report that prompted this batch. The type is a STATIC list, so a client
 * that reads it can only agree with the server. The size is an ENTITLEMENT,
 * resolved per company and per subscription state, so it stays the server's
 * alone — a client-side size check could refuse an upload the server would take.
 *
 * `documents-allowlist.test.ts` compares this list with the server's, so the two
 * cannot drift.
 */

/** Lowercase suffixes EV-0 accepts, in the order the UI lists them. */
export const ACCEPTED_EXTENSIONS = [
  ".pdf",
  ".xlsx",
  ".xls",
  ".csv",
  ".png",
  ".jpg",
  ".jpeg",
] as const;

/** The `accept` attribute of the file input. */
export const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.join(",");

/** What the user is told they may upload — «PDF, Excel, CSV, PNG, JPG». */
export const ACCEPTED_LABEL = "PDF, XLSX, XLS, CSV, PNG, JPG";

/** Does this file name end in one of the accepted suffixes? */
export function isAcceptedFileName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return ACCEPTED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}
