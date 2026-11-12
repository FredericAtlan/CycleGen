"use client";

/** Thin drawer kept for IDE deep-link; prefer /?mode=driver Studio. */
import { useRef, useState } from "react";
import Link from "next/link";
import {
  aggregateAndSaveDrivers,
  analyzeTraceFile,
  MAX_TRACE_FILES,
  saveDriverFromTrace,
  type TracePending,
} from "@/lib/driverFromTraces";
import { useWorkspaceStore } from "@/lib/workspaceStore";

type Props = {
  open: boolean;
  onClose: () => void;
};

export default function DriverFingerprintDrawer({ open, onClose }: Props) {
  const pushConsole = useWorkspaceStore((s) => s.pushConsole);
  const selectAsset = useWorkspaceStore((s) => s.selectAsset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<TracePending[]>([]);
  const [aggMsg, setAggMsg] = useState<string | null>(null);
  const batchGenRef = useRef(0);

  if (!open) return null;

  const clearPending = () => {
    batchGenRef.current += 1;
    setPending([]);
    setError(null);
    setAggMsg(null);
  };

  const onFiles = async (files: FileList | null) => {
    if (!files?.length || busy) return;
    const gen = batchGenRef.current;
    const room = MAX_TRACE_FILES - pending.length;
    if (room <= 0) {
      setError(`Liste pleine (max ${MAX_TRACE_FILES})`);
      return;
    }
    const picked = Array.from(files).slice(0, room);
    setBusy(true);
    setError(null);
    setAggMsg(null);
    let next: TracePending[] = [...pending];
    for (const file of picked) {
      if (batchGenRef.current !== gen) break;
      try {
        const item = await analyzeTraceFile(file);
        if (batchGenRef.current !== gen) break;
        next = [...next, item].slice(0, MAX_TRACE_FILES);
        setPending(next);
        pushConsole(
          `traces · ${file.name} · a+=${item.result.physics.a_max}`
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`${file.name}: ${msg}`);
        pushConsole(`traces · ${file.name} · ERROR · ${msg}`);
      }
    }
    setBusy(false);
  };

  const saveOne = (p: TracePending) => {
    const saved = saveDriverFromTrace(p);
    selectAsset("driver", saved.id);
    pushConsole(`conducteur · créé depuis traces → ${saved.name}`);
  };

  const runAggregate = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await aggregateAndSaveDrivers(pending);
      for (const d of saved) {
        selectAsset("driver", d.id);
        pushConsole(`aggregate · → ${d.name}`);
      }
      setAggMsg(`${saved.length} conducteur(s) agrégé(s) sauvés`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/30"
      data-testid="driver-fingerprint-drawer"
      onClick={onClose}
    >
      <aside
        className="flex h-full w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2.5">
          <div>
            <div className="text-[13px] font-semibold text-slate-900">
              Importer des traces
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">
              Préférez le studio Conducteur pour le parcours guidé
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[12px] text-slate-500 hover:text-slate-900"
          >
            Fermer
          </button>
        </div>

        <div className="space-y-3 overflow-y-auto p-3">
          <Link
            href="/?mode=driver"
            className="block rounded border border-brand/30 bg-brand/5 px-3 py-2 text-center text-[12px] font-semibold text-brand hover:bg-brand/10"
          >
            Ouvrir le studio Conducteur (recommandé)
          </Link>
          <label className="flex cursor-pointer flex-col items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50 px-4 py-8 hover:border-brand">
            <span className="text-[12px] font-semibold text-slate-800">
              {busy ? "Analyse en cours…" : "Déposer ou choisir des fichiers"}
            </span>
            <input
              type="file"
              accept=".csv,.xls,.xlsx,.json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/json"
              multiple
              className="hidden"
              disabled={busy}
              onChange={(e) => void onFiles(e.target.files)}
            />
          </label>
          {error ? (
            <p className="font-mono text-[10px] text-red-600">{error}</p>
          ) : null}
          {aggMsg ? (
            <p className="font-mono text-[10px] text-emerald-700">{aggMsg}</p>
          ) : null}
          <ul className="space-y-2">
            {pending.map((p, i) => (
              <li
                key={`${p.fileName}-${i}`}
                className="rounded border border-slate-200 bg-white p-2"
              >
                <div className="truncate text-[11px] font-semibold text-slate-800">
                  {p.fileName}
                </div>
                <div className="mt-1 font-mono text-[9px] tabular-nums text-slate-500">
                  a+={p.result.physics.a_max} · b={p.result.physics.b_comf}
                </div>
                <button
                  type="button"
                  onClick={() => saveOne(p)}
                  className="mt-2 rounded bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-white"
                >
                  Créer conducteur
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-auto space-y-2 border-t border-slate-200 p-3">
          <button
            type="button"
            disabled={busy || pending.length < 2}
            onClick={() => void runAggregate()}
            className="w-full rounded border border-slate-300 bg-slate-50 px-2 py-2 text-[12px] font-semibold text-slate-800 enabled:hover:bg-white disabled:opacity-40"
          >
            Fusionner en Prudent / Dynamique / PreA
          </button>
          <button
            type="button"
            data-testid="driver-fp-clear-list"
            disabled={busy}
            onClick={clearPending}
            className="w-full text-[11px] text-slate-400 enabled:hover:text-slate-700 disabled:opacity-40"
          >
            Vider la liste
          </button>
        </div>
      </aside>
    </div>
  );
}
