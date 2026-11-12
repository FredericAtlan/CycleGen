"use client";

import { useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { hydrateFromCycle, hydrateFromTrip } from "@/lib/ideHydrate";
import { scheduleUpdateDynamics } from "@/lib/ideSim";
import { useWorkspaceStore } from "@/lib/workspaceStore";

/** Canvas v(t) — live results (sim/session) or library cycle sparkline. */
export default function IdeCanvas() {
  const selection = useWorkspaceStore((s) => s.selection);
  const hoverIndex = useWorkspaceStore((s) => s.hoverIndex);
  const setHoverIndex = useWorkspaceStore((s) => s.setHoverIndex);
  const setPlayheadIndex = useWorkspaceStore((s) => s.setPlayheadIndex);
  const results = useWorkspaceStore((s) => s.results);
  const geometry = useWorkspaceStore((s) => s.geometry);
  const busyCheap = useWorkspaceStore((s) => s.busyCheap);
  const busyExpensive = useWorkspaceStore((s) => s.busyExpensive);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (busyExpensive) return;
    if (selection.kind === "cycle" && selection.id) {
      hydrateFromCycle(selection.id);
    } else if (selection.kind === "trip" && selection.id) {
      const ok = hydrateFromTrip(selection.id);
      if (ok && useWorkspaceStore.getState().geometry.corridor) {
        scheduleUpdateDynamics(75);
      }
    }
  }, [selection.kind, selection.id, busyExpensive]);

  const path = useMemo(() => {
    const v = results.v_kmh;
    if (!v || v.length < 2) return "";
    const w = 800;
    const h = 160;
    const vmin = Math.min(...v);
    const vmax = Math.max(...v);
    const span = Math.max(1e-3, vmax - vmin);
    return v
      .map((yi, i) => {
        const x = (i / (v.length - 1)) * w;
        const y = h - ((yi - vmin) / span) * (h - 8) - 4;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [results.v_kmh]);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const v = results.v_kmh;
    if (!v || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const u = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const i = Math.round(u * (v.length - 1));
    setHoverIndex(i);
    setPlayheadIndex(i);
  };

  const hoverV =
    hoverIndex != null && results.v_kmh
      ? results.v_kmh[hoverIndex]
      : null;
  const hoverS =
    hoverIndex != null && results.s_m ? results.s_m[hoverIndex] : null;

  const status =
    busyExpensive
      ? "rebuild…"
      : busyCheap
        ? "update…"
        : results.source
          ? results.source
          : "idle";

  return (
    <div
      data-testid="ide-canvas"
      className="flex h-full min-h-0 flex-col bg-slate-100"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-2.5 py-1.5">
        <span className="text-[12px] font-semibold text-slate-800">
          Courbe v(t)
          <span className="ml-2 font-mono text-[10px] font-normal text-slate-400">
            {status}
          </span>
        </span>
        <div className="flex items-center gap-2 font-mono text-[10px] tabular-nums text-slate-500">
          {geometry.distance_m != null ? (
            <span>{(geometry.distance_m / 1000).toFixed(1)} km</span>
          ) : null}
          {hoverV != null ? (
            <span>
              v={hoverV.toFixed(1)} km/h
              {hoverS != null ? ` · s=${(hoverS / 1000).toFixed(2)} km` : ""}
            </span>
          ) : (
            <span className="text-slate-400">survol = lecture</span>
          )}
          <Link
            href="/compare"
            className="font-semibold text-brand hover:underline"
          >
            Versus
          </Link>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 p-2">
        {path ? (
          <svg
            ref={svgRef}
            viewBox="0 0 800 160"
            className="h-full w-full rounded border border-slate-200 bg-white"
            preserveAspectRatio="none"
            onMouseMove={onMove}
            onMouseLeave={() => setHoverIndex(null)}
          >
            <path d={path} fill="none" stroke="#0f766e" strokeWidth="1.5" />
            {hoverIndex != null && results.v_kmh ? (
              <line
                x1={(hoverIndex / (results.v_kmh.length - 1)) * 800}
                x2={(hoverIndex / (results.v_kmh.length - 1)) * 800}
                y1={0}
                y2={160}
                stroke="#64748b"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
            ) : null}
          </svg>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 rounded border border-dashed border-slate-300 bg-white px-6 text-center">
            <p
              data-testid="ide-canvas-empty"
              className="text-[13px] font-semibold text-slate-800"
            >
              Pas encore de résultat à afficher
            </p>
            <ol className="max-w-sm space-y-1 text-left text-[12px] leading-relaxed text-slate-600">
              <li>
                1. À gauche → ouvrez un <strong>trajet sauvé</strong> (ou créez
                un trajet GPS)
              </li>
              <li>
                2. Choisissez un <strong>conducteur</strong>
              </li>
              <li>
                3. <strong>Relancer dynamique</strong> (ou Recalculer corridor
                si la géométrie change)
              </li>
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
