"use client";

import { SLOPE_UNITS, type SlopeUnit } from "@/lib/units";

type SlopeUnitToggleProps = {
  value: SlopeUnit;
  onChange: (unit: SlopeUnit) => void;
  className?: string;
};

/** Chart-only slope unit switcher (%, °, rad) — not a simulation parameter. */
export default function SlopeUnitToggle({
  value,
  onChange,
  className = "",
}: SlopeUnitToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Slope display unit"
      title="Display only — does not affect simulation"
      className={`inline-flex rounded border border-slate-200 bg-slate-50 p-0.5 ${className}`}
    >
      {SLOPE_UNITS.map((u) => {
        const active = value === u.id;
        return (
          <button
            key={u.id}
            type="button"
            role="radio"
            aria-checked={active}
            title={u.hint}
            onClick={() => onChange(u.id)}
            className={`min-h-[22px] rounded px-1.5 text-[10px] font-semibold tabular-nums ${
              active
                ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            {u.label}
          </button>
        );
      })}
    </div>
  );
}
