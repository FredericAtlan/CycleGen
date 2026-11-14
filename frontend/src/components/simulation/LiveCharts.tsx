"use client";

import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import {
  TIME_X_AXIS_PROPS,
  formatTimeLabel,
  resampleUniform,
} from "@/lib/chartTime";

export type LivePoint = {
  t: number;
  v: number;
  a: number;
  alpha?: number;
  /** Distance along route (m), when provided by the sim frame. */
  s?: number;
};

type LiveChartsProps = {
  series: LivePoint[];
  tall?: boolean;
};

const SYNC_ID = "cyclegen-live";

export default function LiveCharts({ series, tall = false }: LiveChartsProps) {
  const data = resampleUniform(
    series.map((p) => ({
      t: p.t,
      v_kmh: p.v * 3.6,
      a: p.a,
      alpha_pct:
        p.alpha != null && Number.isFinite(p.alpha)
          ? Math.tan(p.alpha) * 100
          : 0,
    })),
    "t",
    { maxPoints: 600, dtPrefer: 1 }
  );
  const chartH = tall ? "h-40" : "h-28";

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-baseline justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Velocity v(t)
          </h3>
          <span className="text-[10px] text-slate-400">km/h · sync</span>
        </div>
        <div className={`w-full ${chartH}`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              syncId={SYNC_ID}
              margin={{ top: 4, right: 8, left: -8, bottom: 0 }}
            >
              <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
              <XAxis
                dataKey="t"
                {...TIME_X_AXIS_PROPS}
                tick={{ fontSize: 10, fill: "#64748b" }}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "#64748b" }}
                width={36}
                domain={[0, "auto"]}
              />
              <Tooltip
                contentStyle={{
                  fontSize: 11,
                  borderRadius: 6,
                  border: "1px solid #e2e8f0",
                }}
                formatter={(value) => [
                  typeof value === "number" ? `${value.toFixed(1)} km/h` : "",
                  "v",
                ]}
                labelFormatter={(label) => formatTimeLabel(Number(label))}
              />
              <Line
                type="monotone"
                dataKey="v_kmh"
                stroke="#2563eb"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-baseline justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Acceleration a(t)
          </h3>
          <span className="text-[10px] text-slate-400">m/s² · sync</span>
        </div>
        <div className={`w-full ${chartH}`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              syncId={SYNC_ID}
              margin={{ top: 4, right: 8, left: -8, bottom: 0 }}
            >
              <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
              <XAxis
                dataKey="t"
                {...TIME_X_AXIS_PROPS}
                tick={{ fontSize: 10, fill: "#64748b" }}
              />
              <YAxis tick={{ fontSize: 10, fill: "#64748b" }} width={36} />
              <Tooltip
                contentStyle={{
                  fontSize: 11,
                  borderRadius: 6,
                  border: "1px solid #e2e8f0",
                }}
                formatter={(value) => [
                  typeof value === "number" ? `${value.toFixed(2)} m/s²` : "",
                  "a",
                ]}
                labelFormatter={(label) => formatTimeLabel(Number(label))}
              />
              <Line
                type="monotone"
                dataKey="a"
                stroke="#f59e0b"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-baseline justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Slope α(t)
          </h3>
          <span className="text-[10px] text-slate-400">% · sync</span>
        </div>
        <div className={`w-full ${chartH}`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              syncId={SYNC_ID}
              margin={{ top: 4, right: 8, left: -8, bottom: 0 }}
            >
              <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
              <XAxis
                dataKey="t"
                {...TIME_X_AXIS_PROPS}
                tick={{ fontSize: 10, fill: "#64748b" }}
              />
              <YAxis tick={{ fontSize: 10, fill: "#64748b" }} width={36} />
              <Tooltip
                contentStyle={{
                  fontSize: 11,
                  borderRadius: 6,
                  border: "1px solid #e2e8f0",
                }}
                formatter={(value) => [
                  typeof value === "number" ? `${value.toFixed(1)} %` : "",
                  "α",
                ]}
                labelFormatter={(label) => formatTimeLabel(Number(label))}
              />
              <Line
                type="monotone"
                dataKey="alpha_pct"
                stroke="#0d9488"
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
