"use client";

import { useEffect, useState } from "react";

export type BuildPhase = "analyzing" | "corridor" | "generating";

type Stage = { untilPct: number; label: string };

const STAGES: Record<BuildPhase, Stage[]> = {
  analyzing: [
    { untilPct: 20, label: "Géocodage & routage…" },
    { untilPct: 45, label: "Trafic & géométrie…" },
    { untilPct: 70, label: "Overpass (feux, maxspeed)…" },
    { untilPct: 90, label: "Altitude DEM…" },
    { untilPct: 100, label: "Finalisation de l’itinéraire…" },
  ],
  corridor: [
    { untilPct: 18, label: "Préparation du corridor…" },
    { untilPct: 40, label: "Pente & profil altitude…" },
    { untilPct: 62, label: "Courbure & enveloppes…" },
    { untilPct: 82, label: "Feux & limites légales…" },
    { untilPct: 100, label: "Assemblage du cycle…" },
  ],
  generating: [
    { untilPct: 25, label: "Démarrage du moteur…" },
    { untilPct: 55, label: "Simulation cinématique…" },
    { untilPct: 80, label: "Profil vitesse…" },
    { untilPct: 100, label: "Consolidation…" },
  ],
};

/** Soft progress: climbs fast then asymptotes under 93 % until the request ends. */
function softPct(elapsedSec: number, tauSec: number): number {
  return 93 * (1 - Math.exp(-elapsedSec / Math.max(tauSec, 1)));
}

function stageLabel(phase: BuildPhase, pct: number): string {
  const stages = STAGES[phase];
  for (const s of stages) {
    if (pct < s.untilPct) return s.label;
  }
  return stages[stages.length - 1]?.label ?? "En cours…";
}

const TAU: Record<BuildPhase, number> = {
  analyzing: 12,
  corridor: 14,
  generating: 18,
};

export function useBuildProgress(active: boolean, phase: BuildPhase | null) {
  const [elapsed, setElapsed] = useState(0);
  const [pct, setPct] = useState(0);

  useEffect(() => {
    if (!active || !phase) {
      setElapsed(0);
      setPct(0);
      return;
    }
    const t0 = Date.now();
    const tick = () => {
      const t = (Date.now() - t0) / 1000;
      setElapsed(t);
      setPct(softPct(t, TAU[phase]));
    };
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [active, phase]);

  if (!active || !phase) {
    return { pct: 0, elapsed: 0, label: "", phase: null as BuildPhase | null };
  }
  return {
    pct,
    elapsed,
    label: stageLabel(phase, pct),
    phase,
  };
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec.toFixed(0)} s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export type BuildProgressGaugeProps = {
  active: boolean;
  phase: BuildPhase | null;
  /** Compact bar under CTA / in sidebar. */
  variant?: "panel" | "overlay" | "inline";
  className?: string;
};

export default function BuildProgressGauge({
  active,
  phase,
  variant = "panel",
  className = "",
}: BuildProgressGaugeProps) {
  const { pct, elapsed, label } = useBuildProgress(active, phase);
  if (!active || !phase) return null;

  const bar = (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-label={label}
    >
      <div
        className="h-full rounded-full bg-brand transition-[width] duration-200 ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  );

  if (variant === "inline") {
    return (
      <div className={`space-y-1 ${className}`}>
        <div className="flex items-center justify-between gap-2 text-[10px] text-slate-600">
          <span className="min-w-0 truncate font-medium text-slate-800">
            {label}
          </span>
          <span className="shrink-0 tabular-nums text-slate-500">
            {pct.toFixed(0)}% · {formatElapsed(elapsed)}
          </span>
        </div>
        {bar}
      </div>
    );
  }

  if (variant === "overlay") {
    return (
      <div
        className={`pointer-events-none absolute inset-x-0 top-3 z-[1200] flex justify-center px-3 ${className}`}
      >
        <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white/95 px-3 py-2.5 shadow-md backdrop-blur-sm">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold text-slate-900">{label}</p>
            <p className="shrink-0 text-[11px] font-semibold tabular-nums text-brand">
              {pct.toFixed(0)}%
            </p>
          </div>
          {bar}
          <p className="mt-1.5 text-[10px] text-slate-500">
            En cours · {formatElapsed(elapsed)} — ne fermez pas l’onglet
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`rounded-md border border-brand/25 bg-brand/5 px-2.5 py-2 ${className}`}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold leading-snug text-slate-900">
          {label}
        </p>
        <p className="shrink-0 text-[11px] font-semibold tabular-nums text-brand">
          {pct.toFixed(0)}%
        </p>
      </div>
      {bar}
      <p className="mt-1.5 text-[10px] tabular-nums text-slate-500">
        Temps écoulé {formatElapsed(elapsed)}
      </p>
    </div>
  );
}
