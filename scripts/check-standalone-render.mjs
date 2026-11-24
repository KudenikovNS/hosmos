#!/usr/bin/env node
// =============================================================================
// R-9 — DOES THE VSME RENDERER SURVIVE `npm run build`?
//
//   npm run build && node scripts/check-standalone-render.mjs
//
// This is not a duplicate of the vitest suite and it cannot be replaced by one.
// `src/server/render/__tests__/render.integration.test.ts` runs over SOURCES,
// with the repository's own `node_modules` one directory up; it proves the
// renderer is correct and proves nothing at all about the artefact that is
// rsynced to the server. `deploy.yml` ships `.next/standalone` and only that,
// and Next's file tracer decides what goes in it. The tracer has been wrong here
// before — `deploy.yml:57-66` copies `drizzle-orm` and `postgres` back by hand
// because it pruned them — and `pdfmake/src/printer` is a worse case than either
// of those: an unbundled CJS path inside a package, over a PDFKit that reads
// `.afm`, `.trie` and `.icc` files off disk at runtime.
//
// WHAT IS ACTUALLY CHECKED, in order, each failing loudly and with the remedy:
//   1. `.next/standalone` exists.
//   2. `pdfmake/src/printer` RESOLVES FROM INSIDE `.next/standalone` — not from
//      the repository's node_modules, which would resolve on a developer's
//      machine and 404 on the server. The resolved path is asserted to be under
//      the bundle.
//   3. The data files PDFKit reads at runtime are there too (`.afm` metrics,
//      the `.trie` tables). These are the files a bundler drops.
//   4. The font VFS shipped: the Figtree module is present in the bundle, and
//      its four faces decode to real TrueType data.
//   5. A PDF IS ACTUALLY PRODUCED, by the printer loaded out of the bundle, with
//      those fonts — and it starts with `%PDF-`, is non-trivial in size, and
//      names Figtree in its font descriptors (i.e. the face was embedded rather
//      than silently replaced by a base-14 fallback).
//   6. THE XLSX GENERATOR SHIPPED TOO (T5.7, К-22). The second format is the
//      same risk as the first with a different shape — an xlsx library that does
//      not reach the server fails at the moment somebody presses Render — so it
//      is checked here rather than trusted.
//
// ── WHY STEP 6 LOOKS DIFFERENT FROM STEPS 2–5 ───────────────────────────────
// pdfmake had to be EXTERNAL (it reads data files off disk), so the question
// "did it ship" is a question about `.next/standalone/node_modules` and the
// answer can be exercised by requiring it from there. `write-excel-file` is pure
// JavaScript over `fflate` and reads nothing at runtime, so it BUNDLES — and a
// bundled module has no package directory to look for; its code is inside a
// server chunk. Step 6 therefore accepts EITHER location, exactly as step 4 does
// for the font VFS: whichever way the build placed it, it must be there.
//   • external → the generator is loaded and a real `.xlsx` is produced and
//     unzipped, the same end-to-end proof as step 5;
//   • bundled  → the chunk must carry the generator's own OOXML part names
//     (`xl/workbook.xml`, `xl/styles.xml`, `xl/sharedStrings.xml`,
//     `[Content_Types].xml`). Those strings exist nowhere else in this
//     application: their presence is the generator's code, not merely a mention
//     of the package name.
// NEITHER location is a failure, and that is the case this step exists for.
//
// Exit code 0 means the deployed server can render a report. Anything else
// names the missing piece.
// =============================================================================
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  FONT_MODULE,
  PRINTER_SPECIFIER,
  REPO_ROOT,
} from "./pdfmake-runtime.mjs";

const STANDALONE = path.join(REPO_ROOT, ".next", "standalone");

/** Fatal, with the remedy attached — a check nobody can act on is a formality. */
function fail(what, remedy) {
  console.error(`\n  R-9 FAILED: ${what}`);
  console.error(`  remedy:     ${remedy}\n`);
  process.exit(1);
}

function ok(what) {
  console.log(`  ok  ${what}`);
}

// ─── 1. The bundle ───────────────────────────────────────────────────────────

if (!existsSync(STANDALONE)) {
  fail(
    `${path.relative(REPO_ROOT, STANDALONE)} does not exist`,
    "run `env -u DATABASE_URL npm run build` first — this script checks the build output, not the sources",
  );
}
ok(`${path.relative(REPO_ROOT, STANDALONE)} exists`);

// ─── 2. The printer, resolved FROM the bundle ────────────────────────────────

// The `require` is rooted at the bundle's own entry point, so module resolution
// walks `.next/standalone/node_modules` exactly as `node server.js` will.
const bundleRequire = createRequire(path.join(STANDALONE, "server.js"));

let printerPath;
try {
  printerPath = bundleRequire.resolve(PRINTER_SPECIFIER);
} catch {
  fail(
    `${PRINTER_SPECIFIER} does not resolve from inside the standalone bundle`,
    "next.config.mjs must keep pdfmake in `serverExternalPackages` and list its runtime closure in `outputFileTracingIncludes` (scripts/pdfmake-runtime.mjs computes it)",
  );
}

if (!printerPath.startsWith(STANDALONE + path.sep)) {
  fail(
    `${PRINTER_SPECIFIER} resolved to ${printerPath}, which is OUTSIDE the bundle`,
    "the package was found in the repository's node_modules, so it would be missing on the server; add it to `outputFileTracingIncludes`",
  );
}
ok(`${PRINTER_SPECIFIER} → ${path.relative(STANDALONE, printerPath)}`);

// ─── 3. PDFKit's runtime data files ──────────────────────────────────────────

const pdfkitData = path.join(
  path.dirname(bundleRequire.resolve("@foliojs-fork/pdfkit/package.json")),
  "js",
  "data",
);
if (!existsSync(pdfkitData)) {
  fail(
    "@foliojs-fork/pdfkit/js/data is not in the bundle",
    "PDFKit reads its .afm metrics from disk; the tracer or a bundler dropped them",
  );
}
const dataFiles = readdirSync(pdfkitData);
const afmCount = dataFiles.filter((name) => name.endsWith(".afm")).length;
if (afmCount < 14) {
  fail(
    `only ${afmCount} .afm metric files shipped (expected the 14 base fonts)`,
    "check `outputFileTracingExcludes` — something is filtering pdfkit's data directory",
  );
}
ok(
  `pdfkit runtime data: ${afmCount} .afm files, ${dataFiles.length} files total`,
);

// ─── 4. The font VFS ─────────────────────────────────────────────────────────

const bundledFont = path.join(STANDALONE, FONT_MODULE);
let fontSource;
if (existsSync(bundledFont)) {
  fontSource = readFileSync(bundledFont, "utf8");
  ok(
    `font VFS shipped as ${FONT_MODULE} (${(statSync(bundledFont).size / 1024) | 0} KB)`,
  );
} else {
  // Once a route imports the renderer (T5.7) the base64 lives inside a server
  // chunk instead of a copied file. Either location counts as "it shipped";
  // NEITHER does not.
  const chunk = findInServerChunks("Figtree-Regular.ttf");
  if (chunk === null) {
    fail(
      "the Figtree VFS is nowhere in the standalone bundle",
      `keep \`./${FONT_MODULE}\` in \`outputFileTracingIncludes\`, or make sure the route that imports the renderer is part of the build`,
    );
  }
  fontSource = readFileSync(chunk, "utf8");
  ok(`font VFS shipped inside ${path.relative(STANDALONE, chunk)}`);
}

/** The four faces, parsed out of whatever module shipped them. */
const faces = Object.fromEntries(
  [
    ...fontSource.matchAll(
      /"(Figtree-[A-Za-z]+)\.ttf":\s*"?\s*"?([A-Za-z0-9+/=]{2000,})"/g,
    ),
  ].map((match) => [match[1], Buffer.from(match[2], "base64")]),
);
const WANTED = [
  "Figtree-Regular",
  "Figtree-Bold",
  "Figtree-Italic",
  "Figtree-BoldItalic",
];
const missingFaces = WANTED.filter((name) => faces[name] === undefined);
if (missingFaces.length > 0) {
  fail(
    `the shipped font VFS is missing ${missingFaces.join(", ")}`,
    "regenerate src/features/reports/lib/figtree-vfs.ts with all four faces",
  );
}
for (const name of WANTED) {
  // A TrueType file opens with the sfnt version 0x00010000.
  const magic = faces[name].readUInt32BE(0);
  if (magic !== 0x00010000) {
    fail(
      `${name} did not decode to TrueType data (magic 0x${magic.toString(16)})`,
      "the base64 in figtree-vfs.ts is corrupt",
    );
  }
}
ok(
  `four Figtree faces decoded: ${WANTED.map((n) => `${n} ${(faces[n].byteLength / 1024) | 0}KB`).join(", ")}`,
);

// ─── 5. A real PDF, from the bundle ──────────────────────────────────────────

const PdfPrinter = bundleRequire(PRINTER_SPECIFIER);
const printer = new PdfPrinter({
  Figtree: {
    normal: faces["Figtree-Regular"],
    bold: faces["Figtree-Bold"],
    italics: faces["Figtree-Italic"],
    bolditalics: faces["Figtree-BoldItalic"],
  },
});

const doc = printer.createPdfKitDocument({
  content: [
    { text: "VSME Basic sustainability report", style: "h" },
    { text: "Poročilo o trajnosti — šumniki: č, š, ž, Č, Š, Ž" },
    {
      table: {
        body: [
          [{ text: "Scope 1", bold: true }, "18.401 t CO2e"],
          [{ text: "Scope 2", bold: true }, "9.100 t CO2e"],
        ],
      },
    },
    { text: "italic", italics: true },
    { text: "bold italic", bold: true, italics: true },
  ],
  styles: { h: { fontSize: 18, bold: true } },
  defaultStyle: { font: "Figtree" },
});

const pdf = await new Promise((resolve, reject) => {
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  doc.on("error", reject);
  doc.on("end", () => resolve(Buffer.concat(chunks)));
  doc.end();
});

if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
  fail(
    "the produced bytes do not start with %PDF-",
    "pdfmake produced something else",
  );
}
if (pdf.byteLength < 1000) {
  fail(
    `the produced PDF is only ${pdf.byteLength} bytes`,
    "layout produced nothing",
  );
}
if (!pdf.toString("latin1").includes("Figtree")) {
  fail(
    "the produced PDF does not name Figtree in its font descriptors",
    "the embedded face was not used — pdfmake fell back to a base-14 font",
  );
}
ok(`PDF produced from the bundle: ${pdf.byteLength} bytes, embeds Figtree`);

// ─── 6. The XLSX generator (T5.7, К-22) ──────────────────────────────────────

/** The entry `src/server/render/xlsx.ts` imports. */
const XLSX_SPECIFIER = "write-excel-file/node";

/**
 * The OOXML part names the generator writes into every workbook.
 *
 * Chosen because they are the generator's OWN string literals: matching them in
 * a chunk means the code that builds a workbook is in there, not merely a
 * reference to the package. `[Content_Types].xml` is last on purpose — it is
 * the part an `.xlsx` is unopenable without.
 */
const XLSX_MARKERS = [
  "xl/workbook.xml",
  "xl/styles.xml",
  "xl/sharedStrings.xml",
  "[Content_Types].xml",
];

let xlsxPath = null;
try {
  xlsxPath = bundleRequire.resolve(XLSX_SPECIFIER);
} catch {
  // Not a package inside the bundle — it was bundled into a chunk. Checked below.
}

if (xlsxPath && xlsxPath.startsWith(STANDALONE + path.sep)) {
  // EXTERNAL: prove it end to end, like the PDF above.
  const writeXlsxFile = (await import(pathToFileURL(xlsxPath).href)).default;
  const xlsx = await writeXlsxFile([[{ value: "Scope 1", type: String }]], {
    sheet: "R-9",
  }).toBuffer();
  if (xlsx.subarray(0, 2).toString("latin1") !== "PK") {
    fail(
      "the produced bytes are not a zip archive (an .xlsx is a zip)",
      "write-excel-file produced something else",
    );
  }
  const parts = xlsx.toString("latin1");
  const missingParts = XLSX_MARKERS.filter((part) => !parts.includes(part));
  if (missingParts.length > 0) {
    fail(
      `the produced workbook is missing ${missingParts.join(", ")}`,
      "the archive is not a complete OOXML package and Excel will refuse it",
    );
  }
  ok(
    `XLSX produced from the bundle: ${xlsx.byteLength} bytes, ${XLSX_MARKERS.length} OOXML parts`,
  );
} else {
  // BUNDLED: the code must be inside a server chunk. See the header for why
  // this is a different question and not a weaker one.
  const chunk = findInServerChunks(XLSX_MARKERS[0]);
  if (chunk === null) {
    fail(
      `the xlsx generator (${XLSX_SPECIFIER}) is nowhere in the standalone bundle`,
      "make sure the route that imports src/server/render/xlsx.ts is part of the build, or add the package to `serverExternalPackages` + `outputFileTracingIncludes`",
    );
  }
  const source = readFileSync(chunk, "utf8");
  const missingMarkers = XLSX_MARKERS.filter(
    (marker) => !source.includes(marker),
  );
  if (missingMarkers.length > 0) {
    fail(
      `the bundled xlsx generator is missing ${missingMarkers.join(", ")}`,
      "a chunk mentions the package but does not contain the workbook writer — check that `write-excel-file/node` (not `/browser`) is the imported entry",
    );
  }
  ok(
    `xlsx generator bundled into ${path.relative(STANDALONE, chunk)} (all ${XLSX_MARKERS.length} OOXML parts)`,
  );
}

console.log(
  "\n  R-9 ok — the standalone bundle can render a VSME Basic report in both formats.\n",
);

/** Depth-first search of the built server chunks for a marker string. */
function findInServerChunks(marker) {
  const root = path.join(STANDALONE, ".next", "server");
  if (!existsSync(root)) return null;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (
        entry.name.endsWith(".js") &&
        readFileSync(full, "utf8").includes(marker)
      ) {
        return full;
      }
    }
  }
  return null;
}
