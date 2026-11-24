import Link from "next/link";
import { Crown } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import styles from "./TrialBanner.module.css";

type TrialBannerAction =
  { type: "link"; href: string } | { type: "button"; onClick: () => void };

interface TrialBannerProps {
  title: string;
  description: string;
  actionLabel: string;
  action: TrialBannerAction;
}

export function TrialBanner({
  title,
  description,
  actionLabel,
  action,
}: TrialBannerProps) {
  const button = (
    <Button
      variant="secondary"
      className={styles.actionBtn}
      size="sm"
      onClick={action.type === "button" ? action.onClick : undefined}
    >
      {actionLabel}
    </Button>
  );

  return (
    <div className={styles.banner}>
      <div className={styles.row}>
        <Crown size={28} className={styles.crown} />
        <div className={styles.body}>
          <h3 className={styles.title}>{title}</h3>
          <p className={styles.desc}>{description}</p>
        </div>
        {action.type === "link" ? (
          <Link href={action.href}>{button}</Link>
        ) : (
          button
        )}
      </div>
    </div>
  );
}
