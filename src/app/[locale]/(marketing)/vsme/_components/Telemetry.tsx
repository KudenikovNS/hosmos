"use client";

/**
 * The page's telemetry islands (ТЗ §12). Nothing here emits anything until the
 * site-wide cookie banner (`@/shared/consent`) has been answered —
 * `@/shared/analytics` enforces that by queueing.
 */

import { useEffect, useRef, type ReactNode } from "react";

import { track, trackLandingView, type LandingEvent } from "@/shared/analytics";

/** `landing_view`, once per page load (§12). Renders nothing. */
export function PageAnalytics({ locale }: { locale: string }) {
  useEffect(() => {
    trackLandingView(locale);
  }, [locale]);
  return null;
}

/**
 * Fires a view event when at least 50% of the section has been visible for a
 * continuous second (§12's rule for `pricing_view` and `vesg_block_view`).
 *
 * Both halves of that rule matter. Without the 50% threshold a section counts as
 * seen when one pixel of it clips the viewport; without the one-second dwell,
 * scrolling past at speed marks every section as viewed and the "did anyone read
 * the pricing?" question stops having an answer. The timer is cancelled when the
 * section leaves the viewport again, so a fast scroll produces nothing.
 */
export function SectionView({
  event,
  params,
  children,
}: {
  event: LandingEvent;
  params?: Record<string, string>;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const firedRef = useRef(false);

  useEffect(() => {
    const node = ref.current;
    // No IntersectionObserver (very old browsers, some crawlers) simply means no
    // view event — never a broken section.
    if (!node || typeof IntersectionObserver === "undefined") return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !firedRef.current) {
          timer = setTimeout(() => {
            firedRef.current = true;
            track(event, params);
            observer.disconnect();
          }, 1000);
        } else if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(node);
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
    // `params` is a fresh object each render; the event name is the real identity
    // of this observer, so keying the effect on it is both correct and stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event]);

  return <div ref={ref}>{children}</div>;
}
