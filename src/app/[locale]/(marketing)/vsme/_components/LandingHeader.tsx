"use client";

/**
 * Sticky header with the permanent Demo CTA (ТЗ §3 "Навигация").
 *
 * §3 asks for three specific behaviours, and each one is here for a reason the
 * default would get wrong:
 *   • "Sticky после прокрутки 80 px" — the header is sticky from the start but
 *     only grows its border and shadow after 80 px, so the hero is not framed by
 *     a chrome bar at rest.
 *   • "компактная мобильная шторка" — a drawer, not a full-screen takeover.
 *   • "Escape закрывает меню" — and focus goes back to the burger, otherwise a
 *     keyboard user who closes the menu lands at the top of the document.
 *
 * The login link is gated on a feature flag (§3: show it "только если рабочий
 * маршрут существует"), and the flag is read on the server and passed in, so a
 * disabled route is absent from the HTML rather than hidden with CSS.
 */

import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";

import { Link } from "@/i18n/navigation";
import { LanguageSwitcher } from "@/i18n/LanguageSwitcher";
import { PlanetIcon } from "@/shared/ui/PlanetIcon";
import { Button } from "@/shared/ui/Button";
import { track } from "@/shared/analytics";

import { LeadCta } from "./LeadProvider";
import type { NavCopy } from "./copy";
import styles from "./LandingHeader.module.css";

/** Anchor targets, in the order §3 lists them. */
const SECTIONS = [
  { id: "features", key: "features" },
  { id: "process", key: "process" },
  { id: "pricing", key: "pricing" },
  { id: "vesg", key: "vesg" },
  { id: "faq", key: "faq" },
] as const;

export function LandingHeader({
  copy,
  showLogin,
}: {
  copy: NavCopy;
  showLogin: boolean;
}) {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const burgerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // `passive` because the handler never calls preventDefault — without it the
    // browser must wait for this listener before it can scroll.
    const onScroll = () => setScrolled(window.scrollY > 80);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      // Return focus to the control that opened the drawer (§13 focus order).
      burgerRef.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  function onNavClick(id: string) {
    track("nav_click", { item: id, destination: `#${id}` });
    setMenuOpen(false);
  }

  const label = (key: (typeof SECTIONS)[number]["key"]) => copy[key];

  return (
    <header
      className={scrolled ? `${styles.nav} ${styles.navScrolled}` : styles.nav}
    >
      <div className={styles.inner}>
        <Link href="/vsme" className={styles.brandLink}>
          <span className={styles.logo}>
            <PlanetIcon size={28} />
          </span>
          <span className={styles.brand}>Hosmos</span>
        </Link>

        <nav className={styles.links} aria-label={copy.aria}>
          {SECTIONS.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className={styles.link}
              onClick={() => onNavClick(section.id)}
            >
              {label(section.key)}
            </a>
          ))}
          {/* Партия 22 — the one nav item that is a PAGE, not an anchor: the
              articles live on their own route, so the landing's scroll-spy
              behaviour does not apply to them. */}
          <Link
            href="/articles"
            className={styles.link}
            onClick={() =>
              track("nav_click", { item: "articles", destination: "/articles" })
            }
          >
            {copy.articles}
          </Link>
        </nav>

        <div className={styles.actions}>
          <span className={styles.langDesktop}>
            <LanguageSwitcher />
          </span>
          {showLogin && (
            <Link href="/login" className={styles.loginLink}>
              <Button variant="ghost" size="sm">
                {copy.logIn}
              </Button>
            </Link>
          )}
          <LeadCta
            form="demo"
            placement="header"
            event="nav_click"
            eventParams={{ item: "demo_cta", destination: "lead_demo" }}
            size="sm"
          >
            {copy.demoCta}
          </LeadCta>
          <button
            ref={burgerRef}
            type="button"
            className={styles.burger}
            aria-label={menuOpen ? copy.close : copy.open}
            aria-expanded={menuOpen}
            aria-controls="vsme-mobile-menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? (
              <X size={22} aria-hidden="true" />
            ) : (
              <Menu size={22} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {menuOpen && (
        <nav
          id="vsme-mobile-menu"
          className={styles.drawer}
          aria-label={copy.aria}
        >
          {SECTIONS.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className={styles.drawerLink}
              onClick={() => onNavClick(section.id)}
            >
              {label(section.key)}
            </a>
          ))}
          <Link
            href="/articles"
            className={styles.drawerLink}
            onClick={() => setMenuOpen(false)}
          >
            {copy.articles}
          </Link>
          {showLogin && (
            <Link
              href="/login"
              className={styles.drawerLogin}
              onClick={() => onNavClick("login")}
            >
              {copy.logIn}
            </Link>
          )}
          <div className={styles.drawerFooter}>
            <LanguageSwitcher variant="block" />
          </div>
        </nav>
      )}
    </header>
  );
}
