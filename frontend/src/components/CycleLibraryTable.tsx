"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getBenchmarkSource, listBenchmarkSources } from "@/lib/api";
import { CORPUS_FAMILY_LABEL } from "@/lib/corpusGroups";
import {
  deleteSavedCycle,
  elevationExtremesM,
  ensureXspaceAvlSeedCycles,
  listSavedCycles,
  newCycleInstanceId,
  packCycle,
  renameSavedCycle,
  saveCycle,
  seedStudioSessionFromCycle,
  stashBaseCycleForStudio,
  stashEnergyOpen,
  stashCyclesForCompare,
  type SavedCycle,
} from "@/lib/cycleLibrary";
import ProfileDataDrawer from "@/components/ProfileDataDrawer";
import LibraryStorageBanner from "@/components/LibraryStorageBanner";
import { computeCycleStats, enrichSeriesFromGps } from "@/lib/cycleMetrics";
import { parseCycleBlob } from "@/lib/parseCycleFile";
import { clearStudioSession } from "@/lib/studioSession";
import { listSavedTrips } from "@/lib/tripStore";
import type { BenchmarkSourceMeta } from "@/lib/types";

type Kind = "saved" | "corpus" | "trip";

type LibraryRow = {
  id: string;
  kind: Kind;
  name: string;
  family: string;
  /** ISO creation / save date (saved & trips); null for corpus. */
  createdAt: string | null;
  distance_m: number | null;
  duration_s: number | null;
  v_mean_kmh: number | null;
  v_max_kmh: number | null;
  slope_mean_pct: number | null;
  slope_min_pct: number | null;
  slope_max_pct: number | null;
  has_tls: boolean | null;
  has_geo: boolean;
  resultAvailable: boolean;
  z_min_m: number | null;
  z_max_m: number | null;
  meta: BenchmarkSourceMeta | null;
  saved: SavedCycle | null;
};

type ColKey =
  | "name"
  | "createdAt"
  | "has_geo"
  | "resultAvailable"
  | "distance_m"
  | "duration_s"
  | "v_mean_kmh"
  | "v_max_kmh"
  | "slope_mean_pct"
  | "slope_min_pct"
  | "slope_max_pct"
  | "z_min_m"
  | "z_max_m"
  | "has_tls";

const COLS: { key: ColKey; label: string }[] = [
  { key: "name", label: "Nom cycle" },
  { key: "createdAt", label: "Créé le" },
  { key: "has_geo", label: "Type" },
  { key: "resultAvailable", label: "Résultat" },
  { key: "distance_m", label: "Distance" },
  { key: "duration_s", label: "Durée" },
  { key: "v_mean_kmh", label: "v̄" },
  { key: "v_max_kmh", label: "vmax" },
  { key: "slope_mean_pct", label: "Pente moy." },
  { key: "slope_min_pct", label: "Pente min" },
  { key: "slope_max_pct", label: "Pente max" },
  { key: "z_min_m", label: "Alt. min" },
  { key: "z_max_m", label: "Alt. max" },
  { key: "has_tls", label: "Feux" },
];

function numStat(stats: Record<string, unknown> | null | undefined, key: string): number | null {
  if (!stats) return null;
  const v = stats[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function fmtKm(m: number | null): string {
  if (m == null) return "—";
  return `${(m / 1000).toFixed(1)} km`;
}

function fmtDur(s: number | null): string {
  if (s == null) return "—";
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m > 0 ? `${m} min ${r} s` : `${r} s`;
}

function fmtN(n: number | null, d = 1, unit = ""): string {
  if (n == null) return "—";
  return `${n.toFixed(d)}${unit}`;
}

function fmtCreatedAt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const t = d.getTime();
  if (!Number.isFinite(t) || t <= 0) return "—";
  return d.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function cycleFromSavedLike(c: SavedCycle): SavedCycle {
  return packCycle(
    {
      ...c,
      id: newCycleInstanceId(c.origin),
    },
    { maxPoints: 2500 }
  );
}

function typeBadge(row: {
  has_geo: boolean;
  family: string;
  kind: Kind;
}): { label: string; className: string; title: string } {
  if (row.has_geo) {
    return {
      label: "Trajet GPS",
      className: "bg-emerald-50 text-emerald-800",
      title: "Coordonnées GPS — base pour régénérer le dynamique CycleGen",
    };
  }
  if (row.family === "oem" || row.family === "regulatory") {
    return {
      label: row.family === "oem" ? "Réf. OEM" : "Réglementaire",
      className: "bg-amber-50 text-amber-900",
      title:
        "Sans GPS — étude énergie : même v(t), changer de véhicule (P / couple)",
    };
  }
  return {
    label: "Énergie",
    className: "bg-slate-100 text-slate-700",
    title: "Sans GPS — profil v(t) pour P / couple véhicule",
  };
}

export default function CycleLibraryTable() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [corpus, setCorpus] = useState<BenchmarkSourceMeta[]>([]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | Kind>("all");
  const [geoFilter, setGeoFilter] = useState<"all" | "gps" | "no_gps">("all");
  const [sortKey, setSortKey] = useState<ColKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [tick, setTick] = useState(0);
  const [corpusLoading, setCorpusLoading] = useState(true);
  const [dataOpen, setDataOpen] = useState(false);
  const [dataCycle, setDataCycle] = useState<SavedCycle | null>(null);
  const [dataHasGeo, setDataHasGeo] = useState(false);

  useEffect(() => {
    setCorpusLoading(true);
    void (async () => {
      try {
        await ensureXspaceAvlSeedCycles();
        setTick((t) => t + 1);
      } catch {
        /* optional seed */
      }
      try {
        const sources = await listBenchmarkSources();
        setCorpus(Array.isArray(sources) ? sources : []);
        setError("");
      } catch (e) {
        setCorpus([]);
        setError(
          e instanceof Error
            ? e.message
            : "Impossible de charger le corpus (API)."
        );
      } finally {
        setCorpusLoading(false);
      }
    })();
  }, []);

  const rows = useMemo(() => {
    const out: LibraryRow[] = [];
    void tick;

    for (const c of listSavedCycles()) {
      const elev =
        c.z_min_m != null || c.z_max_m != null
          ? { z_min_m: c.z_min_m ?? null, z_max_m: c.z_max_m ?? null }
          : elevationExtremesM(c.corridor?.elevations_m);
      out.push({
        id: `saved:${c.id}`,
        kind: "saved",
        name: c.name,
        family: c.origin,
        createdAt: c.savedAt || null,
        distance_m: c.stats.distance_m,
        duration_s: c.stats.duration_s,
        v_mean_kmh: c.stats.v_mean_kmh,
        v_max_kmh: c.stats.v_max_kmh,
        slope_mean_pct: c.stats.slope_mean_pct,
        slope_min_pct: c.stats.slope_min_pct,
        slope_max_pct: c.stats.slope_max_pct,
        has_tls: (c.meta as { has_tls?: boolean } | undefined)?.has_tls ?? c.limits != null,
        has_geo: (c.geometry?.length ?? 0) >= 2,
        resultAvailable:
          typeof c.resultAvailable === "boolean"
            ? c.resultAvailable
            : c.time.length > 1,
        z_min_m: elev.z_min_m,
        z_max_m: elev.z_max_m,
        meta: null,
        saved: c,
      });
    }

    for (const t of listSavedTrips()) {
      const p = t.profile;
      if (!p || p.time.length < 2) continue;
      const geo = t.geometry?.length
        ? t.geometry
        : t.corridor?.geometry ?? [];
      const enriched = enrichSeriesFromGps({
        time: p.time,
        velocity: p.velocity,
        acceleration: p.acceleration,
        slope: p.slope,
        position: p.position,
        lat: geo.map((g) => g.lat),
        lon: geo.map((g) => g.lon),
      });
      const stats = computeCycleStats({
        time: p.time,
        velocity: p.velocity,
        acceleration: enriched.acceleration,
        slope: enriched.slope,
        position: enriched.position,
        a_lat: enriched.a_lat,
      });
      const tls = t.corridor?.S_feux?.length
        ? t.corridor.S_feux.length > 0
        : null;
      const elev = elevationExtremesM(t.corridor?.elevations_m);
      out.push({
        id: `trip:${t.id}`,
        kind: "trip",
        name: t.name,
        family: "trajet",
        createdAt: t.savedAt || null,
        distance_m: t.distanceM ?? stats.distance_m,
        duration_s: t.durationS ?? stats.duration_s,
        v_mean_kmh: stats.v_mean_kmh,
        v_max_kmh: stats.v_max_kmh,
        slope_mean_pct: stats.slope_mean_pct,
        slope_min_pct: stats.slope_min_pct,
        slope_max_pct: stats.slope_max_pct,
        has_tls: tls,
        has_geo: geo.length >= 2 || (!!t.pointA && !!t.pointB),
        resultAvailable: p.time.length > 1 && p.velocity.length === p.time.length,
        z_min_m: elev.z_min_m,
        z_max_m: elev.z_max_m,
        meta: null,
        saved: packCycle({
          name: t.name,
          source: `Trajet · ${t.driverProfile}`,
          origin: "cyclegen",
          time: p.time,
          velocity: p.velocity,
          acceleration: enriched.acceleration,
          slope: enriched.slope,
          a_lat: enriched.a_lat,
          position: enriched.position,
          geometry: geo.length >= 2 ? geo : enriched.geometry,
          resultAvailable: true,
          z_min_m: elev.z_min_m,
          z_max_m: elev.z_max_m,
          corridor: t.corridor ?? null,
          meta: {
            driverProfile: t.driverProfile,
            routeLabel: `${t.departureLabel} → ${t.destinationLabel}`,
            trafficSource: t.trafficSource ?? undefined,
          },
        }),
      });
    }

    for (const m of corpus) {
      const st = (m.stats ?? null) as Record<string, unknown> | null;
      out.push({
        id: `corpus:${m.id}`,
        kind: "corpus",
        name: m.name,
        family: m.family || "corpus",
        createdAt: null,
        distance_m: numStat(st, "distance_m"),
        duration_s: numStat(st, "duration_s") ?? m.duration_s,
        v_mean_kmh: numStat(st, "v_mean_kmh"),
        v_max_kmh: numStat(st, "v_max_kmh"),
        slope_mean_pct: numStat(st, "slope_mean_pct"),
        slope_min_pct: numStat(st, "slope_min_pct"),
        slope_max_pct: numStat(st, "slope_max_pct"),
        has_tls: m.has_geo ? null : false,
        has_geo: !!m.has_geo,
        resultAvailable: m.n_points > 1 || (numStat(st, "duration_s") ?? m.duration_s) > 0,
        z_min_m: numStat(st, "z_min_m") ?? numStat(st, "elevation_min_m"),
        z_max_m: numStat(st, "z_max_m") ?? numStat(st, "elevation_max_m"),
        meta: m,
        saved: null,
      });
    }
    return out;
  }, [corpus, tick]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = kind === "all" ? rows : rows.filter((r) => r.kind === kind);
    if (geoFilter === "gps") list = list.filter((r) => r.has_geo);
    if (geoFilter === "no_gps") list = list.filter((r) => !r.has_geo);
    if (q) {
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.family.toLowerCase().includes(q) ||
          (r.has_geo ? "gps" : "sans").includes(q)
      );
    }
    const dir = sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      if (sortKey === "has_geo" || sortKey === "resultAvailable") {
        return (Number(a[sortKey]) - Number(b[sortKey])) * dir;
      }
      if (sortKey === "createdAt") {
        const ta = a.createdAt ? Date.parse(a.createdAt) : NaN;
        const tb = b.createdAt ? Date.parse(b.createdAt) : NaN;
        const fa = Number.isFinite(ta) ? ta : null;
        const fb = Number.isFinite(tb) ? tb : null;
        if (fa == null && fb == null) return 0;
        if (fa == null) return 1;
        if (fb == null) return -1;
        return (fa - fb) * dir;
      }
      const va = a[sortKey];
      const vb = b[sortKey];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string" && typeof vb === "string") {
        return va.localeCompare(vb) * dir;
      }
      if (typeof va === "boolean" && typeof vb === "boolean") {
        return (Number(va) - Number(vb)) * dir;
      }
      return (Number(va) - Number(vb)) * dir;
    });
  }, [rows, query, kind, geoFilter, sortKey, sortDir]);

  const selected = useMemo(
    () => filtered.find((r) => r.id === selectedId) ?? null,
    [filtered, selectedId]
  );

  const toggleSort = (key: ColKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const resolveCycle = async (row: LibraryRow): Promise<SavedCycle> => {
    if (row.saved) return cycleFromSavedLike(row.saved);
    if (!row.meta) throw new Error("Cycle illisible");
    const series = await getBenchmarkSource(row.meta.id);
    const enriched = enrichSeriesFromGps({
      time: series.time,
      velocity: series.velocity,
      acceleration: series.acceleration,
      a_lat: series.a_lat,
      slope: series.slope,
      position: series.position,
      lat: series.lat,
      lon: series.lon,
    });
    const stats = computeCycleStats({
      time: series.time,
      velocity: series.velocity,
      acceleration: enriched.acceleration,
      slope: enriched.slope,
      position: enriched.position,
      a_lat: enriched.a_lat,
    });
    return packCycle({
      name: row.meta.name,
      source: row.meta.source || row.meta.family || "corpus",
      sourceUrl: row.meta.url,
      origin: "corpus",
      corpusId: row.meta.id,
      stats,
      time: series.time,
      velocity: series.velocity,
      acceleration: enriched.acceleration,
      slope: enriched.slope,
      a_lat: enriched.a_lat,
      position: enriched.position,
      geometry: enriched.geometry,
      meta: {
        citation: row.meta.citation || undefined,
        license: row.meta.license,
        sourceUrl: row.meta.url || undefined,
      },
    });
  };

  const openData = async (row: LibraryRow) => {
    setError("");
    setLoadingId(row.id);
    try {
      const cycle = await resolveCycle(row);
      setDataCycle(cycle);
      setDataHasGeo(row.has_geo || (cycle.geometry?.length ?? 0) >= 2);
      setDataOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Impossible d’ouvrir les données");
    } finally {
      setLoadingId(null);
    }
  };

  const openStudy = async (row: LibraryRow) => {
    setError("");
    setInfo("");
    setLoadingId(row.id);
    try {
      const cycle = await resolveCycle(row);
      if (cycle.time.length < 2 || !cycle.resultAvailable) {
        throw new Error(
          "Ce cycle n’a pas de résultat d’étude à rouvrir (profil manquant)."
        );
      }
      // Flux 2 — energy studio (no Trajet wizard).
      if (row.kind === "saved" && row.saved?.id) {
        stashEnergyOpen({
          kind: "saved",
          cycleId: row.saved.id,
          vehicleId: cycle.meta?.vehicleId ?? null,
        });
        router.push(`/?mode=energy&saved=${encodeURIComponent(row.saved.id)}`);
      } else if (cycle.corpusId || row.meta?.id) {
        const corpusId = cycle.corpusId || row.meta!.id;
        stashEnergyOpen({
          kind: "corpus",
          corpusId,
          name: cycle.name,
          vehicleId: cycle.meta?.vehicleId ?? null,
        });
        router.push(`/?mode=energy&corpus=${encodeURIComponent(corpusId)}`);
      } else {
        // Import / trip packed in memory — save then open.
        const saved = saveCycle({
          ...cycle,
          id: undefined,
          origin: cycle.origin === "corpus" ? "corpus" : "import",
          geometry: [],
        });
        stashEnergyOpen({
          kind: "saved",
          cycleId: saved.id,
          vehicleId: saved.meta?.vehicleId ?? null,
        });
        router.push(`/?mode=energy&saved=${encodeURIComponent(saved.id)}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ouverture de l’étude échouée");
    } finally {
      setLoadingId(null);
    }
  };

  const useAsBase = async (row: LibraryRow) => {
    setError("");
    setInfo("");
    setLoadingId(row.id);
    try {
      const cycle = await resolveCycle(row);
      if ((cycle.geometry?.length ?? 0) < 2 && cycle.time.length < 2) {
        throw new Error("Cycle sans profil ni géométrie");
      }
      // Sans GPS → Flux 2 énergie (même chemin qu’Étude énergie).
      if ((cycle.geometry?.length ?? 0) < 2) {
        if (cycle.time.length < 2 || !cycle.resultAvailable) {
          throw new Error("Profil manquant pour l’étude énergie");
        }
        if (row.kind === "saved" && row.saved?.id) {
          stashEnergyOpen({
            kind: "saved",
            cycleId: row.saved.id,
            vehicleId: cycle.meta?.vehicleId ?? null,
          });
          router.push(
            `/?mode=energy&saved=${encodeURIComponent(row.saved.id)}`
          );
        } else if (cycle.corpusId || row.meta?.id) {
          const corpusId = cycle.corpusId || row.meta!.id;
          stashEnergyOpen({
            kind: "corpus",
            corpusId,
            name: cycle.name,
            vehicleId: cycle.meta?.vehicleId ?? null,
          });
          router.push(`/?mode=energy&corpus=${encodeURIComponent(corpusId)}`);
        } else {
          const saved = saveCycle({
            ...cycle,
            id: undefined,
            origin: "import",
            geometry: [],
          });
          stashEnergyOpen({ kind: "saved", cycleId: saved.id });
          router.push(`/?mode=energy&saved=${encodeURIComponent(saved.id)}`);
        }
        return;
      }
      // Flux 1 — créateur GPS.
      clearStudioSession();
      seedStudioSessionFromCycle(cycle, "base");
      stashBaseCycleForStudio(cycle, "base");
      router.push("/?mode=create");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement échoué");
    } finally {
      setLoadingId(null);
    }
  };

  const sendToVersus = async (row: LibraryRow) => {
    setError("");
    setInfo("");
    setLoadingId(row.id);
    try {
      const cycle = await resolveCycle(row);
      stashCyclesForCompare([cycle]);
      router.push("/compare");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement échoué");
    } finally {
      setLoadingId(null);
    }
  };

  const addToLibrary = async (row: LibraryRow) => {
    setError("");
    setInfo("");
    setLoadingId(row.id);
    try {
      const cycle = await resolveCycle(row);
      const saved = saveCycle({
        ...cycle,
        id: undefined,
        origin: row.kind === "corpus" ? "corpus" : cycle.origin,
        name: cycle.name,
      });
      setInfo(`« ${saved.name} » ajouté à Mes cycles (navigateur).`);
      setTick((n) => n + 1);
      setSelectedId(`saved:${saved.id}`);
      setKind("saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enregistrement échoué");
    } finally {
      setLoadingId(null);
    }
  };

  const handleRename = (row: LibraryRow) => {
    if (row.kind !== "saved" || !row.saved) return;
    const next = window.prompt("Nouveau nom du cycle", row.saved.name);
    if (next == null) return;
    const updated = renameSavedCycle(row.saved.id, next);
    if (!updated) {
      setError("Renommage impossible");
      return;
    }
    setInfo(`Renommé → « ${updated.name} »`);
    setTick((n) => n + 1);
    setSelectedId(`saved:${updated.id}`);
  };

  const handleDelete = (row: LibraryRow) => {
    if (row.kind !== "saved" || !row.saved) return;
    if (
      !window.confirm(
        `Supprimer « ${row.saved.name} » de la bibliothèque navigateur ?`
      )
    ) {
      return;
    }
    deleteSavedCycle(row.saved.id);
    setInfo(`« ${row.name} » supprimé.`);
    setSelectedId(null);
    setTick((n) => n + 1);
  };

  const handleImportFile = async (file: File) => {
    setError("");
    setInfo("");
    setLoadingId("import");
    try {
      const parsed = await parseCycleBlob(file);
      const slopeRad =
        parsed.slope && parsed.slope.length === parsed.time.length
          ? parsed.slopeIsPercent
            ? parsed.slope.map((p) => Math.atan(p / 100))
            : parsed.slope
          : parsed.time.map(() => 0);
      const enriched = enrichSeriesFromGps({
        time: parsed.time,
        velocity: parsed.velocity,
        acceleration: parsed.acceleration,
        a_lat: parsed.a_lat,
        slope: slopeRad,
        position: parsed.position,
        lat: parsed.lat,
        lon: parsed.lon,
      });
      const stats = computeCycleStats({
        time: parsed.time,
        velocity: parsed.velocity,
        acceleration: enriched.acceleration,
        slope: enriched.slope,
        position: enriched.position,
        a_lat: enriched.a_lat,
      });
      const saved = saveCycle({
        name: parsed.name,
        source: parsed.source || `import · ${file.name}`,
        origin: "import",
        stats,
        time: parsed.time,
        velocity: parsed.velocity,
        acceleration: enriched.acceleration,
        slope: enriched.slope,
        a_lat: enriched.a_lat,
        position: enriched.position,
        geometry: enriched.geometry,
        meta: {
          saveTitle: parsed.name,
          notes: "Import fichier bibliothèque",
        },
      });
      const geoLabel =
        enriched.geometry.length >= 2 ? "Trajet GPS" : "Énergie (sans GPS)";
      setInfo(`Importé « ${saved.name} » · ${geoLabel}`);
      setTick((n) => n + 1);
      setKind("saved");
      setSelectedId(`saved:${saved.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import échoué");
    } finally {
      setLoadingId(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="shrink-0 border-b border-slate-100 px-4 py-2">
        <LibraryStorageBanner onImported={() => setTick((n) => n + 1)} />
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filtrer par nom, famille…"
          className="min-w-[12rem] flex-1 rounded-md border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-brand"
        />
        <div className="flex flex-wrap rounded-md border border-slate-200 bg-slate-50 p-0.5">
          {(
            [
              ["all", "Tous"],
              ["corpus", "Corpus"],
              ["saved", "Mes cycles"],
              ["trip", "Trajets"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setKind(id);
                setTick((n) => n + 1);
              }}
              className={`rounded px-2 py-1 text-[11px] font-semibold ${
                kind === id
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap rounded-md border border-slate-200 bg-slate-50 p-0.5">
          {(
            [
              ["all", "Tous types"],
              ["gps", "Trajet GPS"],
              ["no_gps", "Énergie"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setGeoFilter(id)}
              className={`rounded px-2 py-1 text-[11px] font-semibold ${
                geoFilter === id
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500"
              }`}
              title={
                id === "gps"
                  ? "Avec lat/lon — régénérer le dynamique CycleGen"
                  : id === "no_gps"
                    ? "Sans GPS — P / couple en changeant de véhicule"
                    : undefined
              }
            >
              {label}
            </button>
          ))}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.tsv,.txt,.xml,.gpx,.xlsx,.xls"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleImportFile(f);
          }}
        />
        <button
          type="button"
          disabled={loadingId === "import"}
          onClick={() => fileRef.current?.click()}
          className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          title="Importer CSV / TSV / XML / GPX dans Mes cycles (navigateur)"
        >
          {loadingId === "import" ? "…" : "Importer…"}
        </button>
        <span className="text-[11px] tabular-nums text-slate-400">
          {corpusLoading
            ? "Chargement…"
            : `${filtered.length} cycle${filtered.length === 1 ? "" : "s"}`}
        </span>
        {selected && (
          <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={loadingId === selected.id}
              onClick={() => void openData(selected)}
              className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              title="Inspecter séries, GPS, KPIs"
            >
              {loadingId === selected.id && dataOpen ? "…" : "Données"}
            </button>
            {selected.resultAvailable && (
              <button
                type="button"
                disabled={loadingId === selected.id}
                onClick={() => void openStudy(selected)}
                className={`rounded-md px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50 ${
                  !selected.has_geo
                    ? "bg-brand text-white hover:bg-brand-dark"
                    : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
                title="Flux 2 — t/v/pente + véhicule → P / couple (sans trajet GPS)"
              >
                {loadingId === selected.id
                  ? "…"
                  : "Étude énergie (Flux 2)"}
              </button>
            )}
            <button
              type="button"
              disabled={loadingId === selected.id || !selected.has_geo}
              onClick={() => void useAsBase(selected)}
              className={`rounded-md px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50 ${
                selected.has_geo
                  ? "bg-brand text-white hover:bg-brand-dark"
                  : "border border-slate-200 bg-white text-slate-400"
              }`}
              title={
                selected.has_geo
                  ? "Flux 1 — charger le trajet GPS pour régénérer un cycle"
                  : "Réservé aux cycles avec GPS — utilisez Étude énergie"
              }
            >
              {loadingId === selected.id
                ? "…"
                : "Trajet GPS → cycle (Flux 1)"}
            </button>
            <button
              type="button"
              disabled={loadingId === selected.id}
              onClick={() => void sendToVersus(selected)}
              className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              title="Comparer dans Versus (OEM vs CycleGen)"
            >
              Versus
            </button>
            {(selected.kind === "corpus" || selected.kind === "trip") && (
              <button
                type="button"
                disabled={loadingId === selected.id}
                onClick={() => void addToLibrary(selected)}
                className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                title="Copier dans Mes cycles (navigateur)"
              >
                + Mes cycles
              </button>
            )}
            {selected.kind === "saved" && (
              <>
                <button
                  type="button"
                  onClick={() => handleRename(selected)}
                  className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Renommer
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(selected)}
                  className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-red-700 hover:bg-red-50"
                >
                  Supprimer
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {error && (
        <p className="border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">
          {error}
        </p>
      )}
      {info && !error && (
        <p className="border-b border-emerald-100 bg-emerald-50 px-4 py-2 text-xs text-emerald-800">
          {info}
        </p>
      )}
      <p className="shrink-0 border-b border-slate-100 bg-slate-50 px-4 py-2 text-[11px] leading-snug text-slate-600">
        <span className="font-semibold text-slate-800">2 flux :</span>{" "}
        <span className="text-emerald-800">Trajet GPS → cycle (Flux 1)</span>{" "}
        régénère le dynamique ·{" "}
        <span className="text-amber-900">Étude énergie (Flux 2)</span> = t / v /
        pente + véhicule (P / couple) · Versus pour comparer. Manage : Importer
        / + Mes cycles / Renommer / Supprimer.
      </p>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[720px] border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 bg-slate-50 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              {COLS.map((c) => (
                <th key={c.key} className="border-b border-slate-200 px-2 py-2">
                  <button
                    type="button"
                    onClick={() => toggleSort(c.key)}
                    className="inline-flex items-center gap-1 hover:text-slate-800"
                  >
                    {c.label}
                    {sortKey === c.key && (
                      <span>{sortDir === "asc" ? "↑" : "↓"}</span>
                    )}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const active = selectedId === r.id;
              return (
                <tr
                  key={r.id}
                  tabIndex={0}
                  aria-selected={active}
                  onClick={() => setSelectedId(r.id)}
                  onDoubleClick={() =>
                    void (r.has_geo
                      ? useAsBase(r)
                      : r.resultAvailable
                        ? openStudy(r)
                        : useAsBase(r))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedId(r.id);
                    }
                  }}
                  className={`cursor-pointer border-b border-slate-100 outline-none transition-colors ${
                    active
                      ? "bg-brand/10 ring-1 ring-inset ring-brand/30"
                      : "hover:bg-slate-50"
                  }`}
                >
                  <td className="px-2 py-2">
                    <div className="flex items-start gap-2">
                      <span
                        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                          active
                            ? "border-brand bg-brand text-white"
                            : "border-slate-300 bg-white"
                        }`}
                        aria-hidden
                      >
                        {active && (
                          <span className="h-1.5 w-1.5 rounded-full bg-white" />
                        )}
                      </span>
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-900">
                          {r.name}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          {CORPUS_FAMILY_LABEL[r.family] ?? r.family}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td
                    className="whitespace-nowrap px-2 py-2 tabular-nums text-slate-600"
                    title={r.createdAt ?? undefined}
                  >
                    {fmtCreatedAt(r.createdAt)}
                  </td>
                  <td className="px-2 py-2">
                    {(() => {
                      const b = typeBadge(r);
                      return (
                        <span
                          className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold ${b.className}`}
                          title={b.title}
                        >
                          {b.label}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-2 py-2">
                    {r.resultAvailable ? (
                      <span
                        className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-800"
                        title="Profil temps / vitesse disponible"
                      >
                        <span aria-hidden>✓</span> Oui
                      </span>
                    ) : (
                      <span className="text-[10px] font-semibold text-slate-400">
                        Non
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 tabular-nums">
                    {fmtKm(r.distance_m)}
                  </td>
                  <td className="px-2 py-2 tabular-nums">
                    {fmtDur(r.duration_s)}
                  </td>
                  <td className="px-2 py-2 tabular-nums">
                    {fmtN(r.v_mean_kmh, 0, " km/h")}
                  </td>
                  <td className="px-2 py-2 tabular-nums">
                    {fmtN(r.v_max_kmh, 0, " km/h")}
                  </td>
                  <td className="px-2 py-2 tabular-nums">
                    {fmtN(r.slope_mean_pct, 1, " %")}
                  </td>
                  <td className="px-2 py-2 tabular-nums">
                    {fmtN(r.slope_min_pct, 1, " %")}
                  </td>
                  <td className="px-2 py-2 tabular-nums">
                    {fmtN(r.slope_max_pct, 1, " %")}
                  </td>
                  <td className="px-2 py-2 tabular-nums">
                    {fmtN(r.z_min_m, 0, " m")}
                  </td>
                  <td className="px-2 py-2 tabular-nums">
                    {fmtN(r.z_max_m, 0, " m")}
                  </td>
                  <td className="px-2 py-2">
                    {r.has_tls == null ? "—" : r.has_tls ? "oui" : "non"}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && !corpusLoading && (
              <tr>
                <td
                  colSpan={14}
                  className="px-4 py-12 text-center text-sm text-slate-400"
                >
                  Aucun cycle. Enregistrez un trajet ou lancez l’API corpus.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ProfileDataDrawer
        open={dataOpen}
        onClose={() => {
          setDataOpen(false);
          setDataCycle(null);
        }}
        cycle={dataCycle}
        hasGeo={dataHasGeo}
      />
    </div>
  );
}
