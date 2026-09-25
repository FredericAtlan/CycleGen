"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type ApiConsoleCtx = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
};

const Ctx = createContext<ApiConsoleCtx | null>(null);

export function ApiConsoleProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const value = useMemo(() => ({ open, setOpen, toggle }), [open, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApiConsole(): ApiConsoleCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useApiConsole must be used within ApiConsoleProvider");
  }
  return ctx;
}

export function useApiConsoleOptional(): ApiConsoleCtx | null {
  return useContext(Ctx);
}
