"use client";

import { useId, useState, type ReactNode } from "react";

type AccordionSectionProps = {
  title: string;
  /** Shown in the header badge (e.g. count). */
  badge?: string | number;
  /** One-line summary when collapsed. */
  summary?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
  /** Accent for border/badge (warnings = amber). */
  tone?: "slate" | "amber";
};

export default function AccordionSection({
  title,
  badge,
  summary,
  defaultOpen = false,
  className = "",
  children,
  tone = "slate",
}: AccordionSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  const border =
    tone === "amber" ? "border-amber-200" : "border-slate-200";
  const badgeCls =
    tone === "amber"
      ? "bg-amber-100 text-amber-800"
      : "bg-slate-100 text-slate-600";
  const titleCls =
    tone === "amber" ? "text-amber-900" : "text-slate-600";

  return (
    <div
      className={`overflow-hidden rounded-md border bg-white ${border} ${className}`}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-slate-50/80"
      >
        <span
          className={`mt-0.5 shrink-0 text-[10px] text-slate-400 transition-transform ${
            open ? "rotate-90" : ""
          }`}
          aria-hidden
        >
          ▸
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span
              className={`text-xs font-semibold uppercase tracking-wide ${titleCls}`}
            >
              {title}
            </span>
            {badge != null && badge !== "" && (
              <span
                className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums ${badgeCls}`}
              >
                {badge}
              </span>
            )}
          </span>
          {!open && summary != null && (
            <span className="mt-0.5 block text-[10px] leading-snug text-slate-500">
              {summary}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div
          id={panelId}
          className={`border-t px-3 py-2 ${
            tone === "amber" ? "border-amber-100" : "border-slate-100"
          }`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
