"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import CycleLibraryTable from "@/components/CycleLibraryTable";
import LibraryStorageBanner from "@/components/LibraryStorageBanner";
import { isApiConfigured } from "@/lib/api";
import { canUseGpsStudio, useDemoOsrmClient } from "@/lib/demoFlags";
import { ensureRouteStudioFitPack } from "@/lib/cycleLibrary";
import { hasStudioSession } from "@/lib/studioSession";

/** Bibliothèque alpine démo (fit pack localStorage). */
const ALPINE_DEMO_CYCLES = [
  {
    id: "rs_avl_grossglockner_prudent",
    label: "Grossglockner",
    hint: "Autriche · descente AVL",
  },
  {
    id: "rs_fit_stelvio_prudent",
    label: "Stelvio",
    hint: "Italie · Passo dello Stelvio",
  },
  {
    id: "rs_fit_iseran_prudent",
    label: "Col de l’Iseran",
    hint: "France · Alpes",
  },
  {
    id: "rs_fit_veleta_prudent",
    label: "Pico Veleta",
    hint: "Espagne · Sierra Nevada",
  },
] as const;

const CycleGenShell = dynamic(() => import("@/components/CycleGenShell"), {
  ssr: false,
  loading: () => (
    <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
      Ouverture du créateur de trajet…
    </div>
  ),
});

const EnergyStudyStudio = dynamic(
  () => import("@/components/energy/EnergyStudyStudio"),
  {
    ssr: false,
    loading: () => (
      <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
        Ouverture de l’étude énergie…
      </div>
    ),
  }
);

export default function StudioHome() {
  const params = useSearchParams();
  const mode = params.get("mode");
  const [mounted, setMounted] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const apiOk = isApiConfigured();
  const gpsOk = canUseGpsStudio();
  const demoClient = useDemoOsrmClient();
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!mounted) return;
    setSessionOpen(hasStudioSession());
  }, [mounted, mode]);
  useEffect(() => {
    if (!mounted || mode) return;
    void ensureRouteStudioFitPack().catch(() => {
      /* pack optionnel sur Pages */
    });
  }, [mounted, mode]);

  if (!mounted) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
        Chargement…
      </div>
    );
  }

  if (mode === "create") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {demoClient && (
          <div
            data-testid="pages-demo-api-banner"
            className="shrink-0 border-b border-sky-200 bg-sky-50 px-3 py-2 text-[12px] leading-snug text-sky-950"
          >
            Démo live : départ / arrivée via Photon + OSRM (pas de HERE/Mapbox).
            Simulation IDM serveur indisponible sans API — le tracé et le
            corridor démo s’affichent sur la carte.
          </div>
        )}
        {!gpsOk && (
          <div
            className="shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-snug text-amber-950"
          >
            Trajet GPS indisponible.{" "}
            <Link href="/" className="font-semibold underline underline-offset-2">
              Accueil
            </Link>
          </div>
        )}
        <CycleGenShell />
      </div>
    );
  }

  if (mode === "energy") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <EnergyStudyStudio />
      </div>
    );
  }

  if (mode === "library") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-slate-50 px-3 py-1.5">
          <Link
            href="/"
            className="text-[11px] font-semibold text-slate-500 hover:text-slate-800"
          >
            ← Accueil
          </Link>
          <span className="text-[11px] text-slate-400">
            Bibliothèque — Mes cycles (navigateur) · Corpus · Import
          </span>
        </div>
        <CycleLibraryTable />
      </div>
    );
  }

  return (
    <div
      data-testid="studio-home"
      className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto bg-slate-50 p-6"
    >
      <div className="w-full max-w-2xl space-y-6 py-8">
        <div>
          <h1
            data-testid="studio-home-title"
            className="text-xl font-bold tracking-tight text-slate-900"
          >
            CycleGen
          </h1>
          <p className="mt-1.5 text-sm text-slate-500">
            Deux portes : un trajet GPS, ou une trace (t, v, pente). Bibliothèque
            et Versus restent dans la barre du haut.
          </p>
        </div>

        <LibraryStorageBanner />

        {demoClient && (
          <div
            data-testid="pages-demo-home-banner"
            className="border border-sky-200 bg-sky-50 px-4 py-3 text-[13px] leading-snug text-sky-950"
          >
            <p className="font-semibold">Démo live — trajet GPS (OSRM)</p>
            <p className="mt-1 text-sky-900/90">
              Choisissez un départ et une arrivée : géocodage Photon + routage
              OSRM public. HERE/Mapbox restent dans le code mais sont désactivés
              ici. La simulation serveur nécessite une API déployée.
            </p>
          </div>
        )}

        {sessionOpen && gpsOk && (
          <Link
            href="/?mode=create"
            className="flex flex-col border-l-4 border-brand bg-white py-4 pl-4 pr-5 shadow-sm transition hover:bg-slate-50"
          >
            <span className="text-sm font-semibold text-brand">
              Reprendre le trajet GPS en cours
            </span>
            <span className="mt-1 text-[13px] leading-snug text-slate-600">
              Corridor, paramètres et profil déjà calculés sont conservés.
            </span>
          </Link>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {gpsOk ? (
            <Link
              href="/?mode=create"
              className="flex flex-col border border-slate-200 bg-white p-5 transition hover:border-slate-400"
            >
              <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                Porte 1{demoClient ? " · démo OSRM" : ""}
              </span>
              <span className="mt-1 text-sm font-semibold text-slate-900">
                Trajet GPS
              </span>
              <span className="mt-2 text-[13px] leading-snug text-slate-500">
                {demoClient
                  ? "Adresses ou clics carte → itinéraire OSRM → corridor démo sur la carte."
                  : "Adresses → corridor → IDM/SUMO → profil, puis export et Versus."}
              </span>
            </Link>
          ) : (
            <div
              className="flex flex-col border border-slate-200 bg-slate-100/80 p-5 opacity-70"
              title="Nécessite NEXT_PUBLIC_API_URL (backend déployé)"
            >
              <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                Porte 1 · indisponible
              </span>
              <span className="mt-1 text-sm font-semibold text-slate-600">
                Trajet GPS
              </span>
              <span className="mt-2 text-[13px] leading-snug text-slate-500">
                Nécessite une API déployée (Render / Railway).
              </span>
            </div>
          )}
          <div className="flex flex-col border border-slate-200 bg-white p-5">
            <Link href="/?mode=energy" className="group flex flex-col">
              <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                Porte 2
              </span>
              <span className="mt-1 text-sm font-semibold text-slate-900 group-hover:text-brand">
                Trace (t, v, pente)
              </span>
              <span className="mt-2 text-[13px] leading-snug text-slate-500">
                Importer un roulage, choisir le véhicule, simuler P et couple.
              </span>
            </Link>
            <div className="mt-4 border-t border-slate-100 pt-3">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                Preset
              </p>
              <Link
                href="/?mode=energy&saved=rs_avl_grossglockner_prudent"
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:border-slate-400 hover:bg-white"
              >
                Grossglockner
              </Link>
            </div>
          </div>
        </div>

        <section
          data-testid="alpine-demo-library"
          className="border border-slate-200 bg-white p-5"
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">
              Bibliothèque alpine
            </h2>
            <Link
              href="/?mode=library"
              className="text-[11px] font-semibold text-slate-500 hover:text-brand"
            >
              Voir toute la bibliothèque →
            </Link>
          </div>
          <p className="mt-1 text-[13px] leading-snug text-slate-500">
            Cycles calibrés Route Studio (traces t, v, pente) — disponibles hors
            ligne, sans HERE.
          </p>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {ALPINE_DEMO_CYCLES.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/?mode=energy&saved=${c.id}`}
                  className="flex flex-col border border-slate-200 bg-slate-50 px-3 py-2.5 transition hover:border-slate-400 hover:bg-white"
                >
                  <span className="text-[13px] font-semibold text-slate-800">
                    {c.label}
                  </span>
                  <span className="mt-0.5 text-[11px] text-slate-500">
                    {c.hint}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
