"use client";

/**
 * The one place the lead dialog lives, and the button that opens it.
 *
 * WHY A PROVIDER RATHER THAN A DIALOG PER SECTION
 * -----------------------------------------------
 * Seven places on the page open a form: the header, both hero CTAs, three
 * pricing cards, the White Label strip, the VESG block and the final CTA. If
 * each rendered its own dialog, the page would ship seven copies of the form and
 * seven focus traps, and two of them could be open at once. One provider holds
 * the single dialog; the CTAs only say what to open.
 *
 * The dialog itself is `next/dynamic` with `ssr:false` — it is not part of the
 * first paint, it is never in the server HTML, and its JavaScript is not
 * downloaded until someone actually asks for a form. That is a direct answer to
 * §13's mobile LCP budget: the heaviest interactive component on the page costs
 * nothing until it is wanted.
 *
 * `LeadProvider` wraps SERVER-rendered children. That is allowed and deliberate:
 * children arrive as an already-rendered prop, so the whole page does not become
 * a client component just because a button in it can open a modal.
 */

import dynamic from "next/dynamic";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { Button } from "@/shared/ui/Button";
import { track, type LandingEvent } from "@/shared/analytics";

import type { FormCopy } from "./copy";
import type { LeadRequest } from "./LeadDialog";

const LeadDialog = dynamic(
  () => import("./LeadDialog").then((m) => m.LeadDialog),
  { ssr: false },
);

interface LeadContextValue {
  open: (request: LeadRequest) => void;
}

const LeadContext = createContext<LeadContextValue | null>(null);

/**
 * Open the lead dialog from anywhere inside the provider. Returns a no-op
 * outside it rather than throwing: a CTA rendered outside the provider is a
 * layout mistake, and taking the whole page down with an exception is a worse
 * answer to it than a button that does nothing and says so in the console.
 */
function useLead(): LeadContextValue {
  const value = useContext(LeadContext);
  return (
    value ?? {
      open: () => {
        console.warn(
          "[landing] a lead CTA was rendered outside <LeadProvider>",
        );
      },
    }
  );
}

export function LeadProvider({
  children,
  copy,
  locale,
  privacyHref,
  landingVersion,
}: {
  children: ReactNode;
  copy: FormCopy;
  locale: string;
  privacyHref: string;
  /** Named by the page, so a lead records which variant produced it (§11). */
  landingVersion: string;
}) {
  const [request, setRequest] = useState<LeadRequest | null>(null);

  const open = useCallback((next: LeadRequest) => setRequest(next), []);
  const close = useCallback(() => setRequest(null), []);
  const value = useMemo(() => ({ open }), [open]);

  return (
    <LeadContext.Provider value={value}>
      {children}
      {request && (
        <LeadDialog
          request={request}
          copy={copy}
          locale={locale}
          privacyHref={privacyHref}
          landingVersion={landingVersion}
          onClose={close}
        />
      )}
    </LeadContext.Provider>
  );
}

/**
 * A CTA that opens a lead form and reports the click.
 *
 * The analytics event is a PROP rather than something the button infers from
 * where it sits: §12 gives `hero_cta_click`, `pricing_cta_click` and
 * `vesg_cta_click` distinct names and distinct parameters, and a component that
 * guessed which one it was would be wrong the first time a CTA moved.
 */
export function LeadCta({
  form,
  plan,
  placement,
  event,
  eventParams,
  variant = "primary",
  size = "md",
  className,
  children,
}: {
  form: LeadRequest["form"];
  plan?: string;
  placement: string;
  event: LandingEvent;
  eventParams?: Record<string, string>;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  className?: string;
  children: ReactNode;
}) {
  const { open } = useLead();
  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      onClick={() => {
        track(event, { placement, plan, ...eventParams });
        open({ form, plan, placement });
      }}
    >
      {children}
    </Button>
  );
}
