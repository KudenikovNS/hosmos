/**
 * 0019 — the simplified-ESRS extension of the catalogue: the two JSON modules
 * the generator writes and the migration it renders from them agree, and the
 * 50 ESRS-only rows are shaped like catalogue rows.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import catalogue from "../seed-data/vsme-metrics.json";
import esrs from "../seed-data/esrs-metrics.json";
import ext from "../seed-data/vsme-metrics.esrs.json";

const SQL = readFileSync(
  path.resolve(__dirname, "../../../../drizzle/0019_metric_catalog_esrs.sql"),
  "utf8",
);

describe("vsme-metrics.esrs.json (the 141 VSME rows' ESRS columns)", () => {
  const map = ext as Record<string, Record<string, string | null>>;
  it("names every VSME metric once, and nothing else", () => {
    expect(Object.keys(map).sort()).toEqual(
      catalogue.map((m) => m.metric_key).sort(),
    );
  });
  it("maps 121 of the 141 to a simplified-ESRS reference (20 are VSME-only)", () => {
    const mapped = Object.values(map).filter((v) => v.esrs_reference).length;
    expect(mapped).toBe(121);
  });
  it("is what the migration UPDATEs", () => {
    for (const [key, v] of Object.entries(map)) {
      expect(SQL, key).toContain(`('${key}', `);
      if (v.esrs_reference)
        expect(SQL, key).toContain(`'${v.esrs_reference.replace(/'/g, "''")}'`);
    }
  });
});

describe("esrs-metrics.json (the 50 ESRS-only rows)", () => {
  it("has 50 rows keyed ESRS-001…050, standard esrs, module simplified_esrs", () => {
    expect(esrs).toHaveLength(50);
    esrs.forEach((m, i) => {
      expect(m.metric_key).toBe(`ESRS-${String(i + 1).padStart(3, "0")}`);
      expect(m.standard).toBe("esrs");
      expect(m.module).toBe("simplified_esrs");
      expect(["environmental", "social", "governance"]).toContain(m.pillar);
      expect(["text", "decimal"]).toContain(m.value_type);
      expect(["mandatory", "conditional"]).toContain(m.requirement_type);
      expect(m.esrs_reference).toMatch(/^ESRS /);
    });
  });
  it("sorts after the last VSME metric and never reuses a VSME key", () => {
    const maxVsme = Math.max(...catalogue.map((m) => m.sort_order));
    expect(Math.min(...esrs.map((m) => m.sort_order))).toBeGreaterThan(maxVsme);
    const vsmeKeys = new Set(catalogue.map((m) => m.metric_key));
    expect(esrs.filter((m) => vsmeKeys.has(m.metric_key))).toEqual([]);
  });
  it("is what the migration INSERTs", () => {
    for (const m of esrs)
      expect(SQL, m.metric_key).toContain(`('${m.metric_key}', 'esrs', `);
    expect(SQL).toMatch(/ON CONFLICT \(metric_key\) DO UPDATE SET/);
  });
});
