// =============================================================================
// R-9 — WHICH FILES THE SERVER-SIDE PDF RENDERER NEEDS AT RUNTIME.
//
// Shared by `next.config.mjs` (which turns the list into
// `outputFileTracingIncludes`) and by `scripts/check-standalone-render.mjs`
// (which checks the result). ONE list, so the thing that is copied and the thing
// that is verified cannot drift apart.
//
// ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
// `src/server/render/vsme-basic.ts` imports `pdfmake/src/printer` — an unbundled
// CJS path INSIDE the package rather than its entry point — and underneath it
// `@foliojs-fork/pdfkit` reads `.afm` font metrics, `.trie` tables and an `.icc`
// profile off disk with `fs.readFileSync`. Two things follow:
//
//   1. pdfmake must NOT be bundled. A bundler inlines the JavaScript and leaves
//      the data files behind, and the failure surfaces as "ENOENT Helvetica.afm"
//      on the server, at the moment somebody presses Render.
//   2. pdfmake must be COPIED into `.next/standalone`. Next's tracer has already
//      pruned packages this project needed — `deploy.yml` copies `drizzle-orm`
//      and `postgres` back by hand for exactly that reason — and a fresh
//      `npm run build` on this repo today ships a `.next/standalone/node_modules`
//      with nine packages in it. Nothing about `output: "standalone"` promises
//      that a package listed in `package.json` reaches the server.
//
// ── WHY THE LIST IS COMPUTED AND NOT TYPED OUT ──────────────────────────────
// pdfmake's runtime closure is 47 packages deep (fontkit, brotli, restructure,
// a dozen `es-*` shims…). A hand-written list is a list that goes stale on the
// next `npm update`, and it goes stale SILENTLY: the missing package is only
// reached at render time. So the closure is walked from `package.json`
// dependencies, from the real `node_modules` layout, every build.
//
// ── AND WHY `build/` IS SUBTRACTED ──────────────────────────────────────────
// 13 of pdfmake's 14 MB are `build/` — the pre-bundled BROWSER distribution,
// which is precisely what this renderer stopped using. R-3 (the server's disk
// quota) makes that worth one glob.
// =============================================================================
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** The repository root — this file lives in `scripts/`. */
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** The package the renderer enters through, and the path it enters by. */
export const PRINTER_SPECIFIER = "pdfmake/src/printer";

/** The font asset the renderer embeds (R-9's other half). */
export const FONT_MODULE = "src/features/reports/lib/figtree-vfs.ts";

/**
 * The directory a package resolves to from `fromDir`, or `null`.
 *
 * Two strategies, because a package with an `exports` map may refuse to expose
 * its own `package.json` (`ERR_PACKAGE_PATH_NOT_EXPORTED`) — `png-js`, `xmldoc`
 * and `unicode-properties` all do. The fallback resolves the package's MAIN
 * entry and walks up to the directory that owns it.
 */
function packageDir(name, fromDir) {
  try {
    return path.dirname(
      require.resolve(`${name}/package.json`, { paths: [fromDir] }),
    );
  } catch {
    // fall through to the entry-point strategy
  }
  let entry;
  try {
    entry = require.resolve(name, { paths: [fromDir] });
  } catch {
    return null;
  }
  const marker = `${path.sep}node_modules${path.sep}${name.split("/").join(path.sep)}`;
  const at = entry.lastIndexOf(marker);
  if (at >= 0) return entry.slice(0, at + marker.length);
  let dir = path.dirname(entry);
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Every package directory pdfmake can reach through `dependencies`, hoisted or
 * nested, as paths relative to the repository root.
 */
export function pdfmakeRuntimePackages() {
  const found = new Map();
  const walk = (name, fromDir) => {
    const dir = packageDir(name, fromDir);
    if (dir === null || found.has(dir)) return;
    found.set(dir, name);
    let manifest;
    try {
      manifest = JSON.parse(
        readFileSync(path.join(dir, "package.json"), "utf8"),
      );
    } catch {
      return;
    }
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      walk(dependency, dir);
    }
  };
  walk("pdfmake", REPO_ROOT);
  return [...found.keys()]
    .map((dir) => path.relative(REPO_ROOT, dir).split(path.sep).join("/"))
    .sort();
}

/**
 * Directories and files that never run on the server.
 *
 * PRUNED IN THE INCLUDE LIST RATHER THAN IN `outputFileTracingExcludes`,
 * because the excludes do NOT win against an explicit include: a build with
 * `./node_modules/pdfmake/**` included and `./node_modules/pdfmake/build/**`
 * excluded ships the 13 MB browser bundle anyway (measured). The only reliable
 * way to leave a file out is not to ask for it.
 */
const SKIP_DIRECTORIES = new Set([
  // pdfmake's pre-bundled BROWSER distribution — 13 of its 14 MB, and exactly
  // what the server-side renderer stopped using (R-3, the disk quota).
  "build",
  "test",
  "tests",
  "docs",
  "examples",
  "coverage",
  ".github",
]);

/** `true` when this entry is dead weight on a server (see {@link SKIP_DIRECTORIES}). */
function isSkipped(entry) {
  return entry.isDirectory()
    ? SKIP_DIRECTORIES.has(entry.name)
    : entry.name.endsWith(".map");
}

/** Does this subtree contain anything {@link isSkipped}, at any depth? */
function hasSkipped(rel) {
  for (const entry of readdirSync(path.join(REPO_ROOT, rel), {
    withFileTypes: true,
  })) {
    if (isSkipped(entry)) return true;
    if (entry.isDirectory() && hasSkipped(`${rel}/${entry.name}`)) return true;
  }
  return false;
}

/**
 * The globs that copy one package, minus its dead weight.
 *
 * A subtree with nothing to prune ANYWHERE BELOW IT becomes one recursive glob;
 * only the branches that actually contain something skipped are expanded. The
 * depth matters: pdfkit keeps its 2 MB of source maps one level down, in `js/`,
 * and a check that only looked at the package's own top level would ship them.
 */
function includeGlobs(relativeDir) {
  const globs = [];
  const walk = (rel) => {
    if (!hasSkipped(rel)) {
      globs.push(`./${rel}/**`);
      return;
    }
    for (const entry of readdirSync(path.join(REPO_ROOT, rel), {
      withFileTypes: true,
    })) {
      if (isSkipped(entry)) continue;
      if (entry.isDirectory()) walk(`${rel}/${entry.name}`);
      else globs.push(`./${rel}/${entry.name}`);
    }
  };
  walk(relativeDir);
  return globs;
}

/** The globs `outputFileTracingIncludes` needs — the closure plus the font. */
export function pdfmakeTraceIncludes() {
  return [
    ...pdfmakeRuntimePackages().flatMap(includeGlobs),
    // The font asset. Redundant the day a route imports the renderer (the
    // bundler then carries the base64 inside a server chunk) and harmless
    // afterwards; today it is what makes "the font VFS shipped" checkable at
    // all, since nothing in the app graph imports the renderer until T5.7.
    `./${FONT_MODULE}`,
  ];
}
