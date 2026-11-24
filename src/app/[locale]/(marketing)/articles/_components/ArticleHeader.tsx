/**
 * The header of an article page (партия 22).
 *
 * Deliberately NOT the landing's sticky header: that one is a client island fed
 * with a whole slice of landing copy as props, and an article page needs three
 * things — the way home, the way to the other articles, and the language. Keeping
 * it separate is also why an article route can be rendered without loading the
 * landing's message file at all.
 */
import { Link } from "@/i18n/navigation";
import { LanguageSwitcher } from "@/i18n/LanguageSwitcher";
import { PlanetIcon } from "@/shared/ui/PlanetIcon";

import styles from "./ArticleHeader.module.css";

export function ArticleHeader({ backLabel }: { backLabel: string }) {
  return (
    <header className={styles.nav}>
      <div className={styles.inner}>
        <Link href="/vsme" className={styles.brandLink}>
          <span className={styles.logo}>
            <PlanetIcon size={26} />
          </span>
          <span className={styles.brand}>Hosmos</span>
        </Link>
        <div className={styles.actions}>
          <Link href="/articles" className={styles.link}>
            {backLabel}
          </Link>
          <LanguageSwitcher />
        </div>
      </div>
    </header>
  );
}
