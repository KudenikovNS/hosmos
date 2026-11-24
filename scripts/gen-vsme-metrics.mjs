#!/usr/bin/env node
/**
 * ONE-OFF GENERATOR — NOT part of the application runtime (plan T1.4, MIG-3).
 *
 * Reads the two source workbooks and emits the COMMITTED
 * `src/server/db/seed-data/vsme-metrics.json` (141 records, every DM-20 column).
 * Neither `seed.ts` nor anything in `src/` ever opens an .xlsx: the JSON is the
 * single source of truth from here on, and this script exists only so the
 * derivation is reproducible and reviewable.
 *
 *   node scripts/gen-vsme-metrics.mjs
 *
 * ── No new dependency ───────────────────────────────────────────────────────
 * An .xlsx is a ZIP of XML. The whole reader below is `node:zlib` +
 * `Buffer` + a deliberately small regex pass over `sharedStrings.xml` and
 * `xl/worksheets/sheetN.xml`. It handles exactly the shapes these two files
 * use (shared strings, inline strings, numeric cells); it is NOT a general
 * xlsx library and must not grow into one.
 *
 * ── Where each DM-20 column comes from ──────────────────────────────────────
 * SOURCE A — `Hosmos_ база метрик VSME.xlsx`
 *   · sheet «VSME аудит» — the BACKBONE: 141 rows, `ID` = VSME-001…141, and the
 *     columns DM-20 maps 1:1 (`Модуль`, `Раскрытие`, `Пункт VSME`,
 *     `Тип требования`, `Показатель / поле`, `Что требуется раскрыть`,
 *     `Условие применимости`).
 *   · sheets «General information» / «Environmental» — the DETAIL rows, source
 *     of `unit` and `guidance`. They cover 94 of the 141 metrics (B1, B2, C1, C2
 *     and B3…B7, C3, C4). The remaining 47 (B8…B11, C5…C9 — the social and
 *     governance metrics) have NO detail row in this workbook at all.
 *
 * SOURCE B — `Hosmos_архитектура платформы.xlsx`, sheet «Все показатели»
 *   · column «Тема» → `pillar` (К-26) — this is the ONLY reason the plan names
 *     this workbook, and the 141 `Standard = VSME` rows of that sheet are, row
 *     for row and in the same order, the backbone above (verified below: the
 *     module and the standard reference of every one of the 141 pairs match).
 *   · column «Indicator / disclosure title (English)» → `title_en` (О-20). It is
 *     populated for all 141 rows, carries no Cyrillic and repeats no title; the
 *     assertions below enforce all three rather than trust them.
 *   · That alignment is also what lets this generator fill `unit` and `guidance`
 *     for the 47 metrics source A leaves blank: columns «Формат / тип данных»
 *     and «Guidance / комментарий…» are populated for all 141. On the 94-row
 *     overlap the guidance texts are byte-identical to source A's and the format
 *     strings agree (source A drops the type prefix: `MWh` vs `Decimal, MWh`),
 *     which the assertions below enforce rather than assume.
 *
 * ── Derivations ─────────────────────────────────────────────────────────────
 * `value_type` and `unit` are both read off ONE format string through the
 * explicit `FORMAT_SPEC` table. There is no fallback and no heuristic: a format
 * string that is not in the table aborts the generator. That is the point — a
 * new workbook revision must be classified by a human, not guessed at.
 *
 * `requirement_type` collapses the workbook's seven wordings onto THREE values
 * (`REQUIREMENT_TYPE`) — spec §4.13 names only `mandatory`/`conditional`, and
 * О-19 adds `voluntary` for the two «Добровольно» wordings. Voluntary is not
 * conditional: a conditional datapoint is owed once its condition holds, a
 * voluntary one never is, and folding them together would leave the Phase-4
 * applicability resolver parsing Russian prose out of `applicability_condition`
 * to tell them apart. That verbatim wording still travels there either way.
 *
 * `title` stays the backbone's Russian «Показатель / поле», exactly as DM-20
 * specifies. `title_en` / `disclosure_title_en` (О-20) carry the standard's own
 * English wording, because the product's locales are `en` and `sl` and the
 * VSME renderer (`report_render.language`, О-14) has no use for a Russian label.
 * `disclosure_title_en` is the English half of the bilingual «Раскрытие»; the
 * split is asserted, not assumed (see `englishHalf`).
 *
 * `breakdown_dimensions` is filled for exactly the metrics the workbook marks
 * «Обязательно / breakdown if obtainable» (B3 §29, the seven energy metrics).
 * Neither workbook NAMES the dimension, so the emitted object carries the
 * verbatim source phrase next to the dimension key this generator assigns.
 */
import { inflateRawSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const WORKBOOKS = path.join(REPO, "workbook", "feedback2");
const METRICS_XLSX = path.join(WORKBOOKS, "Hosmos_ база метрик VSME.xlsx");
const ARCH_XLSX = path.join(WORKBOOKS, "Hosmos_архитектура платформы.xlsx");
const OUT = path.join(REPO, "src/server/db/seed-data/vsme-metrics.json");

// ─── Minimal ZIP reader (central directory → inflateRaw) ─────────────────────
function zipEntries(buf) {
  // End of central directory: scan backwards for the signature (no zip64 here —
  // both workbooks are well under 1 MB with a handful of entries).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file: no end-of-central-directory");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50)
      throw new Error("corrupt central directory entry");
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, { method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, entries, name) {
  const e = entries.get(name);
  if (!e) throw new Error(`zip entry not found: ${name}`);
  const { localOffset: o } = e;
  if (buf.readUInt32LE(o) !== 0x04034b50)
    throw new Error(`corrupt local header for ${name}`);
  const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
  const raw = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return raw.toString("utf8");
  if (e.method === 8) return inflateRawSync(raw).toString("utf8");
  throw new Error(`unsupported zip compression method ${e.method} for ${name}`);
}

// ─── Minimal SpreadsheetML reader ────────────────────────────────────────────
const XML_ENTITY = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};
function unescapeXml(s) {
  return s
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITY[m])
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/** Concatenated `<t>` text of one `<si>` / `<is>` element body. */
function textOf(body) {
  let out = "";
  for (const m of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))
    out += unescapeXml(m[1]);
  return out;
}

function sharedStrings(xml) {
  const out = [];
  for (const m of xml.matchAll(/<si\b[^>]*(?:\/>|>([\s\S]*?)<\/si>)/g))
    out.push(m[1] === undefined ? "" : textOf(m[1]));
  return out;
}

/** `"BC12"` → zero-based column index. */
function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref)[1];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Sheet → array of rows, each a sparse-filled array of strings/undefined. */
function sheetRows(xml, strings) {
  const rows = [];
  for (const rowM of xml.matchAll(/<row\b[^>]*(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const body = rowM[1] ?? "";
    const cells = new Map();
    for (const cM of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cM[1];
      const inner = cM[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs);
      if (!ref) continue;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      let value;
      if (type === "s") {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (v) value = strings[Number(v[1])];
      } else if (type === "inlineStr") {
        const is = /<is>([\s\S]*?)<\/is>/.exec(inner);
        if (is) value = textOf(is[1]);
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (v) value = unescapeXml(v[1]);
      }
      if (value !== undefined) cells.set(columnIndex(ref[1]), value);
    }
    const width = cells.size ? Math.max(...cells.keys()) + 1 : 0;
    rows.push(Array.from({ length: width }, (_, i) => cells.get(i)));
  }
  return rows;
}

/** Open a workbook: `{ sheet(name) → rows }`. */
function openWorkbook(file) {
  const buf = readFileSync(file);
  const entries = zipEntries(buf);
  const strings = entries.has("xl/sharedStrings.xml")
    ? sharedStrings(readEntry(buf, entries, "xl/sharedStrings.xml"))
    : [];
  const rels = new Map();
  for (const m of readEntry(
    buf,
    entries,
    "xl/_rels/workbook.xml.rels",
  ).matchAll(/<Relationship\b[^>]*\/>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) rels.set(id, target);
  }
  const book = readEntry(buf, entries, "xl/workbook.xml");
  const sheets = new Map();
  for (const m of book.matchAll(/<sheet\b[^>]*\/>/g)) {
    const name = unescapeXml(/\bname="([^"]*)"/.exec(m[0])[1]);
    const rid = /\br:id="([^"]+)"/.exec(m[0])[1];
    const target = rels.get(rid).replace(/^\/?(xl\/)?/, "");
    sheets.set(name, `xl/${target}`);
  }
  return (name) => {
    const target = sheets.get(name);
    if (!target)
      throw new Error(
        `sheet "${name}" not found in ${path.basename(file)} (have: ${[...sheets.keys()].join(", ")})`,
      );
    return sheetRows(readEntry(buf, entries, target), strings);
  };
}

// ─── Derivation tables (exhaustive; unknown input aborts) ────────────────────

/**
 * Workbook format string → one of the 12 `DataType` (src/shared/enums/quality.ts)
 * plus the `unit`, which is the physical unit named inside that same string and
 * NULL when the format names none. Both workbooks are covered: source A drops
 * the type prefix source B carries (`MWh` / `Decimal, MWh`), so both spellings
 * appear here and must resolve identically.
 *
 * Judgement calls worth knowing about (all of them collapse a composite
 * workbook format onto the single value column DM-19 allows):
 *   · `Boolean + …`, `Yes/No (+ specify)` → `boolean`; the free text that comes
 *     with the flag is a second datapoint the catalogue does not model.
 *   · `Integer or FTE`, `Integer / decimal` → `decimal`; head counts are stated
 *     in FTE and FTE is fractional, so `integer` would truncate real answers.
 *   · `Currency/range` → `text`: a range is not a scalar amount.
 *   · every `Table…` / `Relation…` → `multi_reference`; DM-19 puts these in
 *     `value_json` as a list of related rows.
 */
const FORMAT_SPEC = {
  // numeric
  Decimal: { valueType: "decimal", unit: null },
  "Decimal, EUR": { valueType: "decimal", unit: "EUR" },
  EUR: { valueType: "decimal", unit: "EUR" },
  "Decimal, currency": { valueType: "decimal", unit: "currency" },
  "Decimal, MWh": { valueType: "decimal", unit: "MWh" },
  MWh: { valueType: "decimal", unit: "MWh" },
  "Decimal, tCO2e": { valueType: "decimal", unit: "tCO2e" },
  tCO2e: { valueType: "decimal", unit: "tCO2e" },
  "Decimal, tCO2e/EUR": { valueType: "decimal", unit: "tCO2e/EUR" },
  "tCO2e/EUR": { valueType: "decimal", unit: "tCO2e/EUR" },
  "Decimal, ha": { valueType: "decimal", unit: "ha" },
  "Decimal, m3": { valueType: "decimal", unit: "m3" },
  "Decimal, hours": { valueType: "decimal", unit: "hours" },
  "Decimal, mass unit": { valueType: "decimal", unit: "mass unit" },
  "Integer / decimal": { valueType: "decimal", unit: null },
  "Integer or FTE": { valueType: "decimal", unit: "FTE" },
  Rate: { valueType: "decimal", unit: null },
  Ratio: { valueType: "decimal", unit: null },
  Integer: { valueType: "integer", unit: null },
  Year: { valueType: "integer", unit: null },
  Percentage: { valueType: "percentage", unit: "%" },
  "Ratio / percentage": { valueType: "percentage", unit: "%" },
  // boolean (composites keep only the flag — see the note above)
  Boolean: { valueType: "boolean", unit: null },
  "Yes/No": { valueType: "boolean", unit: null },
  "Yes/No (+ specify)": { valueType: "boolean", unit: null },
  "Boolean + long text": { valueType: "boolean", unit: null },
  "Boolean + long text / URL": { valueType: "boolean", unit: null },
  "Boolean + date": { valueType: "boolean", unit: null },
  // date
  Date: { valueType: "date", unit: null },
  // enumerations
  Enum: { valueType: "enum", unit: null },
  "Enum / text": { valueType: "enum", unit: null },
  "High/Medium/Low": { valueType: "enum", unit: null },
  "Multi-select + text": { valueType: "multi_enum", unit: null },
  "Code / multi-select": { valueType: "multi_enum", unit: null },
  // short strings
  Text: { valueType: "string", unit: null },
  "Text / decimal": { valueType: "string", unit: null },
  "Text / relation": { valueType: "string", unit: null },
  "Country code": { valueType: "string", unit: null },
  "Latitude / longitude": { valueType: "string", unit: null },
  URL: { valueType: "string", unit: null },
  // long / narrative text
  "Text / address": { valueType: "text", unit: null },
  "Long text": { valueType: "text", unit: null },
  "Long text / score": { valueType: "text", unit: null },
  "Long text / table": { valueType: "text", unit: null },
  "Long text / relation": { valueType: "text", unit: null },
  "Document / long text": { valueType: "text", unit: null },
  "Currency/range": { valueType: "text", unit: null },
  // repeated related rows → value_json (DM-19)
  Table: { valueType: "multi_reference", unit: null },
  "Table / address": { valueType: "multi_reference", unit: null },
  "Table: pollutant, amount, unit": {
    valueType: "multi_reference",
    unit: null,
  },
  "Relation / table": { valueType: "multi_reference", unit: null },
};

/** «Тип требования» → `mandatory` / `conditional` / `voluntary` (DM-20 + О-19). */
const REQUIREMENT_TYPE = {
  Обязательно: "mandatory",
  "Обязательно в Comprehensive": "mandatory",
  "Обязательно / breakdown if obtainable": "mandatory",
  "Обязательно / условно": "conditional",
  Условно: "conditional",
  Добровольно: "voluntary",
  "Добровольно / если релевантно": "voluntary",
};

/** The one «Тип требования» wording that means "report a breakdown if you can". */
const BREAKDOWN_REQUIREMENT = "Обязательно / breakdown if obtainable";

/**
 * The dimension key emitted for the breakdown metrics. All seven are B3 §29
 * energy metrics, and VSME §29 asks for energy consumption broken down BY
 * SOURCE. Neither workbook writes the dimension down, so this key is named here
 * — and the phrase it is named from travels with it in `source`.
 */
const BREAKDOWN_DIMENSION = "energy_source";

const PILLAR = {
  General: "general",
  Environmental: "environmental",
  Social: "social",
  Governance: "governance",
};

const MODULE = { Basic: "basic", Comprehensive: "comprehensive" };

// ─── Helpers ─────────────────────────────────────────────────────────────────
const fail = (msg) => {
  throw new Error(msg);
};
/** Trim and collapse every whitespace run (the sheets carry stray \n and NBSP). */
const norm = (v) =>
  v === undefined || v === null
    ? null
    : String(v).replace(/\s+/gu, " ").trim() || null;

/** Any character in the Cyrillic or Cyrillic-Supplement blocks. */
const CYRILLIC = /[Ѐ-ӿԀ-ԯ]/u;

/**
 * The English half of a bilingual «Раскрытие» cell (О-20).
 *
 * Every one of the 21 distinct cells is `«<code> <русское название> / <English
 * name>»` and contains EXACTLY ONE " / " separator, so the split is a single
 * unambiguous cut — not a heuristic. Both facts are checked here, and so is the
 * result being Cyrillic-free, because the failure mode this guards against is a
 * workbook revision that quietly drops the English half and leaves the renderer
 * printing Russian into an `en` report.
 */
function englishHalf(raw, where) {
  const value = norm(raw) ?? fail(`${where}: empty «Раскрытие»`);
  const parts = value.split(" / ");
  if (parts.length !== 2)
    fail(
      `${where}: «Раскрытие» ${JSON.stringify(value)} has ${parts.length - 1} ` +
        `" / " separators, expected exactly 1 — the bilingual split О-20 relies ` +
        `on is no longer unambiguous`,
    );
  const en = parts[1].trim();
  if (!en || CYRILLIC.test(en))
    fail(
      `${where}: the English half of ${JSON.stringify(value)} is empty or still ` +
        `Cyrillic (${JSON.stringify(en)})`,
    );
  return en;
}

function lookupFormat(format, where) {
  const spec = FORMAT_SPEC[format];
  if (!spec)
    fail(
      `unknown format string ${JSON.stringify(format)} (${where}). Add it to ` +
        `FORMAT_SPEC with a deliberate DataType — this generator never guesses.`,
    );
  return spec;
}

// ─── Read the backbone ───────────────────────────────────────────────────────
const metricsBook = openWorkbook(METRICS_XLSX);
const auditRows = metricsBook("VSME аудит");
const auditHeader = auditRows[0].map(norm);
const EXPECTED_AUDIT_HEADER = [
  "ID",
  "Модуль",
  "Раскрытие",
  "Пункт VSME",
  "Тип требования",
  "Показатель / поле",
  "Что требуется раскрыть",
  "Условие применимости",
];
EXPECTED_AUDIT_HEADER.forEach((want, i) => {
  if (auditHeader[i] !== want)
    fail(`«VSME аудит» column ${i} is ${auditHeader[i]}, expected ${want}`);
});
const backbone = auditRows.slice(1).filter((r) => norm(r[0]));

// ─── Read the detail sheets (unit + guidance for 94 of the 141) ──────────────
/**
 * The detail sheets do not carry the metric ID and their «Показатель» is often
 * the English name where the backbone uses Russian, so a join on the title
 * matches only half the rows. What DOES hold exactly is the grouping: within one
 * (disclosure code, paragraph) both sheets list the same metrics in the same
 * order, and the group sizes match everywhere. The join is therefore positional
 * inside the group, and a size mismatch aborts.
 */
const disclosureCodeOf = (raw) =>
  /^([BC]\d{1,2})\b/.exec(norm(raw) ?? "")?.[1] ??
  fail(`cannot read a disclosure code out of ${JSON.stringify(raw)}`);

function pushInto(map, key, value) {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

const detail = new Map(); // metric_key → { format, guidance, sheet }
function attachDetail(sheetName, rows, formatCol, guidanceCol) {
  const groups = new Map();
  for (const [i, r] of backbone.entries())
    pushInto(groups, `${disclosureCodeOf(r[2])}|${norm(r[3])}`, i);
  const detailGroups = new Map();
  for (const r of rows.slice(1)) {
    if (!norm(r[1]) || !norm(r[4])) continue;
    pushInto(detailGroups, `${disclosureCodeOf(r[1])}|${norm(r[2])}`, r);
  }
  for (const [key, rs] of detailGroups) {
    const idx = groups.get(key);
    if (!idx || idx.length !== rs.length)
      fail(
        `«${sheetName}» group ${key} has ${rs.length} rows, the backbone has ` +
          `${idx ? idx.length : "none"} — the positional join is no longer safe`,
      );
    idx.forEach((i, k) =>
      detail.set(norm(backbone[i][0]), {
        sheet: sheetName,
        format: norm(rs[k][formatCol]),
        guidance: norm(rs[k][guidanceCol]),
      }),
    );
  }
}
attachDetail(
  "General information",
  metricsBook("General information"),
  6, // «Формат / единица»
  13, // «Guidance по заполнению показателя»
);
attachDetail(
  "Environmental",
  metricsBook("Environmental"),
  6, // «Единица измерения»
  12, // «Guidance по заполнению показателя»
);

// ─── Read the full-catalogue sheet (pillar, К-26) ────────────────────────────
const archRows = openWorkbook(ARCH_XLSX)("Все показатели");
const archHeader = archRows[1].map(norm);
const A = {
  pillar: archHeader.indexOf("Тема"),
  standard: archHeader.indexOf("Standard"),
  module: archHeader.indexOf("Module / topic standard"),
  reference: archHeader.indexOf("Отсылка к стандарту"),
  titleEn: archHeader.indexOf("Indicator / disclosure title (English)"),
  format: archHeader.indexOf("Формат / тип данных"),
  guidance: archHeader.findIndex((h) => h?.startsWith("Guidance")),
};
for (const [name, i] of Object.entries(A))
  if (i < 0) fail(`«Все показатели»: column for "${name}" not found`);
const arch = archRows.slice(2).filter((r) => norm(r[A.standard]) === "VSME");

if (arch.length !== backbone.length)
  fail(
    `«Все показатели» holds ${arch.length} VSME rows, «VSME аудит» holds ` +
      `${backbone.length} — the row-for-row alignment К-26 relies on is broken`,
  );

// ─── Build ───────────────────────────────────────────────────────────────────
const records = [];
const notes = [];
for (const [i, row] of backbone.entries()) {
  const a = arch[i];
  const metricKey = norm(row[0]);
  const order = /^VSME-(\d{3})$/.exec(metricKey ?? "");
  if (!order) fail(`unexpected metric id ${JSON.stringify(row[0])}`);
  if (Number(order[1]) !== i + 1)
    fail(`metric ids are not dense: row ${i + 1} carries ${metricKey}`);

  // Prove the two workbooks really are describing the same metric before
  // borrowing `pillar` (and the fallbacks) from the second one.
  const moduleSrc = norm(row[1]);
  if (norm(a[A.module]) !== moduleSrc)
    fail(
      `${metricKey}: module «${moduleSrc}» (audit) vs «${norm(a[A.module])}» (arch)`,
    );
  if (norm(a[A.reference]) !== norm(row[3]))
    fail(
      `${metricKey}: paragraph «${norm(row[3])}» (audit) vs ` +
        `«${norm(a[A.reference])}» (arch) — the workbooks are out of step`,
    );

  const pillar =
    PILLAR[norm(a[A.pillar])] ??
    fail(`${metricKey}: unknown «Тема» ${JSON.stringify(a[A.pillar])}`);
  const moduleName =
    MODULE[moduleSrc] ??
    fail(`${metricKey}: unknown «Модуль» ${JSON.stringify(row[1])}`);
  const requirementSrc = norm(row[4]);
  const requirementType =
    REQUIREMENT_TYPE[requirementSrc] ??
    fail(`${metricKey}: unknown «Тип требования» ${JSON.stringify(row[4])}`);

  const d = detail.get(metricKey);
  const archFormat = norm(a[A.format]);
  const archSpec = lookupFormat(archFormat, `${metricKey}, «Все показатели»`);
  let spec = archSpec;
  if (d?.format) {
    const detailSpec = lookupFormat(d.format, `${metricKey}, «${d.sheet}»`);
    if (
      detailSpec.valueType !== archSpec.valueType ||
      detailSpec.unit !== archSpec.unit
    )
      fail(
        `${metricKey}: «${d.sheet}» says ${JSON.stringify(d.format)} but ` +
          `«Все показатели» says ${JSON.stringify(archFormat)} and they do not ` +
          `resolve to the same value_type/unit`,
      );
    spec = detailSpec; // identical by the check above; keep source A as stated
  } else {
    notes.push([metricKey, "unit/value_type"]);
  }

  const guidance = d?.guidance ?? norm(a[A.guidance]);
  if (!d?.guidance) notes.push([metricKey, "guidance"]);

  const disclosureCode = disclosureCodeOf(row[2]);
  const disclosureTitle =
    norm(String(row[2]).replace(/^[BC]\d{1,2}\s*[—–-]?\s*/u, "")) ??
    fail(`${metricKey}: empty disclosure title`);

  // О-20 — the standard's own English wording, next to (never instead of) the
  // Russian DM-20 names. Cyrillic here would mean an `en` report printing a
  // Russian label, so it aborts the generator.
  const titleEn =
    norm(a[A.titleEn]) ??
    fail(
      `${metricKey}: «Indicator / disclosure title (English)» is empty — О-20 ` +
        `needs it for every one of the 141 rows`,
    );
  if (CYRILLIC.test(titleEn))
    fail(`${metricKey}: title_en is not English: ${JSON.stringify(titleEn)}`);

  records.push({
    metric_key: metricKey,
    standard: "vsme",
    pillar,
    module: moduleName,
    disclosure_code: disclosureCode,
    disclosure_title: disclosureTitle,
    disclosure_title_en: englishHalf(row[2], metricKey),
    paragraph: norm(row[3]),
    requirement_type: requirementType,
    title: norm(row[5]) ?? fail(`${metricKey}: empty «Показатель / поле»`),
    title_en: titleEn,
    description: norm(row[6]),
    unit: spec.unit,
    applicability_condition: norm(row[7]),
    value_type: spec.valueType,
    breakdown_dimensions:
      requirementSrc === BREAKDOWN_REQUIREMENT
        ? {
            if_obtainable: true,
            dimensions: [BREAKDOWN_DIMENSION],
            source: `«Тип требования»: ${requirementSrc}`,
          }
        : null,
    guidance,
    sort_order: Number(order[1]),
    is_active: true,
  });
}

// ─── Post-checks (the same invariants the acceptance test restates) ──────────
const check = (ok, msg) => {
  if (!ok) fail(`post-check failed: ${msg}`);
};
check(records.length === 141, `expected 141 records, built ${records.length}`);
const byModule = (m) => records.filter((r) => r.module === m).length;
check(byModule("basic") === 70, `basic=${byModule("basic")}, expected 70`);
check(
  byModule("comprehensive") === 71,
  `comprehensive=${byModule("comprehensive")}, expected 71`,
);
check(
  new Set(records.map((r) => r.metric_key)).size === 141,
  "metric_key is not unique",
);
const titlePerCode = new Map();
for (const r of records) {
  for (const field of ["disclosure_title", "disclosure_title_en"]) {
    const key = `${r.disclosure_code}|${field}`;
    const seen = titlePerCode.get(key);
    if (seen && seen !== r[field])
      fail(
        `${r.disclosure_code} carries two ${field}s: ${JSON.stringify(seen)} ` +
          `and ${JSON.stringify(r[field])}`,
      );
    titlePerCode.set(key, r[field]);
  }
}
const codes = [...new Set(records.map((r) => r.disclosure_code))].sort();
const expectedCodes = [
  ...Array.from({ length: 11 }, (_, i) => `B${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `C${i + 1}`),
].sort();
check(
  codes.join(",") === expectedCodes.join(","),
  `disclosure codes ${codes.join(",")} ≠ B1…B11 + C1…C9`,
);

// О-19: the split across the three requirement types is pinned, so that a
// regeneration cannot silently reshuffle it (the same numbers are restated in
// `metric-catalog.integration.test.ts`).
const byRequirement = (t) =>
  records.filter((r) => r.requirement_type === t).length;
for (const [type, want] of [
  ["mandatory", 44],
  ["conditional", 72],
  ["voluntary", 25],
])
  check(
    byRequirement(type) === want,
    `requirement_type ${type}=${byRequirement(type)}, expected ${want}`,
  );

// О-20: every row is renderable in English.
const noEnglish = records.filter(
  (r) => !r.title_en || !r.disclosure_title_en,
).length;
check(noEnglish === 0, `${noEnglish} records carry no English title`);
const cyrillicEnglish = records
  .filter(
    (r) => CYRILLIC.test(r.title_en) || CYRILLIC.test(r.disclosure_title_en),
  )
  .map((r) => r.metric_key);
check(
  cyrillicEnglish.length === 0,
  `Cyrillic in an *_en column: ${cyrillicEnglish.join(", ")}`,
);

writeFileSync(OUT, `${JSON.stringify(records, null, 2)}\n`, "utf8");
// Hand the result to the repo's own formatter so a regeneration produces a
// byte-identical file and never shows up as diff noise (`format:check`).
execFileSync(path.join(REPO, "node_modules/.bin/prettier"), ["--write", OUT], {
  cwd: REPO,
  stdio: "ignore",
});

// ─── Report ──────────────────────────────────────────────────────────────────
const tally = (key) =>
  [
    ...records.reduce(
      (m, r) => m.set(r[key], (m.get(r[key]) ?? 0) + 1),
      new Map(),
    ),
  ]
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
console.log(`wrote ${path.relative(REPO, OUT)} — ${records.length} metrics`);
console.log(`  module:           ${tally("module")}`);
console.log(`  pillar:           ${tally("pillar")}`);
console.log(`  requirement_type: ${tally("requirement_type")}`);
console.log(`  value_type:       ${tally("value_type")}`);
console.log(
  `  breakdown_dimensions on ${records.filter((r) => r.breakdown_dimensions).length}: ` +
    records
      .filter((r) => r.breakdown_dimensions)
      .map((r) => r.metric_key)
      .join(", "),
);
const missing = records.filter((r) => !r.guidance).map((r) => r.metric_key);
console.log(
  `  metrics with no guidance: ${missing.length ? missing.join(", ") : "none"}`,
);
console.log(`  detail-sheet coverage: ${detail.size}/${records.length}`);
const fallbacks = new Map();
for (const [key, field] of notes) pushInto(fallbacks, field, key);
for (const [field, keys] of fallbacks)
  console.log(
    `  ${field} filled from «Все показатели» for ${keys.length}: ${keys.join(", ")}`,
  );
