/**
 * Hydrate IDE workspace from studioSession / saved trip / cycle library.
 */

import {
  findSeedMatching,
  getDriver,
  listDrivers,
} from "@/lib/driverLibrary";
import { completePhysics, physicsEqual } from "@/lib/driverPresets";
import type { SavedTripSnapshot } from "@/lib/tripStore";
import { listSavedCycles } from "@/lib/cycleLibrary";
import {
  isMeaningfulStudioSession,
  loadStudioSession,
} from "@/lib/studioSession";
import { getSavedTrip, listSavedTrips } from "@/lib/tripStore";
import type { ConsolidatedProfile } from "@/lib/types";
import {
  emptyGeometry,
  emptyResults,
  sampleProfile,
  useWorkspaceStore,
} from "@/lib/workspaceStore";

/** Best library driver id for a saved trip's Markov profile + IDM physics. */
function driverIdFromTripPhysics(
  driverProfile: SavedTripSnapshot["driverProfile"],
  physics: SavedTripSnapshot["physics"]
): string | null {
  const norm = completePhysics(physics);
  const exact =
    findSeedMatching(driverProfile, norm) ??
    listDrivers().find(
      (d) =>
        d.baseProfile === driverProfile && physicsEqual(d.physics, norm)
    );
  if (exact) return exact.id;
  const byProfile = listDrivers().find(
    (d) => d.seed && d.baseProfile === driverProfile
  );
  return byProfile?.id ?? null;
}

function profileFromCycle(id: string): ConsolidatedProfile | null {
  const c = listSavedCycles().find((x) => x.id === id);
  if (!c || !c.resultAvailable || c.velocity.length < 2) return null;
  return {
    time: c.time,
    velocity: c.velocity,
    position: c.position,
    acceleration: c.acceleration ?? c.velocity.map(() => 0),
    slope: c.slope ?? c.velocity.map(() => 0),
    total_duration_s: c.stats.duration_s,
    average_speed_kmh: c.stats.v_mean_kmh,
    status: "completed",
  };
}

/** Load active studio session into geometry/config/results if present. */
export function hydrateFromStudioSession(): boolean {
  const snap = loadStudioSession();
  if (!isMeaningfulStudioSession(snap) || !snap) return false;

  const store = useWorkspaceStore.getState();
  const corr = snap.corridor;
  store.setConfig({
    driverId: snap.driverId ?? store.config.driverId,
    vehicleId: snap.vehicleId ?? store.config.vehicleId,
    maxSpeedKmh: snap.maxSpeedKmh ?? null,
    aY: snap.aY ?? 3.5,
    driverPhysicsOverride: snap.physics
      ? completePhysics(snap.physics)
      : null,
    driverProfileOverride: snap.driverProfile ?? null,
  });

  if (corr && corr.S && corr.S.length > 1) {
    store.setGeometry({
      corridor: corr,
      route: snap.routeResult ?? null,
      corridorId: null,
      distance_m: corr.S[corr.S.length - 1] - corr.S[0],
      nPoints: corr.S.length,
      label:
        [snap.departureLabel, snap.destinationLabel]
          .filter(Boolean)
          .join(" → ") || "session",
    });
  } else if (snap.routeResult) {
    store.setGeometry({
      ...emptyGeometry(),
      route: snap.routeResult,
      label:
        [snap.departureLabel, snap.destinationLabel]
          .filter(Boolean)
          .join(" → ") || "session (route only)",
    });
  }

  if (snap.profile && snap.profile.time?.length > 1) {
    const sampled = sampleProfile(snap.profile);
    store.setResults({
      simulationId: null,
      ...sampled,
      profile: snap.profile,
      source: "session",
    });
  }

  if (snap.driverId) {
    store.selectAsset("driver", snap.driverId);
    const d = getDriver(snap.driverId);
    if (d?.a_y != null && snap.aY == null) {
      store.setConfig({ aY: d.a_y });
    }
  } else if (snap.vehicleId) {
    store.selectAsset("vehicle", snap.vehicleId);
  }

  store.pushConsole(
    `load · studio session · corridor=${corr?.S?.length ?? 0} pts · driver=${snap.driverId ?? "—"}`
  );
  return true;
}

/** Hydrate from a saved trip asset. */
export function hydrateFromTrip(tripId: string): boolean {
  const trip = getSavedTrip(tripId);
  if (!trip) {
    useWorkspaceStore.getState().pushConsole(`load trip · not found ${tripId}`);
    return false;
  }
  const store = useWorkspaceStore.getState();
  const corr = trip.corridor ?? null;
  const resolvedDriverId = driverIdFromTripPhysics(
    trip.driverProfile,
    trip.physics
  );
  store.setConfig({
    maxSpeedKmh: trip.maxSpeedKmh ?? store.config.maxSpeedKmh,
    aY: trip.aY ?? store.config.aY,
    driverId: resolvedDriverId ?? store.config.driverId,
  });
  if (resolvedDriverId) {
    store.selectAsset("driver", resolvedDriverId);
  }
  store.setGeometry({
    corridor: corr,
    route: trip.routeResult ?? null,
    corridorId: null,
    distance_m:
      corr?.S && corr.S.length > 1
        ? corr.S[corr.S.length - 1] - corr.S[0]
        : trip.distanceM ?? null,
    nPoints: corr?.S?.length ?? null,
    label: trip.name || `${trip.departureLabel} → ${trip.destinationLabel}`,
  });
  if (trip.profile && trip.profile.time?.length > 1) {
    const sampled = sampleProfile(trip.profile);
    store.setResults({
      simulationId: null,
      ...sampled,
      profile: trip.profile,
      source: "session",
    });
  } else {
    store.setResults(emptyResults());
  }
  store.pushConsole(
    `load · trip ${trip.name} · corridor=${corr?.S?.length ?? 0} pts`
  );
  return !!corr || !!trip.routeResult;
}

/** Hydrate canvas from a library cycle (results overlay — keep live corridor). */
export function hydrateFromCycle(cycleId: string): boolean {
  const store = useWorkspaceStore.getState();
  const profile = profileFromCycle(cycleId);
  if (!profile) {
    store.pushConsole(`load cycle · no profile ${cycleId}`);
    return false;
  }
  // Do not wipe geometry.corridor/route — Rebuild still needs them.
  // Results source=library keeps sparkline overlay for compare.
  const sampled = sampleProfile(profile);
  store.setResults({
    simulationId: cycleId,
    ...sampled,
    profile,
    source: "library",
  });
  const c = listSavedCycles().find((x) => x.id === cycleId);
  store.pushConsole(`load · cycle ${c?.name ?? cycleId}`);
  return true;
}

function tripHasGeometry(trip: {
  corridor?: { S?: number[] } | null;
  routeResult?: unknown;
}): boolean {
  const s = trip.corridor?.S;
  return !!(s && s.length > 1) || !!trip.routeResult;
}

/**
 * On IDE load: studio session first, else first saved trip with real corridor/route.
 * Never synthesizes corridor geometry.
 */
export function hydrateInitialWorkspace(): boolean {
  if (hydrateFromStudioSession()) {
    const g = useWorkspaceStore.getState().geometry;
    if (g.corridor?.S?.length || g.route) return true;
  }

  const trips = listSavedTrips();
  const candidate = trips.find(tripHasGeometry);
  if (!candidate) {
    useWorkspaceStore.getState().pushConsole(
      "load · no session/trip geometry — Rebuild disabled until route exists"
    );
    return false;
  }

  useWorkspaceStore.getState().selectAsset("trip", candidate.id);
  return true;
}
