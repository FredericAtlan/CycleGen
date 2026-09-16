"use client";

import {
  RENAULT_GROSSGLOCKNER_ZONES,
  normalizeZones,
  type DriverZone,
} from "@/lib/driverZones";
import { completePhysics, type DriverPhysics } from "@/lib/driverPresets";

type DriverZonesEditorProps = {
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  zones: DriverZone[];
  onZonesChange: (zones: DriverZone[]) => void;
  disabled?: boolean;
  /** Hide outer card chrome when wrapped in AccordionSection. */
  embedded?: boolean;
};

function PhysField({
  label,
  value,
  step,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (n: number) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5 text-[10px] text-slate-600">
      <span className="font-medium">{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        className="w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px] tabular-nums disabled:opacity-50"
      />
    </label>
  );
}

export default function DriverZonesEditor({
  enabled,
  onEnabledChange,
  zones,
  onZonesChange,
  disabled = false,
  embedded = false,
}: DriverZonesEditorProps) {
  const updateZone = (index: number, patch: Partial<DriverZone>) => {
    const next = zones.map((z, i) => (i === index ? { ...z, ...patch } : z));
    onZonesChange(normalizeZones(next));
  };

  const updatePhysics = (index: number, patch: Partial<DriverPhysics>) => {
    const z = zones[index];
    if (!z) return;
    updateZone(index, { physics: { ...z.physics, ...patch } });
  };

  const addZone = () => {
    const last = zones[zones.length - 1];
    const s0 = last?.s1_m ?? (last ? last.s0_m + 1000 : 0);
    onZonesChange(
      normalizeZones([
        ...zones,
        {
          id: `z${zones.length + 1}`,
          label: `Zone ${zones.length + 1}`,
          s0_m: s0,
          s1_m: null,
          physics:
            last?.physics ??
            completePhysics({ a_max: 2.0, b_comf: 3.5, speed_factor: 1.0 }),
          a_y: last?.a_y ?? 3.5,
        },
      ])
    );
  };

  const removeZone = (index: number) => {
    onZonesChange(normalizeZones(zones.filter((_, i) => i !== index)));
  };

  return (
    <section
      className={
        embedded
          ? "space-y-2"
          : "space-y-2 rounded-lg border border-slate-200 bg-white p-3"
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          {!embedded && (
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Zones (distance)
            </h3>
          )}
          <p className="text-[10px] leading-snug text-slate-400">
            Split le cycle en segments [s₀, s₁) avec a_max / b_comf / V factor
            (et a_y indicatif) par zone.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={disabled}
          title="Activer les paramètres conducteur par zone de distance"
          onClick={() => onEnabledChange(!enabled)}
          className={`rounded-md px-2 py-1 text-[10px] font-semibold disabled:opacity-40 ${
            enabled
              ? "bg-brand text-white"
              : "border border-slate-200 bg-slate-50 text-slate-600"
          }`}
        >
          {enabled ? "ON" : "OFF"}
        </button>
      </div>

      {enabled && (
        <>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                onZonesChange(normalizeZones(RENAULT_GROSSGLOCKNER_ZONES))
              }
              className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-semibold text-slate-700 hover:bg-white disabled:opacity-40"
              title="Charger les 2 zones Renault Grossglockner (Test) — zone 2 à 1116 m"
            >
              Preset Renault GG
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={addZone}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              + Zone
            </button>
          </div>

          <ul className="space-y-2">
            {zones.map((z, i) => (
              <li
                key={z.id}
                className="space-y-1.5 rounded-md border border-slate-100 bg-slate-50/80 p-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <input
                    type="text"
                    value={z.label}
                    disabled={disabled}
                    onChange={(e) => updateZone(i, { label: e.target.value })}
                    className="min-w-0 flex-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] font-semibold disabled:opacity-50"
                  />
                  <button
                    type="button"
                    disabled={disabled || zones.length <= 1}
                    onClick={() => removeZone(i)}
                    className="text-[10px] font-semibold text-red-600 disabled:opacity-30"
                    title="Retirer la zone"
                  >
                    ×
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <PhysField
                    label="s₀ (m)"
                    value={z.s0_m}
                    step={10}
                    min={0}
                    max={1e6}
                    disabled={disabled}
                    onChange={(s0_m) => updateZone(i, { s0_m })}
                  />
                  <PhysField
                    label="s₁ (m)"
                    value={z.s1_m ?? 0}
                    step={10}
                    min={0}
                    max={1e6}
                    disabled={disabled}
                    onChange={(s1_m) =>
                      updateZone(i, { s1_m: s1_m <= 0 ? null : s1_m })
                    }
                  />
                  <PhysField
                    label="a_max"
                    value={z.physics.a_max}
                    step={0.1}
                    min={0.2}
                    max={12}
                    disabled={disabled}
                    onChange={(a_max) => updatePhysics(i, { a_max })}
                  />
                  <PhysField
                    label="b_comf"
                    value={z.physics.b_comf}
                    step={0.1}
                    min={0.5}
                    max={15}
                    disabled={disabled}
                    onChange={(b_comf) => updatePhysics(i, { b_comf })}
                  />
                  <PhysField
                    label="V factor"
                    value={z.physics.speed_factor}
                    step={0.01}
                    min={0.4}
                    max={1.5}
                    disabled={disabled}
                    onChange={(speed_factor) =>
                      updatePhysics(i, { speed_factor })
                    }
                  />
                  <PhysField
                    label="a_y (lat.)"
                    value={z.a_y ?? 3.5}
                    step={0.1}
                    min={0.5}
                    max={12}
                    disabled={disabled}
                    onChange={(a_y) => updateZone(i, { a_y })}
                  />
                </div>
                <p className="text-[9px] text-slate-400">
                  s₁ = 0 → jusqu’à la fin. a_y zone = hint (enveloppe globale
                  pour l’instant).
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
