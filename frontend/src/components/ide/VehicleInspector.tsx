"use client";

import { useEffect, useState } from "react";
import {
  MASS_CODE_LABEL,
  saveVehicle,
  type MassCode,
  type VehicleCard,
  type VehiclePowertrain,
} from "@/lib/vehicleLibrary";
import { useWorkspaceStore } from "@/lib/workspaceStore";

const REBUILD_HINT_VEHICLE =
  "rebuild corridor · hint — vehicle mass/drag not in cheap IDM; Rebuild corridor if energy path needs them";

type Props = {
  vehicle: VehicleCard;
  onSaved?: (v: VehicleCard) => void;
};

export default function VehicleInspector({ vehicle, onSaved }: Props) {
  const pushConsole = useWorkspaceStore((s) => s.pushConsole);
  const selectAsset = useWorkspaceStore((s) => s.selectAsset);
  const [draft, setDraft] = useState(vehicle);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setDraft(vehicle);
    setDirty(false);
  }, [vehicle]);

  const setNum = (key: keyof VehicleCard, raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    setDraft((d) => ({ ...d, [key]: n }));
    setDirty(true);
  };

  const onSave = () => {
    const saved = saveVehicle({
      ...draft,
      id: draft.id.startsWith("plant-") || draft.id.startsWith("seed-")
        ? undefined
        : draft.id,
      name:
        draft.id.startsWith("plant-") || draft.id.startsWith("seed-")
          ? `${draft.name} (copie)`
          : draft.name,
    });
    selectAsset("vehicle", saved.id);
    pushConsole(`vehicle · saved ${saved.name}`);
    if (useWorkspaceStore.getState().geometry.corridor) {
      pushConsole(REBUILD_HINT_VEHICLE);
    }
    setDirty(false);
    onSaved?.(saved);
  };

  const isSeed =
    vehicle.id.startsWith("plant-") || vehicle.id.startsWith("seed-");

  return (
    <div className="space-y-2 p-2" data-testid="vehicle-inspector">
      <div className="border-b border-slate-200 pb-2">
        <input
          value={draft.name}
          onChange={(e) => {
            setDraft((d) => ({ ...d, name: e.target.value }));
            setDirty(true);
          }}
          className="w-full border-b border-transparent bg-transparent text-[12px] font-semibold text-slate-900 outline-none focus:border-brand"
        />
        <div className="mt-0.5 font-mono text-[9px] text-slate-400">
          {vehicle.id}
          {isSeed ? " · seed" : ""}
        </div>
      </div>

      <label className="flex items-center justify-between gap-2 font-mono text-[9px] uppercase text-slate-400">
        code
        <input
          value={draft.code}
          onChange={(e) => {
            setDraft((d) => ({ ...d, code: e.target.value }));
            setDirty(true);
          }}
          className="w-28 rounded border border-slate-200 px-1 py-0.5 font-mono text-[10px] text-slate-800"
        />
      </label>

      <label className="flex items-center justify-between gap-2 font-mono text-[9px] uppercase text-slate-400">
        massCode
        <select
          value={draft.massCode}
          onChange={(e) => {
            setDraft((d) => ({
              ...d,
              massCode: e.target.value as MassCode,
            }));
            setDirty(true);
          }}
          className="max-w-[9rem] rounded border border-slate-200 px-1 py-0.5 font-mono text-[10px]"
        >
          {(Object.keys(MASS_CODE_LABEL) as MassCode[]).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        {(
          [
            ["mass_kg", "mass"],
            ["f0_n", "F0"],
            ["f1_n_per_kph", "F1"],
            ["f2_n_per_kph2", "F2"],
            ["r_dyn_m", "r_dyn"],
            ["v_max_kmh", "v_max"],
            ["power_kw", "P_kw"],
          ] as const
        ).map(([key, label]) => (
          <label
            key={key}
            className="flex items-center justify-between gap-1 border-b border-slate-100 py-0.5"
          >
            <span className="font-mono text-[9px] uppercase text-slate-400">
              {label}
            </span>
            <input
              type="number"
              step="any"
              value={draft[key] ?? ""}
              onChange={(e) => setNum(key, e.target.value)}
              className="w-16 border-0 bg-transparent text-right font-mono text-[11px] tabular-nums outline-none"
            />
          </label>
        ))}
      </div>

      <label className="flex items-center justify-between gap-2 font-mono text-[9px] uppercase text-slate-400">
        powertrain
        <select
          value={draft.powertrain}
          onChange={(e) => {
            setDraft((d) => ({
              ...d,
              powertrain: e.target.value as VehiclePowertrain,
            }));
            setDirty(true);
          }}
          className="rounded border border-slate-200 px-1 py-0.5 font-mono text-[10px]"
        >
          {(["bev", "hev", "ice", "unknown"] as VehiclePowertrain[]).map(
            (p) => (
              <option key={p} value={p}>
                {p}
              </option>
            )
          )}
        </select>
      </label>

      <button
        type="button"
        disabled={!dirty && !isSeed}
        onClick={onSave}
        className="w-full rounded border border-slate-800 bg-slate-900 px-2 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-white enabled:hover:bg-slate-800 disabled:opacity-40"
      >
        {isSeed ? "Sauver copie" : dirty ? "Sauver" : "À jour"}
      </button>
      <p className="font-mono text-[9px] leading-snug text-slate-400">
        Vehicle card persists locally; cheap IDM ignores it — Rebuild corridor /
        energy path when needed.
      </p>
    </div>
  );
}
