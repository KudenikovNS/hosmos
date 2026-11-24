"use client";

/**
 * FAQ accordion (ТЗ §10, §12 `faq_toggle`, §13 accessibility).
 *
 * Built from `button` + `aria-expanded`/`aria-controls` rather than
 * `<details>/<summary>`, because §13 names that pattern explicitly and because
 * `<details>` gives no place to hang the `faq_toggle` event with a stable
 * `faq_id` that survives reordering the questions.
 *
 * Several answers may be open at once: these are independent objections, and
 * forcing one closed to read another makes comparing two answers impossible.
 *
 * Every answer is in the server HTML, collapsed with the `hidden` ATTRIBUTE
 * rather than dropped from the tree. That is what makes two other requirements
 * true at once: §13's `FAQPage` structured data may only describe text that is
 * actually on the page, and §14's no-JS rule wants the answers readable when the
 * toggles cannot work — the page pairs this with a `<noscript>` rule that
 * overrides `[hidden]` on `[data-faq-panel]`, so a visitor without JavaScript
 * gets all nine answers expanded instead of nine dead buttons.
 */

import { useState } from "react";
import { Plus } from "lucide-react";

import { track } from "@/shared/analytics";

import type { FaqItemCopy } from "./copy";
import styles from "./FaqAccordion.module.css";

export function FaqAccordion({ items }: { items: FaqItemCopy[] }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());

  function toggle(index: number) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
    // `faq_id` is the index, which is stable for a given page version and
    // carries no personal data (§12).
    track("faq_toggle", { faq_id: `faq_${index + 1}` });
  }

  return (
    <div className={styles.list}>
      {items.map((item, index) => {
        const expanded = open.has(index);
        const headerId = `faq-q-${index}`;
        const panelId = `faq-a-${index}`;
        return (
          <div key={item.q} className={styles.item}>
            <h3 className={styles.headerWrap}>
              <button
                type="button"
                id={headerId}
                aria-expanded={expanded}
                aria-controls={panelId}
                className={styles.header}
                onClick={() => toggle(index)}
              >
                <span className={styles.question}>{item.q}</span>
                <Plus
                  size={18}
                  aria-hidden="true"
                  className={
                    expanded ? `${styles.icon} ${styles.iconOpen}` : styles.icon
                  }
                />
              </button>
            </h3>
            <div
              id={panelId}
              role="region"
              aria-labelledby={headerId}
              className={styles.panel}
              data-faq-panel=""
              hidden={!expanded}
            >
              <p className={styles.answer}>{item.a}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
