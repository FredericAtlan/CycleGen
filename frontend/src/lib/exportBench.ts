/**
 * Bench / OEM interchange exports (Route Studio–adjacent).
 *
 * - PUMA Rg/v demand tracks (CSV) — Dynamic SSQ / Driver’s Aid import
 * - CarMaker speed profile (TXT) — Maneuver / IPGDriver
 * - OpenDRIVE (.xodr) — minimal road with elevation for Scenario Editor
 *
 * Native PUMA .ssq / CarMaker .rd5 are proprietary; these are documented
 * engineering handoffs labs map into their tools.
 */

import { downloadBlob } from "@/lib/api";
import type { ConsolidatedProfile, SpatialCorridor } from "@/lib/types";
import { slopeFromRad } from "@/lib/units";

export type BenchExportInput = {
  profile: ConsolidatedProfile;
  corridor?: SpatialCorridor | null;
  /** Optional study slug for filenames. */
  name?: string | null;
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function stamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(
    d.getHours()
  )}${pad2(d.getMinutes())}`;
}

function slug(raw: string | null | undefined, max = 40): string {
  const cleaned = (raw ?? "")
    .trim()
    .replace(/[^\w\-àâäéèêëïîôùûüç.+]+/gi, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, max);
  return cleaned || "cycle";
}

function fmt(n: number, digits: number): string {
  if (!Number.isFinite(n)) return "0";
  const f = n.toFixed(digits);
  // Trim trailing zeros but keep at least one decimal for dyno parsers.
  return f.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ".0");
}

function sampleCount(profile: ConsolidatedProfile): number {
  return Math.min(
    profile.time.length,
    profile.velocity.length,
    profile.position?.length ?? profile.time.length,
    profile.slope?.length ?? profile.time.length
  );
}

/** Grade % from stored slope radians (API native). */
export function gradePctFromRad(alphaRad: number): number {
  return slopeFromRad(alphaRad, "percent");
}

/**
 * PUMA Rg/v demand CSV — Time[s], Velocity[km/h], Gradient[%], Distance[m].
 * Import into Dynamic SSQ / Driver’s Aid (Rg/v control mode).
 */
export function buildPumaRgvCsv(profile: ConsolidatedProfile): string {
  const n = sampleCount(profile);
  if (n < 2) throw new Error("Profil trop court pour export PUMA Rg/v");
  const lines = ["Time[s],Velocity[km/h],Gradient[%],Distance[m]"];
  for (let i = 0; i < n; i++) {
    const t = profile.time[i] ?? 0;
    const vKmh = (profile.velocity[i] ?? 0) * 3.6;
    const grade = gradePctFromRad(profile.slope?.[i] ?? 0);
    const dist = profile.position?.[i] ?? 0;
    lines.push(
      `${fmt(t, 3)},${fmt(vKmh, 3)},${fmt(grade, 3)},${fmt(dist, 3)}`
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * CarMaker / IPGDriver speed profile — tab-separated Time + Velocity.
 */
export function buildCarMakerSpeedProfile(profile: ConsolidatedProfile): string {
  const n = Math.min(profile.time.length, profile.velocity.length);
  if (n < 2) throw new Error("Profil trop court pour export CarMaker");
  const lines = ["Time[s]\tVelocity[km/h]"];
  for (let i = 0; i < n; i++) {
    const t = profile.time[i] ?? 0;
    const vKmh = (profile.velocity[i] ?? 0) * 3.6;
    lines.push(`${fmt(t, 3)}\t${fmt(vKmh, 3)}`);
  }
  return lines.join("\n") + "\n";
}

/** Nearest elevation on corridor for curvilinear s (m). */
function elevAtS(corridor: SpatialCorridor | null | undefined, s: number): number | null {
  const elev = corridor?.elevations_m;
  const S = corridor?.S;
  if (!elev?.length || !S?.length) return null;
  const n = Math.min(elev.length, S.length);
  if (n === 0) return null;
  if (s <= S[0]) return elev[0];
  if (s >= S[n - 1]) return elev[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (S[mid] <= s) lo = mid;
    else hi = mid;
  }
  const s0 = S[lo];
  const s1 = S[hi];
  const z0 = elev[lo];
  const z1 = elev[hi];
  if (s1 <= s0) return z0;
  const u = (s - s0) / (s1 - s0);
  return z0 + (z1 - z0) * u;
}

/**
 * Build altitude series for each profile sample (m).
 * Prefer corridor elevations; else integrate slope from 0.
 */
export function buildAltitudeSeries(
  profile: ConsolidatedProfile,
  corridor?: SpatialCorridor | null
): number[] {
  const n = sampleCount(profile);
  const out = new Array<number>(n);
  let haveCorridor = false;
  for (let i = 0; i < n; i++) {
    const z = elevAtS(corridor, profile.position?.[i] ?? 0);
    if (z != null && Number.isFinite(z)) {
      out[i] = z;
      haveCorridor = true;
    } else {
      out[i] = NaN;
    }
  }
  if (haveCorridor) {
    let last = out.find((z) => Number.isFinite(z)) ?? 0;
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(out[i])) last = out[i];
      else out[i] = last;
    }
    return out;
  }
  // Integrate grade from origin altitude 0.
  out[0] = 0;
  for (let i = 1; i < n; i++) {
    const ds = (profile.position?.[i] ?? 0) - (profile.position?.[i - 1] ?? 0);
    const alpha = profile.slope?.[i - 1] ?? 0;
    out[i] = out[i - 1] + Math.tan(alpha) * Math.max(0, ds);
  }
  return out;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Minimal OpenDRIVE 1.4 road: straight planView + elevationProfile + one lane.
 * Import via CarMaker Scenario Editor (not proprietary .rd5).
 */
export function buildOpenDriveXodr(input: BenchExportInput): string {
  const { profile, corridor = null, name } = input;
  const n = sampleCount(profile);
  if (n < 2) throw new Error("Profil trop court pour OpenDRIVE");

  const length = Math.max(1, profile.position?.[n - 1] ?? 0);
  const alt = buildAltitudeSeries(profile, corridor);

  // Decimate elevation samples (~ every 10 m or keep ≤ 500 points).
  const stepM = Math.max(5, length / 400);
  const elevRows: { s: number; a: number; b: number }[] = [];
  let nextS = 0;
  for (let i = 0; i < n; i++) {
    const s = profile.position?.[i] ?? 0;
    if (i > 0 && i < n - 1 && s < nextS) continue;
    const alpha = profile.slope?.[i] ?? 0;
    elevRows.push({ s, a: alt[i], b: Math.tan(alpha) });
    nextS = s + stepM;
  }
  // Ensure last sample.
  const sLast = profile.position?.[n - 1] ?? length;
  const last = elevRows[elevRows.length - 1];
  if (!last || Math.abs(last.s - sLast) > 0.05) {
    elevRows.push({
      s: sLast,
      a: alt[n - 1],
      b: Math.tan(profile.slope?.[n - 1] ?? 0),
    });
  }

  const roadName = escapeXml(slug(name ?? "CycleGen", 48));
  const elevXml = elevRows
    .map(
      (e) =>
        `      <elevation s="${fmt(e.s, 3)}" a="${fmt(e.a, 3)}" b="${fmt(e.b, 6)}" c="0" d="0"/>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenDRIVE>
  <header revMajor="1" revMinor="4" name="${roadName}" version="1.0" date="${new Date().toISOString()}" north="0" south="0" east="${fmt(length, 3)}" west="0"/>
  <road name="${roadName}" length="${fmt(length, 3)}" id="1" junction="-1">
    <planView>
      <geometry s="0" x="0" y="0" hdg="0" length="${fmt(length, 3)}">
        <line/>
      </geometry>
    </planView>
    <elevationProfile>
${elevXml}
    </elevationProfile>
    <lanes>
      <laneSection s="0">
        <center>
          <lane id="0" type="none" level="true"/>
        </center>
        <right>
          <lane id="-1" type="driving" level="true">
            <width sOffset="0" a="3.5" b="0" c="0" d="0"/>
          </lane>
        </right>
      </laneSection>
    </lanes>
  </road>
</OpenDRIVE>
`;
}

export function downloadPumaRgv(input: BenchExportInput): void {
  const csv = buildPumaRgvCsv(input.profile);
  const base = slug(input.name);
  downloadBlob(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
    `cyclegen_${base}_puma_rgv_${stamp()}.csv`
  );
}

export function downloadCarMakerSpeed(input: BenchExportInput): void {
  const txt = buildCarMakerSpeedProfile(input.profile);
  const base = slug(input.name);
  downloadBlob(
    new Blob([txt], { type: "text/plain;charset=utf-8" }),
    `cyclegen_${base}_carmaker_speed_${stamp()}.txt`
  );
}

export function downloadOpenDrive(input: BenchExportInput): void {
  const xml = buildOpenDriveXodr(input);
  const base = slug(input.name);
  downloadBlob(
    new Blob([xml], { type: "application/xml;charset=utf-8" }),
    `cyclegen_${base}_road_${stamp()}.xodr`
  );
}
