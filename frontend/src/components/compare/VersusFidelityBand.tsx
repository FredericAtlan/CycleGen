"use client";

/**
 * Versus Fidélité band — KPIs from Route Studio fit pack (API or static).
 */

import { useEffect, useState } from "react";
import { getRouteStudioPackSummary } from "@/lib/api";
import { withBase } from "@/lib/basePath";

type Summary = {
  fidelity_mean?: number;
  fidelity_min?: number;
  fidelity_max?: number;
  rmse_mean?: number;
  rmse_best?: number;
  n_pairs?: number;
  best_pair?: { route?: string; style?: string; score?: number; rmse?: number };
  worst_pair?: { route?: string; style?: string; score?: number; rmse?: number };
};

export default function VersusFidelityBand() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const pack = await getRouteStudioPackSummary();
        if (!cancelled) setSummary(pack.summary ?? null);
      } catch {
        // Fallback: static pack in public/
        try {
          const res = await fetch(withBase("/data/route_studio_fit_pack.json"), {
            cache: "force-cache",
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = (await res.json()) as { summary?: Summary };
          if (!cancelled) setSummary(data.summary ?? null);
        } catch (e) {
          if (!cancelled)
            setErr(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (err || !summary) return null;

  return (
    <div
      data-testid="versus-fidelity-band"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-200 bg-slate-50 px-3 py-1.5 font-mono text-[10px] tabular-nums text-slate-600"
    >
      <span className="font-bold uppercase tracking-wide text-slate-500">
        Fidélité RS
      </span>
      {summary.fidelity_mean != null ? (
        <span>
          mean={summary.fidelity_mean.toFixed(1)}
          {summary.fidelity_min != null && summary.fidelity_max != null
            ? ` [${summary.fidelity_min.toFixed(0)}–${summary.fidelity_max.toFixed(0)}]`
            : ""}
        </span>
      ) : null}
      {summary.rmse_mean != null ? (
        <span>
          RMSĒ={summary.rmse_mean.toFixed(2)}
          {summary.rmse_best != null
            ? ` · best=${summary.rmse_best.toFixed(2)}`
            : ""}{" "}
          km/h
        </span>
      ) : null}
      {summary.n_pairs != null ? <span>n={summary.n_pairs}</span> : null}
      {summary.best_pair ? (
        <span className="text-emerald-700">
          best {summary.best_pair.route}/{summary.best_pair.style} ·{" "}
          {summary.best_pair.score}
        </span>
      ) : null}
      {summary.worst_pair ? (
        <span className="text-amber-700">
          worst {summary.worst_pair.route}/{summary.worst_pair.style} ·{" "}
          {summary.worst_pair.score}
        </span>
      ) : null}
    </div>
  );
}
