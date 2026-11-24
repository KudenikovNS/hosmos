/**
 * The hero's product panel — variant 2 (ТЗ §3 "Hero UI").
 *
 * §3 offers a choice: real product interface, or a neutral schematic. Variant 1
 * took the schematic because `productScreenshots` is off. This variant takes the
 * other branch, and the distinction that makes it honest is narrow but real:
 *
 *   • The STRUCTURE is the shipped product's. The eleven Basic disclosures, the
 *     Scope 1 / 2 / 3 split, the actual-versus-estimated flag, the evidence
 *     counter and the factor/method/source line are the fields the platform
 *     genuinely has — the same ones `metric_catalog`, the calculation engine and
 *     the evidence trail expose today.
 *   • The NUMBERS are labelled as an example, in visible text, right under the
 *     panel. §3 forbids invented KPIs; it does not forbid demo data, and every
 *     product screenshot in the industry is demo data. What separates the two is
 *     whether the reader is told. They are told.
 *
 * It is a server component of plain markup — no screenshot, no canvas, no
 * client JavaScript. That matters for the §13 mobile LCP budget: this panel is
 * the largest element in the viewport, so it must paint with the HTML rather
 * than after an image or a hydration pass.
 *
 * KNOWN GAP, deliberately surfaced rather than hidden: the shipped
 * `metric_catalog` carries RU/EN disclosure titles only. The Slovenian names
 * used here come from the EFRAG VSME standard, so the panel is ahead of the
 * product's own SL localisation. Translating the catalogue is a separate task,
 * and until it lands this panel shows the standard's wording rather than a
 * screenshot of an SL screen that does not yet exist.
 */
import { Check, FileText, Paperclip } from "lucide-react";

import styles from "./ProductPreview.module.css";

export interface ProductPreviewCopy {
  caption: string;
  exampleNote: string;
  period: string;
  periodValue: string;
  progress: string;
  moduleBasic: string;
  emissions: string;
  scope1: string;
  scope1Note: string;
  scope2: string;
  scope2Note: string;
  scope3: string;
  scope3Note: string;
  actual: string;
  estimated: string;
  evidence: string;
  evidenceValue: string;
  disclosures: string[];
}

/**
 * Which of the eleven disclosures read as complete in the example. Chosen to
 * show a report MID-FLIGHT rather than a finished one: a panel where every row
 * is ticked says "this is a mockup", while a partly-filled one says "this is
 * what your Tuesday looks like" — and it is also what makes the 23/29 evidence
 * counter and the 72% progress bar consistent with each other.
 */
const COMPLETE_THROUGH = 7;
/** The row drawn as "open" — the one the user would be working on. */
const ACTIVE_INDEX = 2;
const PROGRESS_PERCENT = 72;

export function ProductPreview({ copy }: { copy: ProductPreviewCopy }) {
  return (
    <figure className={styles.wrap}>
      <div className={styles.panel}>
        {/* Window chrome: period + progress, as the real report header shows. */}
        <div className={styles.head}>
          <div className={styles.headBlock}>
            <span className={styles.headLabel}>{copy.period}</span>
            <span className={styles.headValue}>{copy.periodValue}</span>
          </div>
          <div className={styles.headProgress}>
            <span className={styles.headLabel}>{copy.progress}</span>
            <span className={styles.bar} aria-hidden="true">
              <span
                className={styles.barFill}
                style={{ width: `${PROGRESS_PERCENT}%` }}
              />
            </span>
            <span className={styles.headValue}>{PROGRESS_PERCENT} %</span>
          </div>
        </div>

        <div className={styles.body}>
          {/* Left: the B1–B11 checklist. */}
          <div className={styles.col}>
            <p className={styles.colTitle}>{copy.moduleBasic}</p>
            <ul className={styles.list}>
              {copy.disclosures.map((label, index) => {
                const done = index < COMPLETE_THROUGH;
                const active = index === ACTIVE_INDEX;
                return (
                  <li
                    key={label}
                    className={
                      active ? `${styles.row} ${styles.rowActive}` : styles.row
                    }
                  >
                    <span
                      className={done ? styles.tickDone : styles.tickOpen}
                      aria-hidden="true"
                    >
                      {done && <Check size={11} strokeWidth={3} />}
                    </span>
                    <span className={styles.rowLabel}>{label}</span>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Right: emissions, the actual/estimated flag, and evidence. */}
          <div className={styles.col}>
            <p className={styles.colTitle}>{copy.emissions}</p>
            <div className={styles.scopeGrid}>
              <ScopeCard
                name={copy.scope1}
                note={copy.scope1Note}
                value="12,87"
                badge={copy.actual}
                tone="actual"
              />
              <ScopeCard
                name={copy.scope2}
                note={copy.scope2Note}
                value="86,41"
                badge={copy.actual}
                tone="actual"
              />
              <ScopeCard
                name={copy.scope3}
                note={copy.scope3Note}
                value="363,61"
                // §6: the estimated status must stay visible in the UI, so the
                // panel that advertises the product shows it too.
                badge={copy.estimated}
                tone="estimated"
              />
            </div>

            <div className={styles.evidence}>
              <div className={styles.evidenceHead}>
                <Paperclip size={13} aria-hidden="true" />
                <span className={styles.evidenceLabel}>{copy.evidence}</span>
                <span className={styles.evidenceValue}>
                  {copy.evidenceValue}
                </span>
              </div>
              <div className={styles.evidenceFiles}>
                <span className={styles.file}>
                  <FileText size={12} aria-hidden="true" />
                  Racun_Elektro_2024-12.pdf
                </span>
                <span className={styles.file}>
                  <FileText size={12} aria-hidden="true" />
                  Gorivo_2024.xlsx
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* The label that makes the demo data honest (§3). Visible text, not a
          tooltip and not a footnote three sections away. */}
      <figcaption className={styles.caption}>
        <strong>{copy.caption}</strong> {copy.exampleNote}
      </figcaption>
    </figure>
  );
}

function ScopeCard({
  name,
  note,
  value,
  badge,
  tone,
}: {
  name: string;
  note: string;
  value: string;
  badge: string;
  tone: "actual" | "estimated";
}) {
  return (
    <div className={styles.scopeCard}>
      <span className={styles.scopeName}>{name}</span>
      <span className={styles.scopeNote}>{note}</span>
      <span className={styles.scopeValue}>
        {value}
        <span className={styles.scopeUnit}>
          {" "}
          tCO<sub>2</sub>e
        </span>
      </span>
      <span
        className={
          tone === "actual"
            ? `${styles.scopeBadge} ${styles.scopeBadgeActual}`
            : `${styles.scopeBadge} ${styles.scopeBadgeEstimated}`
        }
      >
        {badge}
      </span>
    </div>
  );
}
