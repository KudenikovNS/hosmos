/**
 * `drizzle/0020_factor_set_si_2025_r3.sql` is generated from
 * `seed-data/factor-set-si-2025-r3.ts` plus the VALUES of 0015. This test
 * re-reads the files and proves they still agree — no database needed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { derivedId } from "../seed-data/derived-id";
import { SI_2025_R2 } from "../seed-data/factor-set-si-2025-r2";
import {
  SI_2025_R3,
  SI_2025_R3_ADDITIONS,
  si2025R3FactorId,
} from "../seed-data/factor-set-si-2025-r3";

const DRIZZLE = path.resolve(__dirname, "../../../../drizzle");
const sql = readFileSync(
  path.join(DRIZZLE, "0020_factor_set_si_2025_r3.sql"),
  "utf8",
);
const sql0015 = readFileSync(
  path.join(DRIZZLE, "0015_factor_set_si_2025_r2.sql"),
  "utf8",
);
const tuples = (s: string) =>
  [
    ...s.matchAll(/\n\s*\('([0-9a-f-]{36})', '([0-9a-f-]{36})', '([^']+)'/g),
  ].map((m) => ({ id: m[1]!, setId: m[2]!, code: m[3]! }));

describe("0020 ↔ factor-set-si-2025-r3.ts", () => {
  it("creates the set under its derived id, published after r2", () => {
    expect(SI_2025_R3.id).toBe(derivedId("factor_set", "si-2025-r3"));
    expect(sql).toContain(`('${SI_2025_R3.id}', 'si-2025-r3', `);
    expect(SI_2025_R3.publishedAt > SI_2025_R2.publishedAt).toBe(true);
  });

  it("carries r2's 28 factor codes plus the 5 wood rows, all under the new set", () => {
    const rows = tuples(sql);
    const carried = tuples(sql0015);
    expect(carried).toHaveLength(28);
    expect(rows).toHaveLength(28 + SI_2025_R3_ADDITIONS.length);
    const codes = new Set(rows.map((r) => r.code));
    for (const c of carried) expect(codes.has(c.code), c.code).toBe(true);
    for (const a of SI_2025_R3_ADDITIONS)
      expect(codes.has(a.factor_code), a.factor_code).toBe(true);
    expect(new Set(rows.map((r) => r.setId))).toEqual(new Set([SI_2025_R3.id]));
  });

  it("writes each addition with its derived id, value and biogenic split", () => {
    for (const a of SI_2025_R3_ADDITIONS) {
      const line = sql
        .split("\n")
        .find((l) => l.includes(`('${si2025R3FactorId(a)}', `));
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

  it("splits wood the way VSME B3 wants: biogenic CO2 apart, CH4+N2O in Scope 1", () => {
    const biogenic = SI_2025_R3_ADDITIONS.filter(
      (a) => a.biogenic_treatment === "biogenic",
    );
    expect(biogenic.map((a) => a.activity_type)).toEqual([
      "wood_logs_biogenic",
      "wood_logs_biogenic",
    ]);
    // 112 kg CO2/GJ × ARSO 2025 NCV 15.6 GJ/t
    expect(
      Number(biogenic.find((a) => a.input_unit === "t")!.factor_value),
    ).toBeCloseTo(112 * 15.6, 6);
    const fossil = SI_2025_R3_ADDITIONS.filter(
      (a) => a.biogenic_treatment === null,
    );
    expect(fossil.map((a) => a.activity_type).sort()).toEqual([
      "wood_chips",
      "wood_logs",
      "wood_pellets",
    ]);
    for (const f of fossil) expect(f.geography).toBe("GLOBAL");
  });

  it("copies the ten scoped conversions under the new set", () => {
    expect([
      ...sql.matchAll(/'derived from factor set si-2025-r3/g),
    ]).toHaveLength(10);
    expect(sql).toContain("WHERE s.code = 'si-2025-r3'");
  });
});
