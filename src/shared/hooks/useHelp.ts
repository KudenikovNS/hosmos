"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";

/**
 * Партия 22 — «what goes in this field», by field name.
 *
 * A form asks for `help(...)` by the SAME key it already uses for the label, so
 * an explanation is added by writing one message and nothing else: no prop
 * threading, no per-field component. A key with no message returns `undefined`,
 * and `HelpTip` renders nothing for it — which is why a field may be annotated
 * in one language before the others without the form changing shape.
 */
export function useHelp(
  namespace: string,
): (key: string) => string | undefined {
  const t = useTranslations(namespace);
  return useCallback((key: string) => (t.has(key) ? t(key) : undefined), [t]);
}
