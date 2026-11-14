"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { CycleGenWarning } from "@/lib/types";

type GlobalWarningsContextValue = {
  warnings: CycleGenWarning[];
  setWarnings: (next: CycleGenWarning[]) => void;
};

const GlobalWarningsContext =
  createContext<GlobalWarningsContextValue | null>(null);

export function GlobalWarningsProvider({ children }: { children: ReactNode }) {
  const [warnings, setWarningsState] = useState<CycleGenWarning[]>([]);
  const setWarnings = useCallback((next: CycleGenWarning[]) => {
    setWarningsState(Array.isArray(next) ? next : []);
  }, []);
  const value = useMemo(
    () => ({ warnings, setWarnings }),
    [warnings, setWarnings]
  );
  return (
    <GlobalWarningsContext.Provider value={value}>
      {children}
    </GlobalWarningsContext.Provider>
  );
}

export function useGlobalWarnings(): GlobalWarningsContextValue {
  const ctx = useContext(GlobalWarningsContext);
  if (!ctx) {
    throw new Error(
      "useGlobalWarnings must be used within GlobalWarningsProvider"
    );
  }
  return ctx;
}

export function useGlobalWarningsOptional(): GlobalWarningsContextValue | null {
  return useContext(GlobalWarningsContext);
}
