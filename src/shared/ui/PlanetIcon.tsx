import Image from "next/image";

import planet from "./planet.webp";

/**
 * The Hosmos planet — the brand mark, from the owner's artwork (10.09.2026):
 * a blue–violet sphere with a tilted ring and three orbits. One WebP with a
 * transparent ground (`planet.webp`, 512²), bundled by the static import so
 * the standalone deploy carries it under `.next/static`; `next.config.mjs`
 * already serves images unoptimised. `src/app/icon.png` / `apple-icon.png`
 * are the favicon cut of the same art (sphere + ring; the thin orbits do not
 * read at 32 px).
 *
 * Decorative everywhere it is used — the word «Hosmos» sits beside it — so
 * `alt=""` and `aria-hidden`.
 */
export function PlanetIcon({ size = 18 }: { size?: number }) {
  return (
    <Image
      src={planet}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      priority={size >= 96}
      style={{ width: size, height: size, display: "block" }}
    />
  );
}
