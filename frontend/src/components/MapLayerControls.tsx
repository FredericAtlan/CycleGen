"use client";

import type { ReactNode } from "react";

export type MapSpeedLayers = {
  envelope: boolean;
  legal: boolean;
  traffic: boolean;
  curve: boolean;
};

export const DEFAULT_MAP_SPEED_LAYERS: MapSpeedLayers = {
  envelope: false,
  legal: false,
  traffic: false,
  curve: false,
};

type MapLayerControlsProps = {
  showArrows: boolean;
  onShowArrowsChange: (v: boolean) => void;
  speedLayers: MapSpeedLayers;
  onSpeedLayersChange: (layers: MapSpeedLayers) => void;
  hasRoute: boolean;
  hasCorridorSpeeds: boolean;
};

function IconChip({
  title,
  active,
  color,
  disabled,
  onClick,
  children,
}: {
  title: string;
  active: boolean;
  color: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-7 min-w-[28px] items-center justify-center gap-0.5 rounded px-1.5 text-[10px] font-bold transition disabled:cursor-not-allowed disabled:opacity-35 ${
        active
          ? "text-white shadow-sm ring-2 ring-offset-1 ring-slate-400"
          : "bg-slate-50 text-slate-600 ring-1 ring-slate-200 hover:bg-white"
      }`}
      style={active ? { backgroundColor: color } : undefined}
    >
      {children}
    </button>
  );
}

export default function MapLayerControls({
  showArrows,
  onShowArrowsChange,
  speedLayers,
  onSpeedLayersChange,
  hasRoute,
  hasCorridorSpeeds,
}: MapLayerControlsProps) {
  const anySpeed =
    speedLayers.envelope ||
    speedLayers.legal ||
    speedLayers.traffic ||
    speedLayers.curve;

  const setLayer = (key: keyof MapSpeedLayers, v: boolean) => {
    onSpeedLayersChange({ ...speedLayers, [key]: v });
  };

  return (
    <div className="rounded-md border border-slate-200 bg-white/95 p-1 shadow-sm">
      <div className="mb-0.5 px-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
        Couches
      </div>
      <div className="flex flex-wrap gap-0.5">
        <IconChip
          title="Flèches de sens du trajet"
          active={showArrows}
          color="#1d4ed8"
          disabled={!hasRoute}
          onClick={() => onShowArrowsChange(!showArrows)}
        >
          →
        </IconChip>
        <IconChip
          title="Toutes les couches de vitesse"
          active={anySpeed}
          color="#0f172a"
          disabled={!hasCorridorSpeeds}
          onClick={() => {
            const next = !anySpeed;
            onSpeedLayersChange({
              envelope: next,
              legal: next,
              traffic: next,
              curve: next,
            });
          }}
        >
          V
        </IconChip>
        <IconChip
          title="Enveloppe V_lim"
          active={speedLayers.envelope}
          color="#2563eb"
          disabled={!hasCorridorSpeeds}
          onClick={() => setLayer("envelope", !speedLayers.envelope)}
        >
          E
        </IconChip>
        <IconChip
          title="Vitesse légale (Mapbox)"
          active={speedLayers.legal}
          color="#64748b"
          disabled={!hasCorridorSpeeds}
          onClick={() => setLayer("legal", !speedLayers.legal)}
        >
          L
        </IconChip>
        <IconChip
          title="Vitesse trafic"
          active={speedLayers.traffic}
          color="#ea580c"
          disabled={!hasCorridorSpeeds}
          onClick={() => setLayer("traffic", !speedLayers.traffic)}
        >
          T
        </IconChip>
        <IconChip
          title="Virage (confort a_y)"
          active={speedLayers.curve}
          color="#7c3aed"
          disabled={!hasCorridorSpeeds}
          onClick={() => setLayer("curve", !speedLayers.curve)}
        >
          R
        </IconChip>
      </div>
      {hasCorridorSpeeds && (
        <p className="mt-1 max-w-[11rem] px-1 text-[8px] leading-snug text-slate-400">
          Pente carte : plein = montée · tirets = descente · épaisseur = |%|
        </p>
      )}
    </div>
  );
}
