/**
 * Workspace IDE ledger (Zustand) — 3 strates + UI selection/playhead.
 * P3: live corridor/route in geometry; cheap/expensive busy flags.
 * CycleGenShell remains on /?mode=create (non-régression).
 */

import { create } from "zustand";
import type { DriverPhysics } from "@/lib/driverPresets";
import type {
  ConsolidatedProfile,
  DriverProfile,
  RouteAnalyzeResponse,
  SpatialCorridor,
} from "@/lib/types";

export type AssetKind =
  | "driver"
  | "vehicle"
  | "cycle"
  | "trip"
  | "roadLaw"
  | null;

export type WorkspaceSelection = {
  kind: AssetKind;
  id: string | null;
};

/** Strate 1 — configuration (IDs + lightweight params). */
export type ConfigStratum = {
  driverId: string | null;
  vehicleId: string | null;
  roadLawId: string | null;
  maxSpeedKmh: number | null;
  aY: number;
  /** Live IDM edits (incl. seeds) preferred over library getDriver(). */
  driverPhysicsOverride: DriverPhysics | null;
  driverProfileOverride: DriverProfile | null;
};

/** Strate 2 — géométrie déterministe (référence, pas de mutation in-place). */
export type GeometryStratum = {
  corridorId: string | null;
  distance_m: number | null;
  nPoints: number | null;
  /** Live corridor object — replace wholesale, never mutate. */
  corridor: SpatialCorridor | null;
  route: RouteAnalyzeResponse | null;
  label: string | null;
};

/** Strate 3 — résultats d’exécution (séries). */
export type ResultsStratum = {
  simulationId: string | null;
  v_kmh: number[] | null;
  t_s: number[] | null;
  s_m: number[] | null;
  profile: ConsolidatedProfile | null;
  source: "library" | "sim" | "session" | null;
};

type WorkspaceState = {
  config: ConfigStratum;
  geometry: GeometryStratum;
  results: ResultsStratum;
  selection: WorkspaceSelection;
  hoverIndex: number | null;
  playheadIndex: number | null;
  consoleLines: string[];
  busyCheap: boolean;
  busyExpensive: boolean;
  dynamicsGen: number;

  selectAsset: (kind: AssetKind, id: string | null) => void;
  setConfig: (patch: Partial<ConfigStratum>) => void;
  setGeometry: (next: GeometryStratum | Partial<GeometryStratum>) => void;
  setResults: (next: ResultsStratum) => void;
  setHoverIndex: (i: number | null) => void;
  setPlayheadIndex: (i: number | null) => void;
  pushConsole: (line: string) => void;
  clearConsole: () => void;
  setBusyCheap: (v: boolean) => void;
  setBusyExpensive: (v: boolean) => void;
  bumpDynamicsGen: () => number;
};

export const emptyGeometry = (): GeometryStratum => ({
  corridorId: null,
  distance_m: null,
  nPoints: null,
  corridor: null,
  route: null,
  label: null,
});

export const emptyResults = (): ResultsStratum => ({
  simulationId: null,
  v_kmh: null,
  t_s: null,
  s_m: null,
  profile: null,
  source: null,
});

/** Downsample profile → canvas series. */
export function sampleProfile(
  profile: ConsolidatedProfile,
  maxPts = 400
): Pick<ResultsStratum, "v_kmh" | "t_s" | "s_m"> {
  const n = profile.velocity?.length ?? 0;
  if (n < 2) return { v_kmh: null, t_s: null, s_m: null };
  const step = Math.max(1, Math.floor(n / maxPts));
  const v_kmh: number[] = [];
  const t_s: number[] = [];
  const s_m: number[] = [];
  for (let i = 0; i < n; i += step) {
    v_kmh.push(profile.velocity[i] * 3.6);
    t_s.push(profile.time[i] ?? i);
    s_m.push(profile.position[i] ?? 0);
  }
  return { v_kmh, t_s, s_m };
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  config: {
    driverId: null,
    vehicleId: null,
    roadLawId: null,
    maxSpeedKmh: null,
    aY: 3.5,
    driverPhysicsOverride: null,
    driverProfileOverride: null,
  },
  geometry: emptyGeometry(),
  results: emptyResults(),
  selection: { kind: null, id: null },
  hoverIndex: null,
  playheadIndex: null,
  consoleLines: [
    "CycleGen IDE · P3 — Update dynamics (cheap) / Rebuild corridor (explicit).",
    "Shell Créer (/?mode=create) intact.",
  ],
  busyCheap: false,
  busyExpensive: false,
  dynamicsGen: 0,

  selectAsset: (kind, id) =>
    set((s) => {
      const selection = { kind, id };
      const config = { ...s.config };
      if (kind === "driver") config.driverId = id;
      if (kind === "vehicle") config.vehicleId = id;
      if (kind === "roadLaw") config.roadLawId = id;
      return { selection, config };
    }),

  setConfig: (patch) =>
    set((s) => {
      let changed = false;
      for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
        if (s.config[key] !== patch[key]) {
          changed = true;
          break;
        }
      }
      if (!changed) return s;
      return { config: { ...s.config, ...patch } };
    }),

  setGeometry: (next) =>
    set((s) => ({
      geometry: { ...s.geometry, ...next },
    })),

  setResults: (next) =>
    set((s) => {
      const n = next.v_kmh?.length ?? 0;
      const maxIdx = n > 0 ? n - 1 : null;
      let hoverIndex = s.hoverIndex;
      let playheadIndex = s.playheadIndex;
      if (maxIdx == null) {
        hoverIndex = null;
        playheadIndex = null;
      } else {
        if (hoverIndex != null && hoverIndex > maxIdx) hoverIndex = maxIdx;
        if (playheadIndex != null && playheadIndex > maxIdx) {
          playheadIndex = maxIdx;
        }
      }
      return { results: next, hoverIndex, playheadIndex };
    }),

  setHoverIndex: (i) => set({ hoverIndex: i }),

  setPlayheadIndex: (i) => set({ playheadIndex: i }),

  pushConsole: (line) =>
    set((s) => ({
      consoleLines: [
        ...s.consoleLines.slice(-199),
        `${new Date().toISOString().slice(11, 19)}  ${line}`,
      ],
    })),

  clearConsole: () => set({ consoleLines: [] }),

  setBusyCheap: (v) => set({ busyCheap: v }),

  setBusyExpensive: (v) => set({ busyExpensive: v }),

  bumpDynamicsGen: () => {
    const n = get().dynamicsGen + 1;
    set({ dynamicsGen: n });
    return n;
  },
}));
