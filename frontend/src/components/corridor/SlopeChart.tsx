"use client";

import { useCallback } from "react";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import type { SpatialCorridor } from "@/lib/types";
import {
  slopeFromRad,
  slopeExtremes,
  slopeUnitLabel,
  type SlopeUnit,
} from "@/lib/units";
import SlopeUnitToggle from "@/components/SlopeUnitToggle";

type SlopeChartProps = {
  corridor: SpatialCorridor;
  slopeUnit?: SlopeUnit;
  onSlopeUnitChange?: (unit: SlopeUnit) => void;
  tall?: boolean;
  /** Shared playhead / hover cursor along S (m). */
  highlightS?: number | null;
  onCursorS?: (s_m: number | null) => void;
  syncEnabled?: boolean;
};

function buildData(corridor: SpatialCorridor, unit: SlopeUnit) {
  const n = Math.min(corridor.S.length, corridor.alpha.length);
  const step = Math.max(1, Math.floor(n / 400));
  const rows: { s_km: number; slope: number }[] = [];
  for (let i = 0; i < n; i += step) {
    rows.push({
      s_km: corridor.S[i] / 1000,
      slope: slopeFromRad(corridor.alpha[i], unit),
    });
  }
  if (n > 0 && (n - 1) % step !== 0) {
    const i = n - 1;
    rows.push({
      s_km: corridor.S[i] / 1000,
      slope: slopeFromRad(corridor.alpha[i], unit),
    });
  }
  return rows;
}

export default function SlopeChart({
  corridor,
  slopeUnit = "percent",
  onSlopeUnitChange,
  tall = false,
  highlightS = null,
  onCursorS,
  syncEnabled = true,
}: SlopeChartProps) {
  const data = buildData(corridor, slopeUnit);
  const unitLabel = slopeUnitLabel(slopeUnit);
  const ext = slopeExtremes(corridor.alpha, slopeUnit);
  const digits = slopeUnit === "percent" ? 1 : slopeUnit === "deg" ? 2 : 4;

  const handleMouseMove = useCallback(
    (state: { activeLabel?: string | number }) => {
      if (!syncEnabled || !onCursorS) return;
      const s_km = Number(state?.activeLabel);
      if (!Number.isFinite(s_km)) return;
      onCursorS(s_km * 1000);
    },
    [syncEnabled, onCursorS]
  );

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Pente α(s)
          </h3>
          {ext && (
            <p className="text-[10px] tabular-nums text-slate-500">
              min{" "}
              <span className="font-bold text-slate-800">
                {ext.min.toFixed(digits)}
              </span>{" "}
              · max{" "}
              <span className="font-bold text-slate-800">
                {ext.max.toFixed(digits)}
              </span>{" "}
              {unitLabel}
            </p>
          )}
        </div>
        {onSlopeUnitChange ? (
          <SlopeUnitToggle value={slopeUnit} onChange={onSlopeUnitChange} />
        ) : (
          <span className="text-[10px] text-slate-400">{unitLabel}</span>
        )}
      </div>
      <div className={`w-full ${tall ? "h-52" : "h-36"}`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 4, right: 8, left: -12, bottom: 0 }}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => {
              if (syncEnabled) onCursorS?.(null);
            }}
          >
            <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
            <XAxis
              dataKey="s_km"
              tick={{ fontSize: 10, fill: "#64748b" }}
              tickFormatter={(v: number) => v.toFixed(1)}
              label={{
                value: "s (km)",
                position: "insideBottom",
                offset: -2,
                style: { fontSize: 10, fill: "#94a3b8" },
              }}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "#64748b" }}
              tickFormatter={(v: number) =>
                slopeUnit === "percent" ? v.toFixed(0) : v.toFixed(2)
              }
              width={40}
            />
            <Tooltip
              contentStyle={{
                fontSize: 11,
                borderRadius: 6,
                border: "1px solid #e2e8f0",
              }}
              formatter={(value) => [
                typeof value === "number"
                  ? `${value.toFixed(slopeUnit === "percent" ? 1 : 3)} ${unitLabel}`
                  : String(value ?? ""),
                "α",
              ]}
              labelFormatter={(label) => `s = ${Number(label).toFixed(2)} km`}
            />
            {highlightS != null && Number.isFinite(highlightS) && (
              <ReferenceLine
                x={highlightS / 1000}
                stroke="#0f172a"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            )}
            <Line
              type="monotone"
              dataKey="slope"
              stroke="#2563eb"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
