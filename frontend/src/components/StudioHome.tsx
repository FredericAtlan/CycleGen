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
            href="/?mode=create"
            className="flex flex-col border border-slate-200 bg-white p-5 transition hover:border-slate-400"
          >
            <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
              Porte 1
            </span>
            <span className="mt-1 text-sm font-semibold text-slate-900">
              Trajet GPS
            </span>
            <span className="mt-2 text-[13px] leading-snug text-slate-500">
              Adresses → corridor → IDM/SUMO → profil, puis export et Versus.
            </span>
          </Link>
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
                href="/?mode=energy&corpus=epsim_xspace_grossglockner"
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:border-slate-400 hover:bg-white"
              >
                Grossglockner
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
