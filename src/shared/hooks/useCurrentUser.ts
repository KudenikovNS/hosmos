"use client";

import { useSession } from "./useSession";

interface CurrentUser {
  email: string;
  name: string;
  initials: string;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.substring(0, 2).toUpperCase() || "??";
}

export function useCurrentUser(): CurrentUser {
  const { data } = useSession();
  const email = data?.email ?? "";
  const name = data?.name ?? "";
  return { email, name, initials: name ? getInitials(name) : "??" };
}
