"use client";

import { clsx } from "clsx";
import styles from "./Badge.module.css";

interface BadgeProps {
  children: React.ReactNode;
  variant?: "blue" | "violet" | "green" | "red" | "gray" | "yellow";
  size?: "sm" | "md";
}

export function Badge({ children, variant = "blue", size = "sm" }: BadgeProps) {
  return (
    <span className={clsx(styles.badge, styles[variant], styles[size])}>
      {children}
    </span>
  );
}
