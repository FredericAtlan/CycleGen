"use client";

import { useState, type ReactNode } from "react";
import type { MapFocusRequest } from "@/lib/mapFocus";
import MapLayerControls, {
  type MapSpeedLayers,
} from "@/components/MapLayerControls";

type MapCameraControlsProps = {
  hasRoute: boolean;
  hasA: boolean;
  hasB: boolean;
  hasPoints: boolean;
  hasReference: boolean;
  hasRange: boolean;
  syncEnabled: boolean;
  onSyncChange: (enabled: boolean) => void;
  onFocus: (
    kind: Exclude<MapFocusRequest["kind"], "cursor" | "range" | "bounds">
  ) => void;
  onFocusRange: () => void;
  onClearRange?: () => void;
  showArrows?: boolean;
  onShowArrowsChange?: (v: boolean) => void;
  speedLayers?: MapSpeedLayers;
  onSpeedLayersChange?: (layers: MapSpeedLayers) => void;
  hasCorridorSpeeds?: boolean;
};

export default function MapCameraControls({
  hasRoute,
  hasA,
  hasB,
  hasPoints,
  hasReference,
  hasRange,
  syncEnabled,
  onSyncChange,
  onFocus,
  onFocusRange,
  onClearRange,
  showArrows,
  onShowArrowsChange,
  speedLayers,
  onSpeedLayersChange,
  hasCorridorSpeeds = false,
}: MapCameraControlsProps) {
  const [open, setOpen] = useState(false);

  const activeHints: string[] = [];
  if (showArrows) activeHints.push("Sens");
  if (speedLayers?.envelope) activeHints.push("Env");
  if (speedLayers?.legal) activeHints.push("Légal");
  if (speedLayers?.traffic) activeHints.push("Trafic");
  if (speedLayers?.curve) activeHints.push("Virage");
  if (syncEnabled) activeHints.push("Sync");
  if (hasRange) activeHints.push("Sélection");

  return (
    <div className="pointer-events-auto absolute right-3 top-3 z-[1000] flex max-w-[200px] flex-col items-end gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="map-menus-panel"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white/95 text-slate-700 shadow-sm transition hover:bg-white active:scale-[0.98]"
        title={
          open
            ? "Replier les menus carte"
            : `Déplier les menus carte${activeHints.length ? ` (${activeHints.join(", ")})` : ""}`
        }
      >
        <IconLayers />
      </button>

      {open && (
        <div
          id="map-menus-panel"
          className="flex w-[188px] flex-col gap-1"
        >
          <div className="rounded-md border border-slate-200 bg-white/95 p-1 shadow-sm">
            <div className="mb-0.5 px-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
              Focus
            </div>
            <div className="flex flex-wrap gap-0.5">
              <IconBtn
                title="Itinéraire complet"
                disabled={!hasRoute && !hasReference && !hasPoints}
                onClick={() => onFocus("route")}
              >
                <IconRoute />
              </IconBtn>
              <IconBtn
                title="Points A / B / arrêts"
                disabled={!hasPoints}
                onClick={() => onFocus("points")}
              >
                <IconPins />
              </IconBtn>
              <IconBtn
                title="Trace GPS référence"
                disabled={!hasReference}
                onClick={() => onFocus("reference")}
                accent={hasReference}
              >
                <IconGps />
              </IconBtn>
              <IconBtn
                title="Centrer départ (A)"
                disabled={!hasA}
                onClick={() => onFocus("A")}
              >
                <span className="text-[11px] font-bold">A</span>
              </IconBtn>
              <IconBtn
                title="Centrer arrivée (B)"
                disabled={!hasB}
                onClick={() => onFocus("B")}
              >
                <span className="text-[11px] font-bold">B</span>
              </IconBtn>
              <IconBtn
                title="Portion sélectionnée (brush)"
                disabled={!hasRange}
                onClick={onFocusRange}
                accent={hasRange}
              >
                <IconCrop />
              </IconBtn>
              {hasRange && onClearRange && (
                <IconBtn title="Effacer le zoom sélection" onClick={onClearRange}>
                  <IconClear />
                </IconBtn>
              )}
            </div>
          </div>

          {showArrows != null &&
            onShowArrowsChange &&
            speedLayers &&
            onSpeedLayersChange && (
              <MapLayerControls
                showArrows={showArrows}
                onShowArrowsChange={onShowArrowsChange}
                speedLayers={speedLayers}
                onSpeedLayersChange={onSpeedLayersChange}
                hasRoute={hasRoute}
                hasCorridorSpeeds={hasCorridorSpeeds}
              />
            )}

          <label
            className="flex cursor-pointer items-center justify-between gap-2 rounded-md border border-slate-200 bg-white/95 px-2 py-1.5 shadow-sm"
            title="Synchroniser curseur graphique ↔ carte"
          >
            <span className="text-[10px] font-semibold text-slate-700">Sync</span>
            <input
              type="checkbox"
              checked={syncEnabled}
              onChange={(e) => onSyncChange(e.target.checked)}
              className="h-3.5 w-3.5 accent-brand"
            />
          </label>
        </div>
      )}
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  disabled,
  accent,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-7 w-7 items-center justify-center rounded transition active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-35 ${
        accent
          ? "bg-brand text-white"
          : "bg-slate-50 text-slate-700 ring-1 ring-slate-200 hover:bg-white"
      }`}
    >
      {children}
    </button>
  );
}

function svgProps(extra?: string) {
  return {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: extra,
    "aria-hidden": true as const,
  };
}

function IconLayers() {
  return (
    <svg {...svgProps()}>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

function IconRoute() {
  return (
    <svg {...svgProps()}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M8 7c4 0 4 10 8 10" />
    </svg>
  );
}

function IconPins() {
  return (
    <svg {...svgProps()}>
      <path d="M12 21s-6-5.5-6-10a6 6 0 1 1 12 0c0 4.5-6 10-6 10z" />
      <circle cx="12" cy="11" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconGps() {
  return (
    <svg {...svgProps()}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </svg>
  );
}

function IconCrop() {
  return (
    <svg {...svgProps()}>
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M18 22V8a2 2 0 0 0-2-2H2" />
    </svg>
  );
}

function IconClear() {
  return (
    <svg {...svgProps()}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
