"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ResultsAnalysisPanel from "@/components/export/ResultsAnalysisPanel";
import {
  getBenchmarkSource,
  listBenchmarkSources,
} from "@/lib/api";
import {
  getSavedCycle,
  listSavedCycles,
  packCycle,
  peekEnergyOpen,
  profileFromEnergyCycle,
  saveCycle,
  slimCycleForStudioTransfer,
  stashCyclesForCompare,
  takeEnergyOpen,
  type SavedCycle,
} from "@/lib/cycleLibrary";
import { computeCycleStats, enrichSeriesFromGps } from "@/lib/cycleMetrics";
import { DEFAULT_A_Y } from "@/lib/driverPresets";
import { parseCycleBlob } from "@/lib/parseCycleFile";
import type { BenchmarkSourceMeta, ConsolidatedProfile } from "@/lib/types";
import type { SlopeUnit } from "@/lib/units";
import { getVehicle, type VehicleCard } from "@/lib/vehicleLibrary";

function defaultVehicleForCorpus(corpusId: string | null | undefined): string {
  if (
    corpusId &&
    (corpusId.includes("epsim") || corpusId.includes("xspace"))
  ) {
    return "renault-xspace-apr2bis";
  }
  return "renault-cspace-leapfrog-apr2bis";
}

async function cycleFromCorpus(
  meta: Pick<BenchmarkSourceMeta, "id" | "name" | "source" | "family" | "url">,
  vehicleId?: string | null
): Promise<SavedCycle> {
  const series = await getBenchmarkSource(meta.id);
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
  const vid =
    vehicleId ||
    defaultVehicleForCorpus(meta.id);
  return packCycle(
    {
      name: meta.name,
      source: meta.source || meta.family || "corpus",
      sourceUrl: meta.url,
      origin: "corpus",
      corpusId: meta.id,
      stats,
      time: series.time,
      velocity: series.velocity,
      acceleration: enriched.acceleration,
      slope: enriched.slope,
      a_lat: enriched.a_lat,
      position: enriched.position,
      geometry: [],
      meta: { vehicleId: vid, trafficSource: "profil_import" },
    },
    { maxPoints: 2500, slimCorridor: true }
  );
}

export default function EnergyStudyStudio() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fileRef = useRef<HTMLInputElement>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [cycle, setCycle] = useState<SavedCycle | null>(null);
  const [profile, setProfile] = useState<ConsolidatedProfile | null>(null);
  const [vehicleId, setVehicleId] = useState("renault-xspace-apr2bis");
  const [slopeUnit, setSlopeUnit] = useState<SlopeUnit>("percent");
  const [corpusList, setCorpusList] = useState<BenchmarkSourceMeta[]>([]);
  const [savedList, setSavedList] = useState<SavedCycle[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const applyCycle = useCallback((c: SavedCycle, preferVehicle?: string | null) => {
    const slim = slimCycleForStudioTransfer(c, 2500);
    const p = profileFromEnergyCycle(slim);
    if (!p) {
      setError("Profil illisible (temps / vitesse manquants).");
      return;
    }
    const vid =
      preferVehicle ||
      slim.meta?.vehicleId ||
      defaultVehicleForCorpus(slim.corpusId);
    setCycle(slim);
    setProfile(p as ConsolidatedProfile);
    setVehicleId(vid);
    setError("");
    setPickerOpen(false);
  }, []);

  const refreshPickers = useCallback(() => {
    setSavedList(listSavedCycles());
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const sources = await listBenchmarkSources();
        if (!cancelled) {
          const list = Array.isArray(sources) ? sources : [];
          setCorpusList(
            list.filter((s) => !s.has_geo && (s.n_points ?? 0) > 1)
          );
        }
      } catch {
        /* corpus optional for saved/import */
      }
      refreshPickers();

      const corpusQ = searchParams.get("corpus");
      const savedQ = searchParams.get("saved");
      const stashed = peekEnergyOpen();

      try {
        if (corpusQ) {
          const sources = await listBenchmarkSources().catch(() => [] as BenchmarkSourceMeta[]);
          const list = Array.isArray(sources) ? sources : [];
          const hit = list.find((s) => s.id === corpusQ);
          if (!hit) throw new Error(`Corpus inconnu : ${corpusQ}`);
          const c = await cycleFromCorpus(hit);
          if (!cancelled) {
            applyCycle(c);
            takeEnergyOpen();
          }
        } else if (savedQ) {
          const c = getSavedCycle(savedQ);
          if (!c) throw new Error("Cycle introuvable dans la bibliothèque");
          if (!cancelled) {
            applyCycle(c);
            takeEnergyOpen();
          }
        } else if (stashed?.kind === "corpus") {
          const sources = await listBenchmarkSources().catch(() => [] as BenchmarkSourceMeta[]);
          const list = Array.isArray(sources) ? sources : [];
          const hit = list.find((s) => s.id === stashed.corpusId);
          if (!hit) throw new Error(`Corpus inconnu : ${stashed.corpusId}`);
          const c = await cycleFromCorpus(hit, stashed.vehicleId);
          if (!cancelled) {
            applyCycle(c, stashed.vehicleId);
            takeEnergyOpen();
          }
        } else if (stashed?.kind === "saved") {
          const c = getSavedCycle(stashed.cycleId);
          if (!c) throw new Error("Cycle introuvable dans la bibliothèque");
          if (!cancelled) {
            applyCycle(c, stashed.vehicleId);
            takeEnergyOpen();
          }
        } else {
          if (!cancelled) setPickerOpen(true);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Chargement échoué");
          setPickerOpen(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount / query
  }, []);

  const vehicle = useMemo(
    () => (vehicleId ? getVehicle(vehicleId) : null),
    [vehicleId]
  );

  const handleImport = async (file: File) => {
    setError("");
    setInfo("");
    setLoading(true);
    try {
      const parsed = await parseCycleBlob(file);
      const enriched = enrichSeriesFromGps({
        time: parsed.time,
        velocity: parsed.velocity,
        acceleration: parsed.acceleration,
        slope: parsed.slope,
        position: parsed.position,
        lat: parsed.lat,
        lon: parsed.lon,
      });
      if ((enriched.geometry?.length ?? 0) >= 2) {
        setInfo(
          "Ce fichier a des GPS — pour un cycle dynamique, utilisez Flux 1. Ici on garde t / v / pente pour l’énergie."
        );
      }
      const stats = computeCycleStats({
        time: parsed.time,
        velocity: parsed.velocity,
        acceleration: enriched.acceleration,
        slope: enriched.slope,
        position: enriched.position,
        a_lat: enriched.a_lat,
      });
      const saved = saveCycle({
        name: file.name.replace(/\.[^.]+$/, "") || "Import roulage",
        source: "import",
        origin: "import",
        stats,
        time: parsed.time,
        velocity: parsed.velocity,
        acceleration: enriched.acceleration,
        slope: enriched.slope,
        a_lat: enriched.a_lat,
        position: enriched.position,
        geometry: [],
        meta: {
          vehicleId,
          trafficSource: "profil_import",
          saveTitle: file.name,
        },
      });
      refreshPickers();
      applyCycle(saved);
      setInfo(`« ${saved.name} » enregistré dans Mes cycles.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import échoué");
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleVersus = () => {
    if (!cycle) return;
    stashCyclesForCompare([cycle]);
    router.push("/compare");
  };

  if (loading && !profile) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
        Chargement du profil…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-slate-50">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-1.5">
        <Link
          href="/"
          className="text-[11px] font-semibold text-slate-500 hover:text-slate-800"
        >
          ← Accueil
        </Link>
        <span className="truncate text-[12px] font-semibold text-slate-800">
          {cycle?.name ?? "Trace t / v / pente"}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {!profile && (
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                setLoading(true);
                setError("");
                void cycleFromCorpus({
                  id: "epsim_xspace_grossglockner",
                  name: "Grossglockner — descente alpine (v/pente)",
                  source: "oem",
                  family: "oem",
                  url: null,
                })
                  .then((c) => applyCycle(c, "renault-xspace-apr2bis"))
                  .catch((e) =>
                    setError(
                      e instanceof Error
                        ? e.message
                        : "Impossible de charger Grossglockner"
                    )
                  )
                  .finally(() => setLoading(false));
              }}
              className="rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-950 hover:border-amber-500 disabled:opacity-50"
              title="Trace Grossglockner + véhicule de référence"
            >
              Grossglockner
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              refreshPickers();
              setPickerOpen((v) => !v);
            }}
            className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-700 hover:bg-slate-50"
          >
            {pickerOpen ? "Masquer" : "Trace…"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt,.xml,.gpx"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleImport(f);
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-700 hover:bg-slate-50"
          >
            Import…
          </button>
          <Link
            href="/?mode=library"
            className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-700 hover:bg-slate-50"
          >
            Biblio
          </Link>
        </div>
      </div>

      {(error || info) && (
        <div className="shrink-0 space-y-1 border-b border-slate-100 px-3 py-2">
          {error && (
            <p className="text-[12px] text-red-700" role="alert">
              {error}
            </p>
          )}
          {info && (
            <p className="text-[12px] text-slate-600" role="status">
              {info}
            </p>
          )}
        </div>
      )}

      {pickerOpen && (
        <div className="shrink-0 max-h-56 overflow-y-auto border-b border-slate-200 bg-white px-3 py-2">
          <p className="mb-2 text-[11px] font-semibold text-slate-700">
            Traces corpus (temps / vitesse / pente)
          </p>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {corpusList.map((s) => {
              const featured = s.id === "epsim_xspace_grossglockner";
              return (
              <button
                key={s.id}
                type="button"
                disabled={loading}
                onClick={() => {
                  setLoading(true);
                  void cycleFromCorpus(s)
                    .then((c) =>
                      applyCycle(
                        c,
                        featured ? "renault-xspace-apr2bis" : undefined
                      )
                    )
                    .catch((e) =>
                      setError(
                        e instanceof Error ? e.message : "Chargement corpus"
                      )
                    )
                    .finally(() => setLoading(false));
                }}
                className={`rounded-md border px-2 py-1 text-[10px] font-medium disabled:opacity-50 ${
                  featured
                    ? "border-amber-400 bg-amber-50 font-semibold text-amber-950 hover:border-amber-600"
                    : "border-slate-200 text-slate-700 hover:border-brand hover:text-brand"
                }`}
              >
                {featured ? "★ " : ""}
                {s.name}
              </button>
            );
            })}
            {!corpusList.length && (
              <span className="text-[11px] text-slate-400">
                Aucun corpus sans GPS (API indisponible ?)
              </span>
            )}
          </div>
          <p className="mb-2 text-[11px] font-semibold text-slate-700">
            Mes cycles (sans GPS)
          </p>
          <div className="flex flex-wrap gap-1.5">
            {savedList
              .filter((c) => (c.geometry?.length ?? 0) < 2)
              .map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => applyCycle(c)}
                  className="rounded-md border border-slate-200 px-2 py-1 text-[10px] font-medium text-slate-700 hover:border-brand hover:text-brand"
                >
                  {c.name}
                </button>
              ))}
            {!savedList.filter((c) => (c.geometry?.length ?? 0) < 2).length && (
              <span className="text-[11px] text-slate-400">
                Aucun cycle énergie enregistré — importez un CSV.
              </span>
            )}
          </div>
        </div>
      )}

      {profile && profile.time.length > 1 ? (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <ResultsAnalysisPanel
            profile={profile}
            corridor={null}
            vehicle={vehicle}
            aY={DEFAULT_A_Y}
            slopeUnit={slopeUnit}
            onSlopeUnitChange={setSlopeUnit}
            syncEnabled={false}
            trafficSource="profil_import"
            warnings={profile.warnings ?? []}
            driverProfile="Normal"
            routeLabel={cycle?.name ?? "Roulage"}
            studyName={cycle?.name ?? cycle?.meta?.saveTitle ?? "Roulage"}
            onVersus={handleVersus}
            noGps
            vehicleId={vehicleId}
            onVehicleSelect={(v: VehicleCard) => {
              setVehicleId(v.id);
              if (cycle) {
                setCycle({
                  ...cycle,
                  meta: { ...cycle.meta, vehicleId: v.id },
                });
              }
            }}
            distanceM={cycle?.stats.distance_m ?? null}
            durationS={cycle?.stats.duration_s ?? null}
            onCycleSaved={(name) => setInfo(`Enregistré : « ${name} »`)}
            libraryOrigin={
              cycle?.origin === "corpus"
                ? "corpus"
                : cycle?.origin === "cyclegen"
                  ? "cyclegen"
                  : "import"
            }
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="max-w-md text-sm text-slate-600">
            Créez un cycle à partir d’une trace <strong>temps / vitesse /
            pente</strong>, choisissez le véhicule, puis simulez puissance et
            couple aux roues.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                setLoading(true);
                void cycleFromCorpus({
                  id: "epsim_xspace_grossglockner",
                  name: "Grossglockner — descente alpine (v/pente)",
                  source: "oem",
                  family: "oem",
                  url: null,
                })
                  .then((c) => applyCycle(c, "renault-xspace-apr2bis"))
                  .catch((e) =>
                    setError(
                      e instanceof Error ? e.message : "Chargement EP-SIM"
                    )
                  )
                  .finally(() => setLoading(false));
              }}
              className="rounded-md border border-amber-400 bg-amber-50 px-3 py-1.5 text-[12px] font-semibold text-amber-950 hover:border-amber-600 disabled:opacity-50"
            >
              Ouvrir Grossglockner
            </button>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="rounded-md bg-brand px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-brand-dark"
            >
              Choisir une autre trace
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
