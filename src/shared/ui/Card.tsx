"use client";

import { clsx } from "clsx";
import { HTMLAttributes, forwardRef } from "react";
import styles from "./Card.module.css";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "glass" | "outlined";
  padding?: "sm" | "md" | "lg";
  hover?: boolean;
}

const paddingClass = { sm: styles.padSm, md: styles.padMd, lg: styles.padLg };

export const Card = forwardRef<HTMLDivElement, CardProps>(
  (
    {
      className,
      variant = "default",
      padding = "md",
      hover = false,
      children,
      ...props
    },
    ref,
  ) => {
    return (
      <div
        ref={ref}
        className={clsx(
          styles.card,
          styles[variant],
          // `glass` variant layers the global backdrop utility from globals.css
          variant === "glass" && "glass",
          paddingClass[padding],
          hover && styles.hover,
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  },
);

Card.displayName = "Card";
