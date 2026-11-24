#!/usr/bin/env node
/**
 * ONE-OFF GENERATOR — NOT part of the application runtime.
 *
 * Emits `drizzle/0015_factor_set_si_2025_r2.sql`: factor set `si-2025-r2` =
 * every `emission_factor` row of `si-2025` (read VERBATIM from 0009's VALUES
 * list, re-keyed under the new set code) + the additions in
 * `src/server/db/seed-data/factor-set-si-2025-r2.ts` + the ten set-scoped
 * `unit_conversion` rows of 0010 (re-keyed the same way).
 *
 *   npx tsx scripts/gen-factor-set-si-2025-r2.mjs
 *
 * Reading the applied migrations instead of re-deriving the rows from the
 * workbook is deliberate: 0009 and 0010 already record every judgement (unit
 * codes, `kWh_net`, geography, dates) and the revision must inherit them
 * unchanged. The only new rows are the ones the data module names.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { derivedId } from "../src/server/db/seed-data/derived-id.ts";
import {
  SI_2025_R2,
  SI_2025_R2_ADDITIONS,
  si2025R2FactorId,
} from "../src/server/db/seed-data/factor-set-si-2025-r2.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const M0009 = path.join(REPO, "drizzle/0009_factor_set_si_2025.sql");
const M0010 = path.join(REPO, "drizzle/0010_set_scoped_conversions.sql");
const OUT = path.join(REPO, "drizzle/0015_factor_set_si_2025_r2.sql");

const FACTOR_COLUMNS = [
  "id",
  "factor_set_id",
  "factor_code",
  "factor_name",
  "source_name",
  "source_version",
  "publication_date",
  "applicable_year",
  "geography",
  "activity_type",
  "input_unit",
  "factor_value",
  "output_unit",
  "co2_value",
  "gwp_basis",
  "wtt_included",
  "source_url",
  "source_locator",
  "licence",
  "status",
];

/** Split one `(…)` tuple of SQL literals into raw tokens (quotes kept). */
function splitTuple(body) {
  const out = [];
  let cur = "",
    inStr = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      cur += ch;
      if (ch === "'") {
        if (body[i + 1] === "'") {
          cur += "'";
          i++;
        } else inStr = false;
      }
    } else if (ch === "'") {
      inStr = true;
      cur += ch;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const unq = (tok) =>
  tok === "NULL"
    ? null
    : tok.startsWith("'")
      ? tok.slice(1, -1).replace(/''/g, "'")
      : tok;
const q = (v) =>
  v === null || v === undefined
    ? "NULL"
    : typeof v === "boolean"
      ? String(v)
      : typeof v === "number"
        ? String(v)
        : `'${String(v).replace(/'/g, "''")}'`;

// ── 1. the 23 rows of si-2025, verbatim ─────────────────────────────────────
const sql0009 = readFileSync(M0009, "utf8");
const block = sql0009.slice(sql0009.indexOf("INSERT INTO emission_factor"));
const valuesBlock = block.slice(
  block.indexOf(") VALUES") + ") VALUES".length,
  block.indexOf("\nON CONFLICT"),
);
const tuples = [...valuesBlock.matchAll(/\n\s*\((.*)\)\s*,?\s*$/gm)].map((m) =>
  splitTuple(m[1]),
);
if (tuples.length !== 23)
  throw new Error(`expected 23 si-2025 rows in 0009, parsed ${tuples.length}`);
const carried = tuples.map((toks) => {
  if (toks.length !== FACTOR_COLUMNS.length)
    throw new Error(`tuple has ${toks.length} columns: ${toks[2]}`);
  const row = Object.fromEntries(
    FACTOR_COLUMNS.map((c, i) => [c, unq(toks[i])]),
  );
  row.applicable_year =
    row.applicable_year === null ? null : Number(row.applicable_year);
  row.wtt_included = row.wtt_included === "true";
  return row;
});

// ── 2. the additions ─────────────────────────────────────────────────────────
const added = SI_2025_R2_ADDITIONS.map((r) => ({ ...r }));
const all = [...carried, ...added];

// VAL-031 — unique resolution key inside the set, checked before anything is written.
const keys = new Set();
for (const r of all) {
  const k = [
    r.activity_type,
    r.geography,
    r.input_unit,
    r.applicable_year ?? "any",
  ].join("|");
  if (keys.has(k)) throw new Error(`duplicate resolution key ${k}`);
  keys.add(k);
}

// ── 3. the ten scoped conversions of 0010 ────────────────────────────────────
const sql0010 = readFileSync(M0010, "utf8");
const conv = [
  ...sql0010.matchAll(
    /\n\s*\('([0-9a-f-]{36})',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']*)',\s*'([^']*)'\)/g,
  ),
].map((m) => ({
  from: m[2],
  to: m[3],
  multiplier: m[4],
  context: m[5],
  source: m[6],
  notes: m[7],
}));
if (conv.length !== 10)
  throw new Error(
    `expected 10 scoped conversions in 0010, parsed ${conv.length}`,
  );

// ── 4. render ────────────────────────────────────────────────────────────────
const setId = SI_2025_R2.id;
const factorRows = all.map((r) => {
  const id = si2025R2FactorId(r);
  return (
    "  (" +
    [
      id,
      setId,
      r.factor_code,
      r.factor_name,
      r.source_name,
      r.source_version,
      r.publication_date,
      r.applicable_year,
      r.geography,
      r.activity_type,
      r.input_unit,
      r.factor_value,
      r.output_unit,
      r.co2_value,
      r.gwp_basis,
      r.wtt_included,
      r.source_url,
      r.source_locator,
      r.licence,
      r.status,
    ]
      .map(q)
      .join(", ") +
    ")"
  );
});
const convRows = conv.map((c) => {
  const id = derivedId(
    "unit_conversion",
    c.from,
    c.to,
    c.context,
    SI_2025_R2.code,
  );
  const source = c.source.replace("si-2025", SI_2025_R2.code);
  return (
    "  (" +
    [id, c.from, c.to, c.multiplier, c.context, source, c.notes]
      .map(q)
      .join(", ") +
    ")"
  );
});

const header = `-- 0015_factor_set_si_2025_r2.sql — SLOVENIA 2025, REVISION 2.
--
-- GENERATED by \`scripts/gen-factor-set-si-2025-r2.mjs\` from
-- \`src/server/db/seed-data/factor-set-si-2025-r2.ts\` (the five additions) and
-- the VALUES lists of 0009 (the 23 carried rows) and 0010 (the ten set-scoped
-- natural-gas conversions). DO NOT EDIT BY HAND — rerun the generator.
-- \`factor-set-si-2025-r2.test.ts\` proves this file and the module agree.
--
-- WHY A NEW SET (DM-21). A released factor set is never edited; a correction is
-- a new set. \`si-2025\` (0009) named five workbook rows it could not load
-- because no input form produced their activity type: lignite, coke (ARSO and
-- IPCC) and HFC-125. The literals \`lignite\`, \`coke\`, \`r125\` now exist in
-- \`src/shared/enums/activities.ts\`, and this revision carries the rows. Every
-- other row is 0009's, byte for byte, under a new set id — so a company that
-- burns lignite now gets a Slovenian number instead of \`failed_missing_factor\`,
-- and nothing that priced under \`si-2025\` prices differently here.
--
-- WHAT CHANGES FOR PERIODS. Nothing already created: a period pins its set by id
-- (К-24) and \`si-2025\` stays active and selectable. New periods with no explicit
-- choice pin THIS set, because \`resolveFactorSet\` takes the greatest
-- \`published_at\` among active sets and this one publishes at
-- ${SI_2025_R2.publishedAt.slice(0, 10)}, after 0009's 2026-06-01.
--
-- THE CONVERSIONS TRAVEL WITH THE SET. 0010 bound the ARSO net calorific value
-- to \`si-2025\` (\`unit_conversion.factor_set_id\`); a set without its own copies
-- would resolve Slovenian gas through DEFRA's shared CV again and reopen the
-- 3.69 % disagreement 0010 closed. The ten rows are copied under new ids.
--
-- IDEMPOTENT. \`ON CONFLICT (code) DO NOTHING\` on the set; \`ON CONFLICT DO
-- NOTHING\` on the factors and conversions — every id is a UUIDv5 of the row's
-- natural key under \`seed-data/derived-id.ts\`'s namespace, derived with the
-- same components 0009/0010 used, so a re-run inserts nothing.
--
-- STILL NOT HERE, ON PURPOSE: the 23 United Kingdom fallback rows (0009's
-- reasoning stands), the 45 Scope-3 rows (the engine computes Scope 1/2), and
-- the two litre-denominated mobile rows 27/28 — identical to the SI gas_oil /
-- petrol_mineral litre rows already present and reached through the form.

INSERT INTO factor_set (
  id, code, name, description, status, published_at
) VALUES
  (${q(setId)}, ${q(SI_2025_R2.code)}, ${q(SI_2025_R2.name)}, ${q(SI_2025_R2.description)}, 'active', ${q(SI_2025_R2.publishedAt)})
ON CONFLICT (code) DO NOTHING;

INSERT INTO emission_factor (
  ${FACTOR_COLUMNS.join(", ")}
) VALUES
${factorRows.join(",\n")}
ON CONFLICT DO NOTHING;

INSERT INTO unit_conversion (
  id, from_unit, to_unit, multiplier, activity_context, factor_set_id, source, notes
)
SELECT v.id::uuid, v.from_unit, v.to_unit, v.multiplier::numeric,
       v.activity_context, s.id, v.source, v.notes
FROM factor_set s
CROSS JOIN (VALUES
${convRows.join(",\n")}
) AS v(id, from_unit, to_unit, multiplier, activity_context, source, notes)
WHERE s.code = ${q(SI_2025_R2.code)}
ON CONFLICT DO NOTHING;
`;
writeFileSync(OUT, header);
console.log(
  `wrote ${path.relative(REPO, OUT)}: set ${SI_2025_R2.code}, ${carried.length} carried + ${added.length} added factors, ${conv.length} conversions`,
);
