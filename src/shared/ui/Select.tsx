"use client";

import { clsx } from "clsx";
import { useTranslations } from "next-intl";
import { SelectHTMLAttributes, forwardRef } from "react";
import { HelpTip } from "./HelpTip";
import styles from "./Select.module.css";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  /** Партия 22 — see `Input`'s `help`. */
  help?: string;
  options: readonly { value: string; label: string }[] | readonly string[];
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, error, options, help, id, ...props }, ref) => {
    const t = useTranslations("common");
    const selectId = id || label?.toLowerCase().replace(/\s/g, "-");

    return (
      <div className={styles.wrap}>
        {label && (
          <label htmlFor={selectId} className={styles.label}>
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
        <select
          ref={ref}
          id={selectId}
          className={clsx(styles.select, error && styles.error, className)}
          {...props}
        >
          <option value="">{t("selectPlaceholder")}</option>
          {options.map((opt) => {
            const value = typeof opt === "string" ? opt : opt.value;
            const label = typeof opt === "string" ? opt : opt.label;
            return (
              <option key={value} value={value}>
                {label}
              </option>
            );
          })}
        </select>
        {error && <p className={styles.errorText}>{error}</p>}
      </div>
    );
  },
);

Select.displayName = "Select";
