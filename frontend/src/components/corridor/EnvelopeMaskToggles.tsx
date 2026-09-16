"use client";

import type { EnvelopeMask } from "@/lib/corridorEdit";

type EnvelopeMaskTogglesProps = {
  mask: EnvelopeMask;
  onChange: (mask: EnvelopeMask) => void;
  disabled?: boolean;
  /** Optional traffic_source badge hint (HERE/Mapbox/OSRM). */
  trafficSource?: string | null;
  /** Allow all sources off (Vmax alone still binds via remask). Default true. */
  allowEmpty?: boolean;
};

const OPTIONS: {
  key: keyof EnvelopeMask;
  label: string;
  hint: string;
  swatch: string;
}[] = [
  {
    key: "legal",
    label: "Légal (routeur + OSM)",
    hint: "HERE maxSpeed / Mapbox free-flow / OSRM, puis overlay OSM + snap panneau",
    swatch: "bg-slate-500",
  },
  {
    key: "traffic",
    label: "Trafic (routeur)",
    hint: "Mapbox d/duration à depart_at ; HERE = copie maxSpeed (pas de congestion)",
    swatch: "bg-orange-600",
  },
  {
    key: "curve",
    label: "Virage (géométrie)",
    hint: "√(a_y·R) calculé sur le tracé — indépendant du routeur",
    swatch: "bg-violet-600",
  },
];

export default function EnvelopeMaskToggles({
  mask,
  onChange,
  disabled = false,
  trafficSource = null,
  allowEmpty = true,
}: EnvelopeMaskTogglesProps) {
  const active =
    (mask.legal ? 1 : 0) + (mask.traffic ? 1 : 0) + (mask.curve ? 1 : 0);

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/80 p-2.5">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Sources de l’enveloppe
        </h3>
        <span className="text-[10px] text-slate-400">
          V_lim = min(cochées{allowEmpty ? ", Vmax" : ""})
        </span>
      </div>
      {trafficSource ? (
        <p className="mb-2 text-[10px] text-slate-500">
          Routeur actif :{" "}
          <span className="font-semibold text-slate-700">{trafficSource}</span>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {OPTIONS.map((opt) => {
          const checked = mask[opt.key];
          const alone = checked && active === 1 && !allowEmpty;
          return (
            <label
              key={opt.key}
              title={opt.hint}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-semibold ring-1 transition ${
                checked
                  ? "bg-white text-slate-800 ring-slate-200"
                  : "bg-transparent text-slate-400 ring-slate-100"
              } ${disabled ? "cursor-not-allowed opacity-50" : "hover:bg-white"}`}
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-brand"
                checked={checked}
                disabled={disabled || alone}
                onChange={(e) => {
                  const next = { ...mask, [opt.key]: e.target.checked };
                  if (
                    !allowEmpty &&
                    !next.legal &&
                    !next.traffic &&
                    !next.curve
                  ) {
                    return;
                  }
                  onChange(next);
                }}
              />
              <span className={`h-2 w-2 rounded-sm ${opt.swatch}`} />
              {opt.label}
            </label>
          );
        })}
      </div>
      <p className="mt-2 text-[10px] leading-snug text-slate-500">
        Toutes les combinaisons sont autorisées
        {allowEmpty
          ? " (aucune source → seule la Vmax véhicule borne l’enveloppe)."
          : "."}{" "}
        Impact immédiat sur les graphiques ci-dessous.
      </p>
    </div>
  );
}
