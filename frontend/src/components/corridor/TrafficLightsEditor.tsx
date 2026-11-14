"use client";

import { withUpdatedFeuMode } from "@/lib/corridorEdit";
import type { SpatialCorridor } from "@/lib/types";
import AccordionSection from "@/components/AccordionSection";
import { formatKm } from "./geo";

type TrafficLightsEditorProps = {
  corridor: SpatialCorridor;
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
  onChangeFeux: (S_feux: number[]) => void;
  /** Preferred for tls_mode edits (rebuilds feux_meta). */
  onChangeCorridor?: (corridor: SpatialCorridor) => void;
  onInspect: (s_m: number) => void;
  defaultOpen?: boolean;
  /** Render list only (parent already provides the accordion). */
  bare?: boolean;
};

function tlsSummary(
  feux: number[],
  meta: SpatialCorridor["feux_meta"]
): string {
  if (feux.length === 0) return "Aucun feu détecté — ajout possible";
  let gw = 0;
  let st = 0;
  for (let i = 0; i < feux.length; i++) {
    const mode =
      meta?.[i]?.tls_mode ??
      meta?.find((m) => Math.abs(m.s_m - feux[i]) <= 15)?.tls_mode ??
      "stochastic";
    if (mode === "green_wave") gw += 1;
    else st += 1;
  }
  const parts = [`${feux.length} feu${feux.length > 1 ? "x" : ""}`];
  if (gw) parts.push(`${gw} onde verte`);
  if (st) parts.push(`${st} stochastique`);
  return parts.join(" · ");
}

export default function TrafficLightsEditor({
  corridor,
  selectedIndex,
  onSelect,
  onChangeFeux,
  onChangeCorridor,
  onInspect,
  defaultOpen,
  bare = false,
}: TrafficLightsEditorProps) {
  const feux = corridor.S_feux ?? [];
  const meta = corridor.feux_meta;
  const showMode = Array.isArray(meta) && meta.length > 0;
  const sEnd = corridor.S?.length ? corridor.S[corridor.S.length - 1] : 0;
  const open =
    defaultOpen ?? (feux.length > 0 && feux.length <= 4);

  const updateAt = (index: number, s_m: number) => {
    const next = [...feux];
    next[index] = s_m;
    onChangeFeux(next);
  };

  const removeAt = (index: number) => {
    onChangeFeux(feux.filter((_, i) => i !== index));
    if (selectedIndex === index) onSelect(null);
  };

  const addAt = (s_m: number) => {
    onChangeFeux([...feux, s_m]);
  };

  const updateMode = (index: number, mode: "green_wave" | "stochastic") => {
    if (!onChangeCorridor) return;
    onChangeCorridor(withUpdatedFeuMode(corridor, index, mode));
  };

  const body = (
    <>
      <p className="mb-2 text-[10px] leading-snug text-slate-400">
        Position le long du trajet (m). Clic ligne / graphique → micro-inspection.
      </p>

      {feux.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 px-3 py-3 text-center text-xs text-slate-400">
          Aucun feu détecté — ajoutez-en un au milieu du trajet.
        </p>
      ) : (
        <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-slate-200 bg-slate-50/80 p-1.5">
          {feux.map((s, i) => {
            const active = selectedIndex === i;
            const mode =
              meta?.[i]?.tls_mode ??
              meta?.find((m) => Math.abs(m.s_m - s) <= 15)?.tls_mode ??
              "stochastic";
            return (
              <li
                key={`feu-${i}-${s.toFixed(1)}`}
                className={`flex flex-wrap items-center gap-1.5 rounded px-1.5 py-1 ${
                  active ? "bg-white ring-1 ring-brand/40" : "hover:bg-white"
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    onSelect(i);
                    onInspect(s);
                  }}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-red-500 text-[10px] font-bold text-white"
                  title="Inspect on map"
                >
                  {i + 1}
                </button>
                <input
                  type="number"
                  min={0}
                  max={Math.ceil(sEnd)}
                  step={5}
                  value={Math.round(s)}
                  onChange={(e) => updateAt(i, Number(e.target.value) || 0)}
                  onFocus={() => onSelect(i)}
                  className="w-20 rounded border border-slate-200 bg-white px-1.5 py-1 text-xs tabular-nums outline-none focus:border-brand"
                />
                <span className="text-[10px] text-slate-400">m</span>
                <span className="flex-1 text-[10px] tabular-nums text-slate-500">
                  {formatKm(s)}
                </span>
                {showMode && onChangeCorridor && (
                  <select
                    value={mode}
                    onChange={(e) =>
                      updateMode(
                        i,
                        e.target.value as "green_wave" | "stochastic"
                      )
                    }
                    onFocus={() => onSelect(i)}
                    className="rounded border border-slate-200 bg-white px-1 py-0.5 text-[10px] text-slate-700 outline-none focus:border-brand"
                    title="TLS mode"
                  >
                    <option value="stochastic">stochastic</option>
                    <option value="green_wave">green_wave</option>
                  </select>
                )}
                <button
                  type="button"
                  onClick={() => updateAt(i, Math.max(0, s - 10))}
                  className="rounded px-1 text-[10px] font-semibold text-slate-500 hover:bg-slate-100"
                  title="-10 m"
                >
                  −10
                </button>
                <button
                  type="button"
                  onClick={() => updateAt(i, Math.min(sEnd, s + 10))}
                  className="rounded px-1 text-[10px] font-semibold text-slate-500 hover:bg-slate-100"
                  title="+10 m"
                >
                  +10
                </button>
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  className="text-[10px] font-medium text-red-600 hover:underline"
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        onClick={() => addAt(sEnd > 0 ? sEnd / 2 : 100)}
        className="mt-2 w-full rounded-md border border-dashed border-slate-300 px-2 py-1.5 text-[11px] font-semibold text-slate-600 hover:border-brand hover:text-brand"
      >
        + Ajouter un feu
      </button>
    </>
  );

  if (bare) return <div className="mt-1">{body}</div>;

  return (
    <AccordionSection
      title="Feux tricolores"
      badge={feux.length}
      summary={tlsSummary(feux, meta)}
      defaultOpen={open}
    >
      {body}
    </AccordionSection>
  );
}
