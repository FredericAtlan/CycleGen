"use client";

type SimProgressProps = {
  t: number;
  s: number;
  totalS: number;
  /** Compact single-line variant for the wide analysis column. */
  compact?: boolean;
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function SimProgress({
  t,
  s,
  totalS,
  compact = false,
}: SimProgressProps) {
  const pct =
    totalS > 0 ? Math.min(100, Math.max(0, (s / totalS) * 100)) : 0;

  if (compact) {
    return (
      <div className="flex items-center gap-2 text-[10px] tabular-nums text-slate-600">
        <span>
          <span className="font-semibold text-slate-900">{formatTime(t)}</span>
          <span className="text-slate-400"> · </span>
          {(s / 1000).toFixed(2)}/{(totalS / 1000).toFixed(2)} km
        </span>
        <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-full rounded-full bg-emerald-500 transition-[width] duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="shrink-0 font-semibold text-slate-700">
          {pct.toFixed(0)}%
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5">
      <div className="flex justify-between text-xs text-slate-600">
        <span>
          Time{" "}
          <span className="font-semibold tabular-nums text-slate-900">
            {formatTime(t)}
          </span>
        </span>
        <span>
          Dist{" "}
          <span className="font-semibold tabular-nums text-slate-900">
            {(s / 1000).toFixed(2)} / {(totalS / 1000).toFixed(2)} km
          </span>
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className="h-full rounded-full bg-emerald-500 transition-[width] duration-150"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
