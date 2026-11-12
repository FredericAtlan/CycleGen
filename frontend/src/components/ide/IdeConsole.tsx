"use client";

import { useGlobalWarningsOptional } from "@/components/GlobalWarningsContext";
import { useWorkspaceStore } from "@/lib/workspaceStore";

export default function IdeConsole() {
  const lines = useWorkspaceStore((s) => s.consoleLines);
  const clearConsole = useWorkspaceStore((s) => s.clearConsole);
  const warnings = useGlobalWarningsOptional()?.warnings ?? [];

  return (
    <div
      data-testid="ide-console"
      className="flex h-full min-h-0 flex-col bg-slate-950 text-slate-200"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-slate-800 px-2.5 py-1.5">
        <span className="text-[11px] font-semibold text-slate-300">
          Journal
          {warnings.length > 0 ? (
            <span className="ml-2 font-mono text-[10px] text-amber-400">
              {warnings.length} warning
              {warnings.length > 1 ? "s" : ""}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={clearConsole}
          className="text-[10px] text-slate-500 hover:text-slate-300"
        >
          Effacer
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1 font-mono text-[10px] leading-relaxed tabular-nums">
        {warnings.slice(0, 20).map((w, i) => (
          <div key={`w-${i}`} className="text-amber-400/90">
            WARN {w.code} · {w.message}
          </div>
        ))}
        {lines.map((line, i) => (
          <div key={`l-${i}`} className="text-slate-400">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
