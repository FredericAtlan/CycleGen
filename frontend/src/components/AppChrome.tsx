"use client";

import type { ReactNode } from "react";
import AppHeader from "@/components/AppHeader";
import HelpDrawer from "@/components/HelpDrawer";
import { HelpProvider } from "@/components/HelpContext";
import { HeaderChromeProvider } from "@/components/HeaderChromeContext";
import { GlobalWarningsProvider } from "@/components/GlobalWarningsContext";
import {
  ApiConsoleProvider,
  useApiConsole,
} from "@/components/ApiConsoleContext";
import ApiConsolePanel from "@/components/ApiConsolePanel";

function ApiConsoleHost() {
  const { open, setOpen } = useApiConsole();
  return <ApiConsolePanel open={open} onOpenChange={setOpen} />;
}

export default function AppChrome({ children }: { children: ReactNode }) {
  return (
    <HelpProvider>
      <HeaderChromeProvider>
        <GlobalWarningsProvider>
          <ApiConsoleProvider>
            <div className="relative flex h-dvh flex-col overflow-hidden bg-slate-100">
              <AppHeader />
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {children}
              </div>
              <HelpDrawer />
              <ApiConsoleHost />
            </div>
          </ApiConsoleProvider>
        </GlobalWarningsProvider>
      </HeaderChromeProvider>
    </HelpProvider>
  );
}
