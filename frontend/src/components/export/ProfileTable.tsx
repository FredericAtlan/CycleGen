"use client";

import type { ConsolidatedProfile } from "@/lib/types";
import {
  formatSlope,
  slopeUnitLabel,
  type SlopeUnit,
} from "@/lib/units";

type ProfileTableProps = {
  profile: ConsolidatedProfile;
  maxRows?: number;
  slopeUnit?: SlopeUnit;
};

export default function ProfileTable({
  profile,
  maxRows = 20,
  slopeUnit = "percent",
}: ProfileTableProps) {
  const n = Math.min(
    maxRows,
    profile.time.length,
    profile.velocity.length,
    profile.slope.length,
    profile.position.length,
    profile.acceleration.length
  );

  const rows = Array.from({ length: n }, (_, i) => ({
    t: profile.time[i],
    v: profile.velocity[i],
    slope: profile.slope[i],
    s: profile.position[i],
    a: profile.acceleration[i],
  }));

  const slopeHeader = `Slope (${slopeUnitLabel(slopeUnit)})`;

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-md border border-slate-200">
      <table className="w-full border-collapse text-left text-[11px]">
        <thead className="sticky top-0 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-2 py-1.5 font-semibold">Time</th>
            <th className="px-2 py-1.5 font-semibold">Velocity</th>
            <th className="px-2 py-1.5 font-semibold">{slopeHeader}</th>
            <th className="px-2 py-1.5 font-semibold">Position</th>
            <th className="px-2 py-1.5 font-semibold">Accel</th>
          </tr>
        </thead>
        <tbody className="tabular-nums text-slate-700">
          {rows.map((r, i) => (
            <tr
              key={`row-${i}`}
              className={i % 2 === 0 ? "bg-white" : "bg-slate-50/80"}
            >
              <td className="px-2 py-1">{r.t.toFixed(1)} s</td>
              <td className="px-2 py-1">{(r.v * 3.6).toFixed(1)} km/h</td>
              <td className="px-2 py-1">{formatSlope(r.slope, slopeUnit)}</td>
              <td className="px-2 py-1">{r.s.toFixed(0)} m</td>
              <td className="px-2 py-1">{r.a.toFixed(2)} m/s²</td>
            </tr>
          ))}
        </tbody>
      </table>
      {profile.time.length > maxRows && (
        <p className="border-t border-slate-200 px-2 py-1.5 text-[10px] text-slate-400">
          Showing first {maxRows} of {profile.time.length} samples
        </p>
      )}
    </div>
  );
}
