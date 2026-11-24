/**
 * Партия 24 — the browser's copy of EV-0's allowlist must equal the server's.
 *
 * The client refuses an unsupported file before sending it, which is only safe
 * while the two lists agree: a client list that is SHORTER refuses an upload the
 * server would have taken, and a LONGER one promises a type the server rejects —
 * back to the unexplained «check the field file» this batch came from.
 */
import { describe, expect, it, vi } from "vitest";

// `documents.ts` is server-only by import; the allowlist inside it is a plain
// constant, and this file reads nothing else from it.
vi.mock("server-only", () => ({}));

import { ALLOWED_UPLOAD_TYPES } from "../documents";

import {
  ACCEPTED_EXTENSIONS,
  ACCEPT_ATTRIBUTE,
  ACCEPTED_LABEL,
  isAcceptedFileName,
} from "@/shared/evidence/accepted-files";

describe("the accepted file types", () => {
  it("are exactly the server's", () => {
    const server = ALLOWED_UPLOAD_TYPES.flatMap((type) => type.extensions);
    expect([...ACCEPTED_EXTENSIONS].sort()).toEqual([...server].sort());
  });

  it("are offered to the picker in the attribute it understands", () => {
    expect(ACCEPT_ATTRIBUTE.split(",")).toEqual([...ACCEPTED_EXTENSIONS]);
    // The label is for a human: «.jpg» and «.jpeg» are one format to read.
    for (const format of ["pdf", "xlsx", "xls", "csv", "png", "jpg"])
      expect(ACCEPTED_LABEL.toLowerCase()).toContain(format);
  });

  it("accept the real thing, in any case, with spaces around it", () => {
    for (const name of [
      "racun.pdf",
      "RAČUN.PDF",
      " Poraba 2024.xlsx ",
      "meritve.csv",
      "stevec.JPG",
      "stevec.jpeg",
      "slika.png",
    ])
      expect(isAcceptedFileName(name), name).toBe(true);
  });

  it("refuse what the owner actually tried: Word and a phone photo", () => {
    for (const name of [
      "politika.docx",
      "politika.doc",
      "IMG_0421.HEIC",
      "skica.webp",
      "arhiv.zip",
      "racun.pdf.exe",
      "brez-koncnice",
    ])
      expect(isAcceptedFileName(name), name).toBe(false);
  });
});
