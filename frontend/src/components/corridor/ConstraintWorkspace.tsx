"use client";

/**
 * ConstraintWorkspace — step 2 right panel (~75% width) that hosts every
 * distance-domain constraint chart with an unified "Agrandir" drawer.
 *
 * This component only orchestrates: parent (CycleGenShell) owns state
 * (corridor, mask, filter, min/max) and passes lightweight callbacks so
 * every toggle stays live. All charts are always mounted so that a
 * remask (client-side) reflects instantly, without a spinner.
 */

import { useMemo, useState, type ReactNode } from "react";
import type { EnvelopeMask } from "@/lib/corridorEdit";
import type {
  ElevationSourceKey,
  RouterKey,
  SpatialCorridor,
} from "@/lib/types";
import type {
  ElevationSourceRow,
  SpeedSourceKey,
  SpeedSourceRow,
} from "@/components/corridor/RouterSourceToggles";
import {
  ElevationSourceToggles,
  RouterSpeedToggles,
} from "@/components/corridor/RouterSourceToggles";
import EnvelopeMaskToggles from "@/components/corridor/EnvelopeMaskToggles";
import SpeedLimitChart from "@/components/corridor/SpeedLimitChart";
import SlopeChart from "@/components/corridor/SlopeChart";
import ElevationProfileChart, {
  type ElevationProfileMeta,
} from "@/components/corridor/ElevationProfileChart";
import {
  ChartFocusButton,
  ChartFocusSlot,
} from "@/components/corridor/ChartFocusHost";
import type { SlopeUnit } from "@/lib/units";
import { slopeUnitLabel } from "@/lib/units";
import SlopeUnitToggle from "@/components/SlopeUnitToggle";
import {
  MAX_GRADE_OPTIONS,
  SLOPE_SMOOTH_PRESETS,
  TRAP_LENGTH_OPTIONS,
  type SlopeSmoothPreset,
} from "@/lib/slopeAlgo";
import { ROUTER_LABELS } from "@/lib/types";

export type LegalSmoothMode = "none" | "majority" | "min" | "mean_snap";
export type ElevationCombineMode = "mean" | "min" | "max";

export type ConstraintWorkspaceProps = {
  corridor: SpatialCorridor;
  meta?: ElevationProfileMeta | null;
  disabled?: boolean;

  // Speed section
  envelopeMask: EnvelopeMask;
  onEnvelopeMaskChange: (mask: EnvelopeMask) => void;
  speedSources: SpeedSourceKey[];
  onSpeedSourcesChange: (next: SpeedSourceKey[]) => void;
  speedSourceRows: SpeedSourceRow[];
  legalSmoothMode: LegalSmoothMode;
  onLegalSmoothModeChange: (mode: LegalSmoothMode) => void;
  legalSmoothWindowM: number;
  onLegalSmoothWindowChange: (windowM: number) => void;
  respectLegalLimits: boolean;
  onRespectLegalLimitsChange: (next: boolean) => void;
  speedMinKmh: number | null;
  onSpeedMinKmhChange: (v: number | null) => void;
  speedMaxKmh: number | null;
  onSpeedMaxKmhChange: (v: number | null) => void;
  // Read-only for the chart (Vmax vehicle lives in Comportement).
  globalMaxKmh?: number | null;
  trafficSource?: string | null;
  routersUsed?: RouterKey[];

  // Slope section
  elevationSources: ElevationSourceKey[];
  onElevationSourcesChange: (next: ElevationSourceKey[]) => void;
  elevationSourceRows: ElevationSourceRow[];
  elevationCombine: ElevationCombineMode;
  onElevationCombineChange: (mode: ElevationCombineMode) => void;
  slopeSmoothPreset: SlopeSmoothPreset;
  onSlopeSmoothPresetChange: (p: SlopeSmoothPreset) => void;
  slopeMaxGrade: number;
  onSlopeMaxGradeChange: (g: number) => void;
  alphaMinPct: number | null;
  onAlphaMinPctChange: (v: number | null) => void;
  alphaMaxPct: number | null;
  onAlphaMaxPctChange: (v: number | null) => void;
  slopeUnit?: SlopeUnit;
  onSlopeUnitChange?: (u: SlopeUnit) => void;
  trapLengthM: number;
  onTrapLengthMChange: (v: number) => void;

  // Sync with map / other views
  onCursorS?: (s_m: number | null) => void;
  onBrushRangeS?: (r: { s0: number; s1: number } | null) => void;
  onInspectS?: (s_m: number) => void;
  highlightS?: number | null;

  // Rebuild trigger — called with a debounce by parent (300 ms).
  onRequestRebuild?: () => void;
};

type Tab = "speed" | "slope" | "both";

export default function ConstraintWorkspace(props: ConstraintWorkspaceProps) {
  const {
    corridor,
    meta,
    disabled = false,
    envelopeMask,
    onEnvelopeMaskChange,
    speedSources,
    onSpeedSourcesChange,
    speedSourceRows,
    legalSmoothMode,
    onLegalSmoothModeChange,
    legalSmoothWindowM,
    onLegalSmoothWindowChange,
    respectLegalLimits,
    onRespectLegalLimitsChange,
    speedMinKmh,
    onSpeedMinKmhChange,
    speedMaxKmh,
    onSpeedMaxKmhChange,
    globalMaxKmh,
    trafficSource,
    routersUsed,
    elevationSources,
    onElevationSourcesChange,
    elevationSourceRows,
    elevationCombine,
    onElevationCombineChange,
    slopeSmoothPreset,
    onSlopeSmoothPresetChange,
    slopeMaxGrade,
    onSlopeMaxGradeChange,
    alphaMinPct,
    onAlphaMinPctChange,
    alphaMaxPct,
    onAlphaMaxPctChange,
    slopeUnit,
    onSlopeUnitChange,
    trapLengthM,
    onTrapLengthMChange,
    onCursorS,
    onBrushRangeS,
    onInspectS,
    highlightS,
    onRequestRebuild,
  } = props;

  const [tab, setTabState] = useState<Tab>(() => {
    if (typeof window === "undefined") return "both";
    const raw = window.localStorage.getItem("cyclegen.constraintTab");
    if (raw === "speed" || raw === "slope" || raw === "both") return raw;
    return "both";
  });
  const setTab = (next: Tab) => {
    setTabState(next);
    try {
      window.localStorage.setItem("cyclegen.constraintTab", next);
    } catch {
      /* ignore quota */
    }
  };

  const routerSummary = useMemo(() => {
    if (!routersUsed?.length) return null;
    return routersUsed
      .map((k) => ROUTER_LABELS[k]?.split(" / ")[0] ?? k)
      .join(" · ");
  }, [routersUsed]);

  const activeMaskLabels = useMemo(() => {
    const out: string[] = [];
    if (envelopeMask.legal) out.push("Légal");
    if (envelopeMask.traffic) out.push("Trafic");
    if (envelopeMask.curve) out.push("Courbure");
    return out.length ? out.join(" + ") : "Vmax seule";
  }, [envelopeMask]);

  const legalFilterLabel =
    legalSmoothMode === "none"
      ? "off"
      : `${legalSmoothMode} ${legalSmoothWindowM} m`;

  const slopePresetLabel =
    SLOPE_SMOOTH_PRESETS.find((p) => p.id === slopeSmoothPreset)?.label ??
    slopeSmoothPreset;

  const elevSummary = useMemo(() => {
    if (elevationSources.length === 0) return "aucune";
    if (elevationSources.length === 1) return elevationSources[0];
    return `${elevationSources.length} sources · ${elevationCombine}`;
  }, [elevationSources, elevationCombine]);

  const vClampSummary =
    speedMinKmh != null || speedMaxKmh != null
      ? `V ${speedMinKmh ?? "—"} → ${speedMaxKmh ?? "—"} km/h`
      : "sans clamp";

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">
            Atelier Contraintes — domaine spatial f(s)
          </h2>
          <p className="text-[11px] text-slate-500">
            Infrastructure routière ·{" "}
            {corridor.S.length > 0
              ? `S = ${(corridor.S[corridor.S.length - 1] / 1000).toFixed(1)} km`
              : "corridor non prêt"}
          </p>
        </div>
        <TabBar tab={tab} onChange={setTab} />
      </header>

      {/* Bandeau récap — état spatial complet en une ligne */}
      <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-[11px] leading-snug text-slate-700 shadow-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <RecapChip label="Route" value={routerSummary ?? "—"} />
          <RecapChip
            label="Vitesse"
            value={`${activeMaskLabels} · filtre ${legalFilterLabel} · ${vClampSummary}`}
          />
          <RecapChip
            label="Pente"
            value={`Z ${elevSummary} · SG ${slopePresetLabel} · L ${trapLengthM} m · clamp ${(slopeMaxGrade * 100).toFixed(0)} %`}
          />
        </div>
      </div>

      {(tab === "speed" || tab === "both") && (
        <SectionCard
          title="Vitesse"
          subtitle="min(cochées) → V_envelope"
          focusHint={
            <ChartFocusButton chartId="workspace.speed">Agrandir</ChartFocusButton>
          }
        >
          <div className="grid gap-3 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
            <div className="flex flex-col gap-2">
              {/* 1. Sources & composition — carte unique regroupant routeurs, mask enveloppe, Vmin/Vmax */}
              <div className="rounded-md border border-slate-200 bg-slate-50/80 p-2.5">
                <div className="mb-1.5 flex items-baseline justify-between gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Sources & composition
                  </h3>
                  <span className="text-[10px] text-slate-400">
                    V_env = min(cochées, Vmax)
                  </span>
                </div>

                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Routeurs V légal
                </p>
                <div className="mb-2">
                  <RouterSpeedToggles
                    rows={speedSourceRows}
                    selected={speedSources}
                    onChange={(next) => {
                      onSpeedSourcesChange(next);
                      onRequestRebuild?.();
                    }}
                    disabled={disabled}
                  />
                </div>

                <p className="mb-1 mt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Composantes cochées dans le min
                </p>
                <EnvelopeMaskToggles
                  mask={envelopeMask}
                  onChange={onEnvelopeMaskChange}
                  trafficSource={trafficSource ?? null}
                  hideTrafficSource
                  compact
                  allowEmpty
                  disabled={disabled}
                />

                <label className="mt-2 flex cursor-pointer items-start gap-2 border-t border-slate-200/70 pt-2 text-[11px] font-medium text-slate-700">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-3.5 w-3.5 accent-brand"
                    checked={respectLegalLimits}
                    disabled={disabled}
                    onChange={(e) => {
                      onRespectLegalLimitsChange(e.target.checked);
                      onRequestRebuild?.();
                    }}
                  />
                  <span>
                    Respecter les limites de vitesse
                    <span className="ml-1 text-[10px] font-normal text-slate-500">
                      (enable_speed_limits côté enveloppe)
                    </span>
                  </span>
                </label>

                <p className="mt-2 text-[10px] leading-snug text-slate-500">
                  Vmax véhicule se règle dans{" "}
                  <span className="font-semibold text-slate-700">
                    Comportement
                  </span>{" "}
                  (domaine temporel).
                </p>
              </div>

              <SpatialFilterControls
                mode={legalSmoothMode}
                onModeChange={(m) => {
                  onLegalSmoothModeChange(m);
                  onRequestRebuild?.();
                }}
                windowM={legalSmoothWindowM}
                onWindowChange={(w) => {
                  onLegalSmoothWindowChange(w);
                  onRequestRebuild?.();
                }}
                disabled={disabled}
              />
              <MinMaxRow
                label="V min / V max (km/h)"
                minValue={speedMinKmh}
                maxValue={speedMaxKmh}
                onMinChange={(v) => {
                  onSpeedMinKmhChange(v);
                  onRequestRebuild?.();
                }}
                onMaxChange={(v) => {
                  onSpeedMaxKmhChange(v);
                  onRequestRebuild?.();
                }}
                minPlaceholder="—"
                maxPlaceholder="—"
                disabled={disabled}
                helpText="Clamps optionnels appliqués sur V_envelope (indépendant de Vmax véhicule)."
              />
            </div>
            <div className="min-h-[16rem]">
              <ChartFocusSlot
                chartId="workspace.speed"
                title="Vitesses limites — f(s)"
                subtitle="Composition V_legal / V_traffic / V_curve / V_envelope"
                renderEnlarged={() => (
                  <SpeedLimitChart
                    corridor={corridor}
                    tall
                    envelopeMask={envelopeMask}
                    maxSpeedKmh={globalMaxKmh ?? null}
                    onInspectS={onInspectS}
                    onCursorS={onCursorS}
                    onBrushRangeS={onBrushRangeS}
                    highlightS={highlightS}
                    syncEnabled
                  />
                )}
              >
                <SpeedLimitChart
                  corridor={corridor}
                  envelopeMask={envelopeMask}
                  maxSpeedKmh={globalMaxKmh ?? null}
                  onInspectS={onInspectS}
                  onCursorS={onCursorS}
                  onBrushRangeS={onBrushRangeS}
                  highlightS={highlightS}
                  syncEnabled
                />
              </ChartFocusSlot>
            </div>
          </div>
        </SectionCard>
      )}

      {(tab === "slope" || tab === "both") && (
        <SectionCard
          title="Pente"
          subtitle={`unité ${slopeUnit ? slopeUnitLabel(slopeUnit) : "%"} · combine sources · L = ${trapLengthM.toFixed(0)} m`}
          focusHint={
            <div className="flex items-center gap-2">
              {onSlopeUnitChange && slopeUnit && (
                <SlopeUnitToggle
                  value={slopeUnit}
                  onChange={onSlopeUnitChange}
                />
              )}
              <div className="flex gap-1.5">
                <ChartFocusButton chartId="workspace.slope">
                  α(s)
                </ChartFocusButton>
                <ChartFocusButton chartId="workspace.slope.km">
                  Bandes 1 km
                </ChartFocusButton>
              </div>
            </div>
          }
        >
          <div className="grid gap-3 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
            <div className="flex flex-col gap-2">
              <ElevationSourceToggles
                rows={elevationSourceRows}
                selected={elevationSources}
                onChange={(next) => {
                  onElevationSourcesChange(next);
                  onRequestRebuild?.();
                }}
                combine={elevationCombine}
                onCombineChange={(m) => {
                  onElevationCombineChange(m);
                  onRequestRebuild?.();
                }}
                disabled={disabled}
              />
              <SlopeFilterControls
                smoothPreset={slopeSmoothPreset}
                onSmoothPresetChange={(p) => {
                  onSlopeSmoothPresetChange(p);
                  onRequestRebuild?.();
                }}
                maxGrade={slopeMaxGrade}
                onMaxGradeChange={(g) => {
                  onSlopeMaxGradeChange(g);
                  onRequestRebuild?.();
                }}
                trapLengthM={trapLengthM}
                onTrapLengthMChange={(v) => {
                  onTrapLengthMChange(v);
                  onRequestRebuild?.();
                }}
                disabled={disabled}
              />
              <MinMaxRow
                label="Pente min / max (%)"
                minValue={alphaMinPct}
                maxValue={alphaMaxPct}
                onMinChange={(v) => {
                  onAlphaMinPctChange(v);
                  onRequestRebuild?.();
                }}
                onMaxChange={(v) => {
                  onAlphaMaxPctChange(v);
                  onRequestRebuild?.();
                }}
                minPlaceholder="—"
                maxPlaceholder="—"
                disabled={disabled}
                helpText="Clamps bilatéraux sur α (post-lissage)."
              />
            </div>
            <div className="flex min-h-0 flex-col gap-3">
              <ChartFocusSlot
                chartId="workspace.slope"
                title="Pente continue α(s)"
                subtitle={`preset SG ${slopeSmoothPreset}`}
                renderEnlarged={() => (
                  <SlopeChart
                    corridor={corridor}
                    slopeUnit={slopeUnit}
                    onSlopeUnitChange={onSlopeUnitChange}
                    tall
                    highlightS={highlightS}
                    onCursorS={onCursorS}
                    syncEnabled
                  />
                )}
              >
                <SlopeChart
                  corridor={corridor}
                  slopeUnit={slopeUnit}
                  onSlopeUnitChange={onSlopeUnitChange}
                  highlightS={highlightS}
                  onCursorS={onCursorS}
                  syncEnabled
                />
              </ChartFocusSlot>
              <ChartFocusSlot
                chartId="workspace.slope.km"
                title="Profil de pente — bandes 1 km"
                subtitle={`L = ${trapLengthM.toFixed(0)} m par trapèze`}
                renderEnlarged={() => (
                  <ElevationProfileChart
                    corridor={corridor}
                    tall
                    trapLengthM={trapLengthM}
                    meta={meta ?? null}
                    highlightS={highlightS}
                    onCursorS={onCursorS}
                    syncEnabled
                  />
                )}
              >
                <ElevationProfileChart
                  corridor={corridor}
                  trapLengthM={trapLengthM}
                  meta={meta ?? null}
                  highlightS={highlightS}
                  onCursorS={onCursorS}
                  syncEnabled
                />
              </ChartFocusSlot>
            </div>
          </div>
        </SectionCard>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local subcomponents
// ---------------------------------------------------------------------------

function TabBar({
  tab,
  onChange,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
}) {
  const opts: Array<{ id: Tab; label: string }> = [
    { id: "both", label: "Tout" },
    { id: "speed", label: "Vitesse" },
    { id: "slope", label: "Pente" },
  ];
  return (
    <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5 text-[11px]">
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={`rounded px-2 py-1 font-semibold ${
            tab === o.id
              ? "bg-slate-900 text-white"
              : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function RecapChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </span>
      <span className="text-[11px] font-medium text-slate-800">{value}</span>
    </span>
  );
}

function SectionCard({
  title,
  subtitle,
  focusHint,
  children,
}: {
  title: string;
  subtitle?: string;
  focusHint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          {subtitle && (
            <p className="text-[11px] text-slate-500">{subtitle}</p>
          )}
        </div>
        {focusHint}
      </header>
      {children}
    </section>
  );
}

function SpatialFilterControls({
  mode,
  onModeChange,
  windowM,
  onWindowChange,
  disabled,
}: {
  mode: LegalSmoothMode;
  onModeChange: (m: LegalSmoothMode) => void;
  windowM: number;
  onWindowChange: (w: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/80 p-2.5">
      <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <span>Filtre spatial V_legal</span>
        <span className="text-[10px] font-normal text-slate-500">
          fenêtre {windowM} m
        </span>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {(
          [
            ["none", "off"],
            ["majority", "maj"],
            ["min", "min"],
            ["mean_snap", "μ"],
          ] as Array<[LegalSmoothMode, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`rounded border px-1.5 py-1 text-[10px] font-semibold ${
              mode === id
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
            disabled={disabled}
            onClick={() => onModeChange(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <input
        type="range"
        min={0}
        max={1000}
        step={25}
        value={windowM}
        disabled={disabled || mode === "none"}
        onChange={(e) => onWindowChange(Number(e.target.value))}
        className="mt-2 w-full accent-brand"
      />
    </div>
  );
}

function SlopeFilterControls({
  smoothPreset,
  onSmoothPresetChange,
  maxGrade,
  onMaxGradeChange,
  trapLengthM,
  onTrapLengthMChange,
  disabled,
}: {
  smoothPreset: SlopeSmoothPreset;
  onSmoothPresetChange: (p: SlopeSmoothPreset) => void;
  maxGrade: number;
  onMaxGradeChange: (g: number) => void;
  trapLengthM: number;
  onTrapLengthMChange: (v: number) => void;
  disabled?: boolean;
}) {
  const activePreset =
    SLOPE_SMOOTH_PRESETS.find((p) => p.id === smoothPreset) ??
    SLOPE_SMOOTH_PRESETS[1];
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/80 p-2.5">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Filtre spatial Z → α
      </p>
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
        {SLOPE_SMOOTH_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`rounded border px-1.5 py-1 text-[10px] font-semibold ${
              smoothPreset === p.id
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
            disabled={disabled}
            title={p.hint}
            onClick={() => onSmoothPresetChange(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p className="mt-1 text-[10px] leading-snug text-slate-500">
        SG {activePreset.smoothWindow} pts · MA {activePreset.sgMinSpanM} m ·
        ordre {activePreset.polyorder}
      </p>
      <label className="mt-2 block text-[11px] font-medium text-slate-700">
        <span className="mb-1 flex items-center justify-between">
          <span>Clamp grade DEM max</span>
          <span className="text-[10px] font-normal text-slate-500 tabular-nums">
            {(maxGrade * 100).toFixed(0)} %
          </span>
        </span>
        <select
          className="w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px]"
          value={String(maxGrade)}
          disabled={disabled}
          onChange={(e) => onMaxGradeChange(Number(e.target.value))}
        >
          {MAX_GRADE_OPTIONS.map((opt) => (
            <option key={opt.value} value={String(opt.value)}>
              {opt.label} · {opt.hint}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-2 block text-[11px] font-medium text-slate-700">
        <span className="mb-1 flex items-center justify-between">
          <span>Longueur trapèze L</span>
          <span className="text-[10px] font-normal text-slate-500 tabular-nums">
            {trapLengthM.toFixed(0)} m
          </span>
        </span>
        <div className="flex flex-wrap gap-1">
          {TRAP_LENGTH_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              disabled={disabled}
              onClick={() => onTrapLengthMChange(opt.value)}
              title={opt.hint}
              className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                trapLengthM === opt.value
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </label>
    </div>
  );
}

function MinMaxRow({
  label,
  minValue,
  maxValue,
  onMinChange,
  onMaxChange,
  minPlaceholder,
  maxPlaceholder,
  disabled,
  helpText,
}: {
  label: string;
  minValue: number | null;
  maxValue: number | null;
  onMinChange: (v: number | null) => void;
  onMaxChange: (v: number | null) => void;
  minPlaceholder?: string;
  maxPlaceholder?: string;
  disabled?: boolean;
  helpText?: string;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/80 p-2.5">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <div className="flex items-center gap-2 text-[11px] text-slate-700">
        <input
          type="number"
          className="w-full rounded border border-slate-200 bg-white px-1.5 py-1"
          placeholder={minPlaceholder}
          value={minValue ?? ""}
          disabled={disabled}
          onChange={(e) => {
            const raw = e.target.value.trim();
            if (raw === "") onMinChange(null);
            else {
              const v = Number(raw);
              onMinChange(Number.isFinite(v) ? v : null);
            }
          }}
        />
        <span className="text-slate-400">→</span>
        <input
          type="number"
          className="w-full rounded border border-slate-200 bg-white px-1.5 py-1"
          placeholder={maxPlaceholder}
          value={maxValue ?? ""}
          disabled={disabled}
          onChange={(e) => {
            const raw = e.target.value.trim();
            if (raw === "") onMaxChange(null);
            else {
              const v = Number(raw);
              onMaxChange(Number.isFinite(v) ? v : null);
            }
          }}
        />
      </div>
      {helpText && (
        <p className="mt-1.5 text-[10px] leading-snug text-slate-500">
          {helpText}
        </p>
      )}
    </div>
  );
}
