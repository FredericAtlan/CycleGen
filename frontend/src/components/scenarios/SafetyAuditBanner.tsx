"use client";

import type { ConsolidatedProfile } from "@/lib/types";

type SafetyAuditBannerProps = {
  profile: ConsolidatedProfile | null;
};

export default function SafetyAuditBanner({ profile }: SafetyAuditBannerProps) {
  if (!profile) return null;
  const has =
    profile.max_abs_accel != null ||
    profile.max_abs_accel_g != null ||
    profile.markov_gate_fraction != null ||
    profile.clip_hit_count != null;
  if (!has) return null;

  const g = profile.max_abs_accel_g;
  const hot = g != null && g > 0.85;

  return (
    <div
      className={`rounded-md border px-3 py-2 text-[11px] ${
        hot
          ? "border-amber-200 bg-amber-50 text-amber-900"
          : "border-slate-200 bg-slate-50 text-slate-700"
      }`}
    >
      <div className="mb-1 font-semibold uppercase tracking-wide text-slate-500">
        B · Audit sécurité
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
        {profile.max_abs_accel != null && (
          <span>
            max |a|{" "}
            <strong>{profile.max_abs_accel.toFixed(2)}</strong> m/s²
          </span>
        )}
        {g != null && (
          <span>
            |a|/g <strong>{g.toFixed(2)}</strong>
            {g > 1 ? " ⚠ >1g" : ""}
          </span>
        )}
        {profile.markov_gate_fraction != null && (
          <span>
            Markov gate{" "}
            <strong>
              {(profile.markov_gate_fraction * 100).toFixed(0)}%
            </strong>
          </span>
        )}
        {profile.clip_hit_count != null && (
          <span>
            clips <strong>{profile.clip_hit_count}</strong>
          </span>
        )}
      </div>
    </div>
  );
}
