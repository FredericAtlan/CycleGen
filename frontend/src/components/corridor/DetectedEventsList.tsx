"use client";

import { useMemo } from "react";
import type { DetectedEvent } from "@/lib/types";
import AccordionSection from "@/components/AccordionSection";
import { formatKm } from "./geo";

type DetectedEventsListProps = {
  events: DetectedEvent[];
  defaultOpen?: boolean;
};

function kindLabel(kind: DetectedEvent["kind"]): string {
  switch (kind) {
    case "traffic_signal":
      return "Traffic Signal";
    case "speed_limit":
      return "Speed";
    case "waypoint_stop":
      return "Stop";
    default:
      return kind;
  }
}

function eventDetail(ev: DetectedEvent): string {
  if (ev.kind === "speed_limit" && ev.value != null) {
    const kmh =
      ev.value > 60 ? Math.round(ev.value) : Math.round(ev.value * 3.6);
    return `${kindLabel(ev.kind)} ${kmh}`;
  }
  if (ev.kind === "waypoint_stop") {
    return ev.label || "Waypoint stop";
  }
  if (ev.label) return ev.label;
  return kindLabel(ev.kind);
}

function summarizeEvents(events: DetectedEvent[]): string {
  if (!events.length) return "Aucun événement sur ce cycle";
  const by = new Map<string, number>();
  for (const e of events) {
    by.set(e.kind, (by.get(e.kind) ?? 0) + 1);
  }
  const labels: Record<string, string> = {
    traffic_signal: "feux",
    speed_limit: "vitesses",
    waypoint_stop: "arrêts",
  };
  return [...by.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${labels[k] ?? k}`)
    .join(" · ");
}

export default function DetectedEventsList({
  events,
  defaultOpen = false,
}: DetectedEventsListProps) {
  const sorted = useMemo(
    () => [...(events ?? [])].sort((a, b) => a.s_m - b.s_m),
    [events]
  );
  const summary = useMemo(() => summarizeEvents(sorted), [sorted]);

  return (
    <AccordionSection
      title="Detected events"
      badge={sorted.length}
      summary={summary}
      defaultOpen={defaultOpen || (sorted.length > 0 && sorted.length <= 8)}
    >
      {sorted.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400">
          No events on this cycle.
        </p>
      ) : (
        <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-slate-200 bg-slate-50/80 p-1.5">
          {sorted.map((ev, i) => (
            <li
              key={`${ev.kind}-${ev.s_m}-${i}`}
              className="flex items-start gap-2 rounded px-2 py-1.5 text-xs hover:bg-white"
            >
              <span
                className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
                  ev.kind === "traffic_signal"
                    ? "bg-red-500"
                    : ev.kind === "waypoint_stop"
                      ? "bg-orange-500"
                      : "bg-amber-500"
                }`}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="font-medium tabular-nums text-slate-700">
                  {formatKm(ev.s_m)}
                </span>
                <span className="text-slate-400">: </span>
                <span className="text-slate-600">{eventDetail(ev)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </AccordionSection>
  );
}
