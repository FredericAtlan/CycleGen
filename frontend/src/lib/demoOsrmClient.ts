/**
 * Client-side OSRM + Photon (+ Open-Meteo Z) for the GitHub Pages demo.
 * Used when no FastAPI URL is configured — no HERE/Mapbox keys.
 */
import type {
  CorridorBuildResponse,
  LatLon,
  RouteAnalyzeResponse,
  SpatialCorridor,
  WaypointSpec,
} from "@/lib/types";
import { beginApiRequest, endApiRequestError, endApiRequestOk } from "@/lib/apiActivity";

export type DemoGeocodeResult = {
  lat: number;
  lon: number;
  display_name: string;
  query: string;
  elevation_m?: number | null;
};

const OSRM_BASE = (
  process.env.NEXT_PUBLIC_OSRM_URL || "https://router.project-osrm.org"
).replace(/\/$/, "");
const PHOTON_BASE = (
  process.env.NEXT_PUBLIC_PHOTON_URL || "https://photon.komoot.io"
).replace(/\/$/, "");

function bboxOf(geometry: LatLon[]): [number, number, number, number] {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of geometry) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  if (!Number.isFinite(minLat)) return [0, 0, 0, 0];
  return [minLon, minLat, maxLon, maxLat];
}

function photonLabel(props: Record<string, unknown>): string {
  const name = typeof props.name === "string" ? props.name : "";
  const street = typeof props.street === "string" ? props.street : "";
  const city =
    (typeof props.city === "string" && props.city) ||
    (typeof props.town === "string" && props.town) ||
    (typeof props.village === "string" && props.village) ||
    "";
  const parts = [name || street, city].filter(Boolean);
  return parts.join(", ") || "Point";
}

export async function demoGeocodeAddress(
  query: string,
  opts?: { nearLat?: number; nearLon?: number }
): Promise<DemoGeocodeResult> {
  const q = query.trim();
  if (!q) throw new Error("Adresse vide");
  const ctx = beginApiRequest("GET", "/demo/photon/geocode", { query: q });
  const url = new URL(`${PHOTON_BASE}/api/`);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "1");
  url.searchParams.set("lang", "fr");
  if (opts?.nearLat != null && opts?.nearLon != null) {
    url.searchParams.set("lat", String(opts.nearLat));
    url.searchParams.set("lon", String(opts.nearLon));
  }
  try {
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      endApiRequestError(ctx, `Photon ${res.status}`, res.status);
      throw new Error(`Géocodage démo échoué (${res.status})`);
    }
    const data = (await res.json()) as {
      features?: Array<{
        geometry?: { coordinates?: number[] };
        properties?: Record<string, unknown>;
      }>;
    };
    const feat = data.features?.[0];
    const coords = feat?.geometry?.coordinates;
    if (!coords || coords.length < 2) {
      endApiRequestError(ctx, "Aucun résultat Photon");
      throw new Error(`Adresse introuvable : ${q}`);
    }
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    const display = photonLabel(feat?.properties ?? {});
    const out: DemoGeocodeResult = {
      lat,
      lon,
      display_name: display,
      query: q,
      elevation_m: null,
    };
    endApiRequestOk(ctx, { status: 200, data: out });
    return out;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Adresse")) throw e;
    endApiRequestError(
      ctx,
      e instanceof Error ? e.message : "Photon injoignable"
    );
    throw e instanceof Error ? e : new Error("Photon injoignable");
  }
}

async function resolvePoint(
  label: string | null | undefined,
  lat: number | null | undefined,
  lon: number | null | undefined
): Promise<{ lat: number; lon: number; label: string }> {
  if (
    lat != null &&
    lon != null &&
    Number.isFinite(lat) &&
    Number.isFinite(lon)
  ) {
    return { lat, lon, label: (label || "").trim() || `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
  }
  const q = (label || "").trim();
  if (!q) throw new Error("Point A/B manquant (adresse ou coordonnées)");
  const g = await demoGeocodeAddress(q);
  return { lat: g.lat, lon: g.lon, label: g.display_name };
}

async function fetchElevations(
  geometry: LatLon[]
): Promise<{ elevations: number[]; source: string }> {
  if (geometry.length < 2) {
    return { elevations: geometry.map(() => 0), source: "flat" };
  }
  // Open-Meteo caps batch size — subsample then interpolate.
  const maxPts = 100;
  const step = Math.max(1, Math.ceil(geometry.length / maxPts));
  const sampleIdx: number[] = [];
  for (let i = 0; i < geometry.length; i += step) sampleIdx.push(i);
  if (sampleIdx[sampleIdx.length - 1] !== geometry.length - 1) {
    sampleIdx.push(geometry.length - 1);
  }
  const lats = sampleIdx.map((i) => geometry[i].lat).join(",");
  const lons = sampleIdx.map((i) => geometry[i].lon).join(",");
  const ctx = beginApiRequest("GET", "/demo/open-meteo/elevation");
  try {
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      endApiRequestError(ctx, `Open-Meteo ${res.status}`, res.status);
      return { elevations: geometry.map(() => 0), source: "flat" };
    }
    const data = (await res.json()) as { elevation?: number[] };
    const samples = data.elevation ?? [];
    if (samples.length !== sampleIdx.length) {
      endApiRequestError(ctx, "Open-Meteo taille mismatch");
      return { elevations: geometry.map(() => 0), source: "flat" };
    }
    const elevations = new Array<number>(geometry.length);
    for (let s = 0; s < sampleIdx.length - 1; s++) {
      const i0 = sampleIdx[s];
      const i1 = sampleIdx[s + 1];
      const z0 = samples[s];
      const z1 = samples[s + 1];
      const span = Math.max(1, i1 - i0);
      for (let i = i0; i <= i1; i++) {
        const t = (i - i0) / span;
        elevations[i] = z0 + (z1 - z0) * t;
      }
    }
    endApiRequestOk(ctx, {
      status: 200,
      bytesHint: `${geometry.length} pts Z`,
    });
    return { elevations, source: "open-meteo" };
  } catch (e) {
    endApiRequestError(
      ctx,
      e instanceof Error ? e.message : "Open-Meteo injoignable"
    );
    return { elevations: geometry.map(() => 0), source: "flat" };
  }
}

export type DemoAnalyzeParams = {
  latA?: number | null;
  lonA?: number | null;
  latB?: number | null;
  lonB?: number | null;
  addressA?: string | null;
  addressB?: string | null;
  waypoints?: WaypointSpec[];
  departAt: string;
  aY?: number;
};

export async function demoAnalyzeRoute(
  params: DemoAnalyzeParams
): Promise<RouteAnalyzeResponse> {
  const ctx = beginApiRequest("GET", "/demo/osrm/route", {
    a: params.addressA,
    b: params.addressB,
  });
  try {
    const origin = await resolvePoint(params.addressA, params.latA, params.lonA);
    const dest = await resolvePoint(params.addressB, params.latB, params.lonB);
    const vias: Array<{ lat: number; lon: number; label: string }> = [];
    for (const wp of params.waypoints ?? []) {
      if (!wp) continue;
      const hit = await resolvePoint(
        wp.address,
        wp.lat ?? null,
        wp.lon ?? null
      );
      vias.push(hit);
    }
    const points = [origin, ...vias, dest];
    const coordPath = points.map((p) => `${p.lon},${p.lat}`).join(";");
    const url = new URL(`${OSRM_BASE}/route/v1/driving/${coordPath}`);
    url.searchParams.set("overview", "full");
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("annotations", "speed,distance");

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      endApiRequestError(ctx, `OSRM ${res.status}`, res.status);
      throw new Error(`OSRM démo échoué (${res.status})`);
    }
    const payload = (await res.json()) as {
      code?: string;
      routes?: Array<{
        distance?: number;
        duration?: number;
        geometry?: { coordinates?: number[][] };
        legs?: Array<{
          annotation?: { speed?: Array<number | null>; distance?: Array<number | null> };
        }>;
      }>;
    };
    if (String(payload.code || "").toUpperCase() !== "OK" || !payload.routes?.[0]) {
      endApiRequestError(ctx, `OSRM ${payload.code || "no route"}`);
      throw new Error("Aucun itinéraire OSRM trouvé");
    }
    const route = payload.routes[0];
    const rawCoords = route.geometry?.coordinates ?? [];
    const geometry: LatLon[] = rawCoords.map(([lon, lat]) => ({
      lat: Number(lat),
      lon: Number(lon),
    }));
    if (geometry.length < 2) {
      endApiRequestError(ctx, "Géométrie OSRM vide");
      throw new Error("Géométrie OSRM vide");
    }

    const speeds: number[] = [];
    const distances: number[] = [];
    for (const leg of route.legs ?? []) {
      const ann = leg.annotation || {};
      for (const v of ann.speed || []) speeds.push(Number(v) || 0);
      for (const v of ann.distance || []) distances.push(Number(v) || 0);
    }
    // Align annotation length to geometry edges when possible
    while (speeds.length < Math.max(0, geometry.length - 1)) speeds.push(speeds[speeds.length - 1] ?? 13.9);
    while (distances.length < Math.max(0, geometry.length - 1)) {
      distances.push(distances[distances.length - 1] ?? 10);
    }

    const { elevations, source: elevSource } = await fetchElevations(geometry);
    const out: RouteAnalyzeResponse = {
      geometry,
      distance_m: Number(route.distance) || 0,
      duration_s: Number(route.duration) || 0,
      segment_speeds_mps: speeds,
      segment_distances_m: distances,
      elevations_m: elevations,
      traffic_signals: [],
      bbox: bboxOf(geometry),
      origin: { lat: origin.lat, lon: origin.lon },
      destination: { lat: dest.lat, lon: dest.lon },
      origin_label: origin.label,
      destination_label: dest.label,
      via_points: vias.map((v, i) => ({
        index: i,
        lat: v.lat,
        lon: v.lon,
        label: v.label,
        stop_duration_s: 0,
      })),
      traffic_source: "osrm_freeflow",
      warnings: [
        {
          code: "demo_osrm_pages",
          message:
            "Démo GitHub Pages : itinéraire OSRM public (free-flow), sans HERE/Mapbox ni API CycleGen.",
          s0: 0,
          s1: Number(route.distance) || 0,
          source: "demoOsrmClient",
        },
      ],
      segment_traffic_speeds_mps: speeds,
      depart_at: params.departAt,
      a_y_mps2: params.aY ?? 3.5,
      elevation_source: elevSource,
      routers_used: ["osrm"],
      segment_speeds_by_router: { osrm: speeds },
      segment_traffic_speeds_by_router: { osrm: speeds },
      elevations_by_source:
        elevSource === "open-meteo"
          ? { "open-meteo": elevations }
          : undefined,
      router_status: {
        here: "skipped:demo",
        mapbox: "skipped:demo",
        osrm: "ok",
      },
      connection_log: [
        {
          t_ms: Date.now(),
          provider: "OSRM",
          phase: "demo",
          method: "GET",
          host: "router.project-osrm.org",
          path: "/route/v1/driving",
          status: 200,
          detail: "démo Pages (client)",
        },
      ],
    };
    endApiRequestOk(ctx, {
      status: 200,
      bytesHint: `${(out.distance_m / 1000).toFixed(1)} km · ${geometry.length} pts`,
    });
    return out;
  } catch (e) {
    endApiRequestError(
      ctx,
      e instanceof Error ? e.message : "OSRM démo échoué"
    );
    throw e instanceof Error ? e : new Error("OSRM démo échoué");
  }
}

/** Lightweight corridor for map / charts when FastAPI is offline. */
export function demoBuildCorridor(
  route: RouteAnalyzeResponse,
  options?: { aY?: number; globalMaxSpeedKmh?: number }
): CorridorBuildResponse {
  const n = route.geometry.length;
  const S: number[] = new Array(n).fill(0);
  const segs = route.segment_distances_m ?? [];
  for (let i = 1; i < n; i++) {
    S[i] = S[i - 1] + (segs[i - 1] ?? 0);
  }
  if (S[n - 1] <= 0 && route.distance_m > 0) {
    // Uniform fallback along distance
    for (let i = 0; i < n; i++) S[i] = (route.distance_m * i) / Math.max(1, n - 1);
  }

  const vmax = (options?.globalMaxSpeedKmh ?? 130) / 3.6;
  const speeds = route.segment_speeds_mps ?? [];
  const V: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const edge = speeds[Math.min(i, Math.max(0, speeds.length - 1))] ?? 13.9;
    V[i] = Math.min(Math.max(edge, 1), vmax);
  }

  const elev = route.elevations_m ?? new Array(n).fill(0);
  const alpha: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const ds = Math.max(S[i] - S[i - 1], 1e-3);
    const dz = (elev[i] ?? 0) - (elev[i - 1] ?? 0);
    alpha[i] = Math.atan(dz / ds);
  }
  alpha[0] = alpha[1] ?? 0;

  const corridor: SpatialCorridor = {
    S,
    V_limite: V,
    V_limite_legal: V,
    V_traffic: V,
    V_curve: V,
    V_envelope: V,
    alpha,
    elevations_m: elev,
    S_feux: [],
    events: [],
    geometry: route.geometry,
    traffic_source: route.traffic_source || "osrm_freeflow",
    warnings: [
      ...(route.warnings ?? []),
      {
        code: "demo_corridor",
        message:
          "Corridor démo client (sans Overpass/TLS) — simulation IDM serveur indisponible sans API.",
        s0: 0,
        s1: S[n - 1] || 0,
        source: "demoOsrmClient",
      },
    ],
    a_y_mps2: options?.aY ?? route.a_y_mps2 ?? 3.5,
  };

  return {
    corridor,
    corridor_id: `demo-osrm-${Date.now()}`,
    v_limite_legal: V,
    v_traffic: V,
    v_curve: V,
    v_envelope: V,
    traffic_source: corridor.traffic_source,
    warnings: corridor.warnings,
  };
}
