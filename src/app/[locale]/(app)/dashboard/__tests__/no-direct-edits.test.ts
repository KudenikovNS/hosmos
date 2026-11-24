// =============================================================================
// "NO DIRECT EDITS" (UI-6, T5.9) — ASSERTED, NOT EYEBALLED.
//
// The acceptance criterion of this screen is a NEGATIVE: not one mutating
// control anywhere on it. A negative cannot be checked by rendering the page and
// looking, because the thing that would break it is the control somebody adds
// next quarter, in the state nobody screenshots — a "recalculate" button in the
// stale branch, an "approve" shortcut beside the failed one. Both are reasonable
// ideas and both belong on `/inventory` or `/review`, where the write is
// validated, audited and gated; a hub that could mutate would be a second write
// path for data whose only legitimate one is append-only (§0.4).
//
// SO THE SCREEN IS READ AS TEXT, and the check is structural: no form element,
// no handler, no write hook, no non-GET verb, in any file of the directory. Two
// details make it honest rather than decorative:
//
//   • COMMENTS AND STRINGS ARE STRIPPED FIRST. This very file's neighbours
//     explain at length that they do not mutate; a substring scan that counted
//     the word "button" in a paragraph saying there is no button would be
//     theatre.
//   • THE API IS CHECKED TOO. A screen with no buttons in front of an endpoint
//     with a POST is one `curl` away from not being read-only, and the route is
//     the half a future page could quietly reuse.
// =============================================================================
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const SCREEN_DIR = path.join(REPO_ROOT, "src/app/[locale]/(app)/dashboard");
const ROUTE_FILE = path.join(REPO_ROOT, "src/app/api/dashboard/route.ts");

/** Every `.ts`/`.tsx` of the screen except its own test files. */
function screenFiles(dir: string = SCREEN_DIR): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "__tests__" ? [] : screenFiles(full);
    }
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

/**
 * Source with comments and string literals removed.
 *
 * Naive but sufficient for these files, and deliberately conservative: what is
 * left is code, so a match is a real construct rather than a word in prose.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/** A construct that would make the screen able to change something. */
const MUTATING: readonly { name: string; pattern: RegExp }[] = [
  { name: "a form", pattern: /<form[\s>]/ },
  { name: "a button", pattern: /<[Bb]utton[\s/>]/ },
  {
    name: "a text field",
    pattern: /<(input|textarea|select|Input|Select)[\s/>]/,
  },
  { name: "a click handler", pattern: /\bon(Click|Submit|Change|Input)\s*=/ },
  { name: "the write hook", pattern: /\buseWrite\b/ },
  { name: "a react-query mutation", pattern: /\buseMutation\b/ },
  { name: "a non-GET verb", pattern: /\b(POST|PUT|PATCH|DELETE)\b/ },
  { name: "a fetch with a method", pattern: /\bmethod\s*:/ },
];

describe("`/dashboard` has no mutating control (UI-6)", () => {
  const files = screenFiles();

  it("has files to check at all", () => {
    // A directory that silently moved would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(2);
    expect(files.some((file) => file.endsWith("page.tsx"))).toBe(true);
  });

  it.each(files.map((file) => path.relative(REPO_ROOT, file)))(
    "%s carries no form, handler, write hook or non-GET verb",
    (relative) => {
      const source = code(readFileSync(path.join(REPO_ROOT, relative), "utf8"));
      const found = MUTATING.filter((entry) => entry.pattern.test(source)).map(
        (entry) => entry.name,
      );
      expect(found).toEqual([]);
    },
  );

  it("navigates only with the locale-aware Link", () => {
    // The one interactive element the screen is allowed: a link. Asserted
    // POSITIVELY so that "no controls" cannot be satisfied by a page that also
    // stopped being usable.
    const sources = files.map((file) => readFileSync(file, "utf8"));
    expect(
      sources.some((source) => /from "@\/i18n\/navigation"/.test(source)),
    ).toBe(true);
  });
});

describe("`GET /api/dashboard` is a read (UI-6)", () => {
  const source = readFileSync(ROUTE_FILE, "utf8");

  it("exports exactly GET and OPTIONS — no verb that writes", () => {
    const exported = [...source.matchAll(/export const (\w+)/g)]
      .map((match) => match[1])
      .sort();
    expect(exported).toEqual(["GET", "OPTIONS"]);
  });

  it("asks for the read capability and nothing more", () => {
    expect(source).toContain('requireCapability(session, "data.read")');
  });
});
