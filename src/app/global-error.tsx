"use client";

// =============================================================================
// THE LAST RESORT (партия 19) — a crash in the LOCALE LAYOUT itself, where
// `[locale]/error.tsx` cannot render because the provider it needs is the thing
// that died. Next replaces the whole document here, so this file owns <html>
// and <body>, and it cannot read the message catalogue: the copy is inline, in
// the app's two report languages (Slovene first — the market), with no styling
// beyond what is written here.
// =============================================================================
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="sl" translate="no">
      <body className="notranslate">
        <main
          role="alert"
          style={{
            maxWidth: "36rem",
            margin: "12vh auto",
            padding: "1.5rem",
            fontFamily: "system-ui, sans-serif",
            lineHeight: 1.55,
            color: "#111827",
          }}
        >
          <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>
            Nekaj je šlo narobe / Something went wrong
          </h1>
          <p style={{ margin: "0 0 1rem" }}>
            Zaslon se ni mogel izrisati. Poskusite znova; če se ponovi, osvežite
            stran in izklopite samodejno prevajanje strani v brskalniku — jezik
            izberite v aplikaciji.
            <br />
            The screen failed to render. Try again; if it repeats, reload the
            page and turn off the browser&apos;s automatic page translation —
            pick the language inside the app instead.
          </p>
          <button
            onClick={() => reset()}
            style={{
              padding: "0.5rem 0.9rem",
              borderRadius: "0.5rem",
              border: "1px solid #111827",
              background: "#111827",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            Poskusi znova / Try again
          </button>
          {error.digest && (
            <p
              style={{
                marginTop: "1rem",
                fontSize: "0.8rem",
                color: "#6b7280",
              }}
            >
              {error.digest}
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
