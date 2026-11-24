"use client";

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { useSession } from "@/shared/hooks/useSession";
import { CompanySaveCoordinator } from "./controller";

const Context = createContext<{
  coordinator: CompanySaveCoordinator;
  busy: boolean;
  setBusy: (busy: boolean) => void;
} | null>(null);

export function CompanySaveProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data } = useSession();
  const companyId = data?.company?.id;
  const [coordinator] = useState(() => new CompanySaveCoordinator(companyId));
  useLayoutEffect(() => {
    coordinator.bind(companyId);
  }, [coordinator, companyId]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (coordinator.pending) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [coordinator]);
  return (
    <Context.Provider value={{ coordinator, busy, setBusy }}>
      {children}
    </Context.Provider>
  );
}

export function useCompanySaves() {
  const value = useContext(Context);
  if (!value) throw new Error("CompanySaveProvider is missing");
  return value;
}

/** Remount all local page state on tenant change; freeze input during the handoff. */
export function CompanyContent({ children }: { children: React.ReactNode }) {
  const { data } = useSession();
  const { busy } = useCompanySaves();
  return (
    <div
      key={`${data?.userId ?? ""}:${data?.company?.id ?? ""}`}
      style={{ display: "contents" }}
      inert={busy}
      aria-busy={busy}
    >
      {children}
    </div>
  );
}
