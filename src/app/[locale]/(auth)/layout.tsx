import { LanguageSwitcher } from "@/i18n/LanguageSwitcher";
import styles from "./layout.module.css";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <div className={styles.switcher}>
        <LanguageSwitcher />
      </div>
      {children}
    </>
  );
}
