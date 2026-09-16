"use client";

export type StudioStepId =
  | "trip"
  | "route"
  | "slope"
  | "tls"
  | "envelope"
  | "driver"
  | "vehicle"
  | "cycle";

export type StudioStepState = {
  id: StudioStepId;
  label: string;
  hint: string;
  done: boolean;
};

type StudioChecklistProps = {
  steps: StudioStepState[];
  tlsCount?: number | null;
};

export default function StudioChecklist({
  steps,
  tlsCount,
}: StudioChecklistProps) {
  const n = steps.filter((s) => s.done).length;
  return (
    <section className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Étapes
        </h2>
        <span className="font-mono text-[10px] tabular-nums text-slate-500">
          {n}/{steps.length}
        </span>
      </div>
      <ul className="space-y-1">
        {steps.map((s) => (
          <li key={s.id} className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={s.done}
              readOnly
              tabIndex={-1}
              className="mt-0.5 accent-brand"
              aria-label={s.label}
            />
            <div className="min-w-0 leading-snug">
              <div
                className={`text-[11px] font-medium ${
                  s.done ? "text-slate-800" : "text-slate-500"
                }`}
              >
                {s.label}
                {s.id === "tls" && tlsCount != null && s.done && (
                  <span className="ml-1 font-normal text-slate-400">
                    ({tlsCount} feu{tlsCount === 1 ? "" : "x"})
                  </span>
                )}
              </div>
              {!s.done && (
                <div className="text-[10px] text-slate-400">{s.hint}</div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
