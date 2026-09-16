"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  DEFAULT_A_Y,
  DEFAULT_DRIVER_PROFILE,
  DEFAULT_MAX_SPEED_KMH,
  DRIVER_UI_DOCS,
  UI_DRIVER_PRESETS,
  defaultDriverPhysics,
  matchUiPreset,
  physicsEqual,
  uiPresetById,
  type DriverPhysics,
} from "@/lib/driverPresets";
import {
  DEFAULT_DRIVER_ID,
  deleteDriver,
  driverLabel,
  getDriver,
  listDrivers,
  saveDriver,
  type SavedDriver,
} from "@/lib/driverLibrary";
import {
  identifyDriverFromProfile,
  type DriverMatch,
  type InferredDriverParams,
} from "@/lib/driverIdentify";
import { parseCycleBlob } from "@/lib/parseCycleFile";
import { DRIVER_PARAM_DOCS } from "@/lib/paramDocs";
import type { DriverProfile } from "@/lib/types";
import InfoTip from "@/components/InfoTip";

export type SimParamsPanelProps = {
  driverProfile: DriverProfile;
  onDriverProfileChange: (value: DriverProfile) => void;
  physics: DriverPhysics;
  onPhysicsChange: (value: DriverPhysics) => void;
  maxSpeedKmh: number | null;
  onMaxSpeedKmhChange: (value: number | null) => void;
  aY: number;
  onAYChange: (value: number) => void;
  /** Selected entry in the driver library (null = anonymous / custom). */
  driverId?: string | null;
  onDriverIdChange?: (id: string | null) => void;
  disabled?: boolean;
  /** Hint that params changed and Appliquer is needed. */
  pendingApplyHint?: boolean;
  /** Before → after lines when params are dirty. */
  pendingDiffLines?: string[];
  /** Hide outer card chrome when wrapped in AccordionSection. */
  embedded?: boolean;
};

function SliderField({
  label,
  unit,
  value,
  step,
  min,
  max,
  disabled,
  onChange,
  doc,
  format = (n: number) => n.toFixed(step < 0.1 ? 2 : 1),
}: {
  label: ReactNode;
  unit: string;
  value: number;
  step: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (n: number) => void;
  doc?: { title: string; body: string };
  format?: (n: number) => string;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-1 text-[11px] font-medium text-slate-600">
        <span className="inline-flex items-center gap-1">
          {label}
          {doc && (
            <InfoTip title={doc.title}>
              <pre className="whitespace-pre-wrap font-sans text-[11px] text-slate-700">
                {doc.body}
              </pre>
            </InfoTip>
          )}
        </span>
        <span className="font-mono text-[11px] font-bold tabular-nums text-slate-800">
          {format(value)} {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : min}
        disabled={disabled}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        className="w-full accent-brand disabled:opacity-50"
      />
    </div>
  );
}

export default function SimParamsPanel({
  driverProfile,
  onDriverProfileChange,
  physics,
  onPhysicsChange,
  maxSpeedKmh,
  onMaxSpeedKmhChange,
  aY,
  onAYChange,
  driverId = null,
  onDriverIdChange,
  disabled = false,
  pendingApplyHint = false,
  pendingDiffLines = [],
  embedded = false,
}: SimParamsPanelProps) {
  const [library, setLibrary] = useState<SavedDriver[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [identifyBusy, setIdentifyBusy] = useState(false);
  const [identifyErr, setIdentifyErr] = useState<string | null>(null);
  const [identifyFile, setIdentifyFile] = useState<string | null>(null);
  const [inferred, setInferred] = useState<InferredDriverParams | null>(null);
  const [matches, setMatches] = useState<DriverMatch[]>([]);
  const identifyInputRef = useRef<HTMLInputElement | null>(null);

  const refreshLibrary = () => setLibrary(listDrivers());
  useEffect(() => {
    refreshLibrary();
  }, []);

  const matched = matchUiPreset(physics, aY);
  const defaults = defaultDriverPhysics();
  const isDefault =
    driverProfile === DEFAULT_DRIVER_PROFILE &&
    physicsEqual(physics, defaults) &&
    aY === DEFAULT_A_Y &&
    maxSpeedKmh === DEFAULT_MAX_SPEED_KMH;
  const isCustom = matched == null;
  const vmax = maxSpeedKmh ?? DEFAULT_MAX_SPEED_KMH;
  const selectedLib = driverId ? getDriver(driverId) : null;

  const patchPhysics = (patch: Partial<DriverPhysics>) => {
    onPhysicsChange({ ...physics, ...patch });
    onDriverIdChange?.(null);
  };

  const applyUiPreset = (presetId: string) => {
    if (presetId === "custom") return;
    const p = uiPresetById(presetId);
    if (!p) return;
    onDriverProfileChange(p.id);
    onPhysicsChange({ ...p.physics });
    onAYChange(p.a_y);
    const seedId =
      p.presetId === "avl" ? "seed-bcb" : `seed-${p.presetId}`;
    onDriverIdChange?.(seedId);
  };

  const applyLibraryDriver = (id: string) => {
    const d = library.find((x) => x.id === id) ?? getDriver(id);
    if (!d) return;
    onDriverIdChange?.(d.id);
    onDriverProfileChange(d.baseProfile);
    onPhysicsChange({ ...d.physics });
    if (d.a_y != null && Number.isFinite(d.a_y)) onAYChange(d.a_y);
  };

  const resetToDefaults = () => {
    onDriverProfileChange(DEFAULT_DRIVER_PROFILE);
    onPhysicsChange(defaultDriverPhysics());
    onAYChange(DEFAULT_A_Y);
    onMaxSpeedKmhChange(DEFAULT_MAX_SPEED_KMH);
    onDriverIdChange?.(DEFAULT_DRIVER_ID);
  };

  const handleSaveToLibrary = () => {
    const name = saveName.trim();
    if (!name) return;
    const saved = saveDriver({
      name,
      baseProfile: driverProfile,
      physics: { ...physics },
      a_y: aY,
      notes: isCustom ? "Paramètres personnalisés" : undefined,
    });
    refreshLibrary();
    onDriverIdChange?.(saved.id);
    setSaveOpen(false);
    setSaveName("");
  };

  const handleDelete = () => {
    if (!driverId || selectedLib?.seed) return;
    if (!window.confirm(`Supprimer le conducteur « ${selectedLib?.name} » ?`))
      return;
    deleteDriver(driverId);
    refreshLibrary();
    onDriverIdChange?.(DEFAULT_DRIVER_ID);
    const d = getDriver(DEFAULT_DRIVER_ID);
    if (d) {
      onDriverProfileChange(d.baseProfile);
      onPhysicsChange({ ...d.physics });
    }
  };

  const handleIdentifyFile = async (file: File | null) => {
    if (!file) return;
    setIdentifyBusy(true);
    setIdentifyErr(null);
    setIdentifyFile(file.name);
    try {
      const parsed = await parseCycleBlob(file);
      const { inferred: inf, matches: m } = identifyDriverFromProfile(
        parsed.time,
        parsed.velocity
      );
      setInferred(inf);
      setMatches(m.slice(0, 5));
      refreshLibrary();
    } catch (e) {
      setInferred(null);
      setMatches([]);
      setIdentifyErr(e instanceof Error ? e.message : "Échec d’analyse");
    } finally {
      setIdentifyBusy(false);
      if (identifyInputRef.current) identifyInputRef.current.value = "";
    }
  };

  const applyInferred = () => {
    if (!inferred) return;
    onDriverProfileChange(inferred.baseProfile);
    onPhysicsChange({ ...inferred.physics });
    onDriverIdChange?.(null);
  };

  const applyMatch = (m: DriverMatch) => {
    applyLibraryDriver(m.driver.id);
  };

  const saveInferredAsDriver = () => {
    if (!inferred) return;
    const name =
      saveName.trim() ||
      `Identifié · ${identifyFile?.replace(/\.[^.]+$/, "") || inferred.baseProfile}`;
    const saved = saveDriver({
      name,
      baseProfile: inferred.baseProfile,
      physics: { ...inferred.physics },
      a_y: aY,
      notes: identifyFile
        ? `Identifié depuis ${identifyFile}`
        : "Identifié depuis profil v(t)",
    });
    refreshLibrary();
    onDriverIdChange?.(saved.id);
    onDriverProfileChange(saved.baseProfile);
    onPhysicsChange({ ...saved.physics });
    setSaveName("");
  };

  return (
    <section
      className={
        embedded
          ? "space-y-3"
          : "space-y-3 rounded-lg border border-slate-200 bg-slate-50/80 p-3"
      }
    >
      <div className="flex items-center justify-between gap-2">
        {!embedded ? (
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Conducteur
          </h2>
        ) : (
          <span className="text-[11px] text-slate-500">Bibliothèque & physique</span>
        )}
        <div className="flex items-center gap-1">
          {isCustom && (
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
              Custom
            </span>
          )}
          <button
            type="button"
            disabled={disabled || isDefault}
            title="Remettre Eco/Normal/Agressif/Sport + a_y + Vmax aux valeurs par défaut (Normal)"
            onClick={resetToDefaults}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Par défaut
          </button>
        </div>
      </div>

      {onDriverIdChange && (
        <div className="space-y-1.5 rounded-md border border-slate-200 bg-white p-2">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Bibliothèque
          </label>
          <select
            value={driverId ?? ""}
            disabled={disabled}
            onChange={(e) => {
              const id = e.target.value;
              if (id) applyLibraryDriver(id);
            }}
            className="w-full rounded border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-slate-900 outline-none focus:border-brand disabled:opacity-60"
          >
            <option value="">— paramètres libres —</option>
            {library.map((d) => (
              <option key={d.id} value={d.id}>
                {driverLabel(d)}
                {d.seed ? "" : ` · a=${d.physics.a_max}`}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                setSaveName(
                  selectedLib && !selectedLib.seed
                    ? selectedLib.name
                    : `${driverProfile} custom`
                );
                setSaveOpen((o) => !o);
              }}
              className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-semibold text-slate-700 hover:bg-white disabled:opacity-40"
            >
              Sauver sous…
            </button>
            {selectedLib && !selectedLib.seed && (
              <button
                type="button"
                disabled={disabled}
                onClick={handleDelete}
                className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[10px] font-semibold text-red-700 hover:bg-red-100 disabled:opacity-40"
              >
                Supprimer
              </button>
            )}
          </div>
          {saveOpen && (
            <div className="flex gap-1 pt-0.5">
              <input
                type="text"
                value={saveName}
                disabled={disabled}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="Nom du conducteur"
                className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1 text-[11px] outline-none focus:border-brand"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveToLibrary();
                }}
              />
              <button
                type="button"
                disabled={disabled || !saveName.trim()}
                onClick={handleSaveToLibrary}
                className="rounded-md bg-brand px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40"
              >
                OK
              </button>
            </div>
          )}
        </div>
      )}

      {onDriverIdChange && (
        <div className="space-y-1.5 rounded-md border border-dashed border-slate-300 bg-slate-50/80 p-2">
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Identifier depuis un profil
            </label>
            <InfoTip mark="?" title="Données attendues">
              <p className="mb-1.5 text-slate-600">
                Table temps / vitesse (XLS, CSV, TSV) — virgule ou point
                décimal. Échantillonnage typique 0,1&nbsp;s.
              </p>
              <p className="mb-1.5 rounded border border-amber-200 bg-amber-50/80 px-2 py-1 text-[10px] font-semibold text-amber-900">
                Vitesse utilisée = Vitesse realized (kph) — jamais la consigne
                sp.
              </p>
              <table className="w-full border-collapse text-[10px] tabular-nums">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="py-0.5 pr-1 font-semibold">Temps (s)</th>
                    <th className="py-0.5 pr-1 font-normal text-slate-400">
                      Vitesse sp (kph)
                    </th>
                    <th className="py-0.5 pr-1 font-semibold text-amber-800">
                      Vitesse realized (kph)
                    </th>
                    <th className="py-0.5 font-normal text-slate-400">
                      Pente (%)
                    </th>
                  </tr>
                </thead>
                <tbody className="text-slate-700">
                  <tr>
                    <td className="py-0.5 pr-1">0</td>
                    <td className="py-0.5 pr-1 text-slate-400">0</td>
                    <td className="py-0.5 pr-1 font-semibold text-slate-900">
                      0
                    </td>
                    <td className="py-0.5 text-slate-400">−6</td>
                  </tr>
                  <tr>
                    <td className="py-0.5 pr-1">1</td>
                    <td className="py-0.5 pr-1 text-slate-400">0,48</td>
                    <td className="py-0.5 pr-1 font-semibold text-slate-900">
                      0,099
                    </td>
                    <td className="py-0.5 text-slate-400">−6</td>
                  </tr>
                  <tr>
                    <td className="py-0.5 pr-1">1,1</td>
                    <td className="py-0.5 pr-1 text-slate-400">0,96</td>
                    <td className="py-0.5 pr-1 font-semibold text-slate-900">
                      0,405
                    </td>
                    <td className="py-0.5 text-slate-400">−6</td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-1.5 text-[10px] leading-snug text-slate-500">
                Colonnes minimales :{" "}
                <code className="text-[9px]">Temps</code> +{" "}
                <code className="text-[9px]">Vitesse realized</code>. Sp et
                pente optionnelles (ignorées pour l’ID).
              </p>
            </InfoTip>
          </div>
          <p className="text-[10px] leading-snug text-slate-500">
            Upload XLS / CSV — fingerprint sur la{" "}
            <span className="font-semibold text-slate-700">
              vitesse réalisée
            </span>
            , puis estimation physique et ranking bibliothèque.
          </p>
          <input
            ref={identifyInputRef}
            type="file"
            accept=".xlsx,.xls,.csv,.tsv,.txt,.xml"
            disabled={disabled || identifyBusy}
            className="block w-full text-[10px] text-slate-600 file:mr-2 file:rounded file:border-0 file:bg-white file:px-2 file:py-1 file:text-[10px] file:font-semibold file:text-slate-700"
            onChange={(e) => {
              void handleIdentifyFile(e.target.files?.[0] ?? null);
            }}
          />
          {identifyBusy && (
            <p className="text-[10px] text-slate-500">Analyse en cours…</p>
          )}
          {identifyErr && (
            <p className="text-[10px] font-medium text-red-600">{identifyErr}</p>
          )}
          {inferred && (
            <div className="space-y-1.5 rounded border border-slate-200 bg-white p-1.5">
              <p className="text-[10px] text-slate-600">
                Estimé · base{" "}
                <strong className="text-slate-900">{inferred.baseProfile}</strong>
                {" · "}
                a={inferred.physics.a_max} · b={inferred.physics.b_comf} · sf=
                {inferred.physics.speed_factor}
                {identifyFile ? (
                  <span className="text-slate-400"> · {identifyFile}</span>
                ) : null}
              </p>
              <p className="text-[10px] tabular-nums text-slate-500">
                v̄ {(inferred.fingerprint.v_mean_mps * 3.6).toFixed(0)} km/h ·
                p95 a+ {inferred.fingerprint.p95_accel.toFixed(2)} · p95 a−{" "}
                {inferred.fingerprint.p95_decel.toFixed(2)} · RPA{" "}
                {inferred.fingerprint.rpa.toFixed(2)}
              </p>
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={applyInferred}
                  className="rounded-md bg-brand px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40"
                >
                  Appliquer l’estimé
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={saveInferredAsDriver}
                  className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-semibold text-slate-700 hover:bg-white disabled:opacity-40"
                >
                  Sauver comme conducteur
                </button>
              </div>
              {matches.length > 0 && (
                <ul className="mt-1 space-y-1 border-t border-slate-100 pt-1">
                  <li className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                    Plus proches (bibliothèque)
                  </li>
                  {matches.map((m) => (
                    <li
                      key={m.driver.id}
                      className="flex items-center justify-between gap-2 text-[10px]"
                    >
                      <span className="min-w-0 truncate text-slate-700">
                        <strong className="tabular-nums text-slate-900">
                          {m.score}%
                        </strong>{" "}
                        {driverLabel(m.driver)}
                      </span>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => applyMatch(m)}
                        className="shrink-0 rounded border border-slate-200 px-1.5 py-0.5 font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                      >
                        Appliquer
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-slate-700" htmlFor="driver-preset">
          Preset conducteur
        </label>
        <select
          id="driver-preset"
          disabled={disabled}
          value={matched?.presetId ?? "custom"}
          onChange={(e) => applyUiPreset(e.target.value)}
          className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-800 shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand disabled:opacity-50"
        >
          {UI_DRIVER_PRESETS.map((p) => (
            <option key={p.presetId} value={p.presetId}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom</option>
        </select>
        <p className="text-[11px] leading-snug text-slate-500">
          {matched?.blurb ??
            "Réglages personnalisés — curseurs éditables ci-dessous."}
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            1 · Dynamique longitudinale
          </p>
          <SliderField
            label="a_max"
            unit="m/s²"
            value={physics.a_max}
            step={0.01}
            min={0.5}
            max={6}
            disabled={disabled}
            doc={DRIVER_UI_DOCS.a_max}
            format={(n) => n.toFixed(2)}
            onChange={(a_max) => patchPhysics({ a_max })}
          />
          <SliderField
            label="b_comf"
            unit="m/s²"
            value={physics.b_comf}
            step={0.01}
            min={0.5}
            max={6}
            disabled={disabled}
            doc={DRIVER_UI_DOCS.b_comf}
            format={(n) => n.toFixed(2)}
            onChange={(b_comf) => patchPhysics({ b_comf })}
          />
          <SliderField
            label="Jerk+"
            unit="m/s³"
            value={physics.jerk_max}
            step={0.01}
            min={0}
            max={8}
            disabled={disabled}
            doc={DRIVER_UI_DOCS.jerk_max}
            format={(n) => n.toFixed(2)}
            onChange={(jerk_max) => patchPhysics({ jerk_max })}
          />
          <SliderField
            label="Jerk−"
            unit="m/s³"
            value={physics.jerk_brake_max}
            step={0.01}
            min={0}
            max={8}
            disabled={disabled}
            doc={DRIVER_UI_DOCS.jerk_brake_max}
            format={(n) => n.toFixed(2)}
            onChange={(jerk_brake_max) => patchPhysics({ jerk_brake_max })}
          />
        </div>

        <div className="space-y-2.5 border-t border-slate-100 pt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            2 · Anticipation spatio-temporelle
          </p>
          <SliderField
            label="T (headway)"
            unit="s"
            value={physics.T}
            step={0.1}
            min={0.4}
            max={3.5}
            disabled={disabled}
            doc={DRIVER_UI_DOCS.T}
            format={(n) => n.toFixed(1)}
            onChange={(T) => patchPhysics({ T })}
          />
          <SliderField
            label="T_h (horizon)"
            unit="s"
            value={physics.T_h}
            step={0.1}
            min={1}
            max={8}
            disabled={disabled}
            doc={DRIVER_UI_DOCS.T_h}
            format={(n) => n.toFixed(1)}
            onChange={(T_h) => patchPhysics({ T_h })}
          />
          <SliderField
            label="s₀"
            unit="m"
            value={physics.s0}
            step={0.1}
            min={0.5}
            max={6}
            disabled={disabled}
            doc={DRIVER_UI_DOCS.s0}
            format={(n) => n.toFixed(1)}
            onChange={(s0) => patchPhysics({ s0 })}
          />
        </div>

        <div className="space-y-2.5 border-t border-slate-100 pt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            3 · Agressivité & trajectoire
          </p>
          <SliderField
            label="Speed factor"
            unit="×"
            value={physics.speed_factor}
            step={0.01}
            min={0.7}
            max={1.3}
            disabled={disabled}
            doc={DRIVER_UI_DOCS.speed_factor}
            format={(n) => n.toFixed(2)}
            onChange={(speed_factor) => patchPhysics({ speed_factor })}
          />
          <SliderField
            label={
              <span>
                a<sub>y</sub> latéral
              </span>
            }
            unit="m/s²"
            value={aY}
            step={0.1}
            min={0.5}
            max={8}
            disabled={disabled}
            doc={DRIVER_UI_DOCS.a_y}
            onChange={(v) => {
              onAYChange(v);
              onDriverIdChange?.(null);
            }}
          />
        </div>
      </div>

      {isCustom && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => applyUiPreset("avl")}
          className="text-[11px] font-medium text-brand hover:underline disabled:opacity-50"
        >
          Reset → Standard AVL
        </button>
      )}

      <div className="space-y-1.5 border-t border-slate-200 pt-3">
        <SliderField
          label={
            <span className="inline-flex items-center gap-1">
              Vmax véhicule
              <InfoTip title={DRIVER_PARAM_DOCS.max_speed.title}>
                <pre className="whitespace-pre-wrap font-sans text-[11px] text-slate-700">
                  {DRIVER_PARAM_DOCS.max_speed.body}
                </pre>
              </InfoTip>
            </span>
          }
          unit="km/h"
          value={vmax}
          step={5}
          min={20}
          max={250}
          disabled={disabled}
          format={(n) => String(Math.round(n))}
          onChange={(n) => onMaxSpeedKmhChange(n)}
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] leading-snug text-slate-400">
            Cap après enveloppe × speed factor.
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onMaxSpeedKmhChange(null)}
            className={`shrink-0 rounded-md px-2 py-1 text-[10px] font-semibold ${
              maxSpeedKmh == null
                ? "bg-slate-900 text-white"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            } disabled:opacity-50`}
          >
            Aucun
          </button>
        </div>
      </div>

      {pendingApplyHint && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] leading-snug text-amber-950">
          <p className="font-semibold">
            Modifié depuis le dernier cycle — cliquez{" "}
            <span className="underline">Appliquer</span> pour régénérer.
          </p>
          {pendingDiffLines.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 border-t border-amber-200/80 pt-1.5 font-normal text-amber-900">
              {pendingDiffLines.map((line, i) => (
                <li key={`${i}-${line}`} className="tabular-nums">
                  · {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
