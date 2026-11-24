"use client";

import { clsx } from "clsx";
import { ChevronUp, LogOut } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { Link, usePathname } from "@/i18n/navigation";
import { useCapabilities } from "@/shared/hooks/useCapabilities";
import { useCurrentUser } from "@/shared/hooks/useCurrentUser";

import { mayOpenNavItem, NAV_ITEMS } from "../_lib/navItems";
import styles from "./Sidebar.module.css";

export function SidebarAccountMenu({
  onNavigate,
  onLogout,
}: {
  onNavigate: () => void;
  onLogout: () => Promise<void>;
}) {
  const t = useTranslations("sidebar");
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const pathname = usePathname();
  const caps = useCapabilities();
  const { name, email, initials } = useCurrentUser();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      // On mobile, close this disclosure before closing the entire drawer.
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div
      className={styles.footer}
      ref={rootRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        ref={triggerRef}
        className={styles.userRow}
        aria-label={t("accountMenu")}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={t("accountMenu")}
        onClick={() => setOpen((was) => !was)}
      >
        <span className={styles.avatar} aria-hidden="true">
          <span className={styles.initials}>{initials}</span>
        </span>
        <span className={styles.userDetails}>
          <span className={styles.userText}>
            <span className={styles.userName}>{name || tCommon("user")}</span>
            <span className={styles.userEmail}>{email}</span>
          </span>
          <ChevronUp
            size={16}
            aria-hidden="true"
            className={clsx(
              styles.accountChevron,
              open && styles.accountChevronOpen,
            )}
          />
        </span>
      </button>

      {open && (
        <nav
          id={panelId}
          aria-label={t("accountMenu")}
          className={styles.accountPanel}
        >
          {NAV_ITEMS.filter(
            (item) =>
              item.placement === "account" && mayOpenNavItem(item, caps),
          ).map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                className={clsx(
                  styles.accountItem,
                  active && styles.accountItemActive,
                )}
                aria-current={active ? "page" : undefined}
                onClick={() => {
                  setOpen(false);
                  onNavigate();
                }}
              >
                <item.icon size={18} aria-hidden="true" />
                {tNav(item.labelKey)}
              </Link>
            );
          })}
          <div className={styles.accountDivider} />
          <button
            type="button"
            className={clsx(styles.accountItem, styles.logoutItem)}
            onClick={async () => {
              setOpen(false);
              await onLogout();
            }}
          >
            <LogOut size={18} aria-hidden="true" />
            {t("logout")}
          </button>
        </nav>
      )}
    </div>
  );
}
