"use client";

import { useState, type ReactNode } from "react";
import type { CycleGenWarning, SpatialCorridor } from "@/lib/types";
import type { SlopeUnit } from "@/lib/units";
import { withUpdatedFeux, type EnvelopeMask } from "@/lib/corridorEdit";
import LayoutToggle, {
  analysisShellClass,
  type ViewLayout,
} from "@/components/LayoutToggle";
import WarningsPanel, {
  trafficSourceBadgeClass,
  trafficSourceLabel,
} from "@/components/WarningsPanel";
import SlopeChart from "./SlopeChart";
import ElevationProfileChart from "./ElevationProfileChart";
import SpeedLimitChart from "./SpeedLimitChart";
import EnvelopeMaskToggles from "./EnvelopeMaskToggles";
import DetectedEventsList from "./DetectedEventsList";
import TrafficLightsEditor from "./TrafficLightsEditor";
import MicroInspectPanel from "./MicroInspectPanel";

type StaticConstraintPanelProps = {
  corridor: SpatialCorridor | null;
  loading: boolean;
  error: string | null;
  onGenerateSimulation: () => void;
  onRetry?: () => void;
  slopeUnit?: SlopeUnit;
  onSlopeUnitChange?: (unit: SlopeUnit) => void;
  analysisExpanded?: boolean;
  viewLayout?: ViewLayout;
  onToggleLayout?: () => void;
  onViewLayoutChange?: (layout: ViewLayout) => void;
  onCorridorChange?: (corridor: SpatialCorridor) => void;
  syncEnabled?: boolean;
  onCursorS?: (s_m: number | null) => void;
  onBrushRangeS?: (range: { s0: number; s1: number } | null) => void;
  warnings?: CycleGenWarning[];
  trafficSource?: string | null;
  scenarioExtras?: ReactNode;
  envelopeMask?: EnvelopeMask;
  onEnvelopeMaskChange?: (mask: EnvelopeMask) => void;
  speedFactor?: number;
  maxSpeedKmh?: number | null;
  /** Fallback L when corridor.slope_profile is missing. */
  trapLengthM?: number;
};

function LoadingBlock() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      <p className="text-sm text-slate-500">Building spatial cycle…</p>
      <p className="text-xs text-slate-400">
        Computing α(s), V_lim(s) and detected events
      </p>
    </div>
  );
}

function EmptyBlock() {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-slate-400">
      Analyze a route, then run static constraint analysis to populate charts.
    </div>
  );
}

export default function StaticConstraintPanel({
  corridor,
  loading,
  error,
  onGenerateSimulation,
  onRetry,
  slopeUnit = "percent",
  onSlopeUnitChange,
  analysisExpanded = false,
  viewLayout: viewLayoutProp,
  onToggleLayout,
  onViewLayoutChange,
  onCorridorChange,
  syncEnabled = false,
  onCursorS,
  onBrushRangeS,
  warnings = [],
  trafficSource = null,
  scenarioExtras = null,
  envelopeMask,
  onEnvelopeMaskChange,
  speedFactor,
  maxSpeedKmh = null,
  trapLengthM,
}: StaticConstraintPanelProps) {
  const viewLayout: ViewLayout =
    viewLayoutProp ?? (analysisExpanded ? "analysis" : "split");
  const tall = viewLayout === "analysis";
  const wideGrid = viewLayout === "analysis";
  const [microOpen, setMicroOpen] = useState(false);
  const [inspectS, setInspectS] = useState(0);
  const [selectedFeu, setSelectedFeu] = useState<number | null>(null);

  const displayWarnings =
    warnings.length > 0 ? warnings : corridor?.warnings ?? [];
  const trafficLabel = trafficSourceLabel(
    trafficSource ?? corridor?.traffic_source
  );

  const status =
    loading
      ? "building…"
      : error
        ? "error"
        : corridor
          ? "ready"
          : "pending";

  const openInspect = (s_m: number) => {
    setInspectS(s_m);
    setMicroOpen(true);
  };

  const patchFeux = (S_feux: number[]) => {
    if (!corridor || !onCorridorChange) return;
    onCorridorChange(withUpdatedFeux(corridor, S_feux));
  };

  return (
    <aside className={analysisShellClass(viewLayout)}>
      <div className="flex items-start justify-between gap-2 border-b border-slate-200 px-4 py-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            Static Constraint Analysis
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <p className="text-xs capitalize text-slate-500">{status}</p>
            {trafficLabel && (
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${trafficSourceBadgeClass(
                  trafficSource ?? corridor?.traffic_source
                )}`}
              >
                {trafficLabel}
              </span>
            )}
          </div>
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

      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm text-red-600">{error}</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Retry
            </button>
          )}
        </div>
      ) : !corridor ? (
        <EmptyBlock />
      ) : (
        <div
          className={`flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 ${
            wideGrid ? "lg:grid lg:grid-cols-2 lg:gap-4" : ""
          }`}
        >
          <div className="shrink-0 space-y-4">
            <ElevationProfileChart
              corridor={corridor}
              tall={tall}
              trapLengthM={trapLengthM}
            />
            <SlopeChart
              corridor={corridor}
              slopeUnit={slopeUnit}
              onSlopeUnitChange={onSlopeUnitChange}
              tall={tall}
            />
            {envelopeMask && onEnvelopeMaskChange && (
              <EnvelopeMaskToggles
                mask={envelopeMask}
                onChange={onEnvelopeMaskChange}
              />
            )}
            <SpeedLimitChart
              corridor={corridor}
              tall={tall}
              onInspectS={openInspect}
              highlightS={microOpen ? inspectS : null}
              syncEnabled={syncEnabled}
              onCursorS={onCursorS}
              onBrushRangeS={onBrushRangeS}
              envelopeMask={envelopeMask}
              speedFactor={speedFactor}
              maxSpeedKmh={maxSpeedKmh}
            />
          </div>
          <div className="flex min-h-0 flex-col gap-3">
            {scenarioExtras}
            <WarningsPanel warnings={displayWarnings} />
            {onCorridorChange && (
              <TrafficLightsEditor
                corridor={corridor}
                selectedIndex={selectedFeu}
                onSelect={setSelectedFeu}
                onChangeFeux={patchFeux}
                onChangeCorridor={onCorridorChange}
                onInspect={openInspect}
              />
            )}
            <DetectedEventsList events={corridor.events} />

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
              contextLabel="From speed chart / lights list"
            />

            {!microOpen && (
              <button
                type="button"
                onClick={() =>
                  openInspect(
                    corridor.S_feux[0] ??
                      (corridor.S[corridor.S.length - 1] ?? 0) / 2
                  )
                }
                className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-700 hover:bg-white"
              >
                Open microscopic check window
              </button>
            )}

            <div className="shrink-0 border-t border-slate-200 pt-3">
              <button
                type="button"
                onClick={onGenerateSimulation}
                className="flex w-full min-h-[44px] items-center justify-center gap-2 rounded-md border border-brand bg-white px-3 py-2.5 text-sm font-semibold text-brand transition hover:bg-brand/5 active:scale-[0.98]"
              >
                Simulation SUMO
              </button>
              <p className="mt-1.5 text-center text-[10px] text-slate-400">
                Ou « Générer le cycle » à gauche (IDM). Feux édités pris en
                compte.
              </p>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
