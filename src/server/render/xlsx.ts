// REN-3 / К-22 — THE VSME BASIC RENDERER, AS A WORKBOOK (T5.7).
//
// See docs/decisions/server-render-xlsx.md for the full account.
import "server-only";

import writeXlsxFile from "write-excel-file/node";

import type { ReportLanguage } from "@/i18n/locales";

import { disclaimerText } from "./disclaimer";
import { renderContext } from "./i18n";
import {
  buildSections,
  sectionsToText,
  type RenderBlock,
  type RenderInput,
  type RenderSection,
} from "./sections";

/** The MIME type of an `.xlsx` file — what the download route sends. */
export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Widths (in characters) of the workbook's columns — label, then values. */
const COLUMN_WIDTHS = [42, 58, 30, 30, 30, 30] as const;

/** How many columns every sheet declares; a table wider than this still works. */
const COLUMN_COUNT = COLUMN_WIDTHS.length;

/** Excel's hard cap on a worksheet name. */
const SHEET_NAME_MAX = 31;

/**
 * The characters Excel refuses in a worksheet name.
 *
 * Not cosmetic: a name containing one of these makes the whole workbook
 * unopenable, and the section headings are TRANSLATED strings — a future
 * heading with a slash in it would break every report of that locale and no
 * other. Sanitising here means a heading is only ever a wording decision.
 */
const SHEET_NAME_FORBIDDEN = /[[\]:*?/\\]/g;

// ─── Cells ───────────────────────────────────────────────────────────────────

/** One cell, in the shape `write-excel-file` takes. */
type Cell = {
  value?: string;
  type?: StringConstructor;
  fontWeight?: "bold";
  fontSize?: number;
  wrap?: boolean;
  columnSpan?: number;
};

/** One row of a worksheet. `null` is Excel's empty cell. */
type Row = (Cell | null)[];

/** A text cell. Empty strings become truly empty cells rather than `""`. */
function text(value: string, style: Omit<Cell, "value" | "type"> = {}): Cell {
  return { value, type: String, ...style };
}

/** A cell spanning the whole sheet width — a heading, a paragraph. */
function wide(value: string, style: Omit<Cell, "value" | "type"> = {}): Cell {
  return text(value, { columnSpan: COLUMN_COUNT, wrap: true, ...style });
}

/** A row of empty cells — the workbook's paragraph break. */
const BLANK: Row = [null];

// ─── Blocks → rows ───────────────────────────────────────────────────────────

/**
 * One block of the document model as worksheet rows.
 *
 * The five kinds map exactly as they do in `vsme-basic.ts`'s `blockContent`,
 * which is the point: a block that gained a kind would fail to compile in BOTH
 * renderers rather than silently vanish from one of them.
 */
function blockRows(block: RenderBlock): Row[] {
  switch (block.kind) {
    case "paragraph":
      return [[wide(block.text)]];
    case "subheading":
      return [[wide(block.text, { fontWeight: "bold" })]];
    case "keyValues":
      return block.rows.map((row) => [
        text(row.label, { fontWeight: "bold", wrap: true }),
        text(row.value, { columnSpan: COLUMN_COUNT - 1, wrap: true }),
      ]);
    case "table":
      return [
        block.columns.map((column) =>
          text(column, { fontWeight: "bold", wrap: true }),
        ),
        ...block.rows.map((row) =>
          row.map((cell) => text(cell, { wrap: true })),
        ),
      ];
    case "list":
      return block.items.map((item) => [wide(item)]);
  }
}

/** Every row of one section: its heading, then its blocks, separated by blanks. */
function sectionRows(section: RenderSection): Row[] {
  const rows: Row[] = [
    [wide(section.heading, { fontWeight: "bold", fontSize: 14 })],
  ];
  for (const block of section.blocks) {
    rows.push(BLANK, ...blockRows(block));
  }
  return rows;
}

/**
 * The worksheet names, sanitised and made unique.
 *
 * Uniqueness is not decoration either — two worksheets with the same name is
 * another unopenable workbook, and truncating eleven translated headings to 31
 * characters is exactly the operation that can produce a collision. The
 * disambiguating suffix is the 1-based index, which is stable for a given
 * locale and section list.
 */
export function sheetNames(sections: readonly RenderSection[]): string[] {
  const used = new Set<string>();
  return sections.map((section, index) => {
    const base =
      section.heading.replace(SHEET_NAME_FORBIDDEN, " ").trim() || section.id;
    let name = base.slice(0, SHEET_NAME_MAX);
    if (used.has(name)) {
      const suffix = ` (${index + 1})`;
      name = `${base.slice(0, SHEET_NAME_MAX - suffix.length)}${suffix}`;
    }
    used.add(name);
    return name;
  });
}

// ─── The render ──────────────────────────────────────────────────────────────

/** A finished workbook: the bytes, plus what T5.7 pins beside them. */
export interface VsmeBasicXlsxRender {
  readonly xlsx: Buffer;
  /** The intermediate model — the same one the PDF was built from. */
  readonly sections: readonly RenderSection[];
  /** The same words as plain text, for the acceptance assertions. */
  readonly text: string;
  /** REN-2a's four points, as `report_render.disclaimer_text` stores them. */
  readonly disclaimerText: string;
  /** О-14 — the language this render IS, echoed back for the row. */
  readonly language: ReportLanguage;
}

/** REN-1/REN-2 end to end, in the second format: an input, a language, a workbook. */
export async function renderVsmeBasicXlsx(
  input: RenderInput,
): Promise<VsmeBasicXlsxRender> {
  const sections = buildSections(input);
  const names = sheetNames(sections);
  const columns = COLUMN_WIDTHS.map((width) => ({ width }));

  const xlsx = await writeXlsxFile(
    sections.map((section, index) => ({
      data: sectionRows(section),
      sheet: names[index],
      columns,
    })),
  ).toBuffer();

  return {
    xlsx,
    sections,
    text: sectionsToText(sections),
    disclaimerText: disclaimerText(
      renderContext(input.language),
      input.coverage,
    ),
    language: input.language,
  };
}
