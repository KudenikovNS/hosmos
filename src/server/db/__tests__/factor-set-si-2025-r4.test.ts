/**
 * `drizzle/0023_factor_set_si_2025_r4.sql` is generated from
 * `seed-data/factor-set-si-2025-r4.ts` plus the VALUES of 0015. This test
 * re-reads the files and proves they still agree — no database needed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { derivedId } from "../seed-data/derived-id";
import { SI_2025_R3 } from "../seed-data/factor-set-si-2025-r3";
import {
  SI_2025_R4,
  SI_2025_R4_ADDITIONS,
  SPEND_COMMODITIES,
  SPEND_YEARS,
  si2025R4FactorId,
} from "../seed-data/factor-set-si-2025-r4";

const DRIZZLE = path.resolve(__dirname, "../../../../drizzle");
const sql = readFileSync(
  path.join(DRIZZLE, "0023_factor_set_si_2025_r4.sql"),
  "utf8",
);
const sql0020 = readFileSync(
  path.join(DRIZZLE, "0020_factor_set_si_2025_r3.sql"),
  "utf8",
);
const tuples = (s: string) =>
  [
    ...s.matchAll(/\n\s*\('([0-9a-f-]{36})', '([0-9a-f-]{36})', '([^']+)'/g),
  ].map((m) => ({ id: m[1]!, setId: m[2]!, code: m[3]! }));

describe("0023 ↔ factor-set-si-2025-r4.ts", () => {
  it("creates the set under its derived id, published after r3", () => {
    expect(SI_2025_R4.id).toBe(derivedId("factor_set", "si-2025-r4"));
    expect(sql).toContain(`('${SI_2025_R4.id}', 'si-2025-r4', `);
    expect(SI_2025_R4.publishedAt > SI_2025_R3.publishedAt).toBe(true);
  });

  it("carries r3's 33 factor codes plus the 25 r4 rows, all under the new set", () => {
    const rows = tuples(sql);
    const carried = tuples(sql0020);
    expect(carried).toHaveLength(33);
    expect(rows).toHaveLength(33 + SI_2025_R4_ADDITIONS.length);
    const codes = new Set(rows.map((r) => r.code));
    for (const c of carried) expect(codes.has(c.code), c.code).toBe(true);
    for (const a of SI_2025_R4_ADDITIONS)
      expect(codes.has(a.factor_code), a.factor_code).toBe(true);
    expect(new Set(rows.map((r) => r.setId))).toEqual(new Set([SI_2025_R4.id]));
  });

  it("writes each addition with its derived id, value and biogenic split", () => {
    for (const a of SI_2025_R4_ADDITIONS) {
      const line = sql
        .split("\n")
        .find((l) => l.includes(`('${si2025R4FactorId(a)}', `));
      expect(line, a.factor_code).toBeDefined();
      expect(line).toContain(
        `'${a.activity_type}', '${a.input_unit}', '${a.factor_value}'`,
      );
      expect(
        line!
          .trimEnd()
          .endsWith(a.biogenic_treatment ? "'biogenic')," : "NULL),") ||
          line!
            .trimEnd()
            .endsWith(a.biogenic_treatment ? "'biogenic')" : "NULL)"),
      ).toBe(true);
    }
  });

  it("adds purchased district heat under the key scope2.ts files it under, as an explicit fallback", () => {
    const heat = SI_2025_R4_ADDITIONS.filter(
      (a) => a.activity_type === "heat:heat_defra_default",
    );
    expect(heat).toHaveLength(1);
    expect(heat[0]).toMatchObject({
      input_unit: "kWh",
      geography: "GLOBAL",
      applicable_year: null,
      factor_value: "0.1659",
      biogenic_treatment: null,
    });
  });

  it("adds the eight EXIOBASE spend commodities for 2024–2026, the way scope3/factors.ts selects them", () => {
    const spend = SI_2025_R4_ADDITIONS.filter((a) =>
      a.activity_type.startsWith("scope3_spend:"),
    );
    expect(spend).toHaveLength(SPEND_COMMODITIES.length * SPEND_YEARS.length);
    for (const row of spend) {
      expect(row.input_unit).toBe("EUR_1000");
      expect(row.geography).toBe("GLOBAL");
      expect(SPEND_YEARS).toContain(row.applicable_year);
      expect(row.activity_type).toMatch(/^scope3_spend:s3_c[12]_/);
    }
    const keys = new Set(
      spend.map((r) => r.activity_type.slice("scope3_spend:".length)),
    );
    expect([...keys].sort()).toEqual(SPEND_COMMODITIES.map(([k]) => k).sort());
  });

  it("copies the ten scoped conversions under the new set", () => {
    expect([
      ...sql.matchAll(/'derived from factor set si-2025-r4/g),
    ]).toHaveLength(10);
    expect(sql).toContain("WHERE s.code = 'si-2025-r4'");
  });
});
