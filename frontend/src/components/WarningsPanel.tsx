"use client";

import { useMemo } from "react";
import type { CycleGenWarning } from "@/lib/types";
import AccordionSection from "@/components/AccordionSection";

export type WarningsPanelProps = {
  warnings: CycleGenWarning[];
  title?: string;
  /** @deprecated Prefer accordion; kept for Sidebar. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  className?: string;
};

function formatRange(w: CycleGenWarning): string {
  if (w.s0 === 0 && w.s1 === 0) return "";
  if (Math.abs(w.s0 - w.s1) < 1e-6) return ` @ ${Math.round(w.s0)} m`;
  return ` @ ${Math.round(w.s0)}–${Math.round(w.s1)} m`;
}

function summarizeWarnings(warnings: CycleGenWarning[]): string {
  const byCode = new Map<string, number>();
  for (const w of warnings) {
    const code = w.code || "other";
    byCode.set(code, (byCode.get(code) ?? 0) + 1);
  }
  const top = [...byCode.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([code, n]) => `${code} ×${n}`);
  const more = byCode.size > 4 ? ` · +${byCode.size - 4} types` : "";
  return `${top.join(" · ")}${more}`;
}

function WarningsPanel({
  warnings,
  title = "Alertes & imputations",
  collapsible = true,
  defaultOpen,
  className = "",
}: WarningsPanelProps) {
  const summary = useMemo(() => summarizeWarnings(warnings), [warnings]);
  if (!warnings.length) return null;

  const openByDefault =
    defaultOpen ?? (collapsible ? warnings.length <= 6 : true);

  const list = (
    <ul className="max-h-48 space-y-1.5 overflow-y-auto">
      {warnings.map((w, i) => (
        <li
          key={`${w.code}-${w.s0}-${w.s1}-${i}`}
          className="rounded border border-amber-100 bg-amber-50/80 px-2 py-1.5 text-[11px] leading-snug text-slate-700"
        >
          <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
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
  );

  if (!collapsible) {
    return (
      <section className={`space-y-1 ${className}`}>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {title}
          <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold normal-case tabular-nums text-amber-800">
            {warnings.length}
          </span>
        </h3>
        <p className="text-[10px] text-slate-500">{summary}</p>
        {list}
      </section>
    );
  }

  return (
    <AccordionSection
      title={title}
      badge={warnings.length}
      summary={summary}
      defaultOpen={openByDefault}
      tone="amber"
      className={className}
    >
      {list}
    </AccordionSection>
  );
}

export default WarningsPanel;
/** Gemini W6 alias. */
export { WarningsPanel as ImputationPanel };

/** Human-readable badge label for traffic_source API values. */
export function trafficSourceLabel(source: string | null | undefined): string | null {
  if (!source) return null;
  const key = source.toLowerCase();
  if (key.includes("mapbox")) return "Mapbox Traffic";
  if (key.includes("osrm") || key.includes("freeflow") || key.includes("free"))
    return "OSRM Free-flow (Fallback)";
  return source;
}

/** Tailwind classes: green = Mapbox congestion, amber = OSRM free-flow fallback. */
export function trafficSourceBadgeClass(
  source: string | null | undefined
): string {
  const key = (source ?? "").toLowerCase();
  if (key.includes("mapbox")) {
    return "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200";
  }
  if (key.includes("osrm") || key.includes("freeflow") || key.includes("free")) {
    return "bg-amber-50 text-amber-900 ring-1 ring-amber-300";
  }
  return "bg-slate-100 text-slate-600 ring-1 ring-slate-200";
}
