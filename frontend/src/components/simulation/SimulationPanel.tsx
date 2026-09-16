"use client";

import type { SimEngine } from "@/lib/types";
import LayoutToggle, {
  analysisShellClass,
  type ViewLayout,
} from "@/components/LayoutToggle";
import type { LivePoint } from "./LiveCharts";
import LiveCharts from "./LiveCharts";
import DensityGauge from "./DensityGauge";
import SimProgress from "./SimProgress";
import type { SimSocketStatus } from "./useSimulationSocket";

export type SimulationPanelProps = {
  engine: SimEngine | null;
  starting: boolean;
  stopping: boolean;
  error: string | null;
  wsStatus: SimSocketStatus;
  wsMessage: string | null;
  series: LivePoint[];
  density: number;
  t: number;
  s: number;
  totalS: number;
  onStop: () => void;
  onBackToCorridor: () => void;
  analysisExpanded?: boolean;
  viewLayout?: ViewLayout;
  onToggleLayout?: () => void;
  onViewLayoutChange?: (layout: ViewLayout) => void;
};

export default function SimulationPanel({
  engine,
  starting,
  stopping,
  error,
  wsStatus,
  wsMessage,
  series,
  density,
  t,
  s,
  totalS,
  onStop,
  onBackToCorridor,
  analysisExpanded = false,
  viewLayout: viewLayoutProp,
  onToggleLayout,
  onViewLayoutChange,
}: SimulationPanelProps) {
  const viewLayout: ViewLayout =
    viewLayoutProp ?? (analysisExpanded ? "analysis" : "split");
  const tall = viewLayout === "analysis";
  const engineLabel = (engine ?? "SUMO").toUpperCase();
  const showLive = !error && !starting && series.length > 0;
  const reconnecting =
    wsStatus === "reconnecting" ||
    (wsStatus === "closed" && !!wsMessage?.includes("reconnect"));

  return (
    <aside className={analysisShellClass(viewLayout)}>
      <div className="flex items-start justify-between gap-2 border-b border-slate-200 px-4 py-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            Microscopic Simulation Running ({engineLabel})
          </h2>
          <p className="mt-1 text-xs capitalize text-slate-500">
            {starting
              ? "starting…"
              : error
                ? "error"
                : reconnecting
                  ? "reconnecting…"
                  : wsStatus === "open"
                    ? "live"
                    : wsStatus}
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

      {starting ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          <p className="text-sm text-slate-500">Starting simulation…</p>
          <p className="text-xs text-slate-400">
            POST /api/simulate/start → WebSocket stream
          </p>
        </div>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm text-red-600">{error}</p>
          <button
            type="button"
            onClick={onBackToCorridor}
            className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Back to cycle
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {(wsMessage || reconnecting) && (
            <div
              role="status"
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
            >
              {wsMessage || "Reconnecting to simulation stream…"}
            </div>
          )}

          <div
            className={
              tall
                ? "grid grid-cols-1 gap-4 sm:grid-cols-2"
                : "space-y-4"
            }
          >
            <SimProgress t={t} s={s} totalS={totalS} />
            <DensityGauge density={density} />
          </div>

          {showLive ? (
            <LiveCharts series={series} tall={tall} />
          ) : (
            <div className="flex flex-1 items-center justify-center py-8 text-center text-xs text-slate-400">
              Waiting for frames…
            </div>
          )}

          <div className="mt-auto shrink-0 border-t border-slate-200 pt-3">
            <button
              type="button"
              onClick={onStop}
              disabled={stopping}
              className="flex w-full min-h-[44px] items-center justify-center gap-2 rounded-md bg-brand px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-dark active:scale-[0.98] disabled:opacity-50"
            >
              {stopping && (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              )}
              {stopping ? "Stopping…" : "Stop & consolidate"}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
