"use client";

/**
 * Warnings bell for the app header (left of Help).
 */

import { useEffect, useState } from "react";
import type { CycleGenWarning } from "@/lib/types";
import { useGlobalWarningsOptional } from "@/components/GlobalWarningsContext";

function formatRange(w: CycleGenWarning): string {
  if (w.s0 === 0 && w.s1 === 0) return "";
  if (Math.abs(w.s0 - w.s1) < 1e-6) return ` @ ${Math.round(w.s0)} m`;
  return ` @ ${Math.round(w.s0)}–${Math.round(w.s1)} m`;
}

export default function WarningsBell() {
  const ctx = useGlobalWarningsOptional();
  const warnings = ctx?.warnings ?? [];
  const n = warnings.length;
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanelOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen]);

  if (n === 0) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setPanelOpen((v) => !v)}
        className={`inline-flex h-8 items-center gap-1 rounded-md border px-2 text-[11px] font-semibold transition ${
          panelOpen
            ? "border-amber-400 bg-amber-100 text-amber-950"
            : "border-amber-200 bg-white text-amber-900 hover:bg-amber-50"
        }`}
        title="Warnings globaux"
        aria-expanded={panelOpen}
        aria-label={`${n} warning${n > 1 ? "s" : ""}`}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        <span className="tabular-nums">{n}</span>
      </button>

      {panelOpen && (
        <div
          className="absolute right-0 top-full z-[1300] mt-1.5 w-[min(92vw,22rem)] rounded-lg border border-amber-200 bg-white shadow-xl"
          role="dialog"
          aria-label="Warnings globaux"
        >
          <div className="flex items-center justify-between border-b border-amber-100 px-3 py-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-amber-900">
              Warnings
              <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] tabular-nums normal-case">
                {n}
              </span>
            </h3>
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              className="flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-100"
              aria-label="Fermer"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                aria-hidden
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <ul className="max-h-64 space-y-1.5 overflow-y-auto p-2">
            {warnings.map((w, i) => (
              <li
                key={`${w.code}-${w.s0}-${w.s1}-${i}`}
                className="rounded border border-amber-100 bg-amber-50/80 px-2 py-1.5 text-[11px] leading-snug text-slate-700"
              >
                <div className="flex flex-wrap items-baseline gap-x-1.5">
                  <span className="font-mono text-[10px] font-semibold uppercase text-amber-800">
                    {w.code}
                  </span>
                  {w.source && (
                    <span className="text-[10px] text-slate-400">{w.source}</span>
                  )}
                  <span className="text-[10px] tabular-nums text-slate-400">
                    {formatRange(w)}
                  </span>
                </div>
                <p className="mt-0.5 text-slate-600">{w.message}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
