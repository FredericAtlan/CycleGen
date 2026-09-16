"use client";

/**
 * @deprecated Unused by CycleGenShell — ResultsAnalysisPanel is the step-4 surface.
 */

import type { ReactNode } from "react";
import StaticConstraintPanel from "@/components/corridor/StaticConstraintPanel";
import SimulationPanel from "@/components/simulation/SimulationPanel";
import type { LivePoint } from "@/components/simulation/LiveCharts";
import type { SimSocketStatus } from "@/components/simulation/useSimulationSocket";
import FinalProfilesPanel from "@/components/export/FinalProfilesPanel";
import type {
  ConsolidatedProfile,
  CycleGenWarning,
  SimEngine,
  SpatialCorridor,
  Stage,
} from "@/lib/types";
import type { SlopeUnit } from "@/lib/units";
import type { EnvelopeMask } from "@/lib/corridorEdit";
import type { ViewLayout } from "@/components/LayoutToggle";

export type RightPanelProps = {
  stage: Stage;
  corridor: SpatialCorridor | null;
  loading: boolean;
  error: string | null;
  onGenerateSimulation: () => void;
  onRetry?: () => void;
  slopeUnit?: SlopeUnit;
  onSlopeUnitChange?: (unit: SlopeUnit) => void;
  viewLayout?: ViewLayout;
  onViewLayoutChange?: (layout: ViewLayout) => void;
  /** @deprecated use viewLayout */
  analysisExpanded?: boolean;
  onToggleLayout?: () => void;
  onCorridorChange?: (corridor: SpatialCorridor) => void;
  trafficSource?: string | null;
  warnings?: CycleGenWarning[];
  simEngine: SimEngine | null;
  simStarting: boolean;
  simStopping: boolean;
  simError: string | null;
  wsStatus: SimSocketStatus;
  wsMessage: string | null;
  series: LivePoint[];
  density: number;
  simT: number;
  simS: number;
  totalS: number;
  onStopSimulation: () => void;
  onBackToCorridor: () => void;
  profile: ConsolidatedProfile | null;
  syncEnabled?: boolean;
  onCursorS?: (s_m: number | null) => void;
  onBrushRangeS?: (range: { s0: number; s1: number } | null) => void;
  scenarioExtras?: ReactNode;
  envelopeMask?: EnvelopeMask;
  onEnvelopeMaskChange?: (mask: EnvelopeMask) => void;
  speedFactor?: number;
  maxSpeedKmh?: number | null;
  referenceCycle?: {
    name: string;
    time: number[];
    velocity: number[];
  } | null;
  onClearReference?: () => void;
  /** Lateral comfort accel a_y (m/s²) for export / a_lat. */
  aY?: number;
};

export default function RightPanel({
  stage,
  corridor,
  loading,
  error,
  onGenerateSimulation,
  onRetry,
  slopeUnit = "percent",
  onSlopeUnitChange,
  viewLayout = "split",
  onViewLayoutChange,
  analysisExpanded,
  onToggleLayout,
  onCorridorChange,
  trafficSource = null,
  warnings = [],
  simEngine,
  simStarting,
  simStopping,
  simError,
  wsStatus,
  wsMessage,
  series,
  density,
  simT,
  simS,
  totalS,
  onStopSimulation,
  onBackToCorridor,
  profile,
  syncEnabled = false,
  onCursorS,
  onBrushRangeS,
  scenarioExtras = null,
  envelopeMask,
  onEnvelopeMaskChange,
  speedFactor,
  maxSpeedKmh = null,
  referenceCycle = null,
  onClearReference,
  aY,
}: RightPanelProps) {
  const layout: ViewLayout =
    viewLayout ?? (analysisExpanded ? "analysis" : "split");

  const mergedWarnings =
    warnings.length > 0
      ? warnings
      : corridor?.warnings ?? profile?.warnings ?? [];

  if (stage === "simulating") {
    return (
      <SimulationPanel
        engine={simEngine}
        starting={simStarting}
        stopping={simStopping}
        error={simError}
        wsStatus={wsStatus}
        wsMessage={wsMessage}
        series={series}
        density={density}
        t={simT}
        s={simS}
        totalS={totalS}
        onStop={onStopSimulation}
        onBackToCorridor={onBackToCorridor}
        viewLayout={layout}
        onViewLayoutChange={onViewLayoutChange}
        onToggleLayout={onToggleLayout}
      />
    );
  }

  if (stage === "completed" && profile) {
    return (
      <FinalProfilesPanel
        profile={profile}
        slopeUnit={slopeUnit}
        onSlopeUnitChange={onSlopeUnitChange}
        viewLayout={layout}
        onViewLayoutChange={onViewLayoutChange}
        onToggleLayout={onToggleLayout}
        corridor={corridor}
        onCorridorChange={onCorridorChange}
        syncEnabled={syncEnabled}
        onCursorS={onCursorS}
        onBrushRangeS={onBrushRangeS}
        warnings={
          profile.warnings?.length ? profile.warnings : mergedWarnings
        }
        trafficSource={profile.traffic_source ?? trafficSource}
        scenarioExtras={scenarioExtras}
        aY={aY}
        referenceCycle={referenceCycle}
        onClearReference={onClearReference}
      />
    );
  }

  return (
    <StaticConstraintPanel
      corridor={corridor}
      loading={loading}
      error={error}
      onGenerateSimulation={onGenerateSimulation}
      onRetry={onRetry}
      slopeUnit={slopeUnit}
      onSlopeUnitChange={onSlopeUnitChange}
      viewLayout={layout}
      onViewLayoutChange={onViewLayoutChange}
      onToggleLayout={onToggleLayout}
      onCorridorChange={onCorridorChange}
      syncEnabled={syncEnabled}
      onCursorS={onCursorS}
      onBrushRangeS={onBrushRangeS}
      warnings={mergedWarnings}
      trafficSource={trafficSource}
      scenarioExtras={scenarioExtras}
      envelopeMask={envelopeMask}
      onEnvelopeMaskChange={onEnvelopeMaskChange}
      speedFactor={speedFactor}
      maxSpeedKmh={maxSpeedKmh}
    />
  );
}
