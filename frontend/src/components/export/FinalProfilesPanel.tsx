"use client";

/**
 * @deprecated Prefer ResultsAnalysisPanel + ResultsAnalyseStudio (unified step-4 desk).
 * RightPanel path is unused by CycleGenShell.
 */

import { useState, type ReactNode } from "react";
import type {
  ConsolidatedProfile,
  CycleGenWarning,
  SpatialCorridor,
} from "@/lib/types";
import type { SlopeUnit } from "@/lib/units";
import { DEFAULT_A_Y } from "@/lib/driverPresets";
import { withUpdatedFeux } from "@/lib/corridorEdit";
import LayoutToggle, {
  analysisShellClass,
  type ViewLayout,
} from "@/components/LayoutToggle";
import WarningsPanel, {
  trafficSourceBadgeClass,
  trafficSourceLabel,
} from "@/components/WarningsPanel";
import ProfileCharts from "./ProfileCharts";
import ProfileTable from "./ProfileTable";
import DownloadButtons from "./DownloadButtons";
import MicroInspectPanel from "@/components/corridor/MicroInspectPanel";
import TrafficLightsEditor from "@/components/corridor/TrafficLightsEditor";

export type FinalProfilesPanelProps = {
  profile: ConsolidatedProfile;
  slopeUnit?: SlopeUnit;
  onSlopeUnitChange?: (unit: SlopeUnit) => void;
  analysisExpanded?: boolean;
  viewLayout?: ViewLayout;
  onToggleLayout?: () => void;
  onViewLayoutChange?: (layout: ViewLayout) => void;
  corridor?: SpatialCorridor | null;
  onCorridorChange?: (corridor: SpatialCorridor) => void;
  syncEnabled?: boolean;
  onCursorS?: (s_m: number | null) => void;
  onBrushRangeS?: (range: { s0: number; s1: number } | null) => void;
  warnings?: CycleGenWarning[];
  trafficSource?: string | null;
  scenarioExtras?: ReactNode;
  /** Lateral comfort accel used for a_lat / export (m/s²). */
  aY?: number;
  referenceCycle?: {
    name: string;
    time: number[];
    velocity: number[];
  } | null;
  onClearReference?: () => void;
};

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return `${h}h ${rem}m ${s}s`;
  }
  return `${m} min ${s}s`;
}

export default function FinalProfilesPanel({
  profile,
  slopeUnit = "percent",
  onSlopeUnitChange,
  analysisExpanded = false,
  viewLayout: viewLayoutProp,
  onToggleLayout,
  onViewLayoutChange,
  corridor = null,
  onCorridorChange,
  syncEnabled = false,
  onCursorS,
  onBrushRangeS,
  warnings = [],
  trafficSource = null,
  scenarioExtras = null,
  aY = DEFAULT_A_Y,
  referenceCycle = null,
  onClearReference,
}: FinalProfilesPanelProps) {
  const viewLayout: ViewLayout =
    viewLayoutProp ?? (analysisExpanded ? "analysis" : "split");
  const tall = viewLayout === "analysis";
  const wideGrid = viewLayout === "analysis";
  const [microOpen, setMicroOpen] = useState(false);
  const [inspectS, setInspectS] = useState(0);
  const [inspectMeta, setInspectMeta] = useState<{
    t: number;
    speedKmh: number;
  } | null>(null);
  const [selectedFeu, setSelectedFeu] = useState<number | null>(null);

  const displayWarnings =
    warnings.length > 0
      ? warnings
      : profile.warnings?.length
        ? profile.warnings
        : corridor?.warnings ?? [];
  const trafficLabel = trafficSourceLabel(
    trafficSource ?? profile.traffic_source ?? corridor?.traffic_source
  );

  const badgeClass =
    profile.status === "completed"
      ? "bg-emerald-50 text-emerald-700"
      : "bg-amber-50 text-amber-700";

  const openInspect = (
    s_m: number,
    meta?: { t: number; speedKmh: number }
  ) => {
    setInspectS(s_m);
    setInspectMeta(meta ?? null);
    setMicroOpen(true);
  };

  const patchFeux = (S_feux: number[]) => {
    if (!corridor || !onCorridorChange) return;
    onCorridorChange(withUpdatedFeux(corridor, S_feux));
  };

  return (
    <aside className={analysisShellClass(viewLayout)}>
      <div className="flex items-start justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-900">
              Cycle généré
            </h2>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${badgeClass}`}
            >
              {profile.status}
            </span>
            {trafficLabel && (
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${trafficSourceBadgeClass(
                  trafficSource ??
                    profile.traffic_source ??
                    corridor?.traffic_source
                )}`}
              >
                {trafficLabel}
              </span>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-3 text-xs text-slate-600">
            <span>
              Duration{" "}
              <span className="font-semibold tabular-nums text-slate-900">
                {formatDuration(profile.total_duration_s)}
              </span>
            </span>
            <span>
              Avg{" "}
              <span className="font-semibold tabular-nums text-slate-900">
                {(profile.average_speed_kmh ?? 0).toFixed(1)} km/h
              </span>
            </span>
          </div>
          <p className="mt-1 text-[10px] leading-snug text-slate-400">
            Comparez v réalisée aux limites (enveloppe / légal / trafic /
            virage) et à une référence injectée sur le même graphe.
          </p>
        </div>
        {(onViewLayoutChange || onToggleLayout) && (
          <LayoutToggle
            layout={viewLayout}
            onLayoutChange={(next) => {
              onViewLayoutChange?.(next);
              if (!onViewLayoutChange && onToggleLayout) onToggleLayout();
            }}
          />
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <div className="w-full min-w-0 shrink-0">
          <ProfileCharts
            profile={profile}
            slopeUnit={slopeUnit}
            onSlopeUnitChange={onSlopeUnitChange}
            tall={tall || viewLayout === "split"}
            corridor={corridor}
            onInspectS={openInspect}
            highlightT={microOpen ? inspectMeta?.t ?? null : null}
            syncEnabled={syncEnabled}
            onCursorS={onCursorS}
            onBrushRangeS={onBrushRangeS}
            reference={referenceCycle}
            onClearReference={onClearReference}
            onChangeFeux={onCorridorChange ? patchFeux : undefined}
            selectedFeuIndex={selectedFeu}
            onSelectFeu={setSelectedFeu}
          />
        </div>
        <div
          className={`flex min-h-0 flex-col gap-3 ${
            wideGrid ? "lg:grid lg:grid-cols-2 lg:gap-4" : ""
          }`}
        >
          {scenarioExtras}
          <WarningsPanel warnings={displayWarnings} />
          {corridor && onCorridorChange && (
            <TrafficLightsEditor
              corridor={corridor}
              selectedIndex={selectedFeu}
              onSelect={setSelectedFeu}
              onChangeFeux={patchFeux}
              onChangeCorridor={onCorridorChange}
              onInspect={(s) => openInspect(s)}
            />
          )}

          {corridor && (
            <MicroInspectPanel
              open={microOpen}
              onClose={() => setMicroOpen(false)}
              corridor={corridor}
              inspectS={inspectS}
              onInspectSChange={setInspectS}
              selectedFeuIndex={selectedFeu}
              onAddFeuAtInspect={() => {
                patchFeux([...corridor.S_feux, inspectS]);
                setSelectedFeu(corridor.S_feux.length);
              }}
              onMoveSelectedFeuHere={() => {
                if (selectedFeu == null) return;
                const next = [...corridor.S_feux];
                next[selectedFeu] = inspectS;
                patchFeux(next);
              }}
              speedKmh={inspectMeta?.speedKmh ?? null}
              contextLabel={
                inspectMeta
                  ? `From v(t) at t=${inspectMeta.t.toFixed(0)}s`
                  : "From profile / lights"
              }
            />
          )}

          {!microOpen && corridor && (
            <button
              type="button"
              onClick={() =>
                openInspect(
                  corridor.S_feux[0] ??
                    profile.position[
                      Math.floor(profile.position.length / 2)
                    ] ??
                    0
                )
              }
              className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-700 hover:bg-white"
            >
              Open microscopic check (from speed curve)
            </button>
          )}

          <ProfileTable
            profile={profile}
            maxRows={tall ? 40 : 20}
            slopeUnit={slopeUnit}
          />
          <div className="shrink-0 border-t border-slate-200 pt-3">
            <DownloadButtons
              variant="stack"
              profile={profile}
              corridor={corridor}
              aY={aY}
              trafficSource={trafficSource}
            />
          </div>
        </div>
      </div>
    </aside>
  );
}
