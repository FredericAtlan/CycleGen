"use client";

type DensityGaugeProps = {
  density: number;
};

/** Simple bar gauge for local traffic density (veh/km² or nearby count proxy). */
export default function DensityGauge({ density }: DensityGaugeProps) {
  const capped = Math.min(100, Math.max(0, density));
  const pct = Math.min(100, (capped / 40) * 100);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Local density
        </h3>
        <span className="text-xs font-semibold tabular-nums text-slate-800">
          {density.toFixed(1)}
        </span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[10px] text-slate-400">Nearby vehicles / area proxy</p>
    </div>
  );
}
