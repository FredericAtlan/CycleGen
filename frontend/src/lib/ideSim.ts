/**
 * P3 IDE runners — cheap Update dynamics vs expensive Rebuild corridor.
 * Pure orchestration over api.ts; no scientific math in React.
 */

import { buildCorridor, startSimulation, stopSimulation } from "@/lib/api";
import { completePhysics } from "@/lib/driverPresets";
import { getDriver } from "@/lib/driverLibrary";
import {
  getRoadLawAsync,
  getRoadLawSync,
  roadLawToLegalFilter,
} from "@/lib/roadLawLibrary";
import type { DriverProfile } from "@/lib/types";
import {
  emptyResults,
  sampleProfile,
  useWorkspaceStore,
} from "@/lib/workspaceStore";

function physicsToParams(driverId: string | null) {
  const cfg = useWorkspaceStore.getState().config;
  const d = driverId ? getDriver(driverId) : null;
  const p = completePhysics(cfg.driverPhysicsOverride ?? d?.physics ?? null);
  return {
    profile: (cfg.driverProfileOverride ??
      d?.baseProfile ??
      "Normal") as DriverProfile,
    params: {
      a_max: p.a_max,
      b_comf: p.b_comf,
      speed_factor: p.speed_factor,
      T: p.T,
      T_h: p.T_h,
      s0: p.s0,
      jerk_max: p.jerk_max,
      jerk_brake_max: p.jerk_brake_max,
      pedal_tau_s: p.pedal_tau_s ?? 0,
      vdes_tau_s: p.vdes_tau_s ?? 0,
      descent_hold_gain: p.descent_hold_gain ?? 0,
    },
  };
}

/**
 * Cheap path: re-sim IDM on existing corridor (debounce caller-side 50–100 ms).
 */
export async function runUpdateDynamics(options?: {
  /** Chained after rebuild — allowed while busyExpensive is still held. */
  duringRebuildChain?: boolean;
}): Promise<boolean> {
  const store = useWorkspaceStore.getState();
  const corridor = store.geometry.corridor;
  if (!corridor || !corridor.S || corridor.S.length < 2) {
    store.pushConsole("update dynamics · aborted — no corridor (Rebuild or Créer GPS)");
    return false;
  }
  if (store.busyExpensive && !options?.duringRebuildChain) {
    store.pushConsole("update dynamics · skipped — rebuild in progress");
    return false;
  }

  const gen = store.bumpDynamicsGen();
  store.setBusyCheap(true);
  store.pushConsole("update dynamics · start (IDM)");

  try {
    const { profile, params } = physicsToParams(store.config.driverId);
    const start = await startSimulation(corridor, {
      driverProfile: profile,
      engine: "idm",
      maxSpeedKmh: store.config.maxSpeedKmh,
      enableMarkov: false,
      driverParams: params,
    });

    if (start.status === "failed") {
      store.pushConsole("update dynamics · failed (solver)");
      store.setResults(emptyResults());
      try {
        await stopSimulation(start.simulation_id, start.ws_token);
      } catch {
        /* cleanup */
      }
      return false;
    }

    if (useWorkspaceStore.getState().dynamicsGen !== gen) {
      store.pushConsole("update dynamics · superseded");
      try {
        await stopSimulation(start.simulation_id, start.ws_token);
      } catch {
        /* orphan cleanup best-effort */
      }
      return false;
    }

    let consolidated = null as Awaited<ReturnType<typeof stopSimulation>> | null;
    if (start.status === "completed" || start.engine === "idm") {
      consolidated = await stopSimulation(start.simulation_id, start.ws_token);
    } else {
      // SUMO path — still try stop for profile; IDE prefers IDM for cheap.
      consolidated = await stopSimulation(start.simulation_id, start.ws_token);
    }

    if (useWorkspaceStore.getState().dynamicsGen !== gen) return false;

    const prof = consolidated.profile;
    if (!prof || !prof.time?.length || prof.time.length < 2) {
      store.pushConsole("update dynamics · empty profile");
      store.setResults(emptyResults());
      return false;
    }

    const sampled = sampleProfile(prof);
    store.setResults({
      simulationId: start.simulation_id,
      ...sampled,
      profile: prof,
      source: "sim",
    });
    store.pushConsole(
      `update dynamics · ok · T=${(prof.total_duration_s / 60).toFixed(1)} min · v̄=${prof.average_speed_kmh.toFixed(1)} km/h`
    );
    return true;
  } catch (e) {
    store.pushConsole(
      `update dynamics · ERROR ${e instanceof Error ? e.message : String(e)}`
    );
    return false;
  } finally {
    if (useWorkspaceStore.getState().dynamicsGen === gen) {
      store.setBusyCheap(false);
    }
  }
}

/**
 * Expensive path: rebuild corridor from route + road law (explicit only).
 */
export async function runRebuildCorridor(): Promise<boolean> {
  const store = useWorkspaceStore.getState();
  const route = store.geometry.route;
  if (!route) {
    store.pushConsole(
      "rebuild corridor · aborted — no route (open a saved trip or Créer GPS)"
    );
    return false;
  }
  if (store.busyCheap || store.busyExpensive) {
    store.pushConsole("rebuild corridor · skipped — update or rebuild in progress");
    return false;
  }

  store.setBusyExpensive(true);
  store.pushConsole("rebuild corridor · start");

  let rebuildOk = false;
  try {
    let law = store.config.roadLawId
      ? await getRoadLawAsync(store.config.roadLawId)
      : null;
    if (!law && store.config.roadLawId) {
      law = getRoadLawSync(store.config.roadLawId);
    }
    const legal = law ? roadLawToLegalFilter(law) : undefined;

    const res = await buildCorridor(route, {
      aY: store.config.aY,
      legalSmoothMode: legal?.mode,
      legalSmoothWindowM: legal?.windowM,
      legalMinRunM: legal?.minRunM,
      globalMaxSpeedKmh: law?.vMaxCapKmh ?? store.config.maxSpeedKmh ?? undefined,
    });

    const corr = res.corridor;
    const geomNow = useWorkspaceStore.getState().geometry;
    store.setGeometry({
      corridor: corr,
      corridorId: res.corridor_id ?? null,
      distance_m: corr.S?.length
        ? corr.S[corr.S.length - 1] - corr.S[0]
        : null,
      nPoints: corr.S?.length ?? null,
      route: geomNow.route,
      label: geomNow.label,
    });
    store.pushConsole(
      `rebuild corridor · ok · id=${res.corridor_id ?? "—"} · n=${corr.S?.length ?? 0}` +
        (law ? ` · law=${law.name}` : "")
    );

    rebuildOk = true;
    return true;
  } catch (e) {
    store.pushConsole(
      `rebuild corridor · ERROR ${e instanceof Error ? e.message : String(e)}`
    );
    return false;
  } finally {
    try {
      // Hold busyExpensive until chained cheap update finishes (no Rebuild vs Update race).
      if (rebuildOk || _pendingCheapUpdate) {
        do {
          _pendingCheapUpdate = false;
          await runUpdateDynamics({ duringRebuildChain: true });
        } while (_pendingCheapUpdate);
      }
    } finally {
      store.setBusyExpensive(false);
    }
  }
}

/** Debounced cheap updater (75 ms). */
let _cheapTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingCheapUpdate = false;

export function scheduleUpdateDynamics(delayMs = 75): void {
  if (useWorkspaceStore.getState().busyExpensive) {
    _pendingCheapUpdate = true;
    return;
  }
  if (_cheapTimer) clearTimeout(_cheapTimer);
  _cheapTimer = setTimeout(() => {
    _cheapTimer = null;
    if (useWorkspaceStore.getState().busyExpensive) {
      _pendingCheapUpdate = true;
      return;
    }
    void runUpdateDynamics();
  }, delayMs);
}
