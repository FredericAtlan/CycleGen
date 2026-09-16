"use client";

import { useEffect, useRef, useState } from "react";
import {
  alternateOriginUrl,
  countSavedCyclesInStorage,
  currentOriginLabel,
  migrateLegacyLibraries,
} from "@/lib/localStorageMigrate";
import {
  exportSavedCyclesJson,
  importSavedCyclesJson,
} from "@/lib/cycleLibrary";

type Props = {
  /** Called after a successful import so parent can refresh lists. */
  onImported?: () => void;
};

/**
 * Explains empty library (localhost vs 127.0.0.1) + export/import backup.
 */
export default function LibraryStorageBanner({ onImported }: Props) {
  const [empty, setEmpty] = useState(false);
  const [alt, setAlt] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    migrateLegacyLibraries();
    setEmpty(countSavedCyclesInStorage() === 0);
    setAlt(alternateOriginUrl());
    setHost(currentOriginLabel());
  }, []);

  const handleExport = () => {
    const json = exportSavedCyclesJson();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cyclegen-cycles-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setMsg("Export téléchargé.");
  };

  const handleImportFile = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      const { imported, total } = importSavedCyclesJson(text);
      setEmpty(countSavedCyclesInStorage() === 0);
      setMsg(`${imported} cycle(s) importé(s) — bibliothèque : ${total}.`);
      onImported?.();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Import impossible.");
    }
  };

  if (!empty) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] text-slate-600">
        <span className="text-slate-400">Stockage : {host}</span>
        <button
          type="button"
          onClick={handleExport}
          className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 font-semibold text-slate-700 hover:bg-slate-100"
        >
          Exporter mes cycles
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 font-semibold text-slate-700 hover:bg-slate-100"
        >
          Importer JSON
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => void handleImportFile(e.target.files?.[0] ?? null)}
        />
        {msg ? <span className="text-emerald-700">{msg}</span> : null}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-950">
      <p className="font-semibold">Bibliothèque locale vide sur {host || "…"}</p>
      <p className="leading-snug text-amber-900/90">
        Les cycles sont enregistrés dans le navigateur (localStorage),{" "}
        <strong>séparé par adresse</strong> :{" "}
        <code className="rounded bg-white/80 px-1">localhost</code> et{" "}
        <code className="rounded bg-white/80 px-1">127.0.0.1</code> ne
        partagent pas la même base.
      </p>
      {alt ? (
        <p className="leading-snug">
          Réessayez l’autre URL :{" "}
          <a
            href={alt}
            className="font-semibold text-brand underline hover:no-underline"
          >
            {alt}
          </a>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="rounded-md bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-slate-800"
        >
          Importer une sauvegarde JSON
        </button>
        <button
          type="button"
          onClick={handleExport}
          className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-950 hover:bg-amber-100/50"
        >
          Exporter (si des cycles réapparaissent)
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => void handleImportFile(e.target.files?.[0] ?? null)}
        />
      </div>
      {msg ? <p className="text-[11px] font-medium text-emerald-800">{msg}</p> : null}
    </div>
  );
}
