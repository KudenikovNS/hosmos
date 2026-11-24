import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every design token must be declared in `:root`, for every locale. On
 * 10.09.2026 a per-locale font override was pasted inside `:root`, which
 * moved the weight, size, spacing, radius and shadow tokens after it into a
 * `html:lang(ru)` block — and every other locale lost its design. This test
 * reads the stylesheet the way a browser would and fails on that shape.
 */
const css = readFileSync(
  path.join(process.cwd(), "src/app/globals.css"),
  "utf8",
);

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return "";
  const end = css.indexOf("\n}", start);
  return css.slice(start, end);
}

const root = block(":root");

const REQUIRED = [
  "--font-sans",
  "--font-serif",
  "--font-mono",
  "--fw-normal",
  "--fw-semibold",
  "--text-xs",
  "--text-base",
  "--leading-base",
  "--space-1",
  "--space-4",
  "--space-8",
  "--radius-md",
  "--radius-xl",
  "--radius-full",
  "--shadow-sm",
  "--ease-out",
  "--gray-900",
  "--blue-500",
];

describe("design tokens", () => {
  it("declares every token in :root, so no locale can lose the design", () => {
    const missing = REQUIRED.filter((token) => !root.includes(`${token}:`));
    expect(missing).toEqual([]);
  });

  it("keeps locale overrides to the two font tokens", () => {
    const override = block("html:lang(ru),\nhtml:lang(sr)");
    const declared = [...override.matchAll(/--[a-z0-9-]+(?=:)/g)].map(
      (m) => m[0],
    );
    expect(declared.sort()).toEqual(["--font-sans", "--font-serif"]);
  });
});
