/**
 * `drizzle/0015_factor_set_si_2025_r2.sql` is generated from
 * `seed-data/factor-set-si-2025-r2.ts` plus the VALUES lists of 0009/0010. This
 * test re-reads the three files and proves the generated migration still says
 * what the module says — no database needed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { derivedId } from "../seed-data/derived-id";
import {
  SI_2025_R2,
  SI_2025_R2_ADDITIONS,
  SI_2025_R2_ONLY_ACTIVITY_TYPES,
  si2025R2FactorId,
} from "../seed-data/factor-set-si-2025-r2";
import { FUEL_TYPES, REFRIGERANT_TYPES } from "@/shared/enums";

const DRIZZLE = path.resolve(__dirname, "../../../../drizzle");
const sql = readFileSync(
  path.join(DRIZZLE, "0015_factor_set_si_2025_r2.sql"),
  "utf8",
);
const sql0009 = readFileSync(
  path.join(DRIZZLE, "0009_factor_set_si_2025.sql"),
  "utf8",
);

const factorTuples = (s: string) =>
  [
    ...s.matchAll(/\n\s*\('([0-9a-f-]{36})', '([0-9a-f-]{36})', '([^']+)'/g),
  ].map((m) => ({ id: m[1]!, setId: m[2]!, code: m[3]! }));

describe("0015 ↔ factor-set-si-2025-r2.ts", () => {
  it("creates the set under its derived id, active, published after si-2025", () => {
    expect(SI_2025_R2.id).toBe(derivedId("factor_set", "si-2025-r2"));
    expect(sql).toContain(`('${SI_2025_R2.id}', 'si-2025-r2', `);
    expect(sql).toContain(`'active', '${SI_2025_R2.publishedAt}'`);
    expect(SI_2025_R2.publishedAt > "2026-06-01").toBe(true);
  });

  it("carries every one of si-2025's 23 factor codes plus the 5 additions", () => {
    const rows = factorTuples(sql);
    const carried = factorTuples(sql0009);
    expect(carried).toHaveLength(23);
    expect(rows).toHaveLength(23 + SI_2025_R2_ADDITIONS.length);
    const codes = new Set(rows.map((r) => r.code));
    for (const c of carried) expect(codes.has(c.code), c.code).toBe(true);
    for (const a of SI_2025_R2_ADDITIONS)
      expect(codes.has(a.factor_code), a.factor_code).toBe(true);
    // Every row belongs to the new set, never to si-2025.
    expect(new Set(rows.map((r) => r.setId))).toEqual(new Set([SI_2025_R2.id]));
  });

  it("gives every addition the id its natural key derives, with its workbook value", () => {
    for (const a of SI_2025_R2_ADDITIONS) {
      const id = si2025R2FactorId(a);
      const line = sql.split("\n").find((l) => l.includes(`('${id}', `));
      expect(line, a.factor_code).toBeDefined();
      expect(line).toContain(
        `'${a.activity_type}', '${a.input_unit}', '${a.factor_value}'`,
      );
    }
  });

  it("copies the ten set-scoped conversions under the new set", () => {
    const conv = [...sql.matchAll(/'derived from factor set si-2025-r2/g)];
    expect(conv).toHaveLength(10);
    expect(sql).toContain("WHERE s.code = 'si-2025-r2'");
  });

  it("prices exactly the literals the enums added for it", () => {
    expect([...SI_2025_R2_ONLY_ACTIVITY_TYPES].sort()).toEqual([
      "coke",
      "lignite",
      "r125",
    ]);
    for (const t of SI_2025_R2_ONLY_ACTIVITY_TYPES) {
      expect(
        (FUEL_TYPES as readonly string[]).includes(t) ||
          (REFRIGERANT_TYPES as readonly string[]).includes(t),
        t,
      ).toBe(true);
    }
  });
});
