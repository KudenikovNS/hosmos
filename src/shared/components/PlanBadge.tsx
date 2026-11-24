"use client";

import { Badge } from "@/shared/ui/Badge";
import {
  getPlanBadgeVariant,
  getPlanFeatures,
  type PlanId,
} from "@/shared/plans";

interface PlanBadgeProps {
  plan: PlanId;
  size?: "sm" | "md";
}

// T-A5 (§13.2): the tier badge shared by reports/settings/TopBar, extracted so
// the plan → colour → label mapping lives in one place. Thin wrapper over the
// existing <Badge> — same visual language, no new one.
export function PlanBadge({ plan, size = "sm" }: PlanBadgeProps) {
  return (
    <Badge variant={getPlanBadgeVariant(plan)} size={size}>
      {getPlanFeatures(plan).name}
    </Badge>
  );
}
