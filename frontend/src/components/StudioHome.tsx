"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import CycleLibraryTable from "@/components/CycleLibraryTable";
import LibraryStorageBanner from "@/components/LibraryStorageBanner";
import { hasStudioSession } from "@/lib/studioSession";

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

const DriverStudio = dynamic(
  () => import("@/components/driver/DriverStudio"),
  {
    ssr: false,
    loading: () => (
      <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
        Ouverture du studio Conducteur…
      </div>
    ),
  }
);

export default function StudioHome() {
  const params = useSearchParams();
  const mode = params.get("mode");
  const [mounted, setMounted] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!mounted) return;
    setSessionOpen(hasStudioSession());
  }, [mounted, mode]);

  // Legacy bookmark: banc d'essai retiré → Créer (fenêtres historiques)
  useEffect(() => {
    if (!mounted || mode !== "ide") return;
    const url = new URL(window.location.href);
    url.searchParams.set("mode", "create");
    window.history.replaceState({}, "", url.toString());
  }, [mounted, mode]);

  if (!mounted) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
        Chargement…
      </div>
    );
  }

  if (mode === "create" || mode === "ide") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
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

  if (mode === "driver") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <DriverStudio />
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
            Trajet GPS, étude énergie, bibliothèque — ou Conducteur depuis
            traces (hors définition GPS).
          </p>
        </div>

        <LibraryStorageBanner />

        {sessionOpen && (
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
          <Link
            href="/?mode=driver"
            className="flex flex-col border border-slate-200 bg-white p-5 transition hover:border-slate-400"
            data-testid="studio-home-driver"
          >
            <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
              Scénario
            </span>
            <span className="mt-1 text-sm font-semibold text-slate-900">
              Conducteur depuis traces
            </span>
            <span className="mt-2 text-[13px] leading-snug text-slate-500">
              Choisir un fichier → identifier → enregistrer le conducteur.
            </span>
          </Link>
          <Link
            href="/?mode=create"
            className="flex flex-col border border-slate-200 bg-white p-5 transition hover:border-slate-400"
          >
            <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
              Scénario
            </span>
            <span className="mt-1 text-sm font-semibold text-slate-900">
              Trajet GPS
            </span>
            <span className="mt-2 text-[13px] leading-snug text-slate-500">
              Adresses → corridor → simulation → export.
            </span>
          </Link>
          <Link
            href="/?mode=energy"
            className="flex flex-col border border-slate-200 bg-white p-5 transition hover:border-slate-400"
          >
            <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
              Scénario
            </span>
            <span className="mt-1 text-sm font-semibold text-slate-900">
              Trace énergie (t, v, pente)
            </span>
            <span className="mt-2 text-[13px] leading-snug text-slate-500">
              Importer un roulage et simuler puissance / couple.
            </span>
          </Link>
          <Link
            href="/?mode=library"
            className="flex flex-col border border-slate-200 bg-white p-5 transition hover:border-slate-400"
          >
            <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
              Bibliothèque
            </span>
            <span className="mt-1 text-sm font-semibold text-slate-900">
              Cycles enregistrés
            </span>
            <span className="mt-2 text-[13px] leading-snug text-slate-500">
              Revoir, exporter ou comparer des cycles déjà générés.
            </span>
          </Link>
        </div>
      </div>
    </div>
  );
}
