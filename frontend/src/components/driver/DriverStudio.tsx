"use client";

/**
 * Studio Conducteur — scénario dédié :
 * 1. Choisir des traces → aperçu + mapping Temps/Vitesse → 2. Identifier → 3. Enregistrer.
 */
import { useRef, useState } from "react";
import Link from "next/link";
import {
  aggregateAndSaveDrivers,
  analyzeTraceDraft,
  analyzeTraceFile,
  asDriverProfile,
  isTabularTrace,
  MAX_TRACE_FILES,
  previewTraceFile,
  saveDriverFromTrace,
  type TraceDraft,
  type TracePending,
} from "@/lib/driverFromTraces";
import {
  clampDriverParamsForApi,
  completePhysics,
  type DriverPhysics,
} from "@/lib/driverPresets";
import { listDrivers, type SavedDriver } from "@/lib/driverLibrary";
import type { DriverProfile } from "@/lib/types";
import DriverLibraryPanel from "@/components/driver/DriverLibraryPanel";
import DriverIdentifyPreview from "@/components/driver/DriverIdentifyPreview";

type Step = 1 | 2 | 3 | "library";

const PROFILES: DriverProfile[] = [
  "Eco",
  "Normal",
  "Agressif",
  "Sportif",
  "Prudent",
  "Dynamique",
];

function fmtCell(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  if (typeof v === "number") {
    return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/\.?0+$/, "");
  }
  return String(v);
}

export default function DriverStudio() {
  const [step, setStep] = useState<Step>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<TraceDraft[]>([]);
  const [draftIdx, setDraftIdx] = useState(0);
  const [pending, setPending] = useState<TracePending[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [name, setName] = useState("");
  const [baseProfile, setBaseProfile] = useState<DriverProfile>("Normal");
  const [physics, setPhysics] = useState<DriverPhysics | null>(null);
  const [aY, setAY] = useState(3.5);
  const [lastSaved, setLastSaved] = useState<SavedDriver | null>(null);
  const [aggMsg, setAggMsg] = useState<string | null>(null);
  const [libRefresh, setLibRefresh] = useState(0);
  const batchGenRef = useRef(0);

  const selected = pending[selectedIdx] ?? null;
  const draft = drafts[draftIdx] ?? null;
  // libRefresh / lastSaved intentionally bust listDrivers() via re-render
  void libRefresh;
  void lastSaved;
  const drivers = listDrivers();

  const resetIdentifyForm = (p: TracePending) => {
    setName(p.fileName.replace(/\.(xls|xlsx|csv|json)$/i, ""));
    setBaseProfile(asDriverProfile(p.result.physics.base_profile));
    setPhysics(
      clampDriverParamsForApi(
        completePhysics({
          ...p.result.physics,
          pedal_tau_s: p.result.physics.pedal_tau_s ?? 0,
          vdes_tau_s: p.result.physics.vdes_tau_s ?? 0,
          descent_hold_gain: p.result.physics.descent_hold_gain ?? 0,
        })
      )
    );
    setAY(p.result.physics.a_y ?? 3.5);
  };

  const onFiles = async (files: FileList | null) => {
    if (!files?.length || busy) return;
    const gen = ++batchGenRef.current;
    const room = MAX_TRACE_FILES - pending.length - drafts.length;
    if (room <= 0) {
      setError(`Liste pleine (max ${MAX_TRACE_FILES})`);
      return;
    }
    const picked = Array.from(files).slice(0, room);
    setBusy(true);
    setError(null);
    setAggMsg(null);
    let nextDrafts = [...drafts];
    let nextPending = [...pending];
    let lastError: string | null = null;

    try {
      for (const file of picked) {
        if (batchGenRef.current !== gen) return;
        try {
          if (isTabularTrace(file.name)) {
            const d = await previewTraceFile(file);
            if (batchGenRef.current !== gen) return;
            nextDrafts = [...nextDrafts, d].slice(0, MAX_TRACE_FILES);
            setDrafts(nextDrafts);
          } else {
            // JSON / series — fingerprint direct
            const item = await analyzeTraceFile(file);
            if (batchGenRef.current !== gen) return;
            nextPending = [...nextPending, item].slice(0, MAX_TRACE_FILES);
            setPending(nextPending);
          }
        } catch (e) {
          lastError = `${file.name}: ${e instanceof Error ? e.message : String(e)}`;
          setError(lastError);
        }
      }

      if (batchGenRef.current !== gen) return;
      if (nextDrafts.length > drafts.length) {
        setDraftIdx(Math.min(drafts.length, nextDrafts.length - 1));
        setStep(1);
      } else if (nextPending.length > pending.length) {
        const idx = Math.min(pending.length, nextPending.length - 1);
        setSelectedIdx(idx);
        resetIdentifyForm(nextPending[idx]);
        setStep(2);
      }
    } finally {
      if (batchGenRef.current === gen) setBusy(false);
    }
  };

  const updateDraft = (patch: Partial<Pick<TraceDraft, "col_t" | "col_v" | "v_unit">>) => {
    if (!draft) return;
    setDrafts((prev) =>
      prev.map((d, i) => (i === draftIdx ? { ...d, ...patch } : d))
    );
  };

  const onConfirmDraft = async () => {
    if (!draft || busy) return;
    if (draft.col_t === draft.col_v) {
      setError("Temps et Vitesse doivent être des colonnes différentes");
      return;
    }
    const gen = ++batchGenRef.current;
    setBusy(true);
    setError(null);
    try {
      const item = await analyzeTraceDraft(draft);
      if (batchGenRef.current !== gen) return;
      const nextPending = [...pending, item].slice(0, MAX_TRACE_FILES);
      const nextDrafts = drafts.filter((_, i) => i !== draftIdx);
      setPending(nextPending);
      setDrafts(nextDrafts);
      setDraftIdx(0);
      setSelectedIdx(nextPending.length - 1);
      resetIdentifyForm(item);
      setStep(2);
    } catch (e) {
      if (batchGenRef.current === gen) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (batchGenRef.current === gen) setBusy(false);
    }
  };

  const onConfirmAllDrafts = async () => {
    if (!drafts.length || busy) return;
    const gen = ++batchGenRef.current;
    setBusy(true);
    setError(null);
    let nextPending = [...pending];
    let lastError: string | null = null;
    try {
      for (const d of drafts) {
        if (batchGenRef.current !== gen) return;
        if (d.col_t === d.col_v) {
          lastError = `${d.file.name}: Temps et Vitesse identiques`;
          continue;
        }
        try {
          const item = await analyzeTraceDraft(d);
          if (batchGenRef.current !== gen) return;
          nextPending = [...nextPending, item].slice(0, MAX_TRACE_FILES);
          setPending(nextPending);
        } catch (e) {
          lastError = `${d.file.name}: ${e instanceof Error ? e.message : String(e)}`;
          setError(lastError);
        }
      }
      if (batchGenRef.current !== gen) return;
      setDrafts([]);
      setDraftIdx(0);
      if (lastError) setError(lastError);
      if (nextPending.length > pending.length) {
        const idx = nextPending.length - 1;
        setSelectedIdx(idx);
        resetIdentifyForm(nextPending[idx]);
        setStep(2);
      }
    } finally {
      if (batchGenRef.current === gen) setBusy(false);
    }
  };

  const selectTrace = (i: number) => {
    setSelectedIdx(i);
    const p = pending[i];
    if (p) resetIdentifyForm(p);
    setStep(2);
  };

  const patchPhysics = <K extends keyof DriverPhysics>(
    key: K,
    value: DriverPhysics[K]
  ) => {
    setPhysics((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const onSave = () => {
    if (!selected || !physics) return;
    const final = saveDriverFromTrace(selected, {
      name,
      baseProfile,
      physics,
      a_y: aY,
    });
    setLastSaved(final);
    setLibRefresh((n) => n + 1);
    setStep(3);
  };

  const onAggregate = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await aggregateAndSaveDrivers(pending);
      setAggMsg(`${saved.length} conducteur(s) fusionné(s)`);
      if (saved[0]) setLastSaved(saved[0]);
      setLibRefresh((n) => n + 1);
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clearAll = () => {
    batchGenRef.current += 1;
    setBusy(false);
    setDrafts([]);
    setDraftIdx(0);
    setPending([]);
    setSelectedIdx(0);
    setPhysics(null);
    setLastSaved(null);
    setAggMsg(null);
    setError(null);
    setStep(1);
  };

  const stepClass = (n: 1 | 2 | 3) =>
    `flex items-center gap-2 rounded-md px-3 py-2 text-[12px] font-semibold ${
      step === n
        ? "bg-slate-900 text-white"
        : typeof step === "number" && step > n
          ? "bg-slate-200 text-slate-800"
          : "bg-slate-100 text-slate-400"
    }`;

  const libTabClass =
    step === "library"
      ? "bg-teal-800 text-white"
      : "bg-slate-100 text-slate-600 hover:bg-slate-200";

  return (
    <div
      data-testid="driver-studio"
      className="flex min-h-0 flex-1 flex-col bg-slate-50"
    >
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[16px] font-semibold text-slate-900">
              Conducteur depuis traces
            </h1>
            <p className="mt-0.5 text-[12px] text-slate-500">
              Aperçu → identifier → enregistrer · bibliothèque & comparaison
            </p>
          </div>
          <Link
            href={
              lastSaved
                ? `/?mode=create&driverId=${encodeURIComponent(lastSaved.id)}`
                : "/?mode=create"
            }
            className="text-[12px] font-semibold text-brand hover:underline"
          >
            Ouvrir Créer (trajet GPS) →
          </Link>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={stepClass(1)} onClick={() => setStep(1)}>
            1 · Traces
          </button>
          <button
            type="button"
            className={stepClass(2)}
            disabled={!pending.length}
            onClick={() => pending.length && setStep(2)}
          >
            2 · Identifier
          </button>
          <button
            type="button"
            className={stepClass(3)}
            disabled={!lastSaved}
            onClick={() => lastSaved && setStep(3)}
          >
            3 · Enregistré
          </button>
          <button
            type="button"
            data-testid="driver-studio-library-tab"
            className={`flex items-center gap-2 rounded-md px-3 py-2 text-[12px] font-semibold ${libTabClass}`}
            onClick={() => {
              setLibRefresh((n) => n + 1);
              setStep("library");
            }}
          >
            Bibliothèque ({drivers.length})
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div
          className={`mx-auto w-full space-y-4 ${
            step === 2 ? "max-w-6xl" : "max-w-4xl"
          }`}
        >
          {error ? (
            <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
              {error}
            </p>
          ) : null}

          {step === 1 ? (
            <section data-testid="driver-studio-step-traces" className="space-y-3">
              <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-white px-6 py-10 hover:border-brand">
                <span className="text-[14px] font-semibold text-slate-800">
                  {busy ? "Lecture en cours…" : "Déposer ou choisir des traces"}
                </span>
                <span className="mt-2 font-mono text-[11px] text-slate-400">
                  CSV · XLS · XLSX · JSON · max {MAX_TRACE_FILES}
                </span>
                <input
                  data-testid="driver-studio-file-input"
                  type="file"
                  accept=".csv,.xls,.xlsx,.json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/json"
                  multiple
                  className="hidden"
                  disabled={busy}
                  onChange={(e) => void onFiles(e.target.files)}
                />
              </label>

              {draft ? (
                <div
                  data-testid="driver-studio-preview"
                  className="space-y-3 rounded-lg border border-slate-200 bg-white p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        Aperçu · mapping colonnes
                      </div>
                      <div className="mt-1 truncate text-[13px] font-semibold text-slate-900">
                        {draft.file.name}
                      </div>
                      <div className="mt-0.5 font-mono text-[11px] text-slate-500">
                        {draft.preview.n_data_rows} lignes données
                        {draft.preview.units
                          ? ` · unités : ${draft.preview.units.join(" · ")}`
                          : ""}
                      </div>
                    </div>
                    {drafts.length > 1 ? (
                      <select
                        value={draftIdx}
                        onChange={(e) => setDraftIdx(Number(e.target.value))}
                        className="rounded border border-slate-300 px-2 py-1 text-[12px]"
                      >
                        {drafts.map((d, i) => (
                          <option key={i} value={i}>
                            {d.file.name}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </div>

                  <div className="grid gap-2 sm:grid-cols-3">
                    <label className="block text-[12px] text-slate-600">
                      Temps
                      <select
                        data-testid="driver-studio-col-t"
                        value={draft.col_t}
                        onChange={(e) =>
                          updateDraft({ col_t: Number(e.target.value) })
                        }
                        className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-[12px]"
                      >
                        {draft.preview.headers.map((h, i) => (
                          <option key={i} value={i}>
                            [{i}] {h || `col_${i}`}
                            {draft.preview.units?.[i]
                              ? ` (${draft.preview.units[i]})`
                              : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-[12px] text-slate-600">
                      Vitesse
                      <select
                        data-testid="driver-studio-col-v"
                        value={draft.col_v}
                        onChange={(e) =>
                          updateDraft({ col_v: Number(e.target.value) })
                        }
                        className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-[12px]"
                      >
                        {draft.preview.headers.map((h, i) => (
                          <option key={i} value={i}>
                            [{i}] {h || `col_${i}`}
                            {draft.preview.units?.[i]
                              ? ` (${draft.preview.units[i]})`
                              : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-[12px] text-slate-600">
                      Unité vitesse
                      <select
                        data-testid="driver-studio-v-unit"
                        value={draft.v_unit}
                        onChange={(e) =>
                          updateDraft({
                            v_unit: e.target.value as "mps" | "kmh",
                          })
                        }
                        className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-[12px]"
                      >
                        <option value="kmh">km/h (kph)</option>
                        <option value="mps">m/s</option>
                      </select>
                    </label>
                  </div>

                  <div className="overflow-x-auto rounded border border-slate-100">
                    <table className="min-w-full border-collapse font-mono text-[11px]">
                      <thead>
                        <tr className="bg-slate-50 text-left text-slate-500">
                          {draft.preview.headers.map((h, i) => (
                            <th
                              key={i}
                              className={`whitespace-nowrap border-b border-slate-200 px-2 py-1.5 font-semibold ${
                                i === draft.col_t
                                  ? "bg-sky-50 text-sky-800"
                                  : i === draft.col_v
                                    ? "bg-amber-50 text-amber-800"
                                    : ""
                              }`}
                            >
                              {h || `col_${i}`}
                              {i === draft.col_t ? " · t" : ""}
                              {i === draft.col_v ? " · v" : ""}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {draft.preview.preview_rows.map((row, ri) => (
                          <tr key={ri} className="border-b border-slate-50">
                            {draft.preview.headers.map((_, ci) => (
                              <td
                                key={ci}
                                className={`whitespace-nowrap px-2 py-1 tabular-nums text-slate-700 ${
                                  ci === draft.col_t
                                    ? "bg-sky-50/60"
                                    : ci === draft.col_v
                                      ? "bg-amber-50/60"
                                      : ""
                                }`}
                              >
                                {fmtCell(row[ci])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      data-testid="driver-studio-confirm-mapping"
                      disabled={busy}
                      onClick={() => void onConfirmDraft()}
                      className="rounded bg-slate-900 px-4 py-2 text-[12px] font-semibold text-white enabled:hover:bg-slate-800 disabled:opacity-40"
                    >
                      {busy ? "Analyse…" : "Analyser avec ce mapping"}
                    </button>
                    {drafts.length > 1 ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onConfirmAllDrafts()}
                        className="rounded border border-slate-300 bg-white px-4 py-2 text-[12px] font-medium text-slate-700 enabled:hover:bg-slate-50 disabled:opacity-40"
                      >
                        Analyser les {drafts.length} fichiers
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {pending.length > 0 ? (
                <ul className="space-y-2">
                  {pending.map((p, i) => (
                    <li key={`${p.fileName}-${i}`}>
                      <button
                        type="button"
                        onClick={() => selectTrace(i)}
                        className="w-full rounded border border-slate-200 bg-white px-3 py-2 text-left hover:border-slate-400"
                      >
                        <div className="truncate text-[13px] font-semibold text-slate-800">
                          {p.fileName}
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] tabular-nums text-slate-500">
                          a+={p.result.physics.a_max} · b=
                          {p.result.physics.b_comf} · sf=
                          {p.result.physics.speed_factor} · τ=
                          {p.result.physics.pedal_tau_s ?? 0}
                          {p.mapping
                            ? ` · t[${p.mapping.col_t}] v[${p.mapping.col_v}] ${p.mapping.v_unit}`
                            : ""}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          {step === 2 && selected && physics ? (
            <section
              data-testid="driver-studio-step-identify"
              className="overflow-hidden rounded-lg border border-slate-200 bg-white"
            >
              <div className="grid min-h-[28rem] grid-cols-1 lg:grid-cols-[minmax(280px,380px)_minmax(0,1fr)]">
                {/* Gauche — paramètres conducteur */}
                <div className="space-y-3 border-b border-slate-200 p-4 lg:border-b-0 lg:border-r lg:overflow-y-auto lg:max-h-[min(80vh,720px)]">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      Trace sélectionnée
                    </div>
                    <div className="mt-1 truncate text-[13px] font-semibold text-slate-900">
                      {selected.fileName}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-slate-500">
                      {selected.result.n_points} pts · v̄=
                      {(
                        selected.result.fingerprint.v_mean_mps * 3.6
                      ).toFixed(1)}{" "}
                      km/h
                    </div>
                  </div>

                  {pending.length > 1 ? (
                    <label className="block text-[12px] text-slate-600">
                      Changer de trace
                      <select
                        value={selectedIdx}
                        onChange={(e) => selectTrace(Number(e.target.value))}
                        className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-[12px]"
                      >
                        {pending.map((p, i) => (
                          <option key={i} value={i}>
                            {p.fileName}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}

                  <label className="block text-[12px] text-slate-600">
                    Nom du conducteur
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-[13px] text-slate-900"
                    />
                  </label>

                  <label className="block text-[12px] text-slate-600">
                    Profil de base
                    <select
                      value={baseProfile}
                      onChange={(e) =>
                        setBaseProfile(e.target.value as DriverProfile)
                      }
                      className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-[12px]"
                    >
                      {PROFILES.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="space-y-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      Physique IDM
                    </p>
                    <div className="grid grid-cols-1 gap-2">
                      {(
                        [
                          ["a_max", "a_max", 0.5, 12, 0.05],
                          ["b_comf", "b_comf", 0.5, 12, 0.05],
                          ["speed_factor", "sf", 0.7, 1.35, 0.01],
                          ["T", "T", 0.4, 4, 0.05],
                          ["T_h", "T_h", 1, 10, 0.1],
                          ["s0", "s₀", 0.5, 6, 0.1],
                          ["jerk_max", "jerk+", 0, 8, 0.05],
                          ["jerk_brake_max", "jerk−", 0, 10, 0.05],
                        ] as const
                      ).map(([key, label, min, max, step]) => {
                        const raw = Number(physics[key]);
                        const val = Number.isFinite(raw)
                          ? Math.min(max, Math.max(min, raw))
                          : min;
                        return (
                          <label key={key} className="block space-y-0.5">
                            <div className="flex justify-between text-[11px] text-slate-500">
                              <span>{label}</span>
                              <span className="font-mono tabular-nums text-slate-800">
                                {val.toFixed(step < 0.1 ? 2 : 1)}
                              </span>
                            </div>
                            <input
                              type="range"
                              min={min}
                              max={max}
                              step={step}
                              value={val}
                              onChange={(e) =>
                                patchPhysics(key, Number(e.target.value))
                              }
                              className="w-full accent-slate-800"
                            />
                          </label>
                        );
                      })}
                    </div>

                    <p className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-teal-800">
                      Filtres 1er ordre & retention
                    </p>
                    <div className="grid grid-cols-1 gap-2">
                      {(
                        [
                          ["pedal_tau_s", "pedal_τ (s)", 0, 10, 0.1],
                          ["vdes_tau_s", "vdes_τ (s)", 0, 10, 0.1],
                          ["descent_hold_gain", "hold", 0, 10, 0.1],
                        ] as const
                      ).map(([key, label, min, max, step]) => {
                        const raw = Number(physics[key] ?? 0);
                        const val = Number.isFinite(raw)
                          ? Math.min(max, Math.max(min, raw))
                          : min;
                        return (
                          <label
                            key={key}
                            className="block space-y-0.5 rounded border border-teal-100 bg-teal-50/50 px-2 py-1.5"
                          >
                            <div className="flex justify-between text-[11px] text-teal-900">
                              <span className="font-semibold">{label}</span>
                              <span className="font-mono tabular-nums">
                                {val.toFixed(1)}
                              </span>
                            </div>
                            <input
                              type="range"
                              min={min}
                              max={max}
                              step={step}
                              value={val}
                              onChange={(e) =>
                                patchPhysics(key, Number(e.target.value))
                              }
                              className="w-full accent-teal-700"
                            />
                          </label>
                        );
                      })}
                      <label className="block space-y-0.5">
                        <div className="flex justify-between text-[11px] text-slate-500">
                          <span>a_y</span>
                          <span className="font-mono tabular-nums text-slate-800">
                            {aY.toFixed(2)}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0.5}
                          max={8}
                          step={0.05}
                          value={aY}
                          onChange={(e) => setAY(Number(e.target.value))}
                          className="w-full accent-slate-800"
                        />
                      </label>
                    </div>
                    <p className="text-[9px] leading-snug text-slate-400">
                      Bougez τ / hold : la courbe à droite se met à jour.
                      Molette = zoom · double-clic = reset.
                    </p>
                  </div>

                  <button
                    type="button"
                    data-testid="driver-studio-save"
                    onClick={onSave}
                    className="w-full rounded bg-slate-900 py-2.5 text-[13px] font-semibold text-white hover:bg-slate-800"
                  >
                    Enregistrer le conducteur
                  </button>

                  {pending.length >= 2 ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void onAggregate()}
                      className="w-full rounded border border-slate-300 bg-slate-50 py-2 text-[12px] font-medium text-slate-700 enabled:hover:bg-white disabled:opacity-40"
                    >
                      Fusionner toutes les traces (Prudent / Dynamique / PreA)
                    </button>
                  ) : null}

                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="w-full text-[12px] text-slate-400 hover:text-slate-700"
                  >
                    ← Retour aux traces
                  </button>
                </div>

                {/* Droite — cycle / aperçu */}
                <div className="flex min-h-[20rem] flex-col bg-slate-50/60 p-4 lg:min-h-0">
                  {selected.result.source_profile?.time?.length ? (
                    <div className="flex min-h-0 flex-1 flex-col">
                      <DriverIdentifyPreview
                        key={`${selected.fileName}-${selectedIdx}`}
                        time={selected.result.source_profile.time}
                        velocity_mps={
                          selected.result.source_profile.velocity_mps
                        }
                        physics={physics}
                        sourceLabel={selected.fileName.replace(/\.[^.]+$/, "")}
                        tall
                      />
                    </div>
                  ) : (
                    <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                      Pas de série source dans cette trace (ancien fingerprint).
                      Rechargez le fichier pour activer l’aperçu réactif.
                    </p>
                  )}
                </div>
              </div>
            </section>
          ) : null}

          {step === 3 && lastSaved ? (
            <section
              data-testid="driver-studio-step-saved"
              className="space-y-4 rounded-lg border border-emerald-200 bg-white p-4"
            >
              <div className="text-[14px] font-semibold text-emerald-800">
                Conducteur enregistré
              </div>
              <div className="text-[13px] text-slate-800">{lastSaved.name}</div>
              <div className="font-mono text-[11px] text-slate-500">
                {lastSaved.id} · a_max={lastSaved.physics.a_max} · base=
                {lastSaved.baseProfile}
              </div>
              {lastSaved.sourceProfile?.filename ? (
                <p className="text-[12px] text-slate-600">
                  Profil source :{" "}
                  <strong className="text-slate-900">
                    {lastSaved.sourceProfile.filename}
                  </strong>
                  {lastSaved.sourceProfile.n_raw
                    ? ` · ${lastSaved.sourceProfile.n_raw} pts`
                    : ""}
                  {lastSaved.sourceProfile.time.length
                    ? ` · ${lastSaved.sourceProfile.time.length} pts stockés`
                    : ""}
                </p>
              ) : null}
              {aggMsg ? (
                <p className="text-[12px] text-emerald-700">{aggMsg}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Link
                  href={`/?mode=create&driverId=${encodeURIComponent(lastSaved.id)}`}
                  className="rounded bg-slate-900 px-4 py-2 text-[12px] font-semibold text-white"
                >
                  Utiliser dans Créer (trajet GPS)
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    setLibRefresh((n) => n + 1);
                    setStep("library");
                  }}
                  className="rounded border border-teal-700 bg-teal-50 px-4 py-2 text-[12px] font-semibold text-teal-900"
                >
                  Voir bibliothèque / comparer
                </button>
                <button
                  type="button"
                  onClick={clearAll}
                  className="rounded border border-slate-300 bg-white px-4 py-2 text-[12px] font-medium text-slate-700"
                >
                  Nouvelle identification
                </button>
              </div>
              <p className="text-[11px] text-slate-400">
                Banque locale : {drivers.length} conducteur(s)
              </p>
            </section>
          ) : null}

          {step === "library" ? (
            <DriverLibraryPanel refreshKey={libRefresh} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
