"use client";

import { MAX_WAYPOINTS, type WaypointDraft } from "@/lib/types";

/** Map interaction mode — navigate never mutates endpoints. */
export type MapClickMode = "navigate" | "setA" | "setB" | "waypoints";

type WaypointsEditorProps = {
  waypoints: WaypointDraft[];
  onChange: (next: WaypointDraft[]) => void;
  clickMode: MapClickMode;
  onClickModeChange: (mode: MapClickMode) => void;
  onGeocodeWaypoint: (id: string) => void;
  geocodingId: string | null;
  disabled?: boolean;
  /** Hide outer title/border when wrapped in AccordionSection. */
  embedded?: boolean;
};

export function newWaypointDraft(
  partial?: Partial<Omit<WaypointDraft, "id">>
): WaypointDraft {
  return {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `wp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    lat: partial?.lat ?? null,
    lon: partial?.lon ?? null,
    address: partial?.address ?? "",
    label: partial?.label ?? "",
    stop_duration_s: partial?.stop_duration_s ?? 60,
  };
}

const MODE_OPTS: { id: MapClickMode; label: string; title: string }[] = [
  { id: "navigate", label: "Parcourir", title: "Les clics ne changent pas A/B — pan/zoom" },
  { id: "setA", label: "A", title: "Le prochain clic pose le départ" },
  { id: "setB", label: "B", title: "Le prochain clic pose l’arrivée" },
  { id: "waypoints", label: "Arrêts", title: "Les clics ajoutent des arrêts intermédiaires" },
];

export default function WaypointsEditor({
  waypoints,
  onChange,
  clickMode,
  onClickModeChange,
  onGeocodeWaypoint,
  geocodingId,
  disabled = false,
  embedded = false,
}: WaypointsEditorProps) {
  const atCap = waypoints.length >= MAX_WAYPOINTS;

  const update = (id: string, patch: Partial<WaypointDraft>) => {
    onChange(waypoints.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  };

  const remove = (id: string) => {
    onChange(waypoints.filter((w) => w.id !== id));
  };

  const addEmpty = () => {
    if (atCap || disabled) return;
    onChange([
      ...waypoints,
      newWaypointDraft({
        label: `Arrêt ${waypoints.length + 1}`,
        stop_duration_s: 60,
      }),
    ]);
  };

  const modeHint =
    clickMode === "navigate"
      ? "Mode parcourir : les clics ne modifient pas A/B ni l’analyse."
      : clickMode === "setA"
        ? "Prochain clic carte = départ (recalcule l’itinéraire)."
        : clickMode === "setB"
          ? "Prochain clic carte = arrivée (recalcule l’itinéraire)."
          : "Les clics ajoutent des arrêts (20 max).";

  return (
    <section className="space-y-2">
      {!embedded && (
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Arrêts intermédiaires
          </h2>
          <span className="text-[10px] tabular-nums text-slate-400">
            {waypoints.length}/{MAX_WAYPOINTS}
          </span>
        </div>
      )}

      <div
        role="radiogroup"
        aria-label="Map click mode"
        className="flex rounded-md border border-slate-200 bg-slate-50 p-0.5"
      >
        {MODE_OPTS.map((opt) => {
          const active = clickMode === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={active}
              title={opt.title}
              disabled={disabled || (opt.id === "waypoints" && atCap)}
              onClick={() => onClickModeChange(opt.id)}
              className={`min-h-[34px] flex-1 rounded px-1 text-[10px] font-semibold transition active:scale-[0.98] disabled:opacity-50 ${
                active
                  ? "bg-white text-brand shadow-sm ring-1 ring-slate-200"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <p className="text-[10px] leading-snug text-slate-400">{modeHint}</p>

      <ul className="max-h-56 space-y-2 overflow-y-auto">
        {waypoints.map((wp, i) => (
          <li
            key={wp.id}
            className="space-y-1.5 rounded-md border border-slate-200 bg-white p-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-slate-700">
                #{i + 1}
                {wp.lat != null && wp.lon != null ? (
                  <span className="ml-1 font-normal text-slate-400">
                    {wp.lat.toFixed(4)}, {wp.lon.toFixed(4)}
                  </span>
                ) : (
                  <span className="ml-1 font-normal text-amber-600">
                    no coords
                  </span>
                )}
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => remove(wp.id)}
                className="text-[10px] font-medium text-slate-400 hover:text-red-600"
              >
                Remove
              </button>
            </div>
            <input
              type="text"
              value={wp.label}
              disabled={disabled}
              onChange={(e) => update(wp.id, { label: e.target.value })}
              placeholder="Label"
              className="w-full rounded border border-slate-200 px-2 py-1 text-xs"
            />
            <div className="flex gap-1.5">
              <input
                type="text"
                value={wp.address}
                disabled={disabled}
                onChange={(e) => update(wp.id, { address: e.target.value })}
                placeholder="Adresse ou lat, lon"
                className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1 text-xs"
              />
              <button
                type="button"
                disabled={disabled || !wp.address.trim()}
                onClick={() => onGeocodeWaypoint(wp.id)}
                className="shrink-0 rounded border border-slate-200 px-2 text-[10px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                {geocodingId === wp.id ? "…" : "Localiser"}
              </button>
            </div>
            <label className="flex items-center gap-2 text-[10px] text-slate-500">
              Arrêt
              <input
                type="number"
                min={0}
                max={7200}
                step={10}
                value={wp.stop_duration_s}
                disabled={disabled}
                onChange={(e) =>
                  update(wp.id, {
                    stop_duration_s: Math.max(0, Number(e.target.value) || 0),
                  })
                }
                className="w-20 rounded border border-slate-200 px-1.5 py-0.5 text-xs tabular-nums"
              />
              s
            </label>
          </li>
        ))}
      </ul>

      <button
        type="button"
        disabled={disabled || atCap}
        onClick={addEmpty}
        className="w-full rounded-md border border-dashed border-slate-300 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
      >
        + Ajouter un arrêt
      </button>
    </section>
  );
}
