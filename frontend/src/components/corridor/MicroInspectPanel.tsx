"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import type { SpatialCorridor } from "@/lib/types";
import { formatKm, projectSToLatLon } from "./geo";

const MicroMap = dynamic(() => import("./MicroMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-44 items-center justify-center bg-slate-100 text-xs text-slate-400">
      Loading micro map…
    </div>
  ),
});

type MicroInspectPanelProps = {
  open: boolean;
  onClose: () => void;
  corridor: SpatialCorridor;
  inspectS: number;
  onInspectSChange: (s_m: number) => void;
  onAddFeuAtInspect: () => void;
  selectedFeuIndex: number | null;
  onMoveSelectedFeuHere: () => void;
  /** Optional live speed at this s (from profile scrub). */
  speedKmh?: number | null;
  contextLabel?: string;
};

export default function MicroInspectPanel({
  open,
  onClose,
  corridor,
  inspectS,
  onInspectSChange,
  onAddFeuAtInspect,
  selectedFeuIndex,
  onMoveSelectedFeuHere,
  speedKmh = null,
  contextLabel,
}: MicroInspectPanelProps) {
  const sEnd = corridor.S.length ? corridor.S[corridor.S.length - 1] : 0;
  const center = useMemo(
    () => projectSToLatLon(corridor, inspectS),
    [corridor, inspectS]
  );

  const nearbyFeux = useMemo(() => {
    return corridor.S_feux
      .map((s, i) => ({ s, i, d: Math.abs(s - inspectS) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 5);
  }, [corridor.S_feux, inspectS]);

  if (!open) return null;

  return (
    <div className="shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold text-slate-900">
            Microscopic check
          </h3>
          <p className="truncate text-[10px] text-slate-500">
            {contextLabel ?? "Verify traffic lights along the route"}
            {" · "}
            {formatKm(inspectS)}
            {speedKmh != null ? ` · ${speedKmh.toFixed(0)} km/h` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-50"
          aria-label="Collapse micro view"
        >
          Collapse
        </button>
      </div>

      <div className="space-y-2 p-3">
        <label className="block space-y-1">
          <span className="flex justify-between text-[10px] font-medium text-slate-600">
            Position on route
            <span className="tabular-nums text-slate-400">
              {Math.round(inspectS)} m / {Math.round(sEnd)} m
            </span>
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(1, Math.round(sEnd))}
            step={5}
            value={Math.round(inspectS)}
            onChange={(e) => onInspectSChange(Number(e.target.value))}
            className="w-full accent-brand"
          />
        </label>

        <div className="overflow-hidden rounded-md border border-slate-200">
          {center ? (
            <MicroMap
              corridor={corridor}
              center={center}
              inspectS={inspectS}
              selectedFeuIndex={selectedFeuIndex}
            />
          ) : (
            <div className="flex h-44 items-center justify-center text-xs text-slate-400">
              No geometry at this position
            </div>
          )}
        </div>

        <div className="rounded-md border border-slate-100 bg-slate-50 px-2 py-1.5">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Nearby lights
          </div>
          {nearbyFeux.length === 0 ? (
            <p className="text-[11px] text-slate-400">None nearby</p>
          ) : (
            <ul className="space-y-0.5">
              {nearbyFeux.map(({ s, i, d }) => (
                <li
                  key={`near-${i}`}
                  className="flex justify-between text-[11px] tabular-nums text-slate-700"
                >
                  <span>
                    <span className="font-semibold text-red-600">#{i + 1}</span>{" "}
                    {formatKm(s)}
                  </span>
                  <span className="text-slate-400">Δ {Math.round(d)} m</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onAddFeuAtInspect}
            className="min-h-[36px] flex-1 rounded-md border border-red-200 bg-red-50 px-2 text-[11px] font-semibold text-red-700 hover:bg-red-100"
          >
            Add light here
          </button>
          <button
            type="button"
            disabled={selectedFeuIndex == null}
            onClick={onMoveSelectedFeuHere}
            className="min-h-[36px] flex-1 rounded-md border border-slate-200 bg-white px-2 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            Move selected light here
          </button>
        </div>
      </div>
    </div>
  );
}
