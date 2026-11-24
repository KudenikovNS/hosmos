"use client";

import { clsx } from "clsx";
import { InputHTMLAttributes, forwardRef } from "react";
import { HelpTip } from "./HelpTip";
import styles from "./Input.module.css";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  unit?: string;
  /**
   * Партия 22 — «what goes in this field», shown behind a question mark next to
   * the label. A `hint` is always visible and short; `help` is the sentence
   * that would make the form noisy if every field printed it.
   */
  help?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, hint, unit, help, id, ...props }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s/g, "-");

    return (
      <div className={styles.wrap}>
        {label && (
          <label htmlFor={inputId} className={styles.label}>
            {label}
            {(props.required ||
              props["aria-required"] === true ||
              props["aria-required"] === "true") && (
              <span className={styles.required} aria-hidden="true">
                {" *"}
              </span>
            )}
            <HelpTip text={help} />
          </label>
        )}
        <div className={styles.field}>
          <input
            ref={ref}
            id={inputId}
            className={clsx(
              styles.input,
              error && styles.error,
              unit && styles.hasUnit,
              className,
            )}
            {...props}
          />
          {unit && <span className={styles.unit}>{unit}</span>}
        </div>
        {hint && !error && <p className={styles.hint}>{hint}</p>}
        {error && <p className={styles.errorText}>{error}</p>}
      </div>
    );
  },
);

Input.displayName = "Input";
