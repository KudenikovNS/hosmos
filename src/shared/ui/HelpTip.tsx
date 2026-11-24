"use client";

// =============================================================================
// «WHAT GOES IN THIS FIELD?» — THE ICON THAT ANSWERS IT (партия 22).
//
// The owner's report: «не очень понятно, что заполнять». The catalogue screens
// already carry a hint under the control (партия 18), but the rest of the
// product — organisation, inventory, evidence — shows a bare label, and a bare
// label is only obvious to whoever wrote it. This is the affordance that puts
// an explanation beside EVERY field that has one, without turning the form into
// a manual: a small question mark next to the label, and the text on click.
//
// WHY A BUTTON AND A PANEL, NOT `title=""`. A native tooltip never appears on a
// touch screen, cannot be reached from the keyboard, and disappears while it is
// being read. This one is a real toggle: `aria-expanded` says whether it is
// open, the panel is referenced by `aria-describedby` so a screen reader
// announces it as the field's description, Escape closes it, and a click
// elsewhere closes it too.
//
// It renders NOTHING when there is no text, so a field without an explanation
// costs nothing and shows nothing.
// =============================================================================
import { HelpCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import styles from "./HelpTip.module.css";

export function HelpTip({
  text,
  children,
  label,
}: {
  /** The one-line answer. Omit when `children` carries richer content. */
  text?: string | null;
  children?: ReactNode;
  /** Accessible name of the button; defaults to the shared «Help» string. */
  label?: string;
}) {
  const t = useTranslations("common");
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onClick = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  if (!text && !children) return null;

  return (
    <span className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.button}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label ?? t("help")}
        onClick={() => setOpen((was) => !was)}
      >
        <HelpCircle size={14} aria-hidden="true" />
      </button>
      {open && (
        <span className={styles.panel} id={panelId} role="note">
          {text ? <span className={styles.text}>{text}</span> : null}
          {children}
        </span>
      )}
    </span>
  );
}
