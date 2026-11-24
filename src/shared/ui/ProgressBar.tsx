"use client";

import { clsx } from "clsx";
import styles from "./ProgressBar.module.css";

interface ProgressBarProps {
  value: number;
  max?: number;
  color?: "blue" | "violet" | "green" | "red";
  size?: "sm" | "md";
  showLabel?: boolean;
  label?: string;
}

export function ProgressBar({
  value,
  max = 100,
  color = "blue",
  size = "md",
  showLabel = false,
  label,
}: ProgressBarProps) {
  const percentage = Math.min(100, Math.max(0, (value / max) * 100));

  return (
    <div className={styles.wrap}>
      {(showLabel || label) && (
        <div className={styles.header}>
          <span className={styles.label}>{label}</span>
          <span className={styles.value}>{Math.round(percentage)}%</span>
        </div>
      )}
      <div className={clsx(styles.track, styles[size])}>
        <div
          className={clsx(styles.bar, styles[color])}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}
