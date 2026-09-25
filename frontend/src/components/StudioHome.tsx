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
      <div className="w-full max-w-3xl space-y-6 py-8">
        <div>
          <h1
            data-testid="studio-home-title"
            className="text-lg font-bold text-slate-900"
          >
            CycleGen Studio
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Deux flux : créer un cycle depuis un trajet GPS, ou étudier un
            roulage existant (temps, vitesse, pente) avec la réponse véhicule.
          </p>
        </div>

        <LibraryStorageBanner />

        {sessionOpen && (
          <Link
            href="/?mode=create"
            className="flex flex-col rounded-xl border border-brand/40 bg-brand/5 p-5 shadow-sm transition hover:border-brand hover:shadow"
          >
            <span className="text-sm font-semibold text-brand">
              Reprendre le trajet GPS en cours
            </span>
            <span className="mt-2 text-[13px] leading-snug text-slate-600">
              Corridor, paramètres et profil déjà calculés sont conservés.
            </span>
          </Link>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Link
            href="/?mode=create"
            className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-brand hover:shadow"
          >
            <span className="text-[10px] font-bold uppercase tracking-wide text-brand">
              Flux 1
            </span>
            <span className="mt-1 text-sm font-semibold text-slate-900">
              Créer un cycle depuis un trajet GPS
            </span>
            <span className="mt-2 text-[13px] leading-snug text-slate-500">
              Adresses ou coordonnées → corridor → IDM/SUMO → profil, puis
              puissance / couple (masse, F0, F1, F2, rayon) et enregistrement
              dans la bibliothèque.
            </span>
          </Link>
          <Link
            href="/?mode=energy"
            className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-brand hover:shadow"
          >
            <span className="text-[10px] font-bold uppercase tracking-wide text-brand">
              Flux 2
            </span>
            <span className="mt-1 text-sm font-semibold text-slate-900">
              Créer un cycle depuis une trace (t, v, pente)
            </span>
            <span className="mt-2 text-[13px] leading-snug text-slate-500">
              Importer ou choisir un roulage temps / vitesse / pente, sélectionner
              le véhicule, puis simuler P et couple aux roues.
            </span>
          </Link>
        </div>

        <Link
          href="/?mode=energy&corpus=epsim_xspace_grossglockner"
          className="flex flex-col rounded-xl border border-amber-300 bg-amber-50 p-5 shadow-sm transition hover:border-amber-500 hover:shadow"
        >
          <span className="text-[10px] font-bold uppercase tracking-wide text-amber-900">
            Raccourci · Flux 2
          </span>
          <span className="mt-1 text-sm font-semibold text-slate-900">
            Grossglockner EP-SIM Space (XSPACE) — v / pente
          </span>
          <span className="mt-2 text-[13px] leading-snug text-slate-600">
            Ouvre directement la trace EP-SIM avec le véhicule XSPACE (masse,
            F0/F1/F2, r_dyn) pour calculer puissance et couple aux roues.
          </span>
        </Link>

        <div className="flex flex-wrap gap-3 text-[13px]">
          <Link
            href="/?mode=library"
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-semibold text-slate-700 hover:border-brand hover:text-brand"
          >
            Bibliothèque
          </Link>
          <Link
            href="/compare"
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-semibold text-slate-700 hover:border-brand hover:text-brand"
          >
            Versus (comparaison)
          </Link>
        </div>
      </div>
    </div>
  );
}
