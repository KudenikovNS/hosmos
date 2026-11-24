/**
 * The Slovene datapoint titles (0018) — every catalogue metric has one, none is
 * a copied English string, and the generated migration carries them all.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import catalogue from "../seed-data/vsme-metrics.json";
import titles from "../seed-data/vsme-metrics.sl.json";

const SQL = readFileSync(
  path.resolve(
    __dirname,
    "../../../../drizzle/0018_metric_catalog_title_sl.sql",
  ),
  "utf8",
);

describe("vsme-metrics.sl.json ↔ catalogue ↔ 0018", () => {
  const sl = titles as Record<string, string>;

  it("names every one of the 141 metrics, and nothing else", () => {
    expect(Object.keys(sl).sort()).toEqual(
      catalogue.map((m) => m.metric_key).sort(),
    );
  });

  it("is a translation, not the English copied over", () => {
    for (const m of catalogue) {
      expect(sl[m.metric_key]?.trim(), m.metric_key).not.toBe("");
      expect(sl[m.metric_key], m.metric_key).not.toBe(m.title_en);
    }
  });

  it("is what the migration writes", () => {
    for (const m of catalogue) {
      const escaped = sl[m.metric_key]!.replace(/'/g, "''");
      expect(SQL, m.metric_key).toContain(`('${m.metric_key}', '${escaped}')`);
    }
  });
});
