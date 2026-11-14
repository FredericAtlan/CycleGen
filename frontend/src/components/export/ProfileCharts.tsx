"use client";

import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  ComposedChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  ReferenceArea,
  Legend,
} from "recharts";
import type { ConsolidatedProfile, SpatialCorridor } from "@/lib/types";
import {
  slopeFromRad,
  slopeExtremes,
  slopeUnitLabel,
  type SlopeUnit,
} from "@/lib/units";
import { nearestTimeIndex } from "@/lib/corridorEdit";
import {
  TIME_X_AXIS_PROPS,
  formatTimeLabel,
  resampleUniform,
} from "@/lib/chartTime";
import { snapPostedSpeedKmh } from "@/lib/cycleMetrics";
import SlopeUnitToggle from "@/components/SlopeUnitToggle";

/** Saved / corpus reference series for overlay on v(t). */
export type SpeedReferenceSeries = {
  name: string;
  time: number[];
  /** m/s */
  velocity: number[];
};

type ProfileChartsProps = {
  profile: ConsolidatedProfile;
  slopeUnit?: SlopeUnit;
  onSlopeUnitChange?: (unit: SlopeUnit) => void;
  tall?: boolean;
  corridor?: SpatialCorridor | null;
  onInspectS?: (s_m: number, meta?: { t: number; speedKmh: number }) => void;
  highlightT?: number | null;
  onCursorS?: (s_m: number | null) => void;
  onBrushRangeS?: (range: { s0: number; s1: number } | null) => void;
  syncEnabled?: boolean;
  reference?: SpeedReferenceSeries | null;
  onClearReference?: () => void;
  /** Replace corridor S_feux (insert/remove from pin rail). */
  onChangeFeux?: (S_feux: number[]) => void;
  selectedFeuIndex?: number | null;
  onSelectFeu?: (index: number | null) => void;
  /** Open full inspect drawer (results). */
  onExpandChart?: (series: "v_kmh" | "slope") => void;
};

type LimitToggles = {
  envelope: boolean;
  legal: boolean;
  traffic: boolean;
  curve: boolean;
};

type Row = {
  t: number;
  v_kmh: number;
  slope: number;
  s_m: number;
  env_kmh: number;
  legal_kmh: number;
  traffic_kmh: number;
  curve_kmh: number;
  v_ref_kmh: number;
};

function mpsToKmh(v: number | null | undefined): number {
  if (v == null || !Number.isFinite(v) || v <= 0) return Number.NaN;
  const kmh = v * 3.6;
  if (kmh > 160) return Number.NaN;
  return kmh;
}

function interp1d(xs: number[], ys: number[], x: number): number {
  if (!xs.length || !ys.length) return Number.NaN;
  if (x <= xs[0]) return ys[0] ?? Number.NaN;
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1] ?? Number.NaN;
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const x0 = xs[lo];
  const x1 = xs[hi];
  const u = x1 > x0 ? (x - x0) / (x1 - x0) : 0;
  return ys[lo] + (ys[hi] - ys[lo]) * u;
}

/** Linear sample of a corridor series at abscissa s (m). */
function sampleAtS(S: number[], V: number[] | undefined, s: number): number | null {
  if (!V || V.length === 0 || S.length !== V.length) return null;
  if (s <= S[0]) return V[0];
  const last = S.length - 1;
  if (s >= S[last]) return V[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (S[mid] <= s) lo = mid;
    else hi = mid;
  }
  const s0 = S[lo];
  const s1 = S[hi];
  const t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
  return V[lo] + (V[hi] - V[lo]) * t;
}

/** Posted limits are piecewise constant — no linear blend between 30 and 50. */
function sampleAtSHold(
  S: number[],
  V: number[] | undefined,
  s: number
): number | null {
  if (!V || V.length === 0 || S.length !== V.length) return null;
  if (s <= S[0]) return V[0];
  const last = S.length - 1;
  if (s >= S[last]) return V[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (S[mid] <= s) lo = mid;
    else hi = mid;
  }
  return V[lo];
}

function buildChartData(
  profile: ConsolidatedProfile,
  unit: SlopeUnit,
  corridor: SpatialCorridor | null,
  reference: SpeedReferenceSeries | null | undefined
): Row[] {
  const n = Math.min(
    profile.time.length,
    profile.velocity.length,
    profile.slope.length,
    profile.position.length
  );
  const S = corridor?.S ?? [];
  const env =
    corridor?.V_envelope?.length === S.length
      ? corridor.V_envelope
      : corridor?.V_limite;
  const legal = corridor?.V_limite_legal;
  const traffic = corridor?.V_traffic;
  const curve = corridor?.V_curve;
  const hasRef =
    !!reference &&
    reference.time.length >= 2 &&
    reference.velocity.length === reference.time.length;

  const raw: Row[] = [];
  for (let i = 0; i < n; i++) {
    const s_m = profile.position[i];
    const t = profile.time[i];
    const vRef = hasRef
      ? interp1d(reference!.time, reference!.velocity, t) * 3.6
      : Number.NaN;
    raw.push({
      t,
      v_kmh: profile.velocity[i] * 3.6,
      slope: slopeFromRad(profile.slope[i], unit),
      s_m,
      env_kmh: mpsToKmh(sampleAtS(S, env, s_m)),
      legal_kmh: (() => {
        const raw = mpsToKmh(sampleAtSHold(S, legal, s_m));
        return Number.isFinite(raw) ? snapPostedSpeedKmh(raw) : Number.NaN;
      })(),
      traffic_kmh: mpsToKmh(sampleAtS(S, traffic, s_m)),
      curve_kmh: mpsToKmh(sampleAtS(S, curve, s_m)),
      v_ref_kmh: Number.isFinite(vRef) ? vRef : Number.NaN,
    });
  }
  return resampleUniform(raw, "t", { maxPoints: 800, dtPrefer: 1 });
}

function feuxTimes(
  profile: ConsolidatedProfile,
  S_feux: number[]
): { t: number; index: number; s_m: number }[] {
  const out: { t: number; index: number; s_m: number }[] = [];
  const pos = profile.position;
  const time = profile.time;
  if (!pos.length || !time.length) return out;

  S_feux.forEach((sTarget, index) => {
    let hit = -1;
    for (let i = 0; i < pos.length; i++) {
      if (pos[i] >= sTarget) {
        hit = i;
        break;
      }
    }
    if (hit < 0) hit = pos.length - 1;
    out.push({ t: time[hit], index, s_m: sTarget });
  });
  return out;
}

/** Parallel time axis under v(t) with clickable traffic-light pins. */
function TlsPinRail({
  domain,
  marks,
  editEnabled,
  onEditEnabledChange,
  selectedIndex,
  canEdit,
  onSelect,
  onRemove,
  onInsertAtT,
}: {
  domain: [number, number];
  marks: { t: number; index: number; s_m: number }[];
  editEnabled: boolean;
  onEditEnabledChange: (v: boolean) => void;
  selectedIndex: number | null;
  canEdit: boolean;
  onSelect: (index: number) => void;
  onRemove: (index: number) => void;
  onInsertAtT: (t: number) => void;
}) {
  const [d0, d1] = domain;
  const span = Math.max(1e-6, d1 - d0);
  const pct = (t: number) => ((t - d0) / span) * 100;
  const visible = marks.filter((m) => m.t >= d0 - 0.5 && m.t <= d1 + 0.5);

  const handleRailClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!editEnabled || !canEdit) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = e.clientX - rect.left;
    const t = d0 + (x / rect.width) * span;
    if (!Number.isFinite(t)) return;
    onInsertAtT(t);
  };

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2 pl-10 pr-3">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Feux tricolores
          <span className="ml-1.5 font-normal normal-case text-slate-400">
            ({marks.length})
          </span>
        </span>
        {canEdit && (
          <button
            type="button"
            role="switch"
            aria-checked={editEnabled}
            title={
              editEnabled
                ? "Désactiver l’édition (clic pine = inspecter)"
                : "Activer : clic pine = retirer, clic axe = insérer"
            }
            onClick={() => onEditEnabledChange(!editEnabled)}
            className={`rounded-md px-2 py-0.5 text-[10px] font-semibold transition ${
              editEnabled
                ? "bg-red-600 text-white"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {editEnabled ? "Édition ON" : "Éditer feux"}
          </button>
        )}
      </div>
      <div className="pl-10 pr-3">
        <div
          role="presentation"
          onClick={handleRailClick}
          className={`relative h-8 rounded-md border border-slate-200 bg-slate-50/80 ${
            editEnabled && canEdit
              ? "cursor-copy ring-1 ring-red-200"
              : "cursor-default"
          }`}
          title={
            editEnabled
              ? "Clic sur l’axe pour insérer un feu à cet instant"
              : undefined
          }
        >
          <div className="pointer-events-none absolute inset-x-2 top-[18px] h-px bg-slate-300" />
          {visible.map(({ t, index, s_m }) => {
            const active = selectedIndex === index;
            return (
              <button
                key={`pin-${index}-${s_m.toFixed(1)}`}
                type="button"
                style={{ left: `${pct(t)}%` }}
                title={
                  editEnabled
                    ? `Retirer feu ${index + 1} (${Math.round(s_m)} m)`
                    : `Feu ${index + 1} · ${Math.round(s_m)} m · t=${t.toFixed(0)}s`
                }
                onClick={(e) => {
                  e.stopPropagation();
                  if (editEnabled && canEdit) onRemove(index);
                  else onSelect(index);
                }}
                className={`absolute top-0 z-[1] flex -translate-x-1/2 flex-col items-center outline-none ${
                  editEnabled ? "cursor-pointer hover:opacity-80" : "cursor-pointer"
                }`}
              >
                <span
                  className={`flex h-3.5 w-3.5 items-center justify-center rounded-full text-[8px] font-bold text-white shadow-sm ring-2 ${
                    active
                      ? "bg-red-700 ring-red-300"
                      : editEnabled
                        ? "bg-red-500 ring-white hover:bg-red-600"
                        : "bg-red-500 ring-white"
                  }`}
                >
                  {index + 1}
                </span>
                <span
                  className={`h-2.5 w-px ${active ? "bg-red-700" : "bg-red-500"}`}
                />
                <span
                  className={`h-1.5 w-1.5 rotate-45 ${
                    active ? "bg-red-700" : "bg-red-500"
                  }`}
                />
              </button>
            );
          })}
        </div>
      </div>
      {editEnabled && canEdit && (
        <p className="pl-10 pr-3 text-[10px] leading-snug text-red-700/80">
          Clic sur une pine = retirer · clic sur l’axe = insérer · puis
          Appliquer pour régénérer le cycle.
        </p>
      )}
    </div>
  );
}

const SHORT_NAMES: Record<string, string> = {
  v_kmh: "v",
  env_kmh: "Env",
  legal_kmh: "Lég",
  traffic_kmh: "Traf",
  curve_kmh: "Vir",
  v_ref_kmh: "Réf",
  slope: "α",
};

function CompactTooltip({
  active,
  payload,
  label,
  unit = "km/h",
  digits = 0,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{
    dataKey?: string | number;
    name?: string;
    value?: number | string;
    color?: string;
  }>;
  label?: string | number;
  unit?: string;
  digits?: number;
}) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((p) => {
    const v = typeof p.value === "number" ? p.value : Number(p.value);
    return Number.isFinite(v);
  });
  if (!rows.length) return null;
  return (
    <div className="pointer-events-none max-w-[200px] rounded border border-slate-200/90 bg-white/95 px-1.5 py-1 shadow-sm backdrop-blur-sm">
      <div className="mb-0.5 text-[9px] font-semibold tabular-nums text-slate-500">
        {formatTimeLabel(Number(label))}
      </div>
      <div className="flex flex-wrap gap-x-1.5 gap-y-0.5">
        {rows.map((p) => {
          const key = String(p.dataKey ?? p.name ?? "");
          const short = SHORT_NAMES[key] ?? String(p.name ?? key).slice(0, 4);
          const v = typeof p.value === "number" ? p.value : Number(p.value);
          return (
            <span
              key={key}
              className="inline-flex items-center gap-0.5 text-[10px] tabular-nums text-slate-800"
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: p.color ?? "#64748b" }}
              />
              <span className="font-medium text-slate-500">{short}</span>
              {v.toFixed(digits)}
              <span className="text-slate-400">{unit}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

const LIMIT_SERIES = [
  {
    key: "env_kmh" as const,
    toggle: "envelope" as const,
    name: "V enveloppe",
    stroke: "#2563eb",
    dash: "4 3",
  },
  {
    key: "legal_kmh" as const,
    toggle: "legal" as const,
    name: "V légal",
    stroke: "#64748b",
    dash: "2 2",
  },
  {
    key: "traffic_kmh" as const,
    toggle: "traffic" as const,
    name: "V trafic",
    stroke: "#ea580c",
    dash: "4 2",
  },
  {
    key: "curve_kmh" as const,
    toggle: "curve" as const,
    name: "V virage",
    stroke: "#7c3aed",
    dash: "3 3",
  },
];

export default function ProfileCharts({
  profile,
  slopeUnit = "percent",
  onSlopeUnitChange,
  tall = false,
  corridor = null,
  onInspectS,
  highlightT = null,
  onCursorS,
  onBrushRangeS,
  syncEnabled = false,
  reference = null,
  onClearReference,
  onChangeFeux,
  selectedFeuIndex = null,
  onSelectFeu,
  onExpandChart,
}: ProfileChartsProps) {
  const data = useMemo(
    () => buildChartData(profile, slopeUnit, corridor, reference),
    [profile, slopeUnit, corridor, reference]
  );
  const unitLabel = slopeUnitLabel(slopeUnit);
  const slopeExt = useMemo(
    () => slopeExtremes(profile.slope, slopeUnit),
    [profile.slope, slopeUnit]
  );
  const slopeDigits = slopeUnit === "percent" ? 1 : slopeUnit === "deg" ? 2 : 4;
  const tlsMarks = useMemo(
    () => (corridor ? feuxTimes(profile, corridor.S_feux ?? []) : []),
    [corridor, profile]
  );

  const hasLimits = useMemo(
    () =>
      data.some(
        (r) =>
          Number.isFinite(r.env_kmh) ||
          Number.isFinite(r.legal_kmh) ||
          Number.isFinite(r.traffic_kmh) ||
          Number.isFinite(r.curve_kmh)
      ),
    [data]
  );
  const hasRef = useMemo(
    () => data.some((r) => Number.isFinite(r.v_ref_kmh)),
    [data]
  );

  const [limits, setLimits] = useState<LimitToggles>({
    envelope: true,
    legal: true,
    traffic: true,
    curve: true,
  });
  const [showRef, setShowRef] = useState(true);
  const [editFeux, setEditFeux] = useState(false);

  useEffect(() => {
    if (hasRef) setShowRef(true);
  }, [reference?.name, hasRef]);

  const tMin = data[0]?.t ?? 0;
  const tMax = data.length ? data[data.length - 1].t : 0;
  const tripSpan = Math.max(0, tMax - tMin);

  const [windowSec, setWindowSec] = useState(30);
  const [windowStartT, setWindowStartT] = useState(0);
  /** full = whole trip on chart+map ; window = zoom chart+map to X seconds */
  const [viewMode, setViewMode] = useState<"full" | "window">("full");

  useEffect(() => {
    setViewMode("full");
    setWindowStartT(tMin);
    setWindowSec((w) => {
      if (tripSpan <= 0) return 30;
      return Math.min(Math.max(5, w), Math.max(5, Math.round(tripSpan)));
    });
  }, [profile, tMin, tripSpan]);

  const clampedWidth = useMemo(() => {
    if (tripSpan <= 0) return 30;
    return Math.min(Math.max(5, windowSec), Math.max(5, tripSpan));
  }, [windowSec, tripSpan]);

  const winT0 = useMemo(() => {
    const maxStart = Math.max(tMin, tMax - clampedWidth);
    return Math.min(Math.max(windowStartT, tMin), maxStart);
  }, [windowStartT, tMin, tMax, clampedWidth]);

  const winT1 = useMemo(
    () => Math.min(tMax, winT0 + clampedWidth),
    [winT0, clampedWidth, tMax]
  );

  const xDomain: [number, number] = useMemo(() => {
    if (viewMode === "window" && winT1 > winT0) return [winT0, winT1];
    return [tMin, tMax || 1];
  }, [viewMode, winT0, winT1, tMin, tMax]);

  useEffect(() => {
    if (viewMode === "full") {
      onBrushRangeS?.(null);
    }
  }, [viewMode, onBrushRangeS]);

  useEffect(() => {
    if (!onBrushRangeS) return;
    if (viewMode !== "window" || tripSpan <= 0 || data.length < 2) return;
    if (clampedWidth >= tripSpan - 0.25) {
      onBrushRangeS(null);
      return;
    }
    const i0 = nearestTimeIndex(profile.time, winT0);
    const i1 = nearestTimeIndex(profile.time, winT1);
    const s0 = profile.position[Math.min(i0, i1)] ?? 0;
    const s1 = profile.position[Math.max(i0, i1)] ?? 0;
    if (Math.abs(s1 - s0) < 1) {
      onBrushRangeS(null);
      return;
    }
    onBrushRangeS({ s0: Math.min(s0, s1), s1: Math.max(s0, s1) });
  }, [
    viewMode,
    winT0,
    winT1,
    clampedWidth,
    tripSpan,
    data.length,
    profile.time,
    profile.position,
    onBrushRangeS,
  ]);

  const emitCursorFromT = useCallback(
    (t: number) => {
      if (!onCursorS || !Number.isFinite(t)) return;
      const i = nearestTimeIndex(profile.time, t);
      onCursorS(profile.position[i] ?? null);
    },
    [onCursorS, profile.position, profile.time]
  );

  const handleChartClick = useCallback(
    (state: { activeLabel?: string | number } | null) => {
      if (!onInspectS || !state) return;
      const t = Number(state.activeLabel);
      if (!Number.isFinite(t)) return;
      const i = nearestTimeIndex(profile.time, t);
      const s_m = profile.position[i] ?? 0;
      const speedKmh = (profile.velocity[i] ?? 0) * 3.6;
      onInspectS(s_m, { t: profile.time[i] ?? t, speedKmh });
      if (syncEnabled) onCursorS?.(s_m);
    },
    [onInspectS, onCursorS, profile, syncEnabled]
  );

  const handleMouseMove = useCallback(
    (state: {
      isTooltipActive?: boolean;
      activeLabel?: string | number;
    } | null) => {
      if (!syncEnabled || !onCursorS) return;
      if (!state?.isTooltipActive) return;
      emitCursorFromT(Number(state.activeLabel));
    },
    [syncEnabled, onCursorS, emitCursorFromT]
  );

  const handleMouseLeave = useCallback(() => {
    if (syncEnabled) onCursorS?.(null);
  }, [syncEnabled, onCursorS]);

  const canEditFeux = Boolean(corridor && onChangeFeux);

  const handleSelectFeu = useCallback(
    (index: number) => {
      onSelectFeu?.(index);
      const mark = tlsMarks.find((m) => m.index === index);
      if (!mark || !onInspectS) return;
      const i = nearestTimeIndex(profile.time, mark.t);
      const speedKmh = (profile.velocity[i] ?? 0) * 3.6;
      onInspectS(mark.s_m, { t: profile.time[i] ?? mark.t, speedKmh });
      if (syncEnabled) onCursorS?.(mark.s_m);
    },
    [
      onSelectFeu,
      tlsMarks,
      onInspectS,
      profile.time,
      profile.velocity,
      syncEnabled,
      onCursorS,
    ]
  );

  const handleRemoveFeu = useCallback(
    (index: number) => {
      if (!corridor || !onChangeFeux) return;
      const next = (corridor.S_feux ?? []).filter((_, i) => i !== index);
      onChangeFeux(next);
      if (selectedFeuIndex === index) onSelectFeu?.(null);
      else if (selectedFeuIndex != null && selectedFeuIndex > index) {
        onSelectFeu?.(selectedFeuIndex - 1);
      }
    },
    [corridor, onChangeFeux, selectedFeuIndex, onSelectFeu]
  );

  const handleInsertFeuAtT = useCallback(
    (t: number) => {
      if (!corridor || !onChangeFeux) return;
      const i = nearestTimeIndex(profile.time, t);
      const s_m = profile.position[i] ?? 0;
      onChangeFeux([...(corridor.S_feux ?? []), s_m]);
    },
    [corridor, onChangeFeux, profile.time, profile.position]
  );

  const clearWindow = useCallback(() => {
    setViewMode("full");
  }, []);

  const showWindowView = useCallback(() => {
    setViewMode("window");
  }, []);

  const moveWindow = useCallback((startT: number, widthS?: number) => {
    setWindowStartT(startT);
    if (widthS != null) setWindowSec(widthS);
  }, []);

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <button
            type="button"
            onClick={() => onExpandChart?.("v_kmh")}
            className={`text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${
              onExpandChart
                ? "cursor-pointer hover:text-brand"
                : ""
            }`}
            title={onExpandChart ? "Agrandir dans le volet d’inspection" : undefined}
          >
            Vitesse réalisée vs limites
            {onExpandChart && (
              <span className="ml-1.5 text-[9px] font-normal normal-case text-brand">
                agrandir →
              </span>
            )}
          </button>
          <span className="text-[10px] text-slate-400">
            {syncEnabled ? "hover syncs map · " : ""}
            {viewMode === "window"
              ? "vue fenêtre (carte sync)"
              : "vue trajet entier"}
          </span>
        </div>
        {hasLimits && (
          <div className="flex flex-wrap gap-1">
            {(
              [
                ["envelope", "Enveloppe", "#2563eb"],
                ["legal", "Légal", "#64748b"],
                ["traffic", "Trafic", "#ea580c"],
                ["curve", "Virage", "#7c3aed"],
              ] as const
            ).map(([key, label, color]) => {
              const on = limits[key];
              return (
                <button
                  key={key}
                  type="button"
                  title={`Afficher / masquer ${label}`}
                  onClick={() =>
                    setLimits((prev) => ({ ...prev, [key]: !prev[key] }))
                  }
                  className={`inline-flex min-h-[26px] items-center gap-1 rounded-md px-2 text-[10px] font-semibold transition ${
                    on
                      ? "text-white shadow-sm"
                      : "bg-slate-50 text-slate-500 ring-1 ring-slate-200"
                  }`}
                  style={on ? { backgroundColor: color } : undefined}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
        {hasRef && reference && (
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              title="Afficher / masquer la référence sur le graphe"
              onClick={() => setShowRef((v) => !v)}
              className={`inline-flex min-h-[26px] max-w-[180px] items-center gap-1 truncate rounded-md px-2 text-[10px] font-semibold transition ${
                showRef
                  ? "bg-emerald-600 text-white shadow-sm"
                  : "bg-slate-50 text-slate-500 ring-1 ring-slate-200"
              }`}
            >
              <span className="truncate">Réf · {reference.name}</span>
            </button>
            {onClearReference && (
              <button
                type="button"
                title="Retirer la référence (carte + graphe)"
                onClick={onClearReference}
                className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-red-50 hover:text-red-600"
                aria-label="Retirer la référence"
              >
                ×
              </button>
            )}
          </div>
        )}
        <div
          className={`w-full ${tall ? "h-72" : "h-52"} ${
            onExpandChart ? "cursor-pointer" : ""
          }`}
          onDoubleClick={() => onExpandChart?.("v_kmh")}
          title={onExpandChart ? "Double-clic pour agrandir" : undefined}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={data}
              syncId="cyclegen-profile"
              margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
              onClick={handleChartClick}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
              style={{
                cursor: onInspectS || syncEnabled ? "crosshair" : undefined,
              }}
            >
              <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
              <XAxis
                dataKey="t"
                type="number"
                scale="linear"
                domain={xDomain}
                allowDataOverflow
                allowDecimals={false}
                tickFormatter={TIME_X_AXIS_PROPS.tickFormatter}
                tick={{ fontSize: 10, fill: "#64748b" }}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "#64748b" }}
                width={40}
                domain={[0, "auto"]}
                unit=" km/h"
              />
              <Tooltip
                content={<CompactTooltip unit="km/h" digits={0} />}
                offset={14}
                allowEscapeViewBox={{ x: true, y: true }}
                wrapperStyle={{ zIndex: 20, outline: "none" }}
                cursor={{ stroke: "#94a3b8", strokeWidth: 1, strokeDasharray: "3 3" }}
              />
              {(hasLimits || (hasRef && showRef)) && (
                <Legend
                  wrapperStyle={{ fontSize: 10, paddingTop: 2 }}
                  iconSize={8}
                />
              )}
              {tlsMarks.map(({ t, index }) => (
                <ReferenceLine
                  key={`tls-t-${index}`}
                  x={t}
                  stroke="#dc2626"
                  strokeDasharray="3 3"
                  strokeWidth={1.25}
                  label={
                    tall
                      ? {
                          value: `F${index + 1}`,
                          position: "insideTopRight",
                          fill: "#dc2626",
                          fontSize: 9,
                        }
                      : undefined
                  }
                />
              ))}
              {highlightT != null && (
                <ReferenceLine
                  x={highlightT}
                  stroke="#0f172a"
                  strokeWidth={1.5}
                />
              )}
              {viewMode === "full" && winT1 > winT0 && tripSpan > clampedWidth + 0.5 && (
                <ReferenceArea
                  x1={winT0}
                  x2={winT1}
                  fill="#f59e0b"
                  fillOpacity={0.16}
                  stroke="#f59e0b"
                  strokeOpacity={0.55}
                  ifOverflow="hidden"
                />
              )}
              {LIMIT_SERIES.map((s) => {
                if (!limits[s.toggle]) return null;
                if (!data.some((r) => Number.isFinite(r[s.key]))) return null;
                return (
                  <Line
                    key={s.key}
                    type="stepAfter"
                    dataKey={s.key}
                    name={s.name}
                    stroke={s.stroke}
                    strokeWidth={1.25}
                    strokeDasharray={s.dash}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                );
              })}
              {hasRef && showRef && (
                <Line
                  type="monotone"
                  dataKey="v_ref_kmh"
                  name={`Réf · ${reference?.name ?? "référence"}`}
                  stroke="#059669"
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              )}
              <Line
                type="monotone"
                dataKey="v_kmh"
                name="v réalisée"
                stroke="#0f172a"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {corridor && (
          <TlsPinRail
            domain={xDomain}
            marks={tlsMarks}
            editEnabled={editFeux}
            onEditEnabledChange={setEditFeux}
            selectedIndex={selectedFeuIndex}
            canEdit={canEditFeux}
            onSelect={handleSelectFeu}
            onRemove={handleRemoveFeu}
            onInsertAtT={handleInsertFeuAtT}
          />
        )}

        <div className="rounded-md border border-amber-100 bg-amber-50/50 px-2 py-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-900">
              Curseur
            </span>
            <label className="inline-flex items-center gap-1 text-[10px] font-medium text-slate-600">
              Largeur
              <input
                type="number"
                min={5}
                max={Math.max(5, Math.round(tripSpan) || 5)}
                step={5}
                value={clampedWidth}
                disabled={tripSpan <= 0}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (!Number.isFinite(n)) return;
                  moveWindow(winT0, n);
                }}
                className="w-12 rounded border border-slate-200 bg-white px-1 py-0.5 text-[11px] tabular-nums"
              />
              <span className="text-slate-400">s</span>
            </label>
            <div
              role="radiogroup"
              aria-label="Mode d’affichage"
              className="inline-flex rounded-md border border-amber-200 bg-white p-0.5"
            >
              <button
                type="button"
                role="radio"
                aria-checked={viewMode === "full"}
                aria-label="Tout le graphe"
                title="Tout le graphe"
                onClick={clearWindow}
                className={`inline-flex h-6 w-6 items-center justify-center rounded transition ${
                  viewMode === "full"
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden
                >
                  <rect x="3" y="4" width="18" height="16" rx="1.5" />
                  <polyline points="5 15 9 10 13 13 19 7" />
                </svg>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={viewMode === "window"}
                aria-label={`Fenêtre ${clampedWidth.toFixed(0)} s`}
                disabled={tripSpan <= 0}
                title={`Fenêtre ${clampedWidth.toFixed(0)} s`}
                onClick={showWindowView}
                className={`inline-flex h-6 w-6 items-center justify-center rounded transition disabled:opacity-40 ${
                  viewMode === "window"
                    ? "bg-amber-600 text-white"
                    : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden
                >
                  <rect x="3" y="4" width="18" height="16" rx="1.5" />
                  <rect x="9" y="6" width="6" height="12" rx="0.5" />
                </svg>
              </button>
            </div>
            <span className="ml-auto text-[10px] tabular-nums text-amber-900">
              {formatTimeLabel(winT0)}→{formatTimeLabel(winT1)}
            </span>
          </div>
          <input
            type="range"
            min={tMin}
            max={Math.max(tMin, tMax - clampedWidth)}
            step={Math.max(0.5, tripSpan / 400)}
            value={winT0}
            disabled={tripSpan <= 0}
            onChange={(e) => {
              const t = Number(e.target.value);
              if (!Number.isFinite(t)) return;
              moveWindow(t);
            }}
            className="mt-1 w-full accent-amber-600 disabled:opacity-40"
            title="Position du curseur"
            aria-label="Position du curseur sur la timeline"
          />
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => onExpandChart?.("slope")}
            className={`text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${
              onExpandChart ? "cursor-pointer hover:text-brand" : ""
            }`}
            title={onExpandChart ? "Agrandir dans le volet d’inspection" : undefined}
          >
            Pente α(t)
            {onExpandChart && (
              <span className="ml-1.5 text-[9px] font-normal normal-case text-brand">
                agrandir →
              </span>
            )}
            {slopeExt && (
              <span className="ml-2 text-[10px] font-normal normal-case tabular-nums text-slate-500">
                min{" "}
                <span className="font-bold text-slate-800">
                  {slopeExt.min.toFixed(slopeDigits)}
                </span>{" "}
                · max{" "}
                <span className="font-bold text-slate-800">
                  {slopeExt.max.toFixed(slopeDigits)}
                </span>{" "}
                {unitLabel}
              </span>
            )}
          </button>
          {onSlopeUnitChange ? (
            <SlopeUnitToggle value={slopeUnit} onChange={onSlopeUnitChange} />
          ) : (
            <span className="text-[10px] text-slate-400">{unitLabel}</span>
          )}
        </div>
        <div
          className={`w-full ${tall ? "h-40" : "h-28"} ${
            onExpandChart ? "cursor-pointer" : ""
          }`}
          onDoubleClick={() => onExpandChart?.("slope")}
          title={onExpandChart ? "Double-clic pour agrandir" : undefined}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              syncId="cyclegen-profile"
              margin={{ top: 4, right: 8, left: -8, bottom: 0 }}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
            >
              <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
              <XAxis
                dataKey="t"
                type="number"
                scale="linear"
                domain={xDomain}
                allowDataOverflow
                allowDecimals={false}
                tickFormatter={TIME_X_AXIS_PROPS.tickFormatter}
                tick={{ fontSize: 10, fill: "#64748b" }}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "#64748b" }}
                width={36}
                tickFormatter={(v: number) =>
                  slopeUnit === "percent" ? v.toFixed(0) : v.toFixed(2)
                }
              />
              <Tooltip
                content={
                  <CompactTooltip
                    unit={unitLabel}
                    digits={slopeUnit === "percent" ? 1 : 2}
                  />
                }
                offset={12}
                allowEscapeViewBox={{ x: true, y: true }}
                wrapperStyle={{ zIndex: 20, outline: "none" }}
              />
              {viewMode === "full" && winT1 > winT0 && tripSpan > clampedWidth + 0.5 && (
                <ReferenceArea
                  x1={winT0}
                  x2={winT1}
                  fill="#f59e0b"
                  fillOpacity={0.12}
                  stroke="#f59e0b"
                  strokeOpacity={0.45}
                  ifOverflow="hidden"
                />
              )}
              <Line
                type="monotone"
                dataKey="slope"
                stroke="#16a34a"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
