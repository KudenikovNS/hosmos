"use client";

// =============================================================================
// The no-company gate (BUG-004): an account that is signed in but has no
// active company gets a "create your company" step instead of the screen it
// asked for.
//
// Every product screen reads its data through the active company, so without
// one each of them rendered empty — no data, no hint, no way forward. The
// account reaches this state when the company step of registration did not
// finish (a failure before its retry, a closed tab, a sign-up through email
// verification, which never runs that step, or an empty company name).
//
// The step is the same `POST /api/register` the registration form calls: it
// creates the company, the owner membership and the profile link in one
// transaction, and hands an account that already has an active company that
// company instead of a second one (F11), so a double submit is harmless. An
// account whose only memberships are suspended gets FORBIDDEN and is told to
// contact its administrator. Success refetches the session; the new company id
// then remounts the page under `CompanyContent`.
// =============================================================================
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Building2 } from "lucide-react";

import { apiFetch } from "@/shared/api/client";
import { SESSION_QUERY_KEY, useSession } from "@/shared/hooks/useSession";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";

import { PageLayout } from "./PageLayout";
import { Muted, SectionCard } from "./ScreenKit";
import styles from "./NoCompanyGate.module.css";

type Problem = "nameRequired" | "failed" | "suspended" | null;

export function NoCompanyGate({ children }: { children: React.ReactNode }) {
  const { data } = useSession();
  // Only a loaded, signed-in session without a company is gated. While the
  // session loads, or when it could not be read, the page keeps its own
  // loading and error handling.
  if (!data || data.company) return <>{children}</>;
  return <CreateCompany />;
}

function CreateCompany() {
  const t = useTranslations("common.noCompany");
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<Problem>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const company = name.trim();
    if (!company) {
      setProblem("nameRequired");
      return;
    }
    setSaving(true);
    setProblem(null);
    let result: { ok: boolean; error?: string } | null = null;
    try {
      result = await apiFetch<{ ok: boolean; error?: string }>(
        "/api/register",
        { method: "POST", body: JSON.stringify({ company }) },
      );
    } catch {
      result = null;
    }
    if (result?.ok) {
      // The refetched session carries the company; the gate then steps aside.
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      return;
    }
    setProblem(result?.error === "FORBIDDEN" ? "suspended" : "failed");
    setSaving(false);
  };

  return (
    <PageLayout title={t("title")} subtitle={t("subtitle")}>
      <SectionCard
        icon={<Building2 size={20} aria-hidden="true" />}
        title={t("cardTitle")}
      >
        <p className={styles.body}>{t("body")}</p>
        <form onSubmit={submit} className={styles.form} noValidate>
          <Input
            label={t("nameLabel")}
            placeholder={t("namePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={problem === "nameRequired" ? t("nameRequired") : undefined}
            required
          />
          {(problem === "failed" || problem === "suspended") && (
            <p role="alert" className={styles.error}>
              {t(problem)}
            </p>
          )}
          <div>
            <Button type="submit" loading={saving}>
              {t("create")}
            </Button>
          </div>
        </form>
        <Muted>{t("invited")}</Muted>
      </SectionCard>
    </PageLayout>
  );
}
