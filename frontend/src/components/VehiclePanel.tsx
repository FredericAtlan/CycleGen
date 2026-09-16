"use client";

import { useEffect, useState } from "react";
import {
  MASS_CODE_LABEL,
  deleteVehicle,
  listVehicles,
  saveVehicle,
  type MassCode,
  type VehicleCard,
  type VehiclePowertrain,
} from "@/lib/vehicleLibrary";

type VehiclePanelProps = {
  selectedId: string | null;
  onSelect: (v: VehicleCard) => void;
  disabled?: boolean;
  /** Hide outer title when wrapped in AccordionSection. */
  embedded?: boolean;
  /** Single-line select for energy results (minimal chrome). */
  compact?: boolean;
};

const EMPTY: Omit<VehicleCard, "id"> = {
  code: "",
  name: "",
  massCode: "TM",
  mass_kg: 1500,
  f0_n: 90,
  f1_n_per_kph: 0.5,
  f2_n_per_kph2: 0.03,
  r_dyn_m: 0.31,
  tau_brake_max_nm: null,
  v_max_kmh: 180,
  power_kw: null,
  powertrain: "unknown",
};

export default function VehiclePanel({
  selectedId,
  onSelect,
  disabled,
  embedded = false,
  compact = false,
}: VehiclePanelProps) {
  const [list, setList] = useState<VehicleCard[]>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(EMPTY);

  const refresh = () => setList(listVehicles());

  useEffect(() => {
    refresh();
  }, []);

  const selected = list.find((v) => v.id === selectedId) ?? null;

  const handleSave = () => {
    if (!draft.code.trim() || !draft.name.trim()) return;
    const saved = saveVehicle({ ...draft, code: draft.code.trim(), name: draft.name.trim() });
    refresh();
    onSelect(saved);
    setEditing(false);
  };

  if (compact) {
    const tip = selected
      ? `${selected.name} · ${selected.massCode} ${selected.mass_kg} kg · F0=${selected.f0_n} · F1=${selected.f1_n_per_kph} · F2=${selected.f2_n_per_kph2} · r_dyn=${selected.r_dyn_m} m`
      : "Choisir le véhicule (masse, F0/F1/F2, r_dyn) pour P / couple";
    return (
      <div className="flex min-w-0 items-center gap-1.5" title={tip}>
        <label className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          Véhicule
        </label>
        <select
          value={selectedId ?? ""}
          disabled={disabled}
          onChange={(e) => {
            const v = list.find((x) => x.id === e.target.value);
            if (v) onSelect(v);
          }}
          className="min-w-0 max-w-[14rem] flex-1 truncate rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-900 outline-none focus:border-brand disabled:opacity-60"
        >
          <option value="">—</option>
          {list.map((v) => (
            <option key={v.id} value={v.id}>
              {v.code} · {v.name}
            </option>
          ))}
        </select>
        {selected && (
          <span className="hidden min-w-0 truncate text-[10px] tabular-nums text-slate-400 sm:inline">
            {Math.round(selected.mass_kg)} kg · r={selected.r_dyn_m.toFixed(3)} m
          </span>
        )}
      </div>
    );
  }

  return (
    <section className="space-y-2">
      {!embedded && (
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Véhicule
        </h2>
      )}
      <p className="text-[10px] leading-snug text-slate-400">
        Masse + F0/F1/F2 (road load) pour la puissance mécanique traction / freinage aux roues
        en analyse live et résultats. Vmax plafonne aussi la vitesse du cycle.
      </p>
      <select
        value={selectedId ?? ""}
        disabled={disabled}
        onChange={(e) => {
          const v = list.find((x) => x.id === e.target.value);
          if (v) onSelect(v);
        }}
        className="w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-900 outline-none focus:border-brand disabled:opacity-60"
      >
        <option value="">— Choisir —</option>
        {list.map((v) => (
          <option key={v.id} value={v.id}>
            {v.code} · {v.name}
          </option>
        ))}
      </select>

      {selected && (
        <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 rounded-md bg-slate-50 px-2 py-1.5 text-[10px] text-slate-600">
          <div>
            Masse{" "}
            <span className="font-semibold text-slate-800">
              {selected.mass_kg} kg
            </span>
          </div>
          <div className="truncate" title={MASS_CODE_LABEL[selected.massCode]}>
            {selected.massCode}
          </div>
          <div className="col-span-2 tabular-nums">
            F0 {selected.f0_n} N · F1 {selected.f1_n_per_kph} N/(km/h) · F2{" "}
            {selected.f2_n_per_kph2} N/(km/h)²
          </div>
          <div>
            r_dyn{" "}
            <span className="font-semibold text-slate-800">
              {selected.r_dyn_m.toFixed(3)} m
            </span>
          </div>
          <div>
            τ_brake max{" "}
            <span className="font-semibold text-slate-800">
              {selected.tau_brake_max_nm != null
                ? `${Math.round(selected.tau_brake_max_nm)} N·m`
                : "—"}
            </span>
          </div>
          <div>
            Vmax{" "}
            <span className="font-semibold text-slate-800">
              {selected.v_max_kmh != null ? `${selected.v_max_kmh} km/h` : "—"}
            </span>
          </div>
          {selected.power_kw != null && (
            <div>
              P{" "}
              <span className="font-semibold text-slate-800">
                {selected.power_kw} kW
              </span>
            </div>
          )}
          {selected.battery_kwh != null && (
            <div>
              Batterie{" "}
              <span className="font-semibold text-slate-800">
                {selected.battery_kwh} kWh
              </span>
            </div>
          )}
          {selected.tyre && (
            <div className="col-span-2 truncate" title={selected.tyre}>
              Pneu{" "}
              <span className="font-semibold text-slate-800">{selected.tyre}</span>
              {selected.tyre_diameter_m != null
                ? ` · Ø ${selected.tyre_diameter_m} m`
                : ""}
            </div>
          )}
          {(selected.length_m != null ||
            selected.width_m != null ||
            selected.wheelbase_m != null) && (
            <div className="col-span-2 tabular-nums text-slate-500">
              {[
                selected.length_m != null
                  ? `L ${selected.length_m} m`
                  : null,
                selected.width_m != null ? `l ${selected.width_m} m` : null,
                selected.height_m != null ? `H ${selected.height_m} m` : null,
                selected.wheelbase_m != null
                  ? `emp. ${selected.wheelbase_m} m`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          )}
          {selected.cornering_stiffness != null && (
            <div className="col-span-2 text-slate-500">
              Cornering stiffness{" "}
              <span className="font-semibold text-slate-700">
                {selected.cornering_stiffness}
              </span>{" "}
              (info AVL — latéral via a_y)
            </div>
          )}
          {selected.notes && (
            <div className="col-span-2 text-[9px] leading-snug text-slate-400">
              {selected.notes}
            </div>
          )}
        </dl>
      )}

      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setDraft(selected ?? EMPTY);
          setEditing((v) => !v);
        }}
        className="text-[10px] font-semibold text-brand hover:underline disabled:opacity-40"
      >
        {editing ? "Fermer le formulaire" : "Ajouter / éditer"}
      </button>

      {editing && (
        <div className="space-y-1.5 rounded-md border border-slate-200 p-2">
          <input
            placeholder="Code véhicule"
            value={draft.code}
            onChange={(e) => setDraft({ ...draft, code: e.target.value })}
            className="w-full rounded border border-slate-200 px-2 py-1 text-[11px]"
          />
          <input
            placeholder="Nom"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="w-full rounded border border-slate-200 px-2 py-1 text-[11px]"
          />
          <label className="block text-[10px] text-slate-500">
            Code masse
            <select
              value={draft.massCode}
              onChange={(e) =>
                setDraft({ ...draft, massCode: e.target.value as MassCode })
              }
              className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-[11px]"
            >
              {(Object.keys(MASS_CODE_LABEL) as MassCode[]).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-1">
            <Num
              label="Masse kg"
              value={draft.mass_kg}
              onChange={(n) => setDraft({ ...draft, mass_kg: n })}
            />
            <Num
              label="r_dyn m"
              value={draft.r_dyn_m}
              step={0.001}
              onChange={(n) => setDraft({ ...draft, r_dyn_m: n })}
            />
            <Num
              label="τ_brake max N·m"
              value={draft.tau_brake_max_nm ?? 0}
              step={100}
              onChange={(n) =>
                setDraft({
                  ...draft,
                  tau_brake_max_nm: n > 0 ? n : null,
                })
              }
            />
            <Num
              label="F0 N"
              value={draft.f0_n}
              onChange={(n) => setDraft({ ...draft, f0_n: n })}
            />
            <Num
              label="F1 N/(km/h)"
              value={draft.f1_n_per_kph}
              step={0.01}
              onChange={(n) => setDraft({ ...draft, f1_n_per_kph: n })}
            />
            <Num
              label="F2 N/(km/h)²"
              value={draft.f2_n_per_kph2}
              step={0.001}
              onChange={(n) => setDraft({ ...draft, f2_n_per_kph2: n })}
            />
            <Num
              label="Vmax km/h"
              value={draft.v_max_kmh ?? 0}
              onChange={(n) => setDraft({ ...draft, v_max_kmh: n || null })}
            />
          </div>
          <select
            value={draft.powertrain}
            onChange={(e) =>
              setDraft({
                ...draft,
                powertrain: e.target.value as VehiclePowertrain,
              })
            }
            className="w-full rounded border border-slate-200 px-2 py-1 text-[11px]"
          >
            <option value="unknown">Motorisation ?</option>
            <option value="ice">Thermique</option>
            <option value="hev">Hybride</option>
            <option value="bev">Électrique</option>
          </select>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={handleSave}
              className="flex-1 rounded-md bg-brand px-2 py-1 text-[11px] font-semibold text-white"
            >
              Enregistrer
            </button>
            {selected && (
              <button
                type="button"
                onClick={() => {
                  deleteVehicle(selected.id);
                  refresh();
                  setEditing(false);
                }}
                className="rounded-md border border-red-200 px-2 py-1 text-[11px] font-semibold text-red-600"
              >
                Suppr.
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Num({
  label,
  value,
  onChange,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: number;
}) {
  return (
    <label className="block text-[10px] text-slate-500">
      {label}
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-0.5 w-full rounded border border-slate-200 px-1.5 py-1 text-[11px] tabular-nums"
      />
    </label>
  );
}
