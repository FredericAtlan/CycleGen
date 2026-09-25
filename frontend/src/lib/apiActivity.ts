/**
 * Lightweight API / WebSocket activity bus for the dockable console.
 * Instrumented from `api.ts` and `useSimulationSocket`.
 */

export type ApiActivityLevel = "info" | "ok" | "warn" | "error" | "ws";

export type ApiActivityEntry = {
  id: string;
  t: number;
  level: ApiActivityLevel;
  /** Short French label for the step. */
  label: string;
  /** Technical path / method. */
  detail?: string;
  /** HTTP status or WS state. */
  status?: number | string;
  /** Elapsed ms for request→response. */
  durationMs?: number;
  /** Bytes / sample count hint. */
  bytesHint?: string;
  /** Upstream provider: HERE, Mapbox, OSRM, CycleGen… */
  provider?: string;
  /** Full (redacted) upstream URL when known. */
  url?: string;
  /** Hostname of upstream server. */
  host?: string;
  /** HTTP method when applicable. */
  method?: string;
};

type Listener = (entry: ApiActivityEntry) => void;
type InflightListener = (n: number) => void;

const MAX_BUFFER = 500;
const listeners = new Set<Listener>();
const inflightListeners = new Set<InflightListener>();
const buffer: ApiActivityEntry[] = [];
let seq = 0;
let inflight = 0;

function setInflight(n: number) {
  inflight = Math.max(0, n);
  for (const l of inflightListeners) {
    try {
      l(inflight);
    } catch {
      /* ignore */
    }
  }
}

/** Human labels for known CycleGen endpoints. */
export function describeApiPath(method: string, path: string): string {
  const p = path.split("?")[0] || path;
  if (p.includes("/geocode")) return "Géocodage adresse";
  if (p.includes("/elevation")) return "Altitude DEM";
  if (p.includes("/route/analyze")) return "Analyse d’itinéraire";
  if (p.includes("/corridor/build")) return "Construction du corridor";
  if (p.includes("/simulate/start")) return "Démarrage simulation";
  if (p.includes("/simulate/") && p.includes("/stop")) return "Arrêt simulation";
  if (p.includes("/scenario/run")) return "Scénarios batch";
  if (p.includes("/export")) return "Export profil";
  if (p.includes("/benchmark/sources/") && method === "GET")
    return "Chargement référence benchmark";
  if (p.includes("/benchmark/sources")) return "Liste corpus benchmark";
  if (p.includes("/benchmark/run")) return "Comparaison benchmark";
  if (p.includes("/simulate/ws")) return "Flux WebSocket simulation";
  return `${method} ${p}`;
}

export function getApiActivityBuffer(): ApiActivityEntry[] {
  return buffer.slice();
}

export function getApiInflight(): number {
  return inflight;
}

export function subscribeApiActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeApiInflight(listener: InflightListener): () => void {
  inflightListeners.add(listener);
  listener(inflight);
  return () => {
    inflightListeners.delete(listener);
  };
}

export function emitApiActivity(
  partial: Omit<ApiActivityEntry, "id" | "t"> & { t?: number }
): ApiActivityEntry {
  seq += 1;
  const entry: ApiActivityEntry = {
    id: `api-${seq}-${Date.now()}`,
    t: partial.t ?? Date.now(),
    level: partial.level,
    label: partial.label,
    detail: partial.detail,
    status: partial.status,
    durationMs: partial.durationMs,
    bytesHint: partial.bytesHint,
    provider: partial.provider,
    url: partial.url,
    host: partial.host,
    method: partial.method,
  };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  for (const l of listeners) {
    try {
      l(entry);
    } catch {
      /* ignore subscriber errors */
    }
  }
  return entry;
}

function routingIntentFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const o = body as Record<string, unknown>;
  const profiles = o.routing_profiles;
  if (Array.isArray(profiles) && profiles.length) {
    return `Routeurs UI : ${profiles.map(String).join(" → ")}`;
  }
  if (typeof o.routing_profile === "string") {
    return `Routeur UI : ${o.routing_profile}`;
  }
  return undefined;
}

/** Mark HTTP request start (increments inflight). */
export function beginApiRequest(
  method: string,
  path: string,
  body?: unknown
): { t0: number; label: string } {
  const label = describeApiPath(method, path);
  setInflight(inflight + 1);
  emitApiActivity({
    level: "info",
    provider: "CycleGen",
    label: `Envoi · ${label}`,
    detail: `${method} ${path}`,
    method,
    bytesHint: body !== undefined ? payloadHint(body) : undefined,
  });
  const intent = routingIntentFromBody(body);
  if (intent) {
    emitApiActivity({
      level: "info",
      provider: "CycleGen",
      label: intent,
      detail: "Sélection avant appel amont",
    });
  }
  return { t0: Date.now(), label };
}

type UpstreamLog = {
  t_ms?: number;
  provider?: string;
  phase?: string;
  method?: string;
  host?: string;
  path?: string;
  url?: string;
  status?: number | string | null;
  duration_ms?: number | null;
  detail?: string | null;
  bytes_hint?: string | null;
};

function ingestConnectionLog(data: unknown): void {
  if (!data || typeof data !== "object") return;
  const o = data as Record<string, unknown>;
  const log = o.connection_log;
  if (!Array.isArray(log) || !log.length) return;

  emitApiActivity({
    level: "info",
    provider: "CycleGen",
    label: "Connexions amont",
    detail: `${log.length} hop(s) — détail ci-dessous`,
  });

  for (const raw of log) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as UpstreamLog;
    const provider = e.provider || "upstream";
    const phase = (e.phase || "info").toLowerCase();
    const level: ApiActivityLevel =
      phase === "ok"
        ? "ok"
        : phase === "error"
          ? "error"
          : phase === "start"
            ? "info"
            : phase === "warn"
              ? "warn"
              : "info";
    const phaseFr =
      phase === "start"
        ? "→ connexion"
        : phase === "ok"
          ? "← reçu"
          : phase === "error"
            ? "✗ erreur"
            : "· info";
    const pathBit = e.path ? e.path : "";
    emitApiActivity({
      level,
      provider,
      label: `${phaseFr} · ${provider}${pathBit ? ` ${pathBit}` : ""}`,
      detail: [e.detail, e.host ? `host=${e.host}` : null]
        .filter(Boolean)
        .join(" · ") || undefined,
      status: e.status ?? undefined,
      durationMs:
        typeof e.duration_ms === "number" ? e.duration_ms : undefined,
      bytesHint: e.bytes_hint || undefined,
      host: e.host || undefined,
      url: e.url || undefined,
      method: e.method || undefined,
      t: typeof e.t_ms === "number" ? e.t_ms : undefined,
    });
  }

  const used = o.routers_used;
  const traffic = o.traffic_source;
  const status = o.router_status;
  if (Array.isArray(used) && used.length) {
    emitApiActivity({
      level: "ok",
      provider: String(used[0]).toUpperCase() === "HERE" ? "HERE" : String(used[0]),
      label: `Routeur primaire : ${used.join(" → ")}`,
      detail:
        typeof traffic === "string" ? `traffic_source=${traffic}` : undefined,
    });
  }
  if (status && typeof status === "object") {
    for (const [k, v] of Object.entries(status as Record<string, unknown>)) {
      const provider =
        k === "here" ? "HERE" : k === "mapbox" ? "Mapbox" : k === "osrm" ? "OSRM" : k;
      const ok = String(v) === "ok";
      emitApiActivity({
        level: ok ? "ok" : String(v).startsWith("error") ? "error" : "warn",
        provider,
        label: `Statut ${provider}`,
        detail: String(v),
        status: String(v),
      });
    }
  }
}

export function endApiRequestOk(
  ctx: { t0: number; label: string },
  opts?: { status?: number; data?: unknown; bytesHint?: string }
): void {
  setInflight(inflight - 1);
  ingestConnectionLog(opts?.data);
  emitApiActivity({
    level: "ok",
    provider: "CycleGen",
    label: `Reçu · ${ctx.label}`,
    status: opts?.status ?? 200,
    durationMs: Date.now() - ctx.t0,
    bytesHint:
      opts?.bytesHint ??
      (opts?.data !== undefined ? summarizeJsonData(opts.data) : undefined),
  });
}

export function endApiRequestError(
  ctx: { t0: number; label: string },
  message: string,
  status?: number
): void {
  setInflight(inflight - 1);
  emitApiActivity({
    level: "error",
    provider: "CycleGen",
    label: `Échec · ${ctx.label}`,
    detail: message,
    status,
    durationMs: Date.now() - ctx.t0,
  });
}

export function clearApiActivity(): void {
  buffer.length = 0;
  setInflight(0);
  emitApiActivity({
    level: "info",
    label: "Console effacée",
    detail: "Prêt pour de nouvelles requêtes",
  });
}

/** Summarize a JSON payload size without dumping content. */
export function payloadHint(body: unknown): string | undefined {
  try {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const n = raw.length;
    if (n < 1024) return `${n} o`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
    return `${(n / (1024 * 1024)).toFixed(2)} Mo`;
  } catch {
    return undefined;
  }
}

export function summarizeJsonData(data: unknown): string | undefined {
  if (data == null) return undefined;
  if (Array.isArray(data)) return `${data.length} éléments`;
  if (typeof data === "object") {
    const o = data as Record<string, unknown>;
    const keys = Object.keys(o);
    const hints: string[] = [];
    if (Array.isArray(o.S)) hints.push(`S=${o.S.length}`);
    if (Array.isArray(o.geometry)) hints.push(`geom=${o.geometry.length}`);
    if (Array.isArray(o.time)) hints.push(`t=${o.time.length}`);
    if (Array.isArray(o.velocity)) hints.push(`v=${o.velocity.length}`);
    if (typeof o.simulation_id === "string")
      hints.push(`id=${String(o.simulation_id).slice(0, 8)}…`);
    if (typeof o.engine === "string") hints.push(`engine=${o.engine}`);
    if (typeof o.ws_path === "string") hints.push("ws_path");
    if (typeof o.distance_m === "number")
      hints.push(`${(Number(o.distance_m) / 1000).toFixed(1)} km`);
    if (typeof o.total_duration_s === "number")
      hints.push(`${Math.round(Number(o.total_duration_s))} s`);
    if (typeof o.traffic_source === "string")
      hints.push(`src=${o.traffic_source}`);
    if (Array.isArray(o.routers_used) && o.routers_used.length)
      hints.push(`routers=${o.routers_used.join("+")}`);
    if (Array.isArray(o.connection_log))
      hints.push(`${o.connection_log.length} hops amont`);
    if (hints.length) return hints.join(" · ");
    return `${keys.length} champs`;
  }
  return undefined;
}
