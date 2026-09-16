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
import type { HelpTab } from "@/lib/helpDocs";

type HelpContextValue = {
  open: boolean;
  tab: HelpTab;
  studioStep: StudioWizardStep;
  setStudioStep: (step: StudioWizardStep) => void;
  openHelp: (opts?: { tab?: HelpTab; step?: StudioWizardStep }) => void;
  closeHelp: () => void;
  setTab: (tab: HelpTab) => void;
};

const HelpContext = createContext<HelpContextValue | null>(null);

export function HelpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<HelpTab>("step");
  const [studioStep, setStudioStep] = useState<StudioWizardStep>(1);

  const openHelp = useCallback(
    (opts?: { tab?: HelpTab; step?: StudioWizardStep }) => {
      if (opts?.step != null) setStudioStep(opts.step);
      if (opts?.tab) setTab(opts.tab);
      else if (opts?.step != null) setTab("step");
      setOpen(true);
    },
    []
  );

  const closeHelp = useCallback(() => setOpen(false), []);

  const value = useMemo(
    () => ({
      open,
      tab,
      studioStep,
      setStudioStep,
      openHelp,
      closeHelp,
      setTab,
    }),
    [open, tab, studioStep, openHelp, closeHelp]
  );

  return (
    <HelpContext.Provider value={value}>{children}</HelpContext.Provider>
  );
}

export function useHelp(): HelpContextValue {
  const ctx = useContext(HelpContext);
  if (!ctx) {
    throw new Error("useHelp must be used within HelpProvider");
  }
  return ctx;
}

/** Safe for optional chrome (returns null outside provider). */
export function useHelpOptional(): HelpContextValue | null {
  return useContext(HelpContext);
}
