// =============================================================================
// TYPES FOR `pdfmake/src/printer` — the SERVER half of pdfmake.
//
// `@types/pdfmake` describes the BROWSER entry point (`createPdf`, the global
// `pdfMake`, `addVirtualFileSystem`) because that is what the package's own
// `main` resolves to. The Node-side class lives at an unbundled CJS path
// (`pdfmake/src/printer.js`, `module.exports = PdfPrinter`), which the published
// types do not cover at all — and R-9 is precisely about that path.
//
// So the declaration is written here rather than suppressed at the call site.
// The alternative would have been a compiler suppression over the import, which
// §0.2's counters forbid growing, and rightly: an untyped `createPdfKitDocument`
// is how a document definition with a misspelled font name reaches production as
// a runtime throw. (The counter is a `grep`, so the token is not spelled out
// here either — a comment that mentions it costs the same as one that uses it.)
//
// The shape is the one pdfmake 0.2.x actually implements: the constructor takes
// a font dictionary whose values may be file paths OR `Buffer`s (this renderer
// passes Buffers, decoded from the Figtree VFS), and `createPdfKitDocument`
// returns a PDFKit document, which is a readable stream that must be `end()`ed
// before it emits anything.
// =============================================================================
declare module "pdfmake/src/printer" {
  import type { Readable } from "node:stream";
  import type { TDocumentDefinitions } from "pdfmake/interfaces";

  /** One family: the four faces pdfmake selects between by `bold`/`italics`. */
  interface PdfPrinterFontFaces {
    normal: string | Buffer;
    bold: string | Buffer;
    italics: string | Buffer;
    bolditalics: string | Buffer;
  }

  /** `family name → faces`, as `new PdfPrinter(...)` wants it. */
  type PdfPrinterFonts = Record<string, PdfPrinterFontFaces>;

  /** A PDFKit document: a readable stream that produces bytes after `end()`. */
  interface PdfKitDocument extends Readable {
    end(): void;
  }

  class PdfPrinter {
    constructor(fontDescriptors: PdfPrinterFonts);
    createPdfKitDocument(
      docDefinition: TDocumentDefinitions,
      options?: Record<string, unknown>,
    ): PdfKitDocument;
  }

  export = PdfPrinter;
}
