#!/usr/bin/env node
/**
 * ONE-OFF GENERATOR — the simplified-ESRS extension of the metric catalogue.
 *
 * Reads the ESG expert's checklist `HOSMOS_VSME_and__ESRS_чеклист.xlsx`
 * (sheet «чеклист», 191 rows: 141 VSME datapoints — each mapped to the
 * simplified ESRS — plus 50 datapoints the simplified ESRS asks for and VSME
 * does not) and emits TWO committed JSON files plus ONE migration:
 *
 *   src/server/db/seed-data/vsme-metrics.esrs.json   metric_key → the five new
 *                                                     columns for the 141 rows
 *   src/server/db/seed-data/esrs-metrics.json        the 50 ESRS-only rows
 *   drizzle/0019_metric_catalog_esrs.sql             ALTER + UPDATE + INSERT
 *
 *   npx tsx scripts/gen-esrs-catalogue.mjs
 *
 * Matching the 141 VSME rows to the catalogue is by DISCLOSURE CODE + the
 * Russian datapoint title (`metric_catalog.title`, the workbook's own wording)
 * — verified exact for 141/141 on 06.09.2026; anything else aborts.
 * The xlsx reader is `xlsx-lite` below: zip + shared strings, same shape as
 * `gen-vsme-metrics.mjs`, and must not grow into a general library.
 */
import { inflateRawSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const XLSX = path.join(
  REPO,
  "workbook/feedback4/HOSMOS_VSME_and__ESRS_чеклист.xlsx",
);
const CATALOGUE = path.join(REPO, "src/server/db/seed-data/vsme-metrics.json");
const OUT_VSME = path.join(
  REPO,
  "src/server/db/seed-data/vsme-metrics.esrs.json",
);
const OUT_ESRS = path.join(REPO, "src/server/db/seed-data/esrs-metrics.json");
const OUT_SQL = path.join(REPO, "drizzle/0019_metric_catalog_esrs.sql");

// ── xlsx-lite ────────────────────────────────────────────────────────────────
function zipEntries(buf) {
  const entries = new Map();
  let i = buf.indexOf(Buffer.from("PK\x01\x02"));
  while (i !== -1 && i < buf.length) {
    const compressed = buf.readUInt32LE(i + 20);
    const nameLen = buf.readUInt16LE(i + 28);
    const extraLen = buf.readUInt16LE(i + 30);
    const commentLen = buf.readUInt16LE(i + 32);
    const localOffset = buf.readUInt32LE(i + 42);
    const name = buf.toString("utf8", i + 46, i + 46 + nameLen);
    const method = buf.readUInt16LE(i + 10);
    entries.set(name, { compressed, localOffset, method });
    i += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(i) !== 0x02014b50) break;
  }
  return entries;
}
function readEntry(buf, entries, name) {
  const e = entries.get(name);
  if (!e) throw new Error(`zip entry ${name} missing`);
  const nameLen = buf.readUInt16LE(e.localOffset + 26);
  const extraLen = buf.readUInt16LE(e.localOffset + 28);
  const start = e.localOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.compressed);
  return (e.method === 8 ? inflateRawSync(data) : data).toString("utf8");
}
const unescape = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
function sheetRows(file, sheetName) {
  const buf = readFileSync(file);
  const entries = zipEntries(buf);
  const shared = [
    ...readEntry(buf, entries, "xl/sharedStrings.xml").matchAll(
      /<si>([\s\S]*?)<\/si>/g,
    ),
  ].map((m) =>
    unescape(
      [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""),
    ),
  );
  const book = readEntry(buf, entries, "xl/workbook.xml");
  const rels = readEntry(buf, entries, "xl/_rels/workbook.xml.rels");
  const sheet = [
    ...book.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g),
  ].find((m) => m[1] === sheetName);
  if (!sheet) throw new Error(`sheet ${sheetName} not found`);
  const target =
    rels.match(new RegExp(`Id="${sheet[2]}"[^>]*Target="([^"]+)"`))?.[1] ??
    rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${sheet[2]}"`))[1];
  const xml = readEntry(
    buf,
    entries,
    "xl/" + target.replace(/^\/?xl\//, "").replace(/^\//, ""),
  );
  const rows = [];
  for (const r of xml.matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const c of r[1].matchAll(
      /<c r="([A-Z]+)\d+"(?: [^>]*?t="([a-z]+)")?[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const col =
        c[1].split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const body = c[3] ?? "";
      let value = null;
      if (c[2] === "s")
        value = shared[Number(body.match(/<v>(\d+)<\/v>/)?.[1])] ?? null;
      else if (c[2] === "inlineStr")
        value = unescape(
          [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
            .map((t) => t[1])
            .join(""),
        );
      else {
        const v = body.match(/<v>([\s\S]*?)<\/v>/);
        value = v ? unescape(v[1]) : null;
      }
      row[col] = value;
    }
    rows.push(row);
  }
  return rows;
}

// ── read ─────────────────────────────────────────────────────────────────────
const rows = sheetRows(XLSX, "чеклист");
const header = rows[1];
const COL = Object.fromEntries(
  [
    "Стандарт",
    "ESG",
    "Тема",
    "VSME reference",
    "упрощенный ESRS",
    "Требование стандарта",
    "Datapoint / показатель",
    "Единица / формат",
    "Applicability VSME",
    "Applicability упрощенный ESRS",
    "Наличие в HOSMOS",
    "Где находится",
    "Что уже собирается",
    "Gap",
    "Необходимая доработка",
    "Источник данных клиента",
    "Регуляторный статус 21.08.2026",
    "Официальный источник",
  ].map((h) => {
    const i = header.findIndex((x) => x && x.trim() === h);
    if (i === -1) throw new Error(`column «${h}» not found`);
    return [h, i];
  }),
);
const data = rows
  .slice(2)
  .filter((r) => r.some((c) => c !== null && c !== undefined && c !== ""));
const cell = (r, h) => {
  const v = r[COL[h]];
  return v === undefined || v === null ? "" : String(v).trim();
};
const norm = (s) =>
  s
    .replace(/[\s\-–—]+/g, " ")
    .trim()
    .toLowerCase();

const catalogue = JSON.parse(readFileSync(CATALOGUE, "utf8"));
const byTitle = new Map();
for (const m of catalogue) {
  const k = `${m.disclosure_code}|${norm(m.title)}`;
  if (byTitle.has(k)) throw new Error(`catalogue title not unique: ${k}`);
  byTitle.set(k, m);
}

// ── 141 VSME rows → the five new columns ────────────────────────────────────
const vsmeExt = {};
const esrsOnly = [];
const nullable = (s) => (s === "" || s === "-" ? null : s);
for (const r of data) {
  const standard = cell(r, "Стандарт");
  if (standard === "упрощенный ESRS") {
    esrsOnly.push(r);
    continue;
  }
  const code = cell(r, "VSME reference").match(/^([BC]\d+)/)?.[1];
  const m = byTitle.get(`${code}|${norm(cell(r, "Datapoint / показатель"))}`);
  if (!m)
    throw new Error(
      `no catalogue row for ${cell(r, "VSME reference")} «${cell(r, "Datapoint / показатель")}»`,
    );
  if (vsmeExt[m.metric_key])
    throw new Error(`duplicate checklist row for ${m.metric_key}`);
  vsmeExt[m.metric_key] = {
    esrs_reference: nullable(cell(r, "упрощенный ESRS")),
    esrs_applicability: nullable(cell(r, "Applicability упрощенный ESRS")),
    client_data_source: nullable(cell(r, "Источник данных клиента")),
    regulatory_status: nullable(cell(r, "Регуляторный статус 21.08.2026")),
    official_source: nullable(cell(r, "Официальный источник")),
  };
}
if (Object.keys(vsmeExt).length !== catalogue.length)
  throw new Error(
    `matched ${Object.keys(vsmeExt).length} of ${catalogue.length}`,
  );

// ── 50 ESRS-only rows → catalogue records ───────────────────────────────────
const PILLAR = { E: "environmental", S: "social", G: "governance" };
function valueType(unit) {
  const u = unit.toLowerCase();
  if (/^(count|%|count \/ %|days|kg|t|tco2e)/.test(u)) return "decimal";
  return "text"; // narrative, metric-dependent, structured index …
}
function requirement(applicability) {
  return /^mandatory$/i.test(applicability) ? "mandatory" : "conditional";
}
let sort = Math.max(...catalogue.map((m) => m.sort_order));
const esrsMetrics = esrsOnly.map((r, index) => {
  const ref = cell(r, "упрощенный ESRS"); // e.g. "ESRS E1-4", "ESRS GOV-2"
  const theme = cell(r, "Тема"); // "ESRS E1 - Climate policies"
  const [themeCode, ...rest] = theme.split(" - ");
  const drCode = ref.replace(/^ESRS\s+/, "");
  sort += 1;
  return {
    metric_key: `ESRS-${String(index + 1).padStart(3, "0")}`,
    standard: "esrs",
    pillar: PILLAR[cell(r, "ESG")],
    module: "simplified_esrs",
    disclosure_code: drCode,
    disclosure_title: theme,
    disclosure_title_en: `${themeCode.trim()} — ${rest.join(" - ").trim()}`,
    paragraph: null,
    requirement_type: requirement(cell(r, "Applicability упрощенный ESRS")),
    title: cell(r, "Datapoint / показатель"),
    title_en: cell(r, "Требование стандарта"),
    description: cell(r, "Datapoint / показатель"),
    unit: nullable(cell(r, "Единица / формат")),
    applicability_condition: nullable(cell(r, "Applicability упрощенный ESRS")),
    value_type: valueType(cell(r, "Единица / формат")),
    breakdown_dimensions: null,
    guidance: null,
    sort_order: sort,
    is_active: true,
    esrs_reference: nullable(ref),
    esrs_applicability: nullable(cell(r, "Applicability упрощенный ESRS")),
    client_data_source: nullable(cell(r, "Источник данных клиента")),
    regulatory_status: nullable(cell(r, "Регуляторный статус 21.08.2026")),
    official_source: nullable(cell(r, "Официальный источник")),
  };
});
if (esrsMetrics.length !== 50)
  throw new Error(`expected 50 ESRS-only rows, got ${esrsMetrics.length}`);

writeFileSync(OUT_VSME, JSON.stringify(vsmeExt, null, 2) + "\n");
writeFileSync(OUT_ESRS, JSON.stringify(esrsMetrics, null, 2) + "\n");

// ── migration ────────────────────────────────────────────────────────────────
const q = (v) =>
  v === null || v === undefined
    ? "NULL"
    : typeof v === "boolean"
      ? String(v)
      : typeof v === "number"
        ? String(v)
        : `'${String(v).replace(/'/g, "''")}'`;
const NEW_COLS = [
  "esrs_reference",
  "esrs_applicability",
  "client_data_source",
  "regulatory_status",
  "official_source",
];
const updateRows = Object.entries(vsmeExt)
  .map(
    ([key, v]) => `  (${q(key)}, ${NEW_COLS.map((c) => q(v[c])).join(", ")})`,
  )
  .join(",\n");
const INSERT_COLS = [
  "metric_key",
  "standard",
  "pillar",
  "module",
  "disclosure_code",
  "disclosure_title",
  "disclosure_title_en",
  "paragraph",
  "requirement_type",
  "title",
  "title_en",
  "description",
  "unit",
  "applicability_condition",
  "value_type",
  "breakdown_dimensions",
  "guidance",
  "sort_order",
  "is_active",
  ...NEW_COLS,
];
const insertRows = esrsMetrics
  .map(
    (m) =>
      `  (${INSERT_COLS.map((c) => (c === "breakdown_dimensions" ? "NULL" : q(m[c]))).join(", ")})`,
  )
  .join(",\n");
const sql = `-- 0019_metric_catalog_esrs.sql — THE CATALOGUE LEARNS THE SIMPLIFIED ESRS.
--
-- GENERATED by \`scripts/gen-esrs-catalogue.mjs\` from the ESG expert's
-- checklist «HOSMOS_VSME_and__ESRS_чеклист.xlsx» (06.09.2026). DO NOT EDIT BY
-- HAND — rerun the generator; \`esrs-catalogue.test.ts\` proves this file and
-- the two JSON modules agree.
--
-- WHAT. (1) Five nullable columns on \`metric_catalog\`: the simplified-ESRS
-- reference a VSME datapoint also satisfies (\`esrs_reference\`), when the ESRS
-- requires it (\`esrs_applicability\`), where a client usually finds the data
-- (\`client_data_source\`), the regulatory status as of 21.08.2026 and the
-- official source URL. (2) Those columns filled for the 141 VSME rows.
-- (3) 50 NEW rows, \`standard = 'esrs'\`, \`module = 'simplified_esrs'\`, keys
-- ESRS-001…050: what the simplified ESRS (C(2026)5010, adopted 03.07.2026, not
-- yet in force at the checklist's cut-off) asks for and VSME does not.
--
-- READERS. Everything that means "the VSME catalogue" filters
-- \`standard = 'vsme'\` from this migration on (readiness, renderer,
-- \`/api/metrics\` default); the ESRS rows are reachable by asking for them.
--
-- ADDITIVE; PostgreSQL 13. \`ON CONFLICT (metric_key) DO UPDATE\` so a re-run
-- refreshes the rows rather than failing on the primary key.

ALTER TABLE metric_catalog ADD COLUMN IF NOT EXISTS esrs_reference text;
ALTER TABLE metric_catalog ADD COLUMN IF NOT EXISTS esrs_applicability text;
ALTER TABLE metric_catalog ADD COLUMN IF NOT EXISTS client_data_source text;
ALTER TABLE metric_catalog ADD COLUMN IF NOT EXISTS regulatory_status text;
ALTER TABLE metric_catalog ADD COLUMN IF NOT EXISTS official_source text;

UPDATE metric_catalog SET
  esrs_reference = v.esrs_reference,
  esrs_applicability = v.esrs_applicability,
  client_data_source = v.client_data_source,
  regulatory_status = v.regulatory_status,
  official_source = v.official_source
FROM (VALUES
${updateRows}
) AS v(metric_key, ${NEW_COLS.join(", ")})
WHERE metric_catalog.metric_key = v.metric_key;

INSERT INTO metric_catalog (
  ${INSERT_COLS.join(", ")}
) VALUES
${insertRows}
ON CONFLICT (metric_key) DO UPDATE SET
  ${INSERT_COLS.filter((c) => c !== "metric_key")
    .map((c) => `${c} = excluded.${c}`)
    .join(",\n  ")};
`;
writeFileSync(OUT_SQL, sql);
console.log(
  `wrote ${path.relative(REPO, OUT_VSME)} (${Object.keys(vsmeExt).length}), ${path.relative(REPO, OUT_ESRS)} (${esrsMetrics.length}), ${path.relative(REPO, OUT_SQL)}`,
);
