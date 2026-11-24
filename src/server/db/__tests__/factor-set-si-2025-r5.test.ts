/**
 * `drizzle/0024_factor_set_si_2025_r5.sql` is generated from
 * `seed-data/factor-set-si-2025-r5.ts` plus the VALUES of 0023. This test
 * re-reads the files and proves they still agree — no database needed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { derivedId } from "../seed-data/derived-id";
import { SI_2025_R4 } from "../seed-data/factor-set-si-2025-r4";
import {
  SI_2025_R5,
  SI_2025_R5_ADDITIONS,
  si2025R5FactorId,
} from "../seed-data/factor-set-si-2025-r5";

const DRIZZLE = path.resolve(__dirname, "../../../../drizzle");
const sql = readFileSync(
  path.join(DRIZZLE, "0024_factor_set_si_2025_r5.sql"),
  "utf8",
);
const sql0023 = readFileSync(
  path.join(DRIZZLE, "0023_factor_set_si_2025_r4.sql"),
  "utf8",
);
const tuples = (s: string) =>
  [
    ...s.matchAll(/\n\s*\('([0-9a-f-]{36})', '([0-9a-f-]{36})', '([^']+)'/g),
  ].map((m) => ({ id: m[1]!, setId: m[2]!, code: m[3]! }));

describe("0024 ↔ factor-set-si-2025-r5.ts", () => {
  it("creates the set under its derived id, published after r4", () => {
    expect(SI_2025_R5.id).toBe(derivedId("factor_set", "si-2025-r5"));
    expect(sql).toContain(`('${SI_2025_R5.id}', 'si-2025-r5', `);
    expect(SI_2025_R5.publishedAt > SI_2025_R4.publishedAt).toBe(true);
  });

  it("carries r4's 58 factor codes plus the ten r5 rows, all under the new set", () => {
    const rows = tuples(sql);
    const carried = tuples(sql0023);
    expect(carried).toHaveLength(58);
    expect(rows).toHaveLength(58 + SI_2025_R5_ADDITIONS.length);
    const codes = new Set(rows.map((r) => r.code));
    for (const c of carried) expect(codes.has(c.code), c.code).toBe(true);
    for (const a of SI_2025_R5_ADDITIONS)
      expect(codes.has(a.factor_code), a.factor_code).toBe(true);
    expect(new Set(rows.map((r) => r.setId))).toEqual(new Set([SI_2025_R5.id]));
  });

  it("writes each addition with its derived id and value, CO2-only", () => {
    for (const a of SI_2025_R5_ADDITIONS) {
      const line = sql
        .split("\n")
        .find((l) => l.includes(`('${si2025R5FactorId(a)}', `));
      expect(line, a.factor_code).toBeDefined();
      expect(line).toContain(
        `'${a.activity_type}', '${a.input_unit}', '${a.factor_value}', 'kgCO2e', '${a.factor_value}'`,
      );
      expect(a.co2_value).toBe(a.factor_value);
      expect(a.biogenic_treatment).toBeNull();
    }
  });

  it("stamps every addition with the reporting year 2024 and Slovenian geography", () => {
    // The whole point of the revision: the year the library matches a row
    // against. A null year here would make the row a GLOBAL-style fallback
    // instead of the national 2024 factor, and 2025 would repeat the gap.
    expect(SI_2025_R5_ADDITIONS).toHaveLength(10);
    for (const a of SI_2025_R5_ADDITIONS) {
      expect(a.applicable_year, a.factor_code).toBe(2024);
      expect(a.geography, a.factor_code).toBe("SI");
    }
  });

  it("covers the keys the 2024 pilot failed on: gas oil in litres and grid electricity in kWh", () => {
    const byKey = new Map(
      SI_2025_R5_ADDITIONS.map((a) => [
        `${a.activity_type}|${a.input_unit}`,
        a,
      ]),
    );
    expect(byKey.get("gas_oil|L")?.factor_value).toBe("2.6673777");
    expect(byKey.get("natural_gas|GJ")?.factor_value).toBe("56.5");
    expect(byKey.get("grid:grid_electricity|kWh")?.factor_value).toBe(
      "0.21222",
    );
    expect(byKey.get("grid:residual_mix|kWh")?.factor_value).toBe("0.2502");
  });

  it("derives the per-unit natural-gas rows from the one ARSO figure", () => {
    const gas = new Map(
      SI_2025_R5_ADDITIONS.filter((a) => a.activity_type === "natural_gas").map(
        (a) => [a.input_unit, Number(a.factor_value)],
      ),
    );
    const perGJ = gas.get("GJ")!;
    expect(gas.get("kWh_net")).toBeCloseTo(perGJ * 0.0036, 6);
    expect(gas.get("MWh")).toBeCloseTo(perGJ * 3.6, 6);
    expect(gas.get("m3")).toBeCloseTo(perGJ * 0.035971, 7);
  });

  it("copies the ten scoped conversions under the new set", () => {
    expect([
      ...sql.matchAll(/'derived from factor set si-2025-r5/g),
    ]).toHaveLength(10);
    expect(sql).toContain("WHERE s.code = 'si-2025-r5'");
  });
});
