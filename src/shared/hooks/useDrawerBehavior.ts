"use client";

import { useEffect, useRef } from "react";

/**
 * Modal-drawer a11y behavior: when `enabled`, traps focus inside the
 * container, locks body scroll, closes on Escape, and restores focus to the
 * previously focused element on cleanup. Returns a ref to attach to the
 * drawer container.
 */
export function useDrawerBehavior<T extends HTMLElement>(
  enabled: boolean,
  onClose: () => void,
) {
  const containerRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  // Keep the latest onClose without re-running the main effect (avoids
  // mutating a ref during render — react-hooks/refs).
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const getFocusable = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);

    getFocusable()[0]?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevBodyOverflow;
      previouslyFocused?.focus?.();
    };
  }, [enabled]);

  return containerRef;
}
