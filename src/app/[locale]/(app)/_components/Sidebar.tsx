"use client";

import { useLocale, useTranslations } from "next-intl";
import { clsx } from "clsx";
import { ChevronLeft, Lock, Menu, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { authClient } from "@/server/auth/auth-client";
import { localisedPath } from "@/i18n/localised-path";
import { useCapabilities } from "@/shared/hooks/useCapabilities";
import { usePlan } from "@/shared/hooks/usePlan";
import { useDrawerBehavior } from "@/shared/hooks/useDrawerBehavior";
import { PlanetIcon } from "@/shared/ui/PlanetIcon";
import { Link, usePathname } from "@/i18n/navigation";
import { logOut } from "../_lib/logout";
import { mayOpenNavItem, NAV_ITEMS } from "../_lib/navItems";
import { SidebarAccountMenu } from "./SidebarAccountMenu";
import styles from "./Sidebar.module.css";

export function Sidebar() {
  const pathname = usePathname();
  const t = useTranslations("sidebar");
  const locale = useLocale();
  const tNav = useTranslations("nav");
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { features } = usePlan();
  // A capability-gated entry is HIDDEN, not padlocked (see `NavItem.capability`):
  // a role cannot be upgraded from the billing page, so a lock would point at a
  // remedy that does not exist.
  const caps = useCapabilities();

  const asideRef = useDrawerBehavior<HTMLElement>(mobileOpen, () =>
    setMobileOpen(false),
  );

  // Close the drawer on navigation. Adjusting state during render (keyed on the
  // previous pathname) instead of in an effect: one commit, no cascading render
  // and no frame where the drawer is still open on the new page.
  const [seenPathname, setSeenPathname] = useState(pathname);
  if (pathname !== seenPathname) {
    setSeenPathname(pathname);
    setMobileOpen(false);
  }

  // BUG-001 — see `logOut`: a full load of the login page on success, a
  // visible error (not an unhandled rejection) when the request fails.
  const handleLogout = async () => {
    await logOut({
      signOut: () => authClient.signOut(),
      navigate: (url) => {
        window.location.href = url;
      },
      onFailure: () => toast.error(t("logoutFailed")),
      loginUrl: localisedPath("/login", locale),
    });
  };

  const sidebarContent = (
    <>
      <div className={styles.header}>
        <div className={styles.logo}>
          <PlanetIcon size={28} />
        </div>
        <span className={styles.brand}>Hosmos</span>

        {/* Close drawer — mobile only */}
        <button
          onClick={() => setMobileOpen(false)}
          aria-label={t("closeMenu")}
          className={styles.closeBtn}
        >
          <X size={16} className={styles.iconMuted} />
        </button>

        {/* Collapse — desktop only */}
        <button
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? t("expandSidebar") : t("collapseSidebar")}
          aria-expanded={!collapsed}
          className={styles.collapseBtn}
        >
          <ChevronLeft size={16} className={styles.chevron} />
        </button>
      </div>

      <nav aria-label={t("mainNavigation")} className={styles.nav}>
        {NAV_ITEMS.filter(
          (item) => item.placement !== "account" && mayOpenNavItem(item, caps),
        ).map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + "/");
          const isLocked = item.feature ? !features[item.feature] : false;
          const itemClass = isLocked
            ? styles.navItemLocked
            : isActive
              ? styles.navItemActive
              : styles.navItemDefault;
          const iconClass = isLocked
            ? styles.navIconLocked
            : isActive
              ? styles.navIconActive
              : styles.navIconDefault;
          return (
            <Link
              key={item.href}
              href={isLocked ? "/settings" : item.href}
              aria-current={isActive ? "page" : undefined}
              className={clsx(styles.navItem, itemClass)}
            >
              <item.icon
                size={20}
                className={clsx(styles.navIcon, iconClass)}
              />
              <span className={styles.navLabel}>{tNav(item.labelKey)}</span>
              {isLocked && <Lock size={12} className={styles.lockIcon} />}
            </Link>
          );
        })}
      </nav>

      <SidebarAccountMenu
        key={`${pathname}:${collapsed}:${mobileOpen}`}
        onNavigate={() => setMobileOpen(false)}
        onLogout={handleLogout}
      />
    </>
  );

  return (
    <>
      <button
        onClick={() => setMobileOpen(true)}
        aria-label={t("openMenu")}
        className={styles.menuBtn}
      >
        <Menu size={20} className={styles.iconDark} />
      </button>

      {mobileOpen && (
        <div
          aria-hidden="true"
          className={styles.overlay}
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        ref={asideRef}
        className={clsx(
          styles.aside,
          mobileOpen && styles.open,
          collapsed && styles.collapsed,
        )}
      >
        {sidebarContent}
      </aside>
    </>
  );
}
