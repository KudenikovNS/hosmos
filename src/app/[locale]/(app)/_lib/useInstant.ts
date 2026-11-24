"use client";

import { useFormatter } from "next-intl";

/** An ISO instant as a localised date-time, or an em dash. */
export function useInstant(): (iso: string | null) => string {
  const format = useFormatter();
  return (iso) =>
    iso
      ? format.dateTime(new Date(iso), {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "—";
}
