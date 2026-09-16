"use client";

import { useEffect, useState } from "react";
import {
  defaultTripName,
  deleteSavedTrip,
  listSavedTrips,
  type SavedTripSnapshot,
} from "@/lib/tripStore";

type SavedTripsPanelProps = {
  canSave: boolean;
  suggestedName: string;
  onSave: (name: string) => void;
  onLoad: (trip: SavedTripSnapshot) => void;
  disabled?: boolean;
};

export default function SavedTripsPanel({
  canSave,
  suggestedName,
  onSave,
  onLoad,
  disabled = false,
}: SavedTripsPanelProps) {
  const [trips, setTrips] = useState<SavedTripSnapshot[]>([]);
  const [name, setName] = useState(suggestedName);
  const [open, setOpen] = useState(true);

  const refresh = () => setTrips(listSavedTrips());

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    setName(suggestedName);
  }, [suggestedName]);

  const handleSave = () => {
    const n = name.trim() || defaultTripName("A", "B");
    onSave(n);
    refresh();
  };

  return (
    <section className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Saved trips
        </h2>
        <span className="text-[10px] text-slate-400">
          {open ? "Hide" : "Show"} · {trips.length}
        </span>
      </button>

      {open && (
        <>
          <p className="text-[10px] leading-snug text-slate-400">
            Store A→B, waypoints, params and analysis in this browser (no
            export file needed).
          </p>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={name}
              disabled={disabled || !canSave}
              onChange={(e) => setName(e.target.value)}
              placeholder="Trip name"
              className="min-w-0 flex-1 rounded-md border border-slate-200 px-2 py-1.5 text-xs text-slate-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand disabled:opacity-50"
            />
            <button
              type="button"
              disabled={disabled || !canSave}
              onClick={handleSave}
              className="shrink-0 rounded-md bg-slate-900 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-slate-800 disabled:opacity-40"
            >
              Save
            </button>
          </div>

          {trips.length === 0 ? (
            <p className="text-[11px] text-slate-400">No saved trips yet.</p>
          ) : (
            <ul className="max-h-40 space-y-1 overflow-y-auto">
              {trips.map((t) => (
                <li
                  key={t.id}
                  className="flex items-start gap-1 rounded-md border border-slate-100 bg-slate-50 px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-semibold text-slate-800">
                      {t.name}
                    </div>
                    <div className="text-[10px] tabular-nums text-slate-400">
                      {new Date(t.savedAt).toLocaleString()}
                      {t.profile ? " · cycle" : t.corridor ? " · cycle" : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onLoad(t)}
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold text-brand hover:bg-white disabled:opacity-40"
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      deleteSavedTrip(t.id);
                      refresh();
                    }}
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-400 hover:bg-white hover:text-red-600 disabled:opacity-40"
                  >
                    Del
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
