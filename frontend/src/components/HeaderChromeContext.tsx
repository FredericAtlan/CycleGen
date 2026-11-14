"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { StudioWizardStep } from "@/components/StudioStepper";

export type StudioHeaderChrome = {
  kind: "studio";
  activeStep: StudioWizardStep;
  maxUnlocked: StudioWizardStep;
  onStepChange: (step: StudioWizardStep) => void;
  onLeaveToMenu: () => void;
  lockToStep?: StudioWizardStep;
  cycleTitle?: string | null;
};

export type VersusHeaderChrome = {
  kind: "versus";
  xMode: "time" | "distance";
  onXMode: (mode: "time" | "distance") => void;
  onExplorer: () => void;
  onJpeg: () => void;
  jpegBusy: boolean;
  canExplore: boolean;
  onAddCycle: () => void;
};

export type HeaderChrome = StudioHeaderChrome | VersusHeaderChrome;

type HeaderChromeContextValue = {
  chrome: HeaderChrome | null;
  setHeaderChrome: (next: HeaderChrome | null) => void;
};

const HeaderChromeContext = createContext<HeaderChromeContextValue | null>(
  null
);

export function HeaderChromeProvider({ children }: { children: ReactNode }) {
  const [chrome, setChrome] = useState<HeaderChrome | null>(null);
  const setHeaderChrome = useCallback((next: HeaderChrome | null) => {
    setChrome(next);
  }, []);

  const value = useMemo(
    () => ({ chrome, setHeaderChrome }),
    [chrome, setHeaderChrome]
  );

  return (
    <HeaderChromeContext.Provider value={value}>
      {children}
    </HeaderChromeContext.Provider>
  );
}

export function useHeaderChrome(): HeaderChromeContextValue {
  const ctx = useContext(HeaderChromeContext);
  if (!ctx) {
    throw new Error("useHeaderChrome must be used within HeaderChromeProvider");
  }
  return ctx;
}

export function useHeaderChromeOptional(): HeaderChromeContextValue | null {
  return useContext(HeaderChromeContext);
}
