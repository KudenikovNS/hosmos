#!/usr/bin/env node
/**
 * ONE-OFF GENERATOR — NOT part of the application runtime.
 *
 * Emits `drizzle/0020_factor_set_si_2025_r3.sql`: factor set `si-2025-r3` =
 * every `emission_factor` row of `si-2025` (read VERBATIM from 0009's VALUES
 * list, re-keyed under the new set code) + the additions in
 * `src/server/db/seed-data/factor-set-si-2025-r3.ts` + the ten set-scoped
 * `unit_conversion` rows of 0010 (re-keyed the same way).
 *
 *   npx tsx scripts/gen-factor-set-si-2025-r3.mjs
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
  SI_2025_R3,
  SI_2025_R3_ADDITIONS,
  si2025R3FactorId,
} from "../src/server/db/seed-data/factor-set-si-2025-r3.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const M0015 = path.join(REPO, "drizzle/0015_factor_set_si_2025_r2.sql");
const OUT = path.join(REPO, "drizzle/0020_factor_set_si_2025_r3.sql");

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
// The revision adds one column 0015 did not carry: the biogenic split (CALC-4).
const OUT_COLUMNS = [...FACTOR_COLUMNS, "biogenic_treatment"];

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
const sql0009 = readFileSync(M0015, "utf8");
const block = sql0009.slice(sql0009.indexOf("INSERT INTO emission_factor"));
const valuesBlock = block.slice(
  block.indexOf(") VALUES") + ") VALUES".length,
  block.indexOf("\nON CONFLICT"),
);
const tuples = [...valuesBlock.matchAll(/\n\s*\((.*)\)\s*,?\s*$/gm)].map((m) =>
  splitTuple(m[1]),
);
if (tuples.length !== 28)
  throw new Error(
    `expected 28 si-2025-r2 rows in 0015, parsed ${tuples.length}`,
  );
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
const added = SI_2025_R3_ADDITIONS.map((r) => ({ ...r }));
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
const sql0010 = readFileSync(M0015, "utf8");
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
    `expected 10 scoped conversions in 0015, parsed ${conv.length}`,
  );

// ── 4. render ────────────────────────────────────────────────────────────────
const setId = SI_2025_R3.id;
const factorRows = all.map((r) => {
  const id = si2025R3FactorId(r);
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
      r.biogenic_treatment ?? null,
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
    SI_2025_R3.code,
  );
  const source = c.source.replace("si-2025", SI_2025_R3.code);
  return (
    "  (" +
    [id, c.from, c.to, c.multiplier, c.context, source, c.notes]
      .map(q)
      .join(", ") +
    ")"
  );
});

const header = `-- 0020_factor_set_si_2025_r3.sql — SLOVENIA 2025, REVISION 3: BIOMASS.
--
-- GENERATED by \`scripts/gen-factor-set-si-2025-r3.mjs\` from
-- \`src/server/db/seed-data/factor-set-si-2025-r3.ts\` (the five wood rows) and
-- the VALUES lists of 0015 (the 28 carried rows and the ten set-scoped
-- natural-gas conversions). DO NOT EDIT BY HAND — rerun the generator;
-- \`factor-set-si-2025-r3.test.ts\` proves this file and the module agree.
--
-- WHY. No national set priced wood, a common Scope-1 fuel for Slovenian SMEs.
-- ARSO 2025 lists «Lesna biomasa» at 15.6 GJ/t with a CO2 factor of 0 — the
-- inventory convention that biomass CO2 is BIOGENIC and reported outside the
-- fossil total. The GHG Protocol and VSME B3 want that same split, so this
-- revision carries two things: the biogenic CO2 of wood (IPCC 2006 default,
-- 112 kg CO2/GJ; per tonne 112 × ARSO's 15.6 = 1 747.2 kg CO2/t) on the
-- \`wood_logs_biogenic\` literal with \`biogenic_treatment = 'biogenic'\` (CALC-4
-- keeps it off the fossil line), and the Scope-1 CH4 + N2O of burning wood
-- logs / chips / pellets — the expert workbook's DESNZ 2026 rows 36–38, at
-- GLOBAL, as an EXPLICIT international fallback (stage-1 factor hierarchy,
-- rung 5). ARSO publishes no CH4/N2O factor; the methodologist may replace the
-- three fallback rows with a Slovenian or sector value in a later revision.
--
-- DM-21: a released set is never edited, so this is a NEW set. Every other row
-- is \`si-2025-r2\`'s, byte for byte, under a new set id, and the ten scoped
-- conversions travel with the set (0010's reasoning). New periods pin this set
-- (\`resolveFactorSet\` takes the newest \`published_at\`); existing pins are
-- untouched. Idempotent: \`ON CONFLICT DO NOTHING\` everywhere, derived UUIDs.

INSERT INTO factor_set (
  id, code, name, description, status, published_at
) VALUES
  (${q(setId)}, ${q(SI_2025_R3.code)}, ${q(SI_2025_R3.name)}, ${q(SI_2025_R3.description)}, 'active', ${q(SI_2025_R3.publishedAt)})
ON CONFLICT (code) DO NOTHING;

INSERT INTO emission_factor (
  ${OUT_COLUMNS.join(", ")}
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
WHERE s.code = ${q(SI_2025_R3.code)}
ON CONFLICT DO NOTHING;
`;
writeFileSync(OUT, header);
console.log(
  `wrote ${path.relative(REPO, OUT)}: set ${SI_2025_R3.code}, ${carried.length} carried + ${added.length} added factors, ${conv.length} conversions`,
);
